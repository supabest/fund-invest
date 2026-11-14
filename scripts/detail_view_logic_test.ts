// scripts/detail_view_logic_test.ts —— 概览行 + 整页详情（2026-11-12 用户裁决 A）
//
// 需求：基金/股票展开后篇幅过长 → 概览只留一行（名称+代码 / 持仓市值 / 持仓涨跌幅 / 行尾信号点），
// 整行可点进整页详情，详情左上角「← 返回概览」；hash 路由让手机系统返回键与刷新都停在详情。
// 本测试钉住四件事：
//   ① 判据纯函数：信号点三态（止盈>抄底>不动，复用既有判据不新增阈值）、hash 解析/生成往返一致；
//   ② 概览行没有内联编辑区（旧的空壳 fund-body 随展开机制一起退场）；
//   ③ 详情表单复用旧 id（body-/sbody-）与旧绑定，列表重绘只刷事实区、绝不重建表单；
//   ④ 旧「编辑现场保全」回放机制（FORM_PURE/captureForms/restoreForms/toggle*）彻底删除，
//      而 autoRefresh 的「表单打开就跳过」守卫必须保留（详情表单仍挂 .fund-body.open）。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signalDotState, fundDipStrong, parseDetailHash, detailHash } from "./detail_view_logic.ts";

Deno.test("signalDotState：止盈优先于抄底，两者都没有才是「不动」", () => {
  assertEquals(signalDotState(true, true), "sell");
  assertEquals(signalDotState(true, false), "sell");
  assertEquals(signalDotState(false, true), "buy");
  assertEquals(signalDotState(false, false), "hold");
});

Deno.test("signalDotState：调用方传的是长度/对象等真值，按真值判定（不要求严格布尔）", () => {
  assertEquals(signalDotState(0, 3), "buy");
  assertEquals(signalDotState(1, 0), "sell");
  assertEquals(signalDotState(null, undefined), "hold");
  assertEquals(signalDotState("", ""), "hold");
});

Deno.test("fundDipStrong：安全垫 + 历史最深回撤双突破才升强档（2026-11-14 用户裁决）", () => {
  const cost = { kind: "cost" };
  const deep = { kind: "deep", completion: 95 };
  assertEquals(fundDipStrong([cost, deep]), true);
  assertEquals(fundDipStrong([deep, cost]), true, "腿顺序无关");
  assertEquals(fundDipStrong([cost, { kind: "lump" }, { kind: "ladder" }, deep]), true, "夹带其它两条腿不影响");
  assertEquals(fundDipStrong([null, cost, { kind: "deep", shout: false }]), true, "shout 不参与判据，暂停时判据状态仍如实显示");
});

Deno.test("fundDipStrong：单腿 / 缺腿 / 脏值一律不升强档", () => {
  for (const dips of [[{ kind: "cost" }], [{ kind: "deep" }], [{ kind: "lump" }, { kind: "ladder" }], [], null, undefined, "cost,deep", {}]) {
    assertEquals(fundDipStrong(dips), false, "不该闪：" + JSON.stringify(dips));
  }
});

Deno.test("parseDetailHash：#/fund/<id> 与 #/stock/<id> 解析出 kind 与字符串 id", () => {
  assertEquals(parseDetailHash("#/fund/f1"), { kind: "fund", id: "f1" });
  assertEquals(parseDetailHash("#/stock/sabc123"), { kind: "stock", id: "sabc123" });
  assertEquals(parseDetailHash("#/stock/00700"), { kind: "stock", id: "00700" });
});

Deno.test("parseDetailHash：空/残缺/未知 kind/多级路径一律 null（回概览，不造死详情）", () => {
  for (const h of ["", "#", "#/", "#/fund/", "#/stock/", "#/bond/x", "#/fund/a/b", "fund/f1", "#/FUND/x", null, undefined]) {
    assertEquals(parseDetailHash(h), null, "应判为非详情路由：" + String(h));
  }
});

Deno.test("detailHash：合法 kind+id 生成路由；非法 kind / 空 id / 含斜杠 id 给空串", () => {
  assertEquals(detailHash("fund", "f1"), "#/fund/f1");
  assertEquals(detailHash("stock", "s1"), "#/stock/s1");
  assertEquals(detailHash("bond", "x"), "");
  assertEquals(detailHash("fund", ""), "");
  assertEquals(detailHash("fund", null), "");
  assertEquals(detailHash("fund", undefined), "");
  assertEquals(detailHash("stock", "a/b"), "");
});

Deno.test("detailHash ↔ parseDetailHash 往返一致（id 原样回来，数字 id 变字符串）", () => {
  for (const kind of ["fund", "stock"] as const) {
    for (const id of ["f1", "s00700", "abc-123", 7]) {
      assertEquals(parseDetailHash(detailHash(kind, id)), { kind, id: String(id) });
    }
  }
});

// ---- 接线守卫：直接读 index.html，防止「纯函数绿、界面没接」 ----
const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));

function fnBody(name: string): string {
  const start = html.indexOf("function " + name + "(");
  assert(start >= 0, "index.html 缺少函数 " + name);
  const rest = html.slice(start);
  const end = rest.indexOf("\nfunction ");
  return end < 0 ? rest : rest.slice(0, end);
}

Deno.test("接线守卫：概览是一行行（overviewRowHtml+信号点+键盘可达），不再输出内联编辑区", () => {
  const fund = fnBody("renderFundList");
  const stock = fnBody("renderStockSection");
  for (const [name, body] of [["renderFundList", fund], ["renderStockSection", stock]] as const) {
    assert(body.includes("overviewRowHtml("), name + " 必须走概览行渲染");
    assert(body.includes("signalDotState("), name + " 必须算行尾信号点");
    assert(body.includes("keydown"), name + " 概览行要键盘可达（Enter/Space 进详情）");
    assertEquals(/fund-body|body-\$\{|sbody-/.test(body), false, name + " 不得再输出内联编辑区空壳");
    assertEquals(/toggleFundBody|toggleStockBody/.test(body), false, name + " 不得再挂展开切换");
  }
});

Deno.test("接线守卫：信号点与止盈/抄底角标同判据（基金看 dips，股票看 sDipGate.light）", () => {
  assert(html.includes("signalDotState(!!alert, dips.length>0)"), "基金信号点必须与 🟢 抄底角标同一个 dips");
  assert(html.includes("signalDotState(!!sAlert, sDipGate.light)"), "股票信号点必须与横幅同判据（只看 light）");
});

Deno.test("接线守卫：详情表单复用旧 id 与旧绑定（保存/删除/获取/跳编辑守卫全部不改）", () => {
  const b = fnBody("renderDetailForm");
  assert(b.includes("'body-'") && b.includes("'sbody-'"), "详情表单容器必须沿用 body-/sbody- 旧 id");
  assert(b.includes("fund-body open"), "详情表单必须挂 .fund-body.open（autoRefresh 的跳过守卫认这个类）");
  assert(b.includes("fundBodyHtml(") && b.includes("bindFundBody("), "基金详情表单仍走 fundBodyHtml+bindFundBody");
  assert(b.includes("stockFormHtml(") && b.includes("bindStockBody("), "股票详情表单仍走 stockFormHtml+bindStockBody");
});

Deno.test("接线守卫：列表重绘只刷详情事实区，绝不重建表单；表单只在打开与两处保存后重建", () => {
  const rd = fnBody("refreshDetail");
  assert(rd.includes("detailHead") && rd.includes("detailFacts"), "refreshDetail 要刷头部与事实区");
  assertEquals(rd.includes("detailFormWrap"), false, "refreshDetail 不许碰表单区（打字现场结构性保全）");
  assertEquals(fnBody("render").includes("detailFormWrap"), false, "render() 不许碰表单区");
  assertEquals((html.match(/renderDetailForm\(\);/g) || []).length, 3,
    "表单重建只允许三处：openDetail + saveFundForm + saveStockForm");
});

Deno.test("接线守卫：hash 路由接在 hashchange 与 loadAll，返回键在详情左上角", () => {
  assert(html.includes("window.addEventListener('hashchange'"), "必须监听 hashchange（系统返回键走这里）");
  assert(fnBody("loadAll").includes("applyHashRoute()"), "首屏加载后要按当前 hash 恢复详情（刷新停在详情）");
  assert(fnBody("gotoDetail").includes("detailHash("), "进详情必须经 detailHash 生成路由");
  assert(html.includes('id="detailBackBtn"'), "详情左上角返回按钮必须在骨架里");
  assert(html.includes("← 返回概览"), "返回按钮文案");
  for (const id of ["detailView", "detailHead", "detailFacts", "detailFormWrap"]) {
    assert(html.includes('id="' + id + '"'), "详情区域骨架缺 " + id);
  }
});

Deno.test("接线守卫：旧「编辑现场保全」回放机制彻底退场（结构保全取代 DOM 回放）", () => {
  for (const dead of ["FORM_PURE", "captureForms", "restoreForms", "toggleFundBody", "toggleStockBody", "formBaseline", "chev-"]) {
    assertEquals(html.includes(dead), false, "旧展开/回放机制残留：" + dead);
  }
});

Deno.test("接线守卫：autoRefresh 的「表单打开就跳过」守卫保留（详情表单仍受保护）", () => {
  assertEquals((html.match(/body\.classList\.contains\('open'\)/g) || []).length >= 3, true,
    "基金净值/股票行情/估值分位三处跳过守卫必须都在");
});

Deno.test("接线守卫：概览行 CSS 用 minmax(0,1fr) 保住名称省略号预算，详情打开时概览退场", () => {
  assert(/\.ov-row\{display:grid; grid-template-columns:minmax\(0,1fr\)/.test(html),
    "概览行必须是网格且名称列可收缩（390px 不溢出）");
  assert(html.includes("body.detail-open .panes{display:none;}"), "详情打开时两栏概览必须退场");
  assert(/\.ov-dot\.sell\{background:var\(--brick\)/.test(html), "止盈点用砖红（与横幅同 token）");
  assert(/\.ov-dot\.buy\{background:var\(--jade\)/.test(html), "抄底点用翠玉（与横幅同 token）");
  assert(html.includes("ov-legend"), "信号点要有图例说明（买/卖/不动一眼可懂）");
});

Deno.test("接线守卫：抄底绿灯分级只加动效、不改任何判据（2026-11-14 用户裁决）", () => {
  assert(html.includes("signalDotState(!!alert, dips.length>0)"), "基金概览点亮灯判据不许改");
  assert(html.includes("signalDotState(!!sAlert, sDipGate.light)"), "股票侧不参与分级，判据原样");
  assert(html.includes("fundDipStrong(dips)"), "基金概览要算强档");
  assert(/return overviewRowHtml\('fund', f, [^\n]*dot, strong\)/.test(html), "强档必须传进概览行渲染");
  assert(/@keyframes ov-buy-pulse/.test(html), "双突破要有闪烁动效");
  assert(html.includes("prefers-reduced-motion"), "闪烁必须尊重系统「减少动效」设置");
  assert(html.includes("强抄底（双突破·闪烁）"), "图例要说清闪烁含义");
});

Deno.test("接线守卫：研究/评分/价值门禁/换仓四块事实移入详情事实区，编辑表单只剩可编辑字段", () => {
  const form = fnBody("stockFormHtml");
  for (const fact of ["researchReportHtml(", "scoreDetailHtml(", "valueGateHtml(", "swapSuggest("]) {
    assertEquals(form.includes(fact), false, "stockFormHtml 不得再夹带事实块：" + fact);
  }
  const facts = fnBody("stockDetailFactsHtml");
  for (const fact of ["researchReportHtml(", "scoreDetailHtml(", "swapSuggest(", "valueGateHtml(vRowForSwap, valueIndRef"]) {
    assert(facts.includes(fact), "详情事实区必须承接：" + fact);
  }
});