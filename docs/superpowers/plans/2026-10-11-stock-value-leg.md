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
  owner_yield numeric, margin_of_safety numeric, cn10y numeric, rf_fallback boolean not null,
  -- 排序层与判定
  vq numeric, v_moat numeric, v_cash numeric, v_safety numeric, v_health numeric,
  vcov numeric, tier text, confidence char(1),
  vetoed boolean not null, veto_reasons jsonb, flags jsonb,
  ind_rank integer, ind_n integer, market_rank integer, market_n integer,
  main_final numeric, main_confidence text,   -- 当晚 V1.1 主分快照（spec §8：半年后复盘免 join，不受主引擎改版断裂）
  extras jsonb,                                -- 全部 GS 列日期戳 + ic_approx + 告警
  primary key (batch_date, code)
);
create index if not exists stock_value_batch_tier_idx on stock_value (batch_date, tier);
create index if not exists stock_value_batch_vq_idx on stock_value (batch_date, vq desc);

comment on column stock_value.ic is '投入资本 = 货币资金 + 带息债务（近似，spec §4.1；extras.ic_approx=true 时成立）';
comment on column stock_value.margin_of_safety is 'owner_yield − cn10y（pp）；cn10y 缺失时为 null 且 rf_fallback=true';
comment on column stock_value.rf_fallback is '降级尺子标记；故意 not null 且无 default——漏写该列会让整批 insert 直接报错（fail loudly），而不是静默存成 false 把“口径不一致”伪装成“口径一致”';

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
grep -c "boolean not null" scripts/migrate_stock_value.sql                              # 期望 2（rf_fallback/vetoed 不得带 default：见上注）
```

Expected: 2/2/2/0/1/2。任一不符 → 未按 A1/A4 与本计划 fail-loudly 约束落实，回改后重跑。

- [ ] **Step 3: 与 Task 6 的 upsert 键名交叉核对（先对齐再执行迁移）**

Task 6 写完后执行。**抽取命令已于 Task 1 执行时校正**（原写法 `grep -oE '^\s+[a-z_0-9]+'` 只取每行首词，而本迁移是一行多列 `a text, b text,` 形态 → 实测只拿到 15 个名字 + `primary` 杂讯，漏 32 列，照跑会把 Task 6 的正常 payload 键误报成“多键”）：

```bash
# 迁移列名（逗号/换行都当分隔符；剔掉 SQL 关键字杂讯）
sed -n '/create table if not exists stock_value (/,/primary key/p' scripts/migrate_stock_value.sql \
  | sed 's/--.*//' | tr ',\n' '\n\n' | awk 'NF{print $1}' \
  | grep -E '^[a-z_0-9]+$' | grep -vE '^(create|primary)$' | sort -u > /tmp/db_cols.txt
wc -l /tmp/db_cols.txt                     # 期望 47（Task 1 实测值）
# 编排层 payload 键（只看 toDbRow 的返回对象字面量层，避免把 extras 内层键混进来）
sed -n '/^export function toDbRow/,/^}/p' supabase/functions/stock-value/index.ts \
  | grep -oE '^\s{4}[a-z_0-9]+:' | tr -d ' :' | sort -u > /tmp/payload_keys.txt
diff /tmp/db_cols.txt /tmp/payload_keys.txt
```

Expected: 差异只允许是 `batch_date`/`code` 与主键声明带来的行（payload 里以 `batch_date: batch` 形态出现）；`extras`/`flags`/`veto_reasons` 三个 jsonb 列在 payload 里必须存在。多键 → PostgREST `Could not find the ... column` 整批失败；少键 → 该列恒 NULL。本项目已踩过此坑，必须在此拦住。**两侧的名单都要肉眼过一遍**，命令只是取数手段，不是判据本身。

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

- [ ] **Step 1: 写失败测试（10 条，全部无网络）**

> 第 8–10 条是 Task 2 首轮评审（Needs fixes）判出的三条 plan-mandated 缺陷的回归防护：兄弟列键序误绑、q3「计数 3 但不三根年报」、0331 一季报被误拒。它们必须先红再绿——照原实现（裸 `find(startsWith)` + `mmdd===630||930`）三条全 FAIL。

```ts
// supabase/functions/stock-value/gs_value_test.ts
import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertCols, assertPeriod, mergeValueTables, buildVQ3, yearAnchors, type GsTable } from './gs_value.ts';

// std@0.224.0 的 assertThrows 第二参数只接受 string / ErrorClass，**无 RegExp 重载**：写
// `assertThrows(fn, /re/)` 会撞 TS2769 使整个测试文件跑不起来，而且运行时静默忽略消息匹配
// （守卫测试当场退化成“只要求抛错”的空断言）。取错文再 assertMatch，仓内先例：stock-score/sina_test.ts:46。
const thrownMessage = (fn: () => unknown): string => (assertThrows(fn) as Error).message;

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
  assertMatch(thrownMessage(() => assertCols({ '股票代码': ['1'], '市净率[20260930]': ['1'] } as GsTable, 'q4')), /missing column: 市盈率/);
  assertCols({ '股票代码': ['1'], '股票简称': ['x'], '市盈率[20260930]': ['1'], '市净率[20260930]': ['1'], '总市值[20260930]': ['1'] } as GsTable, 'q4');
});

Deno.test('P-4 守卫：同批绝对值列日期戳不一致 → 抛错；一致则返回该戳', () => {
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20251231]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW)), /period mismatch/);
  assertEquals(assertPeriod({ '股票代码': ['1'], '货币资金[20260630]': ['1'], '带息债务[20260630]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), '20260630');
});

Deno.test('P-4 守卫：日期戳漂到非合法报告期（混提历史窗口的典型症状）→ 抛错', () => {
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20240630]': ['1'] } as GsTable, ['货币资金'], NOW)),
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
  // 第三种空语义：该批成功、但表里没有这一行（GS 分页漏行/停牌）≠ 从不分红，必须 NA 而不是 0。
  // 原写法 `at(t5, K.dy, j5) ?? 0` 把 j5<0（行缺席）与 j5≥0 且值为空 折叠成同一个 0。
  const noRow = { '股票代码': ['999999.SZ'], '股息率[20251231]': ['1.0'], '股息率平均[20211231-20251231]': ['1.0'] } as GsTable;
  assertEquals(merge(noRow).rows.find(r => r.code === '000001.SZ')!.divYield, null);
  assertEquals(merge(noRow).rows.find(r => r.code === '000001.SZ')!.divY5y, null);
});

Deno.test('三年 ROIC 窗口列数≠3 → 整批抛错（宁拒绝不错位；P-2 齐备率 63% 是"行为空"不是"列数变"）', () => {
  const bad = { ...fx('vq3_sample.json') } as GsTable;
  delete bad['投入资本回报率[20231231]'];
  assertMatch(thrownMessage(() => merge(undefined, bad)), /exactly 3 window columns/);
});

Deno.test('兄弟列键序不得决定绑定（V1.1 gs.ts:211-212 实炸过的同类坑：净资产收益率 命中加权版）', () => {
  // vq5 fixture 故意把 `股息率平均[...]` 排在 `股息率[...]` 之前——真响应快照的键序明显非字典序，
  // 裸 find(startsWith) 会把当期股息率绑成五年平均（3.2 → 2.8），且 REQUIRED.q5 的 '股息率'
  // 会被兄弟列单独满足 → 当期股息率整列缺失也能过 P-3 守卫、静默跑完整夜。
  const ks = Object.keys(fx('vq5_sample.json'));
  assertEquals(ks.indexOf('股息率平均[20211231-20251231]') < ks.indexOf('股息率[20251231]'), true);   // 自检：兄弟列确实排在目标列之前
  const rows = merge().rows;
  assertEquals(rows[0].divYield, 3.2);
  assertEquals(rows[0].divY5y, 2.8);
  assertMatch(thrownMessage(() => assertCols(
    { '股票代码': ['1'], '股息率平均[20211231-20251231]': ['1'] } as GsTable, 'q5')), /missing column: 股息率/);
});

Deno.test('三年 ROIC 还须是三根年报列（1231）且年份恰为 base−2/base−1/base——混戳即整批拒绝', () => {
  // 「恰好 3 根」不保证是年度列：{20231231, 20241231, 20260630} 计数也是 3，
  // roic3[2] 会装一期中报值冒充年报，相对 V1.1（另叠加 anchorsOk 新鲜度守卫）是弱化。
  const mixed = { ...fx('vq3_sample.json') } as GsTable;
  delete mixed['投入资本回报率[20231231]'];
  mixed['投入资本回报率[20260630]'] = ['1.0', '2.0', '3.0'];
  assertMatch(thrownMessage(() => merge(undefined, mixed)), /expected 3 annual columns/);
});

Deno.test('一季报戳 0331 必须放行（5 月中至 8 月底 GS 只回 [yyyy0331]，拒它 = 全年约 1/3 的夜晚炸批零产出）', () => {
  assertEquals(assertPeriod({ '股票代码': ['1'], '货币资金[20260331]': ['1'], '带息债务[20260331]': ['1'] } as GsTable,
    ['货币资金', '带息债务'], NOW), '20260331');
  // 放行不等于放弃校验：非法报告期（非 0331/0630/0930/1231）仍须炸批。
  assertMatch(thrownMessage(() => assertPeriod({ '股票代码': ['1'], '货币资金[20260501]': ['1'] } as GsTable, ['货币资金'], NOW)),
    /not in allowed window/);
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
  "带息债务[20260630]": ["10000000000", "123,456,789", "2200000000000"],
  "商誉占净资产比例[20260630]": ["", "8.5", "0.2"] }
```

`vq3_sample.json`（**响应列名形态已按仓内实探针产物修正**，Task 2 执行时发现）：GS 的历史窗口列一律回 `指标名[数据日期]`，**不携带提问里的年份前缀**——铁证是现行生产引擎：`stock-score/gs.ts:30` 的提问里写 `${b}年报净资产收益率`，而 `gs.ts:195` / `gs_test.ts:252-262` 与真响应快照 `stock-score/fixtures/fin_sample.json` 里的列名是 `净资产收益率roe(加权,公布值)[20241231]`。原计划的 `2023年报投入资本回报率[...]` 形态属未验证假设，与同计划的 `REQUIRED.q3` 前缀匹配互斥（年份前缀使任何固定串都无法匹配）。

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "投入资本回报率[20231231]": ["17.1", "7.0", null],
  "投入资本回报率[20241231]": ["18.0", "6.5", null],
  "投入资本回报率[20251231]": ["18.9", "6.2", null] }
```

`vq4_sample.json`

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "市盈率(pe)[20260930]": ["14.2", "38.0", "5.8"],
  "市净率(pb)[20260930]": ["2.1", "-0.5", "0.7"],
  "总市值[20260930]": ["20000000000", "5400171000000", "900000000000"] }
```

`vq5_sample.json`（**键序刻意为之**：`股息率平均` 必须排在 `股息率` 之前，否则测试 8 的前缀误绑防护是空转的——`find(startsWith)` 恰好因为目标列在前而蒙对）

```json
{ "股票代码": ["600031.SH", "000001.SZ", "600036.SH"],
  "股息率平均[20211231-20251231]": ["2.8", "", "4.9"],
  "股息率[20251231]": ["3.2", "", "5.1"] }
```

> `vq2` 的 `带息债务` 第二行写成 `"123,456,789"`（带千分位）：原写法 `"123456789"` 让测试「科学计数法与千分位字符串不得被当成空值」名字里承诺的 `replace(/,/g,'')` 分支从未被执行——测试名承诺的回归防护只兑现了一半。GS 的大额绝对值列确实回千分位串，这条必须有真覆盖。

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

// 列标签 = 去掉 `[数据日期]` 后缀后的列名。GS 在同一张表里并存兄弟列（`股息率` / `股息率平均`、
// `资产负债率` / `资产负债率同比增长率`、`净资产收益率` / 加权公布值），裸 `find(k => k.startsWith(prefix))`
// 的胜负押在响应键序上（真快照键序明显非字典序）→ 会静默绑错列；更糟的是 REQUIRED 守卫会被兄弟列单独满足，
// 目标列整列缺失也能过 P-3、静默跑完整夜（V1.1 `gs.ts:211-212` 就是这么实炸过的）。
const labelOf = (k: string): string => k.replace(/\[.*$/, '');
export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  const keys = Object.keys(t);
  const exact = keys.find(k => labelOf(k) === prefix);
  if (exact) return exact;
  // 无全等标签时才退到前缀，且只接受“前缀后接的不是中文后缀”：`市盈率` → `市盈率(pe)` 是同一指标的括号别名（收），
  // `股息率` → `股息率平均` 是另一个指标（拒）。候选多个则取标签最短，再用列名字典序兜底——决定性，绝不返回“响应里第一个”。
  return keys
    .filter(k => labelOf(k).startsWith(prefix) && !/^[\u4e00-\u9fff]/.test(labelOf(k).slice(prefix.length)))
    .sort((a, b) => labelOf(a).length - labelOf(b).length || (a < b ? -1 : 1))[0];
}
// 提问措辞与响应标签不保证一致（V_Q5 问的是「近5年股息率平均值」，探针形态是 `股息率平均[...]`）→ 按候选依次试。
const colAnyOf = (t: GsTable | null, names: string[]): string | null =>
  t ? names.map(n => colByPrefix(t, n)).find(Boolean) ?? null : null;
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
// q3 的列族守卫同时依赖两件事实（Task 2 执行时定形）：① 响应列名为 `投入资本回报率[yyyyMMdd]`（仓内实探针铁证，见 Fixture 注）；
// ② 「恰好 3 根窗口列」守卫在 assertCols 之后把关，缺任一根 → 数量≠3 → 整批拒绝（与 V1.1 roe3y 同纪律）。
const REQUIRED: Record<BatchName, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率', '所属同花顺行业', '股票市场类型'],
  q2: ['股票代码', '企业自由现金流量fcff', '货币资金', '带息债务', '商誉占净资产比例'],
  q3: ['股票代码', '投入资本回报率'],
  q4: ['股票代码', '市盈率', '市净率', '总市值'],
  q5: ['股票代码', '股息率'],   // 本表能拦住“当期股息率整列缺失”全靠 colByPrefix 的全等标签优先：裸前缀下 `股息率平均` 会单独满足它
};
export function assertCols(t: GsTable, fam: BatchName): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS ${fam} missing column: ${name}`);
}

const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';
// 合法报告期只有四种；其余一律拒（乱戳比放行危险得多）。
const PERIOD_MD = new Set([331, 630, 930, 1231]);

// P-4 双守卫：① 同批绝对值列必须共用一个戳（混提会整体改写）；② 戳必须落在合法报告期窗口
export function assertPeriod(t: GsTable, names: string[], now: Date): string {
  const stamps = new Set<string>();
  for (const n of names) for (const k of windowCols(t, n)) { const s = stampOf(k); if (s) stamps.add(s); }
  if (stamps.size === 0) throw new Error('GS period: no dated column found');
  if (stamps.size > 1) throw new Error(`GS period mismatch: ${[...stamps].sort().join(',')}`);
  const s = [...stamps][0];
  const y = Number(s.slice(0, 4)), mmdd = Number(s.slice(4));
  const base = yearAnchors(now).annualBase;
  // 年报可以是 base 年（已披露）或 base+1 年（提前回下年报）；一季/中/三季报告必然属 base+1 年。
  // `mmdd === 331` 必须在内：5 月中至 8 月底 GS 的绝对值列只回 `[yyyy0331]`，原写法（只认 630/930）
  // 会把全年约 1/3 的夜晚拒成炸批零产出。
  const ok = PERIOD_MD.has(mmdd) && (mmdd === 1231 ? y === base || y === base + 1 : y === base + 1);
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
  // 当期 ROIC 的戳同受 spec §8 时点纪律约束：原先只把 stampOf(K.roic) 直存 extras、从不校验，漂到任意期次都照落。
  const stamp1 = assertPeriod(t1, ['投入资本回报率'], now);
  const codes = t1['股票代码'] as string[];
  if ((t3['股票代码'] as string[]).length !== codes.length) throw new Error('GS q3 row count differs from q1');
  const roic3Keys = windowCols(t3, '投入资本回报率');          // 已按戳升序 = 时间升序；与 V1.1 的 windowColsByPrefix 同口径
  if (roic3Keys.length !== 3) throw new Error(`GS q3 expected exactly 3 window columns, got ${roic3Keys.length}`);
  // “恰好 3 根”不保证是 3 根**年报**列：{20231231, 20241231, 20260630} 计数也是 3，roic3[2] 会装一期中报值冒充年报，
  // 相对 V1.1（另叠加 anchorsOk 新鲜度双通道）是弱化。锤死年份与期次，宁拒绝不错位。
  const base = yearAnchors(now).annualBase;
  const wantYears = [base - 2, base - 1, base].join(',');
  const gotYears = roic3Keys.map(k => stampOf(k).slice(0, 4)).join(',');
  if (roic3Keys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears)
    throw new Error(`GS q3 expected 3 annual columns (${wantYears}@1231), got ${roic3Keys.map(stampOf).join(',')}`);
  const idx = (t: GsTable | null) => new Map(((t?.['股票代码'] as string[] | undefined) ?? []).map((c, i) => [c, i]));
  const i2 = idx(t2), i3 = idx(t3), i4 = idx(t4), i5 = t5 ? idx(t5) : null;
  const K = {
    name: colByPrefix(t1, '股票简称')!, ths: colByPrefix(t1, '所属同花顺行业')!, mkt: colByPrefix(t1, '股票市场类型')!,
    roic: colByPrefix(t1, '投入资本回报率')!,
    fcff: colByPrefix(t2, '企业自由现金流量fcff')!, cash: colByPrefix(t2, '货币资金')!,
    debt: colByPrefix(t2, '带息债务')!, gw: colByPrefix(t2, '商誉占净资产比例')!,
    pe: colByPrefix(t4, '市盈率')!, pb: colByPrefix(t4, '市净率')!, mc: colByPrefix(t4, '总市值')!,
    dy: t5 ? colByPrefix(t5, '股息率')! : null,
    dy5: colAnyOf(t5, ['股息率平均', '近5年股息率平均值', '近5年股息率']),
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
      // 空值语义②（三种空不可互换）：整批缺席 → NA；该批成功但表里无此行（j5<0）→ NA；行在而值空 → 0（从不分红）。
      // 原写法 `?? 0` 无行存在性门控，把“行缺席”折叠成“从不分红”，与 V1.1 的 momRowOk/strictWin 先行门控相反。
      divYield: !t5 || K.dy === null || j5 < 0 ? null : num(t5[K.dy]?.[j5]) ?? 0,
      divY5y: !t5 || K.dy5 === null || j5 < 0 ? null : num(t5[K.dy5]?.[j5]) ?? 0,
    };
  });
  return { rows, stamps: { fin_period: stamp2, val_period: stampOf(K.pe), roic_period: stamp1 } };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd supabase/functions/stock-value && deno test -A gs_value_test.ts && deno check gs_value.ts`
Expected: `ok | 10 passed | 0 failed`，`deno check` 无输出

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

- [ ] **Step 1: 写失败测试（9 条）**

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
  assertEquals(kind({ roic: 9, roic3: [5, 6, 7] }), 'unqualified');               // 单低：med=6<8 但当期 9≥8 → 不触发否决4，才是“roic_med 不达标”这一档
  assertEquals(kind({ fcff: 1e8 }), 'too_rich');                                  // oy=min(0.5,3)=0.5 → mos=-1.35
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }), 'gate_ok');    // oy=min(15,6.2)=6.2 → mos=4.35
  assertEquals(kind({ fcff: 1e8 }, null), 'too_rich');                             // rfFallback：oy 0.5 < 6
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }, null), 'gate_ok'); // rfFallback：oy=6.2 ≥ 6
});

Deno.test('金融股过 gateOf：roic 腿置 true 不得让低 ROE 蒙混（P-1 的误杀/漏判双向都钉住）', () => {
  const fin = { isFin: true, roic: null, roic3: [null, null, null], fcff: 3e9 } as Partial<ValueRaw>;
  // 置 true 生效的一侧：roic3 全 NA 若走非金融分支（`med === null → roicOk = false`），金融股会整类落 unqualified —— 这正是 P-1 要防的误杀形态。
  assertEquals(gateOf(mk(fin), 1.85, { roe: 15 }).passed, true);
  // 低 ROE 靠否决4 拦而不靠 roic 腿兜：这条是 `roicOk = r.isFin ? true` 不被滥用为“金融股免检”的唯一证据。
  const lo = gateOf(mk(fin), 1.85, { roe: 3 });
  assertEquals(lo.vetoed, true);
  assertEquals(lo.vetoReasons.includes('无护城河证据'), true);
  // 上游不传 roe（或传 {roe:null}）时：否决4 不判定 + roicOk 恒 true → 低 ROE 银行仅凭价格腿过关。
  // 该静默路径不由本层守，由 Task 5 把金融股 ROE 列加进 REQUIRED 来守（缺列→整批炸，而不是静默降级）；Task 4 的调用点已写定传 `finRoe.get(code)`。
});
```

> **手算复核要求（不得照抄直觉）**：`normY = roic_med × IC / 市值`，基准样本 `IC=4e9`、`市值=2e10` → 因子 `0.2`；故 `roic_med=31 → normY=6.2`，`roic_med=15 → normY=3`。期望值与实现不符时先重算，确认是实现错才改实现。
>
> **档位互斥性（控制方在 Task 3 执行时裁定，勿再回到字面争论）**：`med < 8` 的样本只可能是 `vetoed` 或 `unqualified`，取决于当期 `roic` 是否也 <8 —— 双低触发否决4（无护城河证据），单低只过不了门禁。这是有意层级而非冗余：否决4 = “从来没达标过”，直接从池子剔除；roic 腿不达标 = “当前不够格”，仍留在观察里。因此本测试若要验证“roic_med 不达标”这一档，**样本必须构造单低**（原写法 `{ roic: 6, roic3: [5,6,7] }` 是双低，被 `kind()` 的优先级抢成 `vetoed`，该档从未被独立验证）。
>
> 另一条结构性事实：`med < 8` 时 `oy ≤ 0.2×med < 1.6` → `mos < −0.25 < 2` → 价格腿必然也不达标。所以 `tooRich` 条件里的 `roicOk` 不是装饰——它把“低 ROIC 且看着贵”归入 `unqualified` 而不是 `too_rich`（只有好公司才配叫“卖太贵”）。若实现漏掉 `roicOk`，本测试的 `roic: 9` 那条会变 `too_rich` 而捕获。

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
    // ⚠ 已知偏离 spec §4 第 3 条（“近 2 期 fcff<0”）：P-1 实测 `fcff` 只能单次取到当期一列（无两期序列），
    // 而 spec §2 的实测结论是硬约束 → 降为单期判定。方向是“多杀”不是“漏杀”（fail-loudly 侧安全），Task 10 验收时须向用户点名此偏离。
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
Expected: `ok | 9 passed | 0 failed`

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

- [ ] **Step 1: 追加失败测试（10 条）**

```ts
import { computeValue, assignGroupsV, pctWithinGroupsV, VCOV_MIN } from './value_engine.ts';

// 同组宇宙（默认 30 只 ≥20 → 走 L2 分组），各腿均有区分度。
// ⚠ roic 从 20 起算不是调参，是必改（控制方在 Task 4 执行时裁定）：原写 `roic: 5+i, roic3:[4+i,5+i,6+i]` 让尾部几只是**双低**（cur<8 且 med<8）
// → 命中否决4 → tier=vetoed → vq 恒 null → 测试 2 「hi/lo 都有 vq 且单调」与测试 7 的样本均不成立（与 Task 3 已裁的「档位样本选错」完全同型）。
// 同时 `med<8 ⟹ oy≤0.2×med<1.6 ⟹ mos<−0.25<2`，低尾根本不可能过价格腿 —— 这是宇宙构造问题，不是排序层能修的（排序层给否决行算 vq 就是绕过门禁结论）。
const uni = (over: Partial<ValueRaw> = {}, n = 30): ValueRaw[] =>
  Array.from({ length: n }, (_, i) => mk({ code: `u${i}`, ths: ['测试业', '测试Ⅱ', 'x'],
    roic: 20 + i, roic3: [19 + i, 20 + i, 21 + i], fcff: (1 + i) * 1e9, pe: 40 - i / 2, pb: 1 + i / 10, ...over }));

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
  u[0] = { ...u[0], code: 'e0', gw: null, divYield: null, divY5y: 0, pe: -8, pb: -1 };
  u[1] = { ...u[1], code: 'e1', fcff: null, divY5y: 0 };   // 现金腿只剩股息一条，且它是 0：不得被当成 NA
  const e0 = computeValue(u, 1.85).find(r => r.code === 'e0')!;
  assertEquals(e0.tier, 'vetoed');                              // PB<0 → 否决1，不许用 NA 兑过去
  assertEquals(e0.flags.includes('pe_na_nonpositive'), true);
  assertEquals(e0.flags.includes('gw_empty_as_zero'), true);
  assertEquals(e0.vCash !== null, true);                        // 股息腿以 0 参与，现金腿仍在
  const e1 = computeValue(u, 1.85).find(r => r.code === 'e1')!;
  assertEquals(e1.vCash !== null, true);                        // 不分红记 0 参与排名（P-6/§5.1）：0 被当 NA 的话这条会空
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

// ⚠ 以下三条是 Task 4 任务评审（spec+质量座位）打回后补的，逐条对应一处已被实测证实的缺陷。
// 控制方不是按推演写的期望值：把三条测试跑在未打补丁的实现上 → 3 failed（`roic 仅 2 期` 拿到 conf=A、
// `门禁过但 vcov<0.6` 拿到 tier=unqualified、金融股 h1 的 vHealth=77.429 而商誉百分位 pG=50.000）；
// 把 `tier !== 'qualified' → 早退分支` 加回去重跑 → h1 的 `confidence` 变 A、当场红（这就是 R3 此前缺失的回归护栏）。
Deno.test('roic 仅 2 期 → 必须 B（spec §6「roic 仅 1-2 期」：med 算得出来不等于三年齐备）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'r2', roic3: [15, null, 16] };
  const r2 = computeValue(u, 1.85).find(r => r.code === 'r2')!;
  assertEquals(r2.gate.roicMed, 15.5);                            // 陷阱本体：两期就够算中位数与最差年
  assertEquals([r2.vMoat, r2.vCash, r2.vSafety, r2.vHealth].every(v => v !== null), true);
  assertEquals(r2.vcov, 1);
  assertEquals(r2.flags.includes('roic_3y_incomplete'), true);
  assertEquals(r2.confidence, 'B');                               // 四维齐备、满覆盖、无否决 —— 唯一压到 B 的就是这条
});

Deno.test('门禁过但 vcov<0.6 → tier 仍是 qualified、vq=null、置信 C（tier 只表达门禁结论，覆盖度不改它）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'g0', isFin: true, roic: null, roic3: [null, null, null], pe: null, pb: null, fcff: 3e9 };
  const g0 = computeValue(u, 1.85, new Map([['g0', 20]])).find(r => r.code === 'g0')!;
  assertEquals(g0.tier, 'qualified');   // 门禁三项全过（oy=15 → mos=13.15）；旧实现拿 `vcov<VCOV_MIN` 改写成 unqualified = 排序层否决门禁结论
  assertEquals([g0.vMoat, g0.vSafety], [null, null]);              // 护城河（roic 天然 NA）+ 估值（PE/PB 双缺）整维 NA
  assertEquals(g0.vcov < VCOV_MIN, true);
  assertEquals(g0.vq, null);                                        // spec §6：vcov<0.6 不产出 VQ，只落原始指标
  assertEquals(g0.confidence, 'C');
});

Deno.test('金融股「有息负债率」腿 NA（spec §5.1 末格）+ 货币资金 NA 不得当 0 用；置信度对所有行统一判（无 tier 早退分支）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'h1', isFin: true, mktcap: null, roic: null, roic3: [null, null, null], cash: 1e10, debt: 1e9 };
  u[1] = { ...u[1], code: 'h2', mktcap: null, cash: null, debt: 1e9 };   // 非金融，仅货币资金 NA
  const pG = pctWithinGroupsV(u, s => -(s.gw ?? 0));
  const rows = computeValue(u, 1.85, new Map([['h1', 20]]));
  const h1 = rows.find(r => r.code === 'h1')!, h2 = rows.find(r => r.code === 'h2')!;
  // 两条样本的稳健维都只剩「商誉」一条有效腿 → renormV 单腿恒等 → vHealth 必须恰等于商誉百分位；
  // 债务率腿若误产分（金融股那条 / `cash ?? 0` 那条），vHealth 会被拉成 (4·pDr+3·pG)/7，绝不等于此值。
  assertEquals(Math.abs(h1.vHealth! - pG.get('h1')!) < 1e-12, true);
  assertEquals(Math.abs(h2.vHealth! - pG.get('h2')!) < 1e-12, true);
  assertEquals(h1.tier, 'unqualified');   // mktcap NA → oy NA → 门禁不过
  assertEquals(h1.flags.length, 0);       // 金融股不判 roic 三年齐备（P-1），其余腿均有效
  assertEquals(h1.vMoat, null);
  assertEquals(h1.confidence, 'B');       // 缺 1 维 → B。原计划的 `tier !== 'qualified' → 早退` 会把这种「门禁不过且无 flag」的行发 A
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts`
Expected: FAIL —— 追加实现前该文件**根本无法加载**：`ImportSpecifiers can't resolve export 'computeValue'`（TS2305），且 `deno test` 默认带类型检查 → 报的是解析错而非逐条断言失败；只有加 `--no-check` 才会看到 SyntaxError 形态。**不要期待「Task 3 的 9 条仍 PASS」这种输出**（同文件形态下不可能出现；评审坐席已确认该措辞会误导执行者）。

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
    // ⚠ 两处 NA 门控都是控制方在 Task 4 评审座位后补的（均为 spec 明文，不是调参）：
    // ① `s.isFin ? null`：spec §5.1 财务稳健行末格明写「金融股 `有息负债率` 腿 NA → renorm」——银行的资产负债口径与产业股不可比；
    // ② 要求 `s.cash !== null`：原写法 `(s.cash ?? 0)` 把「货币资金 NA」当 0 用 → 算成满杠杆，是在三种已批空值语义之外自造第四种，
    //    与同文件 netCash 腿（cash 缺 → 整腿 NA）和 Task 3 的 `investedCapital`（注释原文「任一缺 → null（不猜）」）直接矛盾。方向保守不等于正确：缺数据应该降覆盖度，不应该臆造一个百分比。
    debtRatio: pctFrom(rows, s => (s.isFin ? null
      : s.debt !== null && s.cash !== null && s.cash + s.debt > 0
      ? -s.debt / (s.cash + s.debt) : null)),
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
    // ⚠ 判据必须是「有效期个数」而不是「med 能否算出」（控制方在 Task 4 评审座位后裁定，Critical-1）：
    // `roicStats` 两期就能算出 med/min3 → 原写 `gt.roicMed === null` 只检出 ≤1 期，
    // 让「roic 仅 2 期」的行四维齐备、vcov=1、无 flag → 拿 A 级 → 直接进 spec §7.2「只从 A 级取」的分歧榜（实测：旧实现 conf=A）。
    // spec §6 B 原文是「缺 1 维度，或 `roic` 仅 1-2 期，或带任一 flag」——1-2 期包含 2 期，没有歧义。`roic3` 长度恒 3 由适配器保证（gs_value 的 q3 列族）。
    // 保留 `!s.isFin`：金融股 roic 天然 NA（P-1），护城河整维 NA 已经把它降到 B，不叠加一个假 flag。
    if (!s.isFin && s.roic3.filter(x => x !== null && Number.isFinite(x)).length < 3) flags.push('roic_3y_incomplete');
    if (s.gw === null) flags.push('gw_empty_as_zero');
    if (s.pe !== null && s.pe <= 0) flags.push('pe_na_nonpositive');
    if (s.pb !== null && s.pb <= 0) flags.push('pb_na_nonpositive');
    if (gt.rfFallback) flags.push('rf_fallback');
    // ⚠ `ic_approx` 不得进 flags（控制方在 Task 4 执行时裁定）：spec §4.1 原文只要求“近似状态记入 value_extras.ic_approx=true”，
    // 而 P-1 实测 5224 行里货币资金空 45 / 带息债务空 1 → 约 99% 的行 `icApprox=true`。一旦进 flags，
    // 「带任一 flag → B」会把几乎全市场压成 B → 本任务测试 2 的 `hi.confidence === 'A'` 与 spec §10「A 级占比 ≥40%」数学上不可达，
    // 分歧榜（spec §7 只从 A 级取）直接空榜。近似状态只走 `gate.icApprox` → Task 6 的 extras，信息不丢。
    if (gt.vetoed) flags.push(...gt.vetoReasons.map(x => `veto:${x}`));

    // tier 顺序：否决 > 门禁不过 > 太贵 > 合格。**tier 只翻译门禁层的结论，覆盖度不得改写它**（控制方在 Task 4 评审座位后裁定，Important-2）：
    // 原计划多了一行 `: vcov < VCOV_MIN ? 'unqualified' : 'qualified'`，而 spec §4 对 `unqualified` 的定义就是「门禁不过」（§4 门禁判据表），
    // §6 对 `vcov < 0.6` 的定义是「不产出 VQ（final=null）」——两者不是同一个概念。拿覆盖度把一只在门禁上真的合格的股
    // 改标「不合格」，会让 §8 前视验证没法回答「被门槛挡掉的那批后来如何」（它挡的是覆盖度，不是价值）。
    // 同时该分支与本行上方的旧注释「vcov 只决定 vq，不改 tier」直接矛盾——代码与自己的注释互斥，必须选一边：这里选注释（= spec）。
    // 信息不丢：覆盖度不足的行仍然可见（vcov 照落、四维分照落、vq=null、confidence=C），只是不再伪装成门禁结论。
    const tier: ValueRow['tier'] = gt.vetoed ? 'vetoed' : !gt.passed ? (gt.tooRich ? 'too_rich' : 'unqualified') : 'qualified';
    // spec §6：`vcov < 0.6` → 不产出 VQ。它靠 vq=null 体现，不靠改 tier。下游安全：§7.1 Top10 与 §7.2 分歧榜均要求 `confidence === 'A'`，
    // 而 `vcov < 0.6` 在置信度判据里直接落 C → 不可能有「qualified 且 A 但 vq=null」的行；前端 L1608 还额外写了 `r.vq !== null`。
    const vq = tier === 'qualified' && vcov >= VCOV_MIN ? vq0 : null;
    return { ...s, gate: gt, vq, vMoat, vCash, vSafety, vHealth,
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
    // 置信度对所有行统一判 C>B>A，**不分 tier**（控制方在 Task 4 执行时裁定，原计划的 `tier !== 'qualified' → 早退分支` 已删）：
    // ① spec §6 标题明写“照搬 V1.1 §4.7 纪律”，而 V1.1 `engine.ts:239` 对全批统一判、无 tier 概念（它的注释还写明
    //    `final===null` 的行照样算，由编排层过滤）；早退分支是本计划自创，且它自己的 else 支路也会给否决行发 A。
    // ② 不删它则 spec §6 的 C 判据“分组退化到 MARKET 且组内<20”对非 qualified 行永远不生效（那些行 indN 保持 0、从不进这条判据）。
    // 补 `|| r.gate.vetoed` 进 B 档：vetoed 归 B 不归 C（C 的三条判据里没有否决，不发明 spec 没写的降级）。
    // ⚠ 本项当前是**冗余护栏**（控制方在 Task 4 评审座位后改口，Minor-6）：上一行已把否决原因推成 `veto:${原因}` flag，
    // 而「带任一 flag → B」先命中 → 被否决行无论如何落 B。评审坐席实测：删掉本项后 7 个测试宇宙 165 行判定零差异（`changed: NONE`）。
    // 原写「不补就会蒙 A」的反事实**不成立**，已推翻；保留本项只是为了防止日后有人删掉 `veto:*` 那条 push（spec §6 A 明写「无否决」）。
    // （字段位置：否决位只存在 `ValueRow.gate.vetoed` 上，无顶层 `vetoed`；面值写 `r.vetoed` 会 TS2339。已由 Task 4 修复轮实测证实。）
    // 早退分支本身的回归护栏：新增测试「金融股『有息负债率』腿 NA…」的 `h1.confidence === 'B'` 断言——把早退分支加回去该行变 A、当场红。
    const nulls = [r.vMoat, r.vCash, r.vSafety, r.vHealth].filter(x => x === null).length;
    r.confidence = (r.grp === 'MARKET' && r.indN < 20) || nulls >= 2 || r.vcov < VCOV_MIN ? 'C'
      : nulls === 1 || r.flags.length > 0 || r.gate.vetoed ? 'B' : 'A';
  }
  return out;
}
```

> 实现注：金融股的 `roicMed` 永为 NA（P-1），其 `vMoat` 靠 `roicCur` 也 NA → **整个护城河维度 NA**，`vcov` 自然降到 0.65，不会与满腿者假装可比。这就是 spec §6 “不能与满腿者直接比大小”的落地方式，而不是靠特殊分支拉高它们。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd supabase/functions/stock-value && deno test -A value_engine_test.ts && deno check value_engine.ts`
Expected: `ok | 19 passed | 0 failed`（= Task 3 的 9 条 + 本任务 10 条）

若 `60 倍 PE` 那条 FAIL：先手算 `oy=min(fcff/市值, roic_med×IC/市值)`。基准 `IC=4e9`、`市值=2e10`、`roic_med=20` → `normY=4.0`；`fcff=3.33e8` → `cashY=1.665` → `oy=1.665`，`mos=1.665-1.85=-0.185 < 2` → `too_rich`。注意：该样本 `oy>0` 且 `roic_med=20 ≥ 8`，故不得误落 `unqualified`；若实现把它归到 `unqualified`，是 `tooRich` 条件写错（必顶 `oyPos && roicOk && !priceOk`），不是期望值错。

- [ ] **Step 5: 全量回归（含 Task 2）**

```bash
cd supabase/functions/stock-value && deno test -A .
```

Expected: `gs_value_test.ts` 10 + `value_engine_test.ts` 19 = 29 全绿

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
- Modify: `supabase/functions/stock-value/gs_value.ts`（V_Q5 加 ROE 列）、`supabase/functions/stock-value/fixtures/vq5_sample.json`、`supabase/functions/stock-value/value_engine_test.ts`（**只改 `mk()` 默认值：加 `roe: null`**，见 Step 3 的连带修改）
- Test: `supabase/functions/stock-value/rf_test.ts`、`gs_value_test.ts`（追加 1 条）

**Interfaces:**
- Consumes: `ValueRaw`（本 Task 为它新增**必填** `roe: number | null`）、`computeValue(..., finRoe)`（Task 4）
- Produces:
  - `const CN10Y_TEXT: string`、`ECONOMY_BASE: string`
  - `parseCn10y(text: string): number | null`（百分数，合法窗口 `[0.5, 5.0]`，窗外一律 null）
  - `fetchCn10yStream(apiKey: string, timeoutMs?: number): Promise<string>`（拼接 `STREAM_MESSAGE.content`）
  - `resolveCn10y(input: { override: number | null; overrideOn: string | null; fetched: number | null; today: string }): { cn10y: number | null; source: 'override' | 'auto' | 'none' }`（override 超过 45 天未更新也当失效，避免手动值腐烂成静默错价）

> **控制方裁定（Task 5 pre-flight，三条，dispatch 前写死）**
>
> 1. **`roe` 是必填 `number | null`，不是可选 `roe?:`**。价值腿的纪律是「缺列整批炸，不静默降级」（Task 3 测试注释里那条「静默路径由 Task 5 把 ROE 列加进 REQUIRED 来守」指的就是这里）。必填的代价：仓内唯一的全字段 `ValueRaw` 字面量——`value_engine_test.ts` 的 `mk()`——必须同步加 `roe: null`，否则 `deno test`（默认带类型检查）与 `deno check` 立刻 TS2741 红。连带修改**不许改动任何一条期望值**：引擎读金融股 ROE 走第三参数 `finRoe`，从不读 `r.roe`。
> 2. **`finRoe` 的唯一权威来源是本 Task 的 `ValueRaw.roe`，不是 `stock_score` 快照里的 `roe`。** 两个理由，第二个是实测级缺陷：① 价值腿宇宙是「全部沪深A股」，而 `readMainSnapshot` 只取 `in_pool=true` 的主分行 → 用主分快照喂否决4，池外金融股永远拿不到 roe，正是上面说的静默路径，届时 `REQUIRED.q5` 守的是一个没人读的字段；② `main.map` 的键是**裸 6 位代码**（`toDbRow` 用 `main.get(bare)` 取），而引擎查的是 `finRoe?.get(s.code)`，`s.code` 带 `.SH` 后缀 → 两边永不相交，照原计划写就是**对所有金融股静默免检**。Task 6 正文已按此改（`finRoe` 从本批 `rows` 构建）。
> 3. **列名 `净资产收益率roe(摊薄)` 是对 spec §4「`ROE(扣非加权)`」的偏离**，数据层理由：GS skills 批次里没有「扣非加权」这一列，候选只有 `roe(摊薄)` 与 `roe(加权,公布值)`——两者对「扣非」那一半同样不达标，于是按可绑定性取舍：`stock-score/gs.ts:211-212` 生产在绑的当期列就是 `净资产收益率roe(摊薄`（那里的注释明确警告裸前缀 `净资产收益率roe` 会被三年加权列误匹配，本计划 Task 2 的测试名也点了这个实炸过的坑），且 `REQUIRED.q5` 用全名前缀，绑不上就整批炸。否决4 是「能不能碰」的粗门禁（阈值 8%），摊薄/加权之差不足以翻档。若 Task 10 真实数据显示银行在阈值带内反复，再连同 spec 措辞一起改——**spec 文件本步不动**。

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

**连带修改（裁定 1 的代价，不做则 Step 4 全红）**：`value_engine_test.ts` 的 `mk()` 默认值末尾加 `roe: null`——

```ts
const mk = (o: Partial<ValueRaw> = {}): ValueRaw => ({
  code: '1', name: 'x', ths: ['A', 'B', 'C'], isFin: false, isST: false,
  roic: 15, roic3: [14, 15, 16], fcff: 2e9, cash: 3e9, debt: 1e9, gw: 0,
  pe: 20, pb: 2, mktcap: 2e10, divYield: 2, divY5y: 2, roe: null, ...o,   // ← 全文件只动这一处
});
```

判据：**19 条引擎测试的期望值一条都不许变**。若加了 `roe: null` 之后有引擎测试转红，那是实现写错了（最可能的错法：把 `gateOf`/`vetoesOf` 改成直接读 `r.roe`，绕开了 `finRoe` 参数），不是期望值该跟着动。

**第二处连带（控制方在 Task 5 评审座位前裁定，升格为计划明文）**：`REQUIRED.q5` 加列会把 `gs_value_test.ts` 里那张**内联合成 q5 表** `noRow`（原本只有 `股票代码`/`股息率`/`股息率平均`）顶到 `assertCols` 门上 → `merge(noRow)` 直接抛 `GS q5 missing column`。两条约束在此互斥，**取舍已定：给这张表补上 `'净资产收益率roe(摊薄)[20260630]': ['1.0']`，该测试的三条断言（行在值空→0 / 行缺席→NA / 整批缺席→NA）一字不许动**。理由：这张表要表达的是**行级**空值语义，而 `REQUIRED` 守的是**列级**存在；补列是把测试夹具对齐新契约，不是放宽守卫。**禁止的反向选项**：放宽 `REQUIRED.q5`、给 ROE 加 `?? 0` 降级、或把该测试拆掉——三者都是把刚立起来的「缺列整批炸」闸门拆回去。

- [ ] **Step 4: 跑全量回归 + 类型检查**

```bash
cd supabase/functions/stock-value && deno test -A . && deno check rf.ts gs_value.ts value_engine.ts
```

Expected: `36 passed | 0 failed`（= Task 2-4 的 29 条 + 本 Task 新增 7 条：rf 6 + gs_value 1，其中 gs_value 从 10 变 11）

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
- Test: `supabase/functions/stock-value/index_test.ts`
- Modify: `scripts/verify_deploy_bundles.ts`（`MODULES` 数组加 `"stock-value"`）

> （控制方注：原列出的 `Create: supabase/functions/stock-value/fixtures/score_sample.json` 已删——本 Task 无任何步骤给其内容、无任何代码/测试读取它（grep 零消费者），Step 1 测试用内联 `row`/`main` mock。留它是无主占位，随意编造内容反而污染 fixtures 目录。）

**Interfaces:**
- Consumes: `gsValueFetch/V_Q*/buildVQ3/yearAnchors/mergeValueTables`（Task 2）、`computeValue`（Task 4）、`fetchCn10yStream/parseCn10y/resolveCn10y`（Task 5）
- Produces（可单测的纯函数，`index.ts` 导出）:
  - `buildExtras(stamps: Record<string,string>, r: ValueRow, meta: { cn10ySource: string; icApprox: boolean; mainLegs: Record<string, number | null> | null }): Record<string, unknown>`
  - `toDbRow(r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>, stamps: Record<string,string>, cn10ySource?: string): DbRow`（`stamps` **必传**：spec §8 时点纪律要求每个字段的 GS 日期戳原样落 `extras`，P-4 已证明同一列的历史版与当期版无法共存于一次调用）
  - `type MainSnap = { final: number | null; confidence: string | null; quality: number | null; growth: number | null; value: number | null; momentum: number | null }`（后四个供分歧榜的归因句，spec §7.2；**不含 `roe`** —— 金融股 ROE 改由本批 q5 提供，Task 5 裁定 2）
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
  grp: 'L2:机械设备-工程机械', indRank: 3, indN: 40, marketRank: 12, marketN: 2200, flags: ['ic_approx'] } as any;   // ⚠ `as any`非 `as never`：Deno 2.9.7/TS6 禁展开 never（TS2698），第 54/62 行 `{...row}` 会直接中止整个 test；调用点的 `row as never` 逐字不动，5 条 assertEquals 一字未改

const STAMPS = { fin_period: '20260630', val_period: '20260930', roic_period: '20251231' };
// 显式标注 Map<string, MainSnap>：字面量直推会把 quality 等收窄为 number，与 MainSnap 的 number|null 不同变而报错
const main = new Map<string, MainSnap>([['600031',
  { final: 71.2, confidence: 'A', quality: 82, growth: 40, value: 44, momentum: 30 }]]);

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

// 四腿必须进 MainSnap：`toDbRow` 里 `mainLegs` 直接读它们（spec §7.2 归因句）；**不含 roe**，金融股 ROE 走本批 q5（Task 5 裁定 2）
// ⚠ 必须 `export`：Step 1 测试 `import type { MainSnap } from './index.ts'`（控制方在 Task 6 评审座位前修 brief 自相矛盾：Interfaces 声明导出但 Step 3 漏写 export；build.ts 的 `^export\s+type` 剔离规则会降回普通 type，deploy.ts 自包含无副作用）
export type MainSnap = { final: number | null; confidence: string | null;
  quality: number | null; growth: number | null; value: number | null; momentum: number | null };
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
    debt_ratio: !r.isFin && r.debt !== null && r.cash !== null && r.cash + r.debt > 0 ? r.debt / (r.cash + r.debt) : null,
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

// 主分快照 + 四条腿（供分歧榜归因）：只读最新批次的 in_pool 行（分歧榜本质是池内对比，无需全宇宙）
async function readMainSnapshot(url: string): Promise<{ batch: string | null; map: Map<string, MainSnap> }> {
  const b = await fetch(`${url}/rest/v1/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
  if (!b.ok) throw new Error(`read stock_score batch ${b.status}`);
  const bb = (await b.json())[0] as { batch_date: string } | undefined;
  if (!bb) throw new Error('stock_score has no batch yet — value leg must run AFTER stock-score');
  const d = await fetch(`${url}/rest/v1/stock_score?select=code,final,confidence,quality,growth,value,momentum&batch_date=eq.${bb.batch_date}&in_pool=eq.true`, { headers: svcHeaders() });
  if (!d.ok) throw new Error(`read stock_score rows ${d.status}`);
  const map = new Map<string, MainSnap>();
  for (const x of await d.json()) map.set(String(x.code), {
    final: x.final ?? null, confidence: x.confidence ?? null,
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

    // 金融股否决4 的 ROE 只认本批自己那一列（Task 5 裁定 2）；钥匙必须是 `ValueRaw.code` 原样（带后缀），与引擎内部 `finRoe?.get(s.code)` 同一把
    const finRoe = new Map<string, number>();
    for (const s of rows) if (s.roe !== null) finRoe.set(s.code, s.roe);
    const computed = computeValue(rows as ValueRaw[], resolved.cn10y, finRoe);
    const batch = now.toISOString().slice(0, 10);
    await upsert(computed.map(r => toDbRow(r, batch, poolSet, main.map, stamps, resolved.source)));

    const by = (t: string) => computed.filter(r => r.tier === t).length;
    return Response.json({ ok: true, batch_date: batch, rows: computed.length, qualified: by('qualified'),
      too_rich: by('too_rich'), vetoed: by('vetoed'), unqualified: by('unqualified'),
      a_level: computed.filter(r => r.confidence === 'A').length,
      cn10y: resolved.cn10y, cn10y_source: resolved.source, div_leg_ok: t5 !== null,
      fin_roe_rows: finRoe.size,   // 遥测（Task 6 评审 M4）：带后缀键的金融股 ROE 行数——它是唯一无单测护栏的否决4 入口，靠这个数才能「首夜看穿」
      main_batch: main.batch, stamps });
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsValueFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json({ ok: false, error: msg, kept_old_batch: true }, { status: 500 });
  }
});
}
```

> 实现注：`roic_min3`/`ic`/`net_cash_ratio`/`debt_ratio` 四列**必须真实落库**（前视复盘要用 `ic` 做投入资本近似的质量审计），上面代码已直接写出取值，并由 Step 1 的四条断言钉住。注意 `debt_ratio` 列存的是**正的有息负债率** `debt/(cash+debt)`（与 Task 4 百分位里的取负仅作排序方向，不落负数入库）；`ic` 是 spec §4.1  的近似值，`extras.ic_approx=true` 已在标记这个口径。**本行的口径与 Task 4 的 `debtRatio` 腿对齐（控制方在 Task 4 评审座位后改）：金融股 NA（§5.1 末格）、货币资金 NA 也不臆造成 0** —— 入库列与引擎腿若对同一个量给两种答案，前视复盘会被误导。测试里那行 mock 是非金融股（潍柴）且 cash/debt 均非空 → `assertEquals(db.debt_ratio, 0.2)` 的期望值不因本改动变。

> 实现注（Task 5 裁定 2 的落地，控制方在 Task 5 pre-flight 发现）：`finRoe` 的键**必须**是 `ValueRaw.code` 原样（带 `.SH`/`.SZ` 后缀）。原计划这里从 `main.map` 构建，而 `main.map` 的键是裸 6 位代码，引擎查的却是 `finRoe?.get(s.code)` —— 两边永不相交，金融股否决4 会对**所有行**静默免检（`vetoesOf` 的 `fin?.roe ?? null` 为 null → 不判定，而 `gateOf` 对金融股 `roicOk` 恒 true → 低 ROE 银行仅凭价格腿过关）。这五行在 `Deno.serve` 的 handler 里，**不在单测覆盖范围内**（Task 6 的五条测试都是 `toDbRow`/`buildExtras`）：唯一护栏是 `REQUIRED.q5`（缺列→整批炸）加上 Task 10 首夜看数——若 `qualified` 里出现 `roe<8` 的银行，即为本处回归。

- [ ] **Step 4: 写 `build.ts` 并生成 `deploy.ts`**

```ts
// supabase/functions/stock-value/build.ts —— 与 stock-score/build.ts 同构（拼接顺序：引擎→适配器→rf→index）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\.\/(value_engine|gs_value|rf)\.ts';?\s*$/gm, '')   // ⚠ 斜杠必须转义：`\./` 里的裸 `/` 会提前终止正则→ SyntaxError（与 stock-score/build.ts 同构写法）
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

Expected: 36 + 5 = 41 passed；verify-bundles 全绿

```bash
git add supabase/functions/stock-value scripts/verify_deploy_bundles.ts && \
git commit -m "feat(stock-value): orchestration, main-score snapshot, bundled deploy + verify gate"
```

---

## Task 6B: V_Q5 真响应形态回归（`gs_value.ts` 适配器修复）

> **本 Task 由控制方实探针新增（2026-10-11，Task 6 评审后收尾核查）**。它修的是 Task 2/5 交付物里三条只能从**真响应**才看得见的缺陷——Task 5 评审 parked 的 M3（「摊薄列在本批的可得性系旁证，未对本批实测」）就是这一条，控制方没有等首夜，先跑了两次只读探针。

**探针事实（`.superpowers/sdd/2026-10-11-stock-value-leg/q5_real.json` 留档，5224 行）**：`V_Q5` 真响应的列是 `股息率(股票获利率)[20211231..20251231]` 五根 + `净资产收益率roe(摊薄,公布值)[20211231..20251231]` 五根 + `股票代码` + `股票简称` + `股票市场类型`，**键序是乱的**（ROE 族实际顺序 2023,2024,2021,2022,2025），而 `近5年股息率平均值` 这个词 GS **根本不回列**。三条后果（`probe_q5c.ts` 离线复现，全部机器证实）：
>
> 1. **每晚整批零产出**（最严重）。`REQUIRED.q5` 写的是 `净资产收益率roe(摊薄)`（带右括号），真列标签是 `净资产收益率roe(摊薄,公布值)`——`摊薄` 之后是 `,` 不是 `)`，`colByPrefix` 的全等与前缀两条通道都不收 → `colByPrefix(t5, '净资产收益率roe(摊薄)') = undefined` → `mergeValueTables` 抛 `GS q5 missing column: 净资产收益率roe(摊薄)`。`index.ts` 的 try/catch 只包住 q5 的 **fetch**，`assertCols` 发生在 **merge** 里，所以它不是「该腿置 NA」而是**杀整夜**（零行落库）。绑定期用的 `roeK`（`gs_value.ts:155`）反而截在 `摊薄`、不带右括号——守卫与绑定两处口径不一致才是根因。
> 2. **绑定到最旧一期**。`colByPrefix` 在 5 根**等长**标签里按字典序取最小 → `股息率(股票获利率)[20211231]`、`roe(摊薄,公布值)[20211231]`。于是 `div_yield` 落 2021 年的值、否决4 用 2021 年的 ROE 判今夜的护城河。实测足以翻档：平安银行 2025 年报 ROE **7.7348 < 8 应否决**，2021 年 10.29 放行——方向是**漏杀**（spec §4 最不该漏的那一侧）。
> 3. **五年股息率腿全宇宙 NA**。`colAnyOf` 找不到任何平均值候选 → `K.dy5 = null` → `divY5y` 对 5224 行一律 null → `value_engine.ts:159` 的 `div5` 百分位腿整维缺席，`vcov`/`confidence` 被无声改写。
>
> fixture 之所以完全没暴露这三条：`vq5_sample.json` 是**手工单列形态**（`股息率[20251231]` / `股息率平均[20211231-20251231]` / `roe(摊薄)[20260630]`），与真响应的列族形态无关。vq1/vq2/vq4 的 fixture 都是单列形态且与真响应同形（本探针未覆查它们，因 q1/q2/q4 走 `assertPeriod` 的「同批共用一个戳」守卫，多列会当场炸——静默错绑不可能）。

**Files:**
- Modify: `supabase/functions/stock-value/gs_value.ts`（`REQUIRED.q5` + 新导出 `annualCols` + `mergeValueTables` 的 q5 绑定与 `stamps`）
- Modify: `supabase/functions/stock-value/fixtures/vq5_sample.json`（**换成真响应形态**）
- Create: `supabase/functions/stock-value/fixtures/vq5_legacy_sample.json`（旧的手工单列形态原样改名保留）
- Modify: `supabase/functions/stock-value/gs_value_test.ts`（追加 6 条；既有 11 条的**期望值一字不动**）
- Modify: `supabase/functions/stock-value/deploy.ts`（**由 build.ts 重生成，不可手改**）

**冻结面（本 Task 一个字节都不许改）**: `value_engine.ts` / `rf.ts` / `index.ts` / `index_test.ts` / `value_engine_test.ts` / `rf_test.ts` / `scripts/migrate_stock_value.sql`。**`V_Q5` 的查询措辞也不改**——去掉 `近5年股息率平均值` 有可能让 GS 改回单列或不再回窗口列族，属未探明的赌注；新绑定对「五根年报列」与「一根当期列」两种形态都容忍。

**Interfaces:**
- Produces: `mergeValueTables` 签名不变；返回的 `stamps` 多两个**可选**键 `div_period` / `roe_period`（q5 两族所绑的期次戳）。`index.ts` 的 `buildExtras` 原样透传 `stamps`、run 响应也已带 `stamps` → **无需改 index.ts**，Task 6 评审点名的 out-of-scope 缺口（spec §8 对 q3/q5 只做到「部分可推」）就此闭合，且首夜能直接从响应读到绑定的是哪一期。
- 新导出 `annualCols(t: GsTable, labelPrefix: string): string[]`（按标签前缀取「单期」列族、排除平均值列与区间戳列、按戳升序）。

- [ ] **Step 1: 用真响应生成 shape-real fixture（纯机械，不许手填数值）**

先把旧 fixture 原样改名（它是 Step 2 那 11 条既有测试的依赖，删了就等于放宽回归面）：

```bash
cd "/Users/alick/Documents/GitHub/fund invest"
cp supabase/functions/stock-value/fixtures/vq5_sample.json \
  supabase/functions/stock-value/fixtures/vq5_legacy_sample.json
```

再用下面的脚本从留档的真响应里切出三行，**键序与值一律原样保留**（键序本身就是这条回归的证据，字典序化会把它洗掉）：

```ts
// .superpowers/sdd/2026-10-11-stock-value-leg/mk_fixture.ts —— 跑完即弃，不进仓
const REAL = '.superpowers/sdd/2026-10-11-stock-value-leg/q5_real.json';
type T = Record<string, (string | number | null)[]>;
const t = JSON.parse(await Deno.readTextFile(REAL)) as T;
const codes = t['股票代码'] as string[];
const want = ['600031.SH', '000001.SZ', '600036.SH'].map(c => codes.indexOf(c));
if (want.some(i => i < 0)) throw new Error('code missing in real response');
const out: T = {};
for (const k of Object.keys(t)) out[k] = want.map(i => t[k][i]);   // 保持 t 的原始键序
await Deno.writeTextFile('supabase/functions/stock-value/fixtures/vq5_sample.json', JSON.stringify(out));
console.log('COLS', Object.keys(out).length, 'ROWS', out['股票代码'].length);
```

Run: `deno run -A .superpowers/sdd/2026-10-11-stock-value-leg/mk_fixture.ts`
Expected: `COLS 13 ROWS 3`。三行的真值（脚本会原样写入，此处列出供 Step 2 写期望值）：

| code | 股息率 2021→2025 | roe(摊薄,公布值) 2021→2025 |
|---|---|---|
| 600031.SH | 1.97368421 / 1.01265823 / 1.597676 / 2.184466 / 2.318977 | 18.8934 / 6.577 / 6.6542 / 8.3046 / 9.5188 |
| 000001.SZ | 1.38349515 / 2.1656535 / 7.657082 / 5.196581 / 5.223488 | 10.29 / 10.4712 / 9.8353 / 8.9944 / 7.7348 |
| 600036.SH | 3.12461507 / 4.66451959 / 7.088425 / 5.089058 / 4.788598 | 13.9648 / 14.5967 / 13.62 / 12.1035 / 11.7986 |

- [ ] **Step 2: 先写 6 条失败测试（`gs_value_test.ts` 尾部追加）**

既有 11 条测试**只动一处**：第 12 行的默认 t5 指向改名后的 legacy fixture，其余连期望值一起不动（它们钉的是「行缺席 vs 值空」的空值语义，与形态无关）：

```ts
const merge = (t5: GsTable | null = fx('vq5_legacy_sample.json'), t3: GsTable = fx('vq3_sample.json')) =>   // ← 原为 vq5_sample.json
  mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), t3, fx('vq4_sample.json'), t5, NOW);
const mergeReal = () => mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'),
  fx('vq4_sample.json'), fx('vq5_sample.json'), NOW);
```

追加的 6 条（`annualCols` 需从 `./gs_value.ts` 一并 import）：

```ts
Deno.test('V_Q5 真形态整批不炸（REQUIRED.q5 必须绑得住 `roe(摊薄,公布值)`）', () => {
  // 真响应的 ROE 标签是 `净资产收益率roe(摊薄,公布值)`：守卫前缀若带右括号，merge 直接抛 GS q5 missing column
  assertEquals(mergeReal().rows.length, 3);
});

Deno.test('股息率/ROE 绑最新年报，不是字典序最小的最旧一期', () => {
  const r = mergeReal().rows.find(x => x.code === '600031.SH')!;
  assertEquals(r.divYield, 2.318977);      // 2025 年报；旧绑定给 2021 年的 1.97368421
  assertEquals(r.roe, 9.5188);             // 2025 年报；旧绑定给 2021 年的 18.8934
});

Deno.test('GS 不回平均值列时，近5年股息率由五根年报列派生（空=0，戳升序求和）', () => {
  const r = mergeReal().rows.find(x => x.code === '600031.SH')!;
  // 期望值写成与实现同序的左结合表达式，避免浮点加法次序造成不等
  assertEquals(r.divY5y, (1.97368421 + 1.01265823 + 1.597676 + 2.184466 + 2.318977) / 5);
});

Deno.test('否决4 的档位敏感行：平安银行最新年报 ROE 7.7348 < 8（旧绑定 10.29 会漏杀）', () => {
  assertEquals(mergeReal().rows.find(x => x.code === '000001.SZ')!.roe, 7.7348);
});

Deno.test('annualCols：排除平均值列与区间戳列，按戳升序；单列形态同样命中', () => {
  const win = { '股息率(股票获利率)[20241231]': ['4'], '股息率(股票获利率)[20211231]': ['1'],
    '股息率平均[20211231-20251231]': ['2'], '股息率(股票获利率)[20251231]': ['5'], '股票代码': ['1'] } as GsTable;
  assertEquals(annualCols(win, '股息率'), ['股息率(股票获利率)[20211231]', '股息率(股票获利率)[20241231]', '股息率(股票获利率)[20251231]']);
  assertEquals(annualCols(fx('vq5_legacy_sample.json'), '股息率'), ['股息率[20251231]']);   // 单列老形态
  assertEquals(annualCols({ '股息率[20211231-20251231]': ['1'] } as GsTable, '股息率'), []);  // 只有区间戳 → 不入族
});

Deno.test('GS 若恢复专用平均值列则优先采用；stamps 带 q5 期次（spec §8）', () => {
  assertEquals(mergeReal().stamps.div_period, '20251231');
  assertEquals(mergeReal().stamps.roe_period, '20251231');
  assertEquals(merge().stamps.div_period, '20251231');      // legacy 单列形态同样有戳
  // 专用列优先：真响应不回，但形态若改回来，绝不静默改用派生均值
  const t5 = { '股票代码': ['600031.SH'], '股息率平均[20211231-20251231]': ['2.8'],
    '股息率(股票获利率)[20251231]': ['2.318977'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9.5188'] } as GsTable;
  const rows = mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'),
    fx('vq4_sample.json'), t5, NOW).rows;
  assertEquals(rows.find(x => x.code === '600031.SH')!.divY5y, 2.8);
});
```

Run: `cd supabase/functions/stock-value && deno test -A gs_value_test.ts`
Expected: **FAIL**——`TS2305 Module ... has no exported member 'annualCols'`（Step 3 前它不存在）+ 前 4 条运行时抛 `GS q5 missing column: 净资产收益率roe(摊薄)`。红灯必须两类都出现：只红在 `annualCols` 上说明守卫没被复现。

- [ ] **Step 3: 实现四处改动（`gs_value.ts`）**

3a — `REQUIRED.q5` 的守卫前缀与绑定口径对齐（截在 `摊薄`，不带右括号）：

```ts
  // 2026-10-11 真响应铁证：列名是 `净资产收益率roe(摊薄,公布值)[yyyyMMdd]`。守卫前缀必须截在 `摊薄`、
  // 不带右括号，否则 colByPrefix 两条通道都不收 → 整夜零产出（Task 6B 的杀手回归）。`股息率` 裸前缀仍安全：
  // 兄弟列 `股息率平均` 的下一字是中文 → 被下面的“中文后缀拒绝”规则挡掉。
  q5: ['股票代码', '股息率', '净资产收益率roe(摊薄'],
```

3b — `windowCols` 之后新增导出函数（`labelOf` / `stampOf` 复用模块内既有定义）：

```ts
// 同一指标的「单期年报列族」：按标签前缀取，排除平均值专用列（标签含 `平均`）与区间戳列（`[a-b]`），
// 按戳升序 = 时间升序。真响应的键序是乱的，字典序取首个会绑到最旧一期（见 Task 6B 探针注）。
export function annualCols(t: GsTable, labelPrefix: string): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length));
    })
    .sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : 0));
}
```

3c — `mergeValueTables` 里删掉 `K.dy` / `K.dy5` 两行（改由列族绑定），并把 `roeK` 那一行替换为列族绑定：

```ts
  // 股息率 / ROE 在真响应里都是年报列族（5 根，键序乱）→ 按戳取最新一期；单列老形态同样命中（族里只有一根）。
  const dyKeys = t5 ? annualCols(t5, '股息率') : [];
  const roeKeys = t5 ? annualCols(t5, '净资产收益率roe(摊薄') : [];
  const dyCur = dyKeys.length > 0 ? dyKeys[dyKeys.length - 1] : null;
  const roeCur = roeKeys.length > 0 ? roeKeys[roeKeys.length - 1] : null;
  const dy5Col = colAnyOf(t5, ['股息率平均', '近5年股息率平均值', '近5年股息率']);   // GS 若回专用列优先用（2026-10 实测不回）
  const dy5Keys = dyKeys.slice(-5);   // 最新期起最多 5 根年报列
```

行内三字段改为（空值语义②「批次缺席 / 行缺席 → NA，该批成功且行在而值空 → 0」必须原样保住，派生均值里空值同样按 0 计——与「近 5 年平均」的除数语义一致）：

```ts
      divYield: !t5 || dyCur === null || j5 < 0 ? null : num(t5[dyCur]?.[j5]) ?? 0,
      divY5y: !t5 || j5 < 0 || (dy5Col === null && dy5Keys.length === 0) ? null
        : dy5Col !== null ? num(t5[dy5Col]?.[j5]) ?? 0
          : dy5Keys.reduce((a, k) => a + (num(t5[k]?.[j5]) ?? 0), 0) / dy5Keys.length,
      roe: !t5 || roeCur === null ? null : at(t5, roeCur, j5),
```

3d — 返回值加 q5 期次戳（`index.ts` 与 `ValueRaw` 都不用改）：

```ts
  const stamps: Record<string, string> = { fin_period: stamp2, val_period: stampOf(K.pe), roic_period: stamp1 };
  if (dyCur) stamps.div_period = stampOf(dyCur);   // spec §8：q5 绑的是哪一期必须可见
  if (roeCur) stamps.roe_period = stampOf(roeCur); // 首夜若它不是 1231 结尾，ROE 就是非年化累计值 → 否决4 需重新裁定
  return { rows, stamps };
```

3e — **（Task 6B 评审 Imp-B 的回修，控制方当场裁定）`annualCols` 同戳并列时必须决定性破平局**。3b 的比较器在两根**同戳不同别名**列（如 `roe(摊薄,公布值)[20251231]` 与 `roe(摊薄,扣非)[20251231]`）上返回 0 → `Array.prototype.sort` 保持插入序，而 GS 的插入序本就不确定 → 最新一期取 `dyCur`/`roeCur` 会随快照飘。把比较器补上二级键（标签字典序）：

```ts
    .sort((a, b) => {
      if (stampOf(a) !== stampOf(b)) return stampOf(a) < stampOf(b) ? -1 : 1;
      return labelOf(a) < labelOf(b) ? -1 : labelOf(a) > labelOf(b) ? 1 : 0;   // 同戳多别名 → 按标签破平局，绝不依赖响应插入序
    });
```

并在 Step 2 的 6 条之外**再加两条**（本 Task 的测试总数因此为 8 条，目录判据从 47 改为 **49**）：

```ts
Deno.test('annualCols：同戳多别名按标签破平局，与响应插入序无关（Task 6B 评审 Imp-B）', () => {
  const a = { '股票代码': ['1'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9'], '净资产收益率roe(摊薄,扣非)[20251231]': ['7'] } as GsTable;
  const b = { '净资产收益率roe(摊薄,扣非)[20251231]': ['7'], '净资产收益率roe(摊薄,公布值)[20251231]': ['9'], '股票代码': ['1'] } as GsTable;
  assertEquals(annualCols(a, '净资产收益率roe(摊薄'), annualCols(b, '净资产收益率roe(摊薄'));
  assertEquals(annualCols(a, '净资产收益率roe(摊薄')[0], '净资产收益率roe(摊薄,公布值)[20251231]');   // 标签字典序在前
});

Deno.test('REQUIRED.q5：缺 ROE 族→整批炸（就是差点上线的那条静默路径的反面）', () => {
  const t5 = { '股票代码': ['1'], '股息率(股票获利率)[20251231]': ['2'] } as GsTable;
  const m = thrownMessage(() => mergeValueTables(fx('vq1_sample.json'), fx('vq2_sample.json'), fx('vq3_sample.json'), fx('vq4_sample.json'), t5, NOW));
  assertMatch(m, /missing column: 净资产收益率roe/);
});
```

（`thrownMessage` 是 `gs_value_test.ts` 里既有的小工具——std@0.224.0 的 `assertThrows` 无 RegExp 重载，Task 2 就定了这个写法。）

- [ ] **Step 4: 全量回归**

Run: `cd supabase/functions/stock-value && deno test -A . && deno check gs_value.ts index.ts`
Expected: **49 passed**（19 gs_value + 5 index + 6 rf + 19 value_engine）、零诊断。既有的 11 条 gs_value 测试与 19 条引擎测试**期望值一条都不许变**；若有条目转红，是实现改错了语义（最可能：把「行缺席」也归 0，或让区间戳列进了族），不是测试该放宽。

- [ ] **Step 5: 重生成 deploy.ts + 一致性门禁**

```bash
cd "/Users/alick/Documents/GitHub/fund invest/supabase/functions/stock-value" && deno run --allow-read --allow-write build.ts
cd "/Users/alick/Documents/GitHub/fund invest" && deno task verify-bundles
```

Expected: 5 模块全绿（stock-value 字节数会因 `annualCols` 增加而变化，只要「逐字节一致」即通过）。

- [ ] **Step 6: 提交（⚠ commit 需用户明示）**

```bash
git add supabase/functions/stock-value && \
git commit -m "fix(stock-value): bind V_Q5 by latest annual column, guard ROE alias column, derive 5y dividend"
```

---

## Task 7: 前端接入——拉取、价值胶囊、价值 Top10

**Files:**
- Modify: `index.html`（状态位约 L536 `scoreState` 旁；读取函数插在 `loadStockScores` 后约 L716；PURE 块插在 `// ==== RESEARCH_PURE_BEGIN ====`（L778）之前；渲染接入用 grep 定位）
- Create: `scripts/value_leg_logic.ts`（门面）、`scripts/value_leg_logic_test.ts`

> **文件面裁定（控制方 pre-flight，2026-10-11）**：只改仓库根的 `index.html`。`site/index.html` **未被 git 跟踪**（`git ls-files site/` 返回 0，`git status` 显示 `?? site/`），它是 Vercel/Pages 的部署副本，由 Task 10 Step 9 的既有链 `cp index.html site/index.html` 同步。本轮**不做双写**（双写会造出第二份实现体，正是门面要消除的东西）；此刻两端字节相同只是上次部署的残留，Task 10 之前出现差异是预期状态。

**锚点实测定位（控制方 pre-flight 用 grep 在现行 index.html（3079 行）上量得；实现时仍须自行 grep 复核——行数会随插入漂移）**：页面只有一个主 `<script>`（L475–L3076），`escapeHtml` 是其中的函数声明（L2421）→ 提升后 PURE 块运行时可用（门面单测靠 SHIM）。状态位 `scoreState`/`scoreTried` = L536/L537；调用点 `loadStockScores().then(()=>render())` = L693；`loadStockScores` 函数体 = L699–L716（新函数插 L716 之后）；`RESEARCH_PURE_BEGIN`/`_END` = L778/L851（新块插 L778 之前）；渲染接入三点 = L2243（`renderScoreTop10()`）、L2271（`${scorePillHtml(s)}`）、L2303（`${scoreDetailHtml(s)}`）。已核：本 Task 引入的 9 个新标识符在现行 index.html 中出现次数均为 0（无重复声明）；复用的 CSS 类（`score-pill(-warn)`、`score-bar`、`score-detail`、`score-warn`、`score-card-title`、`score-card-note`、`score-row`、`signal-strip`、`signal-pill pill-normal`、`fund-card`）均已存在；`stock_value.code` 存的是 bare 6 位（`index.ts:34` `r.code.split('.')[0]`），rows Map 键与 `stocks[].code` 同形，无需再剥后缀；`.order('vq')` 的 `vq` 是真列（迁移里有，且建了 `(batch_date, vq desc)` 索引）。

**Interfaces:**
- Consumes: `stock_value` 表（Task 1/6）、`escapeHtml`（index.html 已有）、`scoreState`（已有，取主分做对照）
- Produces（`VALUE_PURE` 块内导出，供门面消费）:
  - `VALUE_TABLE` 常量、`valueFmtPct(v, digits?): string`（null → `'NA'`）
  - `valuePillHtml(row): string` → **终态见终审修复单 F-2/F-3**（本行原样写的是 I-2/I-3 之前的错形态）：先判否决——`tier==='vetoed'`（引擎不变式保证此时 `vq=null`）渲染 `价值 硬否决 ⛔` + `score-pill-warn`；有分行渲染 `价值 78.4 池内 P94`，分位取 **`pool_rank / pool_n`**（`market_rank/market_n` 是全市场分母，标成「池内」是错名）；其它 `vq=null` 行 → 空串
  - `valueGateHtml(row): string` → 展开区的四维度横条 + owner_yield 明细 + 门禁判定过程
  - `renderValueTop10(state): string`（`state=null` → 空串；**未生成时的降级文案在调用点由 `valueTried` 判定**，纯逻辑块不读全局，否则门面无法单测）、`valueTierLabel(tier): string`
  - `valueState`（全局）：`{ batch, rows: Map<bareCode,row>, top10: row[] } | null`；`valueTried: boolean`

- [ ] **Step 1: 写门面（抽取唯一实现体，绝不复制第二份）**

```ts
// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/;
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
  assertEquals(valueFmtPct(-0.187, 2), '-0.19%');
  // 控制方 pre-flight 实证（计划原文这里写的是 '-0.19%'，与实现体矛盾）：toFixed 的二进制舍入不是“四舍五入进位”，
  // -0.185 实际存成 0.18499… → '-0.18%'。展示层沿用页面既有 toFixed 口径（scorePillHtml 也是 toFixed(1)），
  // 不为价值腿另造舍入函数；这条断言是把它钉成文档。
  assertEquals(valueFmtPct(-0.185, 2), '-0.18%');
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
  if(!row) return '';
  if(row.tier === 'vetoed' || row.vetoed) return '<span class="score-pill score-pill-warn">价值 硬否决 ⛔</span>';
  if(row.vq===null || row.vq===undefined) return '';
  const pctPos = (row.pool_n && row.pool_rank) ? ' 池内 P' + Math.max(1, Math.round(100 - row.pool_rank/row.pool_n*100)) : '';
  return '<span class="score-pill">价值 '+Number(row.vq).toFixed(1)+pctPos+'</span>';
}
// ↑ 终审 I-2/I-3 后的终态（原三行形态见本计划「终审修复单」F-2/F-3，交付以修复单为准）：
//   否决必须排在「有无分」之前——引擎 `vq = tier==='qualified' && vcov>=VCOV_MIN ? vq0 : null` 使否决行 vq 必为 null，
//   旧顺序让硬否决胶囊整颗消失；分位改用池内 pool_rank/pool_n，不再拿全市场分母冒充「池内 P」。
function valueGateHtml(row){
  if(!row) return '';
  const bar = (v,l)=>'<div class="score-bar"><span>'+l+'</span><i style="--w:'+Math.max(0,Math.min(100, v==null?0:Number(v)))+'%"></i><em>'+(v==null?'NA':Number(v).toFixed(0))+'</em></div>';
  const veto = (row.veto_reasons||[]).length ? '<div class="score-warn">⛔ 硬否决：'+escapeHtml(row.veto_reasons.join('、'))+'</div>' : '';
  const mos = row.margin_of_safety===null||row.margin_of_safety===undefined
    ? (row.rf_fallback ? '无风险利率口径缺失 → 改用绝对下限（rf_fallback）' : 'NA')
    : valueFmtPct(row.margin_of_safety, 2)+'（owner yield '+valueFmtPct(row.owner_yield)+' − 十年国债 '+valueFmtPct(row.cn10y, 2)+'）';
  return '<div class="score-detail">'+bar(row.v_moat,'资本回报护城河')+bar(row.v_cash,'现金回报')
    +bar(row.v_safety,'安全边际')+bar(row.v_health,'财务稳健')
    +'<div>门禁：'+escapeHtml(valueTierLabel(row.tier))+' · ROIC 中位 '+valueFmtPct(row.roic_med)+' · 安全边际 '+mos+'</div>'
    +veto+'<div style="color:var(--muted)">价值分回答“值不值”，不等于买卖指令；与评分分不可互相替代。</div></div>';
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

> **Step 0（Task 7 评审结转的两条 Minor + 一条覆盖面缺口，先做再碰新功能）**：
> 1. `renderValueTop10`（index.html）的过滤只挡了 `r.vq!==null`，没挡 `undefined`；而 `valuePillHtml` 两个都挡。`undefined` 进 `Number(undefined).toFixed(1)` 会渲染成 `NaN分`。改为同时挡两者。
> 2. 补两条门面测试（接在现有 6 条之后，不开新的块）：
>    - `valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: false })` 必须含字面 `NA`，且**不得**含 `无风险利率口径缺失`（今天只有 rf_fallback=true 那一支被测到）。
>    - `valueGateHtml({ ...row, veto_reasons: ['gw_high','roe_low'] })` 必须含 `⛔ 硬否决` 与 `gw_high`、`roe_low`（否决串是这张卡最该被人看见的部分，现在只在测试数据里出现过，没进过断言）。
> 3. 测后基线：`deno test -A scripts/value_leg_logic_test.ts` = **8 passed**（6+2），`deno test -A scripts/` = **89 passed**。Step 0 的两条是对**已有行为**的表征测试（characterization），它们一写就是绿的——不要为了让它们先红而去改实现体；红只能来自 Step 1 的六条。本 Task 全部做完后：14 passed / scripts/ **95 passed**（87 + Step 0 两条 + Step 1 六条；此处控制方原写 97 是算术笔误，实现轮里发现并坚持了真实数字）。

**Files:**
- Modify: `index.html`（`VALUE_PURE` 块内追加函数；分歧榜卡插在 `renderValueTop10` 调用点之后）
- Modify: `scripts/value_leg_logic.ts`（`EXPORT_NAMES` 追加四个名字：`SWAP_GAP`/`divergeLists`/`swapSuggest`/`renderDivergeBoard`）
- Test: `scripts/value_leg_logic_test.ts`（追加 6 条）

> **两个控制方裁定（pre-flight 已离线机械验证：把 Step 1+Step 2 代码接到 Task 7 真交付物上跑 → 12 passed）**：
> - **门面导出风格**：Step 2 正文里「照 `research_render_logic.ts` 的 `fn()`/`val<T>()` 写法」作废——本文件的 Task 7 交付物用的是 `NS.X as …` 直接 cast，**新四个沿用同一风格**（同一文件里引两套范式是负资产；控制方已用该写法跑绿）。
> - **换仓行不得穿买入信号的衣服**：Step 3 模板原写 `class="trade-banner buy"`，`.buy` 在 CSS 里就是「建议加仓/多投」那面翡翠绿旗（index.html:125），而 spec §7.3 定死此行「仅展示、不构成指令」。改用**不带修饰的 `class="trade-banner"`**（`.trade-banner` 自身有 `border:1.5px solid`，颜色走 currentColor，视觉上与真信号横幅区分）。文案一字不改。
> - **数据前提（不是缺陷）**：`extras.main_legs` 与 `main_final` 来自 `index.ts:23/52` 的主分快照，而它只拉 `stock_score` 里 `in_pool=eq.true` 的行（`index.ts:82`）——所以**不在精选池的持仓股 `main_final` 必为 null**，进不了分歧榜。这与 spec §7.2「无主分快照就无从谈分歧」的口径一致；归因句的 `主分四条腿未快照` 分支负责它的显示。

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

Run: `deno test -A scripts/value_leg_logic_test.ts`
Expected RED 的真实形态（控制方 pre-flight 实测）：**整个测试文件加载失败、0 passed**——因为 Deno 默认做类型检查，`import { divergeLists, … }` 引了一个门面尚未导出的名字会直接 TS2305，而就算跳过类型检查，门面的 `load()` 也会在 `EXPORT_NAMES` 含未实现名字时抛「VALUE_PURE 块缺少导出」。计划原文写的「新增 6 条 FAIL、旧 6 条仍 PASS」不成立，不要为了凑出那个形态去改断言。红意即对：新名字不存在。

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

并在 `scripts/value_leg_logic.ts` 的 `EXPORT_NAMES` 追加 `"SWAP_GAP", "divergeLists", "swapSuggest", "renderDivergeBoard"`，并按本文件已有的 `NS.X as …` 直接 cast 风格补四条导出（控制方裁定：不引入 `fn()`/`val<T>()` 第二套风格）。参考形态：

```ts
export const SWAP_GAP = NS.SWAP_GAP as number;
export const divergeLists = NS.divergeLists as (rows: Record<string, unknown>[]) => { wronged: Record<string, unknown>[]; rich: Record<string, unknown>[] };
export const swapSuggest = NS.swapSuggest as (row: Record<string, unknown> | null, poolRows: Record<string, unknown>[]) => { target: Record<string, unknown>; gap: number } | null;
export const renderDivergeBoard = NS.renderDivergeBoard as (state: { batch: string; rows: Map<string, Record<string, unknown>> } | null) => string;
```

- [ ] **Step 3: 在股票卡展开区接上换仓提示行（仅持仓卡可见）**

接入点就在 **Task 7 刚插的那行 `${valueGateHtml(...)}` 之后**（它属于 `stockFormHtml(s)` 的模板串内部）。但上面三行 `const` 不能写在模板里：先把函数体改成“先算后 return”的形状。
现行形态（grep 定位，实测 L2367 附近）：

```js
function stockFormHtml(s){
  return `
    ${scoreDetailHtml(s)}
    ${valueGateHtml(valueState ? valueState.rows.get(String(s.code||'').trim()) : null)}
    ${researchReportHtml(fundamentals.get(String(s.code)) || null)}
```

目标形态（只动三行，`researchReportHtml` 及以下一字不改；`swapLineHtml` 写在 `return` 之前）：

```js
function stockFormHtml(s){
  // 换仓参考（spec §7.3）：持仓集合在前端、后端无推，所以这里现算；vRowForSwap 为空就是无建议
  const heldPoolRows = valueState ? [...valueState.rows.values()] : [];
  const vRowForSwap = valueState ? valueState.rows.get(String(s.code||'').trim()) : null;
  const swap = swapSuggest(vRowForSwap, heldPoolRows);
  const swapLineHtml = swap
    ? `<div class="trade-banner">🔄 换仓参考：${escapeHtml(swap.target.name || swap.target.code)} 的安全边际高 ${swap.gap.toFixed(1)}pp（≥${SWAP_GAP}pp）——需覆盖换手成本与税负，否则维持持有；仅展示，不构成指令</div>`
    : '';
  return `
    ${scoreDetailHtml(s)}
    ${valueGateHtml(valueState ? valueState.rows.get(String(s.code||'').trim()) : null)}
    ${swapLineHtml}
    ${researchReportHtml(fundamentals.get(String(s.code)) || null)}
```

控方两条硬要求（pre-flight 裁定，评审席会按此判定）：
- 类名用**不带修饰的 `trade-banner`**（不是 `trade-banner buy`，理由见本 Task 头部裁定条）。
- `swap.target.name || swap.target.code` **必须过 `escapeHtml`**（它来自 GS 回的 `股票简称`，与本块其余名称字段同一纪律；上面目标形态已如此写）。另：`swapSuggest(null, …)` 必须返回 null（实现体第一行已挡）——不要把空行当持仓行处。

文案必须包含“需覆盖换手成本与税负，否则维持持有”与“仅展示，不构成指令”两句（spec §7.3 的固定包含项与护栏）。

- [ ] **Step 4: 把分歧榜卡接到页面上（renderValueTop10 插入点之后）**

```js
// Task 7 在 renderStockSection 里插的价值 Top10 语句之后，同一口径的降级（纯函数不读全局）：
list.insertAdjacentHTML('beforeend', valueState ? renderDivergeBoard(valueState)
  : (valueTried ? '<div class="signal-strip"><span class="signal-pill pill-normal">分歧榜待价值批次生成后出现</span></div>' : ''));
```

它必须落在价值 Top10 **之后**、`sectorOvJump` 那两行之前（grep `renderValueTop10(valueState)` 定位）；与价值 Top10 共用同一个 `valueState/valueTried` 降级判据，不开第三个全局量。

- [ ] **Step 5: 跑测试 + 语法自检**

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

Expected: `14 passed`（Step 0 的 8 + Step 1 的 6）；`SYNTAX_OK`；计数 2；`deno test -A scripts/` = **95 passed**（87 + Step 0 两条 + Step 1 六条；= 逐文件 10+13+8+50+14）；主 `<script>` 字节数会变，只要 `node --check` 过。

- [ ] **Step 6: Commit（⚠ 需用户明示；只动 index.html 与那两个 scripts/ 文件，绝不 `git add -A`）**

```bash
git add index.html scripts/value_leg_logic.ts scripts/value_leg_logic_test.ts && \
git commit -m "feat(dashboard): divergence board and swap-suggest line (client-side, display only)"
```

---

### Task 8 修复轮 1（控制方裁定：评审 Important + 控制方实测升级的一条 Minor）

**背景**：评审席判 Task 8 Needs fixes，唯一 Important 是 **spec §7.3 原文要求换仓目标 X 必须是「未持有的合格标的」**（spec L124 逐字），而 Step 2/Step 3 的代码只排除了 `x.code === row.code`，从参照过 `stocks`（前端是唯一知道持仓的地方）——后果：持仓 Y 的卡上可以建议“换仓”到用户**已经持有**的另一只股。本缺陷系 brief 逐字继承，属计划缺陷，不是实现者的。**控制方裁定：修代码，不改 spec**（spec 是权威）。

同时控制方实测升级评审席的一条 Minor：`gap >= SWAP_GAP` 的浮点边界不是“近于零的理论风险”——在一位小数的所有 (a,b) 组合里，**真实差恰为 5.0 的 150 组中有 18 组算出来是 `4.999999999999999`**（如 `8.2-3.2`、`8.7-3.7`、`9.2-4.2`），会被直接丢掉。`SWAP_GAP` 是前视验证的冻结受试对象，边界不容二进制幸运决定（同一个判据今晚亮明晚不亮，污染的就是要比对的前视样本）。而 spec §10 本身要求“5pp 换仓门槛边界”必须有单测。**两条一起修。**

**Fix-1｜`swapSuggest` 新增第三参 `heldCodes`（index.html 块内）**：签名变 `swapSuggest(row, poolRows, heldCodes)`；在现有 `if (!x || x.code === row.code || x.tier !== 'qualified' || x.confidence !== 'A') continue;` 那一行后面追加一条排除：

```js
    if (heldCodes && heldCodes.indexOf(String(x.code)) >= 0) continue;   // spec §7.3：目标必须“未持有”（持仓集合只有前端知道）
```

兼容旧调用（`heldCodes` 省略时不排除）是故意的小而安形：**不**给默认值，不给它就不排——新调用点必须传。

**Fix-2｜边界带容差**：`if (gap >= SWAP_GAP && (!best || gap > best.gap))` 改为：

```js
    if (gap >= SWAP_GAP - 1e-9 && (!best || gap > best.gap)) best = { target: x, gap: gap };
```

（`gap` 字段保留原值写入 `best`，不做四舍五入“救回”；展示层 `toFixed(1)` 仍显示 5.0。）

**Fix-3｜调用点（`stockFormHtml`）**：局部量名 `heldPoolRows` 是误导（它是候选全集 = 池 ∪ 持仓，不是“持仓行”），改名 `valueRows`；并把持仓集传进去：

```js
  const valueRows = valueState ? [...valueState.rows.values()] : [];
  const heldCodes = stocks.map(x => String(x.code || '').trim()).filter(c => /^\d{5,6}$/.test(c));
  const swap = swapSuggest(vRowForSwap, valueRows, heldCodes);
```

其余（`vRowForSwap`、`swapLineHtml`、模板里的 `${swapLineHtml}`）一字不改。

**Fix-4｜归因句不得把“缺腿”画成 0 分（评审席 Minor，控制方接受）**：`divergeRowHtml` 里四处 `Number(ml.quality ?? 0).toFixed(0)` 类写法，改为腿缺时显 `—`（展示层铁律：null 不冒充 0）：

```js
  var leg = function(v){ return (v === null || v === undefined || isNaN(Number(v))) ? '—' : Number(v).toFixed(0); };
  var why = ml ? (' 主分腿：Q' + leg(ml.quality) + '/G' + leg(ml.growth) + '/V' + leg(ml.value) + '/M' + leg(ml.momentum)) : ' 主分四条腿未快照';
```

（既有的 `主分腿：Q82/G40/V44/M30` 断言不受影响——四条腿全在。）

**Fix-5｜`renderDivergeBoard` 对 `state.rows` 补守卫**：`if (!state) return '';` 改为 `if (!state || !state.rows || typeof state.rows.forEach !== 'function') return '';`（与 `renderValueTop10` 的 `state.top10||[]` 同一防御纪律）。

**Fix-6｜门面签名**：`swapSuggest` 导出类型补第三参 `heldCodes?: string[]`（`NS.X as …` 直接 cast 风格不变）。

**新增 5 条测试（接在现有 14 条之后；先跑绿 Fix 再写，或 TDD 顺序自行安排但报告里要留 RED）**：

```ts
Deno.test('swapSuggest：目标必须“未持有”（spec §7.3）——已持有的更优标的不得当换仓目标', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, v('w', 80, 60, 9.0), v('x', 80, 60, 8.0)];
  assertEquals(swapSuggest(y, pool, ['w', 'y'])!.target.code, 'x');   // w 更好但已持有 → 应退而求 x
  assertEquals(swapSuggest(y, pool, [])!.target.code, 'w');           // 不持有 w 时它就是目标
  assertEquals(swapSuggest(y, pool, ['w', 'x', 'y']), null);          // 更优的都持有 → 无建议
});

Deno.test('swapSuggest：浮点边界不得靠运气——真实差恰为 5.0pp 必须给建议', () => {
  const pool = [v('x', 80, 60, 8.2), v('y', 70, 60, 3.2)];            // 8.2-3.2 = 4.999999999999999
  assertEquals(8.2 - 3.2 < 5, true);                                  // 先把这个二进制事实钉在测试里
  const s = swapSuggest(pool[1], pool, []);
  assertEquals(s !== null, true);
  assertEquals(Number(s!.gap.toFixed(1)), 5);
});

Deno.test('divergeLists：非 A 级行不得上榜（spec §7.2/§6：缺数据造成的便宜不得混进结论）', () => {
  // 样本必须够多：只剩一行 A 级时 pctOf 恒为 50，谁都进不了榜——那就测不到过滤器了。
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4),
    { ...v('z1', 99, 1, 9), confidence: 'C' }, { ...v('z2', 1, 99, 0), confidence: 'B' } ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code), ['a']);    // z1 比 a 更“被错杀”，但它是 C 级 → 必须不在榜上
  assertEquals(d.rich.map(r => r.code), ['c']);       // z2 同理（B 级）
});

Deno.test('swapSuggest：候选必须 tier=qualified（too_rich/vetoed/unqualified 都不算“更便宜的合格标的”）', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, { ...v('rich', 80, 60, 9.0), tier: 'too_rich' }, { ...v('veto', 80, 60, 8.5), tier: 'vetoed' }];
  assertEquals(swapSuggest(y, pool, []), null);
});

Deno.test('renderDivergeBoard：state.rows 缺席时优雅降级为空串（不抛）', () => {
  assertEquals(renderDivergeBoard({ batch: '2026-10-11' } as never), '');
});
```

预期计数：`deno test -A scripts/value_leg_logic_test.ts` = **19 passed**（14 + 5）；`deno test -A scripts/` = **100 passed**（95 + 5）。其余判据不变（`node --check` SYNTAX_OK、标记计数 2/2、stock-value 仍 49 passed、HEAD 不变、不双写 site/）。

**不得改动面**：既有 14 条测试的期望值一字不改（特别是 `主分腿：Q82/G40/V44/M30` 与 `swapSuggest(pool[1], pool)!.gap === 5.0` 那条——它用的是两参调用，Fix-1 的向后兼容就是为它保留的）；`SWAP_GAP = 5` 的数值不得动（改动需先改 spec）；两条必含文案与免责句不得改词；`stock-score/**` 与既有信号逻辑零改动。

---

## Task 9: 前视对照脚本 `scripts/value_forward_check.ts`

**Files:**
- Create: `scripts/value_forward_check.ts`、`scripts/value_forward_check_test.ts`

**Interfaces:**
- Consumes: `stock_value`（历史多批次，含 `main_final` 快照）、腾讯 gtimg 250 根 K 线（已有 `sector-trend/tencent.ts` 同口径，但**不 import Edge 函数目录**，在本脚本内重写 `fetchKline`，避开拼接依赖）
- Produces:
  - `meanReturn(bars: {day:string;close:number}[], baseDay: string, n: number): number | null`（基准日取 `baseDay` 或其前一根；超出范围 → null）
  - `groupCompare(rows: {code:string; group:string; baseDay?: string}[], barsOf: Map<string, {day:string;close:number}[]>, nDays: number): { group: string; mean: number|null; median: number|null; n: number; skipped: number }[]`（`baseDay` 缺省取该系列首根；全组无读数仍出一行 n=0）
  - CLI：`deno run --allow-net --allow-env scripts/value_forward_check.ts --batch 2026-10-11 --horizons 20,60,120`（脚本只读 env 与两个主机；若 Deno 报权限不足再退回 `-A`，并在 Task 10 记录），打印两组（被错杀/虚高）与 VQ 十分位 vs 主分十分位的对比表

- [ ] **Step 1: 写失败测试（7 条，不挨网络）**

> **控制方 pre-flight 修正（2026-10-11，机械化把本节代码原样抽出离线跑过）**：计划原文用 `close = 10+i` 的样本却断言
> `=== 20`——而 `(12/10-1)*100` 在二进制里是 `19.999999999999996`，`assertEquals` 是**精确相等**，三条测试同时红
> （实测 `2 passed / 3 failed`）。修法**不是放宽断言**，而是把样本换成 2 的幂次比（8/16/24/32），涨幅落在二进制可精确
> 表示的值上，断言继续用精确相等、判据力零损失（同 Task 8 修复轮对 `SWAP_GAP` 浮点边界的口径：边界必须被**算出来**，不能靠运气）。
> 同时补两处覆盖面：原文那条名为「baseDay 不在序列内 → 取其前一根为基准」的断言其实测的是 **ISO 前 10 字符截取**
> （`2026-01-01T00:00:00Z` 截出来就在序列内），`前一根` 分支从未被测；`median` 也从未被断言。两条各拆一条真用例。

```ts
// scripts/value_forward_check_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { meanReturn, groupCompare, classify } from "./value_forward_check.ts";

const bars = ['2026-01-01','2026-01-02','2026-01-03','2026-01-04'].map((d,i)=>({day:d, close:8*(i+1)}));   // 8,16,24,32
const wknd = [ {day:'2026-01-01', close:8}, {day:'2026-01-02', close:16}, {day:'2026-01-05', close:24}, {day:'2026-01-06', close:32} ];

Deno.test('meanReturn：以 baseDay 收盘为基准算 n 日后涨幅（基准日在序列内）', () => {
  assertEquals(meanReturn(bars, '2026-01-01', 2), 200);          // 8 → 24
});
Deno.test('meanReturn：baseDay 只取前 10 字符（ISO 时间戳进来也能用）', () => {
  assertEquals(meanReturn(bars, '2026-01-02T09:30:00Z', 1), 50); // 16 → 24
});
Deno.test('meanReturn：baseDay 不在序列内 → 取其前一根为基准（真实 K 线有周末/停牌缺口）；早于首根 → null', () => {
  assertEquals(meanReturn(wknd, '2026-01-03', 1), 50);           // 基准落到 01-02（前一根），1 根后是 01-05：16 → 24
  assertEquals(meanReturn(wknd, '2025-12-01', 1), null);         // 早于首根 → null（不猜基准价）
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
  assertEquals(w.n, 2); assertEquals(w.mean, 200);      // 两组都 +200%（涨幅与绝对价无关；b 组整体翻倍不影响）
  assertEquals(w.median, 200);                          // median 此前从未被断言
  assertEquals(r.n, 1); assertEquals(r.mean, 200);
});
Deno.test('groupCompare：无价格历史的 code 不拉低样本数（计入跳过原因供报告）', () => {
  const out = groupCompare([{code:'zz', group:'wronged'}], new Map(), 20);
  assertEquals(out.find(x=>x.group==='wronged')!.n, 0);
  assertEquals(out.find(x=>x.group==='wronged')!.mean, null);
});
Deno.test('classify：只取 A 级（与前端 divergeLists 同过滤器），阈值与前端逐字一致（spec §7.2）', () => {
  const rows = [
    { code:'a', vq:95, main_final:30, confidence:'A' },
    { code:'b', vq:50, main_final:50, confidence:'A' },
    { code:'c', vq:10, main_final:95, confidence:'A' },
    { code:'d', vq:92, main_final:28, confidence:'A' },
    { code:'e', vq:90, main_final:20, confidence:'A' },
    { code:'z1', vq:99, main_final:1,  confidence:'C' },   // 比 a 更“被错杀”，但非 A 级 → 不得混进前视样本
  ];
  const g = classify(rows);
  assertEquals(g.filter(x => x.group === 'wronged').map(x => x.code), ['a']);
  assertEquals(g.filter(x => x.group === 'rich').map(x => x.code), ['c']);
  assertEquals(g.some(x => x.code === 'z1'), false);
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
// 【同公式两处实现】本函数与前端 divergeLists 的过滤器/阈值必须逐字对齐：两边取的是同一个总体（A 级 + 两分齐备），
// 前视对照测的才正是页面展示的那一批。控制方 pre-flight 补的 `confidence==='A'` 过滤就是这条对齐。
function pctMap(xs: number[]): Map<number, number> {
  const s = [...xs].sort((a, b) => a - b);
  return new Map(xs.map(v => [v, (s.filter(x => x < v).length + 0.5 * s.filter(x => x === v).length) / s.length * 100]));
}
export function classify(rows: { code: string; vq: number; main_final: number; confidence?: string }[]): ValLike[] {
  const use = rows.filter(r => r.confidence === 'A');            // 与前端 divergeLists 同过滤器（spec §7.2：非 A 级不得进分歧结论）
  const vp = pctMap(use.map(r => r.vq)), mp = pctMap(use.map(r => r.main_final));
  return use.flatMap(r => {
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

// 控方 pre-flight 修正：原文 `Deno.args[Deno.args.indexOf(k) + 1] ?? d` 在 k 缺席时 indexOf=-1 → 读到 args[0]（一个标志名本身），
// `--batch` 漏传时会把下一个标志名当成日期、绕过下面的用法检查去查一个不存在的批次。改为显式判位置。
const arg = (k: string, d = '') => { const i = Deno.args.indexOf(k); return i >= 0 ? (Deno.args[i + 1] ?? d) : d; };
if (import.meta.main) {
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_ANON_KEY')!;
  const batch = arg('--batch'), horizons = (arg('--horizons', '20,60,120')).split(',').map(Number);
  if (!url || !key || !batch) { console.error('usage: --batch YYYY-MM-DD --horizons 20,60,120'); Deno.exit(2); }
  // 控方注记（N-4）：CLI 段的**权威终态** = 本正文 + 修复轮 1..4 的叠加，未逐轮回写正文；此处仅就地改正两处会致命的一致性：
  // ① PostgREST 的 IS NOT NULL 必须写 `not.is.null`（`not.is_null` → 400 PGRST100，已由线上只读探针坐实）；② select 必须含 `in_pool`，否则 forwardUniverse 的 `in_pool === true` 恒假 → 总体必空。；③ 本节正文里「前端分歧榜另含池外持仓行／可能有微小漂移」那两行已被终审修复单 **F-1 + F-9** 取代（前端补齐 in_pool 判据后两侧同总体，不再是「已知漂移」）。
  const q = `select=code,vq,main_final,tier,confidence,in_pool&batch_date=eq.${batch}&vq=not.is.null&main_final=not.is.null`;
  const res = await fetch(`${url}/rest/v1/stock_value?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) { console.error(`read stock_value ${res.status}`); Deno.exit(1); }
  const rows = (await res.json()) as { code: string; vq: number; main_final: number; confidence: string }[];
  if (rows.length === 0) { console.error('该批次无 (vq, main_final) 齐备行——先确认 Task 6 已落库'); Deno.exit(1); }
  console.log('【前视对照】不足 2 个季度（每季 1 个批次前沿）的读数不具备判据力（spec §8）\n');
  const groups = classify(rows).map(g => ({ ...g, baseDay: batch }));
  const barsOf = new Map<string, Bar[]>();
  for (const g of groups) {
    // 市场前缀只认沪/深：6 开头 = sh（含 688 科创），0/3 开头 = sz；4/8 开头是北交所，gtimg 该入口无历史
    // → 归为无读数（fetchKline 拿不到→skipped 计数），**不得**默默拼个 sz 前缀去拿别的标的的 K 线。
    // 控制方 pre-flight 补：此为数据形状安全项，无网络单测能盖；失方向是 fail-safe（少一个样本，不是错一个样本）。
    const mkt = g.code.startsWith('6') ? 'sh' : (/^[03]/.test(g.code) ? 'sz' : '');
    barsOf.set(g.code, mkt ? await fetchKline(`${mkt}${g.code}`) : []);
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
grep -nE '(>=|<=)\s*(80|50)' scripts/value_forward_check.ts ; grep -nE '(vp|mp) (>=|<=) (80|50)' index.html
```

（控方 pre-flight 修正：原文第二条 grep 写的是 `vp>=80` 无空格形式，而 index.html 里实作是 `vp >= 80`，照旧命令跑会得到“前端无命中”的**伪不一致**信号。两边应各出现 2 行 80/50。）

- [ ] **Step 3: 跑测试 + 干跑一次（仅当生产已有 ≥1 个批次；否则只跑单测）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno test -A scripts/value_forward_check_test.ts
```

Expected: `7 passed`。基线：本 Task 前 `deno test -A scripts/` = **100 passed**（Task 8 后），本 Task 后应为 **107 passed**；
`supabase/functions/stock-value/` 仍 **49 passed**（本 Task 不碰它）。干跑命令（只读）：`deno run --allow-net --allow-env scripts/value_forward_check.ts --batch <最新批次> --horizons 20`；若报“起算批次不足 2 个季度”，属预期输出，不是失败。

- [ ] **Step 4: Commit（⚠ 需用户明示）**

```bash
git add scripts/value_forward_check.ts scripts/value_forward_check_test.ts && \
git commit -m "feat(scripts): forward-return check for value leg (read-only, divergence groups)"
```

---

### Task 9 修复轮 1（控制方裁定：实现者 C1 + C3）

**背景（C1，属计划缺陷，不是实现者的）**：spec §8 L146 逐字要求前视读数对「分歧榜两组」**与**「VQ 十分位 vs 主分十分位」**两者**都做排序对比，本 Task 的 `Interfaces` 也这么写了，但控制方写的 Step 2 代码**只实现了前者**。实现者在报告里指出这一缺口并未自行补上（正确：不在 brief 代码块里的东西不自创）。**控制方裁定：补后半个 spec 要求，修代码不改 spec。**

**背景（C3）**：`meanReturn` 只校基准日 `close > 0`；若**终点**收盘价为 0（停牌/退市/脏数据），会算出 `-100%` 这个**假读数**并拉低整组均值（`fetchKline` 的 `isFinite` 约不住 0）。本项目展示层铁律是「拿不到就是拿不到，绝不填 0 / 绝不造数」→ 同轮修掉。

其余 concerns 的裁定（本轮**不动**）：C2（`deno lint` 对测试文件的 `no-import-prefix`）——与已验收的 `value_leg_logic_test.ts` 同一写法，仓内既有 8 条同类问题，不改风格；C4（`select` 取了 `tier` 但 `classify` 不用）——两边都不看 tier 正是**与前端 `divergeLists` 口径一致**的结果，不是缺陷；C5（干跑未执行）——本轮明确不跑（`stock_value` 表尚未创建），**转交 Task 10**：首跑落库后、注册 cron 前补一次干跑。

**Fix-A｜`meanReturn` 终点价也守（脚本内）**：

```ts
  if (j >= bars.length || !(bars[i].close > 0) || !(bars[j].close > 0)) return null;   // 两端任一不可用→null（不得用 0 价算出 -100% 假读数）
```

**Fix-B｜新增 `decileTable`（导出，接在 `classify` 之后；不依赖网络）**：

```ts
// 十分位对比（spec §8 L146「VQ 十分位 vs 主分十分位」）：按 key **升序**切十档，D1 = 分最低的一档。
// 每档显式带 n：档内只有 1 只也照实说，不拿“档位齐”伪装样本足。
// 可用样本 < 10 → 返回 []：切不出十档就不切，硬切会造出「一档位 = 一只股」的伪判据。
export function decileTable(
  rows: { code: string; vq: number; main_final: number; baseDay?: string }[],
  barsOf: Map<string, Bar[]>, nDays: number, key: 'vq' | 'main_final',
): { decile: number; mean: number | null; n: number }[] {
  const use = rows
    .map(r => {
      const bars = barsOf.get(r.code) ?? [];
      return { r, m: bars.length ? meanReturn(bars, r.baseDay ?? bars[0].day, nDays) : null };
    })
    .filter(x => x.m !== null) as { r: { code: string; vq: number; main_final: number }; m: number }[];
  if (use.length < 10) return [];
  use.sort((a, b) => a.r[key] - b.r[key]);
  const out: { decile: number; mean: number | null; n: number }[] = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor(use.length * d / 10), hi = Math.floor(use.length * (d + 1) / 10);
    const xs = use.slice(lo, hi).map(x => x.m);
    out.push({ decile: d + 1, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: xs.length });
  }
  return out;
}
```

**Fix-C｜CLI 每个窗口补印两张十分位表**（接在现有那行 `窗口 ${n} 日：` 之后，**不改它**）：

```ts
    const scored = rows.map(r => ({ ...r, baseDay: batch }));
    const fmt = (t: { decile: number; mean: number | null; n: number }[]) =>
      t.length ? t.map(x => `D${x.decile} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}%`).join(' | ')
               : '可用样本不足 10，不切十档（诚实：硬切会得到一档位=一只股的伪判据）';
    console.log('  VQ 十分位（D1=分最低）：' + fmt(decileTable(scored, barsOf, n, 'vq')));
    console.log('  主分十分位（D1=分最低）：' + fmt(decileTable(scored, barsOf, n, 'main_final')));
```

**Fix-D｜门面无关**：本 Task 的两个文件不经过 `new Function` 抽取，`scripts/value_leg_logic.ts` 不动。

**新增 4 条测试（接在现有 7 条之后；测试一律不挨网络）**：

```ts
import { meanReturn, groupCompare, classify, decileTable } from "./value_forward_check.ts";   // ← 行内加 decileTable（旧 7 条期望一字不改）

Deno.test('meanReturn：终点收盘为 0（停牌/退市/脏数据）→ null，不得算成 -100% 假读数', () => {
  assertEquals(meanReturn([{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 0 }], '2026-01-01', 1), null);
});

Deno.test('decileTable：按分数升序切十档，D1=分最低；涨幅逐档递增时表格单调（spec §8）', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 10 - i }));
  // 第 i 只的前视涨幅恰为 i*100%（8 → 8*(i+1)，二进制的精确整数比，断言继续用精确相等）
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const t = decileTable(rows, barsOf, 1, 'vq');
  assertEquals(t.map(x => x.decile), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(t.map(x => x.n), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assertEquals(t.map(x => x.mean), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
});

Deno.test('decileTable：同一个样本集换 key 就换序——主分十分位与 VQ 十分位反向', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 10 - i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const m = decileTable(rows, barsOf, 1, 'main_final').map(x => x.mean);
  assertEquals(m, [900, 800, 700, 600, 500, 400, 300, 200, 100, 0]);
});

Deno.test('decileTable：可用样本 <10 → 空表（不硬切十档）；无价格历史的行不入样本而是直接被排除', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.slice(0, 9).map(r => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 16 }]]));
  assertEquals(decileTable(rows, barsOf, 1, 'vq').length, 0);   // c9 无历史 → 可用 9 只
});
```

预期计数：`deno test -A scripts/value_forward_check_test.ts` = **11 passed**（7 + 4）；`deno test -A scripts/` = **111 passed**（107 + 4）。
其余判据不变（stock-value 仍 49、`deno check` / `deno lint` 对**实现文件**无诊断、verify-bundles 5 ✅、HEAD 不变、不双写 `site/`）。

**不得改动面**：现有 7 条测试的期望值一字不改（只在 import 行里**加**一个名字）；`classify` 的 A 级过滤与 `80/50` 阈值不得动（与前端 `divergeLists` 同总体）；`SWAP_GAP`、`index.html`、`scripts/value_leg_logic*`、`supabase/functions/**` 零改动；测试**绝不挨网络**（不 mock fetch，`decileTable`/`meanReturn` 接受现成 `barsOf` 即不需网络）；Step 3 干跑与 Step 4 commit 本轮仍**不执行**。

---

### Task 9 修复轮 2（控制方裁定：修复轮 1 的实现者 C-1 + C-2，同一根病）

**背景**：修复轮 1 的实现者指出（并因不在 brief 代码块里而没有自行修）：Fix-C 把**全量 `rows`** 喂给 `decileTable`，而 CLI 只为 `classify()` 出的分歧榜几行拉了 K 线 → 榜外行一律无历史被排除，**两张十分位表实跑几乎永远打印「可用样本不足 10」**，spec §8 后半句依旧拿不到读数（C-1）。C-2 是同根病的另一面：十分位的总体没过 A 级过滤。

控制方顺着这条线在 `supabase/functions/stock-value/index.ts:38/76/82` 上再核一层，发现还有第三面：脚本查 `stock_value` 时**不带 `in_pool` 过滤**，拿到的是全宇宙（ping 口径 5000+ 行），而前端分歧榜的总体是**池内 (+ 持仓)**（此处记的是 F-1 之前的实况；终审 I-1 判定「前端才是错的一侧」，修复单 F-1 已把前端补齐为纯池内，此后两侧同总体） ——所以 `classify()` 算出的百分位与页面看到的不来自同一个总体，“同公式两处实现”的一致性要求只做到了公式上，没做到总体上。**三条一起修：把“前视总体”抽成一个可测的函数，两套对比都靠它。**

**Fix-E｜新增 `forwardUniverse`（导出，接在 `classify` 之前；不依赖网络）**：

```ts
// 前视总体（spec §7.2 与 §8 的地基）：只有「池内 + A 级」的行进两套对比。
// 必须与前端 index.html 的 divergeLists 同过滤器，否则十分位/分歧榜的百分位就不是页面展示的那一批。
// 【已知且必声明的 drift】前端总体还会带进「池外的自家持仓行」（前端才知道持仓），
// 本脚本在后端跑、不知道持仓 → 两边百分位次序可能有微小漂移，CLI 必须把这行注意事项打印出来。
export function forwardUniverse(
  rows: { code: string; vq: number; main_final: number; confidence?: string; in_pool?: boolean }[],
): { code: string; vq: number; main_final: number }[] {
  return rows.filter(r => r.in_pool === true && r.confidence === 'A');
}
```

**Fix-F｜CLI 换总体、按总体拉 K 线**（接在现有 `const rows = (await res.json()) …` 之后把三行换掉）：

```ts
  const uni = forwardUniverse(rows);                                    // 【本轮核心】两套对比共用同一个总体
  if (uni.length === 0) { console.error('该批次无「池内 + A 级」行——前视无从算起（先确认 Task 6 已落库且池非空）'); Deno.exit(1); }
  console.log(`总体：池内 A 级且两分齐备 ${uni.length} 只；前端分歧榜另含「池外持仓行」，本脚本不知持仓→百分位次序可能有微小漂移\n`);
  console.log(`拉 K 线 ${uni.length} 只 × ${GAP_MS}ms 限流 ≈ ${Math.round(uni.length * GAP_MS / 1000)}s（季度手动跑，一次拉完两张表共用）`);
  const groups = classify(uni).map(g => ({ ...g, baseDay: batch }));
  const scored = uni.map(r => ({ ...r, baseDay: batch }));
  const barsOf = new Map<string, Bar[]>();
  for (const u of uni) {                                                // ← 以前只给 groups 拉，十分位表永远是空；现在给整个总体拉
    // 市场前缀只认沪/深：6 开头 = sh（含 688 科创），0/3 开头 = sz；4/8 开头是北交所，gtimg 该入口无历史
    // → 归为无读数（fetchKline 拿不到→skipped 计数），**不得**默默拼个 sz 前缀去拿别的标的的 K 线。
    // 控制方 pre-flight 补：此为数据形状安全项，无网络单测能盖；失方向是 fail-safe（少一个样本，不是错一个样本）。
    const mkt = u.code.startsWith('6') ? 'sh' : (/^[03]/.test(u.code) ? 'sz' : '');
    barsOf.set(u.code, mkt ? await fetchKline(`${mkt}${u.code}`) : []);
    await new Promise(r => setTimeout(r, GAP_MS));
  }
```

同时：① 查询串里**补上 `in_pool` 列**（`select=code,vq,main_final,tier,confidence,in_pool&…`，服务端不加过滤，过滤放在被测的 `forwardUniverse` 里）；② 行类型 cast 加 `in_pool: boolean`；③ 原 `const groups = classify(rows)…` 与旧的 `for (const g of groups) { … fetchKline … }` 循环、以及 Fix-C 里那行 `const scored = rows.map(…)` 均由上面这段取代（`fmt` 与两行 `console.log('  VQ 十分位…')` 不动）。

**新增 2 条测试（接在现有 11 条之后；仍不挨网络）**：

```ts
import { meanReturn, groupCompare, classify, decileTable, forwardUniverse } from "./value_forward_check.ts";

Deno.test('forwardUniverse：只有「池内 + A 级」进前视总体（与前端 divergeLists 同过滤器，spec §7.2）', () => {
  const rows = [
    { code: 'a', vq: 80, main_final: 40, confidence: 'A', in_pool: true },
    { code: 'b', vq: 70, main_final: 50, confidence: 'B', in_pool: true },    // 非 A 级 → 排除
    { code: 'c', vq: 90, main_final: 30, confidence: 'A', in_pool: false },   // 池外 → 排除
    { code: 'd', vq: 60, main_final: 60, confidence: 'A', in_pool: true },
  ];
  assertEquals(forwardUniverse(rows).map(r => r.code), ['a', 'd']);
});

Deno.test('decileTable 吃的是全体可用样本（不是分歧榜人数）——修复轮 1 C-1 的回归锁', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 12 - i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const t = decileTable(rows, barsOf, 1, 'vq');
  assertEquals(t.length, 10);
  assertEquals(t.reduce((a, x) => a + x.n, 0), 12);   // 12 只全体入档；若只喂分歧榜几行，这条必红
});
```

预期计数：`deno test -A scripts/value_forward_check_test.ts` = **13 passed**（11 + 2）；`deno test -A scripts/` = **113 passed**（111 + 2）。其余判据不变（stock-value 仍 49、实现文件 `deno check`/`deno lint` 无诊断、verify-bundles 5 ✅、HEAD 不变）。

**控制方补跑 `deno task verify-bundles`**（修复轮 1 实现者的 C-4 成立：它内部对各目录 `build.ts` 开了 `--allow-write`，不该让实现者跑；而它的门禁对象 `supabase/functions/**` 本轮零改动 → 由控制方自己跑作判据）。C-3（Fix-A 把旧注释文字消了）→ **不改**：新注释已包含“不填 0”的语义，行为仍由既有第 4 条测试钉着。

**不得改动面**：既有 11 条测试的期望值一字不改（只 import 行再加一个名字）；`classify`/`decileTable`/`meanReturn`/`groupCompare` 四个导出体的**实现**不动（只改 CLI 段与新函数）；`80/50` 阈值与 A 级过滤不得改；不新增任何写操作或新的 `fetch`（K 线仍逐 code 一次 + `GAP_MS` 限流，绝不改成批量）；Step 3 干跑与 Step 4 commit 本轮仍不执行。

---

### Task 9 修复轮 3（任务评审席：1 Critical + 1 Important + 采纳的 5 条 Minor）

**背景**：Task 9 首次正式任务评审判 **Quality: needs fixes**，Spec ✅ 是**带条件**的（条件即 F1）。控制方已用**线上 PostgREST 只读探针**（`.superpowers/sdd/2026-10-11-stock-value-leg/preflight13/probe.ts`，打的是既有表 `stock_score`，文法与表无关）把 F1 坐实为**计划缺陷**（源头 plan L2511，被 brief 逐字继承）：

```
400 | final=not.is_null   | {"code":"PGRST100","details":"unexpected \"_\" expecting operator (eq, gt, ...)","message":"\"failed to parse filter (not.is_null)\" (line 1, column 7)"}
200 | final=not.is.null   | 正常返回行
```

后果：脚本唯一那次 DB 读**必然 400**（`res.ok=false` → 退出码 1），前视读数实际永远产不出。旁证：本仓库 2026-09-30 sector-rotation 的探针清单用的就是 `pos52=not.is.null`。**本轮之后 spec 合规裁决才允许转 ✅。**

**Fix-G｜查询串文法（F1，Critical；`scripts/value_forward_check.ts` CLI 段）**：把

```ts
  const q = `select=code,vq,main_final,tier,confidence,in_pool&batch_date=eq.${batch}&vq=not.is_null&main_final=not.is_null`;
```

整行换成：

```ts
  const q = `select=code,vq,main_final,tier,confidence,in_pool&batch_date=eq.${batch}&vq=not.is.null&main_final=not.is.null`;
```

**Fix-H｜总体守卫搬进被测函数（F2，Important）**：`forwardUniverse` 整**个函数连同其上方的注释块**换成下面这段（`classify`/`decileTable` 不动）。理由写进注释，不许删：

```ts
// 前视总体（spec §7.2 与 §8 的地基）：只有「池内 + A 级 + 两分都是真数字」的行进两套对比。
// 必须与前端 index.html 的 divergeLists 同过滤器（含 null 守卫），否则十分位/分歧榜的百分位就不是页面展示的那一批。
// 【为什么 null 守卫必须在这里、而不是只靠查询串的承诺】value_engine.ts:211 使 `vq=NULL` 与 `confidence='A'` **必然并存**
// （too_rich/vetoed 行不产出 VQ 但仍是 A 级）；一旦查询串走样，null 会被 classify 的百分位算成极低分位而落进「虚高」，
// 并被 decileTable 的 `a.r[key] - b.r[key]` 强转成 0 而污染 D1。总体的守卫必须是被测函数的一部分。
// 【已知且必声明的 drift】前端总体还会带进「池外的自家持仓行」（前端才知道持仓），
// 本脚本在后端跑、不知道持仓 → 两边百分位次序可能有微小漂移，CLI 必须把这行注意事项打印出来。
export type UniRow = { code: string; vq: number; main_final: number; confidence?: string; in_pool?: boolean };
export function forwardUniverse(
  rows: { code: string; vq: number | null; main_final: number | null; confidence?: string; in_pool?: boolean }[],
): UniRow[] {
  const isScore = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
  // 必须 filter、**不得改成 map**：返回的是原对象引用（仍带 confidence/in_pool），
  // 所以 classify(uni) 的再过滤是幂等而非空集——这条隐含契约由第 15 个测试钉住。
  return rows.filter(r => r.in_pool === true && r.confidence === 'A' && isScore(r.vq) && isScore(r.main_final)) as UniRow[];
}
```

同处：CLI 那行 `const rows = (await res.json()) as { code: string; vq: number; main_final: number; confidence: string; in_pool: boolean }[];` **保持不动**——本轮不扩大改动面；`vq: number` 的声明与实际可能为 null 之间的偏差，正是由 Fix-H 的运行时守卫兜住的。

**Fix-I｜`--horizons` 入参校验（F3，Minor）**：紧接现有 `if (!url || !key || !batch) { …Deno.exit(2); }` 那行**之后**插入：

```ts
  const hzRaw = arg('--horizons', '20,60,120');
  if (!horizons.length || horizons.some(h => !Number.isInteger(h) || h <= 0)) { console.error(`--horizons 必须是正整数逗号表（收到「${hzRaw}」）`); Deno.exit(2); }
```

（评审席实测：`--horizons abc` 现在崩在未捕获 TypeError、`--horizons 0` 打印全 0% 伪读数、`--horizons -2` 把**回溯**收益当**前视**读数打印出来。前视样本里混进负窗口是污染，必须挡在门口。）

**Fix-J｜空组也必须出行（F4，Minor）**：把 CLI 里这两行

```ts
    const out = groupCompare(groups, barsOf, n);
    console.log(`窗口 ${n} 日：` + out.map(x => ` ${x.group} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}% 中位=${x.median?.toFixed(2) ?? 'NA'}% 无读数=${x.skipped}`).join(' |'));
```

换成：

```ts
    const cmp = groupCompare(groups, barsOf, n);
    // 组里一个成员都没有时，groupCompare 无从知道该组存在（byG 的键来自 rows）→ 由 CLI 补出 n=0 行。
    // 「分歧榜某一组空了」是前视复盘**最有信息量的读数之一**，绝不允许它在输出里静默消失。
    const shown = ['wronged', 'rich'].map(g => cmp.find(x => x.group === g) ?? { group: g, mean: null, median: null, n: 0, skipped: 0 });
    console.log(`窗口 ${n} 日：` + shown.map(x => ` ${x.group} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}% 中位=${x.median?.toFixed(2) ?? 'NA'}% 无读数=${x.skipped}`).join(' |'));
```

**Fix-K｜市场前缀判定抽成被测函数（F7，Minor）**：新增导出（接在 `async function fetchKline` 之前）：

```ts
// 市场前缀只认沪/深：6 开头 = sh（含 688 科创），0/3 开头 = sz；4/8 开头是北交所，gtimg 该入口无历史
// → 返回 ''（该行归「无读数」），**不得**默默拼个 sz 前缀去拿别的标的的 K 线。失方向是 fail-safe：少一个样本，不是错一个样本。
export function klineSymbol(code: string): string {
  return code.startsWith('6') ? 'sh' : (/^[03]/.test(code) ? 'sz' : '');
}
```

并把 CLI 拉线循环里的**三行注释 + 一行 `const mkt = …`（共四行，从 `// 市场前缀只认沪/深…` 起到 `const mkt = u.code.startsWith('6') ? 'sh' : (/^[03]/.test(u.code) ? 'sz' : '');` 止）换成一行**（理由已搬进 `klineSymbol` 的注释）：

```ts
    const mkt = klineSymbol(u.code);                 // 北交所等无历史入口 → ''（归无读数，绝不拼错前缀去拿别人的 K 线）
```

`for (const u of uni) {` 那行行尾的 `// ← 以前只给 groups 拉…` 注释、以及 `barsOf.set(...)` / `await new Promise(...)` 两行**不动**。

**Fix-L｜耗时预估别说谎（F10，Minor）**：把 CLI 里那行 `console.log(`拉 K 线 …`)` 的括号内文案由

```ts
  console.log(`拉 K 线 ${uni.length} 只 × ${GAP_MS}ms 限流 ≈ ${Math.round(uni.length * GAP_MS / 1000)}s（季度手动跑，一次拉完两张表共用）`);
```

整行换成（只加「+ 每次请求往返」这一处事实，其余一字不改）：

```ts
  console.log(`拉 K 线 ${uni.length} 只 × ${GAP_MS}ms 限流 ≈ ${Math.round(uni.length * GAP_MS / 1000)}s + 每次请求往返耗时（季度手动跑，一次拉完两张表共用）`);
```

**测试改动（共 3 处）**：

1. **整条替换**既有第 5 个测试（`groupCompare：跳组取均值与样本数；全 null 则 mean=null、n=0`）——评审席 F5：它的两个 wronged 样本涨幅同为 200，`mean` 与 `median` 恒等，中位数的偶数分支只是"同值走过"，且 `skipped` 全 13 条从未被断言。新代码（涨幅仍是二进制精确整数）：

```ts
Deno.test('groupCompare：均值≠中位数时两者分别算得出（奇/偶样本分支都走）；skipped 计入但不拉低 n', () => {
  const mk = (end: number) => [{ day:'2026-01-01', close:8 }, { day:'2026-01-02', close:12 }, { day:'2026-01-03', close:end }, { day:'2026-01-04', close:end }];
  const rows = [
    { code:'a', group:'wronged' }, { code:'b', group:'wronged' }, { code:'e', group:'wronged' },
    { code:'d', group:'wronged' },                                                 // d 无历史 → skipped
    { code:'c', group:'rich' },
  ];
  const barsOf = new Map<string, { day:string; close:number }[]>([
    ['a', mk(16)], ['b', mk(16)], ['e', mk(40)], ['c', mk(24)],                   // +100% / +100% / +400% / +200%
  ]);
  const out = groupCompare(rows, barsOf, 2);
  const w = out.find(x => x.group === 'wronged')!, r = out.find(x => x.group === 'rich')!;
  assertEquals(w.n, 3); assertEquals(w.skipped, 1);
  assertEquals(w.mean, 200); assertEquals(w.median, 100);                          // [100,100,400]：均值 200、中位 100，两个量测的是两件事
  assertEquals(r.n, 1); assertEquals(r.mean, 200); assertEquals(r.median, 200);
});
```

2. **追加**（接在现有 13 条之后）：

```ts
Deno.test('klineSymbol：沪 6*→sh（含 688）、深 0/3*→sz、北交所 4/8*→空（无历史入口，不得默默拼前缀）', () => {
  assertEquals(klineSymbol('600519'), 'sh');
  assertEquals(klineSymbol('688981'), 'sh');
  assertEquals(klineSymbol('000001'), 'sz');
  assertEquals(klineSymbol('300750'), 'sz');
  assertEquals(klineSymbol('430047'), '');
  assertEquals(klineSymbol('830799'), '');
});

Deno.test('forwardUniverse↔classify 契约锁：null 分不得进总体，进得来的行必须还能分到组（评审 F2/F6）', () => {
  const rows = [
    { code: 'a', vq: 95, main_final: 30, confidence: 'A', in_pool: true },
    { code: 'b', vq: 50, main_final: 50, confidence: 'A', in_pool: true },
    { code: 'c', vq: 10, main_final: 95, confidence: 'A', in_pool: true },
    { code: 'd', vq: 92, main_final: 28, confidence: 'A', in_pool: true },
    { code: 'e', vq: 90, main_final: 20, confidence: 'A', in_pool: true },
    { code: 'n1', vq: null, main_final: 40, confidence: 'A', in_pool: true },    // value_engine.ts:211 的真实组合：vq=NULL 且 A 级
    { code: 'n2', vq: 88, main_final: null, confidence: 'A', in_pool: true },    // 主分快照缺失 → 同样不得进总体（与前端 divergeLists 同款守卫）
  ];
  const uni = forwardUniverse(rows);
  assertEquals(uni.map(r => r.code), ['a', 'b', 'c', 'd', 'e']);
  assertEquals(classify(uni).length > 0, true);                                   // 若有人把 filter 改成 map（丢 confidence），这条立刻红
  assertEquals(classify(uni).some(x => x.code === 'n1' || x.code === 'n2'), false);
});
```

3. **import 行**再加一个名字：`forwardUniverse` 之后加 `, klineSymbol`。**这是既有文件里除上面第 1 条整条替换之外唯一允许变的行。**

预期计数：`deno test -A scripts/value_forward_check_test.ts` = **15 passed**（13 − 0 删 + 2 新；第 5 条是替换不是增删）；`deno test -A scripts/` = **115 passed**。其余判据：`supabase/functions/stock-value/` 仍 **49**；`deno check` 两文件无诊断；`deno lint scripts/value_forward_check.ts` **0 problems**；`deno lint scripts/` **总数仍为 9**（其中 `value_forward_check_test.ts:2` 的 `no-import-prefix` 是本轮新文件的既例follow，不得为过 lint 改 import 写法）。

**不得改动面**：除 Fix-G/H/I/J/K 与测试的 3 处外，`meanReturn`/`groupCompare`/`classify`/`pctMap`/`decileTable`/`fetchKline`/`arg` 的实现与其余 12 条测试一字不改；`80/50` 阈值、A 级过滤、`GAP_MS` 限流、只 GET 不写、`--batch` 用法检查不动；不新增 `fetch`、不改批量/并发；Step 3 干跑与 Step 4 commit 本轮仍不执行（干跑归 Task 10，需用户明示）。

**评审席提出但控制方裁定不改的（入档，避免下轮重做）**：F8（`fetchKline` 的 `isFinite` 拦不住 `Number('')=0`）——0 价读数已被 `meanReturn` 两端守卫判 null，而把脏 bar 从序列里**删掉**会让 `i+n` 窗口静默移位，二者相权衡现形态更诚实；F9（拉线失败 vs 北交所无历史在 `skipped` 里不可区分）——留待 Task 10 干跑时人工读输出判断；C-1（总体拉线 4–10 分钟）确认无更省的合法做法，干跑排期转 Task 10。

---

### Task 9 修复轮 4（scoped re-review 席：4 条采纳 + 1 条部分采纳 + 1 条控制方自改）

**背景**：修复轮 3 的 scoped re-review 判**上一轮全部采纳项 Addressed**（并用变异测试证明 Fix-H 的守卫承重：删掉 `isScore` → 第 15 条红；把 `filter` 改成 `map` → 第 15 条红），**F1 的条件解除 ⇒ Task 9 的 Spec 合规裁决正式转 ✅**。该席另交 5 条新发现，控制方逐条裁定如下（本轮全是 Minor/Nit，无 Critical/Important）：

| 编号 | 内容 | 裁定 |
|---|---|---|
| N-1 | 第 5 条测试的 wronged 样本 `[100,100,400]` 是奇数个，**偶数中位数分支零覆盖**——把 `(s[k/2-1]+s[k/2])/2` 变异成 `s[k/2]` 测试仍全绿，而该条标题正声称「奇/偶样本分支都走」 | **采纳** → Fix-R |
| N-2 | `--batch` 无形状校验，`--batch "2026-10-11&or=in_pool.eq.false"` 会原样拼进查询串直达 fetch（只读脚本，但等于允许调用方改写 PostgREST 谓词） | **采纳** → Fix-Q |
| N-3 | `isScore` 只认 number；若某次返回把分数写成字符串，总体为空而文案说「池为空」，把数据形态问题误诊成抽样问题 | **部分采纳** → Fix-S 只改错误文案；**拒绝数值字符串强转** |
| N-4 | 计划正文 L2511 仍是 `not.is_null`——照着正文重跑一次就会把 F1 重新引入 | **控制方自行就地改正**（不派实现者，见下「控制方自改」） |
| N-5 | `classify` 上方注释只写「A 级 + 两分齐备」，未提「池内」，与被它吃的 `forwardUniverse` 实际总体不符 | **采纳** → Fix-T（仅注释） |

**Ruling（N-3 为何拒绝强转）**：`pctMap` 的排序与分位全靠 `x < v` 比较。若把 `'95'` 这类字符串**放过守卫**进总体，比较会退化成字典序（`'9' < '100'`），十分位表与分歧榜会**安静地给出错读数**——比现在「总体为空 + 明确报错」更坏。正确处置是让守卫照实拒绝、并把错误文案写成能被读懂的两条成因。

---

**Fix-Q｜`--batch` 形状校验（N-2，`scripts/value_forward_check.ts` CLI 段）**：紧接修复轮 3 的 `--horizons` 校验那两行**之后**插入一行（即插在 `const q = …` 之前）：

```ts
  if (!/^\d{4}-\d{2}-\d{2}$/.test(batch)) { console.error(`--batch 必须是 YYYY-MM-DD（收到「${batch}」）`); Deno.exit(2); }
```

**Fix-S｜空总体的文案要说两条成因（N-3，整行替换）**：把

```ts
  if (uni.length === 0) { console.error('该批次无「池内 + A 级」行——前视无从算起（先确认 Task 6 已落库且池非空）'); Deno.exit(1); }
```

整行换成：

```ts
  if (uni.length === 0) { console.error('该批次无「池内 + A 级 + 两分皆为 number」行——前视无从算起（先确认 Task 6 已落库且池非空；若两分以字符串形态返回，isScore 会照实拒绝——那是数据形态问题，不是抽样问题）'); Deno.exit(1); }
```

（`if` 条件、`Deno.exit(1)` 一字不动，只扩写字符串。）

**Fix-T｜`classify` 注释与实际总体对齐（N-5，仅注释）**：把 `classify` 上方注释块里那处 `（A 级 + 两分齐备）` 换成 `（池内 + A 级 + 两分齐备，见 forwardUniverse）`。该注释行其余文字、`classify` 的实现与阈值 `80/50` **一字不动**。

**Fix-R｜让第 5 条真的走偶数中位数分支（N-1，测试整条替换）**：把既有第 5 个测试（标题以 `groupCompare：均值≠中位数时两者分别算得出` 开头，共 16 行）**整条**换成：

```ts
Deno.test('groupCompare：奇/偶样本各一组，均值≠中位数才测得出中位数取的是哪一支（评审 N-1）', () => {
  const mk = (end: number) => [{ day:'2026-01-01', close:8 }, { day:'2026-01-02', close:12 }, { day:'2026-01-03', close:end }, { day:'2026-01-04', close:end }];
  const rows = [
    { code:'a', group:'wronged' }, { code:'b', group:'wronged' }, { code:'e', group:'wronged' }, { code:'f', group:'wronged' },
    { code:'d', group:'wronged' },                                                 // d 无历史 → skipped
    { code:'c', group:'rich' }, { code:'g', group:'rich' }, { code:'h', group:'rich' },
  ];
  const barsOf = new Map<string, { day:string; close:number }[]>([
    ['a', mk(16)], ['b', mk(24)], ['e', mk(32)], ['f', mk(88)],                    // +100% / +200% / +300% / +1000%
    ['c', mk(24)], ['g', mk(32)], ['h', mk(88)],                                   // +200% / +300% / +1000%
  ]);
  const out = groupCompare(rows, barsOf, 2);
  const w = out.find(x => x.group === 'wronged')!, r = out.find(x => x.group === 'rich')!;
  assertEquals(w.n, 4); assertEquals(w.skipped, 1);
  assertEquals(w.mean, 400); assertEquals(w.median, 250);                           // 偶数支 [100,200,300,1000]：(200+300)/2=250 ≠ 均值 400
  assertEquals(r.n, 3);
  assertEquals(r.mean, 500); assertEquals(r.median, 300);                           // 奇数支 [200,300,1000]：中位 300 ≠ 均值 500
});
```

样本为何这样挑（写在这里供评审复核，不必进代码）：`mk(end)` 固定基准收盘 8、n=2 落在第 3 根，涨幅 = `(end-8)/8*100`，故 16/24/32/88 → **100/200/300/1000**，全是二进制精确整数，断言继续用 `assertEquals` 精确相等（**改样本不改断言精度**）。wronged 取偶数个（4）且中位两值不等 ⇒ 偶数分支被真正测量；rich 取奇数个（3）且中位≠均值 ⇒ 奇数分支被真正测量。变异检验：若把偶数中位写成 `s[k/2]`，`w.median` 会变成 300，本条立刻红。

---

**控制方自改（N-4，不派给实现者）**：计划正文 `## Task 9` Step 2 的查询串那行，把 `not.is_null` 就地改为 `not.is.null`，并补上修复轮 1 起就一直在 select 列表里的 `in_pool`（否则照正文重跑，`forwardUniverse` 的 `in_pool === true` 恒假 → 总体必空），同时在该行上方加一行控制方注记，声明「CLI 段的权威终态 = Step 2 正文 + 修复轮 1..4 的叠加，未逐轮回写正文」。

**预期计数与判据（与修复轮 3 完全相同，本轮不增删测试条数）**：`deno test -A scripts/value_forward_check_test.ts` = **15 passed**（第 5 条是替换）；`deno test -A scripts/` = **115 passed**；`supabase/functions/stock-value/` = **49 passed**；`deno check` 两文件无诊断；`deno lint scripts/value_forward_check.ts` = **0 problems**；`deno lint scripts/` 总数**仍为 9**（不得为过 lint 改 `https://deno.land/std@0.224.0` 的 import 写法）。

**不得改动面**：`meanReturn`/`groupCompare`/`classify`/`pctMap`/`decileTable`/`forwardUniverse`/`klineSymbol`/`fetchKline`/`arg` 的实现一字不动（Fix-Q/S 只在 CLI 段，Fix-T 只改一处注释括号文字）；`isScore` **不得**加数值字符串强转；`80/50` 阈值、A 级过滤、`in_pool` 过滤、`GAP_MS` 限流、只 GET 不写、查询串 `not.is.null` 文法不动；其余 14 条测试一字不改；本轮仍**不**执行干跑与 commit（归 Task 10，需用户明示）。

**Re-review 席提出但控制方裁定不改的（入档，避免下轮重提）**：N-1 席上另建议「给 `groupCompare` 补一条纯空 rows 的测试」——既有第 6 条（`无价格历史的 code 不拉低样本数`）已覆盖 `n=0 / mean=null`，再加是重复覆盖，不采纳。

---

### 终审修复单（whole-branch review：5 Important + 采纳的 4 条 Minor/Nit + 1 条连带改正）

**背景**：全量终审席判 **Critical 0 / Important 5 / Minor 4 / Nit 2**，总判「需先修复 3 项」。控制方对 5 条 Important **逐条独立核验全部坐实**（含自跑的差分与变异复现），并纠正了评审包里我自己的一处事实错误：独立实现是 **3 份**不是 4 份（`value_leg_logic.ts` 是抽 `index.html` 原文的门面，`deploy.ts` 经 verify-bundles 证与源码逐字节一致，二者都不构成第二套逻辑）。席上 300 组含大量并列的总体差分 `mismatch=0` ⇒ **阈值/破平局层零分叉**，分叉只发生在「参与分位的总体」这一维。

用户对三条无权由控制方决定的事项已明示（2026-10-12）：**I-3 选「后端补池内分位两列」（遵 spec，不改 spec 措辞）**、**I-5 选「补进 `.gitignore`」**、**M-3 选「接受换仓建议不参与前视验证，写进 spec」**。

**Ruling（本单的两处控制方自主裁定，写进代码注释，不许删）**：
1. **F-2 只给「否决行」补胶囊，不给其它 `vq=null` 行补。** 引擎不变式是 `vq = tier==='qualified' && vcov>=VCOV_MIN ? vq0 : null`，所以 `too_rich` / `unqualified` / 覆盖度不足的行**同样是 `vq=null`**。若对一切 `vq=null` 渲染「价值 NA」，持仓卡 signal-strip 会为每只非合格票新增一颗噪音胶囊——spec §7.4 只要求「否决标记」可见（§7.1 也只在 Top10 列清单里点名否决标记），没要求给"未入围"发胶囊。代价：`too_rich`/`unqualified` 在持仓条上仍不可见（维持现状），与「被否决」的区分度问题只解决了否决这一侧。
2. **F-1 的过滤写成 `!== false` 而不是 `=== true`。** 既有 5 条 `divergeLists` 测试的 fixture 工厂 `v()` **根本没有 `in_pool` 字段**（`undefined`）；写 `=== true` 会让它们全红，逼人改 fixture 期望值——那正是「改样本迁就断言」的反面。`!== false` 既挡住池外持仓行，又让「不带 `in_pool` 的样本」继续参与，既有断言一字不动。

---

#### F-1｜I-1：分歧榜总体补 `in_pool` 过滤（`index.html` VALUE_PURE 块）

把 `divergeLists` 上方的注释与 `use` 过滤（现 `index.html:850-855`）换成：

```ts
// 分歧榜（spec §7.2 逐字：「VQ **池内**前 20 分位 × V1.1 主分后 50 分位」）：
// 总体必须是「池内 + A 级 + 两分齐备」，与前视脚本 forwardUniverse 同一个总体——否则页面看到的榜
// 与前视时间表声称验证的那张榜**同名、不同总体**，本功能「判生死」的证据基础失效。
// 缺 in_pool 判据的实际后果（终审实测）：一只「已从 stock_pool 摘除但仍有主分快照」的持仓行会
// ①自己混进榜单 ②改掉其余所有行的百分位（实例：加 1 只池外持仓，600519 从 87.5→70 直接出榜）。
// 写成 `!== false` 而非 `=== true`：见计划「控制方裁定」第 2 条（保住既有 5 条测试的无 in_pool fixture）。
function divergeLists(rows){
  var use = (rows || []).filter(function(r){
    return r && r.vq !== null && r.vq !== undefined && r.main_final !== null && r.main_final !== undefined
      && r.confidence === 'A' && r.in_pool !== false;
  });
```

**测试补一条**（接在既有 `divergeLists：非 A 级行不得上榜` 那条之后；`v()` 工厂与 `pctOf` 均已在块内）：

```ts
Deno.test('divergeLists：池外持仓行既不进榜、也不挤掉他人的分位（终审 I-1，spec §7.2「池内」）', () => {
  const base = [
    { ...v('a', 95, 30, 6), in_pool: true }, { ...v('b', 50, 50, 3), in_pool: true },
    { ...v('c', 10, 95, 1), in_pool: true }, { ...v('d', 92, 28, 5), in_pool: true },
  ];
  assertEquals(divergeLists(base).wronged.map(r => r.code), ['a']);          // 池内 4 行：a 的 VQ 分位 87.5 ≥80 → 进榜（终审实测值）
  assertEquals(divergeLists(base).rich.map(r => r.code), ['c']);
  const withOut = base.concat([{ ...v('x', 99, 20, 9), in_pool: false }]);   // x：已从 stock_pool 摘除但两分齐备的持仓行
  const d = divergeLists(withOut);
  assertEquals(d.wronged.map(r => r.code), ['a']);                            // x 不得进榜，且 a 不得被挤掉
  assertEquals(d.rich.map(r => r.code), ['c']);
});
```

（**为什么这条能杀 I-1**：`v` 工厂签名是 `(code, vq, main, mos)`，第 4 参不是覆盖对象，所以 `in_pool` 必须用 `{ ...v(…), in_pool }` 补——与该文件 `main_final: null` 那条既有用例同款写法。块内 `pctOf` 用中位秩约定 `(i+0.5)/n`：4 只时 a 的 VQ 分位 = 87.5（≥80 进榜）；掺进第 5 只（x，vq=99）后 a 落到 (3+0.5)/5 = **70 < 80 直接出榜**，x 自己以 90 进榜。⇒ 未加 `in_pool !== false` 过滤时本条必红，且红的就是「同名不同总体」这个真实后果，不是某个边角形状。）

#### F-2｜I-2：否决行的价值胶囊必须可见（`index.html` VALUE_PURE 块）

`valuePillHtml` 整个函数换成：

```ts
function valuePillHtml(row){
  if(!row) return '';
  // 引擎不变式（value_engine.ts:211）：`vq = tier==='qualified' && vcov>=VCOV_MIN ? vq0 : null`
  // ⇒ 否决行的 vq **必为 null**。所以「是不是否决」必须排在「有没有分」之前判：
  // 旧顺序让硬否决胶囊整颗消失（返回 ''），使「被硬否决」与「价值腿尚未生成」在持仓条上视觉完全相同，
  // 而 tier='vetoed' 这个明确结论就在同一行数据里被丢弃（违反 spec §7.1 否决标记 + §7.4，也违反展示层铁律）。
  if(row.tier === 'vetoed' || row.vetoed) return '<span class="score-pill score-pill-warn">价值 硬否决 ⛔</span>';
  if(row.vq===null || row.vq===undefined) return '';       // 其它无分档（too_rich/unqualified/覆盖度不足）维持现状，见控制方裁定第 1 条
  const pctPos = (row.pool_n && row.pool_rank) ? ' 池内 P' + Math.max(1, Math.round(100 - row.pool_rank/row.pool_n*100)) : '';
  return '<span class="score-pill">价值 '+Number(row.vq).toFixed(1)+pctPos+'</span>';
}
```

**既有那条测试必须换成引擎真实形状**（现 `value_leg_logic_test.ts:24-28`）——它用 `{...row, vetoed:true}` 而 `vq` 保持 `78.4`，证明的是「引擎永不产出的对象能被渲染」，属自证假绿灯：

```ts
Deno.test('valuePillHtml：无行→空串；有分→分 + 池内分位；否决行（引擎真实形状 vq=null）必须可见', () => {
  assertEquals(valuePillHtml(null), '');
  assertEquals(valuePillHtml({ ...row, pool_rank: 12, pool_n: 200 }).includes('池内 P94'), true);
  // 否决行 = 引擎产出的 { tier:'vetoed', vetoed:true, vq:null }。旧断言写 vq:78.4 是被测代码永不收到的形状。
  const vetoedRow = { ...row, vq: null, tier: 'vetoed', vetoed: true };
  const h = valuePillHtml(vetoedRow);
  assertEquals(h.includes('硬否决'), true);
  assertEquals(h.includes('score-pill-warn'), true);
  assertEquals(h.includes('⛔'), true);
  assertEquals(h === '', false);                                              // 这条才是 I-2 的实质：胶囊不得整颗消失
  // 无分且未被否决（如覆盖度不足）→ 仍不渲染，别把「还没算出来」伪装成结论
  assertEquals(valuePillHtml({ ...row, vq: null, tier: 'unqualified', vetoed: false }), '');
});
```

（测试标题里的「池内分位」在 F-3 之后才名副其实；F-3 未落之前这条会红，属预期——**先做 F-3 再跑这条**。）

#### F-3｜I-3：新增池内分位两列 + 把接线抽成可测的 `buildDbRows`（遵 spec §7.1/§7.4，用户选定方案）

**(a) `scripts/migrate_stock_value.sql`**：迁移**尚未执行**（Task 10 Step 1 待用户明示），可直接改 DDL。把

```sql
  ind_rank integer, ind_n integer, market_rank integer, market_n integer,
```

换成

```sql
  ind_rank integer, ind_n integer, market_rank integer, market_n integer,
  pool_rank integer, pool_n integer,   -- 池内分位（spec §7.1/§7.4 的「池内 P」）。终审 I-3：market_n 是全市场有效分行数（5000+），此前被标成「池内 P」是错名
```

**另（re-review N-N1，控制方采纳）**：把 `in_pool boolean default false` 改为 `in_pool boolean not null default false`。理由：F-1 的全部价值在「前端的榜 = 前视脚本验证的榜」，而前端写 `in_pool !== false`（为保住无 `in_pool` 的 fixture 而刻意取宽松侧）、脚本写 `in_pool === true`；两者只在「`in_pool` 恒为布尔」这一前提下等价，而该前提此前**无数据库强制**（列可空、无测试写 `in_pool: null`）。`not null` 把这条等价性从「编排层习惯」变成数据库事实；迁移尚未执行（Task 10 Step 1），改 DDL 零成本。方向与 `rf_fallback`/`vetoed` 的「无 default 才 fail loudly」不冲突：`in_pool` 是**纯事实列**且 `toDbRow:50` 每行必写布尔，`not null` 只会把「漏写」变成整批报错。

**(b) `supabase/functions/stock-value/index.ts`**：新增导出（接在 `toDbRow` 之前）。池信息来自 `stock_pool`，属编排职责，引擎不知道 `poolSet`，所以**必须在编排层算**：

```ts
// 池内分位（spec §7.1/§7.4 的「池内 P」）：宇宙 = 本批 in_pool 且 vq 非 null 的行，按 vq 降序。
// 与引擎给 marketRank 的排序口径逐字一致（`sort((a,b)=>b.vq!-a.vq!)`），两套分位才可对照。
// 不在 value_engine 里算：引擎不接 poolSet（池信息是编排层从 stock_pool 取来的）。
export function poolRanks(computed: ValueRow[], poolSet: Set<string>): Map<string, { rank: number; n: number }> {
  const inPool = computed
    .filter(r => r.vq !== null && poolSet.has(r.code.split('.')[0]))
    .sort((a, b) => b.vq! - a.vq!);
  const m = new Map<string, { rank: number; n: number }>();
  inPool.forEach((r, i) => m.set(r.code.split('.')[0], { rank: i + 1, n: inPool.length }));
  return m;
}
```

**(c) `toDbRow` 签名加第 7 个可选参数**（可选 → 既有 5 条 `index_test.ts` 的位置调用一字不动）：

```ts
export function toDbRow(
  r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none', pool?: Map<string, { rank: number; n: number }>,
): DbRow {
```

并把 `ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: r.marketN,` 一行换成：

```ts
    ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: r.marketN,
    pool_rank: pool?.get(bare)?.rank ?? null, pool_n: pool?.get(bare)?.n ?? null,
```

**(d) 落库映射抽成导出的纯函数 `buildDbRows`，handler 只调它**

**Ruling（控制方，preflight16 变异检验 M3 逼出）**：原方案把 `const pool = poolRanks(...)` 留在 handler 里、`computed.map(...)` 就地展开，而 `index_test.ts` 直接调 `toDbRow(…, pool)`——**接线本身不在任何测试路径上**。变异检验实证：摘掉 `pool` 实参后 6 条测试全绿（M3 存活），即「新列永远 NULL」这个缺陷无法被任何测试抓住。故把接线抽成导出的纯函数，让「漏接 pool」变成可测缺陷：

```ts
// 编排层的落库映射：池内分位必须在这里接线到每一行。抽成导出的纯函数（而不是留在 handler 里两行），
// 是为了让「漏接 pool」这种错误变成可测缺陷 —— 它曾让 pool_rank/pool_n 永远 NULL 而全部测试照绿（终审 I-3 变异检验）。
export function buildDbRows(
  computed: ValueRow[], batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none',
): DbRow[] {
  const pool = poolRanks(computed, poolSet);
  return computed.map(r => toDbRow(r, batch, poolSet, main, stamps, cn10ySource, pool));
}
```

注意参数名是 `main`（`Map<string, MainSnap>`），调用点才写 `main.map`。现 `index.ts:135` 那两行（`const pool = …` + `await upsert(computed.map(...))`）整体换成一行：

```ts
    await upsert(buildDbRows(computed, batch, poolSet, main.map, stamps, resolved.source));
```

**(e) `index.html` 的 `renderValueTop10`**：spec §7.1 给该卡点的列含「池内/市场分位」，此前一个都没显示。在 `owner yield … ROIC中位 …` 那个 muted span 末尾（`+'</span></div>'` 之前）追加：

```ts
      + (r.pool_n && r.pool_rank ? ' · 池内 P' + Math.max(1, Math.round(100 - r.pool_rank / r.pool_n * 100)) : '')
```

**(f) `supabase/functions/stock-value/index_test.ts` 补两条**（用该文件既有的 fixture 风格；动态解构那行同步加 `buildDbRows`）：

1. `poolRanks`：断言「池内 3 行、非池 1 行时 `poolRanks` 给出的 n=3、降序 rank 正确，且非池行不在 Map 里」；再断言 `toDbRow(…, pool)` 落出的 `pool_rank/pool_n` 有值，而**不传** `pool` 时两键为 `null`（证明第 7 参数可选且不产生 `undefined` 落库）。
2. `buildDbRows`：**这条测的是接线本身，`(1)` 测不到**——三行（池内有分 2 只 + 池内 `vq=null` 1 只）经 `buildDbRows` 后，有分两行必须拿到 `pool_rank` 1/2 与 `pool_n=2`，`vq=null` 那行两键必须 `null`（不占池内位）。若 `buildDbRows` 内部忘了把 `poolRanks` 的结果传给 `toDbRow`，本条必红（变异检验 M3 的复验判据）。

#### F-4｜I-4：q5 的 ROE/股息率补 1231 守卫（注册 cron 前必须落，本单随首批做）

`supabase/functions/stock-value/gs_value.ts` 的 `annualCols` 换成（只加第三个参数与一条谓词，排序逻辑不动）：

```ts
export function annualCols(t: GsTable, labelPrefix: string, requireAnnualOnly = false): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length))
        && (!requireAnnualOnly || stampOf(k).endsWith('1231'));   // 终审 I-4：q3 ROIC 锤死 1231，q5 此前不验 → 中报累计值冒充年报
    })
```

两处调用加 `true`：

```ts
  const dyKeys = t5 ? annualCols(t5, '股息率', true) : [];
  const roeKeys = t5 ? annualCols(t5, '净资产收益率roe(摊薄', true) : [];
```

**理由必须写进注释**（接在 `// 股息率 / ROE 在真响应里都是年报列族` 那行之后）：

```ts
  // 【为什么 q5 也要锤 1231】否决4 拿 `roe` 与 ROIC_GATE=8 这个**年化**阈值比（value_engine.ts:50-51）。
  // GS 若回 `净资产收益率roe(摊薄)[yyyy0630]`（H1 累计非年化），一只 H1 ROE 4.5%（年化约 9%，达标）的银行会被判
  // `med<8 && cur<8` → 无护城河证据 → tier=vetoed → 整个银行类出榜。此前 q3 会炸整夜、q5 静默落库，是不对称。
  // q5 是可选批，所以这里**剔出列族**（→ roe=null → 否决4 不判定）而不是炸批：宁缺一个判定，不做一个错判定。
```

**既有断言必须翻转**（这条断言锁的正是缺陷行为本身，属**改正**不是迁就）：`gs_value_test.ts:95` 的 `assertEquals(merge().rows[2].roe, 12.4)` 换成

```ts
  // 终审 I-4：legacy fixture 的 ROE 列**只有** `[20260630]`（中报累计）。加 1231 守卫后它必须被剔出列族 → null。
  // 原断言 12.4 把「中报冒充年报」锁成了不可回归的正确行为，此处是改正，不是回归。
  assertEquals(merge().rows[2].roe, null);
```

并**新增一条**：q5 同时含 `[yyyy0630]` 与 `[yyyy1231]` 时，取 1231 那根、且 `stamps.roe_period` 以 1231 结尾（没有现成 fixture 就照 `fixtures/` 既有形态加一个最小 inline 对象，**不得**改动 `vq5_sample.json` 这个真响应快照）。

#### F-5｜M-1：README 的两个错误计数（本次 diff 自己写错的）

`README.md` 新增段里：Edge Functions「共 5 个」→ **6 个**（补上 `stock-value`）；「构建产物」的 deploy.ts 清单由 4 个补成 5 个（含 `stock-value/deploy.ts`）；「校验会重跑四个模块的构建」→ **五个**。以 `scripts/verify_deploy_bundles.ts` 的 `MODULES` 实数与 `deno task verify-bundles` 的实际输出为准，**不得**写死任何将来还会变的计数（改为「见 `verify_deploy_bundles.ts` 的 MODULES」的写法优先于写数字）。

#### F-6｜M-2：`stock-value/build.ts` 的门禁平移到与其余四员同级

现状：`rd()` 的剥离正则**硬编码三文件名** `/^import\s.*?from\s*'\.\/(value_engine|gs_value|rf)\.ts';?\s*$/gm`，且没有 `assertNoDup` / `assertNoResidualImport`。风险（`sector-trend/build.ts` 的注释逐字写明过）：哪天新增一个 `./foo.ts` 或某条 import 行尾带注释，剥离正则漏掉它，新构建与已提交 deploy.ts **同样坏**，而 verify-bundles 只做字节比对，结构上抓不到。

改法：把 `rd()` 的剥离正则换成 `sector-trend/build.ts` 的通用形态（`/^import\s[^;]*?from\s*["']\.\/[^"']+["'];?[ \t]*$/gm` + 副作用型 import 那条），并把 `DUP_RE` / `assertNoDup` / `RESIDUAL_RES` / `assertNoResidualImport` 四个定义与 `src` 拼接后的两行调用**平移**过来（拼接顺序 value_engine→gs_value→rf→index 不变）。

**两道硬约束**：
- 改完必须重跑 `deno run --allow-read --allow-write supabase/functions/stock-value/build.ts`（缺省即写 `deploy.ts`），再 `deno task verify-bundles` 取 5 ✅。**控制方已在 pristine 副本上实测过结果**：新旧产物**不是**逐字节相同，差异恰为 **+2 空行 / +2 字节**——旧的硬编码正则用 `\s*$` 会把 import 行连同其后的空行一起吃掉，sector-trend 的通用形态用 `[ \t]*$` 会留下那个空行；`diff -B` 输出为空即证明**纯空白差异、行为不变**。因此 **deploy.ts 必须由新 build.ts 重新生成**，不要把产物当成不可动的外部常量去反推正则。判据：`bash -c 'diff -B <(旧 deploy.ts) <(新 deploy.ts)'` 为空 + `verify-bundles` 5 ✅。除空行外出现任何实质差异 → **停下上报，不要手工把产物对齐回旧字节**；
- 若 `assertNoResidualImport` 因 `RESIDUAL_RES` 第 4 条（远程/内置协议 `https?:|jsr:|npm:|node:`）命中既有 import 而炸 → **停下上报，绝不为过门禁放宽 RESIDUAL_RES 或删掉那条谓词**。

#### F-7｜M-4：分歧榜归因句补 spec §7.2 示例要求的 `(P8)/(P22)` 分位数

`divergeLists` 里两处 `push(use[i])` 改成携带分位（`pctOf`/`vp`/`mp` 已在同一作用域，此前判完榜即弃）：

```ts
    if (vp >= 80 && mp <= 50) wronged.push({ ...use[i], vp, mp });        // 分位随行进榜（spec §7.2 示例要 (P8)/(P22)）
    if (vp <= 50 && mp >= 80) rich.push({ ...use[i], vp, mp });
```

`divergeRowHtml` 的 `'<span class="score-pill">VQ ' + Number(r.vq).toFixed(1) + ' / 主分 ' + Number(r.main_final).toFixed(1) + '</span>'` 一行换成：

```ts
    + '<span class="score-pill">VQ ' + Number(r.vq).toFixed(1) + '(P' + Math.round(r.vp) + ') / 主分 ' + Number(r.main_final).toFixed(1) + '(P' + Math.round(r.mp) + ')</span>'
```

用 `{ ...use[i] }`（浅拷）而**不是**往原对象上挂字段：`valueState.rows` 是 `Map<code, row>`，改原对象会污染 Top10 卡与持仓卡的同一引用。**停条件已由控制方预先核过并解除**：`renderDivergeBoard`（`index.html:898-909`）只做 `state.rows.forEach(push)` → `divergeLists(all)` → `d.wronged.slice(0,5).map(r => divergeRowHtml(r, tag))`，**全文无任何按引用比较榜上对象与原行的地方**（实现者仍需自行 `grep` 确认一遍，但预期不触发）。

> 注：`scripts/value_leg_logic.ts:24` 把 `divergeLists` 声明为返 `(rows: Record<string, unknown>[]) => { wronged: Record<string, unknown>[]; rich: … }`，携带 `vp/mp` 的浅拷对象仍满足该类型；**没有测试按引用比榜上对象**（既有 4 条都用 `.map(r => r.code)`）。

**(g) 配套测试（控制方补：无测试的修复 = 不判据的修复，不得入单）**——追加到 `scripts/value_leg_logic_test.ts` 末尾。该文件的 `v(code, vq, main, mos)` fixture 工厂造的是**池内 A 级且两分齐备**的行，`renderDivergeBoard(state)` 的入参是 `{ batch, rows: Map<code, row> }`（与既有第 8/9 条同构）：

```ts
Deno.test('renderDivergeBoard：归因句带上让样本入选的分位 (P90)/(P50)（spec §7.2 示例、终审 M-4）', () => {
  const rows = [v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4)];
  const state = { batch: '2026-10-11', rows: new Map(rows.map(r => [r.code, r as never])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('VQ 95.0(P90) / 主分 30.0(P50)'), true);
  assertEquals(html.includes('VQ 10.0(P10) / 主分 95.0(P90)'), true);
});
```

期望值由「中位秩分位 + 5 行总体」算出并已在站点实跑坐实：`a` 的 vq=95 是最高者 → below=4,eq=1 → P90；`b` 的 main=50 居中 → below=2,eq=1 → P50；`c` 的 vq=10 最低 → P10。**实现者若改样本必须同时重算分位，不得只改样本不改精度。**同理，`divergeRowHtml` 的安全边际沿用 **2 位小数**（`mos=6` → `6.00pp`，不是 `6.0pp`）。

#### F-8｜N-1：同一个量在两处用两种单位（`%` vs `pp`）——**控制方扩大为三处**

`margin_of_safety` 是 `owner_yield − cn10y` 的差，**口径是百分点**：`value_engine.ts:8` 写的就是 `MOS_GATE = 2; // pp`，spec §4/§9 与换仓横幅（`index.html:2449` 的 `5.0pp`）都用 **pp**。但前端把同一个量渲染成 `%` 的地方**不止终审席点名的 `valueGateHtml`**（席上只引了 L817/820）——若只改一处，就把不一致从「gate vs 横幅」平移成「gate 内部 vs Top10/分歧榜」，等于没修。

**Ruling（控制方自主扩大）**：三处一起改，共用一个新增的姊妹 helper，不复用 `valueFmtPct` 也不在调用点各写一遍三元表达式：

在 `index.html` 的 `valueFmtPct` 那行（现 `:804`）**之后**插入一行：

```ts
function valueFmtPp(v, d){ if(v===null || v===undefined || isNaN(Number(v))) return 'NA'; return Number(v).toFixed(d===undefined?1:d)+'pp'; }
```

（**不必**加进 `scripts/value_leg_logic.ts` 的 `EXPORT_NAMES`：测试不直接调它，它只在块内被三个渲染函数消费；`null → 'NA'` 继续守住展示层铁律——不得用 0 冒充无读数。）

三处替换（只改 `margin_of_safety` 的渲染，`owner_yield`/`cn10y`/`roic_med` 等真百分数量**不动**）：

| 位置 | 旧 | 新 |
|---|---|---|
| `valueGateHtml` mos 三元式的非 null 分支（现 `:817`） | `valueFmtPct(row.margin_of_safety, 2)+'（owner yield '` | `valueFmtPp(row.margin_of_safety, 2)+'（owner yield '` |
| `renderValueTop10` muted span（现 `:834`） | `' · 安全边际 '+valueFmtPct(r.margin_of_safety,2)` | `' · 安全边际 '+valueFmtPp(r.margin_of_safety,2)` |
| `divergeRowHtml`（现 `:895`） | `' · 安全边际 '+valueFmtPct(r.margin_of_safety, 2)` | `' · 安全边际 '+valueFmtPp(r.margin_of_safety, 2)` |

**不牵动既有断言**（已核）：`value_leg_logic_test.ts:35` 只断言 `'6.2%'`（owner_yield）、`'1.85%'`（cn10y）与字符串 `'安全边际'`；全仓没有任何断言写死 `4.35%`（`4.35` 只作为 fixture 输入值出现在 `:6`、`value_engine_test.ts:65` 注释、`index_test.ts:10`）。`swapSuggest` 相关断言用的是数值 `gap`，不是渲染串。

**配套测试（控制方补；三处都必须被断言到，否则「扩大为三处」只落了文字）**——追加到 `scripts/value_leg_logic_test.ts` 末尾：

```ts
Deno.test('安全边际三处统一按 pp 渲染，旧单位 4.35% 不得残留（终审 N-1）；Top10 另带池内分位（F-3e）', () => {
  assertEquals(valueGateHtml(row).includes('安全边际 4.35pp'), true);
  assertEquals(valueGateHtml(row).includes('4.35%'), false);
  const top = { batch: '2026-10-11', top10: [{ ...row, pool_rank: 12, pool_n: 200 }] };
  assertEquals(renderValueTop10(top).includes('安全边际 4.35pp'), true);
  assertEquals(renderValueTop10(top).includes('池内 P94'), true);
  const drows = [v('a',95,30,6), v('b',50,50,3), v('c',10,95,1), v('d',92,28,5), v('e',90,20,4)];
  const dstate = { batch: '2026-10-11', rows: new Map(drows.map(r => [r.code, r as never])) } as never;
  assertEquals(renderDivergeBoard(dstate).includes('安全边际 6.00pp'), true);  // 第三处沿用 2 位小数
});
```

第二条同时把 **F-3(e)**（Top10 的「池内 P」）纳入断言：`pool_rank=12, pool_n=200` → `100 − 12/200×100 = 94`。两个断言合起来才能杀死变异 M6（把任一处的 `valueFmtPp` 还原成 `valueFmtPct`）。


#### F-9｜F-1 的连带改正：前视脚本里两处「前端另含池外持仓行 / 微小漂移」在 F-1 之后成了假话

F-1 落地后，前端分歧榜的总体**就是**池内，脚本与页面共用同一个宇宙。但 `scripts/value_forward_check.ts` 里有两处仍宣称两边不同总体（那是修复轮 2 为**当时确实存在**的分叉写的告警）：

- `L50-51` 注释：`// 【已知且必声明的 drift】前端总体还会带进「池外的自家持仓行」…本脚本在后端跑、不知道持仓 → 两边百分位次序可能有微小漂移…`
- `L136` CLI 打印：`console.log(\`总体：池内 A 级且两分齐备 ${uni.length} 只；前端分歧榜另含「池外持仓行」，本脚本不知持仓→百分位次序可能有微小漂移\n\`);`

留着它们，Task 10 干跑时读到的**第一行总体说明就是错的**，而那份输出正是「判生死」的取证材料——这属于交付物里的事实错误，不是措辞问题。

改成（**只改这两处注释与这一行 console.log 的字符串；`forwardUniverse` / `classify` / `decileTable` 的实现一字不动**）：

```ts
// L50-51 两行注释 → 换为（注意：新文本自身不得含「池外持仓行」「微小漂移」两个词组，否则下面的 grep 自检与本文自相矛盾；实现者实际落的写法已回写于此）：
// 【与前端同一总体】本脚本与 index.html 的 divergeLists 取同一个宇宙：池内 + A 级 + 两分皆为 number。
// 终审 I-1 之前前端缺 in_pool 判据（一只池外的持仓行会挤掉他人分位：600519 由 87.5→70 直接出榜），F-1 已补齐那一侧；
// 此后两侧再分叉就是缺陷，不再作为「已知漂移」声明。数据形态差异（vq 回字符串）另见上方 isScore 的注释。

// L136 console.log → 换为：
  console.log(`总体：池内 A 级且两分齐备 ${uni.length} 只（与前端分歧榜同一总体，F-1 已补齐前端的 in_pool 判据）\n`);
```

**自检**（两条都必须为 0，且测试条数不变；注意 `grep -c` 命中 0 时 exit 1，那是预期结果）：

```bash
grep -c "微小漂移" scripts/value_forward_check.ts    # 期望 0
grep -c "池外持仓行" scripts/value_forward_check.ts   # 期望 0
grep -c "^Deno.test" scripts/value_forward_check_test.ts   # 期望 15（本单不动这个文件）
```
---

#### 控制方自行处理（不进本单，实现者不许碰）

- **`docs/superpowers/specs/…-design.md` 回写**（用户已明示授权）：§11 加一句 M-3 的后果签字——「`swap_suggest` 不落持久化，**不参与 §8 前视验证**；§9.6 那个例外的取证范围仅到『前端纯逻辑正确』为止」；§7.1 的「否决标记」列按 N-2 归给 §7.4 胶囊（`renderValueTop10` 先 `filter(tier==='qualified')`，该列在 Top10 卡逻辑上恒空）。
- **plan 自身的 4 处误导（控制方已就地处置，实现者不必碰）**：叙述句里「前端总体=池内(+持仓)」已加实况限定（F-1 之后前端总体就是池内）；Task 7 的 `valuePillHtml` 代码行与接口契约行已按 F-2/F-3 终态改写；「两边百分位次序可能有微小漂移」的**降级表述是错的**（终审实测证明它能直接改变成员资格），其**交付物侧**的两处已列为本单 **F-9** 交实现者执行，plan 正文侧由 N-4 注记第 ③ 条收回；`value_forward_check_test.ts` 第 9 条测试名「与前端 divergeLists 同过滤器」在 F-1 之前名不副实、**F-1 落地即自洽，故不改名**（改名会无谓改动 Task 9 已闭合的交付物）。
- **提交边界**：向 `.gitignore` 追加 `site/`、`.deploy-site/`、`.vercel-tmp/`、`.wrangler/` 四行（用户选定）。**这是仓库根配置改动，由控制方在提交步骤里单独做、单独复述**，不放进本单。

**预期计数（preflight16 已机械化实测坐实）**：`deno test -A supabase/functions/stock-value/` = **49 + 1(F-3f poolRanks) + 1(F-3f buildDbRows 接线) + 1(F-4 新增) = 52**；Step 5b 再 +7（M5/M6/成功载荷/失败载荷/upsert 分块语义 3 条）= **59**（2026-10-12 实测）；`deno test -A scripts/` = **115 + 1(F-1) + 1(F-7g) + 1(F-8 配套) = 118**；`supabase/functions/daily-update/` 仍 **4**。其余判据：`deno check` 全部改动文件无诊断；`deno lint scripts/value_forward_check.ts` **0 problems**；`deno lint scripts/` **总数仍为 9**（不得为过 lint 改 `https://deno.land/std@0.224.0` 的 import 写法）；`deno task verify-bundles` **5 ✅**（F-6 之后 deploy.ts 必须已由新 build.ts 重生成，重跑时逐字节一致；站点实测产物 **46138 bytes**，含 buildDbRows 与 valueFmtPp 后的终态。**字节数不是判据**：实现者实跑为 46137B，差异来自注释行文（反引号/虚词）与函数落位顺序，属噪声；真判据是「`diff -B` 对旧形态为空 + 恰 +2 空行 + verify-bundles 5 ✅ + 两道构建期门禁未被弱化」。

**preflight16 的六条变异必须全部被杀**（删 F-1 的 `in_pool` 判据 / 还原 F-2 胶囊判断顺序 / 从 `buildDbRows` 摘掉 `pool` 实参 / 摘掉 F-4 的 1231 谓词 / F-7 改回 `push(use[i])` / 任一处的 `valueFmtPp` 还原为 `valueFmtPct`）——任何一条存活即该发现未被真正解决。控制方实测结果：**六条全杀**（M3 在引入 `buildDbRows` 之前**存活**，这是本单把接线抽成纯函数的唯一理由）。

**不得改动面**：`value_engine.ts` 的门禁/否决/分位**实现**一字不动（本单不碰引擎逻辑，只在编排层加分位）；`80/50` 与 `SWAP_GAP` 阈值、`VCOV_MIN`、`ROIC_GATE` 不动；`forwardUniverse`/`classify`/`decileTable`/`klineSymbol`/`med`/`pctMap` 实现不动（Task 9 已闭合， parked 的 N-6/N-7 不在本单）；`migrate_stock_value.sql` 除 F-3(a) 那一行外不动（尤其**不许**给 `rf_fallback`/`vetoed` 加 default——Task 1 裁定的「无 default 才能把漏写变成整批报错」）；`fixtures/vq5_sample.json` 等真响应快照**只读不改**；查询串 `not.is.null` 文法不动；`GS_API_KEY` 等凭据不许出现在任何文件；全程零 git 写、零生产写、不运行 `value_forward_check.ts` 本体、不打任何写端点。

**parked 但不进本单（终审席已判定级，控制方同意）**：Task 9 的 N-6（`groupCompare` 里 `med` 的 `sort` 不承重）与 N-7（丢了 n=1 单成员组断言）——席上的理由被控制方接受：属测试强度缺口而非实现缺陷，且前视脚本尚未真跑过一次 DB 读，在 Task 10 干跑步骤里顺带补这两条用例成本为零。**处置：Task 10 的干跑步骤前补，不卡提交。**

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
-- 不得只信 `create table if not exists`：若表已在（或曾用旧版 SQL 建过），它会静默跳过、不补 not null 约束
select column_name, is_nullable, column_default from information_schema.columns
  where table_schema='public' and table_name='stock_value' and data_type='boolean';
```

Expected: 两表存在；每条策略 `roles = {anon,authenticated}`、`cmd = SELECT`；布尔列里 **`rf_fallback` 与 `vetoed` 必须 `is_nullable = NO` 且 `column_default` 为空**（Task 1 裁定：无 default 才能把“漏写”从静默存 false 变成整批报错），`in_pool` 允许 `default false`。不符 → 迁移未真正生效或建的是旧版表，停下上报，不得继续 Step 3。登录用户可读是 I-1 教训的验收点，**必须实际登录一次用前端读取确认**，不能只看 pg_policies。

- [x] **Step 3: 函数部署（2026-10-12 实做：`stock-value` v1 `ACTIVE`，`verify_jwt=false`）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && deno task verify-bundles   # 全绿才允许部署
# entrypoint_path 必须是 **deploy.ts**（不是 index.ts）：上传的是单文件 bundle，
# 平台把它放在 source/ 下，写 index.ts 会返回 400 "Entrypoint path does not exist"。
# 该形态以线上已跑通的 stock-score(v7)/sector-trend(v15) 为权威：GET /functions/<slug> 的 entrypoint_path 均以 source/deploy.ts 结尾。
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=stock-value" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F 'metadata={"entrypoint_path":"deploy.ts","import_map_path":"","verify_jwt":false,"name":"stock-value","no_cache":true};type=application/json' \
  -F "file=@supabase/functions/stock-value/deploy.ts;type=application/typescript"
```

Expected: 返回 `version` 自增、`status: ACTIVE`。先 `GET /v1/projects/$REF/functions` 确认令牌与当前版本列表。

- [x] **Step 4: secrets（2026-10-12 核对结果：零写入）**

secrets 值一律从现有 `stock-score` 函数复制，**绝不在终端回显**；写入方式用 Management API secrets 端点，命令参数从环境取。

> 实况：Edge Function 密钥是**项目级共享**的。`GET /secrets` 的名字清单里 `DAILY_UPDATE_TOKEN`/`GS_API_KEY`/`SUPABASE_URL`/`SB_SERVICE_KEY`/`SUPABASE_SERVICE_ROLE_KEY` 全部已在，新函数部署即自动继承 ⇒ **本轮不需要任何密钥写入**。真正的验收以 Step 5 的 ping 为准（它同时证明两个密钥都可用：无 `DAILY_UPDATE_TOKEN` 会 401，无 `GS_API_KEY` 会 500）。

- [x] **Step 5: ping 验证（无数据写；2026-10-12 实测 `200 {"ok":true,"rows":5171}`）**

```bash
curl -s -H "Authorization: Bearer $DAILY_UPDATE_TOKEN" "$URL/functions/v1/stock-value?mode=ping"
```

Expected: `{"ok":true,"rows":5000+}`。若 rows 明显偏低（<4000）→ P-3 列族丢弃，先排查措辞，不得进入 Step 6。

**认证取值的陷阱（Step 5 实跑发现，适用于所有要调生产函数的步骤，含 Step 6/8）**：`GET /v1/projects/{ref}/secrets` 返回的 `DAILY_UPDATE_TOKEN` **不是运行时生效的那一份**（实测两侧都是 64 位 alnum 但 md5 不同：库里 `de189cc7` vs 生产可用 `11dc16fe`）；拿它去 ping 任何函数（包括已跑通的 `stock-score`）一律 401 `unauthorized`，极易误判成“新函数没拿到密钥”。真正可用的值在 `cron.job.command` 里（`substring(command from 'Bearer ([A-Za-z0-9]+)')`）。**比较两份凭证用 md5，不要把值本身打到终端**；从 `cron.job` 取回后用完立即清零临时文件。另：本机对 `*.supabase.co` 的出网会间歇 `Connection reset`（urllib/curl 均遇过），**失败重试 3–4 次再下结论**。

- [ ] **Step 5b: 部署前的 index.ts 遥测收口（Task 6 评审 parked 的 M3/M5/M6；只动 `index.ts`，改完必须重跑 build.ts + verify-bundles）**

- **M3** `kept_old_batch` 在 upsert 中途失败时不准确：`upsert` 无事务，5224 行分 6 块，第 4 块失败时前 3 块已落库而响应仍称「旧批保留」，而前端（Task 7）读「最新批次」会拿到截断宇宙。修法：`let wrote = false;` 在首个 chunk 前置真，响应改 `kept_old_batch: !wrote`。
- **M5** `in_pool` 与 `main_final` 有两个池真值源（`main.map` 取上一夜标为 in_pool 的主分行，`in_pool` 列取今晚的 `stock_pool`）：改池当晚新入池行 `main_final=null`，分歧榜归因静默缺席。修法：响应加 `main_missing` 计数（池内但 `main.map` 无该裸 6 位码的行数）。
- **M6** 主分快照无龄期校验：stock-score 连失败夜时会把陈主分当今晚快照落库。修法：`batch_date` 距 `main_batch` 超 3 天则响应加 `main_stale: true`（不炸批，符合旁路「尽力而为」纪律）。

**Step 5b 终态（2026-10-12 实做，含控制方新发现）**：三条修法若直接内联在 handler 里，就重犯了终审 I-3 的错（接线不在测试路径上）——变异检验把 `main_missing` 一行删掉、把 `kept_old_batch` 退回硬编 `true`，11 条测试全照绿。因此本轮把它们抽成导出的纯函数，与 `buildDbRows` 同款：

```ts
export function countMainMissing(computed: ValueRow[], poolSet: Set<string>, mainMap: Map<string, MainSnap>): number;
export function isMainStale(batch: string, mainBatch: string | null, maxAgeDays = 3): boolean;
export function runSummary(computed, batch, poolSet, main, resolved, divLegOk, finRoeRows, stamps): Record<string, unknown>;
export function errorBody(msg: string, wrote: boolean): Record<string, unknown>;   // {ok:false,error,kept_old_batch:!wrote}
export async function upsert(rows, onChunkSent?, post = fetch): Promise<void>;      // post 可注入；每发一块先 onChunkSent?.() 再看状态
```

关键裁定：**M5 的谓词不吃 `r.in_pool`**（`ValueRow` 根本不产出该字段，池信息属编排层，与 `poolRanks` 同理），改吃 `poolSet`；`deno check` 会当场拒掉写错的版本，变异 NB4 亦被杀。`kept_old_batch` 的真值由 `upsert` 的 `onChunkSent` 回调供给（声明在 `try` 外面，否则 `catch` 看不见）。

新增 7 条测试（52 → **59**）：`countMainMissing` / `isMainStale` / `runSummary` / `errorBody` 各一，`upsert` 三条（分块尺寸 1000/1000/500 且报告 3 次；第 2 块被拒仍报告 2 次并抛错；空行集一块不发）。

变异检验（`preflight17/mutate5b.py`，隔离副本 `/tmp/p5b2`）：**NB1–NB5 全杀，NB6/NB7 存活**。存活的两条是 handler 调用点的池参数（不把 `poolSet` 递给 `runSummary` / `buildDbRows`）——要覆盖它必须真跑 handler，而本仓库 10 个 Edge Function 无一有 serve 级测试先例。**Ruling**：不在此引入 serve 级假 fetch 框架（4000 行×4 表的夹具量与新架构风险，都落在部署前这道时间门上）；改为把这两条变成 **Step 6/7 的机械化验收项**（见下），即在真实数据上一次性证明接线，比离线桩更强（它同时验到 RLS 与列名）。若 Step 6/7 任一断言不过 → 停下修，不得进 Step 8 注册 cron。

- [ ] **Step 6: 首跑 `mode=run`（⚠ 需用户明示）**

```bash
curl -s -X POST -H "Authorization: Bearer $DAILY_UPDATE_TOKEN" "$URL/functions/v1/stock-value?mode=run"
```

Expected 响应字段逐项核对：`rows ≥ 4000`、`qualified > 0`、`vetoed ≥ 0` 且比例可解释、`cn10y_source ∈ override/auto/none`、`div_leg_ok` 为布尔、**`fin_roe_rows` ≥ 池内金融股数量**（若该数接近 0 而有大量 `isFin` 行，即 `finRoe` 键序回归或摊薄列未绑上）、**`stamps.div_period` 与 `stamps.roe_period` 必须以 `1231` 结尾且年份 = 当年 `annualBase`**（Task 6B：若不是 1231，GS 回的是季报/中报**累计非年化**值，而否决4 拿它跟 8% 这个年化阈值比 → 停下重新裁定，不得当正常数据上线）。

**Step 6/7 必须补的两条机械化断言（承接 Step 5b 存活的变异 NB6/NB7，它们不在任何测试路径上）**：

```sql
-- (a) pool_rank 接线：本批池内有现行的行数必须 > 0，且与 stock_value 的 pool_rank 非空数一致
select count(*) filter (where in_pool and vq is not null) as pool_scored,
       count(*) filter (where pool_rank is not null)       as pool_rank_set
from public.stock_value where batch_date = current_date;
-- (b) main_missing 接线：响应里的 main_missing 必须等于下面这个直查值
select count(*) from public.stock_value v
where v.batch_date = current_date and v.in_pool
  and not exists (select 1 from public.stock_score s
                  where s.batch_date = (select max(batch_date) from public.stock_score) and s.code = v.code);
```

(a) 若 `pool_rank_set = 0` 而 `pool_scored > 0` ⇒ `buildDbRows` 的池参数在 handler 里接错了；(b) 若响应 `main_missing` 为 `undefined`/`0` 而直查 > 0 ⇒ `runSummary` 接错。两者都是**停下修**，不得因“数字看着合理”放行。
**`vetoed` 的银行名单人工抽检**：抽 3-5 家在 `stock_pool` 里的银行，看 `veto_reasons` 含「无护城河证据」者其 `roe`（对照 `extras.stamps.roe_period` 那一期）是否真 <8%——Task 6B 前后的差异就应体现在这里。
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
