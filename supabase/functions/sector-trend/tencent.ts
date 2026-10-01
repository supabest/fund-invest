// tencent.ts —— 腾讯前复权日K适配器（brief Step 1；规则权威 spec §2.1/S2 + §3.2 数据获取纪律）
// 数据源：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get（qfq 前复权，单次最多 640 根，按日期翻页回 2019-01）
// 东财 push2/push2his 已被 WAF IP 封禁（spec S2），本文件及其调用方零依赖。
// 纯解析（parseKline/toSymbol）与网络（fetchRecentKline）分离：前者单测，后者按 brief 由 mode=ping 线上验证。

export interface KlineResp {
  date: string;
  close: number;
  volume: number;
}

const TX_BASE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const REQ_TIMEOUT_MS = 15_000;
const RETRIES = 3;
const BACKOFF_MS = 1_500; // spec §3.2：3 次退避重试（1.5s×n）

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// 腾讯返回严格字符串/数值；'' / '-' / null 一律视为无效（Number('')===0 的陷阱规避）
const toNum = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    ? Number(v)
    : NaN;

// qfqday || day → [date, close=r[2], volume=r[5]]（r[1]=open/r[3]=high/r[4]=low 不取）；畸形输入 → []
export function parseKline(json: unknown, symbol: string): KlineResp[] {
  let node: unknown;
  try {
    node = (json as { data?: Record<string, unknown> })?.data?.[symbol];
  } catch {
    return [];
  }
  if (!node || typeof node !== "object") return [];
  const { qfqday, day } = node as { qfqday?: unknown; day?: unknown };
  const raw = Array.isArray(qfqday) ? qfqday : Array.isArray(day) ? day : null;
  if (!raw) return [];
  const out: KlineResp[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const date = typeof r[0] === "string" ? r[0] : "";
    const close = toNum(r[2]);
    const volume = toNum(r[5]);
    if (!date || !Number.isFinite(close) || !Number.isFinite(volume)) continue;
    out.push({ date, close, volume });
  }
  return out;
}

// market 字段优先（brief 逐字口径 '1'→sh / '0'→sz）；缺失回退首位 in '56' → sh else sz。
// 事实备注（2026-10-01 探针）：GS filterSearch 的 market 取值是 '1'=深 / '2'=沪，与 brief 口径不同；
// 而 sector_etf_map 无 market 列、EtfSnapRow 也不含 market ⇒ 生产链路恒传 null，走代码首位回退
// （回退对 51/56/58→sh、15/16/0→sz 判对）。若将来引入 market 列，必须先按探针事实重定义此映射。
export function toSymbol(ofcode: string, market: string | null): string {
  const code = String(ofcode ?? "").trim();
  if (market === "1") return `sh${code}`;
  if (market === "0") return `sz${code}`;
  return code[0] === "5" || code[0] === "6" ? `sh${code}` : `sz${code}`;
}

// GET param={symbol},day,,{end},{lmt},qfq；3 次退避重试(1.5s×n)，全败 throw。
// pacing（0.3s/请求）由调用方负责（spec §3.2），本函数只管单发尽力拿到一批。
export async function fetchRecentKline(
  symbol: string,
  end: string,
  lmt = 5,
): Promise<KlineResp[]> {
  const url = `${TX_BASE}?param=${
    encodeURIComponent(`${symbol},day,,${end},${lmt},qfq`)
  }`;
  let lastErr: unknown = new Error(`tencent kline failed sym=${symbol}`);
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`tencent http ${r.status} sym=${symbol}`);
      const rows = parseKline(await r.json(), symbol);
      if (rows.length === 0) {
        throw new Error(`tencent kline empty/畸形 sym=${symbol} lmt=${lmt}`);
      }
      return rows;
    } catch (e) {
      // 网络错误的 message 可能内嵌完整 URL → 换为不含 URL 的通用信息（凭据纪律同类，见 stock-score/gs.ts）
      lastErr = e instanceof TypeError
        ? new Error(`tencent network error (attempt ${attempt}) sym=${symbol}`)
        : e;
      if (attempt < RETRIES) await sleep(BACKOFF_MS * attempt);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`tencent kline failed sym=${symbol}`);
}
