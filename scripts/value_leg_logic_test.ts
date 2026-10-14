// scripts/value_leg_logic_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { valueFmtPct, valueTierLabel, valuePillHtml, valueGateHtml, renderValueTop10,
  LEG_PAGE_SIZE, legOrderOpts, legFilter, legRange, legHasMore, legTiebreakCol,
  TREND_LOOKBACK, TREND_KLT, TREND_FQT, TREND_MIN_MONTHS, TREND_POSITION_MA, TREND_R2_STEADY, TREND_DD_RATIO_MIN,
  monthEndCloses, olsLogTrend, longTrendStats, longTrendLabel, brokenLegOf,
  trendBadgeHtml, secidOf, AUTH_TIMEOUT_MS, authErrHint,
  TREND_LABEL_CN, TREND_NA_CN } from "./value_leg_logic.ts";

const row = { code:'600031', name:'潍柴', vq:78.4, tier:'qualified', confidence:'A', vetoed:false,
  owner_yield:6.2, margin_of_safety:4.35, cn10y:1.85, roic_med:18.0, v_moat:80, v_cash:70, v_safety:75, v_health:66,
  market_rank:12, market_n:2200, ind_rank:3, ind_n:40, veto_reasons:[], flags:['ic_approx'] };

Deno.test('valueFmtPct：null → NA（不显示 0.0% 冒充“收益为零”）', () => {
  assertEquals(valueFmtPct(null), 'NA');
  assertEquals(valueFmtPct(6.234, 1), '6.2%');
  assertEquals(valueFmtPct(-0.187, 2), '-0.19%');
  // 控制方 pre-flight 实证（计划原文这里写的是 '-0.19%'，与实现体矛盾）：toFixed 的二进制舍入不是“四舍五入进位”，
  // -0.185 实际存成 0.18499… → '-0.18%'。展示层沿用页面既有 toFixed 口径（scorePillHtml 也是 toFixed(1)），
  // 不为价值腿另造舍入函数；这条断言是把它钉成文档。
  assertEquals(valueFmtPct(-0.185, 2), '-0.18%');
});

Deno.test('valueTierLabel：四档均有中文文案，too_rich 不得读成“卖”', () => {
  assertEquals(valueTierLabel('qualified'), '合格');
  assertEquals(valueTierLabel('too_rich'), '质量达标、价太贵');
  assertEquals(valueTierLabel('vetoed'), '硬否决');
  assertEquals(valueTierLabel('unqualified'), '不合格');
  assertEquals(valueTierLabel(null), '—');
});

Deno.test('valuePillHtml：无行→空串；有分→分 + 池内分位；否决行（引擎真实形状 vq=null）必须可见', () => {
  assertEquals(valuePillHtml(null), '');
  assertEquals(valuePillHtml({ ...row, pool_rank: 12, pool_n: 200 }).includes('池内 P94'), true);
  // 否决行 = 引擎产出的 { tier:'vetoed', vetoed:true, vq:null }。旧断言写 vq:78.4 是被测代码永不收到的形状。
  const vetoedRow = { ...row, vq: null, tier: 'vetoed', vetoed: true };
  const h = valuePillHtml(vetoedRow);
  assertEquals(h.includes('硬否决'), true);
  assertEquals(h.includes('score-pill-warn'), true);
  assertEquals(h.includes('⛔'), true);
  assertEquals(h === '', false);                                              // 这条才是 I-2 的实质：胶囊不得整颗消失
  // 无分且未被否决（如覆盖度不足）→ 仍不渲染，别把「还没算出来」伪装成结论
  assertEquals(valuePillHtml({ ...row, vq: null, tier: 'unqualified', vetoed: false }), '');
});

Deno.test('valueGateHtml：四维度横条 + owner_yield 明细 + mos/cn10y 判定过程均可见；mos null 时走 rfFallback 文案', () => {
  const h = valueGateHtml(row);
  for (const t of ['资本回报护城河', '现金回报', '安全边际', '财务稳健', '6.2%', '1.85%']) {
    assertEquals(h.includes(t), true, `缺少：${t}`);
  }
  assertEquals(valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: true }).includes('无风险利率口径缺失'), true);
});

Deno.test('renderValueTop10：state=null → 空串（降级文案由调用点根据 valueTried 决定，纯逻辑不读全局）', () => {
  assertEquals(renderValueTop10(null), '');
});

Deno.test('renderValueTop10：只渲染 tier=qualified 且 A 级；否决/too_rich 不混进榜（spec §7.1）', () => {
  const rows = [row, { ...row, code: 'x2', vq: 90, tier: 'vetoed' }, { ...row, code: 'x3', vq: 88, confidence: 'C' }];
  const html = renderValueTop10({ batch: '2026-10-11', top10: rows as never[] });
  assertEquals(html.includes('600031'), true);
  assertEquals(html.includes('x2'), false);
  assertEquals(html.includes('x3'), false);
  assertEquals(html.includes('不构成买卖建议'), true);   // 固定免责脚注
});

// ==== Step 0（Task 7 评审结转）：补两条 valueGateHtml 覆盖面 ====
Deno.test('valueGateHtml：mos=null 且非 rf_fallback → 显示 NA，且不得冒出“无风险利率口径缺失”', () => {
  const h = valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: false });
  assertEquals(h.includes('NA'), true);
  assertEquals(h.includes('无风险利率口径缺失'), false);
});

Deno.test('valueGateHtml：veto_reasons 非空 → 硬否决块 + 每条否决串均可见（这张卡最该被人看见的部分）', () => {
  const h = valueGateHtml({ ...row, veto_reasons: ['gw_high', 'roe_low'] });
  assertEquals(h.includes('⛔ 硬否决'), true);
  assertEquals(h.includes('gw_high'), true);
  assertEquals(h.includes('roe_low'), true);
});

// ==== Step 1（Task 8）：分歧榜 + 换仓提示行失败测试 ====
import { divergeLists, swapSuggest, renderDivergeBoard, SWAP_GAP } from "./value_leg_logic.ts";

const v = (code: string, vq: number, main: number, mos: number) =>
  ({ code, name: code, vq, main_final: main, margin_of_safety: mos, tier: 'qualified', confidence: 'A', rf_fallback: false });

Deno.test('SWAP_GAP 常数为 5pp（改动需先改 spec，不得局部改代码）', () => {
  assertEquals(SWAP_GAP, 5);
});

Deno.test('divergeLists：被错杀 = VQ 前 20 分位 × 主分后 50 分位；两组均只取 A 级', () => {
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code).includes('a'), true);
  assertEquals(d.rich.map(r => r.code).includes('c'), true);
  assertEquals(d.wronged.every(r => r.confidence === 'A'), true);
});

Deno.test('divergeLists：main_final 缺失的行不参与（无主分快照就无从谈分歧）', () => {
  const rows = [v('a', 95, 30, 6), { ...v('z', 99, 1, 8), main_final: null }];
  assertEquals(divergeLists(rows).wronged.map(r => r.code).includes('z'), false);
});

Deno.test('swapSuggest：X 的 mos 比 Y 高 ≥5pp 才给建议；4.9pp 不给（边界包含等于）', () => {
  const pool = [v('x', 80, 60, 8.0), v('y', 70, 60, 3.0)];
  assertEquals(swapSuggest(pool[1], pool)!.gap, 5.0);
  assertEquals(swapSuggest({ ...pool[1], margin_of_safety: 3.1 }, pool), null);   // 差 4.9pp
});

Deno.test('swapSuggest：任一侧 rf_fallback（口径不一致）→ 整体静默 null，不混用尺子算优势', () => {
  const pool = [ { ...v('x', 80, 60, 8.0), rf_fallback: true }, v('y', 70, 60, 3.0) ];
  assertEquals(swapSuggest(pool[1], pool), null);
});

Deno.test('renderDivergeBoard：两组标题 + 归因句（含主分四条腿）+ 免责脚注；null 降级为空串', () => {
  // 样本必须足量且真正存在分歧：单行时百分位恒为 50，永远进不了 ≥80 / ≤50 双条件
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ]
    .map(r => ({ ...r, owner_yield: 6.2, roic_med: 18, extras: { main_legs: { quality: 82, growth: 40, value: 44, momentum: 30 } } }));
  const state = { batch: '2026-10-11', top10: rows, rows: new Map(rows.map(r => [r.code, r])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('被错杀'), true);
  assertEquals(html.includes('虚高'), true);
  assertEquals(html.includes('主分腿：Q82/G40/V44/M30'), true);        // 归因句（spec §7.2）
  assertEquals(html.includes('不构成买卖建议'), true);
  assertEquals(renderDivergeBoard(null), '');
});

// ==== Task 8 修复轮 1：5 条新测试（接在既有 14 条之后）====
Deno.test('swapSuggest：目标必须“未持有”（spec §7.3）——已持有的更优标的不得当换仓目标', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, v('w', 80, 60, 9.0), v('x', 80, 60, 8.0)];
  assertEquals(swapSuggest(y, pool, ['w', 'y'])!.target.code, 'x');   // w 更好但已持有 → 应退而求 x
  assertEquals(swapSuggest(y, pool, [])!.target.code, 'w');           // 不持有 w 时它就是目标
  assertEquals(swapSuggest(y, pool, ['w', 'x', 'y']), null);          // 更优的都持有 → 无建议
});

Deno.test('swapSuggest：浮点边界不得靠运气——真实差恰为 5.0pp 必须给建议', () => {
  const pool = [v('x', 80, 60, 8.2), v('y', 70, 60, 3.2)];            // 8.2-3.2 = 4.999999999999999
  assertEquals(8.2 - 3.2 < 5, true);                                  // 先把这个二进制事实钉在测试里
  const s = swapSuggest(pool[1], pool, []);
  assertEquals(s !== null, true);
  assertEquals(Number(s!.gap.toFixed(1)), 5);
});

Deno.test('divergeLists：非 A 级行不得上榜（spec §7.2/§6：缺数据造成的便宜不得混进结论）', () => {
  // 样本必须够多：只剩一行 A 级时 pctOf 恒为 50，谁都进不了榜——那就测不到过滤器了。
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4),
    { ...v('z1', 99, 1, 9), confidence: 'C' }, { ...v('z2', 1, 99, 0), confidence: 'B' } ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code), ['a']);    // z1 比 a 更“被错杀”，但它是 C 级 → 必须不在榜上
  assertEquals(d.rich.map(r => r.code), ['c']);       // z2 同理（B 级）
});

Deno.test('divergeLists：池外持仓行既不进榜、也不挤掉他人的分位（终审 I-1，spec §7.2「池内」）', () => {
  const base = [
    { ...v('a', 95, 30, 6), in_pool: true }, { ...v('b', 50, 50, 3), in_pool: true },
    { ...v('c', 10, 95, 1), in_pool: true }, { ...v('d', 92, 28, 5), in_pool: true },
  ];
  assertEquals(divergeLists(base).wronged.map(r => r.code), ['a']);          // 池内 4 行：a 的 VQ 分位 87.5 ≥80 → 进榜（终审实测值）
  assertEquals(divergeLists(base).rich.map(r => r.code), ['c']);
  const withOut = base.concat([{ ...v('x', 99, 20, 9), in_pool: false }]);   // x：已从 stock_pool 摘除但两分齐备的持仓行
  const d = divergeLists(withOut);
  assertEquals(d.wronged.map(r => r.code), ['a']);                            // x 不得进榜，且 a 不得被挤掉
  assertEquals(d.rich.map(r => r.code), ['c']);
});

Deno.test('swapSuggest：候选必须 tier=qualified（too_rich/vetoed/unqualified 都不算“更便宜的合格标的”）', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, { ...v('rich', 80, 60, 9.0), tier: 'too_rich' }, { ...v('veto', 80, 60, 8.5), tier: 'vetoed' }];
  assertEquals(swapSuggest(y, pool, []), null);
});

Deno.test('renderDivergeBoard：state.rows 缺席时优雅降级为空串（不抛）', () => {
  assertEquals(renderDivergeBoard({ batch: '2026-10-11' } as never), '');
});

// ==== 终审修复单（F-7g / F-8 配套测试）====
Deno.test('renderDivergeBoard：归因句带上让样本入选的分位 (P90)/(P50)（spec §7.2 示例、终审 M-4）', () => {
  const rows = [v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4)];
  const state = { batch: '2026-10-11', rows: new Map(rows.map(r => [r.code, r as never])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('VQ 95.0(P90) / 主分 30.0(P50)'), true);
  assertEquals(html.includes('VQ 10.0(P10) / 主分 95.0(P90)'), true);
});

Deno.test('安全边际三处统一按 pp 渲染，旧单位 4.35% 不得残留（终审 N-1）；Top10 另带池内分位（F-3e）', () => {
  assertEquals(valueGateHtml(row).includes('安全边际 4.35pp'), true);
  assertEquals(valueGateHtml(row).includes('4.35%'), false);
  const top = { batch: '2026-10-11', top10: [{ ...row, pool_rank: 12, pool_n: 200 }] };
  assertEquals(renderValueTop10(top).includes('安全边际 4.35pp'), true);
  assertEquals(renderValueTop10(top).includes('池内 P94'), true);
  const drows = [v('a',95,30,6), v('b',50,50,3), v('c',10,95,1), v('d',92,28,5), v('e',90,20,4)];
  const dstate = { batch: '2026-10-11', rows: new Map(drows.map(r => [r.code, r as never])) } as never;
  assertEquals(renderDivergeBoard(dstate).includes('安全边际 6.00pp'), true);  // 第三处沿用 2 位小数
});

// ==== 2026-10-13 Step 9 预检修复单（缺陷 A：DESC NULLS FIRST 让 Top10 恒空；缺陷 B：单页 1000 行静默截断）====
// 实测依据（2026-10-13 批，只读）：stock_value in_pool 1116 行中 vq 为 NULL 的 1090 行，
// order=vq.desc 下首条有分行名次 = 1091，单页 1000 行内含分行 0 只，qualified+A 的 26 只全在页外。
Deno.test('legOrderOpts：两条腿排序必须显式 nullsFirst:false（默认 DESC NULLS FIRST 是缺陷 A 的根）', () => {
  const o = legOrderOpts();
  assertEquals(o.ascending, false);
  assertEquals(o.nullsFirst, false);   // 严格 === false：写成 undefined（＝不传）等于没修
});

Deno.test('legFilter：非法代码剔除，无持仓时退化为纯 in_pool', () => {
  assertEquals(legFilter(['600031', 'abc', '000001', '1234']), 'in_pool.eq.true,code.in.(600031,000001)');  // in. 形式：PostgREST 列.操作符.值，与现行页面同形
  assertEquals(legFilter([]), 'in_pool.eq.true');
  assertEquals(legFilter(['600031']).includes('in_pool.eq.true'), true);  // 精选池条件不得丢
});

Deno.test('legRange：窗口按 1000 递增且不重叠（1116 行需两窗，第二窗 from=1000）', () => {
  assertEquals(legRange(0), [0, 999]);
  assertEquals(legRange(1), [1000, 1999]);
  assertEquals(legRange(1)[0], LEG_PAGE_SIZE);
});

Deno.test('legHasMore：满页才继续，短页/空页即停（防死循环）', () => {
  assertEquals(legHasMore(1000), true);
  assertEquals(legHasMore(116), false);
  assertEquals(legHasMore(0), false);
});

Deno.test('接线守卫：三条翻页查询函数体内必须真的调用对应的纯函数（含 loadThsPoolNames）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const REQUIRED: Record<string, string[]> = {
    loadStockValue: ['legOrderOpts(', 'legFilter(', 'legRange(', 'legHasMore(', 'legTiebreakCol('],
    loadStockScores: ['legOrderOpts(', 'legFilter(', 'legRange(', 'legHasMore(', 'legTiebreakCol('],
    // 这条取全池行业名，故意不带持仓 or 条件——所以只要求翻页/排序四件
    loadThsPoolNames: ['legOrderOpts(', 'legRange(', 'legHasMore(', 'legTiebreakCol('],
  };
  for (const fn of Object.keys(REQUIRED)) {
    const start = html.indexOf('async function ' + fn + '(');
    assertEquals(start >= 0, true, fn + ' 已不在 index.html 里');
    const end = html.indexOf('\n}\n', start);
    assertEquals(end > start, true, fn + ' 函数体边界未找到');
    const body = html.slice(start, end);
    for (const call of REQUIRED[fn]) {
      assertEquals(body.includes(call), true, fn + ' 未调用 ' + call.slice(0, -1) + '（缺陷会原地复活）');
    }
  }
});

Deno.test('全序守卫：凡用 .range() 翻页的函数都必须带 code 并列键（tie 会让跨页重行/漏行）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const paged = html.split('async function ').filter(f => f.startsWith('load') && f.includes('.range('));
  assertEquals(paged.length >= 3, true, '应至少找到三条翻页查询，实际 ' + paged.length);
  for (const body of paged) {
    assertEquals(body.includes(".order(legTiebreakCol(), {ascending:true})"), true,
      'load' + body.slice(0, body.indexOf('(')) + ' 翻页却缺全序并列键');
  }
  assertEquals(legTiebreakCol(), 'code');
});
// ==== 长期趋势标签（2026-10-13 用户裁定：只做标签、不进分数）====
// 造日序列：months 个月 × 每月 perMonth 个交易日，月内按 (1+step) 复利，跨月再跳 1%
// 月线粒度夹具：新口径判据喂「上市至今全部月线」，不再是日线堆出的 24 月窗
function mkCloses(months: number, step: number, zig = 0) {
  const out: number[] = []; let p = 100;
  for (let i = 0; i < months; i++) { out.push(zig && i % 2 ? p * (1 + zig) : p); p *= (1 + step); }
  return out;
}
// 在 at 处砸一个 depth 深的坑，8 个月内爬回原趋势线：全史斜率几乎不动，但最深回撤真的变深
function withCrash(closes: number[], at: number, depth: number, recover = 8) {
  const out = closes.slice(); const target = Math.min(closes.length - 1, at + recover);
  out[at] = closes[at] * (1 - depth);
  const gap = closes[target] / closes[at];
  for (let k = 1; k < recover && at + k < out.length; k++) out[at + k] = out[at] * Math.pow(gap, k / recover);
  return out;
}
function monthlyToRows(closes: number[]) {
  const out: { date: string; close: number }[] = [];
  closes.forEach((c, m) => {
    const yr = 1998 + Math.floor(m / 12), mm = String((m % 12) + 1).padStart(2, '0');
    out.push({ date: `${yr}-${mm}-28`, close: c });
  });
  return out;
}
// 云天化（600096）2026-10-14 真实近 24 个月月线：从 18.97 冲到 42.97 再崩回 27.41
const YTH_24 = [18.97, 19.31, 20.07, 17.91, 19.87, 19.34, 20.20, 20.37, 23.06, 25.61, 25.40, 27.36,
  29.57, 32.01, 36.79, 42.97, 31.99, 34.78, 30.44, 30.20, 29.67, 31.24, 27.86, 27.41];
function ythLike() {   // 云天化式：上市以来一路上行 + 最后一轮冲高崩回（复刻真实形态的骨架）
  return mkCloses(300, 0.004).slice(0, 276).concat(YTH_24);
}
// 中国铝业式：上市以来年年阴跌，但近 12 个月反弹已站上 24 月线 —— 位置项过、方向项不过
function alLike(months: number, decay: number, rally: number, bounce: number) {
  const out: number[] = []; let p = 200;
  for (let i = 0; i < months - rally; i++) { out.push(p); p *= (1 - decay); }
  for (let i = 0; i < rally; i++) { out.push(p); p *= (1 + bounce); }
  return out;
}

Deno.test('monthEndCloses：每月只取最后一个交易日；乱序输入必须自己排序（不许依赖上游有序）', () => {
  const rows = monthlyToRows(mkCloses(26, 0.002));
  const got = monthEndCloses(rows);
  assertEquals(got.length, 26, '26 个月应得 26 个月末收盘');
  assertEquals(monthEndCloses(rows.slice().reverse()), got, '乱序输入结果与有序不一致');
  assertEquals(monthEndCloses([]), []);
  assertEquals(monthEndCloses(null as never), []);
  // 同月多笔（日线粒度）也必须只留最后一天 —— 这条路径还在，月线源/日线源都要能吃
  assertEquals(monthEndCloses([{ date: '2024-01-05', close: 10 }, { date: '2024-01-26', close: 11 }, { date: '2024-02-03', close: 12 }]), [11, 12]);
});

Deno.test('olsLogTrend：第三参 perYear 决定年化口径（月线喂 12、日线喂 250）；常数价 → R²=null', () => {
  const up = mkCloses(300, 0.002);
  const t = olsLogTrend(up, 250);
  assertEquals(t !== null, true, '300 个点够算 250 窗');
  assertEquals(t!.r2! > 0.99, true, '单调上升的 R² 必须接近 1，实得 ' + t!.r2);
  const m = olsLogTrend(up, 24, 12);
  assertEquals(Math.abs(m!.annualized - (Math.exp(m!.slope * 12) - 1)) < 1e-12, true, '年化必须按 perYear=12 折算');
  assertEquals(olsLogTrend(new Array(250).fill(100), 250)!.r2, null, '全等价格 R² 是 0/0，必须判 null 而非 0 或 1');
  assertEquals(olsLogTrend([1, 2, 3], 250), null, '样本不足窗口 → null，不得用短窗凑');
});

Deno.test('口径是「上市至今」：回归必须吃全部月线，不是最后 24 根（本轮改的就是这一条）', () => {
  const closes = [100, 160, 256, 410, 655].concat(new Array(24).fill(660));   // 前 5 月暴涨、后 24 月横盘
  const st = longTrendStats(monthlyToRows(closes))!;
  assertEquals(st !== undefined && st !== null, true);
  assertEquals(st.months, 29, '样本月数必须等于输入月数（窗口=上市至今），实得 ' + st.months);
  assertEquals(st.annualized > 0.2, true, '全史年化必须吃进前 5 个月的暴涨，实得 ' + st.annualized);
  assertEquals(Math.abs(st.recent24!) < 0.05, true, '近 24 月年化应≈0 —— 两个窗口不是一回事，实得 ' + st.recent24);
  assertEquals(st.firstYear, 1998, '必须披露序列起点（用户要能核对“上市至今”是真的）');
});

Deno.test('最深回撤进判据：一次 −80% 的历史深坑必须把「长期↑稳升」拦下来（fixture 自证只隔离了这一项）', () => {
  // 参数由 scan_fixture.ts 扫出：300 月复利 + 第 120 月砸 −80% 后 4 个月爬回，
  // 得到 ann=5.0% r2=0.785 mdd=-79.9% —— 方向/稳定/位置三腿全过，只有收益回撤比（0.063）不够
  const base = mkCloses(300, 0.004);
  const sa = longTrendStats(monthlyToRows(base))!;
  assertEquals(longTrendLabel(sa), 'steady', '基准：无深回撤的复利长牛必须判稳升，否则下面的对照无意义');
  const sb = longTrendStats(monthlyToRows(withCrash(base, 120, 0.80, 4)))!;
  // —— 前提自证（上一轮的教训：不核对前提的隔离断言是假绿）——
  assertEquals(sb.mdd < -0.7, true, '夹具得真的砸出深坑，实得 ' + sb.mdd);
  assertEquals(sb.annualized > 0, true, '方向项必须仍然通过');
  assertEquals(sb.r2! >= TREND_R2_STEADY, true, '稳定项必须仍然通过，实得 R²=' + sb.r2);
  assertEquals(sb.close > sb.ma24m, true, '位置项必须仍然通过');
  assertEquals(sb.annualized < TREND_DD_RATIO_MIN * Math.abs(sb.mdd), true, '只能由收益回撤门禁拦下');
  assertEquals(longTrendLabel(sb), 'mixed', '同上三条全过、只有最深回撤过深 → 必须降级，实得 ' + longTrendLabel(sb));
});

Deno.test('R² 门禁在长窗口径下仍然生效（同样自证只隔离了 R²）', () => {
  const st = longTrendStats(monthlyToRows(mkCloses(60, 0.004, 0.35)))!;
  assertEquals(st.annualized > 0, true);
  assertEquals(st.r2! < TREND_R2_STEADY, true, '夹具得真的把 R² 打下来，实得 ' + st.r2);
  assertEquals(st.annualized >= TREND_DD_RATIO_MIN * Math.abs(st.mdd), true, '回撤项必须仍然通过');
  assertEquals(longTrendLabel(st), 'mixed', '涨得多不等于稳定上升，R² 必须拦下');
});

Deno.test('破位：上市以来年化≤0 直接判 broken（不再要求先跌破 24 月线——中铝式阴跌）', () => {
  const down = longTrendStats(monthlyToRows(mkCloses(60, -0.004)))!;
  assertEquals(longTrendLabel(down), 'broken', '长期阴跌必须判破位');
  assertEquals(down.annualized <= 0, true, '前提：年化确实≤0');
  // 中国铝业式：现价在 24 月线之上，但上市以来年化是负的 → 仍是破位，不许被中期反弹洗白
  const al = longTrendStats(monthlyToRows(alLike(120, 0.01, 12, 0.04)))!;
  assertEquals(al.annualized < 0, true, '前提：全史年化<0，实得 ' + al.annualized);
  assertEquals(al.close > al.ma24m, true, '前提：末段反弹已站上 24 月线');
  assertEquals(longTrendLabel(al), 'broken', '长期向下 + 中期反弹 ≠ 稳升，也不该只算“纠缠”');
});

Deno.test('云天化式形态：暴涨后深回撤不再是「稳升」，且角标把两个数当面说出来', () => {
  const st = longTrendStats(monthlyToRows(ythLike()))!;
  assertEquals(st.mdd < -0.5, true, '前提：全史最深回撤足够深，实得 ' + st.mdd);
  assertEquals(longTrendLabel(st) === 'steady', false, '用户质疑的就是这一颗“稳升”，本轮必须把它拦下');
  const html = trendBadgeHtml(Object.assign({}, st, { label: longTrendLabel(st) }));
  const title = (html.match(/title="([^"]*)"/) || ['', ''])[1];
  assertEquals(/最深回撤/.test(title), true, 'title 没披露上市以来最深回撤：' + title);
  assertEquals(/距峰/.test(title), true, 'title 没披露当前距历史峰值：' + title);
  assertEquals(/近24月年化/.test(title), true, 'title 须保留旧口径作对照（换口径要能对着看）：' + title);
});

// 拆腿夹具：长期上行 + 末段 24 月阴跌 → 全史年化仍>0，但现价破 24 月线且近端也在跌（珀莱雅/泸州老窖式）
function tailDown(months: number, step: number, tailN: number, tailStep: number) {
  const out = mkCloses(months - tailN, step);
  let p = out[out.length - 1];
  for (let i = 0; i < tailN; i++) { out.push(p); p *= (1 + tailStep); }
  return out;
}
function withLabel(closes: number[]) {
  const st = longTrendStats(monthlyToRows(closes))!;
  return Object.assign({}, st, { label: longTrendLabel(st) });
}

Deno.test('破位拆腿（2026-10-14 取证后用户裁定：只披露、不进分数、标签一字未动）：两条腿必须能被分开说清', () => {
  const down = withLabel(mkCloses(60, -0.004));
  assertEquals(down.annualized <= 0, true, '前提：阴跌式夹具年化≤0');
  assertEquals(down.label, 'broken', '前提：仍判破位');
  assertEquals(brokenLegOf(down as never), 'annualized');
  const al = withLabel(alLike(120, 0.01, 12, 0.04));            // 中铝式：全史年化负，但已站上 24 月线
  assertEquals(al.annualized < 0, true, '前提：全史年化<0，实得 ' + al.annualized);
  assertEquals(al.close > al.ma24m, true, '前提：中期反弹已站上 24 月线');
  assertEquals(al.label, 'broken', '前提：本轮没改判据，它仍判破位');
  assertEquals(brokenLegOf(al as never), 'annualized',
    '起点污染那一类（2007 顶部上市→全史年化负）必须与「正在走弱」分开显示，否则用户只看到一颗笼统的破位');
  const rec = withLabel(tailDown(300, 0.004, 24, -0.02));       // 珀莱雅式：年化>0 但破线且近端在跌
  assertEquals(rec.annualized > 0, true, '前提：长期年化仍>0，实得 ' + rec.annualized);
  assertEquals(rec.close < rec.ma24m, true, '前提：现价已破 24 月线');
  assertEquals((rec.recent24 as number) <= 0, true, '前提：近 24 月年化≤0，实得 ' + rec.recent24);
  assertEquals(rec.label, 'broken', '前提：仍判破位');
  assertEquals(brokenLegOf(rec as never), 'recent');
  for (const closes of [mkCloses(60, 0.004), mkCloses(60, 0.004, 0.35)]) {
    const st = withLabel(closes);
    assertEquals(st.label === 'broken', false, '夹具得真的不是破位，实得 ' + st.label);
    assertEquals(brokenLegOf(st as never), null, '非破位不得带破位归因');
  }
  assertEquals(brokenLegOf(null as never), null);
  assertEquals(brokenLegOf({ label: 'broken' } as never), null, '缺 annualized 时不许把「未知」说成某条腿');
});

Deno.test('拆腿要进内联、不是只挂 title：iPhone 无 hover，「为什么破位」必须当面可读', () => {
  const visible = (h: string) => h.replace(/ title="[^"]*"/g, '');
  const htmlA = visible(trendBadgeHtml(withLabel(alLike(120, 0.01, 12, 0.04)) as never));
  assertEquals(/破位因·上市以来年化/.test(htmlA), true, '年化腿的内联缺失：' + htmlA);
  const htmlR = visible(trendBadgeHtml(withLabel(tailDown(300, 0.004, 24, -0.02)) as never));
  assertEquals(/破位因·破24月线/.test(htmlR), true, '近端腿的内联缺失：' + htmlR);
  assertEquals(/近24月年化\s*-?\d/.test(htmlR), true, '近端腿必须把近 24 月的数值当面写出来：' + htmlR);
  assertEquals(/破位因·上市以来年化/.test(htmlR), false, '两条腿的文案串了：' + htmlR);
  assertEquals(/破位因/.test(visible(trendBadgeHtml(withLabel(mkCloses(60, 0.004)) as never))), false, '稳升不许带破位归因');
  // deno-lint-ignore no-explicit-any
  const legacy: any = { label: 'broken', annualized: -0.038, r2: 0.15, close: 1, ma24m: 20, months: 231, mdd: -0.94 };
  assertEquals(/null|NaN|undefined/.test(trendBadgeHtml(legacy)), false, '旧缓存缺字段时内联不得出脏值：' + trendBadgeHtml(legacy));
  const titleR = (trendBadgeHtml(withLabel(tailDown(300, 0.004, 24, -0.02)) as never).match(/title="([^"]*)"/) || ['', ''])[1];
  assertEquals(/破位归因/.test(titleR), true, '桌面 hover 也要给同一条归因：' + titleR);
});

Deno.test('数据不足判 NA：月线 < ' + 'TREND_MIN_MONTHS 门槛；非正价必须丢弃且不产生 NaN（前复权陷阱）', () => {
  assertEquals(TREND_MIN_MONTHS, 24, '次新股门槛：上市不足 24 个月一律不判定');
  assertEquals(longTrendStats(monthlyToRows(mkCloses(23, 0.004))), null, '23 个月必须判 null');
  assertEquals(longTrendStats([]), null);
  assertEquals(longTrendStats(null as never), null);
  // 前复权全历史实测有大片非正价（云天化 75/342、格力 231/354）：必须丢掉，且不能靠 log(≤0)=NaN 蒙过去
  const dirty = monthlyToRows(mkCloses(40, 0.004));
  dirty[0].close = -3.5; dirty[1].close = 0;
  const st = longTrendStats(dirty)!;
  assertEquals(st !== undefined, true, '丢掉坏点后仍要能算');
  assertEquals(isFinite(st.annualized) && isFinite(st.r2 as number), true, '坏点漏进 log → NaN，实得 ' + st.annualized + '/' + st.r2);
  assertEquals(/NaN|null|undefined/.test(trendBadgeHtml(Object.assign({}, st, { label: 'mixed' }))), false, '渲染出现脏值');
});

Deno.test('旧口径字段必须死干净：两套口径并存是最难查的线上事故', () => {
  const st = longTrendStats(monthlyToRows(mkCloses(60, 0.004)))!;
  for (const gone of ['bars', 'peak', 'peakDraw', 'recent3', 'ma12m', 'monthly']) {
    assertEquals(gone in st, false, `旧字段 ${gone} 还在，说明有两处代码仍在按 24 月窗算`);
  }
  for (const need of ['months', 'ma24m', 'mdd', 'fromPeak', 'recent24', 'annualized', 'r2', 'close']) {
    assertEquals(need in st, true, '缺字段 ' + need);
  }
});

Deno.test('as-of 口径（决议 24）：当月未收盘根必须计入 —— 标签是「当日价口径」，不是上月末口径', () => {
  const rows = monthlyToRows(mkCloses(60, 0.004));
  assertEquals(rows[rows.length - 1].date, '2002-12-28', '前提：夹具末根就是 12 月末');
  const partial = { date: '2003-01-14', close: 404 };   // 当月未收盘：东财月线的末根每天都是这种日期
  const without = longTrendStats(rows)!;
  const withPartial = longTrendStats(rows.concat([partial]))!;
  assertEquals(withPartial.months, without.months + 1, 'partial bar 没被当成新一个月 → 有人偷偷丢了末根');
  assertEquals(withPartial.close, 404, '现价取的是上月末而不是当日价，那「现价 vs 24 月线」这条腿就不是当日口径了');
});

Deno.test('secidOf：与 autoFetchStockData 既有口径同源（6→沪、其余 6 位→深、5 位→港；非法→null）', () => {
  assertEquals(secidOf('600519'), '1.600519');
  assertEquals(secidOf('000001'), '0.000001');
  assertEquals(secidOf('300750'), '0.300750');
  assertEquals(secidOf('00700'), '116.00700');
  assertEquals(secidOf(' 600031 '), '1.600031', '代码要 trim');
  assertEquals(secidOf('abc'), null);
  assertEquals(secidOf(null as never), null);
});

Deno.test('命名：窗口真的换成上市至今，文案才配得上「长期」二字（旧“24月”前缀必须消失）', () => {
  const want = { steady: '长期↑稳升', mixed: '长期↔纠缠', broken: '长期↓破位' } as const;
  for (const k of ['steady', 'mixed', 'broken'] as const) {
    const t = TREND_LABEL_CN[k];
    assertEquals(t, want[k], `${k} 文案应为「${want[k]}」，实得「${t}」`);
    assertEquals(/牛|慢/.test(t), false, `${k} 不许用叙事词：${t}`);
    assertEquals(/24月/.test(t), false, `${k} 仍写“24月”= 口径已改而文案没改：${t}`);
  }
  assertEquals(TREND_NA_CN, '长期—');
});

Deno.test('内联可见：最深回撤已进判据，就必须不依赖 hover 也能看见（iPhone 没有 hover）', () => {
  const st = longTrendStats(monthlyToRows(withCrash(mkCloses(60, 0.006), 30, 0.80)))!;
  const visible = trendBadgeHtml(Object.assign({}, st, { label: 'mixed' })).replace(/ title="[^"]*"/, '');
  assertEquals(/回撤/.test(visible), true, '内联可见文字里没有最深回撤：' + visible);
  assertEquals(/-8\d%|-7\d%/.test(visible), true, '内联得把回撤数值写出来，实得：' + visible);
  const na = trendBadgeHtml(null);
  assertEquals(na.includes('trend-na'), true, '缺数据必须显式占位，禁止空串');
  assertEquals(/null|NaN|undefined/.test(na), false, 'NA 态出现脏值：' + na);
  assertEquals(/TREND_MIN_MONTHS|24/.test(na), true, 'NA 的 title 要说明缺多少数据');
  // deno-lint-ignore no-explicit-any
  const legacy: any = { label: 'steady', annualized: 0.3, r2: 0.7, ma24m: 20, months: 300 };   // 旧数据没有 mdd
  assertEquals(/null|NaN|undefined/.test(trendBadgeHtml(legacy)), false, '缺字段时内联不得渲染脏值：' + trendBadgeHtml(legacy));
});

Deno.test('接线守卫：取数必须走月线全历史（klt=103 / fqt=2 / lmt=10000），且 trendCache 整包透传', async () => {
  // 常量的**字面值**也要钉住：只验「有没有引用常量」，把 fqt 改回 1（全历史一堆非正价）、
  // klt 改回 101（又变成日线窗）都能蒙过去。实测依据：前复权全历史非正价 云天化 75/342、格力 231/354。
  assertEquals(TREND_FQT, 2, 'fqt 必须=2（后复权）：前复权全历史有大片非正价，log 价会 NaN');
  assertEquals(TREND_KLT, 103, 'klt 必须=103（月线）：101 是日线，「上市至今」要拉一万根才凑得出 390 个月');
  assertEquals(TREND_LOOKBACK, 10000, 'lmt 必须一次拉到上市首日（实测最久 390 根月线 / 8510 根日线，未触顶）');
  assertEquals(TREND_POSITION_MA, 24, '位置项窗口固定近 24 月线：它判「现在破没破」，不跟着长期窗口一起变胖');
  // 0.15 = 2026-10-14 用户裁定的收益回撤门禁（形式：比率而非绝对 MDD 阈值，因绝对阈值实测=年限罚）。
  // 挪这个数必须连着分布数据一起改，不许顺手改。
  assertEquals(TREND_DD_RATIO_MIN, 0.15, '收益回撤门禁被改动：它是用户根据池抽样 122 只分布裁定的值');
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const start = html.indexOf('function loadTrendBadges(');
  assertEquals(start >= 0, true, 'loadTrendBadges 不存在');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  for (const call of ['fetchKlineJsonp(', 'secidOf(', 'TREND_LOOKBACK', 'TREND_FQT', 'TREND_KLT', 'longTrendStats(', 'longTrendLabel(', 'renderStockSection()']) {
    assertEquals(body.includes(call), true, 'loadTrendBadges 未调用/未传 ' + call.replace('(', ''));
  }
  // trendCache 必须整包携带 stats：上一版逐字段枚举，漏了 peakDraw/recent3 ⇒ 线上「距峰」永不显示，测试却全绿
  const writeLine = body.split('\n').filter(l => /trendCache\[code\]\s*=/.test(l)).join(' ');
  assertEquals(/Object\.assign\s*\(/.test(writeLine), true,
    'trendCache 是逐字段枚举写入（必然漏字段），应整包 Object.assign({}, st, {label})：' + writeLine.trim());
  const consumed = [...new Set((html.slice(html.indexOf('function trendBadgeHtml('), html.indexOf('// 东财 secid 前缀'))
    .match(/stats\.[A-Za-z_][A-Za-z0-9_]*/g) || []).map(x => x.slice(7)))];
  const stored = [...new Set((writeLine.match(/\bst\.[A-Za-z_][A-Za-z0-9_]*/g) || []).map(x => x.slice(3)))];
  const leaked = consumed.filter(f => f !== 'label' && !writeLine.includes('Object.assign'));
  assertEquals(leaked.length, 0, '被角标消费却没进缓存的字段：' + leaked.join(','));
  assertEquals(stored.length === 0 && /Object\.assign\(\{\}\s*,\s*st\b/.test(writeLine), true,
    '整包写入的写法必须是 Object.assign({}, st, …)，实得：' + writeLine.trim());
  // 月线口径的取数参数不许写死成日线：fetchKlineJsonp 的第 4 参 klt 必须有默认值 101（护住另外三个日线调用点）
  const fp = html.slice(html.indexOf('function fetchKlineJsonp('), html.indexOf('\n}\n', html.indexOf('function fetchKlineJsonp(')));
  assertEquals(/klt/.test(fp) && /101/.test(fp), true, 'fetchKlineJsonp 没有 klt 参数或默认 101，日线调用点会被月线口径带跑');
  for (const lit of ['fetchKlineJsonp(b.secid, 1, 130)', 'fetchKlineJsonp(secid, 1, 260)']) {
    assertEquals(html.includes(lit), true, '日线调用点被改动：' + lit);
  }
  const callLines = html.split('\n')
    .filter(l => /renderValueTop10\s*\(/.test(l))
    .filter(l => !/^\s*function\s+renderValueTop10/.test(l));
  assertEquals(callLines.length >= 1, true, '找不到 renderValueTop10 的调用点（只有定义，没人渲染？）');
  assertEquals(callLines.some(l => /renderValueTop10\s*\(\s*valueState\s*,\s*trendCache\s*\)/.test(l)), true,
    '渲染调用点没把 trendCache 传进 renderValueTop10，角标恒为 NA；实际调用点：\n' + callLines.join('\n'));
});

Deno.test('renderValueTop10：传入 trendMap 则行内挂角标；不传第二参仍渲染 trend-na（旧调用点向后兼容）', () => {
  const st = { batch: '2026-10-13', top10: [row] as never[] };
  const withMap = renderValueTop10(st, { '600031': { label: 'steady', annualized: 0.2, r2: 0.9, close: 1, ma24m: 0.9, months: 300, mdd: -0.4 } } as never);
  assertEquals(withMap.includes('trend-steady'), true);
  const without = renderValueTop10(st);
  assertEquals(without.includes('trend-na'), true, '未传 map 要显式“数据不足”而非消失');
  assertEquals(without.includes('78.4'), true, '角标不得影响分数渲染');
});

Deno.test('接线守卫：submitLogin 必须给两处 auth 调用套超时 + try/catch（否则网络挂起 = 界面永久「正在登录…」）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const start = html.indexOf('async function submitLogin(');
  assertEquals(start >= 0, true, 'submitLogin 不存在');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assertEquals(AUTH_TIMEOUT_MS > 0 && AUTH_TIMEOUT_MS <= 30000, true, '超时必须是有限值，实得 ' + AUTH_TIMEOUT_MS);
  assertEquals(/withAuthTimeout\(\s*sb\.auth\.signInWithPassword/.test(body), true, '登录请求没套超时');
  assertEquals(/withAuthTimeout\(\s*sb\.auth\.signUp/.test(body), true, '注册请求没套超时（同样会永久挂起）');
  // 变异检验 L3 逼出来的：只查「有没有 try」会假绿 —— 两处 auth 请求各自都要有一层 try。
  const tryCount = (body.match(/\btry\s*\{/g) || []).length;
  assertEquals(tryCount >= 2, true, 'submitLogin 里 try 只有 ' + tryCount + ' 处，登录与注册必须各自被 catch 包住');
  // 变异检验 L8 逼出来的：只查「出现过 authErrHint」会假绿 —— 终态分支绕过纯函数照样绿。
  const hintCount = (body.match(/authErrHint\(/g) || []).length;
  assertEquals(hintCount >= 3, true, '失败文案只走 ' + hintCount + ' 次 authErrHint，登录/注册/终态三条路径必须全部经它出，不许在页面里另写文案');
  // L8 第二轮：计数是脆的（4 处删成 3 处照样过 >=3）。改成钉住「终态兜底那一行」本身。
  const lastMsg = (body.trimEnd().split('\n').filter(l => l.includes('loginMsg(')).pop() || '').trim();
  assertEquals(/authErrHint\(/.test(lastMsg), true,
    'submitLogin 的终态兜底分支绕过了 authErrHint，实得：' + lastMsg);
});

Deno.test('边界守卫（用户裁定"只做标签不进分数"的可执行化）：长期趋势字样绝不出现在打分/排序/门禁表达式里', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const polluted = html.split('\n').filter(l => /longTrend|trendLabel|trendStats|TREND_LOOKBACK/.test(l))
    .filter(l => /renorm|W_M|W_Q|W_G|W_V|\.vq\s*[-+*/]|vq\s*=|final\s*[-+*/]|score\s*\+=/.test(l));
  assertEquals(polluted, [], '长期趋势被接进了分数计算：\n' + polluted.join('\n'));
});

