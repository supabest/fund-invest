// index_test.ts — 只覆盖 index.ts 抽出的两个纯 helper（编排主体是 Deno.serve+网络，沿用 V1.0 惯例不单测）
// 先关 serve 守卫再动态 import，避免 import 即绑 8000 端口
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeScores } from './engine.ts';
import { mergeTables } from './gs.ts';
Deno.env.set('STOCK_SCORE_DISABLE_SERVE', '1');
const { applyWarnConf, buildRevealExtras } = await import('./index.ts');
// fixture 路径锚定到本测试文件目录 → CWD 无关（与 gs_test.ts 同模式，无网络）
const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

Deno.test('buildRevealExtras: 正常化PE近似 = pe*(1+gm/100) 两位取整；mix 前二分项+报告期+shift', () => {
  const segs = [{ name: 'A', ratio: 0.5 }, { name: 'B', ratio: 0.3 }, { name: 'C', ratio: 0.2 }];
  const e = buildRevealExtras({ pe: 30, gm: 20 }, { code: '688378', mixed: true, shift: true, segments: segs, report_date: '2025-12-31' });
  assertEquals(e.implied_normal_pe_approx, 36);
  assertEquals((e.mix as { segments: unknown[] }).segments, segs.slice(0, 2));
  assertEquals((e.mix as { report_date: string }).report_date, '2025-12-31');
  assertEquals((e.mix as { shift: boolean }).shift, true);
});

Deno.test('buildRevealExtras: gm≤0 / gm null / pe null → PE 位 null；无 mix 行 → mix null', () => {
  assertEquals(buildRevealExtras({ pe: 30, gm: -5 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 0 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: null }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: null, gm: 20 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 20 }, null).mix, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 20 }, { code: '1' }).mix, { segments: null, report_date: null, shift: false });
});

Deno.test('applyWarnConf: 仅 A→B；B/C 不动；无警示不动；键按全码匹配', () => {
  const rows = [
    { code: '688378.SH', confidence: 'A' as const },
    { code: '000338.SZ', confidence: 'B' as const },
    { code: '600031.SH', confidence: 'C' as const },
    { code: '000001.SZ', confidence: 'A' as const },
  ];
  const warnings = new Map<string, string[]>([
    ['688378.SH', ['单年扣非+150%，需查3年CAGR/周期位置']],
    ['000338.SZ', ['x']], ['600031.SH', ['x']],
    ['688378', []], // bare code 命中不了全码键；且空数组不算警示
  ]);
  applyWarnConf(rows, warnings);
  assertEquals(rows.map(r => r.confidence), ['B', 'B', 'C', 'A']);
});

// C-1 引擎契约（终审回归护栏）：现金腿必须真正进入 Quality——
// 同一宇宙、仅 cash 有无不同 → 目标股 quality 必须变化。若 cash 腿未接入（index.ts 忘记传 cashT），
// 生产批次里所有 s.cash 恒 null；本测试钉住引擎 §4.3 cash 腿参与的契约，wiring 另由下方 mergeTables 3 参测试兜底。
Deno.test('C-1 引擎契约：cash 腿进入 Quality（有 cash vs 无 cash → 目标股 quality 不同）', () => {
  const base = [1, 2, 3, 4, 5, 6].map(i => ({
    code: `60000${i}.SH`, name: `测试${i}`, ths: ['测试业', '测试子'],
    roe: 5 + i, mlr: 20 + i, kc: 10 + i, gm: 8 + i, rev: 15 + i, debt: 40, pe: 20 + i,
    isFin: false, isST: false, r60: i, close: 10 + i, a20: 9 + i, a60: 8 + i,
    cash: null as number | null,
  }));
  // 目标 600001 设 roe/mlr 最低、cash 最高 → cash 分位与 roe/mlr 分位背离，接入后 quality 必然改变
  const cashSeq = [2.0, 1.5, 1.2, 1.0, 0.8, 0.6];
  const rowsA = computeScores(base.map((s, i) => ({ ...s, cash: cashSeq[i] })));
  const rowsB = computeScores(base.map(s => ({ ...s, cash: null })));
  const qa = rowsA.find(r => r.code === '600001.SH')!.quality;
  const qb = rowsB.find(r => r.code === '600001.SH')!.quality;
  assertEquals(qa !== null, true);
  assertEquals(qb !== null, true);
  assertEquals(qa !== qb, true, 'cash 腿应进入 Quality：接入前后 quality 必须不同');
});

// C-1 wiring 兜底：index.ts 生产用 mergeTables(fin,mom,cashT) 3 参——用 fixtures 断言第 3 参确实把 cash 灌进 Stock。
Deno.test('C-1 wiring：mergeTables 3 参（cash fixture）→ 至少一只股票 cash 非 null', () => {
  const stocks = mergeTables(fx('fin_sample.json'), fx('mom_sample.json'), fx('cash_sample.json'));
  assertEquals(stocks.some(s => s.cash != null), true);
});
