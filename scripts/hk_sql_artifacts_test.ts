// scripts/hk_sql_artifacts_test.ts — 两份 SQL 产物的静态门禁（不连库、不执行）
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const read = (n: string) => Deno.readTextFile(new URL(`./${n}`, import.meta.url));

Deno.test('迁移：表名/主键/索引与 spec §4 逐字一致', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(s.includes('create table if not exists stock_value_hk ('), true);
  assertEquals(s.includes('primary key (batch_date, code)'), true);
  assertEquals(s.includes('create index if not exists stock_value_hk_batch_idx on stock_value_hk (batch_date);'), true);
  assertEquals(s.includes('drop table if exists stock_value_hk;'), true, '缺回滚语句');
});

Deno.test('迁移：列集合与 toHkDbRow 逐字对齐（多一列少一列都会让整批 insert 报错或静默丢字段）', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  const body = s.slice(s.indexOf('create table if not exists stock_value_hk ('), s.indexOf('primary key (batch_date, code)'));
  // 不加 ^ 锚：迁移里 `roic_cur numeric, roic_med numeric, roic_min3 numeric` 三个列共用一行（照 spec §4 原样），
  // 行首锚只会捞到每行第一列 ⇒ 12 列被数成 8 列，这条守卫会假红。
  const cols = [...body.matchAll(/([a-z_0-9]+)\s+(?:date|text|numeric|boolean|jsonb)\b/g)].map(m => m[1]);
  assertEquals(cols, ['batch_date', 'code', 'name', 'roic_cur', 'roic_med', 'roic_min3', 'div_yield', 'div_yield_5y', 'pe', 'pb', 'roic_ok', 'extras']);
});

Deno.test('迁移：roic_ok 是可空 boolean（三态），且**不得**有 rf_fallback / margin_of_safety / tier', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(/roic_ok boolean,/.test(s), true, 'roic_ok 必须可空：med=null 时落 null 而非 false');
  assertEquals(/roic_ok boolean not null/.test(s), false);
  // 只在 CREATE TABLE 的列定义里找禁用列名，并先剥掉行内注释：文件头部的说明性注释正当地提到
  // rf_fallback / tier / vq / confidence（解释「为什么不设」），全文扫会恒红。
  const body = s.slice(s.indexOf('create table if not exists stock_value_hk ('), s.indexOf('primary key (batch_date, code)'))
    .replace(/--[^\n]*/g, '');
  for (const k of ['rf_fallback', 'margin_of_safety', 'tier', 'vq', 'confidence', 'owner_yield', 'cn10y'])
    assertEquals(body.includes(k), false, `港股不算安全边际/门禁，不该有 ${k} 列（spec §4）`);
});

Deno.test('迁移：RLS 照 A 股同一范式——只读策略 + grant select + revoke 六项写权限', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  assertEquals(s.includes('alter table stock_value_hk enable row level security;'), true);
  assertEquals(s.includes('create policy "stock_value_hk read" on stock_value_hk for select to anon, authenticated using (true);'), true);
  assertEquals(s.includes('grant select on stock_value_hk to anon;'), true);
  assertEquals(s.includes('grant select on stock_value_hk to authenticated;'), true);
  assertEquals(s.includes('revoke insert, update, delete, truncate, references, trigger on stock_value_hk from anon, authenticated;'), true);
  assertEquals(/create policy .* for (insert|update|delete|all)/.test(s), false, '写路径必须靠「无写策略即拒绝」关闭');
});

Deno.test('迁移：不得触碰 A 股表（spec §11）', async () => {
  const s = await read('migrate_stock_value_hk.sql');
  // `(if not exists )?` 必须在内：最可能的手滑正是 `create table if not exists stock_value`，
  // 少了这一段该形态就溜过守卫。`stock_value\b` 的 \b 在 `_hk` 前不成立 ⇒ 新表名不会误命中。
  assertEquals(/(alter|drop|create|insert into|update|delete from)\s+(table\s+)?(if\s+not\s+exists\s+)?stock_value\b(?!_hk)/.test(s), false, '不得改 stock_value');
  assertEquals(s.includes('value_config'), false);
});

Deno.test('cron：job 名/时刻/URL/超时与 spec §6 一致', async () => {
  const s = await read('cron_stock_value_hk.sql');
  assertEquals(s.includes("select cron.schedule('stock-value-hk-nightly', '50 13 * * *',"), true);
  assertEquals(s.includes('https://sfauluwxmdginezbluvo.supabase.co/functions/v1/stock-value-hk'), true);
  assertEquals(s.includes('timeout_milliseconds := 300000'), true, 'pg_net 默认 5000ms 会把响应掐断，调度侧永远看不见成败');
  assertEquals(s.includes("body := '{}'::jsonb"), true);
});

Deno.test('cron：令牌只用占位符，文件里不得出现真值形态', async () => {
  const s = await read('cron_stock_value_hk.sql');
  assertEquals(s.includes('Bearer $DAILY_UPDATE_TOKEN'), true);
  assertEquals(/\$DAILY_UPDATE_TOKEN/.test(s), true);
  // 真值形态：Bearer 后跟一长串非占位符的字母数字（占位符以 $ 开头，不会命中）
  assertEquals(/Bearer\s+[A-Za-z0-9_\-]{20,}/.test(s), false, 'cron 文件里出现疑似真令牌');
  assertEquals(s.includes('不得') && s.includes('job.command'), true, '必须写明执行后不得 select job.command');
});
