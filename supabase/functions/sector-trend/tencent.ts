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

// —— Task 3b T3b-1：日期翻页历史回填（spec §2.1/S2「640根/次按日期翻页回 2019-01」；评审 I-2）——
// 现有 fetchRecentKline/parseKline/toSymbol 行为与签名不变；以下均为新增导出，只服务 backfill 链路。
// 纯逻辑（prevDay/mergeDedup）与翻页编排（fetchHistoryKline，fetchPage/sleepFn 可注入）分离，便于单测。

const HISTORY_START = "2019-01-01"; // spec §2.1 回测起点
const HISTORY_LMT = 640; // 腾讯单次上限 640 根
const HISTORY_MAX_PAGES = 6; // 已实证回测做法：最多 6 页
const HISTORY_MIN_ROWS = 30; // 本批 <30 行视为已拉到上市头，不再翻页
const HISTORY_PACING_MS = 300; // spec §3.2：0.3s/请求（批间）

// 日历日前一天（UTC 解析避免时区漂移）；非 ISO 格式 throw（调用方传的都是 YYYY-MM-DD）
export function prevDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`prevDay 非法日期: ${date}`);
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

// 多页去重合并：按 pages 传入顺序遍历，同 date 后写覆盖；结果按 date 严格升序。
// 翻页是从近期往远期拉（pages[0]=最新页…pages[n]=最旧页），同 date 边界以更早写入者为准，仅影响极少重叠日，取覆盖语义即可。
export function mergeDedup(pages: KlineResp[][]): KlineResp[] {
  const byDate = new Map<string, KlineResp>();
  for (const page of pages) {
    for (const r of page) byDate.set(r.date, r); // 后写覆盖
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// 单页拉取（默认复用 fetchRecentKline，含 3 次退避；测试可注入 fake）
export type FetchPage = (
  symbol: string,
  end: string,
  lmt: number,
) => Promise<KlineResp[]>;

export interface HistoryOpts {
  start?: string; // 起始日（首行 <= 此日即停），默认 2019-01-01
  end?: string; // 首页右端（含），调用方传今日
  lmt?: number; // 单次上限，默认 640
  maxPages?: number; // 页数上限，默认 6
  minRows?: number; // 本批续页阈值，默认 30
  pacingMs?: number; // 批间 pacing，默认 300
  fetchPage?: FetchPage; // 注入网络
  sleepFn?: (ms: number) => Promise<void>; // 注入 pacing（测试可免等待）
}

// 日期翻页拉全历史（回测实证算法）：单次 640；取回后若首行日期 > start 且本批 >= minRows，
// 则 end = 首行前一天再拉下一批；最多 maxPages 页；批间 pacingMs pacing；日期去重合并升序。
// 终止条件命中即停（含末页恰为 maxPages 时不再 sleep）。限流纪律：串行、无并发（C7）。
export async function fetchHistoryKline(
  symbol: string,
  opts: HistoryOpts = {},
): Promise<KlineResp[]> {
  const start = opts.start ?? HISTORY_START;
  const lmt = opts.lmt ?? HISTORY_LMT;
  const maxPages = opts.maxPages ?? HISTORY_MAX_PAGES;
  const minRows = opts.minRows ?? HISTORY_MIN_ROWS;
  const pacingMs = opts.pacingMs ?? HISTORY_PACING_MS;
  const fetchPage = opts.fetchPage ??
    ((s, e, l) => fetchRecentKline(s, e, l));
  const sleepFn = opts.sleepFn ?? sleep;

  const pages: KlineResp[][] = [];
  let curEnd = opts.end ?? new Date().toISOString().slice(0, 10);
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(symbol, curEnd, lmt);
    pages.push(batch);
    const firstDate = batch.length > 0 ? batch[0].date : "";
    // 续页判据：本批拉满量级(>=minRows) 且 首行仍晚于起始日 且 未到页数上限
    const shouldContinue = batch.length >= minRows && firstDate !== "" &&
      firstDate > start;
    if (!shouldContinue || page === maxPages) break;
    curEnd = prevDay(firstDate);
    await sleepFn(pacingMs); // 批间 pacing，末页不等待
  }
  return mergeDedup(pages);
}
