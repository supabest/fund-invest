import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  extractInd,
  isStyleExcluded,
  normalizeInd,
} from "./sector_normalize.ts";
Deno.test("extractInd: 去ETF后缀与前缀基金公司", () => {
  assertEquals(extractInd("银行ETF南方"), "银行");
  assertEquals(extractInd("机器人ETF鹏华"), "机器人");
  // 实现微调（brief Step 3 注授权）：剥掉 [A-Za-z0-9·-—] 后 '沪深300ETF' → '沪深'（非空，
  // 不触发 `|| s` 回落）。宽基本就不在 class1=1 行业池内，此例只护规则不改合并断言。
  assertEquals(extractInd("华泰柏瑞沪深300ETF"), "沪深");
});
Deno.test("normalizeInd: 已知合并", () => {
  for (const r of ["地产", "房地产", "房产"]) {
    assertEquals(normalizeInd(r), "房地产");
  }
  for (const r of ["券商", "证券", "证券保险"]) {
    assertEquals(normalizeInd(r), "证券");
  }
  for (const r of ["芯片", "集成电路", "半导体", "科创半导体"]) {
    assertEquals(normalizeInd(r), "半导体");
  }
  for (const r of ["半导体设备", "科创半导体设备"]) {
    assertEquals(normalizeInd(r), "半导体设备");
  }
  assertEquals(normalizeInd("绿电"), "电力");
  assertEquals(normalizeInd("储能电池"), "电池");
  assertEquals(normalizeInd("消费50"), "消费");
  assertEquals(normalizeInd("酒"), "酒"); // 酒与食品饮料分列（spec §2.2）
  assertEquals(normalizeInd("食品饮料"), "食品饮料");
  assertEquals(normalizeInd("军工龙头"), "军工");
  assertEquals(normalizeInd("信息技术"), "信息技术"); // 未命中映射表 → 原样
});
// R1 用户裁定（2026-10-01）：稳手合并三组，仅此三组
Deno.test("normalizeInd: R1 有色/软件/电池族合并", () => {
  assertEquals(normalizeInd("有色金属"), "有色");
  assertEquals(normalizeInd("有色矿业"), "有色");
  assertEquals(normalizeInd("有色"), "有色");
  assertEquals(normalizeInd("软件开发"), "软件");
  assertEquals(normalizeInd("软件"), "软件");
  assertEquals(normalizeInd("锂电池"), "电池");
  assertEquals(normalizeInd("电池"), "电池");
});
// R1 明确不许动的维持分列——反向钉
Deno.test("normalizeInd: R1 维持分列反向钉", () => {
  assertEquals(normalizeInd("科创芯片"), "科创芯片"); // 科创芯片/科创芯片设计维持分列
  assertEquals(normalizeInd("科创芯片设计"), "科创芯片设计");
  assertEquals(normalizeInd("消费电子"), "消费电子"); // 消费电子/消费龙头与消费维持分列
  assertEquals(normalizeInd("消费龙头"), "消费龙头");
  assertEquals(normalizeInd("医药"), "医药"); // 医疗族维持分列
  assertEquals(normalizeInd("医疗创新"), "医疗创新");
  assertEquals(normalizeInd("医疗器械"), "医疗器械");
  assertEquals(normalizeInd("医疗设备"), "医疗设备");
  assertEquals(normalizeInd("中药"), "中药");
  assertEquals(normalizeInd("科创医药"), "科创医药");
  assertEquals(normalizeInd("能源"), "能源"); // 能源/新能源/新能源车维持分列
  assertEquals(normalizeInd("新能源车"), "新能源车");
  assertEquals(normalizeInd("半导体设备"), "半导体设备"); // 半导体↔半导体设备分列（spec §2.2）
});
// R2 用户裁定：纯区域/风格类剔除谓词（恰为风格/宽基词本身 → true；风格前缀+行业后缀组合 → false）
Deno.test("isStyleExcluded: R2 纯风格剔除 vs 组合主题保留", () => {
  assertEquals(isStyleExcluded("央企"), true);
  assertEquals(isStyleExcluded("民企"), true);
  assertEquals(isStyleExcluded("深成长"), true); // 交易所前缀+成长风格，无行业后缀
  assertEquals(isStyleExcluded("央企能源"), false); // 风格前缀+行业后缀 → 保留
  assertEquals(isStyleExcluded("创业板算力"), false);
  assertEquals(isStyleExcluded("科创人工智能"), false);
});
