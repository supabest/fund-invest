// sector-trend 纯函数内核（无 IO）——规则权威: docs/superpowers/specs/2026-09-30-sector-rotation-design.md §5
// 均线五态 / 六标签（回测证据阈值）/ ETF 四因子 renorm（Q35/V30/M25/L10，Q 全缺→V/M/L 归一）/ 行业规模加权分 / 横截面动量分位。
// 风格对齐 stock-score/engine.ts：Deno + TS + 无第三方依赖（仅 std testing 在测试侧）。
// S5 纪律：标签仅展示标记，不进分数；多头状态不构成买入标签（翻案①）。

export interface EtfSnap {
  code: string; name: string; amt: number; tem: number;
  r60: number | null; sharpe: number | null; hay: string | null;
}
export interface Bar { date: string; close: number; volume: number }
export interface SectorInput {
  ind: string; pkEtf: string; nEtf: number; theme: string | null;
  etfs: EtfSnap[]; bars: Bar[]; prevMp: number | null;
}
export interface SectorRow {
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

export function computeSectorRows(inputs: SectorInput[]): SectorRow[] {
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
