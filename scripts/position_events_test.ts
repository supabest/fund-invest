// scripts/position_events_test.ts — 止盈档口径修复回归门禁
//
// 裁定：cost = 加权平均买入价（档位唯一依据），卖出永不改写；落袋走 realizedPnL 流水；
// 加仓按加权重算；档表可自定义；换表靠指纹失效判定，不靠按值差集。
// 被测实现体只在 index.html 的 LADDER_PURE 块内，本文件通过 signal_parity.ts 门面取用。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseTiersText, tiersFingerprint, applyPositionEvent, migrateStockPosition,
  positionReturnSummary, profitNextTier, profitAlertFromRet, DEFAULT_TIERS,
  migrateFundPosition, applyFundPositionEvent,
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

// ==== 2026-11-16 用户裁定：止盈落袋收益计入基金/股票总收益 ====
// 基金腿复用同一核心事件机（costBasis↔cost 别名进/出）；综合收益率分母=累计买入成本，
// 账面浮盈率仍是档位唯一依据——判据零改动，只加记账与展示。
Deno.test("基金适配·赎回：只减份额、每份成本不变、落袋入流水、累计买入成本不动（分母不缩小）", () => {
  let f = migrateFundPosition({ costBasis: 1.05, shares: 10000, profitTiers: DEFAULT_TIERS, profitTaken: [] });
  assertEquals(f.cumBuyCost, 10500, "迁移初始化 = 每份成本×份额");
  assertEquals(f.realizedPnL, 0);
  assertEquals(f.cost, undefined, "基金对象不得混入股票字段名 cost");
  const r = applyFundPositionEvent(f, { t: "sell", qty: 4000, price: 1.20 });
  assertEquals(r.ok, true);
  f = r.pos!;
  assertEquals(f.costBasis, 1.05, "赎回绝不改写每份成本（档位的尺）");
  assertEquals(f.shares, 6000);
  assertEquals(f.realizedPnL, 600, "(1.20−1.05)×4000 落袋");
  assertEquals(f.realizedProceeds, 4800);
  assertEquals(f.cumBuyCost, 10500, "分母不因赎回缩小——杜绝「卖出后收益率爆表」");
  assertEquals(f.cost, undefined, "别名出后不得残留股票字段");
});

Deno.test("基金适配·申购：加权平均重算每份成本、累计买入成本增加、历史落袋不回溯", () => {
  let f = migrateFundPosition({ costBasis: 1.05, shares: 10000 });
  f = applyFundPositionEvent(f, { t: "sell", qty: 4000, price: 1.20 }).pos!;
  const realizedBefore = f.realizedPnL;
  const added = applyFundPositionEvent(f, { t: "add", qty: 10000, price: 0.90 });
  assertEquals(added.ok, true);
  f = added.pos!;
  assertEquals(f.shares, 16000);
  assertEquals(f.costBasis, 0.95625, "(1.05×6000 + 0.90×10000)/16000 = 15300/16000，赎回后剩 6000 份参与加权");
  assertEquals(f.cumBuyCost, 19500, "10500 + 9000；赎回不扣减累计买入");
  assertEquals(f.realizedPnL, realizedBefore, "申购不得重算历史已落袋金额");
});

Deno.test("三率归一：基金形态（costBasis/currentNav）与股票形态同式；卖价≠现价时综合率 ≠ 账面率", () => {
  // 4000 份在 1.10 赎回（落袋 200），余 6000 份现价 1.20（浮盈 900）
  const fund = { costBasis: 1.05, currentNav: 1.20, shares: 6000, realizedPnL: 200, cumBuyCost: 10500 };
  const sm = positionReturnSummary(fund);
  assertEquals(Math.round(sm.ret! * 100) / 100, 14.29, "账面浮盈率 = (1.20−1.05)/1.05");
  assertEquals(Math.round(sm.totalReturn! * 100) / 100, 10.48, "综合 = (200+900)/10500");
  assertEquals(sm.realizedPnL, 200);
  // 股票形态回归：同式同值
  const stock = positionReturnSummary({ cost: 30, currentPrice: 36, shares: 600, realizedPnL: 2400, cumBuyCost: 30000 });
  assertEquals(Math.round(stock.ret! * 100) / 100, 20);
  assertEquals(Math.round(stock.totalReturn! * 100) / 100, Math.round((2400 + 3600) / 30000 * 10000) / 100, "20%");
});

Deno.test("基金迁移幂等：两次迁移结果全等；不猜历史赎回（realizedPnL 初始 0）", () => {
  const old = { costBasis: 1.0523, shares: 10000, profitTiers: DEFAULT_TIERS, profitTaken: [20, 40] };
  const a = migrateFundPosition(old);
  assertEquals(a.costBasis, 1.0523);
  assertEquals(a.realizedPnL, 0, "绝不猜历史赎回");
  assertEquals(a.cumBuyCost, Math.round(1.0523 * 10000 * 1e4) / 1e4);
  assertEquals(a.cost, undefined, "迁移后不得残留别名中间字段");
  const b = migrateFundPosition(a);
  assertEquals(b, a, "迁移必须幂等");
});

Deno.test("接线守卫：表头基金/股票收益率计入落袋——分子=浮盈+已落袋、分母=累计买入成本（缺省行回落持仓成本）", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const s = html.indexOf("function render(){");
  assert(s >= 0, "render 不存在");
  const body = html.slice(s, html.indexOf("\nfunction setStatGroup(", s));
  assert(/fundRealized = funds\.reduce\(\(s,f\)=> s \+ \(Number\(f\.realizedPnL\)\|\|0\), 0\)/.test(body),
    "表头缺基金落袋累加（Number() 防缺字段）");
  assert(/stockRealized = stocks\.reduce\(\(s,x\)=> s \+ \(Number\(x\.realizedPnL\)\|\|0\), 0\)/.test(body),
    "表头缺股票落袋累加");
  assertEquals((body.match(/if\(cum>0\) return s \+ cum;/g) || []).length, 2,
    "两腿分母都必须优先用已迁移行的累计买入成本，缺省行回落持仓成本（与邮件概览同口径）");
  assert(/fundRet = fundBase>0 \? \(\(fundMv-fundCost\)\+fundRealized\)\/fundBase\*100 : 0/.test(body),
    "基金表头率必须 =（浮盈+落袋）/累计买入成本");
  assert(/stockRet = stockBase>0 \? \(\(stockMv-stockCost\)\+stockRealized\)\/stockBase\*100 : 0/.test(body),
    "股票表头率必须 =（浮盈+落袋）/累计买入成本");
  assertEquals(html.includes("function setStatGroup(key, mv, ret, barPct, goalLbl, barColor, hint)"),
    true, "setStatGroup 缺 hint 参");
  assertEquals(html.includes("retEl.title = hint || '';"), true,
    "落袋口径说明要走表头悬停提示（无落袋为空=纯浮盈口径）");
});
