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
