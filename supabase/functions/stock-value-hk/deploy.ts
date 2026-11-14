/// <reference lib="deno.ns" />
// hk_engine.ts — 港股降维口径的纯函数。规则权威：spec §3（口径）/§3.1（空值语义）/§3.3（股息不记 0）
// 与 A 股 value_engine.ts 完全隔离（spec §5.2）：roicStats3 是 roicStats 的复制体，不 import、不抽公共模块。
const HK_ROIC_GATE = 8;   // % WACC 锚，与 A 股 ROIC_GATE 同值同理由（2026-10-30 裁定维持 8）；测试三处钉住

type HkRaw = {
  code: string;                    // 5 位补零（00700 / 09988），与持仓/前端同形
  name: string;
  roic3: (number | null)[];        // [Y-2, Y-1, Y] 三年年报 ROIC，顺序由适配器锤死
  divYield: number | null;
  divY5y: number | null;
  pe: number | null;
  pb: number | null;
};

type HkRow = HkRaw & {
  roicCur: number | null;
  roicMed: number | null;
  roicMin3: number | null;
  roicOk: boolean | null;          // 三态：med=null ⇒ null，不是 false
  missing: string[];               // 缺值字段名，落 extras.missing
};

// 与 A 股 value_engine.ts:29 roicStats 同语义的复制体：≥2 期有效才算，med 与 min3 同生同死。
function roicStats3(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

// PE/PB ≤0 一律 null（spec §3.1）。PB≤0 **不推断资不抵债**——那是 A 股否决1 的结论，本设计不产结论。
const pos = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

function computeHk(r: HkRaw): HkRow {
  const { med, min3 } = roicStats3(r.roic3);
  const cur = r.roic3.length > 0 ? r.roic3[r.roic3.length - 1] : null;
  const pe = pos(r.pe), pb = pos(r.pb);
  const missing: string[] = [];
  if (cur === null) missing.push('roic_cur');
  if (med === null) missing.push('roic_med');
  if (r.divYield === null) missing.push('div_yield');
  if (r.divY5y === null) missing.push('div_yield_5y');
  if (pe === null) missing.push('pe');
  if (pb === null) missing.push('pb');
  return {
    code: r.code, name: r.name, roic3: r.roic3,
    divYield: r.divYield, divY5y: r.divY5y, pe, pb,
    roicCur: cur, roicMed: med, roicMin3: min3,
    // 达标只看 med：cur 与 med 相互独立（spec §3；阿里 cur 10.80 达标而 med 6.91 未达标）
    roicOk: med === null ? null : med >= HK_ROIC_GATE,
    missing,
  };
}

// gs_hk.ts — GS 港股列式宽表 → HkRaw[]。规则权威：spec §2.1（三条生产查询串）/§2.5（列名契约与三条形态陷阱）/§5.1（守卫）
// 与 A 股 gs_value.ts 完全隔离（spec §5.2）：四个匹配器是复制体，不 import、不修改共享代码。


type GsHkTable = Record<string, (string | number | null)[]>;

function hkYearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// 措辞是实测锁定的契约，不是可自由改写的自然语言：显式「年报」回 3 列，裸问「投入资本回报率」回 7 列（H-2）。
const buildHkQ1 = (b: number): string =>
  `全部港股的${b - 2}年报投入资本回报率、${b - 1}年报投入资本回报率、${b}年报投入资本回报率、股票简称`;
const HK_Q2 = '全部港股的股息率、近5年股息率平均值、股票简称';
const HK_Q3 = '全部港股的市盈率、市净率、股票简称';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

async function gsHkFetch(query: string, apiKey: string, timeoutMs = 150_000): Promise<GsHkTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'HK_stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz code=${j?.result?.[0]?.code}`);   // 不带 msg 原文
      const t = j?.data?.[0]?.table as GsHkTable | undefined;
      if (!t?.['股票代码']) throw new Error('GS table missing');
      return t;
    } catch (e) {
      // TypeError.message 含完整 URL（带 apiKey）→ 折叠（同 A 股 gsValueFetch 先例）
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// H-6：财务/估值列一律 `港股@` 前缀，而 `股票简称`/`股票代码` 不带 ⇒ 有则剥、无则原样。
// 剥一次让四个匹配器原样复用 A 股规则；教匹配器认前缀会改到共享代码（spec §5.2 禁止）。
function stripHkPrefix(t: GsHkTable): GsHkTable {
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) {
    const bare = k.replace(/^港股@/, '');
    // 剥完撞名 = 两列被静默合并成一列（`港股@股票简称` 与 `股票简称` 并存时）⇒ 宁拒绝不错位
    if (Object.prototype.hasOwnProperty.call(out, bare)) throw new Error(`GS hk column collision after prefix strip: ${bare}`);
    out[bare] = t[k];
  }
  return out;
}

// GS 已去前导零（`0700.HK` / `9988.HK`）⇒ 补零到 5 位与持仓/前端同形。非港股形态一律 null，不猜。
function hkCodeOf(raw: string | number | null | undefined): string | null {
  const m = /^(\d{1,5})(?:\.HK)?$/i.exec(String(raw ?? '').trim());
  return m ? m[1].padStart(5, '0') : null;
}

const labelOf = (k: string): string => k.replace(/\[.*$/, '');
const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';          // 单期戳（A 股复制体）
const rangeOf = (key: string): string => key.match(/\[(\d{8}-\d{8})\]/)?.[1] ?? '';   // 区间戳原样（5 年平均列）

// 全等标签优先 → 前缀（拒中文后缀兄弟列）→ 标签最短 → 列名字典序。决定性，绝不返回「响应里第一个」。
// §2.5 陷阱 1：港股 `股息率(股票获利率)` 与 `…平均` 都能过中文后缀规则，胜负押在「标签最短」这一档。
function colByPrefix(t: GsHkTable, prefix: string): string | undefined {
  const keys = Object.keys(t);
  const exact = keys.find(k => labelOf(k) === prefix);
  if (exact) return exact;
  return keys
    .filter(k => labelOf(k).startsWith(prefix) && !/^[\u4e00-\u9fff]/.test(labelOf(k).slice(prefix.length)))
    .sort((a, b) => labelOf(a).length - labelOf(b).length || (a < b ? -1 : 1))[0];
}

function windowCols(t: GsHkTable, name: string): string[] {
  return Object.keys(t).filter(k => {
    const l = labelOf(k);
    if (!l.startsWith(name)) return false;
    const rest = l.slice(name.length);
    if (rest.length > 0 && /^[\u4e00-\u9fff]/.test(rest)) return false;
    return /\[\d{8}/.test(k.slice(l.length));
  }).sort();
}

function annualCols(t: GsHkTable, labelPrefix: string, requireAnnualOnly = false): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length))
        && (!requireAnnualOnly || stampOf(k).endsWith('1231'));
    })
    .sort((a, b) => {
      if (stampOf(a) !== stampOf(b)) return stampOf(a) < stampOf(b) ? -1 : 1;
      return labelOf(a) < labelOf(b) ? -1 : labelOf(a) > labelOf(b) ? 1 : 0;
    });
}

// §2.5 陷阱 2：5 年平均列的戳是区间 `[a-b]`，annualCols 的 /^\[\d{8}\]$/ 天然拒它 ⇒ 必须另写匹配器，
// 不能靠 annualCols 取「最后一根」当 5 年平均。
function intervalAvgCols(t: GsHkTable, labelPrefix: string): string[] {
  return Object.keys(t).filter(k => {
    const l = labelOf(k);
    return l.startsWith(labelPrefix) && l.includes('平均') && /^\[\d{8}-\d{8}\]$/.test(k.slice(l.length));
  }).sort();
}

const num = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;   // 文本列 / 带百分号列一律 null
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

type HkBatch = 'q1' | 'q2' | 'q3';
const REQUIRED: Record<HkBatch, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率'],
  q2: ['股票代码'],
  q3: ['股票代码', '市盈率', '市净率'],
};
function assertHkCols(t: GsHkTable, fam: HkBatch): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS hk ${fam} missing column: ${name}`);
  // q2 的「当期股息率整列缺失」不能靠 colByPrefix 守：港股标签是 `股息率(股票获利率)`，全等通道不命中，
  // 前缀通道对 `…平均` 兄弟列同样放行（§2.5 陷阱 1）⇒ 兄弟列能单独满足守卫、当期列整列缺失也静默跑完整夜。
  // 改用形态判据：必须存在一根年报戳的当期股息率列。
  if (fam === 'q2' && annualCols(t, '股息率', true).length === 0) throw new Error('GS hk q2 missing column: 股息率(年报当期列)');
}

function mergeHkTables(
  t1: GsHkTable, t2: GsHkTable, t3: GsHkTable, held: Set<string>, now: Date = new Date(),
): { rows: HkRaw[]; stamps: Record<string, string>; years: string[] } {
  const a = stripHkPrefix(t1), b = stripHkPrefix(t2), c = stripHkPrefix(t3);
  assertHkCols(a, 'q1'); assertHkCols(b, 'q2'); assertHkCols(c, 'q3');
  for (const [fam, t] of [['q1', a], ['q2', b], ['q3', c]] as const) {
    if ((t['股票代码']?.length ?? 0) === 0) throw new Error(`GS hk ${fam} returned 0 rows`);
  }
  const base = hkYearAnchors(now).annualBase;
  const wantYears = [base - 2, base - 1, base];
  const roicKeys = windowCols(a, '投入资本回报率');
  // H-2：措辞正确时必为 3 根；变 7 说明措辞被改写成裸问法 ⇒ 不为港股放宽这条守卫
  if (roicKeys.length !== 3) throw new Error(`GS hk q1 expected exactly 3 window columns, got ${roicKeys.length}`);
  const gotYears = roicKeys.map(k => stampOf(k).slice(0, 4)).join(',');
  if (roicKeys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears.join(','))
    throw new Error(`GS hk q1 expected 3 annual columns (${wantYears.join(',')}@1231), got ${roicKeys.map(stampOf).join(',')}`);

  // 股息当期：年报列按戳升序取最后一根（与 A 股 q5 dyCur 同规则）。**不硬绑 base 年**——
  // 1–4 月 base=前年而平台可能已回上一年年报，硬绑会让股息整腿静默变「无数据」四个月（spec §3）。
  const dyKeys = annualCols(b, '股息率', true);
  const dyCur = dyKeys.length > 0 ? dyKeys[dyKeys.length - 1] : null;
  const dy5Keys = intervalAvgCols(b, '股息率');
  if (dy5Keys.length > 1) throw new Error(`GS hk q2 expected at most 1 interval average column, got ${dy5Keys.length}`);
  const dy5Col = dy5Keys[0] ?? null;
  const peCol = colByPrefix(c, '市盈率')!, pbCol = colByPrefix(c, '市净率')!;

  const idx = (t: GsHkTable) => {
    const m = new Map<string, number>();
    (t['股票代码'] ?? []).forEach((raw, i) => {
      const code = hkCodeOf(raw);
      if (code !== null) m.set(code, i);
    });
    return m;
  };
  const i1 = idx(a), i2 = idx(b), i3 = idx(c);
  // 锚 = 持仓码在**任一**表里出现（H-7：宇宙行数随快照漂移，某码缺席是可能形态，不是整批失败）
  const anchor = [...held].filter(code => i1.has(code) || i2.has(code) || i3.has(code)).sort();
  if (anchor.length === 0) throw new Error(`GS hk: 持仓 ${held.size} 只零命中（代码形态或宇宙变了）`);

  const nk1 = colByPrefix(a, '股票简称'), nk2 = colByPrefix(b, '股票简称'), nk3 = colByPrefix(c, '股票简称');
  const at = (t: GsHkTable, k: string | null | undefined, i: number): number | null => (k && i >= 0 ? num(t[k]?.[i]) : null);
  const rows: HkRaw[] = anchor.map(code => {
    const j1 = i1.get(code) ?? -1, j2 = i2.get(code) ?? -1, j3 = i3.get(code) ?? -1;
    const name = str(nk1 ? a[nk1]?.[j1] : '') || str(nk2 ? b[nk2]?.[j2] : '') || str(nk3 ? c[nk3]?.[j3] : '');
    return {
      code, name,
      roic3: roicKeys.map(k => at(a, k, j1)),
      divYield: at(b, dyCur, j2), divY5y: at(b, dy5Col, j2),
      pe: at(c, peCol, j3), pb: at(c, pbCol, j3),
    };
  });
  // 时点纪律：每列各自的戳原样落库，不做跨戳比较、不做时点对齐（H-8：同批可能不同戳，无法对齐）
  const stamps: Record<string, string> = { roic: roicKeys.map(stampOf).join(',') };
  if (dyCur) stamps.div_cur = stampOf(dyCur);
  if (dy5Col) stamps.div_5y = rangeOf(dy5Col);
  stamps.pe = stampOf(peCol);
  stamps.pb = stampOf(pbCol);
  return { rows, stamps, years: wantYears.map(String) };
}


// stock-value-hk 编排层。规则权威：spec §5（编排）/§5.1（守卫）/§5.2（隔离）/§4（落库）



// 持仓是按用户存的 JSON（dingtou_state.data.stocks），不是关系表 ⇒ 范式照 daily-update/index.ts:1563 heldStocksOf。
// 只收 5 位纯数字（港股）；6 位是 A 股，走原价值腿，本函数一律不碰。
function heldHkCodes(states: unknown[]): string[] {
  const out = new Set<string>();
  for (const u of states) {
    const arr = (u as { data?: { stocks?: unknown } })?.data?.stocks;
    if (!Array.isArray(arr)) continue;
    for (const x of arr as Array<{ code?: unknown }>) {
      const c = String(x?.code ?? '').trim();
      if (/^\d{5}$/.test(c)) out.add(c);
    }
  }
  return [...out].sort();
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

type StatesGet = (u: string, init: RequestInit) => Promise<{
  ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown>;
}>;

// 单页 + Content-Range 自证，**不写分页循环**：dingtou_state 一行一个用户，本工具是个人持仓，
// 行数远不到 db-max-rows=1000。真超过 1000 时这里的守卫会炸批而不是静默漏掉一部分用户的持仓
// （A 股 readAllRows 的 1000 行静默截断事故是同型缺陷，宁可显式失败）。
async function readStates(base: string, get: StatesGet = fetch as unknown as StatesGet): Promise<unknown[]> {
  const r = await get(`${base}/rest/v1/dingtou_state?select=user_id,data&order=user_id.asc&limit=1000`,
    { headers: { ...svcHeaders(), 'Prefer': 'count=exact' } });
  if (!r.ok) throw new Error(`read dingtou_state: ${r.status}`);
  const m = /^(\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
  if (!m) throw new Error('read dingtou_state: Content-Range 拿不到总数（count=exact 未生效）');
  const rows = (await r.json()) as unknown[];
  const total = Number(m[3]);
  if (rows.length !== total) throw new Error(`read dingtou_state: 单页被截断（实得 ${rows.length} / 总数 ${total}）⇒ 持仓集合不完整，拒绝跑批`);
  return rows;
}

// 落库映射抽成导出纯函数（同 A 股 buildDbRows 的教训）：extras 的接线若留在 handler 里，
// 「stamps/years 永远空」这种错误就没有任何测试能发现。
function toHkDbRow(
  r: HkRow, batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  return {
    batch_date: batch, code: r.code, name: r.name,
    roic_cur: r.roicCur, roic_med: r.roicMed, roic_min3: r.roicMin3,
    div_yield: r.divYield, div_yield_5y: r.divY5y,
    pe: r.pe, pb: r.pb, roic_ok: r.roicOk,
    extras: { stamps, years, missing: r.missing },
  };
}

function buildHkDbRows(
  rows: HkRow[], batch: string, stamps: Record<string, string>, years: string[],
): Record<string, unknown>[] {
  return rows.map(r => toHkDbRow(r, batch, stamps, years));
}

type PostFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// 持仓港股是个位数行 ⇒ 一次 POST，**不写分块循环**（A 股 5224 行才需要）。
// onSent 先报告再查状态：PostgREST 可能已收下但返回非 2xx，此时旧批已被覆盖，catch 里不能再称「保留」。
async function upsertHk(rows: Record<string, unknown>[], onSent?: () => void, post: PostFn = fetch): Promise<void> {
  if (rows.length === 0) return;
  const url = Deno.env.get('SUPABASE_URL')!;
  const r = await post(`${url}/rest/v1/stock_value_hk?on_conflict=batch_date,code`, {
    method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  onSent?.();
  if (!r.ok) throw new Error(`upsert stock_value_hk ${r.status} ${await r.text()}`);
}

// 遥测：missing_codes 是「持仓非空但某码零命中」的唯一可见出口（REIT 不在宇宙内、宇宙快照漂移）。
// 不报数就永远是静默缺陷——页面只会显示「本批次无该股数据」，与「港股本来就不在范围内」外观一致。
function runHkSummary(
  rows: HkRow[], batch: string, held: string[], stamps: Record<string, string>, years: string[],
): Record<string, unknown> {
  const got = new Set(rows.map(r => r.code));
  return {
    ok: true, batch_date: batch, rows: rows.length, held_hk: held.length,
    roic_ok: rows.filter(r => r.roicOk === true).length,
    roic_fail: rows.filter(r => r.roicOk === false).length,
    roic_na: rows.filter(r => r.roicOk === null).length,
    missing_codes: held.filter(c => !got.has(c)),
    stamps, years,
  };
}

function errorHkBody(msg: string, wrote: boolean): Record<string, unknown> {
  return { ok: false, error: msg, kept_old_batch: !wrote };
}

if (!Deno.env.get('STOCK_VALUE_HK_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const url = Deno.env.get('SUPABASE_URL')!;
  // wrote 必须声明在 try 外面：try 内的 let 对 catch 不可见
  let wrote = false;
  try {
    const held = heldHkCodes(await readStates(url));
    // spec §5 第2步：空集 ⇒ 不发 GS 调用、不写表
    if (held.length === 0) return Response.json({ ok: true, skipped: 'no hk holdings' });
    const now = new Date();
    const { annualBase } = hkYearAnchors(now);
    const [t1, t2, t3] = await Promise.all([
      gsHkFetch(buildHkQ1(annualBase), key), gsHkFetch(HK_Q2, key), gsHkFetch(HK_Q3, key),
    ]);
    const { rows, stamps, years } = mergeHkTables(t1, t2, t3, new Set(held), now);
    const computed = rows.map(computeHk);
    const batch = now.toISOString().slice(0, 10);
    await upsertHk(buildHkDbRows(computed, batch, stamps, years), () => { wrote = true; });
    return Response.json(runHkSummary(computed, batch, held, stamps, years));
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsHkFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json(errorHkBody(msg, wrote), { status: 500 });
  }
});
}
