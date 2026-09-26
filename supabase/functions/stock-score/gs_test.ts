import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { colByPrefix, mergeTables, sortedWindowCols } from './gs.ts';

Deno.test('列名前缀匹配忽略日期戳', () => {
  const t = { '市盈率(pe)[20260924]': [1], '资产负债率[20260630]': [2] } as never as Record<string, never[]>;
  assertEquals(colByPrefix(t, '市盈率(pe)'), '市盈率(pe)[20260924]');
  assertEquals(colByPrefix(t, '净资产收益率'), undefined);
});

Deno.test('mergeTables: ST 判定/金融判定/行业拆分/持仓数值抽取', () => {
  const fin = JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json'));
  const mom = JSON.parse(Deno.readTextFileSync('fixtures/mom_sample.json'));
  const stocks = mergeTables(fin, mom);
  const wc = stocks.find(s => s.code === '000338.SZ')!;
  assertEquals(wc.ths[0], '汽车'); assertEquals(wc.isST, false); assertEquals(wc.isFin, false);
  assertEquals(Math.round(wc.debt!), 64);
  const nb = stocks.find(s => s.code === '600036.SH')!; // 招商银行
  assertEquals(nb.isFin, true);
});

Deno.test('合并取交集且保留 GS 全码', () => {
  const fin = JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json'));
  const stocks = mergeTables(fin, fin); // 自合并也应跑通（列缺失→字段 null）
  assertEquals(stocks.every(s => /\.(SZ|SH|BJ)$/.test(s.code)), true);
});

// 回归护栏：窗口列接线必须「起始日最早=长窗、最晚=短窗」，硬编码日期或对调长短窗都会在此失败
Deno.test('动量窗口列：60日涨跌幅/20日均价/60日均价/收盘价 归属正确', () => {
  const mom = JSON.parse(Deno.readTextFileSync('fixtures/mom_sample.json'));
  assertEquals(sortedWindowCols(mom, '区间涨跌幅').length, 2);
  assertEquals(sortedWindowCols(mom, '区间涨跌幅')[0], '区间涨跌幅:前复权[20260703-20260924]'); // 最早起始日 = 60 日窗
  assertEquals(sortedWindowCols(mom, '区间成交均价')[0], '区间成交均价[20260703-20260924]');
  assertEquals(sortedWindowCols(mom, '区间收盘价').at(-1), '区间收盘价:前复权[20260922-20260924]');
  const wc = mergeTables(JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json')), mom)
    .find(s => s.code === '000338.SZ')!;
  assertEquals(wc.r60, -2.804456396465618); // 长窗，非 -6.26 的 20 日窗
  assertEquals(wc.a60, 27.633539406567618); // 长窗均价
  assertEquals(wc.a20, 26.736584422268546); // 短窗均价
  assertEquals(wc.close, 25.3);
});
