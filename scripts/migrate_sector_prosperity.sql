-- scripts/migrate_sector_prosperity.sql — 行业景气度展示 spec 2026-10-03 §7
-- 执行方式: Management API /database/query（同 migrate_sector_rotation.sql 历史执行方式）
-- 幂等：add column if not exists，可重复执行；纯附加列，score/v/m/l/q 一字不动。
alter table public.sector_rotation_daily add column if not exists prosperity numeric;
alter table public.sector_rotation_daily add column if not exists prosperity_src text;
comment on column public.sector_rotation_daily.prosperity is
  '行业景气度 0..100（同花顺 L2 绝对基本面中位数跨行业百分位），null=未映射/主题/样本不足/取数失败；纯展示，绝不进 score';
comment on column public.sector_rotation_daily.prosperity_src is
  '归因来源：同花顺 L2 行业名，或 null（未命中）；供前端悬浮与调试透明';
