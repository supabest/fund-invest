-- daily_update_run：daily-update 每次运行的台账（2026-10-28）
-- 用途：pg_cron 丢弃响应体、Edge console 无抽取通道，被 150s 墙钟砍掉的那晚只剩 status='running'，
--       断点位置即证据。函数侧 upsert on_conflict=run_at，写失败自吞，绝不影响邮件交付。
-- 口径与同族观测表一致（index_history）：RLS 开、只给 authenticated 读；写入走 service_role 绕过 RLS。
CREATE TABLE IF NOT EXISTS public.daily_update_run (
  run_at       timestamptz NOT NULL,
  status       text        NOT NULL,
  force        boolean     NOT NULL DEFAULT false,
  users        integer,
  ms_total     integer,
  timings      text,
  funds_ok     integer,
  funds_fail   integer,
  stocks_ok    integer,
  stocks_fail  integer,
  index_ok     integer,
  index_fail   integer,
  mail_sent    integer,
  mail_failed  integer,
  error        text,
  errors       text,
  PRIMARY KEY (run_at)
);

-- 2026-10-28 B：errors 装逐条失败原因（基金/股票/指数，截断到 1200 字），只有计数的那版查不到"为什么挂"。
-- 表已在生产存在 ⇒ CREATE IF NOT EXISTS 不会补列，必须先跑这条再部署函数：
-- PostgREST 对未知列整条 upsert 报 42703，函数侧虽自吞，但当晚台账会一行不落。
ALTER TABLE public.daily_update_run ADD COLUMN IF NOT EXISTS errors text;

CREATE INDEX IF NOT EXISTS daily_update_run_status_run_at
  ON public.daily_update_run (status, run_at DESC);

ALTER TABLE public.daily_update_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authed select" ON public.daily_update_run;
CREATE POLICY "authed select" ON public.daily_update_run
  FOR SELECT TO authenticated USING (true);
