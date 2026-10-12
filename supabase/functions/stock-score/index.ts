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

// ==== REST 分页读：与 stock-value/index.ts 同款语义复制（A3 先例：不抽公共模块，任一侧改动同步另一侧）====
// 缺陷不在本腿源码里发现，是价值腿重跑后直查出来的：今晚 `stock_score.in_pool` 标记数正好 **1000**，
// 而 stock_pool 有 1165 只、本批宇宙中对得上的是 1116 只——116 只池内股的 `in_pool`/池内分位是假阴性
//（价值腿响应里的 `main_missing=116` 就是它的回声）。PostgREST `db-max-rows` 默认 1000，
// 而裸 `?select=code` 单页 GET 返 **HTTP 206 + `Content-Range: 0-999/1165`**：不报错、不炸批，静默截断。
// 实测另一形态：offset 越过总数返 **416 PGRST103** 而不是空数组 ⇒ 收尾条件只能是「已收 >= 总数」。
// 五条守卫任一不齐就抛错炸批：宁可今晚不跑，也不能拿一个少 116 只的池明天继续。
type PageGet = (u: string, init: RequestInit) => Promise<{
  ok: boolean; status: number;
  headers: { get(k: string): string | null };
  json(): Promise<unknown>;
}>;

export async function readAllRows(
  base: string, resource: string, params: string,
  get: PageGet = fetch as unknown as PageGet, pageSize = 1000,
): Promise<Record<string, unknown>[]> {
  // offset 分页只有在确定性排序下才不重不漏（平台默认行序会随真空页/簇迁移漂移）
  if (!/(^|&)order=/i.test(params)) throw new Error(`read ${resource}: offset 分页要求确定性 order=`);
  const out: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let from = 0; ;) {
    const r = await get(`${base}/rest/v1/${resource}?${params}&limit=${pageSize}&offset=${from}`,
      { headers: { ...svcHeaders(), 'Prefer': 'count=exact' } });
    if (!r.ok) throw new Error(`read ${resource} page@${from}: ${r.status}`);
    const m = /^(\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
    if (!m) throw new Error(`read ${resource} page@${from}: Content-Range 拿不到总数（count=exact 未生效）`);
    const [start, end, count] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (total === null) total = count;
    else if (count !== total) throw new Error(`read ${resource}: 总数中途变化 ${total} -> ${count}`);
    if (start !== from) throw new Error(`read ${resource}: 页起点 ${start} != 请求 offset ${from}`);
    const page = (await r.json()) as Record<string, unknown>[];
    // 声明的区间长度与实际行数必须一致：逐页自证，不等收尾才发现页被吃了。
    // 有了 `start === from` + 这一条，各页严格铺满 [0, total-1]，所以不必再写「总行数 == total」的收尾守卫（恒真，属死代码）
    if (end - start + 1 !== page.length) throw new Error(`read ${resource} page@${from}: 声明 ${end - start + 1} 行（总数 ${total}）实得 ${page.length} 行`);
    if (page.length === 0) throw new Error(`read ${resource}: page@${from} 空页而总数 ${total} 未到`);   // 进度守卫：按上面两条推导本不可达，但一旦有人改松了守卫，这里必须是报错而不是死循环吊死整个函数
    out.push(...page);
    from += page.length;                                  // 推进量=实收，平台把 db-max-rows 调得比 pageSize 小时也不会静默少收
    if (from >= total) break;
  }
  return out;
}

// 池成员（`in_pool` 与池内分位的唯一真值源）：去重后的 Set 行数必须等于收回行数——Set 会静默吞掉重复 code，
// 只能在这里拿两个数把它拉回来。导出可测：变异检验靠它验证「只读第一页」的写法不能溜过。
export async function readPoolSet(base: string, get?: PageGet, pageSize?: number): Promise<Set<string>> {
  const rows = await readAllRows(base, 'stock_pool', 'select=code&order=code.asc', get, pageSize);
  const set = new Set(rows.map(x => String(x.code)));
  if (set.size !== rows.length) throw new Error(`read stock_pool: 去重后 ${set.size} != 收回 ${rows.length}（池内有重复 code）`);
  return set;
}

// 池成员在 handler 里有两处消费：每行的 `in_pool` 标记、以及池内 Top10。两者必须同一份分页读，
// 所以抽成一个导出函数（与价值腿 runSummary 的终审 I-3 教训同款）：「读」与「用」都留在 handler 里，
// 就没有任何测试能发现「池读退回裸单页」——2026-10-12 变异检验实测 MS6（把 readPoolSet 换成裸 fetch）当场存活，
// 而它的生产后果正是本腿要修的缺陷：尾部 116 只池内股的 in_pool 假阴性。
export async function pickPoolView<T extends { code: string }>(
  scored: T[], url: string = Deno.env.get('SUPABASE_URL')!,
  get: PageGet = fetch as unknown as PageGet,
): Promise<{ inPool: (code: string) => boolean; top: T[] }> {
  const poolSet = await readPoolSet(url, get);   // 分页读：裸 `?select=code` 在 1165 只池上会静默只回 1000 只
  // 入库/比较的 code 口径不带后缀（upsert 行用 r.code.split('.')[0]），池也是 6 位码；
  // 但入参带市场后缀（GS 表里是 600000.SH），谓词自己剔后缀，不让调用方忘记这一步
  const has = (code: string) => poolSet.has(code.split('.')[0]);
  return { inPool: has, top: scored.filter(r => has(r.code)).slice(0, 10) };
}

// C 层读 stock_business_mix（business-mix 维护）；任何失败静默降级为空 Map，绝不阻塞跑批。
// ⚠ 静默降级只适用于「整张表读不到」（读不到就少一点 extras 信息位）；它绝不能成为「读少一半」的遮羞布：
// 今晚 972 行看着安全，而 business-mix 每晚补 300 只 ⇒ 明夜就过 1000，裸读会静默丢掉尾部所有 mix 标记。
// 导出 + 注入 get 仅为可测。
export async function fetchMixMap(url: string, get: PageGet = fetch as unknown as PageGet): Promise<Map<string, MixRow>> {
  const map = new Map<string, MixRow>();
  try {
    // order=code.asc 不改变语义：本函数只按 code 建 Map，与行序无关（加确定性 order 是分页的前提）
    // readAllRows 只交回 Record<string, unknown>[]（通用分页读不认得业务列），所以这里把形状写明；
    // 直接 `as MixRow[]` 会被 TS2352 拒（与价值腿 readMainSnapshot 的 MainCol 同款教训）
    type MixCol = { code: string } & Partial<MixRow>;
    for (const m of (await readAllRows(url, 'stock_business_mix', 'select=code,mixed,shift,segments,report_date&order=code.asc', get)) as MixCol[]) map.set(m.code, m);
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
      const c = await gsFetch(Q_CASH, key, 20_000);   // 尽力而为腿用短预算，避免最坏情况撞平台超时杀整批
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
    const scored = rows.filter(r => r.final !== null);
    const pool = await pickPoolView(scored);   // 池读与两处消费同源分页（见 pickPoolView 上方注释）
    const top = pool.top;
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
      in_pool: pool.inPool(r.code), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [], confidence: r.confidence,
      extras: { fin_period: periodStamp, abs_trend: r.absTrend, pool: { grp: r.grp, ind_n: r.indN }, ...buildRevealExtras(r, mixMap.get(r.code.split('.')[0])) },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, mixed_injected: mixedCount, cash_leg_ok: cashT !== null, cash_rows: cashT?.['股票代码']?.length ?? 0, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
}
