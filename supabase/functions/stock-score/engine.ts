// stock-score 评分引擎（纯函数，无 IO）——规则权威：docs/superpowers/specs/2026-09-27-stock-scoring-v1.1-design.md §4/§5/§8
// （V1.0 基线见 specs/2026-09-26-stock-scoring-v1-design.md §2/§4，分组/百分位/NA 重归一纪律全部继承）
// 四因子总权重固定 Q30/G30/V20/M20；因子内全权重表（B 层探针 PASS → 单套表，缺腿走 renorm，无模式开关）：
//   Q = ROE35 / 毛利率25 / 现金含量15 / ROE三年中位25
//   G = 扣非25 / 归母10 / 营收30 / 营收CAGR20 / 利润率恢复代理15
//   V = PE50 / PEG50；M = 行业相对50 / 绝对趋势50
// 组内百分位：P1/P99 截尾(winsorize) 后 (低于数+0.5×并列数)/N×100；逆序指标取 100-pct
// 风控/异常类信号只进 flags（零分数影响）+ confidence 分级（spec §4.7）

export interface Stock {
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

export interface ScoreRow extends Stock {
  quality: number | null; growth: number | null; value: number | null; momentum: number | null;
  final: number | null; indRank: number; indN: number; marketRank: number; marketN: number;
  cov: number; peg: number | null; flags: string[];
  grp: string;      // 'L2:汽车-汽车零部件' | 'L1:传媒' | 'MARKET'（Task 4 经 extras 消费；mixed → 恒为 'MARKET'）
  absTrend: number; // 满足数/已知数×100：三条件全知时为 0/33.3/66.7/100，部分缺数据时可为 k/已知数 的中间值（如 50、66.7 两条件情形）；-1 = 三条件全缺未参与（Task 4 经 extras 消费）
  lowBase: boolean; // 扣非增速 > 200% → Growth 封顶 + PEG 判无效（spec §4.2）
  confidence: 'A' | 'B' | 'C'; // 排名回填（spec §4.7，先命中先得：C > B > A）
}

// 行业回退：同花顺二级样本≥20 → 一级≥20 → 全市场(MARKET)
export function assignGroups(stocks: Stock[]): Map<string, string> {
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

export function pctWithinGroups(stocks: Stock[], get: (s: Stock) => number | null, reverse = false): Map<string, number> {
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

export function computeScores(all: Stock[]): ScoreRow[] {
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
