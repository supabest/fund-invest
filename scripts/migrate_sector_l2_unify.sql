-- scripts/migrate_sector_l2_unify.sql —— 板块轮动行业口径统一至同花顺二级行业（L2）
-- 源真相: scripts/sector_l2_map.ts IND_TO_L2（102 条：71 保留 → 38 个 L2 板块，31 组剔除）。勿手改本文件映射，改归属请改 IND_TO_L2 后用 tmp 生成器重出。
-- 执行方式: Management API /database/query（同 migrate_sector_prosperity.sql）；事务，可幂等重复执行。
-- 影响面: 仅 sector_etf_map（宇宙表）。历史批次 sector_rotation_daily 一字不改（计划 §5 处理 A：09-30 旧名批次不改不删，10-09 新批次自然取代）。
begin;

-- ① 删除「无单一 L2 父级、用户 2026-10-04 裁定剔除」的 31 个原板块下全部 ETF 行
delete from public.sector_etf_map where canonical_ind in (
  '大宗商品',
  '电子',
  '高端制造',
  '互联网',
  '科创新材料',
  '科创医药',
  '科技',
  '矿业',
  '能源',
  '农业',
  '生物医药',
  '石化',
  '石油',
  '碳中和',
  '消费',
  '新能源',
  '新能源车',
  '信息技术',
  '信息科技',
  '央企创新',
  '央企改革',
  '央企科技',
  '央企能源',
  '医疗创新',
  '医药',
  '油气',
  '战略新兴',
  '长江保护',
  '智能驾驶',
  '智能汽车',
  '资源'
);

-- ② 保留板块改名至同花顺 L2（temp 映射表 JOIN，单条 UPDATE 用快照匹配、不会二次链式改名）
create temp table l2_unify_map(old_ind text, new_l2 text) on commit drop;
insert into l2_unify_map (old_ind, new_l2) values
  ('家电', '白色家电'),
  ('半导体设备', '半导体'),
  ('科创创业人工智能', '半导体'),
  ('科创人工智能', '半导体'),
  ('科创芯片', '半导体'),
  ('科创芯片设计', '半导体'),
  ('人工智能', '半导体'),
  ('数字经济', '半导体'),
  ('绿色电力', '电力'),
  ('工业有色', '工业金属'),
  ('光伏', '光伏设备'),
  ('黄金股', '贵金属'),
  ('化工', '化学制品'),
  ('创新药', '化学制药'),
  ('科创创新药', '化学制药'),
  ('环保', '环境治理'),
  ('计算机', '计算机设备'),
  ('建材', '建筑材料'),
  ('基建', '建筑装饰'),
  ('船舶', '军工装备'),
  ('国防', '军工装备'),
  ('航空航天', '军工装备'),
  ('航天', '军工装备'),
  ('军工', '军工装备'),
  ('通用航空', '军工装备'),
  ('卫星', '军工装备'),
  ('旅游', '旅游及酒店'),
  ('煤炭', '煤炭开采加工'),
  ('汽车', '汽车整车'),
  ('创业板软件', '软件开发'),
  ('大数据', '软件开发'),
  ('金融科技', '软件开发'),
  ('软件', '软件开发'),
  ('信创', '软件开发'),
  ('云计算', '软件开发'),
  ('生物科技', '生物制品'),
  ('疫苗', '生物制品'),
  ('酒', '食品饮料'),
  ('电信', '通信服务'),
  ('创业板人工智能', '通信设备'),
  ('创业板算力', '通信设备'),
  ('通信', '通信设备'),
  ('传媒', '文化传媒'),
  ('稀土', '小金属'),
  ('稀有金属', '小金属'),
  ('有色', '小金属'),
  ('畜牧养殖', '养殖业'),
  ('农牧渔', '养殖业'),
  ('养殖', '养殖业'),
  ('医疗', '医疗服务'),
  ('医疗设备', '医疗器械'),
  ('金融', '银行'),
  ('金融地产', '银行'),
  ('粮食', '种植业与林业'),
  ('工业母机', '自动化设备'),
  ('机床', '自动化设备'),
  ('机器人', '自动化设备');
update public.sector_etf_map s set canonical_ind = m.new_l2
  from l2_unify_map m where s.canonical_ind = m.old_ind;

-- ③ 每 L2 组仅 amt 最大者为代表（并列按 etf_code 升序，可重现）；其余降为非代表
update public.sector_etf_map s set is_rep = (
  s.etf_code = (
    select s2.etf_code from public.sector_etf_map s2
    where s2.canonical_ind = s.canonical_ind
    order by s2.amt desc nulls last, s2.etf_code asc limit 1
  )
);

commit;

-- 校验（执行后单独跑，预期：板块 38 / 代表 38 / 宇宙 340）：
-- select count(distinct canonical_ind) as inds, count(*) filter (where is_rep) as reps, count(*) as etfs from public.sector_etf_map;
