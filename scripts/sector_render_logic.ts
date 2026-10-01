// scripts/sector_render_logic.ts —— 前端「板块轮动」卡片纯逻辑模块（Task 4 修复轮1）
//
// 为什么实现体仍在 index.html：README 明确本工具是**单文件** GitHub Pages 应用（无构建步骤、
// index.html 即部署产物），把页面运行时函数外置成独立 .ts/.js 会让线上卡片直接失效。
// 因此本模块是**类型化门面**：它抽取 index.html 中 `// ==== SECTOR_PURE_BEGIN/END ====`
// 标记块（唯一实现体，页面与本模块共用，不存在第二份副本），在此做静态类型校验并具名导出，
// 供 scripts/sector_render_logic_test.ts 直接 import。抽取失败/函数缺失一律抛错，不会静默降级。
//
// 规则权威：docs/superpowers/specs/2026-09-30-sector-rotation-design.md §4.3 / §5（含 L94
// 「历史不足处理」）/ §7。

// deno-lint-ignore no-explicit-any
type PureFn = (...args: any[]) => any;

/** sector_rotation_daily 单行（24 列，前端 SELECT * 后原样传入） */
export interface SectorRow {
  ind: string;
  pk_etf?: string | null;
  state?: string | null;
  m20?: number | null;
  m60?: number | null;
  dev60?: number | null;
  pos52?: number | null;
  dm20?: number | null;
  vr?: number | null;
  mp?: number | null;
  score?: number | null;
  theme?: string | null;
  labels?: string[] | null;
  stale?: boolean | null;
  batch_date?: string | null;
  [k: string]: unknown;
}

/** 代表ETF K 线根数：index.html 对累积中行逐个 sector_kline head count 得到（Map 或等价对象） */
export type BarsCounts =
  | Map<string, number | null>
  | Record<string, number | null>
  | null
  | undefined;

export interface SplitDegenerate {
  ranked: SectorRow[];
  degenerate: SectorRow[];
}

export interface RankLists {
  up: SectorRow[];
  down: SectorRow[];
  entangled: SectorRow[];
  accumulating: SectorRow[];
  degenerate: SectorRow[];
}

export interface SummaryCounts {
  up: number;
  entangled: number;
  down: number;
  accumulating: number;
  degenerate: number;
  total: number;
  rankable: { up: number; entangled: number; down: number };
}

export interface DisplayMetrics {
  barsN: number | null;
  accumulating: boolean;
  degenerate: boolean;
  dev60: number | null;
  m20: number | null;
  m60: number | null;
  pos52: number | null;
  dm20: number | null;
  vr: number | null;
  score: number | null;
}

export interface ThemeSummary {
  theme: string;
  rows: SectorRow[];
  worst: SectorRow | null;
  labels: string[];
}

/** 修复轮2（评审 I1）：请求序号竞态守卫（实现体在 SECTOR_PURE 块，此处仅类型） */
export interface SectorReqGuard {
  begin(): number;
  isCurrent(id: number): boolean;
}

/** 注入的单行 count 取数（页面传 sector_kline head count，测试传假实现） */
// deno-lint-ignore no-explicit-any
export type AccCountFetcher = (pk: any) => any;

const MARKER =
  /\/\/ ==== SECTOR_PURE_BEGIN ====([\s\S]*?)\/\/ ==== SECTOR_PURE_END ====/;
// 块内 sectorLabelDots 调用页面既有的 escapeHtml（index.html），抽取执行时注入同实现 shim，
// 仅为隔离执行环境，不改变被测语义。
const ESCAPE_SHIM =
  `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }\n`;
const EXPORT_NAMES = [
  "SECTOR_WORST_RANK", "SECTOR_UP_STATES", "SECTOR_DOWN_STATES",
  "SECTOR_ENTANGLED_STATE", "SECTOR_LABEL_DOT", "SECTOR_THEME_ORDER",
  "SECTOR_NOT_COVERED_THEMES", "SECTOR_M60_MIN_BARS", "SECTOR_MA_FULL_BARS",
  "sectorStateWorstRank", "sectorIsAccumulating", "sectorBarsN", "sectorIsDegenerate",
  "sectorRowM60", "sectorSplitRows", "sectorSplitDegenerate", "sectorRankLists",
  "sectorSummaryCounts", "sectorDisplayMetrics", "sectorWorstRow", "sectorThemeGroups",
  "sectorThemeSummaries", "sectorNum", "fmtRatioPct", "fmtPoints", "fmtScoreVal",
  "fmtVr", "sectorLabelDots", "matchApproxPools",
  "sectorBuildAccCounts", "sectorIsStaleReq", "sectorCreateReqGuard",
];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error("index.html 缺少 SECTOR_PURE 标记块");
  const src = ESCAPE_SHIM + m[1] +
    "\nreturn {" + EXPORT_NAMES.join(", ") + "};";
  // deno-lint-ignore no-explicit-any
  const ns = new Function(src)() as any;
  const missing = EXPORT_NAMES.filter((k) => ns[k] === undefined);
  if (missing.length) {
    throw new Error("index.html SECTOR_PURE 块缺少导出：" + missing.join(", "));
  }
  return ns as Record<string, unknown>;
}

const NS: Record<string, unknown> = await load();

// 门面层只做类型收敛：load() 已校验 EXPORT_NAMES 全部存在，缺失即刻抛错（不静默降级）。
function fn(name: string): PureFn {
  return NS[name] as PureFn;
}
function val<T>(name: string): T {
  return NS[name] as T;
}
export const SECTOR_WORST_RANK = val<Record<string, number>>("SECTOR_WORST_RANK");
export const SECTOR_UP_STATES = val<string[]>("SECTOR_UP_STATES");
export const SECTOR_DOWN_STATES = val<string[]>("SECTOR_DOWN_STATES");
export const SECTOR_ENTANGLED_STATE = val<string>("SECTOR_ENTANGLED_STATE");
export const SECTOR_LABEL_DOT = val<Record<string, string>>("SECTOR_LABEL_DOT");
export const SECTOR_THEME_ORDER = val<string[]>("SECTOR_THEME_ORDER");
export const SECTOR_NOT_COVERED_THEMES = val<string[]>("SECTOR_NOT_COVERED_THEMES");
export const SECTOR_M60_MIN_BARS = val<number>("SECTOR_M60_MIN_BARS");
export const SECTOR_MA_FULL_BARS = val<number>("SECTOR_MA_FULL_BARS");

export function sectorStateWorstRank(state: unknown): number {
  return fn("sectorStateWorstRank")(state);
}
export function sectorIsAccumulating(row: SectorRow | null | undefined): boolean {
  return fn("sectorIsAccumulating")(row);
}
export function sectorBarsN(row: SectorRow | null, accCounts?: BarsCounts): number | null {
  return fn("sectorBarsN")(row, accCounts ?? null);
}
export function sectorIsDegenerate(row: SectorRow | null | undefined, accCounts?: BarsCounts): boolean {
  return fn("sectorIsDegenerate")(row, accCounts ?? null);
}
export function sectorRowM60(row: SectorRow | null | undefined, accCounts?: BarsCounts): number | null {
  return fn("sectorRowM60")(row, accCounts ?? null);
}
export function sectorSplitRows(rows: SectorRow[] | null | undefined): {
  tradable: SectorRow[];
  accumulating: SectorRow[];
} {
  return fn("sectorSplitRows")(rows ?? []);
}
export function sectorSplitDegenerate(
  rows: SectorRow[] | null | undefined,
  accCounts?: BarsCounts,
): SplitDegenerate {
  return fn("sectorSplitDegenerate")(rows ?? [], accCounts ?? null);
}
export function sectorRankLists(rows: SectorRow[] | null | undefined, accCounts?: BarsCounts): RankLists {
  return fn("sectorRankLists")(rows ?? [], accCounts ?? null);
}
export function sectorSummaryCounts(rows: SectorRow[] | null | undefined, accCounts?: BarsCounts): SummaryCounts {
  return fn("sectorSummaryCounts")(rows ?? [], accCounts ?? null);
}
export function sectorDisplayMetrics(row: SectorRow | null | undefined, accCounts?: BarsCounts): DisplayMetrics {
  return fn("sectorDisplayMetrics")(row, accCounts ?? null);
}
export function sectorWorstRow(rows: SectorRow[] | null | undefined): SectorRow | null {
  return fn("sectorWorstRow")(rows);
}
export function sectorThemeGroups(rows: SectorRow[] | null | undefined): Map<string, SectorRow[]> {
  return fn("sectorThemeGroups")(rows ?? []);
}
export function sectorThemeSummaries(rows: SectorRow[] | null | undefined, order: string[]): ThemeSummary[] {
  return fn("sectorThemeSummaries")(rows ?? [], order);
}
export function sectorNum(v: unknown): number | null {
  return fn("sectorNum")(v);
}
export function fmtRatioPct(v: unknown, digits?: number): string {
  return fn("fmtRatioPct")(v, digits);
}
export function fmtPoints(v: unknown, digits?: number): string {
  return fn("fmtPoints")(v, digits);
}
export function fmtScoreVal(v: unknown): string {
  return fn("fmtScoreVal")(v);
}
export function fmtVr(v: unknown): string {
  return fn("fmtVr")(v);
}
export function sectorLabelDots(labels: unknown): string {
  return fn("sectorLabelDots")(labels);
}
export function matchApproxPools(ind: string | null | undefined, pools: string[] | null | undefined): string[] {
  return fn("matchApproxPools")(ind, pools);
}
// 修复轮2（评审 I1）：累积中行 head count 并发化（含内部 sectorIsAccumulating 过滤）。
// 实现体唯一住在 index.html SECTOR_PURE 块，本模块只抽出不复制。
export function sectorBuildAccCounts(
  rows: SectorRow[] | null | undefined,
  fetchCount: AccCountFetcher,
): Promise<Map<string, number | null>> {
  return fn("sectorBuildAccCounts")(rows ?? [], fetchCount);
}
export function sectorIsStaleReq(reqSeq: number, latestSeq: number): boolean {
  return fn("sectorIsStaleReq")(reqSeq, latestSeq);
}
export function sectorCreateReqGuard(): SectorReqGuard {
  return fn("sectorCreateReqGuard")() as SectorReqGuard;
}
