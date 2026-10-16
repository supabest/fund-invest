// supabase/functions/stock-value/gs_value_test.ts
import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { annualCols, assertCols, assertPeriod, mergeValueTables, buildVQ3, yearAnchors, windowCols, type GsTable } from './gs_value.ts';
import { roicStats, vetoesOf } from './value_engine.ts';

// std@0.224.0 的 assertThrows 第二参数只接受 string / ErrorClass，**无 RegExp 重载**：写
// `assertThrows(fn, /re/)` 会撞 TS2769 使整个测试文件跑不起来，而且运行时静默忽略消息匹配
// （守卫测试当场退化成“只要求抛错”的空断言）。取错文再 assertMatch，仓内先例：stock-score/sina_test.ts:46。
const thrownMessage = (fn: () => unknown): string => (assertThrows(fn) as Error).message;

const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url))) as GsTable;
const NOW = new Date('2026-10-11T13:30:00Z');   // 合成时钟：annualBase=2025，测试不随挂钟腐烂
const merge = (t5: GsTable | null = fx('vq5_legacy_sample.json'), t3: GsTable = fx('vq3_sample.json')) =>
  mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), t3, fx('vq4_sample.json'), t5, NOW);
const mergeReal = () => mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'),
  fx('vq4_sample.json'), fx('vq5_sample.json'), NOW);

Deno.test('V_Q3 措辞只由 annualBase 拼装，绝不硬编码年份', () => {
  assertEquals(yearAnchors(new Date('2026-03-01')).annualBase, 2024);   // 1-4 月年报未披露完，只能锚前年
  assertEquals(yearAnchors(new Date('2026-05-01')).annualBase, 2025);
  assertEquals(buildVQ3(2025), '全部沪深A股的2023年报投入资本回报率、2024年报投入资本回报率、2025年报投入资本回报率、股票简称');
});

Deno.test('P-3 守卫：请求了估值列但响应整列缺失 → 抛错（绝不静默 NA 跑完整夜）', () => {
  assertMatch(thrownMessage(() => assertCols({ '股票代码': ['1'], '市净率[20260930]': ['1'] } as GsTable, 'q4')), /missing column: 市盈率/);
  assertCols({ '股票代码': ['1'], '股票简称': ['x'], '市盈率[20260930]': ['1'], '市净率[20260930]': ['1'], '总市值[20260930]': ['1'] } as GsTable, 'q4');
});

Deno.test('P-4 守卫：同批绝对值列日期戳不一致 → 抛错；一致则返回该戳', () => {
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20251231]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW)), /period mismatch/);
  assertEquals(assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20260630]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), '20260630');
});

Deno.test('P-4 守卫：日期戳漂到非合法报告期（混提历史窗口的典型症状）→ 抛错', () => {
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20240630]': ['1'] } as GsTable, ['货币资金'], NOW)),
    /not in allowed window/);   // 中报只可能是 base+1=2026 年，20240630 非法
});

Deno.test('科学计数法与千分位字符串不得被当成空值（探针第 5 轮误判成因）', () => {
  const rows = merge().rows;
  assertEquals(rows[0].fcff, 5400171000000);     // '5.400171E12'
  assertEquals(rows[1].debt, 123456789);         // '123,456,789'
});

Deno.test('股息率批次成功而该行空 = 从不分红 → 0；整批缺席 → NA（两种空值不可互换）', () => {
  assertEquals(merge().rows.find(r => r.code === '000001.SZ')!.divYield, 0);
  assertEquals(merge(null).rows.find(r => r.code === '000001.SZ')!.divYield, null);
  assertEquals(merge(null).rows.find(r => r.code === '000001.SZ')!.divY5y, null);
  // 第三种空语义：该批成功、但表里没有这一行（GS 分页漏行/停牌）≠ 从不分红，必须 NA 而不是 0。
  // 原写法 `at(t5, K.dy, j5) ?? 0` 把 j5<0（行缺席）与 j5≥0 且值为空 折叠成同一个 0。
  const noRow = { '股票代码': ['999999.SZ'], '股息率[20251231]': ['1.0'], '股息率平均[20211231-20251231]': ['1.0'],
    '净资产收益率roe(摊薄)[20260630]': ['1.0'] } as GsTable;   // 补齐 Task 5 新增的 REQUIRED.q5 必需列（仅表形态，期望值一字未动）
  assertEquals(merge(noRow).rows.find(r => r.code === '000001.SZ')!.divYield, null);
  assertEquals(merge(noRow).rows.find(r => r.code === '000001.SZ')!.divY5y, null);
});

Deno.test('三年 ROIC 窗口列数≠3 → 整批抛错（宁拒绝不错位；P-2 齐备率 63% 是"行为空"不是"列数变"）', () => {
  const bad = { ...fx('vq3_sample.json') } as GsTable;
  delete bad['投入资本回报率[20231231]'];
  assertMatch(thrownMessage(() => merge(undefined, bad)), /exactly 3 window columns/);
});

Deno.test('兄弟列键序不得决定绑定（V1.1 gs.ts:211-212 实炸过的同类坑：净资产收益率 命中加权版）', () => {
  // vq5 fixture 故意把 `股息率平均[...]` 排在 `股息率[...]` 之前——真响应快照的键序明显非字典序，
  // 裸 find(startsWith) 会把当期股息率绑成五年平均（3.2 → 2.8），且 REQUIRED.q5 的 '股息率'
  // 会被兄弟列单独满足 → 当期股息率整列缺失也能过 P-3 守卫、静默跑完整夜。
  const ks = Object.keys(fx('vq5_legacy_sample.json'));
  assertEquals(ks.indexOf('股息率平均[20211231-20251231]') < ks.indexOf('股息率[20251231]'), true);   // 自检：兄弟列确实排在目标列之前
  const rows = merge().rows;
  assertEquals(rows[0].divYield, 3.2);
  assertEquals(rows[0].divY5y, 2.8);
  assertMatch(thrownMessage(() => assertCols(
    { '股票代码': ['1'], '股息率平均[20211231-20251231]': ['1'] } as GsTable, 'q5')), /missing column: 股息率/);
});

Deno.test('三年 ROIC 还须是三根年报列（1231）且年份恰为 base−2/base−1/base——混戳即整批拒绝', () => {
  // 「恰好 3 根」不保证是年度列：{20231231, 20241231, 20260630} 计数也是 3，
  // roic3[2] 会装一期中报值冒充年报，相对 V1.1（另叠加 anchorsOk 新鲜度守卫）是弱化。
  const mixed = { ...fx('vq3_sample.json') } as GsTable;
  delete mixed['投入资本回报率[20231231]'];
  mixed['投入资本回报率[20260630]'] = ['1.0', '2.0', '3.0'];
  assertMatch(thrownMessage(() => merge(undefined, mixed)), /expected 3 annual columns/);
});

Deno.test('一季报戳 0331 必须放行（5 月中至 8 月底 GS 只回 [yyyy0331]，拒它 = 全年约 1/3 的夜晚炸批零产出）', () => {
  assertEquals(assertPeriod({ '股票代码': ['1'], '货币资金[20260331]': ['1'], '带息债务[20260331]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), '20260331');
  // 放行不等于放弃校验：非法报告期（非 0331/0630/0930/1231）仍须炸批。
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20260501]': ['1'] } as GsTable, ['货币资金'], NOW)),
    /not in allowed window/);
});

Deno.test('V_Q5 含金融股 ROE 对标列（spec §4 否决4 附注）：族里只有中报列或批次缺席时均为 null（取值分支见下一条）', () => {
  // 终审 I-4：legacy fixture 的 ROE 列**只有** `[20260630]`（中报累计）。加 1231 守卫后它必须被剔出列族 → null。
  // 原断言 12.4 把「中报冒充年报」锁成了不可回归的正确行为，此处是改正，不是回归。
  assertEquals(merge().rows[2].roe, null);
  assertEquals(merge(null).rows[2].roe, null);          // 批次缺席 → NA（否决4 不判定，不是归 0）
});

Deno.test('q5 列族锤 1231（终审 I-4）：[yyyy0630] 与 [yyyy1231] 并存时取 1231 那根，stamps.roe_period 以 1231 结尾', () => {
  // 非改动 vq5_sample.json 真响应快照，只照 fixtures/ 既有形态搭最小 inline 对象：
  // 若无 1231 守卫，最新一根会被绑成 20260630 的中报累计值（非年化）→ 否决4 拿它和年化阈值比就是错判定。
  const t5 = {
    '股票代码': ['600031.SH', '000001.SZ', '600036.SH'],
    '股息率[20260630]': ['1.1', '2.2', '3.3'], '股息率[20251231]': ['4.4', '5.5', '6.6'],
    '净资产收益率roe(摊薄)[20260630]': ['4.5', '7.0', '9.9'],
    '净资产收益率roe(摊薄)[20251231]': ['9.0', '11.0', '12.5'],
  } as GsTable;
  const out = mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'), fx('vq4_sample.json'), t5, NOW);
  assertEquals(out.stamps.roe_period.endsWith('1231'), true);
  assertEquals(out.stamps.roe_period, '20251231');
  assertEquals(out.stamps.div_period, '20251231');                            // 股息率同受守卫
  assertEquals(out.rows.find(r => r.code === '600036.SH')!.roe, 12.5);        // 取 1231 那根（旧绑定会拿 0630 的 9.9）
});

Deno.test('V_Q5 真形态整批不炸（REQUIRED.q5 必须绑得住 `roe(摊薄,公布值)`）', () => {
  // 真响应的 ROE 标签是 `净资产收益率roe(摊薄,公布值)`：守卫前缀若带右括号，merge 直接抛 GS q5 missing column
  assertEquals(mergeReal().rows.length, 3);
});

Deno.test('股息率/ROE 绑最新年报，不是字典序最小的最旧一期', () => {
  const r = mergeReal().rows.find(x => x.code === '600031.SH')!;
  assertEquals(r.divYield, 2.318977);      // 2025 年报；旧绑定给 2021 年的 1.97368421
  assertEquals(r.roe, 9.5188);             // 2025 年报；旧绑定给 2021 年的 18.8934
});

Deno.test('GS 不回平均值列时，近5年股息率由五根年报列派生（空=0，戳升序求和）', () => {
  const r = mergeReal().rows.find(x => x.code === '600031.SH')!;
  // 期望值写成与实现同序的左结合表达式，避免浮点加法次序造成不等
  assertEquals(r.divY5y, (1.97368421 + 1.01265823 + 1.597676 + 2.184466 + 2.318977) / 5);
});

Deno.test('否决4 的档位敏感行：平安银行最新年报 ROE 7.7348 < 8（旧绑定 10.29 会漏杀）', () => {
  assertEquals(mergeReal().rows.find(x => x.code === '000001.SZ')!.roe, 7.7348);
});

Deno.test('annualCols：排除平均值列与区间戳列，按戳升序；单列形态同样命中', () => {
  const win = { '股息率(股票获利率)[20241231]': ['4'], '股息率(股票获利率)[20211231]': ['1'],
    '股息率平均[20211231-20251231]': ['2'], '股息率(股票获利率)[20251231]': ['5'], '股票代码': ['1'] } as GsTable;
  assertEquals(annualCols(win, '股息率'), ['股息率(股票获利率)[20211231]', '股息率(股票获利率)[20241231]', '股息率(股票获利率)[20251231]']);
  assertEquals(annualCols(fx('vq5_legacy_sample.json'), '股息率'), ['股息率[20251231]']);   // 单列老形态
  assertEquals(annualCols({ '股息率[20211231-20251231]': ['1'] } as GsTable, '股息率'), []);  // 只有区间戳 → 不入族
});

Deno.test('GS 若恢复专用平均值列则优先采用；stamps 带 q5 期次（spec §8）', () => {
  assertEquals(mergeReal().stamps.div_period, '20251231');
  assertEquals(mergeReal().stamps.roe_period, '20251231');
  assertEquals(merge().stamps.div_period, '20251231');      // legacy 单列形态同样有戳
  // 专用列优先：真响应不回，但形态若改回来，绝不静默改用派生均值
  const t5 = { '股票代码': ['600031.SH'], '股息率平均[20211231-20251231]': ['2.8'],
    '股息率(股票获利率)[20251231]': ['2.318977'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9.5188'] } as GsTable;
  const rows = mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'),
    fx('vq4_sample.json'), t5, NOW).rows;
  assertEquals(rows.find(x => x.code === '600031.SH')!.divY5y, 2.8);
});

Deno.test('annualCols：同戳多别名按标签破平局，与响应插入序无关（Task 6B 评审 Imp-B）', () => {
  const a = { '股票代码': ['1'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9'], '净资产收益率roe(摊薄,扣非)[20251231]': ['7'] } as GsTable;
  const b = { '净资产收益率roe(摊薄,扣非)[20251231]': ['7'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9'], '股票代码': ['1'] } as GsTable;
  assertEquals(annualCols(a, '净资产收益率roe(摊薄'), annualCols(b, '净资产收益率roe(摊薄'));
  assertEquals(annualCols(a, '净资产收益率roe(摊薄')[0], '净资产收益率roe(摊薄,公布值)[20251231]');   // 标签字典序在前
});

Deno.test('REQUIRED.q5：缺 ROE 族→整批炸（就是差点上线的那条静默路径的反面）', () => {
  const t5 = { '股票代码': ['1'], '股息率(股票获利率)[20251231]': ['2'] } as GsTable;
  const m = thrownMessage(() => mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'), fx('vq4_sample.json'), t5, NOW));
  assertMatch(m, /missing column: 净资产收益率roe/);
});

// ===== 2026-10-12 首跑实炸铁证（Task 10 Step 6 第一次 mode=run → 500 `GS period: no dated column found`）=====
// 线上 ROIC 列标签是 `投入资本回报率roic[yyyyMMdd]`（q1 一根、q3 三根皆如此），而 Task 2 的 fixture 按**提问措辞**
// 手抄成裸名 `投入资本回报率[yyyyMMdd]`。于是 assertCols（走 colByPrefix，英文别名属 ASCII 后缀 → 收）放行了，
// 而 assertPeriod / roic3Keys（走 windowCols，硬要求 `名称[` 紧邻）一根都不认 → 整批炸。
// 两个匹配器口径分叉就是这条缺陷的形状：守卫放行、主逻辑失明。修法是把 windowCols 的严格性改成与
// colByPrefix 同一套规则（允许非中文别名），而不是去改提问措辞——GS 回裸名还是回别名不受我们控制。
const aliasify = (t: GsTable): GsTable => Object.fromEntries(Object.entries(t).map(([k, v]) =>
  [k.startsWith('投入资本回报率[') ? k.replace('投入资本回报率[', '投入资本回报率roic[') : k, v])) as GsTable;

Deno.test('windowCols：名称与日期戳之间的英文别名必须进窗口集，中文后缀兄弟列仍须排除', () => {
  const t = {
    '股票代码': ['600031.SH'],
    '投入资本回报率roic[20260630]': ['18.4'],
    '投入资本回报率[20251231]': ['18.9'],
    '投入资本回报率同比增长率[20260630]': ['1.2'],   // 另一个指标，绝不当窗口列（windowCols 存在的理由）
    '投入资本回报率ttm': ['12.0'],                    // 无 8 位数字戳 → 不是窗口列（变异：去掉戳校验时本条红）
  } as GsTable;
  assertEquals(windowCols(t, '投入资本回报率').sort(),
    ['投入资本回报率[20251231]', '投入资本回报率roic[20260630]'].sort());
});

Deno.test('真形态（roic 别名）五表合并：不炸批，当期 ROIC / 三年窗口 / 期次戳全部照绑', () => {
  const { rows, stamps } = mergeValueTables(aliasify(fx('vq1_sample.json')), fx('vq2_sample.json'),
    aliasify(fx('vq3_sample.json')), fx('vq4_sample.json'), fx('vq5_legacy_sample.json'), NOW);
  // 决议 27（2026-10-15 用户裁定「1」）：当期 ROIC 锤到 q3 最近一根**年报**列，期次戳同步改绑。
  // 原断言 [18.4, 6.1, null] / '20260630' 把「中报累计冒充当期」锁成了正确行为，此处是改正，不是回归。
  assertEquals(stamps.roic_period, '20251231');
  assertEquals(rows.map(r => r.roic), [18.9, 6.2, null]);
  assertEquals(rows.map(r => r.roic3), [[17.1, 18.0, 18.9], [7.0, 6.5, 6.2], [null, null, null]]);
});

// ===== 决议 27：当期 ROIC 与 q3/q5 同一先例——锤 1231 年报列 =====
// 【缺陷形状】中报季 GS 的 q1 绝对值列回 `投入资本回报率[yyyy0630]`：**期内累计、非年化**。
// 三条独立铁证（2026-10-15 取证）：① 生产表 5026 行 extras.stamps.roic_period 全部 = 20260630；
// ② 同批内 roic_cur/roic_min3 比值中位数 0.477、75.5% 的行低于自身最差年报；
// ③ 东财逐期序列（潍柴 2025 全年 8.176 / 2024 8.779 …）证明该指标是期内累计口径。
// 而否决4 拿它与**年化**阈值 ROIC_GATE=8 比（value_engine.ts:63）⇒ 中报季 `med<8 && cur<8` 退化成单条件
// `med<8`，本该留在观察里的「单低」被错杀成 tier=vetoed。q3 三年窗（:169）与 q5 ROE（:181-184）早已锤死
// 1231，q1 当期列是不对称的漏项。measured blast radius：2218/5026 = 44.1% 行带「无护城河证据」。
const mergeRoic = (q1Roic: (string | null)[], roic3: (string | null)[]) => {
  const t1 = { ...fx('vq1_sample.json'), '投入资本回报率[20260630]': q1Roic } as GsTable;
  const t3 = {
    ...fx('vq3_sample.json'),
    '投入资本回报率[20231231]': [roic3[0], '7.0', null],
    '投入资本回报率[20241231]': [roic3[1], '6.5', null],
    '投入资本回报率[20251231]': [roic3[2], '6.2', null],
  } as GsTable;
  return mergeValueTables(t1, fx('vq2_sample.json'), t3, fx('vq4_sample.json'), fx('vq5_sample.json'), NOW);
};

Deno.test('中报累计不得冒充当期：med<8 而最近年报≥8 仍是「单低」，不触发否决4（旧绑定 cur=6.5 会错杀）', () => {
  const r = mergeRoic(['6.5', '6.1', null], ['5', '6', '12']).rows.find(x => x.code === '600031.SH')!;
  assertEquals(r.roic, 12);                                    // 绑 q3 最近年报，不是 q1 的 0630 累计 6.5
  assertEquals(roicStats(r.roic3).med, 6);                     // med<8 成立：这一档该叫 unqualified
  assertEquals(vetoesOf(r, roicStats(r.roic3).med).includes('无护城河证据'), false);
});

Deno.test('反向同样成立：q1 中报累计看着达标（≥8）也救不了「最近年报<8」⇒ 双低照旧否决（旧绑定漏杀）', () => {
  const r = mergeRoic(['9.9', '6.1', null], ['12', '6', '5']).rows.find(x => x.code === '600031.SH')!;
  assertEquals(r.roic, 5);
  assertEquals(vetoesOf(r, roicStats(r.roic3).med).includes('无护城河证据'), true);
});

/**
 * 2026-10-16 用户裁定「补兜底（缺失即视为不达标）」**推翻**了本条初版取向（当时写的是
 * 「宁缺一个判定，不做一个错判定」）。推翻依据是实测blast radius：换到年报口径后生产有
 * **411 行** `roic_cur` 由有值变 None，它们在 med 已<8 的前提下从「会判」静默退化成「漏杀」，
 * 与否决3 那条「多杀不是漏杀」的 fail-loudly 取向相反。保留的约束：med 达标时不因缺数据惩罚。
 */
Deno.test('最新年报缺失 → 当期 ROIC = NA → 否决4 **视为不达标**（med<8 时缺失计入，2026-10-16 裁定）', () => {
  const r = mergeRoic(['6.5', '6.1', null], ['6', '7', null]).rows.find(x => x.code === '600031.SH')!;
  assertEquals(r.roic, null);                                  // 缺的正是 roic3 末根（2025 年报）
  assertEquals(roicStats(r.roic3).med, 6.5);                   // 前两期仍算得出 med，但 cur 为 NA
  assertEquals(vetoesOf(r, roicStats(r.roic3).med).includes('无护城河证据'), true);
  // med 达标（≥8）时不得因 cur 缺失而否决——本条把「只在第二条腿缺数据时从严」钉成可测边界
  const ok = mergeRoic(['9.9', '6.1', null], ['12', '13', null]).rows.find(x => x.code === '600031.SH')!;
  assertEquals(vetoesOf(ok, roicStats(ok.roic3).med).includes('无护城河证据'), false);
});

