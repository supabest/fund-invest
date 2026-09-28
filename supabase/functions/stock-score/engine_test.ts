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
  assertEquals(mid.quality, 50); // 硬编码期望：Roe=i 互异且 N=25 → b12 = (12+0.5)/25×100 = 50
  assertEquals(mid.cov, 100); // 单腿化不降覆盖
});
Deno.test('决策8 混合宇宙：isFin 的极端毛利率(999)被剔除出 mlr 横截面，不污染非金融股', () => {
  // 同一 L2 组 25 只：x0 为金融股（isFin:true，真实 mlr=999，roe 居中）；x1..x24 非金融，mlr 均为正常值
  const s: Stock[] = [mk({ code: 'x0', isFin: true, mlr: 999, roe: 12 })];
  for (let i = 1; i <= 24; i++) s.push(mk({ code: `x${i}`, roe: i, mlr: i }));
  const rows = computeScores(s);
  const fin = rows.find(r => r.code === 'x0')!;
  const x5 = rows.find(r => r.code === 'x5')!;
  // (a) 金融股 Quality = 其 ROE 组内百分位（毛利率单腿化）
  assertEquals(fin.quality, pctWithinGroups(s, x => x.roe).get('x0')!);
  // (b) 非金融股 x5 的 Quality 用可手算具体值锁定，若 999 污染 mlr 分布则断言破裂：
  //   ROE 腿：25 只（1..24 + 居中值12）→ x5 低于数4、共1 → (4.5)/25×100 = 18
  //   毛利腿（正确：mlr 有效样本仅非金融 24 只 1..24）→ (4.5)/24×100 = 18.75
  //   Quality = (18×35 + 18.75×25)/60 = 18.3125；若 isFin 剔除逻辑被删除，毛利腿变成 (4.5)/25×100=18 → Quality=18.0625
  assertEquals(x5.quality, 18.3125); // V1.1 weight change, spec §4.3（Q 内部 50/50 → ROE35/毛利25/现金15/ROE中位25）
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

// ============================ V1.1（spec 2026-09-27 §4 A 层 / §5.2 C 层 / §8 B 层 / §7.1 断言）============================
// 权重表按 R-BFORM 裁定：探针 PASS → 生产直接用全权重表（无模式开关，缺失腿走 renorm）
//   Q = ROE35 / 毛利25 / 现金15 / ROE三年中位25；G = 扣非25 / 归母10 / 营收30 / 营收CAGR20 / 毛利率同比15
//   V = PE50 / PEG50（结构不变）；M = 行业相对50 / 绝对趋势50（不变）；总权重 Q30/G30/V20/M20 固定

function assertClose(actual: number | null, expected: number, msg = '') {
  assertEquals(typeof actual === 'number' && Math.abs(actual! - expected) < 1e-9, true, `${msg} actual=${actual} expected=${expected}`);
}

Deno.test('V1.1 低基数: 扣非>200% → Growth 封顶85 + lowBase flag + PEG 无效化（spec §4.2）', () => {
  const crowd: Stock[] = Array.from({ length: 24 }, (_, i) => mk({ code: `k${i}`, kc: 10, gm: 10, rev: 10 }));
  const noCap = mk({ code: 'nocap', kc: 150, gm: 90, rev: 90 }); // 同强度但未触发 → 用作“封顶确实发生”的对照
  const cap = mk({ code: 'cap', kc: 2514, gm: 90, rev: 90 });
  const rows = computeScores([...crowd, noCap, cap]);
  const R = (c: string) => rows.find(r => r.code === c)!;
  assertEquals(R('nocap').lowBase, false);
  assertClose(R('nocap').growth, ((24.5 / 26 * 100) * 25 + (25 / 26 * 100) * 40) / 65); // 未封顶原值
  assertEquals(R('nocap').growth! > 85, true);
  assertEquals(R('cap').lowBase, true);
  assertEquals(R('cap').growth, 85); // 封顶发生在因子内 renorm 之后、综合加权之前
  assertEquals(R('cap').flags.includes('low_base_growth'), true);
  assertEquals(R('cap').peg, null);
  assertEquals(R('cap').confidence, 'B'); // 任一 flag → B
});

Deno.test('V1.1 PEG 低基数否决: 200<扣非<=300（旧规则会给出伪便宜 PEG）→ Value 退化为 PE 单腿', () => {
  const crowd: Stock[] = Array.from({ length: 23 }, (_, i) => mk({ code: `v${i}`, kc: 15, pe: 100 }));
  const vetoed = mk({ code: 'vetoed', kc: 250, pe: 25 }); // 低基数 → peg 判无效
  const kept = mk({ code: 'kept', kc: 190, pe: 25 });     // 未触发 → peg 合法
  const rows = computeScores([...crowd, vetoed, kept]);
  const R = (c: string) => rows.find(r => r.code === c)!;
  assertEquals(R('vetoed').peg, null);
  assertEquals(R('kept').peg, 25 / 190);
  assertClose(R('vetoed').value, 96); // PE 单腿：两只 pe=25 并列最低 → reverse 百分位 100-(0+1)/25*100 = 96
  assertClose(R('kept').value, (96 * 50 + (100 - 0.5 / 24 * 100) * 50) / 100); // 两腿 → 若否决失效则此值变成 96
});

Deno.test('V1.1 现金含量入 Quality（Q=ROE35/毛利25/现金15/ROE中位25）：非金融区分高低，金融股置 NA', () => {
  const s: Stock[] = [
    ...Array.from({ length: 12 }, (_, i) => mk({ code: `lo${i}`, cash: -0.2 })),
    ...Array.from({ length: 12 }, (_, i) => mk({ code: `hi${i}`, cash: 1.2 })),
    mk({ code: 'mid', cash: 0.5 }),
  ];
  const rows = computeScores(s);
  const q = (c: string) => rows.find(r => r.code === c)!.quality!;
  // 其余腿全并列（50），cash 百分位：-0.2→24, 0.5→50, 1.2→76
  assertClose(q('lo0'), (50 * 35 + 50 * 25 + 24 * 15) / 75, '低现金腿');
  assertClose(q('hi0'), (50 * 35 + 50 * 25 + 76 * 15) / 75, '高现金腿');
  assertEquals(q('lo0'), q('lo11')); // 并列取中一致
  assertEquals(q('hi0') > q('mid') && q('mid') > q('lo0'), true);
  // 金融股：现金含量与毛利率同样视为 NA → Quality 退回 ROE 单腿，cash 差异零影响
  const fin: Stock[] = [
    ...Array.from({ length: 12 }, (_, i) => mk({ code: `flo${i}`, isFin: true, cash: -0.2 })),
    ...Array.from({ length: 13 }, (_, i) => mk({ code: `fhi${i}`, isFin: true, cash: 1.2 })),
  ];
  const fRows = computeScores(fin);
  const fq = (c: string) => fRows.find(r => r.code === c)!;
  assertClose(fq('flo0').quality, 50, '金融股 cash 置 NA');
  assertEquals(fq('flo0').quality, fq('fhi0').quality);
  assertEquals(fq('fhi0').cov, 100); // 单腿化不降覆盖（因子层覆盖不变）
});

Deno.test('V1.1 现金含量缩尾: 原始比值截断至 [-0.5,2] 后才取百分位；负值保留为低分不剔除（spec §4.3）', () => {
  const s: Stock[] = [
    ...Array.from({ length: 21 }, (_, i) => mk({ code: `z${i}`, cash: 0 })),
    mk({ code: 'capHi', cash: 50 }), mk({ code: 'atTwo', cash: 2 }),
    mk({ code: 'capLo', cash: -5 }), mk({ code: 'atHalf', cash: -0.5 }),
  ];
  const rows = computeScores(s);
  const q = (c: string) => rows.find(r => r.code === c)!.quality!;
  assertClose(q('capHi'), (50 * 35 + 50 * 25 + 96 * 15) / 75, '50 与 2 截断后并列');
  assertEquals(q('capHi'), q('atTwo'));
  assertEquals(q('capLo'), q('atHalf'));
  assertClose(q('capLo'), (50 * 35 + 50 * 25 + 4 * 15) / 75, '负现金流保留为低分');
  assertEquals(q('capHi') > q('z0') && q('z0') > q('capLo'), true);
});

Deno.test('V1.1 B层 ROE三年中位数入 Quality（权重25，组内百分位）', () => {
  const s: Stock[] = Array.from({ length: 25 }, (_, i) => mk({ code: `q${i}`, roe3y: [i, i + 0.5, i + 1] }));
  const rows = computeScores(s);
  const q = (c: string) => rows.find(r => r.code === c)!.quality!;
  // 其余腿并列 50；roeMed 中位数 = i+0.5 互异 → 最高 98 分位、最低 2 分位
  assertClose(q('q24'), (50 * 35 + 50 * 25 + 98 * 25) / 85, 'roeMed 上腿');
  assertClose(q('q0'), (50 * 35 + 50 * 25 + 2 * 25) / 85, 'roeMed 下腿');
  assertEquals(q('q24') > q('q12') && q('q12') > q('q0'), true);
  // 非空值 <2 → 该腿 NA（质量退回 35/25 renorm），与完全不提供 roe3y 等值
  const s2: Stock[] = [
    mk({ code: 'one', roe3y: [5, null, null] }), mk({ code: 'none' }),
    ...Array.from({ length: 23 }, (_, i) => mk({ code: `p${i}`, roe3y: [i, i + 1, i + 2] })),
  ];
  const r2 = computeScores(s2);
  const q2 = (c: string) => r2.find(r => r.code === c)!.quality!;
  assertClose(q2('one'), 50, '仅1个非空值 → NA 腿');
  assertEquals(q2('one'), q2('none'));
});

Deno.test('V1.1 B层 营收CAGR 腿（权重20）改变 Growth 排名；缺列时 renorm 再分配', () => {
  const s: Stock[] = Array.from({ length: 25 }, (_, i) => mk({ code: `w${i}`, cagr3: i }));
  const rows = computeScores(s);
  const byGrowth = rows.slice().sort((a, b) => b.growth! - a.growth!);
  assertEquals(byGrowth.map(r => r.cagr3), Array.from({ length: 25 }, (_, i) => 24 - i));
  const g = (c: string) => rows.find(r => r.code === c)!.growth!;
  assertClose(g('w24'), (50 * 65 + 98 * 20) / 85, 'cagr3 上腿');
  assertClose(g('w0'), (50 * 65 + 2 * 20) / 85, 'cagr3 下腿');
  assertClose(computeScores(Array.from({ length: 25 }, (_, i) => mk({ code: `w${i}` })))[0].growth!, 50, '无 cagr3 → renorm');
});

Deno.test('V1.1 B层 利润率恢复代理 mlrDelta 腿（权重15）参与 Growth', () => {
  const s: Stock[] = Array.from({ length: 25 }, (_, i) => mk({ code: `d${i}`, mlrDelta: i }));
  const rows = computeScores(s);
  const g = (c: string) => rows.find(r => r.code === c)!.growth!;
  assertClose(g('d24'), (50 * 65 + 98 * 15) / 80, 'mlrDelta 上腿');
  assertClose(g('d0'), (50 * 65 + 2 * 15) / 80, 'mlrDelta 下腿');
  assertEquals(g('d24') > g('d0'), true);
});

Deno.test('V1.1 毛利率恶化标记: 营收>=30 且 毛利率同比<=-5pp → flag，分数零影响（spec §4.4）', () => {
  const uni = (mlrYoy: number | null, revOverride?: number): Stock[] =>
    Array.from({ length: 25 }, (_, i) => mk({ code: `m${i}`, rev: i === 0 && revOverride !== undefined ? revOverride : 40, mlrYoy: i === 0 ? mlrYoy : null }));
  const flagged = computeScores(uni(-8)).find(r => r.code === 'm0')!;
  const clean = computeScores(uni(null)).find(r => r.code === 'm0')!;
  assertEquals(flagged.flags.includes('margin_deterioration'), true);
  assertEquals(clean.flags.includes('margin_deterioration'), false);
  assertEquals([flagged.quality, flagged.growth, flagged.value, flagged.momentum, flagged.final],
    [clean.quality, clean.growth, clean.value, clean.momentum, clean.final]); // 只标记不进分
  assertEquals(flagged.confidence, 'B'); // flag → 置信度至多 B
  // 边界：营收 29 或 同比 -4.9 均不触发
  assertEquals(computeScores(uni(-8, 29)).find(r => r.code === 'm0')!.flags.includes('margin_deterioration'), false);
  assertEquals(computeScores(uni(-4.9)).find(r => r.code === 'm0')!.flags.includes('margin_deterioration'), false);
});

Deno.test('V1.1 动量拥挤标记: r60 组内>=95分位 且 close>a60*1.15 → flag；缺 r60/a60 不判定（spec §4.5）', () => {
  const uni = (over?: Partial<Stock>): Stock[] =>
    Array.from({ length: 25 }, (_, i) => mk({ code: `t${i}`, r60: i, close: 10, a20: 9, a60: 8, ...over }));
  const rows = computeScores(uni());
  const has = (c: string) => rows.find(r => r.code === c)!.flags.includes('momentum_crowded');
  assertEquals(has('t24'), true);  // 98 分位 + 10 > 9.2
  assertEquals(has('t23'), false); // 94 分位 < 95
  assertEquals(rows.find(r => r.code === 't24')!.confidence, 'B');
  const noBreakout = computeScores(uni({ a60: 12 })).find(r => r.code === 't24')!; // 10 > 13.8 false
  assertEquals(noBreakout.flags.includes('momentum_crowded'), false);
  const noA60 = computeScores(Array.from({ length: 25 }, (_, i) =>
    mk({ code: `t${i}`, r60: i, close: 10, a20: 9, a60: i === 24 ? null : 8 }))).find(r => r.code === 't24')!;
  assertEquals(noA60.flags.includes('momentum_crowded'), false); // 缺数据不判定，也不算违规
  assertEquals(noA60.momentum !== null, true);
  const noR60 = computeScores(Array.from({ length: 25 }, (_, i) =>
    mk({ code: `t${i}`, r60: i === 24 ? null : i, close: 10, a20: 9, a60: 8 }))).find(r => r.code === 't24')!;
  assertEquals(noR60.flags.includes('momentum_crowded'), false);
});

Deno.test('V1.1 置信度: C=降级组样本<20 或 >=2因子NA；B=单因子NA 或任一flag；A=其余（spec §4.7）', () => {
  const big: Stock[] = Array.from({ length: 25 }, (_, i) => mk({
    code: `f${i}`, r60: i, close: 10, a20: 9.9, a60: 9.9, // a60 抬高 → 全组不触发拥挤
    pe: i === 0 ? -1 : 15,
    debt: i === 1 ? 85 : 50,
    ...(i === 3 ? { pe: null, r60: null, close: null, a20: null, a60: null } : {}), // Value+Momentum 双 NA
  }));
  const small: Stock[] = Array.from({ length: 8 }, (_, i) => mk({ code: `s${i}`, ths: ['综合', '综合Ⅱ', 'x'], r60: i, cagr3: null }));
  const rows = computeScores([...big, ...small]);
  const cf = (c: string) => rows.find(r => r.code === c)!.confidence;
  assertEquals(cf('f4'), 'A');
  assertEquals(rows.find(r => r.code === 'f4')!.value !== null, true);
  assertEquals(cf('f0'), 'B'); // Value 单因子 NA
  assertEquals(cf('f1'), 'B'); // 仅 flag
  assertEquals(cf('f3'), 'C'); // 两因子 NA
  assertEquals(cf('s0'), 'C'); // 已降级 MARKET 且组内样本 <20
});

Deno.test('V1.1 混合业务: mixed=true → grp 强制 MARKET 按全市场宇宙取百分位，其他股分组计数不受影响（spec §5.2）', () => {
  // L2「传媒-影视」恰 20 只（含混合股）：若混合股退出计数 → 其余 19 只降级 L1，断言即破裂
  const l2: Stock[] = Array.from({ length: 20 }, (_, i) => mk({
    code: `b${i}`, ths: ['传媒', '影视', 'x'], roe: i === 0 ? 100 : i,
    mixed: i === 0, isFin: i === 0, // 混合股设为金融 → Quality 只剩 ROE 单腿，便于手算
  }));
  const mkt: Stock[] = Array.from({ length: 8 }, (_, i) => mk({ code: `k${i}`, ths: ['综合', '综合Ⅱ', 'x'], roe: i * 10 }));
  const rows = computeScores([...l2, ...mkt]);
  const R = (c: string) => rows.find(r => r.code === c)!;
  assertEquals(R('b0').grp, 'MARKET');
  assertEquals(R('b1').grp, 'L2:传媒-影视');
  assertEquals(R('b19').grp, 'L2:传媒-影视');
  assertEquals(R('b0').flags.includes('mixed_business'), true);
  assertClose(R('b0').quality, (8 + 0.5) / 9 * 100, '全市场池百分位（ROE100 在 9 只 MARKET 中）');
  assertEquals(R('b0').quality !== 97.5, true); // 未被强制时会得到的 L2 池分位（20 只最高）
  assertEquals(R('b0').confidence, 'C'); // 降级组样本 <20 优先于 flag→B
  assertEquals(R('b1').grp === 'L2:传媒-影视' && assignGroups([...l2, ...mkt]).get('b1') === 'L2:传媒-影视', true);
});

Deno.test('V1.1 奥来德 688378 硬值回归（spec §7.1）: Growth<=85 / PEG 不再进 Value / low_base_growth / confidence B', () => {
  const peers: Stock[] = Array.from({ length: 25 }, (_, i) => mk({
    code: `peer${i}`, ths: ['电子', '半导体', 'x'],
    roe: 5 + i / 2, mlr: 20 + i / 3, kc: 10 + i, gm: i, rev: i, pe: 30 + i,
    r60: i - 12, close: 10, a20: 9, a60: 8, cash: 0.3, roe3y: [6, 7, 6.5],
  }));
  const aolaide: Stock = mk({
    code: '688378', name: '奥来德', ths: ['电子', '半导体', 'x'],
    roe: 5.9, mlr: 27.5, kc: 2514, gm: 20.5, rev: 22.4, debt: 30, pe: 46,
    r60: 30, close: 20, a20: 17, a60: 19, // close 未过 MA60*1.15 → 本例不触发拥挤
    cash: 0.89, mlrYoy: 22.79, roe3y: [7.2, 5.15, 4.22],
  });
  const rows = computeScores([...peers, aolaide]);
  const r = rows.find(x => x.code === '688378')!;
  assertEquals(r.lowBase, true);
  assertEquals(r.growth, 85); // 未封顶前为 ~92 → 封顶生效
  assertEquals(r.peg, null);
  assertClose(r.value, 100 - (16 + 1) / 26 * 100, 'Value = PE 单腿（PEG 已否决）'); // pe=46 与 peer16 并列 → 低于16、共2 → 反序百分位 34.615
  assertEquals(r.value !== null, true);
  assertEquals(r.flags, ['low_base_growth']);
  assertEquals(r.flags.includes('margin_deterioration'), false); // 探针实测 +22.79pp 为改善
  assertEquals(r.confidence, 'B');
});
