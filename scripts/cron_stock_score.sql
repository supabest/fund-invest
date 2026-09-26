-- stock-score nightly: runs daily at 21:30 Beijing (13:30 UTC), after daily-update 20:30
-- Registered 2026-09-27, jobid=7
select cron.schedule('stock-score-nightly', '30 13 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-score',
    headers := jsonb_build_object('Authorization','Bearer <DAILY_UPDATE_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb
  ) as req_id$$);
