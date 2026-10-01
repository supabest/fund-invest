// scripts/sector_render_logic_test.ts —— Task 4 前端「板块轮动」卡片纯渲染逻辑单测
// 修复轮1：spec §5 L94「历史不足处理」为权威 —— 代表ETF 上市不足 250 根的行业**参与榜单**
// （显示状态与行业分），pos52/dm20 相关留空，行内标注「数据积累中(n=X)」。上一轮按控制者 Task3
// 派工时的 C3 裁决把累积中行整体排除在双榜外，该裁决已被裁定越界，本文件按 spec 重写榜单期望值。
// 单一事实源：被测函数实现体在 index.html 的 SECTOR_PURE 标记块（README：本工具是单文件 GitHub
// Pages 应用、无构建步骤 ⇒ 页面运行代码不能外置成独立脚本文件）；本测试 import 类型化门面模块
// scripts/sector_render_logic.ts，由该模块抽取标记块，页面与测试共用同一份实现，不存在副本漂移。
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import * as P from "./sector_render_logic.ts";

// deno-lint-ignore no-explicit-any
type Cell = any;
// 夹具行：ind 必有（与 sector_rotation_daily NOT NULL 一致），其余列任意
type Row = { ind: string; [k: string]: Cell };
// deno-lint-ignore no-explicit-any
const row = (o: Cell): Row => ({
  batch_date: "2026-10-01", ind: "x", pk_etf: "000000", n_etf: 1,
  m20: 0, m60: 0, pos52: 50, dev60: 0, vr: 1, mp: 50, dm20: null,
  state: "纠缠", labels: [], score: 50, v: 50, m: 50, l: 50, q: null,
  theme: null, stale: false, ...o,
});
// 与生产一致的 n 口径：Map<pk_etf, n>（index.html 只对累积中的 ≤6 行做 sector_kline head count）
const counts = (o: Record<string, number | null>) => new Map(Object.entries(o));
// 本批（batch_date=2026-10-01，110 行）累积中 6 行的真实 n（SELECT count(*) FROM sector_kline 取证）
const ACC = { "560210": 133, "560710": 157, "158049": 6, "159107": 248, "159141": 196, "589070": 167 };

// ---------- R-T4-1 + 修复轮1：累积中判定 = pos52 === null（严禁 falsy）；退化判定另算 ----------
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

// (a) 累积中行进入正确榜单且带标注 —— spec §5 L94
Deno.test("spec L94: 累积中行并入其 state 所属榜单，按真实 m60 参与排序（不再整体排除在双榜外）", () => {
  const lists = P.sectorRankLists(PROD_ROWS, counts(ACC));
  // 向上榜 12 行（= SQL count(*) state in ('强多头','多头')）：农牧渔 +7.54%(n=133) 第 8、船舶 +5.45%(n=157) 第 11
  assertEquals(lists.up.length, 12);
  assertEquals(lists.up.map((r) => r.ind), [
    "医疗", "银行", "煤炭", "房地产", "油气", "能源", "粮食",
    "农牧渔", "石油", "金融", "船舶", "金融地产",
  ]);
  // 调整榜 74 行（= SQL count(*) state in ('走弱','空头排列')）：科创芯片设计 -27.73% 升到第 5
  assertEquals(lists.down.length, 74);
  assertEquals(lists.down.slice(0, 5).map((r) => r.ind), [
    "工业母机", "半导体龙头", "科创新材料", "机床", "科创芯片设计",
  ]);
  assertEquals(lists.down[8].ind, "科创创业人工智能");
  assertEquals(lists.down[lists.down.length - 1].ind !== "创业板软件", true, "n=248 累积中行按真实值排序，不被无条件压尾");
  // 纠缠 24 行（其中 1 行退化，置底）
  assertEquals(lists.entangled.length, 24);
  // 累积中 6 行仍可单独枚举（供概要「数据积累中 6」注记），但不再独占一个榜单
  assertEquals(lists.accumulating.length, 6);
  assertEquals(lists.accumulating.map((r) => r.ind).sort(), [
    "农牧渔", "船舶", "创业板算力", "创业板软件", "科创创业人工智能", "科创芯片设计",
  ].sort());
});

Deno.test("累积中入榜后行数守恒：双榜 + 纠缠覆盖全部入库行且不重不漏", () => {
  const lists = P.sectorRankLists(PROD_ROWS, counts(ACC));
  const seen = new Map<string, number>();
  [...lists.up, ...lists.down, ...lists.entangled].forEach((r) => {
    seen.set(r.ind, (seen.get(r.ind) ?? 0) + 1);
  });
  assertEquals(seen.size, PROD_ROWS.length); // 110 行各出现一次
  let dup = 0;
  seen.forEach((c) => { if (c > 1) dup++; });
  assertEquals(dup, 0);
});

// (b) 退化行 m60=null 语义且置底、不影响其余行排序
Deno.test("sectorIsDegenerate: 累积中 && n<61（engine pctChange 需 n>60）；n≥61 一律按真实值参与排序", () => {
  const acc = counts({ A: 60, B: 61, C: 133, D: 248, E: 5, F: null });
  assertEquals(P.sectorIsDegenerate(row({ ind: "A", pk_etf: "A", pos52: null }), acc), true, "n=60 仍算不出 m60");
  assertEquals(P.sectorIsDegenerate(row({ ind: "B", pk_etf: "B", pos52: null }), acc), false, "n=61 恰好可算 m60");
  assertEquals(P.sectorIsDegenerate(row({ ind: "C", pk_etf: "C", pos52: null }), acc), false);
  assertEquals(P.sectorIsDegenerate(row({ ind: "D", pk_etf: "D", pos52: null }), acc), false);
  assertEquals(P.sectorIsDegenerate(row({ ind: "E", pk_etf: "E", pos52: null }), acc), true);
  assertEquals(P.sectorIsDegenerate(row({ ind: "F", pk_etf: "F", pos52: null }), acc), true, "head count 失败 ⇒ 保守视为退化，杜绝伪 0 当真涨跌");
});

Deno.test("退化判定只作用于累积中行：pos52 非空（n≥250）即使 accCounts 无该 pk 也不算退化", () => {
  const pos52Zero = row({ ind: "光伏龙头", pk_etf: "159766", pos52: 0, state: "走弱", m60: -0.1 });
  assertEquals(P.sectorIsAccumulating(pos52Zero), false);
  assertEquals(P.sectorIsDegenerate(pos52Zero, new Map()), false);
  assertEquals(P.sectorRowM60(pos52Zero, new Map()), -0.1);
  // m60 恰为 0 且 pos52 非空（本批「旅游」真实如此）= 真实平盘，不得被当成伪 0 隐藏
  const flat = row({ ind: "旅游", pk_etf: "159766", pos52: 3.6066, state: "空头排列", m60: 0 });
  assertEquals(P.sectorIsDegenerate(flat, new Map()), false);
  assertEquals(P.sectorRowM60(flat, new Map()), 0);
});

Deno.test("sectorRowM60: 退化行 → null（Task2 评审 M5：engine 兜底 0 与真实平盘不可区分）", () => {
  const deg = row({ ind: "创业板算力", pk_etf: "158049", pos52: null, state: "纠缠", m20: 0, m60: 0 });
  assertEquals(P.sectorRowM60(deg, counts(ACC)), null);
  const real = row({ ind: "科创芯片设计", pk_etf: "589070", pos52: null, m60: -0.2773 });
  assertEquals(P.sectorRowM60(real, counts(ACC)), -0.2773);
  assertEquals(P.sectorRowM60(row({ m60: null }), new Map()), null);
});

Deno.test("退化行置于所属榜末尾，且不改变其余行的相对次序", () => {
  const rows = [
    row({ ind: "多头甲", pk_etf: "01", state: "多头", m60: 0.02 }),
    row({ ind: "退化多头", pk_etf: "02", state: "多头", m60: 0, pos52: null }),
    row({ ind: "多头乙", pk_etf: "03", state: "多头", m60: 0.05 }),
    row({ ind: "多头丙", pk_etf: "04", state: "多头", m60: 0.01 }),
  ];
  const acc = counts({ "02": 6 });
  assertEquals(P.sectorRankLists(rows, acc).up.map((r) => r.ind), ["多头乙", "多头甲", "多头丙", "退化多头"]);
  // 纠缠组的退化行同样置底（本批创业板算力 state=纠缠，正属此情形）
  const eRows = [
    row({ ind: "纠缠甲", pk_etf: "11", state: "纠缠" }),
    row({ ind: "退化纠缠", pk_etf: "158049", state: "纠缠", pos52: null }),
    row({ ind: "纠缠乙", pk_etf: "12", state: "纠缠" }),
  ];
  assertEquals(P.sectorRankLists(eRows, acc).entangled.map((r) => r.ind), ["纠缠甲", "纠缠乙", "退化纠缠"]);
  assertEquals(P.sectorRankLists(eRows, acc).up.length, 0);
});

// (c) pos52=0 有效值：正常入榜出分位，且不被误判退化
Deno.test("pos52=0 行照常入榜并出分位 0.0（反 falsy 回归防线）", () => {
  const rows = [
    row({ ind: "信创", pk_etf: "001", state: "走弱", m60: -0.1, pos52: 0 }),
    row({ ind: "计算机", pk_etf: "002", state: "走弱", m60: -0.2, pos52: 0 }),
  ];
  const lists = P.sectorRankLists(rows, new Map());
  assertEquals(lists.down.map((r) => r.ind), ["计算机", "信创"]);
  assertEquals(lists.accumulating.length, 0);
  assertEquals(P.fmtPoints(lists.down[0].pos52), "0.0");
});

// (d) 概要单一口径 + 一致性断言
Deno.test("概要口径与 SQL 实测一致：向上 12 / 纠缠 24 / 调整 74（入库行 state 实数），数据积累中 6 为并列注记", () => {
  const c = P.sectorSummaryCounts(PROD_ROWS, counts(ACC));
  assertEquals(c.up, 12); // SELECT count(*) WHERE state in ('强多头','多头') = 2 + 10
  assertEquals(c.entangled, 24); // WHERE state = '纠缠'
  assertEquals(c.down, 74); // WHERE state in ('走弱','空头排列') = 7 + 67
  assertEquals(c.accumulating, 6); // WHERE pos52 IS NULL
  assertEquals(c.degenerate, 1); // n<61：创业板算力 n=6
  assertEquals(c.total, 110);
});

Deno.test("一致性：三数之和 == 总行数；(剔除退化行后的三数) + 退化行数 == 总行数；概要与榜长同源", () => {
  const c = P.sectorSummaryCounts(PROD_ROWS, counts(ACC));
  assertEquals(c.up + c.entangled + c.down, c.total);
  assertEquals(c.rankable.up + c.rankable.entangled + c.rankable.down + c.degenerate, c.total);
  assertEquals(c.rankable.up, 12); // 本批退化行落在纠缠组
  assertEquals(c.rankable.entangled, 23);
  assertEquals(c.rankable.down, 74);
  const lists = P.sectorRankLists(PROD_ROWS, counts(ACC));
  assertEquals(c.up, lists.up.length, "同一卡片内概要数字与榜单行数必须同源，不得两处打架");
  assertEquals(c.entangled, lists.entangled.length);
  assertEquals(c.down, lists.down.length);
});

// (e) 累积中/退化行单元格留空口径 + 比率字段 ×100 格式化
Deno.test("sectorDisplayMetrics: 累积中行 pos52/dm20 → null；n≥61 保留真实 20/60日/乖离；退化行 dev60/m20/m60 → null", () => {
  const nm133 = P.sectorDisplayMetrics(
    row({ ind: "农牧渔", pk_etf: "560210", state: "多头", pos52: null, dm20: null, m20: -0.0384, m60: 0.0754, dev60: 0.0224, vr: 0.9497 }),
    counts(ACC),
  );
  assertEquals(nm133.barsN, 133);
  assertEquals(nm133.accumulating, true);
  assertEquals(nm133.degenerate, false);
  assertEquals(nm133.m20, -0.0384);
  assertEquals(nm133.m60, 0.0754);
  assertEquals(nm133.dev60, 0.0224);
  assertEquals(nm133.pos52, null);
  assertEquals(nm133.dm20, null);
  assertEquals(P.fmtRatioPct(nm133.m60), "+7.54%");
  assertEquals(P.fmtPoints(nm133.pos52), "—");
  assertEquals(P.fmtPoints(nm133.dm20), "—");

  const deg = P.sectorDisplayMetrics(
    row({ ind: "创业板算力", pk_etf: "158049", state: "纠缠", pos52: null, m20: 0, m60: 0, dev60: -0.0466, vr: null }),
    counts(ACC),
  );
  assertEquals(deg.degenerate, true);
  assertEquals(deg.barsN, 6);
  assertEquals(deg.m20, null);
  assertEquals(deg.m60, null);
  assertEquals(deg.dev60, null, "乖离基准 ma60 本身是部分窗口 ⇒ 一并留空，不呈现伪精度");
  assertEquals(P.fmtRatioPct(deg.m60), "—");

  const normal = P.sectorDisplayMetrics(row({ ind: "银行", pk_etf: "512800", pos52: 97.541, dm20: 12.5, m60: 0.1238 }), new Map());
  assertEquals(normal.accumulating, false);
  assertEquals(normal.degenerate, false);
  assertEquals(normal.pos52, 97.541);
  assertEquals(normal.dm20, 12.5);
});

Deno.test("sectorSplitDegenerate: 拆分保序、不改入参数组", () => {
  const rows = [row({ ind: "a", pk_etf: "1", pos52: null }), row({ ind: "b", pk_etf: "2" })];
  const s = P.sectorSplitDegenerate(rows, counts({ "1": 30 }));
  assertEquals(s.degenerate.map((r) => r.ind), ["a"]);
  assertEquals(s.ranked.map((r) => r.ind), ["b"]);
  assertEquals(rows.length, 2);
});

// ---------- 状态集合常量（spec §4.3）----------
Deno.test("SECTOR_UP_STATES / SECTOR_DOWN_STATES / 纠缠态常量与 spec §4.3 一致", () => {
  assertEquals(P.SECTOR_UP_STATES, ["强多头", "多头"]);
  assertEquals(P.SECTOR_DOWN_STATES, ["走弱", "空头排列"]);
  assertEquals(P.SECTOR_ENTANGLED_STATE, "纠缠");
});

Deno.test("SECTOR_M60_MIN_BARS / SECTOR_MA_FULL_BARS 门槛取自 engine 的可算条件（pctChange n>60 / 均线满窗 120）", () => {
  assertEquals(P.SECTOR_M60_MIN_BARS, 61);
  assertEquals(P.SECTOR_MA_FULL_BARS, 120);
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
  assertEquals(P.sectorWorstRow(rows)!.ind, "稀土");
  assertEquals(P.sectorWorstRow([]), null);
  assertEquals(P.sectorWorstRow(null), null);
});

Deno.test("累积中行同样参与主题最差状态（spec L94：显示状态与行业分，不被主题条忽略）", () => {
  const rows = [
    row({ ind: "绿色电力", state: "空头排列", theme: "电力/绿电", pos52: null, m60: -0.3 }),
    row({ ind: "电力", state: "多头", theme: "电力/绿电", m60: 0.0218 }),
  ];
  const sums = P.sectorThemeSummaries(rows, ["电力/绿电"]);
  assertEquals(sums[0].worst!.ind, "绿色电力");
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
  assertEquals(g.get("全球资源")!.length, 2);
  const sums = P.sectorThemeSummaries(rows, ["电力/绿电", "机器人", "新能源车", "全球资源"]);
  assertEquals(sums.length, 4);
  assertEquals(sums[0].worst!.ind, "绿色电力"); // 同空头排列取 m60 更低（0.0204 < 0.0218）
  assertEquals(sums[0].rows.map((r) => r.ind), ["电力", "绿色电力"]);
  assertEquals(sums[1].worst!.state, "空头排列");
  assertEquals(sums[2].worst, null); // 本批次无映射行业 → 由渲染层降级显示
  assertEquals(sums[2].theme, "新能源车");
  assertEquals(sums[3].worst!.state, "空头排列");
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

// ---------- 生产批次镜像夹具（数值取自只读取证，见 task-4-report.md 修复轮1 §1）----------
// deno-lint-ignore no-explicit-any
function prodRow(ind: string, state: string, m60: number, pk: string, pos52: Cell, extra: Cell = {}): Row {
  return row({
    ind, state, m60, pk_etf: pk, pos52, m20: 0.01, dev60: 0.01, dm20: null, vr: 0.9, score: 60,
    ...extra,
  });
}
const PROD_ROWS: Row[] = (() => {
  const up = [
    prodRow("医疗", "强多头", 0.1405, "512170", 56.3107),
    prodRow("银行", "强多头", 0.1238, "512800", 97.541),
    prodRow("煤炭", "多头", 0.1135, "515220", 56.7164),
    prodRow("房地产", "多头", 0.1102, "512200", 33.2707),
    prodRow("油气", "多头", 0.0987, "159309", 46.6667),
    prodRow("能源", "多头", 0.089, "159930", 62.5413),
    prodRow("粮食", "多头", 0.0875, "159698", 22.8205),
    prodRow("农牧渔", "多头", 0.0754, "560210", null, { m20: -0.0384, dev60: 0.0224, vr: 0.9497, score: 64.02 }),
    prodRow("石油", "多头", 0.0697, "561360", 45.2292),
    prodRow("金融", "多头", 0.0556, "510230", 44.856),
    prodRow("船舶", "多头", 0.0545, "560710", null, { m20: 0.0372, dev60: 0.0446, vr: 0.9985, score: 61 }),
    prodRow("金融地产", "多头", 0.0508, "159940", 41.7476),
  ];
  const deep = [
    ["工业母机", "空头排列", -0.2872], ["半导体龙头", "空头排列", -0.2845],
    ["科创新材料", "空头排列", -0.2806], ["机床", "空头排列", -0.2796],
    ["科创芯片", "走弱", -0.2688], ["半导体", "走弱", -0.2614], ["半导体设备", "走弱", -0.2551],
  ].map((t: Cell) => prodRow(String(t[0]), String(t[1]), Number(t[2]), "D" + String(t[0]), 40));
  // 其余真实调整行 64 条（m60 ∈ [-0.111, -0.048]，均高于三条累积中行的最深跌幅档）
  const tail: Row[] = [];
  for (let i = 0; i < 64; i++) {
    tail.push(prodRow("调整真实" + i, i % 2 ? "走弱" : "空头排列", -0.048 - i * 0.001, "Z" + i, 50));
  }
  const downAcc = [
    prodRow("科创芯片设计", "空头排列", -0.2773, "589070", null, { m20: -0.0708, dev60: -0.0842, vr: 1.6531, score: 31.52 }),
    prodRow("科创创业人工智能", "空头排列", -0.2066, "159141", null, { m20: -0.0571, dev60: -0.0831, vr: 0.7066, score: 42.59 }),
    prodRow("创业板软件", "空头排列", -0.0613, "159107", null, { m20: -0.0845, dev60: -0.0534, vr: 0.7557, score: 58.22 }),
  ];
  const down = [...deep, ...tail, ...downAcc];
  const entangled: Row[] = [];
  for (let i = 0; i < 23; i++) {
    entangled.push(row({ ind: "纠缠真实" + i, pk_etf: "E" + i, state: "纠缠", pos52: 50, m60: 0.001 * i }));
  }
  entangled.push(row({
    ind: "创业板算力", pk_etf: "158049", state: "纠缠", pos52: null, m20: 0, m60: 0,
    dev60: -0.0466, vr: null, dm20: null, score: 37.01,
  }));
  const all = [...up, ...down, ...entangled];
  if (all.length !== 110) throw new Error("夹具行数应等于本批入库行数 110，实为 " + all.length);
  return all;
})();
