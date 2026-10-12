/// <reference lib="deno.ns" />
// stock-value 编排层。规则权威：spec §2.1（批次）/§4–§6（引擎）/§8（存储与快照）
import { computeValue, roicStats, investedCapital, type ValueRow } from './value_engine.ts';
import type { ValueRaw } from './gs_value.ts';
import { gsValueFetch, mergeValueTables, yearAnchors, buildVQ3, V_Q1, V_Q2, V_Q4, V_Q5 } from './gs_value.ts';
import { fetchCn10yStream, parseCn10y, resolveCn10y } from './rf.ts';

const MIN_ROWS = 4000;                       // 与 stock-score 同阈值：短表一律视为接口异常

// 四腿必须进 MainSnap：`toDbRow` 里 `mainLegs` 直接读它们（spec §7.2 归因句）；**不含 roe**，金融股 ROE 走本批 q5（Task 5 裁定 2）
export type MainSnap = { final: number | null; confidence: string | null;
  quality: number | null; growth: number | null; value: number | null; momentum: number | null };
type DbRow = Record<string, unknown>;

export function buildExtras(
  stamps: Record<string, string>, r: ValueRow,
  meta: { cn10ySource: string; icApprox: boolean; mainLegs: Record<string, number | null> | null },
): Record<string, unknown> {
  return {
    stamps,                                  // 时点纪律（spec §8）：每个字段的 GS 日期戳原样落库
    cn10y_source: meta.cn10ySource,
    ic_approx: meta.icApprox || null,
    main_legs: meta.mainLegs,                // 分歧榜归因用（spec §7.2）：主分四条腿当晚快照
    grp: r.grp,
    owner_cash: r.gate.fcfYield, owner_norm: r.gate.normYield,   // 取小前的两条腿，页面可解释
    veto_reasons: r.gate.vetoReasons,
  };
}

// 池内分位（spec §7.1/§7.4 的「池内 P」）：宇宙 = 本批 in_pool 且 vq 非 null 的行，按 vq 降序。
// 与引擎给 marketRank 的排序口径逐字一致（`sort((a,b)=>b.vq!-a.vq!)`），两套分位才可对照。
// 不在 value_engine 里算：引擎不接 poolSet（池信息是编排层从 stock_pool 取来的）。
export function poolRanks(computed: ValueRow[], poolSet: Set<string>): Map<string, { rank: number; n: number }> {
  const inPool = computed
    .filter(r => r.vq !== null && poolSet.has(r.code.split('.')[0]))
    .sort((a, b) => b.vq! - a.vq!);
  const m = new Map<string, { rank: number; n: number }>();
  inPool.forEach((r, i) => m.set(r.code.split('.')[0], { rank: i + 1, n: inPool.length }));
  return m;
}

export function toDbRow(
  r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none', pool?: Map<string, { rank: number; n: number }>,
): DbRow {
  const bare = r.code.split('.')[0];
  const m = main.get(bare) ?? null;
  return {
    batch_date: batch, code: bare, name: r.name, ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null,
    in_pool: poolSet.has(bare),
    roic_cur: r.roic, fcff: r.fcff, mktcap: r.mktcap, pe: r.pe, pb: r.pb,
    cash: r.cash, debt: r.debt, gw_pct: r.gw, div_yield: r.divYield, div_yield_5y: r.divY5y,
    roic_med: r.gate.roicMed, roic_min3: roicStats(r.roic3).min3, ic: investedCapital(r),
    fcf_yield: r.gate.fcfYield, ep: r.pe !== null && r.pe > 0 ? 100 / r.pe : null,
    bm: r.pb !== null && r.pb > 0 ? 100 / r.pb : null, norm_yield: r.gate.normYield,
    net_cash_ratio: r.cash !== null && r.debt !== null && r.mktcap !== null && r.mktcap > 0
      ? (r.cash - r.debt) / r.mktcap : null,
    debt_ratio: !r.isFin && r.debt !== null && r.cash !== null && r.cash + r.debt > 0 ? r.debt / (r.cash + r.debt) : null,
    owner_yield: r.gate.ownerYield, margin_of_safety: r.gate.mos, cn10y: r.gate.cn10y, rf_fallback: r.gate.rfFallback,
    vq: r.vq, v_moat: r.vMoat, v_cash: r.vCash, v_safety: r.vSafety, v_health: r.vHealth,
    vcov: r.vcov, tier: r.tier, confidence: r.confidence,
    vetoed: r.gate.vetoed, veto_reasons: r.gate.vetoReasons, flags: r.flags,
    ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: r.marketN,
    pool_rank: pool?.get(bare)?.rank ?? null, pool_n: pool?.get(bare)?.n ?? null,
    main_final: m?.final ?? null, main_confidence: m?.confidence ?? null,
    extras: buildExtras(stamps, r, {
      cn10ySource, icApprox: r.gate.icApprox,
      mainLegs: m ? { quality: m.quality, growth: m.growth, value: m.value, momentum: m.momentum } : null,
    }),
  };
}

// 编排层的落库映射：池内分位必须在这里接线到每一行。抽成导出的纯函数（而不是留在 handler 里两行），
// 是为了让「漏接 pool」这种错误变成可测缺陷 —— 它曾让 pool_rank/pool_n 永远 NULL 而全部测试照绿（终审 I-3 变异检验）。
export function buildDbRows(
  computed: ValueRow[], batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none',
): DbRow[] {
  const pool = poolRanks(computed, poolSet);
  return computed.map(r => toDbRow(r, batch, poolSet, main, stamps, cn10ySource, pool));
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

// onChunkSent 用回调而不是让 upsert 返回布尔：分块循环里「本块已发出」是过程事实，
// 由调用方持有 wrote 状态、被调方只负责报告，避免函数返回值在多个 return 点被误解。
// post 可注入（默认 fetch）：「失败时已发出几块」是 wrote 的唯一来源，旧版把它整段留在 handler 里、
// 变异检验直接存活；故只开这一个接缝，不重构整个 handler。导出仅为可测。
export async function upsert(
  rows: DbRow[],
  onChunkSent?: () => void,
  post: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }> = fetch,
): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await post(`${url}/rest/v1/stock_value?on_conflict=batch_date,code`, {
      method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    // 先报告「本块已发出」再检查状态：PostgREST 可能已收下本块但返回非 2xx（限流/超时截断），
    // 此时旧批**已经**被覆盖，catch 里不能再称「保留」。
    onChunkSent?.();
    if (!r.ok) throw new Error(`upsert stock_value ${r.status} ${await r.text()}`);
  }
}

// 主分快照 + 四条腿（供分歧榜归因）：只读最新批次的 in_pool 行（分歧榜本质是池内对比，无需全宇宙）
async function readMainSnapshot(url: string): Promise<{ batch: string | null; map: Map<string, MainSnap> }> {
  const b = await fetch(`${url}/rest/v1/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
  if (!b.ok) throw new Error(`read stock_score batch ${b.status}`);
  const bb = (await b.json())[0] as { batch_date: string } | undefined;
  if (!bb) throw new Error('stock_score has no batch yet — value leg must run AFTER stock-score');
  const d = await fetch(`${url}/rest/v1/stock_score?select=code,final,confidence,quality,growth,value,momentum&batch_date=eq.${bb.batch_date}&in_pool=eq.true`, { headers: svcHeaders() });
  if (!d.ok) throw new Error(`read stock_score rows ${d.status}`);
  const map = new Map<string, MainSnap>();
  for (const x of await d.json()) map.set(String(x.code), {
    final: x.final ?? null, confidence: x.confidence ?? null,
    quality: x.quality ?? null, growth: x.growth ?? null, value: x.value ?? null, momentum: x.momentum ?? null,
  });
  return { batch: bb.batch_date, map };
}

// 遥测（Task 6 评审 parked M5）：今晚池内但主分快照缺位的行数。两个真值源（主分快照取**上一夜**的
// in_pool 行、poolSet 取**今晚**的 stock_pool）在改池当晚必然不等：新入池行 main_final=null →
// 分歧榜归因静默缺席。不报数就永远是静默缺陷。池成员一律从 poolSet 问，不在 ValueRow 上找 in_pool
//（引擎不接池信息，见 poolRanks 同款理由）；抽成导出纯函数同 buildDbRows 的教训（终审 I-3）——不抽就没人测得动。
export function countMainMissing(computed: ValueRow[], poolSet: Set<string>, mainMap: Map<string, MainSnap>): number {
  return computed.filter(r => poolSet.has(r.code.split('.')[0]) && !mainMap.has(r.code.split('.')[0])).length;
}

// 遥测（M6）：主分快照龄期。stock-score 连失败夜会把自己的陈快照当今晚的落库；
// 尽力而为纪律是**不炸批**，但必须把陈度如实报出。mainBatch=null（无主分批次）不属于「陈」，交给主分自己报错。
export function isMainStale(batch: string, mainBatch: string | null, maxAgeDays = 3): boolean {
  if (mainBatch === null) return false;
  return (Date.parse(`${batch}T00:00:00Z`) - Date.parse(`${mainBatch}T00:00:00Z`)) / 86_400_000 > maxAgeDays;
}

// 首跑成功载荷。抽成导出纯函数的理由与 buildDbRows 完全同款（终审 I-3 陷阱）：遥测字段的**接线**（把 poolSet
// 与 main 递到正确的谓词上）若留在 handler 里，就没有任何测试能发现 `main_missing` 永远不被计算、或
// `main_stale` 拿错了批次。这里把两个遥测和口径计数一并算完，handler 只递参数、不拼对象。
type MainSnapshot = { batch: string | null; map: Map<string, MainSnap> };
export function runSummary(
  computed: ValueRow[], batch: string, poolSet: Set<string>, main: MainSnapshot,
  resolved: { cn10y: number | null; source: string }, divLegOk: boolean, finRoeRows: number,
  stamps: Record<string, string>,
): Record<string, unknown> {
  const by = (t: string) => computed.filter(r => r.tier === t).length;
  return {
    ok: true, batch_date: batch, rows: computed.length, qualified: by('qualified'),
    too_rich: by('too_rich'), vetoed: by('vetoed'), unqualified: by('unqualified'),
    a_level: computed.filter(r => r.confidence === 'A').length,
    cn10y: resolved.cn10y, cn10y_source: resolved.source, div_leg_ok: divLegOk,
    fin_roe_rows: finRoeRows,   // 遥测（Task 6 评审 M4）：带后缀键的金融股 ROE 行数——它是唯一无单测护栏的否决4 入口，靠这个数才能「首夜看穿」
    main_batch: main.batch,
    main_missing: countMainMissing(computed, poolSet, main.map),   // 遥测（M5）：改池当晚新入池、归因静默缺席的只数
    main_stale: isMainStale(batch, main.batch),                    // 遥测（M6）：主分快照龄期超阈，不炸批但如实报出
    stamps,
  };
}

// 失败载荷（M3）：kept_old_batch 必须由实际写入过程回答，不得硬编 true。upsert 无事务，5224 行分 6 块，
// 第 4 块失败时前 3 块已落库而旧批已被覆盖；前端读「最新批次」会拿到截断宇宙，谎称「旧批保留」比报错更难发现。
// 抽成导出纯函数同上两个谓词的理由：「写过了仍称保留」这个错误方向必须变成可测缺陷。
export function errorBody(msg: string, wrote: boolean): Record<string, unknown> {
  return { ok: false, error: msg, kept_old_batch: !wrote };
}

if (!Deno.env.get('STOCK_VALUE_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const mode = new URL(req.url).searchParams.get('mode') || 'run';
  const url = Deno.env.get('SUPABASE_URL')!;
  // M3（Task 6 评审）：「旧批是否还在」必须由实际写入过程回答，不是由 catch 分支猜。**必须声明在 try 外面**——
  // try 内的 let 对 catch 不可见；放外层则「进不了 try 就是没写」依旧成立。
  let wrote = false;
  try {
    if (mode === 'ping') {
      const t = await gsValueFetch(V_Q4, key, 30_000);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const now = new Date();
    const { annualBase } = yearAnchors(now);
    // 四个硬批次：任一失败/短表/缺列 → assertCols/行守抛错 → 外层 catch 保留旧批次
    const [t1, t2, t3, t4] = await Promise.all([
      gsValueFetch(V_Q1, key), gsValueFetch(V_Q2, key), gsValueFetch(buildVQ3(annualBase), key), gsValueFetch(V_Q4, key),
    ]);
    for (const t of [t1, t2, t3, t4]) if ((t['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error('GS 短表，保留旧批次');
    // 分红+金融 ROE 批是“尽力而为”腿（同 stock-score 现金腿）：失败只置 NA，绝不杀整批
    let t5 = null;
    try { const c = await gsValueFetch(V_Q5, key, 60_000); if ((c['股票代码']?.length ?? 0) >= MIN_ROWS) t5 = c; } catch { t5 = null; }
    const { rows, stamps } = mergeValueTables(t1, t2, t3, t4, t5, now);

    // cn10y：override 优先，其次自动取数，全缺则引擎走 OWNER_YIELD_FLOOR 退化
    const cfgR = await fetch(`${url}/rest/v1/value_config?select=cn10y_override,cn10y_manual_on&limit=1`, { headers: svcHeaders() });
    const cfg = cfgR.ok ? ((await cfgR.json())[0] ?? {}) : {};
    const resolved = resolveCn10y({
      override: cfg.cn10y_override ?? null, overrideOn: cfg.cn10y_manual_on ?? null,
      fetched: parseCn10y(await fetchCn10yStream(key)), today: now.toISOString().slice(0, 10),
    });

    const main = await readMainSnapshot(url);
    const poolR = await fetch(`${url}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
    if (!poolR.ok) throw new Error(`read stock_pool ${poolR.status}`);
    const poolSet = new Set(((await poolR.json()) as { code: string }[]).map(x => x.code));

    // 金融股否决4 的 ROE 只认本批自己那一列（Task 5 裁定 2）；钥匙必须是 `ValueRaw.code` 原样（带后缀），与引擎内部 `finRoe?.get(s.code)` 同一把
    const finRoe = new Map<string, number>();
    for (const s of rows) if (s.roe !== null) finRoe.set(s.code, s.roe);
    const computed = computeValue(rows as ValueRaw[], resolved.cn10y, finRoe);
    const batch = now.toISOString().slice(0, 10);
    await upsert(buildDbRows(computed, batch, poolSet, main.map, stamps, resolved.source), () => { wrote = true; });

    return Response.json(runSummary(computed, batch, poolSet, main, resolved, t5 !== null, finRoe.size, stamps));
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsValueFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json(errorBody(msg, wrote), { status: 500 });
  }
});
}
