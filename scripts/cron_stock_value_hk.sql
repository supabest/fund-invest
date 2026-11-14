-- stock-value-hk nightly: runs daily at 21:50 Beijing (13:50 UTC), 5 min after A 股 stock-value 21:45
-- 无数据依赖（不读 stock_value、不读主分），错开只为避免 GS 并发限流（spec §6）
-- 令牌用 $DAILY_UPDATE_TOKEN 占位，**不得**把真值写入本文件；执行后不得 select job.command（含 Bearer 原值）
-- timeout_milliseconds 必须显式给：pg_net 0.20.4 默认 5000ms 会把响应掐断，
-- net._http_response 恒 status_code=NULL 而 cron.job_run_details 恒 succeeded（http_post 只是入队）
-- ⇒ 调度侧永远看不见函数成败。A 股 2026-10-16 已踩过，同口径取 300000ms。
-- ⚠ 注册需用户明示（Task 8）。
select cron.schedule('stock-value-hk-nightly', '50 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value-hk',
    headers := jsonb_build_object('Authorization','Bearer $DAILY_UPDATE_TOKEN','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);
