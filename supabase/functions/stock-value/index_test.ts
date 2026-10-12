// supabase/functions/stock-value/index_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { MainSnap } from './index.ts';            // 类型导入编译期擦除，不会触发 Deno.serve
Deno.env.set('STOCK_VALUE_DISABLE_SERVE', '1');           // import 即绑端口 → 必须先关
const { buildExtras, toDbRow, poolRanks, buildDbRows } = await import('./index.ts');

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
