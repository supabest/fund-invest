// scripts/detail_view_logic.ts —— 概览行 + 整页详情路由纯逻辑门面（照 calendar_logic.ts 同模式）
//
// 背景（2026-11-12 用户裁决 A）：基金/股票卡片展开后篇幅过长，改为「一行概览 + 整页详情 + 左上返回」。
// 概览行只留 名称(+代码) / 持仓市值 / 持仓涨跌幅 / 行尾信号点；信号点复用既有止盈/抄底判据（不新增阈值）。
// 详情是独立 DOM 区域：列表重绘永远不碰详情表单（结构上取代旧的「编辑现场保全」回放机制）。
// 实现体只存在于 index.html 的 DETAIL_PURE 块：本文件不抄第二份，抽取失败必须炸（绝不静默降级）。
const MARKER = /\/\/ ==== DETAIL_PURE_BEGIN ====([\s\S]*?)\/\/ ==== DETAIL_PURE_END ====/;
const EXPORT_NAMES = ['signalDotState', 'parseDetailHash', 'detailHash'];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error('index.html 缺少 DETAIL_PURE 标记块');
  // deno-lint-ignore no-explicit-any
  const ns = new Function(m[1] + '\nreturn {' + EXPORT_NAMES.join(', ') + '};')() as any;
  const missing = EXPORT_NAMES.filter((k) => ns[k] === undefined);
  if (missing.length) throw new Error('DETAIL_PURE 块缺少导出：' + missing.join(', '));
  return ns;
}
const NS = await load();

// deno-lint-ignore no-explicit-any
const F = NS as any;

export type DetailRoute = { kind: 'fund' | 'stock'; id: string };

/** 行尾信号点三态：止盈优先于抄底（两者同时命中时只报更紧急的卖出），都没有则中性「不动」。 */
export const signalDotState = F.signalDotState as (hasSell: unknown, hasBuy: unknown) => 'sell' | 'buy' | 'hold';
/** 解析 location.hash → 详情路由；非详情格式（含空/残缺/未知 kind/多级路径）一律 null（回概览）。 */
export const parseDetailHash = F.parseDetailHash as (hash: string | null | undefined) => DetailRoute | null;
/** 详情路由 → hash；非法 kind / 空 id / 含斜杠 id 给空串（绝不造出解析不回来的死链）。 */
export const detailHash = F.detailHash as (kind: string, id: string | number | null | undefined) => string;