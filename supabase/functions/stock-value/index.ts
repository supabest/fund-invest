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

async function upsert(rows: DbRow[]) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/stock_value?on_conflict=batch_date,code`, {
      method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
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

if (!Deno.env.get('STOCK_VALUE_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const mode = new URL(req.url).searchParams.get('mode') || 'run';
  const url = Deno.env.get('SUPABASE_URL')!;
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
    await upsert(buildDbRows(computed, batch, poolSet, main.map, stamps, resolved.source));

    const by = (t: string) => computed.filter(r => r.tier === t).length;
    return Response.json({ ok: true, batch_date: batch, rows: computed.length, qualified: by('qualified'),
      too_rich: by('too_rich'), vetoed: by('vetoed'), unqualified: by('unqualified'),
      a_level: computed.filter(r => r.confidence === 'A').length,
      cn10y: resolved.cn10y, cn10y_source: resolved.source, div_leg_ok: t5 !== null,
      fin_roe_rows: finRoe.size,   // 遥测（Task 6 评审 M4）：带后缀键的金融股 ROE 行数——它是唯一无单测护栏的否决4 入口，靠这个数才能「首夜看穿」
      main_batch: main.batch, stamps });
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsValueFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json({ ok: false, error: msg, kept_old_batch: true }, { status: 500 });
  }
});
}
