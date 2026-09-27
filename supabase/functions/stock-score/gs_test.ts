import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { colByPrefix, mergeTables, sortedWindowCols, windowColsByPrefix, yearAnchors, isAnnualBaseFresh, buildQFin, Q_FIN, Q_CASH } from './gs.ts';

// fixture 路径锚定到本测试文件所在目录 → CWD 无关（repo root 与函数目录两种跑法都可）
const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

Deno.test('列名前缀匹配忽略日期戳', () => {
  const t = { '市盈率(pe)[20260924]': [1], '资产负债率[20260630]': [2] } as never as Record<string, never[]>;
  assertEquals(colByPrefix(t, '市盈率(pe)'), '市盈率(pe)[20260924]');
  assertEquals(colByPrefix(t, '净资产收益率'), undefined);
});

Deno.test('mergeTables: ST 判定/金融判定/行业拆分/持仓数值抽取', () => {
  const fin = fx('fin_sample.json');
  const mom = fx('mom_sample.json');
  const stocks = mergeTables(fin, mom, null);
  const wc = stocks.find(s => s.code === '000338.SZ')!;
  assertEquals(wc.ths[0], '汽车'); assertEquals(wc.isST, false); assertEquals(wc.isFin, false);
  assertEquals(Math.round(wc.debt!), 64);
  const nb = stocks.find(s => s.code === '600036.SH')!; // 招商银行
  assertEquals(nb.isFin, true);
});

Deno.test('合并取交集且保留 GS 全码；cash=null → cash 字段缺席', () => {
  const fin = fx('fin_sample.json');
  const stocks = mergeTables(fin, fin, null); // 自合并也应跑通（列缺失→字段 null）
  assertEquals(stocks.every(s => /\.(SZ|SH|BJ)$/.test(s.code)), true);
  assertEquals(stocks.every(s => s.cash === null), true); // R-CASH 优雅降级（C 层风格）
});

// 回归护栏：窗口列接线必须「起始日最早=长窗、最晚=短窗」，硬编码日期或对调长短窗都会在此失败
Deno.test('动量窗口列：60日涨跌幅/20日均价/60日均价/收盘价 归属正确', () => {
  const mom = fx('mom_sample.json');
  assertEquals(sortedWindowCols(mom, '区间涨跌幅').length, 2);
  assertEquals(sortedWindowCols(mom, '区间涨跌幅')[0], '区间涨跌幅:前复权[20260703-20260924]'); // 最早起始日 = 60 日窗
  assertEquals(sortedWindowCols(mom, '区间成交均价')[0], '区间成交均价[20260703-20260924]');
  assertEquals(sortedWindowCols(mom, '区间收盘价').at(-1), '区间收盘价:前复权[20260922-20260924]');
  const wc = mergeTables(fx('fin_sample.json'), mom, null)
    .find(s => s.code === '000338.SZ')!;
  assertEquals(wc.r60, -2.804456396465618); // 长窗，非 -6.26 的 20 日窗
  assertEquals(wc.a60, 27.633539406567618); // 长窗均价
  assertEquals(wc.a20, 26.736584422268546); // 短窗均价
  assertEquals(wc.close, 25.3);
});

// ---- V1.1 扩列 ----

// 跑批撞上年报披露日（本期列本身就是 12月31日）时，mlrDelta 不得用自身作差→ 恒 0
Deno.test('mlrDelta 年报同日自反守卫：无上期年报列时退回 null', () => {
  const fin = {
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20251231]': ['40'], // 只有年报列，且它就是本期
  };
  const mom = { '股票代码': [] as string[] };
  const [s] = mergeTables(fin, mom, null);
  assertEquals(s.mlr, 40); // 本期毛利率照旧接线
  assertEquals(s.mlrDelta, null); // 无「早于本期的年报」→ null（而非 40-40=0）
  assertEquals(s.mlrYoy, null); // 无上年同期列 → null
});

Deno.test('Q_FIN V1.1 措辞：年份由披露季锚点动态推导（不硬编码）/现金独调/无污染措辞', () => {
  // 探针实锤：'销售毛利率同比增长率' 进 Q_FIN 会吞掉销售毛利率/roe(摊薄) 当期列；
  // 现金流指标并入 Q_FIN 会被 GS 误解析成同比增长率列 → 必须留在独立 Q_CASH。
  assertEquals(Q_CASH, '全部沪深A股的经营活动产生的现金流量净额、归属于母公司所有者的净利润、股票简称');
  assertEquals(Q_FIN.includes('经营活动产生的现金流量净额'), false);
  assertEquals(Q_FIN.includes('销售毛利率同比增长率'), false);
  // fix 轮 2：措辞由 buildQFin(annualBase) 动态拼装——下面的拼结构同源断言保证
  // 无任何硬编码年份常量（措辞字符串只在 buildQFin 模板里出现一次）。
  // 拼结构与生产措辞同源：导出 buildQFin，测试不读时钟（但措辞必须由同一 yearAnchors
  // 规则驱动 → 逐字等于 buildQFin(base)，升/降一档锚点都应破裂）
  const now = new Date();
  const Y = now.getFullYear();
  const base = now.getMonth() + 1 >= 5 ? Y - 1 : Y - 2;
  assertEquals(Q_FIN, buildQFin(base));
  assertEquals(Q_FIN === buildQFin(base - 1), false); // 锚点自降一档 → 措辞必不同
  for (const n of [base - 2, base - 1, base]) {
    assertEquals(Q_FIN.includes(`${n}年报净资产收益率`), true, `Q_FIN 缺 ${n}年报净资产收益率`);
  }
  assertEquals(Q_FIN.includes(`${base}年报销售毛利率`), true);
  assertEquals(Q_FIN.includes(`${base}年中报销售毛利率`), true);
  assertEquals(Q_FIN.includes(`${base + 1}年`), false); // 不得出现未来年报措辞
  for (const need of ['销售毛利率', '近3年营业总收入复合增长率', '所属同花顺行业']) {
    assertEquals(Q_FIN.includes(need), true, `Q_FIN 缺少 ${need}`);
  }
});

// fix 轮 2：年份锚点纯函数（合成 Date，测试无时钟）
Deno.test('yearAnchors: 披露月映射——5 月起锚上年，1-4 月锚前年', () => {
  assertEquals(yearAnchors(new Date(2026, 4, 1)).annualBase, 2025); // 5 月：年报已披露完毕
  assertEquals(yearAnchors(new Date(2026, 3, 30)).annualBase, 2024); // 4 月：尚未完备
  assertEquals(yearAnchors(new Date(2026, 0, 15)).annualBase, 2024);
  assertEquals(yearAnchors(new Date(2026, 11, 31)).annualBase, 2025);
  // 当年措辞只能由这一函数驱动（无硬编码常量可供漂移）
  assertEquals(buildQFin(yearAnchors(new Date(2027, 5, 1)).annualBase).includes('2025年报净资产收益率、2026年报净资产收益率'), true);
});

Deno.test('isAnnualBaseFresh: 基期必须恰等于当年合法锚点（拒绝 1.5 年前基期）', () => {
  // 1-4 月：合法锚点 = Y-2（=2024）；锚到尚未披露完毕的 Y-1 也算错
  assertEquals(isAnnualBaseFresh(new Date(2026, 0, 15), 2024), true); // 1 月合法锚点
  assertEquals(isAnnualBaseFresh(new Date(2026, 0, 15), 2023), false); // 更旧 → 拒
  assertEquals(isAnnualBaseFresh(new Date(2026, 0, 15), 2025), false); // 1 月错锚当年未完年报 → 拒
  // 5 月起：合法锚点 = Y-1（=2025）；退回 2024（=「1.5 年前」的年报前沿）→ 拒
  assertEquals(isAnnualBaseFresh(new Date(2026, 8, 1), 2025), true); // 9 月默认锚
  assertEquals(isAnnualBaseFresh(new Date(2026, 8, 1), 2024), false); // 9 月的 1.5 年前基期 → 拒
  assertEquals(isAnnualBaseFresh(new Date(2026, 8, 1), 2023), false); // 硬编码 2023 漂移 → 拒
});

Deno.test('windowColsByPrefix: 严格 名称[ 窗口列匹配，排除增长率先兄弟列', () => {
  const t = {
    '销售毛利率同比增长率[20260630]': [99], '销售毛利率环比增长[20260630]': [98],
    '销售毛利率[20251231]': [1], '销售毛利率[20260630]': [2],
    '归属于母公司所有者的净利润同比增长率[20260630]': [97], '归属于母公司所有者的净利润[20260630]': [3],
  };
  // mlrYoy(同比) 与 mlrDelta(本期-上年年报) 是不同字段——前缀 discipline 保证不互换
  assertEquals(windowColsByPrefix(t, '销售毛利率'), ['销售毛利率[20251231]', '销售毛利率[20260630]']);
  assertEquals(windowColsByPrefix(t, '归属于母公司所有者的净利润'), ['归属于母公司所有者的净利润[20260630]']);
});

Deno.test('V1.1 新列接线（奥来德 688378 硬值，Task 2/4 探针）：cash/mlrYoy/mlrDelta/roe3y/cagr3', () => {
  const fin = fx('fin_sample.json');
  const mom = fx('mom_sample.json');
  const cash = fx('cash_sample.json');
  const ald = mergeTables(fin, mom, cash).find(s => s.code === '688378.SH')!;
  // 现金比值 = 经营现金流净额 / 归母净利（独立第 3 次调用，原始值列）
  assertEquals(ald.cash, 157010826.89 / 175808330.99); // ≈0.893
  // mlrYoy 派生（fix 轮 1 改口径）= 本期 − 上年同期 的百分点差 pp（spec §4.4 / engine
  // 契约），非旧相对 %：(56.2948/45.8472−1)×100=22.79 是 %，56.2948−45.8472=10.4476 才是 pp
  const near = (a: number | null | undefined, b: number, tol = 1e-3) =>
    assertEquals(a !== null && a !== undefined && Math.abs(a - b) <= tol, true, `期望 ${b}±${tol}，实得 ${String(a)}`);
  near(ald.mlrYoy, 10.4476);
  // mlrDelta(R6) = 本期 56.2948 − 2025年报 48.9803（≠ mlrYoy，两字段永不互换）
  assertEquals(Math.round((ald.mlrDelta ?? 0) * 1e4), 73145);
  // roe 当期摊薄值未被 3 年加权列污染；roe3y 按窗口日期升序 [2023,2024,2025]
  assertEquals(ald.roe, 8.3718);
  assertEquals(ald.roe3y, [7.2, 5.15, 4.22]);
  // cagr3 裁定：取最新窗口列 [20251231]（=2022→2025 年报 3 年 CAGR），而非 [20231231]
  assertEquals(ald.cagr3, 7.9299124980327);
  assertEquals(sortedWindowCols(fin, '营业总收入复合年增长率').at(-1), '营业总收入复合年增长率[20251231]');
  // 手工对账：7.93% ⇒ 2022 营收 = 5.77亿(2025年报) ÷ 1.0793³ ≈ 4.59亿（控制器期望≈4.58，
  // 容差 0.02 内；若误接 [20231231]=22.19% 则反推得 3.16亿，断言破裂）
  assertEquals(Math.abs(5.77 / Math.pow(1 + (ald.cagr3 ?? 0) / 100, 3) - 4.58) <= 0.02, true);
  // 当期毛利率本身仍要拿得到（污染守卫的另一半）
  assertEquals(ald.mlr, 56.2948);
});

Deno.test('R-CASHNEG: 归母净利≤0 → cash 比值无意义 → null；行/表缺失 → null', () => {
  const fin = { '股票代码': ['000001.SZ', '000002.SZ', '300001.SZ'], '股票简称': ['A', 'B', 'C'], '股票市场类型': ['x', 'x', 'x'] };
  const mk = (rows: [string, number | null, number | null][]) => ({
    '股票代码': rows.map(r => r[0]),
    '经营活动产生的现金流量净额[20260630]': rows.map(r => r[1]),
    '归属于母公司所有者的净利润[20260630]': rows.map(r => r[2]),
  });
  const mom = { '股票代码': [] as string[] };
  const neg = mergeTables(fin, mom, mk([['000001.SZ', 100, -50], ['000002.SZ', 100, 0]]));
  assertEquals(neg[0].cash, null); // np<0
  assertEquals(neg[1].cash, null); // np=0
  assertEquals(neg[2].cash, null); // 不在 cash 表
  const ok = mergeTables(fin, mom, mk([['000001.SZ', -100, 50], ['000002.SZ', 100, 50]]));
  assertEquals(ok[0].cash, -2); // 负现金流保留为低分（不置 null）
  assertEquals(ok[1].cash, 2);
  assertEquals(ok[2].cash, null);
});

// ---- fix 轮 1 新增 ----

// pp 口径回归：旧相对 % 推导在上年基数为负时会翻符号（金浦钛业案）——
// 本期 +8、上年同期 −4：pp 差 = +12（改善）；相对 % 会算出 -300（误判恶化）
Deno.test('mlrYoy 百分点口径：负基数上年同期仍得正 pp（改善）', () => {
  const fin = {
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20251231]': ['8'], // 本期（年报日）；mlrYoy 基期取同月日的 20241231，非自身
    '销售毛利率[20241231]': ['-4'], // 上年同期：与本期同 mmdd=1231、非自身 → 合法基期；负基数（金浦钛业形态）
    '销售毛利率[20250630]': ['4'], // 中报列不参与（非最大日期，也不是 12月31日基期）
    '销售毛利率[20240630]': ['-10'], // 非本期/非上年同期日，不得被误当基期
  };
  const [s] = mergeTables(fin, { '股票代码': [] as string[] }, null);
  assertEquals(s.mlr, 8);
  assertEquals(s.mlrYoy, 12); // pp，严格相等：8 − (−4)（改善）
  assertEquals(s.mlrDelta, 12); // 收紧后基期=latest.year−1 且 12月31日列（=20241231 的 −4）：8 − (−4)
  assertEquals((8 / -4 - 1) * 100, -300); // 旧口径会得到的错误符号（反面对照，钉死回归点）
});

// pp 口径的另一半：本期非年报日、上年同期为正基数 → 简单作差
Deno.test('mlrYoy 百分点口径：普通同期对（10.45pp）与年报自反守卫', () => {
  const near = (a: number | null | undefined, b: number, tol = 1e-3) =>
    assertEquals(a !== null && a !== undefined && Math.abs(a - b) <= tol, true, `期望 ${b}±${tol}，实得 ${String(a)}`);
  const mom = { '股票代码': [] as string[] };
  const h1 = mergeTables({
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20260630]': ['56.2948'], '销售毛利率[20250630]': ['45.8472'], '销售毛利率[20251231]': ['48.9803'],
  }, mom, null)[0];
  near(h1.mlrYoy, 10.4476); // 56.2948 − 45.8472（pp）
  near(h1.mlrDelta, 7.3145); // 56.2948 − 48.9803（pp，与 mlrYoy 永不互换）
  // 本期即年报日且无上一年年报列：不得用自身作差 → mlrYoy/mlrDelta 均 null（而非 0）
  const ann = mergeTables({
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20251231]': ['40'], // 仅此一根毛利率列，且它就是本期
  }, mom, null)[0];
  assertEquals(ann.mlrYoy, null); // 同月日基期 = 自身 → 守卫拒绝
  assertEquals(ann.mlrDelta, null); // 无上一年年报列 → null（旧版会得 40−40=0 恒 0）
});

// fix 轮 2 守卫：数据里的年报基期与运行时锚点相差 >1 年（含「1.5 年前基期」的
// 陈旧形态）→ B 层派生字段整组置 null（NA 优雅降级），pp 版 mlrYoy 不受管辖
Deno.test('新鲜度守卫：陈旧基期 → mlrDelta/roe3y/cagr3 置 null；mlrYoy 照常', () => {
  const stale = {
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20990630]': ['55'], '销售毛利率[20980630]': ['50'], '销售毛利率[20981231]': ['48'],
    '净资产收益率roe(加权,公布值)[20971231]': ['7'], '净资产收益率roe(加权,公布值)[20981231]': ['8'], '净资产收益率roe(加权,公布值)[20991231]': ['9'],
    '营业总收入复合年增长率[20991231]': ['12.3'],
  };
  const [s] = mergeTables(stale, { '股票代码': [] as string[] }, null);
  assertEquals(s.mlrYoy, 5); // pp：55 − 50，数据自身同期对，不依赖年份锚点
  assertEquals(s.mlrDelta, null); // 数据基期 2098 与运行时锚点差 >1 年 → 守卫
  assertEquals(s.roe3y, undefined);
  assertEquals(s.cagr3, null);
});

// fix 轮 2：mlrDelta 基期收紧——只接受「年份恰为 latest.year−1」的 12月31日列，
// 更早年份的年报不得当基期（旧版会拿 2024 年报配 2026 中报）
Deno.test('mlrDelta 基期收紧：年报年份不够新 → null（而非远旧年报作差）', () => {
  const nearMiss = {
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '销售毛利率[20260630]': ['55'], '销售毛利率[20241231]': ['50'], // 少了 2025 年报列
  };
  const [s] = mergeTables(nearMiss, { '股票代码': [] as string[] }, null);
  assertEquals(s.mlrDelta, null); // 旧版会得 55−50=5（基期隔了 1.5 年）→ 现必须 null
});

// fix 轮 2：roe3y 必须恰好 3 根窗口列，否则整组 null（宁可 NA，不可 2 列错位）
Deno.test('roe3y 列数断言：窗口列不等于 3 根 → null', () => {
  const two = {
    '股票代码': ['000001.SZ'], '股票简称': ['A'], '股票市场类型': ['x'],
    '净资产收益率roe(加权,公布值)[20241231]': ['7'], '净资产收益率roe(加权,公布值)[20251231]': ['8'],
  };
  assertEquals(mergeTables(two, { '股票代码': [] as string[] }, null)[0].roe3y, undefined);
  const four = { ...two, '净资产收益率roe(加权,公布值)[20261231]': ['9'], '净资产收益率roe(加权,公布值)[20231231]': ['6'] };
  assertEquals(mergeTables(four, { '股票代码': [] as string[] }, null)[0].roe3y, undefined);
  // 恰好 3 根且与运行时锚点同步（fixture 实除 2023/24/25）→ 正常数组
  const ald = mergeTables(fx('fin_sample.json'), fx('mom_sample.json'), null).find(s => s.code === '688378.SH')!;
  assertEquals(ald.roe3y, [7.2, 5.15, 4.22]);
});
