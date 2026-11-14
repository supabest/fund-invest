-- scripts/migrate_stock_value_hk.sql — 港股价值评估降维口径 spec §4
-- 执行方式: Management API POST /v1/projects/{ref}/database/query（同 migrate_stock_value.sql 历史执行方式）
-- ⚠ 本 Task 只创建文件；执行迁移需用户明示（Task 8 统一执行，执行前后做只读侦察与结构验收）。

create table if not exists stock_value_hk (
  batch_date date not null,
  code text not null,              -- 5 位补零，与持仓/前端同形（00700 / 09988）
  name text,
  roic_cur numeric, roic_med numeric, roic_min3 numeric,
  div_yield numeric, div_yield_5y numeric,
  pe numeric, pb numeric,
  roic_ok boolean,                 -- med>=8；med 为 null 时此列为 null（三态，不是布尔两态）
  extras jsonb,                    -- { stamps: {roic,div_cur,div_5y,pe,pb → 日期戳原样}, years: ["Y-2","Y-1","Y"], missing: [缺值字段名] }
  primary key (batch_date, code)
);
create index if not exists stock_value_hk_batch_idx on stock_value_hk (batch_date);

comment on column stock_value_hk.roic_ok is '三态：med>=8 为 true、med<8 为 false、med 为 null 时此列亦为 null。把数据缺口写成 false 等于把「不知道」说成「无护城河证据」';
comment on column stock_value_hk.roic_cur is '最新年报 ROIC，与 roic_med 相互独立：只缺最新一期时此列 null 而 med 照样有值，达标判定只看 med';
comment on column stock_value_hk.div_yield is '最新年报股息率；空值落 null 而非 0——港股未确认「空=从不分红」，与 A 股 P-6 语义不同（spec §3.3）';
comment on column stock_value_hk.extras is 'stamps 按列各自记戳（PE/PB 可能不同戳，不做时点对齐）；years 是三年窗；missing 是缺值字段名';

-- 不设 rf_fallback / margin_of_safety / tier / vq / confidence：港股不算安全边际、不产门禁结论。
-- A 股 rf_fallback 是 not null 且无 default 的 fail-loudly 设计；港股该列**不存在**，而不是填 false 撒谎。
-- 这是选择新表而非复用 stock_value 的首要理由（spec §4）。

-- RLS：读面向 anon + authenticated；写路径由「无写策略即拒绝」关闭，nightly 走 service_role BYPASSRLS
alter table stock_value_hk enable row level security;
drop policy if exists "stock_value_hk anon read" on stock_value_hk;
drop policy if exists "stock_value_hk read" on stock_value_hk;
create policy "stock_value_hk read" on stock_value_hk for select to anon, authenticated using (true);
grant select on stock_value_hk to anon;
grant select on stock_value_hk to authenticated;
revoke insert, update, delete, truncate, references, trigger on stock_value_hk from anon, authenticated;

-- 回滚（不留半坏状态给前端）：drop table if exists stock_value_hk;
