/// <reference lib="deno.ns" />

// research_core —— 产业研究员纯核心（无 IO）：提示词组装 / 六段解析 / 防重判定 / 错误脱敏
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4(脱敏) §5(防重) §7(提示词)

const CODE_RE = /^\d{5,6}$/;
type Verdict = '升温' | '平稳' | '降温' | '恶化';
const VERDICTS: readonly Verdict[] = ['升温', '平稳', '降温', '恶化'];

interface Anchors {
  scoreRow: Record<string, unknown> | null; // stock_score 该 code 最新批次行（extras.mix 内含主营结构）
  mixRow: Record<string, unknown> | null;   // 兼容签名保留：V1 readAnchors 恒置 null（主营结构实际取自 scoreRow.extras.mix）
}

// 六段标题固定序（前端渲染与解析校验共用同一数组）
const SECTION_TITLES = ['需求', '供给', '价格与盈利', '竞争格局与扩产', '管理层与市场信号', '结论与温度'];

function buildPrompt(code: string, name: string, anchors: Anchors): string {
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
// 鉴权：verify_jwt:true 平台 JWT 守卫 + 函数体内 role 自校（仅 authenticated 可调用，拒 anon；不新增 Secret，终审 I-1）。
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
  if (!r.ok) throw new Error(`数据获取失败（stock_fundamental 读取 ${r.status}）`); // 不透传 raw body，避免脏日志（终审 I-2）
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function writeRow(row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${rest()}/stock_fundamental?on_conflict=code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error(`数据获取失败（stock_fundamental 写入 ${r.status}）`); // 不透传 raw body（终审 I-2）
}

// 财务锚点：该 code 自己的最新批次行（含 extras.mix）；读失败静默 null，spec §7「缺则注明无」。
// M-6：单查询按 code 过滤 + batch_date.desc 取首行，不再先拉全局 max(batch_date) 两步（避免跨批次漂移）。
async function readAnchors(code: string): Promise<Anchors> {
  try {
    const s = await fetch(`${rest()}/stock_score?select=*&code=eq.${encodeURIComponent(code)}&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
    if (!s.ok) return { scoreRow: null, mixRow: null };
    const scoreRow = ((await s.json()) as Record<string, unknown>[])[0] ?? null;
    return { scoreRow, mixRow: null }; // mix 已在该 code 最新批次行的 extras 内（stock-score buildRevealExtras 先例），不另读 business_mix 防双源漂移
  } catch { return { scoreRow: null, mixRow: null }; }
}

// 终审 I-1：verify_jwt:true 仅保证 JWT 由项目密钥签名（不区分角色），本函数只读取已由平台验签的
// Authorization JWT 的 role claim（不重复验签）。仅 role==='authenticated'（邮箱密码登录）可调用，
// 拒绝 anon/publishable（落实 spec §4「需已登录」，不新增 Secret）。
function callerRole(req: Request): string | null {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch { return null; }
}

// export 供编排层单测直接调 handle（build.ts 会剥除 export 关键字，不影响部署产物）
async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  if (callerRole(req) !== 'authenticated') return json({ ok: false, error: '需登录（已认证会话）后使用研究功能' }, 401); // I-1：在任何 DB/provider 调用之前拦截
  let body: { action?: string; code?: string; provider?: string; model?: string; api_key?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const code = String(body.code ?? '').trim();
  if (!CODE_RE.test(code)) return json({ ok: false, error: '代码格式不符（A股6位/港股5位）' }, 400);

  if (body.action === 'status') {
    try { return json({ ok: true, row: await readRow(code) }); }
    catch (e) { return json({ ok: false, error: sanitizeError(String(e), '') }, 502); } // I-2：status 读失败也返结构体，不裸 500
  }
  if (body.action !== 'generate') return json({ ok: false, error: 'action 须为 generate|status' }, 400);

  const slug = String(body.provider ?? '') as ProviderSlug;
  // M-2：用 hasOwnProperty 防原型链旁路（否则 slug='constructor'/'toString' 等 inherited key 会使 `!PROVIDERS[slug]` 为假而绕过校验）
  const spec = Object.prototype.hasOwnProperty.call(PROVIDERS, slug) ? PROVIDERS[slug] : null;
  if (!spec) return json({ ok: false, error: 'provider 须为 zhipu|bailian' }, 400);
  const apiKey = String(body.api_key ?? '');
  if (apiKey.length < 8) return json({ ok: false, error: '缺少 API Key（本功能密钥随用随贴，不落任何存储）' }, 400);
  // 终审 I-1：model 白名单——缺省或等于 defaultModel 直接用；自定义名仅允安全字符集且≤64，拒绝任意注入（落全局共享表）
  const rawModel = String(body.model ?? '').trim();
  if (rawModel && rawModel !== spec.defaultModel && !/^[A-Za-z0-9._:-]{1,64}$/.test(rawModel)) {
    return json({ ok: false, error: 'model 名称非法' }, 400);
  }
  const model = rawModel || spec.defaultModel;

  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  try {
    // I-2：readRow/dedupe/writeRow(running) 均纳入 try，异常走统一 failed 落库+结构化返回，不逃逸成裸 500
    const existing = await readRow(code);
    const act = dedupeAction(existing as { status: string; started_at: string; finished_at: string | null } | null, now);
    if (act !== 'run' && existing) return json({ ok: true, row: existing, cached: act });

    await writeRow({ code, provider: slug, model, status: 'running', verdict: null, summary: null, report: null, sources: null, error: null, started_at: startedAt, finished_at: null });

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
    try { await writeRow(failed); } catch { /* 落库也失败则不阻塞结构化返回（I-2） */ }
    return json({ ok: false, error: failed.error, row: failed }, 502);
  }
}

// 单测守卫先例（同 SECTOR_TREND_DISABLE_SERVE）；线上 Edge 不注入该变量
if (!Deno.env.get('STOCK_RESEARCH_DISABLE_SERVE')) {
  Deno.serve((req: Request) => handle(req));
}
