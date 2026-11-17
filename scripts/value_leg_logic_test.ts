// scripts/value_leg_logic_test.ts
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { valueFmtPct, valueTierLabel, valueGateHtml, renderValueTop10,
  LEG_PAGE_SIZE, legOrderOpts, legFilter, legRange, legHasMore, legTiebreakCol,
  TREND_LOOKBACK, TREND_KLT, TREND_FQT, TREND_MIN_MONTHS, TREND_POSITION_MA, TREND_R2_STEADY, TREND_DD_RATIO_MIN,
  monthEndCloses, olsLogTrend, longTrendStats, longTrendLabel, brokenLegOf,
  trendBadgeHtml, secidOf, AUTH_TIMEOUT_MS, authErrHint,
  TREND_LABEL_CN, TREND_NA_CN,
  trendNaWhy, trendStaleHtml, trendStaleDays, fetchStatBump, trendPick,
  EM_VAL_MIN_ROWS, valPctSupported, emValUrl, valuationPctFromRows, valPctCaliber, valPctNaWhy,
  valPctNeedFetch, valPctApply, valPctHtml, valPctMerge, valPctLockNote,
  incomeChannelOf, renderIncomeList, foldCardHtml, INCOME_DEBT_MAX,
  CORE_W, CORE_MOAT_INNER, CORE_MOS_LO, CORE_MOS_HI, CORE_DEBT_CEIL, CORE_MOAT_REL_PP, CORE_TREND_N,
  coreTrendKey, corePoolPillars, corePoolSort,
  valueMedian, valueIndStatsOf, ROIC_GATE_PCT, valueAssessmentHtml,
  valueTrendExempt, ROIC_TREND_FLOOR_PCT,
  profitRefHtml, buyRefHtml,
  hkFmtPct, hkFmtNum, valueAssessmentHkHtml } from "./value_leg_logic.ts";

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

// ==== Step 1（Task 8）：换仓提示行测试（分歧榜已于 2026-11-16 随量化初筛卡一并删除）====
import { swapSuggest, SWAP_GAP } from "./value_leg_logic.ts";

const v = (code: string, vq: number, main: number, mos: number) =>
  ({ code, name: code, vq, main_final: main, margin_of_safety: mos, tier: 'qualified', confidence: 'A', rf_fallback: false });

Deno.test('SWAP_GAP 常数为 5pp（改动需先改 spec，不得局部改代码）', () => {
  assertEquals(SWAP_GAP, 5);
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

Deno.test('swapSuggest：候选必须 tier=qualified（too_rich/vetoed/unqualified 都不算“更便宜的合格标的”）', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, { ...v('rich', 80, 60, 9.0), tier: 'too_rich' }, { ...v('veto', 80, 60, 8.5), tier: 'vetoed' }];
  assertEquals(swapSuggest(y, pool, []), null);
});

// ==== 终审修复单（F-7g / F-8 配套测试）====
Deno.test('安全边际三处统一按 pp 渲染，旧单位 4.35% 不得残留（终审 N-1）；核心池行另带支柱读数（2026-11-16）', () => {
  assertEquals(valueGateHtml(row).includes('安全边际 4.35pp'), true);
  assertEquals(valueGateHtml(row).includes('4.35%'), false);
  const top = { batch: '2026-10-11', top10: [{ ...row, pool_rank: 12, pool_n: 200 }] };
  assertEquals(renderValueTop10(top).includes('安全边际 4.35pp'), true);
  assertEquals(renderValueTop10(top).includes('护城河 '), true);   // 复合支柱读数逐行展示
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

// 本文件自有的近似断言（engine_test.ts 的 assertClose 不在本模块作用域，跨文件引用会直接炸）
function assertClose(got: number, want: number, msg: string, tol: number) {
  assertEquals(Math.abs(got - want) <= tol, true, msg + '，实得 ' + got + ' 期望 ' + want);
}

Deno.test('年化波动率是纯披露：同方向同端点，路径更抖必须给出更高的 σ（且据此得到更低的收益波动比）', () => {
  const mild = longTrendStats(monthlyToRows(mkCloses(60, 0.004, 0.02)))!;
  const harsh = longTrendStats(monthlyToRows(mkCloses(60, 0.004, 0.35)))!;
  assertEquals('volAnn' in mild, true, '缺 volAnn：月线序列已经喂进来了，波动率没理由不算');
  assertEquals('rvRatio' in mild, true, '缺 rvRatio（年化收益 ÷ 年化波动）');
  // σ 必须真的在量“路径”而不是“方向”：两条序列都是上涨趋势，差别只在抖动
  assertEquals(mild.volAnn !== null && harsh.volAnn !== null, true, '两条序列的 σ 都没算出来');
  assertEquals((harsh.volAnn as number) > (mild.volAnn as number), true,
    '抖动序列的年化波动没超过平滑序列，实得 ' + harsh.volAnn + ' vs ' + mild.volAnn);
  // 前提自证：两边都是非退化序列，否则下面那句比大小是在比 null
  assertEquals(mild.rvRatio !== null, true, 'mild σ 应为 0 以外的值，实得 volAnn=' + mild.volAnn);
  assertEquals(harsh.rvRatio !== null, true, 'harsh σ 应为 0 以外的值，实得 volAnn=' + harsh.volAnn);
  assertEquals((mild.rvRatio as number) > (harsh.rvRatio as number), true,
    '同方向更抖的路应给出更低的收益波动比，实得 ' + mild.rvRatio + ' vs ' + harsh.rvRatio);
  // 单位口径：月线 σ 必须年化（×√12），否则数值会小一个量级、和 GS 的“年化波动率”对不上
  const mret: number[] = []; const cs = monthlyToRows(mkCloses(60, 0.004, 0.35)).map(r => r.close);
  for (let i = 1; i < cs.length; i++) mret.push(Math.log(cs[i] / cs[i - 1]));
  const mu = mret.reduce((a, b) => a + b, 0) / mret.length;
  const sd = Math.sqrt(mret.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (mret.length - 1));
  assertClose(harsh.volAnn as number, sd * Math.sqrt(12), 'volAnn 必须是月收益样本标准差 ×√12', 1e-9);
});

Deno.test('σ=0 的退化序列不得产出 Infinity（完美等比 = 零波动，分母为 0 必须判 null）', () => {
  const st = longTrendStats(monthlyToRows(mkCloses(60, 0.004)))!;
  assertClose(st.volAnn as number, 0, '严格等比月线的对数收益是常数，σ 应为 0', 1e-12);
  assertEquals(st.rvRatio, null, 'σ=0 时收益波动比无定义，必须是 null 而不是 Infinity/NaN');
  const html = trendBadgeHtml(Object.assign({}, st, { label: longTrendLabel(st) }));
  assertEquals(/Infinity|NaN|null|undefined/.test(html), false, '退化序列把脏值渲染进了角标：' + html.slice(0, 200));
  assertMatch(html, /年化波动/, '角标 title 必须披露年化波动率');
  assertMatch(html, /收益波动比/, '角标 title 必须披露收益波动比');
  // 命名纪律（2026-10-14 教训沿用）：本指标未扣无风险利率，词不得超出判据所测——严禁写成“夏普比率”。
  assertEquals(/夏普/.test(html), false, '未扣 rf 的收益波动比不得自称“夏普比率”：' + html.slice(0, 200));
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
  assertEquals(callLines.some(l => /renderValueTop10\s*\(\s*valueState\s*,\s*trendCache/.test(l)), true,
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

// ==== 核心池 Top10 · 长期价值（2026-11-16 用户裁定：护城河 40% 复合排序；破位分腿；缺数据重归一）====
const coreRow = (code: string, over: Record<string, unknown> = {}) => ({ code, name: 'N' + code, tier: 'qualified', confidence: 'A', vq: 80,
  ths_l2: '汽车零部件', roic_med: 18, roic_min3: 15.3, margin_of_safety: 4.35, v_health: 66, debt_ratio: 0.36, ...over });

Deno.test('核心池常量：权重 40/25/15/20、护城河内层 0.4/0.3/0.3、MOS 尺 2→8pp、负债顶 0.75、趋势数值表含破位分腿', () => {
  assertEquals(CORE_W, { moat: 0.40, safety: 0.25, health: 0.15, trend: 0.20 });
  assertEquals(CORE_MOAT_INNER, { abs: 0.4, rel: 0.3, stability: 0.3 });
  assertEquals(CORE_MOS_LO, 2);
  assertEquals(CORE_MOS_HI, 8);
  assertEquals(CORE_DEBT_CEIL, 0.75);
  assertEquals(CORE_MOAT_REL_PP, 15);
  assertEquals(CORE_TREND_N, { steady: 1, mixed: 0.55, broken_annualized: 0.55, broken_recent: 0.15, na: 0.55 });
});

Deno.test('coreTrendKey：破位必须分腿（年化腿/近端腿），与 brokenLegOf 同式；未知腿宁回 na 不压成近端', () => {
  assertEquals(coreTrendKey(null), 'na');
  assertEquals(coreTrendKey(undefined as never), 'na');
  assertEquals(coreTrendKey({ label: 'steady' } as never), 'steady');
  assertEquals(coreTrendKey({ label: 'mixed' } as never), 'mixed');
  assertEquals(coreTrendKey({ label: 'broken', annualized: -0.02 } as never), 'broken_annualized');
  assertEquals(coreTrendKey({ label: 'broken', annualized: 0.05 } as never), 'broken_recent');
  // Number(null)=0 是两函数共用的历史既定行为 → 年化腿（0.55 与中性同值，分值不受影响）；undefined 才是真「未知」
  assertEquals(coreTrendKey({ label: 'broken', annualized: null } as never), 'broken_annualized');
  assertEquals(coreTrendKey({ label: 'broken', annualized: undefined } as never), 'na');
  assertEquals(coreTrendKey({ label: 'nonsense' } as never), 'na');
  // 同一份 stats 两函数必须给同一腿（判据同源的文档化钉子）
  assertEquals(brokenLegOf({ label: 'broken', annualized: -0.02 } as never) === 'annualized', true);
  assertEquals(brokenLegOf({ label: 'broken', annualized: 0.05 } as never) === 'recent', true);
  assertEquals(brokenLegOf({ label: 'broken', annualized: null } as never) === 'annualized', true);   // Number(null)=0 历史既定
  assertEquals(brokenLegOf({ label: 'broken', annualized: undefined } as never) === null, true);       // 非有限 → 宁可不归因
});

Deno.test('corePoolPillars：护城河=绝对40%+相对行业30%+稳定性30%；某项缺数据在剩余项内重归一，绝不记 0', () => {
  // abs=(18-9.53)/(24.74-9.53)=0.5569 · rel=(18-6.9)/15=0.74 · stab=15.3/18=0.85
  const p = corePoolPillars(coreRow('a'), 6.9, 9.53, 24.74);
  assertEquals(Math.round(p.moat! * 1000), 700);       // 0.4×0.5569+0.3×0.74+0.3×0.85=0.6997
  assertEquals(Math.round(p.safety! * 1000), 392);     // (4.35-2)/6=0.3917
  assertEquals(Math.round(p.health! * 1000), 604);     // 0.6×0.66+0.4×(1-0.36/0.75)=0.604
  const noInd = corePoolPillars(coreRow('a'), null, 9.53, 24.74);                       // 缺行业中位
  assertEquals(Math.round(noInd.moat! * 1000), 682);   // (0.4×0.5569+0.3×0.85)/0.7=0.6825
  const noMin3 = corePoolPillars(coreRow('a', { roic_min3: null }), 6.9, 9.53, 24.74);  // 缺近3年最低
  assertEquals(Math.round(noMin3.moat! * 1000), 635);  // (0.4×0.5569+0.3×0.74)/0.7=0.6354
  const noBoth = corePoolPillars(coreRow('a', { roic_min3: null }), null, 9.53, 24.74); // 只剩绝对项
  assertEquals(Math.round(noBoth.moat! * 1000), 557);  // abs 独撑=0.5569
});

Deno.test('corePoolPillars：MOS 是绝对尺（2pp→0 / 8pp→1，超界截断）；负债率>75% 该项记 0；全缺 → null 不伪装', () => {
  assertEquals(corePoolPillars(coreRow('a', { margin_of_safety: 2 }), 6.9, 9.53, 24.74).safety, 0);
  assertEquals(corePoolPillars(coreRow('a', { margin_of_safety: 1.2 }), 6.9, 9.53, 24.74).safety, 0);
  assertEquals(corePoolPillars(coreRow('a', { margin_of_safety: 8 }), 6.9, 9.53, 24.74).safety, 1);
  assertEquals(corePoolPillars(coreRow('a', { margin_of_safety: 9.5 }), 6.9, 9.53, 24.74).safety, 1);
  assertEquals(corePoolPillars(coreRow('a', { margin_of_safety: null }), 6.9, 9.53, 24.74).safety, null);
  assertEquals(corePoolPillars(coreRow('a', { debt_ratio: 0.9 }), 6.9, 9.53, 24.74).health, 0.396);  // 负债项归 0，稳健维独撑
  assertEquals(corePoolPillars(coreRow('a', { debt_ratio: null }), 6.9, 9.53, 24.74).health, 0.66);  // 缺负债在稳健维内重归一
  assertEquals(corePoolPillars(coreRow('a', { roic_med: null }), 6.9, 9.53, 24.74).moat, null);
  assertEquals(corePoolPillars({ code: 'e' } as never, 6.9, 9.53, 24.74), { moat: null, safety: null, health: null });
});

Deno.test('corePoolSort：只收 qualified+A+vq 齐备；复合序把「宽护城河+高边际」排前；趋势未取到按三支柱基座排', () => {
  const lo = coreRow('lo', { roic_med: 9.5, roic_min3: 9.0, margin_of_safety: 2.0, v_health: 40, debt_ratio: 0.6 });
  const hi = coreRow('hi', { roic_med: 24.7, roic_min3: 22.0, margin_of_safety: 7.5, v_health: 90, debt_ratio: 0.2 });
  const out = corePoolSort([lo, hi,
    { ...hi, code: 'veto', tier: 'vetoed' }, { ...hi, code: 'bcc', confidence: 'C' }, { ...hi, code: 'nvq', vq: null }]);
  assertEquals(out.map(r => r.code), ['hi', 'lo']);
  assertEquals(out[0].coreScore! > out[1].coreScore!, true);
  assertEquals(out[0].trendKey, 'na');
  assertEquals(out[0].pillars.safety! > out[1].pillars.safety!, true);   // 支柱读数随行返回（渲染层直接用）
});

Deno.test('corePoolSort：趋势进排序——steady 独占鳌头；破位分腿生效（年化腿 0.55 > 近端腿 0.15）；并列按 vq→code 全序破平', () => {
  const mk = (code: string, over: Record<string, unknown> = {}) =>
    coreRow(code, { roic_med: 18, roic_min3: 15.3, margin_of_safety: 4.35, v_health: 66, debt_ratio: 0.36, ...over });
  const ind = { 汽车零部件: { med: 6.9, n: 40 } };
  const trend = { aa: { label: 'steady' }, bb: { label: 'mixed' }, cc: { label: 'broken', annualized: -0.02 },
    dd: { label: 'broken', annualized: 0.05 }, ee: { label: 'nope' } } as never;
  const out = corePoolSort(['ee', 'dd', 'cc', 'bb', 'aa'].map(c => mk(c)), ind, trend);
  assertEquals(out.map(r => r.trendKey), ['steady', 'mixed', 'broken_annualized', 'na', 'broken_recent']);
  // 全柱相同 → 复合分只由趋势数值决定：1 > 0.55×3 > 0.15；三个 0.55 同分按 code 升序（全序键保证重渲染同序）
  assertEquals(out.map(r => r.code), ['aa', 'bb', 'cc', 'ee', 'dd']);
});

Deno.test('corePoolSort：缺数据重归一而非记 0——缺负债率行不被负债项拖累；全缺行=纯中性 0.55（趋势支柱始终入权）', () => {
  const full = coreRow('full', { roic_med: 18, roic_min3: 15.3, margin_of_safety: 4.35, v_health: 66, debt_ratio: 0.36 });
  const noDebt = coreRow('nodebt', { roic_med: 18, roic_min3: 15.3, margin_of_safety: 4.35, v_health: 66, debt_ratio: null });
  const bare = coreRow('bare', { roic_med: null, roic_min3: null, margin_of_safety: null, v_health: null, debt_ratio: null });
  const out = corePoolSort([bare, noDebt, full]);
  // nodebt 0.6712 > full 0.6606：重归一的中性语义（缺一项=该项不参与），不是「缺数据占便宜」的伪装——按裁定钉成文档
  assertEquals(out.map(r => r.code), ['nodebt', 'full', 'bare']);
  assertEquals(Math.round(out[2].coreScore! * 1000), 550);   // 全缺 = 仅剩趋势中性 0.55：未知 ≠ 已知差，也不冒充已知好
});

Deno.test('renderValueTop10：标题=核心池 Top10·长期价值；脚注钉住四支柱权重与破位分腿；支柱读数/vq/ROIC 逐行可读', () => {
  const html = renderValueTop10({ batch: '2026-11-16', top10: [coreRow('600031')] as never[] });
  assertEquals(html.includes('核心池 Top10 · 长期价值'), true);
  assertEquals(html.includes('护城河40%+安全边际25%+稳健15%+长期趋势20%'), true);
  assertEquals(html.includes('破位按前视取证分腿'), true);
  assertEquals(html.includes('护城河 '), true);
  assertEquals(html.includes('ROIC中位 18.00%'), true);
  assertEquals(html.includes('vq 80.0'), true);
});

Deno.test('接线守卫：loadTrendBadges 候选=核心池复合前 12（趋势缺省按三支柱排，落地后 loadTrendBadges→renderStockSection 自动重排）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const start = html.indexOf('function loadTrendBadges(');
  assertEquals(start >= 0, true, 'loadTrendBadges 不存在');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assertEquals(/corePoolSort\(\(valueState && valueState\.top10 \? valueState\.top10 : \[\]\)/.test(body), true,
    '候选拉取必须是 corePoolSort 复合序（趋势未取到=中性 0.55，不得按旧纯 vq 序）');
  assertEquals(body.includes('.slice(0, 12)'), true, '候选=12（比展示多 2 只），兜住趋势落地后的切榜边缘');
  assertEquals(/b\.vq\s*-\s*a\.vq/.test(body), false, '旧的纯 vq 候选序不得残留');
});

Deno.test('接线守卫：股票区只渲染两张榜（核心池+收益型），量化初筛/分歧榜源码删净（2026-11-16 裁定）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf('function renderStockSection(');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(body.includes('renderValueTop10(valueState, trendCache, valueIndRef ? valueIndRef.byL2 : null)'), true,
    '核心池主榜未接（或行业参照没传进排序）');
  assertEquals(body.includes('renderIncomeList(incomeState)'), true, '收益型卡未接');
  assertEquals(body.includes('renderScoreTop10'), false, '量化初筛卡调用残留');
  assertEquals(body.includes('renderDivergeBoard'), false, '分歧榜调用残留');
  for (const gone of ['function renderScoreTop10', 'function renderDivergeBoard', 'function divergeLists',
    'function pctOf(', 'function scoreStars', 'INCOME_ROIC_MIN', 'alreadyQualified', 'highLeverage']) {
    assertEquals(html.includes(gone), false, '已删符号残留：' + gone);
  }
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

// ==== 2026-10-15 第一步（用户裁定「先第一步」）：NA 分口径 / 陈旧标注 / 失败计数 ====

Deno.test('as-of 溯源：longTrendStats 必须自带 asOf（最后一根月线的日期）——陈旧回退全靠它声明截止日', () => {
  const rows = monthlyToRows(mkCloses(30, 0.004));
  assertEquals(longTrendStats(rows)!.asOf, rows[rows.length - 1].date, 'asOf 不是最后一根月线的日期');
  assertEquals(longTrendStats(rows.slice().reverse())!.asOf, rows[rows.length - 1].date, '乱序输入把 asOf 带到了中间的月份');
});


Deno.test('缓存裁决 trendPick：本轮失败不许擦掉上次成功的数（回灌来的陈旧好值也是好值）', () => {
  const staleGood = { label: 'steady', annualized: 0.2, months: 300, asOf: '2026-10-14', stale: 1, staleDays: 1 } as never;
  assertEquals(trendPick(staleGood, { failed: 1 } as never), null, '取数失败会把上次成功的数擦掉');
  assertEquals(trendPick(staleGood, { short: 1, monthly: 3 } as never), null, '样本不足会把稳升说成没数据（源截断时的致命误报）');
  assertEquals(trendPick(null, { failed: 1 } as never), { failed: 1 } as never, '本来没值时必须如实标失败，不许留空占位');
  assertEquals((trendPick({ failed: 1 } as never, { label: 'mixed' } as never) as never as { label: string }).label, 'mixed',
    '新取到的标签不得被旧的 NA 占位挡住');
});

const stripTitle = (h: string) => h.replace(/ title="[^"]*"/g, '');

Deno.test('NA 必须分两种口径：取数失败 ≠ 数据不足（截图里 10/10 全「长期—」，用户分不清是网络还是次新股）', () => {
  const fail = trendBadgeHtml({ failed: 1 } as never);
  assertEquals(/取数失败/.test(stripTitle(fail)), true, '取数失败没在内联说清（title 不算，iPhone 无 hover）：' + fail);
  const short = trendBadgeHtml({ short: 1, monthly: 10 } as never);
  assertEquals(/不足/.test(stripTitle(short)), true, '样本不足没在内联说清：' + short);
  assertEquals(/取数失败/.test(short), false, '样本不足被说成了网络故障：' + short);
  assertEquals(/不足/.test(fail), false, '网络故障被说成了数据不足：' + fail);
  assertEquals(/长期—/.test(fail) && /长期—/.test(short), true, '角标本体一字不动（TREND_NA_CN 由命名测试钉住）');
  const ok = trendBadgeHtml(withLabel(mkCloses(60, 0.004)) as never);
  assertEquals(/取数失败|不足/.test(stripTitle(ok)), false, '有标签时不许挂 NA 归因：' + ok);
  assertEquals(/取数失败|不足/.test(trendBadgeHtml(null as never)), false, '还没取数（null）时不猜原因');
});

Deno.test('陈旧缓存必须当面标注截至哪天（决议 24 是「当日价口径」，不许拿上月缓存冒充）', () => {
  const fresh = withLabel(mkCloses(60, 0.004));
  assertEquals(/天前/.test(trendBadgeHtml(fresh as never)), false, '新鲜数据挂了陈旧标注：' + trendBadgeHtml(fresh as never));
  const stale = Object.assign({}, fresh, { asOf: '2026-09-30', stale: 1, staleDays: 15 });
  const h = stripTitle(trendBadgeHtml(stale as never));
  assertEquals(/09-30/.test(h), true, '陈旧标注没写截止日期：' + h);
  assertEquals(/15\s*天前/.test(h), true, '陈旧标注没写几天前：' + h);
  const legacy = Object.assign({}, fresh, { stale: 1 });   // 旧条目缺 asOf/staleDays
  assertEquals(/null|NaN|undefined/.test(trendBadgeHtml(legacy as never)), false,
    '缺字段的陈旧条目不得出脏值：' + trendBadgeHtml(legacy as never));
  const sameDay = Object.assign({}, fresh, { asOf: '2026-10-15', stale: 1, staleDays: 0 });   // 今天早些时候存的
  assertEquals(/天前/.test(trendBadgeHtml(sameDay as never)), false,
    '当天存的缓存就是当日价，标「0 天前」是每行挂一句废话：' + trendBadgeHtml(sameDay as never));
});

Deno.test('trendStaleDays：同一天=0、跨月跨年正确、时钟回拨不出负、非法输入=null（NaN 进界面就是脏值）', () => {
  assertEquals(trendStaleDays('2026-10-15', '2026-10-15'), 0);
  assertEquals(trendStaleDays('2026-09-30', '2026-10-15'), 15);
  assertEquals(trendStaleDays('2025-12-31', '2026-01-01'), 1);
  assertEquals(trendStaleDays('2026-10-15', '2026-10-14'), 0);
  assertEquals(trendStaleDays(null, '2026-10-15'), null);
  assertEquals(trendStaleDays('x', 'y'), null);
});

Deno.test('trendNaWhy / trendStaleHtml：口径词由数据决定，缺字段一律空串（宁可不说不许说错）', () => {
  assertEquals(/取数失败/.test(trendNaWhy({ failed: 1 } as never)), true);
  assertEquals(/不足/.test(trendNaWhy({ short: 1 } as never)), true);
  assertEquals(trendNaWhy(null), '');
  assertEquals(trendNaWhy({ label: 'steady' } as never), '');
  assertEquals(trendStaleHtml({ stale: 1, staleDays: 3, asOf: '2026-10-12' } as never).indexOf('3') >= 0, true);
  assertEquals(trendStaleHtml({ stale: 1 } as never), '');
  assertEquals(trendStaleHtml({ staleDays: 3, asOf: '2026-10-12' } as never), '');
});

Deno.test('取数失败计数只记账不猜：按日累加 ok/fail，不动其他日（一周后拿它判断到底多频繁）', () => {
  let s = fetchStatBump({}, '2026-10-15', false);
  s = fetchStatBump(s, '2026-10-15', false);
  s = fetchStatBump(s, '2026-10-15', true);
  s = fetchStatBump(s, '2026-10-14', true);
  assertEquals(s['2026-10-15'], { ok: 1, fail: 2 });
  assertEquals(s['2026-10-14'], { ok: 1, fail: 0 });
});

Deno.test('持久化接线守卫：成功才写穿 localStorage；回灌必须标 stale；stale 必须重取；失败不得覆盖已有陈旧条目', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const start = html.indexOf('function loadTrendBadges(');
  assertEquals(start >= 0, true, '找不到 loadTrendBadges');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assertEquals(/localStorage\./.test(html.slice(html.indexOf('var trendCache'))), true,
    'trendCache 附近没有 localStorage 读写 —— 第一步要求刷新后仍记得上次成功的数');
  assertEquals(/trendStorePut\(|trendStoreSave\(/.test(body), true, 'loadTrendBadges 成功分支没写穿 localStorage');
  assertEquals(/trendStorePut\(\s*code\s*,\s*trendCache\[code\]\s*\)/.test(body), true,
    '写穿的不是刚进 trendCache 的那一份 —— 内存与 localStorage 内容分叉，刷新后看到的是另一个数');
  assertEquals(/bumpFetchStat\(!x\.err\)/.test(body), true,
    '按日计数没记在「这条请求成没成」上：把次新股的样本不足算成网络故障，第二步就会被这份账带跑');
  // 必须把搜索范围收到 trendHydrate 自己身上：整页 html 上找 `stale: 1` 会被 trendCache 那行注释命中（M20 实测假绿）
  const hyStart = html.indexOf('function trendHydrate(');
  assertEquals(hyStart >= 0, true, '找不到 trendHydrate，回灌入口改名了？守卫需要重写');
  const hy = html.slice(hyStart, html.indexOf('\n}\n', hyStart));
  assertEquals(/stale:\s*1/.test(hy), true, '回灌条目没标 stale —— 不标就是拿旧口径冒充当日价，且缓存从此永久冻结不再重取');
  assertEquals(/\.stale/.test(body), true, 'todo 判定没把 stale 纳入重取范围 —— 缓存一旦落地就永久冻结');
  const catchAt = body.indexOf('failed: 1');
  assertEquals(catchAt >= 0, true, '失败分支形状变了，守卫需要重写');
  assertEquals(/trendStorePut\(|trendStoreSave\(/.test(body.slice(catchAt)), false,
    '失败分支里写了 localStorage —— 失败不得覆盖已有陈旧条目');
});

// ===================== 估值百分位自动取数（2026-10-16 用户裁定 A）=====================
// 口径不是设计选择，是 2026-10-15 抽样对账（18 只等距样本）实测出来的四个结论：
// ① 跨源当期值无争议（东财 vs 腾讯 ΔPE 相对中位 0.01%）；② 5 年窗口 vs 上市至今有 4/10 跨档（Δ最大 24.0pp）；
// ③ 历史负 PE 让 含负/仅正 两套分位差到 11.3pp 且语义反转（浙能 66.0→59.8 跨档）；
// ④ 用行业指数分位代理个股：中位误差 19.2pp、64% 跨档、11% 根本没有对应指数。
// 所以这里只允许「个股自身 + 上市至今（接口地板 2018-01-02）+ 仅正值参与」这一套口径，且必须当面写出来。
const valDay = (i: number) => { const d = new Date(Date.UTC(2025, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10) + ' 00:00:00'; };
// 120 期真实形态：60 期低于尾部、56 期高于尾部，再叠 4 期具象样本（含 1 期亏损）。
// 分母必须 ≥EM_VAL_MIN_ROWS —— 否则「样本不足」守卫会先于算式把结果吃掉，那就不是在测算式了。
const VAL_ROWS = [
  ...Array.from({ length: 60 }, (_, i) => ({ TRADE_DATE: valDay(i), PE_TTM: 5, PB_MRQ: 0.5 })),
  ...Array.from({ length: 56 }, (_, i) => ({ TRADE_DATE: valDay(60 + i), PE_TTM: 50, PB_MRQ: 50 })),
  { TRADE_DATE: '2026-10-12 00:00:00', PE_TTM: -5, PB_MRQ: 4.0 },   // 亏损期：不得进分母
  { TRADE_DATE: '2026-10-13 00:00:00', PE_TTM: 30, PB_MRQ: 3.0 },
  { TRADE_DATE: '2026-10-14 00:00:00', PE_TTM: 20, PB_MRQ: 2.0 },
  { TRADE_DATE: '2026-10-15 00:00:00', PE_TTM: 10, PB_MRQ: 1.0 },
];

Deno.test('emValUrl：只裁三列、pageSize=5000（老股恒定 2129 期，一页取完 → 无 PostgREST 式截断）', () => {
  const u = emValUrl('000338');
  assertEquals(u.includes('RPT_VALUEANALYSIS_DET'), true);
  assertEquals(u.includes('columns=TRADE_DATE,PE_TTM,PB_MRQ'), true,
    '必须裁列：全列实测 1.23MB/只，裁三列 160KB —— 持仓 20 首屏差 24MB 与 3.2MB');
  assertEquals(/columns=[^&]*TOTAL_MARKET/.test(u), false, '夹带无关列就是在给首屏加体积');
  assertEquals(u.includes('pageSize=5000'), true);
  assertEquals(u.includes('sortColumns=TRADE_DATE') && /sortTypes=-1/.test(u), true);
  assertEquals(decodeURIComponent(u).includes('SECURITY_CODE="000338"'), true);
});

Deno.test('分位公式：(低于 + 0.5×并列)/有效数×100，与仓内既有口径（V1 spec §10）同式', () => {
  const m = valuationPctFromRows(VAL_ROWS, '000001');
  assertEquals(m.na, null);
  assertEquals(m.metric, 'PE');
  assertEquals(m.n, 119, '负 PE 那期不得进分母');
  assertEquals(m.dropped, 1, '剔了几期必须当面可查，否则读者无法复算');
  assertEquals(m.pct, 50.8, '(60 低于 + 0.5×1 并列)/119×100 —— 并列只记半票');
});

Deno.test('并列的 0.5 票：全序列同值时必须是 50.0，既不是 0 也不是 100', () => {
  const flat = Array.from({ length: 120 }, (_, i) => ({ TRADE_DATE: valDay(i), PE_TTM: 10, PB_MRQ: 1 }));
  assertEquals(valuationPctFromRows(flat, '000001').pct, 50);
});

Deno.test('响应行序不可信：乱序输入必须给同一个分位（GS 键序教训的同型守卫）', () => {
  const a = valuationPctFromRows(VAL_ROWS, '000001');
  const b = valuationPctFromRows(VAL_ROWS.slice().reverse(), '000001');
  assertEquals(b.pct, a.pct);
  assertEquals(b.from, '2025-01-01');
  assertEquals(b.to, '2026-10-15');
});

Deno.test('当期亏损 → 改判 PB 分位，PE 那条一律不出现（博睿/之江实测 PE 为负、分位无意义）', () => {
  const rows = VAL_ROWS.map(r => ({ ...r, PE_TTM: r.TRADE_DATE.indexOf('2026-10-15') >= 0 ? -22.98 : r.PE_TTM }));
  const m = valuationPctFromRows(rows, '688229');
  assertEquals(m.metric, 'PB');
  assertEquals(m.na, null, 'PB 可用就不是未判定 —— 归成 NA 等于把能算的数扔掉');
  // 换指标 = 换分母：PB 120 期全正 → n=120、dropped=0（PE 那条的 1 期负值不再相关）；cur=1.0 → (60+0.5×1)/120
  assertEquals(m.n, 120);
  assertEquals(m.dropped, 0);
  assertEquals(m.pct, 50.4);
  assertEquals(valPctCaliber(m).includes('当期亏损'), true, '改判 PB 必须说明为什么换了指标');
});

Deno.test('PE 与 PB 当期都不可用 → pct=null，绝不落 0（0 会被 pctTier 读成「低估区·双倍」）', () => {
  const m = valuationPctFromRows(VAL_ROWS.map(r => ({ ...r, PE_TTM: -1, PB_MRQ: null })), '688229');
  assertEquals(m.na, 'no_current');
  assertEquals(m.pct, null);
});

Deno.test('NA 分口径三态关键词互斥：接口空响应 ≠ 样本不足 ≠ 非 A 股（trendNaWhy 同纪律）', () => {
  const failed = valuationPctFromRows([], '000338');
  const short = valuationPctFromRows(
    Array.from({ length: EM_VAL_MIN_ROWS - 1 }, (_, i) => ({ TRADE_DATE: '2026-01-0' + (1 + (i % 9)) + ' 00:00:00', PE_TTM: 10 + i, PB_MRQ: 1 })), '688545');
  const notA = valuationPctFromRows(VAL_ROWS, '00700');
  assertEquals([failed.na, short.na, notA.na], ['failed', 'short', 'not_a_share']);
  const wF = valPctNaWhy(failed), wS = valPctNaWhy(short), wN = valPctNaWhy(notA);
  assertEquals(wF.includes('样本不足'), false); assertEquals(wS.includes('样本不足'), true);
  assertEquals(wS.includes('未取到'), false);   assertEquals(wF.includes('未取到'), true);
  assertEquals(wN.includes('沪深 A 股'), true);
  assertEquals(wN.includes('未取到'), false, '把「平台本来就没这标的」报成「取数失败」，人会去反复重试');
  assertEquals(short.pct, null);
});

Deno.test('valPctSupported：只认 6 位 A 股代码；港股 5 位/北交所/ETF 实测返回空表（00700、510300 已验证）', () => {
  assertEquals([valPctSupported('000338'), valPctSupported('688545')], [true, true]);
  assertEquals([valPctSupported('00700'), valPctSupported('510300'), valPctSupported(''), valPctSupported(null)], [false, false, false, false]);
});

Deno.test('口径标签：把窗口、期数、剔除数、数据日期一次说全（同一只股两次快照必须可比）', () => {
  const m = valuationPctFromRows(VAL_ROWS, '000001');
  const t = valPctCaliber(m);
  assertEquals(t.includes('PE-TTM'), true);
  assertEquals(t.includes('119 期'), true);
  assertEquals(t.includes('2025-01-01') && t.includes('2026-10-15'), true);
  assertEquals(t.includes('剔除 1 期非正'), true);
});

Deno.test('当日缓存裁决：今日已取到就不重取；未判定/失败必须重取；跨日必须重取', () => {
  const ok = { ...valuationPctFromRows(VAL_ROWS, '000001'), fetchedAt: '2026-10-16' };
  assertEquals(valPctNeedFetch(ok, '2026-10-16'), false);
  assertEquals(valPctNeedFetch(ok, '2026-10-17'), true, '分位是日频数，隔天不重取就是在拿昨天冒充今天');
  assertEquals(valPctNeedFetch({ ...ok, na: 'failed' }, '2026-10-16'), true);
  assertEquals(valPctNeedFetch(null, '2026-10-16'), true);
  assertEquals(valPctNeedFetch({ ...ok, fetchedAt: null }, '2026-10-16'), true, '缺 fetchedAt 的旧条目一律重取，宁多一次请求');
});

Deno.test('失败不得擦掉上次成功的分位：valPctMerge 返回 null 表示保留旧条目（trendPick 同纪律）', () => {
  const good = { ...valuationPctFromRows(VAL_ROWS, '000001'), fetchedAt: '2026-10-16' };
  const failed = { metric: null, pct: null, n: 0, total: 0, dropped: 0, from: null, to: null, cur: null, na: 'failed', fetchedAt: '2026-10-17' };
  assertEquals(valPctMerge(good, failed), null, '一次网络抖动就把可用分位降级成 NA，是本轮明确要防的静默失败');
  assertEquals(valPctMerge(good, good)?.pct, 50.8);
  assertEquals(valPctMerge(null, failed)?.na, 'failed', '本来就没有旧值时，NA 也得落地 —— 不落地就是界面无感');
  assertEquals(valPctMerge(null, good)?.pct, 50.8);
});

Deno.test('人工值优先：手填过分位就不覆盖，只在提示里报自动值（自动读取不得悄悄改用户的输入）', () => {
  const fresh = { ...valuationPctFromRows(VAL_ROWS, '000001'), fetchedAt: '2026-10-16' };
  assertEquals(valPctApply({ valuationPercentile: '' }, fresh), { write: true, value: 50.8, note: '' });
  assertEquals(valPctApply({ valuationPercentile: '50.8', valPctAuto: 50.8 }, fresh), { write: true, value: 50.8, note: '' },
    '上次是自动填的就该继续由自动刷新接管，否则首屏缓存从此永久冻结');
  const locked = valPctApply({ valuationPercentile: '5', valPctAuto: 50.8 }, fresh);
  assertEquals(locked.write, false, '手填 5 被自动 50.8 冲掉 = 悄悄改用户输入');
  assertEquals(locked.value, 5, '不覆盖时回读人工值，卡片与信号必须看到同一个数');
  assertEquals(locked.note.includes('50.8'), true, '不覆盖也要把自动算得的数披露出来');
});

Deno.test('接线守卫：取数→合并→写回→渲染 四跳齐全，且 meta 整包 Object.assign（禁逐字段枚举）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const bodyOf = (name: string) => {
    const at = html.indexOf('function ' + name + '(');
    assertEquals(at >= 0, true, '找不到 ' + name + '，接线守卫需要重写');
    return html.slice(at, html.indexOf('\n}\n', at));
  };
  // 第一跳：URL 与算分位必须同源，否则裁列/pageSize 会在某一跳漂移
  const io = bodyOf('fetchValuationPct');
  assertEquals(/emValUrl\(/.test(io), true, '取数没用统一 URL 构造函数');
  assertEquals(/valuationPctFromRows\(/.test(io), true, '取到响应却没算分位');
  assertEquals(/AbortSignal\.timeout\(/.test(io), true, '没有硬超时：东财挂起会把整批首屏一起拖住（auth 那轮 15s 教训）');
  // 第二跳：写回。dom.md 记过的「内联小字从未渲染」就是逐字段枚举造成的
  const mg = bodyOf('refreshValuationPct');
  assertEquals(/fetchValuationPct\(/.test(mg), true, '合并层没真去取数');
  assertEquals(/valPctNeedFetch\(/.test(mg), true, '没走当日缓存判定 —— 每次 focus 重入都会重打 3.2MB');
  assertEquals(/valPctMerge\(/.test(mg), true, '失败没裁决就写回 —— 一次网络抖动就会把上次成功的分位擦成 NA');
  assertEquals(/Object\.assign/.test(mg), true, 'meta 逐字段枚举写回 = 字段流向对不上账');
  // 合并裁决必须真的 gate 住写回：写成 Object.assign({}, fresh) 一样能过上一条，却把「失败不擦好值」退化成一句空话
  assertEquals(/Object\.assign\(\{\},\s*keep\s*\)/.test(mg), true,
    '写回的不是 valPctMerge 留下的那一份 —— 一次网络抖动就能把上次成功的分位擦成 NA');
  assertEquals(/valPctApply\(/.test(mg), true, '没经人工优先裁决就写 valuationPercentile，会悄悄冲掉用户手填值');
  assertEquals(/\.valuationPercentile\s*=/.test(mg), true, '算了分位却没写进消费字段，双信号与抄底仲裁都看不见');
  // 分位没动但 fetchedAt 换了，同样得算「有变化」，否则这次写回永不落盘、下一次打开页面又是整批 160KB/只
  assertEquals(/changed:\s*changed\s*\|\|\s*metaChanged/.test(mg), true,
    'changed 只统计字段变化、丢掉了缓存刷新 —— 当日缓存从此形同虚设，同一天反复打开就反复重打东财');
  // 第三、四跳：两个入口 + 渲染
  assertEquals(/refreshValuationPct\(/.test(bodyOf('autoRefreshStocks')), true, '首屏批量没带估值分位：页面打开自动刷新的既有约定落空');
  assertEquals(/refreshValuationPct\(/.test(bodyOf('autoFetchStockData')), true, '单只「自动获取行情」没顺手取分位');
  assertEquals(/valPctHtml\(/.test(bodyOf('dualSignalHtml')), true,
    '卡片不渲染口径标签 = 同一只股两次快照跳档时，无从判断是估值变了还是口径变了');
  // 取过数却没分位（NA 三态）时，「两项数据全无」的老早退会把占位一起吞掉 —— 界面无感正是 dom.md 记过的那类缺陷
  assertEquals(/dd===null\)[\s\S]{0,200}?return chip/.test(bodyOf('dualSignalHtml')), true,
    '无分位无回撤必须退回「只渲染 NA 占位」，静默返回空串等于把「不适用」和「没取过」都说成没话说');
  assertEquals(/valPctLockNote\(/.test(bodyOf('dualSignalHtml')), true,
    '手工值与自动值同时出现在卡片上却没人裁决归属 = 读者把「暂停」归因到那个没在用的数上');
});

Deno.test('valPctHtml：有值渲染口径 chip；未判定渲染显式占位；跨日必须标陈旧（空串=界面无感，正是本仓库记过的静默降级）', () => {
  const ok = { ...valuationPctFromRows(VAL_ROWS, '000001'), fetchedAt: '2026-10-16' };
  assertMatch(valPctHtml(ok, '2026-10-16'), /PE分位 50\.8/);
  assertEquals(valPctHtml(null, '2026-10-16'), '', '没取过就不显示，别在卡片上加噪音');
  assertMatch(valPctHtml({ ...ok, na: 'failed' }, '2026-10-16'), /估值分位未取到/);
  assertMatch(valPctHtml({ ...ok, fetchedAt: '2026-10-13' }, '2026-10-16'), /3 天前/,
    '三天的分位冒充今天的分位 —— 百分位是日频数，陈旧必须当面说');
});

Deno.test('自动值与在用值不一致时必须当面说清谁在驱动信号（本地 DOM 实测：手填 85 时 chip 仍显示 PE分位 39.8，读者会把「暂停」归因到 39.8 上）', () => {
  const auto = { ...valuationPctFromRows(VAL_ROWS, '000001'), fetchedAt: '2026-10-16' };   // 自动算得 50.8
  assertEquals(valPctLockNote(50.8, auto), '', '两个数一致 = 没话要说，别在卡片上长字');
  const lock = valPctLockNote(85, auto);
  assertMatch(lock, /85/, '手工在用的数必须出现');
  assertMatch(lock, /50\.8/, '自动算得的数也要出现，否则无从对照');
  assertMatch(lock, /为准/, '得说清是谁在驱动信号 —— 只摆两个数等于没裁决');
  assertEquals(valPctLockNote(null, auto), '', '没填分位时主文案已经说「未填估值百分位」，这里不重复');
  assertEquals(valPctLockNote(85, { ...auto, na: 'failed' }), '', 'NA 没有自动值可比，不许造「自动算得 null」这种脏话');
  assertEquals(valPctLockNote(85, null), '', '从没取过数 = 不存在第二口径，没什么要说');
});

// ==== 收益型观察名单（2026-10-30 独立通道 → 2026-11-16 用户裁定收紧为全四要求；前 15）====
// 夹具形态＝收紧后能活下来的行：白名单行业 + 股息双门 + 价值门禁全过（tier=qualified）+ 负债率合规。
const incRow = { code:'600900', name:'长江电力', ths_l2:'电力', in_pool:true,
  div_yield:4.6, div_yield_5y:3.2, roic_med:12.5, debt_ratio:0.55, tier:'qualified' };

Deno.test('INCOME_DEBT_MAX 常数为 0.75（2026-11-16 裁定：与核心池负债率顶同值；旧 ROIC≥3 三筛已废）', () => {
  assertEquals(INCOME_DEBT_MAX, 0.75);
});

Deno.test('收益型名单：五道筛子逐格生效（行业白名单 / 股息率≥4 / 5年股息≥2.5 / 价值门禁全过 / 负债率≤75%）', () => {
  const out = incomeChannelOf([
    incRow,                                             // 唯一幸存者：五道筛全过
    { ...incRow, code:'x_ind', ths_l2:'白酒' },
    { ...incRow, code:'x_dy', div_yield:3.9 },
    { ...incRow, code:'x_dy5', div_yield_5y:2.4 },
    { ...incRow, code:'x_rich', tier:'too_rich' },      // 护城河宽但无安全边际 → 高息透镜也不收（粤高速A 形态）
    { ...incRow, code:'x_veto', tier:'vetoed' },
    { ...incRow, code:'x_unq', tier:'unqualified' },
    { ...incRow, code:'x_debt', debt_ratio:0.751 },
  ]);
  assertEquals(out.total, 1);
  assertEquals(out.list.map(r => r.code), ['600900']);
});

Deno.test('收益型名单：阈值是闭区间，恰好等于门槛必须入选（4 / 2.5 / 0.75 均二进制精确）', () => {
  const out = incomeChannelOf([{ ...incRow, div_yield:4, div_yield_5y:2.5, debt_ratio:0.75 }]);
  assertEquals(out.total, 1);
});

Deno.test('收益型名单：股息缺失整行剔除，不得当 0、也不得当通过；tier 缺失=门禁未知=剔除；负债率缺失不剔除', () => {
  const out = incomeChannelOf([
    { ...incRow, code:'n_debt', div_yield:5.5, debt_ratio:null },   // 幸存者二：负债缺失只不拦
    incRow,                                                          // 幸存者一
    { ...incRow, code:'n_dy', div_yield:null },
    { ...incRow, code:'n_dy5', div_yield_5y:undefined },
    { ...incRow, code:'n_tier', tier:undefined },
  ]);
  assertEquals(out.total, 2);
  assertEquals(out.list.map(r => r.code), ['n_debt', '600900']);   // 股息降序
});

Deno.test('收益型名单：按股息率降序、页面只取前 15、池内核心按 in_pool 严格 true 打标', () => {
  const rows = Array.from({ length: 18 }, (_, i) => ({ ...incRow, code: 'c' + String(i).padStart(2, '0'), div_yield: 6 - i * 0.1 }));
  rows[0] = { ...rows[0], in_pool: true };              // c00 池内核心
  rows[1] = { ...rows[1], in_pool: false };             // c01 池外
  rows[2] = { ...rows[2], in_pool: undefined as never };  // 缺字段 ≠ 池内（=== true 才标，绝不 undefined 冒充）
  const out = incomeChannelOf(rows);
  assertEquals(out.total, 18);
  assertEquals(out.list[0].code, 'c00');
  assertEquals(out.list[0].inCorePool, true);
  assertEquals(out.list[1].inCorePool, false);
  assertEquals(out.list[2].inCorePool, false);
  const html = renderIncomeList({ batch: '2026-10-11', list: out.list, total: out.total });
  assertEquals((html.match(/class="score-row"/g) || []).length, 15);
  assertEquals(html.includes('共 18 只'), true);
  assertEquals(html.includes('池内核心'), true);
  assertEquals(html.includes('c17'), false);            // 第 16~18 只被截掉
  assertEquals(html.includes('不构成买卖建议'), true);
});

Deno.test('renderIncomeList：null → 空串（降级文案由调用点决定）；有批次但零命中必须出卡说明，不得静默消失；脚注点明四要求全过', () => {
  assertEquals(renderIncomeList(null), '');
  const empty = renderIncomeList({ batch: '2026-10-11', list: [], total: 0 });
  assertEquals(empty.includes('本批次无同时通过'), true);   // 空榜 ≠ 无此功能：静默消失正是仓库记过的降级
  assertEquals(empty.includes('不构成买卖建议'), true);
  const html = renderIncomeList({ batch: '2026-10-11', list: [incRow as never], total: 1 });
  assertEquals(html.includes('8%'), true);              // 脚注须点明价值门禁锚
  assertEquals(html.includes('有息负债率'), true);
});

Deno.test('接线守卫：收益型名单独立取数（不得复用只含精选池+持仓的 valueState），并接进并行加载与渲染点', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const start = html.indexOf('async function loadIncomeWatch(');
  assertEquals(start >= 0, true, 'loadIncomeWatch 不存在');
  const end = html.indexOf('\n}\n', start);
  assertEquals(end > start, true, 'loadIncomeWatch 函数体边界未找到');
  const body = html.slice(start, end);
  for (const t of ['stock_value', "in('ths_l2'", 'legOrderOpts(', 'legRange(', 'legHasMore(', 'legTiebreakCol(', 'incomeChannelOf(']) {
    assertEquals(body.includes(t), true, 'loadIncomeWatch 缺少：' + t);
  }
  // legFilter 只取「精选池 + 持仓」，与独立通道「白名单行业 × 全市场」的总体不符——用了就是同名不同总体
  assertEquals(body.includes('legFilter('), false, '收益型名单不得用 legFilter');
  assertEquals(/Promise\.all\(\[[^\]]*loadIncomeWatch\(\)[^\]]*\]\)/.test(html), true,
    '收益型取数必须与首屏同一批并行，否则回流/竞态');
  const vi = html.indexOf('renderValueTop10(valueState, trendCache, valueIndRef ? valueIndRef.byL2 : null)');
  const ii = html.indexOf('renderIncomeList(incomeState)');
  assertEquals(vi >= 0 && ii > vi, true, '收益型卡片必须接在核心池榜之后（且主榜调用点带行业参照）');
});

Deno.test('负债率上限：>75% 剔除、恰好 75% 留（0.75 二进制精确）；缺失不拦也不伪装', () => {
  const at75 = incomeChannelOf([{ ...incRow, code:'d75', debt_ratio: 0.75 }]);
  const at76 = incomeChannelOf([{ ...incRow, code:'d76', debt_ratio: 0.751 }]);
  assertEquals(at75.total, 1);
  assertEquals(at76.total, 0);
  const na = incomeChannelOf([{ ...incRow, code:'dna', debt_ratio: null }]);
  assertEquals(na.total, 1);
  assertEquals(na.list[0].code, 'dna');
});

Deno.test('valueMedian / valueIndStatsOf：行业中位只吃有效 roic_med，n=有效行数', () => {
  assertEquals(valueMedian([]), null);
  assertEquals(valueMedian([5, null, 7]), 6);
  assertEquals(valueMedian([7]), 7);
  assertEquals(valueMedian([1, 3, 9, 20]), 6);          // 偶数取中间两数均值
  const s = valueIndStatsOf([
    { ths_l2: '汽车零部件', roic_med: 4 }, { ths_l2: '汽车零部件', roic_med: 6 },
    { ths_l2: '汽车零部件', roic_med: 20 }, { ths_l2: '汽车零部件', roic_med: null },
    { ths_l2: '白酒', roic_med: 15 }, { ths_l2: null, roic_med: 99 },
  ]);
  assertEquals(s['汽车零部件'], { med: 6, n: 3 });     // null 不计入分母，也不当 0
  assertEquals(s['白酒'], { med: 15, n: 1 });
  assertEquals(s[undefined as never], undefined);        // 缺行业不造「无名行业」
  assertEquals(Object.keys(s).length, 2);
});

Deno.test('价值否决文案：无护城河证据 → 本股 ROIC 数值 + 8% 门槛 + 同行业中位，不再是一句「无证据」', () => {
  const veto = { ...row, tier: 'vetoed', veto_reasons: ['无护城河证据'], ths_l2: '汽车零部件',
    roic_med: 7.654586, roic_cur: 7.654586, roic_min3: 7.012263 };
  const h = valueGateHtml(veto, { '汽车零部件': { med: 6.9027, n: 215 } });
  for (const t of ['⛔ 硬否决', 'ROIC 未达 8%', 'ROIC 中位 7.65%', '当期 7.65%', '近3年最低 7.01%',
    '门槛 8%', '同行业中位 6.90%', '汽车零部件 n=215']) {
    assertEquals(h.includes(t), true, '缺少：' + t);
  }
  // 7.65 高于同业中位 6.90：必须说清「高于同行但未过绝对门槛」，否则读者会以为数据自相矛盾
  assertEquals(h.includes('高于同行业中位，仍未过门槛'), true);
  // 原句会让人读成「找不到数据」，不许再出现
  assertEquals(h.includes('无护城河证据'), false, '原句「无护城河证据」必须换掉');
});

Deno.test('价值否决文案：缺行业参考时只讲本股与门槛；低于同业中位时换说法；不得出现 NA 冒充数值', () => {
  const veto = { ...row, tier: 'vetoed', veto_reasons: ['无护城河证据'], ths_l2: '汽车零部件',
    roic_med: 5.2, roic_cur: 3.1, roic_min3: null };
  const noInd = valueGateHtml(veto, null);
  assertEquals(noInd.includes('同行业中位'), false);
  assertEquals(noInd.includes('ROIC 中位 5.20%'), true);
  assertEquals(noInd.includes('当期 3.10%'), true);
  assertEquals(noInd.includes('近3年最低'), false);      // 缺值不硬造一行
  assertEquals(noInd.includes('NA'), false);
  const below = valueGateHtml(veto, { '汽车零部件': { med: 9.5, n: 215 } });
  assertEquals(below.includes('本股也低于同行业中位'), true);
});

Deno.test('价值否决文案：金融股（roic_med 天然 NA）走 ROE 说法，不把 NA 当数值展示', () => {
  const fin = { ...row, tier: 'vetoed', veto_reasons: ['无护城河证据'], roic_med: null, roic_cur: null, roic_min3: null };
  const h = valueGateHtml(fin, { '银行': { med: 6.1, n: 42 } });
  assertEquals(h.includes('ROE'), true);
  assertEquals(h.includes('金融股'), true);
  assertEquals(h.includes('金融股按 ROE 对标'), true);
  assertEquals(h.includes('ROIC 未达'), false);   // 金融股用的不是 ROIC 口径，别混说
});

Deno.test('价值否决文案：其它否决原因原样可见（不被护城河改写吞掉）', () => {
  const h = valueGateHtml({ ...row, tier: 'vetoed', veto_reasons: ['资不抵债', '商誉/净资产>50%'] });
  assertEquals(h.includes('资不抵债'), true);
  assertEquals(h.includes('商誉/净资产&gt;50%'), true);   // 原因串经 escapeHtml，'>' 变实体
});

// ── 2026-10-31：抄底亮灯时要标出「价值硬否决是哪一类」（用户裁定：只标注，不改买入指令）──
// 三态按质地/行业中位分：普通＝资不抵债/商誉/烧钱加杠杆这类与行业无关的硬伤；
// 双否决＝护城河否决且本股 ROIC 不高于同行业中位（绝对门槛里、同行比较里都输）；
// 单否决＝护城河否决但本股高于同行业中位（只被 8% 资本成本锚这一条绝对门槛压住）。


Deno.test('接线守卫：价值评估栏每卡常驻，行业参照与批次状态由调用点传入', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  // 2026-11-01 三栏收口：原来「灯亮才补一行否决标注」改成卡片常驻第三栏——价值只回答值不值，
  // 与买卖灯位无关，所以调用点前面不得再挂 sDipGate.light 这类指令门禁。
  assertEquals(/sDipGate\.light \? valueAssessmentHtml\(/.test(html), false,
    '价值栏一旦跟灯位绑定就又变回「抄底才提醒风险」的附属标注了');
  assertEquals(/const vRow = valueState \? valueState\.rows\.get\(/.test(html), true,
    '必须按 code 取本批次价值行（取不到就是未判定）');
  // 2026-11-14 港股分流：原断言只钉 A 股单分支，分流后必然红。**改写而非删除**——
  // 两条分支都要钉住，否则「港股接上了但 A 股被顺手改坏」或「A 股没动但港股根本没接」都能溜过。
  assertEquals(/const valueRef = isHk\s*\?\s*valueAssessmentHkHtml\(hkRow, !!valueHkState\)\s*:\s*valueAssessmentHtml\(vRow, valueIndRef \? valueIndRef\.byL2 : null, !!valueState\);/.test(html), true,
    '分流必须两条分支都在：港股走降维栏、A 股原调用一字不动，且行业参照与批次状态仍由调用点传入');
  assertEquals(html.includes("const isHk = /^\\d{5}$/.test(String(s.code||'').trim());"), true,
    '分流判据必须是 5 位码形态（港股），不得按名字或行业猜');
  assertEquals(/const hkRow = valueHkState \? valueHkState\.rows\.get\(/.test(html), true,
    '港股行必须按 code 取本批次（取不到就是未判定）');
  assertEquals(html.includes('${valueRef}'), true, '评估栏要渲染进卡片');
});

Deno.test('ROIC_GATE_PCT 与引擎 ROIC_GATE 同值（改一端必须改另一端）', async () => {
  const engine = await Deno.readTextFile(new URL('../supabase/functions/stock-value/value_engine.ts', import.meta.url));
  const m = engine.match(/const ROIC_GATE = (\d+(?:\.\d+)?)/);
  assertEquals(m !== null, true, '引擎里找不到 ROIC_GATE');
  assertEquals(ROIC_GATE_PCT, Number(m![1]), '前端门槛文案与引擎判定漂移');
});

Deno.test('接线守卫：行业参照是独立只读取数，挂进首屏 Promise.all，并传给价值门禁卡', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('function loadValueIndustryRef('), true, '缺行业参照取数');
  const s = html.indexOf('function loadValueIndustryRef(');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(body.includes(".select('ths_l2,roic_med')"), true, '只取两列，别把整表拉回来');
  assertEquals(body.includes('valueIndStatsOf('), true, '中位计算必须走纯函数');
  const all = html.match(/Promise\.all\(\[[^\]]*\]\)/g) || [];
  assertEquals(all.some(x => x.includes('loadValueIndustryRef()')), true, '未并入首屏并行取数');
  assertEquals(html.includes('valueGateHtml(vRowForSwap, valueIndRef'), true, '门禁卡没拿到行业参照');
});

// ==== 三张榜单卡折叠（2026-10-30 用户要求：默认收起、记住选择）====
Deno.test('foldCardHtml：卡片带折叠键、默认收起（无 fold-open）、按钮初始为「展开」，键值转义', () => {
  const h = foldCardHtml('income', '收益型观察名单', '<div class="x">正文</div>');
  assertEquals(h.includes('class="fund-card fold-card"'), true);
  assertEquals(h.includes('data-fold-key="income"'), true);
  assertEquals(h.includes('fold-btn'), true);
  assertEquals(h.includes('aria-expanded="false"'), true);
  assertEquals(h.includes('展开'), true);
  assertEquals(h.includes('fold-open'), false);
  assertEquals(h.includes('<div class="fold-body"><div class="x">正文</div></div>'), true);
  assertEquals(foldCardHtml('a"b', 't', 'b').includes('data-fold-key="a&quot;b"'), true);
});

Deno.test('两张榜单卡都必须走折叠壳：核心池/收益型（纯函数内）；已删的量化初筛卡不得残留', () => {
  const v = renderValueTop10({ batch: '2026-10-11', top10: [row] as never[] });
  assertEquals(v.includes('data-fold-key="value"'), true);
  assertEquals(v.includes('fold-open'), false);
  const i = renderIncomeList({ batch: '2026-10-11', list: [incRow as never], total: 1 });
  assertEquals(i.includes('data-fold-key="income"'), true);
  assertEquals(i.includes('fold-open'), false);
});

Deno.test('接线守卫：默认收起靠 CSS（无 fold-open 即隐藏），展开状态由点击写入 localStorage 并在渲染后回放', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(/\.fold-card \.fold-body\{display:none;?\}/.test(html), true, '缺少默认收起 CSS');
  assertEquals(/\.fold-card\.fold-open \.fold-body\{display:block;?\}/.test(html), true, '缺少展开态 CSS');
  assertEquals(html.includes("localStorage.getItem('dinvest_fold_'"), true, '读不到上次选择');
  assertEquals(html.includes("localStorage.setItem('dinvest_fold_'"), true, '写过不存＝记不住');
  assertEquals(html.includes('function applyFoldState('), true, '缺回放函数');
  assertEquals(html.includes('.fold-card[data-fold-key]'), true, '回放必须覆盖所有折叠卡');
  // 渲染收尾必须回放，否则展开过的卡片刷新后「看着收起」但按钮说「收起」
  const start = html.indexOf('function renderStockSection(');
  const applyAt = html.indexOf('applyFoldState(list)', start);
  assertEquals(start >= 0 && applyAt > start, true, 'renderStockSection 里没调用 applyFoldState(list)');
  // 2026-11-16 裁定：量化初筛卡（foldCardHtml('score'）删除——删卡必须删净，不得留半张
  assertEquals(html.includes("foldCardHtml('score'"), false, '量化初筛卡已删，foldCardHtml(\'score\' 不得残留');
});

Deno.test('接线守卫（体级）：回放要真的按存储开关卡片，判定只认 "1"（"0" 必须继续收起）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const fs = html.indexOf('function applyFoldState(');
  assertEquals(fs >= 0, true);
  const fbody = html.slice(fs, html.indexOf('\n}\n', fs));
  for (const t of ['foldOpenOf(', 'classList.toggle(', ".textContent = open ? '收起' : '展开'", 'aria-expanded']) {
    assertEquals(fbody.includes(t), true, 'applyFoldState 缺少：' + t);
  }
  const rs = html.indexOf('function foldOpenOf(');
  const rbody = html.slice(rs, html.indexOf('\n}\n', rs));
  assertEquals(rbody.includes("localStorage.getItem('dinvest_fold_'+key)==='1'"), true,
    '只能把 "1" 当展开：否则上次收起过的卡片刷新后会自己打开');
});

Deno.test('接线守卫：折叠按钮必须有委托点击监听（卡片是渲染后动态插入的，不能只在创建时绑）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf("document.addEventListener('click', function(e){");
  assertEquals(s >= 0, true, '缺委托点击监听');
  const body = html.slice(s, html.indexOf('\n});', s));
  for (const t of [".closest('.fold-btn')", "classList.contains('fold-open')", "localStorage.setItem('dinvest_fold_"]) {
    assertEquals(body.includes(t), true, '点击监听缺少：' + t);
  }
});

// ==== 2026-11-01 三栏收口：价值评估栏的行为契约（2ef0b33 手改实现，本批按 TDD 补测试）====
// 这一栏替代原「价值 硬否决 ⛔」胶囊与灯亮标注，所以原裁定里最硬的两条必须在它身上重验：
// ① 不许把「本股高于同行业中位」说成「低于同行业中位」（2026-10-31 双/单否决口径）；
// ② 只回答「值不值」，不发买卖指令（2026-10-31 指令隔离）。
const vaVeto = { code:'600001', name:'单/双否决样本', tier:'vetoed', vetoed:true,
  veto_reasons:['无护城河证据'], ths_l2:'工程机械', roic_med:5.0, v_moat:20, v_health:55, margin_of_safety:12.0 };
const vaIndHigher = { '工程机械': { med: 4.0, n: 30 } };   // 本股 5.0 > 同行 4.0 ⇒ 只是没过资本成本门槛
const vaIndLower  = { '工程机械': { med: 9.0, n: 30 } };   // 本股 5.0 ≤ 同行 9.0 ⇒ 与同行一样差

Deno.test('价值评估栏：本股 ROIC 高于同行业中位时，绝不许写「低于同行业中位」', () => {
  const out = valueAssessmentHtml(vaVeto, vaIndHigher, true);
  assertEquals(out.includes('未覆盖资本成本'), true, '门槛没过这件事必须说出来');
  assertEquals(out.includes('低于同行业中位'), false,
    '本股 5.0% 高于同行中位 4.0%，写「低于同行业中位」是假话：' + out.replace(/<[^>]+>/g, ' '));
  assertEquals(/高于同行业中位/.test(out), true, '单否决要把「优于同行仍被绝对门槛压住」说清楚');
});

Deno.test('价值评估栏：本股 ROIC 不高于同行业中位时必须点明「低于同行业中位」并给中位值', () => {
  const out = valueAssessmentHtml(vaVeto, vaIndLower, true);
  assertEquals(/低于同行业中位 9\.00%/.test(out), true, '双否决要说清同行中位值：' + out.replace(/<[^>]+>/g, ' '));
});

Deno.test('价值评估栏：没有同行业参照时不凭空提中位，也不冒充有参照', () => {
  const out = valueAssessmentHtml(vaVeto, null, true);
  assertEquals(out.includes('同行业中位'), false, '无参照却提中位是编数据');
  assertEquals(out.includes('无同行业参照'), true, '要显式说没有参照');
});

Deno.test('价值评估栏：缺值一律 NA，不拿 0 或 NaN 冒充结论', () => {
  const empty = { code:'600002', name:'缺值样本', tier:'unqualified', vetoed:false, veto_reasons:[],
    ths_l2:'工程机械', roic_med:null, v_moat:null, v_health:null, margin_of_safety:null };
  const out = valueAssessmentHtml(empty, vaIndLower, true);
  assertEquals(/NaN|null%|undefined|nullpp/.test(out), false, '缺值不许冒充数值：' + out.replace(/<[^>]+>/g, ' '));
  assertEquals((out.match(/NA/g) || []).length, 4, '四维都缺 ⇒ 四格各写一次 NA：' + out.replace(/<[^>]+>/g, ' '));
});

Deno.test('价值评估栏：未判定三态分开——无概念/查过取不到/批次未生成', () => {
  assertEquals(valueAssessmentHtml(undefined, vaIndHigher, true), '', '调用点没有这一行的概念时不刷栏');
  assertEquals(valueAssessmentHtml(null, vaIndHigher, false), '', '价值批次尚未生成时不刷栏（别处已有降级语）');
  assertEquals(valueAssessmentHtml(null, vaIndHigher, true).includes('本批次无该股数据（未判定）'), true,
    '查过但取不到 = 未判定，绝不等于合格');
});

Deno.test('价值评估栏：本股 ROIC 与同行业中位持平时说「持平」，既不写低于也不写高于', () => {
  const flat = (h: string) => h.replace(/<[^>]*>/g, '');
  const out = flat(valueAssessmentHtml({ ...vaVeto, roic_med: 5.0 }, { 工程机械: { med: 5.0, n: 24 } }, true));
  assertEquals(out.includes('低于同行业中位'), false, '5.0 与中位 5.0 相等，写「低于」是假话：' + out);
  assertEquals(out.includes('高于同行业中位'), false, '相等也不是「高于」：' + out);
  // 锚必须带上分支自己的措辞：只写「同行业中位 5.00%」会被雷达格那句满足，verdict 分支回退一位小数也测不到
  assertMatch(out, /与同行业中位 5\.00% 持平，未过资本成本门槛/);
});

Deno.test('价值评估栏：只回答值不值，栏内不得出现任何买卖指令话术', () => {
  const cases = [
    valueAssessmentHtml(vaVeto, vaIndHigher, true),
    valueAssessmentHtml(vaVeto, vaIndLower, true),
    valueAssessmentHtml({ ...row }, vaIndHigher, true),
    valueAssessmentHtml({ ...row, v_moat: 20, v_health: 20, margin_of_safety: -3, roic_med: 3 }, vaIndHigher, true),
    valueAssessmentHtml({ ...row, v_moat: 20, v_health: 20, margin_of_safety: -3, roic_med: 3, tier:'unqualified' }, vaIndHigher, true),
  ];
  for (const one of cases) {
    const txt = one.replace(/<[^>]+>/g, ' ');
    for (const bad of ['建议买入', '加仓', '新建仓', '建仓', '卖出', '可观察等待', '等待更好价格', '→']) {
      assertEquals(txt.includes(bad), false, '价值评估栏里出现指令话术「' + bad + '」：' + txt);
    }
    assertEquals(/NaN|null%|undefined/.test(txt), false, '缺值不许冒充数值：' + txt);
  }
  assertEquals(cases.some(c => c.includes('不等于买卖指令')), true, '隔离声明必须在栏内（让用户知道这栏不发指令）');
});

// ==== 2026-11-01 三栏收口：止盈栏的三态必须由「活着的那支渲染函数」给出 ====
// 三态只由 profitRefHtml 一处给出（手改后卡片改走它；旧的 profitMetaText 已于 2026-11-02 作为零调用死代码删除）。
// 邮件端 tierNoteHtml 仍说「各止盈档已执行完毕」；档表恒有 DEFAULT_TIERS 兜底，
// 所以 nextTier 为空只可能是「全部档已执行」，把它念成「暂无止盈档」是假话。
Deno.test('止盈参考栏：三态齐全——已达档 / 下一档 / 全部执行完（与邮件同句）', () => {
  const flat = (h: string) => h.replace(/<[^>]*>/g, '');
  const hit = profitRefHtml({ tier: { ret: 20, sell: 10 }, ret: 25 }, null, 25, null, { shares: 1000 });
  assertMatch(flat(hit), /已达 \+20% 止盈档（卖10%）/);
  const next = profitRefHtml(null, { ret: 20, sell: 10 }, 8, null, { shares: 1000 });
  assertMatch(flat(next), /下一止盈档 \+20% （卖10%）/);
  const done = profitRefHtml(null, null, 65, null, { shares: 1000 });
  const doneTxt = flat(done);
  assertMatch(doneTxt, /各止盈档已执行完毕/);
  assertEquals(doneTxt.includes('暂无止盈档'), false,
    '档表恒有默认档兜底，取不到下一档只可能是已全部执行——「暂无止盈档」是假话：' + doneTxt);
});

// ==== 2026-11-16 落袋计入总收益（用户裁定）：基金形态（costBasis/currentNav）与股票同一行文案 ====
Deno.test('止盈参考栏（落袋行）：基金 costBasis/currentNav 同式出「已落袋 + 综合收益率」；股票形态回归不变', () => {
  const flat = (h: string) => h.replace(/<[^>]*>/g, '');
  // 基金：6000 份、每份成本 1.05、现净值 1.20（账面 +14.3%）；4000 份在 1.10 赎回落袋 ¥200；累计买入 10500
  const fund = { id: 'f1', name: '测试基金', shares: 6000, costBasis: 1.05, currentNav: 1.20,
    realizedPnL: 200, cumBuyCost: 10500, profitTiers: [{ ret: 20, sell: 10 }, { ret: 40, sell: 20 }], profitTaken: [] };
  const fundRet = (1.20 - 1.05) / 1.05 * 100;
  const fundHtml = profitRefHtml(null, { ret: 20, sell: 10 }, fundRet, null, fund as never);
  const fundTxt = flat(fundHtml);
  assertMatch(fundTxt, /已落袋 ¥200/, '基金也要出落袋行：' + fundTxt);
  assertMatch(fundTxt, /综合收益率 \+10\.5%/, '(200+900)/10500 = 10.476%：' + fundTxt);
  assertMatch(fundTxt, /账面浮盈率为档位依据/, '档位依据的口径声明两腿都要有：' + fundTxt);
  // 股票形态回归：字段名不同、数学同式
  const stock = { id: 't1', name: '测试股', shares: 600, cost: 30, currentPrice: 36,
    realizedPnL: 2400, cumBuyCost: 30000, profitTiers: [{ ret: 20, sell: 10 }, { ret: 40, sell: 20 }], profitTaken: [] };
  const stockRet = (36 - 30) / 30 * 100;
  const stockTxt = flat(profitRefHtml(null, { ret: 40, sell: 20 }, stockRet, null, stock as never));
  assertMatch(stockTxt, /已落袋 ¥2,400/);
  assertMatch(stockTxt, /综合收益率 \+20\.0%/, '(2400+3600)/30000 = 20%：' + stockTxt);
});

Deno.test('买入参考栏：档位与白话明细都进栏，明细要转义；未传入的提示/横幅不得凭空出现', () => {
  const ref = { label: '双倍', text: '现价较均线 -16.0%；52 周回撤 38.0%，回撤较深；已跌穿成本安全垫' };
  const s = { currentPrice: '12.34', ma60: 14.0, ma120: 15.0 };
  const gate = { light: true, needPad: false, shout: true };
  const one = buyRefHtml(ref, 'pill-double', s, -16, gate, null, null, '', null, '', '');
  assertMatch(one, /<span class="signal-pill pill-double">买入参考·双倍<\/span>/);
  assertEquals(one.includes(ref.text), true, '白话明细整句要渲染进栏：' + one.replace(/<[^>]+>/g, ' '));
  assertEquals(one.includes('现价 12.34 · MA60 14.00 · MA120 15.00'), true, '均线事实行要如实报数');
  assertEquals(one.includes('🟢'), false, '横幅未传入时栏内不得凭空出现买入标志');
  assertEquals(one.includes('未设目标跌幅安全垫'), false, '补填提示未传入时不得凭空出现');
  // 明细来自纯函数，但内容可能含 < >（脏数据/负号写法），必须转义后再进 HTML
  const dirty = buyRefHtml({ label: '正常', text: '回撤 <b>38%</b> & 未达档' }, 'pill-normal',
    { currentPrice: '1' }, null, { light: false, needPad: false, shout: false }, null, null, '', null, '', '');
  assertEquals(dirty.includes('<b>38%</b>'), false, '明细里的标签必须被转义，不能当成 HTML');
  assertEquals(dirty.includes('&lt;b&gt;38%&lt;/b&gt;'), true);
});

// ==== 2026-11-02 裁定 B：短板票只数质地三维，安全边际只作事实展示 ====
// 依据 #80 分布：`margin_of_safety ≤ 0` 占非否决样本 80.9%，它作为一票时几乎人人背票，
// 「均无短板」变成稀缺荣誉、warn 配色失去区分度。裁定只撤它这一票，四维雷达格照旧如实报正/负，
// 40/70 与 8% 门槛、`>2` 才转 warn 的判据一字不动。
Deno.test('价值评估栏（裁定 B）：安全边际为负不记短板票，但雷达格必须照实显示负值', () => {
  const r = { code: '600003', name: '仅安全边际为负', tier: 'qualified', vetoed: false, veto_reasons: [],
    ths_l2: '工程机械', roic_med: 12.0, v_moat: 60, v_health: 60, margin_of_safety: -1.2 };
  const txt = valueAssessmentHtml(r, vaIndHigher, true).replace(/<[^>]*>/g, '');
  assertEquals(txt.includes('安全边际偏弱'), false, '裁定 B：mos 不再参与短板计数：' + txt);
  assertMatch(txt, /负 -1\.2pp/, '雷达格仍要如实报出安全边际为负：' + txt);
  assertEquals(txt.includes('四维均无短板'), false, 'mos 明明是负数，再写「四维均无短板」就是假话：' + txt);
  assertMatch(txt, /质地三维无短板/, '无票时只说被计票的质地三维：' + txt);
});

Deno.test('价值评估栏（裁定 B）：warn 配色要质地三维全弱；两弱普通色，且句子只列被计票的维', () => {
  const two = valueAssessmentHtml({ code: '600004', name: '两弱', tier: 'qualified', vetoed: false, veto_reasons: [],
    ths_l2: '工程机械', roic_med: 3.0, v_moat: 20, v_health: 60, margin_of_safety: -3 }, vaIndHigher, true);
  assertEquals(two.includes('verdict-warn'), false, '两票仍普通色（`>2` 判据不动）：' + two.replace(/<[^>]*>/g, ' '));
  assertMatch(two.replace(/<[^>]*>/g, ''), /护城河、资本回报偏弱/, '短板句只列质地两维，不得把 mos 混进来：' + two);

  const three = valueAssessmentHtml({ code: '600005', name: '三弱', tier: 'qualified', vetoed: false, veto_reasons: [],
    ths_l2: '工程机械', roic_med: 3.0, v_moat: 20, v_health: 20, margin_of_safety: -3 }, vaIndHigher, true);
  assertMatch(three.replace(/<[^>]*>/g, ''), /护城河、资本回报、财务稳健偏弱/);
  assertEquals(three.includes('verdict-warn'), true, '三票全弱必须转 warn（>2 的分界就是三）：' + three.replace(/<[^>]*>/g, ' '));
});

Deno.test('价值评估栏（裁定 B）：安全边际为正时与为负时同句，不因 mos 换措辞', () => {
  const one = (mos: number) => valueAssessmentHtml({ code: '600006', name: '对照', tier: 'qualified', vetoed: false,
    veto_reasons: [], ths_l2: '工程机械', roic_med: 12.0, v_moat: 60, v_health: 60, margin_of_safety: mos }, vaIndHigher, true);
  assertEquals(one(4.2).replace(/<[^>]*>/g, '').includes('质地三维无短板'), true);
  assertEquals(one(-4.2).replace(/<[^>]*>/g, '').includes('质地三维无短板'), true,
    'mos 只影响雷达格，不影响 verdict 句子');
  assertEquals(one(4.2) === one(-4.2), false, '雷达格里的正/负必须不同，别让断言变成同义反复');
});

// ==== 2026-11-02 裁定③：金融股确实没有资本回报数据时，暂按 ROE 口径对标 ====
// 引擎侧早就这么判否决4（value_engine.ts:61-62 把 med/cur 两条腿都换成 ROE），但那个数只在运行时存在、
// 从不落库，页面只能写「无数据」——现在有 extras.fin_roe 后仍写「无数据」就是假话。
// 旧批次没有该键（现网 2026-11-01 即是），所以两种形态必须分别有断言。
const finRow = (roe: number | null, over: Record<string, unknown> = {}) => ({
  code: '600001', name: '样本银行', tier: 'qualified', vetoed: false, veto_reasons: [],
  ths_l2: '银行', roic_med: null, v_moat: 60, v_health: 60, margin_of_safety: 4.0,
  extras: roe === null ? {} : { fin_roe: roe }, ...over,
} as never);
const flat = (h: string) => h.replace(/<[^>]*>/g, '');

Deno.test('价值评估栏（ROE 对标）：金融股拿到 extras.fin_roe 时，资本回报格按 ROE 报数并标明口径', () => {
  const txt = flat(valueAssessmentHtml(finRow(12.3), null, true));
  assertMatch(txt, /达标 · 12\.30%（ROE 口径对标）/, 'ROE 数字要看得见、口径要标得清：' + txt);
  assertEquals(txt.includes('无数据'), false, '有 ROE 却写「无数据」是假话：' + txt);
  assertMatch(txt, /质地三维无短板/, '12.3% ≥ 8% 门槛 ⇒ 资本回报不记短板票：' + txt);
});

Deno.test('价值评估栏（ROE 对标）：低于门槛的金融股 ROE 照记一票短板，与非金融股同权', () => {
  const txt = flat(valueAssessmentHtml(finRow(5.2), null, true));
  assertMatch(txt, /未达标 · 5\.20%（ROE 口径对标）/);
  assertMatch(txt, /资本回报偏弱/, 'ROE 5.2% < 8% 必须进短板清单（否决4 用的是同一个对标口径）：' + txt);
});

Deno.test('价值评估栏（ROE 对标）：被否决的金融股要说清 ROE 对标值，不再退回「无数据」', () => {
  const txt = flat(valueAssessmentHtml(finRow(5.2, { tier: 'vetoed', vetoed: true, veto_reasons: ['无护城河证据'] }), null, true));
  assertMatch(txt, /ROE 口径对标 5\.20%/, '否决句里要带对标值：' + txt);
  assertEquals(txt.includes('未覆盖资本成本'), true, '没过 8% 门槛要说出来：' + txt);
  assertEquals(txt.includes('无数据'), false, '明明有 ROE，写「无数据」是假话：' + txt);
});

Deno.test('价值评估栏（ROE 对标·兼容护栏）：旧批次没有 extras.fin_roe 时退回原句，不冒充数值', () => {
  // 这条在改动前就是绿的，它是**护栏**而不是 RED：防止新加的 ROE 分支把「缺数」形态也念成有数。
  const out = valueAssessmentHtml(finRow(null, { tier: 'vetoed', vetoed: true, veto_reasons: ['无护城河证据'] }), null, true);
  assertMatch(flat(out), /资本回报维度无数据（金融股按 ROE 口径对标）/, '缺数就说缺数（现网 2026-11-01 批次就是这形态）');
  assertEquals(/NaN|null%|undefined/.test(flat(out)), false, '缺键不许冒数值：' + flat(out));
});

Deno.test('价值评估栏（ROE 对标）：ROE 已过门槛的被否决金融股，不得退回「无数据」', () => {
  // 变异检验补漏：把「无数据」分支的判空从 retVal 改回 roic 时，现网会冒出这条假话
  // ——金融股 roic_med 恒为 null，但 extras.fin_roe 有值且已达标，句子却说维度无数据。
  const txt = flat(valueAssessmentHtml(finRow(12.3, { tier: 'vetoed', vetoed: true, veto_reasons: ['无护城河证据'] }), null, true));
  assertEquals(txt.includes('无数据'), false, 'ROE 12.3% 达标却说无数据是假话：' + txt);
  assertMatch(txt, /未见可识别护城河/, '否决原因只剩护城河时要说护城河：' + txt);
});

Deno.test('价值评估栏（ROE 对标）：ROE 数字不得与 ROIC 同业中位并排（量纲不同源，会造出假比较）', () => {
  const txt = flat(valueAssessmentHtml(finRow(12.3), { 银行: { med: 8.5, n: 24 } }, true));
  assertEquals(txt.includes('同行业中位'), false, '同业中位取的是 roic_med，跟 ROE 不是一个口径，不能并排写：' + txt);
});

// ==== 2026-11-02 裁定：走势第二把尺 C 档（R4「末段向上且末值≥5%」），落点=页面标签层 ====
// 分布依据（台账续四十三，2026-11-01 批次 5028 行实测）：
//   · 豁免作用域只有「仅无护城河证据」1754 行；含质地硬伤的否决一律不碰（R1 会连带放掉 104 行）。
//   · 这 1754 行的 roic_med 非空值最大 7.9987 < 8 ⇒ 豁免后仍过不了门禁，落点 vetoed→不合格，合格池零变化。
//   · 金融股（roic_med NULL）三点齐全 0 行 ⇒ 走势尺对金融股整片不可用，必须显式排除而不是让它误命中。
const moatRow = (vals: Array<number | null> | null, over: Record<string, unknown> = {}) => ({
  code: '002852', name: '道道全', ths_l2: '农产品加工', tier: 'vetoed', vetoed: true,
  veto_reasons: ['无护城河证据'], roic_med: 4.08, roic_cur: 7.96, roic_min3: 5.09,
  v_moat: 55, v_cash: 60, v_safety: 40, v_health: 60, margin_of_safety: -1.2,
  owner_yield: 0.6, cn10y: 1.85, rf_fallback: false,
  extras: vals ? { roic_hist: { years: ['2023', '2024', '2025'], values: vals } } : {},
  ...over,
} as never);
const IND = { 农产品加工: { med: 6.1, n: 12 } };

Deno.test('走势豁免（C 档）：末段向上且末值≥5% ⇒ 命中，并交出年份与原值供文案引用', () => {
  const hit = valueTrendExempt(moatRow([5.09, 6.44, 7.96]));
  assertEquals(!!hit, true, '现网 294 行的主形态，必须命中：' + JSON.stringify(hit));
  assertEquals(hit!.vals, [5.09, 6.44, 7.96], '值要原样给（页面不得自己再算一遍）');
  assertEquals(hit!.years, ['2023', '2024', '2025']);
});

Deno.test('走势豁免（C 档）：末段持平也算向上（判据是 ≥，不是 >）', () => {
  // 变异检验钉边界：改成 v[2] > v[1] 时这条必须翻红
  assertEquals(!!valueTrendExempt(moatRow([4.0, 6.44, 6.44])), true);
});

Deno.test('走势豁免（C 档）：末段向下（倒 V）不豁免', () => {
  assertEquals(valueTrendExempt(moatRow([5.09, 7.96, 6.44])), null, '先涨后跌不是趋势向好');
});

Deno.test('走势豁免（C 档）：末值 4.6% 不豁免——只方向向上、水平仍低的要挡住', () => {
  // 读数依据：R1 的 215 行里有 33 行末值 <3%，含一汽解放 [-2.62,-2.27,-1.21] 这类负值回升
  assertEquals(valueTrendExempt(moatRow([1.2, 3.1, 4.6])), null);
});

Deno.test('走势豁免（C 档）：末值恰好 5.0% 豁免（下限含等号）', () => {
  assertEquals(!!valueTrendExempt(moatRow([1.2, 3.1, 5.0])), true);
});

Deno.test('走势豁免（C 档）：三点不齐一律不豁免（261 行=14.9% 永远吃不到尺子，不许蒙）', () => {
  assertEquals(valueTrendExempt(moatRow([5.09, null, 7.96])), null);
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44])), null);
  assertEquals(valueTrendExempt(moatRow([null, null, null])), null);
});

Deno.test('走势豁免（C 档）：带质地硬伤的行绝不豁免（104 行误放面的守卫）', () => {
  for (const extra of ['烧钱加杠杆', '资不抵债', '商誉/净资产>50%']) {
    const r = moatRow([5.09, 6.44, 7.96], { veto_reasons: ['无护城河证据', extra] });
    assertEquals(valueTrendExempt(r), null, extra + ' 在列时走势不得放行');
  }
});

Deno.test('走势豁免（C 档）：金融股不豁免——roic_med 为空即出局，不看序列长什么样', () => {
  // 金融股的否决4 走 ROE 对标，extras.roic_hist 是 ROIC 序列，两者不同源；且实测这批三点齐全 0 行
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44, 7.96], { roic_med: null })), null);
});

Deno.test('走势豁免（C 档）：非否决行不适用（合格池不因走势重算，门禁原样）', () => {
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44, 7.96], { tier: 'qualified', vetoed: false, veto_reasons: [] })), null);
});

Deno.test('走势豁免（C 档·兼容护栏）：旧批次没有 extras.roic_hist 时返回 null，不抛、不冒充', () => {
  assertEquals(valueTrendExempt(moatRow(null)), null);
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44, 7.96], { extras: null })), null);
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44, 7.96], { extras: { roic_hist: null } })), null);
  assertEquals(valueTrendExempt(moatRow([5.09, 6.44, 7.96], { extras: { roic_hist: { years: ['2023'], values: ['x', 6, 7] } } })), null);
  assertEquals(valueTrendExempt(null), null);
});

Deno.test('走势豁免（C 档）：下限 5% 与门槛 8% 差 3pp，两个数各管各的、不得互相顶替', () => {
  assertEquals(ROIC_TREND_FLOOR_PCT, 5);
  assertEquals(ROIC_GATE_PCT - ROIC_TREND_FLOOR_PCT, 3);
});

Deno.test('价值评估栏（走势豁免）：命中行要报出三年原值与回升事实，并明写仍不合格', () => {
  const txt = flat(valueAssessmentHtml(moatRow([5.09, 6.44, 7.96]), IND, true));
  assertMatch(txt, /近三年 ROIC 2023 5\.09% → 2025 7\.96% 回升/, '走势事实要带年份与原值：' + txt);
  assertMatch(txt, /不再算硬否决，但仍不合格/, '要说清改的是标签、不是门禁：' + txt);
});

Deno.test('价值评估栏（走势豁免）：未命中的否决行文案一字不改（现网 1459 行的形态必须原样）', () => {
  // 这是 pin：现网这批行今天打印的就是下面这句，改动前后逐字相等（含行业比较三分支之一）。
  const clause = '；近三年 ROIC 2023 5.09% → 2025 7.96% 回升，不再算硬否决，但仍不合格';
  const up = flat(valueAssessmentHtml(moatRow([5.09, 6.44, 7.96]), IND, true));
  const down = flat(valueAssessmentHtml(moatRow([7.96, 6.44, 5.09]), IND, true));
  assertEquals(down.includes('回升'), false, '末段向下的行不得被走势句污染：' + down);
  assertEquals(up.replace(clause, ''), down, '豁免只能是追加一句走势事实，原句（含同业比较）一字不许动：' + up);
});

Deno.test('展开明细（走势豁免）：门禁行由「硬否决」改「不合格（近三年回报回升，门槛未过）」，⛔ 撤下', () => {
  const txt = flat(valueGateHtml(moatRow([5.09, 6.44, 7.96]), IND));
  assertEquals(txt.includes('⛔'), false, '豁免行不再亮 ⛔：' + txt);
  assertMatch(txt, /门禁：不合格（近三年回报回升，门槛未过）/, '门禁一词要留着——不豁免门禁：' + txt);
  assertMatch(txt, /不合格：ROIC 未达 8% 资本成本门槛/);
  assertMatch(txt, /本股 ROIC 中位 4\.08% · 当期 7\.96%/, '三条明细行原样保留（本轮只把小数位从一位改两位）：' + txt);
});

Deno.test('展开明细（兼容护栏）：未豁免的行门禁与 ⛔ 句与现网逐字相同', () => {
  const txt = flat(valueGateHtml(moatRow([7.96, 6.44, 5.09]), IND));
  assertMatch(txt, /门禁：硬否决 · ROIC 中位 4\.08% · 安全边际 -1\.20pp（owner yield 0\.6% − 十年国债 1\.85%）/);
  assertMatch(txt, /⛔ 硬否决：ROIC 未达 8% 资本成本门槛/);
  const none = flat(valueGateHtml(moatRow(null), IND));
  assertMatch(none, /⛔ 硬否决：ROIC 未达 8% 资本成本门槛/, '没有 roic_hist 的旧批次保持原形态：' + none);
});

Deno.test('走势豁免不许冒充数值：命中行的资本回报雷达格仍显示「未达标」', () => {
  const txt = flat(valueAssessmentHtml(moatRow([5.09, 6.44, 7.96]), IND, true));
  assertMatch(txt, /未达标 · 4\.08%（同行业中位 6\.10%）/, '走势只改标签，雷达格仍按 8% 门槛判：' + txt);
  assertEquals(/达标 · 4\.1%/.test(txt.replace(/未达标/g, '')), false, '不得冒出「达标」：' + txt);
});

Deno.test('走势豁免（C 档）：只作用于硬否决行——合格行即使带着护城河原因也不参与', () => {
  // 契约测试（变异检验补漏）：撤掉「非否决行不参与」这道守卫时，现网不会出现错行，
  // 但豁免的语义边界就没了——它会开始给一个没被否决的行贴「不再算硬否决」，那是句假话。
  const txt = flat(valueAssessmentHtml(
    moatRow([5.09, 6.44, 7.96], { tier: 'qualified', vetoed: false }), IND, true));
  assertEquals(txt.includes('不再算硬否决'), false, '合格行不得出现「不再算硬否决」：' + txt);
  const raw = moatRow([5.09, 6.44, 7.96], { tier: 'qualified', vetoed: false });
  assertEquals(valueTrendExempt(raw), null, '纯函数同样不得给合格行发豁免');
});

// ==== 2026-11-02 精度收口：资本回报读数统一两位小数 ====
// 取证（现网 2026-11-01 批次 5028 行，经 Pages 反代只读分页取全）：1 位小数会把 <8% 的值念成「8.0%」，
// 与同屏「未达 8% 资本成本门槛」自相矛盾，共 17 行（中位 7 / 当期 6 / 近3年最低 8）；
// 道道全 roic_cur=7.959025 就是其中一例。改两位后只剩 1 行（002489 med=7.998735→8.00%），已单独钉住。
// 本轮只动小数位：8% 门槛、比较式、走势五道判据一字未动。
Deno.test('资本回报读数（两位小数）：7.959% 不得念成「8.0%」——展开明细三项与门禁行同口径', () => {
  const txt = flat(valueGateHtml(moatRow([5.09, 6.44, 7.96], {
    roic_med: 6.444812, roic_cur: 7.959025, roic_min3: 5.085701,
  }), IND));
  assertMatch(txt, /本股 ROIC 中位 6\.44% · 当期 7\.96% · 近3年最低 5\.09%/,
    '展开明细三项统一两位小数：' + txt);
  assertEquals(txt.includes('当期 8.0%'), false, '7.96% 舍成 8.0% 会和同屏「未达 8%」打架：' + txt);
  assertMatch(txt, /· ROIC 中位 6\.44% · 安全边际/, '门禁行走同一口径：' + txt);
});

Deno.test('资本回报读数（两位小数）：雷达格、同业中位、ROE 对标值与展开明细同屏同口径', () => {
  const txt = flat(valueAssessmentHtml(
    moatRow([5.09, 6.44, 7.96], { roic_med: 7.654586 }), { 农产品加工: { med: 6.9027, n: 12 } }, true));
  assertMatch(txt, /未达标 · 7\.65%（同行业中位 6\.90%）/, '雷达格两位小数：' + txt);
  assertMatch(txt, /本股高于同行业中位 6\.90%/, 'verdict 里的同业中位也是同一口径：' + txt);
});

Deno.test('资本回报读数（两位小数）：两张榜单行的「ROIC中位」不得留一位小数口径', () => {
  assertMatch(renderValueTop10({ batch: '2026-11-01', top10: [row] as never[] }), /ROIC中位 18\.00%/);
  assertMatch(renderIncomeList({ batch: '2026-11-01', list: [incRow as never], total: 1 }), /ROIC中位 12\.50%/);
});

Deno.test('资本回报读数（两位小数·残留取证）：7.998735 改两位后仍显示 8.00%，同屏「未达 8%」不得因此被改掉', () => {
  // 现网只剩这一行（002489 浙江永强）。它是舍入的固有残留，不是新 bug：
  // 句子说的仍是「未达 8%」，判据与档位一字未动；把它当假话修掉要动的是舍入方式，不属本轮范围。
  const txt = flat(valueGateHtml(moatRow(null, { roic_med: 7.998735, roic_cur: 7.998735, roic_min3: 0.618947 }), IND));
  assertMatch(txt, /本股 ROIC 中位 8\.00%/);
  assertMatch(txt, /⛔ 硬否决：ROIC 未达 8% 资本成本门槛/, '读数显示 8.00% 也不得改掉「未达 8%」这句判据：' + txt);
});

Deno.test('价值评估栏：口径披露——护城河只看资本回报，不得让「宽」冒充市场份额与行业格局（2026-11-02 裁定 A）', () => {
  const disclosed = '护城河只看近三年资本回报（ROIC），不含市场份额与行业格局';
  for (const out of [
    flat(valueAssessmentHtml(vaVeto, vaIndHigher, true)),
    flat(valueAssessmentHtml({ ...row }, vaIndHigher, true)),
  ]) {
    assertEquals(out.includes(disclosed), true, '本栏四维里「护城河」实际只量资本回报，须当场说清：' + out);
    assertEquals(out.includes('不等于买卖指令'), true, '原有的指令隔离句不得被换掉：' + out);
  }
});

// ── 2026-11-14：港股降维口径价值评估（spec §7）。三行事实 + 两句常驻口径行，不产 tier/门禁/换仓 ──
// 夹具值取自 2026-11-14 GS 实调（spec §2.4）；估值两数逐日漂移，这里钉的是**格式**不是生产验收基准。
const hkTencent = {
  batch_date: '2026-11-14', code: '00700', name: '腾讯控股',
  roic_cur: 15.8625, roic_med: 15.8625, roic_min3: 10.5299,
  div_yield: 0.8848080133555927, div_yield_5y: 0.8381616844832607,
  pe: 13.078457, pb: 4.189377, roic_ok: true,
  extras: { stamps: { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' }, years: ['2023', '2024', '2025'], missing: [] },
};
const hkAlibaba = { ...hkTencent, code: '09988', name: '阿里巴巴-W',
  roic_cur: 10.7987, roic_med: 6.909, roic_min3: 6.4716,
  div_yield: 1.51951171875, div_yield_5y: 1.6028015582280901,
  pe: 21.12736, pb: 2.185361, roic_ok: false };

const HK_NOTE_1 = '港股只报资本回报、股息与估值三项；不评估安全边际，也不与同业比较';
const HK_NOTE_2 = '资本回报以 8% 为参照线，按平台日历年度口径，可能与公司自身财年不完全对齐';

Deno.test('港股逐字：腾讯三行事实 + 两句口径行全文比对（spec §7 输出形态）', () => {
  assertEquals(valueAssessmentHkHtml(hkTencent, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div>'
    + '<div class="value-hk-rows">'
    + '<div class="value-dim"><div class="dim-label">资本回报</div><div class="dim-val ok">达标 · 近三年中位 15.86%（最差年 10.53%）</div></div>'
    + '<div class="value-dim"><div class="dim-label">股息</div><div class="dim-val">0.88%（近五年平均 0.84%）</div></div>'
    + '<div class="value-dim"><div class="dim-label">估值</div><div class="dim-val">PE 13.08 · PB 4.19</div></div>'
    + '</div>'
    + '<div class="value-note">' + HK_NOTE_1 + '</div>'
    + '<div class="value-note">' + HK_NOTE_2 + '</div>'
    + '</div>');
});

Deno.test('港股逐字：阿里未达标（med 6.91 < 8）而 cur 10.80 达标 ⇒ 判定只看 med', () => {
  const h = valueAssessmentHkHtml(hkAlibaba, true);
  assertEquals(h.includes('<div class="dim-val warn">未达标 · 近三年中位 6.91%（最差年 6.47%）</div>'), true);
  assertEquals(h.includes('1.52%（近五年平均 1.60%）'), true);
  assertEquals(h.includes('PE 21.13 · PB 2.19'), true);
  assertEquals(h.includes('10.80'), false, 'cur 不参与判定，也不出现在文案里');
});

Deno.test('港股缺失：med=null ⇒ 资本回报「无数据」，不是「未达标」也不是 NA', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, roic_med: null, roic_min3: null, roic_ok: null }, true);
  assertEquals(h.includes('<div class="dim-val ">无数据</div>'), true);
  assertEquals(h.includes('未达标'), false);
  assertEquals(h.includes('达标 ·'), false);
  assertEquals(h.includes('NA'), false);
});

Deno.test('港股缺失：股息/估值逐项「无数据」，不显示 0、不显示 --', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, div_yield: null, div_yield_5y: null, pe: null, pb: null }, true);
  assertEquals(h.includes('<div class="dim-label">股息</div><div class="dim-val">无数据</div>'), true);
  assertEquals(h.includes('<div class="dim-label">估值</div><div class="dim-val">无数据</div>'), true);
  assertEquals(h.includes('0.00%'), false);
  assertEquals(h.includes('--'), false);
});

Deno.test('港股半缺：只有 PB 有值时逐项披露，不把整行判成无数据', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, pe: null }, true);
  assertEquals(h.includes('PE 无数据 · PB 4.19'), true);
  const h2 = valueAssessmentHkHtml({ ...hkTencent, div_yield_5y: null }, true);
  assertEquals(h2.includes('0.88%'), true);
  assertEquals(h2.includes('近五年平均'), false);
  const h3 = valueAssessmentHkHtml({ ...hkTencent, roic_min3: null }, true);
  assertEquals(h3.includes('达标 · 近三年中位 15.86%'), true);
  assertEquals(h3.includes('最差年'), false);
});

Deno.test('港股负号统一 U+2212：九龙仓真实形态（最差年 −2.036、PE 为负已归 null）', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, code: '00004', name: '九龙仓集团',
    roic_cur: 0.0313, roic_med: 0.0313, roic_min3: -2.036, roic_ok: false,
    div_yield: 1.8399264029438824, div_yield_5y: 1.734822560546205, pe: null, pb: 0.39938 }, true);
  assertEquals(h.includes('未达标 · 近三年中位 0.03%（最差年 −2.04%）'), true);
  assertEquals(h.includes('-2.04'), false, 'ASCII 负号必须替换成 U+2212');
  assertEquals(h.includes('PE 无数据 · PB 0.40'), true);
  assertEquals(hkFmtPct(-2.036, 2), '−2.04%');
  assertEquals(hkFmtNum(-1.5, 2), '−1.50');
});

Deno.test('港股格式化器：缺失回「无数据」（A 股 valueFmtPct 回 NA，口径不同故不复用）', () => {
  assertEquals(hkFmtPct(null), '无数据');
  assertEquals(hkFmtPct(undefined as unknown as null), '无数据');
  assertEquals(hkFmtPct(NaN), '无数据');
  assertEquals(hkFmtNum(null), '无数据');
  assertEquals(hkFmtPct(15.8625, 2), '15.86%');
  assertEquals(hkFmtNum(4.189377, 2), '4.19');
  assertEquals(valueFmtPct(null), 'NA', 'A 股格式化器口径一字未改');
});

Deno.test('港股批次三态：hasBatch=false 整区不出；true 但无行 ⇒ 沿用 A 股「本批次无该股数据（未判定）」句式', () => {
  assertEquals(valueAssessmentHkHtml(null, false), '');
  assertEquals(valueAssessmentHkHtml(undefined, false), '');
  assertEquals(valueAssessmentHkHtml(null, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div><div class="ref-empty">本批次无该股数据（未判定）</div></div>');
  assertEquals(valueAssessmentHkHtml(undefined, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div><div class="ref-empty">本批次无该股数据（未判定）</div></div>');
});

Deno.test('港股不产指令：输出里没有 tier/门禁/同业/换仓字样，也没有 verdict 区', () => {
  const h = valueAssessmentHkHtml(hkTencent, true);
  // 「安全边际」不在禁用词表里：口径行必须明说「不评估安全边际」，禁它会与 spec §7 的常驻行直接冲突。
  // 禁的是**把它当一个维度报出来**，故下面另钉 dim-label 只有三个。
  for (const w of ['合格', '不合格', '硬否决', '同行业', '同业中位', '换仓', 'value-verdict', 'value-radar', '护城河'])
    assertEquals(h.includes(w), false, `港股栏不该出现「${w}」`);
  assertEquals(h.includes('不评估安全边际'), true);
  assertEquals([...h.matchAll(/<div class="dim-label">([^<]*)<\/div>/g)].map(m => m[1]), ['资本回报', '股息', '估值'],
    '只报三个维度；多出「安全边际」这一维就是越界产结论');
});

Deno.test('参照线只在口径行露一次；由 ROIC_GATE_PCT 插值，不得硬编码', async () => {
  const h = valueAssessmentHkHtml(hkTencent, true);
  // 不能数 '8%' 子串：腾讯股息 0.88% 里就含 '8%'，数子串会恒得 2 而假红。
  // 改数「为参照线」这个只可能出现在口径行的短语，并单独核事实行区块里不含参照线。
  assertEquals(h.split('为参照线').length - 1, 1, '参照线只能出现一次');
  const facts = h.slice(h.indexOf('<div class="value-hk-rows">'), h.indexOf('</div><div class="value-note">'));
  assertEquals(facts.includes('参照'), false, '三行事实里不得夹带参照线');
  assertEquals(h.includes(HK_NOTE_2), true);
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes("'<div class=\"value-note\">资本回报以 ' + ROIC_GATE_PCT + '% 为参照线"), true,
    '参照线必须由常量插值，硬编码 8 会与引擎漂移');
});

Deno.test('A 股文案零回归：两句 value-note 与四维标签逐字不变', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('价值评估只回答"值不值"，不等于买卖指令'), true);
  assertEquals(html.includes('护城河只看近三年资本回报（ROIC），不含市场份额与行业格局'), true);
  for (const w of ['护城河', '资本回报', '安全边际', '财务稳健'])
    assertEquals(html.includes('<div class="dim-label">' + w + '</div>'), true);
});

Deno.test('跨层契约：GS 夹具 → 适配器 → 引擎 → 落库行 → 前端 HTML 全链路逐字', async () => {
  Deno.env.set('STOCK_VALUE_HK_DISABLE_SERVE', '1');
  const { mergeHkTables } = await import('../supabase/functions/stock-value-hk/gs_hk.ts');
  const { computeHk } = await import('../supabase/functions/stock-value-hk/hk_engine.ts');
  const { toHkDbRow } = await import('../supabase/functions/stock-value-hk/index.ts');
  const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`../supabase/functions/stock-value-hk/fixtures/${n}`, import.meta.url)));
  const held = new Set(['00700', '09988']);
  const { rows, stamps, years } = mergeHkTables(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), held, new Date('2026-11-14T13:50:00Z'));
  const db = toHkDbRow(computeHk(rows[0]), '2026-11-14', stamps, years);
  // 前端读的列名必须与后端写的列名同源：任一端改名，这条就红
  assertEquals(valueAssessmentHkHtml(db, true), valueAssessmentHkHtml(hkTencent, true));
  const db2 = toHkDbRow(computeHk(rows[1]), '2026-11-14', stamps, years);
  assertEquals(valueAssessmentHkHtml(db2, true), valueAssessmentHkHtml(hkAlibaba, true));
});

Deno.test('接线守卫：港股取数是独立只读 loader，挂进首屏 Promise.all', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('async function loadStockValueHk('), true, '缺港股独立取数');
  assertEquals(/Promise\.all\(\[loadStockScores\(\), loadStockValue\(\), loadIncomeWatch\(\), loadValueIndustryRef\(\), loadStockValueHk\(\)\]\)/.test(html), true,
    '港股 loader 必须挂进首屏 Promise.all，否则渲染时 valueHkState 恒 null');
  const s = html.indexOf('async function loadStockValueHk(');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(body.includes("sb.from('stock_value_hk')"), true, '必须读新表');
  assertEquals(body.includes("sb.from('stock_value')"), false, '不得读 A 股表');
  assertEquals(body.includes('.order('), true, '取最新批次必须显式排序');
  assertEquals(/filter\(c=>\/\^\\d\{5\}\$\/\.test\(c\)\)/.test(body), true, '只取 5 位港股码');
  assertEquals(body.includes('valueHkState = { batch, rows: new Map('), true, '必须落成 Map<code,row>');
});

Deno.test('接线守卫：A 股取数与门禁/换仓调用点一字未改（spec §11）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('${valueGateHtml(vRowForSwap, valueIndRef ? valueIndRef.byL2 : null)}'), true,
    '价值门禁仍只吃 A 股行；港股行天然取不到 ⇒ 返回空，无需额外屏蔽');
  assertEquals(html.includes('const swap = swapSuggest(vRowForSwap, valueRows, heldCodes);'), true);
  assertEquals(html.includes("const orFilter = legFilter(stocks.map(s=>s.code));"), true, 'loadStockValue 的取数范围未改');
  assertEquals(/function legFilter\(codes\)\{[\s\S]*?\/\^\\d\{5,6\}\$\//.test(html), true,
    'legFilter 的 5,6 位形态不改：它放行港股码去查 stock_value，而那张表没有港股行 ⇒ 返回空，无害');
});

Deno.test('港股行天然拿不到 A 股门禁与换仓（无需额外屏蔽，spec §7）', () => {
  assertEquals(valueGateHtml(null), '');
  assertEquals(swapSuggest(null, [], []), null);
  assertEquals(swapSuggest(undefined as unknown as null, [hkTencent as unknown as Record<string, unknown>], ['00700']), null);
});

// ==== 2026-11-15 手机端胶囊消失修复：冷启动竞态（Promise.all 早于 syncOnOpen）====
// 实测链路：登录端冷缓存打开 → boot 的 Promise.all 用空/旧 stocks 跑 → loadStockValueHk 见 0 个 5 位码早退
// → valueHkState 恒 null → 港股价值评估胶囊整块消失（A 股腿同理丢持仓行）；loaders 一次加载只跑一回，再无重试。
Deno.test('接线守卫：syncOnOpen 两条成功路径都必须补跑批量状态加载（冷启动竞态修复）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf('async function syncOnOpen(');
  assertEquals(s >= 0, true, 'syncOnOpen 不存在');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals((body.match(/reloadBatchStatesAfterSync\(\);/g) || []).length, 2,
    '云端胜出与本地推云两条成功路径都要补跑；catch 失败路径不跑（没有新持仓可依），实得：\n' + body);
  // boot 侧必须先记指纹再并行取数：否则补跑判定无从对比
  const is = html.indexOf('function initCloud(');
  assertEquals(is >= 0, true, 'initCloud 不存在');
  const init = html.slice(is, html.indexOf('\n}\n', is));
  assertEquals(/batchStocksKey = stocksKeyOf\(\);\s*\n\s*Promise\.all\(\[loadStockScores/.test(init), true,
    'initCloud 必须在 Promise.all 之前记录持仓指纹');
});

Deno.test('接线守卫：补跑器按「指纹变化 + 状态缺失」挑 loader——热缓存零开销、冷启动全量补齐、空库不无限重试', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf('async function reloadBatchStatesAfterSync(');
  assertEquals(s >= 0, true, 'reloadBatchStatesAfterSync 不存在');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  // 跳过条件必须同时要求数据来源（指纹）与结果（三态齐全）：指纹没变但 boot 取数失败时也要补
  assertEquals(/!keyChanged && valueHkState && scoreState && valueState\) return;/.test(body), true,
    '缺「指纹未变且三态齐全 ⇒ 跳过」——热缓存桌面端会被加无谓请求');
  // 同指纹限频闩：空库/持续失败时 syncOnOpen 会被 focus 每 60s 触发，没有闩就是无限重查
  assertEquals(/!keyChanged && key === batchReloadKey\) return;/.test(body), true, '缺同指纹补跑限频闩');
  // 粒度：三条吃持仓的腿各自带补跑条件
  assertEquals(/!scoreState\) jobs\.push\(loadStockScores\(\)\)/.test(body), true, '评分腿缺补跑条件');
  assertEquals(/!valueState\) jobs\.push\(loadStockValue\(\)\)/.test(body), true, 'A股价值腿缺补跑条件');
  assertEquals(/!valueHkState\) jobs\.push\(loadStockValueHk\(\)\)/.test(body), true, '港股腿缺补跑条件');
  assertEquals(body.includes('loadIncomeWatch()'), false, '收益型名单不吃持仓，不得混进补跑名单白打请求');
  assertEquals(body.includes('render();'), true, '补跑完必须重渲染，否则胶囊出来了卡片没刷');
});

// ==== 2026-11-15 之二：SDK 迟到 = 整会话云层静默死亡（本机实测复现一次）====
// initCloud 的 SDK 轮询预算原为 20×500ms=10s：弱网首拉 218KB 自托管 supabase-js 超 10s 即放弃，
// 所有 loader 第一行早退（if(!cloudReady||!sb) return），评分/价值/港股胶囊与云同步全体消失，
// 且 loaders 一次页面加载只跑一回、永不自愈——这正是「手机端刷新多少次都没用」的头号嫌疑形态。
Deno.test('接线守卫：SDK 等待预算 60s（10s 预算在弱网下会把整个云层判死刑）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf('function initCloud(');
  assertEquals(s >= 0, true, 'initCloud 不存在');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(/if\(\(tries\|\|0\) < 120\)/.test(body), true,
    'SDK 等待预算必须是 120×500ms=60s（弱网首拉 218KB 自托管 SDK 常超 10s）');
});

Deno.test('接线守卫：SDK 迟到自愈钩子——loadAll 只挂一次 focus 监听，SDK 已就绪而云层未起时重启 initCloud', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const s = html.indexOf('async function loadAll(');
  assertEquals(s >= 0, true, 'loadAll 不存在');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(body.includes('cloudRecoveryHooked'), true, '缺只挂一次的闩——重复挂监听会让 initCloud 重复跑、auth 重复订阅');
  assertEquals(/!cloudReady && window\.supabase && window\.supabase\.createClient\) initCloud\(\)/.test(body), true,
    '自愈条件必须齐全：云层未起且 SDK 真就绪才重启');
});

// ==== 2026-11-16 落袋记账接线守卫：基金腿全链路 + 邮件概览同口径 ====
Deno.test('接线守卫：基金落袋记账全链路——表单块、按钮绑定、事件函数走适配器、迁移接线、成本下调守卫', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  // ① 两腿表单都有持仓变动块（股票 data-sk / 基金 data-k，同款文案前缀）
  assertEquals((html.match(/持仓变动（卖出 \/ 加仓请登记/g) || []).length, 2, '股票与基金表单各一块');
  // ② 基金绑定走 recordFundPositionEvent（加仓/卖出成对）
  assertEquals(/recordFundPositionEvent\(id,'add'\)/.test(html), true, 'bindFundBody 缺加仓绑定');
  assertEquals(/recordFundPositionEvent\(id,'sell'\)/.test(html), true, 'bindFundBody 缺卖出绑定');
  // ③ 基金事件必须走 costBasis 适配器，不得旁路核心事件机
  assertEquals(/const r = applyFundPositionEvent\(f, \{t:type, qty, price, ts:Date\.now\(\)\}\)/.test(html), true,
    'recordFundPositionEvent 必须复用 applyFundPositionEvent（成本重算/落袋语义只此一处）');
  // ④ 迁移接线：migrateFunds 内幂等补齐（云端与本地两条路径都过 migrateFunds）
  assertEquals(/Object\.assign\(f, migrateFundPosition\(f\)\)/.test(html), true,
    'migrateFunds 必须接入 migrateFundPosition，否则云端拉下的旧记录缺落袋字段');
  // ⑤ 基金成本下调守卫与股票同款（confirm + 表单引导语）
  assertEquals(html.includes('部分赎回请用「登记卖出」，不要改小每份成本'), true, '基金成本下调必须弹确认并引导走登记卖出');
  assertEquals((html.match(/每份成本不变/g) || []).length >= 1, true, '基金注记/提示要说明「每份成本不变」');
  // ⑥ 三率/落袋行字段归一：profitRefHtml 认得基金字段
  assertEquals(/Number\(s\.currentPrice \?\? s\.currentNav\)/.test(html), true, '落袋行的现价读取必须归一（基金 currentNav）');
  assertEquals(/Number\(s\.cost \?\? s\.costBasis\)/.test(html), true, '落袋行的成本读取必须归一（基金 costBasis）');
});

Deno.test('接线守卫：邮件持仓概览同口径——分子含已落袋、分母=累计买入成本、标签转总盈、未迁移回落旧口径', async () => {
  const email = await Deno.readTextFile(new URL('../supabase/functions/daily-update/index.ts', import.meta.url));
  assertEquals(email.includes('ag.mv - ag.cost + realized'), true, '分子必须含已落袋：' + 'mv−cost+realized');
  assertEquals(/base > 0 \? base : ag\.cost/.test(email), true, '分母=累计买入成本，未迁移行回落持仓成本');
  assertEquals(email.includes("'已落袋 '"), true, '落袋金额必须单列披露');
  assertEquals(email.includes("'总盈 +'"), true, '含落袋后标签转「总盈」');
  assertEquals(email.includes("'浮盈 +'"), true, '无落袋时保持「浮盈」旧标签（老用户零观感变化）');
  // 两腿累加点都要记 realized/base
  assertEquals((email.match(/ag\.realized = \(ag\.realized \|\| 0\) \+ \(Number\(/g) || []).length, 2, '基金腿与股票腿各一处');
  assertEquals((email.match(/ag\.base = \(ag\.base \|\| 0\) \+ /g) || []).length, 2, '基金腿与股票腿各一处');
});
