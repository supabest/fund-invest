// gs_fund_test.ts —— 景气度基本面宽表解析纯函数测试（spec 2026-10-03 §4/§5）。
// 合成宽表的列名用 Step 1 线上探针实测前缀（值带正/负/空以测稳健解析；
// 同花顺行业带 L1-L2-L3 路径）。断言锁的是「前缀命中即解析」的行为，不锁日期后缀。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseFundTable, type GsFundTable } from "./gs_fund.ts";

Deno.test("parseFundTable: 前缀匹配三列 + 同花顺路径拆 L1/L2 + 百分号/负值/空稳健", () => {
  const t: GsFundTable = {
    "股票代码": ["600519", "300750", "000001"],
    "营业总收入(同比增长率)[20260930]": ["12.5", "-3.2", ""],
    "归属母公司股东的净利润-扣除非经常损益(同比增长率)[20260930]": ["8", "15.1", "-40"],
    "所属同花顺行业": ["食品饮料-白酒-白酒", "电力设备-电池-锂电池", "银行-国有大型银行-"],
  };
  const rows = parseFundTable(t);
  assertEquals(rows.length, 3);
  assertEquals(rows[0], { code: "600519", revYoy: 12.5, kcYoy: 8, thsL1: "食品饮料", thsL2: "白酒" });
  assertEquals(rows[1].revYoy, -3.2);
  assertEquals(rows[1].thsL2, "电池");
  assertEquals(rows[2].revYoy, null);   // 空串 → null
  assertEquals(rows[2].kcYoy, -40);     // 负值保留
  assertEquals(rows[2].thsL1, "银行");
});

Deno.test("parseFundTable: 缺整列 → 该行 revYoy/kcYoy 为 null（优雅缺席）", () => {
  const rows = parseFundTable({ "股票代码": ["600000"], "所属同花顺行业": ["银行-股份行-"] });
  assertEquals(rows[0].revYoy, null);
  assertEquals(rows[0].kcYoy, null);
  assertEquals(rows[0].thsL2, "股份行");
});

Deno.test("parseFundTable: 无 股票代码 列 → 空数组（不炸）", () => {
  assertEquals(parseFundTable({ "所属同花顺行业": ["x-y-"] }), []);
});

// —— Task 2：L2 中位数聚合 + 跨行业百分位刻度（spec 2026-10-03 §5）——
import { fundMedian, aggregateByThs, toProsperityScale, type FundRow } from "./gs_fund.ts";

const fr = (revYoy: number | null, kcYoy: number | null, thsL2: string): FundRow =>
  ({ code: "x", revYoy, kcYoy, thsL1: "L1", thsL2 });

Deno.test("fundMedian: 奇数取中、偶数取中间两值均值、空数组→NaN 由调用方兜", () => {
  assertEquals(fundMedian([3, 1, 2]), 2);
  assertEquals(fundMedian([4, 1, 2, 3]), 2.5);
});

Deno.test("aggregateByThs: 中位数抗离群 + raw=0.5/0.5 合成 + 样本<5 不生成", () => {
  const rows: FundRow[] = [
    ...[1, 2, 3, 4, 100].map((v) => fr(v, v, "白酒")),     // rev 中位=3，kc 中位=3，raw=3；含离群 100 不改中位
    fr(10, 10, "证券"), fr(11, 11, "证券"), fr(12, 12, "证券"), // 仅 3 只 < 5 → 不生成
  ];
  const m = aggregateByThs(rows);
  assertEquals(m.has("证券"), false);
  assertEquals(m.get("白酒")!.raw, 3);
  assertEquals(m.get("白酒")!.n, 5);
});

Deno.test("aggregateByThs: rev/kc 一空一非空的记录仍计一个有效样本，双空记录剔除", () => {
  const rows = [fr(5, null, "芯片"), fr(6, null, "芯片"), fr(7, 7, "芯片"), fr(null, null, "芯片"), fr(8, 8, "芯片"), fr(9, 9, "芯片")];
  const m = aggregateByThs(rows);
  assertEquals(m.get("芯片")!.n, 5); // 4 条里剔除 1 条双空 = 5（1 空 kc 计入）
  assertEquals(m.get("芯片")!.raw, 0.5 * fundMedian([5, 6, 7, 8, 9]) + 0.5 * fundMedian([7, 8, 9]));
});

Deno.test("toProsperityScale: 跨行业百分位秩（最小≈低、最大≈高、单元素=50）", () => {
  const scale = toProsperityScale(new Map([["a", { raw: 1, n: 6 }], ["b", { raw: 2, n: 6 }], ["c", { raw: 3, n: 6 }]]));
  // 口径同 engine.pctRank：(below + 0.5*ties)/N*100，故三 distinct 值 → 16.67/50/83.33
  assertEquals(scale.get("a")! < scale.get("b")!, true);
  assertEquals(scale.get("b")! < scale.get("c")!, true);
  assertEquals(scale.get("c"), ((2 + 0.5) / 3) * 100); // 最大：below=2,ties=1 → 83.33
  assertEquals(scale.get("a"), ((0 + 0.5) / 3) * 100); // 最小：below=0,ties=1 → 16.67
  assertEquals(toProsperityScale(new Map([["z", { raw: 9, n: 6 }]])).get("z"), 50);
});
