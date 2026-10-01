/// <reference lib="deno.ns" />
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
import {
  type Bar,
  computeSectorRows,
  type EtfSnap,
  type SectorInput,
  type SectorRow,
} from "./engine.ts";
import {
  fetchHistoryKline,
  type FetchPage,
  fetchRecentKline,
  sleep,
  toSymbol,
} from "./tencent.ts";
import { type EtfSnapRow, fetchSegments } from "./gs_etf.ts";

// —— 常量 ——
export const BARS_FULL = 250; // spec §5 标签门槛 = C3 accumulating 分界
const DEPTH_LMT = 640; // spec S2：腾讯单次最多 640 根（历史不足时先深拉一次）
const TAIL_KEEP = 300; // 引擎窗口上限（pos52 需 250 根，留余量）
const READ_WINDOW_DAYS = 450; // DB 尾读日历日窗口（≈290 交易日 > 250）
const KLINE_PACING_MS = 300; // spec §3.2
const UPSERT_CHUNK = 1000; // 与 stock-score/upsert 同粒度
const KLINE_FLUSH_EVERY = 20; // 每 20 只代表 ETF 冲刷一次 sector_kline（防 wall-clock 截断丢整轮深拉成果）
const BACKFILL_START = "2019-01-01"; // Task 3b T3b-1：历史翻页起点（spec §2.1/S2；评审 I-2，pos52/未来 label_stats 需多年历史）
// 注：MIN_ROWS 快照守卫单一定义在 gs_etf.fetchSegments（编排层不重复声明，避免 bundle 重名）

// —— 类型 ——
export interface MapRow {
  etf_code: string;
  etf_name: string;
  canonical_ind: string;
  amt: number | null;
  is_rep: boolean;
}

// sector_rotation_daily 的 24 列（scripts/migrate_sector_rotation.sql 实列名；表无 bars_n 列 ⇒ barsN 不落库）
export interface DailyRow {
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
export function themeOf(ind: string): string | null {
  return THEME_MAP[ind] ?? null;
}

// 字典中在本轮宇宙里找不到对应行业的键（C1 纪律：只报警、不落库、不新建行业）
export function unmatchedThemeKeys(inds: string[]): string[] {
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
export function toDbRow(
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
export function splitByBarsN(
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
export function rankLists(
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
export function shapeStaleRow(prev: DailyRow, batchDate: string): DailyRow {
  return {
    ...prev,
    batch_date: batchDate,
    labels: [...(prev.labels ?? [])],
    stale: true,
  };
}

// C1/C2/C5 的降级信息统一聚合：展平 + 去重 + 保序 + 溢出折叠成一条
export function aggregateWarnings(
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
export function isQResurrected(
  prevRows: { q: number | null }[],
  qAlive: boolean,
): boolean {
  if (!qAlive) return false;
  return prevRows.every((r) => r.q === null || r.q === undefined);
}

// C1 宇宙 × 当日截面 × K线尾 × prevMp → 引擎入参；行业无任何截面 ETF → 记入 noSnap（编排层走 stale）
export function assembleInputs(
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
export function klineOneQuery(
  code: string,
  cutoff: string,
  limit: number,
): string | null {
  if (!SAFE_CODE.test(code)) return null;
  return `sector_kline?select=trade_date,close,volume&etf_code=eq.${code}&trade_date=gte.${cutoff}&order=trade_date.desc&limit=${limit}`;
}

// 分批冲刷判定（纯函数）：i 为 1-based 已处理只数
export function shouldFlush(i: number, total: number, every: number): boolean {
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
export interface BackfillStats {
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
          // 与 before 同口径读【已落库批次】的 pos52-null 计数：
          //  整轮 GS 失败/computed 为空时，刷新轮不写库 ⇒ after 应如实等于 before（未变），
          //  不能用内存 acc（那会把「本轮没算」误报成「accumulating 归零」）。
          accumulating_after: dailyAfter.latestAcc,
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
