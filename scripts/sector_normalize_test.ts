import { assertEquals } from 'https://deno.land/std@0.224.0/testing/asserts.ts';
import { extractInd, normalizeInd } from './sector_normalize.ts';
Deno.test('extractInd: 去ETF后缀与前缀基金公司', () => {
  assertEquals(extractInd('银行ETF南方'), '银行');
  assertEquals(extractInd('机器人ETF鹏华'), '机器人');
  // 实现微调（brief Step 3 注授权）：剥掉 [A-Za-z0-9·-—] 后 '沪深300ETF' → '沪深'（非空，
  // 不触发 `|| s` 回落）。宽基本就不在 class1=1 行业池内，此例只护规则不改合并断言。
  assertEquals(extractInd('华泰柏瑞沪深300ETF'), '沪深');
});
Deno.test('normalizeInd: 已知合并', () => {
  for (const r of ['地产', '房地产', '房产']) assertEquals(normalizeInd(r), '房地产');
  for (const r of ['券商', '证券', '证券保险']) assertEquals(normalizeInd(r), '证券');
  for (const r of ['芯片', '集成电路', '半导体', '科创半导体']) assertEquals(normalizeInd(r), '半导体');
  for (const r of ['半导体设备', '科创半导体设备']) assertEquals(normalizeInd(r), '半导体设备');
  assertEquals(normalizeInd('绿电'), '电力');
  assertEquals(normalizeInd('储能电池'), '电池');
  assertEquals(normalizeInd('消费50'), '消费');
  assertEquals(normalizeInd('酒'), '酒');          // 酒与食品饮料分列（spec §2.2）
  assertEquals(normalizeInd('食品饮料'), '食品饮料');
  assertEquals(normalizeInd('军工龙头'), '军工');
  assertEquals(normalizeInd('信息技术'), '信息技术'); // 未命中映射表 → 原样
});
