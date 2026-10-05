/// <reference lib="deno.ns" />
// gs_fund.ts —— 景气度基本面宽表适配器（spec 2026-10-03 §4/§5）。
// sector-trend 自发的国信智能选股宽表查询（不跨函数 import stock-score）；
// 列名内嵌日期戳（探针实测 [20260630]）→ 一律前缀匹配、绝不硬编码日期（沿用 gs.ts 纪律）。
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
// 预算算术：单次 45s + 退避 2s + 二次 45s = 92s < index.ts PROSPERITY_BUDGET_MS(120s)。
// 旧的 90s×3 使任何需重试的情形必被 withBudget 丢弃 —— 花 3 倍配额、产出恒 null。
const FUND_TIMEOUT_MS = 45_000;
const FUND_ATTEMPTS = 2;
// Step 1 线上探针实测列前缀（探针返回：营业总收入(同比增长率)[20260630] /
// 归属母公司股东的净利润-扣除非经常损益(同比增长率)[20260630] / 所属同花顺行业）：
const REV_PREFIX = "营业总收入(同比增长率)";
const KC_PREFIX = "归属母公司股东的净利润-扣除非经常损益(同比增长率)";
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
      // 业务码非 0 = 确定性失败（日限额 197006 / 鉴权失效等）⇒ 不重试，对齐 gs_etf.ts 既有纪律
      if (j?.result?.[0]?.code !== 0) {
        throw Object.assign(
          new Error(`GS fund biz ${JSON.stringify(j?.result?.[0])}`),
          { fatal: true },
        );
      }
      const table = j?.data?.[0]?.table as GsFundTable | undefined;
      if (!table?.[CODE_COL]) throw new Error("GS fund table missing 股票代码");
      return table;
    } catch (e) {
      // 网络 TypeError 的 message 可能内嵌含 apiKey 的 URL → 换成不含 URL 的通用信息
      lastErr = e instanceof TypeError ? new Error(`GS fund network error (attempt ${attempt + 1})`) : e;
      // 确定性失败或末次尝试 ⇒ 直接跳出，不再空等退避（旧实现在抛错前多挂 6s）
      if ((e as { fatal?: boolean }).fatal || attempt === FUND_ATTEMPTS - 1) break;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// —— Task 2：L2 聚合（中位数）+ 跨行业百分位刻度（spec 2026-10-03 §5）——
// 纯函数，不依赖网络；FundRow 由 Task 1 parseFundTable 产出。

export function fundMedian(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  const n = a.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export interface ThsRaw { raw: number; n: number }

// 食品饮料 L1 特判键（2026-10-05）：ETF 榜唯一 L1 板块名，与 sector_l2_map.ts 的 FOOD_L1 同字面。
// 股票侧无 ths_l2='食品饮料'（它是 L1），恒等映射本会落空 → 该板块景气度恒 null、每轮进 unmapped。
// 这里额外把 ths_l1='食品饮料' 的全部样本（其 L2 子行业 白酒/饮料制造/食品加工制造 的并集）按
// 与 L2 完全相同的口径合成一个键=FOOD_L1 的「合成行业」，使 scale 含同名键 → mapCanonicalToThs 恒等命中。
const FOOD_L1 = "食品饮料";

// 按 thsL2 分组；每组内 rev 有效值、kc 有效值各取中位数；raw=0.5·med(rev)+0.5·med(kc)。
// 「有效样本」n = 该组中 rev 或 kc 至少其一非空的记录数；n<5 不生成（spec §5 样本下限）。
// 另按 thsL1 聚合出 FOOD_L1 合成行业（见上）。二者共用同一中位数口径，仅聚合粒度不同。
export function aggregateByThs(rows: FundRow[]): Map<string, ThsRaw> {
  const byThs = new Map<string, { rev: number[]; kc: number[]; n: number }>();
  const food: { rev: number[]; kc: number[]; n: number } = { rev: [], kc: [], n: 0 }; // 食品饮料 L1 合成组（跨其三个 L2 子行业）
  for (const r of rows) {
    if (!r.thsL2) continue;
    let g = byThs.get(r.thsL2);
    if (!g) { g = { rev: [], kc: [], n: 0 }; byThs.set(r.thsL2, g); }
    if (r.revYoy === null && r.kcYoy === null) continue; // 双空剔除
    g.n++;
    if (r.revYoy !== null) g.rev.push(r.revYoy);
    if (r.kcYoy !== null) g.kc.push(r.kcYoy);
    if (r.thsL1 === FOOD_L1) { // 同一有效样本并入合成组（与子行业各自计数并行，互不覆盖）
      food.n++;
      if (r.revYoy !== null) food.rev.push(r.revYoy);
      if (r.kcYoy !== null) food.kc.push(r.kcYoy);
    }
  }
  const out = new Map<string, ThsRaw>();
  const rawOf = (g: { rev: number[]; kc: number[] }): number | null => {
    const mr = g.rev.length ? fundMedian(g.rev) : NaN;
    const mk = g.kc.length ? fundMedian(g.kc) : NaN;
    if (Number.isNaN(mr) && Number.isNaN(mk)) return null;
    return 0.5 * (Number.isNaN(mr) ? mk : mr) + 0.5 * (Number.isNaN(mk) ? mr : mk);
  };
  for (const [ths, g] of byThs) {
    if (g.n < 5) continue;
    const raw = rawOf(g);
    if (raw === null) continue;
    out.set(ths, { raw, n: g.n });
  }
  if (food.n >= 5) { // 合成组用同一 n>=5 门槛与口径；键=FOOD_L1 与板块名同名 → 恒等命中
    const raw = rawOf(food);
    if (raw !== null) out.set(FOOD_L1, { raw, n: food.n });
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

// —— Task 3：同花顺 L2 ↔ canonical 归因映射 + 顶层编排（spec 2026-10-03 §6）——
// safeGsMsg 为 bundle 内既有导出，复用其 key 脱敏能力（注释放独立行：build.ts 的 import 剥离正则要求 import 语句行尾无内容）
import { safeGsMsg } from "./gs_etf.ts";

// 2026-10-04 L2 统一：sector_etf_map.canonical_ind 已改为同花顺 L2 名，与景气度宽表按 thsL2
// 聚合出的键【同名】⇒ 归因退化为恒等命中（同名即命中）。原 CANON_TO_THS（curated 简称↔全称）、
// THS_DENY（否决方向性失真）、唯一子串模糊规则，都是「剥字名 ≠ L2」时代的补偿，统一后失去
// 存在意义；留着反而会把某板块景气度错配到名字相近的兄弟 L2（如 电力 vs 绿色电力），故整段删除。
// 命中与否只取决于：该 L2 是否有 ≥5 样本进入景气刻度。唯一 L1 板块「食品饮料」由 aggregateByThs 的
// 合成行业(按 thsL1 并其子 L2)提供同名键而命中，不再天然落空（2026-10-05 特判）。
export function mapCanonicalToThs(canon: string, thsWithProsperity: Set<string>): string | null {
  const c = canon.trim();
  return c && thsWithProsperity.has(c) ? c : null; // 恒等：canonical 本身即 L2 名
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
  const { byInd, unmapped: unmappedAll } = attachCanonical(scale, canonicalInds);
  // scale 为空 = 取数/解析已失败（上一条 warning 已记录原因）。此时报「N 个行业未映射」
  // 会把排障方向带偏到"映射表不全"，而真实原因是端点/配额 —— 故只在确有刻度时报告映射缺口。
  const unmapped = scale.size === 0 ? [] : unmappedAll;
  let mapped = 0;
  for (const v of byInd.values()) if (v.prosperity !== null) mapped++;
  if (unmapped.length > 0) {
    warnings.push(`景气度未映射到同花顺的 canonical 行业(${unmapped.length}): ${unmapped.slice(0, 20).join(",")}${unmapped.length > 20 ? ",…" : ""}`);
  }
  return { byInd, mapped, unmapped, warnings };
}
