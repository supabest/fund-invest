// rf.ts — 十年期国债收益率（门禁层的尺子）。规则权威：spec §4/§9.2 + 计划修订 A2
// 数据源是 gs-economy-query skill 的底层端点（Edge 里跑不了 python 脚本），响应为自然语言。
// 因此解析采取「宁缺勿猜」：拿不到就返回 null，由编排层走 OWNER_YIELD_FLOOR 退化路径。
export const ECONOMY_BASE = 'https://dgzt.guosen.com.cn/skills/agent/adapter/query';
export const CN10Y_TEXT = '中国十年期国债收益率最新值';
const CN10Y_MIN = 0.5, CN10Y_MAX = 5.0;      // %；窗外一律视为解析失败
const OVERRIDE_MAX_AGE_DAYS = 45;

export async function fetchCn10yStream(apiKey: string, timeoutMs = 60_000): Promise<string> {
  const qs = new URLSearchParams({ text: CN10Y_TEXT, softName: 'goldsun_skills', apiKey });
  try {
    const r = await fetch(`${ECONOMY_BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return '';
    const j = await r.json();
    if (j?.result?.[0]?.code !== 0) return '';
    return (j?.data ?? []).filter((x: Record<string, unknown>) => x?.type === 'STREAM_MESSAGE')
      .map((x: Record<string, unknown>) => String(x.content ?? '')).join('');
  } catch { return ''; }                      // TypeError.message 含带 key 的 URL → 吐空串，不往上传
}

function pctAt(text: string): { i: number; v: number }[] {
  const out: { i: number; v: number }[] = [];
  const re = /(\d+(?:\.\d+)?)\s*%/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ i: m.index, v: Number(m[1]) });
  return out;
}

export function parseCn10y(text: string): number | null {
  const pcts = pctAt(text ?? '');
  if (pcts.length === 0) return null;
  // 优先取“10年/十年/10Y”之后 30 字内第一个百分数（多利率并列时防拿错）
  const anchor = text.search(/10\s*年|十年|10Y/i);
  const cand = anchor >= 0 ? pcts.filter(x => x.i >= anchor && x.i - anchor <= 30) : [];
  const pick = (cand.length ? cand : pcts).find(x => x.v >= CN10Y_MIN && x.v <= CN10Y_MAX);
  return pick ? pick.v : null;
}

export function resolveCn10y(i: { override: number | null; overrideOn: string | null; fetched: number | null; today: string }):
  { cn10y: number | null; source: 'override' | 'auto' | 'none' } {
  const fresh = i.override !== null && i.overrideOn !== null &&
    (Date.parse(i.today) - Date.parse(i.overrideOn)) / 86400_000 <= OVERRIDE_MAX_AGE_DAYS;
  if (fresh) return { cn10y: i.override, source: 'override' };
  if (i.fetched !== null) return { cn10y: i.fetched, source: 'auto' };
  return { cn10y: null, source: 'none' };
}
