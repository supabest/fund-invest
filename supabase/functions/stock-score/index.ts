/// <reference lib="deno.ns" />
import { computeScores, type Stock } from './engine.ts';
import { gsFetch, mergeTables, Q_FIN, Q_MOM } from './gs.ts';

const MIN_ROWS = 4000;

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
    const stocks: Stock[] = mergeTables(finT, momT);
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
    await upsert(scored.map(r => ({
      batch_date: batch, code: r.code.split('.')[0], name: r.name,
      ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null, ths_l3: r.ths[2] ?? null,
      quality: r.quality, growth: r.growth, value: r.value, momentum: r.momentum, final: r.final,
      ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: scored.length,
      in_pool: poolSet.has(r.code.split('.')[0]), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [],
      extras: { fin_period: periodStamp, abs_trend: r.absTrend },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
