/// <reference lib="deno.ns" />
// stock-research —— 产业研究员 Edge Function（编排层，无状态无 cron，全按需）
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5/§6/§7
// 鉴权：verify_jwt:true 平台 JWT 守卫 + 函数体内 role 自校（仅 authenticated 可调用，拒 anon；不新增 Secret，终审 I-1）。
// 密钥纪律：api_key 仅从请求体进、只在内存使用——不落库、不进日志、不进响应体（spec §4）。
import { CODE_RE, buildPrompt, dedupeAction, parseReport, sanitizeError, type Anchors } from "./research_core.ts";
import { PROVIDERS, callResearch, type ProviderSlug } from "./providers.ts";

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
export async function handle(req: Request): Promise<Response> {
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
