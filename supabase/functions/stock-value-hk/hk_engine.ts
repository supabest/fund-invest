// hk_engine.ts — 港股降维口径的纯函数。规则权威：spec §3（口径）/§3.1（空值语义）/§3.3（股息不记 0）
// 与 A 股 value_engine.ts 完全隔离（spec §5.2）：roicStats3 是 roicStats 的复制体，不 import、不抽公共模块。
export const HK_ROIC_GATE = 8;   // % WACC 锚，与 A 股 ROIC_GATE 同值同理由（2026-10-30 裁定维持 8）；测试三处钉住

export type HkRaw = {
  code: string;                    // 5 位补零（00700 / 09988），与持仓/前端同形
  name: string;
  roic3: (number | null)[];        // [Y-2, Y-1, Y] 三年年报 ROIC，顺序由适配器锤死
  divYield: number | null;
  divY5y: number | null;
  pe: number | null;
  pb: number | null;
};

export type HkRow = HkRaw & {
  roicCur: number | null;
  roicMed: number | null;
  roicMin3: number | null;
  roicOk: boolean | null;          // 三态：med=null ⇒ null，不是 false
  missing: string[];               // 缺值字段名，落 extras.missing
};

// 与 A 股 value_engine.ts:29 roicStats 同语义的复制体：≥2 期有效才算，med 与 min3 同生同死。
export function roicStats3(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

// PE/PB ≤0 一律 null（spec §3.1）。PB≤0 **不推断资不抵债**——那是 A 股否决1 的结论，本设计不产结论。
const pos = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

export function computeHk(r: HkRaw): HkRow {
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
