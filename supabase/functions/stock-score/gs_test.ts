import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { colByPrefix, mergeTables, sortedWindowCols, windowColsByPrefix, Q_FIN, Q_CASH } from './gs.ts';

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

Deno.test('Q_FIN V1.1 措辞：现金独立调用、不含同比增长率类污染措辞', () => {
  // 探针实锤：'销售毛利率同比增长率' 进 Q_FIN 会吞掉销售毛利率/roe(摊薄) 当期列；
  // 现金流指标并入 Q_FIN 会被 GS 误解析成同比增长率列 → 必须留在独立 Q_CASH。
  assertEquals(Q_CASH, '全部沪深A股的经营活动产生的现金流量净额、归属于母公司所有者的净利润、股票简称');
  assertEquals(Q_FIN.includes('经营活动产生的现金流量净额'), false);
  assertEquals(Q_FIN.includes('销售毛利率同比增长率'), false);
  for (const need of ['销售毛利率', '2023年报净资产收益率', '2024年报净资产收益率',
    '2025年报净资产收益率', '近3年营业总收入复合增长率', '2025年报销售毛利率', '2025年中报销售毛利率']) {
    assertEquals(Q_FIN.includes(need), true, `Q_FIN 缺少 ${need}`);
  }
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
  // mlrYoy 派生 = 本期毛利率/上年同期 − 1，与 GS 同比列逐位一致（探针双验）
  assertEquals(ald.mlrYoy, 22.787869270097193);
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
