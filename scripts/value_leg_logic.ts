// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/;
const SHIM = `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }\n`;
const EXPORT_NAMES = ['VALUE_TABLE', 'LEG_PAGE_SIZE', 'legOrderOpts', 'legFilter', 'legRange', 'legHasMore', 'legTiebreakCol', 'valueFmtPct', 'valueTierLabel', 'valuePillHtml', 'valueGateHtml', 'renderValueTop10', 'SWAP_GAP', 'divergeLists', 'swapSuggest', 'renderDivergeBoard',
  'TREND_LOOKBACK', 'TREND_KLT', 'TREND_FQT', 'TREND_MIN_MONTHS', 'TREND_POSITION_MA', 'TREND_R2_STEADY', 'TREND_DD_RATIO_MIN', 'monthEndCloses', 'olsLogTrend',
  'longTrendStats', 'longTrendLabel', 'brokenLegOf', 'trendBadgeHtml',
  'trendNaWhy', 'trendStaleHtml', 'trendStaleDays', 'fetchStatBump', 'trendPick', 'secidOf',
  'AUTH_TIMEOUT_MS', 'authErrHint',
  'TREND_LABEL_CN', 'TREND_NA_CN'];

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
export const renderValueTop10 = NS.renderValueTop10 as (state: { batch: string; top10: Record<string, unknown>[] } | null, trendMap?: Record<string, Record<string, unknown>> | null) => string;
export const SWAP_GAP = NS.SWAP_GAP as number;
export const divergeLists = NS.divergeLists as (rows: Record<string, unknown>[]) => { wronged: Record<string, unknown>[]; rich: Record<string, unknown>[] };
export const swapSuggest = NS.swapSuggest as (row: Record<string, unknown> | null, poolRows: Record<string, unknown>[], heldCodes?: string[]) => { target: Record<string, unknown>; gap: number } | null;
export const renderDivergeBoard = NS.renderDivergeBoard as (state: { batch: string; rows: Map<string, Record<string, unknown>> } | null) => string;
export const LEG_PAGE_SIZE = NS.LEG_PAGE_SIZE as number;
export const legOrderOpts = NS.legOrderOpts as () => { ascending: boolean; nullsFirst: boolean };
export const legFilter = NS.legFilter as (codes: string[]) => string;
export const legRange = NS.legRange as (i: number) => [number, number];
export const legHasMore = NS.legHasMore as (n: number) => boolean;
export const legTiebreakCol = NS.legTiebreakCol as () => string;
export const TREND_LOOKBACK = NS.TREND_LOOKBACK as number;
export const TREND_KLT = NS.TREND_KLT as number;          // 103 = 月线
export const TREND_FQT = NS.TREND_FQT as number;          // 2 = 后复权（前复权全历史实测有非正价）
export const TREND_MIN_MONTHS = NS.TREND_MIN_MONTHS as number;
export const TREND_POSITION_MA = NS.TREND_POSITION_MA as number;   // 位置项窗口（近 24 月线），与长期方向窗口是两回事
export const TREND_R2_STEADY = NS.TREND_R2_STEADY as number;
export const TREND_DD_RATIO_MIN = NS.TREND_DD_RATIO_MIN as number;   // 2026-10-14 用户裁定的收益回撤门禁
export const monthEndCloses = NS.monthEndCloses as (rows: { date: string; close: number }[] | null) => number[];
export const olsLogTrend = NS.olsLogTrend as (closes: number[], w: number, perYear?: number) => { slope: number; r2: number | null; annualized: number; n: number } | null;
export type TrendStats = { close: number; ma24m: number; months: number; firstYear: number | null; asOf: string | null; slope: number;
  r2: number | null; annualized: number; mdd: number; fromPeak: number; ddRatio: number | null; recent24: number | null };
export const longTrendStats = NS.longTrendStats as (rows: { date: string; close: number }[] | null) => TrendStats | null;
export const longTrendLabel = NS.longTrendLabel as (s: TrendStats | null) => 'steady' | 'mixed' | 'broken' | null;
export type BrokenLeg = 'annualized' | 'recent' | null;
export const brokenLegOf = NS.brokenLegOf as (s: (TrendStats & { label?: string }) | null) => BrokenLeg;
export const trendBadgeHtml = NS.trendBadgeHtml as (stats: Record<string, unknown> | null) => string;
export const trendNaWhy = NS.trendNaWhy as (stats: Record<string, unknown> | null) => string;
export const trendStaleHtml = NS.trendStaleHtml as (stats: Record<string, unknown> | null) => string;
export const trendStaleDays = NS.trendStaleDays as (asOf: string | null, today: string | null) => number | null;
export type FetchStat = Record<string, { ok: number; fail: number }>;
export const fetchStatBump = NS.fetchStatBump as (stat: FetchStat | null, day: string, ok: boolean) => FetchStat;
// deno-lint-ignore no-explicit-any
export const trendPick = NS.trendPick as (prev: Record<string, any> | null, fresh: Record<string, any>) => Record<string, any> | null;
export const secidOf = NS.secidOf as (code: string | null) => string | null;
export const AUTH_TIMEOUT_MS = NS.AUTH_TIMEOUT_MS as number;
export const TREND_LABEL_CN = NS.TREND_LABEL_CN as Record<'steady' | 'mixed' | 'broken', string>;
export const TREND_NA_CN = NS.TREND_NA_CN as string;
export const authErrHint = NS.authErrHint as (e: { name?: string; message?: string; __authTimeout?: number } | null) => string;
