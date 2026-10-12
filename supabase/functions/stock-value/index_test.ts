// supabase/functions/stock-value/index_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { MainSnap } from './index.ts';            // 类型导入编译期擦除，不会触发 Deno.serve
Deno.env.set('STOCK_VALUE_DISABLE_SERVE', '1');           // import 即绑端口 → 必须先关
const { buildExtras, toDbRow, poolRanks, buildDbRows, countMainMissing, isMainStale, runSummary, errorBody, upsert } = await import('./index.ts');

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
