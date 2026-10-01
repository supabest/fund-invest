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
  bars_n integer,          -- 全新建表时一并带上（下方 ALTER 负责已存在表的增量补齐）
  primary key (batch_date, ind)
);

-- 终审 Important-2：bars_n 列 —— 代表ETF当日可用 K 线根数（engine SectorRow.barsN 原样落库）。
-- 语义：engine 对 barsN<250 的行业会把 m20/m60/dev60 兜底为 0（Task2-M5），库内伪 0 与「真实平盘 0」
-- 无法区分；bars_n 是下游第二个消费方（日报/回测）唯一的免歧判别器：bars_n<21 ⇒ m20 不可算，
-- bars_n<61 ⇒ m60/dev60 不可算（阀值取 engine 实际公式），bars_n<250 ⇒ pos52/dm20 相关标签留空。
-- 幂等：本文件整体可重复执行（create if not exists + add column if not exists），对已存在表仅新增一列。
alter table public.sector_rotation_daily add column if not exists bars_n integer;
comment on column public.sector_rotation_daily.bars_n is
  '代表ETF当日可用 K 线根数（0..N）；区分样本不足的 0 兜底与真实平盘 0：<21 m20 不可算、<61 m60/dev60 不可算、<250 pos52/标签留空（数据积累中）';
