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
