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

// left-join in memory：pool 全代码 + 各自 updated_at（缺表行 = null）→ 最旧优先取 300。
// nullsfirst 语义：codes 在 mix 表中缺失者排最前（最优先补拉）。
// 注：为正确区分“缺失”与“已更新但较新”，此处读取 mix 表全量 updated_at（表 ≤ 池 ~1165 行，开销可忽略），
//     而非 limit 300 —— 一旦表行数 > 300，只读 300 会把“较新的已更新行”误判为“缺失”。见 task-5-report concerns。
async function pickStaleCodes(): Promise<string[]> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const poolResp = await fetch(`${url}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
  if (!poolResp.ok) throw new Error(`read stock_pool ${poolResp.status} ${await poolResp.text()}`);
  const pool = (await poolResp.json()) as { code: string }[];

  const mixResp = await fetch(`${url}/rest/v1/stock_business_mix?select=code,updated_at&order=updated_at.asc.nullsfirst`, { headers: svcHeaders() });
  if (!mixResp.ok) throw new Error(`read stock_business_mix ${mixResp.status} ${await mixResp.text()}`);
  const mix = (await mixResp.json()) as { code: string; updated_at: string | null }[];
  const updatedAt = new Map(mix.map(m => [m.code, m.updated_at]));

  return pool.map(p => ({ code: p.code, u: updatedAt.get(p.code) ?? null }))
    .sort((a, b) => {
      if (a.u === null && b.u === null) return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      if (a.u === null) return -1; // 缺失优先
      if (b.u === null) return 1;
      return a.u < b.u ? -1 : a.u > b.u ? 1 : (a.code < b.code ? -1 : 1); // 旧时间优先
    })
    .slice(0, BATCH)
    .map(r => r.code);
}

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
