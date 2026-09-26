/// <reference lib="deno.ns" />
// stock-score 评分引擎（纯函数，无 IO）——规则权威：docs/superpowers/specs/2026-09-26-stock-scoring-v1-design.md §2/§4
// 权重固定 Q30/G30/V20/M20；因子内 Q=ROE50/毛利率50, G=扣非35/归母15/营收50, V=PE50/PEG50, M=行业相对50/绝对趋势50
// 组内百分位：P1/P99 截尾(winsorize) 后 (低于数+0.5×并列数)/N×100；逆序指标取 100-pct

interface Stock {
  code: string; name: string; ths: string[];
  roe: number | null; mlr: number | null; kc: number | null; gm: number | null;
  rev: number | null; debt: number | null; pe: number | null;
  isFin: boolean; isST: boolean;
  r60: number | null; close: number | null; a20: number | null; a60: number | null;
}

interface ScoreRow extends Stock {
  quality: number | null; growth: number | null; value: number | null; momentum: number | null;
  final: number | null; indRank: number; indN: number; marketRank: number; marketN: number;
  cov: number; peg: number | null; flags: string[];
  grp: string;      // 'L2:汽车-汽车零部件' | 'L1:传媒' | 'MARKET'（Task 4 经 extras 消费）
  absTrend: number; // 满足数/已知数×100：三条件全知时为 0/33.3/66.7/100，部分缺数据时可为 k/已知数 的中间值（如 50、66.7 两条件情形）；-1 = 三条件全缺未参与（Task 4 经 extras 消费）
}

// 行业回退：同花顺二级样本≥20 → 一级≥20 → 全市场(MARKET)
function assignGroups(stocks: Stock[]): Map<string, string> {
  const l2 = new Map<string, number>(); const l1 = new Map<string, number>();
  for (const s of stocks) {
    if (s.ths.length >= 2) l2.set(`${s.ths[0]}-${s.ths[1]}`, (l2.get(`${s.ths[0]}-${s.ths[1]}`) ?? 0) + 1);
    if (s.ths.length >= 1) l1.set(s.ths[0], (l1.get(s.ths[0]) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of stocks) {
    const k2 = s.ths.length >= 2 ? `${s.ths[0]}-${s.ths[1]}` : '';
    const k1 = s.ths.length >= 1 ? s.ths[0] : '';
    if (k2 && (l2.get(k2) ?? 0) >= 20) out.set(s.code, `L2:${k2}`);
    else if (k1 && (l1.get(k1) ?? 0) >= 20) out.set(s.code, `L1:${k1}`);
    else out.set(s.code, 'MARKET');
  }
  return out;
}

interface PctEntry { code: string; grp: string; v: number }

// 在给定分组归属下计算组内 winsorize 百分位；组内有效样本 <5 → 该组不产生分数。
// 单一入口同时服务原始指标与派生指标（如 PEG），保证组归属始终按全宇宙统计一次。
function pctFromEntries(entries: PctEntry[], reverse: boolean): Map<string, number> {
  const byG = new Map<string, PctEntry[]>();
  for (const e of entries) {
    const arr = byG.get(e.grp);
    if (arr) arr.push(e); else byG.set(e.grp, [e]);
  }
  const out = new Map<string, number>();
  for (const [, members] of byG) {
    if (members.length < 5) continue;
    const nums = members.map(m => m.v).sort((a, b) => a - b);
    const p1 = nums[Math.floor(nums.length * 0.01)];
    const p99 = nums[Math.min(nums.length - 1, Math.floor(nums.length * 0.99))];
    const sv = nums.map(v => Math.min(Math.max(v, p1), p99)).sort((a, b) => a - b);
    for (const m of members) {
      const v = Math.min(Math.max(m.v, p1), p99);
      const lo = sv.filter(x => x < v).length;
      const eq = sv.filter(x => x === v).length;
      const pct = (lo + 0.5 * eq) / sv.length * 100;
      out.set(m.code, reverse ? 100 - pct : pct);
    }
  }
  return out;
}

function pctWithinGroups(stocks: Stock[], get: (s: Stock) => number | null, reverse = false): Map<string, number> {
  const groups = assignGroups(stocks);
  const entries: PctEntry[] = [];
  for (const s of stocks) {
    const v = get(s);
    if (v !== null && Number.isFinite(v)) entries.push({ code: s.code, grp: groups.get(s.code)!, v });
  }
  return pctFromEntries(entries, reverse);
}

const WEIGHTS = { quality: 30, growth: 30, value: 20, momentum: 20 };

// NA 重归一：有效腿按各自权重重分配；返回 [得分, 有效权重覆盖之和]
function renorm(pairs: [number | null, number][]): [number | null, number] {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, wt]) => a + wt, 0);
  if (tot === 0) return [null, 0];
  if (valid.length === 1) return [valid[0][0], valid[0][1]]; // 单腿恒等，避免浮点往返误差
  return [valid.reduce((a, [v, wt]) => a + v * wt, 0) / tot, tot];
}

// PEG 有效判据（spec 决策6）：PE∈(0,200] 且 扣非增速∈[10,300]
function pegOf(s: Stock): number | null {
  return s.pe !== null && s.pe > 0 && s.pe <= 200 && s.kc !== null && s.kc >= 10 && s.kc <= 300
    ? s.pe / s.kc : null;
}

function computeScores(all: Stock[]): ScoreRow[] {
  const stocks = all.filter(s => !s.isST); // 唯一硬过滤 = 剔除 ST
  const groups = assignGroups(stocks);
  const gOf = (s: Stock) => groups.get(s.code)!;

  // 所有百分位均在“全宇宙分好的组”内算；派生指标只改取值不改分组
  const entries = (get: (s: Stock) => number | null): PctEntry[] => {
    const out: PctEntry[] = [];
    for (const s of stocks) {
      const v = get(s);
      if (v !== null && Number.isFinite(v)) out.push({ code: s.code, grp: gOf(s), v });
    }
    return out;
  };
  const pct = {
    roe: pctFromEntries(entries(s => s.roe), false),
    mlr: pctFromEntries(entries(s => (s.isFin ? null : s.mlr)), false), // 决策8：金融股毛利率视为 NA
    kc: pctFromEntries(entries(s => s.kc), false),
    gm: pctFromEntries(entries(s => s.gm), false),
    rev: pctFromEntries(entries(s => s.rev), false),
    r60: pctFromEntries(entries(s => s.r60), false),
    pma20: pctFromEntries(entries(s => (s.close !== null && s.a20 !== null && s.a20 !== 0 ? s.close / s.a20 : null)), false),
    peInv: pctFromEntries(entries(s => (s.pe !== null && s.pe > 0 ? s.pe : null)), true), // 亏损 PE≤0 → 经济无效 → NA
    pegInv: pctFromEntries(entries(pegOf), true),
  };
  const get = (m: Map<string, number>, s: Stock) => m.get(s.code) ?? null;

  const rows: ScoreRow[] = stocks.map(s => {
    const q = renorm([[get(pct.roe, s), 50], [get(pct.mlr, s), 50]])[0];
    const gr = renorm([[get(pct.kc, s), 35], [get(pct.gm, s), 15], [get(pct.rev, s), 50]])[0];
    const v = renorm([[get(pct.peInv, s), 50], [get(pct.pegInv, s), 50]])[0];
    const rel = renorm([[get(pct.r60, s), 50], [get(pct.pma20, s), 50]])[0];

    // 绝对趋势三条件（决策7）：满足数/已知数×100；缺数据条件退出重归一；全缺 → NA
    const conds: (number | null)[] = [
      s.close !== null && s.a20 !== null ? (s.close > s.a20 ? 1 : 0) : null,
      s.close !== null && s.a60 !== null ? (s.close > s.a60 ? 1 : 0) : null,
      s.a20 !== null && s.a60 !== null ? (s.a20 > s.a60 ? 1 : 0) : null,
    ];
    const known = conds.filter((c): c is number => c !== null);
    const absTrend = known.length === 0 ? -1 : known.reduce((a, b) => a + b, 0) / known.length * 100;
    const mo = renorm([[rel, 50], [absTrend === -1 ? null : absTrend, 50]])[0];

    const [fin, cov] = renorm([[q, WEIGHTS.quality], [gr, WEIGHTS.growth], [v, WEIGHTS.value], [mo, WEIGHTS.momentum]]);
    return {
      ...s, quality: q, growth: gr, value: v, momentum: mo,
      final: cov >= 40 ? fin : null, indRank: 0, indN: 0, marketRank: 0, marketN: 0,
      cov, peg: pegOf(s),
      flags: s.debt !== null && s.debt > 80 ? ['负债率>80%'] : [], // 风控只进 flags 不进分
      grp: gOf(s), absTrend,
    };
  });

  // 全市场排名 + 行业（组）排名：按 final 降序，未评分者不参与
  const byFinal = rows.filter(r => r.final !== null).sort((a, b) => b.final! - a.final!);
  byFinal.forEach((r, i) => { r.marketRank = i + 1; r.marketN = byFinal.length; });
  for (const r of byFinal) {
    const mate = byFinal.filter(x => x.grp === r.grp);
    r.indN = mate.length; r.indRank = mate.indexOf(r) + 1;
  }
  return rows;
}

// GS（国信智能选股）宽表解析适配器：把列式（column-oriented）返回的批量表
// 归一化为 engine.ts 的 Stock[]。GS 列名内嵌数据日期戳（如 [20260924] /
// [20260703-20260924]），日期会随快照漂移，因此所有列一律按前缀匹配，
// 窗口列按起始日字典序（=时间序）取第 0 个 / 最后一个，绝不硬编码日期。

type GsTable = Record<string, (string | number | null)[]>;

const Q_FIN = '全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、所属同花顺行业';
const Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}

// 同一指标的多个窗口列（列名内嵌 yyyyMMdd 起始日）按字典序 = 时间序升序：
// 最早起始日 = 长窗（60日），最晚起始日 = 短窗（20日）；单一列时首尾同为该列。
function sortedWindowCols(t: GsTable, prefix: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(prefix)).sort();
}

const num = (v: string | number | null | undefined): number | null => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);

const col = (t: GsTable, prefix: string, i: number) => {
  const k = colByPrefix(t, prefix);
  return k ? t[k]?.[i] ?? null : null;
};

// 按窗口前缀取第 idx 个窗口（0 = 最早起始日 = 长窗；idx 越界则回退到最后一个窗口）
const windowCol = (t: GsTable, prefix: string, i: number, idx: number): number | null => {
  const keys = sortedWindowCols(t, prefix);
  if (keys.length === 0) return null;
  const key = keys[Math.min(idx, keys.length - 1)];
  return num(t[key]?.[i]);
};
const lastWindowCol = (t: GsTable, prefix: string, i: number): number | null => {
  const keys = sortedWindowCols(t, prefix);
  if (keys.length === 0) return null;
  return num(t[keys[keys.length - 1]]?.[i]);
};

async function gsFetch(query: string, apiKey: string, timeoutMs = 90_000): Promise<GsTable> {
  const qs = new URLSearchParams({
    searchstring: query,
    searchtype: 'stock',
    softName: 'goldsun_skills',
    skillName: 'gs-smart-stock-picking',
    apiKey,
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz ${JSON.stringify(j?.result?.[0])}`);
      const table = j?.data?.[0]?.table as GsTable | undefined;
      if (!table?.['股票代码']) throw new Error('GS table missing');
      return table;
    } catch (e) {
      // 网络错误（fetch 本身失败的 TypeError）的 message 可能内嵌含 apiKey 的完整 URL，
      // 脱敏为不含 URL 的通用信息后再保留；3 次重试用尽由末尾 throw lastErr 抛出。
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function mergeTables(fin: GsTable, mom: GsTable): Stock[] {
  const codes = (fin['股票代码'] as string[] | undefined) ?? [];
  // 守卫：有数据行却缺失“股票市场类型”列时，下方 isST 判定会把全部股票静默标为 ST
  // （0 可用行且无报错）——在此 fail loudly，避免编排层拿到空宇宙。
  if (codes.length > 0 && !colByPrefix(fin, '股票市场类型')) {
    throw new Error('GS fin table missing 股票市场类型 column');
  }
  const momCodes = (mom['股票代码'] as string[] | undefined) ?? [];
  const momIdx = new Map(momCodes.map((c, i) => [c, i]));
  const thsK = colByPrefix(fin, '所属同花顺行业');
  const mktK = colByPrefix(fin, '股票市场类型');
  const out: Stock[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = str(col(fin, '股票简称', i));
    // 市场类型是 GS 的分层标签串（';' 分隔），缺 "全部A股(非ST)" / "(非金融)" 标记即视为该类
    const mkt = mktK ? str(fin[mktK]?.[i]) : '';
    const j = momIdx.get(code) ?? -1;
    const momRowOk = j >= 0;
    out.push({
      code,
      name,
      ths: (thsK ? str(fin[thsK]?.[i]) : '').split('-'),
      roe: num(col(fin, '净资产收益率roe', i)),
      mlr: num(col(fin, '销售毛利率', i)),
      kc: num(col(fin, '归属母公司股东的净利润-扣除', i)),
      gm: num(col(fin, '归属母公司股东的净利润(同比', i)),
      rev: num(col(fin, '营业总收入(同比', i)),
      debt: num(col(fin, '资产负债率', i)),
      pe: num(col(fin, '市盈率(pe)', i)),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      // 动量四字段全部经窗口列排序接线：涨跌幅长窗(起始日最早)→r60；
      // 均价长窗→a60、短窗(起始日最晚)→a20；收盘价取字典序最大的窗口。
      r60: momRowOk ? windowCol(mom, '区间涨跌幅:前复权', j, 0) : null,
      close: momRowOk ? lastWindowCol(mom, '区间收盘价', j) : null,
      a20: momRowOk ? lastWindowCol(mom, '区间成交均价', j) : null,
      a60: momRowOk ? windowCol(mom, '区间成交均价', j, 0) : null,
    });
  }
  return out;
}




const MIN_ROWS = 4000;

// service 角色 headers：与 daily-update index.ts L181-183 的 `H` 构造完全一致
// （apikey + 'Bearer ' + serviceKey + Content-Type），生产代码不留 'placeholder'。
function svcHeaders(): Record<string, string> {
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

async function upsert(rows: Record<string, unknown>[], table: string, onConflict: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
  }
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const u = new URL(req.url); const mode = u.searchParams.get('mode') || 'run';
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  try {
    if (mode === 'ping') {
      const t = await gsFetch('工程机械行业市盈率低于20的股票', key);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const [finT, momT] = [await gsFetch(Q_FIN, key), await gsFetch(Q_MOM, key)];
    const n = (finT['股票代码']?.length ?? 0);
    if (n < MIN_ROWS || (momT['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error(`GS 行数异常 fin=${n}，保留旧批次`);
    const stocks: Stock[] = mergeTables(finT, momT);
    const periodStamp = (Object.keys(finT).find(k => k.startsWith('资产负债率')) ?? '').match(/\[(\d{8})\]/)?.[1] ?? '';
    const batch = new Date().toISOString().slice(0, 10);
    const rows = computeScores(stocks);
    const poolResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
    if (!poolResp.ok) throw new Error(`read stock_pool ${poolResp.status} ${await poolResp.text()}`);
    const pool = await poolResp.json();
    const poolSet = new Set((pool as { code: string }[]).map(p => p.code));
    const scored = rows.filter(r => r.final !== null);
    const top = scored.filter(r => poolSet.has(r.code.split('.')[0])).slice(0, 10);
    // 增强：Top10+持仓 周期警示（扣非增速>100 → 提示核对3年CAGR），失败不阻塞
    const warnings = new Map<string, string[]>();
    for (const r of [...top, ...scored.filter(r => ['000338.SZ', '002415.SZ', '600031.SH'].includes(r.code))]) {
      if (r.kc !== null && r.kc > 100) warnings.set(r.code, [`单年扣非+${Math.round(r.kc)}%，需查3年CAGR/周期位置`]);
    }
    await upsert(scored.map(r => ({
      batch_date: batch, code: r.code.split('.')[0], name: r.name,
      ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null, ths_l3: r.ths[2] ?? null,
      quality: r.quality, growth: r.growth, value: r.value, momentum: r.momentum, final: r.final,
      ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: scored.length,
      in_pool: poolSet.has(r.code.split('.')[0]), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [],
      extras: { fin_period: periodStamp, abs_trend: r.absTrend },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
