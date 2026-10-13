-- stock-value nightly: runs daily at 21:45 Beijing (13:45 UTC), 15 min after stock-score 21:30
-- 依赖：stock-score 当晚批次（价值腿要读它的主分快照）；business-mix 22:00 在价值腿之后，不影响（主分腿才吃 mix）
-- 令牌用 $DAILY_UPDATE_TOKEN 占位，**不得**把真值写入本文件；执行后不得 select job.command（含 Bearer 原值）
-- 注册 2026-10-13（Task 10 Step 8；jobid 与复核结果见 .superpowers/sdd/2026-10-11-stock-value-leg/progress.md）
select cron.schedule('stock-value-nightly', '45 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value',
    headers := jsonb_build_object('Authorization','Bearer $DAILY_UPDATE_TOKEN','Content-Type','application/json'),
    body := '{}'::jsonb
  ) as req_id$$);
