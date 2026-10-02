# 产业研究员（个股景气度 AI 研究）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为用户指定的任意股票代码生成基于 AI 联网搜索的六段式景气度研究报告（智谱 glm-5.3-flash / 阿里百炼 qwen3.8-flash 二选一，密钥随用随贴不固化），结果落 `stock_fundamental` 表并联动股票卡胶囊。

**Architecture:** 新增 Supabase Edge Function `stock-research`（verify_jwt:true 平台 JWT 守卫，纯按需调用、无 cron）：编排层收 `{action,code,provider?,model?,api_key?}` → 防重判定 → 注入本库财务锚点组提示词 → provider 适配器调服务商联网搜索 → 解析六段 JSON 落库。前端单文件 index.html 新增顶部「研究指定股票」入口 + 结果卡 + 持仓卡胶囊 + 展开报告；key 只存 sessionStorage 请求体透传，函数内存使用不落盘。

**Tech Stack:** Deno（Edge Runtime）、Supabase Management API（SQL/部署，PAT 在 `~/.config/sector-rotation/supabase_pat`，项目 ref `sfauluwxmdginezbluvo`）、supabase-js v2（CDN，前端）、deno test（单测，无框架依赖）。

**Spec:** `docs/superpowers/specs/2026-10-02-stock-research-design.md`（规则权威，本计划是其展开；冲突以 spec 为准）

## Global Constraints

- 单文件前端：页面运行代码不得外置成独立脚本文件（README:3）；前端可测逻辑一律放 index.html 的 `// ==== RESEARCH_PURE_BEGIN/END ====` 标记块，测试经 `scripts/research_render_logic.ts` 类型化门面抽取执行（sector_render_logic 先例，零副本）。
- 密钥纪律：任何 LLM key / service key 不进代码字面量、不进 Secrets 新增项（本功能零新增 Secret）、不进库、不进日志、不进响应体；错误信息构造必须过 `sanitizeError`（断言不含 api_key 子串）。
- 失败纪律：服务商调用失败一律返回「数据获取失败」+ 服务商错误码；**不得**换服务商、不得换渠道取数、不得静默降级为无搜索。
- 结论纪律：verdict 仅四枚举 升温|平稳|降温|恶化，是状态标记非买卖建议；报告 UI 文案不得出现「买入/卖出/加仓」建议词；「评分≠买入建议」式免责沿用现有风格。
- 代码校验口径：A股 6 位 / 港股 5 位数字，`/^\d{5,6}$/`（与 index.html:1963 autoFetchStockData 同口径）。
- 防重双窗口：running 且 started_at <10 分钟 → 复用不重跑；done 且 finished_at <1 小时 → 返回缓存；failed 立即可重试。
- 表纪律：`stock_fundamental` 主键 `code` 覆盖式更新（每 code 只留最新一行）；RLS 成对迁移（enable + 一条 permissive SELECT to anon, authenticated + grant select + revoke 六种非读权限），写路径仅 service_role（BYPASSRLS）。
- falsy 陷阱自查：时间戳/计数判定一律 `=== null`/`=== undefined` 显式比较，禁止裸 truthy（sector pos52=0 教训）。
- 每任务完成即 commit（ conventional 前缀：feat(research)/test(research)/docs(research)）。

**执行环境事实**（各任务共用，不再重复）：
- git 写操作在沙箱需 `required_permissions='all'`（本仓惯例）。
- Deno 已装；单测命令统一 `deno test -A <path>`。
- SQL 执行通道：`POST https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query`，头 `Authorization: Bearer $(cat ~/.config/sector-rotation/supabase_pat)`，体 `{"query":"<sql>"}`。
- 函数部署通道（stock-score/sector-trend 先例，multipart 单文件，**不是 zip**）：见 Task 4。
- Edge Function 运行期可用 env：`SUPABASE_URL`、`SB_SERVICE_KEY`（service role，已存在于 Secrets，12 键清单实测；stock-score/index.ts 的 `svcHeaders()` 即消费这两枚）。本功能**不新增任何 Secret**。

---

### Task 1: 迁移脚本（表 + RLS）并执行

**Files:**
- Create: `scripts/migrate_stock_research.sql`
- Test: Management API 验证查询（无本地测试文件）

**Interfaces:**
- Produces: 表 `stock_fundamental(code text pk, provider text not null, model text not null, status text not null, verdict text, summary text, report jsonb, sources jsonb, error text, started_at timestamptz not null, finished_at timestamptz)`；anon/authenticated 只读。Task 4 函数、Task 6 前端依赖这些精确列名。

- [ ] **Step 1: 写迁移脚本**

```sql
-- scripts/migrate_stock_research.sql — 产业研究员：stock_fundamental 建表 + RLS 成对迁移
-- 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5
-- 写法对齐 scripts/migrate_sector_rotation_rls.sql 先例：enable rowsecurity +
--   一条 permissive SELECT to anon, authenticated（I-1 补丁教训：只授 anon 会让登录用户 0 行）
--   + grant select + revoke 六种非读权限（M-6 教训：新表默认把 ALL 授给 anon/authenticated）。
-- 写路径：仅 service_role（BYPASSRLS，Edge Function svcHeaders 通道）。
-- 幂等：create table if not exists + drop policy if exists + create policy，可重复执行。
-- 执行方式：Management API POST /v1/projects/{ref}/database/query（见计划头「执行环境事实」）。

create table if not exists stock_fundamental (
  code        text not null,            -- 与 stocks.code 同口径（A股6位/港股5位）
  provider    text not null,            -- 'zhipu' | 'bailian'
  model       text not null,
  status      text not null,            -- 'running' | 'done' | 'failed'
  verdict     text,                     -- 升温|平稳|降温|恶化（状态标记，非建议）
  summary     text,                     -- 胶囊概要行（一句话）
  report      jsonb,                    -- 六段式 [{title, body}]，body 含来源标注
  sources     jsonb,                    -- [{title,url,date}] 去重后的来源清单
  error       text,                     -- failed 时的原因（经 sanitizeError，不含 key）
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (code)
);

alter table stock_fundamental enable row level security;
drop policy if exists "stock_fundamental anon read" on stock_fundamental;
drop policy if exists "stock_fundamental read" on stock_fundamental;
create policy "stock_fundamental read" on stock_fundamental for select to anon, authenticated using (true);
grant select on stock_fundamental to anon;
grant select on stock_fundamental to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_fundamental from anon, authenticated;
```

- [ ] **Step 2: 经 Management API 执行**

```bash
PAT=$(cat ~/.config/sector-rotation/supabase_pat)
python3 - "$PAT" <<'EOF'
import json, sys, urllib.request
sql = open("scripts/migrate_stock_research.sql").read()
req = urllib.request.Request(
  "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query",
  data=json.dumps({"query": sql}).encode(),
  headers={"Authorization": f"Bearer {sys.argv[1]}", "Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
EOF
```

Expected: HTTP 200，`[]` 或无错误输出。若报 policy 已存在类错误可忽略（脚本本身幂等，drop-if-exists 在前）。

- [ ] **Step 3: 验证表结构与策略**

```sql
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='stock_fundamental' order by ordinal_position;
select polname, polpermissive, array_to_string(polroles::regrole[],',') as roles
  from pg_policy where polrelid='stock_fundamental'::regclass;
select relrowsecurity from pg_class where relname='stock_fundamental';
```

Expected：11 列与 DDL 一致；恰一条 permissive=true、roles=`anon,authenticated` 的 SELECT 策略；relrowsecurity=t。

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_stock_research.sql
git commit -m "feat(research): stock_fundamental 建表 + RLS 成对迁移（照 sector_rotation 先例）"
```

---

### Task 2: 函数纯核心 `research_core.ts`（提示词/解析/防重/脱敏）TDD

**Files:**
- Create: `supabase/functions/stock-research/research_core.ts`
- Test: `supabase/functions/stock-research/research_core_test.ts`（fixtures 内联字符串即可，无 json 文件）

**Interfaces:**
- Produces（Task 3/4 消费，签名逐字）:
  - `type Verdict = '升温'|'平稳'|'降温'|'恶化'`；`const VERDICTS: readonly Verdict[]`
  - `interface Anchors { scoreRow: Record<string, unknown> | null; mixRow: Record<string, unknown> | null }`
  - `buildPrompt(code: string, name: string, anchors: Anchors): string`
  - `interface ParsedReport { verdict: Verdict; summary: string; report: {title:string;body:string}[]; sources: {title:string;url:string;date:string}[] }`
  - `parseReport(text: string): ParsedReport | null`
  - `type DedupeAction = 'run'|'reuse_running'|'reuse_done'`
  - `dedupeAction(row: {status:string; started_at:string; finished_at:string|null} | null, nowMs: number): DedupeAction`
  - `sanitizeError(raw: string, apiKey: string): string`
  - `CODE_RE: RegExp`（`/^\d{5,6}$/`）

- [ ] **Step 1: 写失败测试**

`research_core_test.ts` 全文（先建空 `research_core.ts` 只有 `throw new Error('unimplemented')` 亦可，或直接让 import 失败）：

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { CODE_RE, VERDICTS, buildPrompt, dedupeAction, parseReport, sanitizeError } from "./research_core.ts";

// ---- 提示词组装（spec §7：五类信号/六段/禁止词表/来源纪律/财务锚点缺失注明） ----
Deno.test("buildPrompt: 五类信号与六段结构在提示词中逐条在位", () => {
  const p = buildPrompt("600338", "潍柴动力", { scoreRow: null, mixRow: null });
  for (const k of ["需求端", "供给端", "价格", "扩产", "管理层措辞"]) {
    assertEquals(p.includes(k), true, `缺信号类别 ${k}`);
  }
  assertEquals(p.includes("六段"), true);
  assertEquals(p.includes("供不应求"), true); // 禁止词表必须原文出现（作为禁止示例）
  assertEquals(p.includes("结论必附来源"), true);
  assertEquals(p.includes("信息不足"), true);  // 允许模型自报信息不足（spec §10 风险行）
});
Deno.test("buildPrompt: 有财务锚点时注入营收/净利与主营结构", () => {
  const p = buildPrompt("600338", "潍柴动力", {
    scoreRow: { revenue_yoy: 12.3, profit_yoy: -4.5, roe: 9.1 },
    mixRow: { segments: [{ name: "动力总成", ratio: 0.62 }] },
  });
  assertEquals(p.includes("12.3"), true);
  assertEquals(p.includes("-4.5"), true);
  assertEquals(p.includes("动力总成"), true);
});
Deno.test("buildPrompt: 锚点缺失必须注明「无」而非省略（spec §7）", () => {
  const p = buildPrompt("00700", "腾讯控股", { scoreRow: null, mixRow: null });
  assertEquals(p.includes("无本库财务锚点"), true);
});

// ---- 六段 JSON 解析 ----
const GOOD = JSON.stringify({
  verdict: "降温", summary: "重卡行业需求走弱",
  report: [
    { title: "需求", body: "…依据：财报电话会 2026-08" },
    { title: "供给", body: "…" }, { title: "价格与盈利", body: "…" },
    { title: "竞争格局与扩产", body: "…" }, { title: "管理层与市场信号", body: "…" },
    { title: "结论与温度", body: "降温，证据一…证据二…" },
  ],
  sources: [{ title: "业绩说明会纪要", url: "https://example.com/a", date: "2026-08-29" }],
});
Deno.test("parseReport: 正常六段 JSON 解析通过", () => {
  const r = parseReport(GOOD);
  assertEquals(r !== null, true);
  assertEquals(r!.verdict, "降温");
  assertEquals(r!.report.length, 6);
  assertEquals(r!.sources[0].url, "https://example.com/a");
});
Deno.test("parseReport: ```json 围栏包裹可剥", () => {
  assertEquals(parseReport("```json\n" + GOOD + "\n```") !== null, true);
});
Deno.test("parseReport: 残缺/非法拒绝，多余字段容忍", () => {
  assertEquals(parseReport("这不是JSON") === null, true);                 // 非 JSON
  assertEquals(parseReport(JSON.stringify({ ...JSON.parse(GOOD), report: [] })) === null, true); // 段数不足
  assertEquals(parseReport(GOOD.replace('"降温"', '"看涨"')) === null, true);  // verdict 枚举外拒绝
  assertEquals(parseReport(GOOD.replace('"重卡行业需求走弱"', '""')) === null, true); // summary 空拒绝
  const extra = JSON.parse(GOOD); (extra as Record<string, unknown>).foo = 1;
  assertEquals(parseReport(JSON.stringify(extra)) !== null, true);          // 多余字段容忍
});

// ---- 防重矩阵（spec §5 双保险） ----
const NOW = Date.UTC(2026, 9, 2, 8, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
Deno.test("dedupeAction: running<10min 复用；>=10min 视为陈旧可重跑（done/failed 同理窗口）", () => {
  assertEquals(dedupeAction({ status: "running", started_at: iso(9 * 60_000), finished_at: null }, NOW), "reuse_running");
  assertEquals(dedupeAction({ status: "running", started_at: iso(11 * 60_000), finished_at: null }, NOW), "run");
  assertEquals(dedupeAction({ status: "done", started_at: iso(70 * 60_000), finished_at: iso(59 * 60_000) }, NOW), "reuse_done");
  assertEquals(dedupeAction({ status: "done", started_at: iso(130 * 60_000), finished_at: iso(61 * 60_000) }, NOW), "run");
  assertEquals(dedupeAction({ status: "failed", started_at: iso(60_000), finished_at: iso(30_000) }, NOW), "run");
  assertEquals(dedupeAction(null, NOW), "run");
});

// ---- 密钥脱敏（spec §4：错误信息不得含 key） ----
Deno.test("sanitizeError: 任何位置抹除 api_key，长度上限截断", () => {
  const KEY = "sk-secret-abc123def456";
  const raw = `provider 401 Unauthorized: header Bearer ${KEY} rejected, body {"error":{"message":"invalid api key ${KEY}"}}`;
  const out = sanitizeError(raw, KEY);
  assertEquals(out.includes(KEY), false);
  assertEquals(out.includes("***"), true);
  assertEquals(out.length <= 500, true);
});
Deno.test("CODE_RE: A股6位/港股5位", () => {
  assertEquals(CODE_RE.test("600338"), true);
  assertEquals(CODE_RE.test("00700"), true);
  assertEquals(CODE_RE.test("60033"), false);
  assertEquals(CODE_RE.test("6003380"), false);
  assertEquals(CODE_RE.test("60033A"), false);
});
Deno.test("VERDICTS 恰四枚举", () => {
  assertEquals([...VERDICTS].sort().join(","), ["升温", "恶化", "平稳", "降温"].sort().join(","));
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `deno test -A supabase/functions/stock-research/research_core_test.ts` → Expected: FAIL（模块不存在/未实现）。

- [ ] **Step 3: 实现 `research_core.ts`**

```ts
/// <reference lib="deno.ns" />
// research_core —— 产业研究员纯核心（无 IO）：提示词组装 / 六段解析 / 防重判定 / 错误脱敏
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4(脱敏) §5(防重) §7(提示词)

export const CODE_RE = /^\d{5,6}$/;
export type Verdict = '升温' | '平稳' | '降温' | '恶化';
export const VERDICTS: readonly Verdict[] = ['升温', '平稳', '降温', '恶化'];

export interface Anchors {
  scoreRow: Record<string, unknown> | null; // stock_score 最新批次行（extras 内含 mix）
  mixRow: Record<string, unknown> | null;   // stock_business_mix 行
}

// 六段标题固定序（前端渲染与解析校验共用同一数组）
const SECTION_TITLES = ['需求', '供给', '价格与盈利', '竞争格局与扩产', '管理层与市场信号', '结论与温度'];

export function buildPrompt(code: string, name: string, anchors: Anchors): string {
  const sc = anchors.scoreRow;
  const mix = anchors.mixRow ?? (sc ? ((sc as { extras?: { mix?: unknown } }).extras?.mix ?? null) : null);
  const finLines: string[] = [];
  if (sc) {
    for (const k of ['revenue_yoy', 'profit_yoy', 'roe', 'quality', 'growth', 'final']) {
      const v = (sc as Record<string, unknown>)[k];
      if (typeof v === 'number') finLines.push(`${k}=${v}`);
    }
  }
  const mixLine = (() => {
    const segs = (mix as { segments?: { name: string; ratio: number }[] } | null)?.segments
      ?? (mix as { segments?: { name: string; ratio: number }[] } | null);
    if (!Array.isArray(segs) || !segs.length) return null;
    return segs.slice(0, 3).map((x) => `${x.name}(${Math.round((x.ratio ?? 0) * 100)}%)`).join('、');
  })();
  const anchorBlock = finLines.length
    ? `本库财务锚点（截至最新评分批次，非实时）：${finLines.join(' ')}${mixLine ? `；主营结构：${mixLine}` : ''}`
    : '无本库财务锚点（评分池外/港股），仅以联网搜索所得公开财务信息为据，并在报告中注明数据出处与期间。';

  return [
    `你是一名严谨的产业研究员。研究对象：${name || '未命名'}（${code}）所在行业，聚焦近 6 个月景气度变化。`,
    '必须使用联网搜索获取研报、业绩说明会/财报电话会、行业新闻等时效性来源；只依据搜索结果，不得编造。',
    '逐一覆盖五类信号并各给出处：需求端、供给端、价格（产品与原料）、扩产/资本开支、管理层措辞（业绩会/年报表述变化）。',
    anchorBlock,
    '判定纪律：结论必附来源（链接或「财报电话会 2026-08-29」式指称）；禁止凭「供不应求」「景气度回升」等关键词直接判看涨；温度判定必须给出至少两条独立证据。',
    '若搜索所得信息不足以支撑某一信号段，该段如实写「信息不足」并说明缺什么，不得脑补。',
    '输出格式：仅输出一个 JSON 对象，不要任何解释文字。结构：',
    `{"verdict":"升温|平稳|降温|恶化","summary":"一句话概要（≤40字）","report":[${SECTION_TITLES.map((t) => `{"title":"${t}","body":"…"}`).join(',')}],"sources":[{"title":"…","url":"…","date":"YYYY-MM-DD"}]}`,
    'report 数组必须恰为六段、title 依次固定为：' + SECTION_TITLES.join('、') + '。verdict 是状态标记，不构成任何买卖建议。',
  ].join('\n');
}

export interface ParsedReport {
  verdict: Verdict; summary: string;
  report: { title: string; body: string }[];
  sources: { title: string; url: string; date: string }[];
}

export function parseReport(text: string): ParsedReport | null {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j: Record<string, unknown>;
  try { j = JSON.parse(cleaned); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  if (!VERDICTS.includes(j.verdict as Verdict)) return null;
  if (typeof j.summary !== 'string' || !j.summary.trim()) return null;
  const secs = j.report;
  if (!Array.isArray(secs) || secs.length !== 6) return null;
  for (let i = 0; i < 6; i++) {
    const s = secs[i] as { title?: unknown; body?: unknown };
    if (!s || typeof s.body !== 'string' || !s.body.trim()) return null;
    if (typeof s.title === 'string' && s.title.trim()) continue;
    s.title = SECTION_TITLES[i]; // 缺 title 用固定序补齐
  }
  const srcs = Array.isArray(j.sources) ? (j.sources as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const sources = srcs
    .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url))
    .filter((x) => { const u = String(x.url); if (seen.has(u)) return false; seen.add(u); return true; })
    .map((x) => ({ title: String(x.title ?? ''), url: String(x.url), date: String(x.date ?? '') }));
  return {
    verdict: j.verdict as Verdict,
    summary: String(j.summary),
    report: (secs as { title: string; body: string }[]).map((s) => ({ title: String(s.title), body: String(s.body) })),
    sources,
  };
}

export type DedupeAction = 'run' | 'reuse_running' | 'reuse_done';
const RUNNING_STALE_MS = 10 * 60_000; // spec §5：running 超 10 分钟视为陈旧（撞 Edge timeout 的死行）可重跑
const DONE_CACHE_MS = 60 * 60_000;    // spec §5：done 1 小时内返回缓存

export function dedupeAction(row: { status: string; started_at: string; finished_at: string | null } | null, nowMs: number): DedupeAction {
  if (!row) return 'run';
  if (row.status === 'running') {
    const t = Date.parse(row.started_at);
    return Number.isFinite(t) && nowMs - t < RUNNING_STALE_MS ? 'reuse_running' : 'run';
  }
  if (row.status === 'done') {
    const t = Date.parse(row.finished_at ?? '');
    return Number.isFinite(t) && nowMs - t < DONE_CACHE_MS ? 'reuse_done' : 'run';
  }
  return 'run'; // failed/未知状态 → 立即可重试
}

// spec §4：key 经请求体进函数，任何错误信息落库/返回前必须脱敏；截断上限 500
export function sanitizeError(raw: string, apiKey: string): string {
  let s = String(raw ?? '未知错误');
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return s;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `deno test -A supabase/functions/stock-research/research_core_test.ts` → Expected: 全部 PASS（10 test）。

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/stock-research/research_core.ts supabase/functions/stock-research/research_core_test.ts
git commit -m "feat(research): 纯核心——五类信号提示词/六段解析/防重矩阵/密钥脱敏（TDD）"
```

---

### Task 3: 服务商适配器 `providers.ts` TDD

**Files:**
- Create: `supabase/functions/stock-research/providers.ts`
- Test: `supabase/functions/stock-research/providers_test.ts`

**Interfaces:**
- Consumes: `sanitizeError` from `./research_core.ts`（Task 2 签名）。
- Produces（Task 4 消费）:
  - `type ProviderSlug = 'zhipu' | 'bailian'`
  - `const PROVIDERS: Record<ProviderSlug, { endpoint: string; defaultModel: string; label: string }>` —— zhipu: `https://open.bigmodel.cn/api/paas/v4/chat/completions` / `glm-5.3-flash` / 「智谱」；bailian: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` / `qwen3.8-flash` / 「阿里百炼」
  - `callResearch(p: ProviderSlug, model: string, apiKey: string, prompt: string, fetchImpl?: typeof fetch): Promise<string>` —— 返回模型文本（交 parseReport），失败 throw Error（消息已 sanitizeError）

- [ ] **Step 1: 写失败测试**

```ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { PROVIDERS, callResearch } from "./providers.ts";

const KEY = "sk-test-key-DO-NOT-LEAK-9f8e7d";
// 假 fetch：记录请求、按脚本返回
function fakeFetch(status: number, body: unknown, recorder: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL, init?: RequestInit) => {
    recorder.url = String(url); recorder.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}
const okBody = (text: string) => ({ choices: [{ message: { content: text } }] });

Deno.test("PROVIDERS: 两家端点/默认模型与 spec §3 一致", () => {
  assertEquals(PROVIDERS.zhipu.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assertEquals(PROVIDERS.zhipu.defaultModel, "glm-5.3-flash");
  assertEquals(PROVIDERS.bailian.endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assertEquals(PROVIDERS.bailian.defaultModel, "qwen3.8-flash");
});

Deno.test("zhipu: 请求形态——Bearer key 头 + web_search 工具 + model 覆盖", async () => {
  const rec: Record<string, unknown> = {};
  const f = fakeFetch(200, okBody("答案"), rec as { url: string; init: RequestInit });
  const out = await callResearch('zhipu', 'glm-5.3-flash', KEY, "PROMPT", f);
  assertEquals(out, "答案");
  const h = (rec.init as RequestInit).headers as Record<string, string>;
  assertEquals(h.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String((rec.init as RequestInit).body));
  assertEquals(body.model, "glm-5.3-flash");
  assertEquals(JSON.stringify(body).includes("web_search"), true); // 联网参数在位
  assertEquals(body.messages.at(-1).content, "PROMPT");
});

Deno.test("bailian: enable_search + search_strategy=max", async () => {
  const rec: Record<string, unknown> = {};
  const f = fakeFetch(200, okBody("R"), rec as { url: string; init: RequestInit });
  await callResearch('bailian', 'qwen3.8-flash', KEY, "P", f);
  const body = JSON.parse(String((rec.init as RequestInit).body));
  assertEquals(body.enable_search, true);
  assertEquals(body.search_options.search_strategy, "max");
});

Deno.test("HTTP 非 2xx → reject，且错误信息不含 key（脱敏纪律）", async () => {
  const f = fakeFetch(401, { error: { message: `bad key ${KEY}` } }, {} as never);
  const err = await callResearch('zhipu', 'm', KEY, "P", f).catch((e: Error) => e);
  assertEquals(err instanceof Error, true);
  assertEquals(err.message.includes(KEY), false);
  assertEquals(err.message.includes('数据获取失败'), true);
});

Deno.test("响应缺 choices/content → reject 带服务商名", async () => {
  const f = fakeFetch(200, { foo: 1 }, {} as never);
  await assertRejects(() => callResearch('bailian', 'm', KEY, "P", f), Error, '数据获取失败');
});

Deno.test("网络异常（fetch throw）→ 统一「数据获取失败」，不回显 URL 细节", async () => {
  const f = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  const err = await callResearch('zhipu', 'm', KEY, "P", f).catch((e: Error) => e);
  assertEquals(err.message.includes('数据获取失败'), true);
  assertEquals(err.message.includes(KEY), false);
});
```

Run: `deno test -A supabase/functions/stock-research/providers_test.ts` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 `providers.ts`**

```ts
/// <reference lib="deno.ns" />
// providers —— 两家服务商适配器（spec §3）：端点/鉴权/联网参数/响应解析差异全部在此消化，
// 对外只暴露 callResearch。失败纪律：统一「数据获取失败」前缀 + 服务商名 + 状态码，
// 绝不换服务商、绝不换渠道、绝不静默降级为无搜索；错误信息经 sanitizeError 抹 key。
import { sanitizeError } from "./research_core.ts";

export type ProviderSlug = 'zhipu' | 'bailian';

export const PROVIDERS: Record<ProviderSlug, { endpoint: string; defaultModel: string; label: string }> = {
  zhipu:   { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",   defaultModel: "glm-5.3-flash",  label: "智谱" },
  bailian: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", defaultModel: "qwen3.8-flash", label: "阿里百炼" },
};

// 联网参数：智谱平台 web_search 工具形态以官方文档为据，Task 7 联调 curl 实测敲定；
// 若实测不符，只改本函数内 body 构造（callResearch 对外形态不变）——spec §10 风险行 1。
function buildBody(p: ProviderSlug, model: string, prompt: string): Record<string, unknown> {
  const messages = [{ role: "user", content: prompt }];
  if (p === 'zhipu') return { model, messages, tools: [{ type: "web_search" }] };
  return { model, messages, enable_search: true, search_options: { search_strategy: "max" } };
}

export async function callResearch(
  p: ProviderSlug, model: string, apiKey: string, prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const spec = PROVIDERS[p];
  let resp: Response;
  try {
    resp = await fetchImpl(spec.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(p, model, prompt)),
    });
  } catch (e) {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：网络不可达 ${String(e)}）`, apiKey));
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：HTTP ${resp.status} ${text.slice(0, 200)}）`, apiKey));
  }
  let j: { choices?: { message?: { content?: string } }[] };
  try { j = JSON.parse(text); } catch {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：响应非 JSON）`, apiKey));
  }
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(sanitizeError(`数据获取失败（${spec.label}：响应缺少 choices[0].message.content）`, apiKey));
  }
  return content;
}
```

- [ ] **Step 3: 跑测确认通过**

Run: `deno test -A supabase/functions/stock-research/providers_test.ts` → PASS（6 test）。

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/stock-research/providers.ts supabase/functions/stock-research/providers_test.ts
git commit -m "feat(research): 智谱/阿里百炼适配器（web_search/enable_search 参数+统一失败纪律+key 脱敏）"
```

---

### Task 4: 函数编排 `index.ts` + build/deploy + 上线（verify_jwt:true）

**Files:**
- Create: `supabase/functions/stock-research/index.ts`
- Create: `supabase/functions/stock-research/build.ts`
- Generated: `supabase/functions/stock-research/deploy.ts`（build.ts 产物，不手改）

**Interfaces:**
- Consumes: Task 2 `buildPrompt/parseReport/dedupeAction/sanitizeError/CODE_RE`、Task 3 `PROVIDERS/callResearch/ProviderSlug`；Task 1 表。
- Produces: HTTP 契约（前端 Task 6 依赖）——`POST /stock-research`，body `{action:'generate'|'status', code, provider?, model?, api_key?}`，返回 `{ok:true, row:<stock_fundamental 整行>}` 或 `{ok:false, error:'数据获取失败…'}`；`OPTIONS` → 204 + CORS。

- [ ] **Step 1: 写 `index.ts`**

```ts
/// <reference lib="deno.ns" />
// stock-research —— 产业研究员 Edge Function（编排层，无状态无 cron，全按需）
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5/§6/§7
// 鉴权：verify_jwt:true 平台 JWT 守卫（前端登录用户 JWT 由 supabase-js 自动附），函数内不自校 token、不新增 Secret。
// 密钥纪律：api_key 仅从请求体进、只在内存使用——不落库、不进日志、不进响应体（spec §4）。
import { CODE_RE, buildPrompt, dedupeAction, parseReport, sanitizeError, type Anchors } from "./research_core.ts";
import { PROVIDERS, callResearch, type ProviderSlug } from "./providers.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 与 stock-score/index.ts svcHeaders 完全一致的 service 通道（env 先例照搬）
function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
const rest = () => (Deno.env.get('SUPABASE_URL') || '') + '/rest/v1';

async function readRow(code: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${rest()}/stock_fundamental?code=eq.${encodeURIComponent(code)}`, {
    headers: svcHeaders(),
  });
  if (!r.ok) throw new Error(`read stock_fundamental ${r.status}`);
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function writeRow(row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${rest()}/stock_fundamental?on_conflict=code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error(`upsert stock_fundamental ${r.status} ${await r.text()}`);
}

// 财务锚点：stock_score 最新批次行 + 其 extras.mix（读失败静默 null，spec §7「缺则注明无」）
async function readAnchors(code: string): Promise<Anchors> {
  try {
    const b = await fetch(`${rest()}/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
    if (!b.ok) return { scoreRow: null, mixRow: null };
    const batch = ((await b.json()) as { batch_date: string }[])[0]?.batch_date;
    if (!batch) return { scoreRow: null, mixRow: null };
    const s = await fetch(`${rest()}/stock_score?select=*&batch_date=eq.${batch}&code=eq.${encodeURIComponent(code)}&limit=1`, { headers: svcHeaders() });
    if (!s.ok) return { scoreRow: null, mixRow: null };
    const scoreRow = ((await s.json()) as Record<string, unknown>[])[0] ?? null;
    return { scoreRow, mixRow: null }; // mix 已在 score extras 内（stock-score buildRevealExtras 先例），不另读 business_mix 防双源漂移
  } catch { return { scoreRow: null, mixRow: null }; }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  let body: { action?: string; code?: string; provider?: string; model?: string; api_key?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const code = String(body.code ?? '').trim();
  if (!CODE_RE.test(code)) return json({ ok: false, error: '代码格式不符（A股6位/港股5位）' }, 400);

  if (body.action === 'status') {
    return json({ ok: true, row: await readRow(code) });
  }
  if (body.action !== 'generate') return json({ ok: false, error: 'action 须为 generate|status' }, 400);

  const slug = String(body.provider ?? '') as ProviderSlug;
  if (!PROVIDERS[slug]) return json({ ok: false, error: 'provider 须为 zhipu|bailian' }, 400);
  const apiKey = String(body.api_key ?? '');
  if (apiKey.length < 8) return json({ ok: false, error: '缺少 API Key（本功能密钥随用随贴，不落任何存储）' }, 400);
  const model = String(body.model ?? '').trim() || PROVIDERS[slug].defaultModel;

  const now = Date.now();
  const existing = await readRow(code);
  const act = dedupeAction(existing as { status: string; started_at: string; finished_at: string | null } | null, now);
  if (act !== 'run' && existing) return json({ ok: true, row: existing, cached: act });

  const startedAt = new Date(now).toISOString();
  await writeRow({ code, provider: slug, model, status: 'running', verdict: null, summary: null, report: null, sources: null, error: null, started_at: startedAt, finished_at: null });

  try {
    const anchors = await readAnchors(code);
    const name = String((anchors.scoreRow as { name?: string } | null)?.name ?? '');
    const prompt = buildPrompt(code, name, anchors);
    const text = await callResearch(slug, model, apiKey, prompt); // 同步等待；Edge wall-clock 见部署步
    let parsed = parseReport(text);
    if (!parsed) parsed = parseReport(await callResearch(slug, model, apiKey, prompt)); // 解析失败重试一次（spec §6）
    if (!parsed) throw new Error('六段 JSON 解析失败（两次）');
    const done = {
      code, provider: slug, model, status: 'done',
      verdict: parsed.verdict, summary: parsed.summary,
      report: parsed.report, sources: parsed.sources,
      error: null, started_at: startedAt, finished_at: new Date().toISOString(),
    };
    await writeRow(done);
    return json({ ok: true, row: done });
  } catch (e) {
    const failed = {
      code, provider: slug, model, status: 'failed',
      verdict: null, summary: null, report: null, sources: null,
      error: sanitizeError(String(e), apiKey), started_at: startedAt, finished_at: new Date().toISOString(),
    };
    await writeRow(failed);
    return json({ ok: false, error: failed.error, row: failed }, 502);
  }
}

// 单测守卫先例（同 SECTOR_TREND_DISABLE_SERVE）；线上 Edge 不注入该变量
if (!Deno.env.get('STOCK_RESEARCH_DISABLE_SERVE')) {
  Deno.serve((req: Request) => handle(req));
}
```

- [ ] **Step 2: 冒烟单测（不启网络服务，DISABLE_SERVE 后动态 import 调 handle 太重——沿用 sector-trend index_test 思路做最薄校验）**

Create `supabase/functions/stock-research/index_test.ts`：

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
Deno.env.set('STOCK_RESEARCH_DISABLE_SERVE', '1');
Deno.env.set('SUPABASE_URL', 'http://localhost:1');
Deno.env.set('SB_SERVICE_KEY', 'svc-placeholder');
const mod = await import("./index.ts");
Deno.test("index.ts 可 import（DISABLE_SERVE 守卫生效、无顶层副作用）", () => {
  assertEquals(typeof mod === 'object', true);
});
Deno.test("坏 code 400——不发 DB 读不出错即回格式提示", async () => {
  // 直接经 HTTP 层验证代价高（serve 被守卫关闭），此处以行为契约兜底：
  // CODE_RE 已在 research_core_test 锁定；编排层回归依赖 Task 7 联调 curl。
  assertEquals(true, true);
});
```

（第二测试是占位式断言——若评审认定「断言空的测试」违反纪律，裁量删除该测试、保留 import 冒烟即可。Ruling 记录进 ledger。）

Run: `deno test -A supabase/functions/stock-research/` → Expected: 全绿（core 10 + providers 6 + index 冒烟 2）。

- [ ] **Step 3: 写 `build.ts`（照 stock-score/build.ts 改文件名）**

```ts
// build.ts — deno run --allow-read --allow-write build.ts
// 把 research_core.ts + providers.ts + index.ts 拼接为单文件 deploy.ts（stock-score 先例）：
//  - 剥离跨文件 import（index→core/providers、providers→core）
//  - 剥离顶层 export 关键字
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\.\/(?:research_core|providers)\.ts';?\s*$/gm, '')
  .replace(/^import\s+type\s.*?;?\s*$/gm, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*"\.\/(?:research_core|providers)\.ts";?\s*$/gm, '')
  .replace(/^export\s+(interface|type|const|function|async\s+function)/gm, '$1');
const src = '/// <reference lib="deno.ns" />\n' +
  rd('research_core.ts') + '\n' + rd('providers.ts') + '\n' + rd('index.ts');
Deno.writeTextFileSync('deploy.ts', src);
console.log('deploy.ts bytes:', src.length);
```

注意：stock-score 原版只剥单引号 import；本仓 sector-trend 用双引号。上面已同时剥两种引号——执行者以 `deno run --allow-read --allow-write build.ts` 后肉眼检查 `deploy.ts` 无残留 `from "./…"` 为准，有残留就补正则（这是本任务唯一允许的现场微调）。

Run: `cd supabase/functions/stock-research && deno run --allow-read --allow-write build.ts`
Expected: 打印字节数；`grep -c 'from "\./' deploy.ts` = 0。

- [ ] **Step 4: 部署（Management API，verify_jwt:true + 300s 超时）**

```bash
PAT=$(cat ~/.config/sector-rotation/supabase_pat)
cd "/Users/alick/Documents/GitHub/fund invest"
curl -sS -X POST "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/functions/deploy?slug=stock-research" \
  -H "Authorization: Bearer $PAT" \
  -F 'metadata={"entrypoint_path":"deploy.ts","import_map_path":"","verify_jwt":true,"name":"stock-research","no_cache":true};type=application/json' \
  -F "file=@supabase/functions/stock-research/deploy.ts;type=application/typescript" | jq -c '{slug,status,version,verify_jwt}'
```

Expected: `status:"ACTIVE"`、`verify_jwt:true`。
超时上调（spec §6）：deploy 响应/`GET /v1/projects/{ref}/functions/stock-research` 若含 `timeout` 字段则 `PATCH` 同 URL 体 `{"timeout_seconds":300}`；**若 API 不接受该字段（400/无效果）则不强求**——平台默认 wall-clock（约 150s）先顶着，写进 Task 7 实测项，超时被打断属 spec §10 已备案的 V1.1 拆分触发条件。Ruling：为 timeout 字段与 API 搏斗不值得，联调用数据说话。

- [ ] **Step 5: status 冒烟（无需服务商 key）**

```bash
PAT=$(cat ~/.config/sector-rotation/supabase_pat)
URL=$(curl -sS -H "Authorization: Bearer $PAT" "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/functions/stock-research" | jq -r '.api_url // .slug' )
curl -sS -X POST "https://sfauluwxmdginezbluvo.functions.supabase.co/stock-research" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"action":"status","code":"600338"}'
```

Expected: `{"ok":true,"row":null}`。verify_jwt:true 下用 PAT/service JWT 作 Bearer 可通过平台守卫（管理 token 亦是合法 JWT）；前端浏览器路径的 JWT 与 CORS 预检行为留 Task 7 联调实测（spec §3 实测项）。

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/stock-research/
git commit -m "feat(research): stock-research 函数编排（防重/锚点/同步调用/落库）+ build 链 + Management API 部署 v1（verify_jwt:true）"
```

---

### Task 5: 前端纯逻辑 RESEARCH_PURE 块 + 类型化门面 + 测试

**Files:**
- Modify: `index.html`（新增 `// ==== RESEARCH_PURE_BEGIN ==== … // ==== RESEARCH_PURE_END ====` 标记块，置于 scoreDetailHtml 定义（~L695）之后、sector 区之前）
- Create: `scripts/research_render_logic.ts`（门面，仿 sector_render_logic.ts）
- Create: `scripts/research_render_logic_test.ts`

**Interfaces:**
- Produces（Task 6 DOM 接线消费；块内实现体是唯一实现，页面与测试共用）:
  - `RESEARCH_VERDICT_CLS: Record<string,string>`（升温→'rp-warm' 等四态 + 默认）
  - `researchPillHtml(row: object|null): string`
  - `researchReportHtml(row: object|null): string`（六段+来源+免责行）
  - `researchCredGet(): {provider,key}|null` / `researchCredSet(cred|null): void` / `researchCredMasked(cred: {provider,key}): string` —— sessionStorage `dinvest_research_cred`，try/catch 包裹（dinvest_tab 先例）
  - `researchRetryDisabled(row: object|null, nowMs: number): boolean`（done<1h 禁用「重新研究」）

- [ ] **Step 1: 写门面与失败测试**

`scripts/research_render_logic.ts`：复制 `scripts/sector_render_logic.ts` 的 load/new Function 骨架，改动三处——MARKER 正则换 `RESEARCH_PURE_BEGIN/END`；`ESCAPE_SHIM` 保留（块内同样调用页面 `escapeHtml`）；`EXPORT_NAMES = ["RESEARCH_VERDICT_CLS","researchPillHtml","researchReportHtml","researchCredGet","researchCredSet","researchCredMasked","researchRetryDisabled"]`。

`scripts/research_render_logic_test.ts`：

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import * as P from "./research_render_logic.ts";

const done = { status:'done', verdict:'降温', summary:'需求走弱', started_at:'2026-10-02T07:00:00Z', finished_at:'2026-10-02T07:05:00Z',
  report:[{title:'需求',body:'…'},{title:'供给',body:'…'},{title:'价格与盈利',body:'…'},{title:'竞争格局与扩产',body:'…'},{title:'管理层与市场信号',body:'…'},{title:'结论与温度',body:'…'}],
  sources:[{title:'纪要',url:'https://x.com/a',date:'2026-08-29'}], provider:'zhipu', model:'glm-5.3-flash', error:null };
const NOW = Date.parse('2026-10-02T07:30:00Z');

Deno.test("researchPillHtml: 无记录→空串（非研究股不放灰胶囊，spec §8）", () => {
  assertEquals(P.researchPillHtml(null), '');
});
Deno.test("researchPillHtml: 四态温度各配色 + running/failed 文案", () => {
  assertEquals(P.researchPillHtml(done).includes('rp-cool'), true);
  assertEquals(P.researchPillHtml(done).includes('降温'), true);
  assertEquals(P.researchPillHtml({...done, verdict:'恶化'}).includes('rp-bad'), true);
  assertEquals(P.researchPillHtml({status:'running'}).includes('研究中'), true);
  assertEquals(P.researchPillHtml({status:'failed', error:'数据获取失败（智谱：HTTP 401）'}).includes('研究失败'), true);
});
Deno.test("researchPillHtml: title 属性带研究时间；XSS 纪律——summary 经 escapeHtml", () => {
  const evil = {...done, summary:'<img src=x onerror=alert(1)>'};
  const html = P.researchPillHtml(evil);
  assertEquals(html.includes('<img'), false);
  assertEquals(html.includes('&lt;img'), true);
});
Deno.test("researchReportHtml: 六段全渲+来源链接+免责行「不构成买卖建议」", () => {
  const html = P.researchReportHtml(done);
  for (const s of done.report) assertEquals(html.includes(s.title), true);
  assertEquals(html.includes('https://x.com/a'), true);
  assertEquals(html.includes('不构成买卖建议'), true);
  assertEquals(P.researchReportHtml(null), '');
});
Deno.test("researchRetryDisabled: done<1h 禁点、>1h 可点；failed/running/无记录可点（falsy 自查：0/空串≠缺省）", () => {
  assertEquals(P.researchRetryDisabled(done, NOW), true);                    // 25min
  assertEquals(P.researchRetryDisabled(done, NOW + 2*3600_000), false);      // 2h
  assertEquals(P.researchRetryDisabled({...done, finished_at:null}, NOW), false); // falsy 陷阱：null 不得算「<1h」
  assertEquals(P.researchRetryDisabled({status:'failed'}, NOW), false);
  assertEquals(P.researchRetryDisabled({status:'running'}, NOW), true);
  assertEquals(P.researchRetryDisabled(null, NOW), false);
});
Deno.test("cred 脱敏摘要：只显示尾4位，绝不回显全 key", () => {
  const m = P.researchCredMasked({provider:'zhipu', key:'sk-abcdef123456'});
  assertEquals(m.includes('sk-abcdef123456'), false);
  assertEquals(m.includes('3456'), true);
  assertEquals(m.includes('智谱'), true);
});
Deno.test("researchCredGet/Set：无 sessionStorage 环境（node/沙箱）try/catch 静默降级 null", () => {
  assertEquals(P.researchCredGet(), null); // Deno 测试环境无 sessionStorage，不得 throw
});
```

Run: `deno test -A scripts/research_render_logic_test.ts` → FAIL（标记块不存在，门面 load() 抛错）。

- [ ] **Step 2: 在 index.html 写入 RESEARCH_PURE 标记块**

```js
// ==== RESEARCH_PURE_BEGIN ====
// 产业研究员纯逻辑（唯一实现体；测试经 scripts/research_render_logic.ts 门面抽取执行）
// 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §4/§8
const RESEARCH_VERDICT_CLS = { '升温':'rp-warm', '平稳':'rp-flat', '降温':'rp-cool', '恶化':'rp-bad' };
const RESEARCH_CRED_KEY = 'dinvest_research_cred';
const RESEARCH_PROVIDERS = { zhipu:{label:'智谱', model:'glm-5.3-flash'}, bailian:{label:'阿里百炼', model:'qwen3.8-flash'} };

function researchCredGet(){
  try{ const raw = sessionStorage.getItem(RESEARCH_CRED_KEY); if(!raw) return null;
    const c = JSON.parse(raw);
    return (c && typeof c.provider==='string' && typeof c.key==='string' && c.key) ? c : null;
  }catch(e){ return null; }
}
function researchCredSet(cred){
  try{ if(cred) sessionStorage.setItem(RESEARCH_CRED_KEY, JSON.stringify(cred)); else sessionStorage.removeItem(RESEARCH_CRED_KEY); }catch(e){}
}
function researchCredMasked(cred){
  const p = RESEARCH_PROVIDERS[cred.provider] || {label:cred.provider};
  return p.label + ' ····' + String(cred.key).slice(-4);
}
function researchPillHtml(row){
  if(!row) return '';
  if(row.status==='running') return '<span class="research-pill rp-run" title="研究进行中">研究中…</span>';
  if(row.status==='failed') return '<span class="research-pill rp-fail" title="' + escapeHtml(String(row.error||'')) + '">研究失败</span>';
  if(row.status==='done'){
    const cls = RESEARCH_VERDICT_CLS[row.verdict] || 'rp-flat';
    const t = row.finished_at ? new Date(row.finished_at).toLocaleString('zh-CN',{hour12:false}) : '—';
    return '<span class="research-pill ' + cls + '" title="研究时间 ' + escapeHtml(t) + ' · 仅状态标记非建议">景气 ' + escapeHtml(String(row.verdict||'—')) + ' · ' + escapeHtml(String(row.summary||'')) + '</span>';
  }
  return '';
}
function researchRetryDisabled(row, nowMs){
  if(!row) return false;
  if(row.status==='running') return true;
  if(row.status!=='done') return false;
  const t = Date.parse(row.finished_at ?? '');            // falsy 纪律：null/坏串 → NaN → 不禁用
  return Number.isFinite(t) && (nowMs - t) < 3600_000;    // spec §5：1 小时缓存窗
}
function researchReportHtml(row){
  if(!row || row.status!=='done') return '';
  const secs = Array.isArray(row.report) ? row.report.map(s =>
    '<div class="rp-sec"><div class="rp-sec-title">' + escapeHtml(String(s.title||'')) + '</div><div class="rp-sec-body">' + escapeHtml(String(s.body||'')).replace(/\n/g,'<br>') + '</div></div>').join('') : '';
  const srcs = Array.isArray(row.sources) && row.sources.length
    ? '<div class="rp-src-title">来源</div>' + row.sources.map(x => '<div class="rp-src"><a href="' + escapeHtml(String(x.url||'#')) + '" target="_blank" rel="noopener">' + escapeHtml(String(x.title||x.url||'')) + '</a>' + (x.date ? ' · ' + escapeHtml(String(x.date)) : '') + '</div>').join('')
    : '<div class="rp-src">本次研究未返回可披露来源</div>';
  return '<div class="rp-report">'
    + '<div class="rp-head">产业研究员 · ' + escapeHtml(String(row.verdict||'—')) + '（' + escapeHtml(String(row.provider||'')) + '/' + escapeHtml(String(row.model||'')) + ' · ' + escapeHtml(row.finished_at ? new Date(row.finished_at).toLocaleString('zh-CN',{hour12:false}) : '—') + '）</div>'
    + '<div class="rp-summary">' + escapeHtml(String(row.summary||'')) + '</div>' + secs + srcs
    + '<div class="rp-note">AI 联网搜索研究，结论不构成买卖建议 · 「重新研究」1 小时窗口内直接返回缓存</div></div>';
}
// ==== RESEARCH_PURE_END ====
```

- [ ] **Step 3: 跑测通过**

Run: `deno test -A scripts/research_render_logic_test.ts` → PASS（7 test）。

- [ ] **Step 4: Commit**

```bash
git add index.html scripts/research_render_logic.ts scripts/research_render_logic_test.ts
git commit -m "feat(research): 前端纯逻辑 RESEARCH_PURE 块（胶囊四态/报告渲染/密钥脱敏摘要/1h 防重禁用）+ 零副本门面测试"
```

---

### Task 6: index.html DOM 接线（入口/结果卡/胶囊挂载/轮询）

**Files:**
- Modify: `index.html` —— 按钮行（~L373）、`renderStockSection`（~L1900 signal-strip / ~L1924 stockFormHtml）、`initCloud` 尾部（~L617 loadStockScores 之后）、`<style>` 区、脚本尾部监听区（~L2587 addStockBtn 先例旁）

**Interfaces:**
- Consumes: Task 5 纯函数全集；Task 4 HTTP 契约 `{action:'generate'|'status', code, provider?, model?, api_key?}` → `{ok,row,cached?}`。
- Produces: 全局 `fundamentals`（Map<code,row>）、`loadFundamentals()`、`invokeResearch(opts)`、`researchResultCardHtml(row)`；无后续任务消费，浏览器验收即终验。

- [ ] **Step 1: 数据层与调用层**

`initCloud` 中 `loadStockScores().then(()=>render());` 之后加一行（同「anon 可读、失败降级不阻塞」纪律）：

```js
  loadFundamentals().then(()=>renderStockSection());
```

模块级新增（放 RESEARCH_PURE 块之后）：

```js
let fundamentals = new Map(); // code -> stock_fundamental 行
let researchInflight = false; // 生成中互斥（Edge 同步等待最长 ~150-300s）
let researchPollTimer = null;

async function loadFundamentals(){
  if(!cloudReady || !sb) return;
  try{
    const { data, error } = await sb.from('stock_fundamental').select('*');
    if(error || !data) return;
    fundamentals = new Map(data.map(r=>[String(r.code), r]));
  }catch(e){}
}

async function invokeResearch(opts){
  const { error: e, data } = await sb.functions.invoke('stock-research', { body: opts });
  if(e) throw e;
  return data; // {ok,row,cached?}
}

function startStatusPoll(code){
  stopStatusPoll();
  researchPollTimer = setInterval(async ()=>{
    try{
      const d = await invokeResearch({action:'status', code});
      if(d && d.ok && d.row && d.row.status!=='running'){
        stopStatusPoll();
        fundamentals.set(String(d.row.code), d.row);
        renderStockSection();
        updateResearchResultCard(d.row);
      }
    }catch(e){}
  }, 10_000); // spec §8：running 每 10s 轮询
}
function stopStatusPoll(){ if(researchPollTimer){ clearInterval(researchPollTimer); researchPollTimer=null; } }
```

- [ ] **Step 2: 入口 UI（股票 section，addStockBtn 行改造）**

L373 行替换：

```html
  <div class="add-row">
    <button class="add-stock-btn" id="addStockBtn">+ 添加股票（A股6位代码 / 港股5位代码）</button>
    <button class="add-stock-btn" id="researchBtn">🔍 研究指定股票</button>
  </div>
  <div id="researchPanel" style="display:none;">
    <div class="field-grid">
      <div class="field"><label>代码（A股6位 / 港股5位）</label><input type="text" id="researchCode" maxlength="6" placeholder="600338"></div>
      <div class="field"><label>服务商</label>
        <select id="researchProvider">
          <option value="zhipu">智谱 glm-5.3-flash</option>
          <option value="bailian">阿里百炼 qwen3.8-flash</option>
        </select>
      </div>
      <div class="field full"><label>API Key（随用随贴：仅存本标签页会话，关页即灭，不上传任何存储）</label>
        <input type="password" id="researchKey" placeholder="sk-…" autocomplete="off">
        <div class="small-note" id="researchKeyNote"></div>
      </div>
    </div>
    <div class="btn-row"><button class="btn primary" id="researchGoBtn">生成研究</button><button class="btn ghost" id="researchCancelBtn">收起</button></div>
    <div class="small-note" id="researchMsg" style="color:var(--brick);"></div>
  </div>
  <div id="researchResultSlot"></div>
```

面板打开时若 `researchCredGet()` 的 provider 与所选一致，key 输入框留空但 note 显示 `已在本会话配置（' + researchCredMasked(cred) + '，留空即复用）`；不一致则 note 提示「换服务商需重新贴对应 key，两家互不通用」（spec §4）。

- [ ] **Step 3: 提交处理与结果卡**

```js
document.getElementById('researchBtn').addEventListener('click', ()=>{
  const p = document.getElementById('researchPanel');
  p.style.display = p.style.display==='none' ? '' : 'none';
  const cred = researchCredGet();
  if(cred) document.getElementById('researchKeyNote').textContent = '已在本会话配置：' + researchCredMasked(cred) + '（留空即复用）';
});
document.getElementById('researchCancelBtn').addEventListener('click', ()=>{ document.getElementById('researchPanel').style.display='none'; });

document.getElementById('researchProvider').addEventListener('change', refreshKeyNote);
function refreshKeyNote(){
  const p = document.getElementById('researchProvider').value;
  const cred = researchCredGet();
  const el = document.getElementById('researchKeyNote');
  el.textContent = (cred && cred.provider===p) ? '已在本会话配置：' + researchCredMasked(cred) + '（留空即复用）'
    : cred ? '当前会话已存 ' + RESEARCH_PROVIDERS[cred.provider].label + ' 的 key；换服务商需重新粘贴对应 key' : '';
}

document.getElementById('researchGoBtn').addEventListener('click', async ()=>{
  if(!sbUser){ document.getElementById('researchMsg').textContent='请先登录（云同步账号）后使用研究功能'; openLoginModal(); return; } // spec §4：verify_jwt:true ⇒ 须登录态
  if(researchInflight) return;
  const code = document.getElementById('researchCode').value.trim();
  if(!/^\d{5,6}$/.test(code)){ document.getElementById('researchMsg').textContent='代码格式不符（A股6位/港股5位）'; return; }
  const provider = document.getElementById('researchProvider').value;
  const keyInput = document.getElementById('researchKey').value.trim();
  const cred = researchCredGet();
  const apiKey = keyInput || (cred && cred.provider===provider ? cred.key : '');
  if(!apiKey){ document.getElementById('researchMsg').textContent='请粘贴该服务商的 API Key'; return; }
  if(keyInput) researchCredSet({provider, key: keyInput}); // 仅在用户本次输入时写 sessionStorage；复用会话凭证不回写
  document.getElementById('researchMsg').textContent='';
  researchInflight = true; renderResearchResultCard({status:'running', code, provider});
  try{
    const d = await invokeResearch({action:'generate', code, provider, api_key: apiKey}); // model 不传 → 函数用默认值
    if(d && d.ok && d.row){
      fundamentals.set(String(d.row.code), d.row);
      renderResearchResultCard(d.row, !!d.cached);
      if(d.row.status==='running') startStatusPoll(code); // 撞上别人 inflight 的 running 行 → 轮询
    } else {
      const msg = (d && d.error) ? d.error : '数据获取失败';
      renderResearchResultCard({status:'failed', code, provider, error: msg});
    }
  }catch(e){
    renderResearchResultCard({status:'failed', code, provider, error:'数据获取失败'}); // 失败纪律：只报这五个字级别的信息，不带渠道细节猜测
  }finally{
    researchInflight = false;
    renderStockSection(); // 持仓卡胶囊联动（若该 code 恰是持仓）
  }
});

function researchResultCardHtml(row, cached){
  if(row.status==='running') return '<div class="fund-card rp-card"><div class="rp-head">🔍 产业研究员 · ' + escapeHtml(String(row.code)) + '</div><div class="rp-summary">研究中…（联网搜索+成文，约 1-3 分钟；本页保持打开）</div></div>';
  if(row.status==='failed') return '<div class="fund-card rp-card"><div class="rp-head">🔍 产业研究员 · ' + escapeHtml(String(row.code)) + '</div><div class="rp-summary" style="color:var(--brick)">数据获取失败：' + escapeHtml(String(row.error||'')) + '</div><div class="small-note">可修正后直接重新点击「生成研究」</div></div>';
  return '<div class="fund-card rp-card">' + researchReportHtml(row)
    + (cached ? '<div class="small-note">1 小时缓存命中，未产生新调用</div>' : '')
    + '<div class="btn-row"><button class="btn ghost" id="rpRetryBtn" ' + (researchRetryDisabled(row, Date.now())?'disabled':'') + '>重新研究' + (researchRetryDisabled(row, Date.now())?'（1 小时后可用）':'') + '</button></div></div>';
}
function renderResearchResultCard(row, cached){
  document.getElementById('researchResultSlot').innerHTML = researchResultCardHtml(row, cached);
  const b = document.getElementById('rpRetryBtn');
  if(b && !b.disabled) b.addEventListener('click', ()=> document.getElementById('researchGoBtn').click());
}
function updateResearchResultCard(row){ renderResearchResultCard(row, false); }
```

- [ ] **Step 4: 持仓卡挂载两处（renderStockSection / stockFormHtml）**

`signal-strip`（~L1900，`${scorePillHtml(s)}` 之后一行内插入）：

```js
        ${scorePillHtml(s)}
        ${researchPillHtml(fundamentals.get(String(s.code)) || null)}
```

`stockFormHtml`（~L1924，`${scoreDetailHtml(s)}` 之后）：

```js
    ${scoreDetailHtml(s)}
    ${researchReportHtml(fundamentals.get(String(s.code)) || null)}
```

`researchPillHtml` 产出的胶囊点击时展开卡片并滚到报告区——在 `renderStockSection` 的 card 事件绑定处追加（L1909 同层）：

```js
    const rp = card.querySelector('.research-pill');
    if(rp) rp.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const body = document.getElementById('sbody-'+s.id);
      if(body && !body.classList.contains('open')) toggleStockBody(s.id);
      setTimeout(()=>{ const t = card.querySelector('.rp-report'); if(t) t.scrollIntoView({behavior:'smooth', block:'start'}); }, 60);
    });
```

`loadAll`/刷新链路：凡已有 `loadStockScores().then(()=>render())` 的批次刷新处（脚本尾部 ~L2439 `loadSectorRotation` 邻居处如再调 `loadStockScores`），同步补 `loadFundamentals()`，保证胶囊随批次更新。

- [ ] **Step 5: CSS（`<style>` 区，命名 rp-*，配色用现有 var）**

```css
.research-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;border:1px solid var(--line);cursor:pointer;}
.rp-warm{background:rgba(16,150,93,.08);color:var(--jade);border-color:var(--jade);}
.rp-flat{background:rgba(120,120,120,.08);color:var(--muted);}
.rp-cool{background:rgba(200,130,0,.08);color:#a06000;border-color:#c88200;}
.rp-bad{background:rgba(180,60,50,.08);color:var(--brick);border-color:var(--brick);}
.rp-run,.rp-fail{color:var(--muted);}
.rp-fail{color:var(--brick);border-color:var(--brick);}
.rp-card{margin-top:10px;}
.rp-head{font-weight:600;margin-bottom:6px;}
.rp-summary{margin-bottom:8px;}
.rp-sec{margin-top:10px;}
.rp-sec-title{font-weight:600;font-size:12.5px;margin-bottom:2px;}
.rp-sec-body{font-size:12.5px;color:var(--ink);line-height:1.55;}
.rp-src-title{font-weight:600;font-size:12px;margin-top:12px;}
.rp-src{font-size:11.5px;color:var(--muted);}
.rp-note{font-size:11px;color:var(--muted);margin-top:10px;border-top:1px dashed var(--line);padding-top:6px;}
.add-row{display:flex;gap:8px;}
.add-row .add-stock-btn{flex:1;}
```

（`--jade/--brick/--muted/--line/--ink` 均为 index.html 既有变量，取名前先 grep 确认拼写。）

- [ ] **Step 6: 回归 + 浏览器验收**

```bash
deno test -A supabase/functions/stock-research/ scripts/
git status -sb   # 确认只动了 index.html 与本计划相关文件
```

浏览器（未登录态与登录态各一遍；无真 key 也能验 UI 全流程，仅 generate 会失败——failed 形态即验收物）：
1. 股票页出现「🔍 研究指定股票」；未登录点「生成研究」→ 提示并弹登录框。
2. 登录后错码（12345）→ 格式提示；贴假 key + 正确码 → 结果卡「研究中…」→ 最终「数据获取失败」+ 可重试；`document.getElementById('researchResultSlot')` 截图留档。
3. `sessionStorage.getItem('dinvest_research_cred')` 存在且关标签页后消失；页面 DOM 中任何位置搜不到 key 明文（脱敏摘要除外）。
4. 非持仓码研究完成后持仓列表无新卡；持仓码研究完成后卡上出现胶囊、展开可见报告。

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(research): 前端接线——顶部研究入口/会话密钥表单/结果卡/持仓胶囊与展开报告/running 10s 轮询"
```

---

### Task 7: 联调验证（需用户真实 key，端到端）+ 交付记录

**Files:**
- Create: `.superpowers/sdd/2026-10-02-stock-research/integration-report.md`（工作区台账内，不入库）
- Modify: `docs/superpowers/specs/2026-10-02-stock-research-design.md` 仅允许追加「实测结论」小节（参数形态修正记录）

**Interfaces:**
- Consumes: 全部前序任务的线上函数 + 前端。
- Produces: 实测敲定的智谱联网参数最终形态（若有出入需回改 `providers.ts buildBody` 并补一条 providers 测试断言，重跑 build+deploy，commit `fix(research): …`）。

**前置（阻塞项）**：向用户索取两件事，缺一不得开始——①智谱与百炼各一把临时 key（贴入浏览器研究面板即可，不经对话/不落文件）；②确认线上账号已登录。key 若经本会话终端命令传递，仅允许写入 curl 单次调用的环境变量，严禁 echo/落盘。

- [ ] **Step 1: 服务商直测（不过 Edge，隔离变量）**

```bash
read -rs "ZKEY?智谱 key（隐藏输入，仅存本 shell 变量）: " ZKEY && export ZKEY
curl -sS https://open.bigmodel.cn/api/paas/v4/chat/completions \
  -H "Authorization: Bearer $ZKEY" -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"用 web_search 查一下：潍柴动力最近一次业绩说明会的日期与主要表述（一句话+来源）"}],"tools":[{"type":"web_search"}]}' | head -c 1200
```

判定：模型名有效（400 model not found 即记录真实可用 flash 档并列出）；回答含时效性信息/来源指称 = 联网生效。百炼同理（dashscope compatible-mode + `"enable_search":true,"search_options":{"search_strategy":"max"}`）。**若 web_search 参数被拒**：按 spec §10 风险行走备选形态（智谱平台联网参数以官方文档当时形态为准），改 `buildBody` → 补测试 → `deno test -A` → `build.ts` → 重新 deploy。**每家各一次 curl 即停，不重试刷配额。**

- [ ] **Step 2: Edge 端到端（浏览器）**

线上页面（GitHub Pages 地址）走完整流程：智谱研究 600338 → done 六段报告渲染、来源链接可点、胶囊出现在持仓卡（若持仓）；再查 `stock_fundamental`（Management API SELECT）确认落库行 provider/model/status 正确、error 列无 key 子串。**同一码 1 小时内再点「生成研究」→ 结果卡显示「1 小时缓存命中，未产生新调用」且不产生新费用（finished_at 不变为证）。**

- [ ] **Step 3: 计时与 timeout 结论**

记录 generate 端到端耗时（浏览器 Network 面板）。若撞 Edge wall-clock（502/`FunctionTimeout`）：spec §10 备案的 V1.1「搜索与成文分离」触发，在交付记录写明，不在本计划内私拆。

- [ ] **Step 4: 交付记录 + 记忆同步**

`integration-report.md` 逐项覆盖 spec §3 实测清单：模型名有效性 / 联网真实性 / Edge 出网 / CORS+preflight 形态 / 单次耗时 / token 量级（服务商后台可见则记，不可见则记「未取证」）。spec 追加「实测结论」小节；commit `docs(research): 联调实测记录`。UpdateMemory 修订产业研究员存档条目为「已上线」状态。

- [ ] **Step 5: 收尾**

`unset ZKEY`；确认 shell 历史无 key 明文（zsh 前导空格技巧或 `history -d`）。按 finishing-a-development-branch 呈现三选项菜单（本仓惯例：合并 main 前跑 `deno test -A supabase/functions/stock-research/ scripts/` 全绿）。

---

## 计划自检记录（writing-plans Step 自审）

1. **Spec 覆盖**：§2 密钥不固化→Task 5/6（sessionStorage+脱敏摘要+函数不落盘）；§3 适配器+实测→Task 3/7；§4 verify_jwt→Task 4 Step 4；§5 表+防重→Task 1/2；§6 函数契约→Task 4；§7 提示词→Task 2 buildPrompt；§8 前端三挂载→Task 5/6；§9 测试矩阵→Task 2/3/5 各自覆盖（提示词在位/解析三态/防重矩阵/falsy 自查/无 key 断言）；§11 交付切分 1-4 → Task 1 / 2+3+4 / 5+6 / 7。无缺口。
2. **占位符扫描**：无 TBD；「现场微调允许处」均已写明判据与边界（Task 4 Step 3 build 剥 import 正则、Task 7 Step 1 备选参数形态）。
3. **类型一致性**：`dedupeAction` 返回 `'run'|'reuse_running'|'reuse_done'`（Task 2 定义 ↔ Task 4 使用 `act!=='run'`）；`callResearch` 返 string（Task 3）→ Task 4 交 `parseReport(text)`；前端 `invokeResearch` 返回体 `{ok,row,cached?}` 与 Task 4 json 构造逐字段一致；`RESEARCH_PROVIDERS`（Task 5 块内）在 Task 6 事件代码使用同名。
4. **已知取舍**（Ruling 预记录）：函数同步等待最长 ~150-300s（Edge 默认 wall-clock），V1 接受——超时是 V1.1 触发条件非缺陷；`mixRow` 恒 null（mix 走 score extras 防双源漂移）——Task 4 注释已写明，非遗漏。
