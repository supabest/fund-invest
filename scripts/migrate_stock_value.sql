-- scripts/migrate_stock_value.sql — 个股价值腿 spec §8（修订 A1/A4 见 plans/2026-10-11-stock-value-leg.md）
-- 执行方式: Management API POST /v1/projects/{ref}/database/query（同 migrate_v11.sql 历史执行方式）
-- ⚠ 本 Task 只创建文件；执行迁移需用户明示（Task 10 统一执行）。

create table if not exists stock_value (
  batch_date date not null, code text not null, name text,
  ths_l1 text, ths_l2 text, in_pool boolean not null default false,
  -- 原始指标（GS 直取；单位见计划头「单位口径」）
  roic_cur numeric, fcff numeric, mktcap numeric, pe numeric, pb numeric,
  cash numeric, debt numeric, gw_pct numeric, div_yield numeric, div_yield_5y numeric,
  -- 派生比率（引擎产出；只用比率，不落绝对额供跨期比较 — P-4）
  roic_med numeric, roic_min3 numeric, ic numeric,
  fcf_yield numeric, ep numeric, bm numeric, norm_yield numeric,
  net_cash_ratio numeric, debt_ratio numeric,
  owner_yield numeric, margin_of_safety numeric, cn10y numeric, rf_fallback boolean not null,
  -- 排序层与判定
  vq numeric, v_moat numeric, v_cash numeric, v_safety numeric, v_health numeric,
  vcov numeric, tier text, confidence char(1),
  vetoed boolean not null, veto_reasons jsonb, flags jsonb,
  ind_rank integer, ind_n integer, market_rank integer, market_n integer,
  pool_rank integer, pool_n integer,   -- 池内分位（spec §7.1/§7.4 的「池内 P」）。终审 I-3：market_n 是全市场有效分行数（5000+），此前被标成「池内 P」是错名
  main_final numeric, main_confidence text,   -- 当晚 V1.1 主分快照（spec §8：半年后复盘免 join，不受主引擎改版断裂）
  extras jsonb,                                -- 全部 GS 列日期戳 + ic_approx + 告警
  primary key (batch_date, code)
);
create index if not exists stock_value_batch_tier_idx on stock_value (batch_date, tier);
create index if not exists stock_value_batch_vq_idx on stock_value (batch_date, vq desc);

comment on column stock_value.ic is '投入资本 = 货币资金 + 带息债务（近似，spec §4.1；extras.ic_approx=true 时成立）';
comment on column stock_value.margin_of_safety is 'owner_yield − cn10y（pp）；cn10y 缺失时为 null 且 rf_fallback=true';
comment on column stock_value.rf_fallback is '降级尺子标记；故意 not null 且无 default——漏写该列会让整批 insert 直接报错（fail loudly），而不是静默存成 false 把“口径不一致”伪装成“口径一致”';

create table if not exists value_config (
  id integer primary key default 1 check (id = 1),
  cn10y_override numeric,      -- 百分数（1.85 = 1.85%）；null = 不覆盖自动取数
  cn10y_manual_on date,
  updated_at timestamptz not null default now()
);
insert into value_config (id) values (1) on conflict (id) do nothing;

-- RLS：读面向 anon + authenticated（修订 A4）；写路径由「无写策略即拒绝」关闭，nightly 走 service_role BYPASSRLS
alter table stock_value enable row level security;
drop policy if exists "stock_value anon read" on stock_value;
drop policy if exists "stock_value read" on stock_value;
create policy "stock_value read" on stock_value for select to anon, authenticated using (true);
grant select on stock_value to anon;
grant select on stock_value to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_value from anon, authenticated;

alter table value_config enable row level security;
drop policy if exists "value_config anon read" on value_config;
drop policy if exists "value_config read" on value_config;
create policy "value_config read" on value_config for select to anon, authenticated using (true);
grant select on value_config to anon;
grant select on value_config to authenticated;
revoke insert, update, delete, truncate, references, trigger on value_config from anon, authenticated;

-- 回滚（不留半坏状态给前端）：drop table if exists stock_value; drop table if exists value_config;
