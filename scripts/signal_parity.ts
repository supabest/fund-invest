// scripts/signal_parity.ts — 前端信号引擎门面（照 value_leg_logic.ts 同模式）
//
// 用途：把 index.html 的 SIGNAL_PURE 块（marketLevel → evalFundSignal）逐字抽出来执行，
// 供 scripts/signal_parity_test.ts 与 supabase/functions/daily-update 的服务端实现做双端一致性比对。
//
// 约束（单文件应用无构建步骤 ⇒ 实现体不外置）：
// - 实现体只存在于 index.html，本文件不再抄一份，抽取失败必须炸，绝不静默降级；
// - 块内引用的全局态（funds/themeCaps/goal）与页面常量（BENCHMARKS/DEFAULT_*）在此注入，常量取自 index.html 原文。

const MARKER = /\/\/ ==== SIGNAL_PURE_BEGIN ====([\s\S]*?)\/\/ ==== SIGNAL_PURE_END ====/;
// 回撤抄底判据在 SIGNAL_PURE 之外（页面卡片横幅用），单独抽一块：门槛基金 30 / 股票 20 的双端护栏。
const LADDER_MARKER = /\/\/ ==== LADDER_PURE_BEGIN ====([\s\S]*?)\/\/ ==== LADDER_PURE_END ====/;

// 常量声明在块外（页面顶部），按原文抽取并求值；抽取或求值失败即抛。
const CONST_SOURCES: Record<string, RegExp> = {
  BENCHMARKS: /const BENCHMARKS = \{[\s\S]*?\n\};/,
  DEFAULT_THEMES: /const DEFAULT_THEMES = \[[^\]]*\];/,
  DEFAULT_CAPS: /const DEFAULT_CAPS = \{[^}]*\};/,
  DEFAULT_TIERS: /const DEFAULT_TIERS = \[[\s\S]*?\n\];/,
};

function extractConst(html: string, name: string): string {
  const m = html.match(CONST_SOURCES[name]);
  if (!m) throw new Error(`index.html 缺少常量声明：${name}`);
  // 去掉 `const NAME = ` 前缀，只留字面量
  return m[0].replace(new RegExp(`^const ${name} = `), '');
}

// 块内引用的页面全局：注入成本门面作用域内的可变量，测试用 __setState 改写；
// 兜底桩（fmtDateCN/valPctHtml/valPctLockNote）只服务于块内 HTML 函数的分支，本门面不校验渲染。
const STUBS = `
let funds = [];
let themeCaps = {};
let goal = 200000;
const mktMap = {}, mktFetching = {};
function fmtDateCN(){ return ''; }
function valPctHtml(){ return ''; }
function valPctLockNote(){ return ''; }
function __setState(next){
  funds = (next && next.funds) || [];
  themeCaps = (next && next.themeCaps) || {};
  goal = (next && next.goal) || 200000;
}
`;

const EXPORT_NAMES = [
  'BENCHMARKS', 'DEFAULT_THEMES', 'DEFAULT_CAPS', 'DEFAULT_TIERS',
  'marketLevel', 'DD_STEPS', 'ddAddPct', 'pctTier', 'drawdownFrom', 'dualSignal',
  'computeDeviation', 'effectiveCost', 'computeReturn', 'themeMarketValue', 'themeCapAmount', 'fundBenchKey',
  'baseSignal', 'evalFundSignal', 'fmtWan', 'fmtSigned', 'fmtMoney', 'fmtPct',
  'dipAlertStock', 'dipAlertFundLadder', 'buyBannerHtml', 'stockAddPlan', 'stockBuyBannerHtml', 'stockLotSizeOf', 'lotFromTxQuote',
  'sellBannerHtml', 'stockSellPlan', 'stockSellBannerHtml',
  'profitNextTier', 'profitMetaText',
  'supabaseBaseUrl',
  '__setState',
];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error('index.html 缺少 SIGNAL_PURE 标记块');
  const ladder = html.match(LADDER_MARKER);
  if (!ladder) throw new Error('index.html 缺少 LADDER_PURE 标记块');
  const consts = Object.keys(CONST_SOURCES).map(n => `const ${n} = ${extractConst(html, n)}`).join('\n');
  // deno-lint-ignore no-explicit-any
  const ns = new Function(consts + STUBS + m[1] + '\n' + ladder[1] + '\nreturn {' + EXPORT_NAMES.join(', ') + '};')() as any;
  const missing = EXPORT_NAMES.filter(k => ns[k] === undefined);
  if (missing.length) throw new Error('SIGNAL_PURE 块缺少导出：' + missing.join(', '));
  return ns;
}
const NS = await load();

// deno-lint-ignore no-explicit-any
const F = NS as any;

export type Bench = { secid: string; name: string; th: number[] };
export type SignalResult = {
  level?: string; label: string; multiplier: number; reasons?: string[];
  forced?: boolean; paused?: boolean; resumeReady?: boolean;
  // deno-lint-ignore no-explicit-any
  resumeSignal?: any;
};
export type FundLike = {
  theme?: string; valuationPercentile?: unknown; manualPause?: unknown; aboveMaStreak?: number;
  resumeRule?: { requireDays?: number; mode?: string; targetDrawdown?: unknown } | null;
  isQDII?: unknown; qdiiPremium?: unknown;
  ma60?: number | null; ma120?: number | null; currentNav?: number;
  costBasis?: number | null; costTotal?: number | null; marketValue?: number | null;
};

export const BENCHMARKS = F.BENCHMARKS as Record<string, Bench>;
export const DEFAULT_THEMES = F.DEFAULT_THEMES as string[];
export const DEFAULT_CAPS = F.DEFAULT_CAPS as Record<string, number>;
export const DEFAULT_TIERS = F.DEFAULT_TIERS as { ret: number; sell: number }[];

export const marketLevel = F.marketLevel as (dev: number | null, th?: number[]) => { level: string; label: string; coef: number };
export const DD_STEPS = F.DD_STEPS as { dd: number; add: number }[];
export const ddAddPct = F.ddAddPct as (dd: number) => number;
export const pctTier = F.pctTier as (pct: number | null) => { label: string; coef: number; desc: string } | null;
export const drawdownFrom = F.drawdownFrom as (high: number, price: number) => number | null;
export const dualSignal = F.dualSignal as (
  pct: number | null,
  dd: number | null,
  withPct?: boolean,
) => { total: number; label: string; addPct: number; vetoed: boolean; reasons: string[] };
export const computeDeviation = F.computeDeviation as (f: FundLike) => number | null;
export const effectiveCost = F.effectiveCost as (f: FundLike) => number;
export const computeReturn = F.computeReturn as (f: FundLike) => number | null;
export const themeMarketValue = F.themeMarketValue as (theme: string) => number;
export const themeCapAmount = F.themeCapAmount as (theme: string) => number;
export const baseSignal = F.baseSignal as (f: FundLike) => SignalResult;
export const fundBenchKey = F.fundBenchKey as (f: { benchmark?: unknown }) => string;
export const evalFundSignal = F.evalFundSignal as (f: FundLike) => SignalResult;
export const fmtWan = F.fmtWan as (n: number) => string;
export const fmtSigned = F.fmtSigned as (n: number, digits?: number) => string;
export const fmtMoney = F.fmtMoney as (n: number) => string;
export const fmtPct = F.fmtPct as (n: number | null, digits?: number) => string;
export const dipAlertStock = F.dipAlertStock as (
  s: { high52w?: unknown; currentPrice?: unknown; valuationPercentile?: unknown },
) => { dd: number; add: number } | null;
export const dipAlertFundLadder = F.dipAlertFundLadder as (
  f: { high52w?: unknown; currentNav?: unknown; valuationPercentile?: unknown }, sig?: { level?: string } | null,
) => { kind: string; dd: number; add: number; shout: boolean } | null;
export const buyBannerHtml = F.buyBannerHtml as (
  list: Array<{ kind: string; dd?: number; add?: number; ret?: number; target?: number; shout: boolean }>,
) => string;
export type AddPlan = { want: number; lots: number; amount: number; lotSize: number; ratio: number };
export const stockAddPlan = F.stockAddPlan as (mv: number, price: number, add: number, lotSize?: number) => AddPlan | null;
export const stockLotSizeOf = F.stockLotSizeOf as (s: { code?: unknown; lotSize?: unknown }) => number;
export const lotFromTxQuote = F.lotFromTxQuote as (text: string) => number | null;
/** Supabase 基址分派：Pages 项目域走同源 /sb 反代，其余（Vercel/本地）直连。 */
export const supabaseBaseUrl = F.supabaseBaseUrl as (host: string, origin: string, direct: string) => string;
export const stockBuyBannerHtml = F.stockBuyBannerHtml as (
  d: { dd: number; add: number }, plan: AddPlan | null,
) => string;
export type SellPlan = {
  wantShares: number; lots: number; qty: number; amount: number; lotSize: number; ratio: number; sell: number;
  shares: number; price: number;
};
export type SellAlert = { ret: number; tier: { ret: number; sell: number } };
export const stockSellPlan = F.stockSellPlan as (
  shares: number, price: number, sellPct: number, lotSize?: number,
) => SellPlan | null;
/** 基金止盈横幅：份额可小数赎回，保持百分比口径。 */
export const sellBannerHtml = F.sellBannerHtml as (a: SellAlert) => string;
/** 股票止盈横幅：整手折算；plan 为 null 表示缺股数/现价，只陈述比例。 */
export const stockSellBannerHtml = F.stockSellBannerHtml as (a: SellAlert, plan: SellPlan | null) => string;
/** 下一止盈档：只看高于当前收益率且未执行的档；已越过全部档返回 null。 */
export const profitNextTier = F.profitNextTier as (
  tiers: { ret: number; sell: number }[] | null | undefined,
  taken: number[] | null | undefined,
  ret: number | null | undefined,
) => { ret: number; sell: number } | null;
/** 卡片元信息：已达档 / 下一档 / 全部执行完，三选一，避免「+83% 还写下一档 +20%」。 */
export const profitMetaText = F.profitMetaText as (
  alert: SellAlert | null | undefined,
  next: { ret: number; sell: number } | null | undefined,
) => string;

/** 注入前端全局态（funds 影响 themeMarketValue；themeCaps/goal 影响 themeCapAmount）。 */
export const setState = F.__setState as (next: { funds?: { theme?: string; marketValue?: number }[]; themeCaps?: Record<string, number>; goal?: number }) => void;
