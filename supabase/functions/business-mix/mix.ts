// mix.ts — 东财主营构成(zygcfx)纯解析：混合业务判定
// 规则权威：docs/superpowers/specs/2026-09-27-stock-scoring-v1.1-design.md §5.1
// 纯函数，无 IO；输入 = 东财 zygcfx 数组原样行（含 MAINOP_TYPE '1'/'2'/'3'，decide 内部只取 '1'）。
//
// 国标行业口径 = MAINOP_TYPE==='1'（'2'=产品、'3'=地区，必须忽略）。
// ratio = MBI_RATIO（0~1 小数）；name = ITEM_NAME；报告期 = REPORT_DATE。

/** 东财 zygcfx 单行（只声明本函数关心的字段，运行时其余字段忽略） */
export interface ZygcfxRow {
  MAINOP_TYPE: string;   // '1' 按行业 / '2' 按产品 / '3' 按地区
  REPORT_DATE: string;   // 'YYYY-MM-DD 00:00:00'
  ITEM_NAME: string;     // 如 '化学原料和化学制品制造业C26'
  MBI_RATIO: number;     // 收入占比 0~1
}

export interface MixSeg { name: string; ratio: number }

export interface MixVerdict {
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
export function decide(rows: ZygcfxRow[], today: string): MixVerdict | null {
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
