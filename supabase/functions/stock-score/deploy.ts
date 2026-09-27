/// <reference lib="deno.ns" />
// stock-score 评分引擎（纯函数，无 IO）——规则权威：docs/superpowers/specs/2026-09-27-stock-scoring-v1.1-design.md §4/§5/§8
// （V1.0 基线见 specs/2026-09-26-stock-scoring-v1-design.md §2/§4，分组/百分位/NA 重归一纪律全部继承）
// 四因子总权重固定 Q30/G30/V20/M20；因子内全权重表（B 层探针 PASS → 单套表，缺腿走 renorm，无模式开关）：
//   Q = ROE35 / 毛利率25 / 现金含量15 / ROE三年中位25
//   G = 扣非25 / 归母10 / 营收30 / 营收CAGR20 / 利润率恢复代理15
//   V = PE50 / PEG50；M = 行业相对50 / 绝对趋势50
// 组内百分位：P1/P99 截尾(winsorize) 后 (低于数+0.5×并列数)/N×100；逆序指标取 100-pct
// 风控/异常类信号只进 flags（零分数影响）+ confidence 分级（spec §4.7）

interface Stock {
  code: string; name: string; ths: string[];
  roe: number | null; mlr: number | null; kc: number | null; gm: number | null;
  rev: number | null; debt: number | null; pe: number | null;
  isFin: boolean; isST: boolean;
  r60: number | null; close: number | null; a20: number | null; a60: number | null;
  // V1.1 新增（全部可选，由 Task 4 编排注入；缺列 → 该腿 NA → renorm 再分配）
  cash?: number | null;      // 利润现金含量 = 经营现金流净额 / 归母净利（spec §4.1/§4.3）
  mlrYoy?: number | null;    // 销售毛利率同比（pp）——仅用于 margin_deterioration 标记，不进分（spec §4.4）
  roe3y?: (number | null)[]; // 近三年年报 ROE → 中位数腿（spec §8）
  cagr3?: number | null;     // 近 3 年营收复合增长率（spec §8）
  mlrDelta?: number | null;  // 利润率恢复代理 = 毛利率本期 − 上年年报（spec §8 R6）
  mixed?: boolean;           // C 层主营结构判定混合业务 → 百分位池强制降级全市场（spec §5.2）
}

interface ScoreRow extends Stock {
  quality: number | null; growth: number | null; value: number | null; momentum: number | null;
  final: number | null; indRank: number; indN: number; marketRank: number; marketN: number;
  cov: number; peg: number | null; flags: string[];
  grp: string;      // 'L2:汽车-汽车零部件' | 'L1:传媒' | 'MARKET'（Task 4 经 extras 消费；mixed → 恒为 'MARKET'）
  absTrend: number; // 满足数/已知数×100：三条件全知时为 0/33.3/66.7/100，部分缺数据时可为 k/已知数 的中间值（如 50、66.7 两条件情形）；-1 = 三条件全缺未参与（Task 4 经 extras 消费）
  lowBase: boolean; // 扣非增速 > 200% → Growth 封顶 + PEG 判无效（spec §4.2）
  confidence: 'A' | 'B' | 'C'; // 排名回填（spec §4.7，先命中先得：C > B > A）
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
  // C 层（spec §5.2）：混合业务改用全市场宇宙取百分位。覆盖在正常分组之后执行
  // → 组内计数仍按全宇宙统计，其他股的分组不受 mixed 标记影响。
  for (const s of stocks) if (s.mixed) out.set(s.code, 'MARKET');
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

// V1.1 因子内全权重表（R-BFORM：单套表，缺腿一律走 renorm）
const W_Q = { roe: 35, mlr: 25, cash: 15, roeMed: 25 };
const W_G = { kc: 25, gm: 10, rev: 30, cagr3: 20, mlrDelta: 15 };
const W_V = { peInv: 50, pegInv: 50 };
const W_M = { rel: 50, abs: 50 };        // 行业相对（r60/pma20 各半）/ 绝对趋势
const W_REL = { r60: 50, pma20: 50 };

const LOW_BASE_KC = 200;   // spec §4.2 / R1：宽表仅有同比 → 单判据 扣非增速 > 200%
const GROWTH_CAP = 85;     // 封顶发生在因子内 renorm 之后、综合加权之前
const CASH_CLAMP: [number, number] = [-0.5, 2]; // spec §4.3：百分位前截尾，负现金流保留为低分
const MARGIN_REV = 30;     // spec §4.4
const MARGIN_DROP = -5;
const CROWD_PCT = 95;      // spec §4.5：组内 60 日涨幅分位 ≥95 且 close > MA60×1.15
const CROWD_BREAKOUT = 1.15;

// NA 重归一：有效腿按各自权重重分配；返回 [得分, 有效权重覆盖之和]
function renorm(pairs: [number | null, number][]): [number | null, number] {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, wt]) => a + wt, 0);
  if (tot === 0) return [null, 0];
  if (valid.length === 1) return [valid[0][0], valid[0][1]]; // 单腿恒等，避免浮点往返误差
  return [valid.reduce((a, [v, wt]) => a + v * wt, 0) / tot, tot];
}

const isLowBase = (s: Stock): boolean => s.kc !== null && s.kc > LOW_BASE_KC;

// 利润现金含量：金融股同样置 NA（沿用决策8 毛利率剔除纪律）；百分位前截尾至 [-0.5,2]
function cashOf(s: Stock): number | null {
  if (s.isFin) return null;
  const c = s.cash ?? null;
  if (c === null || !Number.isFinite(c)) return null;
  return Math.min(Math.max(c, CASH_CLAMP[0]), CASH_CLAMP[1]);
}

// 近三年 ROE 中位数（spec §8）：非空值不足 2 个 → NA（单值不构成“中位数”）
function roeMedian(s: Stock): number | null {
  const xs = (s.roe3y ?? [])
    .filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (xs.length < 2) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// PEG 有效判据（V1.0 决策6）：PE∈(0,200] 且 扣非增速∈[10,300]
// V1.1 spec §4.2：低基数（扣非>200%）一律判无效——修复期增速算出的 PEG 是伪便宜，Value 退为 PE 单腿
function pegOf(s: Stock): number | null {
  if (isLowBase(s)) return null;
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
    cash: pctFromEntries(entries(cashOf), false),                       // §4.3：现金含量（已缩尾）
    roeMed: pctFromEntries(entries(roeMedian), false),                  // §8：3 年 ROE 中位数
    kc: pctFromEntries(entries(s => s.kc), false),
    gm: pctFromEntries(entries(s => s.gm), false),
    rev: pctFromEntries(entries(s => s.rev), false),
    cagr3: pctFromEntries(entries(s => s.cagr3 ?? null), false),         // §8：营收 CAGR
    mlrDelta: pctFromEntries(entries(s => s.mlrDelta ?? null), false),   // §8 R6：利润率恢复代理
    r60: pctFromEntries(entries(s => s.r60), false),
    pma20: pctFromEntries(entries(s => (s.close !== null && s.a20 !== null && s.a20 !== 0 ? s.close / s.a20 : null)), false),
    peInv: pctFromEntries(entries(s => (s.pe !== null && s.pe > 0 ? s.pe : null)), true), // 亏损 PE≤0 → 经济无效 → NA
    pegInv: pctFromEntries(entries(pegOf), true),
  };
  const get = (m: Map<string, number>, s: Stock) => m.get(s.code) ?? null;

  const rows: ScoreRow[] = stocks.map(s => {
    const lowBase = isLowBase(s);
    const [q] = renorm([
      [get(pct.roe, s), W_Q.roe], [get(pct.mlr, s), W_Q.mlr],
      [get(pct.cash, s), W_Q.cash], [get(pct.roeMed, s), W_Q.roeMed],
    ]);
    const [gr0] = renorm([
      [get(pct.kc, s), W_G.kc], [get(pct.gm, s), W_G.gm], [get(pct.rev, s), W_G.rev],
      [get(pct.cagr3, s), W_G.cagr3], [get(pct.mlrDelta, s), W_G.mlrDelta],
    ]);
    const gr = gr0 !== null && lowBase ? Math.min(gr0, GROWTH_CAP) : gr0; // §4.2 封顶
    const v = renorm([[get(pct.peInv, s), W_V.peInv], [get(pct.pegInv, s), W_V.pegInv]])[0];
    const rel = renorm([[get(pct.r60, s), W_REL.r60], [get(pct.pma20, s), W_REL.pma20]])[0];

    // 绝对趋势三条件（决策7）：满足数/已知数×100；缺数据条件退出重归一；全缺 → NA
    const conds: (number | null)[] = [
      s.close !== null && s.a20 !== null ? (s.close > s.a20 ? 1 : 0) : null,
      s.close !== null && s.a60 !== null ? (s.close > s.a60 ? 1 : 0) : null,
      s.a20 !== null && s.a60 !== null ? (s.a20 > s.a60 ? 1 : 0) : null,
    ];
    const known = conds.filter((c): c is number => c !== null);
    const absTrend = known.length === 0 ? -1 : known.reduce((a, b) => a + b, 0) / known.length * 100;
    const mo = renorm([[rel, W_M.rel], [absTrend === -1 ? null : absTrend, W_M.abs]])[0];

    const [fin, cov] = renorm([[q, WEIGHTS.quality], [gr, WEIGHTS.growth], [v, WEIGHTS.value], [mo, WEIGHTS.momentum]]);

    // 标记/风控全部不进分（V1.0 决策 + V1.1 §9 裁决：反向证据只标记）
    const flags: string[] = [];
    if (s.debt !== null && s.debt > 80) flags.push('负债率>80%'); // 风控只进 flags 不进分
    if (lowBase) flags.push('low_base_growth');
    if (s.mixed) flags.push('mixed_business');
    const mlrYoy = s.mlrYoy ?? null; // 缺列（探针未通过/编排未注入）→ 不判定
    if (s.rev !== null && s.rev >= MARGIN_REV && mlrYoy !== null && mlrYoy <= MARGIN_DROP) flags.push('margin_deterioration');
    const r60Pct = get(pct.r60, s); // 缺 r60/a60 → 不判定（不算触发也不算违规，spec §4.5）
    if (r60Pct !== null && s.close !== null && s.a60 !== null && r60Pct >= CROWD_PCT && s.close > s.a60 * CROWD_BREAKOUT) {
      flags.push('momentum_crowded');
    }

    return {
      ...s, quality: q, growth: gr, value: v, momentum: mo,
      final: cov >= 40 ? fin : null, indRank: 0, indN: 0, marketRank: 0, marketN: 0,
      cov, peg: pegOf(s),
      flags,
      grp: gOf(s), absTrend, lowBase,
      confidence: 'A', // 占位，排名计算后回填（indN 需先知道）
    };
  });

  // 全市场排名 + 行业（组）排名：按 final 降序，未评分者不参与
  const byFinal = rows.filter(r => r.final !== null).sort((a, b) => b.final! - a.final!);
  byFinal.forEach((r, i) => { r.marketRank = i + 1; r.marketN = byFinal.length; });
  for (const r of byFinal) {
    const mate = byFinal.filter(x => x.grp === r.grp);
    r.indN = mate.length; r.indRank = mate.indexOf(r) + 1;
  }

  // 置信度（spec §4.7）：在排名之后回填，先命中先得 C > B > A。
  // final===null 的行同样计算（indN 保持 0）；编排层会过滤它们。
  for (const r of rows) {
    const nulls = [r.quality, r.growth, r.value, r.momentum].filter(x => x === null).length;
    r.confidence = (r.grp === 'MARKET' && r.indN < 20) || nulls >= 2 ? 'C'
      : (nulls === 1 || r.flags.length > 0 ? 'B' : 'A');
  }
  return rows;
}

// GS（国信智能选股）宽表解析适配器：把列式（column-oriented）返回的批量表
// 归一化为 engine.ts 的 Stock[]。GS 列名内嵌数据日期戳（如 [20260924] /
// [20260703-20260924]），日期会随快照漂移，因此所有列一律按前缀匹配，
// 窗口列按起始日字典序（=时间序）取第 0 个 / 最后一个，绝不硬编码日期。

type GsTable = Record<string, (string | number | null)[]>;

// V1.1 措辞（探针实证的最终版）：不写「销售毛利率同比增长率」——GS 会把同查询里
// 的销售毛利率/roe(摊薄) 当期列连带替换成同比增长率列（污染）；改用 年中报/
// 年报历史绝对值窗口列，mlrYoy 由适配器自行派生（百分点口径，fix 轮 1）。
// 现金流指标同理必须留在独立 Q_CASH（并入会被误解析成同比增长率列）。
//
// 查询年份锚点运行时推导（fix 轮 1）：Q_FIN 措辞里绝不出现硬编码的 2023/2024/2025。
// annualBase = 最新一期完整年报的年份：年报须在次年 4/30 前披露完毕，故当年
// month>=5 可锚 currentYear-1，1-4 月只能锚 currentYear-2。yearAnchors 是纯函数
// （无隐式时钟），测试传合成 Date 即可覆盖披露月映射。
function yearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// 新鲜度守卫：基期必须**恰好等于** yearAnchors(now) 推出的当年合法锚点——偏旧（如 9 月里
// 错用 2024 基期 = 「1.5 年前」的年报前沿）或偏新（1-4 月里错锚到当年尚未披露完毕的年报）
// 均判陈旧 → 拒绝。调用方递合成 Date → 可测（无隐式时钟）。
function isAnnualBaseFresh(now: Date, annualBase: number): boolean {
  return annualBase === yearAnchors(now).annualBase;
}

// Q_FIN 由 annualBase 模板拼装；除年份锚点外逐字沿用探针 L 的最终措辞。
function buildQFin(annualBase: number): string {
  const b = annualBase;
  return `全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、${b - 2}年报净资产收益率、${b - 1}年报净资产收益率、${b}年报净资产收益率、近3年营业总收入复合增长率、${b}年报销售毛利率、${b}年中报销售毛利率、所属同花顺行业`;
}

// 模块加载时按当前日期推导（Edge Runtime 每次冷启动重算）；index.ts 禁改，
// Q_FIN 保持同名导出。
const Q_FIN = buildQFin(yearAnchors(new Date()).annualBase);
const Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业';
const Q_CASH = '全部沪深A股的经营活动产生的现金流量净额、归属于母公司所有者的净利润、股票简称';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}

// 同一指标的多个窗口列（列名内嵌 yyyyMMdd 起始日）按字典序 = 时间序升序：
// 最早起始日 = 长窗（60日），最晚起始日 = 短窗（20日）；单一列时首尾同为该列。
function sortedWindowCols(t: GsTable, prefix: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(prefix)).sort();
}

// 严格窗口列：`名称[yyyyMMdd...]` 才入选，排除同名前缀的先兄弟列
// （销售毛利率同比增长率 / 归属于母公司所有者的净利润同比增长率等），
// mlrYoy 与 mlrDelta 是不同字段，绝不互换。仍按字典序 = 时间序升序。
function windowColsByPrefix(t: GsTable, name: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(name + '[') && /^\d{8}/.test(k.slice(name.length + 1))).sort();
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

// 严格窗口列版本（同上纪律，但排除增长率先兄弟列）：idx=0 最早期，-1 最新期；
// 行索引越界 = 该 code 在此表无行 → null（优雅缺席，不 clamp 取值）
const strictWin = (t: GsTable, name: string, i: number, idx: number): number | null => {
  const keys = windowColsByPrefix(t, name);
  if (keys.length === 0) return null;
  const key = idx < 0 ? keys[keys.length + idx] : keys[Math.min(idx, keys.length - 1)];
  if (!key || i < 0 || i >= (t[key]?.length ?? 0)) return null;
  return num(t[key]?.[i]);
};

// 利润现金含量 = 经营现金流净额 ÷ 归母净利（各自窗口列最新值）；
// R-CASHNEG：分母≤0 时比值无经济意义 → null（Quality 缺腿由引擎 renorm 处理）
const cashRatio = (cf: number | null, np: number | null): number | null =>
  cf !== null && np !== null && np > 0 ? cf / np : null;

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

// 从严格窗口列名中取 yyyyMMdd 日期戳（'销售毛利率[20250630]' → 20250630）
const colDate = (key: string): number => Number(key.match(/\[(\d{8})/)?.[1] ?? NaN);
const mmdd = (d: number): number => d % 10000;

// cash = 独立第 3 次 GS 调用（Q_CASH）的原始值宽表；null/缺省 → Stock.cash 全 null
// （Task 6 编排接入前的兼容形态：两参调用照旧可用，缺失表现为 C 层风格优雅缺席）。
// now 可注入（fix 轮 2）：新鲜度守卫不再偷读挂钟，硬值测试传固定时钟，
// fixture 锚点 2025 不会到 2028 年腐烂；index.ts 两参调用走默认值不受影响。
function mergeTables(fin: GsTable, mom: GsTable, cash: GsTable | null = null, now: Date = new Date()): Stock[] {
  const codes = (fin['股票代码'] as string[] | undefined) ?? [];
  // 守卫：有数据行却缺失“股票市场类型”列时，下方 isST 判定会把全部股票静默标为 ST
  // （0 可用行且无报错）——在此 fail loudly，避免编排层拿到空宇宙。
  if (codes.length > 0 && !colByPrefix(fin, '股票市场类型')) {
    throw new Error('GS fin table missing 股票市场类型 column');
  }
  const momCodes = (mom['股票代码'] as string[] | undefined) ?? [];
  const momIdx = new Map(momCodes.map((c, i) => [c, i]));
  const cashCodes = (cash?.['股票代码'] as string[] | undefined) ?? [];
  const cashIdx = new Map(cashCodes.map((c, i) => [c, i]));
  const thsK = colByPrefix(fin, '所属同花顺行业');
  const mktK = colByPrefix(fin, '股票市场类型');

  // 销售毛利率三个绝对值窗口列（本期 / 上年同期 / 上年年报）按日期定位，不按下标猜测：
  // 本期=日期最大；上年同期=年份减一且月日相同，本期即 12月31日年报时不自反；
  // 上年年报=年份恰为 latest.year−1 且月日 1231（fix 轮 1 收紧：更早年份的
  // 年报列不得当基期）。
  const mlrKeys = windowColsByPrefix(fin, '销售毛利率').filter(k => Number.isFinite(colDate(k)));
  const mlrKeyOf = (i: number, pick: (ds: number[]) => number): number | null => {
    const dates = mlrKeys.map(colDate);
    const d = pick(dates);
    return Number.isFinite(d) ? num(fin[mlrKeys[dates.indexOf(d)]]?.[i]) : null;
  };
  const at = (i: number) => ({
    latest: mlrKeyOf(i, ds => Math.max(...ds)),
    // 上年同期=年份减一且月日相同（本期即 12月31日年报时不得自反）；
    // 找不到严格同月日的上年列就是 null，无其他兜底（fix 轮 2 纠正旧注释）
    prevYoy: mlrKeyOf(i, ds => {
      const y = Math.max(...ds);
      const want = (Math.floor(y / 10000) - 1) * 10000 + mmdd(y);
      if (want === y) return NaN;
      return ds.filter(d => d === want)[0] ?? NaN;
    }),
    // 上年年报 = 年份恰为 latest.year−1 的 12月31日列（fix 轮 1 收紧守卫：跑批撞上
    // 年报披露日、或只有更早年份年报时不得用自身/远旧年报作差 → 退回 null 而非恒 0）
    prevAnnual: mlrKeyOf(i, ds => {
      const y = Math.max(...ds);
      const want = (Math.floor(y / 10000) - 1) * 10000 + 1231;
      return ds.filter(d => d === want)[0] ?? NaN;
    }),
  });

  // ---- fix 轮 1：B 层派生年份锚点新鲜度守卫（不信任单点，双通道核对）----
  // 数据驱动基期：毛利率窗口里最新 12月31日列的年份；运行时基期：yearAnchors(now)。
  // 运行时基期本身陈旧（isAnnualBaseFresh 不过）或两者相差 >1 年 → anchorsOk=false，
  // mlrDelta/roe3y/cagr3 只置 null（NA 优雅降级）；mlrYoy 是数据自身同期对的 pp 差，
  // 不依赖年份锚点 → **不**受此守卫管辖（fix 轮 2 纠正旧注释）。
  const annualBase = yearAnchors(now).annualBase;
  const annRefs = mlrKeys.map(colDate).filter(d => mmdd(d) === 1231);
  // fix 轮 2 取整：20261231/10000=2026.1231 会带 mmdd 小数尾巴，把早披露的
  // FY(base+1) 年报列（如 2027-02 跑批撞出 [20261231]，差 1.1231>1）误判成宇宙级
  // 陈旧——必须 floor 到纯年份再与 annualBase 比。
  const dataAnnualBase = annRefs.length ? Math.floor(Math.max(...annRefs) / 10000) : NaN;
  const anchorsOk = isAnnualBaseFresh(now, annualBase)
    && (!Number.isFinite(dataAnnualBase) || Math.abs(dataAnnualBase - annualBase) <= 1);

  // roe3y：近三年年报加权 ROE 窗口列，按日期升序（裁定 4）。fix 轮 1 收紧：
  // 必须恰好 3 根窗口列，否则整组置 null（宁可 NA，不可 2 列错位当 3 列）。
  const roe3All = windowColsByPrefix(fin, '净资产收益率roe(加权,公布值)');
  const roe3Keys = roe3All.length === 3 ? roe3All : [];
  const out: Stock[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = str(col(fin, '股票简称', i));
    // 市场类型是 GS 的分层标签串（';' 分隔），缺 "全部A股(非ST)" / "(非金融)" 标记即视为该类
    const mkt = mktK ? str(fin[mktK]?.[i]) : '';
    const j = momIdx.get(code) ?? -1;
    const momRowOk = j >= 0;
    const m = at(i);
    const k = cashIdx.get(code) ?? -1;
    const out2: Stock = {
      code,
      name,
      ths: (thsK ? str(fin[thsK]?.[i]) : '').split('-'),
      // 当期 ROE 严格取摊薄列（只写 '净资产收益率roe' 会被 3 年加权列误匹配）
      roe: num(col(fin, '净资产收益率roe(摊薄', i)),
      mlr: m.latest,
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
      // ---- V1.1 新增（缺列 → null/空数组，引擎侧走 NA renorm）----
      // 利润现金含量：独立第 3 次 GS 调用的两个原始值列最新窗口值之比
      cash: k >= 0
        ? cashRatio(
          strictWin(cash!, '经营活动产生的现金流量净额', k, -1),
          strictWin(cash!, '归属于母公司所有者的净利润', k, -1))
        : null,
      // mlrYoy（fix 轮 1 改口径）：百分点差 pp = 本期 − 上年同期（spec §4.4 /
      // engine.ts 注释 "pp" / MARGIN_DROP=-5 均按 pp 判定）。旧推导 (latest/prev−1)*100
      // 是相对 %，且上年基数为负时符号翻转（金浦钛业案）——pp 差同时消除两个缺陷。
      // 两者非 null 才接线，无「prev≠0」残守卫（pp 口径不需要除法）。
      mlrYoy: m.latest !== null && m.prevYoy !== null ? m.latest - m.prevYoy : null,
      // mlrDelta（R6 利润率恢复代理）：本期 − 上年年报（同为 pp 差），两者非 null
      // 且年份锚点新鲜（anchorsOk）才接线
      mlrDelta: anchorsOk && m.latest !== null && m.prevAnnual !== null ? m.latest - m.prevAnnual : null,
      // roe3y：近三年年报 ROE 升序数组；列数≠ 3 或锚点陈旧 → undefined（engine `(s.roe3y ?? [])` 走 NA）
      roe3y: anchorsOk && roe3Keys.length === 3 ? roe3Keys.map(key => num(fin[key]?.[i])) : undefined,
      // 裁定 1：取日期最新的窗口列（[annualBase 年报] = 3 年 CAGR）；锚点陈旧 → null
      cagr3: anchorsOk ? strictWin(fin, '营业总收入复合年增长率', i, -1) : null,
    };
    out.push(out2);
  }
  return out;
}




const MIN_ROWS = 4000;

// —— 以下 mix/extras 相关纯函数可被 index_test.ts 直接单测（无网络依赖）——
interface MixSegment { name: string; ratio: number }

// stock_business_mix 行（bare code 为键；segments 项 = {name, ratio}）
interface MixRow {
  code: string; // bare code（如 '688378'）
  mixed?: boolean; shift?: boolean;
  segments?: MixSegment[] | null; report_date?: string | null;
}

// extras 揭示位（信息位，不参与评分）：正常化 PE 近似 + 主营结构；pe/gm 来自 ScoreRow（extends Stock）
function buildRevealExtras(
  r: { pe: number | null; gm: number | null },
  m?: MixRow | null,
): Record<string, unknown> {
  const gm = r.gm ?? 0; // 先局部化，供 TS 收窄后再参与乘法
  return {
    implied_normal_pe_approx: r.pe !== null && gm > 0
      ? Math.round(r.pe * (1 + gm / 100) * 100) / 100 : null, // spec §4.6 近似口径；R-APPROX：必须带 _approx 后缀，前端标「≈」
    mix: m ? { segments: m.segments?.slice(0, 2) ?? null, report_date: m.report_date ?? null, shift: !!m.shift } : null,
  };
}

// R-WARNCONF 终裁：warnings 是评分后生成的展示位，无法回灌引擎 → 编排层收尾降级，仅 A→B
function applyWarnConf<T extends { code: string; confidence: 'A' | 'B' | 'C' }>(rows: T[], warnings: Map<string, string[]>): void {
  for (const r of rows) if ((warnings.get(r.code) ?? []).length > 0 && r.confidence === 'A') r.confidence = 'B';
}

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

// C 层读 stock_business_mix（business-mix 维护）；任何失败静默降级为空 Map，绝不阻塞跑批
async function fetchMixMap(url: string): Promise<Map<string, MixRow>> {
  const map = new Map<string, MixRow>();
  try {
    const resp = await fetch(`${url}/rest/v1/stock_business_mix?select=code,mixed,shift,segments,report_date`, { headers: svcHeaders() });
    if (!resp.ok) return map;
    for (const m of (await resp.json()) as MixRow[]) map.set(m.code, m);
  } catch { /* 外部/表缺失 → C 层静默跳过（spec §5.3） */ }
  return map;
}

// 守卫仅针对单测场景（index_test.ts 先设 STOCK_SCORE_DISABLE_SERVE 再动态 import）；
// 线上 Edge 不会注入该变量， Deno.serve 注册行为不变。
if (!Deno.env.get('STOCK_SCORE_DISABLE_SERVE')) {
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
    // C 层混合业务标记：仅设 s.mixed，分组降级（→MARKET）由 engine.assignGroups 完成
    const mixMap = await fetchMixMap(Deno.env.get('SUPABASE_URL')!);
    let mixedCount = 0;
    for (const s of stocks) {
      const m = mixMap.get(s.code.split('.')[0]);
      if (m?.mixed) { s.mixed = true; mixedCount++; }
    }
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
    // R-WARNCONF 终裁：警示行置信度 A→B（spec §4.7 warning 计入；B/C 不动）
    applyWarnConf(scored, warnings);
    await upsert(scored.map(r => ({
      batch_date: batch, code: r.code.split('.')[0], name: r.name,
      ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null, ths_l3: r.ths[2] ?? null,
      quality: r.quality, growth: r.growth, value: r.value, momentum: r.momentum, final: r.final,
      ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: scored.length,
      in_pool: poolSet.has(r.code.split('.')[0]), cov: r.cov, pe: r.pe, peg: r.peg, roe: r.roe, debt: r.debt,
      flags: r.flags, warnings: warnings.get(r.code) ?? [], confidence: r.confidence,
      extras: { fin_period: periodStamp, abs_trend: r.absTrend, ...buildRevealExtras(r, mixMap.get(r.code.split('.')[0])) },
    })), 'stock_score', 'batch_date,code');
    return Response.json({ ok: true, batch_date: batch, scored: scored.length, skipped: rows.length - scored.length, mixed_injected: mixedCount, top10: top.map(t2 => ({ code: t2.code, name: t2.name, final: t2.final })) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
}
