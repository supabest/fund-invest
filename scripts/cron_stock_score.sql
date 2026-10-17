-- stock-score nightly: runs daily at 21:30 Beijing (13:30 UTC), after daily-update 20:30
-- Registered 2026-09-27, jobid=7
-- 2026-10-16 补 timeout_milliseconds（cron_sector_trend.sql 当时已记下本条属既有隐患、只改了它自己）：
-- pg_net 默认 5000ms < 本函数批次时长 ⇒ 响应在 5s 被掐断，net._http_response 恒 status_code=NULL，
-- 而 cron 侧恒 succeeded。取 300000ms 与 sector-trend 同口径；仍为 fire-and-forget。
select cron.schedule('stock-score-nightly', '30 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-score',
    headers := jsonb_build_object('Authorization','Bearer <DAILY_UPDATE_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);
