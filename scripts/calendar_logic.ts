// scripts/calendar_logic.ts —— 财报日历纯逻辑门面（照 value_leg_logic.ts / research_render_logic.ts 同模式）
//
// 实现体只存在于 index.html 的 CAL_PURE 块：本文件不抄第二份，抽取失败必须炸（绝不静默降级）。
// 邮件端 supabase/functions/daily-update/index.ts 另有一份镜像，两者由 calendar_logic_test.ts 的
// 矩阵比对钉住——历史上「页面改了邮件没改」（止盈档，2026-10-31）就是缺这道护栏。
const MARKER = /\/\/ ==== CAL_PURE_BEGIN ====([\s\S]*?)\/\/ ==== CAL_PURE_END ====/;
const EXPORT_NAMES = [
  'CAL_WINDOW_DAYS', 'CAL_SOON_DAYS', 'calSupported', 'periodLabel', 'calPeriods', 'calFilter',
  'statutorySchedule', 'calDaysBetween', 'nextDisclosure', 'calWindow', 'disclosureText', 'disclosurePillHtml',
];

async function load(): Promise<Record<string, unknown>> {
  const html = await Deno.readTextFile(new URL('../index.html', import.meta.url));
  const m = html.match(MARKER);
  if (!m) throw new Error('index.html 缺少 CAL_PURE 标记块');
  // deno-lint-ignore no-explicit-any
  const ns = new Function(m[1] + '\nreturn {' + EXPORT_NAMES.join(', ') + '};')() as any;
  const missing = EXPORT_NAMES.filter((k) => ns[k] === undefined);
  if (missing.length) throw new Error('CAL_PURE 块缺少导出：' + missing.join(', '));
  return ns;
}
const NS = await load();

// deno-lint-ignore no-explicit-any
const F = NS as any;

export const CAL_WINDOW_DAYS = F.CAL_WINDOW_DAYS as number;
export const CAL_SOON_DAYS = F.CAL_SOON_DAYS as number;
export const calSupported = F.calSupported as (code: unknown) => boolean;
export const periodLabel = F.periodLabel as (reportDate: string | null) => string;
export const calPeriods = F.calPeriods as (today: string, back?: number, fwd?: number) => string[];
export const calFilter = F.calFilter as (codes: unknown[], reportDates: (string | null)[]) => string;
export const statutorySchedule = F.statutorySchedule as (today: string, count?: number) =>
  { reportDate: string; deadline: string; label: string }[];
export const calDaysBetween = F.calDaysBetween as (from: string, to: string) => number;
export type Disclosure = {
  code: string; date: string; kind: 'appoint' | 'statutory'; changed: boolean;
  fromDate: string | null; label: string; daysTo: number;
};
// deno-lint-ignore no-explicit-any
export type CalRow = Record<string, any>;
export const nextDisclosure = F.nextDisclosure as (rows: CalRow[], code: unknown, today: string) => Disclosure | null;
export const calWindow = F.calWindow as (list: (Disclosure | null)[], today: string) =>
  { soon: Disclosure[]; later: Disclosure[] };
export const disclosureText = F.disclosureText as (e: Disclosure | null) => string;
export const disclosurePillHtml = F.disclosurePillHtml as (e: Disclosure | null, status?: string | null) => string;
