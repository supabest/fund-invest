// scripts/build_universe.ts —— 本地一次性：GS 15 分段行业 ETF 截面 → 行业归一 → seed SQL
// 规则权威: spec §2.1（15 分段矩阵 + 触顶覆盖闭合检查）/ §2.2（归一）/ §2.3（代表ETF、规模<2亿不入池）
// 凭据: 环境变量 GS_API_KEY（值由执行者从 gs-etf-filter skill memory.md 取出后 export，绝不落文件/日志）
import {
  extractInd,
  isStyleExcluded,
  normalizeInd,
} from "./sector_normalize.ts";

const BASE =
  "https://dgzt.guosen.com.cn/skills/gsfinancing/selected/ETF/filterSearch/1.0";
// endamt ∈ {2,10 / 10,30 / 30,100000}（亿）× temperRegion ∈ {1..5}（1-高温…5-低温）= 15 分段
const AMT_BANDS: { range: string; label: string }[] = [
  { range: "2,10", label: "2-10亿" },
  { range: "10,30", label: "10-30亿" },
  { range: "30,100000", label: "30亿+" },
];
const TEMPERS = [1, 2, 3, 4, 5];
const CAP = 100; // GS filterSearch 单段最多返回 100 只
const MIN_ROWS = 300; // spec §3.2：并集去重 <300 视为快照异常
const SLEEP_MS = 400; // 调用间 pacing，禁止突发（push2his 封禁教训同类）
// 覆盖闭合修复（spec §2.1「触顶 → 覆盖闭合检查」）：分段返回满 100 只时，沿**同一
// endamt 轴**递归对半细分（区间连续无缝 + 并集去重，故不丢成员、不改变 15 段矩阵语义）。
// 细分到 MIN_WIDTH 仍触顶、或超出 MAX_LEAVES 预算 → 仍按 brief 打印 TRUNCATED 并非零退出。
const OPEN_HI = 100_000; // 30亿+ 开口段的哨兵上界
const MIN_WIDTH = 0.5;
const OPEN_STEP = 30;
const MAX_LEAVES = 12;

type SegBand = { lo: number; hi: number };
const bandParam = (b: SegBand) => `${b.lo},${b.hi}`;
const bandLabel = (b: SegBand) =>
  b.hi >= OPEN_HI ? `${b.lo}亿+` : `${b.lo}-${b.hi}亿`;
const segLabel = (b: SegBand, t: number) => `${bandLabel(b)}×temper${t}`;
// 对半切；开口段按 OPEN_STEP 绝对步长上移（对半切 30-100000 无意义）；宽度不足即不可再切
function splitBand(b: SegBand): [SegBand, SegBand] | null {
  if (b.hi - b.lo <= MIN_WIDTH * 2) return null;
  const raw = b.hi >= OPEN_HI ? b.lo + OPEN_STEP : b.lo + (b.hi - b.lo) / 2;
  const mid = Math.round(raw * 100) / 100;
  if (mid <= b.lo || mid >= b.hi) return null;
  return [{ lo: b.lo, hi: mid }, { lo: mid, hi: b.hi }];
}

type EtfRow = { ofcode: string; ofname: string; endamt?: string | number };

const apiKey = Deno.env.get("GS_API_KEY");
if (!apiKey) {
  console.error(
    "GS_API_KEY 未设置：从 gs-etf-filter skill memory.md 读取后 export（勿写入文件）",
  );
  Deno.exit(1);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchSeg(endamt: string, temper: number): Promise<EtfRow[]> {
  const qs = new URLSearchParams({
    class1: "1",
    endamt,
    temperRegion: String(temper),
    orderCol: "nowrange",
    orderType: "0",
    softName: "goldsun_skills",
    skillName: "gs-etf-filter",
    apiKey: apiKey!,
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) {
        throw new Error(`GS biz ${JSON.stringify(j?.result?.[0])}`);
      }
      return (j?.data ?? []) as EtfRow[];
    } catch (e) {
      // 网络错误的 message 可能内嵌含 apiKey 的完整 URL → 脱敏为不含 URL 的通用信息
      lastErr = e instanceof TypeError
        ? new Error(`GS network error (attempt ${attempt + 1})`)
        : e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---- 15 分段拉取（触顶段递归细分至闭合）+ 并集去重（ofcode） ----
const union = new Map<string, EtfRow>();
const segLines: string[] = [];
const budget = { calls: 0, leaves: 0 };

async function fetchClosed(
  band: SegBand,
  temper: number,
): Promise<{ rows: EtfRow[]; capped: boolean }> {
  if (++budget.leaves > MAX_LEAVES) return { rows: [], capped: true };
  const rows = await fetchSeg(bandParam(band), temper);
  budget.calls++;
  await sleep(SLEEP_MS);
  segLines.push(`  ${segLabel(band, temper)} = ${rows.length} 只`);
  if (rows.length < CAP) return { rows, capped: false };
  const parts = splitBand(band);
  if (!parts) return { rows, capped: true }; // 已是最细粒度仍触顶
  const [a, b] = [
    await fetchClosed(parts[0], temper),
    await fetchClosed(parts[1], temper),
  ];
  return { rows: [...a.rows, ...b.rows], capped: a.capped || b.capped };
}

for (const band of AMT_BANDS) {
  for (const t of TEMPERS) {
    budget.leaves = 0;
    const { rows, capped } = await fetchClosed({
      lo: Number(band.range.split(",")[0]),
      hi: Number(band.range.split(",")[1]),
    }, t);
    if (capped) {
      console.error(
        `TRUNCATED seg=${band.label}×temper${t}（细分后仍有子段返回满 ${CAP} 只，覆盖未闭合）`,
      );
      Deno.exit(2);
    }
    for (const row of rows) {
      if (!union.has(row.ofcode)) union.set(row.ofcode, row);
    }
  }
}

// ---- MIN_ROWS 守卫 ----
if (union.size < MIN_ROWS) {
  console.error(
    `MIN_ROWS 违例: 并集去重 ${union.size} < ${MIN_ROWS}（快照异常，跳过宇宙重建）`,
  );
  Deno.exit(3);
}

// ---- 归一 + 代表ETF（每规范行业取 amt 最大者；并列按代码升序，可重现） ----
const num = (v: string | number | undefined | null): number => {
  const x = typeof v === "string" ? parseFloat(v) : v ?? NaN;
  return Number.isFinite(x) ? x : 0;
};
type MapRow = {
  code: string;
  name: string;
  raw: string;
  ind: string;
  amt: number;
  isRep: boolean;
};
const byInd = new Map<string, MapRow[]>();
for (const row of union.values()) {
  const name = (row.ofname ?? "").trim();
  const code = String(row.ofcode).trim();
  const raw = extractInd(name);
  const ind = normalizeInd(raw);
  const item: MapRow = {
    code,
    name,
    raw,
    ind,
    amt: num(row.endamt),
    isRep: false,
  };
  if (!byInd.has(ind)) byInd.set(ind, []);
  byInd.get(ind)!.push(item);
}
const all: MapRow[] = [];

// ---- R2 剔除纯区域/风格类（归一之后、is_rep 评选之前）：被剔除的 ETF 完全不进 seed ----
const dropped: { ind: string; n: number }[] = [];
for (const ind of [...byInd.keys()]) {
  if (isStyleExcluded(ind)) {
    dropped.push({ ind, n: byInd.get(ind)!.length });
    byInd.delete(ind);
  }
}

for (const [, items] of byInd) {
  items.sort((a, b) => b.amt - a.amt || a.code.localeCompare(b.code));
  items[0].isRep = true;
  all.push(...items);
}
all.sort((a, b) => a.ind.localeCompare(b.ind, "zh") || b.amt - a.amt);

// ---- 疑似重复清单：canonical 之间「互为前缀」或「编辑距离≤1」 ----
function lev(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
const inds = [...byInd.keys()].sort((a, b) => a.localeCompare(b, "zh"));
const dups: string[] = [];
for (let i = 0; i < inds.length; i++) {
  for (let j = i + 1; j < inds.length; j++) {
    const [x, y] = [inds[i], inds[j]];
    const prefix = x.startsWith(y) || y.startsWith(x);
    const d = lev(x, y);
    if (prefix || d <= 1) {
      dups.push(`  ${x} ↔ ${y}  [${prefix ? "前缀" : `编辑距离${d}`}]`);
    }
  }
}

// ---- seed SQL 产物 ----
const esc = (s: string) => s.replace(/'/g, "''");
const values = all.map((m) =>
  `  ('${esc(m.code)}','${esc(m.name)}','${
    esc(m.ind)
  }',${m.amt},${m.isRep},current_date)`
).join(",\n");
const sql =
  `-- scripts/seed_sector_map.sql —— 由 scripts/build_universe.ts 生成（GS 15 分段 + sector_normalize 归一）；勿手改，改合并规则请改 MERGE 后重跑
-- 生成日期: ${
    new Date().toISOString().slice(0, 10)
  }  宇宙 ${all.length} 只 / 规范行业 ${byInd.size} 个 / 代表ETF ${
    all.filter((m) => m.isRep).length
  } 只
insert into sector_etf_map (etf_code, etf_name, canonical_ind, amt, is_rep, updated_on) values
${values}
on conflict (etf_code) do update set
  etf_name = excluded.etf_name,
  canonical_ind = excluded.canonical_ind,
  amt = excluded.amt,
  is_rep = excluded.is_rep,
  updated_on = current_date;
`;
await Deno.writeTextFile(
  new URL("./seed_sector_map.sql", import.meta.url),
  sql,
);

// ---- stdout 报告 ----
console.log(
  `基础分段: ${
    AMT_BANDS.length * TEMPERS.length
  } 段；实际调用 ${budget.calls} 次（触顶段沿 endamt 轴细分，见下列子段）`,
);
console.log(segLines.join("\n"));
console.log(`并集去重 ETF 数: ${union.size}（MIN_ROWS ${MIN_ROWS} 通过）`);
if (dropped.length) {
  console.log(
    `R2 剔除纯区域/风格类: ${dropped.length} 个行业 / ${
      dropped.reduce((s, d) => s + d.n, 0)
    } 只 ETF 不入池 -> ${dropped.map((d) => `${d.ind}(n=${d.n})`).join(" ")}`,
  );
}
console.log(`规范行业数: ${byInd.size}`);
console.log(`代表ETF数: ${all.filter((m) => m.isRep).length}`);
const top = [...byInd.entries()]
  .sort((a, b) =>
    b[1].length - a[1].length ||
    b[1].reduce((s, x) => s + x.amt, 0) - a[1].reduce((s, x) => s + x.amt, 0)
  )
  .slice(0, 20);
console.log("Top20 行业（按入池ETF数，并列按行业总规模）:");
console.log(
  top.map(([ind, items]) =>
    `  ${ind}  n=${items.length}  rep=${items[0].code} ${
      items[0].name
    }  sum_amt=${items.reduce((s, x) => s + x.amt, 0).toFixed(1)}亿`
  ).join("\n"),
);
console.log(
  `未合并疑似重复清单（前缀 / 编辑距离≤1，供人工审，共 ${dups.length} 对）:`,
);
console.log(dups.length ? dups.join("\n") : "  （无）");
