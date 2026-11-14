# 港股价值评估（降维口径）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给持仓港股一条只报事实的价值参考通道（资本回报 / 股息 / PE·PB 三行），独立表、独立函数、独立 cron，A 股价值腿一字不动。

**Architecture:** 新建 `supabase/functions/stock-value-hk/`（纯函数 `hk_engine.ts` + 适配器 `gs_hk.ts` + 编排 `index.ts` + 构建 `build.ts`），三次 GS `HK_stock` 全市场查询 → 剥 `港股@` 前缀 → 本地过滤到持仓 5 位码 → 算三年中位/最差年/达标三态 → upsert 新表 `stock_value_hk`。前端在 `index.html` 的 `VALUE_PURE` 块内新增 `valueAssessmentHkHtml`，`stockDetailFactsHtml` 按 code 形态分流，新 `loadStockValueHk()` 独立只读取数挂进首屏 `Promise.all`。

**Tech Stack:** Deno + TypeScript（Supabase Edge Functions，单文件 bundle 部署）、PostgreSQL + PostgREST + RLS、pg_cron / pg_net、原生 JS 单文件前端（`index.html`）、`deno test` + std@0.224.0 assert、Cloudflare Pages。

**Spec:** `docs/superpowers/specs/2026-11-13-hk-value-lite-design.md`（含 2026-11-14 更正：估值验收不钉死数值、H-7/H-8 为快照态观测、新增 §2.5 列名契约）

**台账:** `.superpowers/sdd/2026-11-13-hk-value-lite/progress.md`（gitignored，**只追加**，不改写历史条目；探针产物不入库）

## Global Constraints

每个任务的要求都隐含包含本节全部条目。

- **不改 A 股价值腿任何代码与文案**：`supabase/functions/stock-value/` 下所有文件、`stock_value` 表、以及 `index.html` 里 `valueAssessmentHtml` / `valueGateHtml` / `valueVetoHtml` / `valueMoatVetoHtml` / `loadStockValue` / `loadIncomeWatch` / `loadValueIndustryRef` / `renderValueTop10` / `renderDivergeBoard` / `swapSuggest` 一律**只读不改**。两句 A 股 `.value-note` 逐字不变。
- **不 import A 股模块**：`hk_engine.ts` / `gs_hk.ts` / `index.ts` 不得出现 `from '../stock-value/...'`。`roicStats` 与三个列名匹配器是**复制体**（spec §5.2），两侧任一改动手工同步，由门槛三处同值测试钉住。
- **`deploy.ts` 是构建产物，不可手改**：改源模块后必须在该目录重跑 `build.ts`，再跑 `deno task verify-bundles`。
- **三条生产查询串原样锁定**（spec §2.1），不得改写措辞：
  - `buildHkQ1(b)` = `` `全部港股的${b-2}年报投入资本回报率、${b-1}年报投入资本回报率、${b}年报投入资本回报率、股票简称` ``
  - `HK_Q2` = `全部港股的股息率、近5年股息率平均值、股票简称`
  - `HK_Q3` = `全部港股的市盈率、市净率、股票简称`
  - `searchtype` 一律 `HK_stock`。
- **参照线 8%**：`HK_ROIC_GATE`（新引擎）= `ROIC_GATE`（A 股引擎）= `ROIC_GATE_PCT`（前端）三处同值，测试钉住。8 是 WACC 锚，不是行业均值，不做行业调整。
- **空值语义**（spec §3.1/§3.3）：ROIC 有效期 <2 ⇒ med/min3 皆 null；`roic_ok` 三态（med=null ⇒ **null，不是 false**）；股息空 ⇒ **null，不记 0**；PE≤0 / PB≤0 ⇒ null，**不推断「资不抵债」**。
- **前端文案纪律**（spec §7）：缺失一律「无数据」（不是 `NA`、不是 `0`、不是 `--`）；负号统一 U+2212「−」，`toFixed` 产出的 ASCII `-` 必须替换；8% 只在第二句口径行露一次；不露算式与内部术语；无 tier / vq / confidence / 四维雷达 / 门禁明细 / 换仓参考。
- **凭据安全**：GS key 只从 `Deno.env.get('GS_API_KEY')` 读；`TypeError` 必须折叠（其 message 含带 apiKey 的完整 URL）；错误响应必须 `.replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED')`。cron SQL 用 `$DAILY_UPDATE_TOKEN` 占位，**真值绝不写入文件**；执行后**不得** `select job.command`。Supabase PAT 只从 `~/.config/sector-rotation/supabase_pat` 读，用 python `.strip()`（`TOKEN=$(cat 文件)` 会 401），绝不打印、绝不入库。
- **生产只读铁律**：Task 1–7 全程不碰生产。迁移执行、Edge 部署、cron 注册、Pages 发布**全部集中在 Task 8，且需用户明示**。`stock-value-hk` 与 `stock-value` 一样 `verify_jwt=false` ⇒ **任何无凭据的 GET/POST 都会真跑批并写生产表**，不能拿它当 401 探针。
- **测试命令**：`deno task test`（= `deno test -A scripts/ supabase/functions/`）。变异检验前先 `NO_COLOR=1` 并剥 ANSI 码。
- **std@0.224.0 的 `assertThrows` 无 RegExp 重载**：一律 `const thrownMessage = (fn) => (assertThrows(fn) as Error).message` 再 `assertMatch`。
- **阈值夹具离边界留富余**（用 12 / 4，不用 7.9999 / 8.0001），否则变异检验假活。
- **编辑安全**：`index.html` 是 303KB 单文件，Edit 报「保存失败/无变更」时可能**已写入** ⇒ 重试前先 grep 计数防重复插入。台账 `progress.md` 含超长行，只用 `cat >>` 追加，不用 Edit/Write。
- **每次 GS 调用后固定输出**：`风险提示：选股结果和实时行情可能有一定差异，选股结果仅作参考，不构成投资建议，请用户自主决策并自行承担投资风险。`

## File Structure

**新建 —— Edge 函数 `supabase/functions/stock-value-hk/`**

| 文件 | 职责 |
|---|---|
| `hk_engine.ts` | 纯口径：`HK_ROIC_GATE`、`roicStats3`、`computeHk`、`HkRaw`/`HkRow` 类型。不读网络、不读全局、不读时钟 |
| `hk_engine_test.ts` | 三年窗统计、三态、PE/PB≤0、股息空值、门槛三处同值 |
| `gs_hk.ts` | 三条查询串、`gsHkFetch`、`stripHkPrefix`、`hkCodeOf`、四个匹配器复制体、`assertHkCols`、`mergeHkTables` |
| `gs_hk_test.ts` | 前缀剥离、代码补零、§2.5 三条形态陷阱、真实夹具逐位、七条守卫变异 |
| `fixtures/hk_q1_sample.json`<br>`fixtures/hk_q2_sample.json`<br>`fixtures/hk_q3_sample.json` | 2026-11-14 实调原始列名与值的精简切片（5 行：九龙仓/载通/科联系统/腾讯/阿里），**键序保持响应原样（乱序）** |
| `index.ts` | 编排：`heldHkCodes`、`readStates`、`toHkDbRow`、`buildHkDbRows`、`upsertHk`、`runHkSummary`、`errorHkBody`、handler |
| `index_test.ts` | 持仓提取、单页截断守卫、落库映射、wrote 语义、遥测、隔离守卫 |
| `build.ts` | 拼接 `hk_engine.ts` + `gs_hk.ts` + `index.ts` → `deploy.ts`，含重名与残留 import 门禁 |
| `deploy.ts` | **构建产物**，部署推的就是它 |

**新建 —— SQL**

| 文件 | 职责 |
|---|---|
| `scripts/migrate_stock_value_hk.sql` | 建表 + 索引 + RLS（只读 anon/authenticated，写路径无策略即拒绝）+ 回滚注释 |
| `scripts/cron_stock_value_hk.sql` | `stock-value-hk-nightly`，`50 13 * * *`，`timeout_milliseconds := 300000` |
| `scripts/hk_sql_artifacts_test.ts` | 静态钉住两份 SQL 的结构与凭据占位不变式（不连库） |

**修改**

| 文件 | 改什么 |
|---|---|
| `scripts/verify_deploy_bundles.ts:13-19` | `MODULES` 数组加 `"stock-value-hk"` |
| `index.html:132` 后 | 新增 `.value-hk-rows` 单列网格 CSS（**追加，不动 `.value-radar`**） |
| `index.html:377` 后 | 桌面端 `.value-hk-rows{gap:8px;}` |
| `index.html:1282` 后 | `VALUE_PURE` 块内新增 `hkFmtPct` / `hkFmtNum` / `valueAssessmentHkHtml` |
| `index.html:684` 后 | 新增 `let valueHkState = null;` |
| `index.html:854` | `Promise.all` 加 `loadStockValueHk()` |
| `index.html:933` 后 | 新增 `loadStockValueHk()` |
| `index.html:3874` | ctx 解构加 `hkRow` |
| `index.html:3881` | 改成 `isHk` 三元分流（A 股分支逐字保留） |
| `index.html:3951` 后 | 新增 `const hkRow = ...` |
| `index.html:3954` | ctx 传参加 `hkRow` |
| `scripts/value_leg_logic.ts:19` | `EXPORT_NAMES` 加三个名字 |
| `scripts/value_leg_logic.ts:122` 后 | 三个 typed export |
| `scripts/value_leg_logic_test.ts:1044-1055` | **改写**接线守卫「价值评估栏每卡常驻…」整块，钉住两条分支（不是删除） |
| `scripts/value_leg_logic_test.ts` 末尾 | 新增港股逐字/缺失/负号/跨层契约测试 |

> 上表行号一律是**改动前**（HEAD `9f4ea8e`）的位置，已逐条核对。Task 6 会往 `index.html` 插入约 45 行、往测试文件插入 1 行 import + 12 条用例 ⇒ 之后的行号全部下移。**各 Step 一律按锚点文本定位，不要按这里的行号切割**（Task 7 Step 2 已就此单独警示）。

**不改**（明确列出，防止执行者「顺手修」）：`supabase/functions/stock-value/**`、`supabase/functions/daily-update/**`（邮件端 spec §8 不动）、`stock_value` 表、`index.html` 的 `legFilter`（它的 `/^\d{5,6}$/` 会放行 5 位港股码去查 `stock_value`，但那张表没有港股行 ⇒ 返回空，无害；spec §11 禁止改任何 `stock_value` 查询）。

---

### Task 1: 纯口径引擎 `hk_engine.ts`

**Files:**
- Create: `supabase/functions/stock-value-hk/hk_engine.ts`
- Test: `supabase/functions/stock-value-hk/hk_engine_test.ts`

**Interfaces:**
- Consumes: 无（本任务是地基）
- Produces:
  - `HK_ROIC_GATE: number`（= 8）
  - `type HkRaw = { code: string; name: string; roic3: (number|null)[]; divYield: number|null; divY5y: number|null; pe: number|null; pb: number|null }`
  - `type HkRow = HkRaw & { roicCur: number|null; roicMed: number|null; roicMin3: number|null; roicOk: boolean|null; missing: string[] }`
  - `roicStats3(roic3: (number|null)[]): { med: number|null; min3: number|null }`
  - `computeHk(r: HkRaw): HkRow`

- [ ] **Step 1: 写失败测试**

Create `supabase/functions/stock-value-hk/hk_engine_test.ts`:

```ts
// supabase/functions/stock-value-hk/hk_engine_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { HK_ROIC_GATE, roicStats3, computeHk, type HkRaw } from './hk_engine.ts';

// 夹具值取自 2026-11-14 GS HK_stock 实调（spec §2.4）。估值两数逐日漂移，这里只当形态样本。
const raw = (over: Partial<HkRaw> = {}): HkRaw => ({
  code: '00700', name: '腾讯控股', roic3: [10.5299, 15.8648, 15.8625],
  divYield: 0.8848080133555927, divY5y: 0.8381616844832607, pe: 13.078457, pb: 4.189377, ...over,
});

Deno.test('roicStats3：三年窗取中位与最差年（腾讯/阿里真实值）', () => {
  assertEquals(roicStats3([10.5299, 15.8648, 15.8625]), { med: 15.8625, min3: 10.5299 });
  assertEquals(roicStats3([6.4716, 6.909, 10.7987]), { med: 6.909, min3: 6.4716 });
});

Deno.test('roicStats3：负 ROIC 参与统计（九龙仓真实形态，最差年 −2.036）', () => {
  assertEquals(roicStats3([0.5646, -2.036, 0.0313]), { med: 0.0313, min3: -2.036 });
});

Deno.test('roicStats3：偶数期取中间两数均值；<2 期 med 与 min3 同生同死皆 null', () => {
  assertEquals(roicStats3([4, 10, null, null]), { med: 7, min3: 4 });
  assertEquals(roicStats3([9, null, null]), { med: null, min3: null });
  assertEquals(roicStats3([null, null, null]), { med: null, min3: null });
  assertEquals(roicStats3([]), { med: null, min3: null });
});

Deno.test('roicStats3：非有限值与 null 同待遇，不参与统计', () => {
  assertEquals(roicStats3([NaN, 12, Infinity, 6]), { med: 9, min3: 6 });
});

Deno.test('roic_ok 三态：med=null ⇒ null（不是 false）', () => {
  assertEquals(computeHk(raw({ roic3: [9, null, null] })).roicOk, null);
  assertEquals(computeHk(raw({ roic3: [null, null, null] })).roicOk, null);
});

Deno.test('8% 参照线：夹具离阈值留富余（浮点边界会让变异检验假活）', () => {
  assertEquals(HK_ROIC_GATE, 8);
  assertEquals(computeHk(raw({ roic3: [11, 12, 13] })).roicOk, true);    // med 12，高出 4pp
  assertEquals(computeHk(raw({ roic3: [3, 4, 5] })).roicOk, false);      // med 4，低 4pp
});

Deno.test('达标只看 med：cur 与 med 相互独立（阿里真实形态 cur 10.80 而 med 6.91 ⇒ 未达标）', () => {
  const r = computeHk(raw({ code: '09988', name: '阿里巴巴-W', roic3: [6.4716, 6.909, 10.7987] }));
  assertEquals(r.roicCur, 10.7987);
  assertEquals(r.roicMed, 6.909);
  assertEquals(r.roicMin3, 6.4716);
  assertEquals(r.roicOk, false);
});

Deno.test('只缺最新一期：roic_cur=null 而 med 照样有值，不得断言成无护城河证据', () => {
  const r = computeHk(raw({ roic3: [11, 13, null] }));
  assertEquals(r.roicCur, null);
  assertEquals(r.roicMed, 12);
  assertEquals(r.roicMin3, 11);
  assertEquals(r.roicOk, true);
  assertEquals(r.missing.includes('roic_cur'), true);
});

Deno.test('PE/PB ≤0 ⇒ null（亏损股 PE 无经济含义；PB≤0 不推断资不抵债）', () => {
  const r = computeHk(raw({ pe: -145.178781, pb: 0 }));
  assertEquals(r.pe, null);
  assertEquals(r.pb, null);
  assertEquals(r.missing.includes('pe'), true);
  assertEquals(r.missing.includes('pb'), true);
});

Deno.test('股息空值落 null 而非 0（港股未确认「空=从不分红」，spec §3.3）', () => {
  const r = computeHk(raw({ divYield: null, divY5y: null }));
  assertEquals(r.divYield, null);
  assertEquals(r.divY5y, null);
  assertEquals(r.missing.includes('div_yield'), true);
  assertEquals(r.missing.includes('div_yield_5y'), true);
});

Deno.test('missing 只列真缺的字段；齐备时为空数组；code/name 原样透传', () => {
  const r = computeHk(raw());
  assertEquals(r.missing, []);
  assertEquals(r.code, '00700');
  assertEquals(r.name, '腾讯控股');
});

Deno.test('门槛三处同值：港股引擎 = A 股引擎 = 前端常量（改一端必须改另两端）', async () => {
  const a = await Deno.readTextFile(new URL('../stock-value/value_engine.ts', import.meta.url));
  const m = /export const ROIC_GATE = (\d+(?:\.\d+)?)/.exec(a);
  assertEquals(m !== null, true, 'A 股引擎里找不到 ROIC_GATE');
  assertEquals(HK_ROIC_GATE, Number(m![1]), '港股引擎与 A 股引擎门槛漂移');
  const html = await Deno.readTextFile(new URL('../../../index.html', import.meta.url));
  const f = /var ROIC_GATE_PCT = (\d+(?:\.\d+)?);/.exec(html);
  assertEquals(f !== null, true, '前端找不到 ROIC_GATE_PCT');
  assertEquals(HK_ROIC_GATE, Number(f![1]), '港股引擎与前端门槛文案漂移');
});

Deno.test('隔离守卫：港股引擎不 import A 股模块、不做 ROE 替代（spec §5.2 / §3.2）', async () => {
  const src = await Deno.readTextFile(new URL('./hk_engine.ts', import.meta.url));
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '港股引擎不得 import A 股模块');
  // 港股不返回「股票市场类型」⇒ 无法识别金融股 ⇒ 不做 ROE 对标（ROE 与 ROIC 量纲不同源，
  // 拿它跟 8% 比等于造一个假比较）。引擎里连 roe 这个词都不该出现，缺数就走「无数据」。
  assertEquals(/roe/i.test(src), false, '不得引入 ROE 替代或按名字猜金融股');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/hk_engine_test.ts`
Expected: FAIL — `Module not found "file:///.../supabase/functions/stock-value-hk/hk_engine.ts"`

- [ ] **Step 3: 写实现**

Create `supabase/functions/stock-value-hk/hk_engine.ts`:

```ts
// hk_engine.ts — 港股降维口径的纯函数。规则权威：spec §3（口径）/§3.1（空值语义）/§3.3（股息不记 0）
// 与 A 股 value_engine.ts 完全隔离（spec §5.2）：roicStats3 是 roicStats 的复制体，不 import、不抽公共模块。
export const HK_ROIC_GATE = 8;   // % WACC 锚，与 A 股 ROIC_GATE 同值同理由（2026-10-30 裁定维持 8）；测试三处钉住

export type HkRaw = {
  code: string;                    // 5 位补零（00700 / 09988），与持仓/前端同形
  name: string;
  roic3: (number | null)[];        // [Y-2, Y-1, Y] 三年年报 ROIC，顺序由适配器锤死
  divYield: number | null;
  divY5y: number | null;
  pe: number | null;
  pb: number | null;
};

export type HkRow = HkRaw & {
  roicCur: number | null;
  roicMed: number | null;
  roicMin3: number | null;
  roicOk: boolean | null;          // 三态：med=null ⇒ null，不是 false
  missing: string[];               // 缺值字段名，落 extras.missing
};

// 与 A 股 value_engine.ts:29 roicStats 同语义的复制体：≥2 期有效才算，med 与 min3 同生同死。
export function roicStats3(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

// PE/PB ≤0 一律 null（spec §3.1）。PB≤0 **不推断资不抵债**——那是 A 股否决1 的结论，本设计不产结论。
const pos = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

export function computeHk(r: HkRaw): HkRow {
  const { med, min3 } = roicStats3(r.roic3);
  const cur = r.roic3.length > 0 ? r.roic3[r.roic3.length - 1] : null;
  const pe = pos(r.pe), pb = pos(r.pb);
  const missing: string[] = [];
  if (cur === null) missing.push('roic_cur');
  if (med === null) missing.push('roic_med');
  if (r.divYield === null) missing.push('div_yield');
  if (r.divY5y === null) missing.push('div_yield_5y');
  if (pe === null) missing.push('pe');
  if (pb === null) missing.push('pb');
  return {
    code: r.code, name: r.name, roic3: r.roic3,
    divYield: r.divYield, divY5y: r.divY5y, pe, pb,
    roicCur: cur, roicMed: med, roicMin3: min3,
    // 达标只看 med：cur 与 med 相互独立（spec §3；阿里 cur 10.80 达标而 med 6.91 未达标）
    roicOk: med === null ? null : med >= HK_ROIC_GATE,
    missing,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/hk_engine_test.ts`
Expected: PASS — 13 tests, 0 failures

- [ ] **Step 5: 类型与 lint 检查**

Run: `deno check supabase/functions/stock-value-hk/hk_engine.ts supabase/functions/stock-value-hk/hk_engine_test.ts && deno lint supabase/functions/stock-value-hk/`
Expected: 无 error（`deno lint` 若报既有基线规则，与 HEAD 副本逐规则比对，只看净增量）

- [ ] **Step 6: 提交**

```bash
git add supabase/functions/stock-value-hk/hk_engine.ts supabase/functions/stock-value-hk/hk_engine_test.ts
git commit -m "$(cat <<'EOF'
feat(hk): 港股降维口径纯引擎，三年中位/最差年与达标三态

roic_ok 在 med 缺失时落 null 而非 false，避免把数据缺口说成经营结论；
PE/PB≤0 归 null 但不推断资不抵债。与 A 股引擎完全隔离，门槛三处同值由测试钉住。
EOF
)"
```

---

### Task 2: 适配器 `gs_hk.ts` + 真实夹具

**Files:**
- Create: `supabase/functions/stock-value-hk/gs_hk.ts`
- Create: `supabase/functions/stock-value-hk/fixtures/hk_q1_sample.json`
- Create: `supabase/functions/stock-value-hk/fixtures/hk_q2_sample.json`
- Create: `supabase/functions/stock-value-hk/fixtures/hk_q3_sample.json`
- Test: `supabase/functions/stock-value-hk/gs_hk_test.ts`

**Interfaces:**
- Consumes: `type HkRaw` from `./hk_engine.ts`（Task 1）
- Produces:
  - `type GsHkTable = Record<string, (string|number|null)[]>`
  - `hkYearAnchors(now: Date): { annualBase: number }`
  - `buildHkQ1(b: number): string`、`HK_Q2: string`、`HK_Q3: string`
  - `gsHkFetch(query: string, apiKey: string, timeoutMs?: number): Promise<GsHkTable>`
  - `stripHkPrefix(t: GsHkTable): GsHkTable`
  - `hkCodeOf(raw: string|number|null|undefined): string|null`
  - `colByPrefix(t, prefix): string|undefined`、`windowCols(t, name): string[]`、`annualCols(t, labelPrefix, requireAnnualOnly?): string[]`、`intervalAvgCols(t, labelPrefix): string[]`
  - `type HkBatch = 'q1'|'q2'|'q3'`、`assertHkCols(t: GsHkTable, fam: HkBatch): void`
  - `mergeHkTables(t1, t2, t3, held: Set<string>, now?: Date): { rows: HkRaw[]; stamps: Record<string,string>; years: string[] }`

- [ ] **Step 1: 落夹具（真实实调切片，键序保持响应原样）**

Create `supabase/functions/stock-value-hk/fixtures/hk_q1_sample.json`:

```json
{
  "港股@投入资本回报率[20241231]": ["-2.036", "0.8926", "5.7797", "15.8648", "6.909"],
  "股票简称": ["九龙仓集团", "载通", "科联系统", "腾讯控股", "阿里巴巴-W"],
  "港股@投入资本回报率[20231231]": ["0.5646", "1.9081", "6.499", "10.5299", "6.4716"],
  "港股@投入资本回报率[20251231]": ["0.0313", "1.9198", "3.7087", "15.8625", "10.7987"],
  "股票代码": ["0004.HK", "0062.HK", "0046.HK", "0700.HK", "9988.HK"]
}
```

Create `supabase/functions/stock-value-hk/fixtures/hk_q2_sample.json`:

```json
{
  "港股@股息率(股票获利率)平均[20211231-20251231]": [1.734822560546205, 6.080053596954104, 6.3704954996023035, 0.8381616844832607, 1.6028015582280901],
  "股票简称": ["九龙仓集团", "载通", "科联系统", "腾讯控股", "阿里巴巴-W"],
  "港股@股息率(股票获利率)[20251231]": [1.8399264029438824, 7.547169811320756, 6.211180124223603, 0.8848080133555927, 1.51951171875],
  "股票代码": ["0004.HK", "0062.HK", "0046.HK", "0700.HK", "9988.HK"]
}
```

Create `supabase/functions/stock-value-hk/fixtures/hk_q3_sample.json`:

```json
{
  "港股@市净率(pb)[20261113]": [0.39938, 0.362037, 0.561775, 4.189377, 2.185361],
  "股票简称": ["九龙仓集团", "载通", "科联系统", "腾讯控股", "阿里巴巴-W"],
  "港股@市盈率(pe,ttm)[20261113]": ["-145.178781", "20.469506", "13.466979", "13.078457", "21.12736"],
  "股票代码": ["0004.HK", "0062.HK", "0046.HK", "0700.HK", "9988.HK"]
}
```

三份夹具的来源与形态要点（写进 `gs_hk_test.ts` 头注释，不另建文档）：2026-11-14 实调 2792 行里切出 5 行；ROIC 是**字符串**、股息/PE/PB 是**数字**；ROIC 列键序是 2024→2023→2025（**乱序**，字典序取首个会绑到 2024）；九龙仓 PE 为负、ROIC 含负值，是天然的边界样本。

- [ ] **Step 2: 写失败测试**

Create `supabase/functions/stock-value-hk/gs_hk_test.ts`:

```ts
// supabase/functions/stock-value-hk/gs_hk_test.ts
// 夹具 = 2026-11-14 GS HK_stock 实调原始切片（spec §2.4/§2.5）。键序保持响应原样（乱序），
// 因为「按字典序取首个」正是 A 股踩过的绑错列陷阱；ROIC 是字符串、估值是数字，num() 两种都要收。
import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  HK_Q2, HK_Q3, buildHkQ1, hkYearAnchors, stripHkPrefix, hkCodeOf,
  colByPrefix, windowCols, annualCols, intervalAvgCols, assertHkCols, mergeHkTables, type GsHkTable,
} from './gs_hk.ts';

const thrownMessage = (fn: () => unknown): string => (assertThrows(fn) as Error).message;
const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url))) as GsHkTable;
const NOW = new Date('2026-11-14T13:50:00Z');   // 合成时钟：annualBase=2025，测试不随挂钟腐烂
const HELD = new Set(['00700', '09988']);
const merge = (t1 = fx('hk_q1_sample.json'), t2 = fx('hk_q2_sample.json'), t3 = fx('hk_q3_sample.json'), held = HELD) =>
  mergeHkTables(t1, t2, t3, held, NOW);
// 删掉某表里的一行（模拟 H-7 单码缺席），列名与键序不变
const dropRow = (t: GsHkTable, code: string): GsHkTable => {
  const j = (t['股票代码'] as string[]).indexOf(code);
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) out[k] = (t[k] as (string | number | null)[]).filter((_, i) => i !== j);
  return out;
};
const renameKey = (t: GsHkTable, from: string, to: string): GsHkTable => {
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) out[k === from ? to : k] = t[k];
  return out;
};

Deno.test('查询串措辞：HK_Q1 只由 annualBase 拼装，HK_Q2/HK_Q3 逐字锁定（spec §2.1）', () => {
  assertEquals(hkYearAnchors(new Date('2026-03-01')).annualBase, 2024);   // 1-4 月年报未披露完，锚前年
  assertEquals(hkYearAnchors(new Date('2026-05-01')).annualBase, 2025);
  assertEquals(buildHkQ1(2025), '全部港股的2023年报投入资本回报率、2024年报投入资本回报率、2025年报投入资本回报率、股票简称');
  assertEquals(HK_Q2, '全部港股的股息率、近5年股息率平均值、股票简称');
  assertEquals(HK_Q3, '全部港股的市盈率、市净率、股票简称');
});

Deno.test('H-6 剥前缀：财务/估值列剥 港股@，简称与代码不带前缀则原样', () => {
  const s = stripHkPrefix(fx('hk_q1_sample.json'));
  assertEquals(Object.keys(s).sort(), ['投入资本回报率[20231231]', '投入资本回报率[20241231]', '投入资本回报率[20251231]', '股票代码', '股票简称'].sort());
  assertEquals(s['股票简称'], fx('hk_q1_sample.json')['股票简称']);
});

Deno.test('剥前缀撞名 ⇒ 抛错（两列静默合并成一列比炸批危险）', () => {
  assertMatch(thrownMessage(() => stripHkPrefix({ '港股@股票简称': ['a'], '股票简称': ['b'] })), /column collision after prefix strip: 股票简称/);
});

Deno.test('H-6 代码补零：0700.HK→00700、9988.HK→09988；非港股形态一律 null，不猜', () => {
  assertEquals(hkCodeOf('0700.HK'), '00700');
  assertEquals(hkCodeOf('9988.HK'), '09988');
  assertEquals(hkCodeOf('700'), '00700');
  // 九龙仓真实码是 00004：GS 去了前导零回 '0004.HK'，补零到 5 位得 '00004'（不是 '0004'）。
  // 夹具里另外两只同理：'0062.HK'→'00062'（载通）、'0046.HK'→'00046'（科联系统）。
  assertEquals(hkCodeOf('0004.HK'), '00004');
  assertEquals(hkCodeOf('0062.HK'), '00062');
  assertEquals(hkCodeOf('600031.SH'), null);
  assertEquals(hkCodeOf('600031'), null);      // 6 位 = A 股，不是港股
  assertEquals(hkCodeOf(''), null);
  assertEquals(hkCodeOf(null), null);
});

Deno.test('§2.5 陷阱 1：当期股息率靠「标签最短」胜出，不是靠中文后缀拒绝；键序颠倒也不变', () => {
  const b = stripHkPrefix(fx('hk_q2_sample.json'));
  const cur = '股息率(股票获利率)[20251231]', avg = '股息率(股票获利率)平均[20211231-20251231]';
  // 两个标签都能通过「拒绝中文后缀」规则（别名 (股票获利率) 挡在 平均 前面）
  assertEquals(/^[\u4e00-\u9fff]/.test('股息率(股票获利率)平均'.slice('股息率'.length)), false);
  assertEquals(colByPrefix(b, '股息率'), cur);
  const reversed: GsHkTable = {};
  for (const k of Object.keys(b).reverse()) reversed[k] = b[k];
  assertEquals(colByPrefix(reversed, '股息率'), cur);
  assertEquals(colByPrefix({ [avg]: [1] }, '股息率'), avg);   // 只剩兄弟列时仍会命中 ⇒ 守卫必须另立形态判据
});

Deno.test('§2.5 陷阱 2：5 年平均列是区间戳，annualCols 天然拒它，intervalAvgCols 才收', () => {
  const b = stripHkPrefix(fx('hk_q2_sample.json'));
  assertEquals(annualCols(b, '股息率', true), ['股息率(股票获利率)[20251231]']);
  assertEquals(intervalAvgCols(b, '股息率'), ['股息率(股票获利率)平均[20211231-20251231]']);
});

Deno.test('年报列按戳升序 = 时间升序（真实夹具键序是 2024→2023→2025，字典序取首个会绑错）', () => {
  const a = stripHkPrefix(fx('hk_q1_sample.json'));
  assertEquals(windowCols(a, '投入资本回报率'), ['投入资本回报率[20231231]', '投入资本回报率[20241231]', '投入资本回报率[20251231]']);
  assertEquals(annualCols(a, '投入资本回报率', true).map(k => k.slice(-9, -1)), ['20231231', '20241231', '20251231']);
});

Deno.test('§2.5 陷阱 3：市盈率(pe,ttm) / 市净率(pb) 的括号别名以非中文开头 ⇒ colByPrefix 收', () => {
  const c = stripHkPrefix(fx('hk_q3_sample.json'));
  assertEquals(colByPrefix(c, '市盈率'), '市盈率(pe,ttm)[20261113]');
  assertEquals(colByPrefix(c, '市净率'), '市净率(pb)[20261113]');
});

Deno.test('真实夹具逐位：只落持仓 2 行（夹具 5 行），ROIC 与股息对齐 spec §2.4', () => {
  const { rows, stamps, years } = merge();
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(years, ['2023', '2024', '2025']);
  const t = rows[0], a = rows[1];
  assertEquals(t.name, '腾讯控股');
  assertEquals(t.roic3, [10.5299, 15.8648, 15.8625]);
  assertEquals(t.divYield, 0.8848080133555927);
  assertEquals(t.divY5y, 0.8381616844832607);
  assertEquals(t.pe, 13.078457);
  assertEquals(t.pb, 4.189377);
  assertEquals(a.name, '阿里巴巴-W');
  assertEquals(a.roic3, [6.4716, 6.909, 10.7987]);
  assertEquals(a.divYield, 1.51951171875);
  assertEquals(a.divY5y, 1.6028015582280901);
  assertEquals(stamps, { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' });
});

Deno.test('H-8 混合戳：PE 与 PB 各取自己的戳，不做跨戳比较、不做时点对齐', () => {
  const t3 = renameKey(fx('hk_q3_sample.json'), '港股@市净率(pb)[20261113]', '港股@市净率(pb)[20261112]');
  const { rows, stamps } = merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), t3);
  assertEquals(stamps.pe, '20261113');
  assertEquals(stamps.pb, '20261112');
  assertEquals(rows[0].pb, 4.189377);   // 值照取，不因戳不同而丢弃
});

Deno.test('H-7 单码缺席：某码在估值表缺席 ⇒ 该次字段落 null，不整批失败', () => {
  const { rows } = merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), dropRow(fx('hk_q3_sample.json'), '0700.HK'));
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(rows[0].pe, null);
  assertEquals(rows[0].pb, null);
  assertEquals(rows[0].roic3, [10.5299, 15.8648, 15.8625]);   // 其它两表照取
  assertEquals(rows[0].divYield, 0.8848080133555927);
  assertEquals(rows[1].pe, 21.12736);
});

Deno.test('锚 = 任一表命中：只在估值表出现的持仓码也要落行（ROIC/股息为 null）', () => {
  const { rows } = merge(dropRow(fx('hk_q1_sample.json'), '0700.HK'), dropRow(fx('hk_q2_sample.json'), '0700.HK'));
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(rows[0].roic3, [null, null, null]);
  assertEquals(rows[0].divYield, null);
  assertEquals(rows[0].name, '腾讯控股');   // 简称从估值表兜回来
  assertEquals(rows[0].pe, 13.078457);
});

Deno.test('股息空值落 null 而非 0（行在而值空，spec §3.3）', () => {
  const t2 = fx('hk_q2_sample.json');
  const j = (t2['股票代码'] as string[]).indexOf('0700.HK');
  (t2['港股@股息率(股票获利率)[20251231]'] as (number | null)[])[j] = null;
  (t2['港股@股息率(股票获利率)平均[20211231-20251231]'] as (number | null)[])[j] = null;
  const { rows } = merge(fx('hk_q1_sample.json'), t2);
  assertEquals(rows[0].divYield, null);
  assertEquals(rows[0].divY5y, null);
});

Deno.test('守卫变异①：年报列变 7 根（裸措辞形态）⇒ 必红', () => {
  const a = fx('hk_q1_sample.json');
  for (const s of ['20221231', '20260331', '20260630', '20260930']) a[`港股@投入资本回报率[${s}]`] = ['1', '1', '1', '1', '1'];
  assertMatch(thrownMessage(() => merge(a)), /expected exactly 3 window columns, got 7/);
});

Deno.test('守卫变异②：年报戳改中报 ⇒ 必红（防中报累计冒充当期，A 股决议27 原型事故）', () => {
  const a = renameKey(fx('hk_q1_sample.json'), '港股@投入资本回报率[20251231]', '港股@投入资本回报率[20250630]');
  assertMatch(thrownMessage(() => merge(a)), /expected 3 annual columns \(2023,2024,2025@1231\)/);
});

Deno.test('守卫变异③：年份错窗 ⇒ 必红', () => {
  const a = renameKey(fx('hk_q1_sample.json'), '港股@投入资本回报率[20231231]', '港股@投入资本回报率[20221231]');
  assertMatch(thrownMessage(() => merge(a)), /got 20221231,20241231,20251231/);
});

Deno.test('守卫变异④：任一查询 0 行 ⇒ 必红（不写空批）', () => {
  const empty: GsHkTable = { '股票代码': [], '股票简称': [], '港股@投入资本回报率[20231231]': [], '港股@投入资本回报率[20241231]': [], '港股@投入资本回报率[20251231]': [] };
  assertMatch(thrownMessage(() => mergeHkTables(empty, fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), HELD, NOW)), /GS hk q1 returned 0 rows/);
});

Deno.test('守卫变异⑤：持仓非空却零命中 ⇒ 必红（代码形态或宇宙变了，不得静默写空）', () => {
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), new Set(['00823']))), /持仓 1 只零命中/);
});

Deno.test('守卫变异⑥：q2 只剩「平均」兄弟列 ⇒ 必红（colByPrefix 会被兄弟列单独满足）', () => {
  const b: GsHkTable = {
    '股票代码': ['0700.HK'], '股票简称': ['腾讯控股'],
    '港股@股息率(股票获利率)平均[20211231-20251231]': [0.8381616844832607],
  };
  assertEquals(colByPrefix(stripHkPrefix(b), '股息率') !== undefined, true);   // 前缀守卫确实放行
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), b)), /GS hk q2 missing column: 股息率\(年报当期列\)/);
});

Deno.test('守卫变异⑦：两根区间平均列 ⇒ 必红（绑哪根不确定，宁拒绝不错位）', () => {
  const b = fx('hk_q2_sample.json');
  b['港股@股息率(股票获利率)平均[20201231-20241231]'] = [1, 1, 1, 1, 1];
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), b)), /expected at most 1 interval average column, got 2/);
});

Deno.test('守卫：q1 缺 ROIC 列 / q3 缺市盈率列 ⇒ 必红', () => {
  const a = fx('hk_q1_sample.json');
  for (const k of Object.keys(a)) if (k.startsWith('港股@投入资本回报率')) delete a[k];
  assertMatch(thrownMessage(() => assertHkCols(stripHkPrefix(a), 'q1')), /GS hk q1 missing column: 投入资本回报率/);
  const c = fx('hk_q3_sample.json');
  delete c['港股@市盈率(pe,ttm)[20261113]'];
  assertMatch(thrownMessage(() => assertHkCols(stripHkPrefix(c), 'q3')), /GS hk q3 missing column: 市盈率/);
});

Deno.test('隔离守卫：适配器不 import A 股模块（spec §5.2）', async () => {
  const src = await Deno.readTextFile(new URL('./gs_hk.ts', import.meta.url));
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '适配器不得 import A 股 gs_value.ts');
});
```

（「凭据脱敏」那条源码钉住测试要读 `index.ts`，该文件 Task 3 才建 ⇒ **不在本任务写**，Task 3 Step 1 会连同实现一起补上。本任务的 22 条全部只依赖 `gs_hk.ts` 与夹具。）

- [ ] **Step 3: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/gs_hk_test.ts`
Expected: FAIL — `Module not found "file:///.../supabase/functions/stock-value-hk/gs_hk.ts"`

- [ ] **Step 4: 写实现**

Create `supabase/functions/stock-value-hk/gs_hk.ts`:

```ts
// gs_hk.ts — GS 港股列式宽表 → HkRaw[]。规则权威：spec §2.1（三条生产查询串）/§2.5（列名契约与三条形态陷阱）/§5.1（守卫）
// 与 A 股 gs_value.ts 完全隔离（spec §5.2）：四个匹配器是复制体，不 import、不修改共享代码。
import type { HkRaw } from './hk_engine.ts';

export type GsHkTable = Record<string, (string | number | null)[]>;

export function hkYearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// 措辞是实测锁定的契约，不是可自由改写的自然语言：显式「年报」回 3 列，裸问「投入资本回报率」回 7 列（H-2）。
export const buildHkQ1 = (b: number): string =>
  `全部港股的${b - 2}年报投入资本回报率、${b - 1}年报投入资本回报率、${b}年报投入资本回报率、股票简称`;
export const HK_Q2 = '全部港股的股息率、近5年股息率平均值、股票简称';
export const HK_Q3 = '全部港股的市盈率、市净率、股票简称';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export async function gsHkFetch(query: string, apiKey: string, timeoutMs = 150_000): Promise<GsHkTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'HK_stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz code=${j?.result?.[0]?.code}`);   // 不带 msg 原文
      const t = j?.data?.[0]?.table as GsHkTable | undefined;
      if (!t?.['股票代码']) throw new Error('GS table missing');
      return t;
    } catch (e) {
      // TypeError.message 含完整 URL（带 apiKey）→ 折叠（同 A 股 gsValueFetch 先例）
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// H-6：财务/估值列一律 `港股@` 前缀，而 `股票简称`/`股票代码` 不带 ⇒ 有则剥、无则原样。
// 剥一次让四个匹配器原样复用 A 股规则；教匹配器认前缀会改到共享代码（spec §5.2 禁止）。
export function stripHkPrefix(t: GsHkTable): GsHkTable {
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) {
    const bare = k.replace(/^港股@/, '');
    // 剥完撞名 = 两列被静默合并成一列（`港股@股票简称` 与 `股票简称` 并存时）⇒ 宁拒绝不错位
    if (Object.prototype.hasOwnProperty.call(out, bare)) throw new Error(`GS hk column collision after prefix strip: ${bare}`);
    out[bare] = t[k];
  }
  return out;
}

// GS 已去前导零（`0700.HK` / `9988.HK`）⇒ 补零到 5 位与持仓/前端同形。非港股形态一律 null，不猜。
export function hkCodeOf(raw: string | number | null | undefined): string | null {
  const m = /^(\d{1,5})(?:\.HK)?$/i.exec(String(raw ?? '').trim());
  return m ? m[1].padStart(5, '0') : null;
}

const labelOf = (k: string): string => k.replace(/\[.*$/, '');
const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';          // 单期戳（A 股复制体）
const rangeOf = (key: string): string => key.match(/\[(\d{8}-\d{8})\]/)?.[1] ?? '';   // 区间戳原样（5 年平均列）

// 全等标签优先 → 前缀（拒中文后缀兄弟列）→ 标签最短 → 列名字典序。决定性，绝不返回「响应里第一个」。
// §2.5 陷阱 1：港股 `股息率(股票获利率)` 与 `…平均` 都能过中文后缀规则，胜负押在「标签最短」这一档。
export function colByPrefix(t: GsHkTable, prefix: string): string | undefined {
  const keys = Object.keys(t);
  const exact = keys.find(k => labelOf(k) === prefix);
  if (exact) return exact;
  return keys
    .filter(k => labelOf(k).startsWith(prefix) && !/^[\u4e00-\u9fff]/.test(labelOf(k).slice(prefix.length)))
    .sort((a, b) => labelOf(a).length - labelOf(b).length || (a < b ? -1 : 1))[0];
}

export function windowCols(t: GsHkTable, name: string): string[] {
  return Object.keys(t).filter(k => {
    const l = labelOf(k);
    if (!l.startsWith(name)) return false;
    const rest = l.slice(name.length);
    if (rest.length > 0 && /^[\u4e00-\u9fff]/.test(rest)) return false;
    return /\[\d{8}/.test(k.slice(l.length));
  }).sort();
}

export function annualCols(t: GsHkTable, labelPrefix: string, requireAnnualOnly = false): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length))
        && (!requireAnnualOnly || stampOf(k).endsWith('1231'));
    })
    .sort((a, b) => {
      if (stampOf(a) !== stampOf(b)) return stampOf(a) < stampOf(b) ? -1 : 1;
      return labelOf(a) < labelOf(b) ? -1 : labelOf(a) > labelOf(b) ? 1 : 0;
    });
}

// §2.5 陷阱 2：5 年平均列的戳是区间 `[a-b]`，annualCols 的 /^\[\d{8}\]$/ 天然拒它 ⇒ 必须另写匹配器，
// 不能靠 annualCols 取「最后一根」当 5 年平均。
export function intervalAvgCols(t: GsHkTable, labelPrefix: string): string[] {
  return Object.keys(t).filter(k => {
    const l = labelOf(k);
    return l.startsWith(labelPrefix) && l.includes('平均') && /^\[\d{8}-\d{8}\]$/.test(k.slice(l.length));
  }).sort();
}

const num = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;   // 文本列 / 带百分号列一律 null
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export type HkBatch = 'q1' | 'q2' | 'q3';
const REQUIRED: Record<HkBatch, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率'],
  q2: ['股票代码'],
  q3: ['股票代码', '市盈率', '市净率'],
};
export function assertHkCols(t: GsHkTable, fam: HkBatch): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS hk ${fam} missing column: ${name}`);
  // q2 的「当期股息率整列缺失」不能靠 colByPrefix 守：港股标签是 `股息率(股票获利率)`，全等通道不命中，
  // 前缀通道对 `…平均` 兄弟列同样放行（§2.5 陷阱 1）⇒ 兄弟列能单独满足守卫、当期列整列缺失也静默跑完整夜。
  // 改用形态判据：必须存在一根年报戳的当期股息率列。
  if (fam === 'q2' && annualCols(t, '股息率', true).length === 0) throw new Error('GS hk q2 missing column: 股息率(年报当期列)');
}

export function mergeHkTables(
  t1: GsHkTable, t2: GsHkTable, t3: GsHkTable, held: Set<string>, now: Date = new Date(),
): { rows: HkRaw[]; stamps: Record<string, string>; years: string[] } {
  const a = stripHkPrefix(t1), b = stripHkPrefix(t2), c = stripHkPrefix(t3);
  assertHkCols(a, 'q1'); assertHkCols(b, 'q2'); assertHkCols(c, 'q3');
  for (const [fam, t] of [['q1', a], ['q2', b], ['q3', c]] as const) {
    if ((t['股票代码']?.length ?? 0) === 0) throw new Error(`GS hk ${fam} returned 0 rows`);
  }
  const base = hkYearAnchors(now).annualBase;
  const wantYears = [base - 2, base - 1, base];
  const roicKeys = windowCols(a, '投入资本回报率');
  // H-2：措辞正确时必为 3 根；变 7 说明措辞被改写成裸问法 ⇒ 不为港股放宽这条守卫
  if (roicKeys.length !== 3) throw new Error(`GS hk q1 expected exactly 3 window columns, got ${roicKeys.length}`);
  const gotYears = roicKeys.map(k => stampOf(k).slice(0, 4)).join(',');
  if (roicKeys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears.join(','))
    throw new Error(`GS hk q1 expected 3 annual columns (${wantYears.join(',')}@1231), got ${roicKeys.map(stampOf).join(',')}`);

  // 股息当期：年报列按戳升序取最后一根（与 A 股 q5 dyCur 同规则）。**不硬绑 base 年**——
  // 1–4 月 base=前年而平台可能已回上一年年报，硬绑会让股息整腿静默变「无数据」四个月（spec §3）。
  const dyKeys = annualCols(b, '股息率', true);
  const dyCur = dyKeys.length > 0 ? dyKeys[dyKeys.length - 1] : null;
  const dy5Keys = intervalAvgCols(b, '股息率');
  if (dy5Keys.length > 1) throw new Error(`GS hk q2 expected at most 1 interval average column, got ${dy5Keys.length}`);
  const dy5Col = dy5Keys[0] ?? null;
  const peCol = colByPrefix(c, '市盈率')!, pbCol = colByPrefix(c, '市净率')!;

  const idx = (t: GsHkTable) => {
    const m = new Map<string, number>();
    (t['股票代码'] ?? []).forEach((raw, i) => {
      const code = hkCodeOf(raw);
      if (code !== null) m.set(code, i);
    });
    return m;
  };
  const i1 = idx(a), i2 = idx(b), i3 = idx(c);
  // 锚 = 持仓码在**任一**表里出现（H-7：宇宙行数随快照漂移，某码缺席是可能形态，不是整批失败）
  const anchor = [...held].filter(code => i1.has(code) || i2.has(code) || i3.has(code)).sort();
  if (anchor.length === 0) throw new Error(`GS hk: 持仓 ${held.size} 只零命中（代码形态或宇宙变了）`);

  const nk1 = colByPrefix(a, '股票简称'), nk2 = colByPrefix(b, '股票简称'), nk3 = colByPrefix(c, '股票简称');
  const at = (t: GsHkTable, k: string | null | undefined, i: number): number | null => (k && i >= 0 ? num(t[k]?.[i]) : null);
  const rows: HkRaw[] = anchor.map(code => {
    const j1 = i1.get(code) ?? -1, j2 = i2.get(code) ?? -1, j3 = i3.get(code) ?? -1;
    const name = str(nk1 ? a[nk1]?.[j1] : '') || str(nk2 ? b[nk2]?.[j2] : '') || str(nk3 ? c[nk3]?.[j3] : '');
    return {
      code, name,
      roic3: roicKeys.map(k => at(a, k, j1)),
      divYield: at(b, dyCur, j2), divY5y: at(b, dy5Col, j2),
      pe: at(c, peCol, j3), pb: at(c, pbCol, j3),
    };
  });
  // 时点纪律：每列各自的戳原样落库，不做跨戳比较、不做时点对齐（H-8：同批可能不同戳，无法对齐）
  const stamps: Record<string, string> = { roic: roicKeys.map(stampOf).join(',') };
  if (dyCur) stamps.div_cur = stampOf(dyCur);
  if (dy5Col) stamps.div_5y = rangeOf(dy5Col);
  stamps.pe = stampOf(peCol);
  stamps.pb = stampOf(pbCol);
  return { rows, stamps, years: wantYears.map(String) };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/gs_hk_test.ts`
Expected: PASS — 22 tests, 0 failures

- [ ] **Step 6: 变异检验（守卫真的会红）**

七条守卫逐条改松，确认**对应那条测试**变红，然后还原并复跑全绿。用一个驱动脚本跑完，避免手工 `cp` 忘记还原：

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
# 还原证明用 md5 前后对账，不用 `git diff --stat`：本任务的源文件此刻还是 untracked（Step 8 才提交），
# git diff 对未跟踪文件恒无输出 ⇒ 变异体留在文件里也会「看起来已还原」。
md5 -q supabase/functions/stock-value-hk/gs_hk.ts > /tmp/hk_gs_before.md5
NO_COLOR=1 python3 - <<'PY'
import os, re, subprocess, sys
p = 'supabase/functions/stock-value-hk/gs_hk.ts'
t = 'supabase/functions/stock-value-hk/gs_hk_test.ts'
orig = open(p, encoding='utf-8').read()
env = {**os.environ, 'NO_COLOR': '1'}
# (标签, 原文锚, 变异体, 必须变红的测试名子串)
MUT = [
  ('①年报列数', 'if (roicKeys.length !== 3)', 'if (roicKeys.length !== 7)', '守卫变异①'),
  ('②年报戳形', "if (roicKeys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears.join(','))",
                "if (gotYears !== wantYears.join(','))", '守卫变异②'),
  ('③年份错窗', "|| gotYears !== wantYears.join(',')", "|| false", '守卫变异③'),
  ('④查询0行', "if ((t['股票代码']?.length ?? 0) === 0)", 'if (false)', '守卫变异④'),
  ('⑤持仓零命中', 'if (anchor.length === 0)', 'if (false)', '守卫变异⑤'),
  ('⑥q2形态判据', "if (fam === 'q2' && annualCols(t, '股息率', true).length === 0)", 'if (false)', '守卫变异⑥'),
  ('⑦区间列唯一', 'if (dy5Keys.length > 1)', 'if (false)', '守卫变异⑦'),
]
def run(args):
    r = subprocess.run(['deno', 'test', '-A', t] + args, capture_output=True, text=True, env=env)
    return r.returncode, re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
bad = []
try:
    for name, old, new, want in MUT:
        n = orig.count(old)
        if n != 1:
            print(f'❌ 变异{name}: 锚命中 {n} 处（须恰好 1）⇒ 计划里的锚与实现漂移，先修锚'); bad.append(name); continue
        open(p, 'w', encoding='utf-8').write(orig.replace(old, new))
        rc, out = run(['--filter', want])
        ok = rc != 0 and 'FAILED' in out
        print(f'{"✅" if ok else "❌"} 变异{name} → 「{want}」{"变红" if ok else "没红（这条守卫是假的）"}')
        if not ok: bad.append(name); print(out[-500:])
finally:
    open(p, 'w', encoding='utf-8').write(orig)
rc, out = run([])
print('还原后全量:', 'PASS' if rc == 0 else 'FAIL\n' + out[-1500:])
sys.exit(1 if bad or rc != 0 else 0)
PY
echo "exit=$?"
md5 -q supabase/functions/stock-value-hk/gs_hk.ts > /tmp/hk_gs_after.md5
cmp /tmp/hk_gs_before.md5 /tmp/hk_gs_after.md5 && echo "restored byte-identical"
```

Expected: 七行全 `✅ … 变红`；`还原后全量: PASS`；`exit=0`；末行 `restored byte-identical`。

**两条锚的取舍已在沙箱实跑验证，不要「优化」它们**：

- 变异②必须取**整条 if 判据**换成只留年份检查。若改成「只留 `some(…1231)`、去掉年份检查」，放松的是③那条腿，②的测试照样红不了 ⇒ 检验假活（实跑确认过：该形态下 `守卫变异②` 仍 ok）。也不能只替换 `endsWith('1231')` 子串——它在 `annualCols` 里也出现，全局替换会连带改到取列逻辑。
- 变异③取 `|| gotYears !== wantYears.join(',')` 这个**带 `||` 的片段**，与②的整条 if 锚不重叠（②先跑、`finally` 还原后才跑③），两者各自证明一条测试非假。

- [ ] **Step 7: 类型与 lint 检查**

Run: `deno check supabase/functions/stock-value-hk/gs_hk.ts supabase/functions/stock-value-hk/gs_hk_test.ts && deno lint supabase/functions/stock-value-hk/`
Expected: 无 error

- [ ] **Step 8: 提交**

```bash
git add supabase/functions/stock-value-hk/gs_hk.ts supabase/functions/stock-value-hk/gs_hk_test.ts supabase/functions/stock-value-hk/fixtures/
git commit -m "$(cat <<'EOF'
feat(hk): GS 港股适配器，剥前缀后复用 A 股匹配规则

夹具取自 2026-11-14 实调切片（键序保持乱序原样）。当期股息率靠「标签最短」
胜出而非中文后缀拒绝，5 年平均是区间戳列需另写匹配器，q2 守卫改形态判据
防兄弟列单独满足；七条守卫逐条做变异检验。
EOF
)"
```

---

### Task 3: 编排层 `index.ts`

**Files:**
- Create: `supabase/functions/stock-value-hk/index.ts`
- Test: `supabase/functions/stock-value-hk/index_test.ts`
- Modify: `supabase/functions/stock-value-hk/gs_hk_test.ts`（补 Task 2 Step 2 暂缓的「凭据脱敏」测试）

**Interfaces:**
- Consumes: `computeHk`、`type HkRaw`、`type HkRow`（Task 1）；`gsHkFetch`、`buildHkQ1`、`HK_Q2`、`HK_Q3`、`hkYearAnchors`、`mergeHkTables`（Task 2）
- Produces:
  - `heldHkCodes(states: unknown[]): string[]`
  - `readStates(base: string, get?: StatesGet): Promise<unknown[]>`
  - `toHkDbRow(r: HkRow, batch: string, stamps: Record<string,string>, years: string[]): Record<string, unknown>`
  - `buildHkDbRows(rows: HkRow[], batch: string, stamps: Record<string,string>, years: string[]): Record<string, unknown>[]`
  - `upsertHk(rows: Record<string, unknown>[], onSent?: () => void, post?: PostFn): Promise<void>`
  - `runHkSummary(rows: HkRow[], batch: string, held: string[], stamps: Record<string,string>, years: string[]): Record<string, unknown>`
  - `errorHkBody(msg: string, wrote: boolean): Record<string, unknown>`

- [ ] **Step 1: 写失败测试**

Create `supabase/functions/stock-value-hk/index_test.ts`:

```ts
// supabase/functions/stock-value-hk/index_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeHk, type HkRaw, type HkRow } from './hk_engine.ts';
Deno.env.set('STOCK_VALUE_HK_DISABLE_SERVE', '1');   // import 即绑端口 → 必须先关
const { heldHkCodes, readStates, toHkDbRow, buildHkDbRows, upsertHk, runHkSummary, errorHkBody } = await import('./index.ts');

const STAMPS = { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' };
const YEARS = ['2023', '2024', '2025'];
const raw: HkRaw = { code: '00700', name: '腾讯控股', roic3: [10.5299, 15.8648, 15.8625],
  divYield: 0.8848080133555927, divY5y: 0.8381616844832607, pe: 13.078457, pb: 4.189377 };
const row: HkRow = computeHk(raw);

// readStates 的注入接缝：只开 get 一个口，不重构整个 handler（同 A 股 upsert 的 post 先例）
const page = (rows: unknown[], range: string | null, ok = true, status = 200) => ({
  ok, status, headers: { get: (k: string) => (k.toLowerCase() === 'content-range' ? range : null) },
  json: () => Promise.resolve(rows),
});

Deno.test('heldHkCodes：只收 5 位纯数字，跨用户合并去重并排序', () => {
  const states = [
    { user_id: 'u1', data: { stocks: [{ code: '00700' }, { code: '600031' }, { code: '09988' }] } },
    { user_id: 'u2', data: { stocks: [{ code: '00700' }, { code: ' 00823 ' }] } },
  ];
  assertEquals(heldHkCodes(states), ['00700', '00823', '09988']);
});

Deno.test('heldHkCodes：非数组 / 缺字段 / 空代码一律跳过，不抛错', () => {
  assertEquals(heldHkCodes([null, undefined, {}, { data: null }, { data: { stocks: 'x' } }, { data: { stocks: [null, {}, { code: '' }, { code: '700' }] } }]), []);
  assertEquals(heldHkCodes([]), []);
});

Deno.test('readStates：单页取全量，Content-Range 自证总数', async () => {
  const rows = [{ user_id: 'u1', data: { stocks: [{ code: '00700' }] } }];
  const got = await readStates('https://x', (() => Promise.resolve(page(rows, '0-0/1'))) as never);
  assertEquals(got, rows);
});

Deno.test('readStates 守卫：单页被 db-max-rows 截断 ⇒ 抛错（持仓集合不完整，拒绝跑批）', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ user_id: `u${i}`, data: { stocks: [] } }));
  const err = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page(rows, '0-999/1165'))) as never));
  assertEquals(String(err).includes('单页被截断（实得 1000 / 总数 1165）'), true);
});

Deno.test('readStates 守卫：拿不到 Content-Range / 非 2xx ⇒ 抛错', async () => {
  const e1 = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page([], null))) as never));
  assertEquals(String(e1).includes('Content-Range 拿不到总数'), true);
  const e2 = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page([], '0-0/1', false, 500))) as never));
  assertEquals(String(e2).includes('read dingtou_state: 500'), true);
});

Deno.test('toHkDbRow：列名逐字对齐迁移，roic_ok 三态原样落库，extras 三键', () => {
  const db = toHkDbRow(row, '2026-11-14', STAMPS, YEARS);
  assertEquals(db.batch_date, '2026-11-14');
  assertEquals(db.code, '00700');
  assertEquals(db.name, '腾讯控股');
  assertEquals(db.roic_cur, 15.8625);
  assertEquals(db.roic_med, 15.8625);
  assertEquals(db.roic_min3, 10.5299);
  assertEquals(db.div_yield, 0.8848080133555927);
  assertEquals(db.div_yield_5y, 0.8381616844832607);
  assertEquals(db.pe, 13.078457);
  assertEquals(db.pb, 4.189377);
  assertEquals(db.roic_ok, true);
  assertEquals(db.extras, { stamps: STAMPS, years: YEARS, missing: [] });
  // 港股不算安全边际 ⇒ 这些列必须**不存在**，而不是填 false/0 撒谎（spec §4）
  for (const k of ['rf_fallback', 'margin_of_safety', 'tier', 'vq', 'confidence', 'owner_yield', 'cn10y'])
    assertEquals(Object.prototype.hasOwnProperty.call(db, k), false, `不该有 ${k} 列`);
});

Deno.test('toHkDbRow：med 缺失 ⇒ roic_ok 落 null（三态），missing 列出缺值字段', () => {
  const db = toHkDbRow(computeHk({ ...raw, roic3: [9, null, null], divYield: null, pe: -1 }), '2026-11-14', STAMPS, YEARS);
  assertEquals(db.roic_med, null);
  assertEquals(db.roic_ok, null);
  assertEquals(db.pe, null);
  assertEquals((db.extras as { missing: string[] }).missing, ['roic_cur', 'roic_med', 'div_yield', 'pe']);
});

Deno.test('buildHkDbRows：逐行接线 stamps 与 years（漏接会让 extras 永远空）', () => {
  const rows = [row, computeHk({ ...raw, code: '09988', name: '阿里巴巴-W', roic3: [6.4716, 6.909, 10.7987] })];
  const dbs = buildHkDbRows(rows, '2026-11-14', STAMPS, YEARS);
  assertEquals(dbs.length, 2);
  assertEquals(dbs.map(d => d.code), ['00700', '09988']);
  assertEquals(dbs[1].roic_ok, false);
  for (const d of dbs) assertEquals((d.extras as { years: string[] }).years, YEARS);
});

Deno.test('upsertHk：URL 与 Prefer 正确，发出即报告（持仓个位数行 ⇒ 一次 POST，不分块）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  Deno.env.set('SB_SERVICE_KEY', 'svc');
  let reports = 0;
  const seen: { url: string; init: RequestInit }[] = [];
  await upsertHk([{ code: '00700' }], () => { reports++; }, ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve('') });
  }) as never);
  assertEquals(reports, 1);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, 'https://x/rest/v1/stock_value_hk?on_conflict=batch_date,code');
  assertEquals((seen[0].init.headers as Record<string, string>).Prefer, 'resolution=merge-duplicates');
  assertEquals((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer svc');
});

Deno.test('upsertHk：非 2xx 仍要报告已发出（PostgREST 可能已收下），且必须抛错', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  let reports = 0;
  const err = await assertRejects(() => upsertHk([{ code: '00700' }], () => { reports++; },
    (() => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') })) as never));
  assertEquals(reports, 1);
  assertEquals(String(err).includes('upsert stock_value_hk 502'), true);
  assertEquals(errorHkBody(String(err), true).kept_old_batch, false);   // 已发出 ⇒ 不得再称旧批保留
});

Deno.test('upsertHk：空行集一次也不发（不能发空数组去把本批当作空覆掉）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  await upsertHk([], () => { throw new Error('空批不应报告'); },
    (() => { throw new Error('空批不应发请求'); }) as never);
});

Deno.test('runHkSummary：三态计数 + missing_codes 列出零命中持仓（REIT 缺席必须可见）', () => {
  const rows = [row, computeHk({ ...raw, code: '09988', roic3: [6.4716, 6.909, 10.7987] }),
    computeHk({ ...raw, code: '00004', roic3: [9, null, null] })];
  const s = runHkSummary(rows, '2026-11-14', ['00004', '00700', '00823', '09988'], STAMPS, YEARS);
  assertEquals(s.ok, true);
  assertEquals(s.batch_date, '2026-11-14');
  assertEquals(s.rows, 3);
  assertEquals(s.held_hk, 4);
  assertEquals(s.roic_ok, 1);
  assertEquals(s.roic_fail, 1);
  assertEquals(s.roic_na, 1);
  assertEquals(s.missing_codes, ['00823']);
  assertEquals(s.stamps, STAMPS);
  assertEquals(s.years, YEARS);
});

Deno.test('errorHkBody：wrote 由实际写入过程回答，不得硬编', () => {
  assertEquals(errorHkBody('boom', false), { ok: false, error: 'boom', kept_old_batch: true });
  assertEquals(errorHkBody('boom', true).kept_old_batch, false);
});

Deno.test('接线守卫：无港股持仓的早返回必须在任何 GS 调用之前（spec §5 第2步）', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const skip = src.indexOf("skipped: 'no hk holdings'");
  const gs = src.indexOf('gsHkFetch(buildHkQ1');
  assertEquals(skip > 0, true, '缺 no hk holdings 早返回');
  assertEquals(gs > skip, true, '早返回必须在 GS 调用之前，否则空持仓夜也会发三次调用');
});

Deno.test('接线守卫：Deno.serve 被 DISABLE_SERVE 包住；鉴权与脱敏在位；不 import A 股模块', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(src.includes("if (!Deno.env.get('STOCK_VALUE_HK_DISABLE_SERVE')) {"), true, '测试无法 import（会绑端口）');
  assertEquals(src.includes("req.headers.get('Authorization') !== `Bearer ${token}`"), true, '缺 Bearer 鉴权');
  assertEquals(src.includes(".replace(/\\S*apiKey=\\S*/g, 'apiKey=REDACTED')"), true, '缺凭据脱敏');
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '不得 import A 股模块');
  assertEquals(src.includes('stock_value?'), false, '不得写 A 股表');
});
```

同时把 Task 2 Step 2 说明里暂缓的那条测试追加到 `gs_hk_test.ts` 末尾（此时 `index.ts` 已存在，读它不会 NotFound）：

```ts
Deno.test('凭据脱敏沿用 A 股做法：TypeError 折叠 + 错误体洗 apiKey（源码钉住）', async () => {
  const src = await Deno.readTextFile(new URL('./gs_hk.ts', import.meta.url));
  assertEquals(src.includes("e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e"), true,
    'TypeError.message 含带 apiKey 的完整 URL，必须折叠');
  assertEquals(/searchtype:\s*'HK_stock'/.test(src), true, '通道必须是 HK_stock');
  const idx = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(idx.includes(".replace(/\\S*apiKey=\\S*/g, 'apiKey=REDACTED')"), true, '错误响应必须洗掉 apiKey');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/index_test.ts`
Expected: FAIL — `Module not found "file:///.../supabase/functions/stock-value-hk/index.ts"`

- [ ] **Step 3: 写实现**

Create `supabase/functions/stock-value-hk/index.ts`:

```ts
/// <reference lib="deno.ns" />
// stock-value-hk 编排层。规则权威：spec §5（编排）/§5.1（守卫）/§5.2（隔离）/§4（落库）
import { computeHk, type HkRow } from './hk_engine.ts';
import { gsHkFetch, mergeHkTables, hkYearAnchors, buildHkQ1, HK_Q2, HK_Q3 } from './gs_hk.ts';

// 持仓是按用户存的 JSON（dingtou_state.data.stocks），不是关系表 ⇒ 范式照 daily-update/index.ts:1563 heldStocksOf。
// 只收 5 位纯数字（港股）；6 位是 A 股，走原价值腿，本函数一律不碰。
export function heldHkCodes(states: unknown[]): string[] {
  const out = new Set<string>();
  for (const u of states) {
    const arr = (u as { data?: { stocks?: unknown } })?.data?.stocks;
    if (!Array.isArray(arr)) continue;
    for (const x of arr as Array<{ code?: unknown }>) {
      const c = String(x?.code ?? '').trim();
      if (/^\d{5}$/.test(c)) out.add(c);
    }
  }
  return [...out].sort();
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

type StatesGet = (u: string, init: RequestInit) => Promise<{
  ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown>;
}>;

// 单页 + Content-Range 自证，**不写分页循环**：dingtou_state 一行一个用户，本工具是个人持仓，
// 行数远不到 db-max-rows=1000。真超过 1000 时这里的守卫会炸批而不是静默漏掉一部分用户的持仓
// （A 股 readAllRows 的 1000 行静默截断事故是同型缺陷，宁可显式失败）。
export async function readStates(base: string, get: StatesGet = fetch as unknown as StatesGet): Promise<unknown[]> {
  const r = await get(`${base}/rest/v1/dingtou_state?select=user_id,data&order=user_id.asc&limit=1000`,
    { headers: { ...svcHeaders(), 'Prefer': 'count=exact' } });
  if (!r.ok) throw new Error(`read dingtou_state: ${r.status}`);
  const m = /^(\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
  if (!m) throw new Error('read dingtou_state: Content-Range 拿不到总数（count=exact 未生效）');
  const rows = (await r.json()) as unknown[];
  const total = Number(m[3]);
  if (rows.length !== total) throw new Error(`read dingtou_state: 单页被截断（实得 ${rows.length} / 总数 ${total}）⇒ 持仓集合不完整，拒绝跑批`);
  return rows;
}

// 落库映射抽成导出纯函数（同 A 股 buildDbRows 的教训）：extras 的接线若留在 handler 里，
// 「stamps/years 永远空」这种错误就没有任何测试能发现。
export function toHkDbRow(
  r: HkRow, batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  return {
    batch_date: batch, code: r.code, name: r.name,
    roic_cur: r.roicCur, roic_med: r.roicMed, roic_min3: r.roicMin3,
    div_yield: r.divYield, div_yield_5y: r.divY5y,
    pe: r.pe, pb: r.pb, roic_ok: r.roicOk,
    extras: { stamps, years, missing: r.missing },
  };
}

export function buildHkDbRows(
  rows: HkRow[], batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown>[] {
  return rows.map(r => toHkDbRow(r, batch, stamps, years));
}

type PostFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// 持仓港股是个位数行 ⇒ 一次 POST，**不写分块循环**（A 股 5224 行才需要）。
// onSent 先报告再查状态：PostgREST 可能已收下但返回非 2xx，此时旧批已被覆盖，catch 里不能再称「保留」。
export async function upsertHk(rows: Record<string, unknown>[], onSent?: () => void, post: PostFn = fetch): Promise<void> {
  if (rows.length === 0) return;
  const url = Deno.env.get('SUPABASE_URL')!;
  const r = await post(`${url}/rest/v1/stock_value_hk?on_conflict=batch_date,code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  onSent?.();
  if (!r.ok) throw new Error(`upsert stock_value_hk ${r.status} ${await r.text()}`);
}

// 遥测：missing_codes 是「持仓非空但某码零命中」的唯一可见出口（REIT 不在宇宙内、宇宙快照漂移）。
// 不报数就永远是静默缺陷——页面只会显示「本批次无该股数据」，与「港股本来就不在范围内」外观一致。
export function runHkSummary(
  rows: HkRow[], batch: string, held: string[], stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  const got = new Set(rows.map(r => r.code));
  return {
    ok: true, batch_date: batch, rows: rows.length, held_hk: held.length,
    roic_ok: rows.filter(r => r.roicOk === true).length,
    roic_fail: rows.filter(r => r.roicOk === false).length,
    roic_na: rows.filter(r => r.roicOk === null).length,
    missing_codes: held.filter(c => !got.has(c)),
    stamps, years,
  };
}

export function errorHkBody(msg: string, wrote: boolean): Record<string, unknown> {
  return { ok: false, error: msg, kept_old_batch: !wrote };
}

if (!Deno.env.get('STOCK_VALUE_HK_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const url = Deno.env.get('SUPABASE_URL')!;
  // wrote 必须声明在 try 外面：try 内的 let 对 catch 不可见
  let wrote = false;
  try {
    const held = heldHkCodes(await readStates(url));
    // spec §5 第2步：空集 ⇒ 不发 GS 调用、不写表
    if (held.length === 0) return Response.json({ ok: true, skipped: 'no hk holdings' });
    const now = new Date();
    const { annualBase } = hkYearAnchors(now);
    const [t1, t2, t3] = await Promise.all([
      gsHkFetch(buildHkQ1(annualBase), key), gsHkFetch(HK_Q2, key), gsHkFetch(HK_Q3, key),
    ]);
    const { rows, stamps, years } = mergeHkTables(t1, t2, t3, new Set(held), now);
    const computed = rows.map(computeHk);
    const batch = now.toISOString().slice(0, 10);
    await upsertHk(buildHkDbRows(computed, batch, stamps, years), () => { wrote = true; });
    return Response.json(runHkSummary(computed, batch, held, stamps, years));
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsHkFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json(errorHkBody(msg, wrote), { status: 500 });
  }
});
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `NO_COLOR=1 deno test -A supabase/functions/stock-value-hk/`
Expected: PASS — 三个测试文件全绿（引擎 13 + 适配器 23 + 编排 15 = 51；适配器第 23 条就是本步骤补写的「凭据脱敏」）

- [ ] **Step 5: 全仓测试 + 类型 + lint**

Run: `NO_COLOR=1 deno task test && deno check supabase/functions/stock-value-hk/index.ts && deno lint supabase/functions/stock-value-hk/`
Expected: 全仓既有用例零回归（A 股价值腿一字未改），无 type error

- [ ] **Step 6: 提交**

```bash
git add supabase/functions/stock-value-hk/index.ts supabase/functions/stock-value-hk/index_test.ts supabase/functions/stock-value-hk/gs_hk_test.ts
git commit -m "$(cat <<'EOF'
feat(hk): 港股价值腿编排，只落持仓行、空持仓夜不调用 GS

readStates 单页 + Content-Range 自证，超 1000 行显式炸批而不是静默漏持仓；
missing_codes 把 REIT/宇宙漂移导致的零命中变成可见遥测；wrote 由实际发出回答。
EOF
)"
```

---

### Task 4: SQL 产物（迁移 + cron）与静态门禁

**Files:**
- Create: `scripts/migrate_stock_value_hk.sql`
- Create: `scripts/cron_stock_value_hk.sql`
- Test: `scripts/hk_sql_artifacts_test.ts`

**Interfaces:**
- Consumes: `toHkDbRow` 的列名集合（Task 3）——迁移的列必须与它逐字对齐
- Produces: 表 `stock_value_hk`（列：`batch_date, code, name, roic_cur, roic_med, roic_min3, div_yield, div_yield_5y, pe, pb, roic_ok, extras`）；cron job `stock-value-hk-nightly`

**本任务只创建文件，不执行。** 执行集中在 Task 8，需用户明示。

- [ ] **Step 1: 写失败测试**

Create `scripts/hk_sql_artifacts_test.ts`:

```ts
// scripts/hk_sql_artifacts_test.ts — 两份 SQL 产物的静态门禁（不连库、不执行）
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const read = (n: string) => Deno.readTextFile(new URL(`./${n}`, import.meta.url));

Deno.test('迁移：表名/主键/索引与 spec §4 逐字一致', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(s.includes('create table if not exists stock_value_hk ('), true);
  assertEquals(s.includes('primary key (batch_date, code)'), true);
  assertEquals(s.includes('create index if not exists stock_value_hk_batch_idx on stock_value_hk (batch_date);'), true);
  assertEquals(s.includes('drop table if exists stock_value_hk;'), true, '缺回滚语句');
});

Deno.test('迁移：列集合与 toHkDbRow 逐字对齐（多一列少一列都会让整批 insert 报错或静默丢字段）', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  const body = s.slice(s.indexOf('create table if not exists stock_value_hk ('), s.indexOf('primary key (batch_date, code)'));
  // 不加 ^ 锚：迁移里 `roic_cur numeric, roic_med numeric, roic_min3 numeric` 三个列共用一行（照 spec §4 原样），
  // 行首锚只会捞到每行第一列 ⇒ 12 列被数成 8 列，这条守卫会假红。
  const cols = [...body.matchAll(/([a-z_0-9]+)\s+(?:date|text|numeric|boolean|jsonb)\b/g)].map(m => m[1]);
  assertEquals(cols, ['batch_date', 'code', 'name', 'roic_cur', 'roic_med', 'roic_min3', 'div_yield', 'div_yield_5y', 'pe', 'pb', 'roic_ok', 'extras']);
});

Deno.test('迁移：roic_ok 是可空 boolean（三态），且**不得**有 rf_fallback / margin_of_safety / tier', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(/roic_ok boolean,/.test(s), true, 'roic_ok 必须可空：med=null 时落 null 而非 false');
  assertEquals(/roic_ok boolean not null/.test(s), false);
  // 只在 CREATE TABLE 的列定义里找禁用列名，并先剥掉行内注释：文件头部的说明性注释正当地提到
  // rf_fallback / tier / vq / confidence（解释「为什么不设」），全文扫会恒红。
  const body = s.slice(s.indexOf('create table if not exists stock_value_hk ('), s.indexOf('primary key (batch_date, code)'))
    .replace(/--[^\n]*/g, '');
  for (const k of ['rf_fallback', 'margin_of_safety', 'tier', 'vq', 'confidence', 'owner_yield', 'cn10y'])
    assertEquals(body.includes(k), false, `港股不算安全边际/门禁，不该有 ${k} 列（spec §4）`);
});

Deno.test('迁移：RLS 照 A 股同一范式——只读策略 + grant select + revoke 六项写权限', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(s.includes('alter table stock_value_hk enable row level security;'), true);
  assertEquals(s.includes('create policy "stock_value_hk read" on stock_value_hk for select to anon, authenticated using (true);'), true);
  assertEquals(s.includes('grant select on stock_value_hk to anon;'), true);
  assertEquals(s.includes('grant select on stock_value_hk to authenticated;'), true);
  assertEquals(s.includes('revoke insert, update, delete, truncate, references, trigger on stock_value_hk from anon, authenticated;'), true);
  assertEquals(/create policy .* for (insert|update|delete|all)/.test(s), false, '写路径必须靠「无写策略即拒绝」关闭');
});

Deno.test('迁移：不得触碰 A 股表（spec §11）', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  // `(if not exists )?` 必须在内：最可能的手滑正是 `create table if not exists stock_value`，
  // 少了这一段该形态就溜过守卫。`stock_value\b` 的 \b 在 `_hk` 前不成立 ⇒ 新表名不会误命中。
  assertEquals(/(alter|drop|create|insert into|update|delete from)\s+(table\s+)?(if\s+not\s+exists\s+)?stock_value\b(?!_hk)/.test(s), false, '不得改 stock_value');
  assertEquals(s.includes('value_config'), false);
});

Deno.test('cron：job 名/时刻/URL/超时与 spec §6 一致', async () => {
  const s = await read('cron_stock_value_hk.sql');
  assertEquals(s.includes("select cron.schedule('stock-value-hk-nightly', '50 13 * * *',"), true);
  assertEquals(s.includes('https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value-hk'), true);
  assertEquals(s.includes('timeout_milliseconds := 300000'), true, 'pg_net 默认 5000ms 会把响应掐断，调度侧永远看不见成败');
  assertEquals(s.includes("body := '{}'::jsonb"), true);
});

Deno.test('cron：令牌只用占位符，文件里不得出现真值形态', async () => {
  const s = await read('cron_stock_value_hk.sql');
  assertEquals(s.includes('Bearer $DAILY_UPDATE_TOKEN'), true);
  assertEquals(/\$DAILY_UPDATE_TOKEN/.test(s), true);
  // 真值形态：Bearer 后跟一长串非占位符的字母数字（占位符以 $ 开头，不会命中）
  assertEquals(/Bearer\s+[A-Za-z0-9_\-]{20,}/.test(s), false, 'cron 文件里出现疑似真令牌');
  assertEquals(s.includes('不得') && s.includes('job.command'), true, '必须写明执行后不得 select job.command');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A scripts/hk_sql_artifacts_test.ts`
Expected: FAIL — `NotFound: No such file or directory ... scripts/migrate_stock_value_hk.sql`

- [ ] **Step 3: 写迁移文件**

Create `scripts/migrate_stock_value_hk.sql`:

```sql
-- scripts/migrate_stock_value_hk.sql — 港股价值评估降维口径 spec §4
-- 执行方式: Management API POST /v1/projects/{ref}/database/query（同 migrate_stock_value.sql 历史执行方式）
-- ⚠ 本 Task 只创建文件；执行迁移需用户明示（Task 8 统一执行，执行前后做只读侦察与结构验收）。

create table if not exists stock_value_hk (
  batch_date date not null,
  code text not null,              -- 5 位补零，与持仓/前端同形（00700 / 09988）
  name text,
  roic_cur numeric, roic_med numeric, roic_min3 numeric,
  div_yield numeric, div_yield_5y numeric,
  pe numeric, pb numeric,
  roic_ok boolean,                 -- med>=8；med 为 null 时此列为 null（三态，不是布尔两态）
  extras jsonb,                    -- { stamps: {roic,div_cur,div_5y,pe,pb → 日期戳原样}, years: ["Y-2","Y-1","Y"], missing: [缺值字段名] }
  primary key (batch_date, code)
);
create index if not exists stock_value_hk_batch_idx on stock_value_hk (batch_date);

comment on column stock_value_hk.roic_ok is '三态：med>=8 为 true、med<8 为 false、med 为 null 时此列亦为 null。把数据缺口写成 false 等于把「不知道」说成「无护城河证据」';
comment on column stock_value_hk.roic_cur is '最新年报 ROIC，与 roic_med 相互独立：只缺最新一期时此列 null 而 med 照样有值，达标判定只看 med';
comment on column stock_value_hk.div_yield is '最新年报股息率；空值落 null 而非 0——港股未确认「空=从不分红」，与 A 股 P-6 语义不同（spec §3.3）';
comment on column stock_value_hk.extras is 'stamps 按列各自记戳（PE/PB 可能不同戳，不做时点对齐）；years 是三年窗；missing 是缺值字段名';

-- 不设 rf_fallback / margin_of_safety / tier / vq / confidence：港股不算安全边际、不产门禁结论。
-- A 股 rf_fallback 是 not null 且无 default 的 fail-loudly 设计；港股该列**不存在**，而不是填 false 撒谎。
-- 这是选择新表而非复用 stock_value 的首要理由（spec §4）。

-- RLS：读面向 anon + authenticated；写路径由「无写策略即拒绝」关闭，nightly 走 service_role BYPASSRLS
alter table stock_value_hk enable row level security;
drop policy if exists "stock_value_hk anon read" on stock_value_hk;
drop policy if exists "stock_value_hk read" on stock_value_hk;
create policy "stock_value_hk read" on stock_value_hk for select to anon, authenticated using (true);
grant select on stock_value_hk to anon;
grant select on stock_value_hk to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_value_hk from anon, authenticated;

-- 回滚（不留半坏状态给前端）：drop table if exists stock_value_hk;
```

- [ ] **Step 4: 写 cron 文件**

Create `scripts/cron_stock_value_hk.sql`:

```sql
-- stock-value-hk nightly: runs daily at 21:50 Beijing (13:50 UTC), 5 min after A 股 stock-value 21:45
-- 无数据依赖（不读 stock_value、不读主分），错开只为避免 GS 并发限流（spec §6）
-- 令牌用 $DAILY_UPDATE_TOKEN 占位，**不得**把真值写入本文件；执行后不得 select job.command（含 Bearer 原值）
-- timeout_milliseconds 必须显式给：pg_net 0.20.4 默认 5000ms 会把响应掐断，
-- net._http_response 恒 status_code=NULL 而 cron.job_run_details 恒 succeeded（http_post 只是入队）
-- ⇒ 调度侧永远看不见函数成败。A 股 2026-10-16 已踩过，同口径取 300000ms。
-- ⚠ 注册需用户明示（Task 8）。
select cron.schedule('stock-value-hk-nightly', '50 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value-hk',
    headers := jsonb_build_object('Authorization','Bearer $DAILY_UPDATE_TOKEN','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `NO_COLOR=1 deno test -A scripts/hk_sql_artifacts_test.ts`
Expected: PASS — 7 tests, 0 failures

- [ ] **Step 6: 凭据扫描**

Run: `deno task check-secrets`
Expected: PASS（两份新 SQL 只有占位符，无真值）

- [ ] **Step 7: 提交**

```bash
git add scripts/migrate_stock_value_hk.sql scripts/cron_stock_value_hk.sql scripts/hk_sql_artifacts_test.ts
git commit -m "$(cat <<'EOF'
feat(hk): stock_value_hk 迁移与夜间 cron 产物，静态门禁钉住结构

roic_ok 可空以承载三态；不设 rf_fallback 等安全边际列，避免填 false 撒谎。
RLS 只读、写路径无策略即拒绝；cron 21:50 北京、显式 300s 超时、令牌只留占位符。
EOF
)"
```

---

### Task 5: 构建产物 `deploy.ts` 与一致性门禁注册

**Files:**
- Create: `supabase/functions/stock-value-hk/build.ts`
- Create: `supabase/functions/stock-value-hk/deploy.ts`（**构建产物，由 build.ts 生成，不可手改**）
- Modify: `scripts/verify_deploy_bundles.ts:13-19`

**Interfaces:**
- Consumes: `hk_engine.ts`（Task 1）、`gs_hk.ts`（Task 2）、`index.ts`（Task 3）
- Produces: 自包含单文件 `deploy.ts`；`deno task verify-bundles stock-value-hk` 可校验

- [ ] **Step 1: 写 build.ts**

Create `supabase/functions/stock-value-hk/build.ts`:

```ts
// supabase/functions/stock-value-hk/build.ts —— 与 stock-value/build.ts 同构（拼接顺序：引擎→适配器→index）
// 本仓 deploy.ts 为构建产物，不可手改；改源模块后必须重跑本脚本再跑 deno task verify-bundles。
//  - 剥离所有相对模块 import（index→hk_engine/gs_hk），含内联 type 与多行形式
//    ⚠ 剥离正则要求 import 语句行尾无内容（引号闭合/分号后直接行尾）；残留由 assertNoResidualImport 在构建期拒绝
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
//  - 重名校验：bundle 后各文件顶层私有标识符共作用域，撞名会在 nightly 运行时炸链，构建期先拦（TS2451）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, "");
const rd = (f: string) =>
  stripRefs(Deno.readTextFileSync(f))
    .replace(/^import\s[^;]*?from\s*["']\.\/[^"']+["'];?[ \t]*$/gm, "")
    .replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(
      /^export\s+(interface|type|const|function|async\s+function)/gm,
      "$1",
    );

const DUP_RE =
  /^(?:const|let|var|function|async\s+function|class|interface|type)\s+([A-Za-z0-9_$]+)/gm;
function assertNoDup(src: string) {
  const seen = new Map<string, number>();
  for (const m of src.matchAll(DUP_RE)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const bad = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (bad.length > 0) {
    throw new Error(
      `bundle 顶层标识符重名: ${
        bad.join(", ")
      } ⇒ 请重命名所属文件的私有常量/助手`,
    );
  }
}

const RESIDUAL_RES = [
  /\bfrom\s*["']\.\.?\//,
  /^\s*import\s+["']\.\.?\//,
  /\bimport\s*\(\s*["']\.\.?\//,
  /\bfrom\s*["'](https?:|jsr:|npm:|node:)/,
];
function assertNoResidualImport(src: string) {
  const bad = src
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => RESIDUAL_RES.some((re) => re.test(l)));
  if (bad.length > 0) {
    throw new Error(
      `bundle 残留相对模块引用（剥离正则未命中）:\n` +
        bad.map(([n, l]) => `  deploy.ts 大致 L${n}: ${l}`).join("\n") +
        `\n⇒ 单文件部署必须自包含：import 语句行尾不得带注释/额外内容，` +
        `类型位置改用已拼接文件的裸类型名`,
    );
  }
}

const src = '/// <reference lib="deno.ns" />\n' +
  rd("hk_engine.ts") + "\n" + rd("gs_hk.ts") + "\n" + rd("index.ts");
assertNoDup(src);
assertNoResidualImport(src);
// 输出路径可选（缺省 deploy.ts）：一致性门禁把产物写到临时路径再与已提交 deploy.ts 逐字节比对
const out = Deno.args[0] ?? "deploy.ts";
Deno.writeTextFileSync(out, src);
console.log(`${out} bytes:`, src.length);
```

- [ ] **Step 2: 生成产物并确认自包含**

Run:
```bash
cd "/Users/alick/Documents/GitHub/fund invest/supabase/functions/stock-value-hk" && deno run --allow-read --allow-write build.ts && deno check deploy.ts
```
Expected: 打印 `deploy.ts bytes: <N>`；`deno check` 无 error（自包含，不联网拉模块）

若 `assertNoDup` 报重名：把撞名的私有常量/助手在所属文件里改名（例如 `num`/`str`/`labelOf` 只应出现一次），**不要**改门禁。

- [ ] **Step 3: 注册进一致性门禁**

Modify `scripts/verify_deploy_bundles.ts` — 把 `MODULES` 数组改成：

```ts
const MODULES = [
  "sector-trend",
  "stock-score",
  "stock-research",
  "business-mix",
  "stock-value",
  "stock-value-hk",
] as const;
```

- [ ] **Step 4: 跑门禁确认通过**

Run: `deno task verify-bundles`
Expected: 6 行全 `✅ 一致`，末行 `全部 6 个函数的 deploy.ts 与源码构建逐字节一致。`，退出码 0

- [ ] **Step 5: 证明门禁真的会拦漂移**

Run:
```bash
cd "/Users/alick/Documents/GitHub/fund invest"
# 还原证明不能用 `git diff --stat`：本任务的源文件此刻还是 untracked（Step 6 才提交），
# git diff 对未跟踪文件恒无输出 ⇒ 探针留在文件里也会「看起来已还原」。改用 md5 前后对账。
md5 -q supabase/functions/stock-value-hk/hk_engine.ts > /tmp/hk_engine_before.md5
printf '\n// drift probe\n' >> supabase/functions/stock-value-hk/hk_engine.ts
deno task verify-bundles stock-value-hk > /tmp/hk_drift.log 2>&1; echo "exit=$?"
python3 - <<'PY'
p='supabase/functions/stock-value-hk/hk_engine.ts'
s=open(p,encoding='utf-8').read()
assert s.endswith('\n// drift probe\n'), '探针不在文件末尾，还原会切错内容'
open(p,'w',encoding='utf-8').write(s[:-len('\n// drift probe\n')])
PY
deno task verify-bundles stock-value-hk > /tmp/hk_clean.log 2>&1; echo "exit=$?"
md5 -q supabase/functions/stock-value-hk/hk_engine.ts > /tmp/hk_engine_after.md5
cmp /tmp/hk_engine_before.md5 /tmp/hk_engine_after.md5 && echo "restored byte-identical"
```
Expected: 第一次 `exit=1` 且日志含 `❌ 漂移  stock-value-hk`；还原后 `exit=0`；末行 `restored byte-identical`（md5 与追加探针前相同）

- [ ] **Step 6: 全仓测试 + 提交**

Run: `NO_COLOR=1 deno task test`
Expected: 全绿

```bash
git add supabase/functions/stock-value-hk/build.ts supabase/functions/stock-value-hk/deploy.ts scripts/verify_deploy_bundles.ts
git commit -m "$(cat <<'EOF'
build(hk): stock-value-hk 单文件 bundle 与一致性门禁注册

deploy.ts 由 build.ts 拼接生成，含重名与残留 import 门禁；verify-bundles
覆盖范围从 5 个函数扩到 6 个，源模块改动忘记重跑构建从此会显式失败。
EOF
)"
```

---

### Task 6: 前端纯函数 `valueAssessmentHkHtml` + 逐字测试

**Files:**
- Modify: `index.html`（CSS 两处 + `VALUE_PURE` 块内新增三个函数）
- Modify: `scripts/value_leg_logic.ts:19`（`EXPORT_NAMES`）与 `:122` 后（typed exports）
- Test: `scripts/value_leg_logic_test.ts`（末尾追加）

**Interfaces:**
- Consumes: 块内既有 `valueNumOrNull`、`ROIC_GATE_PCT`（**不改它们**）
- Produces:
  - `hkFmtPct(v: number|null, d?: number): string` — 缺失回 `'无数据'`，负号 U+2212
  - `hkFmtNum(v: number|null, d?: number): string` — 同上，不带 `%`
  - `valueAssessmentHkHtml(hkRow: Record<string,unknown>|null|undefined, hasBatch: boolean): string`
  - CSS 类 `.value-hk-rows`（单列网格）

- [ ] **Step 1: 写失败测试**

在 `scripts/value_leg_logic_test.ts` **末尾追加**，并把三个新名字加进该文件**第 3–15 行那条** import（该文件有两条来自 `./value_leg_logic.ts` 的 import：第 3–15 行与第 76 行；加进前者，**不要新增第三条**）。

第 15 行 `  profitRefHtml, buyRefHtml } from "./value_leg_logic.ts";` 改成：
```ts
  profitRefHtml, buyRefHtml,
  hkFmtPct, hkFmtNum, valueAssessmentHkHtml } from "./value_leg_logic.ts";
```

末尾追加：
```ts
// ── 2026-11-14：港股降维口径价值评估（spec §7）。三行事实 + 两句常驻口径行，不产 tier/门禁/换仓 ──
// 夹具值取自 2026-11-14 GS 实调（spec §2.4）；估值两数逐日漂移，这里钉的是**格式**不是生产验收基准。
const hkTencent = {
  batch_date: '2026-11-14', code: '00700', name: '腾讯控股',
  roic_cur: 15.8625, roic_med: 15.8625, roic_min3: 10.5299,
  div_yield: 0.8848080133555927, div_yield_5y: 0.8381616844832607,
  pe: 13.078457, pb: 4.189377, roic_ok: true,
  extras: { stamps: { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' }, years: ['2023', '2024', '2025'], missing: [] },
};
const hkAlibaba = { ...hkTencent, code: '09988', name: '阿里巴巴-W',
  roic_cur: 10.7987, roic_med: 6.909, roic_min3: 6.4716,
  div_yield: 1.51951171875, div_yield_5y: 1.6028015582280901,
  pe: 21.12736, pb: 2.185361, roic_ok: false };

const HK_NOTE_1 = '港股只报资本回报、股息与估值三项；不评估安全边际，也不与同业比较';
const HK_NOTE_2 = '资本回报以 8% 为参照线，按平台日历年度口径，可能与公司自身财年不完全对齐';

Deno.test('港股逐字：腾讯三行事实 + 两句口径行全文比对（spec §7 输出形态）', () => {
  assertEquals(valueAssessmentHkHtml(hkTencent, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div>'
    + '<div class="value-hk-rows">'
    + '<div class="value-dim"><div class="dim-label">资本回报</div><div class="dim-val ok">达标 · 近三年中位 15.86%（最差年 10.53%）</div></div>'
    + '<div class="value-dim"><div class="dim-label">股息</div><div class="dim-val">0.88%（近五年平均 0.84%）</div></div>'
    + '<div class="value-dim"><div class="dim-label">估值</div><div class="dim-val">PE 13.08 · PB 4.19</div></div>'
    + '</div>'
    + '<div class="value-note">' + HK_NOTE_1 + '</div>'
    + '<div class="value-note">' + HK_NOTE_2 + '</div>'
    + '</div>');
});

Deno.test('港股逐字：阿里未达标（med 6.91 < 8）而 cur 10.80 达标 ⇒ 判定只看 med', () => {
  const h = valueAssessmentHkHtml(hkAlibaba, true);
  assertEquals(h.includes('<div class="dim-val warn">未达标 · 近三年中位 6.91%（最差年 6.47%）</div>'), true);
  assertEquals(h.includes('1.52%（近五年平均 1.60%）'), true);
  assertEquals(h.includes('PE 21.13 · PB 2.19'), true);
  assertEquals(h.includes('10.80'), false, 'cur 不参与判定，也不出现在文案里');
});

Deno.test('港股缺失：med=null ⇒ 资本回报「无数据」，不是「未达标」也不是 NA', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, roic_med: null, roic_min3: null, roic_ok: null }, true);
  assertEquals(h.includes('<div class="dim-val ">无数据</div>'), true);
  assertEquals(h.includes('未达标'), false);
  assertEquals(h.includes('达标 ·'), false);
  assertEquals(h.includes('NA'), false);
});

Deno.test('港股缺失：股息/估值逐项「无数据」，不显示 0、不显示 --', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, div_yield: null, div_yield_5y: null, pe: null, pb: null }, true);
  assertEquals(h.includes('<div class="dim-label">股息</div><div class="dim-val">无数据</div>'), true);
  assertEquals(h.includes('<div class="dim-label">估值</div><div class="dim-val">无数据</div>'), true);
  assertEquals(h.includes('0.00%'), false);
  assertEquals(h.includes('--'), false);
});

Deno.test('港股半缺：只有 PB 有值时逐项披露，不把整行判成无数据', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, pe: null }, true);
  assertEquals(h.includes('PE 无数据 · PB 4.19'), true);
  const h2 = valueAssessmentHkHtml({ ...hkTencent, div_yield_5y: null }, true);
  assertEquals(h2.includes('0.88%'), true);
  assertEquals(h2.includes('近五年平均'), false);
  const h3 = valueAssessmentHkHtml({ ...hkTencent, roic_min3: null }, true);
  assertEquals(h3.includes('达标 · 近三年中位 15.86%'), true);
  assertEquals(h3.includes('最差年'), false);
});

Deno.test('港股负号统一 U+2212：九龙仓真实形态（最差年 −2.036、PE 为负已归 null）', () => {
  const h = valueAssessmentHkHtml({ ...hkTencent, code: '00004', name: '九龙仓集团',
    roic_cur: 0.0313, roic_med: 0.0313, roic_min3: -2.036, roic_ok: false,
    div_yield: 1.8399264029438824, div_yield_5y: 1.734822560546205, pe: null, pb: 0.39938 }, true);
  assertEquals(h.includes('未达标 · 近三年中位 0.03%（最差年 −2.04%）'), true);
  assertEquals(h.includes('-2.04'), false, 'ASCII 负号必须替换成 U+2212');
  assertEquals(h.includes('PE 无数据 · PB 0.40'), true);
  assertEquals(hkFmtPct(-2.036, 2), '−2.04%');
  assertEquals(hkFmtNum(-1.5, 2), '−1.50');
});

Deno.test('港股格式化器：缺失回「无数据」（A 股 valueFmtPct 回 NA，口径不同故不复用）', () => {
  assertEquals(hkFmtPct(null), '无数据');
  assertEquals(hkFmtPct(undefined as unknown as null), '无数据');
  assertEquals(hkFmtPct(NaN), '无数据');
  assertEquals(hkFmtNum(null), '无数据');
  assertEquals(hkFmtPct(15.8625, 2), '15.86%');
  assertEquals(hkFmtNum(4.189377, 2), '4.19');
  assertEquals(valueFmtPct(null), 'NA', 'A 股格式化器口径一字未改');
});

Deno.test('港股批次三态：hasBatch=false 整区不出；true 但无行 ⇒ 沿用 A 股「本批次无该股数据（未判定）」句式', () => {
  assertEquals(valueAssessmentHkHtml(null, false), '');
  assertEquals(valueAssessmentHkHtml(undefined, false), '');
  assertEquals(valueAssessmentHkHtml(null, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div><div class="ref-empty">本批次无该股数据（未判定）</div></div>');
  assertEquals(valueAssessmentHkHtml(undefined, true),
    '<div class="ref-section"><div class="ref-title">价值评估</div><div class="ref-empty">本批次无该股数据（未判定）</div></div>');
});

Deno.test('港股不产指令：输出里没有 tier/门禁/同业/换仓字样，也没有 verdict 区', () => {
  const h = valueAssessmentHkHtml(hkTencent, true);
  // 「安全边际」不在禁用词表里：口径行必须明说「不评估安全边际」，禁它会与 spec §7 的常驻行直接冲突。
  // 禁的是**把它当一个维度报出来**，故下面另钉 dim-label 只有三个。
  for (const w of ['合格', '不合格', '硬否决', '同行业', '同业中位', '换仓', 'value-verdict', 'value-radar', '护城河'])
    assertEquals(h.includes(w), false, `港股栏不该出现「${w}」`);
  assertEquals(h.includes('不评估安全边际'), true);
  assertEquals([...h.matchAll(/<div class="dim-label">([^<]*)<\/div>/g)].map(m => m[1]), ['资本回报', '股息', '估值'],
    '只报三个维度；多出「安全边际」这一维就是越界产结论');
});

Deno.test('参照线只在口径行露一次；由 ROIC_GATE_PCT 插值，不得硬编码', async () => {
  const h = valueAssessmentHkHtml(hkTencent, true);
  // 不能数 '8%' 子串：腾讯股息 0.88% 里就含 '8%'，数子串会恒得 2 而假红。
  // 改数「为参照线」这个只可能出现在口径行的短语，并单独核事实行区块里不含参照线。
  assertEquals(h.split('为参照线').length - 1, 1, '参照线只能出现一次');
  const facts = h.slice(h.indexOf('<div class="value-hk-rows">'), h.indexOf('</div><div class="value-note">'));
  assertEquals(facts.includes('参照'), false, '三行事实里不得夹带参照线');
  assertEquals(h.includes(HK_NOTE_2), true);
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes("'<div class=\"value-note\">资本回报以 ' + ROIC_GATE_PCT + '% 为参照线"), true,
    '参照线必须由常量插值，硬编码 8 会与引擎漂移');
});

Deno.test('A 股文案零回归：两句 value-note 与四维标签逐字不变', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('价值评估只回答"值不值"，不等于买卖指令'), true);
  assertEquals(html.includes('护城河只看近三年资本回报（ROIC），不含市场份额与行业格局'), true);
  for (const w of ['护城河', '资本回报', '安全边际', '财务稳健'])
    assertEquals(html.includes('<div class="dim-label">' + w + '</div>'), true);
});

Deno.test('跨层契约：GS 夹具 → 适配器 → 引擎 → 落库行 → 前端 HTML 全链路逐字', async () => {
  Deno.env.set('STOCK_VALUE_HK_DISABLE_SERVE', '1');
  const { mergeHkTables } = await import('../supabase/functions/stock-value-hk/gs_hk.ts');
  const { computeHk } = await import('../supabase/functions/stock-value-hk/hk_engine.ts');
  const { toHkDbRow } = await import('../supabase/functions/stock-value-hk/index.ts');
  const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`../supabase/functions/stock-value-hk/fixtures/${n}`, import.meta.url)));
  const held = new Set(['00700', '09988']);
  const { rows, stamps, years } = mergeHkTables(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), held, new Date('2026-11-14T13:50:00Z'));
  const db = toHkDbRow(computeHk(rows[0]), '2026-11-14', stamps, years);
  // 前端读的列名必须与后端写的列名同源：任一端改名，这条就红
  assertEquals(valueAssessmentHkHtml(db, true), valueAssessmentHkHtml(hkTencent, true));
  const db2 = toHkDbRow(computeHk(rows[1]), '2026-11-14', stamps, years);
  assertEquals(valueAssessmentHkHtml(db2, true), valueAssessmentHkHtml(hkAlibaba, true));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A scripts/value_leg_logic_test.ts`
Expected: FAIL — `TS2305 [ERROR]: Module '"./value_leg_logic.ts"' has no exported member 'hkFmtPct'.`（门面还没导出这三个名字，Step 5 才加）。
若看到的是 `VALUE_PURE 块缺少导出：hkFmtPct, hkFmtNum, valueAssessmentHkHtml`，说明门面已加而 `index.html` 纯块还没加 —— 同样是预期的红，继续 Step 3。

- [ ] **Step 3: 加 CSS（两处，追加不动既有规则）**

在 `index.html` 的 `.value-radar{...}` 那一行**之后**插入：
```css
  /* 港股降维口径：三行事实竖排（A 股四维是 2×2 网格，口径不同故另立类，不改 .value-radar） */
  .value-hk-rows{display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:10px;}
```

在桌面端媒体查询里的 `.value-radar{gap:10px 16px;}` 那一行**之后**插入：
```css
    .value-hk-rows{gap:8px;}
```

- [ ] **Step 4: 加纯函数（`VALUE_PURE` 块内）**

在 `index.html` 里 `valueAssessmentHtml` 函数结束的 `}`（`return html;` 之后那一行）与 `function valueGateHtml(row, indByL2){` 之间插入：

```js
// ---- 港股价值评估（降维口径，2026-11-14）----
// 独立表 stock_value_hk，只报三行事实：资本回报 / 股息 / 估值。不产 tier、不算安全边际、不比同业。
// 缺失一律「无数据」：A 股 valueFmtPct 回 'NA'，口径不同 ⇒ 另写格式化器，不复用也不改它。
function hkFmtPct(v, d){
  if(v===null || v===undefined || isNaN(Number(v))) return '无数据';
  return Number(v).toFixed(d===undefined?2:d).replace('-', '\u2212') + '%';
}
function hkFmtNum(v, d){
  if(v===null || v===undefined || isNaN(Number(v))) return '无数据';
  return Number(v).toFixed(d===undefined?2:d).replace('-', '\u2212');
}
function valueAssessmentHkHtml(hkRow, hasBatch){
  if(!hkRow) return hasBatch ? '<div class="ref-section"><div class="ref-title">价值评估</div><div class="ref-empty">本批次无该股数据（未判定）</div></div>' : '';
  var med = valueNumOrNull(hkRow.roic_med);
  var min3 = valueNumOrNull(hkRow.roic_min3);
  var dy = valueNumOrNull(hkRow.div_yield);
  var dy5 = valueNumOrNull(hkRow.div_yield_5y);
  var pe = valueNumOrNull(hkRow.pe);
  var pb = valueNumOrNull(hkRow.pb);
  // 达标只看 med（cur 与 med 相互独立）；8% 由 ROIC_GATE_PCT 插值，与引擎同值由测试钉住
  var retTxt, retCls;
  if(med === null){ retTxt = '无数据'; retCls = ''; }
  else {
    var ok = med >= ROIC_GATE_PCT;
    retCls = ok ? 'ok' : 'warn';
    retTxt = (ok ? '达标' : '未达标') + ' · 近三年中位 ' + hkFmtPct(med, 2) + (min3 === null ? '' : '（最差年 ' + hkFmtPct(min3, 2) + '）');
  }
  var dyTxt = dy === null ? '无数据' : hkFmtPct(dy, 2) + (dy5 === null ? '' : '（近五年平均 ' + hkFmtPct(dy5, 2) + '）');
  var valTxt = (pe === null && pb === null) ? '无数据' : 'PE ' + hkFmtNum(pe, 2) + ' · PB ' + hkFmtNum(pb, 2);
  var html = '<div class="ref-section"><div class="ref-title">价值评估</div>';
  html += '<div class="value-hk-rows">';
  html += '<div class="value-dim"><div class="dim-label">资本回报</div><div class="dim-val ' + retCls + '">' + retTxt + '</div></div>';
  html += '<div class="value-dim"><div class="dim-label">股息</div><div class="dim-val">' + dyTxt + '</div></div>';
  html += '<div class="value-dim"><div class="dim-label">估值</div><div class="dim-val">' + valTxt + '</div></div>';
  html += '</div>';
  html += '<div class="value-note">港股只报资本回报、股息与估值三项；不评估安全边际，也不与同业比较</div>';
  html += '<div class="value-note">资本回报以 ' + ROIC_GATE_PCT + '% 为参照线，按平台日历年度口径，可能与公司自身财年不完全对齐</div>';
  html += '</div>';
  return html;
}
```

- [ ] **Step 5: 门面导出**

`scripts/value_leg_logic.ts` 的 `EXPORT_NAMES` 最后一行 `'profitRefHtml', 'buyRefHtml'];` 改成：
```ts
  'profitRefHtml', 'buyRefHtml',
  'hkFmtPct', 'hkFmtNum', 'valueAssessmentHkHtml'];
```

在 `valueAssessmentHtml` 的 typed export 之后追加：
```ts
/** 港股降维口径（2026-11-14）：三行事实 + 两句口径行；缺失回「无数据」而非 A 股的 'NA'。 */
export const hkFmtPct = NS.hkFmtPct as (v: number | null, d?: number) => string;
export const hkFmtNum = NS.hkFmtNum as (v: number | null, d?: number) => string;
export const valueAssessmentHkHtml = NS.valueAssessmentHkHtml as (
  row: Record<string, unknown> | null | undefined, hasBatch: boolean,
) => string;
```

- [ ] **Step 6: 跑测试确认通过**

Run: `NO_COLOR=1 deno test -A scripts/value_leg_logic_test.ts`
Expected: PASS — 既有全部用例 + 新增 12 条全绿

若 Edit 报「保存失败/无变更」：**先 grep 计数再决定是否重试**（`grep -c "function valueAssessmentHkHtml" index.html` 应为 1），防止重复插入。

- [ ] **Step 7: 全仓测试 + lint + 提交**

Run: `NO_COLOR=1 deno task test && deno lint scripts/value_leg_logic.ts scripts/value_leg_logic_test.ts`
Expected: 全绿，无新增 lint error

```bash
git add index.html scripts/value_leg_logic.ts scripts/value_leg_logic_test.ts
git commit -m "$(cat <<'EOF'
feat(hk): 港股价值评估栏纯函数，三行事实 + 两句口径行

缺失一律「无数据」而非 A 股的 NA，负号统一 U+2212，8% 由常量插值只露一次。
跨层契约测试把 GS 夹具→适配器→引擎→落库行→前端 HTML 串成一条，
任一端改列名都会红；A 股两句 value-note 与四维标签逐字未动。
EOF
)"
```

---

### Task 7: 前端接线（loader / state / 分流）与接线守卫改写

**Files:**
- Modify: `index.html`（state 变量、`Promise.all`、新 loader、ctx 解构、分流、ctx 传参）
- Test: `scripts/value_leg_logic_test.ts`（**改写**既有守卫「接线守卫：价值评估栏每卡常驻…」）+ 末尾追加新守卫

**Interfaces:**
- Consumes: `valueAssessmentHkHtml`（Task 6）；表 `stock_value_hk`（Task 4 定义，Task 8 才建）
- Produces: 全局 `valueHkState: { batch: string; rows: Map<string, Record<string,unknown>> } | null`；`loadStockValueHk(): Promise<void>`；`stockDetailFactsHtml` 的 ctx 新增 `hkRow`

**关键：既有接线守卫会因分流而变红，必须改写它钉住两条分支，不是删掉它。**

- [ ] **Step 1: 先跑一次确认既有守卫的现状**

Run: `NO_COLOR=1 deno test -A scripts/value_leg_logic_test.ts --filter "接线守卫：价值评估栏每卡常驻"`
Expected: PASS（此时还没改分流）

- [ ] **Step 2: 改写既有守卫 + 追加新守卫（先红）**

把标题为 `接线守卫：价值评估栏每卡常驻，行业参照与批次状态由调用点传入` 的那个 `Deno.test` **整块**替换为下面的版本。

**按标题定位，不要按行号**：该块在改动前是 `scripts/value_leg_logic_test.ts:1044-1055`，但 Task 6 Step 1 把 import 的一行拆成了两行 ⇒ 到本任务它已下移一行（1045-1056）。照旧行号替换会切掉相邻测试的首尾。定位命令：
```bash
grep -n "接线守卫：价值评估栏每卡常驻" scripts/value_leg_logic_test.ts
```

```ts
Deno.test('接线守卫：价值评估栏每卡常驻，行业参照与批次状态由调用点传入', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  // 2026-11-01 三栏收口：原来「灯亮才补一行否决标注」改成卡片常驻第三栏——价值只回答值不值，
  // 与买卖灯位无关，所以调用点前面不得再挂 sDipGate.light 这类指令门禁。
  assertEquals(/sDipGate\.light \? valueAssessmentHtml\(/.test(html), false,
    '价值栏一旦跟灯位绑定就又变回「抄底才提醒风险」的附属标注了');
  assertEquals(/const vRow = valueState \? valueState\.rows\.get\(/.test(html), true,
    '必须按 code 取本批次价值行（取不到就是未判定）');
  // 2026-11-14 港股分流：原断言只钉 A 股单分支，分流后必然红。**改写而非删除**——
  // 两条分支都要钉住，否则「港股接上了但 A 股被顺手改坏」或「A 股没动但港股根本没接」都能溜过。
  assertEquals(/const valueRef = isHk\s*\?\s*valueAssessmentHkHtml\(hkRow, !!valueHkState\)\s*:\s*valueAssessmentHtml\(vRow, valueIndRef \? valueIndRef\.byL2 : null, !!valueState\);/.test(html), true,
    '分流必须两条分支都在：港股走降维栏、A 股原调用一字不动，且行业参照与批次状态仍由调用点传入');
  assertEquals(html.includes("const isHk = /^\\d{5}$/.test(String(s.code||'').trim());"), true,
    '分流判据必须是 5 位码形态（港股），不得按名字或行业猜');
  assertEquals(/const hkRow = valueHkState \? valueHkState\.rows\.get\(/.test(html), true,
    '港股行必须按 code 取本批次（取不到就是未判定）');
  assertEquals(html.includes('${valueRef}'), true, '评估栏要渲染进卡片');
});
```

末尾追加：
```ts
Deno.test('接线守卫：港股取数是独立只读 loader，挂进首屏 Promise.all', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('async function loadStockValueHk('), true, '缺港股独立取数');
  assertEquals(/Promise\.all\(\[loadStockScores\(\), loadStockValue\(\), loadIncomeWatch\(\), loadValueIndustryRef\(\), loadStockValueHk\(\)\]\)/.test(html), true,
    '港股 loader 必须挂进首屏 Promise.all，否则渲染时 valueHkState 恒 null');
  const s = html.indexOf('async function loadStockValueHk(');
  const body = html.slice(s, html.indexOf('\n}\n', s));
  assertEquals(body.includes("sb.from('stock_value_hk')"), true, '必须读新表');
  assertEquals(body.includes("sb.from('stock_value')"), false, '不得读 A 股表');
  assertEquals(body.includes('.order('), true, '取最新批次必须显式排序');
  assertEquals(/filter\(c=>\/\^\\d\{5\}\$\/\.test\(c\)\)/.test(body), true, '只取 5 位港股码');
  assertEquals(body.includes('valueHkState = { batch, rows: new Map('), true, '必须落成 Map<code,row>');
});

Deno.test('接线守卫：A 股取数与门禁/换仓调用点一字未改（spec §11）', async () => {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  assertEquals(html.includes('${valueGateHtml(vRowForSwap, valueIndRef ? valueIndRef.byL2 : null)}'), true,
    '价值门禁仍只吃 A 股行；港股行天然取不到 ⇒ 返回空，无需额外屏蔽');
  assertEquals(html.includes('const swap = swapSuggest(vRowForSwap, valueRows, heldCodes);'), true);
  assertEquals(html.includes("const orFilter = legFilter(stocks.map(s=>s.code));"), true, 'loadStockValue 的取数范围未改');
  assertEquals(/function legFilter\(codes\)\{[\s\S]*?\/\^\\d\{5,6\}\$\//.test(html), true,
    'legFilter 的 5,6 位形态不改：它放行港股码去查 stock_value，而那张表没有港股行 ⇒ 返回空，无害');
});

Deno.test('港股行天然拿不到 A 股门禁与换仓（无需额外屏蔽，spec §7）', () => {
  assertEquals(valueGateHtml(null), '');
  assertEquals(swapSuggest(null, [], []), null);
  assertEquals(swapSuggest(undefined as unknown as null, [hkTencent as unknown as Record<string, unknown>], ['00700']), null);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `NO_COLOR=1 deno test -A scripts/value_leg_logic_test.ts --filter "接线守卫"`
Expected: FAIL — 改写后的「价值评估栏每卡常驻」与新增的「港股取数是独立只读 loader」两条红（分流与 loader 还没写）

- [ ] **Step 4: 加 state 变量**

在 `index.html` 的 `let incomeTried = false;` 那一行**之后**插入：
```js
// 港股价值腿（stock_value_hk 最新批次，降维口径）：独立表独立取数，null=未生成/读取失败 → 整区不出
let valueHkState = null;   // { batch, rows: Map<code,row> }
```

- [ ] **Step 5: 加 loader**

在 `index.html` 的 `loadIncomeWatch()` 函数结束（`}` 之后、`// 价值门禁的行业参照` 注释之前）插入：

```js
// 港股价值腿（stock_value_hk 只读，降维口径）：范式照 loadIncomeWatch——先取最新批次，再按持仓码取行。
// 单页足够：`.in('code', codes)` 已把范围限死在持仓港股（个位数），与 A 股腿的全市场读不同，
// 不存在 db-max-rows=1000 截断风险；仍显式 order 保证确定性（PostgREST 默认行序会漂移）。
async function loadStockValueHk(){
  if(!cloudReady || !sb) return;
  try{
    const codes = stocks.map(s=>String(s.code||'').trim()).filter(c=>/^\d{5}$/.test(c));
    if(!codes.length) return;
    const { data: b, error: be } = await sb.from('stock_value_hk').select('batch_date')
      .order('batch_date',{ascending:false}).limit(1).maybeSingle();
    if(be || !b) return;
    const batch = b.batch_date;
    const { data, error } = await sb.from('stock_value_hk').select('*')
      .eq('batch_date', batch).in('code', codes).order('code',{ascending:true});
    if(error || !data) return;
    valueHkState = { batch, rows: new Map(data.map(r=>[String(r.code), r])) };
  }catch(e){ console.warn('hk value load failed', e); }
}
```

- [ ] **Step 6: 挂进首屏 Promise.all**

把 `index.html` 的这一行：
```js
  Promise.all([loadStockScores(), loadStockValue(), loadIncomeWatch(), loadValueIndustryRef()]).then(()=>{ render(); loadTrendBadges(); });
```
改成：
```js
  Promise.all([loadStockScores(), loadStockValue(), loadIncomeWatch(), loadValueIndustryRef(), loadStockValueHk()]).then(()=>{ render(); loadTrendBadges(); });
```

- [ ] **Step 7: ctx 解构与分流**

把 `stockDetailFactsHtml` 的解构行：
```js
  const {sAlert, nextTier, ret, sSellPlan, sRef, pillCls, dev, sDipGate, sPlan, dCostStock, sDip, vRow} = ctx;
```
改成：
```js
  const {sAlert, nextTier, ret, sSellPlan, sRef, pillCls, dev, sDipGate, sPlan, dCostStock, sDip, vRow, hkRow} = ctx;
```

把 `const valueRef = valueAssessmentHtml(vRow, valueIndRef ? valueIndRef.byL2 : null, !!valueState);` 这一行改成：
```js
  // 港股（5 位码）走降维口径栏，A 股分支一字不动。valueGateHtml / swapSuggest 都以 stock_value 行为输入，
  // 港股码在那张表里取不到 ⇒ 天然返回空，无需额外屏蔽（spec §7）。
  const isHk = /^\d{5}$/.test(String(s.code||'').trim());
  const valueRef = isHk
    ? valueAssessmentHkHtml(hkRow, !!valueHkState)
    : valueAssessmentHtml(vRow, valueIndRef ? valueIndRef.byL2 : null, !!valueState);
```

- [ ] **Step 8: 取港股行并传进 ctx**

在 `const vRow = valueState ? valueState.rows.get(String(s.code||'').trim()) || null : null;` 那一行**之后**插入：
```js
    const hkRow = valueHkState ? valueHkState.rows.get(String(s.code||'').trim()) || null : null;
```

把 ctx 传参行：
```js
    factsEl.innerHTML = stockDetailFactsHtml(s, {sAlert, nextTier, ret, sSellPlan, sRef, pillCls, dev, sDipGate, sPlan, dCostStock, sDip, vRow});
```
改成：
```js
    factsEl.innerHTML = stockDetailFactsHtml(s, {sAlert, nextTier, ret, sSellPlan, sRef, pillCls, dev, sDipGate, sPlan, dCostStock, sDip, vRow, hkRow});
```

- [ ] **Step 9: 跑测试确认通过**

Run: `NO_COLOR=1 deno task test`
Expected: 全仓全绿（含改写后的接线守卫与三条新守卫）

每处 Edit 后若报「保存失败/无变更」，先 grep 计数再决定重试：
```bash
grep -c "loadStockValueHk" index.html      # 应为 2（定义 + Promise.all）
grep -c "valueAssessmentHkHtml" index.html # 应为 2（定义 + 分流调用）
grep -c "const hkRow = " index.html        # 应为 1
grep -c "const isHk = " index.html         # 应为 1
```

- [ ] **Step 10: 本地静态自检（不连生产）**

Run:
```bash
cd "/Users/alick/Documents/GitHub/fund invest"
node --input-type=module -e "
import {readFileSync} from 'node:fs';
const h=readFileSync('index.html','utf8');
const m=h.match(/\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/);
new Function(m[1]);            // 纯块语法可解析
console.log('pure block parses OK; valueAssessmentHkHtml defined:', /function valueAssessmentHkHtml\(/.test(m[1]));
console.log('hk loader defined:', /async function loadStockValueHk\(/.test(h));
console.log('css defined:', /\.value-hk-rows\{/.test(h));
"
```
Expected: 三行均 true / OK，无语法异常

- [ ] **Step 11: 提交**

```bash
git add index.html scripts/value_leg_logic_test.ts
git commit -m "$(cat <<'EOF'
feat(ui): 港股详情页按 5 位码分流到降维价值栏，独立只读 loader

既有接线守卫改写成钉住两条分支（不是删除），A 股调用与门禁/换仓接线逐字未动；
legFilter 的 5,6 位形态刻意不改——它放行港股码去查 stock_value 只会返回空。
EOF
)"
```

---

### Task 8: 生产执行与验收（**需用户明示，分两阶段**）

**Files:**
- 不改代码。只执行 SQL / 部署 / 只读核验，并把证据追加进 `.superpowers/sdd/2026-11-13-hk-value-lite/progress.md`

**Interfaces:**
- Consumes: Task 1–7 的全部产物；`deploy.ts` 已通过 `deno task verify-bundles`
- Produces: 生产表 `stock_value_hk`、现网 Edge Function `stock-value-hk`、cron job `stock-value-hk-nightly`、现网前端

**前置门禁（全部满足才动手，且每一项都要用户明示）：**
1. `NO_COLOR=1 deno task test` 全绿
2. `deno task verify-bundles` 6 个函数全 `✅ 一致`
3. `deno task check-secrets` 通过
4. 用户明确说「执行迁移 / 部署 / 注册 cron / 发布 Pages」

**凭据纪律：** PAT 只从 `~/.config/sector-rotation/supabase_pat` 读，用 python `.strip()`，绝不打印。`DAILY_UPDATE_TOKEN` 真值只在执行 cron SQL 的那一刻由 python 从环境/配置读入并替换占位符，**绝不写入任何文件**；执行后**不得** `select job.command`。

**网络口径（本阶段所有 SQL 与部署都走这一条路）：** 一律 `https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query`（Management API，本机可达）。**本机到 `*.supabase.co` 数据面被 SNI 级按域拦**（TLS 停在 Client Hello，重试 8/8 全挂，与客户端 TLS 形态无关）⇒ 不要直连 PostgREST 或函数 URL 做验收，也不要把连不上误判成「部署坏了」。下文所有 SQL 块都指「经该端点执行的只读/写入查询」。

#### 阶段 A：迁移 + 部署 + 注册 + 发布（一个会话内完成）

- [ ] **Step A1: 只读侦察（迁移前）**

用 Management API `POST /v1/projects/{ref}/database/query` 跑只读 SQL，把结果记进台账：
```sql
select table_name from information_schema.tables where table_name in ('stock_value','stock_value_hk');
select count(*) as stock_value_rows, max(batch_date) as latest from stock_value;
select jobname, schedule, active from cron.job where jobname like 'stock-value%' order by jobname;
```
再 `GET /v1/projects/{ref}/functions` 取现网版本清单（逐项 `slug/version/updated_at/verify_jwt`），与台账对齐；不一致先把差异写进台账再动手。

Expected: `stock_value_hk` **不存在**；`stock_value` 行数与最新批次记为基线（Step A9 要对账「一字未动」）；`stock-value-nightly` 存在且 active。

- [ ] **Step A2: 执行迁移**

把 `scripts/migrate_stock_value_hk.sql` 全文经 Management API `database/query` 执行。

Expected: 无 error。**若报错，停下来报告，不要重试改写后的 SQL**（先查清是权限、语法还是已存在）。

- [ ] **Step A3: 结构验收（只读）**

```sql
select column_name, data_type, is_nullable from information_schema.columns
 where table_name='stock_value_hk' order by ordinal_position;
select indexname from pg_indexes where tablename='stock_value_hk';
select polname, polcmd, polroles::regrole[] from pg_policy where polrelid='stock_value_hk'::regclass;
select relrowsecurity from pg_class where relname='stock_value_hk';
```
Expected: 12 列且顺序为 `batch_date, code, name, roic_cur, roic_med, roic_min3, div_yield, div_yield_5y, pe, pb, roic_ok, extras`；`roic_ok` 的 `is_nullable='YES'`；索引含 `stock_value_hk_batch_idx` 与主键；策略只有 1 条 `polcmd='r'`（SELECT）；`relrowsecurity=true`。

- [ ] **Step A4: 部署 Edge Function**

先确认产物一致：`deno task verify-bundles stock-value-hk` → `✅ 一致`。

用 Management API 部署（**`api.supabase.com` 本机可达；`*.supabase.co` 数据面被 SNI 级按域拦，不要拿它探活**）：

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
# entrypoint_path 必须是 **deploy.ts**（不是 index.ts）：上传的是单文件 bundle，平台把它放在 source/ 下，
# 写 index.ts 会返回 400 "Entrypoint path does not exist"。
# 权威依据：线上已跑通的 stock-score(v7)/sector-trend(v15) 的 GET /functions/<slug> 均以 source/deploy.ts 结尾；
# A 股 stock-value v1 也是按这条命令实做成功的（docs/superpowers/plans/2026-10-11-stock-value-leg.md:3361）。
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=stock-value-hk" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F 'metadata={"entrypoint_path":"deploy.ts","import_map_path":"","verify_jwt":false,"name":"stock-value-hk","no_cache":true};type=application/json' \
  -F "file=@supabase/functions/stock-value-hk/deploy.ts;type=application/typescript"
```

`$REF` = `sfauluwxmdginezbluvo`；`$SUPABASE_ACCESS_TOKEN` 由 python 从 `~/.config/sector-rotation/supabase_pat` 读入（`.strip()`）后注入环境，**绝不打印、绝不写入仓库文件**。

Expected: 返回 `version` 自增、`status ACTIVE`。**部署后不得用无凭据请求探活**——`verify_jwt=false` ⇒ 任何 GET/POST 都会真跑批并写表。也不要为「先 ping 一下」给函数加 `mode=ping` 分支：spec 没要求，加了就是越范围。

- [ ] **Step A5: 确认环境变量齐备**

`GET /v1/projects/{ref}/functions` 核对 `stock-value-hk` 的 `verify_jwt=false`；函数依赖 `GS_API_KEY` / `DAILY_UPDATE_TOKEN` / `SUPABASE_URL` / `SB_SERVICE_KEY`（或 `SUPABASE_SERVICE_ROLE_KEY`）——这些是项目级 secrets，A 股 `stock-value` 已在用，新函数自动继承。若首夜报 `GS_API_KEY missing`，按既有 secrets 配置流程补，**不要把 key 写进仓库任何文件**。

- [ ] **Step A6: 注册 cron**

读 `scripts/cron_stock_value_hk.sql`，用 python 把 `$DAILY_UPDATE_TOKEN` 替换成真值后**只在内存里**拼进 `database/query` 的请求体执行（替换后的 SQL 绝不落盘、绝不打印）。

Expected: 返回 jobid。

- [ ] **Step A7: cron 复核（不取 command）**

```sql
select jobid, jobname, schedule, active, database, username from cron.job where jobname='stock-value-hk-nightly';
```
Expected: 1 行，`schedule='50 13 * * *'`，`active=true`。**严禁** `select command` 或 `select *`（含 Bearer 原值）。

- [ ] **Step A8: 发布前端到 Cloudflare Pages**

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
cp index.html site/index.html && cmp index.html site/index.html && echo "staging byte-identical"
cd site && wrangler pages deploy . --project-name=fund-invest888 --branch=main > /tmp/hk_pages.log 2>&1; echo "exit=$?"
```
Expected: `cmp` 无输出 + `staging byte-identical`；`exit=0`；日志含新部署专属 URL `<hash>.fund-invest888.pages.dev`。**严禁把部署命令管道进 tail/head 后判成败。**

四路 md5 逐字节验收（本地 / staging / 专属 URL / 别名）：
```bash
cd "/Users/alick/Documents/GitHub/fund invest"
md5 -q index.html site/index.html
curl -sSL --retry 3 --retry-all-errors --max-time 120 "https://<hash>.fund-invest888.pages.dev/" -o /tmp/hk_live_hash.html
curl -sSL --retry 3 --retry-all-errors --max-time 120 "https://fund-invest888.pages.dev/" -o /tmp/hk_live_alias.html
wc -c /tmp/hk_live_hash.html /tmp/hk_live_alias.html
md5 -q /tmp/hk_live_hash.html /tmp/hk_live_alias.html
cmp index.html /tmp/hk_live_hash.html && cmp index.html /tmp/hk_live_alias.html && echo "four-way identical"
```
Expected: 四个 md5 全等、字节数全等、`four-way identical`。别名传播有延迟，必要时等约 25s 复验。**curl 失败不会覆盖 `-o` 目标**：若字节数明显偏小，那是传输截断而非内容不一致 ⇒ 删掉残留文件重取，不要据此判「漂移」。

- [ ] **Step A9: A 股零回归对账（只读）**

```sql
select count(*) as stock_value_rows, max(batch_date) as latest from stock_value;
```
Expected: 与 Step A1 基线**完全相同**（本任务不写 A 股表；若不同，说明有别的批次跑过，需在台账里注明原因而不是当作回归）。

- [ ] **Step A10: 台账追加**

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
mkdir -p .superpowers/sdd/2026-11-13-hk-value-lite
cat >> .superpowers/sdd/2026-11-13-hk-value-lite/progress.md <<'EOF'

## 2026-11-14 阶段 A：迁移 + 部署 + cron + Pages
- 迁移前基线：stock_value 行数=<填>，最新批次=<填>；stock_value_hk 不存在
- 迁移后结构：12 列、roic_ok 可空、RLS 只读策略 1 条、索引 2 个
- Edge：stock-value-hk v<填> ACTIVE，verify_jwt=false
- cron：stock-value-hk-nightly jobid=<填>，50 13 * * *，active=true（未取 command）
- Pages：部署 <hash>.fund-invest888.pages.dev，四路 md5=<填>，字节=<填>，cmp 一致
- A 股对账：stock_value 行数与最新批次与基线相同
EOF
```
（`<填>` 处写实测值；台账只追加，不改写历史条目。）

#### 阶段 B：首夜 cron 实跑后的只读验收（**次日**，21:50 北京之后）

- [ ] **Step B1: 调度与响应核验（只读）**

```sql
select status, return_message, start_time, end_time from cron.job_run_details
 where jobid=(select jobid from cron.job where jobname='stock-value-hk-nightly')
 order by start_time desc limit 3;
select id, status_code, error_msg, created from net._http_response order by created desc limit 5;
```
Expected: `status='succeeded'`；`net._http_response` 有对应行且 `status_code=200`（**不是 NULL**——NULL 意味着被 5s 超时掐断，说明 `timeout_milliseconds` 没生效）。

- [ ] **Step B2: 落库范围与数值验收（只读）**

```sql
select batch_date, code, name, roic_cur, roic_med, roic_min3, roic_ok,
       div_yield, div_yield_5y, pe, pb, extras
  from stock_value_hk
 where batch_date=(select max(batch_date) from stock_value_hk)
 order by code;
```
Expected（spec §10）：
- 行数 = 持仓港股只数（当前 2：`00700`、`09988`），**不含**全市场 2792 行
- `00700`：`roic_med=15.8625`、`roic_min3=10.5299`、`roic_ok=true`、`div_yield≈0.8848`、`div_yield_5y≈0.8382`
- `09988`：`roic_med=6.909`、`roic_min3=6.4716`、`roic_ok=false`、`roic_cur=10.7987`（cur 达标而 med 未达标 ⇒ 证明判定只看 med）、`div_yield≈1.5195`、`div_yield_5y≈1.6028`
- `pe`/`pb`：**有值且为正，与当日 GS 实调一致**（不钉死数值——spec §2.4：2026-11-14 腾讯 PB 已从 2.680 变为 4.189377）
- `extras.stamps` 五个键齐备，`extras.years=['2023','2024','2025']`，`extras.missing=[]`

- [ ] **Step B3: 当日估值实调对照（只读 GS）**

用 `gs-smart-stock-picking` 跑 `HK_Q3`（`全部港股的市盈率、市净率、股票简称`，`searchtype=HK_stock`），取 `0700.HK` / `9988.HK` 两行，与 Step B2 的 `pe`/`pb` 对照。

Expected: 一致（若 cron 与本次调用跨了快照刷新，允许差异，但需在台账记下两次的戳与值）。**调用后输出风险提示文案。**

- [ ] **Step B4: 浏览器 DOM 级实测（测绿不等于接线对）**

登录 `https://fund-invest888.pages.dev/`，打开腾讯 00700 与阿里 09988 的详情页，用 DOM 查询取 `.ref-section` 里标题为「价值评估」的那一块，核：
- 三行 `.value-dim` 的 `.dim-label` 依次是 `资本回报 / 股息 / 估值`
- 腾讯资本回报含 `达标 · 近三年中位 15.86%（最差年 10.53%）`，class 含 `ok`
- 阿里资本回报含 `未达标 · 近三年中位 6.91%（最差年 6.47%）`，class 含 `warn`
- 两句 `.value-note` 逐字等于 spec §7 的口径行，第二句含 `8%`
- **没有** `.value-radar`、`.value-verdict`、门禁明细、换仓横幅
- 再开一只 A 股持仓详情页，核四维雷达与两句 A 股 `.value-note` **逐字未变**

Expected: 全部命中。若显示「本批次无该股数据（未判定）」，说明 cron 还没跑或 `valueHkState` 没接上 ⇒ 回 Step B1/B2 查，不要改文案掩盖。

- [ ] **Step B5: 空持仓分支验收（只读推演，不写生产）**

不通过真跑验证（真跑需要清空持仓，属破坏性操作）。改为核对 Step B1 的响应体：若某夜持仓无港股，`runHkSummary` 不会执行，响应应是 `{"ok":true,"skipped":"no hk holdings"}`。该分支已由 Task 3 的接线守卫测试（早返回在 GS 调用之前）覆盖，**此处只记录「未做生产实测」这一事实**，不谎称已验。

- [ ] **Step B6: 邮件零回归**

核对次日邮件与前一日的结构一致（邮件端 `daily-update/index.ts` 全文 0 处 `stock_value`，本任务未改它）。Expected: 邮件内容不含港股价值三行，也不含任何新增段落。

- [ ] **Step B7: 台账追加验收证据**

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
cat >> .superpowers/sdd/2026-11-13-hk-value-lite/progress.md <<'EOF'

## 2026-11-15 阶段 B：首夜 cron 只读验收
- 调度：job_run_details status=<填>；net._http_response status_code=<填>（非 NULL）
- 落库：行数=<填>（= 持仓港股只数）；00700 med/min3/roic_ok=<填>；09988 med/min3/roic_ok/cur=<填>
- 估值：pe/pb 与当日 GS 实调对照=<填>（含两次的戳）
- DOM：腾讯/阿里三行 + 两句口径行逐字命中；A 股四维与两句 note 未变
- 空持仓分支：未做生产实测（由 Task 3 接线守卫覆盖）
- 邮件：结构与前一日一致，无新增段落
EOF
```

- [ ] **Step B8: 收尾**

Run: `git status --short && NO_COLOR=1 deno task test && deno task verify-bundles && deno task check-secrets`
Expected: 工作区只有台账（gitignored）与 `site/`（gitignored）变动，无未提交的源码漂移；三道门禁全绿。

**若用户要求提交/推送本阶段的文档更正**（spec 的 2026-11-14 更正目前未提交），按用户明示执行；否则保持未提交状态并告知。