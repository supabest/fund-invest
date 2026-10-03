-- scripts/migrate_fix_polluted_industries.sql
-- 背景：sector_etf_map.canonical_ind 存在 8 个 ETF 产品名污染/政策主题（2026-10-03 实测坐实）。
--   根因：sector_normalize.extractInd 的 `|| s` 兜底把纯字母主题（5G/TMT）剥空后吐回含基金公司全名。
--   归一侧已由 sector_normalize.ts 修复（THEME_MERGE + 龙头族并入 + 央企结构调整剔除，见 2026-10-03 选B）。
--   本脚本修当前生产数据（nightly 只读 sector_etf_map，故必须同步）。
-- 前提已核验：7 只并入标的 amt 均 < 目标行业现有代表 amt，故现有 is_rep 全部不变，被并入者降为非代表。
-- 规则权威：spec §2.2；代表ETF口径=每行业 amt 最大者（build_universe 同）。
BEGIN;

-- 1) 真·产品名污染（含基金公司/字母）→ 归入语义行业，降为非代表
UPDATE sector_etf_map SET canonical_ind = '通信', is_rep = false, updated_on = current_date
 WHERE canonical_ind = '5GETF博时';      -- 159811 amt=2.03  → 通信(rep 515880/418.22 不变)

UPDATE sector_etf_map SET canonical_ind = '科技', is_rep = false, updated_on = current_date
 WHERE canonical_ind IN ('TMT50ETF招商', 'TMTETF景顺', '科技龙头');
                                          -- 159909/6.58, 512220/7.68, 516050/2.07 → 科技(rep 515000/39.59 不变)

-- 2) 龙头族（2026-10-03 选B 推翻 R1「龙头族维持分列」）→ 并入基础行业，降为非代表
UPDATE sector_etf_map SET canonical_ind = '光伏',   is_rep = false, updated_on = current_date
 WHERE canonical_ind = '光伏龙头';         -- 560980 amt=2.00  → 光伏(rep 515790/46.62 不变)
UPDATE sector_etf_map SET canonical_ind = '半导体', is_rep = false, updated_on = current_date
 WHERE canonical_ind = '半导体龙头';       -- 159665 amt=5.62  → 半导体(rep 588170/418.81 不变)
UPDATE sector_etf_map SET canonical_ind = '消费',   is_rep = false, updated_on = current_date
 WHERE canonical_ind = '消费龙头';         -- 516130 amt=10.45 → 消费(rep 159928/148.71 不变)

-- 3) 纯政策主题 → 移出宇宙（与已剔除的"央企"同类，512960 amt=54.96）
DELETE FROM sector_etf_map WHERE canonical_ind = '央企结构调整';

COMMIT;

-- 复核（执行后手工跑，应均为 0 行）：
--   SELECT canonical_ind, count(*) FROM sector_etf_map
--    WHERE canonical_ind ~ '[A-Za-z0-9]' OR canonical_ind LIKE '%龙头%'
--       OR canonical_ind LIKE '%ETF%' OR canonical_ind = '央企结构调整'
--    GROUP BY canonical_ind;
