// scripts/research_render_logic.ts —— 前端「产业研究员」纯逻辑门面（Task 5）
//
// 为什么实现体仍在 index.html：README 明确本工具是**单文件** GitHub Pages 应用（无构建步骤、
// index.html 即部署产物），把页面运行时函数外置成独立 .ts/.js 会让线上卡片直接失效。
// 因此本模块是**类型化门面**：它抽取 index.html 中 `// ==== RESEARCH_PURE_BEGIN/END ====`
// 标记块（唯一实现体，页面与本模块共用，不存在第二份副本），在此做静态类型校验并具名导出，
// 供 scripts/research_render_logic_test.ts 直接 import。抽取失败/函数缺失一律抛错，不会静默降级。
//
// 规则权威：docs/superpowers/specs/2026-10-02-stock-research-design.md §4 / §8。

// deno-lint-ignore no-explicit-any
type PureFn = (...args: any[]) => any;

/** stock_fundamental 单行（前端 SELECT * 或函数返回 row 原样传入；仅列本门面关心的字段） */
export interface ResearchRow {
  code?: string;
  status?: string | null;         // 'running' | 'done' | 'failed'
  verdict?: string | null;        // '升温' | '平稳' | '降温' | '恶化'
  summary?: string | null;
  report?: { title: string; body: string }[] | null;
  sources?: { title?: string; url?: string; date?: string }[] | null;
  provider?: string | null;
  model?: string | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  [k: string]: unknown;
}

/** 服务商凭证（sessionStorage 持久化形态：provider slug + 明文 key，仅本会话内存/临时存储） */
export interface ResearchCred {
  provider: string;
  key: string;
}

const MARKER =
  /\/\/ ==== RESEARCH_PURE_BEGIN ====([\s\S]*?)\/\/ ==== RESEARCH_PURE_END ====/;
// 块内 researchPillHtml/researchReportHtml 调用页面既有的 escapeHtml（index.html），抽取执行时
// 注入同实现 shim，仅为隔离执行环境，不改变被测语义。
const ESCAPE_SHIM =
  `function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }\n`;
const EXPORT_NAMES = [
  "RESEARCH_VERDICT_CLS", "researchPillHtml", "researchReportHtml",
  "researchCredGet", "researchCredSet", "researchCredMasked", "researchRetryDisabled",
];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error("index.html 缺少 RESEARCH_PURE 标记块");
  const src = ESCAPE_SHIM + m[1] +
    "\nreturn {" + EXPORT_NAMES.join(", ") + "};";
  // deno-lint-ignore no-explicit-any
  const ns = new Function(src)() as any;
  const missing = EXPORT_NAMES.filter((k) => ns[k] === undefined);
  if (missing.length) {
    throw new Error("index.html RESEARCH_PURE 块缺少导出：" + missing.join(", "));
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

export const RESEARCH_VERDICT_CLS = val<Record<string, string>>("RESEARCH_VERDICT_CLS");

export function researchPillHtml(row: ResearchRow | null | undefined): string {
  return fn("researchPillHtml")(row ?? null) as string;
}
export function researchReportHtml(row: ResearchRow | null | undefined): string {
  return fn("researchReportHtml")(row ?? null) as string;
}
export function researchCredGet(): ResearchCred | null {
  return fn("researchCredGet")() as ResearchCred | null;
}
export function researchCredSet(cred: ResearchCred | null): void {
  fn("researchCredSet")(cred ?? null);
}
export function researchCredMasked(cred: ResearchCred): string {
  return fn("researchCredMasked")(cred) as string;
}
export function researchRetryDisabled(row: ResearchRow | null | undefined, nowMs: number): boolean {
  return fn("researchRetryDisabled")(row ?? null, nowMs) as boolean;
}
