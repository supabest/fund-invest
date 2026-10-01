// scripts/sector_render_logic_test.ts —— Task 4 前端「板块轮动」卡片纯渲染逻辑单测
// 背景：卡片全部代码按控制者要求只落在 index.html（commit 面仅 index.html + 本测试文件），
// 因此这里用标记抽取 index.html 的 SECTOR_PURE 块，在 Deno 里独立验证排序/最差状态/
// 数值单位格式化/近似池匹配等纯函数，浏览器端到端只是最后一步。
// 说明：块内 labelDots 调用页面既有的 escapeHtml（index.html L1484）；抽取执行时以同实现
// 的 shim 注入，只为隔离测试，不改变被测函数语义。
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";

const ESCAPE_SHIM =
  `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }\n`;

async function loadPureBlock(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const m = html.match(
    /\/\/ ==== SECTOR_PURE_BEGIN ====([\s\S]*?)\/\/ ==== SECTOR_PURE_END ====/,
  );
  if (!m) throw new Error("index.html 缺少 SECTOR_PURE 标记块");
  const src = ESCAPE_SHIM + m[1] +
    `\nreturn { SECTOR_WORST_RANK, SECTOR_LABEL_DOT, SECTOR_THEME_ORDER, SECTOR_NOT_COVERED_THEMES,
      sectorStateWorstRank, sectorIsAccumulating, sectorSplitRows, sectorRankLists, sectorWorstRow,
      sectorThemeGroups, sectorThemeSummaries, fmtRatioPct, fmtPoints, fmtScoreVal, fmtVr,
      sectorLabelDots, matchApproxPools, sectorSummaryCounts };`;
  // deno-lint-ignore no-explicit-any
  return new Function(src)() as any;
}

// deno-lint-ignore no-explicit-any
const P: any = await loadPureBlock();

// deno-lint-ignore no-explicit-any
const row = (o: any) => ({
  batch_date: "2026-10-01", ind: "x", pk_etf: "000000", n_etf: 1,
  m20: 0, m60: 0, pos52: 50, dev60: 0, vr: 1, mp: 50, dm20: null,
  state: "纠缠", labels: [], score: 50, v: 50, m: 50, l: 50, q: null,
  theme: null, stale: false, ...o,
});

// ---------- R-T4-1：累积中判定 = pos52 === null，严禁 falsy ----------
Deno.test("sectorIsAccumulating: pos52=0 是有效值（恰在52周最低点），不得当累积中", () => {
  assertEquals(P.sectorIsAccumulating(row({ pos52: 0 })), false);
  assertEquals(P.sectorIsAccumulating(row({ pos52: 0.6231 })), false);
  assertEquals(P.sectorIsAccumulating(row({ pos52: 100 })), false);
});
Deno.test("sectorIsAccumulating: null/undefined/缺行 → 累积中", () => {
  assertEquals(P.sectorIsAccumulating(row({ pos52: null })), true);
  assertEquals(P.sectorIsAccumulating(row({ pos52: undefined })), true);
  assertEquals(P.sectorIsAccumulating(null), true);
});

// ---------- spec §4.3 / index.ts C3：双榜只在可交易子集内按 m60 排序 ----------
Deno.test("sectorRankLists: 向上=强多头/多头按 m60 降序；调整=走弱/空头排列按 m60 升序；纠缠/累积中分流", () => {
  const rows = [
    row({ ind: "农牧渔", state: "多头", m60: 0, pos52: null }), // 累积中：兜底 0 不得进榜（C3）
    row({ ind: "医疗", state: "强多头", m60: 0.1405 }),
    row({ ind: "银行", state: "强多头", m60: 0.1238 }),
    row({ ind: "煤炭", state: "多头", m60: 0.1135 }),
    row({ ind: "房地产", state: "多头", m60: 0.1102 }),
    row({ ind: "油气", state: "多头", m60: 0.0987 }),
    row({ ind: "半导体", state: "走弱", m60: -0.03 }),
    row({ ind: "机器人", state: "空头排列", m60: -0.2097 }),
    row({ ind: "新能源车", state: "空头排列", m60: -0.1982 }),
    row({ ind: "黄金股", state: "纠缠", m60: 0.1127 }),
  ];
  const r = P.sectorRankLists(rows);
  assertEquals(r.up.map((x: Row) => x.ind), ["医疗", "银行", "煤炭", "房地产", "油气"]);
  assertEquals(r.down.map((x: Row) => x.ind), ["机器人", "新能源车", "半导体"]);
  assertEquals(r.entangled.map((x: Row) => x.ind), ["黄金股"]);
  assertEquals(r.accumulating.map((x: Row) => x.ind), ["农牧渔"]);
});

type Row = ReturnType<typeof row>;

Deno.test("sectorSummaryCounts: 概要与引擎 rankLists 同口径（向上/纠缠/调整/数据积累中）", () => {
  const rows = [
    row({ ind: "医疗", state: "强多头" }), row({ ind: "煤炭", state: "多头" }),
    row({ ind: "半导体", state: "走弱" }), row({ ind: "机器人", state: "空头排列" }),
    row({ ind: "黄金股", state: "纠缠" }), row({ ind: "农牧渔", state: "多头", pos52: null }),
  ];
  assertEquals(P.sectorSummaryCounts(rows), { up: 2, entangled: 1, down: 2, accumulating: 1 });
});

Deno.test("sectorSplitRows: 分流不改动原数组、保序", () => {
  const rows = [row({ ind: "a", pos52: null }), row({ ind: "b", pos52: 0 })];
  const s = P.sectorSplitRows(rows);
  assertEquals(s.tradable.map((x: Row) => x.ind), ["b"]);
  assertEquals(s.accumulating.map((x: Row) => x.ind), ["a"]);
  assertEquals(rows.length, 2);
});

// ---------- R-T4-4：主题最差状态（空头排列 < 走弱 < 纠缠 < 多头 < 强多头）----------
Deno.test("sectorStateWorstRank: 五态严格递增；未知态回落纠缠", () => {
  const order = ["空头排列", "走弱", "纠缠", "多头", "强多头"];
  const ranks = order.map((s) => Number(P.sectorStateWorstRank(s)));
  for (let i = 1; i < ranks.length; i++) assertEquals(ranks[i] > ranks[i - 1], true);
  assertEquals(P.sectorStateWorstRank("空头排列"), 0);
  assertEquals(P.sectorStateWorstRank("强多头"), 4);
  assertEquals(P.sectorStateWorstRank("乱码态"), P.SECTOR_WORST_RANK["纠缠"]);
});

Deno.test("sectorWorstRow: 取最差状态行；同最差状态取 m60 更低者", () => {
  const rows = [
    row({ ind: "油气", state: "多头", m60: 0.0987 }),
    row({ ind: "有色", state: "空头排列", m60: -0.0592 }),
    row({ ind: "稀土", state: "空头排列", m60: -0.1939 }),
  ];
  assertEquals(P.sectorWorstRow(rows).ind, "稀土");
  assertEquals(P.sectorWorstRow([]), null);
  assertEquals(P.sectorWorstRow(null), null);
});

Deno.test("sectorThemeGroups/Summaries: 按 theme 列分组，theme=null 不入组；标签并集", () => {
  const rows = [
    row({ ind: "电力", state: "空头排列", theme: "电力/绿电", labels: ["左侧埋伏"], m60: 0.0218 }),
    row({ ind: "绿色电力", state: "空头排列", theme: "电力/绿电", labels: [], m60: 0.0204 }),
    row({ ind: "机器人", state: "空头排列", theme: "机器人", labels: ["左侧埋伏"] }),
    row({ ind: "煤炭", state: "多头", theme: "全球资源", labels: [] }),
    row({ ind: "稀土", state: "空头排列", theme: "全球资源", labels: ["左侧埋伏"] }),
    row({ ind: "医疗", state: "强多头", theme: null }),
  ];
  const g = P.sectorThemeGroups(rows);
  assertEquals([...g.keys()], ["电力/绿电", "机器人", "全球资源"]);
  assertEquals(g.get("全球资源").length, 2);
  const sums = P.sectorThemeSummaries(rows, ["电力/绿电", "机器人", "新能源车", "全球资源"]);
  assertEquals(sums.length, 4);
  assertEquals(sums[0].worst.ind, "绿色电力"); // 同空头排列取 m60 更低（0.0204 < 0.0218）
  assertEquals(sums[0].rows.map((x: Row) => x.ind), ["电力", "绿色电力"]);
  assertEquals(sums[1].worst.state, "空头排列");
  assertEquals(sums[2].worst, null); // 本批次无映射行业 → 由渲染层降级显示
  assertEquals(sums[2].theme, "新能源车");
  assertEquals(sums[3].worst.state, "空头排列");
  assertEquals(sums[3].labels, ["左侧埋伏"]);
});

// ---------- R-T4-3：数值单位陷阱（比率 ×100；点位不 ×100；null → 「—」）----------
Deno.test("fmtRatioPct: 比率字段 ×100；0 不加正号；null → —", () => {
  assertEquals(P.fmtRatioPct(0.1405), "+14.05%");
  assertEquals(P.fmtRatioPct(0.1238), "+12.38%");
  assertEquals(P.fmtRatioPct(-0.0592), "-5.92%");
  assertEquals(P.fmtRatioPct(0), "0.00%");
  assertEquals(P.fmtRatioPct(0.0204, 1), "+2.0%");
  assertEquals(P.fmtRatioPct(null), "—");
  assertEquals(P.fmtRatioPct(undefined), "—");
  assertEquals(P.fmtRatioPct(NaN), "—");
});

Deno.test("fmtPoints: 0-100 点位不得二次 ×100；0 是有效值；null → —", () => {
  assertEquals(P.fmtPoints(97.541), "97.5");
  assertEquals(P.fmtPoints(56.3107), "56.3");
  assertEquals(P.fmtPoints(0.6231), "0.6");
  assertEquals(P.fmtPoints(0), "0.0");
  assertEquals(P.fmtPoints(100), "100.0");
  assertEquals(P.fmtPoints(null), "—");
  assertEquals(P.fmtScoreVal(63.02), "63.0");
  assertEquals(P.fmtScoreVal(null), "—");
});

Deno.test("fmtVr: 量比是倍数，不加 %；null → —", () => {
  assertEquals(P.fmtVr(1.7), "1.70");
  assertEquals(P.fmtVr(0), "0.00");
  assertEquals(P.fmtVr(null), "—");
});

// ---------- brief Step2 色点映射 ----------
Deno.test("SECTOR_LABEL_DOT: 筑底候选=绿 过热警示/高位放量滞涨=红 禁追高=橙 退潮观察/左侧埋伏=灰", () => {
  assertEquals(P.SECTOR_LABEL_DOT["筑底候选"], "green");
  assertEquals(P.SECTOR_LABEL_DOT["过热警示"], "red");
  assertEquals(P.SECTOR_LABEL_DOT["高位放量滞涨"], "red");
  assertEquals(P.SECTOR_LABEL_DOT["禁追高"], "amber");
  assertEquals(P.SECTOR_LABEL_DOT["退潮观察"], "gray");
  assertEquals(P.SECTOR_LABEL_DOT["左侧埋伏"], "gray");
});

Deno.test("sectorLabelDots: 空标签→空串；多标签按入参顺序；未知标签回落灰点；文本被转义", () => {
  assertEquals(P.sectorLabelDots([]), "");
  assertEquals(P.sectorLabelDots(null), "");
  const h = P.sectorLabelDots(["左侧埋伏", "筑底候选"]);
  assertEquals(h.indexOf("dot-gray") < h.indexOf("dot-green"), true);
  assertEquals(h.includes("左侧埋伏"), true);
  const bad = P.sectorLabelDots(['<img src=x onerror="alert(1)">']);
  assertEquals(bad.includes("<img"), false);
  assertEquals(bad.includes("&lt;img"), true);
  assertEquals(bad.includes("dot-gray"), true);
});

// ---------- R-T4-5：近似个股池匹配（互为子串，不做跨系统合成）----------
Deno.test("matchApproxPools: 互为子串命中；单字池名不参与；去重；无命中返回空", () => {
  const pools = ["半导体", "半导体设备", "芯片设计", "电力设备", "火电设备", "酒", "银行"];
  assertEquals(P.matchApproxPools("半导体", pools), ["半导体", "半导体设备"]);
  assertEquals(P.matchApproxPools("半导体设备", pools), ["半导体", "半导体设备"]);
  assertEquals(P.matchApproxPools("电力", pools), ["电力设备"]);
  assertEquals(P.matchApproxPools("银行", pools), ["银行"]);
  assertEquals(P.matchApproxPools("酒", pools), []); // 「酒」池名单字，按 guard 不参与匹配
  assertEquals(P.matchApproxPools("机器人", pools), []);
  assertEquals(P.matchApproxPools("", pools), []);
  assertEquals(P.matchApproxPools("有色", null), []);
});

// ---------- 常量表（渲染层与脚注共用） ----------
Deno.test("主题条常量：四个可覆盖主题按 brief 顺序；美国/日本不覆盖；均衡配置不呈现", () => {
  assertEquals(P.SECTOR_THEME_ORDER, ["电力/绿电", "机器人", "新能源车", "全球资源"]);
  assertEquals(P.SECTOR_NOT_COVERED_THEMES, ["美国股票", "日本股票"]);
});
