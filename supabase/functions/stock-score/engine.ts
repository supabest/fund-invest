// stock-score 评分引擎（纯函数，无 IO）——规则权威：docs/superpowers/specs/2026-09-26-stock-scoring-v1-design.md §2/§4
// 权重固定 Q30/G30/V20/M20；因子内 Q=ROE50/毛利率50, G=扣非35/归母15/营收50, V=PE50/PEG50, M=行业相对50/绝对趋势50
// 组内百分位：P1/P99 截尾(winsorize) 后 (低于数+0.5×并列数)/N×100；逆序指标取 100-pct

export interface Stock {
  code: string; name: string; ths: string[];
  roe: number | null; mlr: number | null; kc: number | null; gm: number | null;
  rev: number | null; debt: number | null; pe: number | null;
  isFin: boolean; isST: boolean;
  r60: number | null; close: number | null; a20: number | null; a60: number | null;
}

export interface ScoreRow extends Stock {
  quality: number | null; growth: number | null; value: number | null; momentum: number | null;
  final: number | null; indRank: number; indN: number; marketRank: number; marketN: number;
  cov: number; peg: number | null; flags: string[];
  grp: string;      // 'L2:汽车-汽车零部件' | 'L1:传媒' | 'MARKET'（Task 4 经 extras 消费）
  absTrend: number; // 0/33.3/66.7/100；-1 = 数据缺失未参与（Task 4 经 extras 消费）
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
