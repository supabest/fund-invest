// scripts/position_events_test.ts — 止盈档口径修复回归门禁
//
// 裁定：cost = 加权平均买入价（档位唯一依据），卖出永不改写；落袋走 realizedPnL 流水；
// 加仓按加权重算；档表可自定义；换表靠指纹失效判定，不靠按值差集。
// 被测实现体只在 index.html 的 LADDER_PURE 块内，本文件通过 signal_parity.ts 门面取用。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseTiersText, tiersFingerprint, applyPositionEvent, migrateStockPosition,
  positionReturnSummary, profitNextTier, profitAlertFromRet, DEFAULT_TIERS,
} from "./signal_parity.ts";

Deno.test("parseTiersText：可新增 +100% 档；非法输入绝不静默回退默认档表", () => {
  const ok = parseTiersText("20:10,40:20,60:30,80:50,100:25");
  assertEquals(ok.ok, true);
  assertEquals(ok.tiers!.length, 5, "自定义档表要能超过默认 4 档");
  assertEquals(ok.tiers![4], { ret: 100, sell: 25 });
  for (const bad of ["", "20", "20:10,20:15", "40:10,20:20", "20:0", "20:101", "abc:10"]) {
    assertEquals(parseTiersText(bad).ok, false, "应拒绝：" + bad);
  }
});

Deno.test("tiersFingerprint：换预设必变；recycle 与默认表在 40/60 重叠，按值差集清不掉残留", () => {
  const def = tiersFingerprint(DEFAULT_TIERS);
  const rec = tiersFingerprint(parseTiersText("25:10,40:15,60:20,100:25").tiers!);
  assert(def !== rec, "档表指纹必须能区分预设");
  // 残留 [40,60] 在 recycle 里都是合法 ret；差集为空 ⇒ 必须靠指纹变更整体重置 profitTaken
  const recycleRets = parseTiersText("25:10,40:15,60:20,100:25").tiers!.map((t) => t.ret);
  assertEquals([40, 60].every((r) => recycleRets.includes(r)), true);
  assertEquals([40, 60].filter((r) => !recycleRets.includes(r)), []);
});

Deno.test("002415 回归：部分卖出后 cost 不变、ret 恒 +20%、下一档正常指向 40", () => {
  let p = migrateStockPosition({
    cost: 30, shares: 1000, currentPrice: 36, profitTiers: DEFAULT_TIERS, profitTaken: [],
  });
  const r = applyPositionEvent(p, { t: "sell", qty: 400, price: 36 });
  assertEquals(r.ok, true);
  p = r.pos!;
  assertEquals(p.cost, 30, "卖出绝不改写成本（档位的尺）");
  assertEquals(p.shares, 600);
  assertEquals(p.realizedPnL, 2400, "(36−30)×400 落袋");
  assertEquals(p.realizedProceeds, 14400);
  const sm = positionReturnSummary(p);
  assertEquals(Math.round(sm.ret! * 100) / 100, 20, "ret 不因卖出跳高");
  assertEquals(profitNextTier(p.profitTiers, p.profitTaken, sm.ret)!.ret, 40, "不烧穿档表");
});

Deno.test("对照：把成本改小到 18 会让 ret 跳 +100% 并烧穿 80 档（被禁止的降成本口径）", () => {
  const sm = positionReturnSummary({ cost: 18, shares: 600, currentPrice: 36 });
  assertEquals(Math.round(sm.ret!), 100);
  assertEquals(profitNextTier(DEFAULT_TIERS, [], sm.ret), null, "越顶 ⇒ 取不到下一档");
  assertEquals(profitAlertFromRet(sm.ret, { profitTiers: DEFAULT_TIERS, profitTaken: [] })!.tier.ret, 80,
    "代码实际走 sAlert「已达最高档」，不是 next=null 分支");
});

Deno.test("自定义 +100% 档解死局：ret=100 有命中档；ret=79.9 给 80；全执行后收尾", () => {
  const tiers = parseTiersText("20:10,40:20,60:30,80:50,100:25").tiers!;
  assertEquals(profitAlertFromRet(100, { profitTiers: tiers, profitTaken: [] })!.tier.ret, 100);
  assertEquals(profitNextTier(tiers, [], 79.9)!.ret, 80);
  assertEquals(profitNextTier(tiers, [20, 40, 60, 80, 100], 120), null);
});

Deno.test("加仓：加权平均重算成本、历史落袋不回溯、costVersion 递增", () => {
  let p = migrateStockPosition({
    cost: 30, shares: 1000, currentPrice: 36, profitTiers: DEFAULT_TIERS, profitTaken: [],
  });
  p = applyPositionEvent(p, { t: "sell", qty: 400, price: 36 }).pos!;
  const realizedBefore = p.realizedPnL;
  const added = applyPositionEvent(p, { t: "add", qty: 1000, price: 20 });
  assertEquals(added.ok, true);
  p = added.pos!;
  assertEquals(p.cost, 23.75, "(30×600 + 20×1000)/1600 = 23.75，卖出后剩 600 股参与加权");
  assertEquals(p.shares, 1600);
  assertEquals(p.realizedPnL, realizedBefore, "加仓不得重算历史已落袋金额");
  assertEquals(p.costVersion, 1, "成本基准版本须递增以提示复核历史档位标记");
  assertEquals(Math.round(positionReturnSummary(p).ret!), 52, "(36−23.75)/23.75 ≈ 51.6%");
});

Deno.test("低位加仓合法拉低成本（不该被当成降成本记账）；卖出超股数被拒", () => {
  const base = migrateStockPosition({ cost: 30, shares: 1000 });
  assertEquals(applyPositionEvent(base, { t: "sell", qty: 1200, price: 36 }).ok, false);
  const add = applyPositionEvent(base, { t: "add", qty: 1000, price: 20 });
  assertEquals(add.ok, true);
  assertEquals(add.pos!.cost, 25);
  assertEquals(add.pos!.events[0].t, "add", "加仓要留事件痕迹");
});

Deno.test("公司行动：送转按比例调股数与成本；现金分红进已实现而不冲减成本", () => {
  let p = migrateStockPosition({ cost: 30, shares: 1000 });
  p = applyPositionEvent(p, { t: "corporateAction", kind: "split", ratio: 2 }).pos!;
  assertEquals(p.shares, 2000);
  assertEquals(p.cost, 15);
  const costBefore = p.cost;
  p = applyPositionEvent(p, { t: "corporateAction", kind: "dividend", cash: 500 }).pos!;
  assertEquals(p.cost, costBefore, "分红不冲减 cost（否则又回到降成本口径）");
  assertEquals(p.realizedPnL, 500);
});

Deno.test("migrateStockPosition 幂等：旧记录不丢值、不猜历史卖出、重复迁移结果一致", () => {
  const old = { cost: 30, shares: 1000, profitTiers: DEFAULT_TIERS, profitTaken: [20, 40] };
  const a = migrateStockPosition(old);
  assertEquals(a.cost, 30);
  assertEquals(a.profitTaken, [20, 40]);
  assertEquals(a.realizedPnL, 0, "绝不猜历史卖出");
  assertEquals(a.schemaVersion, 1);
  const b = migrateStockPosition(a);
  assertEquals(b, a, "迁移必须幂等");
});

Deno.test("回归保护：819 的批量标记 ≤hit 语义保持不动，价格回落不重喊已越过低档", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/const add = tiers\.filter\(t => t\.ret <= hit\)\.map\(t => t\.ret\);/.test(html),
    "markProfitTaken 的批量写入是有意设计，不得改成只标命中档");
  const taken = DEFAULT_TIERS.filter((t) => t.ret <= 60).map((t) => t.ret);
  assertEquals(profitAlertFromRet(35, { profitTiers: DEFAULT_TIERS, profitTaken: taken }), null,
    "从 +65% 回落到 +35% 时不得重新宣布 +20% 档");
});

Deno.test("接线守卫：档位文本框与持仓事件登记入口都已落地", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/data-sk="tierText"/.test(html), "股票表单要有可编辑档位文本框");
  assert(/data-k="tierText"/.test(html), "基金表单要有可编辑档位文本框");
  assert(/data-action="sellPosition"/.test(html), "要有独立卖出登记入口");
  assert(/data-action="addPosition"/.test(html), "加仓要与卖出成对落地");
  assert(/data-action="resetTaken"/.test(html), "profitTaken 要有清除入口");
  assert(/function resetProfitTaken\(/.test(html));
  assert(/function migrateStocks\(/.test(html));
  assert(/function tiersFingerprint\(/.test(html));
});
