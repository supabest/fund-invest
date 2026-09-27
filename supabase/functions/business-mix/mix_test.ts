import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { decide, type ZygcfxRow } from './mix.ts';

const TODAY = '2026-09-27';

// 行构造器：只填 decide 关心的四字段（东财原样返回还含 SECUCODE/RANK 等，运行时被忽略）
const row = (mt: string, rd: string, name: string, ratio: number): ZygcfxRow =>
  ({ MAINOP_TYPE: mt, REPORT_DATE: rd, ITEM_NAME: name, MBI_RATIO: ratio });

// ---- 真实样本：奥来德 688378（2026-09-27 东财 PageAjax 实测，zygcfx 原样结构，MAINOP_TYPE 为字符串）----
// 2026H1 只有 MAINOP_TYPE='2'（产品口径：蒸发源设备 0.6238）——行业口径 '1' 最新期是 2025A。
// 该 fixture 混入 '2'/'3' 行，用于证明 decide 的外部过滤（按 ruling：过滤在 decide 内部做）。
const AOLAIDE: ZygcfxRow[] = [
  row('2', '2026-06-30 00:00:00', '蒸发源设备', 0.623839),
  row('2', '2026-06-30 00:00:00', '有机发光材料', 0.284464),
  row('2', '2026-06-30 00:00:00', '其他功能材料', 0.090439),
  row('1', '2025-12-31 00:00:00', '化学原料和化学制品制造业C26', 0.604368),
  row('1', '2025-12-31 00:00:00', '专用设备制造业C35', 0.394145),
  row('1', '2025-12-31 00:00:00', '其他(补充)', 0.001487),
  row('2', '2025-12-31 00:00:00', '有机发光材料', 0.498943),
  row('2', '2025-12-31 00:00:00', '蒸发源设备', 0.394145),
  row('3', '2025-12-31 00:00:00', '境内', 0.992903),
  row('1', '2024-12-31 00:00:00', '化学原料和化学制品制造业C26', 0.681463),
  row('1', '2024-12-31 00:00:00', '专用设备制造业C35', 0.317574),
];

Deno.test('奥来德 688378 硬值（探针实测）：2025A 行业口径 60.4/39.4 → mixed+shift', () => {
  const v = decide(AOLAIDE, TODAY)!;
  assertEquals(v.reportDate, '2025-12-31');
  assertEquals(v.mixed, true, 'top1 0.604368<0.70 且 top2 0.394145>=0.25 → 混合业务');
  assertEquals(v.shift, true);
  assertEquals(v.segments[0], { name: '化学原料和化学制品制造业C26', ratio: 0.604368 });
  assertEquals(v.segments[1], { name: '专用设备制造业C35', ratio: 0.394145 });
  // 若 '2' 行未被过滤，top1 会变成 2026H1 蒸发源设备 0.6238 且期次变 2026-06-30 → 上面断言即破裂
  assertEquals(v.segments.some(s => s.name === '蒸发源设备'), false);
  assertEquals(v.segments.some(s => s.name === '境内'), false);
});

// ---- 真实样本：贵州茅台 600519（单一主业对照，同样实测）----
const MOUTAI: ZygcfxRow[] = [
  row('1', '2025-12-31 00:00:00', '酒类', 0.999624),
  row('1', '2025-12-31 00:00:00', '其他(补充)', 0.000376),
  row('2', '2025-12-31 00:00:00', '茅台酒', 0.853953),
  row('3', '2025-12-31 00:00:00', '境内', 0.995243),
];

Deno.test('茅台 600519 硬值：top1 0.9996>=0.70 → 单一主业，双 false', () => {
  const v = decide(MOUTAI, TODAY)!;
  assertEquals(v.reportDate, '2025-12-31');
  assertEquals(v.mixed, false);
  assertEquals(v.shift, false);
});

Deno.test('MAINOP_TYPE 过滤：只有 2/3 行（产品/地区口径）→ null，即使产品占比达标', () => {
  const onlyProducts: ZygcfxRow[] = [
    row('2', '2026-06-30 00:00:00', '蒸发源设备', 0.623839),
    row('3', '2026-06-30 00:00:00', '境内', 0.99),
  ];
  assertEquals(decide(onlyProducts, TODAY), null);
});

Deno.test('新鲜度：存在年报时优先最新年报，即使中期日期更新', () => {
  const rows: ZygcfxRow[] = [
    row('1', '2026-06-30 00:00:00', '交通运输设备制造业', 0.50), // 中期更晚，但不用
    row('1', '2026-06-30 00:00:00', '专用设备制造业', 0.49),
    row('1', '2025-12-31 00:00:00', '交通运输设备制造业', 0.78), // 最新年报 → 采用
    row('1', '2025-12-31 00:00:00', '专用设备制造业', 0.20),
    row('1', '2024-12-31 00:00:00', '交通运输设备制造业', 0.90), // 更早年报不覆盖更新年报
  ];
  const v = decide(rows, TODAY)!;
  assertEquals(v.reportDate, '2025-12-31');
  assertEquals(v.mixed, false);
  assertEquals(v.shift, false);
});

Deno.test('新鲜度退化：仅中期(06-30)行业行时采用最新中期（潍柴 000338 实测形态）', () => {
  const rows: ZygcfxRow[] = [
    row('1', '2026-06-30 00:00:00', '交通运输设备制造业', 0.780433),
    row('1', '2026-06-30 00:00:00', '专用设备制造业', 0.203408),
    row('1', '2026-06-30 00:00:00', '其他', 0.016159),
    row('1', '2025-06-30 00:00:00', '交通运输设备制造业', 0.80),
  ];
  const v = decide(rows, TODAY)!;
  assertEquals(v.reportDate, '2026-06-30');
  assertEquals(v.mixed, false);
  assertEquals(v.shift, false); // top1 0.780433 >= 0.70
});

// ---- 判据矩阵（合成，全部落年报口径以隔离新鲜度变量）----
const y = (name: string, ratio: number): ZygcfxRow => row('1', '2025-12-31 00:00:00', name, ratio);

Deno.test('判据矩阵：top1<0.70 时按 top2 分档（>=0.25 混合 / [0.10,0.25) 仅 shift / <0.10 双 false）', () => {
  const cases: [ZygcfxRow[], boolean, boolean][] = [
    [[y('a', 0.69), y('b', 0.30)], true, true],    // top2 恰在混合档
    [[y('a', 0.69), y('b', 0.25)], true, true],    // 边界 top2=0.25 含 → mixed
    [[y('a', 0.50), y('b', 0.249)], false, true],  // 边界 top2<0.25 → 仅 shift
    [[y('a', 0.50), y('b', 0.10)], false, true],   // 边界 top2=0.10 含 → shift
    [[y('a', 0.50), y('b', 0.099)], false, false], // top2<0.10 → 双 false
    [[y('a', 0.70), y('b', 0.29)], false, false],  // top1=0.70 含 → 单一主业优先于次大
    [[y('a', 0.95)], false, false],                // 单行业
  ];
  for (const [rows, mixed, shift] of cases) {
    const v = decide(rows, TODAY)!;
    assertEquals([v.mixed, v.shift], [mixed, shift], `${JSON.stringify(rows.map(r => r.MBI_RATIO))}`);
  }
});

Deno.test('边界 0.25 与 0.10 判定用未取整原值（segments 降序）', () => {
  const v = decide([y('c', 0.12), y('a', 0.68), y('b', 0.20)], TODAY)!;
  assertEquals(v.segments.map(s => s.ratio), [0.68, 0.20, 0.12]);
  assertEquals([v.mixed, v.shift], [false, true]); // top2=0.20 ∈[0.10,0.25)
});

Deno.test('空输入 / 无 MAINOP_TYPE=1 / 坏 ratio → null', () => {
  assertEquals(decide([], TODAY), null);
  assertEquals(decide([row('2', '2025-12-31 00:00:00', 'x', 0.5)], TODAY), null);
  assertEquals(decide([row('1', '2025-12-31 00:00:00', 'x', Number.NaN)], TODAY), null);
});

Deno.test('report_date 归一为 YYYY-MM-DD（剥离时间部分后入库）', () => {
  const v = decide(AOLAIDE, TODAY)!;
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(v.reportDate), true);
});
