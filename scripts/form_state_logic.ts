// scripts/form_state_logic.ts —— 编辑区现场保全纯逻辑门面（照 calendar_logic.ts 同模式）
//
// 背景（2026-11-08 用户报障）：手机端展开基金/股票编辑区打字时面板经常自己折叠。
// 根因是 renderFundList/renderStockSection 每次 list.innerHTML='' 重建，编辑区一律输出成
// 空壳 <div class="fund-body">，展开态与未保存输入只活在 DOM 里；而大盘取数、autoRefreshAll、
// 趋势角标批量、云同步快照、window focus 都会在打字那几秒异步触发重绘。
// 用户裁决 A：重绘时保住现场（展开态 + 用户改过的字段 + 焦点光标），未改的字段仍吃最新数据。
//
// 实现体只存在于 index.html 的 FORM_PURE 块：本文件不抄第二份，抽取失败必须炸（绝不静默降级）。
// DOM 读写在块外的 captureForms/restoreForms，本块只放可单测的判据。
const MARKER = /\/\/ ==== FORM_PURE_BEGIN ====([\s\S]*?)\/\/ ==== FORM_PURE_END ====/;
const EXPORT_NAMES = ['formDirty', 'formStillOpen'];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error('index.html 缺少 FORM_PURE 标记块');
  // deno-lint-ignore no-explicit-any
  const ns = new Function(m[1] + '\nreturn {' + EXPORT_NAMES.join(', ') + '};')() as any;
  const missing = EXPORT_NAMES.filter((k) => ns[k] === undefined);
  if (missing.length) throw new Error('FORM_PURE 块缺少导出：' + missing.join(', '));
  return ns;
}
const NS = await load();

// deno-lint-ignore no-explicit-any
const F = NS as any;

export type FormValues = Record<string, string>;
export type OpenForm = { id: string | number; dirty: FormValues; focus: { key: string; start: number | null; end: number | null } | null };

/** 只报「用户改过」的字段：与建表时的基线逐字比对；基线里没有的键一律带上（宁可多保不可丢字）。 */
export const formDirty = F.formDirty as (current: FormValues | null, baseline: FormValues | null) => FormValues;
/** 重绘后仍值得回放的展开卡：数据里已不存在的 id（被删除）必须丢掉，不能复活一张空表单。 */
export const formStillOpen = F.formStillOpen as (open: OpenForm[] | null, ids: (string | number)[] | null) => OpenForm[];
