import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assignGroups, pctWithinGroups, computeScores, type Stock } from './engine.ts';

function mk(over: Partial<Stock>): Stock {
  return { code: '000001', name: 'x', ths: ['A', 'B', 'C'], roe: 10, mlr: 20, kc: 15,
    gm: 15, rev: 10, debt: 50, pe: 20, isFin: false, isST: false,
    r60: 5, close: 10, a20: 9, a60: 8, ...over };
}

Deno.test('同花顺二级<20只时回退一级，一级也<20回退全市场', () => {
  const many: Stock[] = Array.from({ length: 20 }, (_, i) => mk({ code: `m${i}`, ths: ['传媒', '影视', 'x'] }));
  const few: Stock[] = Array.from({ length: 8 }, (_, i) => mk({ code: `f${i}`, ths: ['综合', '综合Ⅱ', 'x'] }));
  const g = assignGroups([...many, ...few]);
  assertEquals(g.get('m0'), 'L2:传媒-影视');
  assertEquals(g.get('f0'), 'MARKET'); // 一级"综合"仍<20 → 全市场
});

Deno.test('组内百分位：最高=100方向，并列取中，逆序翻转', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `c${i}`, roe: i % 5 })); // 5档并列
  const p = pctWithinGroups(s, x => x.roe);
  const vals = new Set([...p.values()]);
  assertEquals(Math.max(...vals), 90);   // (20+2.5)/25*100=90，非 100（原 98 与规则公式不符，按 spec §10 修正）
  const rev = pctWithinGroups(s, x => x.roe, true);
  assertEquals([...vals].map(v => 100 - v).sort((a, b) => a - b)[0], Math.min(...rev.values()));
});

Deno.test('组内有效样本<5 不产生百分位', () => {
  const s = Array.from({ length: 20 }, (_, i) => mk({ code: `a${i}` }));
  s.push(...Array.from({ length: 4 }, (_, i) => mk({ code: `b${i}`, ths: ['稀有', '稀有Ⅱ', 'x'] })));
  const p = pctWithinGroups(s, x => x.roe);
  assertEquals(p.has('b0'), false);
});

Deno.test('金融股：毛利率NA → Quality=ROE单腿；权重全落单指标', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `b${i}`, roe: i, mlr: null, isFin: true, kc: i, gm: i, rev: i, pe: 5 + i / 10, r60: i - 12, close: 10, a20: 10 + (i - 12) / 100, a60: 10 }));
  const rows = computeScores(s);
  const mid = rows.find(r => r.code === 'b12')!;
  // 原 brief 的 mid.__roePct 断言行不可用（引擎无此字段），按 plan 注改为语义断言：
  assertEquals(mid.quality !== null, true);
  assertEquals(mid.quality, pctWithinGroups(s, x => x.roe).get('b12')!); // 单腿 = 其 ROE 组内百分位
  assertEquals(mid.cov, 100); // 单腿化不降覆盖
});
Deno.test('PEG 有效性：扣非增速8(<10) → NA → Value=PE单指标；增速500(>300) 同 NA', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `p${i}`, kc: i === 0 ? 8 : i === 1 ? 500 : 20, pe: 15 }));
  const rows = computeScores(s);
  assertEquals(rows.find(r => r.code === 'p0')!.peg, null);
  assertEquals(rows.find(r => r.code === 'p1')!.peg, null);
  assertEquals(typeof rows.find(r => r.code === 'p2')!.peg, 'number');
});
Deno.test('亏损股 PE<0：Value=NA → 三维重归一 30/30/20→37.5/37.5/25，cov=80', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `l${i}`, pe: i === 0 ? -12 : 15 }));
  const rows = computeScores(s);
  const loss = rows.find(r => r.code === 'l0')!;
  assertEquals(loss.value, null);
  assertEquals(loss.cov, 80);
  assertEquals(loss.final !== null, true);
});
Deno.test('绝对趋势三条件：空头=0 全满足=100', () => {
  const s: Stock[] = [];
  for (let i = 0; i < 25; i++) s.push(mk({ code: `t${i}`, close: 10, a20: i === 0 ? 11 : 8.5, a60: i === 0 ? 12 : 8, r60: i }));
  const rows = computeScores(s);
  assertEquals(rows.find(r => r.code === 't0')!.absTrend, 0);
  assertEquals(rows.find(r => r.code === 't1')!.absTrend, 100);
});
Deno.test('ST 剔除、负债率>80 打标不进分', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `s${i}`, isST: i === 0, debt: i === 1 ? 85 : 50 }));
  const rows = computeScores(s);
  assertEquals(rows.find(r => r.code === 's0'), undefined);
  assertEquals(rows.find(r => r.code === 's1')!.flags.includes('负债率>80%'), true);
});
