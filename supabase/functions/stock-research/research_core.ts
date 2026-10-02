/// <reference lib="deno.ns" />
// research_core —— 产业研究员纯核心（无 IO）：提示词组装 / 六段解析 / 防重判定 / 错误脱敏
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4(脱敏) §5(防重) §7(提示词)

export const CODE_RE = /^\d{5,6}$/;
export type Verdict = '升温' | '平稳' | '降温' | '恶化';
export const VERDICTS: readonly Verdict[] = ['升温', '平稳', '降温', '恶化'];

export interface Anchors {
  scoreRow: Record<string, unknown> | null; // stock_score 最新批次行（extras 内含 mix）
  mixRow: Record<string, unknown> | null;   // stock_business_mix 行
}

// 六段标题固定序（前端渲染与解析校验共用同一数组）
const SECTION_TITLES = ['需求', '供给', '价格与盈利', '竞争格局与扩产', '管理层与市场信号', '结论与温度'];

export function buildPrompt(code: string, name: string, anchors: Anchors): string {
  const sc = anchors.scoreRow;
  const mix = anchors.mixRow ?? (sc ? ((sc as { extras?: { mix?: unknown } }).extras?.mix ?? null) : null);
  const finLines: string[] = [];
  if (sc) {
    for (const k of ['revenue_yoy', 'profit_yoy', 'roe', 'quality', 'growth', 'final']) {
      const v = (sc as Record<string, unknown>)[k];
      if (typeof v === 'number') finLines.push(`${k}=${v}`);
    }
  }
  const mixLine = (() => {
    const segs = (mix as { segments?: { name: string; ratio: number }[] } | null)?.segments
      ?? (mix as { segments?: { name: string; ratio: number }[] } | null);
    if (!Array.isArray(segs) || !segs.length) return null;
    return segs.slice(0, 3).map((x) => `${x.name}(${Math.round((x.ratio ?? 0) * 100)}%)`).join('、');
  })();
  const anchorBlock = finLines.length
    ? `本库财务锚点（截至最新评分批次，非实时）：${finLines.join(' ')}${mixLine ? `；主营结构：${mixLine}` : ''}`
    : '无本库财务锚点（评分池外/港股），仅以联网搜索所得公开财务信息为据，并在报告中注明数据出处与期间。';

  return [
    `你是一名严谨的产业研究员。研究对象：${name || '未命名'}（${code}）所在行业，聚焦近 6 个月景气度变化。`,
    '必须使用联网搜索获取研报、业绩说明会/财报电话会、行业新闻等时效性来源；只依据搜索结果，不得编造。',
    '逐一覆盖五类信号并各给出处：需求端、供给端、价格（产品与原料）、扩产/资本开支、管理层措辞（业绩会/年报表述变化）。',
    anchorBlock,
    '判定纪律：结论必附来源（链接或「财报电话会 2026-08-29」式指称）；禁止凭「供不应求」「景气度回升」等关键词直接判看涨；温度判定必须给出至少两条独立证据。',
    '若搜索所得信息不足以支撑某一信号段，该段如实写「信息不足」并说明缺什么，不得脑补。',
    '输出格式：仅输出一个 JSON 对象，不要任何解释文字。结构：',
    `{"verdict":"升温|平稳|降温|恶化","summary":"一句话概要（≤40字）","report":[${SECTION_TITLES.map((t) => `{"title":"${t}","body":"…"}`).join(',')}],"sources":[{"title":"…","url":"…","date":"YYYY-MM-DD"}]}`,
    'report 数组必须恰为六段、title 依次固定为：' + SECTION_TITLES.join('、') + '。verdict 是状态标记，不构成任何买卖建议。',
  ].join('\n');
}

export interface ParsedReport {
  verdict: Verdict; summary: string;
  report: { title: string; body: string }[];
  sources: { title: string; url: string; date: string }[];
}

export function parseReport(text: string): ParsedReport | null {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j: Record<string, unknown>;
  try { j = JSON.parse(cleaned); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  if (!VERDICTS.includes(j.verdict as Verdict)) return null;
  if (typeof j.summary !== 'string' || !j.summary.trim()) return null;
  const secs = j.report;
  if (!Array.isArray(secs) || secs.length !== 6) return null;
  for (let i = 0; i < 6; i++) {
    const s = secs[i] as { title?: unknown; body?: unknown };
    if (!s || typeof s.body !== 'string' || !s.body.trim()) return null;
    if (typeof s.title === 'string' && s.title.trim()) continue;
    s.title = SECTION_TITLES[i]; // 缺 title 用固定序补齐
  }
  const srcs = Array.isArray(j.sources) ? (j.sources as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const sources = srcs
    .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url))
    .filter((x) => { const u = String(x.url); if (seen.has(u)) return false; seen.add(u); return true; })
    .map((x) => ({ title: String(x.title ?? ''), url: String(x.url), date: String(x.date ?? '') }));
  return {
    verdict: j.verdict as Verdict,
    summary: String(j.summary),
    report: (secs as { title: string; body: string }[]).map((s) => ({ title: String(s.title), body: String(s.body) })),
    sources,
  };
}

export type DedupeAction = 'run' | 'reuse_running' | 'reuse_done';
const RUNNING_STALE_MS = 10 * 60_000; // spec §5：running 超 10 分钟视为陈旧（撞 Edge timeout 的死行）可重跑
const DONE_CACHE_MS = 60 * 60_000;    // spec §5：done 1 小时内返回缓存

export function dedupeAction(row: { status: string; started_at: string; finished_at: string | null } | null, nowMs: number): DedupeAction {
  if (!row) return 'run';
  if (row.status === 'running') {
    const t = Date.parse(row.started_at);
    return Number.isFinite(t) && nowMs - t < RUNNING_STALE_MS ? 'reuse_running' : 'run';
  }
  if (row.status === 'done') {
    const t = Date.parse(row.finished_at ?? '');
    return Number.isFinite(t) && nowMs - t < DONE_CACHE_MS ? 'reuse_done' : 'run';
  }
  return 'run'; // failed/未知状态 → 立即可重试
}

// spec §4：key 经请求体进函数，任何错误信息落库/返回前必须脱敏；截断上限 500
export function sanitizeError(raw: string, apiKey: string): string {
  let s = String(raw ?? '未知错误');
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return s;
}
