-- scripts/migrate_sector_xinchuang.sql —— 信创键改判：半导体 → 软件开发（2026-10-05 增量修正）
-- 缘起：IND_TO_L2['信创'] 原按 CN5075(国证信创, 芯片化) 证据归半导体；但本宇宙实际两只信创 ETF
--       华夏562570 跟踪中证信创，前十软件多数派(深信服/三六零/恒生/金山/广联达 ~22% > 存储半导体 ~19%)
--       ⇒ 改判归 软件开发。映射权威已改 scripts/sector_l2_map.ts；本文件是其在「已跑过
--       migrate_sector_l2_unify.sql 的生产库」上的增量落地（生产已把 信创 改名并入 半导体，
--       无法靠重跑整表迁移回退，只能定点移这两只 + 重算受影响两组的代表）。
-- 影响面：仅 sector_etf_map。板块总数不变(38)，只 半导体 69→67、软件开发 28→30；两 ETF 体量小
--       (4.03/2.06 亿)，撼不动任一组代表，重算后 reps 仍为 38。历史 sector_rotation_daily 不动。
-- 执行方式：Management API /database/query。事务，幂等可重跑（第二次移 0 行、重算等值）。
begin;

-- ① 把 2026-10-04 全量迁移里被并入 半导体 的 2 只信创 ETF 改归 软件开发
update public.sector_etf_map
   set canonical_ind = '软件开发'
 where etf_code in ('562570', '159540');

-- ② 重算受影响两组的代表（组内 amt 最大者为代表，并列按 etf_code 升序，可重现）
update public.sector_etf_map s set is_rep = (
  s.etf_code = (
    select s2.etf_code from public.sector_etf_map s2
    where s2.canonical_ind = s.canonical_ind
    order by s2.amt desc nulls last, s2.etf_code asc limit 1
  )
)
where s.canonical_ind in ('半导体', '软件开发');

commit;

-- 校验（执行后单独跑，预期：板块 38 / 代表 38 / 宇宙 340；半导体 67 只 / 软件开发 30 只；
--       两只信创 ETF 现属 软件开发 且非代表；半导体 rep 仍 588200，软件开发 rep 仍 159852 软件ETF嘉实）：
-- select canonical_ind, count(*) n, count(*) filter(where is_rep) reps
--   from public.sector_etf_map where canonical_ind in ('半导体','软件开发') group by 1;
