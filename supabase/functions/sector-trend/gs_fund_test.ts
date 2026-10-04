// gs_fund_test.ts —— 景气度基本面宽表解析纯函数测试（spec 2026-10-03 §4/§5）。
// 合成宽表的列名用 Step 1 线上探针实测前缀（值带正/负/空以测稳健解析；
// 同花顺行业带 L1-L2-L3 路径）。断言锁的是「前缀命中即解析」的行为，不锁日期后缀。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseFundTable, type GsFundTable } from "./gs_fund.ts";

Deno.test("parseFundTable: 前缀匹配三列 + 同花顺路径拆 L1/L2 + 百分号/负值/空稳健", () => {
  const t: GsFundTable = {
    "股票代码": ["600519", "300750", "000001"],
    "营业总收入(同比增长率)[20260930]": ["12.5%", "-3.2", ""],
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
  assertEquals(Number.isNaN(fundMedian([])), true); // 标题声称的空调用契约，此前无断言承载
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
  assertEquals(m.get("芯片")!.n, 5); // 6 条里剔除 1 条双空 = 5（1 空 kc 仍计入）
  // 字面量而非复用 fundMedian：后者正是被测者，自引用会让「偶数取上中位」这类 off-by-one 双向共谋通过。
  // rev 中位([5,6,7,8,9])=7、kc 中位([7,8,9])=8 → 0.5*7+0.5*8=7.5
  assertEquals(m.get("芯片")!.raw, 7.5);
});

// 2026-10-04 L2 统一：THS_DENY / 子串模糊规则已整段删除（canonical 本身即 L2 ⇒ 恒等命中），
// 原「否决方向性失真配对」的用例随之作废：现下 医疗/金融 等旧剥字名不再命中任何 L2。

Deno.test("toProsperityScale: 跨行业百分位秩（最小≈低、最大≈高、单元素=50）", () => {
  const scale = toProsperityScale(new Map([["a", { raw: 1, n: 6 }], ["b", { raw: 2, n: 6 }], ["c", { raw: 3, n: 6 }]]));
  // 口径同 engine.pctRank：(below + 0.5*ties)/N*100，故三 distinct 值 → 16.67/50/83.33
  assertEquals(scale.get("a")! < scale.get("b")!, true);
  assertEquals(scale.get("b")! < scale.get("c")!, true);
  assertEquals(scale.get("c"), ((2 + 0.5) / 3) * 100); // 最大：below=2,ties=1 → 83.33
  assertEquals(scale.get("a"), ((0 + 0.5) / 3) * 100); // 最小：below=0,ties=1 → 16.67
  assertEquals(toProsperityScale(new Map([["z", { raw: 9, n: 6 }]])).get("z"), 50);
});

// —— Task 3：同花顺 L2 ↔ canonical 归因映射 + buildProsperity 编排（spec 2026-10-03 §6）——
import { mapCanonicalToThs, attachCanonical, buildProsperity } from "./gs_fund.ts";

// 2026-10-04 L2 统一：canonical 本身即同花顺 L2 ⇒ 归因退化为恒等命中，无 curated / 无子串 / 无否决。
Deno.test("mapCanonicalToThs: 恒等命中——canonical 是 L2 且有景气即命中", () => {
  assertEquals(mapCanonicalToThs("半导体", new Set(["半导体"])), "半导体");
  assertEquals(mapCanonicalToThs("证券", new Set(["证券"])), "证券");
});
Deno.test("mapCanonicalToThs: 不再子串/curated 模糊——同名之外一律 null（防误配兄弟 L2）", () => {
  assertEquals(mapCanonicalToThs("医疗", new Set(["医疗器械", "化学制药"])), null); // 旧子串规则会误命中 医疗器械
  assertEquals(mapCanonicalToThs("券商", new Set(["证券"])), null); // 旧 curated 会映射到 证券；统一后 券商 非板块名、不在 L2 刻度集→null
  assertEquals(mapCanonicalToThs("电力", new Set(["电力", "绿色电力"])), "电力"); // 精确优先，即便存在子串兄弟
});
Deno.test("mapCanonicalToThs: 空 / 主题 / 无归属 / L1例外 → null", () => {
  assertEquals(mapCanonicalToThs("", new Set(["半导体"])), null);
  assertEquals(mapCanonicalToThs("科创芯片", new Set(["半导体"])), null);
  assertEquals(mapCanonicalToThs("食品饮料", new Set(["白酒", "饮料制造"])), null); // L1 例外天然不命中 L2 刻度
});

Deno.test("attachCanonical: 命中给 {prosperity,src}，未命中得 null 并进 unmapped 清单", () => {
  const scale = new Map<string, number>([["证券", 80], ["白酒", 40]]);
  const { byInd, unmapped } = attachCanonical(scale, ["证券", "白酒", "科创芯片"]);
  assertEquals(byInd.get("证券"), { prosperity: 80, src: "证券" });
  assertEquals(byInd.get("白酒"), { prosperity: 40, src: "白酒" });
  assertEquals(byInd.get("科创芯片"), { prosperity: null, src: null });
  assertEquals(unmapped.includes("科创芯片"), true);
  assertEquals(unmapped.includes("证券"), false);
});

Deno.test("buildProsperity: 注入的 fetch 抛错 → 不 throw、byInd 全 null、warnings 有记录", async () => {
  const boom = async () => { throw new Error("GS 挂了"); };
  const res = await buildProsperity(boom, "KEY", ["证券"]);
  assertEquals(res.byInd.get("证券"), { prosperity: null, src: null });
  assertEquals(res.warnings.length >= 1, true);
  assertEquals(res.mapped, 0);
});

Deno.test("buildProsperity: 正常链路聚合映射（注入合成宽表）", async () => {
  const fake = async () => ({
    "股票代码": Array.from({ length: 6 }, (_, i) => `c${i}`),
    "营业总收入(同比增长率)[20260930]": [10, 20, 30, 40, 50, 60],
    "归属母公司股东的净利润-扣除非经常损益(同比增长率)[20260930]": [10, 20, 30, 40, 50, 60],
    "所属同花顺行业": Array(6).fill("非银金融-证券-证券"),
  });
  const res = await buildProsperity(fake, "KEY", ["证券"]);
  assertEquals(res.byInd.get("证券")!.src, "证券");
  assertEquals(typeof res.byInd.get("证券")!.prosperity, "number");
});
