# 个股评分 V1.1 增补 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 V1.1 增补 spec 落地 A 层（低基数保护/PEG降权/现金含量/标记/置信度）+ C 层（混合业务识别与池修正）+ B 层（探针通过后实施），新浪 K 线作增强与对账通道。

**Architecture:** 沿用 V1.0 分层：纯函数引擎（engine.ts）→ GS/新浪适配器（gs.ts/sina.ts）→ Edge 编排（index.ts）→ build.ts 打包部署；C 层主营结构由独立低频函数 `business-mix` 维护 `stock_business_mix` 表，nightly 评分只读表。

**Tech Stack:** Deno/TypeScript（Supabase Edge Runtime）、Supabase REST + pg_cron + pg_net、东财 F10 PageAjax、新浪日K JSON API、单文件前端 index.html。

**Spec:** `docs/superpowers/specs/2026-09-27-stock-scoring-v1.1-design.md`（裁决表 §9 与本文冲突时以 spec 为准；本计划对 §5.3"新股单只补拉"有一处修订，见 Task 6 备注）。

## Global Constraints

- 四因子总权重 Q30/G30/V20/M20 固定；因子内权重见 spec §4.3/§8；
- 异常/风控信号只标记不扣分（封顶/降权是 spec 明确定义的规则，不属于"扣分标记"）；
- 核心评分输入只依赖 GS；新浪/东财失败必须静默降级，不得阻塞跑批或覆盖旧批次；
- 不在任何文件/日志中硬编码或明文输出 key；网络错误消息脱敏（沿用 gs.ts L67-70 模式）；
- GS 列名一律前缀匹配，绝不硬编码日期戳（gs.ts 头部纪律）；
- 测试命令：`deno test supabase/functions/stock-score/`（engine/sina 测试无需网络权限；涉及 fetch 的用 `--allow-env --allow-net` 仅运行对应测试文件）；
- 部署走 Management API（PAT 当次向用户索取或复用会话内已提供的），项目 ref `sfauluwxmdginezbluvo`；触发跑批用 pg_net `net.http_post`（本机到 `*.supabase.co` 数据面被重置，Management API 正常）。

---

### Task 1: DDL — confidence 列 + stock_business_mix 表

**Files:**
- Create: `scripts/migrate_v11.sql`
- Modify: 无（线上经 Management API `/database/query` 执行）

**Interfaces:**
- Produces: `stock_score.confidence CHAR(1)`；`stock_business_mix(code text PK, report_date text, segments jsonb, mixed boolean, shift boolean, updated_at timestamptz default now())`，anon 只读。

- [ ] **Step 1: 写迁移 SQL**

```sql
-- scripts/migrate_v11.sql
alter table stock_score add column if not exists confidence char(1);

create table if not exists stock_business_mix (
  code text primary key,
  report_date text,
  segments jsonb,          -- [{name, ratio}] 按国标行业 MAINOP_TYPE='1'
  mixed boolean not null default false,
  shift boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table stock_business_mix enable row level security;
create policy "mix anon read" on stock_business_mix for select to anon using (true);
grant select on stock_business_mix to anon;
```

- [ ] **Step 2: 执行并验证**

Management API 执行后验证：`select count(*) from information_schema.columns where table_name='stock_score' and column_name='confidence'` = 1；`stock_business_mix` 存在且 0 行。

- [ ] **Step 3: Commit** `git add scripts/migrate_v11.sql && git commit -m "feat(stock-score): V1.1 DDL confidence 列 + stock_business_mix 表"`

---

### Task 2: 探针 — GS 新增列可得性 + B 层历史列（一次性，产出决定后续措辞）

**背景:** 本任务不用 TDD——产物是**列名字典**，供 Task 4/5 的适配器与引擎分支使用。

**Files:**
- Create: `.superpowers/sdd/…/probe-columns.md`（git-ignored 工作区内的记录，非仓库文件）
- 临时脚本不落库（/tmp）

- [ ] **Step 1: A 层扩列探针**——GS 查询措辞试：
`全部沪深A股的经营现金流与净利润的比值、销售毛利率同比增长率、净资产收益率、销售毛利率`（各词分别再单独发一次小查询避免归因失败）。记录返回的确切列名前缀、非空率、奥来德(688378)抽样值。
期望：现金比值（TTNNJLRTBL 类）非空率 >80%；毛利率同比列存在。

- [ ] **Step 2: B 层历史列探针**——措辞试：
`全部沪深A股2023年报、2024年报、2025年报的净资产收益率`，验证 spec §8 三条：列存在、非空率>80%、奥来德三值 ≈ 7.20/5.15/4.22（允许 ±0.3 容差）。
再试 `近3年营业总收入复合增长率`。

- [ ] **Step 3: 新浪数据面连通性**——从本机与 Edge Runtime 各发一次 `getKLineData?symbol=sh688378&scale=240&datalen=70`，确认返回 70 根。若 Management API 可查函数日志则部署冒烟留到 Task 5。

- [ ] **Step 4: 记录结论**——把确切列名前缀、探针通过/失败写入 `B_LAYER=pass|fail` 判定，交回控制器。失败则 Task 4/5 走 A-only 分支（引擎代码已用可选字段设计，不阻塞）。

---

### Task 3: 引擎 V1.1 改造（TDD）

**Files:**
- Modify: `supabase/functions/stock-score/engine.ts`
- Modify: `supabase/functions/stock-score/engine_test.ts`

**Interfaces:**
- Consumes: 无外部依赖（纯函数）。
- Produces:
  - `Stock` 新增可选字段：`cash?: number|null`（现金含量比值）、`mlrYoy?: number|null`（毛利率同比 pp）、`mixed?: boolean`（C 层由编排注入，true→百分位组强制 'MARKET'）、`roe3y?: (number|null)[]`、`cagr3?: number|null`、`mlrDelta?: number|null`（B 层，探针通过才填充）；
  - `ScoreRow` 新增：`confidence: 'A'|'B'|'C'`、`lowBase: boolean`；
  - `computeScores(all: Stock[]): ScoreRow[]` 签名不变。

- [ ] **Step 1: 写失败测试（A 层规则）**

```ts
// engine_test.ts 追加（沿用现有 deno.test 模式与构造辅助函数；若无辅助构造函数则内联完整 Stock 字面量）
Deno.test('V1.1 低基数: 扣非>200% → growth封顶85 + lowBase flag + PEG 无效化', () => {
  const mk = (kc: number): Stock => ({ code:'1.SH'+kc, name:'T'+kc, ths:['电子','半导体'], roe:10, mlr:30, kc, gm:10, rev:10, debt:40, pe:60, isFin:false, isST:false, r60:5, close:10, a20:9, a60:8 });
  const base = mk(50); const boom = mk(2514);
  // 造 24 只同组对照股使百分位有意义
  const crowd = Array.from({length:24}, (_,i)=>({ ...base, code:'C'+i }));
  const rows = computeScores([...crowd, boom]);
  const r = rows.find(x => x.kc === 2514)!;
  assert(r.growth !== null && r.growth <= 85);
  assert(r.lowBase && r.flags.includes('low_base_growth'));
  assert(r.peg === null);            // PEG 判无效 → Value 单腿
});

Deno.test('V1.1 现金含量入 Quality: ROE50/毛利率35/现金15, 金融股现金置 NA', () => {
  // 构造两只 isFin 相同、仅 cash 不同的股票 → quality 不得有差异；
  // 非金融两只仅 cash 差异 → quality 有差异且高 cash 者更高。
});

Deno.test('V1.1 毛利率恶化: rev>=30 且 mlrYoy<=-5 → flag, 不改分数', () => { /* 同宇宙 neuter 对比 */ });

Deno.test('V1.1 拥挤度: 60日涨幅组内>=95分位 且 close>a60*1.15 → momentum_crowded', () => { /* 25 只组，1 只极端 */ });

Deno.test('V1.1 置信度: C=降级且ind_n<20或两因子null; B=任一flag; A=其余', () => { /* 三种构造 */ });

Deno.test('V1.1 混合业务: mixed=true → grp=MARKET, 百分位按全市场宇宙', () => {
  // 小行业组(8只)中一只标 mixed → 其 grp==='MARKET' 且不产生 L2 组内排名依赖
});
```

实现测试前先跑 `deno test` 确认新测试 FAIL（字段不存在时 TS 编译错误即失败信号）。

- [ ] **Step 2: 实现引擎改动**

```ts
// engine.ts 关键改动（完整实现按此规格展开）：
// 1) assignGroups 顶部: if (s.mixed) { out.set(s.code, 'MARKET'); continue; }
// 2) pegOf 增加低基数否决:
const isLowBase = (s: Stock) => s.kc !== null && s.kc > 200;
function pegOf(s: Stock) {
  if (isLowBase(s)) return null;
  /* 原条件不变 */
}
// 3) 新增百分位:
//    cash:  entries(s => s.isFin ? null : clamp(s.cash, -0.5, 2))   → pct.cash
//    mlrYoy: entries(s => s.mlrYoy)                                  → pct.mlrYoy（仅标记用，不进分）
// 4) Quality:  A 层 renorm([[roe,50],[mlr,35],[cash,15]])
//    B 层（s.roe3y 提供时）中位数百分位加入: [roe,35],[mlr,25],[cash,15],[roeMed,25]
//    （roeMed = s.roe3y 过滤 null 后中位数，>=2 个值才有效，百分位走 pctFromEntries 组内）
// 5) Growth:  B 层权重 扣非35/归母15/营收50 → [kc,25],[gm,10],[rev,30],[cagr,20],[mlrDelta,15]（cagr/mlrDelta 百分位存在时）
//    封顶: const gr0 = renorm(...)[0]; const gr = gr0 !== null && isLowBase(s) ? Math.min(gr0, 85) : gr0;
// 6) flags 组装（在既有 debt flag 基础上追加）:
//    lowBase → 'low_base_growth';  mixed → 'mixed_business';
//    s.rev>=30 && s.mlrYoy!==null && s.mlrYoy<=-5 → 'margin_deterioration';
//    crowdedOf(s, pct.r60) → 'momentum_crowded'   // pct.r60.get(s.code)>=95 且 close>a60*1.15（r60/close/a60 任一 null 则不判定）
// 7) Value/Momentum 结构不动（PEG 失效由 pegOf 返回 null 自然触发单腿 renorm）；
// 8) confidence（排名计算之后回填）:
//    let conf: 'A'|'B'|'C';
//    const nulls = [q,gr,v,mo].filter(x=>x===null).length;
//    if ((r.indN<20 && r.grp==='MARKET') || nulls>=2) conf='C';
//    else if (nulls===1 || r.flags.length>0) conf='B';
//    else conf='A';
```

注意 B 层字段全部走"存在则参与、缺失 renorm"路径——探针失败时编排层不传，引擎零改动退回 A 形态。

- [ ] **Step 3: 全部测试通过 + 既有测试不回归**

Run: `deno test supabase/functions/stock-score/engine_test.ts` Expected: PASS（新旧全部）

- [ ] **Step 4: Commit** `feat(stock-score): V1.1 引擎——低基数封顶/PEG否决/现金含量/标记/置信度/混合池强制`

---

### Task 4: gs.ts 扩列 + sina.ts 新模块

**Files:**
- Modify: `supabase/functions/stock-score/gs.ts`、`gs_test.ts`
- Create: `supabase/functions/stock-score/sina.ts`、`sina_test.ts`（纯计算部分可测）

**Interfaces:**
- Consumes: Task 2 探得的**确切列名前缀**；Task 3 的 `Stock.cash/mlrYoy` 字段。
- Produces: `mergeTables` 返回含新字段的 Stock[]；`dailyKline(symbol): Promise<Kbar[]>`、`ma(closes, n): number|null`、`retN(bars, n): number|null`；`sinaSymbol(code) => 'sh600000'|'sz000338'|'bj...'`。

- [ ] **Step 1: sina.ts（含失败脱敏 + 超时）**

```ts
/// <reference lib="deno.ns" />
export interface Kbar { day: string; close: number }
const SINA = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData';
export function sinaSymbol(code: string): string {
  const c = code.split('.')[0]; const mkt = code.split('.')[1] ?? '';
  const p = mkt === 'SH' || c.startsWith('6') ? 'sh' : mkt === 'BJ' || /^[48]/.test(c) ? 'bj' : 'sz';
  return p + c;
}
export async function dailyKline(symbol: string, datalen = 70): Promise<Kbar[]> {
  const r = await fetch(`${SINA}?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`sina http ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('sina bad payload');   // 不打印 payload
  return j.map((b: {day:string;close:string}) => ({ day: b.day, close: parseFloat(b.close) }));
}
export function ma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}
export function retN(bars: Kbar[], n: number): number | null {   // 区间涨跌幅 %
  if (bars.length < n + 1) return null;
  const prev = bars[bars.length - 1 - n].close, last = bars[bars.length - 1].close;
  return prev > 0 ? (last / prev - 1) * 100 : null;
}
```

sina_test.ts：sinaSymbol 三分市场、ma/retN 硬值（手算数组）、dailyKline 解析失败抛错（用坏 JSON 的纯函数 `parseKline` 抽出测试，不打网络）。

- [ ] **Step 2: gs.ts Q_FIN 更新**（措辞 = 原 8 指标 + 现金比值 + 毛利率同比 + B 层历史列[仅探针通过]），`mergeTables` 按 Task 2 记录的确切前缀接线 `cash/mlrYoy(/roe3y/cagr3/mlrDelta)`；B 层字段探针失败时保持不赋值（可选字段）。
- [ ] **Step 3: gs_test.ts fixtures 重生成**——真实跑一次新 Q_FIN（全池），按现有 fixture 纪律裁剪 58 行存 `fixtures/fin_sample.json`（列数组与代码列同一 idx 取值，防 Task 3 旧错位复发）；新增断言：新列前缀匹配成功、奥来德 cash/mlrYoy 值与 Task 2 记录一致。
- [ ] **Step 4: `deno check` + 全量本地冒烟**——临时脚本跑全量 fin+mom → computeScores → 打印 5021 行分布、low_base 计数、A/B/C 比例。Expected: low_base 占比 <3%（spec §7.2）。
- [ ] **Step 5: Commit** `feat(stock-score): GS V1.1 扩列 + 新浪日K模块（增强/对账通道）`

---

### Task 5: business-mix 函数（东财主营结构，低频分批）

**Files:**
- Create: `supabase/functions/business-mix/index.ts`、`mix.ts`（纯解析）、`mix_test.ts`、`build.ts`（复制 stock-score 模式）

**Interfaces:**
- Produces: 表行 `{code:'000338', report_date:'2026-06-30', segments:[{name,ratio}], mixed, shift}`；HTTP `?mode=run` 每晚处理 300 只。

- [ ] **Step 1: mix.ts 纯函数（TDD）**

```ts
export interface MixSeg { name: string; ratio: number }
export interface MixVerdict { reportDate: string; segments: MixSeg[]; mixed: boolean; shift: boolean }
// decide(zygcfxRows, 'MAINOP_TYPE'=1):
//   按 REPORT_DATE 取最近一期；ratio=MBI_RATIO；降序；
//   top1 >= 0.70 → {mixed:false, shift:false}
//   top1 < 0.70 && top2 >= 0.25 → {mixed:true}
//   其余 → {shift: top2 >= 0.10}    // business_shift 记录用，不影响评分
//   无 MAINOP_TYPE='1' 行 → null（跳过该股票）
```

测试硬值：奥来德实测数据（60.4/39.4 → mixed:true，2025A 期；2026H1 按行业码口径重算，测试用真实返回样本）。

- [ ] **Step 2: index.ts 编排**

流程：读 `stock_pool` 全代码 → 与 `stock_business_mix` left join → 取 `updated_at` 最旧（null 优先）300 只 → 逐只 `fetch('https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=SH688378'形式)`（市场前缀：6→SH，0/3→SZ，4/8→BJ）→ 并发 4、每请求间隔 150ms、失败重试 1 次后跳过 → `decide` → upsert `stock_business_mix`（on_conflict=code，`Prefer: resolution=merge-duplicates,return=minimal`）。
认证、svcHeaders、脱敏模式与 stock-score/index.ts 完全一致（DAILY_UPDATE_TOKEN 校验）。
返回 `{ok, processed, mixed, shift, skipped}`。

- [ ] **Step 3: build.ts + 本地测试** `deno test supabase/functions/business-mix/`（仅 mix_test.ts，无网络）

- [ ] **Step 4: Commit** `feat(business-mix): 东财主营构成低频批函数——混合业务判定`

> **spec §5.3 修订记录:** "新股入池时 stock-score 单只补拉"改为**不实现**——分批任务每晚 300 只、按最旧 updated_at 轮转，新股 1-2 晚内自然覆盖；避免 nightly 内嵌未测外部依赖。Ruling 同步回填 spec §9（R7）。

---

### Task 6: stock-score 编排接入（mix 表 + 新浪增强 + 对账）

**Files:**
- Modify: `supabase/functions/stock-score/index.ts`
- Modify: `supabase/functions/stock-score/build.ts`（拼接清单加 sina.ts）

**Interfaces:**
- Consumes: Task 3 `Stock.mixed/confidence`、Task 4 `sina.ts`、Task 5 表。
- Produces: upsert 行新增 `confidence`；`extras` 新增 `implied_normal_pe`、`crowded_src`；warnings 新增对账偏差项。

- [ ] **Step 1: 读 mix 表注入**

```ts
const mixResp = await fetch(`${url}/rest/v1/stock_business_mix?select=code,mixed,shift,segments,report_date`, { headers: svcHeaders() });
const mixMap = new Map<string, any>();  // 表空 → 空 Map → C 层静默跳过（spec §5.3）
if (mixResp.ok) for (const m of await mixResp.json()) mixMap.set(m.code, m);
for (const s of stocks) {
  const m = mixMap.get(s.code.split('.')[0]);
  if (m?.mixed) s.mixed = true;
}
```

rows 计算后把 `m.segments`（前两项名称+占比）塞进对应输出行的 extras。

- [ ] **Step 2: 新浪拥挤度增强（失败静默）**

```ts
// 仅池内 + Top50 候选（并集，≤1215 只）；并发 20；整体 try/catch 包裹，任何异常 → crowded 全缺省
async function enrichCrowded(codes: Set<string>, stocks: Stock[]) {
  try {
    await Promise.all([...codes].map(async (c) => {
      const s = stocks.find(x => x.code.split('.')[0] === c); if (!s) return;
      const bars = await dailyKline(sinaSymbol(c), 70);
      const m60 = ma(bars.map(b => b.close), 60);
      if (m60 && s.close !== null) s.crowdedRaw = { r60s: retN(bars, 60), above: s.close > m60 * 1.15 };
    }));
  } catch { /* 增强层，吞掉 */ }
}
```

（`crowdedRaw` 若不便进 Stock 接口，可传第二参数给 computeScores 或独立函数判旗——实现者选最小侵入方案，评审关注点。）

- [ ] **Step 3: 对账通道**——从池内固定取 20 只（按代码排序取每 58 只抽 1），新浪 r60 vs GS r60，|偏差|>2pp → 写入该行 warnings `['动量源偏差 x.x%']`。同样整体 try/catch。
- [ ] **Step 4: upsert 增列** `confidence: r.confidence`，`extras: { ..., implied_normal_pe, mix: m?.segments?.slice(0,2) ?? null }`；`implied_normal_pe = pe!==null && gm>0 ? pe*(1+gm/100) : null`（近似口径：按当年增速外推的正常化 PE，spec §4.6 的实现近似，记入 report）。
- [ ] **Step 5: `deno check deploy.ts` + build + Commit** `feat(stock-score): 编排接入混合池/置信度/新浪增强与对账`

---

### Task 7: 前端 — 徽标与明细行

**Files:**
- Modify: `index.html`（renderScoreTop10 / scorePillHtml / scoreDetailHtml，现 L562-600 一带）

- [ ] **Step 1: Top10 行**：名称后插置信度徽标 `<span class="conf-badge conf-{A|B|C}">{置信度}</span>`（CSS 三色：A jade/B 灰/C amber；新增 12 行内样式）；flag 展示沿用现有 `⚠ flags.join` 通道（low_base_growth 等自动出现）。
- [ ] **Step 2: 持仓明细展开区**（scoreDetailHtml）：四因子横条下加一行 `口径与置信度`：`（混合业务？'全市场口径 · 收入结构 设备62%/材料28%'：'行业池 '+ths_l2）· 置信度 B`；有 `extras.implied_normal_pe` 时加行 `当前利润增速正常化 PE ≈ xx（info-only）`。
- [ ] **Step 3: 降级**：`confidence==null`（旧批次）→ 不显示徽标；segments 缺 → 只显示池口径。**不新增网络请求**，仍走 scoreState 缓存。
- [ ] **Step 4: 本地验证**：起 http server，用 mock scoreState 在控制台断言渲染三种情形。Commit `feat(ui): V1.1 置信度徽标+混合口径标注+正常化PE揭示`

---

### Task 8: 部署链 + 注册 business-mix cron

- [ ] **Step 1:** Management API 部署 stock-score（deploy.ts，同 V1.0 参数）与 business-mix 两个函数。
- [ ] **Step 2:** pg_net 触发 ping 冒烟 ×2。
- [ ] **Step 3:** pg_net 触发 business-mix 首轮 300 只 → 验证表行数与奥来德行 mixed=true。
- [ ] **Step 4:** 注册 cron：`cron.schedule('business-mix-batch', '0 14 * * *', $$select net.http_post(...business-mix...)$$)`（14:00 UTC=北京 22:00，错开 21:30 stock-score）。
- [ ] **Step 5:** pg_net 触发 stock-score 全量（V1.1 首次跑批），完成后执行 Task 9 断言。
- [ ] **Step 6:** 留档 `scripts/cron_business_mix.sql`（token 占位符），Commit。

---

### Task 9: 验证断言 + 收尾

- [ ] **Step 1: spec §7 硬断言**（SQL 对账）：
  1. 奥来德 688378：`growth<=85 and peg is null and flags::text like '%low_base_growth%' and confidence='B'`；mix 表首轮覆盖后 `mixed=true and grp 口径为 MARKET`（首轮未覆盖则记"待第二批"，不阻塞）；
  2. `select count(*) filter (where flags::text like '%low_base_growth%')::float/count(*) < 0.03`；
  3. 持仓回归：潍柴 momentum<35、招行 quality 组内高位（对齐 V1.0 基线 75±5）；
  4. 记录本批 A/B/C 比例到 ledger 作基线。
- [ ] **Step 2:** GetProblems 全绿；`deno test supabase/functions/` 全量通过。
- [ ] **Step 3:** spec §9 回填 R7（新股补拉修订）；合并 main、推送 GitHub Pages（**当次向用户确认后再 push**）。
- [ ] **Step 4:** 最终全分支 CodeReview。

---

## 测试矩阵速查

| 模块 | 命令 | 网络 |
|---|---|---|
| engine_test.ts | `deno test .../engine_test.ts` | 无 |
| gs_test.ts | 同上（fixture 本地） | 无 |
| sina_test.ts | 同上 | 无（parse 纯函数化） |
| mix_test.ts | 同上 | 无（真实响应样本存 fixtures/） |
| 全量冒烟 | 临时脚本（Task 4 Step 4） | GS，本地可通 |
| 部署验证 | pg_net via Management API | 服务端 |
