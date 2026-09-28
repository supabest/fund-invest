// DEPRECATED / 未接线：新浪行情为不复权价，与 GS 前复权口径不可混用（直接对接会静默污染 momentum_crowded）。
// crowded 已在 engine.ts 内用 GS a60 实现。本模块原语仅保留备未来解决复权口径后启用；启用前必须先对齐复权。
/// <reference lib="deno.ns" />
export interface Kbar { day: string; close: number }

const SINA = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData';

export function sinaSymbol(code: string): string {
  const c = code.split('.')[0];
  const mkt = code.split('.')[1] ?? '';
  // 北交所代码段：4xxxxx / 8xxxxx / 9xxxxx（含 920xxx 新号段，裸代码无后缀时一并覆盖）
  const p = mkt === 'SH' || c.startsWith('6') ? 'sh'
    : mkt === 'BJ' || /^[489]/.test(c) ? 'bj'
    : 'sz';
  return p + c;
}

// 纯函数：解析 K 线响应（可测，不打网络）。防御式解析：非数组 → 抛错（不附
// payload 内容）；单根 bar 字段缺失/非法（含字符串数字解析失败）→ 丢弃该 bar，
// 其余照常返回，由 ma/retN 的长度守卫自然降级。
export function parseKline(raw: unknown): Kbar[] {
  if (!Array.isArray(raw)) throw new Error('sina bad payload');
  const out: Kbar[] = [];
  for (const b of raw as Record<string, unknown>[]) {
    const day = typeof b?.day === 'string' ? b.day : '';
    const close = typeof b?.close === 'string' ? parseFloat(b.close) : typeof b?.close === 'number' ? b.close : NaN;
    if (day && Number.isFinite(close)) out.push({ day, close });
  }
  return out;
}

export async function dailyKline(symbol: string, datalen = 70): Promise<Kbar[]> {
  let raw: unknown;
  try {
    const r = await fetch(`${SINA}?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`sina http ${r.status}`);
    // fix 轮 3：网关拦截页（HTML）会让 r.json() 抛 SyntaxError，其 message 内嵌
    // payload 片段——单独冒住并归一为 'sina bad payload'，不把原始片段带到错误链。
    try {
      raw = await r.json();
    } catch {
      throw new Error('sina bad payload');
    }
  } catch (e) {
    // TypeError 脱敏：不暴露含参数的 URL
    throw e instanceof TypeError ? new Error('sina network error') : e;
  }
  return parseKline(raw);
}

export function ma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function retN(bars: Kbar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const prev = bars[bars.length - 1 - n].close;
  const last = bars[bars.length - 1].close;
  return prev > 0 ? (last / prev - 1) * 100 : null;
}
