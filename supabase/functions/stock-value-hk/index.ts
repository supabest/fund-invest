/// <reference lib="deno.ns" />
// stock-value-hk 编排层。规则权威：spec §5（编排）/§5.1（守卫）/§5.2（隔离）/§4（落库）
import { computeHk, type HkRow } from './hk_engine.ts';
import { gsHkFetch, mergeHkTables, hkYearAnchors, buildHkQ1, HK_Q2, HK_Q3 } from './gs_hk.ts';

// 持仓是按用户存的 JSON（dingtou_state.data.stocks），不是关系表 ⇒ 范式照 daily-update/index.ts:1563 heldStocksOf。
// 只收 5 位纯数字（港股）；6 位是 A 股，走原价值腿，本函数一律不碰。
export function heldHkCodes(states: unknown[]): string[] {
  const out = new Set<string>();
  for (const u of states) {
    const arr = (u as { data?: { stocks?: unknown } })?.data?.stocks;
    if (!Array.isArray(arr)) continue;
    for (const x of arr as Array<{ code?: unknown }>) {
      const c = String(x?.code ?? '').trim();
      if (/^\d{5}$/.test(c)) out.add(c);
    }
  }
  return [...out].sort();
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

type StatesGet = (u: string, init: RequestInit) => Promise<{
  ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown>;
}>;

// 单页 + Content-Range 自证，**不写分页循环**：dingtou_state 一行一个用户，本工具是个人持仓，
// 行数远不到 db-max-rows=1000。真超过 1000 时这里的守卫会炸批而不是静默漏掉一部分用户的持仓
// （A 股 readAllRows 的 1000 行静默截断事故是同型缺陷，宁可显式失败）。
export async function readStates(base: string, get: StatesGet = fetch as unknown as StatesGet): Promise<unknown[]> {
  const r = await get(`${base}/rest/v1/dingtou_state?select=user_id,data&order=user_id.asc&limit=1000`,
    { headers: { ...svcHeaders(), 'Prefer': 'count=exact' } });
  if (!r.ok) throw new Error(`read dingtou_state: ${r.status}`);
  const m = /^(\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
  if (!m) throw new Error('read dingtou_state: Content-Range 拿不到总数（count=exact 未生效）');
  const rows = (await r.json()) as unknown[];
  const total = Number(m[3]);
  if (rows.length !== total) throw new Error(`read dingtou_state: 单页被截断（实得 ${rows.length} / 总数 ${total}）⇒ 持仓集合不完整，拒绝跑批`);
  return rows;
}

// 落库映射抽成导出纯函数（同 A 股 buildDbRows 的教训）：extras 的接线若留在 handler 里，
// 「stamps/years 永远空」这种错误就没有任何测试能发现。
export function toHkDbRow(
  r: HkRow, batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  return {
    batch_date: batch, code: r.code, name: r.name,
    roic_cur: r.roicCur, roic_med: r.roicMed, roic_min3: r.roicMin3,
    div_yield: r.divYield, div_yield_5y: r.divY5y,
    pe: r.pe, pb: r.pb, roic_ok: r.roicOk,
    extras: { stamps, years, missing: r.missing },
  };
}

export function buildHkDbRows(
  rows: HkRow[], batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown>[] {
  return rows.map(r => toHkDbRow(r, batch, stamps, years));
}

type PostFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// 持仓港股是个位数行 ⇒ 一次 POST，**不写分块循环**（A 股 5224 行才需要）。
// onSent 先报告再查状态：PostgREST 可能已收下但返回非 2xx，此时旧批已被覆盖，catch 里不能再称「保留」。
export async function upsertHk(rows: Record<string, unknown>[], onSent?: () => void, post: PostFn = fetch): Promise<void> {
  if (rows.length === 0) return;
  const url = Deno.env.get('SUPABASE_URL')!;
  const r = await post(`${url}/rest/v1/stock_value_hk?on_conflict=batch_date,code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  onSent?.();
  if (!r.ok) throw new Error(`upsert stock_value_hk ${r.status} ${await r.text()}`);
}

// 遥测：missing_codes 是「持仓非空但某码零命中」的唯一可见出口（REIT 不在宇宙内、宇宙快照漂移）。
// 不报数就永远是静默缺陷——页面只会显示「本批次无该股数据」，与「港股本来就不在范围内」外观一致。
export function runHkSummary(
  rows: HkRow[], batch: string, held: string[], stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  const got = new Set(rows.map(r => r.code));
  return {
    ok: true, batch_date: batch, rows: rows.length, held_hk: held.length,
    roic_ok: rows.filter(r => r.roicOk === true).length,
    roic_fail: rows.filter(r => r.roicOk === false).length,
    roic_na: rows.filter(r => r.roicOk === null).length,
    missing_codes: held.filter(c => !got.has(c)),
    stamps, years,
  };
}

export function errorHkBody(msg: string, wrote: boolean): Record<string, unknown> {
  return { ok: false, error: msg, kept_old_batch: !wrote };
}

if (!Deno.env.get('STOCK_VALUE_HK_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const url = Deno.env.get('SUPABASE_URL')!;
  // wrote 必须声明在 try 外面：try 内的 let 对 catch 不可见
  let wrote = false;
  try {
    const held = heldHkCodes(await readStates(url));
    // spec §5 第2步：空集 ⇒ 不发 GS 调用、不写表
    if (held.length === 0) return Response.json({ ok: true, skipped: 'no hk holdings' });
    const now = new Date();
    const { annualBase } = hkYearAnchors(now);
    const [t1, t2, t3] = await Promise.all([
      gsHkFetch(buildHkQ1(annualBase), key), gsHkFetch(HK_Q2, key), gsHkFetch(HK_Q3, key),
    ]);
    const { rows, stamps, years } = mergeHkTables(t1, t2, t3, new Set(held), now);
    const computed = rows.map(computeHk);
    const batch = now.toISOString().slice(0, 10);
    await upsertHk(buildHkDbRows(computed, batch, stamps, years), () => { wrote = true; });
    return Response.json(runHkSummary(computed, batch, held, stamps, years));
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsHkFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json(errorHkBody(msg, wrote), { status: 500 });
  }
});
}
