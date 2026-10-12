// scripts/value_leg_logic.ts — 前端价值腿纯逻辑门面（照 research_render_logic.ts 同模式）
const MARKER = /\/\/ ==== VALUE_PURE_BEGIN ====([\s\S]*?)\/\/ ==== VALUE_PURE_END ====/;
const SHIM = `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }\n`;
const EXPORT_NAMES = ['VALUE_TABLE', 'valueFmtPct', 'valueTierLabel', 'valuePillHtml', 'valueGateHtml', 'renderValueTop10', 'SWAP_GAP', 'divergeLists', 'swapSuggest', 'renderDivergeBoard'];

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
export const renderValueTop10 = NS.renderValueTop10 as (state: { batch: string; top10: Record<string, unknown>[] } | null) => string;
export const SWAP_GAP = NS.SWAP_GAP as number;
export const divergeLists = NS.divergeLists as (rows: Record<string, unknown>[]) => { wronged: Record<string, unknown>[]; rich: Record<string, unknown>[] };
export const swapSuggest = NS.swapSuggest as (row: Record<string, unknown> | null, poolRows: Record<string, unknown>[], heldCodes?: string[]) => { target: Record<string, unknown>; gap: number } | null;
export const renderDivergeBoard = NS.renderDivergeBoard as (state: { batch: string; rows: Map<string, Record<string, unknown>> } | null) => string;
