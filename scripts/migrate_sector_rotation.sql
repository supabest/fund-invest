-- scripts/migrate_sector_rotation.sql — 板块轮动三表 spec §3.1
-- 执行方式: Management API /database/query（同 scripts/migrate_v11.sql 历史执行方式，2026-09-30）
create table if not exists sector_etf_map (
  etf_code text primary key, etf_name text not null,
  canonical_ind text not null, amt numeric,
  is_rep boolean default false, updated_on date
);
create table if not exists sector_kline (
  etf_code text, trade_date date, close numeric not null, volume numeric,
  primary key (etf_code, trade_date)
);
create table if not exists sector_rotation_daily (
  batch_date date, ind text, pk_etf text, n_etf int,
  close numeric, ma20 numeric, ma60 numeric, ma120 numeric,
  m20 numeric, m60 numeric, pos52 numeric, dev60 numeric,
  vr numeric, mp numeric, dm20 numeric,
  state text, labels text[], score numeric,
  v numeric, m numeric, l numeric, q numeric,
  theme text, stale boolean default false,
  primary key (batch_date, ind)
);
