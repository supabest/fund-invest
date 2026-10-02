/// <reference lib="deno.ns" />
// stock-research —— 产业研究员 Edge Function（编排层，无状态无 cron，全按需）
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5/§6/§7
// 鉴权：verify_jwt:true 平台 JWT 守卫（前端登录用户 JWT 由 supabase-js 自动附），函数内不自校 token、不新增 Secret。
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
  // M-2：用 hasOwnProperty 防原型链旁路（否则 slug='constructor'/'toString' 等 inherited key 会使 `!PROVIDERS[slug]` 为假而绕过校验）
  const spec = Object.prototype.hasOwnProperty.call(PROVIDERS, slug) ? PROVIDERS[slug] : null;
  if (!spec) return json({ ok: false, error: 'provider 须为 zhipu|bailian' }, 400);
  const apiKey = String(body.api_key ?? '');
  if (apiKey.length < 8) return json({ ok: false, error: '缺少 API Key（本功能密钥随用随贴，不落任何存储）' }, 400);
  const model = String(body.model ?? '').trim() || spec.defaultModel;

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
