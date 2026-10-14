// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/;
const SHIM = `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }\n`;
const EXPORT_NAMES = ['VALUE_TABLE', 'LEG_PAGE_SIZE', 'legOrderOpts', 'legFilter', 'legRange', 'legHasMore', 'legTiebreakCol', 'valueFmtPct', 'valueTierLabel', 'valuePillHtml', 'valueGateHtml', 'renderValueTop10', 'SWAP_GAP', 'divergeLists', 'swapSuggest', 'renderDivergeBoard',
  'TREND_LOOKBACK', 'TREND_MIN_BARS', 'TREND_MONTHLY_MA', 'TREND_R2_STEADY', 'monthEndCloses', 'olsLogTrend',
  'longTrendStats', 'longTrendLabel', 'trendBadgeHtml', 'secidOf',
  'AUTH_TIMEOUT_MS', 'authErrHint'];

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
export const TREND_MIN_BARS = NS.TREND_MIN_BARS as number;
export const TREND_MONTHLY_MA = NS.TREND_MONTHLY_MA as number;
export const TREND_R2_STEADY = NS.TREND_R2_STEADY as number;
export const monthEndCloses = NS.monthEndCloses as (rows: { date: string; close: number }[] | null) => number[];
export const olsLogTrend = NS.olsLogTrend as (closes: number[], w: number, perYear?: number) => { slope: number; r2: number | null; annualized: number; n: number } | null;
export const longTrendStats = NS.longTrendStats as (rows: { date: string; close: number }[] | null) => { close: number; ma24m: number; monthly: number; bars: number; slope: number; r2: number | null; annualized: number } | null;
export const longTrendLabel = NS.longTrendLabel as (s: { close: number; ma24m: number; slope: number; r2: number | null } | null) => 'steady' | 'mixed' | 'broken' | null;
export const trendBadgeHtml = NS.trendBadgeHtml as (stats: Record<string, unknown> | null) => string;
export const secidOf = NS.secidOf as (code: string | null) => string | null;
export const AUTH_TIMEOUT_MS = NS.AUTH_TIMEOUT_MS as number;
export const authErrHint = NS.authErrHint as (e: { name?: string; message?: string; __authTimeout?: number } | null) => string;
