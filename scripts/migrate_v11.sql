-- scripts/migrate_v11.sql — V1.1 增补 spec §4.7/§5.3
-- 执行方式: Management API /database/query（2026-09-27）
alter table stock_score add column if not exists confidence char(1);

create table if not exists stock_business_mix (
  code text primary key,
  report_date text,
  segments jsonb,          -- [{name, ratio}] 按国标行业 MAINOP_TYPE='1'
  mixed boolean not null default false,
  shift boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table stock_business_mix enable row level security;
drop policy if exists "mix anon read" on stock_business_mix;
create policy "mix anon read" on stock_business_mix for select to anon using (true);
grant select on stock_business_mix to anon;
