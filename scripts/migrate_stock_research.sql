-- scripts/migrate_stock_research.sql — 产业研究员：stock_fundamental 建表 + RLS 成对迁移
-- 规则权威: docs/superpowers/specs/2026-10-02-stock-research-design.md §5
-- 写法对齐 scripts/migrate_sector_rotation_rls.sql 先例：enable rowsecurity +
--   一条 permissive SELECT to anon, authenticated（I-1 补丁教训：只授 anon 会让登录用户 0 行）
--   + grant select + revoke 六种非读权限（M-6 教训：新表默认把 ALL 授给 anon/authenticated）。
-- 写路径：仅 service_role（BYPASSRLS，Edge Function svcHeaders 通道）。
-- 幂等：create table if not exists + drop policy if exists + create policy，可重复执行。
-- 执行方式：Management API POST /v1/projects/{ref}/database/query（见计划头「执行环境事实」）。

create table if not exists stock_fundamental (
  code        text not null,            -- 与 stocks.code 同口径（A股6位/港股5位）
  provider    text not null,            -- 'zhipu' | 'bailian'
  model       text not null,
  status      text not null,            -- 'running' | 'done' | 'failed'
  verdict     text,                     -- 升温|平稳|降温|恶化（状态标记，非建议）
  summary     text,                     -- 胶囊概要行（一句话）
  report      jsonb,                    -- 六段式 [{title, body}]，body 含来源标注
  sources     jsonb,                    -- [{title,url,date}] 去重后的来源清单
  error       text,                     -- failed 时的原因（经 sanitizeError，不含 key）
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (code)
);

alter table stock_fundamental enable row level security;
drop policy if exists "stock_fundamental anon read" on stock_fundamental;
drop policy if exists "stock_fundamental read" on stock_fundamental;
create policy "stock_fundamental read" on stock_fundamental for select to anon, authenticated using (true);
grant select on stock_fundamental to anon;
grant select on stock_fundamental to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_fundamental from anon, authenticated;
