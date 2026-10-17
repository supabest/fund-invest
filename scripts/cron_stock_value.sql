-- stock-value nightly: runs daily at 21:45 Beijing (13:45 UTC), 15 min after stock-score 21:30
-- 依赖：stock-score 当晚批次（价值腿要读它的主分快照）；business-mix 22:00 在价值腿之后，不影响（主分腿才吃 mix）
-- 令牌用 $DAILY_UPDATE_TOKEN 占位，**不得**把真值写入本文件；执行后不得 select job.command（含 Bearer 原值）
-- 注册 2026-10-13（Task 10 Step 8；jobid 与复核结果见 .superpowers/sdd/2026-10-11-stock-value-leg/progress.md）
-- 2026-10-16 补 timeout_milliseconds：pg_net 0.20.4 默认 5000ms，而本函数全量一轮 ~20-30s
-- ⇒ 响应被在 5s 掐断，net._http_response 恒为 status_code=NULL + “Timeout of 5000 ms reached”，
-- 而 cron.job_run_details 恒 succeeded（http_post 只是入队）⇒ 调度侧永远看不见函数成败。
-- 与 cron_sector_trend.sql 同口径取 300000ms；修的是观测，cron 仍是 fire-and-forget，不会变成同步等待。
select cron.schedule('stock-value-nightly', '45 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value',
    headers := jsonb_build_object('Authorization','Bearer $DAILY_UPDATE_TOKEN','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);
