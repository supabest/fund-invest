import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  FOOD_L1,
  IND_TO_L2,
  L2_SET,
  L2_TARGETS,
  assertTargets,
  isDropped,
  toL2,
  unmappedCanonical,
} from "./sector_l2_map.ts";

// 生产表 sector_etf_map 在 2026-10-03 迁移后的全部 canonical_ind（冻结快照）。
// 本测试用它是为了「不连库也能钉住覆盖率」：宇宙重建若冒出第 103 个剥字名，
// UNMAPPED 必须显式报警而不是悄悄入池 —— 见 unmappedCanonical 用例。
const UNIVERSE_102 = [
  "中药", "云计算", "互联网", "人工智能", "传媒", "信创", "信息技术", "信息科技", "光伏", "养殖",
  "军工", "农业", "农牧渔", "创业板人工智能", "创业板算力", "创业板软件", "创新药", "化工", "医疗",
  "医疗创新", "医疗器械", "医疗设备", "医药", "半导体", "半导体设备", "卫星", "国防", "基建",
  "大宗商品", "大数据", "央企创新", "央企改革", "央企科技", "央企能源", "家电", "工业有色", "工业母机",
  "工程机械", "建材", "战略新兴", "房地产", "数字经济", "新能源", "新能源车", "旅游", "智能汽车",
  "智能驾驶", "有色", "机器人", "机床", "汽车", "油气", "消费", "消费电子", "游戏", "煤炭", "环保",
  "生物医药", "生物科技", "电信", "电力", "电子", "电池", "电网设备", "畜牧养殖", "疫苗", "石化",
  "石油", "矿业", "碳中和", "科创人工智能", "科创创业人工智能", "科创创新药", "科创医药", "科创新材料",
  "科创芯片", "科创芯片设计", "科技", "稀土", "稀有金属", "粮食", "绿色电力", "能源", "航天",
  "航空航天", "船舶", "计算机", "证券", "资源", "软件", "通信", "通用航空", "酒", "金融", "金融地产",
  "金融科技", "钢铁", "银行", "长江保护", "食品饮料", "高端制造", "黄金股",
];

const kept = Object.entries(IND_TO_L2).filter(([, v]) => v !== null);
const dropped = Object.entries(IND_TO_L2).filter(([, v]) => v === null).map(([k]) => k);
const sectorCount = new Set(kept.map(([, v]) => v)).size;

Deno.test("sector_l2_map: 覆盖宇宙表全部 102 个原板块名，一条不多一条不少", () => {
  assertEquals(UNIVERSE_102.length, 102);
  const keys = Object.keys(IND_TO_L2).sort();
  assertEquals(keys, [...UNIVERSE_102].sort());
});

Deno.test("sector_l2_map: 每个映射目标都是合法同花顺 L2（或唯一批准的 L1 例外）", () => {
  assertEquals(L2_SET.size, 90);
  assertEquals(assertTargets(), []);
  for (const [k, v] of kept) {
    assertEquals(L2_TARGETS.has(v as string), true, `${k} -> ${v} 非法`);
  }
});

Deno.test("sector_l2_map: 统一后 38 个板块、31 组剔除、0 个未命中", () => {
  // 代价（用户已知悉）：102 → 38 个板块。半导体 69 只 / 3535.6 亿，占全榜 31%。
  assertEquals(sectorCount, 38);
  assertEquals(dropped.length, 31);
  assertEquals(unmappedCanonical(UNIVERSE_102), []);
});

// —— 证据驱动的关键纠正，逐条钉住，防回归到"名字剥字"时代的错误归属 ——
Deno.test("sector_l2_map: AI/数字经济 归半导体（前十实测）；信创经改判归软件开发", () => {
  assertEquals(toL2("信创"), "软件开发"); // 华夏562570 中证信创 软件多数派（2026-10 改判，原按 CN5075 芯片指数错配为半导体）
  assertEquals(toL2("数字经济"), "半导体"); // 931582 前十 8/10 半导体设备/芯片
  assertEquals(toL2("科创人工智能"), "半导体"); // 950180 7/10
  assertEquals(toL2("人工智能"), "半导体"); // 930713 行业分布 半导体37.07%
  assertEquals(toL2("软件"), "软件开发"); // 930601 8/10 —— 真软件才进软件
  assertEquals(toL2("金融科技"), "软件开发"); // 930986 6/10
});

Deno.test("sector_l2_map: IT服务 不再作为归属目标（没有任何 ETF 以它为主导）", () => {
  // 计划表曾写「IT服务 ← 云计算/大数据/数字经济/信息技术/信息科技」；实测这五组
  // 前三者 plurality 是 软件开发/半导体，后两者直接剔除。IT服务 一行是凭空造的。
  const targets = new Set(kept.map(([, v]) => v));
  assertEquals(targets.has("IT服务"), false);
  assertEquals(toL2("云计算"), "软件开发");
  assertEquals(toL2("信息技术"), null);
  assertEquals(toL2("信息科技"), null);
});

Deno.test("sector_l2_map: 金融/金融地产 归银行（000045 实测 银行6/证券3/保险1）", () => {
  assertEquals(toL2("金融"), "银行");
  assertEquals(toL2("金融地产"), "银行");
  // 于是 多元金融 失去了唯一成员，不再出现在榜上
  const targets = new Set(kept.map(([, v]) => v));
  assertEquals(targets.has("多元金融"), false);
});

Deno.test("sector_l2_map: 工业母机/机床 归自动化设备，通用设备不再是目标", () => {
  assertEquals(toL2("工业母机"), "自动化设备"); // 931866 自动化设备4 > 通用设备3
  assertEquals(toL2("机床"), "自动化设备");
  assertEquals(toL2("机器人"), "自动化设备"); // L3「机器人」⊂ 自动化设备
  const targets = new Set(kept.map(([, v]) => v));
  assertEquals(targets.has("通用设备"), false);
  assertEquals(targets.has("农产品加工"), false); // 农业 剔除后失去成员
});

Deno.test("sector_l2_map: 有色/稀有金属 按权重归小金属（前十只数 4-4 平票不可用）", () => {
  assertEquals(toL2("有色"), "小金属"); // 512400 小金属21.34% vs 能源金属12.37%
  assertEquals(toL2("稀有金属"), "小金属"); // 562800 31.64% vs 22.03%
  assertEquals(toL2("稀土"), "小金属");
  assertEquals(toL2("工业有色"), "工业金属"); // H11059 6/10 才是真工业金属
  assertEquals(toL2("黄金股"), "贵金属");
});

Deno.test("sector_l2_map: 医疗 归医疗服务（按权重 28.1% vs 医疗器械 23.6%）", () => {
  assertEquals(toL2("医疗"), "医疗服务");
  assertEquals(toL2("医疗器械"), "医疗器械");
  assertEquals(toL2("医疗设备"), "医疗器械");
});

Deno.test("sector_l2_map: 食品饮料族用 L1 例外，不硬塞白酒", () => {
  assertEquals(FOOD_L1, "食品饮料");
  assertEquals(L2_SET.has(FOOD_L1), false); // 它是 L1，不在 L2 集合里 —— 例外的代价必须可见
  assertEquals(toL2("酒"), FOOD_L1);
  assertEquals(toL2("食品饮料"), FOOD_L1);
  assertEquals(toL2("白酒"), null); // 白酒 从未作为原板块名存在过 → 未命中，不是剔除
  assertEquals(isDropped("白酒"), false);
  assertEquals(isDropped("消费"), true);
});

Deno.test("sector_l2_map: 无单一 L2 父级者一律剔除（用户 2026-10-04 裁定）", () => {
  for (const ind of ["消费", "科技", "电子", "医药", "生物医药", "医疗创新", "科创医药", "新能源",
    "新能源车", "智能汽车", "智能驾驶", "科创新材料", "大宗商品", "矿业", "石油", "石化", "油气",
    "互联网", "农业", "能源", "资源", "碳中和", "战略新兴", "高端制造", "央企创新", "央企改革",
    "央企科技", "央企能源", "长江保护", "信息技术", "信息科技"]) {
    assertEquals(toL2(ind), null, `${ind} 应剔除`);
    assertEquals(isDropped(ind), true, `${ind} 应在表中且为 null`);
  }
});

Deno.test("sector_l2_map: 宇宙冒出未收录的剥字名 → UNMAPPED 报警，绝不入池", () => {
  assertEquals(unmappedCanonical(["半导体", "半导体龙头", "央企结构调整"]), ["半导体龙头", "央企结构调整"]);
  assertEquals(toL2("半导体龙头"), null); // 未命中 ≠ 表内剔除，但结果同样不入池
  assertEquals(isDropped("半导体龙头"), false);
});

Deno.test("sector_l2_map: assertTargets 对手滑写错行业名会抛错", () => {
  assertTargets({ 半导体: "半导体" }); // 合法，不抛
  let msg = "";
  try {
    assertTargets({ 半导体: "电子" }); // 电子 是 L1 不是 L2 —— 必须拦下
  } catch (e) {
    msg = (e as Error).message;
  }
  assertEquals(msg.includes("半导体 -> 电子"), true, msg);
});
