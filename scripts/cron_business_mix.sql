-- business-mix batch: runs daily at 22:00 Beijing (14:00 UTC), after stock-score 21:30.
-- Low-frequency C-layer: rotates 300 pool codes/night by oldest updated_at (missing-first),
-- reads 东财 F10 主营构成 (MAINOP_TYPE='1' 国标行业), upserts stock_business_mix.
-- stock-score reads that table NEXT night (mix is slow-changing → order is decoupled on purpose:
-- 东财 fetch latency must never delay the critical scoring path).
-- Registered 2026-09-28 via Management API, jobid=8, schedule '0 14 * * *'.
-- NOTE: <DAILY_UPDATE_TOKEN> is a placeholder — the live cron.job stores the real secret.
select cron.schedule('business-mix-batch', '0 14 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/business-mix?mode=run',
    headers := jsonb_build_object('Authorization','Bearer <DAILY_UPDATE_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb
  ) as req_id$$);
