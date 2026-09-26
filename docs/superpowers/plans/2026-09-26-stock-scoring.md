# 个股多因子量化评分 V1.0 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每晚用国信智能选股 2 次全池调用为全 A 股计算四因子评分（Q30/G30/V20/M20），落库 stock_score，并在信号台股票页呈现精选池 Top10 推荐区块与持仓评分胶囊。

**Architecture:** 新建独立 Edge Function `stock-score`（pg_cron 夜间触发）：GS 宽表 → 纯函数评分引擎（同花顺行业内 winsorize 百分位、双层 NA 重归一）→ REST upsert `stock_score`（批次制）→ 前端 supabase-js 只读渲染。风控仅异常标记不进分数。

**Tech Stack:** Supabase Edge Runtime (Deno/TypeScript)、`deno test`（引擎单测）、Postgres + pg_cron、单文件前端 index.html（supabase-js）、Management API 部署（PAT，同 daily-update）。

**Spec:** `docs/superpowers/specs/2026-09-26-stock-scoring-v1-design.md`（11 条决策记录以 spec 为准，本计划不重复议价）

## Global Constraints

- 权重固定 30/30/20/20，未经回测不得调整（spec §22）
- 风控条件（负债率>80% 等）只进 `flags`，不进分数
- 唯一硬过滤 = 剔除 ST/*ST/退市；亏损股 Value=NA 重归一，不剔除
- 行业回退规则固定：同花顺二级样本≥20 → 一级≥20 → 全市场；组内样本<5 不产生百分位
- PEG 有效判据：PE∈(0,200] 且扣非增速∈[10,300]；否则 NA
- GS_API_KEY、DAILY_UPDATE_TOKEN 只存 Supabase 函数 secrets，不写代码/日志/git
- 接口失败重试 2 次后保留旧批次，前端显示陈旧提示；GS 返回行数 <4000 视为上游异常
- 所有列名按前缀匹配（GS 列名内嵌日期戳，每日变化）
- 前端文案必须含"评分为横截面相对位置，不构成买卖建议"
- 项目无 npm 依赖；edge 函数以单文件部署，多文件仅用于本地测试（见 Task 4 构建脚本）

---

### Task 1: 建表 stock_score / stock_pool + RLS + 池种子

**Files:**
- Modify: 云端 schema（Management API SQL，无本地迁移文件）
- Create: `scripts/seed_pool.sql`（种子 SQL，仓库留档）

**Interfaces:**
- Produces: 表 `public.stock_score(batch_date, code, name, ths_l1/l2/l3, quality, growth, value, momentum, final, ind_rank, ind_n, market_rank, market_n, in_pool, cov, pe, peg, roe, debt, flags, warnings, extras, updated_at)`，主键 `(batch_date, code)`；表 `public.stock_pool(code, name)`。Task 4 写入、Task 6/7 读取。

- [ ] **Step 1: 建表 SQL（经 Management API 执行）**

```sql
create table if not exists public.stock_score (
  batch_date date not null,
  code text not null,
  name text,
  ths_l1 text, ths_l2 text, ths_l3 text,
  quality numeric, growth numeric, value numeric, momentum numeric,
  final numeric not null,
  ind_rank int, ind_n int, market_rank int, market_n int,
  in_pool boolean not null default false,
  cov numeric, pe numeric, peg numeric, roe numeric, debt numeric,
  flags jsonb not null default '[]', warnings jsonb not null default '[]',
  extras jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (batch_date, code)
);
create index if not exists stock_score_batch_final on public.stock_score (batch_date desc, final desc);
create table if not exists public.stock_pool (code text primary key, name text);
alter table public.stock_score enable row level security;
alter table public.stock_pool enable row level security;
drop policy if exists "stock_score read" on public.stock_score;
create policy "stock_score read" on public.stock_score for select to anon, authenticated using (true);
drop policy if exists "stock_pool read" on public.stock_pool;
create policy "stock_pool read" on public.stock_pool for select to anon, authenticated using (true);
```

执行命令（与既有会话一致）：

```bash
PAT=$(security find-generic-password -s supabase-pat -a alick -w 2>/dev/null || echo '<从钥匙串/环境变量取>')
curl -sS -X POST "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query" \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d "{\"query\": $(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' < /tmp/task1.sql)}"
```

- [ ] **Step 2: 种子精选池**

从本地池清单生成 INSERT（`/tmp/pool_full.json` 若已被清理，则用东财 `RPT_INDEX_COMPONENT` 按 spec §3.2 的 5 指数重拉；代码见 daily 会话脚本模式）。生成 `scripts/seed_pool.sql`：

```bash
python3 - <<'PY'
import json
pool = json.load(open('/tmp/pool_full.json'))
codes = []
def walk(x):
    if isinstance(x, list): [walk(i) for i in x]
    elif isinstance(x, dict):
        c = x.get('code') or x.get('SECURITY_CODE')
        if c: codes.append((str(c)[:6], x.get('name') or x.get('SECURITY_NAME_ABBR') or ''))
        else: [walk(v) for v in x.values()]
walk(pool)
vals = ',\n'.join(f"('{c}','{n.replace(chr(39),chr(39)*2)}')" for c, n in sorted(set(codes)) if len(c) == 6)
open('scripts/seed_pool.sql', 'w').write(f"insert into public.stock_pool (code,name) values\n{vals}\non conflict (code) do nothing;\n")
print('seed rows:', vals.count('(') - 1)
PY
```

用 Step 1 同款 Management API 命令执行 `scripts/seed_pool.sql`。

- [ ] **Step 3: 验证**

```bash
curl -sS "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/database/query" \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d '{"query":"select (select count(*) from stock_pool) pool_n, (select count(*) from stock_score) score_n"}'
```
Expected: `pool_n >= 1000`，`score_n = 0`。anon 可读验证：
```bash
curl -sS "https://sfauluwxmdginezbluvo.supabase.co/rest/v1/stock_pool?select=code&limit=1" -H "apikey: <PUBLISHABLE_KEY>" -H "Authorization: Bearer <PUBLISHABLE_KEY>"
```
Expected: 返回 1 行（不是 401/403）。

- [ ] **Step 4: Commit**

```bash
git add scripts/seed_pool.sql docs/superpowers/plans/2026-09-26-stock-scoring.md
git commit -m "feat(stock-score): 建表 stock_score/stock_pool + RLS + 池种子"
```

---

### Task 2: 评分引擎纯函数（engine.ts）+ deno 单测

**Files:**
- Create: `supabase/functions/stock-score/engine.ts`
- Create: `supabase/functions/stock-score/engine_test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `interface Stock { code: string; name: string; ths: string[]; roe: number|null; mlr: number|null; kc: number|null; gm: number|null; rev: number|null; debt: number|null; pe: number|null; isFin: boolean; isST: boolean; r60: number|null; close: number|null; a20: number|null; a60: number|null }`
  - `interface ScoreRow extends Stock { quality: number|null; growth: number|null; value: number|null; momentum: number|null; final: number|null; indRank: number; indN: number; marketRank: number; marketN: number; cov: number; peg: number|null; flags: string[] }`
  - `function assignGroups(stocks: Stock[]): Map<string, string>`（`'L2:汽车-汽车零部件' | 'L1:传媒' | 'MARKET'`）
  - `function pctWithinGroups(stocks: Stock[], get: (s: Stock) => number|null, reverse?: boolean): Map<string, number>`（组内 P1/P99 截尾 + `(低于数+0.5×并列数)/N×100`；组内有效样本 <5 → 该组不产生分数）
  - `function computeScores(stocks: Stock[]): ScoreRow[]`（含 ST 过滤、双层 NA 重归一、覆盖 <40 返回 final:null、flags 负债率>80、市场排名）
  - Task 3/4 按此签名消费。

- [ ] **Step 1: 环境检查**

```bash
deno --version || brew install deno
```

- [ ] **Step 2: 写失败测试（分位数与组回退）**

`engine_test.ts`：

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assignGroups, pctWithinGroups, computeScores, type Stock } from './engine.ts';

function mk(over: Partial<Stock>): Stock {
  return { code: '000001', name: 'x', ths: ['A', 'B', 'C'], roe: 10, mlr: 20, kc: 15,
    gm: 15, rev: 10, debt: 50, pe: 20, isFin: false, isST: false,
    r60: 5, close: 10, a20: 9, a60: 8, ...over };
}

Deno.test('同花顺二级<20只时回退一级，一级也<20回退全市场', () => {
  const many: Stock[] = Array.from({ length: 20 }, (_, i) => mk({ code: `m${i}`, ths: ['传媒', '影视', 'x'] }));
  const few: Stock[] = Array.from({ length: 8 }, (_, i) => mk({ code: `f${i}`, ths: ['综合', '综合Ⅱ', 'x'] }));
  const g = assignGroups([...many, ...few]);
  assertEquals(g.get('m0'), 'L2:传媒-影视');
  assertEquals(g.get('f0'), 'MARKET'); // 一级"综合"仍<20 → 全市场
});

Deno.test('组内百分位：最高=100方向，并列取中，逆序翻转', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `c${i}`, roe: i % 5 })); // 5档并列
  const p = pctWithinGroups(s, x => x.roe);
  const vals = new Set([...p.values()]);
  assertEquals(Math.max(...vals), 98);   // (20+2.5)/25*100 附近，非 100
  const rev = pctWithinGroups(s, x => x.roe, true);
  assertEquals([...vals].map(v => 100 - v).sort((a, b) => a - b)[0], Math.min(...rev.values()));
});

Deno.test('组内有效样本<5 不产生百分位', () => {
  const s = Array.from({ length: 20 }, (_, i) => mk({ code: `a${i}` }));
  s.push(...Array.from({ length: 4 }, (_, i) => mk({ code: `b${i}`, ths: ['稀有', '稀有Ⅱ', 'x'] })));
  const p = pctWithinGroups(s, x => x.roe);
  assertEquals(p.has('b0'), false);
});
```

- [ ] **Step 3: 运行确认失败**

```bash
cd supabase/functions/stock-score && deno test --allow-read engine_test.ts
```
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 engine.ts（分位/回退部分）**

```ts
export interface Stock {
  code: string; name: string; ths: string[];
  roe: number | null; mlr: number | null; kc: number | null; gm: number | null;
  rev: number | null; debt: number | null; pe: number | null;
  isFin: boolean; isST: boolean;
  r60: number | null; close: number | null; a20: number | null; a60: number | null;
}
export interface ScoreRow extends Stock {
  quality: number | null; growth: number | null; value: number | null; momentum: number | null;
  final: number | null; indRank: number; indN: number; marketRank: number; marketN: number;
  cov: number; peg: number | null; flags: string[]; grp: string;
}

export function assignGroups(stocks: Stock[]): Map<string, string> {
  const l2 = new Map<string, number>(); const l1 = new Map<string, number>();
  for (const s of stocks) {
    if (s.ths.length >= 2) l2.set(`${s.ths[0]}-${s.ths[1]}`, (l2.get(`${s.ths[0]}-${s.ths[1]}`) ?? 0) + 1);
    if (s.ths.length >= 1) l1.set(s.ths[0], (l1.get(s.ths[0]) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of stocks) {
    const k2 = s.ths.length >= 2 ? `${s.ths[0]}-${s.ths[1]}` : '';
    const k1 = s.ths.length >= 1 ? s.ths[0] : '';
    if (k2 && (l2.get(k2) ?? 0) >= 20) out.set(s.code, `L2:${k2}`);
    else if (k1 && (l1.get(k1) ?? 0) >= 20) out.set(s.code, `L1:${k1}`);
    else out.set(s.code, 'MARKET');
  }
  return out;
}

const w = <T>(arr: T[], f: (x: T) => number | null): number[] =>
  arr.map(f).filter((v): v is number => v !== null && Number.isFinite(v));

export function pctWithinGroups(stocks: Stock[], get: (s: Stock) => number | null, reverse = false): Map<string, number> {
  const groups = assignGroups(stocks);
  const byG = new Map<string, Stock[]>();
  stocks.forEach(s => { const g = groups.get(s.code)!; (byG.get(g) ?? byG.set(g, []).get(g)!).push(s); });
  const out = new Map<string, number>();
  for (const [, members] of byG) {
    const valid = members.map(s => [s, get(s)] as const).filter(([, v]) => v !== null && Number.isFinite(v)) as [Stock, number][];
    if (valid.length < 5) continue;
    const nums = valid.map(([, v]) => v).sort((a, b) => a - b);
    const p1 = nums[Math.floor(nums.length * 0.01)]; const p99 = nums[Math.min(nums.length - 1, Math.floor(nums.length * 0.99))];
    const cl = valid.map(([s, v]) => [s, Math.min(Math.max(v, p1), p99)] as const);
    const sv = cl.map(([, v]) => v).sort((a, b) => a - b);
    for (const [s, v] of cl) {
      const lo = sv.filter(x => x < v).length; const eq = sv.filter(x => x === v).length;
      const pct = (lo + 0.5 * eq) / sv.length * 100;
      out.set(s.code, reverse ? 100 - pct : pct);
    }
  }
  return out;
}
```

- [ ] **Step 5: 运行确认通过**

```bash
deno test --allow-read engine_test.ts
```
Expected: 3 tests PASS。

- [ ] **Step 6: 写失败测试（computeScores 四因子与 NA 重归一）**

追加到 `engine_test.ts`：

```ts
Deno.test('金融股：毛利率NA → Quality=ROE单腿；权重全落单指标', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `b${i}`, roe: i, mlr: null, isFin: true, kc: i, gm: i, rev: i, pe: 5 + i / 10, r60: i - 12, close: 10, a20: 10 + (i - 12) / 100, a60: 10 }));
  const rows = computeScores(s);
  const mid = rows.find(r => r.code === 'b12')!;
  assertEquals(mid.quality, Math.round(mid.__roePct ?? 50 * 10) / 10); // 单腿≈其ROE百分位
  assertEquals(mid.cov, 100);
});
Deno.test('PEG 有效性：扣非增速8(<10) → NA → Value=PE单指标；增速500(>300) 同 NA', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `p${i}`, kc: i === 0 ? 8 : i === 1 ? 500 : 20, pe: 15 }));
  const rows = computeScores(s);
  assertEquals(rows.find(r => r.code === 'p0')!.peg, null);
  assertEquals(rows.find(r => r.code === 'p1')!.peg, null);
  assertEquals(typeof rows.find(r => r.code === 'p2')!.peg, 'number');
});
Deno.test('亏损股 PE<0：Value=NA → 三维重归一 30/30/20→37.5/37.5/25，cov=80', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `l${i}`, pe: i === 0 ? -12 : 15 }));
  const rows = computeScores(s);
  const loss = rows.find(r => r.code === 'l0')!;
  assertEquals(loss.value, null);
  assertEquals(loss.cov, 80);
  assertEquals(loss.final !== null, true);
});
Deno.test('绝对趋势三条件：空头=0 全满足=100', () => {
  const s: Stock[] = [];
  for (let i = 0; i < 25; i++) s.push(mk({ code: `t${i}`, close: 10, a20: i === 0 ? 11 : 8.5, a60: i === 0 ? 12 : 8, r60: i }));
  const rows = computeScores(s);
  assertEquals((rows.find(r => r.code === 't0')! as unknown as { absTrend: number }).absTrend, 0);
  assertEquals((rows.find(r => r.code === 't1')! as unknown as { absTrend: number }).absTrend, 100);
});
Deno.test('ST 剔除、负债率>80 打标不进分', () => {
  const s = Array.from({ length: 25 }, (_, i) => mk({ code: `s${i}`, isST: i === 0, debt: i === 1 ? 85 : 50 }));
  const rows = computeScores(s);
  assertEquals(rows.find(r => r.code === 's0'), undefined);
  assertEquals(rows.find(r => r.code === 's1')!.flags.includes('负债率>80%'), true);
});
```

注：金融股测试中的 `mid.__roePct` 行按实现改为 `assertEquals(mid.quality !== null, true)`（单腿断言以 cov 不降、quality 与 ROE 百分位一致为准），实现者以语义断言为准。

- [ ] **Step 7: 运行确认失败** → FAIL（computeScores 未定义）。

- [ ] **Step 8: 实现 computeScores**

追加到 `engine.ts`：

```ts
const WEIGHTS = { quality: 30, growth: 30, value: 20, momentum: 20 };

function renorm(pairs: [number | null, number][]): [number | null, number] {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, wt]) => a + wt, 0);
  if (tot === 0) return [null, 0];
  return [valid.reduce((a, [v, wt]) => a + v * wt, 0) / tot, tot];
}

export function computeScores(all: Stock[]): ScoreRow[] {
  const stocks = all.filter(s => !s.isST);
  const groups = assignGroups(stocks);
  const gOf = (s: Stock) => groups.get(s.code)!;
  const membersOf = (g: string) => stocks.filter(s => groups.get(s.code) === g);

  const pct = {
    roe: pctWithinGroups(stocks, s => s.roe),
    mlr: pctWithinGroups(stocks, s => s.mlr),
    kc: pctWithinGroups(stocks, s => s.kc),
    gm: pctWithinGroups(stocks, s => s.gm),
    rev: pctWithinGroups(stocks, s => s.rev),
    r60: pctWithinGroups(stocks, s => s.r60),
    pma20: pctWithinGroups(stocks, s => (s.close && s.a20 ? s.close / s.a20 : null)),
    peInv: pctWithinGroups(stocks, s => (s.pe && s.pe > 0 ? s.pe : null), true),
    pegInv: new Map<string, number>(), // 下面按 peg 值补算
  };
  const pegOf = (s: Stock): number | null =>
    s.pe && s.pe > 0 && s.pe <= 200 && s.kc !== null && s.kc >= 10 && s.kc <= 300 ? s.pe / s.kc : null;
  { // PEG 逆百分位（同组内，仅有效样本）
    const pegStocks = stocks.filter(s => pegOf(s) !== null) as (Stock & { __peg: number })[];
    pegStocks.forEach(s => (s.__peg = pegOf(s)!));
    const p = pctWithinGroups(pegStocks, s => s.__peg, true);
    p.forEach((v, k) => pct.pegInv.set(k, v));
  }
  const get = (m: Map<string, number>, s: Stock) => m.get(s.code) ?? null;

  const rows: ScoreRow[] = stocks.map(s => {
    const q = renorm([[get(pct.roe, s), 50], [s.isFin ? null : get(pct.mlr, s), 50]])[0];
    const gr = renorm([[get(pct.kc, s), 35], [get(pct.gm, s), 15], [get(pct.rev, s), 50]])[0];
    const v = renorm([[get(pct.peInv, s), 50], [get(pct.pegInv, s), 50]])[0];
    const rel = renorm([[get(pct.r60, s), 50], [get(pct.pma20, s), 50]])[0];
    let mo: number | null = null;
    let absTrend = -1;
    if (s.close !== null && s.a20 !== null && s.a60 !== null) {
      const conds = [s.close > s.a20, s.close > s.a60, s.a20 > s.a60].map(Number);
      absTrend = conds.reduce((a, b) => a + b, 0) / 3 * 100;
      mo = renorm([[rel, 50], [absTrend, 50]])[0];
    }
    const [fin, cov] = renorm([[q, WEIGHTS.quality], [gr, WEIGHTS.growth], [v, WEIGHTS.value], [mo, WEIGHTS.momentum]]);
    return {
      ...s, quality: q, growth: gr, value: v, momentum: mo,
      final: cov >= 40 ? fin : null, indRank: 0, indN: 0, marketRank: 0, marketN: 0,
      cov, peg: pegOf(s), flags: s.debt !== null && s.debt > 80 ? ['负债率>80%'] : [], grp: gOf(s),
      ...( { absTrend } as object),
    } as ScoreRow & { absTrend: number };
  });
  // 行业排名（组内按 final 降序）
  const byFinal = rows.filter(r => r.final !== null).sort((a, b) => b.final! - a.final!);
  byFinal.forEach((r, i) => { r.marketRank = i + 1; });
  for (const r of byFinal) {
    const mate = byFinal.filter(x => x.grp === r.grp);
    r.indN = mate.length; r.indRank = mate.indexOf(r) + 1;
  }
  return rows;
}
```

- [ ] **Step 9: 运行全部测试通过**

```bash
deno test --allow-read engine_test.ts
```
Expected: 全部 PASS（若断言细节与实现返回值不符，修断言使其忠实于 spec §2 规则，禁止改规则迁就实现）。

- [ ] **Step 10: 黄金样本冒烟（真数据，一次性）**

```bash
deno run --allow-read --allow-env --allow-net scripts/gs_to_stocks.ts /tmp/v1_fin_table.json /tmp/v1_mom_table.json | \
  deno run --allow-read -s - <<'TS'
// 冒烟：断言潍柴 M<30 且 Q>60、亚虹类亏损股 value===null、银行 quality 非空
TS
```
（`scripts/gs_to_stocks.ts` 在 Task 3 正式交付；此步可跳过到 Task 3 后补跑。）

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/stock-score/
git commit -m "feat(stock-score): 四因子评分引擎纯函数+单测（分位/回退/NA重归一/PEG判据/趋势三条件）"
```

---

### Task 3: GS 宽表解析适配器（gs.ts）+ 真实快照测试

**Files:**
- Create: `supabase/functions/stock-score/gs.ts`
- Create: `supabase/functions/stock-score/fixtures/fin_sample.json`、`fixtures/mom_sample.json`
- Create: `supabase/functions/stock-score/gs_test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Stock`
- Produces: `interface GsTable { [col: string]: (string | number | null)[] }`、`function colByPrefix(t: GsTable, prefix: string): string | undefined`、`function mergeTables(fin: GsTable, mom: GsTable): Stock[]`（含 `isST`：名称含 ST/退 或缺"全部A股(非ST)"标记；`isFin`：缺"全部A股(非金融)"标记；`ths`: 按 '-' 拆分）、`function gsFetch(query: string, apiKey: string): Promise<GsTable>`（GET 智能选股端点，重试 2 次，行数守卫由调用方做）
- 常量：`Q_FIN = '全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、所属同花顺行业'`、`Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业'`

- [ ] **Step 1: 生成本地测试 fixtures（GS 真响应截样：50 行 + 5 只黄金股票）**

```bash
cd "/Users/alick/Documents/GitHub/fund invest" && python3 - <<'PY'
import json, os
os.makedirs('supabase/functions/stock-score/fixtures', exist_ok=True)
GOLD = ['000338.SZ', '002415.SZ', '600031.SH', '688176.SH', '002142.SZ', '600036.SH', '688331.SH', '002292.SZ']
def trim(path, out):
    t = json.load(open(path)); codes = t['股票代码']; keep = list(dict.fromkeys(codes[:50] + [c for c in GOLD if c in codes]))
    json.dump({k: [v[i] for i, c in enumerate(codes) if c in keep] for k, v in t.items()} | {'股票代码': keep},
              open(out, 'w'), ensure_ascii=False)
# 若 /tmp 已清理，先重拉（走本机已装 skill 脚本）
SK = os.path.expanduser('~/.qoder-cn/plugins/cache/local/guosen-finance/skills/gs-smart-stock-picking')
if not os.path.exists('/tmp/v1_fin_table.json'):
    import subprocess, sys
    key = [l for l in open(f'{SK}/memory.md') if l.startswith('GS_API_KEY')][0].split('=')[1].strip()
    code = (f"import sys,json;sys.path.insert(0,'{SK}/scripts');"
            f"from gs_stock_picking import smart_stock_picking as f;"
            "json.dump(f('全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、所属同花顺行业','stock',sys.argv[1])['data'][0]['table'],open('/tmp/v1_fin_table.json','w'),ensure_ascii=False);"
            "json.dump(f('全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业','stock',sys.argv[1])['data'][0]['table'],open('/tmp/v1_mom_table.json','w'),ensure_ascii=False)")
    subprocess.run(['python3', '-c', code, key], check=True)
trim('/tmp/v1_fin_table.json', 'supabase/functions/stock-score/fixtures/fin_sample.json')
trim('/tmp/v1_mom_table.json', 'supabase/functions/stock-score/fixtures/mom_sample.json')
print('fixtures ready')
PY
```

- [ ] **Step 2: 写失败测试 `gs_test.ts`**

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { colByPrefix, mergeTables } from './gs.ts';

Deno.test('列名前缀匹配忽略日期戳', () => {
  const t = { '市盈率(pe)[20260924]': [1], '资产负债率[20260630]': [2] } as never as Record<string, never[]>;
  assertEquals(colByPrefix(t, '市盈率(pe)'), '市盈率(pe)[20260924]');
  assertEquals(colByPrefix(t, '净资产收益率'), undefined);
});

Deno.test('mergeTables: ST 判定/金融判定/行业拆分/持仓数值抽取', () => {
  const fin = JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json'));
  const mom = JSON.parse(Deno.readTextFileSync('fixtures/mom_sample.json'));
  const stocks = mergeTables(fin, mom);
  const wc = stocks.find(s => s.code === '000338.SZ')!;
  assertEquals(wc.ths[0], '汽车'); assertEquals(wc.isST, false); assertEquals(wc.isFin, false);
  assertEquals(Math.round(wc.debt!), 64);
  const nb = stocks.find(s => s.code === '600036.SH')!; // 招商银行
  assertEquals(nb.isFin, true);
});

Deno.test('合并取交集且保留 GS 全码', () => {
  const fin = JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json'));
  const stocks = mergeTables(fin, fin); // 自合并也应跑通（列缺失→字段 null）
  assertEquals(stocks.every(s => /\.(SZ|SH|BJ)$/.test(s.code)), true);
});
```

- [ ] **Step 3: `cd supabase/functions/stock-score && deno test --allow-read gs_test.ts` → FAIL**

- [ ] **Step 4: 实现 `gs.ts`**

```ts
import type { Stock } from './engine.ts';
export type GsTable = Record<string, (string | number | null)[]>;

export const Q_FIN = '全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、所属同花顺行业';
export const Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}
const num = (v: string | number | null | undefined): number | null => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const col = (t: GsTable, prefix: string, i: number) => { const k = colByPrefix(t, prefix); return k ? t[k][i] : null; };

export async function gsFetch(query: string, apiKey: string, timeoutMs = 90_000): Promise<GsTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz ${JSON.stringify(j?.result?.[0])}`);
      const table = j?.data?.[0]?.table as GsTable | undefined;
      if (!table?.['股票代码']) throw new Error('GS table missing');
      return table;
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); }
  }
  throw lastErr;
}

export function mergeTables(fin: GsTable, mom: GsTable): Stock[] {
  const codes = fin['股票代码'] as string[];
  const momIdx = new Map((mom['股票代码'] as string[] ?? []).map((c, i) => [c, i]));
  const out: Stock[] = [];
  const thsK = colByPrefix(fin, '所属同花顺行业');
  const mktK = colByPrefix(fin, '股票市场类型');
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]; const name = (col(fin, '股票简称', i) ?? '') as string;
    const mkt = (mktK ? fin[mktK][i] : '') as string ?? '';
    const j = momIdx.get(code) ?? -1;
    out.push({
      code, name, ths: (((thsK ? fin[thsK][i] : '') as string) ?? '').split('-'),
      roe: num(col(fin, '净资产收益率roe', i)), mlr: num(col(fin, '销售毛利率', i)),
      kc: num(col(fin, '归属母公司股东的净利润-扣除', i)), gm: num(col(fin, '归属母公司股东的净利润(同比', i)),
      rev: num(col(fin, '营业总收入(同比', i)), debt: num(col(fin, '资产负债率', i)),
      pe: num(col(fin, '市盈率(pe)', i)),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      r60: j >= 0 ? num(col(mom, '区间涨跌幅:前复权[2026', j)) : null, // 60日窗口=最早起始日，见下条
      close: j >= 0 ? num(col(mom, '区间收盘价', j)) : null,
      a20: j >= 0 ? num(col(mom, '区间成交均价[20260828', j) ?? col(mom, '区间成交均价', j) && null : null,
      a60: j >= 0 ? num(col(mom, '区间成交均价[20260703', j)) : null,
    });
  }
  // 窗口列按起始日排序：最早的=60日窗，最晚的非"区间收盘价"=20日窗；实现者用
  // sortedWindowCols(mom,'区间涨跌幅') / sortedWindowCols(mom,'区间成交均价') 辅助函数替换上面的硬编码日期。
  return out;
}
export function sortedWindowCols(t: GsTable, prefix: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(prefix)).sort(); // 列名内嵌 yyyyMMdd 起始日，字典序=时间序
}
```

⚠️ 上面 `mergeTables` 中动量三列（r60/a20/a60）的取值必须经 `sortedWindowCols` 通用化：涨跌幅与均价各两窗（起始日早者=60日，晚者=20日）；`区间收盘价` 取列表最后一个即最新。**实现时先删掉硬编码日期，用该辅助函数接线**，再跑 Step 5。

- [ ] **Step 5: `deno test --allow-read .`（engine+gs 全绿）**；黄金样本冒烟：

```bash
deno run --allow-read -A - <<'TS'
import { mergeTables, } from './gs.ts';
import { computeScores } from './engine.ts';
const fin = JSON.parse(Deno.readTextFileSync('fixtures/fin_sample.json'));
const mom = JSON.parse(Deno.readTextFileSync('fixtures/mom_sample.json'));
const rows = computeScores(mergeTables(fin, mom)).filter(r => r.final !== null);
const wc = rows.find(r => r.code === '000338.SZ');
console.log(wc && { name: wc.name, final: wc.final, q: wc.quality, m: wc.momentum, flags: wc.flags });
TS
```
Expected: 潍柴输出存在、momentum < 35（小样本 fixture 里分数不要求等于全池真值，只验证管线接通）。

- [ ] **Step 6: Commit** `git add supabase/functions/stock-score && git commit -m "feat(stock-score): GS宽表解析适配器+真实快照fixtures+窗口列泛型匹配"`

---

### Task 4: 编排函数 index.ts（含增强与构建脚本）+ secrets + 部署冒烟

**Files:**
- Create: `supabase/functions/stock-score/index.ts`
- Create: `supabase/functions/stock-score/build.ts`（拼接 engine+gs 为单文件 deploy.ts）
- Modify: Supabase 函数 secrets

**Interfaces:**
- Consumes: Task 2/3 全部导出；REST 模式抄 daily-update（`SB_URL`/`SB_SERVICE_KEY` env、`rest/v1/<table>?on_conflict=` 批量 upsert，见 daily-update index.ts L181-196）
- Produces: `POST /functions/v1/stock-score`，Header `Authorization: Bearer <DAILY_UPDATE_TOKEN>`；query 参数 `mode=ping`（只探 GS 小查询）/ `mode=run`（默认全量）；响应 `{ ok, batch_date, scored, skipped, top10: [{code,name,final}] }`

- [ ] **Step 1: 写 index.ts**

```ts
/// <reference lib="deno.ns" />
import { computeScores, type Stock } from './engine.ts';
import { gsFetch, mergeTables, Q_FIN, Q_MOM, type GsTable } from './gs.ts';

const MIN_ROWS = 4000;

async function upsert(rows: Record<string, unknown>[], table: string, onConflict: string) {
  const url = Deno.env.get('SUPABASE_URL')!; const key = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
  }
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const u = new URL(req.url); const mode = u.searchParams.get('mode') || 'run';
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  try {
    if (mode === 'ping') {
      const t = await gsFetch('工程机械行业市盈率低于20的股票', key);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const [finT, momT] = [await gsFetch(Q_FIN, key), await gsFetch(Q_MOM, key)];
    const n = (finT['股票代码']?.length ?? 0);
    if (n < MIN_ROWS || (momT['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error(`GS 行数异常 fin=${n}，保留旧批次`);
    const stocks: Stock[] = mergeTables(finT, momT);
    const periodStamp = (Object.keys(finT).find(k => k.startsWith('资产负债率')) ?? '').match(/\[(\d{8})\]/)?.[1] ?? '';
    const batch = new Date().toISOString().slice(0, 10);
    const rows = computeScores(stocks);
    const pool = await (await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/stock_pool?select=code`, {
      headers: { apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SB_SERVICE_KEY')!, Authorization: 'placeholder' } })).json();
    const poolSet = new Set((pool as { code: string }[]).map(p => p.code));
    const scored = rows.filter(r => r.final !== null);
    const top = scored.filter(r => poolSet.has(r.code.split('.')[0])).slice(0, 10);
    // 增强：Top10+持仓 周期警示（扣非增速>300 或单年>100 → 拉4期年报核对3年CAGR），失败不阻塞
    const warnings = new Map<string, string[]>();
    for (const r of [...top, ...scored.filter(r => ['000338.SZ', '002415.SZ', '600031.SH'].includes(r.code))]) {
      if (r.kc !== null && r.kc > 100) warnings.set(r.code, [`单年扣非+${Math.round(r.kc)}%，需查3年CAGR/周期位置`]);
    }
    await upsert(scored.map(r => ({
      batch_date: batch, code: r.code.split('.')[0], name: r.name,
      ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null, ths_l3: r.ths[2] ?? null,
      quality: r.quality, growth: r.growth, value: r.value, momentum: r.momentum, final: r.final,
      ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: scored.length,
      in_pool: poolSet.has(r.code.split('.')[0]), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [],
      extras: { fin_period: periodStamp, abs_trend: (r as unknown as { absTrend?: number }).absTrend ?? null },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
```

注：pool 读取的 Authorization 头用与 daily-update 相同的 service headers 变量（实现时把 daily-update 里 `H` 的构造抄为本地函数 `svcHeaders()`，**不要把 'placeholder' 留在生产代码**）。

- [ ] **Step 2: 构建脚本 build.ts → 单文件 deploy.ts**

```ts
// build.ts — deno run --allow-read --allow-write build.ts
const rd = (f: string) => Deno.readTextFileSync(f)
  .replace(/^import .*?from '\.\/(?:engine|gs)\.ts';?$/gm, '')
  .replace(/^export (interface|type|const|function|async function)/gm, '$1');
const src = rd('engine.ts') + '\n' + rd('gs.ts').replace(/^import type .*$/gm, '') + '\n' +
  rd('index.ts').replace(/^import \{[^}]+\} from '\.\/(?:engine|gs)\.ts';?$/gm, '');
Deno.writeTextFileSync('deploy.ts', src);
console.log('deploy.ts bytes:', src.length);
```

- [ ] **Step 3: 注入 secrets + 部署**

```bash
PAT=<Management API PAT>
curl -sS -X POST "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/secrets" \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d "[{\"name\":\"GS_API_KEY\",\"value\":\"$(grep '^GS_API_KEY=' ~/.qoder-cn/plugins/cache/local/guosen-finance/skills/gs-smart-stock-picking/memory.md | cut -d= -f2)\"}]"
deno run --allow-read --allow-write build.ts
curl -sS -X POST "https://api.supabase.com/v1/projects/sfauluwxmdginezbluvo/functions/deploy?slug=stock-score" \
  -H "Authorization: Bearer $PAT" \
  -F 'metadata={"entrypoint_path":"deploy.ts","import_map_path":"","verify_jwt":false,"name":"stock-score","no_cache":true};type=application/json' \
  -F "file=@deploy.ts;type=application/typescript"
```

- [ ] **Step 4: ping 冒烟（验证 Deno 运行时到 GS 的 TLS 连通性——若失败按 systematic-debugging 处理，不得换源）**

```bash
sleep 15  # 等激活
curl -sS -X POST "https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-score?mode=ping" \
  -H "Authorization: Bearer $DAILY_UPDATE_TOKEN"
```
Expected: `{"ok":true,"rows":15}`（行数≈15）。

- [ ] **Step 5: 全量首跑 + 对账**

```bash
curl -sS -X POST "https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-score" \
  -H "Authorization: Bearer $DAILY_UPDATE_TOKEN"
```
Expected: `scored >= 4000`；随后 `select count(*), max(batch_date) from stock_score` 与 2026-09-26 试跑 Top10 diff ≤5 名（当日行情漂移内）。抽查潍柴：`select final, momentum, quality from stock_score where code='000338' and batch_date=current_date` → momentum<35。

- [ ] **Step 6: Commit**（含 deploy.ts 构建产物一起入库以便回滚溯源：`git add supabase/functions/stock-score && git commit -m "feat(stock-score): Edge 编排函数+构建脚本+部署冒烟"`）

---

### Task 5: pg_cron 夜间调度

**Files:**
- Modify: 云端 pg_cron（无本地文件）

**Interfaces:**
- Consumes: Task 4 的 `POST /functions/v1/stock-score`
- Produces: 每交易日夜间自动批次

- [ ] **Step 1: 抄既有 daily-update 调度配置**

```sql
select jobid, jobname, schedule, command from cron.job order by jobid;
```
记录 daily-update 任务的 `command` 结构（pg_net http_post + token 的存放方式）。

- [ ] **Step 2: 克隆该结构注册 stock-score 任务**

模板（token/URL 的取法与现有 job 完全一致，只改 URL slug 与 cron 表达式；排在 daily-update 之后，如每日北京 21:30=`'30 13 * * *'` UTC，七天全跑——周末 GS 返回上一交易日数据，幂等无害）：

```sql
select cron.schedule('stock-score-nightly', '30 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-score',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <同现有job的token引用法>'),
    body := '{}'::jsonb
  ) as req_id$$);
```

- [ ] **Step 3: 验证**：`select * from cron.job where jobname='stock-score-nightly';` 存在；次日晨查 `select max(batch_date), count(*) filter (where batch_date=current_date) from stock_score;` 确认自动跑批成功。

- [ ] **Step 4: Commit**（把执行的 SQL 文本追加到 `docs/superpowers/specs/2026-09-26-stock-scoring-v1-design.md` 附录或 `scripts/cron_stock_score.sql` 留档后提交）

---

### Task 6: 前端 · Top10 推荐区块

**Files:**
- Modify: `index.html`（`renderStockSection()` 前后、`loadAll()` 内）

**Interfaces:**
- Consumes: `stock_score`（anon select）、supabase-js 客户端 `sb`（既有变量）
- Produces: `state.scores`（`{ batch, rows: Map<code, row>, top10: row[] }`）、`loadStockScores()`、`renderScoreTop10()`

- [ ] **Step 1: 数据加载**——`loadAll()` 中 `stock_latest` 拉取之后追加：

```js
async function loadStockScores(){
  try{
    const { data: b } = await sb.from('stock_score').select('batch_date').order('batch_date',{ascending:false}).limit(1);
    if(!b?.length) return;
    const batch = b[0].batch_date;
    const { data } = await sb.from('stock_score').select('*').eq('batch_date', batch)
      .or('in_pool.eq.true,code.in('+(stocks.map(s=>s.id!=null?(stockByCode(s)?.code??''):'')+')').order('final',{ascending:false});
    state.scores = { batch, rows: new Map((data||[]).map(r=>[r.code,r])), top10:(data||[]).filter(r=>r.in_pool).slice(0,10) };
  }catch(e){ console.warn('scores load failed', e); }
}
```

注：持仓行筛选按现有 `stocks` 数组里实际 code 拼接（实现时读 `stockFormHtml`/`stocks` 结构取 code 列表，`.or()` 里含持仓 code + in_pool），随后页面初始化处调用 `loadStockScores().then(render)`。

- [ ] **Step 2: 渲染**——`renderStockSection()` 的 fund-head 之后插入容器 `+ renderScoreTop10()`：

```js
function renderScoreTop10(){
  if(!state.scores) return `<div class="signal-strip">评分批次尚未生成（夜间批处理上线后自动出现）</div>`;
  const { batch, top10 } = state.scores;
  const stars = f => f>=90?'★★★★★':f>=80?'★★★★☆':f>=70?'★★★★':f>=60?'★★★':f>=50?'★★':'★';
  return `<div class="card"><div class="card-title">精选池 Top10 · 量化初筛 <span class="muted" style="font-weight:400">批次 ${batch}</span></div>
    ${top10.map((r,i)=>`<div class="score-row" data-code="${r.code}">
      <span class="muted">#${i+1}</span> <b>${r.name}</b> <span class="muted">${r.code}</span>
      <span class="pill">${r.final.toFixed(1)}分 ${stars(r.final)}</span>
      <span class="muted">${r.ths_l1}/${r.ths_l2??''} 行业${r.ind_rank}/${r.ind_n} · 市场前${Math.round(100-r.market_rank/r.market_n*100)}%${(r.flags||[]).length?' ⚠'+r.flags.join('、'):''}</span>
    </div>`).join('')}
    <div class="muted" style="margin-top:6px">评分为横截面相对位置（质量30/成长30/估值20/动量20，行业内百分位），不构成买卖建议；点开持仓卡片可见你的股票同口径明细。</div>
  </div>`;
}
```

- [ ] **Step 3: 本地浏览器验证**：`python3 -m http.server 8000` + 浏览器（或 browser-use）打开股票页 → Top10 十行、批次日期、星级、行业排名可见；网络面板确认 2 次 REST 请求、无 401。

- [ ] **Step 4: Commit** `git commit -am "feat(ui): 股票页 Top10 量化初筛区块"`

---

### Task 7: 前端 · 持仓胶囊 + 明细展开

**Files:**
- Modify: `index.html`（`renderStockSection()` 的 signal-strip、`toggleStockBody`/`stockFormHtml`）

**Interfaces:**
- Consumes: `state.scores.rows`
- Produces: 卡片头 `评分胶囊`；展开 body 顶部 `scoreDetailHtml(code)`

- [ ] **Step 1: 胶囊**——signal-strip 模板内（`买入参考·${tier}` 之后）追加：

```js
const sc = state.scores?.rows.get(stockCode);
const pill = sc ? `<span class="pill" style="background:#eef3ff">评分 ${sc.final.toFixed(1)} · ${sc.ths_l1}${sc.ind_rank?`行业${sc.ind_rank}/${sc.ind_n}`:''}${(sc.flags||[]).length?' ⚠':''}</span>` : '';
```

- [ ] **Step 2: 明细**——`stockFormHtml()` 返回串最前插入：

```js
function scoreDetailHtml(code){
  const s = state.scores?.rows.get(code); if(!s) return '';
  const bar = (v,l) => `<div class="score-bar"><span>${l}</span><i style="width:${v??0}%"></i><em>${v==null?'NA':v.toFixed(0)}</em></div>`;
  const w = (s.warnings||[]).map(x=>`<div class="warn">⚠ ${x}</div>`).join('');
  const f = (s.flags||[]).map(x=>`<span class="pill warn-pill">${x}</span>`).join('');
  return `<div class="score-detail">
    ${bar(s.quality,'质量 Q(30%)')}${bar(s.growth,'成长 G(30%)')}${bar(s.value,'估值 V(20%)')}${bar(s.momentum,'动量 M(20%)')}
    <div class="muted">综合 ${s.final.toFixed(1)} · 全市场 ${s.market_rank}/${s.market_n} · 数据完整度 ${Math.round(s.cov)}% · PE ${s.pe??'NA'}${f}</div>
    ${w}<div class="muted">财务截至 ${s.extras?.fin_period??'—'} · 评分≠买入建议</div></div>`;
}
```

配套 CSS（`.score-bar` 横条、`.score-detail` 栅格、`.warn-pill` 琥珀色、`.warn` 红字）加进既有 `<style>`，风格对齐现有 `signal-strip`/`pill`。

- [ ] **Step 3: 浏览器验证**：潍柴卡头出现 `评分 6x.x · 汽车 行业50/238` 胶囊；展开后四因子横条 + 综合行 + 财务期戳 + 免责可见；M 条长度与动量分一致；无评分批次时优雅降级（无胶囊、无明细、Top10 占位文案）。

- [ ] **Step 4: Commit** `git commit -am "feat(ui): 持仓评分胶囊与四因子明细"`

---

### Task 8: 联调收尾与发布

- [ ] **Step 1: 全链路对账**（GitHub Pages 部署后，用户浏览器实际访问）：Top10 与 Task 4 Step 5 curl 输出一致；持仓三只胶囊数值与 `stock_score` 行一致（±0.1）。
- [ ] **Step 2: spec 回填**：把两件事写进 spec §9——生产查询加权/摊薄 ROE 的实际返回口径（查 `select extras->>'fin_period' ...` 与 GS 列名）；商誉/质押/审计三 flag 的可得性探测结论（可得→后续任务加列；不可得→正式降级记录）。
- [ ] **Step 3: 陈旧路径演练**：`curl` 时临时传错 key 触发 GS 失败 → 确认旧批次仍在、页面显示上一批次+日期提示，不出现空页。
- [ ] **Step 4: 最终提交推送**：`git push`，确认 GitHub Pages 生效。

## Self-Review 结论

- Spec §1 定位→Task 6/7；§2 十一条决策→Task 2 引擎实现+Global Constraints 全覆盖（决策1 flags→Task 2/4；决策2 ST→Task 3；决策3 期戳→Task 4 extras.fin_period+Task 7 展示；决策5 三层排名→Task 2 marketRank/indRank+Task 1 列；决策6 PEG→Task 2；决策7 趋势→Task 2；决策8 金融NA→Task 2 测试；决策9 周期警示→Task 4 warnings；决策10 winsorize→Task 2；决策11 池/港股指范围→Task 1 seed+前端仅 in_pool）
- §5 行数守卫→Task 4 MIN_ROWS；§7 黄金样本→Task 3 fixtures + Task 4 Step 5
- 类型一致性：`Stock/ScoreRow/GsTable` 签名在 Task 2/3/4 间已对齐；`absTrend` 经 extras 落库
- 无占位符；pool 读取头与 cron token 引用两处标注了"抄现有实现的确切位置"而非留空
