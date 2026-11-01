// supabase/functions/stock-value/index_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { MainSnap } from './index.ts';            // 类型导入编译期擦除，不会触发 Deno.serve
Deno.env.set('STOCK_VALUE_DISABLE_SERVE', '1');           // import 即绑端口 → 必须先关
const { buildExtras, toDbRow, poolRanks, buildDbRows, countMainMissing, isMainStale, runSummary, errorBody,
  upsert, readAllRows, readPoolSet, readMainSnapshot } = await import('./index.ts');

const row = { code: '600031.SH', name: '测试制造', ths: ['机械设备', '工程机械', '工程机械'],
  isFin: false, isST: false, roic: 18.4, roic3: [17.1, 18.0, 18.9], fcff: 5.400171e12, cash: 4e10, debt: 1e10,
  gw: null, pe: 14.2, pb: 2.1, mktcap: 2e10, divYield: 3.2, divY5y: 2.8, roe: 3.1,
  gate: { ownerYield: 6.2, mos: 4.35, cn10y: 1.85, rfFallback: false, icApprox: true, roicMed: 18,
    fcfYield: 27000.855, normYield: 2.7, passed: true, tooRich: false, vetoed: false, vetoReasons: [] },
  vq: 78.4, vMoat: 80, vCash: 70, vSafety: 75, vHealth: 66, vcov: 1, tier: 'qualified', confidence: 'A',
  grp: 'L2:机械设备-工程机械', indRank: 3, indN: 40, marketRank: 12, marketN: 2200, flags: ['ic_approx'] } as any;

const STAMPS = { fin_period: '20260630', val_period: '20260930', roic_period: '20251231' };
// 显式标注 Map<string, MainSnap>：字面量直推会把 quality 等收窄为 number，与 MainSnap 的 number|null 不同变而报错
const main = new Map<string, MainSnap>([['600031',
  { final: 71.2, confidence: 'A', quality: 82, growth: 40, value: 44, momentum: 30 }]]);

Deno.test('toDbRow：代码剔后缀、列名逐字对齐迁移、不丢主分快照与四条腿', () => {
  const db = toDbRow(row as never, '2026-10-11', new Set(['600031']), main, STAMPS, 'auto');
  assertEquals(db.code, '600031');                       // bare code（前端按 6 位代码 join）
  assertEquals(db.batch_date, '2026-10-11');
  assertEquals(db.in_pool, true);
  assertEquals(db.main_final, 71.2);
  assertEquals(db.owner_yield, 6.2);
  assertEquals(db.tier, 'qualified');
  // 派生列必须真实落库（前视复盘要用 ic 做近似质量审计，不得留空位）：fixture cash=4e10 debt=1e10
  assertEquals(db.ic, 5e10);
  assertEquals(db.roic_min3, 17.1);
  assertEquals(db.debt_ratio, 0.2);
  assertEquals(db.net_cash_ratio, (4e10 - 1e10) / 2e10);   // 1.5
  // 时点纪律（spec §8）与归因快照：stamps 绝不因“为了可读性”而被丢掉
  assertEquals((db.extras as Record<string, unknown>).stamps, STAMPS);
  assertEquals(((db.extras as Record<string, unknown>).main_legs as Record<string, number>).momentum, 30);
  assertEquals((db.extras as Record<string, unknown>).cn10y_source, 'auto');
});

Deno.test('toDbRow：非池行 in_pool=false 且 main_final/main_legs 均=null（不谎称有快照）', () => {
  const db = toDbRow(row as never, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.in_pool, false); assertEquals(db.main_final, null);
  assertEquals((db.extras as Record<string, unknown>).main_legs, null);
});

Deno.test('buildExtras：日期戳全部落库（时点纪律）+ cn10ySource + ic_approx', () => {
  const ex = buildExtras(STAMPS, row as never, { cn10ySource: 'auto', icApprox: true, mainLegs: null });
  assertEquals(ex.stamps, STAMPS);
  assertEquals(ex.cn10y_source, 'auto');
  assertEquals(ex.ic_approx, true);
});

// 决议 29 的地基（R2 第二把尺要的是斜率）：三点年报序列连年份一起落 `extras`。
// 只落 `roic_cur/roic_med/roic_min3` 不够——med 是中位数、min3 是最小值，时间顺序在落库那一刻就丢了，
// 事后从这三列无法还原「2023 年是多少」。年份直接来自上游已锤死的连续三年守卫，不在这里重算。
// ⚠ 序列**必须乱序**：夹具若取升序 [17.1,18.0,18.9]，把实现改成 `.sort()` 的变异体是恒等变换 → 测试假活
//   （变异检验实测：初版用升序夹具时 M4 在 79 全绿下存活）。乱序才是「保序」这件事的证据。
Deno.test('buildExtras：roic_hist = 年份 + 三点序列**按年升序原样保留**（不排序、不统计化）', () => {
  const mix = { ...row, roic3: [18.9, 17.1, 18.0] } as never;    // 2023 最高、2024 掉、2025 回升
  const ex = buildExtras({ ...STAMPS, roic_fys: '2023,2024,2025' }, mix,
    { cn10ySource: 'auto', icApprox: true, mainLegs: null });
  assertEquals(ex.roic_hist, { years: ['2023', '2024', '2025'], values: [18.9, 17.1, 18.0] });
});

Deno.test('buildExtras：上游没有 roic_fys 时 roic_hist=null（不猜年份，宁缺一个标注）', () => {
  const ex = buildExtras(STAMPS, row as never, { cn10ySource: 'auto', icApprox: true, mainLegs: null });
  assertEquals(ex.roic_hist, null);
});

Deno.test('toDbRow：vetoed 行照落库（veto_reasons 带原因，前视需要被排除的那批）', () => {
  // 引擎对否决者不产 VQ（tier 优先于打分），此处模拟其输出形态，验证 toDbRow 不丢原始位
  const bad = { ...row, tier: 'vetoed', vq: null, gate: { ...row.gate, vetoed: true, vetoReasons: ['资不抵债'] } } as never;
  const db = toDbRow(bad, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.vetoed, true);
  assertEquals(db.veto_reasons, ['资不抵债']);
  assertEquals(db.vq, null);                                // 否决者不产 VQ，但原始位保留
});

Deno.test('toDbRow：rf_fallback 行 mos=null 不得变成 0（两种“无”不等价）', () => {
  const fb = { ...row, gate: { ...row.gate, mos: null, rfFallback: true } } as never;
  const db = toDbRow(fb, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.margin_of_safety, null);
  assertEquals(db.rf_fallback, true);
});

// ==== 终审修复单 F-3（I-3）：池内分位两列的接线 ==== 
Deno.test('poolRanks：只池内有分行占位、vq 降序 rank；toDbRow 第 7 参可选，不传时两键为 null 而非 undefined', () => {
  const a = { ...row, code: '600031.SH', vq: 90 } as never;
  const b = { ...row, code: '000001.SZ', vq: 70 } as never;
  const c = { ...row, code: '300750.SZ', vq: 80 } as never;
  const out = { ...row, code: '999999.BJ', vq: 99 } as never;          // 池外行：不得占位（n 只数池内）
  const poolSet = new Set(['600031', '000001', '300750']);
  const pool = poolRanks([a, b, c, out] as never[], poolSet);
  assertEquals(pool.size, 3);
  assertEquals(pool.get('600031'), { rank: 1, n: 3 });                 // vq 降序：90 > 80 > 70
  assertEquals(pool.get('300750'), { rank: 2, n: 3 });
  assertEquals(pool.get('000001'), { rank: 3, n: 3 });
  assertEquals(pool.has('999999'), false);
  const db = toDbRow(a, '2026-10-11', poolSet, main, STAMPS, 'auto', pool);
  assertEquals(db.pool_rank, 1);
  assertEquals(db.pool_n, 3);
  // 第 7 参可选：既有 5 条测试的位置调用一字不动；不传时两键必须是 null（不得以 undefined 落库）
  const dbNoPool = toDbRow(a, '2026-10-11', poolSet, main, STAMPS, 'auto');
  assertEquals(dbNoPool.pool_rank, null);
  assertEquals(dbNoPool.pool_n, null);
});

Deno.test('buildDbRows：接线本身被测（变异检验 M3 复验）——漏把 poolRanks 结果传给 toDbRow 时本条必红', () => {
  const a = { ...row, code: '600031.SH', vq: 90 } as never;
  const b = { ...row, code: '000001.SZ', vq: 70 } as never;
  const noScore = { ...row, code: '300750.SZ', vq: null, tier: 'vetoed',
    gate: { ...row.gate, vetoed: true, vetoReasons: ['gw_high'] } } as never;
  const poolSet = new Set(['600031', '000001', '300750']);
  const dbRows = buildDbRows([a, b, noScore] as never[], '2026-10-11', poolSet, main, STAMPS, 'auto');
  const by = (c: string) => dbRows.find(d => d.code === c)!;
  assertEquals(by('600031').pool_rank, 1);                              // 池内有分两只：rank 1/2、n=2
  assertEquals(by('000001').pool_rank, 2);
  assertEquals(by('600031').pool_n, 2);
  assertEquals(by('000001').pool_n, 2);
  assertEquals(by('300750').pool_rank, null);                           // vq=null 不占池内位
  assertEquals(by('300750').pool_n, null);
});

// ==== Step 5b 遥测收口（Task 6 评审 parked M3/M5/M6）====
Deno.test('countMainMissing：只数「今晚池内且上一夜主分快照缺位」的行（改池当晚新入池者 = 分歧榜归因静默缺席的数）', () => {
  // 池成员来自 poolSet（引擎的 ValueRow 不带 in_pool，与 poolRanks 同理）——若实现改去读 r.in_pool，本条必红
  const poolSet = new Set(['600031', '000001', '300750']);
  const covered = { ...row, code: '600031.SH' } as never;                  // 池内且在 main 里 → 不计
  const freshInPool = { ...row, code: '000001.SZ' } as never;              // 今晚刚入池，上一夜快照无此码 → 计 1
  const outOfPool = { ...row, code: '600519.SH' } as never;                // 池外不计（它本来就不该有归因）
  assertEquals(countMainMissing([covered, freshInPool, outOfPool] as never[], poolSet, main), 1);
  assertEquals(countMainMissing([covered, outOfPool] as never[], poolSet, main), 0);   // 全覆盖 → 0，不是 null/undefined
  assertEquals(countMainMissing([], poolSet, main), 0);
  assertEquals(countMainMissing([freshInPool] as never[], new Set<string>(), main), 0); // 空池 → 0（无池内行可缺）
  assertEquals(countMainMissing([covered] as never[], poolSet, new Map()), 1);         // 主分快照整体缺席时每个池内行都算缺位
});

Deno.test('isMainStale：主分快照龄期严格大于 3 天才算陈；批次缺席（null）不归「陈」', () => {
  assertEquals(isMainStale('2026-10-11', '2026-10-11'), false);   // 同夜
  assertEquals(isMainStale('2026-10-11', '2026-10-08'), false);   // 恰好 3 天：不炸不报
  assertEquals(isMainStale('2026-10-11', '2026-10-07'), true);    // 4 天
  assertEquals(isMainStale('2026-10-11', null), false);           // 无主分批次交给主分自己报错
  assertEquals(isMainStale('2026-10-11', '2026-10-09', 1), true); // 阈值可参数化（干跑时人工收紧）
});

Deno.test('runSummary：两个遥测的接线本身被测（buildDbRows 同款守法）——漏算、拿错批次、掉字段时本条必红', () => {
  const poolSet = new Set(['600031', '000001']);
  const s = runSummary([row, { ...row, code: '000001.SZ' } as never] as never[], '2026-10-11', poolSet,
    { batch: '2026-10-11', map: main }, { cn10y: 1.85, source: 'auto' }, true, 7, STAMPS);
  assertEquals(s.ok, true);
  assertEquals(s.batch_date, '2026-10-11');
  assertEquals(s.rows, 2);
  assertEquals(s.qualified, 2);                       // tier 计数不得因抽函数而走形
  assertEquals(s.a_level, 2);
  assertEquals(s.main_batch, '2026-10-11');
  assertEquals(s.main_missing, 1);                    // 000001 今晚入池、上一夜快照无此码
  assertEquals(s.main_stale, false);
  assertEquals(s.div_leg_ok, true);
  assertEquals(s.fin_roe_rows, 7);
  assertEquals(s.cn10y, 1.85);
  assertEquals(s.cn10y_source, 'auto');
  assertEquals(s.stamps, STAMPS);

  // 陈批必须报陈（main_stale 递的是本批 vs 主分批次，递错了本条红）；全覆盖时 main_missing 必须是 0 而不是 undefined
  const stale = runSummary([row] as never[], '2026-10-11', new Set(['600031']),
    { batch: '2026-10-07', map: main }, { cn10y: null, source: 'none' }, false, 0, STAMPS);
  assertEquals(stale.main_stale, true);
  assertEquals(stale.main_missing, 0);
  assertEquals(stale.div_leg_ok, false);              // 尽力而为腿挂了要如实报 false，不得隐去
  assertEquals(stale.cn10y, null);
});

Deno.test('errorBody：写尚未发生才配得上「旧批保留」；分块中途挂掉必须报 false（变异：硬编 true 时本条红）', () => {
  assertEquals(errorBody('GS 短表', false).kept_old_batch, true);    // fetch 阶段就报错：一行都没写，旧批确实还在
  assertEquals(errorBody('upsert stock_value 429', true).kept_old_batch, false);  // 已发出过块：旧批已被覆盖，不得再称保留
  assertEquals(errorBody('e', true).ok, false);
  assertEquals(errorBody('rate limited apiKey=REDACTED', false).error, 'rate limited apiKey=REDACTED');
});

// upsert 是 wrote 的唯一真值源；不注入 post 就测不到「失败时已发出几块」，变异检验 NB5 曾因此存活。
Deno.test('upsert：每发出一个分块就报告一次（2500 行→ 3 块，尺寸 1000/1000/500）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://stub.invalid');
  const sizes: number[] = [];
  let reports = 0;
  await upsert(Array.from({ length: 2500 }, () => ({ code: 'x' })), () => { reports++; },
    async (_u: string, init: RequestInit) => {
      sizes.push((JSON.parse(String(init.body)) as unknown[]).length);
      return { ok: true, status: 201, text: async () => '' };
    });
  assertEquals(sizes, [1000, 1000, 500]);
  assertEquals(reports, 3);
});

Deno.test('upsert：第 2 块被拒仍然要报告 2 次发出，且必须抛错（旧批已被覆盖，kept_old_batch 得走 false）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://stub.invalid');
  let calls = 0;
  let reports = 0;
  const err = await assertRejects(() => upsert(Array.from({ length: 2000 }, () => ({ code: 'x' })),
    () => { reports++; },
    async () => { calls++; const second = calls === 2;
      return { ok: !second, status: second ? 502 : 201, text: async () => 'bad gateway' };
    }), Error);
  assertEquals(calls, 2);                     // 第二块挂了就不发第三块：不写部分截断宇宙
  assertEquals(reports, 2);                   // 含被拒那块：它已被服务端收下，事实是「动过手」
  assertEquals(String(err).includes('upsert stock_value 502'), true);
});

Deno.test('upsert：空行集一块也不发（不能发空数组去把本批当作空覆掉）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://stub.invalid');
  let calls = 0;
  await upsert([], () => { throw new Error('空批不应报告'); },
    async () => { calls++; return { ok: true, status: 201, text: async () => '' }; });
  assertEquals(calls, 0);
});

// ==== 2026-10-12 首跑后对账抓到的真缺陷：PostgREST `db-max-rows`=1000 的静默截断 ====
// 取证（服务端 pg_net 实发 GET，只读）：`?select=code` 单页返回 **HTTP 206 + Content-Range `0-999/1165`**，
// 于是 1165 只池只标出 1000 只 in_pool，116 只假阴性。它不报错、不炸批，只让「池内」这条维度静默失真。
// 同一条读法也用在主分快照（`stock_score?...&in_pool=eq.true` 池内 1116 行 → 同样只回 1000）。
// 实测的第二条形态：offset 越过总数返回 **416 PGRST103**（不是空数组）⇒ 终止条件只能是「已收 >= 总数」。
type PageResp = { ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown> };
// 桩一律用 `Promise.resolve` 而不是 `async`：async 而无 await 会被 `deno lint` 报 require-await，
// 本仓库的判据是「lint 不得高于基线」，测试文件也一样。
const poolStub = (codes: string[], opts: { hideTotal?: boolean; serverCap?: number } = {}) => {
  const st = { calls: 0, offsets: [] as number[], prefers: [] as string[] };
  const get = (u: string, init?: RequestInit): Promise<PageResp> => {
    st.calls++;
    st.prefers.push(String((init?.headers as Record<string, string> | undefined)?.['Prefer'] ?? ''));
    const q = new URL(u).searchParams;
    const offset = Number(q.get('offset') ?? '0');
    st.offsets.push(offset);
    if (offset >= codes.length) return Promise.resolve({ ok: false, status: 416,   // 真平台形态：越界是错误而非空页
      headers: { get: () => `*/${codes.length}` }, json: () => Promise.resolve({ code: 'PGRST103' }) });
    // serverCap = 平台侧 db-max-rows 比请求的 limit 更小（这一页就是被截了）
    const n = Math.min(Number(q.get('limit') ?? '1000'), opts.serverCap ?? Infinity, codes.length - offset);
    const slice = codes.slice(offset, offset + n);
    const cr = `${offset}-${offset + slice.length - 1}/${opts.hideTotal ? '*' : codes.length}`;
    return Promise.resolve({ ok: true, status: 206, headers: { get: (k) => k.toLowerCase() === 'content-range' ? cr : null },
      json: () => Promise.resolve(slice.map(c => ({ code: c }))) });
  };
  return { get: get as never, st };
};
const codes1165 = (_n = 1165) => Array.from({ length: _n }, (_, i) => String(i).padStart(6, '0'));

Deno.test('readAllRows：单页被 db-max-rows 截断时必须靠分页取回全部，且每页 offset 由上一页实收行数推进', async () => {
  const codes = codes1165();
  const { get, st } = poolStub(codes);
  const rows = await readAllRows('https://stub.invalid', 'stock_pool', 'select=code&order=code.asc', get);
  assertEquals(rows.length, 1165);                                  // 旧写法只拿第一页 ⇒ 1000
  assertEquals(st.calls, 2);                                         // 1000 + 165，不多发一页（第三页会 416）
  assertEquals(st.offsets, [0, 1000]);
  assertEquals(rows[1000].code, '001000');                           // 第 1001 行确实是分页接上的
  // 请求里必须带 `Prefer: count=exact`：没有它 PostgREST 返 `0-999/*`（无总数），
  // 整套闭合校验就无从谈起，而桩子自己是模拟不出这个差别的——只能直接钉请求
  assertEquals(st.prefers, ['count=exact', 'count=exact']);
  // 平台把 db-max-rows 调小（< 请求 limit）时也不能静默少收：靠实收行数推进，照样取全
  const capped = poolStub(codes, { serverCap: 500 });
  const r2 = await readAllRows('https://stub.invalid', 'stock_pool', 'select=code&order=code.asc', capped.get, 1000);
  assertEquals(r2.length, 1165);
  assertEquals(capped.st.offsets, [0, 500, 1000]);   // 推进量=各页实收（500/500/165），第三页到底
  assertEquals(capped.st.calls, 3);
});

Deno.test('readAllRows：总数拿不到就抛（未生效的 count=exact 会让截断重新变成静默）', async () => {
  const e = await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool',
    'select=code&order=code.asc', poolStub(codes1165(), { hideTotal: true }).get), Error);
  assertEquals(String(e).includes('Content-Range'), true);
  // Content-Range 整个缺失同样抛（变异：删掉这条守卫后，只回 1000 行的读法看起来完全正常）
  const noRange = () => Promise.resolve({ ok: true, status: 200,
    headers: { get: () => null }, json: () => Promise.resolve(codes1165(1000).map(c => ({ code: c }))) });
  await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool',
    'select=code&order=code.asc', noRange as never), Error);
  // 空表（真平台形态：`0--1/0` + 空数组）也必须抛——池读成空集会把全宇宙 in_pool 静默标 false
  const empty = (): Promise<PageResp> => Promise.resolve({ ok: true, status: 200,
    headers: { get: () => '0--1/0' }, json: () => Promise.resolve([]) });
  const e2 = await assertRejects(() => readPoolSet('https://stub.invalid', empty as never), Error);
  assertEquals(String(e2).includes('Content-Range'), true);
});

Deno.test('readAllRows：非 2xx / 页起点与请求不符 / 未要求确定性排序 —— 三种不确定形态一律抛，不得返回部分结果', async () => {
  await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool', 'select=code&order=code.asc',
    () => Promise.resolve({ ok: false, status: 502, headers: { get: () => null }, json: () => Promise.resolve([]) } as never)), Error);
  // 页起点错位（服务端返回的 range 从 999 开始 ⇒ 有一行被重复或跳过，偏移分页就靠这个对齐自证）
  const skewed = (u: string): Promise<PageResp> => {
    const offset = Number(new URL(u).searchParams.get('offset') ?? '0');
    const cr = offset === 0 ? `0-999/1165` : `999-1164/1165`;
    return Promise.resolve({ ok: true, status: 206, headers: { get: (k) => k.toLowerCase() === 'content-range' ? cr : null },
      json: () => Promise.resolve(Array.from({ length: offset === 0 ? 1000 : 166 }, (_, i) => ({ code: String(i) }))) });
  };
  const e2 = await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool',
    'select=code&order=code.asc', skewed as never), Error);
  assertEquals(String(e2).includes('页起点'), true);
  // 没有 order= 时 offset 分页不保证不重不漏 ⇒ 直接拒绝这种调用方写法（判据是参数本身，不是响应）
  const e3 = await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool',
    'select=code', poolStub(codes1165()).get), Error);
  assertEquals(String(e3).includes('order'), true);
});

Deno.test('readAllRows：声明区间长度与实际行数不符即抛（页被吃了也不拿部分结果交差）', async () => {
  const short = (): Promise<PageResp> => Promise.resolve({ ok: true, status: 206,
    headers: { get: () => '0-4/1000' }, json: () => Promise.resolve([1, 2, 3].map(c => ({ code: String(c) }))) });
  const e = await assertRejects(() => readAllRows('https://stub.invalid', 'stock_pool',
    'select=code&order=code.asc', short as never), Error);
  assertEquals(String(e).includes('1000'), true);
});

Deno.test('readPoolSet：重复 code 使去重后变少时必抛（Set 会静默吞掉重复，总数就对不上）', async () => {
  const dup = (): Promise<PageResp> => Promise.resolve({ ok: true, status: 206,
    headers: { get: () => '0-999/1000' },
    json: () => Promise.resolve(Array.from({ length: 1000 }, (_, i) => ({ code: String(i % 900) }))) });   // 900 唯一
  const e = await assertRejects(() => readPoolSet('https://stub.invalid', dup as never), Error);
  assertEquals(String(e).includes('1000'), true);
});

Deno.test('readPoolSet：第 1001 只以后的池内代码必须在集合里（首跑那 116 只假阴性）', async () => {
  const codes = codes1165();
  const set = await readPoolSet('https://stub.invalid', poolStub(codes).get);
  assertEquals(set.size, 1165);
  assertEquals(set.has('001164'), true);        // 旧写法下这一只永远不在 Set 里
  assertEquals(set.has('000999'), true);
});

Deno.test('readMainSnapshot：主分快照同样分页——池内 1116 只不得只拿到 1000 只的归因', async () => {
  const codes = codes1165(1116);
  let calls = 0;
  const get = (u: string): Promise<PageResp> => {
    calls++;
    const q = new URL(u).searchParams;
    if ((q.get('limit') ?? '') === '1') {        // 第一批：取最新批次号
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => '0-0/1' },
        json: () => Promise.resolve([{ batch_date: '2026-10-12' }]) });
    }
    const offset = Number(q.get('offset') ?? '0');
    const n = Math.min(1000, codes.length - offset);
    const cr = `${offset}-${offset + n - 1}/${codes.length}`;
    return Promise.resolve({ ok: true, status: 206, headers: { get: (k) => k.toLowerCase() === 'content-range' ? cr : null },
      json: () => Promise.resolve(codes.slice(offset, offset + n).map(c => ({   // 首跑形态：1000 只之后仍有 116 只要拿
        code: c, final: 70, confidence: 'A', quality: 80, growth: 40, value: 44, momentum: 30 }))) });
  };
  const m = await readMainSnapshot('https://stub.invalid', get as never);
  assertEquals(m.batch, '2026-10-12');
  assertEquals(m.map.size, 1116);
  assertEquals(m.map.get('001115')?.momentum, 30);
  assertEquals(calls, 3);                        // 1 次批次 + 2 次明细
});
