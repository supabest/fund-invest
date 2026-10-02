/// <reference lib="deno.ns" />

// research_core —— 产业研究员纯核心（无 IO）：提示词组装 / 六段解析 / 防重判定 / 错误脱敏
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4(脱敏) §5(防重) §7(提示词)

const CODE_RE = /^\d{5,6}$/;
type Verdict = '升温' | '平稳' | '降温' | '恶化';
const VERDICTS: readonly Verdict[] = ['升温', '平稳', '降温', '恶化'];

interface Anchors {
  scoreRow: Record<string, unknown> | null; // stock_score 最新批次行（extras 内含 mix）
  mixRow: Record<string, unknown> | null;   // stock_business_mix 行
}

// 六段标题固定序（前端渲染与解析校验共用同一数组）
const SECTION_TITLES = ['需求', '供给', '价格与盈利', '竞争格局与扩产', '管理层与市场信号', '结论与温度'];

function buildPrompt(code: string, name: string, anchors: Anchors): string {
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

interface ParsedReport {
  verdict: Verdict; summary: string;
  report: { title: string; body: string }[];
  sources: { title: string; url: string; date: string }[];
}

function parseReport(text: string): ParsedReport | null {
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

type DedupeAction = 'run' | 'reuse_running' | 'reuse_done';
const RUNNING_STALE_MS = 10 * 60_000; // spec §5：running 超 10 分钟视为陈旧（撞 Edge timeout 的死行）可重跑
const DONE_CACHE_MS = 60 * 60_000;    // spec §5：done 1 小时内返回缓存

function dedupeAction(row: { status: string; started_at: string; finished_at: string | null } | null, nowMs: number): DedupeAction {
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
function sanitizeError(raw: string, apiKey: string): string {
  let s = String(raw ?? '未知错误');
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  // 截断分支须保证总长 ≤500：留 1 位给省略号，否则 500+1=501 违反契约
  if (s.length > 500) s = s.slice(0, 499) + '…';
  return s;
}


// providers —— 两家服务商适配器（spec §3）：端点/鉴权/联网参数/响应解析差异全部在此消化，
// 对外只暴露 callResearch。失败纪律：统一「数据获取失败」前缀 + 服务商名 + 状态码，
// 绝不换服务商、绝不换渠道、绝不静默降级为无搜索；错误信息经 sanitizeError 抹 key。

type ProviderSlug = 'zhipu' | 'bailian';

const PROVIDERS: Record<ProviderSlug, { endpoint: string; defaultModel: string; label: string }> = {
  zhipu:   { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",   defaultModel: "glm-5.3-flash",  label: "智谱" },
  bailian: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", defaultModel: "qwen3.8-flash", label: "阿里百炼" },
};

// 联网参数：智谱平台 web_search 工具形态以官方文档为据，Task 7 联调 curl 实测敲定；
// 若实测不符，只改本函数内 body 构造（callResearch 对外形态不变）——spec §10 风险行 1。
function buildBody(p: ProviderSlug, model: string, prompt: string): Record<string, unknown> {
  const messages = [{ role: "user", content: prompt }];
  if (p === 'zhipu') return { model, messages, tools: [{ type: "web_search" }] };
  return { model, messages, enable_search: true, search_options: { search_strategy: "max" } };
}

async function callResearch(
  p: ProviderSlug, model: string, apiKey: string, prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const spec = PROVIDERS[p];
  let resp: Response;
  try {
    resp = await fetchImpl(spec.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(p, model, prompt)),
    });
  } catch (e) {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：网络不可达 ${String(e)}）`, apiKey));
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    // 先对切片原文脱敏再截断：text.slice(0,200) 先截会让跨界 key 变成残片，
    // 逃出外层 sanitizeError 的全串 split(apiKey) 替换；外层 sanitizeError 保留作双保险。
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：HTTP ${resp.status} ${sanitizeError(text, apiKey).slice(0, 200)}）`, apiKey));
  }
  let j: { choices?: { message?: { content?: string } }[] };
  try { j = JSON.parse(text); } catch {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：响应非 JSON）`, apiKey));
  }
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：响应缺少 choices[0].message.content）`, apiKey));
  }
  return content;
}


// stock-research —— 产业研究员 Edge Function（编排层，无状态无 cron，全按需）
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5/§6/§7
// 鉴权：verify_jwt:true 平台 JWT 守卫（前端登录用户 JWT 由 supabase-js 自动附），函数内不自校 token、不新增 Secret。
// 密钥纪律：api_key 仅从请求体进、只在内存使用——不落库、不进日志、不进响应体（spec §4）。


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 与 stock-score/index.ts svcHeaders 完全一致的 service 通道（env 先例照搬）
function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
const rest = () => (Deno.env.get('SUPABASE_URL') || '') + '/rest/v1';

async function readRow(code: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${rest()}/stock_fundamental?code=eq.${encodeURIComponent(code)}`, {
    headers: svcHeaders(),
  });
  if (!r.ok) throw new Error(`read stock_fundamental ${r.status}`);
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function writeRow(row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${rest()}/stock_fundamental?on_conflict=code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error(`upsert stock_fundamental ${r.status} ${await r.text()}`);
}

// 财务锚点：stock_score 最新批次行 + 其 extras.mix（读失败静默 null，spec §7「缺则注明无」）
async function readAnchors(code: string): Promise<Anchors> {
  try {
    const b = await fetch(`${rest()}/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
    if (!b.ok) return { scoreRow: null, mixRow: null };
    const batch = ((await b.json()) as { batch_date: string }[])[0]?.batch_date;
    if (!batch) return { scoreRow: null, mixRow: null };
    const s = await fetch(`${rest()}/stock_score?select=*&batch_date=eq.${batch}&code=eq.${encodeURIComponent(code)}&limit=1`, { headers: svcHeaders() });
    if (!s.ok) return { scoreRow: null, mixRow: null };
    const scoreRow = ((await s.json()) as Record<string, unknown>[])[0] ?? null;
    return { scoreRow, mixRow: null }; // mix 已在 score extras 内（stock-score buildRevealExtras 先例），不另读 business_mix 防双源漂移
  } catch { return { scoreRow: null, mixRow: null }; }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  let body: { action?: string; code?: string; provider?: string; model?: string; api_key?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const code = String(body.code ?? '').trim();
  if (!CODE_RE.test(code)) return json({ ok: false, error: '代码格式不符（A股6位/港股5位）' }, 400);

  if (body.action === 'status') {
    return json({ ok: true, row: await readRow(code) });
  }
  if (body.action !== 'generate') return json({ ok: false, error: 'action 须为 generate|status' }, 400);

  const slug = String(body.provider ?? '') as ProviderSlug;
  if (!PROVIDERS[slug]) return json({ ok: false, error: 'provider 须为 zhipu|bailian' }, 400);
  const apiKey = String(body.api_key ?? '');
  if (apiKey.length < 8) return json({ ok: false, error: '缺少 API Key（本功能密钥随用随贴，不落任何存储）' }, 400);
  const model = String(body.model ?? '').trim() || PROVIDERS[slug].defaultModel;

  const now = Date.now();
  const existing = await readRow(code);
  const act = dedupeAction(existing as { status: string; started_at: string; finished_at: string | null } | null, now);
  if (act !== 'run' && existing) return json({ ok: true, row: existing, cached: act });

  const startedAt = new Date(now).toISOString();
  await writeRow({ code, provider: slug, model, status: 'running', verdict: null, summary: null, report: null, sources: null, error: null, started_at: startedAt, finished_at: null });

  try {
    const anchors = await readAnchors(code);
    const name = String((anchors.scoreRow as { name?: string } | null)?.name ?? '');
    const prompt = buildPrompt(code, name, anchors);
    const text = await callResearch(slug, model, apiKey, prompt); // 同步等待；Edge wall-clock 见部署步
    let parsed = parseReport(text);
    if (!parsed) parsed = parseReport(await callResearch(slug, model, apiKey, prompt)); // 解析失败重试一次（spec §6）
    if (!parsed) throw new Error('六段 JSON 解析失败（两次）');
    const done = {
      code, provider: slug, model, status: 'done',
      verdict: parsed.verdict, summary: parsed.summary,
      report: parsed.report, sources: parsed.sources,
      error: null, started_at: startedAt, finished_at: new Date().toISOString(),
    };
    await writeRow(done);
    return json({ ok: true, row: done });
  } catch (e) {
    const failed = {
      code, provider: slug, model, status: 'failed',
      verdict: null, summary: null, report: null, sources: null,
      error: sanitizeError(String(e), apiKey), started_at: startedAt, finished_at: new Date().toISOString(),
    };
    await writeRow(failed);
    return json({ ok: false, error: failed.error, row: failed }, 502);
  }
}

// 单测守卫先例（同 SECTOR_TREND_DISABLE_SERVE）；线上 Edge 不注入该变量
if (!Deno.env.get('STOCK_RESEARCH_DISABLE_SERVE')) {
  Deno.serve((req: Request) => handle(req));
}
