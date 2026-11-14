// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/;
const SHIM = `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }\n`
  // 三栏渲染函数依赖 fmtPct/fmtMoney，二者定义在标记块外；门面按同口径补一份，只服务测试调用
  + `function fmtPct(n, digits){ if(n===null || n===undefined || isNaN(n)) return '--'; const d=(digits===undefined?1:digits); const s=Number(n).toFixed(d); return (n>0?'+':'')+s+'%'; }\n`
  + `function fmtMoney(n){ if(isNaN(n)) return '¥0'; return '¥'+Math.round(n).toLocaleString('zh-CN'); }\n`;
const EXPORT_NAMES = ['VALUE_TABLE', 'LEG_PAGE_SIZE', 'legOrderOpts', 'legFilter', 'legRange', 'legHasMore', 'legTiebreakCol', 'valueFmtPct', 'valueTierLabel', 'valueGateHtml', 'renderValueTop10', 'SWAP_GAP', 'divergeLists', 'swapSuggest', 'renderDivergeBoard',
  'TREND_LOOKBACK', 'TREND_KLT', 'TREND_FQT', 'TREND_MIN_MONTHS', 'TREND_POSITION_MA', 'TREND_R2_STEADY', 'TREND_DD_RATIO_MIN', 'monthEndCloses', 'olsLogTrend',
  'longTrendStats', 'longTrendLabel', 'brokenLegOf', 'trendBadgeHtml',
  'trendNaWhy', 'trendStaleHtml', 'trendStaleDays', 'fetchStatBump', 'trendPick', 'secidOf',
  'AUTH_TIMEOUT_MS', 'authErrHint',
  'EM_VAL_MIN_ROWS', 'valPctSupported', 'emValUrl', 'valuationPctFromRows', 'valPctCaliber', 'valPctNaWhy',
  'valPctNeedFetch', 'valPctApply', 'valPctHtml', 'valPctMerge', 'valPctLockNote',
  'TREND_LABEL_CN', 'TREND_NA_CN',
  'INCOME_INDUSTRIES', 'INCOME_DY_MIN', 'INCOME_DY5_MIN', 'INCOME_ROIC_MIN', 'INCOME_LIMIT',
  'incomeChannelOf', 'renderIncomeList', 'foldCardHtml',
  'ROIC_GATE_PCT', 'valueMedian', 'valueIndStatsOf', 'valueMoatVetoHtml', 'valueVetoHtml', 'valueAssessmentHtml',
  'ROIC_TREND_FLOOR_PCT', 'valueTrendExempt',
  'profitRefHtml', 'buyRefHtml',
  'hkFmtPct', 'hkFmtNum', 'valueAssessmentHkHtml'];

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
export const valueGateHtml = NS.valueGateHtml as (row: Record<string, unknown> | null, indByL2?: Record<string, { med: number; n: number }> | null) => string;
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
  r2: number | null; annualized: number; mdd: number; fromPeak: number; ddRatio: number | null;
  volAnn: number | null; rvRatio: number | null;   // 2026-10-18 纯披露：年化波动 / 年化收益÷年化波动（未扣 rf）
  recent24: number | null };
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

// ---- 估值百分位（2026-10-16 用户裁定 A）----
export const EM_VAL_MIN_ROWS = NS.EM_VAL_MIN_ROWS as number;
export const valPctSupported = NS.valPctSupported as (code: string | null) => boolean;
export const emValUrl = NS.emValUrl as (code: string) => string;
export type ValPctMeta = { metric: 'PE' | 'PB' | null; pct: number | null; n: number; total: number; dropped: number;
  from: string | null; to: string | null; cur: number | null; na: string | null; fetchedAt?: string | null };
// deno-lint-ignore no-explicit-any
export const valuationPctFromRows = NS.valuationPctFromRows as (rows: any[] | null, code?: string | null) => ValPctMeta;
export const valPctCaliber = NS.valPctCaliber as (o: ValPctMeta | null) => string;
export const valPctNaWhy = NS.valPctNaWhy as (o: ValPctMeta | null) => string;
export const valPctNeedFetch = NS.valPctNeedFetch as (meta: ValPctMeta | null, today: string | null) => boolean;
// deno-lint-ignore no-explicit-any
export const valPctApply = NS.valPctApply as (item: any, meta: ValPctMeta) => { write: boolean; value: number | null; note: string };
export const valPctHtml = NS.valPctHtml as (meta: ValPctMeta | null, today?: string | null) => string;
// deno-lint-ignore no-explicit-any
export const valPctMerge = NS.valPctMerge as (prev: Record<string, any> | null, fresh: Record<string, any>) => Record<string, any> | null;
export const valPctLockNote = NS.valPctLockNote as (used: number | string | null, meta: ValPctMeta | null) => string;

// ---- 收益型观察名单（2026-10-30 用户裁定：独立通道，非门禁例外）----
export const INCOME_INDUSTRIES = NS.INCOME_INDUSTRIES as string[];
export const INCOME_DY_MIN = NS.INCOME_DY_MIN as number;
export const INCOME_DY5_MIN = NS.INCOME_DY5_MIN as number;
export const INCOME_ROIC_MIN = NS.INCOME_ROIC_MIN as number;
export const INCOME_LIMIT = NS.INCOME_LIMIT as number;
export type IncomeRow = Record<string, unknown> & { alreadyQualified?: boolean; highLeverage?: boolean };
export const incomeChannelOf = NS.incomeChannelOf as (rows: Record<string, unknown>[]) => { list: IncomeRow[]; total: number };
export const renderIncomeList = NS.renderIncomeList as (state: { batch: string; list: IncomeRow[]; total: number } | null) => string;
export const foldCardHtml = NS.foldCardHtml as (key: string, titleInner: string, bodyHtml: string) => string;
// 2026-10-30：否决理由的人话版。门槛常量与引擎 ROIC_GATE 同值（测试读引擎源码钉住）。
export const ROIC_GATE_PCT = NS.ROIC_GATE_PCT as number;
export const valueMedian = NS.valueMedian as (vals: (number | null | undefined)[]) => number | null;
export type IndRef = { med: number; n: number };
export const valueIndStatsOf = NS.valueIndStatsOf as (rows: Record<string, unknown>[]) => Record<string, IndRef>;
export const valueMoatVetoHtml = NS.valueMoatVetoHtml as (row: Record<string, unknown> | null, indByL2?: Record<string, IndRef> | null) => string;
export const valueVetoHtml = NS.valueVetoHtml as (row: Record<string, unknown> | null, indByL2?: Record<string, IndRef> | null) => string;
/** 参照值放宽到 number|null：价值评估栏要把脏参照行（med:null）判成「无参照」，而不是把它当 0。 */
type IndRefLike = { med: number | null; n?: number };
/** 走势第二把尺（2026-11-02 裁定 C 档）：命中时交出年份与三点原值供文案引用；不命中一律 null。 */
export type TrendExempt = { years: string[]; vals: number[]; end: number };
export const ROIC_TREND_FLOOR_PCT = NS.ROIC_TREND_FLOOR_PCT as number;
export const valueTrendExempt = NS.valueTrendExempt as (row: Record<string, unknown> | null) => TrendExempt | null;
/** 价值评估栏（2026-11-01 三栏收口）：四维 + 人话 verdict；只回答「值不值」，不发买卖指令。 */
export const valueAssessmentHtml = NS.valueAssessmentHtml as (
  row: Record<string, unknown> | null | undefined, indByL2: Record<string, IndRefLike> | null, hasBatch: boolean,
) => string;
/** 港股降维口径（2026-11-14）：三行事实 + 两句口径行；缺失回「无数据」而非 A 股的 'NA'。 */
export const hkFmtPct = NS.hkFmtPct as (v: number | null, d?: number) => string;
export const hkFmtNum = NS.hkFmtNum as (v: number | null, d?: number) => string;
export const valueAssessmentHkHtml = NS.valueAssessmentHkHtml as (
  row: Record<string, unknown> | null | undefined, hasBatch: boolean,
) => string;
/** 止盈参考栏：三态（已达档 / 下一档 / 全部执行完）必须与邮件 tierNoteHtml 同句；缺数据不冒充数值。 */
type ProfitAlertLike = { tier: { ret: number; sell: number }; ret: number } | null;
type ProfitTierLike = { ret: number; sell: number } | null;
export const profitRefHtml = NS.profitRefHtml as (
  alert: ProfitAlertLike, next: ProfitTierLike, ret: number | null,
  plan: Record<string, unknown> | null, s: Record<string, unknown>,
) => string;
/** 买入参考栏：胶囊档位 + 三条腿白话明细（明细要转义）+ 安全垫补填提示 + 买入横幅。 */
export const buyRefHtml = NS.buyRefHtml as (
  ref: { label: string; text: string }, pillCls: string, s: Record<string, unknown>, dev: number | null,
  gate: { light: boolean; needPad: boolean; shout: boolean }, plan: unknown, cost: unknown,
  dualHtml: string, dip: unknown, padHint: string, banner: string,
) => string;
