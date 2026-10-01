-- scripts/reschedule_sector_trend_cron.sql — Task 3b-3: sector-trend nightly 错峰
-- 背景（Task 3 评审 D3 / 遗留项）：pg_cron job 9 `sector-trend-nightly` 原 schedule '30 14 * * *'
--   （UTC 14:30 = 北京 22:30）与 job 6 `fund-daily-2230`（同为北京 22:30）撞同一分钟，
--   两函数并发拉起会争抢 edge worker / 连接池。本迁移只挪分钟，把 sector-trend 推迟 5 分钟到
--   北京 22:35（UTC 14:35），不改任何 job 的 SQL 载荷、不新建/删除 job。
-- 执行方式: Management API /database/query（同 scripts/migrate_v11.sql / cron_sector_trend.sql）。
-- 幂等：cron.alter_job 按 job_id 定位，只改 schedule（command/database/username 缺省 NULL=不动）。
-- 注意：不触碰 job 5/6/7/8 的 timeout（项目级维护隐患，见 task-3-report §13-3，本次不动）。
--
-- ⚠ 偏离 Task 3b 指令一处（必要修正）：brief 写的是 `select cron.reschedule(9, '35 14 * * *')`，
--   但本实例 pg_cron 未安装 `cron.reschedule`（pg_proc 里 cron schema 只有 schedule/unschedule/alter_job），
--   执行会 `ERROR 42883 function does not exist`。改用等价且保 jobid/command 的 `cron.alter_job`
--   （Supabase 现行 in-place 改 schedule 的手段）。另：`cron.reschedule(9, '35 14 * * *')` 这种
--   integer + 未加引号常量的位置参数写法即使函数存在也会因 unknown 类型推断失败，故用具名参数 + 显式类型。

select cron.alter_job(job_id := 9::bigint, schedule := '35 14 * * *'::text);

-- 核对（人工运维用）：
--   select jobid, jobname, schedule from cron.job order by jobid;
-- 回滚（如需恢复原错峰前状态）：
--   select cron.alter_job(job_id := 9::bigint, schedule := '30 14 * * *'::text);
