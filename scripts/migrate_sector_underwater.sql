-- scripts/migrate_sector_underwater.sql — sector_rotation_daily 增「回撤时长上下文」两列（2026-10-07）
-- 执行方式: Management API /database/query（同 migrate_sector_rotation.sql / migrate_sector_prosperity.sql 历史执行方式）
-- 语义：与景气度同级的「仅上下文展示、绝不进 score/排序」指标，帮用户判断某板块自最近一次
--       250 日窗口高点以来已水下多久、距该高点回撤多少（吸收自外部「ETF 回撤—修复时间」研究的
--       时间维度，但用我方 2019 起多年 K 线自算，非小样本预测）。
--   • underwater_days: 距最近一次 250 日窗口高点的交易日间隔。0 = 正处窗口新高；
--                      NULL = 代表ETF 样本 <250 根、窗口高点未成形（同 pos52 留空口径，绝不用部分窗口冒充）。
--   • drawdown_pct   : 最新收盘距该窗口高点的回撤（比率，负值，如 -0.25 = -25%）；NULL 同上。
-- 幂等：整体可重复执行（add column if not exists），对已存在表仅新增两列。
-- 部署顺序：本迁移须先于（或随）sector-trend 函数重部署执行——函数写库会带这两列，
--          列不存在时 PostgREST upsert 会报 unknown column。

alter table public.sector_rotation_daily add column if not exists underwater_days integer;
alter table public.sector_rotation_daily add column if not exists drawdown_pct numeric;

comment on column public.sector_rotation_daily.underwater_days is
  '距最近一次 250 日窗口高点的交易日数；0=创新高、NULL=样本<250 窗口未成形；仅上下文展示，不进 score/排序';
comment on column public.sector_rotation_daily.drawdown_pct is
  '最新收盘距该窗口高点的回撤比率（负值，-0.25=-25%）；NULL=窗口未成形；仅上下文展示';
