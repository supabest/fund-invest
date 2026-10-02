/// <reference lib="deno.ns" />
// research_core —— 产业研究员纯核心（无 IO）：提示词组装 / 六段解析 / 防重判定 / 错误脱敏
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4(脱敏) §5(防重) §7(提示词)

export const CODE_RE = /^\d{5,6}$/;
export type Verdict = '升温' | '平稳' | '降温' | '恶化';
export const VERDICTS: readonly Verdict[] = ['升温', '平稳', '降温', '恶化'];

export interface Anchors {
  scoreRow: Record<string, unknown> | null; // stock_score 该 code 最新批次行（extras.mix 内含主营结构）
  mixRow: Record<string, unknown> | null;   // 兼容签名保留：V1 readAnchors 恒置 null（主营结构实际取自 scoreRow.extras.mix）
}

// 六段标题固定序（前端渲染与解析校验共用同一数组）
const SECTION_TITLES = ['需求', '供给', '价格与盈利', '竞争格局与扩产', '管理层与市场信号', '结论与温度'];

export function buildPrompt(code: string, name: string, anchors: Anchors): string {
  const sc = anchors.scoreRow as Record<string, unknown> | null;
  // 主营结构：V1 实际取自 stock_score.extras.mix.segments（stock-score buildRevealExtras 写入）；
  // anchors.mixRow 仅为兼容既有签名保留，readAnchors 恒置 null（见 index.ts），不双源读 business_mix。
  const mix = anchors.mixRow ?? (sc?.extras ? ((sc.extras as { mix?: { segments?: unknown } } | null)?.mix ?? null) : null);
  const pickNums = (keys: string[]): string[] => {
    const out: string[] = [];
    if (sc) for (const k of keys) { const v = sc[k]; if (typeof v === 'number') out.push(`${k}=${v}`); }
    return out;
  };
  // 财务行：只挑 stock_score 真实存在的数值列（生产表无营收/净利同比列，已不取值）
  const finFields = pickNums(['roe', 'pe', 'debt']);
  // 评分行：quality/growth/value/momentum/final 是本库量化评分（0-100 百分位），非财务增长率
  const scoreFields = pickNums(['quality', 'growth', 'value', 'momentum', 'final']);
  const mixLine = (() => {
    const segs = (mix as { segments?: { name: string; ratio: number }[] } | null)?.segments
      ?? (mix as { segments?: { name: string; ratio: number }[] } | null);
    if (!Array.isArray(segs) || !segs.length) return null;
    return segs.slice(0, 3).map((x) => `${x.name}(${Math.round((x.ratio ?? 0) * 100)}%)`).join('、');
  })();
  const ths = sc
    ? [sc.ths_l1, sc.ths_l2].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' / ')
    : '';
  const anchorLines: string[] = [];
  if (finFields.length) anchorLines.push(`本库财务快照（非实时同比数据）：${finFields.join(' ')}`);
  if (scoreFields.length) anchorLines.push(`本库量化评分(0-100 百分位，非财务增长率，不得据此判景气方向)：${scoreFields.join(' ')}`);
  if (mixLine) anchorLines.push(`主营结构：${mixLine}`);
  if (ths) anchorLines.push(`行业背景（同花顺分类）：${ths}`);
  const anchorBlock = anchorLines.length
    ? anchorLines.join('\n')
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
  // 截断分支须保证总长 ≤500：留 1 位给省略号，否则 500+1=501 违反契约
  if (s.length > 500) s = s.slice(0, 499) + '…';
  return s;
}
