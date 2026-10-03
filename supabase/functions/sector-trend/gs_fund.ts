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
const FUND_TIMEOUT_MS = 90_000;
const FUND_ATTEMPTS = 3;
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

// —— Task 3：同花顺 L2 ↔ canonical 归因映射 + 顶层编排（spec 2026-10-03 §6）——
import { safeGsMsg } from "./gs_etf.ts"; // bundle 内既有导出，复用脉敏

// curated 主表：由 Task3 Step1 枚举真实数据填充（宁缺毋滥：只钉「名称不一致但同一行业」的宽基）。
// 每个 value 必须是 ref-l2-full.txt 首列存在的同花顺 L2 名；主题/政策/宽基模糊者一律不钉（运行时→null）。
export const CANON_TO_THS: Record<string, string> = {
  "券商": "证券", // 任务硬依赖；证券同义 L2 存在（ref-l2-full.txt L84）
  "建材": "建筑材料", // 简称↔全称，同一行业；无子串关系→必须 curated
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
