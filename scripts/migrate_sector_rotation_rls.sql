-- scripts/migrate_sector_rotation_rls.sql — Task 3b-2: 三张 sector_* 表 RLS 成对迁移
-- 背景（Task 3 评审 I-1 / D3 / D4）：sector_etf_map / sector_kline / sector_rotation_daily
--   建表时 RLS=false，且 Supabase 对 public schema 新表的默认权限把 anon/authenticated 授成 ALL，
--   等于前端暴露面可读可写。本迁移收口：开 RLS + 只放 anon 的 SELECT（读，Task 4 前端依赖），
--   写路径由 RLS「无写策略即拒绝」自动关闭；nightly 用 service_role（BYPASSRLS）不受影响。
-- 写法/命名对齐 scripts/migrate_v11.sql 的 `enable row level security` + `"<obj> anon read"` 策略 + `grant select ... to anon`。
--
-- 【I-1 补丁 2026-10-01·Task 3b 评审 Important-1】首版只 `to anon`，实测 authenticated 角色可见 0 行；
--   而 index.html 共享同一 createClient（L520）且支持邮箱登录（L1982 signInWithPassword）⇒ 登录用户
--   请求带 JWT，PostgREST 判定 role=authenticated，策略不匹配 → sector 卡片「200 + 空数组」静默空白。
--   修正为 `to anon, authenticated`（CREATE POLICY 的角色列表不带括号），对齐前端只读展示表的既有惯例（pg_policies 实测：
--   stock_score / stock_pool 均为 {anon,authenticated} SELECT）。命名随之由 "<obj> anon read" 改 "<obj> read"，
--   并 drop 旧名策略避免 PERMISSIVE 叠加留下只授 anon 的残骸。仅放 SELECT，不新增任何写策略；并 revoke 首版遗留的 6 种非读 grant（Task 3b 评审 M-6：anon/authenticated 原持 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER），RLS 之外再补 ACL 层防越权）。
-- 幂等：drop policy if exists（新旧两名都 drop）+ create policy，enable RLS 可重复执行；执行方式 Management API /database/query。

-- sector_etf_map
alter table sector_etf_map enable row level security;
drop policy if exists "sector_etf_map anon read" on sector_etf_map;
drop policy if exists "sector_etf_map read" on sector_etf_map;
create policy "sector_etf_map read" on sector_etf_map for select to anon, authenticated using (true);
grant select on sector_etf_map to anon;
grant select on sector_etf_map to authenticated;
revoke insert, update, delete, truncate, references, trigger on sector_etf_map from anon, authenticated;

-- sector_kline
alter table sector_kline enable row level security;
drop policy if exists "sector_kline anon read" on sector_kline;
drop policy if exists "sector_kline read" on sector_kline;
create policy "sector_kline read" on sector_kline for select to anon, authenticated using (true);
grant select on sector_kline to anon;
grant select on sector_kline to authenticated;
revoke insert, update, delete, truncate, references, trigger on sector_kline from anon, authenticated;

-- sector_rotation_daily
alter table sector_rotation_daily enable row level security;
drop policy if exists "sector_rotation_daily anon read" on sector_rotation_daily;
drop policy if exists "sector_rotation_daily read" on sector_rotation_daily;
create policy "sector_rotation_daily read" on sector_rotation_daily for select to anon, authenticated using (true);
grant select on sector_rotation_daily to anon;
grant select on sector_rotation_daily to authenticated;
revoke insert, update, delete, truncate, references, trigger on sector_rotation_daily from anon, authenticated;

-- 回滚（万一 anon 读取因策略组合失效，立即执行以下三条恢复原状，勿留半坏状态给 Task 4）：
--   drop policy if exists "sector_etf_map read" on sector_etf_map;                alter table sector_etf_map disable row level security;
--   drop policy if exists "sector_kline read" on sector_kline;                    alter table sector_kline disable row level security;
--   drop policy if exists "sector_rotation_daily read" on sector_rotation_daily;  alter table sector_rotation_daily disable row level security;
