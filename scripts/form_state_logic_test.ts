// scripts/form_state_logic_test.ts —— 编辑区现场保全（2026-11-08 用户裁决 A）
//
// 报障：手机端展开基金/股票编辑区打字时面板经常自己折叠、打到一半的字也没了。
// 根因：两个列表重绘都是 list.innerHTML='' 全量重建，编辑区输出成空壳，展开态只活在 DOM；
// 而大盘取数 / autoRefreshAll / 趋势角标批量 / 云同步 / window focus 都在打字那几秒异步重绘。
// 本测试钉住三件事：
//   ① 判据纯函数：只把「用户改过」的字段算 dirty（未改的字段重绘后仍吃最新行情）；已删除的卡不复活；
//   ② 接线：两个列表都必须「重建前抓现场、重建后回放」，toggle 建表时记基线；
//   ③ 回放只覆盖 dirty 且恢复焦点；回放后不得重记基线（否则下一次重绘就把用户打了一半的字冲掉）。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formDirty, formStillOpen, type OpenForm } from "./form_state_logic.ts";

Deno.test("formDirty：只报用户改过的字段，未改的字段不进 dirty（重绘后仍吃最新数据）", () => {
  const baseline = { shares: "100", currentNav: "0.904", name: "测试基金", manualPause: "0" };
  const current = { shares: "12345", currentNav: "0.904", name: "测试基金", manualPause: "0" };
  assertEquals(formDirty(current, baseline), { shares: "12345" });
});

Deno.test("formDirty：勾选框按 '1'/'0' 比对，勾上算改过、原样不算", () => {
  assertEquals(formDirty({ manualPause: "1" }, { manualPause: "0" }), { manualPause: "1" });
  assertEquals(formDirty({ manualPause: "0" }, { manualPause: "0" }), {});
  assertEquals(formDirty({ manualPause: "0" }, { manualPause: "1" }), { manualPause: "0" });
});

Deno.test("formDirty：基线里没有的键一律带上（宁可多保不可丢字）", () => {
  assertEquals(formDirty({ qdiiPremium: "2.5" }, {}), { qdiiPremium: "2.5" });
  assertEquals(formDirty({ a: "1", b: "2" }, { a: "1" }), { b: "2" });
});

Deno.test("formDirty：空输入不炸，返回空对象", () => {
  assertEquals(formDirty(null, null), {});
  assertEquals(formDirty({}, { a: "1" }), {});
  assertEquals(formDirty({ a: "" }, { a: "" }), {});
});

Deno.test("formStillOpen：数据里已不存在的卡（被删除）不复活，其余按原顺序回放", () => {
  const open: OpenForm[] = [
    { id: "f1", dirty: { shares: "1" }, focus: null },
    { id: "f2", dirty: {}, focus: null },
    { id: "f3", dirty: { name: "x" }, focus: null },
  ];
  const kept = formStillOpen(open, ["f3", "f1"]);
  assertEquals(kept.map((x) => x.id), ["f1", "f3"]);
});

Deno.test("formStillOpen：id 数字与字符串同视；空输入返回空数组", () => {
  const open = [{ id: 7, dirty: {}, focus: null }];
  assertEquals(formStillOpen(open, ["7"]).length, 1);
  assertEquals(formStillOpen(null, ["7"]), []);
  assertEquals(formStillOpen(open, null), []);
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

Deno.test("接线守卫：两个列表重绘都必须先抓现场再清空，重建后回放展开态", () => {
  const fund = fnBody("renderFundList");
  const capF = fund.indexOf("captureForms(list, 'fund')");
  const clearF = fund.indexOf("list.innerHTML = ''");
  const resF = fund.indexOf("restoreForms(snap, 'fund', funds, toggleFundBody)");
  assert(capF >= 0, "renderFundList 必须在重建前 captureForms（否则展开态随 innerHTML='' 一起没了）");
  assert(capF < clearF, "captureForms 必须排在 list.innerHTML='' 之前");
  assert(resF > fund.lastIndexOf("list.appendChild(card)"), "restoreForms 必须排在卡片全部重建之后");

  const stock = fnBody("renderStockSection");
  const capS = stock.indexOf("captureForms(list, 'stock')");
  const clearS = stock.indexOf("list.innerHTML = ''");
  const resS = stock.indexOf("restoreForms(snap, 'stock', stocks, toggleStockBody)");
  assert(capS >= 0, "renderStockSection 必须在重建前 captureForms");
  assert(capS < clearS, "股票侧 captureForms 必须排在 list.innerHTML='' 之前");
  assert(resS > stock.lastIndexOf("list.appendChild(card)"), "股票侧 restoreForms 必须排在卡片全部重建之后");
});

Deno.test("接线守卫：展开建表时记基线，收起时清基线；抓现场只读 .fund-body.open 且走 formDirty", () => {
  const tf = fnBody("toggleFundBody");
  assert(/body\.innerHTML = fundBodyHtml\(funds\.find\(x=>x\.id===id\)\);/.test(tf), "基金展开仍走 fundBodyHtml 建表");
  assert(tf.indexOf("rememberFormBaseline('fund', id, body)") > tf.indexOf("body.innerHTML = fundBodyHtml"),
    "基金建表后必须记基线（dirty 的比对锚）");
  assert(/delete formBaseline\['fund:'\+id\]/.test(tf), "收起时清掉基线，避免残留");
  const ts = fnBody("toggleStockBody");
  assert(ts.indexOf("rememberFormBaseline('stock', id, body)") > ts.indexOf("body.innerHTML = stockFormHtml"),
    "股票建表后必须记基线");
  assert(/delete formBaseline\['stock:'\+id\]/.test(ts), "股票收起时清掉基线");

  const cap = fnBody("captureForms");
  assert(/\.fund-body\.open/.test(cap), "抓现场只认展开着的编辑区");
  assert(/formDirty\(/.test(cap), "dirty 判定必须走纯函数，不得在 DOM 层手写比对");
  assert(/document\.activeElement/.test(cap), "必须记下当前焦点，否则重绘后键盘/光标掉回 body");
  assert(/const FORM_FIELD_SEL = '\[data-k\],\[data-sk\]'/.test(html),
    "股票编辑区字段用 data-sk（基金用 data-k），统一选择器必须两种都覆盖，否则股票侧只保展开不保输入");
  assert(/querySelectorAll\(FORM_FIELD_SEL\)/.test(fnBody("formValuesIn")),
    "抓现场必须走覆盖两种属性的统一选择器，不得只读 data-k");
});

Deno.test("接线守卫：回放只覆盖 dirty、恢复焦点光标，且回放后不得重记基线", () => {
  const res = fnBody("restoreForms");
  assert(/formStillOpen\(/.test(res), "回放前必须过滤掉已删除的卡");
  assert(/el\.value = o\.dirty\[k\]/.test(res), "文本框回放必须把 dirty 值写回 value（只断言 o.dirty[k] 出现会被勾选框分支蒙混）");
  assert(/el\.checked = o\.dirty\[k\]==='1'/.test(res), "勾选框回放必须把 dirty 的 '1'/'0' 写回 checked");
  assert(/data-sk/.test(res), "回放定位字段必须兼容 data-sk（股票表单），否则股票输入回不去");
  assert(/\.focus\(/.test(res), "回放后必须恢复焦点");
  assert(/setSelectionRange/.test(res), "文本框需要恢复光标位置");
  assertEquals(res.includes("rememberFormBaseline"), false,
    "回放后不得重记基线：否则用户打了一半的字在下一次重绘就不再算 dirty，会被行情数据冲掉");
});
