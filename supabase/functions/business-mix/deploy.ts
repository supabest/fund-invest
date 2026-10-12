/// <reference lib="deno.ns" />
// mix.ts — 东财主营构成(zygcfx)纯解析：混合业务判定
// 规则权威：docs/superpowers/specs/2026-09-27-stock-scoring-v1.1-design.md §5.1
// 纯函数，无 IO；输入 = 东财 zygcfx 数组原样行（含 MAINOP_TYPE '1'/'2'/'3'，decide 内部只取 '1'）。
//
// 国标行业口径 = MAINOP_TYPE==='1'（'2'=产品、'3'=地区，必须忽略）。
// ratio = MBI_RATIO（0~1 小数）；name = ITEM_NAME；报告期 = REPORT_DATE。

/** 东财 zygcfx 单行（只声明本函数关心的字段，运行时其余字段忽略） */
interface ZygcfxRow {
  MAINOP_TYPE: string;   // '1' 按行业 / '2' 按产品 / '3' 按地区
  REPORT_DATE: string;   // 'YYYY-MM-DD 00:00:00'
  ITEM_NAME: string;     // 如 '化学原料和化学制品制造业C26'
  MBI_RATIO: number;     // 收入占比 0~1
}

interface MixSeg { name: string; ratio: number }

interface MixVerdict {
  reportDate: string;    // 实际采用的报告期 'YYYY-MM-DD'
  segments: MixSeg[];    // 该期 MAINOP_TYPE=1 全部行业，按 ratio 降序
  mixed: boolean;
  shift: boolean;
}

// 判据阈值（spec §5.1）
const TOP1_SINGLE = 0.70; // top1 ≥ 此值 → 单一主业
const TOP2_MIXED = 0.25;  // top1<0.70 且 top2≥此值 → 混合业务
const TOP2_SHIFT = 0.10;  // top1<0.70 且 top2∈[此值,0.25) → business_shift（仅记录，不进评分）

const datePart = (rd: string): string => rd.slice(0, 10);            // 'YYYY-MM-DD'
const mmdd = (rd: string): string => rd.slice(5, 10);                // 'MM-DD'
const isAnnual = (rd: string): boolean => mmdd(rd) === '12-31';      // 年报口径

/**
 * 判定主营结构。
 * @param rows  东财 zygcfx 原样数组（含各 MAINOP_TYPE，内部过滤 '1'）
 * @param today 'YYYY-MM-DD'，保留于接口（新鲜度按“有年报优先取最新年报”，无需 today）
 * @returns MixVerdict | null（无 MAINOP_TYPE=1 行 / 空输入 → null，调用方跳过该股）
 */
function decide(rows: ZygcfxRow[], today: string): MixVerdict | null {
  void today; // 新鲜度规则不依赖 today（优先年报、否则退化为最新中期），保留形参以贴合接口
  const ind = (rows ?? []).filter(r => r && r.MAINOP_TYPE === '1');
  if (ind.length === 0) return null;

  // 新鲜度：优先取“最新年报”（mm-dd='12-31' 的最大日期）；无年报则退化为最新中期
  const dates = [...new Set(ind.map(r => datePart(r.REPORT_DATE)))];
  const annuals = dates.filter(isAnnual);
  const pool = annuals.length > 0 ? annuals : dates;
  const chosen = pool.reduce((a, b) => (a >= b ? a : b)); // 字典序 = 时间序

  const segments: MixSeg[] = ind
    .filter(r => datePart(r.REPORT_DATE) === chosen)
    .map(r => ({ name: r.ITEM_NAME, ratio: Number(r.MBI_RATIO) }))
    .filter(s => Number.isFinite(s.ratio))
    .sort((a, b) => b.ratio - a.ratio);
  if (segments.length === 0) return null;

  const top1 = segments[0].ratio;
  const top2 = segments.length >= 2 ? segments[1].ratio : 0;

  let mixed = false;
  let shift = false;
  if (top1 >= TOP1_SINGLE) {
    mixed = false; shift = false;               // 单一主业，正常池
  } else if (top2 >= TOP2_MIXED) {
    mixed = true; shift = true;                  // 混合业务（spec：flag mixed_business，confidence 至多 B）
  } else if (top2 >= TOP2_SHIFT) {
    mixed = false; shift = true;                 // 单一主业但次大 10~25%：记录结构迁移，不影响评分
  } else {
    mixed = false; shift = false;                // top1<0.70 且 top2<0.10
  }
  return { reportDate: chosen, segments, mixed, shift };
}



// business-mix —— 东财主营构成低频批函数（V1.1 C 层混合业务识别）
// 编排模式（认证 / svcHeaders / upsert / 脱敏）与 stock-score/index.ts 完全一致。
// 数据源：东财 F10 PC_HSF10/BusinessAnalysis/PageAjax（zygcfx，半年才变，低频）。
// 表：stock_business_mix(code PK, report_date, segments JSONB, mixed, shift, updated_at)。

const EM_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax';
const BATCH = 300;        // 每晚处理 300 只（全池 ~1165，四晚轮转）
const CONCURRENCY = 4;    // 并发 4
const STAGGER_MS = 150;   // 每请求间隔 150ms（东财限速）
const RETRY_BACKOFF_MS = 2000; // 失败重试 1 次的退避
const FETCH_TIMEOUT_MS = 15000;

// service 角色 headers：与 stock-score/index.ts svcHeaders 一致（apikey + Bearer serviceKey + Content-Type）
function svcHeaders(): Record<string, string> {
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

// upsert：Prefer merge-duplicates + return minimal，单请求（chunk = BATCH = 300）
async function upsert(rows: Record<string, unknown>[], table: string, onConflict: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// 市场前缀：6→SH，0/3→SZ，4/8/9→BJ；其余（未知板块）返回 ''，调用方跳过
function marketPrefix(code6: string): string {
  const c = code6[0];
  if (c === '6') return 'SH';
  if (c === '0' || c === '3') return 'SZ';
  if (c === '4' || c === '8' || c === '9') return 'BJ';
  return '';
}

// 拉单只 zygcfx 原样行数组；1 次重试（2s 退避）后仍失败则 throw（上层计入 skipped）。
// 脱敏：错误信息只含状态码/代码，绝不落完整 URL（东财 URL 无密钥，但守 house style）。
async function fetchZygcfx(code6: string): Promise<ZygcfxRow[]> {
  const prefix = marketPrefix(code6);
  if (!prefix) throw new Error(`unknown market for ${code6}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${EM_BASE}?code=${prefix}${code6}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://emweb.securities.eastmoney.com/' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`em http ${r.status} (${code6})`);
      const j = await r.json();
      const rows = (j as Record<string, unknown>).zygcfx;
      // 非数组 / 缺字段 → 视为空（decide 返回 null → skip），不当作失败
      return Array.isArray(rows) ? rows as ZygcfxRow[] : [];
    } catch (e) {
      // 网络错误 message 可能内嵌完整 URL，脱敏为不含 URL 的通用信息
      lastErr = e instanceof TypeError ? new Error(`em network error (${code6})`) : e;
      if (attempt === 0) await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastErr;
}

// ---- offset 分页读（2026-10-12 用户裁定「三条腿一并修」：与价值腿/主分腿同型的静默截断）----
// 缺陷不在本腿源码里发现，是价值腿重跑后直查出来的：PostgREST `db-max-rows` 默认 1000，裸 `?select=code`
// 单页 GET 返 **HTTP 206 + `Content-Range: 0-999/1165`** —— 不报错、不炸批，静默截断。
// 后果：池 1165 只 > 1000 ⇒ 每晚只看到按 code 升序的前 1000 只，第 1001 只往后的池成员
// **永远进不了「最旧优先补拉 300 只」的候选集**——不是慢，是静默饿死。而 stock_business_mix 今晚 972 行、
// business-mix 每晚补 300 ⇒ 第二处裸读明夜越线。实测另一形态：offset 越过总数返 **416 PGRST103**
// 而不是空数组 ⇒ 收尾条件只能是「已收 >= 总数」，不得靠「拿到空页/不够一页」退出。
// 五条守卫任一不齐就抛错炸批：宁可今晚不跑，也不能拿一个少 165 只的池明天继续。
// 与价值腿逐字对齐的**复制体**而非共享模块：每个 edge 函数各自打包成独立 deploy.ts，跨函数 import 会破坏 bundle。
type PageGet = (u: string, init: RequestInit) => Promise<{
  ok: boolean; status: number;
  headers: { get(k: string): string | null };
  json(): Promise<unknown>;
}>;

async function readAllRows(
  base: string, resource: string, params: string,
  get: PageGet = fetch as unknown as PageGet, pageSize = 1000,
): Promise<Record<string, unknown>[]> {
  // offset 分页只有在确定性排序下才不重不漏（平台默认行序会随真空页/簇迁移漂移）
  if (!/(^|&)order=/i.test(params)) throw new Error(`read ${resource}: offset 分页要求确定性 order=`);
  const out: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let from = 0; ;) {
    const r = await get(`${base}/rest/v1/${resource}?${params}&limit=${pageSize}&offset=${from}`,
      { headers: { ...svcHeaders(), 'Prefer': 'count=exact' } });
    if (!r.ok) throw new Error(`read ${resource} page@${from}: ${r.status}`);
    const m = /^(\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
    if (!m) throw new Error(`read ${resource} page@${from}: Content-Range 拿不到总数（count=exact 未生效）`);
    const [start, end, count] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (total === null) total = count;
    else if (count !== total) throw new Error(`read ${resource}: 总数中途变化 ${total} -> ${count}`);
    if (start !== from) throw new Error(`read ${resource}: 页起点 ${start} != 请求 offset ${from}`);
    const page = (await r.json()) as Record<string, unknown>[];
    // 声明的区间长度与实际行数必须一致：逐页自证，不等收尾才发现页被吃了。
    // 有了 `start === from` + 这一条，各页严格铺满 [0, total-1]，所以不必再写「总行数 == total」的收尾守卫（恒真，属死代码）
    if (end - start + 1 !== page.length) throw new Error(`read ${resource} page@${from}: 声明 ${end - start + 1} 行（总数 ${total}）实得 ${page.length} 行`);
    if (page.length === 0) throw new Error(`read ${resource}: page@${from} 空页而总数 ${total} 未到`);   // 进度守卫：按上面两条推导本不可达，但一旦有人改松了守卫，这里必须是报错而不是死循环吊死整个函数
    out.push(...page);
    from += page.length;                                  // 推进量=实收，平台把 db-max-rows 调得比 pageSize 小时也不会静默少收
    if (from >= total) break;
  }
  return out;
}

// 池成员（候选集的唯一真值源）：去重后的 Set 行数必须等于收回行数——Set 会静默吞掉重复 code，
// 只能在这里拿两个数把它拉回来。导出可测：变异检验靠它验证「只读第一页」的写法不能溜过。
async function readPoolSet(base: string, get?: PageGet, pageSize?: number): Promise<Set<string>> {
  const rows = await readAllRows(base, 'stock_pool', 'select=code&order=code.asc', get, pageSize);
  const set = new Set(rows.map(x => String(x.code)));
  if (set.size !== rows.length) throw new Error(`read stock_pool: 去重后 ${set.size} != 收回 ${rows.length}（池内有重复 code）`);
  return set;
}

// left-join in memory：pool 全代码 + 各自 updated_at（缺表行 = null）→ 最旧优先取 300。
// nullsfirst 语义：codes 在 mix 表中缺失者排最前（最优先补拉）。
// 注：为正确区分“缺失”与“已更新但较新”，此处读取 mix 表全量 updated_at（表 ≤ 池 ~1165 行，开销可忽略），
//     而非 limit 300 —— 一旦表行数 > 300，只读 300 会把“较新的已更新行”误判为“缺失”。见 task-5-report concerns。
//     「读全量」这个判断从一开始就是对的，错的是读法：全量必须靠分页拿，裸读拿到的只是前 1000 行。
// 导出 + 注入 get 仅为可测（分页接线与排序优先级必须在不起服务器的情况下验）。
async function pickStaleCodes(
  url: string = Deno.env.get('SUPABASE_URL')!,
  get: PageGet = fetch as unknown as PageGet,
): Promise<string[]> {
  const pool = [...await readPoolSet(url, get)];

  // 这里只需要 code -> updated_at 的映射，与行序无关，所以 SQL order 用 code.asc 提供确定性即可；
  // 「nullsfirst + 旧→新」由下面的内存排序负责（原 `order=updated_at.asc.nullsfirst` 在 updated_at 并列时
  // 行序不定，跨页反而会漂移）
  // readAllRows 只交回 Record<string, unknown>[]（通用分页读不认得业务列），所以把形状写明；
  // 直接 `as {code:string;updated_at:string}[]` 会被 TS2352 拒（与价值腿 readMainSnapshot 的 MainCol 同款教训）
  type MixAtCol = { code: string; updated_at: string | null };
  const mix = (await readAllRows(url, 'stock_business_mix', 'select=code,updated_at&order=code.asc', get)) as MixAtCol[];
  const updatedAt = new Map(mix.map(m => [m.code, m.updated_at]));

  return pool.map(code => ({ code, u: updatedAt.get(code) ?? null }))
    .sort((a, b) => {
      if (a.u === null && b.u === null) return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      if (a.u === null) return -1; // 缺失优先
      if (b.u === null) return 1;
      return a.u < b.u ? -1 : a.u > b.u ? 1 : (a.code < b.code ? -1 : 1); // 旧时间优先
    })
    .slice(0, BATCH)
    .map(r => r.code);
}

// 守卫仅针对单测场景（index_test.ts 先设 BUSINESS_MIX_DISABLE_SERVE 再动态 import；静态 import 会被
// 提到 Deno.env.set 之前执行，import 即绑 8000 端口，整套测试以 uncaught error 倒下）。
// 线上 Edge 不会注入该变量，Deno.serve 注册行为不变。
if (!Deno.env.get('BUSINESS_MIX_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const u = new URL(req.url); const mode = u.searchParams.get('mode') || 'run';
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (mode === 'ping') {
      // 连通性探针：拉 1 只（SH600519），返回列数
      const rows = await fetchZygcfx('600519');
      const cols = rows.length > 0 ? Object.keys(rows[0]).length : 0;
      return Response.json({ ok: true, cols });
    }

    const codes = await pickStaleCodes();
    const nowIso = new Date().toISOString();
    const outRows: Record<string, unknown>[] = [];
    let mixedCount = 0, shiftCount = 0, skipped = 0;

    // 并发 CONCURRENCY、每请求间隔 STAGGER_MS；单只失败/无数据 → 跳过并计数，绝不中断批
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= codes.length) break;
        await sleep(STAGGER_MS);
        const code = codes[i];
        try {
          const v = decide(await fetchZygcfx(code), today);
          if (!v) { skipped++; continue; }
          outRows.push({ code, report_date: v.reportDate, segments: v.segments, mixed: v.mixed, shift: v.shift, updated_at: nowIso });
          if (v.mixed) mixedCount++;
          if (v.shift) shiftCount++;
        } catch {
          skipped++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker));

    if (outRows.length > 0) await upsert(outRows, 'stock_business_mix', 'code');
    return Response.json({ ok: true, processed: outRows.length, mixed: mixedCount, shift: shiftCount, skipped });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
}
