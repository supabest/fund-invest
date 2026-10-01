-- scripts/migrate_sector_rotation_rls.sql — Task 3b-2: 三张 sector_* 表 RLS 成对迁移
-- 背景（Task 3 评审 I-1 / D3 / D4）：sector_etf_map / sector_kline / sector_rotation_daily
--   建表时 RLS=false，且 Supabase 对 public schema 新表的默认权限把 anon/authenticated 授成 ALL，
--   等于前端暴露面可读可写。本迁移收口：开 RLS + 只放 anon 的 SELECT（读，Task 4 前端依赖），
--   写路径由 RLS「无写策略即拒绝」自动关闭；nightly 用 service_role（BYPASSRLS）不受影响。
-- 写法/命名对齐 scripts/migrate_v11.sql 的 `enable row level security` + `"<obj> anon read"` 策略 + `grant select ... to anon`。
-- 幂等：drop policy if exists + create policy，enable RLS 可重复执行；执行方式 Management API /database/query。

-- sector_etf_map
alter table sector_etf_map enable row level security;
drop policy if exists "sector_etf_map anon read" on sector_etf_map;
create policy "sector_etf_map anon read" on sector_etf_map for select to anon using (true);
grant select on sector_etf_map to anon;

-- sector_kline
alter table sector_kline enable row level security;
drop policy if exists "sector_kline anon read" on sector_kline;
create policy "sector_kline anon read" on sector_kline for select to anon using (true);
grant select on sector_kline to anon;

-- sector_rotation_daily
alter table sector_rotation_daily enable row level security;
drop policy if exists "sector_rotation_daily anon read" on sector_rotation_daily;
create policy "sector_rotation_daily anon read" on sector_rotation_daily for select to anon using (true);
grant select on sector_rotation_daily to anon;

-- 回滚（万一 anon 读取因策略组合失效，立即执行以下三条恢复原状，勿留半坏状态给 Task 4）：
--   drop policy if exists "sector_etf_map anon read" on sector_etf_map;         alter table sector_etf_map disable row level security;
--   drop policy if exists "sector_kline anon read" on sector_kline;             alter table sector_kline disable row level security;
--   drop policy if exists "sector_rotation_daily anon read" on sector_rotation_daily; alter table sector_rotation_daily disable row level security;
