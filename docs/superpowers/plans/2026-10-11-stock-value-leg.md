# 个股价值腿 VQ（stock-value）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建独立 Edge Function `stock-value` 与表 `stock_value`，每晚产出巴菲特式价值分 VQ + 绝对阈值门禁判定，与现有 `stock-score` V1.1 并行对照。

**Architecture:** 四层单向依赖——GS 列式宽表适配器（严格分批、缺列即整批拒绝）→ 纯函数引擎（绝对阈值门禁 + 四维百分位排序）→ 编排层（拉数、快照主分、落库）→ 前端只读渲染（价值 Top10 / 分歧榜 / 持仓胶囊 / 换仓提示行）。后端完全不知道持仓，换仓建议在前端纯逻辑层派生。

**Tech Stack:** Deno + TypeScript（断言 `https://deno.land/std@0.224.0/assert/mod.ts`）、Supabase Edge Functions / PostgREST / pg_cron、单文件 `index.html`（零构建）。

**Spec:** `docs/superpowers/specs/2026-10-11-stock-value-leg-design.md`（2026-10-11 用户批准）

---

## 计划对 spec 的五处修订（写计划与自审时发现 spec 不可实现或口径过简；执行前用户可否决任一条，否决则回 spec 重议）

| # | spec 原文 | 修订 | 理由 |
|---|---|---|---|
| A1 | §8 表含 `swap_suggest_of code`，由批次写入 | **该列不建**；换仓建议改由前端纯逻辑计算（Task 8） | 持仓只存在于浏览器 localStorage（按访问地址隔离），Edge Function 拿不到"当前持仓集合"，后端无从判定 X 相对 Y 的关系 |
| A2 | §9.2 `cn10y` 取数走 `gs-economy-query` | 改调该 skill 的底层 HTTP 端点 `GET https://dgzt.guosen.com.cn/skills/agent/adapter/query?text=&softName=goldsun_skills&apiKey=`，正则解析 + 合理性窗口 + `value_config.cn10y_override` 人工兜底 | skill 是本地 python 脚本，Edge 运行时无法执行；但其数据面可直连。响应是自然语言文本，必须带兜底位 |
| A3 | §3 "分位基准沿用 `assignGroups`" | 在 `value_engine.ts` 内**复制**一份分组/百分位 helper，不抽公共模块 | `stock-score` 已由 `build.ts` 拼接成冻结产物（用户裁定不改 V1.1）；抽公共模块要动它的构建链与 `deploy.ts`，风险大于 DRY 收益。复制处写"与 V1.1 语义对齐"注释 + 交叉单测钉住 |
| A4 | §8 "RLS 只读 anon" | 策略角色写 `to anon, authenticated`，并 `revoke insert/update/delete/truncate/references/trigger` | 既有教训（`scripts/migrate_sector_rotation_rls.sql` 的 I-1 补丁）：只授 anon 时，登录用户带 JWT 走 authenticated 角色 → 前端拿到「200 + 空数组」静默空白 |
| A5 | §7.2 归因句示例用「60 日涨幅组内 P9」 | 归因句改用**当晚快照的主分四条腿** `extras.main_legs`（`Q82/G40/V44/M30`）；§4.1 的“3 只样本校准”因三表接口列名未实测，改为探针先打印响应树、人工读数后回传误差计算（Task 10 Step 6b） | `stock_value` 不快照动量分位（§8 列清单里没有），而 `stock_score` 已有 `quality/growth/value/momentum` 四列，取快照零额外成本；同样能回答“为什么两套分数不一致”，且不引入新的 GS 调用。校准需真实响应形态，猜列名会违反“先探针后写解析器”纪律 | 待用户确认（AI 推荐取舍） |

---

## Global Constraints（每个 Task 隐含遵守）

- **不改现有规则**：`supabase/functions/stock-score/**` 一个字节都不改；`index.html` 既有主信号 / 双信号 / 止盈抄底横幅逻辑不改写、不重排优先级。
- **阈值与权重冻结**：`35/25/25/15` 与全部门槛常数（`ROIC_GATE=8`、`MOS_GATE=2`、`OWNER_YIELD_FLOOR=6`、`SWAP_GAP=5`、`VCOV_MIN=0.6`）是**前视验证的受试对象**，spec §8 时间表（2 个季度初读 / 6 个月才可谈接入）届满前一律不得调整；要改先改 spec 并留决策记录。
- **批次编排硬约束**：估值列（PE/PB/总市值）独立批次（P-3）；三年 ROIC 历史窗口列独占一批，绝不与三表科目混提（P-4）。
- **fail loudly**：任一必需列族缺失 → 整批拒绝、保留旧批次；禁止"缺列就静默 NA 跑完"（那会污染一整夜的前视样本）。
- **三种空值语义不得混用**：商誉空 → `0`；股息率空 → `0`（且仅在该批成功时；批次失败必须 NA）；PE≤0 / PB≤0 → NA。
- **`too_rich` 永远不等于卖出**；`swap_suggest` 只是持仓卡上多一行展示，不产生指令、不改写 `profitTiers` 与主信号。
- **凭据安全**：日志 / 响应体 / 错误对象一律不得输出 `GS_API_KEY`、`DAILY_UPDATE_TOKEN`、`SB_SERVICE_KEY`；上游 `msg` 原文不进错误信息；网络 `TypeError.message` 可能内嵌含 key 的完整 URL，必须折叠成无 URL 的通用信息（照 `stock-score/gs.ts` 119-121 的做法）。
- **生产写与提交都需逐次明示**：迁移执行、函数部署、cron 注册、`?mode=run` 调用、以及本计划任何 `git commit` —— 默认状态是**不执行 / 不提交**，此类步骤均带 `⚠ 需用户明示`。
- **只跑当晚截面，严禁回填历史**（spec §8 冷启动 + 时点纪律）：绝不用当期值反推历史基期（前视泄漏）；跨年比较只在相同报告期戳之间进行。历史只能靠逐夜积累，任何“补一把历史”的提议在本时间表届满前一律拒绝。
- **不在本计划范围**（spec §9 已列空位）：指数级 PE 历史分位（P-8 GS 无口径）、逐年股息序列（P-7 只给 5 年平均）、审计意见硬否决（P-5 实测全 None）、卖出侧规则（除 §7.3 一行展示外）。
- **单文件前端纪律**：页面运行时逻辑的唯一实现体留在 `index.html` 的 `VALUE_PURE_BEGIN/END` 标记块内；`scripts/value_leg_logic.ts` 只做**门面**（正则抽取 + `new Function` 执行 + 缺失即抛错），绝不复制第二份实现。
- **代码风格**：2 空格缩进、单引号、带分号；测试用 `Deno.test`；时钟可注入（不偷读挂钟）；fixture 用 `new URL('./fixtures/x.json', import.meta.url)` 锚定（CWD 无关）。
- **单位口径**：`fcff/cash/debt/mktcap` 全部**元**；`roic/gw/div_yield/pe/pb` 为百分数或倍数；派生率（`fcf_yield`、`ep`、`bm`、`norm_yield`、`owner_yield`）一律输出**百分数**；`cn10y` 传百分数（如 `1.85`），`margin_of_safety` 输出 **pp**。全链路只用比率派生，绝不跨批相减绝对额（P-4）。

---

## Task 1: 数据库迁移 `stock_value` + `value_config`

**Files:**
- Create: `scripts/migrate_stock_value.sql`
- 参照不改写: `scripts/migrate_sector_rotation.sql`、`scripts/migrate_sector_rotation_rls.sql`

**Interfaces:**
- Produces: 表 `stock_value`（列名即 Task 6 upsert payload 的键）、表 `value_config`（`cn10y_override numeric, cn10y_manual_on date, updated_at timestamptz`，单行 `id=1`）

- [ ] **Step 1: 写迁移文件（幂等：`create table if not exists` + `add column if not exists`）**

```sql
-- scripts/migrate_stock_value.sql — 个股价值腿 spec §8（修订 A1/A4 见 plans/2026-10-11-stock-value-leg.md）
-- 执行方式: Management API POST /v1/projects/{ref}/database/query（同 migrate_v11.sql 历史执行方式）
-- ⚠ 本 Task 只创建文件；执行迁移需用户明示（Task 10 统一执行）。

create table if not exists stock_value (
  batch_date date not null, code text not null, name text,
  ths_l1 text, ths_l2 text, in_pool boolean default false,
  -- 原始指标（GS 直取；单位见计划头「单位口径」）
  roic_cur numeric, fcff numeric, mktcap numeric, pe numeric, pb numeric,
  cash numeric, debt numeric, gw_pct numeric, div_yield numeric, div_yield_5y numeric,
  -- 派生比率（引擎产出；只用比率，不落绝对额供跨期比较 — P-4）
  roic_med numeric, roic_min3 numeric, ic numeric,
  fcf_yield numeric, ep numeric, bm numeric, norm_yield numeric,
  net_cash_ratio numeric, debt_ratio numeric,
  owner_yield numeric, margin_of_safety numeric, cn10y numeric, rf_fallback boolean default false,
  -- 排序层与判定
  vq numeric, v_moat numeric, v_cash numeric, v_safety numeric, v_health numeric,
  vcov numeric, tier text, confidence char(1),
  vetoed boolean default false, veto_reasons jsonb, flags jsonb,
  ind_rank integer, ind_n integer, market_rank integer, market_n integer,
  main_final numeric, main_confidence text,   -- 当晚 V1.1 主分快照（spec §8：半年后复盘免 join，不受主引擎改版断裂）
  extras jsonb,                                -- 全部 GS 列日期戳 + ic_approx + 告警
  primary key (batch_date, code)
);
create index if not exists stock_value_batch_tier_idx on stock_value (batch_date, tier);
create index if not exists stock_value_batch_vq_idx on stock_value (batch_date, vq desc);

comment on column stock_value.ic is '投入资本 = 货币资金 + 带息债务（近似，spec §4.1；extras.ic_approx=true 时成立）';
comment on column stock_value.margin_of_safety is 'owner_yield − cn10y（pp）；cn10y 缺失时为 null 且 rf_fallback=true';

create table if not exists value_config (
  id integer primary key default 1 check (id = 1),
  cn10y_override numeric,      -- 百分数（1.85 = 1.85%）；null = 不覆盖自动取数
  cn10y_manual_on date,
  updated_at timestamptz not null default now()
);
insert into value_config (id) values (1) on conflict (id) do nothing;

-- RLS：读面向 anon + authenticated（修订 A4）；写路径由「无写策略即拒绝」关闭，nightly 走 service_role BYPASSRLS
alter table stock_value enable row level security;
drop policy if exists "stock_value anon read" on stock_value;
drop policy if exists "stock_value read" on stock_value;
create policy "stock_value read" on stock_value for select to anon, authenticated using (true);
grant select on stock_value to anon;
grant select on stock_value to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_value from anon, authenticated;

alter table value_config enable row level security;
drop policy if exists "value_config anon read" on value_config;
drop policy if exists "value_config read" on value_config;
create policy "value_config read" on value_config for select to anon, authenticated using (true);
grant select on value_config to anon;
grant select on value_config to authenticated;
revoke insert, update, delete, truncate, references, trigger on value_config from anon, authenticated;

-- 回滚（不留半坏状态给前端）：drop table if exists stock_value; drop table if exists value_config;
```

- [ ] **Step 2: 静态自检（本地跑，不碰生产）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
grep -c "enable row level security" scripts/migrate_stock_value.sql                    # 期望 2
grep -c 'for select to anon, authenticated' scripts/migrate_stock_value.sql           # 期望 2
grep -c "revoke insert, update, delete, truncate, references, trigger" scripts/migrate_stock_value.sql  # 期望 2
grep -c "swap_suggest_of" scripts/migrate_stock_value.sql                               # 期望 0（修订 A1）
grep -c "primary key (batch_date, code)" scripts/migrate_stock_value.sql               # 期望 1
```

Expected: 2/2/2/0/1。任一不符 → 未按 A1/A4 落实，回改后重跑。

- [ ] **Step 3: 与 Task 6 的 upsert 键名交叉核对（先对齐再执行迁移）**

Task 6 写完后执行：

```bash
# 迁移列名
sed -n '/create table if not exists stock_value/,/primary key/p' scripts/migrate_stock_value.sql \
  | grep -oE '^\s+[a-z_0-9]+' | tr -d ' ' | sort > /tmp/db_cols.txt
# 编排层 payload 键
grep -oE '^\s+[a-z_0-9]+:' supabase/functions/stock-value/index.ts | tr -d ' :' | sort -u > /tmp/payload_keys.txt
diff /tmp/db_cols.txt /tmp/payload_keys.txt
```

Expected: 差异只允许是 `batch_date`/`code`（payload 里以 `batch_date: batch` 形态出现）。多键 → PostgREST `Could not find the ... column` 整批失败；少键 → 该列恒 NULL。本项目已踩过此坑，必须在此拦住。

- [ ] **Step 4: Commit（⚠ 需用户明示）**

```bash
git add scripts/migrate_stock_value.sql
git commit -m "feat(stock-value): add stock_value/value_config migration with anon+authenticated RLS"
```

---

## Task 2: GS 价值批适配器 `gs_value.ts`（P-3 / P-4 守卫的实现处）

**Files:**
- Create: `supabase/functions/stock-value/gs_value.ts`
- Create: `supabase/functions/stock-value/fixtures/vq1_sample.json` … `vq5_sample.json`
- Test: `supabase/functions/stock-value/gs_value_test.ts`

**Interfaces:**
- Consumes: 无（不 import `stock-score/*`）
- Produces:
  - `type GsTable = Record<string, (string | number | null)[]>`
  - `yearAnchors(now: Date): { annualBase: number }`、`V_Q1/V_Q2/V_Q4/V_Q5: string`、`buildVQ3(b: number): string`
  - `interface ValueRaw { code; name; ths: string[]; isFin; isST; roic; roic3: (number|null)[]; fcff; cash; debt; gw; pe; pb; mktcap; divYield; divY5y }`（数值位均 `number | null`）
  - `assertCols(t: GsTable, fam: 'q1'|'q2'|'q3'|'q4'|'q5'): void` — 缺列抛 `GS <fam> missing column: <名>`
  - `assertPeriod(t: GsTable, names: string[], now: Date): string` — 返回共同日期戳；批内不一致或期次非法即抛错
  - `mergeValueTables(t1,t2,t3,t4,t5: GsTable|null, now?: Date): { rows: ValueRaw[]; stamps: Record<string,string> }`
  - `gsValueFetch(query: string, apiKey: string, timeoutMs?: number): Promise<GsTable>`

- [ ] **Step 1: 写失败测试（7 条，全部无网络）**

```ts
// supabase/functions/stock-value/gs_value_test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertCols, assertPeriod, mergeValueTables, buildVQ3, yearAnchors, type GsTable } from './gs_value.ts';

const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url))) as GsTable;
const NOW = new Date('2026-10-11T13:30:00Z');   // 合成时钟：annualBase=2025，测试不随挂钟腐烂
const merge = (t5: GsTable | null = fx('vq5_sample.json'), t3: GsTable = fx('vq3_sample.json')) =>
  mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), t3, fx('vq4_sample.json'), t5, NOW);

Deno.test('V_Q3 措辞只由 annualBase 拼装，绝不硬编码年份', () => {
  assertEquals(yearAnchors(new Date('2026-03-01')).annualBase, 2024);   // 1-4 月年报未披露完，只能锚前年
  assertEquals(yearAnchors(new Date('2026-05-01')).annualBase, 2025);
  assertEquals(buildVQ3(2025), '全部沪深A股的2023年报投入资本回报率、2024年报投入资本回报率、2025年报投入资本回报率、股票简称');
});

Deno.test('P-3 守卫：请求了估值列但响应整列缺失 → 抛错（绝不静默 NA 跑完整夜）', () => {
  assertThrows(() => assertCols({ '股票代码': ['1'], '市净率[20260930]': ['1'] } as GsTable, 'q4'), /missing column: 市盈率/);
  assertCols({ '股票代码': ['1'], '股票简称': ['x'], '市盈率[20260930]': ['1'], '市净率[20260930]': ['1'], '总市值[20260930]': ['1'] } as GsTable, 'q4');
});

Deno.test('P-4 守卫：同批绝对值列日期戳不一致 → 抛错；一致则返回该戳', () => {
  assertThrows(() => assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20251231]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), /period mismatch/);
  assertEquals(assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20260630]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), '20260630');
});

Deno.test('P-4 守卫：日期戳漂到非合法报告期（混提历史窗口的典型症状）→ 抛错', () => {
  assertThrows(() => assertPeriod({ '股票代码': ['1'], '货币资金[20240630]': ['1'] } as GsTable, ['货币资金'], NOW),
    /not in allowed window/);   // 中报只可能是 base+1=2026 年，20240630 非法
});

Deno.test('科学计数法与千分位字符串不得被当成空值（探针第 5 轮误判成因）', () => {
  const rows = merge().rows;
  assertEquals(rows[0].fcff, 5400171000000);     // '5.400171E12'
  assertEquals(rows[1].debt, 123456789);         // '123,456,789'
});

Deno.test('股息率批次成功而该行空 = 从不分红 → 0；整批缺席 → NA（两种空值不可互换）', () => {
  assertEquals(merge().rows.find(r => r.code === '000001.SZ')!.divYield, 0);
  assertEquals(merge(null).rows.find(r => r.code === '000001.SZ')!.divYield, null);
  assertEquals(merge(null).rows.find(r => r.code === '000001.SZ')!.divY5y, null);
});

Deno.test('三年 ROIC 窗口列数≠3 → 整批抛错（宁拒绝不错位；P-2 齐备率 63% 是"行为空"不是"列数变"）', () => {
  const bad = { ...fx('vq3_sample.json') } as GsTable;
  delete bad['2023年报投入资本回报率[20231231]'];
  assertThrows(() => merge(undefined, bad), /exactly 3 window columns/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd supabase/functions/stock-value && deno test -A gs_value_test.ts`
Expected: FAIL — `Module not found: gs_value.ts`（及 fixtures 缺失）

- [ ] **Step 3: 写 fixtures（3 行覆盖 空商誉 / 空股息率 / 金融股 NA；列名带真实日期戳，键名含 `股票市场类型`——缺它会让 `isST` 静默全 true）**

`vq1_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "股票简称": ["测试制造", "测试地产", "测试银行"],
  "投入资本回报率[20260630]": ["18.4", "6.1", null],
  "所属同花顺行业": ["机械设备-工程机械-工程机械", "房地产-房地产开发-房地产开发", "银行-国有大型银行-国有大型银行"],
  "股票市场类型": ["全部A股(非ST);全部A股(非金融)", "全部A股(非ST);全部A股(非金融)", "全部A股(非ST)"] }
```

`vq2_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "企业自由现金流量fcff[20260630]": ["5.400171E12", "-2300000000", "12345678900"],
  "货币资金[20260630]": ["40000000000", "30000000000", "1800000000000"],
  "带息债务[20260630]": ["10000000000", "123456789", "2200000000000"],
  "商誉占净资产比例[20260630]": ["", "8.5", "0.2"] }
```

`vq3_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "2023年报投入资本回报率[20231231]": ["17.1", "7.0", null],
  "2024年报投入资本回报率[20241231]": ["18.0", "6.5", null],
  "2025年报投入资本回报率[20251231]": ["18.9", "6.2", null] }
```

`vq4_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "市盈率(pe)[20260930]": ["14.2", "38.0", "5.8"],
  "市净率(pb)[20260930]": ["2.1", "-0.5", "0.7"],
  "总市值[20260930]": ["20000000000", "5400171000000", "900000000000"] }
```

`vq5_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "股息率[20251231]": ["3.2", "", "5.1"],
  "股息率平均[20211231-20251231]": ["2.8", "", "4.9"] }
```

- [ ] **Step 4: 实现 `gs_value.ts`**

```ts
// gs_value.ts — GS 列式宽表 → ValueRaw[]。规则权威：spec §2（P-1..P-8）/§2.1（批次编排）
// 列名一律按前缀匹配，绝不硬编码日期戳（GS 的戳随快照漂移）；窗口列按字典序 = 时间序。
export type GsTable = Record<string, (string | number | null)[]>;

export function yearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// spec §2.1：V_Q3 独占历史窗口（P-4 混提会把三表科目戳整体改写成年报）；
// V_Q4 独占估值列（P-3 九字段大查询里 PE/PB 整列被丢弃）。
export const V_Q1 = '全部沪深A股的投入资本回报率、股票简称、所属同花顺行业、股票市场类型';
export const V_Q2 = '全部沪深A股的企业自由现金流量fcff、货币资金、带息债务、商誉占净资产比例、股票简称';
export const buildVQ3 = (b: number): string =>
  `全部沪深A股的${b - 2}年报投入资本回报率、${b - 1}年报投入资本回报率、${b}年报投入资本回报率、股票简称`;
export const V_Q4 = '全部沪深A股的市盈率、市净率、总市值、股票简称';
export const V_Q5 = '全部沪深A股的股息率、近5年股息率平均值、股票简称';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export async function gsValueFetch(query: string, apiKey: string, timeoutMs = 150_000): Promise<GsTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz code=${j?.result?.[0]?.code}`); // 不带 msg 原文
      const t = j?.data?.[0]?.table as GsTable | undefined;
      if (!t?.['股票代码']) throw new Error('GS table missing');
      return t;
    } catch (e) {
      // TypeError.message 含完整 URL（带 apiKey）→ 折叠（同 stock-score/gs.ts 先例）
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}
// 严格窗口列 `名称[yyyyMMdd...]`：排除 "资产负债率同比增长率" 这类同名前缀兄弟列
export function windowCols(t: GsTable, name: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(name + '[') && /\[\d{8}/.test(k.slice(name.length))).sort();
}

const num = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null; // 文本列 / 带百分号列一律 NA
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export type BatchName = 'q1' | 'q2' | 'q3' | 'q4' | 'q5';
const REQUIRED: Record<BatchName, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率', '所属同花顺行业', '股票市场类型'],
  q2: ['股票代码', '企业自由现金流量fcff', '货币资金', '带息债务', '商誉占净资产比例'],
  q3: ['股票代码', '投入资本回报率'],
  q4: ['股票代码', '市盈率', '市净率', '总市值'],
  q5: ['股票代码', '股息率'],
};
export function assertCols(t: GsTable, fam: BatchName): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS ${fam} missing column: ${name}`);
}

const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';

// P-4 双守卫：① 同批绝对值列必须共用一个戳（混提会整体改写）；② 戳必须落在合法报告期窗口
export function assertPeriod(t: GsTable, names: string[], now: Date): string {
  const stamps = new Set<string>();
  for (const n of names) for (const k of windowCols(t, n)) { const s = stampOf(k); if (s) stamps.add(s); }
  if (stamps.size === 0) throw new Error('GS period: no dated column found');
  if (stamps.size > 1) throw new Error(`GS period mismatch: ${[...stamps].sort().join(',')}`);
  const s = [...stamps][0];
  const y = Number(s.slice(0, 4)), mmdd = Number(s.slice(4));
  const base = yearAnchors(now).annualBase;
  const ok = mmdd === 1231 ? (y === base || y === base + 1) : (mmdd === 630 || mmdd === 930) ? y === base + 1 : false;
  if (!ok) throw new Error(`GS period not in allowed window: ${s} (annualBase=${base})`);
  return s;
}

export interface ValueRaw {
  code: string; name: string; ths: string[]; isFin: boolean; isST: boolean;
  roic: number | null; roic3: (number | null)[];
  fcff: number | null; cash: number | null; debt: number | null; gw: number | null;
  pe: number | null; pb: number | null; mktcap: number | null;
  divYield: number | null; divY5y: number | null;
}

export function mergeValueTables(
  t1: GsTable, t2: GsTable, t3: GsTable, t4: GsTable, t5: GsTable | null,
  now: Date = new Date(),
): { rows: ValueRaw[]; stamps: Record<string, string> } {
  assertCols(t1, 'q1'); assertCols(t2, 'q2'); assertCols(t3, 'q3'); assertCols(t4, 'q4');
  if (t5) assertCols(t5, 'q5');
  const stamp2 = assertPeriod(t2, ['货币资金', '带息债务', '企业自由现金流量fcff', '商誉占净资产比例'], now);
  const codes = t1['股票代码'] as string[];
  if ((t3['股票代码'] as string[]).length !== codes.length) throw new Error('GS q3 row count differs from q1');
  const roic3Keys = Object.keys(t3).filter(k => /^\d{4}年报投入资本回报率/.test(k)).sort();
  if (roic3Keys.length !== 3) throw new Error(`GS q3 expected exactly 3 window columns, got ${roic3Keys.length}`);
  const idx = (t: GsTable | null) => new Map(((t?.['股票代码'] as string[] | undefined) ?? []).map((c, i) => [c, i]));
  const i2 = idx(t2), i3 = idx(t3), i4 = idx(t4), i5 = t5 ? idx(t5) : null;
  const K = {
    name: colByPrefix(t1, '股票简称')!, ths: colByPrefix(t1, '所属同花顺行业')!, mkt: colByPrefix(t1, '股票市场类型')!,
    roic: colByPrefix(t1, '投入资本回报率')!,
    fcff: colByPrefix(t2, '企业自由现金流量fcff')!, cash: colByPrefix(t2, '货币资金')!,
    debt: colByPrefix(t2, '带息债务')!, gw: colByPrefix(t2, '商誉占净资产比例')!,
    pe: colByPrefix(t4, '市盈率')!, pb: colByPrefix(t4, '市净率')!, mc: colByPrefix(t4, '总市值')!,
    dy: t5 ? colByPrefix(t5, '股息率')! : null,
    dy5: t5 ? (Object.keys(t5).find(k => k.startsWith('股息率平均') || k.startsWith('近5年股息率')) ?? null) : null,
  };
  const at = (t: GsTable, k: string, i: number): number | null => (i >= 0 ? num(t[k]?.[i]) : null);
  const rows: ValueRaw[] = codes.map((code, i) => {
    const j2 = i2.get(code) ?? -1, j3 = i3.get(code) ?? -1, j4 = i4.get(code) ?? -1, j5 = i5?.get(code) ?? -1;
    const name = str(t1[K.name]?.[i]);
    const mkt = str(t1[K.mkt]?.[i]);   // GS 分层标签串（';' 分隔）；缺 "全部A股(非ST)" 即视为该类
    return {
      code, name, ths: str(t1[K.ths]?.[i]).split('-'),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      roic: at(t1, K.roic, i),
      roic3: roic3Keys.map(k => at(t3, k, j3)),
      fcff: at(t2, K.fcff, j2), cash: at(t2, K.cash, j2), debt: at(t2, K.debt, j2),
      gw: at(t2, K.gw, j2),                                    // 空值语义①：商誉空 → 0（在引擎侧落地）
      pe: at(t4, K.pe, j4), pb: at(t4, K.pb, j4), mktcap: at(t4, K.mc, j4),
      // 空值语义②：该批成功而行为空 = 从不分红 → 0；整批缺席 → null（NA），二者绝不可互换
      divYield: !t5 || K.dy === null ? null : at(t5, K.dy, j5) ?? 0,
      divY5y: !t5 || K.dy5 === null ? null : at(t5, K.dy5, j5) ?? 0,
    };
  });
  return { rows, stamps: { fin_period: stamp2, val_period: stampOf(K.pe), roic_period: stampOf(K.roic) } };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd supabase/functions/stock-value && deno test -A gs_value_test.ts && deno check gs_value.ts`
Expected: `ok | 7 passed | 0 failed`，`deno check` 无输出

- [ ] **Step 6: Commit（⚠ 需用户明示）**

```bash
git add supabase/functions/stock-value && \
git commit -m "feat(stock-value): GS value-batch adapter with P-3/P-4 column-family and period guards"
```

---

## Task 3: 引擎·门禁层（绝对阈值，与行业无关）

**Files:**
- Create: `supabase/functions/stock-value/value_engine.ts`（本 Task 只写门禁层；Task 4 追加排序层）
- Test: `supabase/functions/stock-value/value_engine_test.ts`

**Interfaces:**
- Consumes: `ValueRaw`（Task 2）
- Produces:
  - 常数 `ROIC_GATE=8`、`MOS_GATE=2`、`OWNER_YIELD_FLOOR=6`、`VETO_GUW=50`、`VETO_LEV=2`、`VCOV_MIN=0.6`
  - `interface Gate { ownerYield: number|null; mos: number|null; cn10y: number|null; rfFallback: boolean; icApprox: boolean; roicMed: number|null; fcfYield: number|null; normYield: number|null; passed: boolean; tooRich: boolean; vetoed: boolean; vetoReasons: string[] }`
  - `investedCapital(r: ValueRaw): number|null`
  - `roicStats(roic3: (number|null)[]): { med: number|null; min3: number|null }`
  - `ownerYieldOf(r, roicMed, cn10y): { cashY: number|null; normY: number|null; oy: number|null }`
  - `mosOf(oy, cn10y): { mos: number|null; rfFallback: boolean }`
  - `vetoesOf(r, roicMed, fin?: { roe: number|null }): string[]`
  - `gateOf(r, cn10y, fin?): Gate`

- [ ] **Step 1: 写失败测试（8 条）**

```ts
// supabase/functions/stock-value/value_engine_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { roicStats, investedCapital, ownerYieldOf, mosOf, vetoesOf, gateOf, ROIC_GATE, VETO_GUW } from './value_engine.ts';
import type { ValueRaw } from './gs_value.ts';

// 基准样本：市值 200 亿、FCFF 20 亿→cashY=10%；IC=40 亿、roic_med=15%→normY=3%；oy=min=3%
const mk = (o: Partial<ValueRaw> = {}): ValueRaw => ({
  code: '1', name: 'x', ths: ['A', 'B', 'C'], isFin: false, isST: false,
  roic: 15, roic3: [14, 15, 16], fcff: 2e9, cash: 3e9, debt: 1e9, gw: 0,
  pe: 20, pb: 2, mktcap: 2e10, divYield: 2, divY5y: 2, ...o,
});

Deno.test('roicStats：3 年取中位与最差年；非空 <2 期 → 双 NA（单值不构成“中位数”）', () => {
  assertEquals(roicStats([14, 16, 15]), { med: 15, min3: 14 });
  assertEquals(roicStats([14, null, 15]), { med: 14.5, min3: 14 });
  assertEquals(roicStats([14, null, null]), { med: null, min3: null });
  assertEquals(roicStats([]), { med: null, min3: null });
});

Deno.test('投入资本 = 货币资金 + 带息债务（近似）；任一缺 → null（不猜）', () => {
  assertEquals(investedCapital(mk()), 4e9);
  assertEquals(investedCapital(mk({ debt: null })), null);
});

Deno.test('owner_yield 取小：同时惩罚烧钱与周期虚高（spec §4 存在理由）', () => {
  const o = ownerYieldOf(mk(), 15, null);
  assertEquals(o.cashY, 10); assertEquals(o.normY, 3); assertEquals(o.oy, 3);
});

Deno.test('owner_yield 单腿 NA → 退回可得腿；双腿全 NA → null（不冒充 0）', () => {
  assertEquals(ownerYieldOf(mk({ fcff: null }), 15, null), { cashY: null, normY: 3, oy: 3 });
  assertEquals(ownerYieldOf(mk({ fcff: null }), null, null).oy, null);
});

Deno.test('mos = owner_yield − cn10y（pp）；cn10y NA → mos=null 且 rfFallback=true', () => {
  assertEquals(mosOf(8, 1.85), { mos: 6.15, rfFallback: false });
  assertEquals(mosOf(8, null), { mos: null, rfFallback: true });
  assertEquals(mosOf(null, 1.85), { mos: null, rfFallback: false });
});

Deno.test('四条硬否决逐条命中；商誉空按 0 不触发（空值语义①）', () => {
  assertEquals(vetoesOf(mk({ pb: -0.5 }), 15), ['资不抵债']);
  assertEquals(vetoesOf(mk({ gw: 55 }), 15), [`商誉/净资产>${VETO_GUW}%`]);
  assertEquals(vetoesOf(mk({ gw: null }), 15), []);
  assertEquals(vetoesOf(mk({ fcff: -1e9, debt: 3e9, cash: 1e9, roic: 5, roic3: [5, 4, null] }), 4.5),
    ['烧钱加杠杆', '无护城河证据']);
});

Deno.test('金融股否决4 走 ROE 对标：roic 天然 NA 不得整类误杀（P-1）', () => {
  const fin = mk({ isFin: true, roic: null, roic3: [null, null, null] });
  assertEquals(vetoesOf(fin, null, { roe: 15 }).includes('无护城河证据'), false);
  assertEquals(vetoesOf(fin, null, { roe: 3 }).includes('无护城河证据'), true);
  assertEquals(vetoesOf(fin, null, undefined).includes('无护城河证据'), false);  // 无 roe 输入 → 不判定，不算触发
});

Deno.test('门禁判定：否决 > oy≤0 > roic_med 不达标 > mos 不足（too_rich 不是卖出）', () => {
  const kind = (o: Partial<ValueRaw>, cn: number | null = 1.85) => {
    const x = gateOf(mk(o), cn);
    return x.vetoed ? 'vetoed' : x.passed ? 'gate_ok' : x.tooRich ? 'too_rich' : 'unqualified';
  };
  assertEquals(kind({ pb: -1 }), 'vetoed');
  assertEquals(kind({ fcff: -1e9 }), 'unqualified');                              // oy≤0（烧钱）
  assertEquals(kind({ roic: 6, roic3: [5, 6, 7] }), 'unqualified');               // roic_med 6 < 8
  assertEquals(kind({ fcff: 1e8 }), 'too_rich');                                  // oy=min(0.5,3)=0.5 → mos=-1.35
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }), 'gate_ok');    // oy=min(15,6.2)=6.2 → mos=4.35
  assertEquals(kind({ fcff: 1e8 }, null), 'too_rich');                             // rfFallback：oy 0.5 < 6
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }, null), 'gate_ok'); // rfFallback：oy=6.2 ≥ 6
});
```

> **手算复核要求（不得照抄直觉）**：`normY = roic_med × IC / 市值`，基准样本 `IC=4e9`、`市值=2e10` → 因子 `0.2`；故 `roic_med=31 → normY=6.2`，`roic_med=15 → normY=3`。期望值与实现不符时先重算，确认是实现错才改实现。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts`
Expected: FAIL — `Module not found: value_engine.ts`

- [ ] **Step 3: 实现门禁层**

```ts
// value_engine.ts — 价值腿纯函数（无 IO）。规则权威：spec §4（门禁）/§5（排序）/§6（置信度）
// 两层结构是本设计存在理由：门禁用绝对阈值（回答“值不值”，不被行业漂移污染），排序用组内
// 百分位（回答“合格者中谁更靠前”）。一只 60 倍 PE 的芯片股能在半导体组内排到“便宜”，
// 但它必须被门禁挡在 too_rich，绝不因百分位高而混进 Top10。
import type { ValueRaw } from './gs_value.ts';

export const ROIC_GATE = 8;             // %  常态资本回报下限（spec §4 硬门禁）
export const MOS_GATE = 2;              // pp 相对十年国债的最低超额（软门禁 → too_rich）
export const OWNER_YIELD_FLOOR = 6;     // %  cn10y 取不到时的绝对下限（spec §9.2）
export const VETO_GUW = 50;             // %  商誉/净资产（否决2）
export const VETO_LEV = 2;              // ×  带息债务/货币资金（否决3）
export const VCOV_MIN = 0.6;            //    有效覆盖低于此 → 不产出 VQ（spec §6）

export const investedCapital = (r: ValueRaw): number | null =>
  r.cash !== null && r.debt !== null ? r.cash + r.debt : null;   // spec §4.1 近似

export function roicStats(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

export function ownerYieldOf(r: ValueRaw, roicMed: number | null, _cn10y: number | null) {
  const ok = r.mktcap !== null && r.mktcap > 0;
  const cashY = ok && r.fcff !== null ? r.fcff / r.mktcap! * 100 : null;
  const ic = investedCapital(r);
  const normY = ok && roicMed !== null && ic !== null ? roicMed * ic / r.mktcap! : null;
  const legs = [cashY, normY].filter((x): x is number => x !== null);
  return { cashY, normY, oy: legs.length === 0 ? null : Math.min(...legs) };   // 取小 = 保守
}

export function mosOf(oy: number | null, cn10y: number | null): { mos: number | null; rfFallback: boolean } {
  if (oy === null) return { mos: null, rfFallback: cn10y === null };
  if (cn10y === null) return { mos: null, rfFallback: true };
  return { mos: oy - cn10y, rfFallback: false };
}

export function vetoesOf(r: ValueRaw, roicMed: number | null, fin?: { roe: number | null }): string[] {
  const out: string[] = [];
  if (r.pb !== null && r.pb < 0) out.push('资不抵债');                                       // 否决1
  if ((r.gw ?? 0) > VETO_GUW) out.push(`商誉/净资产>${VETO_GUW}%`);                             // 否决2（空=无商誉=0）
  if (r.fcff !== null && r.fcff < 0 && r.debt !== null && r.cash !== null && r.cash > 0 && r.debt / r.cash > VETO_LEV) {
    out.push('烧钱加杠杆');                                                                     // 否决3（价值陷阱标准形态）
  }
  // 否决4 附注：金融股 roic 天然 NA（P-1）→ 改用 ROE 对标；无 roe 输入则不判定
  const med = r.isFin ? fin?.roe ?? null : roicMed;
  const cur = r.isFin ? fin?.roe ?? null : r.roic;
  if (med !== null && cur !== null && med < ROIC_GATE && cur < ROIC_GATE) out.push('无护城河证据');
  return out;
}

export interface Gate {
  ownerYield: number | null; mos: number | null; cn10y: number | null; rfFallback: boolean;
  icApprox: boolean; roicMed: number | null; fcfYield: number | null; normYield: number | null;
  passed: boolean; tooRich: boolean; vetoed: boolean; vetoReasons: string[];
}

export function gateOf(r: ValueRaw, cn10y: number | null, fin?: { roe: number | null }): Gate {
  const { med } = roicStats(r.roic3);
  const { cashY, normY, oy } = ownerYieldOf(r, med, cn10y);
  const { mos, rfFallback } = mosOf(oy, cn10y);
  const vetoReasons = vetoesOf(r, med, fin);
  const oyPos = oy !== null && oy > 0;
  // 金融股不判 roic 腿（置 true，交排序层 NA 重归一与置信度体现）；非金融 NA 视为不达标（保守）
  const roicOk = r.isFin ? true : med === null ? false : med >= ROIC_GATE;
  const priceOk = oy === null ? false : mos !== null ? mos >= MOS_GATE : oy >= OWNER_YIELD_FLOOR;
  return {
    ownerYield: oy, mos, cn10y, rfFallback, icApprox: investedCapital(r) !== null,
    roicMed: med, fcfYield: cashY, normYield: normY,
    vetoed: vetoReasons.length > 0, vetoReasons,
    tooRich: vetoReasons.length === 0 && oyPos && roicOk && !priceOk,
    passed: vetoReasons.length === 0 && oyPos && roicOk && priceOk,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts && deno check value_engine.ts`
Expected: `ok | 8 passed | 0 failed`

- [ ] **Step 5: Commit（⚠ 需用户明示）**

```bash
git add supabase/functions/stock-value/value_engine.ts supabase/functions/stock-value/value_engine_test.ts && \
git commit -m "feat(stock-value): absolute-threshold gate layer (owner yield, MOS, four hard vetoes)"
```

---

## Task 4: 引擎·排序层 VQ + vcov + confidence + tier

**Files:**
- Modify: `supabase/functions/stock-value/value_engine.ts`（**追加到文件末尾**，不改 Task 3 已定稿部分）
- Test: `supabase/functions/stock-value/value_engine_test.ts`（追加）

**Interfaces:**
- Consumes: `ValueRaw`、`Gate`、`gateOf`、`roicStats`、`VCOV_MIN`
- Produces:
  - `W_VQ = { moat: 35, cash: 25, safety: 25, health: 15 }`
  - `assignGroupsV(rows: { code: string; ths: string[] }[]): Map<string, string>`
  - `pctWithinGroupsV(rows: ValueRaw[], get: (r: ValueRaw) => number | null): Map<string, number>`（组内 P1/P99 截尾 + 并列取中；恒正向，贵者已由取值环节取倒数）
  - `interface ValueRow extends ValueRaw { gate: Gate; vq: number|null; vMoat: number|null; vCash: number|null; vSafety: number|null; vHealth: number|null; vcov: number; tier: 'qualified'|'too_rich'|'unqualified'|'vetoed'; confidence: 'A'|'B'|'C'; grp: string; indRank: number; indN: number; marketRank: number; marketN: number; flags: string[] }`
  - `computeValue(rows: ValueRaw[], cn10y: number | null, finRoe?: Map<string, number>): ValueRow[]`

- [ ] **Step 1: 追加失败测试（7 条）**

```ts
import { computeValue, assignGroupsV, pctWithinGroupsV, VCOV_MIN } from './value_engine.ts';

// 同组宇宙（默认 30 只 ≥20 → 走 L2 分组），各腿均有区分度
const uni = (over: Partial<ValueRaw> = {}, n = 30): ValueRaw[] =>
  Array.from({ length: n }, (_, i) => mk({ code: `u${i}`, ths: ['测试业', '测试Ⅱ', 'x'],
    roic: 5 + i, roic3: [4 + i, 5 + i, 6 + i], fcff: (1 + i) * 1e9, pe: 40 - i / 2, pb: 1 + i / 10, ...over }));

Deno.test('A3 复制体守卫：分组回退与 V1.1 逐字对齐（L2≥20 → L1≥20 → MARKET）', () => {
  const many = uni({}, 20).map((s, i) => ({ ...s, code: `m${i}`, ths: ['传媒', '影视', 'x'] }));
  const few = uni({}, 8).map((s, i) => ({ ...s, code: `f${i}`, ths: ['综合', '综合Ⅱ', 'x'] }));
  const g = assignGroupsV([...many, ...few]);
  assertEquals(g.get('m0'), 'L2:传媒-影视');
  assertEquals(g.get('f0'), 'MARKET');
});

Deno.test('满腿宇宙：vcov=1、四维齐备、A 级、VQ 在合格者中单调', () => {
  const rows = computeValue(uni(), 1.85);
  const hi = rows.find(r => r.code === 'u29')!, lo = rows.find(r => r.code === 'u0')!;
  assertEquals(hi.vcov, 1);
  assertEquals([hi.vMoat, hi.vCash, hi.vSafety, hi.vHealth].every(v => v !== null), true);
  assertEquals(hi.confidence, 'A');
  assertEquals(hi.vq !== null && lo.vq !== null && hi.vq > lo.vq, true);
});

Deno.test('60 倍 PE 行业内相对最低 → 必须落 too_rich（两层结构存在理由，spec §10 黄金样本）', () => {
  // 半导体宇宙：24 只 PE=120、1 只 PE=60（组内估值百分位最优），但 owner_yield 依旧抵不过十年国债
  const semi = Array.from({ length: 25 }, (_, i) => mk({ code: `s${i}`, ths: ['电子', '半导体', 'x'],
    pe: i < 24 ? 120 : 60, fcff: i < 24 ? 1.67e8 : 3.33e8,   // cashY：0.835% vs 1.665%
    roic: 20, roic3: [20, 20, 20], mktcap: 2e10 }));
  const epPct = pctWithinGroupsV(semi, s => (s.pe! > 0 ? 100 / s.pe! : null));
  assertEquals(epPct.get('s24')! > epPct.get('s0')!, true);   // 百分位上它“便宜”
  const rel = computeValue(semi, 1.85).find(r => r.code === 's24')!;
  assertEquals(rel.tier, 'too_rich');                          // 门禁上它不便宜（oy=1.665 → mos=-0.185）
});

Deno.test('三种空值语义分别生效：商誉空→0 参与、股息空→0 参与、PE/PB 非正→NA', () => {
  const u = uni({ roic3: [15, 15, 15], roic: 15, fcff: 3e9 }, 25);
  u[0] = { ...u[0], code: 'e0', gw: null, divYield: null, divY5y: null, pe: -8, pb: -1 };
  const e0 = computeValue(u, 1.85).find(r => r.code === 'e0')!;
  assertEquals(e0.tier, 'vetoed');                              // PB<0 → 否决1，不许用 NA 兑过去
  assertEquals(e0.flags.includes('pe_na_nonpositive'), true);
  assertEquals(e0.flags.includes('gw_empty_as_zero'), true);
  assertEquals(e0.vCash !== null, true);                        // 股息腿以 0 参与，现金腿仍在
});

Deno.test('vcov<0.6 → vq=null 但原始指标照落（前视需要知道被排除的那批后来如何）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'v0', roic: null, roic3: [], fcff: null, cash: null, divY5y: null };
  const v0 = computeValue(u, 1.85).find(r => r.code === 'v0')!;
  assertEquals(v0.vq, null);
  assertEquals(v0.vcov < VCOV_MIN, true);
  assertEquals(v0.tier, 'unqualified');   // oy=null → 门禁不过
  assertEquals(v0.roic3.length, 0);       // 原始位照留
});

Deno.test('置信度：缺 ≥2 维 或 MARKET 且组内<20 或 vcov<0.6 → C；缺 1 维 或带 flag → B；否则 A', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'c0', roic3: [15, null, null] };   // roicMed/min3 两腿 NA，但 roicCur 在 → 不缺维
  assertEquals(computeValue(u, 1.85).find(r => r.code === 'c0')!.confidence, 'B');  // 带 roic_3y_incomplete flag
  const small = uni({}, 10).map((s, i) => ({ ...s, code: `s${i}`, ths: ['稀有', '稀有Ⅱ', 'x'] }));
  assertEquals(computeValue(small, 1.85).every(r => r.confidence === 'C'), true);   // 组内<20 → MARKET
});

Deno.test('tier 判定顺序 vetoed > unqualified > too_rich > qualified；否决者照落库', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 't0', pb: -1 };
  u[1] = { ...u[1], code: 't1', fcff: -5e8 };
  const rows = computeValue(u, 1.85);
  assertEquals(rows.find(r => r.code === 't0')!.tier, 'vetoed');
  assertEquals(rows.find(r => r.code === 't1')!.tier, 'unqualified');
  assertEquals(rows.filter(r => r.tier === 'qualified').length > 0, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts`
Expected: FAIL — `computeValue is not exported`（Task 3 的 8 条仍 PASS）

- [ ] **Step 3: 追加排序层实现到 `value_engine.ts` 末尾**

```ts
// ---- 排序层（spec §5）：四维百分位加权合成。组内 P1/P99 截尾 + 并列取中，沿用 V1.1 语义 ----
export const W_VQ = { moat: 35, cash: 25, safety: 25, health: 15 };
const W_MOAT = { roicCur: 12, roicMed: 13, roicMin3: 10 };   // 用“最差年”而非标准差：护城河是穿越周期不掉
const W_CASH = { fcfYield: 20, div5y: 5 };                    // 用户裁定：股息只给 5%
const W_SAFETY = { ep: 10, normYield: 10, bm: 5 };            // B/M 压低（与 normYield 共享净资产项）
const W_HEALTH = { netCash: 8, debtRatio: 4, gw: 3 };

// A3：本块是 stock-score/engine.ts 的 assignGroups + pctFromEntries 的**语义复制**
// （V1.1 已冻结，不抽公共模块）。任一侧改动必须同步另一侧；'A3 复制体守卫' 钉住分组行为。
export function assignGroupsV(rows: { code: string; ths: string[] }[]): Map<string, string> {
  const l2 = new Map<string, number>(), l1 = new Map<string, number>();
  for (const s of rows) {
    if (s.ths.length >= 2) l2.set(`${s.ths[0]}-${s.ths[1]}`, (l2.get(`${s.ths[0]}-${s.ths[1]}`) ?? 0) + 1);
    if (s.ths.length >= 1) l1.set(s.ths[0], (l1.get(s.ths[0]) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of rows) {
    const k2 = s.ths.length >= 2 ? `${s.ths[0]}-${s.ths[1]}` : '';
    const k1 = s.ths.length >= 1 ? s.ths[0] : '';
    out.set(s.code, k2 && (l2.get(k2) ?? 0) >= 20 ? `L2:${k2}` : k1 && (l1.get(k1) ?? 0) >= 20 ? `L1:${k1}` : 'MARKET');
  }
  return out;
}

interface PEntry { code: string; grp: string; v: number }
function pctFrom(rows: ValueRaw[], get: (r: ValueRaw) => number | null): Map<string, number> {
  const gs = assignGroupsV(rows);
  const byG = new Map<string, PEntry[]>();
  for (const s of rows) {
    const v = get(s);
    if (v !== null && Number.isFinite(v)) {
      const grp = gs.get(s.code)!;
      const arr = byG.get(grp); if (arr) arr.push({ code: s.code, grp, v }); else byG.set(grp, [{ code: s.code, grp, v }]);
    }
  }
  const out = new Map<string, number>();
  for (const [, ms] of byG) {
    if (ms.length < 5) continue;                        // 组内有效样本 <5 不产生分数（V1.1 纪律）
    const nums = ms.map(m => m.v).sort((a, b) => a - b);
    const p1 = nums[Math.floor(nums.length * 0.01)];
    const p99 = nums[Math.min(nums.length - 1, Math.floor(nums.length * 0.99))];
    const sv = nums.map(v => Math.min(Math.max(v, p1), p99)).sort((a, b) => a - b);
    for (const m of ms) {
      const v = Math.min(Math.max(m.v, p1), p99);
      out.set(m.code, (sv.filter(x => x < v).length + 0.5 * sv.filter(x => x === v).length) / sv.length * 100);
    }
  }
  return out;
}
export function pctWithinGroupsV(rows: ValueRaw[], get: (r: ValueRaw) => number | null) {
  return pctFrom(rows, get);
}

// NA 重归一：有效腿按各自权重重分配；返回 [得分, 有效权重之和]（单腿恒等，避免浮点往返）
function renormV(pairs: [number | null, number][]): [number | null, number] {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, w]) => a + w, 0);
  if (tot === 0) return [null, 0];
  if (valid.length === 1) return [valid[0][0], valid[0][1]];
  return [valid.reduce((a, [v, w]) => a + v * w, 0) / tot, tot];
}

export interface ValueRow extends ValueRaw {
  gate: Gate; vq: number | null; vMoat: number | null; vCash: number | null; vSafety: number | null; vHealth: number | null;
  vcov: number; tier: 'qualified' | 'too_rich' | 'unqualified' | 'vetoed';
  confidence: 'A' | 'B' | 'C'; grp: string; indRank: number; indN: number; marketRank: number; marketN: number;
  flags: string[];
}

export function computeValue(all: ValueRaw[], cn10y: number | null, finRoe?: Map<string, number>): ValueRow[] {
  const rows = all.filter(s => !s.isST);                        // 唯一硬过滤（V1.0 决策 2）
  const gates = new Map(rows.map(s => [s.code, gateOf(s, cn10y, s.isFin ? { roe: finRoe?.get(s.code) ?? null } : undefined)]));
  // 贵者先取倒数（ep=100/pe、bm=100/pb），使全链统一正向高分，reverse 分支不散落
  const epOf = (s: ValueRaw) => (s.pe !== null && s.pe > 0 ? 100 / s.pe : null);   // 空值语义③：PE≤0 → NA
  const bmOf = (s: ValueRaw) => (s.pb !== null && s.pb > 0 ? 100 / s.pb : null);
  const p = {
    roicCur: pctFrom(rows, s => s.roic),
    roicMed: pctFrom(rows, s => gates.get(s.code)!.roicMed),
    roicMin3: pctFrom(rows, s => roicStats(s.roic3).min3),
    fcfY: pctFrom(rows, s => gates.get(s.code)!.fcfYield),
    div5: pctFrom(rows, s => s.divY5y),                         // 空 → 0 已在适配器落地（批次失败才是 NA）
    ep: pctFrom(rows, epOf), normY: pctFrom(rows, s => gates.get(s.code)!.normYield), bm: pctFrom(rows, bmOf),
    netCash: pctFrom(rows, s => (s.cash !== null && s.debt !== null && s.mktcap !== null && s.mktcap > 0
      ? (s.cash - s.debt) / s.mktcap : null)),
    // 有息负债率 = debt/(cash+debt)：严格单调于 debt/cash，百分位不变；存正数口径，取负只用于排序方向（列名不再撒谎）
    debtRatio: pctFrom(rows, s => (s.debt !== null && (s.cash ?? 0) + s.debt > 0
      ? -s.debt / ((s.cash ?? 0) + s.debt) : null)),
    gw: pctFrom(rows, s => -(s.gw ?? 0)),
  };
  const g = (m: Map<string, number>, s: ValueRaw) => m.get(s.code) ?? null;
  const groups = assignGroupsV(rows);

  const out: ValueRow[] = rows.map(s => {
    const gt = gates.get(s.code)!;
    const [vMoat] = renormV([[g(p.roicCur, s), W_MOAT.roicCur], [g(p.roicMed, s), W_MOAT.roicMed], [g(p.roicMin3, s), W_MOAT.roicMin3]]);
    const [vCash] = renormV([[g(p.fcfY, s), W_CASH.fcfYield], [g(p.div5, s), W_CASH.div5y]]);
    const [vSafety] = renormV([[g(p.ep, s), W_SAFETY.ep], [g(p.normY, s), W_SAFETY.normYield], [g(p.bm, s), W_SAFETY.bm]]);
    const [vHealth] = renormV([[g(p.netCash, s), W_HEALTH.netCash], [g(p.debtRatio, s), W_HEALTH.debtRatio], [g(p.gw, s), W_HEALTH.gw]]);
    const [vq0, wSum] = renormV([[vMoat, W_VQ.moat], [vCash, W_VQ.cash], [vSafety, W_VQ.safety], [vHealth, W_VQ.health]]);
    const vcov = wSum / 100;

    const flags: string[] = [];
    if (gt.roicMed === null && !s.isFin) flags.push('roic_3y_incomplete');   // P-2：三年齐备仅 63%
    if (s.gw === null) flags.push('gw_empty_as_zero');
    if (s.pe !== null && s.pe <= 0) flags.push('pe_na_nonpositive');
    if (s.pb !== null && s.pb <= 0) flags.push('pb_na_nonpositive');
    if (gt.rfFallback) flags.push('rf_fallback');
    if (gt.icApprox) flags.push('ic_approx');                                 // spec §4.1 已知粗糙近似
    if (gt.vetoed) flags.push(...gt.vetoReasons.map(x => `veto:${x}`));

    // tier 顺序：否决 > 门禁不过 > 太贵 > 合格。vcov 只决定 vq 是否产出，不改 tier。
    const tier: ValueRow['tier'] = gt.vetoed ? 'vetoed'
      : !gt.passed ? (gt.tooRich ? 'too_rich' : 'unqualified')
      : vcov < VCOV_MIN ? 'unqualified' : 'qualified';
    return { ...s, gate: gt, vq: tier === 'qualified' ? vq0 : null, vMoat, vCash, vSafety, vHealth,
      vcov, tier, confidence: 'A' as const, grp: groups.get(s.code)!,
      indRank: 0, indN: 0, marketRank: 0, marketN: 0, flags };
  });

  // 排名与置信度在成行后回填（indN 需先知道；照 V1.1 先命中先得 C>B>A）
  const scored = out.filter(r => r.vq !== null).sort((a, b) => b.vq! - a.vq!);
  scored.forEach((r, i) => { r.marketRank = i + 1; r.marketN = scored.length; });
  for (const r of scored) {
    const mate = scored.filter(x => x.grp === r.grp);
    r.indN = mate.length; r.indRank = mate.indexOf(r) + 1;
  }
  for (const r of out) {
    if (r.tier !== 'qualified') { r.confidence = r.vcov < VCOV_MIN ? 'C' : r.flags.length > 0 ? 'B' : 'A'; continue; }
    const nulls = [r.vMoat, r.vCash, r.vSafety, r.vHealth].filter(x => x === null).length;
    r.confidence = (r.grp === 'MARKET' && r.indN < 20) || nulls >= 2 || r.vcov < VCOV_MIN ? 'C'
      : nulls === 1 || r.flags.length > 0 ? 'B' : 'A';
  }
  return out;
}
```

> 实现注：金融股的 `roicMed` 永为 NA（P-1），其 `vMoat` 靠 `roicCur` 也 NA → **整个护城河维度 NA**，`vcov` 自然降到 0.65，不会与满腿者假装可比。这就是 spec §6 “不能与满腿者直接比大小”的落地方式，而不是靠特殊分支拉高它们。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts && deno check value_engine.ts`
Expected: `ok | 15 passed | 0 failed`

若 `60 倍 PE` 那条 FAIL：先手算 `oy=min(fcff/市值, roic_med×IC/市值)`。基准 `IC=4e9`、`市值=2e10`、`roic_med=20` → `normY=4.0`；`fcff=3.33e8` → `cashY=1.665` → `oy=1.665`，`mos=1.665-1.85=-0.185 < 2` → `too_rich`。注意：该样本 `oy>0` 且 `roic_med=20 ≥ 8`，故不得误落 `unqualified`；若实现把它归到 `unqualified`，是 `tooRich` 条件写错（必顶 `oyPos && roicOk && !priceOk`），不是期望值错。

- [ ] **Step 5: 全量回归（含 Task 2）**

```bash
cd supabase/functions/stock-value && deno test -A .
```

Expected: `gs_value_test.ts` 7 + `value_engine_test.ts` 15 = 22 全绿

- [ ] **Step 6: Commit（⚠ 需用户明示）**

```bash
git add supabase/functions/stock-value && \
git commit -m "feat(stock-value): VQ ranking layer (4-dim percentile, vcov, confidence, tier)"
```

---

## Task 5: 两个外部输入——`cn10y` 与金融股 ROE（先探针后写解析器）

**Files:**
- Create: `supabase/functions/stock-value/rf.ts`
- Create: `scripts/probe_cn10y.ts`（一次性探针，跑完即删，不入库）
- Modify: `supabase/functions/stock-value/gs_value.ts`（V_Q5 加 ROE 列）、`supabase/functions/stock-value/fixtures/vq5_sample.json`
- Test: `supabase/functions/stock-value/rf_test.ts`、`gs_value_test.ts`（追加 1 条）

**Interfaces:**
- Consumes: `ValueRaw`（本 Task 为它新增 `roe: number | null`）、`computeValue(..., finRoe)`（Task 4）
- Produces:
  - `const CN10Y_TEXT: string`、`ECONOMY_BASE: string`
  - `parseCn10y(text: string): number | null`（百分数，合法窗口 `[0.5, 5.0]`，窗外一律 null）
  - `fetchCn10yStream(apiKey: string, timeoutMs?: number): Promise<string>`（拼接 `STREAM_MESSAGE.content`）
  - `resolveCn10y(input: { override: number | null; overrideOn: string | null; fetched: number | null; today: string }): { cn10y: number | null; source: 'override' | 'auto' | 'none' }`（override 超过 45 天未更新也当失效，避免手动值腐烂成静默错价）

- [ ] **Step 1: 写探针并实跑一次（不得猜测响应形态就写解析器）**

```ts
// scripts/probe_cn10y.ts —— 一次性：看 GS 宏观经济端点的真实返回长什么样。
// 凭据铁律：key 只从环境变量或本地 memory.md 读入，**绝不打印**；输出前再跑一道 replace 傅底。
const KEYFILE = '/Users/alick/.qoder-cn/plugins/cache/local/guosen-finance/skills/gs-smart-stock-picking/memory.md';
const fromEnv = Deno.env.get('GS_API_KEY');
const key = fromEnv ?? (await Deno.readTextFile(KEYFILE)).match(/^GS_API_KEY\s*=\s*(\S+)\s*$/m)?.[1];
if (!key) { console.error('no key'); Deno.exit(2); }          // 只报错，不回显缺失的值
const scrub = (s: string) => s.replaceAll(key, 'REDACTED');

const qs = new URLSearchParams({ text: '中国十年期国债收益率最新值', softName: 'goldsun_skills', apiKey: key });
const r = await fetch(`https://dgzt.guosen.com.cn/skills/agent/adapter/query?${qs}`, { signal: AbortSignal.timeout(60_000) });
const j = await r.json();
const content = (j?.data ?? []).filter((x: Record<string, unknown>) => x?.type === 'STREAM_MESSAGE')
  .map((x: Record<string, unknown>) => String(x.content ?? '')).join('');
console.log('code=', j?.result?.[0]?.code, 'http=', r.status, 'content_len=', content.length);
console.log(scrub(content).slice(0, 1200));                     // 只打正文，不拼 URL、不打 headers
```

Run: `cd "/Users/alick/Documents/GitHub/fund invest" && deno run -A scripts/probe_cn10y.ts`
Expected: 拿到真实正文。**记录三个事实后才能进入 Step 2**：① 百分数带不带 `%`；② 一句里是否并列多个利率（如同时给出 1 年/10 年）；③ 日期如何附在数值旁。若返回 `code!=0` 或正文无利率→跳到 Step 1b。

- [ ] **Step 1b（仅当 Step 1 拿不到可用正文）: 确定降级方案并写进 spec**

若端点不可用或输出形态不稳定：本 Task 只保留 `value_config.cn10y_override` 手动通道（由用户周期性写入），`fetchCn10yStream` 直接返回空串，门禁全走 `OWNER_YIELD_FLOOR=6` 绝对下限（`rf_fallback=true`）。必须同步修订 spec §9.2 并追加一条决策记录——不得默默把“取不到”当临时状态长期跑。

- [ ] **Step 2: 写失败测试（rf 6 条，全部不挨网络；ROE 那条在 Step 2b 追加到 gs_value_test）**

```ts
// supabase/functions/stock-value/rf_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseCn10y, resolveCn10y } from './rf.ts';

Deno.test('parseCn10y：带百分号的十年期数值直接取值', () => {
  assertEquals(parseCn10y('中国10年期国债收益率为1.85%（2026-10-10）'), 1.85);
});

Deno.test('parseCn10y：多利率并列时必须拿“10年/十年”邻近那个，不是第一个', () => {
  assertEquals(parseCn10y('1年期1.35%，10年期国债收益率2.10%'), 2.1);
});

Deno.test('parseCn10y：超出合理窗口 [0.5,5.0]% 一律 null（宁可 rf_fallback，不可把 0.0185 当 1.85）', () => {
  assertEquals(parseCn10y('十年期国债收益率 0.0185'), null);      // 无百分号 → 不猜
  assertEquals(parseCn10y('十年期国债收益率 6.20%'), null);      // 窗外
  assertEquals(parseCn10y('今日天气晴'), null);                      // 无数字
});

Deno.test('resolveCn10y：override 优先于 auto', () => {
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-10-01', fetched: 1.85, today: '2026-10-11' }),
    { cn10y: 2.0, source: 'override' });
});

Deno.test('resolveCn10y：override 超过 45 天未更新 → 失效，退回 auto（防手动值腐烂）', () => {
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-01-01', fetched: 1.85, today: '2026-10-11' }),
    { cn10y: 1.85, source: 'auto' });
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-01-01', fetched: null, today: '2026-10-11' }),
    { cn10y: null, source: 'none' });
});

Deno.test('resolveCn10y：全缺 → source=none（编排层走 rfFallback，不抛错）', () => {
  assertEquals(resolveCn10y({ override: null, overrideOn: null, fetched: null, today: '2026-10-11' }),
    { cn10y: null, source: 'none' });
});

```

- [ ] **Step 2b: 追加 1 条到 `gs_value_test.ts` 末尾（ROE 属适配器职责，测试留在它自己的文件里，复用该文件已有的 `fx`/`NOW`/`merge`）**

```ts
// supabase/functions/stock-value/gs_value_test.ts（追加；fx / NOW / merge 已在该文件顶部定义）
Deno.test('V_Q5 含金融股 ROE 对标列（spec §4 否决4 附注）：批次在则取值，批次缺席则 NA', () => {
  assertEquals(merge().rows[2].roe, 12.4);              // 600036 测试银行
  assertEquals(merge(null).rows[2].roe, null);          // 批次缺席 → NA（否决4 不判定，不是归 0）
});
```

Run: `cd supabase/functions/stock-value && deno test -A gs_value_test.ts`
Expected: FAIL — `rows[2].roe` 为 `undefined`（ValueRaw 尚无 `roe` 字段）。本 Task 的 rf 6 条同步骤红：`Module not found: ./rf.ts`。

- [ ] **Step 3: 实现 `rf.ts`，并修订 V_Q5（措辞 + REQUIRED + fixtures）**

```ts
// rf.ts — 十年期国债收益率（门禁层的尺子）。规则权威：spec §4/§9.2 + 计划修订 A2
// 数据源是 gs-economy-query skill 的底层端点（Edge 里跑不了 python 脚本），响应为自然语言。
// 因此解析采取「宁缺勿猜」：拿不到就返回 null，由编排层走 OWNER_YIELD_FLOOR 退化路径。
export const ECONOMY_BASE = 'https://dgzt.guosen.com.cn/skills/agent/adapter/query';
export const CN10Y_TEXT = '中国十年期国债收益率最新值';
const CN10Y_MIN = 0.5, CN10Y_MAX = 5.0;      // %；窗外一律视为解析失败
const OVERRIDE_MAX_AGE_DAYS = 45;

export async function fetchCn10yStream(apiKey: string, timeoutMs = 60_000): Promise<string> {
  const qs = new URLSearchParams({ text: CN10Y_TEXT, softName: 'goldsun_skills', apiKey });
  try {
    const r = await fetch(`${ECONOMY_BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return '';
    const j = await r.json();
    if (j?.result?.[0]?.code !== 0) return '';
    return (j?.data ?? []).filter((x: Record<string, unknown>) => x?.type === 'STREAM_MESSAGE')
      .map((x: Record<string, unknown>) => String(x.content ?? '')).join('');
  } catch { return ''; }                      // TypeError.message 含带 key 的 URL → 吐空串，不往上传
}

function pctAt(text: string): { i: number; v: number }[] {
  const out: { i: number; v: number }[] = [];
  const re = /(\d+(?:\.\d+)?)\s*%/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ i: m.index, v: Number(m[1]) });
  return out;
}

export function parseCn10y(text: string): number | null {
  const pcts = pctAt(text ?? '');
  if (pcts.length === 0) return null;
  // 优先取“10年/十年/10Y”之后 30 字内第一个百分数（多利率并列时防拿错）
  const anchor = text.search(/10\s*年|十年|10Y/i);
  const cand = anchor >= 0 ? pcts.filter(x => x.i >= anchor && x.i - anchor <= 30) : [];
  const pick = (cand.length ? cand : pcts).find(x => x.v >= CN10Y_MIN && x.v <= CN10Y_MAX);
  return pick ? pick.v : null;
}

export function resolveCn10y(i: { override: number | null; overrideOn: string | null; fetched: number | null; today: string }):
  { cn10y: number | null; source: 'override' | 'auto' | 'none' } {
  const fresh = i.override !== null && i.overrideOn !== null &&
    (Date.parse(i.today) - Date.parse(i.overrideOn)) / 86400_000 <= OVERRIDE_MAX_AGE_DAYS;
  if (fresh) return { cn10y: i.override, source: 'override' };
  if (i.fetched !== null) return { cn10y: i.fetched, source: 'auto' };
  return { cn10y: null, source: 'none' };
}
```

`gs_value.ts` 三处修订（只改本批，不动其余批次）：

```ts
export const V_Q5 = '全部沪深A股的股息率、近5年股息率平均值、净资产收益率roe(摊薄)、股票简称';  // 4 字段，仍在 P-3 安全区内
q5: ['股票代码', '股息率', '净资产收益率roe(摊薄)'],                                              // REQUIRED 加 ROE
// ValueRaw 新增 `roe: number | null`；mergeValueTables 里：
//   roeK = t5 ? colByPrefix(t5, '净资产收益率roe(摊薄') ?? null : null
//   roe: !t5 || roeK === null ? null : at(t5, roeK, j5),      // 批次缺席 → NA（不得归 0）
```

`vq5_sample.json` 追加列：`"净资产收益率roe(摊薄)[20260630]": ["3.1", "2.4", "12.4"]`；`vq1_sample.json` 的 `600036.SH` 保持 `投入资本回报率` 为 `null`（金融股 NA，P-1）。

- [ ] **Step 4: 跑全量回归 + 类型检查**

```bash
cd supabase/functions/stock-value && deno test -A . && deno check rf.ts gs_value.ts value_engine.ts
```

Expected: `29 passed | 0 failed`（= Task 2-4 的 22 条 + 本 Task 新增 7 条：rf 6 + gs_value 1，其中 gs_value 从 7 变 8）

- [ ] **Step 5: 删除探针文件（探针产物不入库）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && rm scripts/probe_cn10y.ts && git status --short scripts/
```

Expected: `scripts/` 无新增未跟踪项。**若探针输出里出现了 key，不得将该输出贴进任何文档/提交/记忆。**

- [ ] **Step 6: Commit（⚠ 需用户明示）**

```bash
git add supabase/functions/stock-value && \
git commit -m "feat(stock-value): cn10y resolution with override + fin-sector ROE in dividend batch"
```

---

## Task 6: 编排层 `index.ts` + 构建产物 `deploy.ts`

**Files:**
- Create: `supabase/functions/stock-value/index.ts`
- Create: `supabase/functions/stock-value/build.ts`（拷 `stock-score/build.ts` 改模块名）
- Create: `supabase/functions/stock-value/deploy.ts`（**由 build.ts 生成，不可手改**）
- Create: `supabase/functions/stock-value/fixtures/score_sample.json`
- Test: `supabase/functions/stock-value/index_test.ts`
- Modify: `scripts/verify_deploy_bundles.ts:16-21`（`MODULES` 数组加 `"stock-value"`）

**Interfaces:**
- Consumes: `gsValueFetch/V_Q*/buildVQ3/yearAnchors/mergeValueTables`（Task 2）、`computeValue`（Task 4）、`fetchCn10yStream/parseCn10y/resolveCn10y`（Task 5）
- Produces（可单测的纯函数，`index.ts` 导出）:
  - `buildExtras(stamps: Record<string,string>, r: ValueRow, meta: { cn10ySource: string; icApprox: boolean; mainLegs: Record<string, number | null> | null }): Record<string, unknown>`
  - `toDbRow(r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>, stamps: Record<string,string>, cn10ySource?: string): DbRow`（`stamps` **必传**：spec §8 时点纪律要求每个字段的 GS 日期戳原样落 `extras`，P-4 已证明同一列的历史版与当期版无法共存于一次调用）
  - `type MainSnap = { final: number | null; confidence: string | null; roe: number | null; quality: number | null; growth: number | null; value: number | null; momentum: number | null }`（后四个供分歧榜的归因句，spec §7.2）
  - HTTP：`GET/POST /stock-value?mode=ping|run`，鉴权 `DAILY_UPDATE_TOKEN`（与 `stock-score` 完全一致）

- [ ] **Step 1: 写失败测试（5 条，先关 serve 守卫再动态 import）**

```ts
// supabase/functions/stock-value/index_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { MainSnap } from './index.ts';            // 类型导入编译期擦除，不会触发 Deno.serve
Deno.env.set('STOCK_VALUE_DISABLE_SERVE', '1');           // import 即绑端口 → 必须先关
const { buildExtras, toDbRow } = await import('./index.ts');

const row = { code: '600031.SH', name: '测试制造', ths: ['机械设备', '工程机械', '工程机械'],
  isFin: false, isST: false, roic: 18.4, roic3: [17.1, 18.0, 18.9], fcff: 5.400171e12, cash: 4e10, debt: 1e10,
  gw: null, pe: 14.2, pb: 2.1, mktcap: 2e10, divYield: 3.2, divY5y: 2.8, roe: 3.1,
  gate: { ownerYield: 6.2, mos: 4.35, cn10y: 1.85, rfFallback: false, icApprox: true, roicMed: 18,
    fcfYield: 27000.855, normYield: 2.7, passed: true, tooRich: false, vetoed: false, vetoReasons: [] },
  vq: 78.4, vMoat: 80, vCash: 70, vSafety: 75, vHealth: 66, vcov: 1, tier: 'qualified', confidence: 'A',
  grp: 'L2:机械设备-工程机械', indRank: 3, indN: 40, marketRank: 12, marketN: 2200, flags: ['ic_approx'] } as never;

const STAMPS = { fin_period: '20260630', val_period: '20260930', roic_period: '20251231' };
// 显式标注 Map<string, MainSnap>：字面量直推会把 quality 等收窄为 number，与 MainSnap 的 number|null 不同变而报错
const main = new Map<string, MainSnap>([['600031',
  { final: 71.2, confidence: 'A', roe: 3.1, quality: 82, growth: 40, value: 44, momentum: 30 }]]);

Deno.test('toDbRow：代码剔后缀、列名逐字对齐迁移、不丢主分快照与四条腿', () => {
  const db = toDbRow(row as never, '2026-10-11', new Set(['600031']), main, STAMPS, 'auto');
  assertEquals(db.code, '600031');                       // bare code（前端按 6 位代码 join）
  assertEquals(db.batch_date, '2026-10-11');
  assertEquals(db.in_pool, true);
  assertEquals(db.main_final, 71.2);
  assertEquals(db.owner_yield, 6.2);
  assertEquals(db.tier, 'qualified');
  // 派生列必须真实落库（前视复盘要用 ic 做近似质量审计，不得留空位）：fixture cash=4e10 debt=1e10
  assertEquals(db.ic, 5e10);
  assertEquals(db.roic_min3, 17.1);
  assertEquals(db.debt_ratio, 0.2);
  assertEquals(db.net_cash_ratio, (4e10 - 1e10) / 2e10);   // 1.5
  // 时点纪律（spec §8）与归因快照：stamps 绝不因“为了可读性”而被丢掉
  assertEquals((db.extras as Record<string, unknown>).stamps, STAMPS);
  assertEquals(((db.extras as Record<string, unknown>).main_legs as Record<string, number>).momentum, 30);
  assertEquals((db.extras as Record<string, unknown>).cn10y_source, 'auto');
});

Deno.test('toDbRow：非池行 in_pool=false 且 main_final/main_legs 均=null（不谎称有快照）', () => {
  const db = toDbRow(row as never, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.in_pool, false); assertEquals(db.main_final, null);
  assertEquals((db.extras as Record<string, unknown>).main_legs, null);
});

Deno.test('buildExtras：日期戳全部落库（时点纪律）+ cn10ySource + ic_approx', () => {
  const ex = buildExtras(STAMPS, row as never, { cn10ySource: 'auto', icApprox: true, mainLegs: null });
  assertEquals(ex.stamps, STAMPS);
  assertEquals(ex.cn10y_source, 'auto');
  assertEquals(ex.ic_approx, true);
});

Deno.test('toDbRow：vetoed 行照落库（veto_reasons 带原因，前视需要被排除的那批）', () => {
  // 引擎对否决者不产 VQ（tier 优先于打分），此处模拟其输出形态，验证 toDbRow 不丢原始位
  const bad = { ...row, tier: 'vetoed', vq: null, gate: { ...row.gate, vetoed: true, vetoReasons: ['资不抵债'] } } as never;
  const db = toDbRow(bad, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.vetoed, true);
  assertEquals(db.veto_reasons, ['资不抵债']);
  assertEquals(db.vq, null);                                // 否决者不产 VQ，但原始位保留
});

Deno.test('toDbRow：rf_fallback 行 mos=null 不得变成 0（两种“无”不等价）', () => {
  const fb = { ...row, gate: { ...row.gate, mos: null, rfFallback: true } } as never;
  const db = toDbRow(fb, '2026-10-11', new Set(), new Map(), STAMPS);
  assertEquals(db.margin_of_safety, null);
  assertEquals(db.rf_fallback, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd supabase/functions/stock-value && deno test -A index_test.ts`
Expected: FAIL — `Module not found: ./index.ts`

- [ ] **Step 3: 实现 `index.ts`**

```ts
/// <reference lib="deno.ns" />
// stock-value 编排层。规则权威：spec §2.1（批次）/§4–§6（引擎）/§8（存储与快照）
import { computeValue, roicStats, investedCapital, type ValueRow } from './value_engine.ts';
import type { ValueRaw } from './gs_value.ts';
import { gsValueFetch, mergeValueTables, yearAnchors, buildVQ3, V_Q1, V_Q2, V_Q4, V_Q5 } from './gs_value.ts';
import { fetchCn10yStream, parseCn10y, resolveCn10y } from './rf.ts';

const MIN_ROWS = 4000;                       // 与 stock-score 同阈值：短表一律视为接口异常

type MainSnap = { final: number | null; confidence: string | null; roe: number | null };
type DbRow = Record<string, unknown>;

export function buildExtras(
  stamps: Record<string, string>, r: ValueRow,
  meta: { cn10ySource: string; icApprox: boolean; mainLegs: Record<string, number | null> | null },
): Record<string, unknown> {
  return {
    stamps,                                  // 时点纪律（spec §8）：每个字段的 GS 日期戳原样落库
    cn10y_source: meta.cn10ySource,
    ic_approx: meta.icApprox || null,
    main_legs: meta.mainLegs,                // 分歧榜归因用（spec §7.2）：主分四条腿当晚快照
    grp: r.grp,
    owner_cash: r.gate.fcfYield, owner_norm: r.gate.normYield,   // 取小前的两条腿，页面可解释
    veto_reasons: r.gate.vetoReasons,
  };
}

export function toDbRow(
  r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none',
): DbRow {
  const bare = r.code.split('.')[0];
  const m = main.get(bare) ?? null;
  return {
    batch_date: batch, code: bare, name: r.name, ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null,
    in_pool: poolSet.has(bare),
    roic_cur: r.roic, fcff: r.fcff, mktcap: r.mktcap, pe: r.pe, pb: r.pb,
    cash: r.cash, debt: r.debt, gw_pct: r.gw, div_yield: r.divYield, div_yield_5y: r.divY5y,
    roic_med: r.gate.roicMed, roic_min3: roicStats(r.roic3).min3, ic: investedCapital(r),
    fcf_yield: r.gate.fcfYield, ep: r.pe !== null && r.pe > 0 ? 100 / r.pe : null,
    bm: r.pb !== null && r.pb > 0 ? 100 / r.pb : null, norm_yield: r.gate.normYield,
    net_cash_ratio: r.cash !== null && r.debt !== null && r.mktcap !== null && r.mktcap > 0
      ? (r.cash - r.debt) / r.mktcap : null,
    debt_ratio: r.debt !== null && (r.cash ?? 0) + r.debt > 0 ? r.debt / ((r.cash ?? 0) + r.debt) : null,
    owner_yield: r.gate.ownerYield, margin_of_safety: r.gate.mos, cn10y: r.gate.cn10y, rf_fallback: r.gate.rfFallback,
    vq: r.vq, v_moat: r.vMoat, v_cash: r.vCash, v_safety: r.vSafety, v_health: r.vHealth,
    vcov: r.vcov, tier: r.tier, confidence: r.confidence,
    vetoed: r.gate.vetoed, veto_reasons: r.gate.vetoReasons, flags: r.flags,
    ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: r.marketN,
    main_final: m?.final ?? null, main_confidence: m?.confidence ?? null,
    extras: buildExtras(stamps, r, {
      cn10ySource, icApprox: r.gate.icApprox,
      mainLegs: m ? { quality: m.quality, growth: m.growth, value: m.value, momentum: m.momentum } : null,
    }),
  };
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

async function upsert(rows: DbRow[]) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/stock_value?on_conflict=batch_date,code`, {
      method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`upsert stock_value ${r.status} ${await r.text()}`);
  }
}

// 主分快照 + 金融股 ROE 候选 + 四条腿（供分歧榜归因）：只读最新批次的 in_pool 行（分歧榜本质是池内对比，无需全宇宙）
async function readMainSnapshot(url: string): Promise<{ batch: string | null; map: Map<string, MainSnap> }> {
  const b = await fetch(`${url}/rest/v1/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
  if (!b.ok) throw new Error(`read stock_score batch ${b.status}`);
  const bb = (await b.json())[0] as { batch_date: string } | undefined;
  if (!bb) throw new Error('stock_score has no batch yet — value leg must run AFTER stock-score');
  const d = await fetch(`${url}/rest/v1/stock_score?select=code,final,confidence,roe,quality,growth,value,momentum&batch_date=eq.${bb.batch_date}&in_pool=eq.true`, { headers: svcHeaders() });
  if (!d.ok) throw new Error(`read stock_score rows ${d.status}`);
  const map = new Map<string, MainSnap>();
  for (const x of await d.json()) map.set(String(x.code), {
    final: x.final ?? null, confidence: x.confidence ?? null, roe: x.roe ?? null,
    quality: x.quality ?? null, growth: x.growth ?? null, value: x.value ?? null, momentum: x.momentum ?? null,
  });
  return { batch: bb.batch_date, map };
}

if (!Deno.env.get('STOCK_VALUE_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const mode = new URL(req.url).searchParams.get('mode') || 'run';
  const url = Deno.env.get('SUPABASE_URL')!;
  try {
    if (mode === 'ping') {
      const t = await gsValueFetch(V_Q4, key, 30_000);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const now = new Date();
    const { annualBase } = yearAnchors(now);
    // 四个硬批次：任一失败/短表/缺列 → assertCols/行守抛错 → 外层 catch 保留旧批次
    const [t1, t2, t3, t4] = await Promise.all([
      gsValueFetch(V_Q1, key), gsValueFetch(V_Q2, key), gsValueFetch(buildVQ3(annualBase), key), gsValueFetch(V_Q4, key),
    ]);
    for (const t of [t1, t2, t3, t4]) if ((t['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error('GS 短表，保留旧批次');
    // 分红+金融 ROE 批是“尽力而为”腿（同 stock-score 现金腿）：失败只置 NA，绝不杀整批
    let t5 = null;
    try { const c = await gsValueFetch(V_Q5, key, 60_000); if ((c['股票代码']?.length ?? 0) >= MIN_ROWS) t5 = c; } catch { t5 = null; }
    const { rows, stamps } = mergeValueTables(t1, t2, t3, t4, t5, now);

    // cn10y：override 优先，其次自动取数，全缺则引擎走 OWNER_YIELD_FLOOR 退化
    const cfgR = await fetch(`${url}/rest/v1/value_config?select=cn10y_override,cn10y_manual_on&limit=1`, { headers: svcHeaders() });
    const cfg = cfgR.ok ? ((await cfgR.json())[0] ?? {}) : {};
    const resolved = resolveCn10y({
      override: cfg.cn10y_override ?? null, overrideOn: cfg.cn10y_manual_on ?? null,
      fetched: parseCn10y(await fetchCn10yStream(key)), today: now.toISOString().slice(0, 10),
    });

    const main = await readMainSnapshot(url);
    const poolR = await fetch(`${url}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
    if (!poolR.ok) throw new Error(`read stock_pool ${poolR.status}`);
    const poolSet = new Set(((await poolR.json()) as { code: string }[]).map(x => x.code));

    const finRoe = new Map<string, number>();
    for (const [c, m] of main.map) if (m.roe !== null) finRoe.set(c, m.roe);
    const computed = computeValue(rows as ValueRaw[], resolved.cn10y, finRoe);
    const batch = now.toISOString().slice(0, 10);
    await upsert(computed.map(r => toDbRow(r, batch, poolSet, main.map, stamps, resolved.source)));

    const by = (t: string) => computed.filter(r => r.tier === t).length;
    return Response.json({ ok: true, batch_date: batch, rows: computed.length, qualified: by('qualified'),
      too_rich: by('too_rich'), vetoed: by('vetoed'), unqualified: by('unqualified'),
      a_level: computed.filter(r => r.confidence === 'A').length,
      cn10y: resolved.cn10y, cn10y_source: resolved.source, div_leg_ok: t5 !== null,
      main_batch: main.batch, stamps });
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsValueFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json({ ok: false, error: msg, kept_old_batch: true }, { status: 500 });
  }
});
}
```

> 实现注：`roic_min3`/`ic`/`net_cash_ratio`/`debt_ratio` 四列**必须真实落库**（前视复盘要用 `ic` 做投入资本近似的质量审计），上面代码已直接写出取值，并由 Step 1 的四条断言钉住。注意 `debt_ratio` 列存的是**正的有息负债率** `debt/(cash+debt)`（与 Task 4 百分位里的取负仅作排序方向，不落负数入库）；`ic` 是 spec §4.1 的近似值，`extras.ic_approx=true` 已在标记这个口径。

- [ ] **Step 4: 写 `build.ts` 并生成 `deploy.ts`**

```ts
// supabase/functions/stock-value/build.ts —— 与 stock-score/build.ts 同构（拼接顺序：引擎→适配器→rf→index）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\./(value_engine|gs_value|rf)\.ts';?\s*$/gm, '')
  .replace(/^import\s+type\s.*?;?\s*$/gm, '')
  .replace(/^export\s+(interface|type|const|function|async\s+function)/gm, '$1');
const src = '/// <reference lib="deno.ns" />\n' +
  rd('value_engine.ts') + '\n' + rd('gs_value.ts') + '\n' + rd('rf.ts') + '\n' + rd('index.ts');
const out = Deno.args[0] ?? 'deploy.ts';
Deno.writeTextFileSync(out, src);
console.log(`${out} bytes:`, src.length);
```

```bash
cd supabase/functions/stock-value && deno run --allow-read --allow-write build.ts
deno check deploy.ts
```

Expected: 生成 deploy.ts 且类型检查无错。拼接后 `index_test.ts` 仍从 `index.ts` 导入（仓内惯例：测试不覆盖 deploy.ts）。

- [ ] **Step 5: 把新模块纳入一致性门禁**

Modify `scripts/verify_deploy_bundles.ts` 的 `MODULES`：

```ts
const MODULES = [
  "sector-trend",
  "stock-score",
  "stock-research",
  "business-mix",
  "stock-value",
] as const;
```

Run: `cd "/Users/alick/Documents/GitHub/fund invest" && deno task verify-bundles`
Expected: `stock-value ✅`（其余四模块也应全绿；若报“无 build.ts”先回 Step 4）

- [ ] **Step 6: 全量回归 + 提交（⚠ commit 需用户明示）**

```bash
cd supabase/functions/stock-value && deno test -A . && deno check .
cd "/Users/alick/Documents/GitHub/fund invest" && deno task verify-bundles
```

Expected: 29 + 5 = 34 passed；verify-bundles 全绿

```bash
git add supabase/functions/stock-value scripts/verify_deploy_bundles.ts && \
git commit -m "feat(stock-value): orchestration, main-score snapshot, bundled deploy + verify gate"
```

---

## Task 7: 前端接入——拉取、价值胶囊、价值 Top10

**Files:**
- Modify: `index.html`（状态位约 L536 `scoreState` 旁；读取函数插在 `loadStockScores` 后约 L716；PURE 块插在 `// ==== RESEARCH_PURE_BEGIN ====`（L778）之前；渲染接入用 grep 定位）
- Create: `scripts/value_leg_logic.ts`（门面）、`scripts/value_leg_logic_test.ts`

**Interfaces:**
- Consumes: `stock_value` 表（Task 1/6）、`escapeHtml`（index.html 已有）、`scoreState`（已有，取主分做对照）
- Produces（`VALUE_PURE` 块内导出，供门面消费）:
  - `VALUE_TABLE` 常量、`valueFmtPct(v, digits?): string`（null → `'NA'`）
  - `valuePillHtml(row): string` → `价值 78.4 · 池内 P8`（无行 → 空串）
  - `valueGateHtml(row): string` → 展开区的四维度横条 + owner_yield 明细 + 门禁判定过程
  - `renderValueTop10(state): string`（`state=null` → 空串；**未生成时的降级文案在调用点由 `valueTried` 判定**，纯逻辑块不读全局，否则门面无法单测）、`valueTierLabel(tier): string`
  - `valueState`（全局）：`{ batch, rows: Map<bareCode,row>, top10: row[] } | null`；`valueTried: boolean`

- [ ] **Step 1: 写门面（抽取唯一实现体，绝不复制第二份）**

```ts
// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====\/;
const SHIM = `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }\n`;
const EXPORT_NAMES = ['VALUE_TABLE', 'valueFmtPct', 'valueTierLabel', 'valuePillHtml', 'valueGateHtml', 'renderValueTop10'];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error('index.html 缺少 VALUE_PURE 标记块');
  // deno-lint-ignore no-explicit-any
  const ns = new Function(SHIM + m[1] + '\nreturn {' + EXPORT_NAMES.join(', ') + '};')() as any;
  const missing = EXPORT_NAMES.filter(k => ns[k] === undefined);
  if (missing.length) throw new Error('VALUE_PURE 块缺少导出：' + missing.join(', '));
  return ns;
}
const NS = await load();
export const VALUE_TABLE = NS.VALUE_TABLE as Record<string, string>;
export const valueFmtPct = NS.valueFmtPct as (v: number | null, d?: number) => string;
export const valueTierLabel = NS.valueTierLabel as (t: string | null) => string;
export const valuePillHtml = NS.valuePillHtml as (row: Record<string, unknown> | null) => string;
export const valueGateHtml = NS.valueGateHtml as (row: Record<string, unknown> | null) => string;
export const renderValueTop10 = NS.renderValueTop10 as (state: { batch: string; top10: Record<string, unknown>[] } | null) => string;
```

- [ ] **Step 2: 写失败测试（6 条）**

```ts
// scripts/value_leg_logic_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { valueFmtPct, valueTierLabel, valuePillHtml, valueGateHtml, renderValueTop10 } from "./value_leg_logic.ts";

const row = { code:'600031', name:'潍柴', vq:78.4, tier:'qualified', confidence:'A', vetoed:false,
  owner_yield:6.2, margin_of_safety:4.35, cn10y:1.85, roic_med:18.0, v_moat:80, v_cash:70, v_safety:75, v_health:66,
  market_rank:12, market_n:2200, ind_rank:3, ind_n:40, veto_reasons:[], flags:['ic_approx'] };

Deno.test('valueFmtPct：null → NA（不显示 0.0% 冒充“收益为零”）', () => {
  assertEquals(valueFmtPct(null), 'NA');
  assertEquals(valueFmtPct(6.234, 1), '6.2%');
  assertEquals(valueFmtPct(-0.185, 2), '-0.19%');
});

Deno.test('valueTierLabel：四档均有中文文案，too_rich 不得读成“卖”', () => {
  assertEquals(valueTierLabel('qualified'), '合格');
  assertEquals(valueTierLabel('too_rich'), '质量达标、价太贵');
  assertEquals(valueTierLabel('vetoed'), '硬否决');
  assertEquals(valueTierLabel('unqualified'), '不合格');
  assertEquals(valueTierLabel(null), '—');
});

Deno.test('valuePillHtml：无行→空串；有行→分 + 池内分位；否决行加红标', () => {
  assertEquals(valuePillHtml(null), '');
  assertEquals(valuePillHtml(row).includes('价值 78.4'), true);
  assertEquals(valuePillHtml({ ...row, vetoed: true }).includes('⛔'), true);
});

Deno.test('valueGateHtml：四维度横条 + owner_yield 明细 + mos/cn10y 判定过程均可见；mos null 时走 rfFallback 文案', () => {
  const h = valueGateHtml(row);
  for (const t of ['资本回报护城河', '现金回报', '安全边际', '财务稳健', '6.2%', '1.85%']) {
    assertEquals(h.includes(t), true, `缺少：${t}`);
  }
  assertEquals(valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: true }).includes('无风险利率口径缺失'), true);
});

Deno.test('renderValueTop10：state=null → 空串（降级文案由调用点根据 valueTried 决定，纯逻辑不读全局）', () => {
  assertEquals(renderValueTop10(null), '');
});

Deno.test('renderValueTop10：只渲染 tier=qualified 且 A 级；否决/too_rich 不混进榜（spec §7.1）', () => {
  const rows = [row, { ...row, code: 'x2', vq: 90, tier: 'vetoed' }, { ...row, code: 'x3', vq: 88, confidence: 'C' }];
  const html = renderValueTop10({ batch: '2026-10-11', top10: rows as never[] });
  assertEquals(html.includes('600031'), true);
  assertEquals(html.includes('x2'), false);
  assertEquals(html.includes('x3'), false);
  assertEquals(html.includes('不构成买卖建议'), true);   // 固定免责脚注
});
```

Run: `deno test -A scripts/value_leg_logic_test.ts` → Expected FAIL：`index.html 缺少 VALUE_PURE 标记块`

- [ ] **Step 3: 在 `index.html` 写 `VALUE_PURE` 块（唯一实现体，放在 RESEARCH_PURE 块之前）**

```html
<script>
// ==== VALUE_PURE_BEGIN ====
var VALUE_TABLE = { qualified:'合格', too_rich:'质量达标、价太贵', unqualified:'不合格', vetoed:'硬否决' };
function valueFmtPct(v, d){ if(v===null || v===undefined || isNaN(Number(v))) return 'NA'; return Number(v).toFixed(d===undefined?1:d)+'%'; }
function valueTierLabel(t){ return (t && VALUE_TABLE[t]) ? VALUE_TABLE[t] : '—'; }
function valuePillHtml(row){
  if(!row || row.vq===null || row.vq===undefined) return '';
  const pctPos = (row.market_n && row.market_rank) ? ' 池内 P' + Math.max(1, Math.round(100 - row.market_rank/row.market_n*100)) : '';
  return '<span class="score-pill'+(row.vetoed?' score-pill-warn':'')+'">价值 '+Number(row.vq).toFixed(1)+pctPos+(row.vetoed?' ⛔':'')+'</span>';
}
function valueGateHtml(row){
  if(!row) return '';
  const bar = (v,l)=>'<div class="score-bar"><span>'+l+'</span><i style="--w:'+Math.max(0,Math.min(100, v==null?0:Number(v)))+'%"></i><em>'+(v==null?'NA':Number(v).toFixed(0))+'</em></div>';
  const veto = (row.veto_reasons||[]).length ? '<div class="score-warn">⛔ 硬否决：'+escapeHtml(row.veto_reasons.join('、'))+'</div>' : '';
  const mos = row.margin_of_safety===null||row.margin_of_safety===undefined
    ? (row.rf_fallback ? '无风险利率口径缺失 → 改用绝对下限（rf_fallback）' : 'NA')
    : valueFmtPct(row.margin_of_safety, 2)+'（owner yield '+valueFmtPct(row.owner_yield)+' − 十年国债 '+valueFmtPct(row.cn10y)+'）';
  return '<div class="score-detail">'+bar(row.v_moat,'资本回报护城河')+bar(row.v_cash,'现金回报')
    +bar(row.v_safety,'安全边际')+bar(row.v_health,'财务稳健')
    +'<div>门禁：'+escapeHtml(valueTierLabel(row.tier))+' · ROIC 中位 '+valueFmtPct(row.roic_med)+' · 安全边际 '+mos+'</div>'
    +veto+'<div style="color:var(--muted)'>价值分回答“值不值”，不等于买卖指令；与评分分不可互相替代。</div></div>';
}
function renderValueTop10(state){
  if(!state) return '';
  const list = (state.top10||[]).filter(r => r.tier==='qualified' && r.confidence==='A' && r.vq!==null)
    .sort((a,b)=>b.vq-a.vq).slice(0,10);
  return '<div class="fund-card"><div class="score-card-title">价值 Top10 · 巴菲特式质量价值 '
    +'<span style="font-weight:400;font-size:11.5px;color:var(--muted)">批次 '+escapeHtml(String(state.batch))+'</span></div>'
    +(list.length ? list.map((r,i)=>'<div class="score-row" data-code="'+escapeHtml(String(r.code))+'">'
      +'<span style="color:var(--muted);width:24px">#'+(i+1)+'</span><b>'+escapeHtml(r.name||'')+'</b>'
      +'<span style="color:var(--muted);font-size:11.5px">'+escapeHtml(String(r.code))+'</span>'
      +'<span class="score-pill">'+Number(r.vq).toFixed(1)+'分</span>'
      +'<span style="color:var(--muted);font-size:11px">owner yield '+valueFmtPct(r.owner_yield)
      +' · 安全边际 '+valueFmtPct(r.margin_of_safety,2)+' · ROIC中位 '+valueFmtPct(r.roic_med)+'</span></div>').join('')
      : '<div class="score-row" style="color:var(--muted)">本批次无 A 级合格标的</div>')
    +'<div class="score-card-note">门禁用绝对阈值（值不值得拥有），排序用行业内百分位（合格者中谁更靠前）；不构成买卖建议。</div></div>';
}
// ==== VALUE_PURE_END ====
</script>
```

注意：本块必须放在主 `<script>` 内（与 `escapeHtml` 同作用域）而非新开一个 script 标签，否则 `render()` 找不到函数；插入位置用 `grep -n "RESEARCH_PURE_BEGIN" index.html` 定位，插在该行所在函数之前的顶层位置。

- [ ] **Step 4: 状态位、拉取函数、调用点**

```js
// 紧接 L536 scoreState 声明之后
let valueState = null;   // { batch, rows: Map<bareCode,row>, top10: row[] }；null=未生成/读取失败 → 卡片优雅降级
let valueTried = false;

// 紧接 loadStockScores 函数之后（同一只读范式：先取最新批次，再按 in_pool + 持仓取行）
async function loadStockValue(){
  if(!cloudReady || !sb) return;
  valueTried = true;
  try{
    const { data: b, error: be } = await sb.from('stock_value').select('batch_date')
      .order('batch_date',{ascending:false}).limit(1).maybeSingle();
    if(be || !b) return;
    const batch = b.batch_date;
    const codes = [...new Set(stocks.map(s=>String(s.code||'').trim()).filter(c=>/^\d{5,6}$/.test(c)))];
    const orFilter = codes.length ? 'in_pool.eq.true,code.in.(' + codes.join(',') + ')' : 'in_pool.eq.true';
    const { data, error } = await sb.from('stock_value').select('*')
      .eq('batch_date', batch).or(orFilter).order('vq',{ascending:false});
    if(error || !data) return;
    valueState = { batch, rows: new Map(data.map(r=>[String(r.code), r])),
      top10: data.filter(r=>r.in_pool && r.tier==='qualified' && r.confidence==='A') };
  }catch(e){ console.warn('value load failed', e); }
}
```

调用点：`grep -n "loadStockScores().then" index.html` 定位（现行 L693），改为：

```js
  Promise.all([loadStockScores(), loadStockValue()]).then(()=>render());
```

- [ ] **Step 5: 渲染接入（不改写现有评分卡，只在其后追加）**

```js
// 1) 股票卡头部：紧跟现有 ${scorePillHtml(s)} 之后加一颗价值胶囊
//    ${valuePillHtml(valueState ? valueState.rows.get(String(s.code||'').trim()) : null)}
// 2) 股票卡展开明细：紧跟现有 ${scoreDetailHtml(s)} 之后加
//    ${valueGateHtml(valueState ? valueState.rows.get(String(s.code||'').trim()) : null)}
// 3) 评分 Top10 卡之后追加价值 Top10（找 renderScoreTop10() 的调用点，紧接其后）
//    降级文案与 renderScoreTop10 同构，但放在调用点（纯函数不读全局）：
//    ${valueState ? renderValueTop10(valueState)
//      : (valueTried ? '<div class="signal-strip"><span class="signal-pill pill-normal">价值批次尚未生成（夜间批处理上线后自动出现）</span></div>' : '')}
```

接入方式：用 `grep -n 'scorePillHtml(s)\|scoreDetailHtml(s)\|renderScoreTop10()' index.html` 拿到精确行号后做单点插入，禁止整块重写卡片模板（本轮刚上线的止盈/抄底横幅就在这些行附近，重写容易误删）。

- [ ] **Step 6: 跑门面测试 + 语法自检**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno test -A scripts/value_leg_logic_test.ts
python3 - <<'PY'
import re
s=open('index.html').read()
blocks=re.findall(r'<script>(.*?)</script>', s, re.S)
big=max(blocks, key=len)
open('/tmp/_main.js','w').write(big)
print('main script bytes:', len(big))
PY
node --check /tmp/_main.js && echo SYNTAX_OK
```

Expected: `6 passed`；`SYNTAX_OK`。门面测试在 Step 3 前必须 FAIL（红先于绿）。

- [ ] **Step 7: Commit（⚠ 需用户明示；只动 index.html 与 scripts/，绝不 `git add -A`）**

```bash
git add index.html scripts/value_leg_logic.ts scripts/value_leg_logic_test.ts && \
git commit -m "feat(dashboard): value-leg pill, gate detail and Top10 card from stock_value batch"
```

---

## Task 8: 前端——分歧榜与换仓提示行（spec 核心交付 + 修订 A1 落地处）

**Files:**
- Modify: `index.html`（`VALUE_PURE` 块内追加函数；分歧榜卡插在 `renderValueTop10` 调用点之后）
- Modify: `scripts/value_leg_logic.ts`（`EXPORT_NAMES` 追加三个名字）
- Test: `scripts/value_leg_logic_test.ts`（追加 6 条）

**Interfaces:**
- Consumes: `valueState.rows`（含 `vq` 与 `main_final` 两个分）+ 前端本地 `stocks`（持仓集合，唯一知道持仓的地方）
- Produces（`VALUE_PURE` 块内）:
  - `const SWAP_GAP = 5;`（pp，spec §7.3；与引擎常数分开写，改动需同步 spec）
  - `divergeLists(rows: object[]): { wronged: object[]; rich: object[] }`（只取 A 级，无条件——spec §7.2 “缺数据造成的便宜”不得混进结论；不留开关）
  - `swapSuggest(row: object, poolRows: object[]): { target: object; gap: number } | null`
  - `renderDivergeBoard(state): string`（持仓集合不需传：`state.rows` 已含池内行与持仓行，榜单只按分歧选，持仓侧提示走 `swapSuggest`）

- [ ] **Step 1: 追加失败测试（6 条）**

```ts
import { divergeLists, swapSuggest, renderDivergeBoard, SWAP_GAP } from "./value_leg_logic.ts";

const v = (code: string, vq: number, main: number, mos: number) =>
  ({ code, name: code, vq, main_final: main, margin_of_safety: mos, tier: 'qualified', confidence: 'A', rf_fallback: false });

Deno.test('SWAP_GAP 常数为 5pp（改动需先改 spec，不得局部改代码）', () => {
  assertEquals(SWAP_GAP, 5);
});

Deno.test('divergeLists：被错杀 = VQ 前 20 分位 × 主分后 50 分位；两组均只取 A 级', () => {
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code).includes('a'), true);
  assertEquals(d.rich.map(r => r.code).includes('c'), true);
  assertEquals(d.wronged.every(r => r.confidence === 'A'), true);
});

Deno.test('divergeLists：main_final 缺失的行不参与（无主分快照就无从谈分歧）', () => {
  const rows = [v('a', 95, 30, 6), { ...v('z', 99, 1, 8), main_final: null }];
  assertEquals(divergeLists(rows).wronged.map(r => r.code).includes('z'), false);
});

Deno.test('swapSuggest：X 的 mos 比 Y 高 ≥5pp 才给建议；4.9pp 不给（边界包含等于）', () => {
  const pool = [v('x', 80, 60, 8.0), v('y', 70, 60, 3.0)];
  assertEquals(swapSuggest(pool[1], pool)!.gap, 5.0);
  assertEquals(swapSuggest({ ...pool[1], margin_of_safety: 3.1 }, pool), null);   // 差 4.9pp
});

Deno.test('swapSuggest：任一侧 rf_fallback（口径不一致）→ 整体静默 null，不混用尺子算优势', () => {
  const pool = [ { ...v('x', 80, 60, 8.0), rf_fallback: true }, v('y', 70, 60, 3.0) ];
  assertEquals(swapSuggest(pool[1], pool), null);
});

Deno.test('renderDivergeBoard：两组标题 + 归因句（含主分四条腿）+ 免责脚注；null 降级为空串', () => {
  // 样本必须足量且真正存在分歧：单行时百分位恒为 50，永远进不了 ≥80 / ≤50 双条件
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ]
    .map(r => ({ ...r, owner_yield: 6.2, roic_med: 18, extras: { main_legs: { quality: 82, growth: 40, value: 44, momentum: 30 } } }));
  const state = { batch: '2026-10-11', top10: rows, rows: new Map(rows.map(r => [r.code, r])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('被错杀'), true);
  assertEquals(html.includes('虚高'), true);
  assertEquals(html.includes('主分腿：Q82/G40/V44/M30'), true);        // 归因句（spec §7.2）
  assertEquals(html.includes('不构成买卖建议'), true);
  assertEquals(renderDivergeBoard(null), '');
});
```

Run: `deno test -A scripts/value_leg_logic_test.ts` → Expected: 新增 6 条 FAIL（`divergeLists is not exported`），旧 6 条仍 PASS

- [ ] **Step 2: 在 `VALUE_PURE` 块内追加分歧榜与换仓逻辑**

```js
// ==== 以下续写在 VALUE_PURE_BEGIN/END 块内 ====
var SWAP_GAP = 5;   // pp；spec §7.3 换仓门槛——改动需先改 spec（受前视时间表约束，届满前不得调）

function pctOf(values, v, reverse){
  var n = values.length; if(!n) return null;
  var below = values.filter(function(x){ return x < v; }).length;
  var eq = values.filter(function(x){ return x === v; }).length;
  var p = (below + 0.5*eq) / n * 100;
  return reverse ? 100 - p : p;
}

// 分歧榜：只取 A 级且 main_final 快照齐全者参与（spec §7.2：“缺数据造成的便宜”不得混进结论）
function divergeLists(rows){
  var use = (rows || []).filter(function(r){
    return r && r.vq !== null && r.vq !== undefined && r.main_final !== null && r.main_final !== undefined
      && r.confidence === 'A';
  });
  var vqs = use.map(function(r){ return Number(r.vq); });
  var ms  = use.map(function(r){ return Number(r.main_final); });
  var wronged = [], rich = [];
  for (var i = 0; i < use.length; i++) {
    var vp = pctOf(vqs, Number(use[i].vq)), mp = pctOf(ms, Number(use[i].main_final));
    if (vp >= 80 && mp <= 50) wronged.push(use[i]);        // 价值高、主分低 → 被动量错杀
    if (vp <= 50 && mp >= 80) rich.push(use[i]);           // 价值低、主分高 → 动量堆出来的贵货
  }
  wronged.sort(function(a,b){ return b.vq - a.vq; });
  rich.sort(function(a,b){ return b.main_final - a.main_final; });
  return { wronged: wronged, rich: rich };
}

// 换仓建议：纯机会成本比较，只看安全边际差；too_rich 永不构成卖出（spec §7.3）
function swapSuggest(row, poolRows){
  if (!row || row.margin_of_safety === null || row.margin_of_safety === undefined || row.rf_fallback) return null;
  var y = Number(row.margin_of_safety);
  var best = null;
  for (var i = 0; i < (poolRows || []).length; i++) {
    var x = poolRows[i];
    if (!x || x.code === row.code || x.tier !== 'qualified' || x.confidence !== 'A') continue;
    if (x.margin_of_safety === null || x.margin_of_safety === undefined || x.rf_fallback) continue;  // 口径不一致 → 不混用尺子
    var gap = Number(x.margin_of_safety) - y;
    if (gap >= SWAP_GAP && (!best || gap > best.gap)) best = { target: x, gap: gap };
  }
  return best;
}

function divergeRowHtml(r, tag){
  var ex = r.extras || {};
  var ml = ex.main_legs || null;
  // 归因句（spec §7.2）：价值侧说“为什么便宜”，主分侧说“为什么被低估”——动量腿低是错杀最常见成因；主分侧说“为什么高分”
  var why = ml ? (' 主分腿：Q' + Number(ml.quality ?? 0).toFixed(0) + '/G' + Number(ml.growth ?? 0).toFixed(0)
    + '/V' + Number(ml.value ?? 0).toFixed(0) + '/M' + Number(ml.momentum ?? 0).toFixed(0)) : ' 主分四条腿未快照';
  return '<div class="score-row"><span class="warn-pill">' + tag + '</span><b>' + escapeHtml(r.name || r.code) + '</b>'
    + '<span style="color:var(--muted);font-size:11.5px">' + escapeHtml(String(r.code)) + '</span>'
    + '<span class="score-pill">VQ ' + Number(r.vq).toFixed(1) + ' / 主分 ' + Number(r.main_final).toFixed(1) + '</span>'
    + '<span style="color:var(--muted);font-size:11px">owner yield ' + valueFmtPct(r.owner_yield)
    + ' · 安全边际 ' + valueFmtPct(r.margin_of_safety, 2) + ' · ROIC中位 ' + valueFmtPct(r.roic_med) + ' · ' + escapeHtml(why) + '</span></div>';
}

function renderDivergeBoard(state){
  if (!state) return '';
  var all = [];
  state.rows.forEach(function(r){ all.push(r); });
  var d = divergeLists(all);
  return '<div class="fund-card"><div class="score-card-title">分歧榜 · 两套分数不一致的地方'
    + '<span style="font-weight:400;font-size:11.5px;color:var(--muted)">批次 ' + escapeHtml(String(state.batch)) + '</span></div>'
    + (d.wronged.length ? d.wronged.slice(0, 5).map(function(r){ return divergeRowHtml(r, '被错杀'); }).join('') : '')
    + (d.rich.length ? d.rich.slice(0, 5).map(function(r){ return divergeRowHtml(r, '虚高'); }).join('') : '')
    + (d.wronged.length + d.rich.length === 0 ? '<div class="score-row" style="color:var(--muted)">本批次无显著分歧样本（两套分数同向）</div>' : '')
    + '<div class="score-card-note">分歧榜只展示两套口径哪里不一致，不构成买卖建议。</div></div>';
}
```

并在 `scripts/value_leg_logic.ts` 的 `EXPORT_NAMES` 追加 `"SWAP_GAP", "divergeLists", "swapSuggest", "renderDivergeBoard"`，及对应类型收敛导出（照 `research_render_logic.ts` 的 `fn()`/`val<T>()` 写法）。

- [ ] **Step 3: 在股票卡展开区接上换仓提示行（仅持仓卡可见）**

```js
// 在 Task 7 插入的 ${valueGateHtml(...)} 之后追加一行（持仓集合在前端，后端无推）：
const heldPoolRows = valueState ? [...valueState.rows.values()] : [];
const vRowForSwap = valueState ? valueState.rows.get(String(s.code||'').trim()) : null;
const swap = swapSuggest(vRowForSwap, heldPoolRows);
// 模板里：${swap ? `<div class="trade-banner buy">🔄 换仓参考：${swap.target.name||swap.target.code} 的安全边际高 ${swap.gap.toFixed(1)}pp（≥${SWAP_GAP}pp）——需覆盖换手成本与税负，否则维持持有；仅展示，不构成指令</div>` : ''}
```

文案必须包含“需覆盖换手成本与税负，否则维持持有”与“仅展示，不构成指令”两句（spec §7.3 的固定包含项与护栏）。

- [ ] **Step 4: 跑测试 + 语法自检**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno test -A scripts/value_leg_logic_test.ts
python3 - <<'PY'
import re; s=open('index.html').read()
big=max(re.findall(r'<script>(.*?)</script>', s, re.S), key=len)
open('/tmp/_main.js','w').write(big); print('bytes', len(big))
PY
node --check /tmp/_main.js && echo SYNTAX_OK
grep -c "VALUE_PURE_BEGIN\|VALUE_PURE_END" index.html   # 期望 2（标记块各自只有一个 BEGIN/END）
```

Expected: `12 passed`；`SYNTAX_OK`；计数 2

- [ ] **Step 5: Commit（⚠ 需用户明示）**

```bash
git add index.html scripts/value_leg_logic.ts scripts/value_leg_logic_test.ts && \
git commit -m "feat(dashboard): divergence board and swap-suggest line (client-side, display only)"
```

---

## Task 9: 前视对照脚本 `scripts/value_forward_check.ts`

**Files:**
- Create: `scripts/value_forward_check.ts`、`scripts/value_forward_check_test.ts`

**Interfaces:**
- Consumes: `stock_value`（历史多批次，含 `main_final` 快照）、腾讯 gtimg 250 根 K 线（已有 `sector-trend/tencent.ts` 同口径，但**不 import Edge 函数目录**，在本脚本内重写 `fetchKline`，避开拼接依赖）
- Produces:
  - `meanReturn(bars: {day:string;close:number}[], baseDay: string, n: number): number | null`（基准日取 `baseDay` 或其前一根；超出范围 → null）
  - `groupCompare(rows: {code:string; group:string; baseDay?: string}[], barsOf: Map<string, {day:string;close:number}[]>, nDays: number): { group: string; mean: number|null; median: number|null; n: number; skipped: number }[]`（`baseDay` 缺省取该系列首根；全组无读数仍出一行 n=0）
  - CLI：`deno run -A scripts/value_forward_check.ts --batch 2026-10-11 --horizons 20,60,120`，打印两组（被错杀/虚高）与 VQ 十分位 vs 主分十分位的对比表

- [ ] **Step 1: 写失败测试（5 条，不挨网络）**

```ts
// scripts/value_forward_check_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { meanReturn, groupCompare } from "./value_forward_check.ts";

const bars = ['2026-01-01','2026-01-02','2026-01-03','2026-01-04'].map((d,i)=>({day:d, close:10+i}));

Deno.test('meanReturn：以 baseDay 收盘为基准算 n 日后涨幅（基准日在序列内）', () => {
  assertEquals(meanReturn(bars, '2026-01-01', 2), 20);          // 10 → 12
});
Deno.test('meanReturn：baseDay 不在序列内 → 取其前一根为基准；早于首根 → null', () => {
  assertEquals(meanReturn(bars, '2026-01-01T00:00:00Z', 1), 10);
  assertEquals(meanReturn(bars, '2025-12-01', 1), null);
});
Deno.test('meanReturn：窗口越界（不足 n 根）→ null（新批次拿不到读数就是拿不到，不填 0）', () => {
  assertEquals(meanReturn(bars, '2026-01-04', 20), null);
});
Deno.test('groupCompare：跳组取均值与样本数；全 null 则 mean=null、n=0', () => {
  const rows = [{ code:'a', group:'wronged' }, { code:'b', group:'wronged' }, { code:'c', group:'rich' }];
  const barsOf = new Map<string, {day:string;close:number}[]>([
    ['a', bars], ['b', bars.map(x=>({...x, close:x.close*2}))],
    ['c', bars],
  ]);
  const out = groupCompare(rows, barsOf, 2);
  const w = out.find(x=>x.group==='wronged')!, r = out.find(x=>x.group==='rich')!;
  assertEquals(w.n, 2); assertEquals(w.mean, 20);        // 两组都是 +20%（涨幅与绝对价无关）
  assertEquals(r.n, 1); assertEquals(r.mean, 20);
});
Deno.test('groupCompare：无价格历史的 code 不拉低样本数（计入跳过原因供报告）', () => {
  const out = groupCompare([{code:'zz', group:'wronged'}], new Map(), 20);
  assertEquals(out.find(x=>x.group==='wronged')!.n, 0);
  assertEquals(out.find(x=>x.group==='wronged')!.mean, null);
});
```

Run: `deno test -A scripts/value_forward_check_test.ts` → Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现脚本**

```ts
/// <reference lib="deno.ns" />
// scripts/value_forward_check.ts —— 前视对照（只读）。规则权威：spec §8 前视验证 + §7.2 分歧榜
// 铁律：本脚本全程只 GET（数据库只读 + gtimg 行情），不写任何生产数据；不足 2 个季度的读数不具备判据力。
const TX_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const KLINE_LMT = 250;
const GAP_MS = 200;                     // 限流教训：逐 code 一次请求 + 200ms，绝不用东财 push2his 批量
type Bar = { day: string; close: number };
type ValLike = { code: string; group: string; baseDay?: string };

export function meanReturn(bars: Bar[], baseDay: string, n: number): number | null {
  if (!bars.length) return null;
  const key = baseDay.slice(0, 10);
  let i = bars.findIndex(b => b.day === key);
  if (i < 0) { for (let k = bars.length - 1; k >= 0; k--) if (bars[k].day <= key) { i = k; break; } }  // 取前一根为基准
  if (i < 0) return null;                               // 早于首根 → null（不猜基准价）
  const j = i + n;
  if (j >= bars.length || !(bars[i].close > 0)) return null;   // 窗口越界 → null（不填 0）
  return (bars[j].close / bars[i].close - 1) * 100;
}

export function groupCompare(rows: ValLike[], barsOf: Map<string, Bar[]>, nDays: number)
: { group: string; mean: number | null; median: number | null; n: number; skipped: number }[] {
  const byG = new Map<string, number[]>(); const skip = new Map<string, number>();
  for (const g of new Set(rows.map(r => r.group))) byG.set(g, []);   // 全组无读数也要出行（报告要看见 n=0）
  for (const r of rows) {
    const bars = barsOf.get(r.code) ?? [];
    const m = bars.length ? meanReturn(bars, r.baseDay ?? bars[0].day, nDays) : null;
    if (m === null) { skip.set(r.group, (skip.get(r.group) ?? 0) + 1); continue; }   // 不计入 n，不拉低均值
    byG.get(r.group)!.push(m);
  }
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  return [...byG.entries()].map(([group, xs]) => ({
    group, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    median: xs.length ? med(xs) : null, n: xs.length, skipped: skip.get(group) ?? 0,
  }));
}

// 分位重算（与前端 divergeLists 同公式；前端块靠 new Function 抽取，无法在 Deno import，故本文件重写一份）
function pctMap(xs: number[]): Map<number, number> {
  const s = [...xs].sort((a, b) => a - b);
  return new Map(xs.map(v => [v, (s.filter(x => x < v).length + 0.5 * s.filter(x => x === v).length) / s.length * 100]));
}
export function classify(rows: { code: string; vq: number; main_final: number }[]): ValLike[] {
  const vp = pctMap(rows.map(r => r.vq)), mp = pctMap(rows.map(r => r.main_final));
  return rows.flatMap(r => {
    const a = vp.get(r.vq)!, b = mp.get(r.main_final)!;
    if (a >= 80 && b <= 50) return [{ code: r.code, group: 'wronged' }];      // 价值高 / 主分低 → 被错杀
    if (a <= 50 && b >= 80) return [{ code: r.code, group: 'rich' }];          // 价值低 / 主分高 → 虚高
    return [];
  });
}

async function fetchKline(sym: string): Promise<Bar[]> {
  const url = `${TX_BASE}?param=${encodeURIComponent(`${sym},day,,${KLINE_LMT},qfq`)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = await r.json();
      const node = j?.data?.[sym];
      const raw = (node?.qfqday ?? node?.day ?? []) as (string | number)[][];
      return raw.map(x => ({ day: String(x[0]), close: Number(x[2]) })).filter(b => b.day && isFinite(b.close));
    } catch { if (attempt === 3) return []; await new Promise(r => setTimeout(r, 1500 * attempt)); }
  }
  return [];
}

const arg = (k: string, d = '') => (Deno.args[Deno.args.indexOf(k) + 1] ?? d);
if (import.meta.main) {
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_ANON_KEY')!;
  const batch = arg('--batch'), horizons = (arg('--horizons', '20,60,120')).split(',').map(Number);
  if (!url || !key || !batch) { console.error('usage: --batch YYYY-MM-DD --horizons 20,60,120'); Deno.exit(2); }
  const q = `select=code,vq,main_final,tier,confidence&batch_date=eq.${batch}&vq=not.is_null&main_final=not.is_null`;
  const res = await fetch(`${url}/rest/v1/stock_value?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) { console.error(`read stock_value ${res.status}`); Deno.exit(1); }
  const rows = (await res.json()) as { code: string; vq: number; main_final: number }[];
  if (rows.length === 0) { console.error('该批次无 (vq, main_final) 齐备行——先确认 Task 6 已落库'); Deno.exit(1); }
  console.log('【前视对照】不足 2 个季度（每季 1 个批次前沿）的读数不具备判据力（spec §8）\n');
  const groups = classify(rows).map(g => ({ ...g, baseDay: batch }));
  const barsOf = new Map<string, Bar[]>();
  for (const g of groups) {
    barsOf.set(g.code, await fetchKline(`${g.code.startsWith('6') ? 'sh' : 'sz'}${g.code}`));
    await new Promise(r => setTimeout(r, GAP_MS));
  }
  for (const n of horizons) {
    const out = groupCompare(groups, barsOf, n);
    console.log(`窗口 ${n} 日：` + out.map(x => ` ${x.group} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}% 中位=${x.median?.toFixed(2) ?? 'NA'}% 无读数=${x.skipped}`).join(' |'));
  }
}
```

分组阈值（`vp>=80 && mp<=50` / `vp<=50 && mp>=80`）与前端 `divergeLists` 是本计划的两处同公式实现（脚本一份、前端 PURE 块一份），改动必须同步。执行时跑一次交叉核对，两边数字不一致就停下：

```bash
grep -n '80\|50' scripts/value_forward_check.ts | grep -E 'wronged|rich|>=|<=' ; grep -n 'vp>=80\|mp<=50\|vp<=50\|mp>=80' index.html
```

- [ ] **Step 3: 跑测试 + 干跑一次（仅当生产已有 ≥1 个批次；否则只跑单测）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno test -A scripts/value_forward_check_test.ts
```

Expected: `5 passed`。干跑命令（只读）：`deno run -A scripts/value_forward_check.ts --batch <最新批次> --horizons 20`；若报“起算批次不足 2 个季度”，属预期输出，不是失败。

- [ ] **Step 4: Commit（⚠ 需用户明示）**

```bash
git add scripts/value_forward_check.ts scripts/value_forward_check_test.ts && \
git commit -m "feat(scripts): forward-return check for value leg (read-only, divergence groups)"
```

---

## Task 10: 上线（本 Task 每一步都是生产写，需用户逐条明示）

**Files:**
- Modify: `scripts/cron_stock_score.sql` 同目录新建 `scripts/cron_stock_value.sql`
- Modify: `README.md`（模块表加 `stock-value`；不推送无关脏文件）

**Interfaces:**
- Consumes: Task 1-9 全部产物
- Produces: 生产库表 + ACTIVE 函数 + 每晚 cron + 首跑健康度报告

- [ ] **Step 1: 迁移执行（⚠ 需用户明示）**

```bash
# 令牌只从环境变量读，绝不写进文件/命令行历史可见形式
SQL=$(python3 -c "import pathlib,sys; sys.stdout.write(pathlib.Path('scripts/migrate_stock_value.sql').read_text())")
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,os;print(json.dumps({'query':os.environ['SQL']}))")"
```

执行前必须向用户复述一遍将建的表名与策略，得到“执行”两字才动手。

- [ ] **Step 2: 只读验收建表结果（无写）**

```sql
select table_name from information_schema.tables where table_schema='public' and table_name in ('stock_value','value_config');
select tablename, policyname, roles::text, cmd from pg_policies where tablename in ('stock_value','value_config');
```

Expected: 两表存在；每条策略 `roles = {anon,authenticated}`、`cmd = SELECT`。登录用户可读是 I-1 教训的验收点，**必须实际登录一次用前端读取确认**，不能只看 pg_policies。

- [ ] **Step 3: 函数部署（⚠ 需用户明示）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno task verify-bundles   # 全绿才允许部署
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=stock-value" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F 'metadata={"entrypoint_path":"index.ts","import_map_path":"","verify_jwt":false,"name":"stock-value","no_cache":true};type=application/json' \
  -F "file=@supabase/functions/stock-value/deploy.ts;type=application/typescript"
```

Expected: 返回 `version` 自增、`status: ACTIVE`。先 `GET /v1/projects/$REF/functions` 确认令牌与当前版本列表。

- [ ] **Step 4: secrets（`GS_API_KEY` 复用，`DAILY_UPDATE_TOKEN` 复用；⚠ 需用户明示）**

secrets 值一律从现有 `stock-score` 函数复制，**绝不在终端回显**；写入方式用 Management API secrets 端点，命令参数从环境取。

- [ ] **Step 5: ping 验证（无数据写）**

```bash
curl -s -H "Authorization: Bearer $DAILY_UPDATE_TOKEN" "$URL/functions/v1/stock-value?mode=ping"
```

Expected: `{"ok":true,"rows":5000+}`。若 rows 明显偏低（<4000）→ P-3 列族丢弃，先排查措辞，不得进入 Step 6。

- [ ] **Step 6: 首跑 `mode=run`（⚠ 需用户明示）**

```bash
curl -s -X POST -H "Authorization: Bearer $DAILY_UPDATE_TOKEN" "$URL/functions/v1/stock-value?mode=run"
```

Expected 响应字段逐项核对：`rows ≥ 4000`、`qualified > 0`、`vetoed ≥ 0` 且比例可解释、`cn10y_source ∈ override/auto/none`、`div_leg_ok` 为布尔。
若 `cn10y_source=none` 且 `qualified` 异常偏少 → `rf_fallback` 退化路径在起作用，先写入 `value_config.cn10y_override` 再重跑，不要直接判“引擎坏了”。

- [ ] **Step 6b: 投入资本近似校准（⚠ 需用户明示才能跑；spec §4.1/§9.1 “落地首周必须校准”，不校准则不得进入 Step 8 注册 cron）**

先写一次性探针实跑（响应形态未知，**不得猜列名就写解析器**，同 Task 5 的纪律）：

```ts
// scripts/probe_ic_calibration.ts —— 一次性：用国信三表接口的真实股东权益校准 ic = 货币资金 + 带息债务（spec §4.1）
// 凭据铁律：key 只从 env 或本地 memory.md 读，绝不打印；输出前再过一道 scrub。本脚本全程只 GET。
const BALSHEET = 'https://dgzt.guosen.com.cn/skills/gsnews/gsf10/financial/balanceSheet/1.0';
const KEYFILE = '/Users/alick/.qoder-cn/plugins/cache/local/guosen-finance/skills/gs-smart-stock-picking/memory.md';
const fromEnv = Deno.env.get('GS_API_KEY');
const key = fromEnv ?? (await Deno.readTextFile(KEYFILE)).match(/^GS_API_KEY\s*=\s*(\S+)\s*$/m)?.[1];
if (!key) { console.error('no key'); Deno.exit(2); }
const scrub = (s: string) => s.split(key).join('REDACTED');

const SB = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const batch = Deno.args[0] ?? '';
if (!batch) { console.error('usage: probe_ic_calibration.ts <batch_date>'); Deno.exit(2); }
// 取价值 Top 榜前 10（spec §4.1 只要求校准 3 只；多取几只是因为 Top 榜才是要接入的那批）
const q = `select=code,name,ic,cash,debt,mktcap&batch_date=eq.${batch}&tier=eq.qualified&confidence=eq.A&order=vq.desc&limit=10`;
const rs = await fetch(`${SB}/rest/v1/stock_value?${q}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
if (!rs.ok) { console.error(`read stock_value ${rs.status}`); Deno.exit(1); }
const top = (await rs.json()) as { code: string; name: string; ic: number; cash: number; debt: number }[];
if (!top.length) { console.error('无 A 级合格行，先回 Step 7 查健康度'); Deno.exit(1); }

// 股东权益字面名未知：先打印真实响应结构（只打键名与样本体前 600 字，已 scrub），再据实读数
for (const r of top.slice(0, 3)) {
  const sym = `${r.code.startsWith('6') ? 'SH' : 'SZ'}`;
  const u = `${BALSHEET}?${new URLSearchParams({ code: r.code, market: sym, reportType: 'Q4', count: '1', softName: 'goldsun_skills', apiKey: key })}`;
  const resp = await fetch(u, { signal: AbortSignal.timeout(60_000) });
  const body = scrub(await resp.text());
  console.log(`--- ${r.code} ${r.name} http=${resp.status}`);
  console.log(body.slice(0, 600));                                  // 只为了看树形与字段名，不拼 URL、不打 headers
  await new Promise(x => setTimeout(x, 300));
}
```

Run: `cd "/Users/alick/Documents/GitHub/fund invest" && deno run -A scripts/probe_ic_calibration.ts <首跑批次>`

**拿到真实响应树形后**，人工从上面打印的正文里读出年报“所有者权益合计/股东权益”数字（不猜列名、不自动解析），把三个数回传给探针算误差。探针补完这一段（列位置确定，无需猜测）：

```ts
// 用法：probe_ic_calibration.ts <batch_date> --eq 600031=4.12e10 --eq 000651=2.30e10 --eq 600519=2.16e11
// （--eq 的值就是上一步人工从响应正文里读到的年报股东权益，单位元；科学计数法直接写）
const relErr = (approx: number, truth: number) => truth === 0 ? NaN : Math.abs(approx - truth) / Math.abs(truth) * 100;
const given = new Map<string, number>();
for (let i = 0; i < Deno.args.length - 1; i++)
  if (Deno.args[i] === '--eq') { const [c, v] = Deno.args[i + 1].split('='); given.set(c, Number(v)); }
if (given.size >= 3) {
  const errs: number[] = [];
  console.log('code      ic_approx      equity_true      rel_err%');
  for (const r of top) {
    const t = given.get(r.code);
    if (t === undefined || !isFinite(t) || t <= 0) continue;
    const approx = (r.cash ?? 0) + (r.debt ?? 0);
    const e = relErr(approx, t); errs.push(e);
    console.log(`${r.code}  ${approx.toExponential(3)}   ${t.toExponential(3)}   ${e.toFixed(1)}%`);
  }
  const s = errs.sort((a, b) => a - b), k = s.length >> 1;
  console.log(`样本 ${s.length} 只・中位误差 ${((s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2)).toFixed(1)}%`);
}
```

判定与行动（用 spec §4.1 原文阈值 25%，不得自己放宽）：
- 中位误差 **≤25%** → 近似可继续用；在报告里写“已校准，保留 ic_approx=true 标记”，进 Step 7。
- 中位误差 **>25%** → **停下不注册 cron**，改为“三表接口单只补取”方案（仅 Top 榜，≤13 只/晚）：这属架构改动（新增每晚逐只取数与缓存），必须回 spec 重议并由用户批准后再执行。
- 响应正文里根本找不到股东权益数 → 记为新的实测推翻，同上停下上报。

探针产物不入库：`rm scripts/probe_ic_calibration.ts`（与 Task 5 Step 5 同纪律）。**探针输出里若出现 key，不得贴进任何文档/提交/记忆。**

- [ ] **Step 7: 只读健康度复核（不写；输出须脱敏）**

```sql
select tier, confidence, count(*) from stock_value where batch_date = current_date group by 1,2 order by 3 desc;
select count(*) filter (where vq is not null) as with_vq, count(*) filter (where confidence='A') as a_level,
       percentile_cont(0.5) within group (order by vq) as vq_median,
       count(*) filter (where main_final is null and in_pool) as pool_missing_main
  from stock_value where batch_date = current_date;
-- 黄金样本的真实数据版（spec §10“招商银行——金融股 NA 路径”）：单测只能用合成 fixture 走同一代码路径，
-- 而这里验证真池子里的银行股确实没被“无护城河证据”误杀（P-1：roic 对金融股天然 NA）
select count(*) filter (where roic_cur is null and vetoed and veto_reasons::text like '%无护城河%') as fin_miskilled,
       count(*) filter (where roic_cur is null) as roic_na_rows
  from stock_value where batch_date = current_date and ths_l1 in ('银行','非银金融','证券','保险');
```

判据（spec §10）：`vq_median` 应近 50、A 级占比 ≥40%、`pool_missing_main` 应为 0、`fin_miskilled` **必须为 0**（不为 0 则金融股否决4 的 ROE 对标路径未生效，属引擎缺陷）。不达则**停线上**（不注册 cron），先把原因写进报告给用户。

- [ ] **Step 8: 注册 cron（⚠ 需用户明示；排在 stock-score 后 15 分钟）**

```sql
-- scripts/cron_stock_value.sql
-- stock-value nightly: 21:45 北京（13:45 UTC），紧跟 stock-score 21:30
select cron.schedule('stock-value-nightly', '45 13 * * *',
  $$select net.http_post(
    url := 'https://<REF>.supabase.co/functions/v1/stock-value',
    headers := jsonb_build_object('Authorization','Bearer <DAILY_UPDATE_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb
  ) as req_id$$);
```

令牌写 `$DAILY_UPDATE_TOKEN` 变量插值，**执行后不得** `select job.command`（含 Bearer 原值，既有凭据安全规范）；只 `select jobid, schedule from cron.job where jobname='stock-value-nightly'` 确认已注册。

- [ ] **Step 9: 前端双端部署（Pages + Vercel；⚠ 需用户明示）**

沿用既有链：`cp index.html site/index.html` → `wrangler pages deploy . --project-name=fund-invest888 --branch=main` → `vercel deploy --prod --yes`。
验收踩过的两个坑必须重做：① 部署后先打专属 URL 确认新内容（`grep -c renderDivergeBoard`），再 `sleep 25` 后复验 `pages.dev` 别名（别名传播有延迟）；② `*.vercel.app` 直连可能超时，内容级拿不到证据时**如实说明**，只以 CLI `vercel inspect` 的 `target: production` / `status: Ready` 为据。

- [ ] **Step 10: 更新文档与收尾**

```bash
# README.md：模块清单加 stock-value（仅这一行，不混入无关脏文件）
# spec：把 A1–A5 五条修订回写进 docs/superpowers/specs/2026-10-11-stock-value-leg-design.md §11 决策记录
```

spec 回写时逐条标注“计划阶段发现（2026-10-11）”，不要伪装成原始设计。最后向用户报告：本地未 push 的提交数（含本轮之前已有的 2 个）、前视时间表起算日（首个可用批次日期）。
