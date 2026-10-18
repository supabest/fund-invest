-- fund-daily-2230: daily-update 每日 22:30 北京（14:30 UTC）—— 拉基金净值/股票收盘/指数行情 + 逐用户邮件报告。
-- 与 sector-trend 同一时刻错峰：本任务排 14:30 UTC 与 sector-trend（35 14 * * *）相隔 5 分钟。
-- 历史：原计划 20:30 北京（12:30 UTC）跑，后改 22:30 以等 A 股/场外基金净值落定；jobid=6（生产库既有定义）。
-- 本文件是模板而非首次注册脚本：token 是占位符，真实值只存在生产库的 cron.job 里（勿把真值粘回仓库）。
-- 2026-10-16 与其余 cron 模板同口径补 timeout_milliseconds := 300000（pg_net 默认 5000ms 会在批次中途掐断响应，
-- 表现为 net._http_response.status_code 恒 NULL 而 cron 侧恒 succeeded）。
-- 幂等：重复执行会新建同名 job —— 先确认不存在（select * from cron.job where jobname='fund-daily-2230'），
-- 已存在要改时间用 cron.alter_job(job_id := <id>, schedule := '...')。
select cron.schedule('fund-daily-2230', '30 14 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/daily-update',
    headers := jsonb_build_object('Authorization','Bearer <DAILY_UPDATE_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);
