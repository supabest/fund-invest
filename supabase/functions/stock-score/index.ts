/// <reference lib="deno.ns" />
import { computeScores, type Stock } from './engine.ts';
import { gsFetch, mergeTables, Q_FIN, Q_MOM, Q_CASH, type GsTable } from './gs.ts';

const MIN_ROWS = 4000;

// —— 以下 mix/extras 相关纯函数可被 index_test.ts 直接单测（无网络依赖）——
interface MixSegment { name: string; ratio: number }

// stock_business_mix 行（bare code 为键；segments 项 = {name, ratio}）
interface MixRow {
  code: string; // bare code（如 '688378'）
  mixed?: boolean; shift?: boolean;
  segments?: MixSegment[] | null; report_date?: string | null;
}

// extras 揭示位（信息位，不参与评分）：正常化 PE 近似 + 主营结构；pe/gm 来自 ScoreRow（extends Stock）
export function buildRevealExtras(
  r: { pe: number | null; gm: number | null },
  m?: MixRow | null,
): Record<string, unknown> {
  const gm = r.gm ?? 0; // 先局部化，供 TS 收窄后再参与乘法
  return {
    implied_normal_pe_approx: r.pe !== null && gm > 0
      ? Math.round(r.pe * (1 + gm / 100) * 100) / 100 : null, // spec §4.6 近似口径；R-APPROX：必须带 _approx 后缀，前端标「≈」
    mix: m ? { segments: m.segments?.slice(0, 2) ?? null, report_date: m.report_date ?? null, shift: !!m.shift } : null,
  };
}

// R-WARNCONF 终裁：warnings 是评分后生成的展示位，无法回灌引擎 → 编排层收尾降级，仅 A→B
export function applyWarnConf<T extends { code: string; confidence: 'A' | 'B' | 'C' }>(rows: T[], warnings: Map<string, string[]>): void {
  for (const r of rows) if ((warnings.get(r.code) ?? []).length > 0 && r.confidence === 'A') r.confidence = 'B';
}

// service 角色 headers：与 daily-update index.ts L181-183 的 `H` 构造完全一致
// （apikey + 'Bearer ' + serviceKey + Content-Type），生产代码不留 'placeholder'。
function svcHeaders(): Record<string, string> {
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

async function upsert(rows: Record<string, unknown>[], table: string, onConflict: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
  }
}

// C 层读 stock_business_mix（business-mix 维护）；任何失败静默降级为空 Map，绝不阻塞跑批
async function fetchMixMap(url: string): Promise<Map<string, MixRow>> {
  const map = new Map<string, MixRow>();
  try {
    const resp = await fetch(`${url}/rest/v1/stock_business_mix?select=code,mixed,shift,segments,report_date`, { headers: svcHeaders() });
    if (!resp.ok) return map;
    for (const m of (await resp.json()) as MixRow[]) map.set(m.code, m);
  } catch { /* 外部/表缺失 → C 层静默跳过（spec §5.3） */ }
  return map;
}

// 守卫仅针对单测场景（index_test.ts 先设 STOCK_SCORE_DISABLE_SERVE 再动态 import）；
// 线上 Edge 不会注入该变量， Deno.serve 注册行为不变。
if (!Deno.env.get('STOCK_SCORE_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const u = new URL(req.url); const mode = u.searchParams.get('mode') || 'run';
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  try {
    if (mode === 'ping') {
      const t = await gsFetch('工程机械行业市盈率低于20的股票', key);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const [finT, momT] = [await gsFetch(Q_FIN, key), await gsFetch(Q_MOM, key)];
    const n = (finT['股票代码']?.length ?? 0);
    if (n < MIN_ROWS || (momT['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error(`GS 行数异常 fin=${n}，保留旧批次`);
    // C-1（spec §4.3）：现金腿必须独立第 3 次 GS 调用（并入会被 GS 误解析成同比增长率列）；
    // 独立且静默降级——短表/畸形/异常一律置 null，绝不阻塞跑批或覆盖好批次（缺腿由引擎 renorm 处理）。
    let cashT: GsTable | null = null;
    try {
      const c = await gsFetch(Q_CASH, key);
      if ((c['股票代码']?.length ?? 0) >= MIN_ROWS) cashT = c;   // 短表/畸形 → 保持 null（该腿被 renorm 排除）
    } catch { cashT = null; }                                    // 现金腿尽力而为；缺席 → 保守降级
    const stocks: Stock[] = mergeTables(finT, momT, cashT);
    // C 层混合业务标记：仅设 s.mixed，分组降级（→MARKET）由 engine.assignGroups 完成
    const mixMap = await fetchMixMap(Deno.env.get('SUPABASE_URL')!);
    let mixedCount = 0;
    for (const s of stocks) {
      const m = mixMap.get(s.code.split('.')[0]);
      if (m?.mixed) { s.mixed = true; mixedCount++; }
    }
    const periodStamp = (Object.keys(finT).find(k => k.startsWith('资产负债率')) ?? '').match(/\[(\d{8})\]/)?.[1] ?? '';
    const batch = new Date().toISOString().slice(0, 10);
    const rows = computeScores(stocks);
    const poolResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
    if (!poolResp.ok) throw new Error(`read stock_pool ${poolResp.status} ${await poolResp.text()}`);
    const pool = await poolResp.json();
    const poolSet = new Set((pool as { code: string }[]).map(p => p.code));
    const scored = rows.filter(r => r.final !== null);
    const top = scored.filter(r => poolSet.has(r.code.split('.')[0])).slice(0, 10);
    // 增强：Top10+持仓 周期警示（扣非增速>100 → 提示核对3年CAGR），失败不阻塞
    const warnings = new Map<string, string[]>();
    for (const r of [...top, ...scored.filter(r => ['000338.SZ', '002415.SZ', '600031.SH'].includes(r.code))]) {
      if (r.kc !== null && r.kc > 100) warnings.set(r.code, [`单年扣非+${Math.round(r.kc)}%，需查3年CAGR/周期位置`]);
    }
    // R-WARNCONF 终裁：警示行置信度 A→B（spec §4.7 warning 计入；B/C 不动）
    applyWarnConf(scored, warnings);
    await upsert(scored.map(r => ({
      batch_date: batch, code: r.code.split('.')[0], name: r.name,
      ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null, ths_l3: r.ths[2] ?? null,
      quality: r.quality, growth: r.growth, value: r.value, momentum: r.momentum, final: r.final,
      ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: scored.length,
      in_pool: poolSet.has(r.code.split('.')[0]), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [], confidence: r.confidence,
      extras: { fin_period: periodStamp, abs_trend: r.absTrend, pool: { grp: r.grp, ind_n: r.indN }, ...buildRevealExtras(r, mixMap.get(r.code.split('.')[0])) },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, mixed_injected: mixedCount, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
}
