-- sector-trend nightly：行业ETF板块轮动 22:30 北京 = 14:30 UTC（spec §6，daily-update 20:30 / stock-score 21:30 / business-mix 22:00 之后）
-- 模式同 scripts/cron_stock_score.sql（pg_cron + pg_net fire-and-forget 触发 edge function）
--
-- ⚠ 本文件是【模板】，不入库任何真实凭据（控制者裁决 C6）：
--    注册时把 <SECTOR_TREND_TOKEN> 替换为 secrets 里的真值（本地存 ~/.config/sector-rotation/sector_trend_token，repo 外 0600），
--    替换动作只在内存里做，替换后的 SQL 不落任何文件、不进 stdout/报告/git。
--
-- 偏离 brief Step 4 一处（必要修正，报告「偏离」章节有记录）：
--    pg_net 0.20.4 的 net.http_post timeout_milliseconds 默认 5000ms，而本函数全量一轮 ~40-90s
--    （110×腾讯 0.3s pacing + 15×GS 分段），照抄 brief 会让每晚的 HTTP 客户端在 5 秒就断开、
--    net._http_response 只留下 timed_out=true 的空响应，无法核对结果。故显式放宽到 300000ms。
--    （cron_stock_score.sql 同样未设该参数，属既有隐患，本次不改它。）
select cron.schedule('sector-trend-nightly', '30 14 * * *',
  $$select net.http_post(
    url := 'https://sfauluwxmdginezbluvo.supabase.co/functions/v1/sector-trend',
    headers := jsonb_build_object('Authorization','Bearer <SECTOR_TREND_TOKEN>','Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) as req_id$$);

-- 核对 / 撤销（人工运维用，勿自动执行）
-- select jobid, jobname, schedule, active from cron.job order by jobid;
-- select id, status_code, timed_out, error_msg, left(content, 500) as content_head, created
--   from net._http_response order by id desc limit 5;
-- select cron.unschedule('sector-trend-nightly');
