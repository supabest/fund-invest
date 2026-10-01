/// <reference lib="deno.ns" />
// sector-trend 纯函数内核（无 IO）——规则权威: docs/superpowers/specs/2026-09-30-sector-rotation-design.md §5
// 均线五态 / 六标签（回测证据阈值）/ ETF 四因子 renorm（Q35/V30/M25/L10，Q 全缺→V/M/L 归一）/ 行业规模加权分 / 横截面动量分位。
// 风格对齐 stock-score/engine.ts：Deno + TS + 无第三方依赖（仅 std testing 在测试侧）。
// S5 纪律：标签仅展示标记，不进分数；多头状态不构成买入标签（翻案①）。

interface EtfSnap {
  code: string; name: string; amt: number; tem: number;
  r60: number | null; sharpe: number | null; hay: string | null;
}
interface Bar { date: string; close: number; volume: number }
interface SectorInput {
  ind: string; pkEtf: string; nEtf: number; theme: string | null;
  etfs: EtfSnap[]; bars: Bar[]; prevMp: number | null;
}
interface SectorRow {
  ind: string; pkEtf: string; nEtf: number; theme: string | null;
  close: number; ma20: number; ma60: number; ma120: number;
  m20: number; m60: number; pos52: number | null; dev60: number;
  vr: number | null; mp: number | null; dm20: number | null;
  state: '强多头' | '多头' | '纠缠' | '走弱' | '空头排列';
  labels: string[]; barsN: number;
  score: number | null; v: number | null; m: number | null; l: number | null; q: number | null;
}

type State = SectorRow['state'];

// 四因子固定全权重（Q 无数据时按 Σ非缺腿w 归一，等价 spec renorm(46/38/15)）
const WQ = 35, WV = 30, WM = 25, WL = 10;

// V 估值档映射（spec §4.1）：5→100/4→80/3→60/2→40/1→20；越界视为 NA
const V_MAP: Record<number, number> = { 5: 100, 4: 80, 3: 60, 2: 40, 1: 20 };

// spec §5 阈值（逐字）
const T = {
  bottom: { pos52: 20, m20: 0.02, vr: 0.9 },   // 筑底候选: pos52≤20 且 m20>+2% 且 vr≤0.9
  overheat: { pos52: 90, dev60: 0.15 },          // 过热警示: pos52≥90 且 dev60≥+15%
  stall: { pos52: 70, vr: 1.8, m20: 0.02 },      // 高位放量滞涨: pos52≥70 且 vr≥1.8 且 |m20|≤2%
  chase: { dm20: 20, vr: 1.2, m20: 0.02 },        // 禁追高: dm20≥+20 且 vr≥1.2 且 m20>+2%
  ebb: { pos52: 70, dm20: -20 },                  // 退潮观察: pos52≥70 且 dm20≤-20
  left: { pos52: 15, m20: 0 },                     // 左侧埋伏: pos52≤15 且 m20≤0
};

const round2 = (x: number): number => Math.round(x * 100) / 100;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// 尾部窗口均值：窗口不足则按可得样本（保证 close/ma* 恒为 number）
function sma(closes: number[], w: number): number {
  const n = closes.length;
  const from = Math.max(0, n - w);
  let s = 0;
  for (let i = from; i < n; i++) s += closes[i];
  return s / (n - from);
}

// 区间涨跌：close/close[-k]-1，需 n>k 否则 null
function pctChange(closes: number[], k: number): number | null {
  const n = closes.length;
  if (n <= k) return null;
  const base = closes[n - 1 - k];
  return base === 0 ? null : closes[n - 1] / base - 1;
}

// 52 周(250 根)分位：需 ≥250 根；max==min → 0
function pos52(closes: number[]): number | null {
  if (closes.length < 250) return null;
  const win = closes.slice(-250);
  const c = closes[closes.length - 1];
  const mn = Math.min(...win), mx = Math.max(...win);
  return mx === mn ? 0 : (c - mn) / (mx - mn) * 100;
}

// 量比 20/120：需 ≥120 根
function volRatio(vols: number[]): number | null {
  if (vols.length < 120) return null;
  const a20 = sma(vols, 20), a120 = sma(vols, 120);
  return a120 === 0 ? null : a20 / a120;
}

function classifyState(ma20: number, ma60: number, ma120: number, close: number): State {
  if (ma20 > ma60 && ma60 > ma120 && close > ma20) return '强多头';
  if (ma20 > ma60 && close > ma60) return '多头';
  if (ma20 < ma60 && ma60 < ma120 && close < ma20) return '空头排列';
  if (ma20 < ma60 && close < ma60) return '走弱';
  return '纠缠';
}

// NA 重归一：有效腿按权重重分配，全缺 → null
function renorm(pairs: [number | null, number][]): number | null {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, w]) => a + w, 0);
  if (tot === 0) return null;
  return valid.reduce((a, [v, w]) => a + v * w, 0) / tot;
}

// 横截面百分位秩 (below + 0.5*ties)/N*100（升序），仅对有限值
function pctRank(values: (number | null)[]): (number | null)[] {
  const valid = values.filter(isNum);
  const n = valid.length;
  return values.map((v) => {
    if (!isNum(v)) return null;
    let below = 0, ties = 0;
    for (const x of valid) { if (x < v) below++; else if (x === v) ties++; }
    return (below + 0.5 * ties) / n * 100;
  });
}

interface EtfFactors { v: number | null; m: number | null; l: number | null; q: number | null; score: number | null }

// 对全池 ETF 计算四因子分（V 直接映射；M=0.6*r60截面+0.4*夏普截面；L=规模截面；Q 命中100/否则30，全池无 hay → 腿剔除）
function computeEtfFactors(pool: EtfSnap[]): EtfFactors[] {
  const qAlive = pool.some((e) => e.hay !== null && e.hay !== undefined);
  const r60Rank = pctRank(pool.map((e) => e.r60));
  const sharpeRank = pctRank(pool.map((e) => e.sharpe));
  const amtRank = pctRank(pool.map((e) => e.amt));
  return pool.map((e, i) => {
    const v = V_MAP[e.tem] ?? null;
    const m = renorm([[r60Rank[i], 0.6], [sharpeRank[i], 0.4]]);
    const l = amtRank[i];
    const q = qAlive ? (e.hay !== null && e.hay !== undefined ? 100 : 30) : null;
    const score = renorm([[q, WQ], [v, WV], [m, WM], [l, WL]]);
    return { v, m, l, q, score };
  });
}

// 规模加权均值：仅对该腿非空的 ETF 计入
function weighted(pool: EtfSnap[], vals: (number | null)[], legAlive = true): number | null {
  if (!legAlive) return null;
  let num = 0, den = 0;
  pool.forEach((e, i) => { const x = vals[i]; if (isNum(x)) { num += x * e.amt; den += e.amt; } });
  return den === 0 ? null : num / den;
}

function computeSectorRows(inputs: SectorInput[]): SectorRow[] {
  // 全池 ETF 因子（跨行业统一取截面百分位）
  const pool: EtfSnap[] = [];
  const etfIdxOf: number[][] = inputs.map(() => []);
  inputs.forEach((inp, idx) => inp.etfs.forEach((e) => { etfIdxOf[idx].push(pool.length); pool.push(e); }));
  const factors = computeEtfFactors(pool);

  // 行业 m60 → 横截面动量分位 mp（当日全体行业）
  const closesOf = inputs.map((inp) => inp.bars.map((b) => b.close));
  const m60Of = closesOf.map((c) => pctChange(c, 60));
  const mpOf = pctRank(m60Of);

  return inputs.map((inp, idx) => {
    const barsArr = inp.bars;
    const closes = closesOf[idx];
    const vols = barsArr.map((b) => b.volume);
    const n = barsArr.length;
    const barsN = n;

    const close = n > 0 ? closes[n - 1] : 0;
    const ma20 = sma(closes, 20), ma60 = sma(closes, 60), ma120 = sma(closes, 120);
    const m20raw = pctChange(closes, 20);
    const m60 = m60Of[idx];
    const m20 = m20raw ?? 0; // 类型 close/m20/dev60 为 number：样本不足以 0 兜底（历史不足另行处理）
    const p52 = pos52(closes);
    const vr = volRatio(vols);
    const dev60 = ma60 === 0 ? 0 : close / ma60 - 1;
    const mp = mpOf[idx];
    const dm20 = (isNum(mp) && isNum(inp.prevMp)) ? mp - inp.prevMp : null;

    const state = classifyState(ma20, ma60, ma120, close);

    // 标签：门槛 barsN≥250 且 pos52/vr 非空；dm20 相关另需 dm20 非空
    const labels: string[] = [];
    if (barsN >= 250 && p52 !== null && vr !== null) {
      if (p52 <= T.bottom.pos52 && m20 > T.bottom.m20 && vr <= T.bottom.vr) labels.push('筑底候选');
      if (p52 >= T.overheat.pos52 && dev60 >= T.overheat.dev60) labels.push('过热警示');
      if (p52 >= T.stall.pos52 && vr >= T.stall.vr && Math.abs(m20) <= T.stall.m20) labels.push('高位放量滞涨');
      if (p52 <= T.left.pos52 && m20 <= T.left.m20) labels.push('左侧埋伏');
      if (dm20 !== null) {
        if (dm20 >= T.chase.dm20 && vr >= T.chase.vr && m20 > T.chase.m20) labels.push('禁追高');
        if (p52 >= T.ebb.pos52 && dm20 <= T.ebb.dm20) labels.push('退潮观察');
      }
    }

    // 行业分：本行业入池 ETF 的四因子分规模加权；分项同法
    const myIdx = etfIdxOf[idx];
    const myEtfs = myIdx.map((i) => pool[i]);
    const leg = (sel: (f: EtfFactors) => number | null) => myIdx.map((i) => sel(factors[i]));
    const qAlivePool = pool.some((e) => e.hay !== null && e.hay !== undefined);
    const vAvg = weighted(myEtfs, leg((f) => f.v));
    const mAvg = weighted(myEtfs, leg((f) => f.m));
    const lAvg = weighted(myEtfs, leg((f) => f.l));
    const qAvg = weighted(myEtfs, leg((f) => f.q), qAlivePool);
    const score = weighted(myEtfs, leg((f) => f.score));

    return {
      ind: inp.ind, pkEtf: inp.pkEtf, nEtf: inp.nEtf, theme: inp.theme,
      close, ma20, ma60, ma120,
      m20, m60: m60 ?? 0, pos52: p52, dev60,
      vr, mp, dm20,
      state, labels, barsN,
      score: score === null ? null : round2(score),
      v: vAvg === null ? null : round2(vAvg),
      m: mAvg === null ? null : round2(mAvg),
      l: lAvg === null ? null : round2(lAvg),
      q: qAvg === null ? null : round2(qAvg),
    };
  });
}

// tencent.ts —— 腾讯前复权日K适配器（brief Step 1；规则权威 spec §2.1/S2 + §3.2 数据获取纪律）
// 数据源：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get（qfq 前复权，单次最多 640 根，按日期翻页回 2019-01）
// 东财 push2/push2his 已被 WAF IP 封禁（spec S2），本文件及其调用方零依赖。
// 纯解析（parseKline/toSymbol）与网络（fetchRecentKline）分离：前者单测，后者按 brief 由 mode=ping 线上验证。

interface KlineResp {
  date: string;
  close: number;
  volume: number;
}

const TX_BASE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const REQ_TIMEOUT_MS = 15_000;
const RETRIES = 3;
const BACKOFF_MS = 1_500; // spec §3.2：3 次退避重试（1.5s×n）

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// 腾讯返回严格字符串/数值；'' / '-' / null 一律视为无效（Number('')===0 的陷阱规避）
const toNum = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    ? Number(v)
    : NaN;

// qfqday || day → [date, close=r[2], volume=r[5]]（r[1]=open/r[3]=high/r[4]=low 不取）；畸形输入 → []
function parseKline(json: unknown, symbol: string): KlineResp[] {
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
function toSymbol(ofcode: string, market: string | null): string {
  const code = String(ofcode ?? "").trim();
  if (market === "1") return `sh${code}`;
  if (market === "0") return `sz${code}`;
  return code[0] === "5" || code[0] === "6" ? `sh${code}` : `sz${code}`;
}

// GET param={symbol},day,,{end},{lmt},qfq；3 次退避重试(1.5s×n)，全败 throw。
// pacing（0.3s/请求）由调用方负责（spec §3.2），本函数只管单发尽力拿到一批。
async function fetchRecentKline(
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
function prevDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`prevDay 非法日期: ${date}`);
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

// 多页去重合并：按 pages 传入顺序遍历，同 date 后写覆盖；结果按 date 严格升序。
// 翻页是从近期往远期拉（pages[0]=最新页…pages[n]=最旧页），同 date 边界以更早写入者为准，仅影响极少重叠日，取覆盖语义即可。
function mergeDedup(pages: KlineResp[][]): KlineResp[] {
  const byDate = new Map<string, KlineResp>();
  for (const page of pages) {
    for (const r of page) byDate.set(r.date, r); // 后写覆盖
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// 单页拉取（默认复用 fetchRecentKline，含 3 次退避；测试可注入 fake）
type FetchPage = (
  symbol: string,
  end: string,
  lmt: number,
) => Promise<KlineResp[]>;

interface HistoryOpts {
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
async function fetchHistoryKline(
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

// gs_etf.ts —— 国信 gs-etf-filter「行业型 ETF 截面」适配器（brief Step 2；spec §2.1 15 分段矩阵 / §3.2 纪律）
// 每晚 15 分段串行拉取（class1=1 行业型；endamt 规模段 × temperRegion 估值档），供：
//   ① 当日 V/L/M 因子腿（temperRegion→V、endamt→L、range60d/sharpe1yrank→M）
//   ② Q 景气探测（hayjqidu 当前全空 → Q 腿 null；一旦回填自动回切 Q35 权重，见 engine.computeEtfFactors）
// 控制者裁决 C2：触顶（=100 只）**只记 truncated**，绝不照抄 scripts/build_universe.ts 的 exit(2) 硬退出；
// MIN_ROWS 仅在整个 15 段并集异常（<300）时抛错，交编排层走 stale 降级（spec §3.2）。


const BASE =
  "https://dgzt.guosen.com.cn/skills/gsfinancing/selected/ETF/filterSearch/1.0";
const CAP = 100; // GS filterSearch 单段最多返回 100 只
const MIN_ROWS = 300; // spec §3.2：并集去重 <300 视为快照异常
const PACING_MS = 400; // brief Step 2：分段间 400ms
const ATTEMPTS = 2; // 首发 + 1 次重试
const RETRY_BACKOFF_MS = 1_500;
const GS_REQ_TIMEOUT_MS = 30_000;

// endamt ∈ {2-10 / 10-30 / 30+亿} × temperRegion ∈ {1..5}（1-高温…5-低温）= 15 分段（与 build_universe 同矩阵）
const AMT_BANDS = ["2,10", "10,30", "30,100000"];
const TEMPERS = ["1", "2", "3", "4", "5"];

interface EtfSnapRow {
  code: string;
  name: string;
  amt: number | null; // 亿；缺列 → null（brief「缺列→null」语义 ⇒ 可空，编排层按 NA 处理）
  tem: number | null; // 估值档 1..5；缺列 → null
  r60: number | null;
  sharpe: number | null;
  hay: string | null; // hayjqidu：空串/缺列 → null（Q 腿缺席）
}

function buildSegParams(
  amt: string,
  tem: string,
): Record<string, string> {
  return {
    class1: "1",
    endamt: amt,
    temperRegion: tem,
    orderCol: "nowrange",
    orderType: "0",
    softName: "goldsun_skills",
    skillName: "gs-etf-filter",
  };
}

const gsToNum = (v: unknown): number | null =>
  typeof v === "number"
    ? (Number.isFinite(v) ? v : null)
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    ? Number(v)
    : null;
const toStr = (
  v: unknown,
): string => (typeof v === "string"
  ? v.trim()
  : typeof v === "number"
  ? String(v)
  : "");

// data[] → EtfSnapRow[]（ofcode/ofname/endamt/temperRegion/range60d/sharpe1yrank/hayjqidu；缺列→null）
function parseSearchResp(json: unknown): EtfSnapRow[] {
  const j = json as { result?: { code?: number }[]; data?: unknown } | null;
  if (!j || typeof j !== "object") return [];
  if (j.result?.[0]?.code !== 0) return []; // 业务失败码（鉴权/参数）当空截面，交由 fetchSegments 记 warning
  const data = Array.isArray(j.data) ? j.data : null;
  if (!data) return [];
  const out: EtfSnapRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const code = toStr(r.ofcode);
    const hay = toStr(r.hayjqidu);
    out.push({
      code,
      name: toStr(r.ofname),
      amt: gsToNum(r.endamt),
      tem: gsToNum(r.temperRegion),
      r60: gsToNum(r.range60d),
      sharpe: gsToNum(r.sharpe1yrank),
      hay: hay === "" ? null : hay,
    });
  }
  return out;
}

async function segFetch(
  amt: string,
  tem: string,
  apiKey: string,
): Promise<EtfSnapRow[]> {
  const qs = new URLSearchParams({ ...buildSegParams(amt, tem), apiKey });
  let lastErr: unknown = new Error("gs_etf fetch failed");
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, {
        signal: AbortSignal.timeout(GS_REQ_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const rows = parseSearchResp(await r.json());
      if (rows.length === 0) throw new Error("GS 空截面/业务失败码"); // 含 result.code≠0（如 apiKey 失效）
      return rows;
    } catch (e) {
      // 网络错误 message 可能内嵌含 apiKey 的完整 URL → 脱敏（先例：stock-score/gs.ts、tencent.ts）
      lastErr = e instanceof TypeError
        ? new Error(`GS network error (attempt ${attempt})`)
        : e;
      if (attempt < ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("gs_etf fetch failed");
}

interface SegSnapshot {
  rows: Map<string, EtfSnapRow>;
  truncated: string[];
  warnings: string[];
}

// 15 分段串行 + 400ms pacing；单段失败（重试后）记 warning 继续；满 100 记 truncated；并集 <300 → throw('MIN_ROWS')
async function fetchSegments(apiKey: string): Promise<SegSnapshot> {
  const rows = new Map<string, EtfSnapRow>();
  const truncated: string[] = [];
  const warnings: string[] = [];
  for (const amt of AMT_BANDS) {
    for (const tem of TEMPERS) {
      const seg = `amt=${amt}×temper${tem}`;
      let segRows: EtfSnapRow[] | null = null;
      try {
        segRows = await segFetch(amt, tem, apiKey);
      } catch (e) {
        warnings.push(
          `${seg} 取数失败（重试 ${ATTEMPTS} 次后跳过）: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (segRows) {
        if (segRows.length === CAP) {
          truncated.push(
            `${seg} 返回满 ${CAP} 只（覆盖未闭合，仅记警告不炸链 C2）`,
          );
        }
        for (const r of segRows) {
          if (r.code && !rows.has(r.code)) rows.set(r.code, r);
        }
      }
      await sleep(PACING_MS);
    }
  }
  if (rows.size < MIN_ROWS) {
    throw new Error(
      `MIN_ROWS 违例: 并集去重 ${rows.size} < ${MIN_ROWS}（快照异常）`,
    );
  }
  return { rows, truncated, warnings };
}


// sector-trend —— 行业ETF板块轮动 nightly 编排（brief Step 3；结构严格仿 stock-score/index.ts）
// 规则权威: docs/superpowers/specs/2026-09-30-sector-rotation-design.md §3（数据源纪律）§6（nightly 流程）
// 内核（指标/状态/标签/renorm）全部在 engine.ts（Task 2 冻结，本文件一字不改），此处只做数据接入与落库。
//
// 控制者裁决落点：
//   C1 宇宙只读：nightly 仅处理 sector_etf_map 中 is_rep=true 的既有代表 ETF，不做行业归一，
//      不 import scripts/；截面里出现的 map 外 ETF 只记 warnings。
//   C2 触顶降级：GS 分段满 100 只 → truncated 警告 + 继续（gs_etf.ts 内实现），绝不 exit 炸链。
//   C3 barsN 不足：engine 把样本不足的 m20/m60/dev60 兜底为 0 ⇒ 榜单排序只在 barsN≥250 子集内进行，
//      不足者计入 accumulating 并在响应里暴露（rankLists/splitByBarsN）。
//   C4 prevMp：从 sector_rotation_daily 最近一个 batch_date 取 (ind, mp)；取不到传 null（首跑全 null）。
//   C5 stale：某行业当日 K线/截面失败 → 复制昨日行且 stale=true，不静默丢行业。
//   C6 凭据：token/key 只从 env 读，错误信息不含 URL/凭据（tencent.ts/gs_etf.ts 各自脱敏）。
//   C7 pacing：腾讯 300ms/请求；GS 分段 400ms。




// —— 常量 ——
const BARS_FULL = 250; // spec §5 标签门槛 = C3 accumulating 分界
const DEPTH_LMT = 640; // spec S2：腾讯单次最多 640 根（历史不足时先深拉一次）
const TAIL_KEEP = 300; // 引擎窗口上限（pos52 需 250 根，留余量）
const READ_WINDOW_DAYS = 450; // DB 尾读日历日窗口（≈290 交易日 > 250）
const KLINE_PACING_MS = 300; // spec §3.2
const UPSERT_CHUNK = 1000; // 与 stock-score/upsert 同粒度
const KLINE_FLUSH_EVERY = 20; // 每 20 只代表 ETF 冲刷一次 sector_kline（防 wall-clock 截断丢整轮深拉成果）
const BACKFILL_START = "2019-01-01"; // Task 3b T3b-1：历史翻页起点（spec §2.1/S2；评审 I-2，pos52/未来 label_stats 需多年历史）
// 注：MIN_ROWS 快照守卫单一定义在 gs_etf.fetchSegments（编排层不重复声明，避免 bundle 重名）

// —— 类型 ——
interface MapRow {
  etf_code: string;
  etf_name: string;
  canonical_ind: string;
  amt: number | null;
  is_rep: boolean;
}

// sector_rotation_daily 的 24 列（scripts/migrate_sector_rotation.sql 实列名；表无 bars_n 列 ⇒ barsN 不落库）
interface DailyRow {
  batch_date: string;
  ind: string;
  pk_etf: string;
  n_etf: number;
  close: number;
  ma20: number;
  ma60: number;
  ma120: number;
  m20: number;
  m60: number;
  pos52: number | null;
  dev60: number;
  vr: number | null;
  mp: number | null;
  dm20: number | null;
  state: string;
  labels: string[];
  score: number | null;
  v: number | null;
  m: number | null;
  l: number | null;
  q: number | null;
  theme: string | null;
  stale: boolean;
}

// spec §4.4 + brief Step 3 字典逐字；末尾 2 个键是 Task 1b 归并裁定（R1 有色金属→有色）后的补偿别名，
// 否则「全球资源」主题会整族落空（报告偏离 3）。
const THEME_MAP: Record<string, string> = {
  "电力": "电力/绿电",
  "绿色电力": "电力/绿电",
  "机器人": "机器人",
  "新能源车": "新能源车",
  "电池": "新能源车",
  "充电桩": "新能源车",
  "资源": "全球资源",
  "有色金属": "全球资源",
  "有色": "全球资源", // R1 补偿别名
  "稀土": "全球资源",
  "煤炭": "全球资源",
  "石油": "全球资源",
  "油气": "全球资源",
  "粮食": "全球资源",
  "大宗商品": "全球资源",
  "黄金": "全球资源",
};

// —— 以下纯函数可被 index_test.ts 直接单测（无 IO） ——
function themeOf(ind: string): string | null {
  return THEME_MAP[ind] ?? null;
}

// 字典中在本轮宇宙里找不到对应行业的键（C1 纪律：只报警、不落库、不新建行业）
function unmatchedThemeKeys(inds: string[]): string[] {
  const set = new Set(inds);
  return Object.keys(THEME_MAP).filter((k) => !set.has(k));
}

const r4 = (
  x: number | null,
):
  | number
  | null => (x === null || !Number.isFinite(x)
    ? null
    : Math.round(x * 10000) / 10000);

// SectorRow → DB 行（23 引擎字段 → 24 列；barsN 无对应列，故不落库）
function toDbRow(
  r: SectorRow,
  batchDate: string,
  stale: boolean,
): DailyRow {
  return {
    batch_date: batchDate,
    ind: r.ind,
    pk_etf: r.pkEtf,
    n_etf: r.nEtf,
    close: r4(r.close) ?? 0,
    ma20: r4(r.ma20) ?? 0,
    ma60: r4(r.ma60) ?? 0,
    ma120: r4(r.ma120) ?? 0,
    m20: r4(r.m20) ?? 0,
    m60: r4(r.m60) ?? 0,
    pos52: r4(r.pos52),
    dev60: r4(r.dev60) ?? 0,
    vr: r4(r.vr),
    mp: r4(r.mp),
    dm20: r4(r.dm20),
    state: r.state,
    labels: r.labels,
    score: r.score,
    v: r.v,
    m: r.m,
    l: r.l,
    q: r.q,
    theme: r.theme,
    stale,
  };
}

// C3：按 250 根门槛分流（不足者不参与榜单排序，标签已由 engine 置空）
function splitByBarsN(
  rows: SectorRow[],
): { tradable: SectorRow[]; accumulating: SectorRow[] } {
  const tradable: SectorRow[] = [];
  const accumulating: SectorRow[] = [];
  for (const r of rows) {
    (r.barsN >= BARS_FULL ? tradable : accumulating).push(r);
  }
  return { tradable, accumulating };
}

// spec §4.3 榜单口径：向上(强多头/多头, m60 降序) / 调整(走弱/空头排列, m60 升序) / 纠缠计数
// —— 仅在 barsN≥250 子集内排（C3：m60=0 兜底值不得当真实涨跌）
function rankLists(
  rows: SectorRow[],
): {
  up: SectorRow[];
  down: SectorRow[];
  entangled: number;
  accumulating: number;
} {
  const { tradable, accumulating } = splitByBarsN(rows);
  const up = tradable.filter((r) => r.state === "强多头" || r.state === "多头")
    .sort((a, b) => b.m60 - a.m60);
  const down = tradable.filter((r) =>
    r.state === "走弱" || r.state === "空头排列"
  ).sort((a, b) => a.m60 - b.m60);
  const entangled = tradable.filter((r) => r.state === "纠缠").length;
  return { up, down, entangled, accumulating: accumulating.length };
}

// C5/§3.2：昨日行整批 copy 到今日，labels 原样、不重算，仅换 batch_date 并置 stale
function shapeStaleRow(prev: DailyRow, batchDate: string): DailyRow {
  return {
    ...prev,
    batch_date: batchDate,
    labels: [...(prev.labels ?? [])],
    stale: true,
  };
}

// C1/C2/C5 的降级信息统一聚合：展平 + 去重 + 保序 + 溢出折叠成一条
function aggregateWarnings(
  parts: (string[] | undefined)[],
  cap = 50,
): string[] {
  const out: string[] = [];
  for (const p of parts) {
    for (const w of p ?? []) if (!out.includes(w)) out.push(w);
  }
  if (out.length <= cap) return out;
  return [...out.slice(0, cap), `…另有 ${out.length - cap} 条警告未展开`];
}

// S4：Q 腿从「昨日全 null」到「今日有数据」才算复活（首跑无昨日行 ⇒ 只要 qAlive 就报，保守）
function isQResurrected(
  prevRows: { q: number | null }[],
  qAlive: boolean,
): boolean {
  if (!qAlive) return false;
  return prevRows.every((r) => r.q === null || r.q === undefined);
}

// C1 宇宙 × 当日截面 × K线尾 × prevMp → 引擎入参；行业无任何截面 ETF → 记入 noSnap（编排层走 stale）
function assembleInputs(
  mapRows: MapRow[],
  snap: Map<string, EtfSnapRow>,
  barsByCode: Map<string, Bar[]>,
  prevMp: Map<string, number>,
): { inputs: SectorInput[]; noSnap: string[]; offmapCodes: string[] } {
  const byInd = new Map<string, MapRow[]>();
  for (const m of mapRows) {
    const arr = byInd.get(m.canonical_ind);
    if (arr) arr.push(m);
    else byInd.set(m.canonical_ind, [m]);
  }
  const inputs: SectorInput[] = [];
  const noSnap: string[] = [];
  const inds = [...byInd.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  for (const ind of inds) {
    const rows = byInd.get(ind)!;
    const rep = rows.find((r) => r.is_rep) ??
      rows.slice().sort((a, b) => (b.amt ?? 0) - (a.amt ?? 0))[0];
    const etfs: EtfSnap[] = [];
    for (
      const m of rows.slice().sort((a, b) =>
        a.etf_code.localeCompare(b.etf_code)
      )
    ) {
      const s = snap.get(m.etf_code);
      if (!s || s.amt === null) continue; // 截面缺该 ETF / 规模 NA ⇒ 不可加权，不入池
      etfs.push({
        code: s.code,
        name: s.name || m.etf_name,
        amt: s.amt,
        tem: s.tem ?? 0,
        r60: s.r60,
        sharpe: s.sharpe,
        hay: s.hay,
      });
    }
    if (etfs.length === 0) noSnap.push(ind);
    inputs.push({
      ind,
      pkEtf: rep.etf_code,
      nEtf: etfs.length,
      theme: themeOf(ind),
      etfs,
      bars: barsByCode.get(rep.etf_code) ?? [],
      prevMp: prevMp.get(ind) ?? null,
    });
  }
  const codes = new Set(mapRows.map((m) => m.etf_code));
  const offmapCodes = [...snap.keys()].filter((c) => !codes.has(c));
  return { inputs, noSnap, offmapCodes };
}

// —— 以下为 IO 编排（按 brief：网络链以 mode=ping 线上验证代替单测） ——
function svcHeaders(): Record<string, string> {
  const serviceKey = Deno.env.get("SB_SERVICE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function upsert(
  rows: Record<string, unknown>[],
  table: string,
  onConflict: string,
) {
  const url = Deno.env.get("SUPABASE_URL")!;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { ...svcHeaders(), "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
    });
    if (!r.ok) {
      throw new Error(
        `upsert ${table} ${r.status} ${(await r.text()).slice(0, 300)}`,
      );
    }
  }
}

async function readTable<T>(path: string): Promise<T[]> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: svcHeaders() });
  if (!r.ok) {
    throw new Error(
      `read ${path.split("?")[0]} ${r.status} ${
        (await r.text()).slice(0, 300)
      }`,
    );
  }
  return (await r.json()) as T[];
}

const SAFE_CODE = /^[A-Za-z0-9._-]+$/;

// PostgREST 尾读查询串（纯函数，单测钉住）：
//  - 单 ETF 等值过滤 + order desc + limit：单次响应行数一定 < 平台上限（实测批量 in.() 取 20×302 行被 1000 行上限静默截断）
//  - code 含引号/空格等一律拒绝（返回 null），避免过滤器注入
function klineOneQuery(
  code: string,
  cutoff: string,
  limit: number,
): string | null {
  if (!SAFE_CODE.test(code)) return null;
  return `sector_kline?select=trade_date,close,volume&etf_code=eq.${code}&trade_date=gte.${cutoff}&order=trade_date.desc&limit=${limit}`;
}

// 分批冲刷判定（纯函数）：i 为 1-based 已处理只数
function shouldFlush(i: number, total: number, every: number): boolean {
  return every > 0 && (i % every === 0 || i >= total);
}

// C3 尾读：逐只 ETF 取窗口内最近 TAIL_KEEP 根（单请求行数 ≤ TAIL_KEEP，消除批量截断风险）
async function readBarsTail(codes: string[]): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const c of codes) out.set(c, []);
  const cutoff = new Date(Date.now() - READ_WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  for (const code of codes) {
    const path = klineOneQuery(code, cutoff, TAIL_KEEP);
    if (!path) continue;
    const rows = await readTable<
      { trade_date: string; close: number; volume: number | null }
    >(path);
    const arr: Bar[] = rows.map((r) => ({
      date: r.trade_date,
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    }));
    arr.reverse(); // desc 取回 → 转时间升序（引擎把末根作今日收盘）
    out.set(code, arr);
  }
  return out;
}

// 最近一个批次（整批，含全部列）：供 prevMp（C4）与 stale copy（C5）
async function readPrevBatch(today: string): Promise<DailyRow[]> {
  let rows: DailyRow[];
  try {
    rows = await readTable<DailyRow>(
      `sector_rotation_daily?select=*&batch_date=lt.${today}&order=batch_date.desc&limit=500`,
    );
  } catch {
    return []; // 首跑/表读失败：无昨日行 ⇒ stale 无从复制（在响应里以 warning 披露）
  }
  if (rows.length === 0) return [];
  const last = rows[0].batch_date;
  return rows.filter((r) => r.batch_date === last);
}

interface KlineResult {
  barsByCode: Map<string, Bar[]>;
  added: number;
  failed: { etf_code: string; ind: string; err: string }[];
}

// 步骤②：腾讯夜增量（lmt=5）；表内不足 250 根时先深拉一次（lmt=640），之后自动回到夜增量
async function updateKlines(
  reps: MapRow[],
  today: string,
): Promise<KlineResult> {
  const codes = reps.map((r) => r.etf_code);
  const barsByCode = await readBarsTail(codes);
  const added: {
    etf_code: string;
    trade_date: string;
    close: number;
    volume: number;
  }[] = [];
  const failed: KlineResult["failed"] = [];
  let nAdded = 0;
  for (let idx = 0; idx < reps.length; idx++) {
    const rep = reps[idx];
    const sym = toSymbol(rep.etf_code, null);
    const stored = barsByCode.get(rep.etf_code) ?? [];
    const lmt = stored.length < BARS_FULL ? DEPTH_LMT : 5;
    try {
      const fetched = await fetchRecentKline(sym, today, lmt);
      const have = new Set(stored.map((b) => b.date));
      let fresh = 0;
      for (const b of fetched) {
        if (have.has(b.date)) continue;
        have.add(b.date);
        added.push({
          etf_code: rep.etf_code,
          trade_date: b.date,
          close: b.close,
          volume: b.volume,
        });
        stored.push({ date: b.date, close: b.close, volume: b.volume });
        fresh++;
      }
      while (stored.length > TAIL_KEEP) stored.shift();
      barsByCode.set(rep.etf_code, stored);
      nAdded += fresh;
      if (fresh > 0 && lmt === 5) {
        console.log(`kline ${rep.etf_code} +${fresh}`);
      }
    } catch (e) {
      failed.push({
        etf_code: rep.etf_code,
        ind: rep.canonical_ind,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    await sleep(KLINE_PACING_MS); // spec §3.2：0.3 秒/请求
    if (
      added.length > 0 && shouldFlush(idx + 1, reps.length, KLINE_FLUSH_EVERY)
    ) {
      await upsert(added, "sector_kline", "etf_code,trade_date"); // 分批冲刷，崩在中间也不丢已拉到的 bar
      added.length = 0;
    }
  }
  if (added.length > 0) {
    await upsert(added, "sector_kline", "etf_code,trade_date");
  }
  return { barsByCode, added: nAdded, failed };
}

// —— Task 3b T3b-1 mode=backfill：逐只代表 ETF 日期翻页拉全历史并 upsert sector_kline ——
// 限流纪律（C7）：fetchHistoryKline 内部页间 0.3s；本函数再保证 ETF 间 ≥ 0.3s（末页后无内部 sleep），
// 全程串行无并发；连续失败不在此重试加频（交由上层观察 failed 列表判断是否疑似限流）。
interface BackfillStats {
  etfs: number;
  rowsAdded: number; // 相对 pre-read 已存日期的新增行数（pre-read 受 PostgREST 1000 行上限约束，重跑时可能低估存量 ⇒ rowsAdded 偏大但不改变幂等结果）
  rowsWritten: number; // 本次 upsert 写出的去重历史总行数（含已存，merge-duplicates 幂等）
  pages: number; // fetchPage 调用次数（翻页总量，用于限流取证）
  failed: { etf_code: string; ind: string; err: string }[];
  minDate: string | null;
  maxDate: string | null;
}

async function backfillHistory(
  reps: MapRow[],
  today: string,
): Promise<BackfillStats> {
  const out: BackfillStats = {
    etfs: reps.length,
    rowsAdded: 0,
    rowsWritten: 0,
    pages: 0,
    failed: [],
    minDate: null,
    maxDate: null,
  };
  const buffer: {
    etf_code: string;
    trade_date: string;
    close: number;
    volume: number;
  }[] = [];
  for (let idx = 0; idx < reps.length; idx++) {
    const rep = reps[idx];
    if (!SAFE_CODE.test(rep.etf_code)) {
      out.failed.push({
        etf_code: rep.etf_code,
        ind: rep.canonical_ind,
        err: "非法 etf_code（防过滤器注入，跳过）",
      });
      continue;
    }
    const sym = toSymbol(rep.etf_code, null);
    try {
      // 已存日期（升序，受 1000 行上限；首跑存量 ≤640 完整）
      const pre = await readTable<{ trade_date: string }>(
        `sector_kline?select=trade_date&etf_code=eq.${rep.etf_code}&order=trade_date.asc`,
      ).catch(() => []);
      const existing = new Set(pre.map((p) => p.trade_date));
      const countingFetch: FetchPage = async (s, e, l) => {
        out.pages++;
        return fetchRecentKline(s, e, l);
      };
      const hist = await fetchHistoryKline(sym, {
        start: BACKFILL_START,
        end: today,
        fetchPage: countingFetch,
      });
      let added = 0;
      for (const b of hist) {
        buffer.push({
          etf_code: rep.etf_code,
          trade_date: b.date,
          close: b.close,
          volume: b.volume,
        });
        if (!existing.has(b.date)) added++;
        if (out.minDate === null || b.date < out.minDate) out.minDate = b.date;
        if (out.maxDate === null || b.date > out.maxDate) out.maxDate = b.date;
      }
      out.rowsAdded += added;
      out.rowsWritten += hist.length;
    } catch (e) {
      out.failed.push({
        etf_code: rep.etf_code,
        ind: rep.canonical_ind,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    await sleep(KLINE_PACING_MS); // ETF 间也保持 ≥0.3s（页内已由 fetchHistoryKline pacing）
    if (
      buffer.length > 0 && shouldFlush(idx + 1, reps.length, KLINE_FLUSH_EVERY)
    ) {
      await upsert(buffer, "sector_kline", "etf_code,trade_date"); // 分批冲刷，崩中间不丢已拉历史
      buffer.length = 0;
    }
  }
  if (buffer.length > 0) {
    await upsert(buffer, "sector_kline", "etf_code,trade_date");
  }
  return out;
}

// 批次统计（刷新前后对照用，纯读）：distinct batch_date 数、最新批次、最新批次内 pos52 IS NULL（= accumulating 代理，D4 已严格等价）计数。
// 注：limit=500 与 readPrevBatch 同口径；若批次数 × 行业数 > 500，batches/latestAcc 为近似（order desc 保证最新批次必完整）。
async function readDailyStats(): Promise<
  { batches: number; latestAcc: number; latest: string | null }
> {
  const rows = await readTable<{ batch_date: string; pos52: number | null }>(
    "sector_rotation_daily?select=batch_date,pos52&order=batch_date.desc&limit=500",
  ).catch(() => []);
  if (rows.length === 0) return { batches: 0, latestAcc: 0, latest: null };
  const set = new Set(rows.map((r) => r.batch_date));
  const latest = rows[0].batch_date;
  const latestAcc =
    rows.filter((r) => r.batch_date === latest && r.pos52 === null)
      .length;
  return { batches: set.size, latestAcc, latest };
}

// 守卫仅针对单测场景（index_test.ts 先设 SECTOR_TREND_DISABLE_SERVE 再动态 import）；
// 线上 Edge 不会注入该变量，Deno.serve 注册行为不变（同 stock-score）。
if (!Deno.env.get("SECTOR_TREND_DISABLE_SERVE")) {
  Deno.serve(async (req: Request) => {
    const token = Deno.env.get("SECTOR_TREND_TOKEN") || "";
    if (!token || req.headers.get("Authorization") !== `Bearer ${token}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const u = new URL(req.url);
    const mode = u.searchParams.get("mode") || "run";
    const stage = u.searchParams.get("stage") || "";
    const today = new Date().toISOString().slice(0, 10);
    const warnParts: (string[] | undefined)[] = [];
    try {
      if (mode === "ping") {
        const rows = await fetchRecentKline("sh512800", today, 5);
        return Response.json({
          ok: true,
          mode,
          batch_date: today,
          bars: rows.length,
          last: rows[rows.length - 1],
        });
      }
      const key = Deno.env.get("GS_API_KEY") || "";
      if (!key) {
        return Response.json({ ok: false, error: "GS_API_KEY missing" }, {
          status: 500,
        });
      }

      // ① 宇宙（C1：sector_etf_map 既有 is_rep 行；空表 ⇒ throw，保留旧批次语义）
      const mapRows = await readTable<MapRow>(
        "sector_etf_map?select=etf_code,etf_name,canonical_ind,amt,is_rep&order=etf_code.asc",
      );
      if (mapRows.length === 0) {
        throw new Error("seed missing: sector_etf_map 为空，保留旧批次");
      }
      let reps = mapRows.filter((m) => m.is_rep);
      const onlyInds = (u.searchParams.get("inds") || "").split(",").map((s) =>
        s.trim()
      ).filter(Boolean);
      if (onlyInds.length > 0) {
        reps = reps.filter((r) => onlyInds.includes(r.canonical_ind));
      }
      const limit = Number(u.searchParams.get("limit") || "0");
      const offset = Number(u.searchParams.get("offset") || "0");
      if (limit > 0 || offset > 0) {
        const end = limit > 0 ? offset + limit : undefined; // 冒烟/分批回填用
        reps = reps.slice(offset, end);
      }
      if (reps.length === 0) {
        throw new Error(
          `seed missing: 宇宙筛选后 0 个行业 (inds=${onlyInds.join("/")})`,
        );
      }
      const selInds = new Set(reps.map((r) => r.canonical_ind));
      const subMap = mapRows.filter((m) => selInds.has(m.canonical_ind));
      warnParts.push(
        unmatchedThemeKeys([...selInds]).length > 0
          ? [
            `theme 字典未命中行业键: ${
              unmatchedThemeKeys([...selInds]).join(",")
            }`,
          ]
          : [],
      );

      // ② 腾讯K线增量（0.3s pacing + 3 次退避重试；单只失败只计数，不中断）
      //   mode=backfill：先逐只代表 ETF 日期翻页拉全历史 upsert（走与 run 相同的鉴权/宇宙/写入链路），
      //   再自动续跑下面与 mode=run 相同的当日计算（pos52/dev60/labels 基于新历史刷新）。
      //   阀门（防 edge wall-clock 截断，沿用 Task 3 mode=run&stage=kline 分批实证做法）：
      //     &stage=history[&limit&offset] = 仅分页拉取（可分批），不做计算轮即早返回；
      //     &stage=compute = 跳过分页，仅跑计算轮（分页已由前序 stage=history 完成）。
      let bf: BackfillStats | null = null;
      let dailyBefore: {
        batches: number;
        latestAcc: number;
        latest: string | null;
      } | null = null;
      if (mode === "backfill") {
        dailyBefore = await readDailyStats();
        if (stage !== "compute") {
          bf = await backfillHistory(reps, today);
          if (bf.failed.length > 0) {
            warnParts.push(
              bf.failed.map((f) =>
                `backfill 失败 ${f.etf_code}(${f.ind}): ${f.err}`
              ),
            );
          }
        }
        if (stage === "history") {
          return Response.json({
            ok: true,
            mode,
            stage,
            batch_date: today,
            etfs: reps.length,
            rows_added: bf?.rowsAdded ?? 0,
            rows_written: bf?.rowsWritten ?? 0,
            pages_total: bf?.pages ?? 0,
            kline_min: bf?.minDate ?? null,
            kline_max: bf?.maxDate ?? null,
            kline_failed: bf?.failed.length ?? 0,
            warnings: aggregateWarnings(warnParts),
          });
        }
      }
      const kn = await updateKlines(reps, today);
      if (kn.failed.length > 0) {
        warnParts.push(
          kn.failed.map((f) => `kline 失败 ${f.etf_code}(${f.ind}): ${f.err}`),
        );
      }
      if (stage === "kline") {
        return Response.json({
          ok: true,
          mode,
          stage,
          batch_date: today,
          reps: reps.length,
          kline_added: kn.added,
          kline_failed: kn.failed.length,
          bars_min: Math.min(
            ...[...kn.barsByCode.values()].map((b) => b.length),
          ),
          bars_max: Math.max(
            ...[...kn.barsByCode.values()].map((b) => b.length),
          ),
          warnings: aggregateWarnings(warnParts),
        });
      }

      // ③ GS 15 分段截面（含 Q 探测；整轮失败 ⇒ 全局 stale 降级）
      let snap = new Map<string, EtfSnapRow>();
      let truncated: string[] = [];
      let gsError = "";
      try {
        const seg = await fetchSegments(key);
        snap = seg.rows;
        truncated = seg.truncated;
        warnParts.push(seg.warnings);
      } catch (e) {
        gsError = e instanceof Error ? e.message : String(e); // 含 MIN_ROWS：适配器已脱敏
        warnParts.push([`GS 截面整体失败: ${gsError}`]);
      }
      const qAlive = [...snap.values()].some((r) => r.hay !== null);

      // ④ prevMp（C4）+ 昨日整批（C5）
      const prevRows = await readPrevBatch(today);
      const prevMp = new Map<string, number>();
      for (const r of prevRows) {
        if (typeof r.mp === "number") prevMp.set(r.ind, r.mp);
      }
      const prevByInd = new Map<string, DailyRow>(
        prevRows.map((r) => [r.ind, r]),
      );

      // ⑤ 组装 → 引擎 → upsert
      const { inputs, noSnap, offmapCodes } = assembleInputs(
        subMap,
        snap,
        kn.barsByCode,
        prevMp,
      );
      warnParts.push(
        offmapCodes.length > 0
          ? [
            `GS 截面含 ${offmapCodes.length} 只 map 外 ETF（nightly 不做归一 C1，周一本地流程处理）: ${
              offmapCodes.slice(0, 10).join(",")
            }${offmapCodes.length > 10 ? ",…" : ""}`,
          ]
          : [],
      );
      warnParts.push(
        noSnap.length > 0
          ? [`截面缺该行业 ETF（走 stale）: ${noSnap.join(",")}`]
          : [],
      );

      const staleInds = new Set([...noSnap, ...kn.failed.map((f) => f.ind)]);
      const computed = gsError || inputs.length === 0
        ? []
        : computeSectorRows(inputs);

      const outRows: DailyRow[] = [];
      let staleRows = 0;
      const dropped: string[] = [];
      for (const r of computed) {
        const needStale = staleInds.has(r.ind);
        const prev = prevByInd.get(r.ind);
        if (needStale && prev) {
          outRows.push(shapeStaleRow(prev, today));
          staleRows++;
        } else {
          if (needStale && !prev) dropped.push(r.ind);
          outRows.push(toDbRow(r, today, needStale));
          if (needStale && !prev) staleRows++; // 无昨日行可 copy ⇒ 当日行标 stale，绝不静默丢（C5）
        }
      }
      if (gsError) {
        // 整轮截面失败 ⇒ 昨日整批 copy 到今日（labels 原样，不重算）
        outRows.length = 0;
        staleRows = 0;
        for (const prev of prevRows) {
          if (selInds.has(prev.ind)) {
            outRows.push(shapeStaleRow(prev, today));
            staleRows++;
          }
        }
        if (outRows.length === 0) {
          warnParts.push([
            "stale 降级无可 copy 的昨日批次 ⇒ 本轮不写库，保留旧批次",
          ]);
        }
      }
      if (dropped.length > 0) {
        warnParts.push([
          `无昨日行、保留当日降级行并置 stale: ${dropped.join(",")}`,
        ]);
      }
      if (outRows.length > 0) {
        await upsert(
          outRows as unknown as Record<string, unknown>[],
          "sector_rotation_daily",
          "batch_date,ind",
        );
      }

      // ⑥ S4：Q 腿复活探测（false→true 才 log 一次）
      if (isQResurrected(prevRows, qAlive)) console.log("Q_RESURRECTED");

      const lists = rankLists(computed);
      const acc = lists.accumulating;
      // mode=backfill 专用响应：刷新前后对照（批次不增 + accumulating 刷新）+ 历史深度/行数取证
      if (mode === "backfill") {
        const dailyAfter = await readDailyStats();
        return Response.json({
          ok: outRows.length > 0,
          mode,
          batch_date: today,
          etfs: bf?.etfs ?? reps.length,
          rows_added: bf?.rowsAdded ?? 0,
          rows_written: bf?.rowsWritten ?? 0,
          pages_total: bf?.pages ?? 0,
          kline_min: bf?.minDate ?? null,
          kline_max: bf?.maxDate ?? null,
          kline_failed: (bf?.failed.length ?? 0) + kn.failed.length,
          batches_before: dailyBefore?.batches ?? null,
          batches_after: dailyAfter.batches,
          accumulating_before: dailyBefore?.latestAcc ?? null,
          accumulating_after: acc,
          industries: outRows.length,
          up: lists.up.length,
          down: lists.down.length,
          entangled: lists.entangled,
          stale_rows: staleRows,
          gs_rows: snap.size,
          gs_offmap: offmapCodes.length,
          prev_batch_date: prevRows[0]?.batch_date ?? null,
          error: gsError || undefined,
          warnings: aggregateWarnings(warnParts),
        });
      }
      return Response.json({
        ok: outRows.length > 0,
        mode,
        batch_date: today,
        industries: outRows.length,
        up: lists.up.length,
        down: lists.down.length,
        entangled: lists.entangled,
        accumulating: acc,
        accumulating_inds: splitByBarsN(computed).accumulating.map((r) =>
          `${r.ind}(n=${r.barsN})`
        ),
        up_list: lists.up.slice(0, 10).map((r) =>
          `${r.ind}:${Math.round(r.m60 * 1000) / 10}`
        ),
        down_list: lists.down.slice(0, 10).map((r) =>
          `${r.ind}:${Math.round(r.m60 * 1000) / 10}`
        ),
        stale_rows: staleRows,
        kline_added: kn.added,
        kline_failed: kn.failed.length,
        gs_rows: snap.size,
        gs_offmap: offmapCodes.length,
        truncated,
        q_alive: qAlive,
        q_resurrected: isQResurrected(prevRows, qAlive),
        prev_batch_date: prevRows[0]?.batch_date ?? null,
        error: gsError || undefined,
        warnings: aggregateWarnings(warnParts),
      });
    } catch (e) {
      return Response.json({
        ok: false,
        error: String(e),
        batch_date: today,
        warnings: aggregateWarnings(warnParts),
      }, { status: 500 });
    }
  });
}
