// index_test.ts — 只覆盖 index.ts 抽出的两个纯 helper（编排主体是 Deno.serve+网络，沿用 V1.0 惯例不单测）
// 先关 serve 守卫再动态 import，避免 import 即绑 8000 端口
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
Deno.env.set('STOCK_SCORE_DISABLE_SERVE', '1');
const { applyWarnConf, buildRevealExtras } = await import('./index.ts');

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
