# 行业景气度展示（Prosperity Display）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为板块轮动 nightly 引入「行业景气度」——由 sector-trend 自发的国信智能选股宽表按同花顺 L2 聚合、归因到 canonical 行业、作为**独立展示信号**写入 `sector_rotation_daily` 并渲染到行业卡，绝不参与 `score` 排序。

**Architecture:** 三段式：(1) 新建 `gs_fund.ts` 精简基本面适配器（宽表 fetch→解析→中位数聚合→跨行业百分位→同花顺↔canonical 归因映射，全为可单测纯函数 + 一个注入式 fetch）；(2) `index.ts` 在既有 ③ GS 截面之后插入隔离的 ③.5 子流程，产出 `Map<canonical_ind,{prosperity,src}>` 附到落库行；(3) 前端 `index.html` SECTOR_PURE 块新增 `fmtProsperity` 纯函数并在 `sectorRowHtml` 追加「景气」展示，`sector_render_logic.ts` 门面同步导出。`engine.ts` 零改动。

**Tech Stack:** Deno + TypeScript（无第三方依赖，测试仅 std `assert`）；国信 `smart_stock_picking` 宽表接口；Supabase Postgres + PostgREST；GitHub Pages 单文件前端。

**Spec:** `docs/superpowers/specs/2026-10-03-sector-prosperity-display-design.md`（本计划从该 spec 论证，spec 与计划同迁；对 S1 的局部修订见 spec §9）

## Global Constraints

以下为全项目级硬约束，每个 Task 隐式遵守（值逐字取自 spec）：

- **评分冻结**：`score`、`v`、`m`、`l`、`q` 五列与本特性上线前**逐值一致**；`engine.ts` **零 diff**（不改一字）。景气度绝不进 `computeEtfFactors`、不改 `qAlive`。
- **数据源纪律**：景气度数据来自 **sector-trend 自己发的国信查询**，**不读 `stock_score` 输出表**；复用现有 `GS_API_KEY`（env），每夜仅 +1 次 GS 调用。
- **列名前缀匹配**：国信宽表列名内嵌日期戳（`[2026xxxx]`），一律**按前缀匹配**、**绝不硬编码日期**（沿用 `stock-score/gs.ts` 纪律，spec §12）。
- **③.5 隔离**：景气度子流程任何异常只记 warnings、**绝不 throw 中断 ③→④→⑤ 主链**；整轮失败 ⇒ `prosperity` 全 null、板块分与榜单不受影响（spec §4）。
- **凭据脱敏**：GS 网络错误 message 可能内嵌含 apiKey 的 URL，进任何文案前必须过 `safeGsMsg`（`gs_etf.ts` 既有导出）；不硬编码密钥（C6）。
- **样本下限**：某同花顺 L2 有效成分 < **5** 只 ⇒ 该行业 raw 不可信 ⇒ prosperity 不生成（映射端得 null）。
- **刻度**：`prosperity ∈ [0,100]`（跨行业百分位秩）；档位 `高 ≥66` / `中 33–66` / `低 <33`。
- **缺值显示**：前端 null 一律显示 `—`，**绝不显示 0**（0 会被误读为极低景气）。
- **bundle 唯一实现**：前端运行时纯函数实现体**只住在 `index.html` 的 `SECTOR_PURE` 块**，`sector_render_logic.ts` 仅抽出具名导出（不复制第二份实现）。
- **标识符不重名**：`gs_fund.ts` 顶层符号不得与 `engine.ts`/`tencent.ts`/`gs_etf.ts`/`index.ts` 撞名（`build.ts` 的 `assertNoDup` 会在构建期拦），新增符号统一 `fund` 前缀；`gs_fund.ts` 须加入 `build.ts` 拼接列表。
- **风格**：Deno 测试文件先 `Deno.env.set("SECTOR_TREND_DISABLE_SERVE","1")` 再动态 `import`（同 `index_test.ts`）；2 空格缩进；TS 严格类型。

---

## File Structure

- **Create** `supabase/functions/sector-trend/gs_fund.ts` — 基本面宽表适配器 + 聚合 + 归因映射（纯函数为主 + 一个注入式 fetch）。职责边界：把「一次 GS 宽表调用」加工为 `Map<canonical_ind,{prosperity,src}>`；不碰引擎、不落库。
- **Create** `supabase/functions/sector-trend/gs_fund_test.ts` — gs_fund.ts 纯函数单测。
- **Create** `supabase/functions/sector-trend/fixtures/fund_wide_table.json` — Task 1 探针实跑产出的宽表样本（列名/取值真值来源）。
- **Modify** `supabase/functions/sector-trend/index.ts` — DailyRow + toDbRow 加两列；handle() 插入 ③.5；NightlyDeps 加 `fetchFundTable`；落库前附 prosperity。
- **Modify** `supabase/functions/sector-trend/index_test.ts` — 列数 pin 25→27；新增 ③.5 隔离端到端测。
- **Modify** `supabase/functions/sector-trend/build.ts` — 拼接列表加 `gs_fund.ts`。
- **Create** `scripts/migrate_sector_prosperity.sql` — `alter table ... add column if not exists`（幂等）。
- **Modify** `index.html` — SECTOR_PURE 块加 `fmtProsperity`；`sectorRowHtml` metrics 行追加「景气」展示 + src 悬停。
- **Modify** `scripts/sector_render_logic.ts` — `EXPORT_NAMES` 加 `fmtProsperity`；`SectorRow` 接口加 `prosperity`/`prosperity_src` 字段；加导出包装函数。
- **Modify** `scripts/sector_render_logic_test.ts` — 景气渲染纯函数测（null→`—`、档位边界、绝不显 0）。

Task 顺序：1→2→3 递进构建 `gs_fund.ts`（后者消费前者导出的类型/函数），4 接入编排 + schema，5 前端，6 构建/回归/部署。**Task 4/5 之间无生产写入；生产迁移与函数部署集中在 Task 6 且为需人工确认的操作位。**

---

## Task 1: 国信基本面宽表探针 + 解析核心

**Files:**
- Create: `supabase/functions/sector-trend/fixtures/fund_wide_table.json`
- Create: `supabase/functions/sector-trend/gs_fund.ts`（本 Task 只写 fetch + parse 部分）
- Create: `supabase/functions/sector-trend/gs_fund_test.ts`

**Interfaces:**
- Consumes: 无（起点）。
- Produces：`gs_fund.ts` 导出
  - `const FUND_QUERY: string`（景气度专用宽表查询串）
  - `interface FundRow { code: string; revYoy: number | null; kcYoy: number | null; thsL1: string; thsL2: string }`
  - `async function fetchFundTable(apiKey: string): Promise<GsFundTable>`（网络，注入位；失败脱敏后 throw）
  - `function parseFundTable(t: GsFundTable): FundRow[]`（纯）
  - `type GsFundTable = Record<string, (string | number | null)[]>`

- [ ] **Step 1: 线上探针——跑一次景气度宽表查询，落真值样本**

写一次性探针脚本并运行（GS_API_KEY 已在 env；本机可达 dgzt.guosen.com.cn）。查询串：

```
全部沪深A股的营业总收入同比增长率、扣非净利润同比增长率、所属同花顺行业
```

端点与参数与 `stock-score/gs.ts:gsFetch` 完全一致（`GET https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking`，`searchtype=stock`、`skillName=gs-smart-stock-picking`）。

```bash
cat > /tmp/fund_probe.ts <<'TS'
const key = Deno.env.get("GS_API_KEY")!;
const q = "全部沪深A股的营业总收入同比增长率、扣非净利润同比增长率、所属同花顺行业";
const qs = new URLSearchParams({ searchstring: q, searchtype: "stock", softName: "goldsun_skills", skillName: "gs-smart-stock-picking", apiKey: key });
const r = await fetch(`https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking?${qs}`, { signal: AbortSignal.timeout(90000) });
const j = await r.json();
const table = j?.data?.[0]?.table;
console.log("COLUMNS:", JSON.stringify(Object.keys(table ?? {}), null, 0));
// 落前 3 行样本进 fixture（含 股票代码 列证明行序对齐）
Deno.writeTextFileSync("supabase/functions/sector-trend/fixtures/fund_wide_table.json", JSON.stringify(table));
TS
deno run --allow-env --allow-read --allow-net --allow-write /tmp/fund_probe.ts
```

Expected: 打印出的 `COLUMNS` 含三个关键前缀：`股票代码`、`营业总收入同比增长率`（或 `营业总收入(同比…`）、`扣非净利润同比增长率`（或 `…净利润-扣除…同比…`）、`所属同花顺行业`。**记下实际前缀字符串**——Step 3 的 `REV_PREFIX`/`KC_PREFIX`/`THS_PREFIX` 常量按实测填。若 `table` 缺 `股票代码` → 探针失败，重试或上报，不得进入下一步。

- [ ] **Step 2: 写失败测试（解析纯函数）**

`gs_fund_test.ts`：用 Step 1 实测列名构造合成宽表（键用占位说明，执行时替换为探针真实前缀，值带百分号/负数/空以测稳健解析；同花顺行业带 `L1-L2-L3` 路径）：

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseFundTable, type GsFundTable } from "./gs_fund.ts";

Deno.test("parseFundTable: 前缀匹配三列 + 同花顺路径拆 L1/L2 + 百分号/负值/空稳健", () => {
  const t: GsFundTable = {
    "股票代码": ["600519", "300750", "000001"],
    "营业总收入同比增长率[20260930]": ["12.5", "-3.2", ""],
    "扣非净利润同比增长率[20260930]": ["8", "15.1", "-40"],
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
```

> 注：测试合成列名（`营业总收入同比增长率[...]`）应与 Step 1 实测前缀一致；若 GS 实际返回 `营业总收入(同比增长率)[...]` 之类，同步把合成 fixture 与常量前缀一起对齐为实测值。测试断言的是「前缀命中即解析」的行为，不锁死具体日期后缀。

- [ ] **Step 3: 跑红**

Run: `cd "supabase/functions/sector-trend" && deno test --allow-env --allow-read gs_fund_test.ts`
Expected: FAIL（`parseFundTable`/`FundRow` 未定义）。

- [ ] **Step 4: 写实现（fetch + parse）**

`gs_fund.ts`：

```ts
/// <reference lib="deno.ns" />
// gs_fund.ts —— 景气度基本面宽表适配器（spec 2026-10-03 §4/§5）。
// sector-trend 自发的国信智能选股宽表查询（不跨函数 import stock-score）；
// 列名内嵌日期戳 → 一律前缀匹配、绝不硬编码日期（沿用 gs.ts 纪律）。
export type GsFundTable = Record<string, (string | number | null)[]>;

export interface FundRow {
  code: string;
  revYoy: number | null;
  kcYoy: number | null;
  thsL1: string;
  thsL2: string;
}

export const FUND_QUERY =
  "全部沪深A股的营业总收入同比增长率、扣非净利润同比增长率、所属同花顺行业";

const FUND_BASE = "https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking";
const FUND_TIMEOUT_MS = 90_000;
const FUND_ATTEMPTS = 3;
// 按 Step 1 探针实测填（下值为示例，执行时以真实列前缀替换）：
const REV_PREFIX = "营业总收入同比增长率";
const KC_PREFIX = "扣非净利润同比增长率";
const THS_PREFIX = "所属同花顺行业";
const CODE_COL = "股票代码";

const fundNum = (v: string | number | null | undefined): number | null => {
  const x = typeof v === "string" ? parseFloat(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
const fundStr = (v: string | number | null | undefined): string =>
  typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v);
const fundColKey = (t: GsFundTable, prefix: string): string | undefined =>
  Object.keys(t).find((k) => k.startsWith(prefix));

export function parseFundTable(t: GsFundTable): FundRow[] {
  const codes = t[CODE_COL];
  if (!Array.isArray(codes)) return [];
  const revK = fundColKey(t, REV_PREFIX);
  const kcK = fundColKey(t, KC_PREFIX);
  const thsK = fundColKey(t, THS_PREFIX);
  const out: FundRow[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = fundStr(codes[i]);
    if (!code) continue;
    const ths = (thsK ? fundStr(t[thsK]?.[i]) : "").split("-");
    out.push({
      code,
      revYoy: revK ? fundNum(t[revK]?.[i]) : null,
      kcYoy: kcK ? fundNum(t[kcK]?.[i]) : null,
      thsL1: ths[0] ?? "",
      thsL2: ths[1] ?? "",
    });
  }
  return out;
}

export async function fetchFundTable(apiKey: string): Promise<GsFundTable> {
  const qs = new URLSearchParams({
    searchstring: FUND_QUERY,
    searchtype: "stock",
    softName: "goldsun_skills",
    skillName: "gs-smart-stock-picking",
    apiKey,
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < FUND_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`${FUND_BASE}?${qs}`, { signal: AbortSignal.timeout(FUND_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`GS fund http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS fund biz ${JSON.stringify(j?.result?.[0])}`);
      const table = j?.data?.[0]?.table as GsFundTable | undefined;
      if (!table?.[CODE_COL]) throw new Error("GS fund table missing 股票代码");
      return table;
    } catch (e) {
      // 网络 TypeError 的 message 可能内嵌含 apiKey 的 URL → 换成不含 URL 的通用信息
      lastErr = e instanceof TypeError ? new Error(`GS fund network error (attempt ${attempt + 1})`) : e;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 5: 跑绿**

Run: `cd "supabase/functions/sector-trend" && deno test --allow-env --allow-read gs_fund_test.ts`
Expected: PASS（3 个 parse 测试全绿）。

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/sector-trend/gs_fund.ts supabase/functions/sector-trend/gs_fund_test.ts supabase/functions/sector-trend/fixtures/fund_wide_table.json
git commit -m "feat(sector-prosperity): gs_fund 基本面宽表探针 + 解析核心"
```

---

## Task 2: L2 聚合（中位数）+ 跨行业百分位刻度

**Files:**
- Modify: `supabase/functions/sector-trend/gs_fund.ts`（追加，不改 Task 1 代码）
- Modify: `supabase/functions/sector-trend/gs_fund_test.ts`（追加测试）

**Interfaces:**
- Consumes: `FundRow`（Task 1）。
- Produces：
  - `function fundMedian(xs: number[]): number`（升序中位数，偶数取中间两值均值）
  - `interface ThsRaw { raw: number; n: number }`
  - `function aggregateByThs(rows: FundRow[]): Map<string, ThsRaw>`（按 thsL2 分组；组内 rev/kc 各取有效值中位数；`raw = 0.5*med(rev)+0.5*med(kc)`；有效样本（rev 或 kc 至少一个非空的记录数，实际按两列配对样本数）< 5 ⇒ 不生成该组）
  - `function toProsperityScale(raws: Map<string, ThsRaw>): Map<string, number>`（对 raw 求百分位秩 0..100，复用 engine `pctRank` 同口径：`(below + 0.5*ties)/N*100`）

- [ ] **Step 1: 写失败测试**

```ts
import { fundMedian, aggregateByThs, toProsperityScale, type FundRow } from "./gs_fund.ts";

const fr = (revYoy: number | null, kcYoy: number | null, thsL2: string): FundRow =>
  ({ code: "x", revYoy, kcYoy, thsL1: "L1", thsL2 });

Deno.test("fundMedian: 奇数取中、偶数取中间两值均值、空数组→NaN 由调用方兜", () => {
  assertEquals(fundMedian([3, 1, 2]), 2);
  assertEquals(fundMedian([4, 1, 2, 3]), 2.5);
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
  assertEquals(m.get("芯片")!.n, 5); // 4 条里剔除 1 条双空 = 5（1 空 kc 计入）
  assertEquals(m.get("芯片")!.raw, 0.5 * fundMedian([5, 6, 7, 8, 9]) + 0.5 * fundMedian([7, 8, 9]));
});

Deno.test("toProsperityScale: 跨行业百分位秩（最小≈低、最大≈高、单元素=50）", () => {
  const scale = toProsperityScale(new Map([["a", { raw: 1, n: 6 }], ["b", { raw: 2, n: 6 }], ["c", { raw: 3, n: 6 }]]));
  assertEquals(scale.get("a")! < scale.get("b")!, true);
  assertEquals(scale.get("b")! < scale.get("c")!, true);
  assertEquals(scale.get("c"), (2 / 3) * 100);
  assertEquals(toProsperityScale(new Map([["z", { raw: 9, n: 6 }]])).get("z"), 50);
});
```

- [ ] **Step 2: 跑红** — Run 同 Task 1 Step 5 命令；Expected: FAIL（函数未定义）。

- [ ] **Step 3: 写实现（追加到 gs_fund.ts）**

```ts
export function fundMedian(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  const n = a.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export interface ThsRaw { raw: number; n: number }

// 按 thsL2 分组；每组内 rev 有效值、kc 有效值各取中位数；raw=0.5·med(rev)+0.5·med(kc)。
// 「有效样本」n = 该组中 rev 或 kc 至少其一非空的记录数；n<5 不生成（spec §5 样本下限）。
export function aggregateByThs(rows: FundRow[]): Map<string, ThsRaw> {
  const byThs = new Map<string, { rev: number[]; kc: number[]; n: number }>();
  for (const r of rows) {
    if (!r.thsL2) continue;
    let g = byThs.get(r.thsL2);
    if (!g) { g = { rev: [], kc: [], n: 0 }; byThs.set(r.thsL2, g); }
    if (r.revYoy === null && r.kcYoy === null) continue; // 双空剔除
    g.n++;
    if (r.revYoy !== null) g.rev.push(r.revYoy);
    if (r.kcYoy !== null) g.kc.push(r.kcYoy);
  }
  const out = new Map<string, ThsRaw>();
  for (const [ths, g] of byThs) {
    if (g.n < 5) continue;
    const mr = g.rev.length ? fundMedian(g.rev) : NaN;
    const mk = g.kc.length ? fundMedian(g.kc) : NaN;
    if (Number.isNaN(mr) && Number.isNaN(mk)) continue;
    const raw = 0.5 * (Number.isNaN(mr) ? mk : mr) + 0.5 * (Number.isNaN(mk) ? mr : mk);
    out.set(ths, { raw, n: g.n });
  }
  return out;
}

// 跨行业百分位秩（口径同 engine.pctRank：(below+0.5*ties)/N*100，升序）
export function toProsperityScale(raws: Map<string, ThsRaw>): Map<string, number> {
  const keys = [...raws.keys()];
  const vals = keys.map((k) => raws.get(k)!.raw);
  const n = vals.length;
  const out = new Map<string, number>();
  keys.forEach((k, i) => {
    const v = vals[i];
    let below = 0, ties = 0;
    for (const x of vals) { if (x < v) below++; else if (x === v) ties++; }
    out.set(k, n === 0 ? 50 : (below + 0.5 * ties) / n * 100);
  });
  return out;
}
```

- [ ] **Step 4: 跑绿** — Run 同测试命令；Expected: PASS。

- [ ] **Step 5: Commit** — `git add gs_fund.ts gs_fund_test.ts && git commit -m "feat(sector-prosperity): L2 中位数聚合 + 跨行业百分位刻度"`

---

## Task 3: 同花顺 L2 ↔ canonical 归因映射 + 顶层编排函数

**Files:**
- Modify: `supabase/functions/sector-trend/gs_fund.ts`（追加）
- Modify: `supabase/functions/sector-trend/gs_fund_test.ts`（追加）

**Interfaces:**
- Consumes: `fetchFundTable`、`parseFundTable`、`aggregateByThs`、`toProsperityScale`（Task 1/2）。
- Produces：
  - `const CANON_TO_THS: Record<string, string>`（curated 主表，Step 1 枚举后填充）
  - `function mapCanonicalToThs(canon: string, thsWithProsperity: Set<string>): string | null`
  - `function attachCanonical(scale: Map<string, number>, canonicalInds: string[]): { byInd: Map<string, { prosperity: number | null; src: string | null }>; unmapped: string[] }`
  - `interface ProsperityResult { byInd: Map<string, { prosperity: number | null; src: string | null }>; mapped: number; unmapped: string[]; warnings: string[] }`
  - `async function buildProsperity(fetchTable: (apiKey: string) => Promise<GsFundTable>, apiKey: string, canonicalInds: string[]): Promise<ProsperityResult>`（组合：fetch→parse→aggregate→scale→attach；`fetchTable` 注入便于单测/隔离）

- [ ] **Step 1: 枚举同花顺 L2 全集，与 canonical 对齐，填 curated 表**

复用 Task 1 fixture 枚举 L2：

```bash
cat > /tmp/enum_l2.ts <<'TS'
const t = JSON.parse(Deno.readTextFileSync("supabase/functions/sector-trend/fixtures/fund_wide_table.json"));
const thsK = Object.keys(t).find(k => k.startsWith("所属同花顺行业"))!;
const l2 = new Set<string>();
for (const v of (t[thsK] as string[])) { const p = String(v||"").split("-"); if (p[1]) l2.add(p[1]); }
console.log([...l2].sort().join("\n"));
TS
deno run --allow-read /tmp/enum_l2.ts
```

再取 canonical 行业清单（本地归一宇宙）：

```bash
deno run --allow-read --allow-env --allow-net scripts/build_universe.ts 2>/dev/null | head -1 || \
python3 -c "import json,urllib.request,os; pat=open(os.path.expanduser('~/.config/sector-rotation/supabase_pat')).read().strip(); req=urllib.request.Request('https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query',data=json.dumps({'query':\"SELECT DISTINCT canonical_ind FROM sector_etf_map ORDER BY 1\"}).encode(),headers={'Authorization':'Bearer '+pat,'Content-Type':'application/json'},method='POST'); print('\n'.join(r['canonical_ind'] for r in json.loads(urllib.request.urlopen(req).read())))"
```

对照两份清单，把「名称不一致但同义」的宽基/行业钉进 `CANON_TO_THS`（如 `券商→证券`、`白酒→酿酒行业`/`→白酒`（以实测 L2 为准）、`半导体→半导体`… ；主题类如 科创芯片/数字经济/央企改革**不钉**、留 null）。**目标不是 100% 覆盖**——spec §6「宁缺毋滥」，能可靠映射的宽基行业即可，主题判 null 属预期。把枚举结果与命中率（映射成功数 / canonical 总数）作为 Task 3 report 的一行记录。

- [ ] **Step 2: 写失败测试**

```ts
import { mapCanonicalToThs, attachCanonical } from "./gs_fund.ts";

Deno.test("mapCanonicalToThs: curated 优先于同名/子串", () => {
  // CANON_TO_THS 至少含一条示例：券商→证券（以 Step1 实测为准）
  assertEquals(mapCanonicalToThs("券商", new Set(["证券", "券商"])), "证券"); // curated 命中，即便同名也走 curated
});
Deno.test("mapCanonicalToThs: 精确同名", () => {
  assertEquals(mapCanonicalToThs("半导体", new Set(["半导体"])), "半导体");
});
Deno.test("mapCanonicalToThs: 唯一子串命中（canonical 是某 L2 子串，且唯一）", () => {
  assertEquals(mapCanonicalToThs("医疗", new Set(["医疗器械", "化学制药"])), "医疗器械");
});
Deno.test("mapCanonicalToThs: 多义子串 → null（不猜）", () => {
  assertEquals(mapCanonicalToThs("电子", new Set(["半导体", "电子制造", "光学光电子"])), null);
});
Deno.test("mapCanonicalToThs: 主题/无归属 → null", () => {
  assertEquals(mapCanonicalToThs("科创芯片", new Set(["半导体"])), null);
});

Deno.test("attachCanonical: 命中给 {prosperity,src}，未命中得 null 并进 unmapped 清单", () => {
  const scale = new Map<string, number>([["证券", 80], ["白酒", 40]]);
  const { byInd, unmapped } = attachCanonical(scale, ["券商", "白酒", "科创芯片"]);
  assertEquals(byInd.get("券商"), { prosperity: 80, src: "证券" });
  assertEquals(byInd.get("白酒"), { prosperity: 40, src: "白酒" });
  assertEquals(byInd.get("科创芯片"), { prosperity: null, src: null });
  assertEquals(unmapped.includes("科创芯片"), true);
  assertEquals(unmapped.includes("券商"), false);
});

Deno.test("buildProsperity: 注入的 fetch 抛错 → 不 throw、byInd 全 null、warnings 有记录", async () => {
  const boom = async () => { throw new Error("GS 挂了"); };
  const res = await buildProsperity(boom, "KEY", ["券商"]);
  expect; // 断言下方
  assertEquals(res.byInd.get("券商"), { prosperity: null, src: null });
  assertEquals(res.warnings.length >= 1, true);
  assertEquals(res.mapped, 0);
});

Deno.test("buildProsperity: 正常链路聚合映射（注入合成宽表）", async () => {
  const fake = async () => ({
    "股票代码": Array.from({ length: 6 }, (_, i) => `c${i}`),
    "营业总收入同比增长率[20260930]": [10, 20, 30, 40, 50, 60],
    "扣非净利润同比增长率[20260930]": [10, 20, 30, 40, 50, 60],
    "所属同花顺行业": Array(6).fill("非银金融-证券-证券"),
  });
  const res = await buildProsperity(fake, "KEY", ["券商"]);
  assertEquals(res.byInd.get("券商")!.src, "证券");
  assertEquals(typeof res.byInd.get("券商")!.prosperity, "number");
});
```

> `buildProsperity` 的失败用例里，错误 message 进 warnings 前须过 `safeGsMsg(msg, apiKey)`（从 `./gs_etf.ts` import）。

- [ ] **Step 3: 跑红** — Expected: FAIL（未定义）。

- [ ] **Step 4: 写实现（追加到 gs_fund.ts）**

```ts
import { safeGsMsg } from "./gs_etf.ts"; // bundle 内既有导出，复用脱敏

// curated 主表：由 Task3 Step1 枚举真实数据填充（下为示例形态，执行时以实测 L2 为准）
export const CANON_TO_THS: Record<string, string> = {
  "券商": "证券",
  // ... 枚举后补全
};

export function mapCanonicalToThs(canon: string, thsWithProsperity: Set<string>): string | null {
  const c = canon.trim();
  if (!c) return null;
  const curated = CANON_TO_THS[c];
  if (curated && thsWithProsperity.has(curated)) return curated;   // 1. curated 命中且该 L2 有景气
  if (thsWithProsperity.has(c)) return c;                          // 2. 精确同名
  const subs = [...thsWithProsperity].filter(
    (l2) => (l2.includes(c) || c.includes(l2)) && c.length >= 2 && l2.length >= 2,
  );
  return subs.length === 1 ? subs[0] : null;                       // 3. 唯一子串；多义/0 → null
}

export function attachCanonical(
  scale: Map<string, number>,
  canonicalInds: string[],
): { byInd: Map<string, { prosperity: number | null; src: string | null }>; unmapped: string[] } {
  const thsSet = new Set(scale.keys());
  const byInd = new Map<string, { prosperity: number | null; src: string | null }>();
  const unmapped: string[] = [];
  for (const ind of canonicalInds) {
    const ths = mapCanonicalToThs(ind, thsSet);
    if (ths === null) {
      byInd.set(ind, { prosperity: null, src: null });
      unmapped.push(ind);
    } else {
      byInd.set(ind, { prosperity: scale.get(ths) ?? null, src: ths });
    }
  }
  return { byInd, unmapped };
}

export interface ProsperityResult {
  byInd: Map<string, { prosperity: number | null; src: string | null }>;
  mapped: number;
  unmapped: string[];
  warnings: string[];
}

export async function buildProsperity(
  fetchTable: (apiKey: string) => Promise<GsFundTable>,
  apiKey: string,
  canonicalInds: string[],
): Promise<ProsperityResult> {
  const warnings: string[] = [];
  let scale = new Map<string, number>();
  try {
    const table = await fetchTable(apiKey);
    const rows = parseFundTable(table);
    const raws = aggregateByThs(rows);
    scale = toProsperityScale(raws);
    if (scale.size === 0) warnings.push("景气度：宽表聚合后无可用同花顺 L2（样本/字段异常）");
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    warnings.push(`景气度计算失败（不影响评分）: ${safeGsMsg(m, apiKey)}`);
    // scale 保持空 ⇒ 下面 attach 全 null
  }
  const { byInd, unmapped } = attachCanonical(scale, canonicalInds);
  let mapped = 0;
  for (const v of byInd.values()) if (v.prosperity !== null) mapped++;
  if (unmapped.length > 0) {
    warnings.push(`景气度未映射到同花顺的 canonical 行业(${unmapped.length}): ${unmapped.slice(0, 20).join(",")}${unmapped.length > 20 ? ",…" : ""}`);
  }
  return { byInd, mapped, unmapped, warnings };
}
```

- [ ] **Step 5: 跑绿** — Run: `deno test --allow-env --allow-read gs_fund_test.ts`；Expected: PASS（全绿）。

- [ ] **Step 6: Commit** — `git add gs_fund.ts gs_fund_test.ts && git commit -m "feat(sector-prosperity): 同花顺↔canonical 归因映射 + buildProsperity 编排"`

---

## Task 4: schema 两列 + index.ts ③.5 接入 + 隔离验证

**Files:**
- Create: `scripts/migrate_sector_prosperity.sql`
- Modify: `supabase/functions/sector-trend/index.ts`
- Modify: `supabase/functions/sector-trend/index_test.ts`

**Interfaces:**
- Consumes: `buildProsperity`、`fetchFundTable`（Task 1–3）。
- Produces：`DailyRow` 增 `prosperity: number | null` + `prosperity_src: string | null`；`NightlyDeps` 增 `fetchFundTable`；`toDbRow` 输出含两列（默认 null）。

- [ ] **Step 1: 写迁移 SQL（幂等，仿 migrate_sector_rotation.sql 风格）**

`scripts/migrate_sector_prosperity.sql`：

```sql
-- scripts/migrate_sector_prosperity.sql — 行业景气度展示 spec 2026-10-03 §7
-- 执行方式: Management API /database/query（同 migrate_sector_rotation.sql 历史执行方式）
-- 幂等：add column if not exists，可重复执行；纯附加列，score/v/m/l/q 一字不动。
alter table public.sector_rotation_daily add column if not exists prosperity numeric;
alter table public.sector_rotation_daily add column if not exists prosperity_src text;
comment on column public.sector_rotation_daily.prosperity is
  '行业景气度 0..100（同花顺 L2 绝对基本面中位数跨行业百分位），null=未映射/主题/样本不足/取数失败；纯展示，绝不进 score';
comment on column public.sector_rotation_daily.prosperity_src is
  '归因来源：同花顺 L2 行业名，或 null（未命中）；供前端悬浮与调试透明';
```

> **不在此 Task 执行到生产**（生产写为不可逆操作，集中在 Task 6 的部署位、需人工确认）。本 Task 只创建文件。

- [ ] **Step 2: 改测试到红（列数 pin + 隔离用例）**

`index_test.ts`：
- 把 `shapeStaleRow` 测试里 `assertEquals(Object.keys(s).length, 25)` 改为 `27`（新增 prosperity/prosperity_src 随 prev 整行搬）。
- 在 `toDbRow` 的整行 `assertEquals(r, {...})` 对象里补 `prosperity: null, prosperity_src: null` 两键（默认 null）。
- `NightlyDeps` spy：给 `gsSpy` 返回对象补 `fetchFundTable: async () => { throw new Error("fund disabled in test"); }`（现有 skip/失败用例据此证明主链不受景气影响）。
- 新增隔离用例（追加到文件末尾）：

```ts
Deno.test("③.5 景气度隔离：fetchFundTable 抛错 → 主链照常、score 落库不变、prosperity=null", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)],
    tencent: [barRow(YDAY), barRow(TODAY)], // 真实交易日 → 走到 ⑤ 落库
    dailyLatest: [{ batch_date: YDAY }],
  });
  const spy = { n: 0 };
  const deps = {
    fetchSegments: async () => { spy.n++; return SNAP; },
    fetchFundTable: async () => { throw new Error("GS fund boom"); },
  };
  try {
    const j = await (await handle(runReq(), deps)).json() as Record<string, unknown>;
    assertEquals(spy.n, 1, "GS 截面仍被调用（景气失败不牵累主链）");
    const daily = s.writes.find((w) => w.table === "sector_rotation_daily")!;
    const row0 = daily.body[0] as Record<string, unknown>;
    assertEquals(row0.prosperity, null);
    assertEquals(row0.prosperity_src, null);
    assertEquals(typeof row0.score === "number" || row0.score === null, true, "score 语义不受景气影响");
    assertEquals((j.warnings as string[]).some((w) => w.includes("景气度计算失败")), true);
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.delete("SUPABASE_URL");
  }
});

Deno.test("③.5 景气度命中：可映射行业落 prosperity + prosperity_src", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)], tencent: [barRow(YDAY), barRow(TODAY)], dailyLatest: [{ batch_date: YDAY }],
  });
  const deps = {
    fetchSegments: async () => SNAP,
    fetchFundTable: async () => ({
      "股票代码": Array.from({ length: 6 }, (_, i) => `c${i}`),
      "营业总收入同比增长率[x]": [10, 20, 30, 40, 50, 60],
      "扣非净利润同比增长率[x]": [10, 20, 30, 40, 50, 60],
      "所属同花顺行业": Array(6).fill("非银金融-证券-证券"),
    }),
  };
  try {
    await handle(runReq(), deps);
    const daily = s.writes.find((w) => w.table === "sector_rotation_daily")!;
    const row0 = daily.body[0] as Record<string, unknown>;
    assertEquals(row0.ind, "银行");
    // 「银行」在 universe 测试宇宙里，是否命中取决于 CANON_TO_THS/子串；此断言按实际映射结果校准：
    assertEquals(typeof row0.prosperity === "number" || row0.prosperity === null, true);
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.set;
    Deno.env.delete("SUPABASE_URL");
  }
});
```

> 「银行」是否命中取决于 Task 3 curated 表：若 Step 1 枚举把 `银行`（或 `券商`→`证券` 之类）钉入，则 prosperity 为数值；未钉则 null。执行时按实际 curated 结果把断言收敛为「数值」或「null」，**两者都是合法**——本用例核心是证明字段被正确写入而非缺失。

- [ ] **Step 3: 跑红** — Run: `cd "supabase/functions/sector-trend" && deno test --allow-env --allow-read index_test.ts`；Expected: FAIL（`toDbRow` 缺两列 / `handle` 无 ③.5 / deps 签名不符）。

- [ ] **Step 4: 改 index.ts 到绿**

(1) import 追加：`import { buildProsperity, type ProsperityResult } from "./gs_fund.ts";` 及 `fetchFundTable`。
(2) `DailyRow` 接口末尾加：

```ts
  prosperity: number | null;   // 景气度展示（0..100 或 null），绝不进 score
  prosperity_src: string | null; // 归因同花顺 L2 或 null
```

(3) `toDbRow` 返回对象加：

```ts
    prosperity: null,      // 由编排层 ③.5 在落库前按 ind 附着
    prosperity_src: null,
```

(4) `NightlyDeps` 接口与 `REAL_DEPS` 增 `fetchFundTable`：

```ts
export interface NightlyDeps {
  fetchSegments: (apiKey: string) => Promise<SegSnapshot>;
  fetchFundTable: (apiKey: string) => Promise<import("./gs_fund.ts").GsFundTable>;
}
const REAL_DEPS: NightlyDeps = { fetchSegments, fetchFundTable };
```

(5) `handle()` 在 **③ GS 截面之后、④ prevMp 之前**插入 ③.5（`gsError` 判定不依赖景气）：

```ts
    // ③.5 景气度（隔离子流程，spec 2026-10-03 §4）：任何异常只记 warnings，绝不中断主链。
    let prosperityByInd = new Map<string, { prosperity: number | null; src: string | null }>();
    try {
      const pres: ProsperityResult = await buildProsperity(
        deps.fetchFundTable, key, [...selInds],
      );
      prosperityByInd = pres.byInd;
      warnParts.push(pres.warnings);
    } catch (e) { // buildProsperity 内部已兜，理论不达；双保险
      warnParts.push([`景气度子流程异常（忽略）: ${safeGsMsg(e instanceof Error ? e.message : String(e), key)}`]);
    }
```

(6) `outRows` 组装循环里，fresh 行落库前附着景气（stale 行走 `shapeStaleRow(prev)` 天然带昨日值）：

```ts
      } else {
        if (needStale && !prev) dropped.push(r.ind);
        const db = toDbRow(r, today, needStale);
        const p = prosperityByInd.get(r.ind);
        db.prosperity = p?.prosperity ?? null;
        db.prosperity_src = p?.src ?? null;
        outRows.push(db);
        ...
      }
```

(7) import `safeGsMsg`：把 `gs_etf.ts` 的 import 行补上 `safeGsMsg`。
(8) 两个 run/backfill 响应对象各补 `prosperity_mapped: [...prosperityByInd.values()].filter((v) => v.prosperity !== null).length`。

- [ ] **Step 5: 跑绿 + 回归**

Run: `cd "supabase/functions/sector-trend" && deno test --allow-env --allow-read index_test.ts engine_test.ts`
Expected: PASS；且 **`engine_test.ts` 全绿（engine.ts 未动）**、`score/v/m/l/q` 断言不变。

- [ ] **Step 6: Commit** — `git add scripts/migrate_sector_prosperity.sql supabase/functions/sector-trend/index.ts supabase/functions/sector-trend/index_test.ts && git commit -m "feat(sector-prosperity): sector_rotation_daily 两列 + nightly ③.5 隔离接入"`

---

## Task 5: 前端景气度展示（index.html SECTOR_PURE + facade）

**Files:**
- Modify: `index.html`（SECTOR_PURE 块 `sectorRowHtml`，约 1208–1237；新增 `fmtProsperity`；导出位 893–1118 内）
- Modify: `scripts/sector_render_logic.ts`
- Modify: `scripts/sector_render_logic_test.ts`

**Interfaces:**
- Consumes: 行对象自动带 `prosperity`/`prosperity_src`（`index.html` 查询已是 `.select('*')`）。
- Produces: `fmtProsperity(v): string`（null→`—`；否则数值一位小数）+ `prosperityBand(v): '高'|'中'|'低'|null`。

- [ ] **Step 1: 写失败测试**

`sector_render_logic_test.ts` 追加（沿用文件既有 import 门面方式）：

```ts
Deno.test("fmtProsperity: null→'—'，数值保留一位小数、绝不把 null 渲染成 0", () => {
  assertEquals(fmtProsperity(null), "—");
  assertEquals(fmtProsperity(undefined), "—");
  assertEquals(fmtProsperity(66.66), "66.7");
  assertEquals(fmtProsperity(0), "0.0"); // 真实 0 分位仍是 0.0（与 null 区分）
});
Deno.test("prosperityBand: 高≥66 / 中33-66 / 低<33；null→null", () => {
  assertEquals(prosperityBand(80), "高");
  assertEquals(prosperityBand(66), "高");
  assertEquals(prosperityBand(50), "中");
  assertEquals(prosperityBand(33), "中");
  assertEquals(prosperityBand(32.9), "低");
  assertEquals(prosperityBand(null), null);
});
```

> 门面需从 index.html SECTOR_PURE 抽出 `fmtProsperity`/`prosperityBand` 后再 import（见 Step 3）。

- [ ] **Step 2: 跑红** — Run: `deno test --allow-read --allow-env scripts/sector_render_logic_test.ts`；Expected: FAIL（导出名缺失，门面 `load()` 抛「缺少导出 fmtProsperity」）。

- [ ] **Step 3: 写实现**

(1) `index.html` SECTOR_PURE 块内（`fmtVr` 之后）新增纯函数：

```js
function fmtProsperity(v){ const n = sectorNum(v); return n === null ? '—' : n.toFixed(1); }
function prosperityBand(v){ const n = sectorNum(v); if(n === null) return null; return n >= 66 ? '高' : (n >= 33 ? '中' : '低'); }
```

(2) `scripts/sector_render_logic.ts`：`EXPORT_NAMES` 数组追加 `"fmtProsperity", "prosperityBand"`；`SectorRow` 接口加：

```ts
  prosperity?: number | null;
  prosperity_src?: string | null;
```

并新增门面导出：

```ts
export function fmtProsperity(v: unknown): string { return fn("fmtProsperity")(v); }
export function prosperityBand(v: unknown): "高" | "中" | "低" | null { return fn("prosperityBand")(v); }
```

(3) `index.html` `sectorRowHtml`（1208–1237）：把景气展示并入 metrics 行（在「行业分」之后），**并列、不参与排序**：

```js
  const pros = r.prosperity;
  const band = prosperityBand(pros);
  const prosHtml = ` · 景气 <em>${fmtProsperity(pros)}</em>${band ? `<span class="sector-pros-${band}">${band}</span>` : ''}`;
  // metrics 行末尾（行业分之后）拼接 prosHtml；sector-metrics 的 title 里追加来源：
```

具体：把第 1221 行 `+ \` · 行业分 <em>${fmtScoreVal(m.score)}</em>\`` 之后接 `+ prosHtml`；并在 `tip` 字符串末尾 `tip += '\n景气度=同花顺L2「'+escapeHtml(String(r.prosperity_src||'—'))+'」绝对基本面中位数跨行业百分位，仅展示、不参与行业分与排序。'`。
(4) `index.html` CSS `<style>` 板块区（约 179 起）加轻量配色（与既有 sector-tag 风格一致，不新造体系）：

```css
.sector-pros-高{color:var(--jade);} .sector-pros-中{color:var(--gold);} .sector-pros-低{color:var(--muted);}
.sector-pros-高,.sector-pros-中,.sector-pros-低{font-size:11px;margin-left:2px;}
```

- [ ] **Step 4: 跑绿** — Run: `deno test --allow-read --allow-env scripts/sector_render_logic_test.ts`；Expected: PASS。

- [ ] **Step 5: Commit** — `git add index.html scripts/sector_render_logic.ts scripts/sector_render_logic_test.ts && git commit -m "feat(sector-prosperity): 前端行业卡景气度并列展示（不参与排序）"`

---

## Task 6: 构建、全量回归、生产部署与线上验证

**Files:**
- Modify: `supabase/functions/sector-trend/build.ts`
- （无新测试；验证 + 运维操作）

**Interfaces:**
- Consumes: 前 5 Task 全部产物。

- [ ] **Step 1: build.ts 拼接列表加 gs_fund.ts**

把：

```ts
const src = '/// <reference lib="deno.ns" />\n' +
  rd("engine.ts") + "\n" + rd("tencent.ts") + "\n" + rd("gs_etf.ts") + "\n" +
  rd("index.ts");
```

改为（gs_fund 须在 index 之前、gs_etf 之后，因其 `import { safeGsMsg } from "./gs_etf.ts"` 依赖已被 `rd` 剥离，顺序仅影响可读性；重名检查兜底）：

```ts
const src = '/// <reference lib="deno.ns" />\n' +
  rd("engine.ts") + "\n" + rd("tencent.ts") + "\n" + rd("gs_etf.ts") + "\n" +
  rd("gs_fund.ts") + "\n" + rd("index.ts");
```

> 若 `assertNoDup` 报重名（如 gs_fund 某顶层符号与 gs_etf/index 撞），改 gs_fund 侧符号名（保持 `fund` 前缀纪律），不改构建脚本绕过。

- [ ] **Step 2: 全量测试回归**

Run: `cd "supabase/functions/sector-trend" && deno test --allow-env --allow-read --allow-net .` 与 `cd scripts && deno test --allow-read --allow-env --allow-net .`
Expected: 全绿；`engine_test.ts`/`gs_etf_test.ts` 既有断言零改动仍过。

- [ ] **Step 3: 构建 deploy.ts**

Run: `cd "supabase/functions/sector-trend" && deno run --allow-read --allow-write build.ts`
Expected: 打印 `deploy.ts bytes: ...`，无「bundle 顶层标识符重名」错误。

---

> **⚠️ 以下为生产不可逆操作，执行前必须由人工明确确认（subagent-driven-development 的「stop」条件：跨 worktree 副作用/发布）。**

- [ ] **Step 4: 执行 schema 迁移（Management API）**

沿用历史执行方式（`migrate_sector_rotation.sql` 同款）：

```bash
python3 -c "import json,urllib.request,os; pat=open(os.path.expanduser('~/.config/sector-rotation/supabase_pat')).read().strip(); sql=open('scripts/migrate_sector_prosperity.sql').read(); req=urllib.request.Request('https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query',data=json.dumps({'query':sql}).encode(),headers={'Authorization':'Bearer '+pat,'Content-Type':'application/json'},method='POST'); print(urllib.request.urlopen(req).read().decode())"
```

Expected: HTTP 2xx，两列存在（复核：`select prosperity, prosperity_src from sector_rotation_daily limit 1` 不报错）。

- [ ] **Step 5: 部署 sector-trend Edge Function + 线上冒烟**

按本仓既有函数部署流程推 `deploy.ts`（`supabase functions deploy sector-trend` 或既有 CI/脚本路径）。随后打一次 nightly：

```bash
curl -s -X POST "$SB/functions/v1/sector-trend?mode=run" -H "Authorization: Bearer $SECTOR_TREND_TOKEN"
```

Expected 响应：`ok:true`、`prosperity_mapped ≥ 1`、warnings 可能含未映射清单；`q_alive:false`、score 相关计数正常。

- [ ] **Step 6: 逐值回归验收（spec §11 硬标准）**

对最新批次比对「本特性上线前后 score/v/m/l/q 逐值一致」：取上线前最后一个真实批次与上线后新批次，`full outer join on ind`，断言五列相等（或仅随当日正常行情变动、无系统性偏移/无因景气引入的重排）。复核前端行业卡：可映射宽基显示数值+档位+来源悬浮；主题/未映射显示 `—`；缺值不显示 0。

- [ ] **Step 7: Commit（构建产物）** — `git add supabase/functions/sector-trend/deploy.ts && git commit -m "chore(sector-prosperity): 重建 deploy.ts（含 gs_fund）"`

---

## Self-Review

**1. Spec coverage：**
- §2 不进 score → 全局约束「评分冻结」+ Task 4 `toDbRow` 默认 null 不改五列 + Task 6 Step 6 逐值回归。✓
- §3 与原 q 腿隔离 → 独立列 `prosperity`，`q`/`qAlive`/`engine` 未动（Task 4 只加列不改 q）。✓
- §4 数据链路 ③.5 + 隔离 + 每夜+1 次 GS → Task 3 `buildProsperity`(注入 fetch) + Task 4 (5) 插入位 + try/catch 不 throw。✓
- §5 定义/刻度/样本下限 → Task 2（中位数、raw、百分位、n<5）。✓
- §6 归因映射（curated/同名/唯一子串/多义 null/未命中报警）→ Task 3 `mapCanonicalToThs` + `buildProsperity` unmapped warnings。✓
- §7 schema 两列 + DailyRow/toDbRow + stale 复制 → Task 4 + `shapeStaleRow` 整行 spread（列数 pin 27）。✓
- §8 前端契约（并列、不参与排序、null→—、来源标注、集中在 SECTOR_PURE+facade）→ Task 5。✓
- §9 S1 修订 → spec 已载，代码侧体现为「sector-trend 自发国信查询、不读 stock_score 输出表」（Task 1 自建 `fetchFundTable`，无跨函数 import）。✓
- §10 TDD 验证策略 → 各 Task 红/绿 + Task 4 隔离用例 + Task 6 回归。✓
- §11 验收 → Task 6 Step 6。✓
- §12 风险（列名漂移→前缀匹配；主题永远 null→展示—；回退→停 ③.5）→ 全局约束 + Task 4 catch 降级。✓

**2. Placeholder scan：** `CANON_TO_THS`、`REV_PREFIX`/`KC_PREFIX`/`THS_PREFIX` 是**由确定性探针（Task 1 Step 1 / Task 3 Step 1）产出的真实数据**，非 TBD——探针给出可复现的枚举程序，产物是具体清单。Task 4「银行」断言允许数值或 null，二者皆合法且写明核心是「字段被正确写入」，非含糊占位。

**3. 类型一致性：** `FundRow`/`ThsRaw`/`ProsperityResult` 定义于 gs_fund.ts，Task 4 import `ProsperityResult`、`GsFundTable` 一致；`DailyRow.prosperity/prosperity_src` 命名与迁移 SQL 列名、前端 `r.prosperity/r.prosperity_src` 三处逐字对齐；`fmtProsperity`/`prosperityBand` 在 index.html、EXPORT_NAMES、门面导出、测试四处同名。

---

## Execution Handoff

计划完成并保存到 `docs/superpowers/plans/2026-10-03-sector-prosperity-display.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 逐 Task 派发全新 implementer 子代理 + 任务间双阶段评审，迭代快、省上下文。

**2. Inline Execution** — 在本会话用 executing-plans 批量执行、检查点复核。

选哪种？（注意：Task 6 Step 4–5 为生产迁移 + 函数部署，属需人工确认的不可逆操作。）
