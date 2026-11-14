// supabase/functions/stock-value-hk/index_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeHk, type HkRaw, type HkRow } from './hk_engine.ts';
Deno.env.set('STOCK_VALUE_HK_DISABLE_SERVE', '1');   // import 即绑端口 → 必须先关
const { heldHkCodes, readStates, toHkDbRow, buildHkDbRows, upsertHk, runHkSummary, errorHkBody } = await import('./index.ts');

const STAMPS = { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' };
const YEARS = ['2023', '2024', '2025'];
const raw: HkRaw = { code: '00700', name: '腾讯控股', roic3: [10.5299, 15.8648, 15.8625],
  divYield: 0.8848080133555927, divY5y: 0.8381616844832607, pe: 13.078457, pb: 4.189377 };
const row: HkRow = computeHk(raw);

// readStates 的注入接缝：只开 get 一个口，不重构整个 handler（同 A 股 upsert 的 post 先例）
const page = (rows: unknown[], range: string | null, ok = true, status = 200) => ({
  ok, status, headers: { get: (k: string) => (k.toLowerCase() === 'content-range' ? range : null) },
  json: () => Promise.resolve(rows),
});

Deno.test('heldHkCodes：只收 5 位纯数字，跨用户合并去重并排序', () => {
  const states = [
    { user_id: 'u1', data: { stocks: [{ code: '00700' }, { code: '600031' }, { code: '09988' }] } },
    { user_id: 'u2', data: { stocks: [{ code: '00700' }, { code: ' 00823 ' }] } },
  ];
  assertEquals(heldHkCodes(states), ['00700', '00823', '09988']);
});

Deno.test('heldHkCodes：非数组 / 缺字段 / 空代码一律跳过，不抛错', () => {
  assertEquals(heldHkCodes([null, undefined, {}, { data: null }, { data: { stocks: 'x' } }, { data: { stocks: [null, {}, { code: '' }, { code: '700' }] } }]), []);
  assertEquals(heldHkCodes([]), []);
});

Deno.test('readStates：单页取全量，Content-Range 自证总数', async () => {
  const rows = [{ user_id: 'u1', data: { stocks: [{ code: '00700' }] } }];
  const got = await readStates('https://x', (() => Promise.resolve(page(rows, '0-0/1'))) as never);
  assertEquals(got, rows);
});

Deno.test('readStates 守卫：单页被 db-max-rows 截断 ⇒ 抛错（持仓集合不完整，拒绝跑批）', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ user_id: `u${i}`, data: { stocks: [] } }));
  const err = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page(rows, '0-999/1165'))) as never));
  assertEquals(String(err).includes('单页被截断（实得 1000 / 总数 1165）'), true);
});

Deno.test('readStates 守卫：拿不到 Content-Range / 非 2xx ⇒ 抛错', async () => {
  const e1 = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page([], null))) as never));
  assertEquals(String(e1).includes('Content-Range 拿不到总数'), true);
  const e2 = await assertRejects(() => readStates('https://x', (() => Promise.resolve(page([], '0-0/1', false, 500))) as never));
  assertEquals(String(e2).includes('read dingtou_state: 500'), true);
});

Deno.test('toHkDbRow：列名逐字对齐迁移，roic_ok 三态原样落库，extras 三键', () => {
  const db = toHkDbRow(row, '2026-11-14', STAMPS, YEARS);
  assertEquals(db.batch_date, '2026-11-14');
  assertEquals(db.code, '00700');
  assertEquals(db.name, '腾讯控股');
  assertEquals(db.roic_cur, 15.8625);
  assertEquals(db.roic_med, 15.8625);
  assertEquals(db.roic_min3, 10.5299);
  assertEquals(db.div_yield, 0.8848080133555927);
  assertEquals(db.div_yield_5y, 0.8381616844832607);
  assertEquals(db.pe, 13.078457);
  assertEquals(db.pb, 4.189377);
  assertEquals(db.roic_ok, true);
  assertEquals(db.extras, { stamps: STAMPS, years: YEARS, missing: [] });
  // 港股不算安全边际 ⇒ 这些列必须**不存在**，而不是填 false/0 撒谎（spec §4）
  for (const k of ['rf_fallback', 'margin_of_safety', 'tier', 'vq', 'confidence', 'owner_yield', 'cn10y'])
    assertEquals(Object.prototype.hasOwnProperty.call(db, k), false, `不该有 ${k} 列`);
});

Deno.test('toHkDbRow：med 缺失 ⇒ roic_ok 落 null（三态），missing 列出缺值字段', () => {
  const db = toHkDbRow(computeHk({ ...raw, roic3: [9, null, null], divYield: null, pe: -1 }), '2026-11-14', STAMPS, YEARS);
  assertEquals(db.roic_med, null);
  assertEquals(db.roic_ok, null);
  assertEquals(db.pe, null);
  assertEquals((db.extras as { missing: string[] }).missing, ['roic_cur', 'roic_med', 'div_yield', 'pe']);
});

Deno.test('buildHkDbRows：逐行接线 stamps 与 years（漏接会让 extras 永远空）', () => {
  const rows = [row, computeHk({ ...raw, code: '09988', name: '阿里巴巴-W', roic3: [6.4716, 6.909, 10.7987] })];
  const dbs = buildHkDbRows(rows, '2026-11-14', STAMPS, YEARS);
  assertEquals(dbs.length, 2);
  assertEquals(dbs.map(d => d.code), ['00700', '09988']);
  assertEquals(dbs[1].roic_ok, false);
  for (const d of dbs) assertEquals((d.extras as { years: string[] }).years, YEARS);
});

Deno.test('upsertHk：URL 与 Prefer 正确，发出即报告（持仓个位数行 ⇒ 一次 POST，不分块）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  Deno.env.set('SB_SERVICE_KEY', 'svc');
  let reports = 0;
  const seen: { url: string; init: RequestInit }[] = [];
  await upsertHk([{ code: '00700' }], () => { reports++; }, ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve('') });
  }) as never);
  assertEquals(reports, 1);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, 'https://x/rest/v1/stock_value_hk?on_conflict=batch_date,code');
  assertEquals((seen[0].init.headers as Record<string, string>).Prefer, 'resolution=merge-duplicates');
  assertEquals((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer svc');
});

Deno.test('upsertHk：非 2xx 仍要报告已发出（PostgREST 可能已收下），且必须抛错', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  let reports = 0;
  const err = await assertRejects(() => upsertHk([{ code: '00700' }], () => { reports++; },
    (() => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') })) as never));
  assertEquals(reports, 1);
  assertEquals(String(err).includes('upsert stock_value_hk 502'), true);
  assertEquals(errorHkBody(String(err), true).kept_old_batch, false);   // 已发出 ⇒ 不得再称旧批保留
});

Deno.test('upsertHk：空行集一次也不发（不能发空数组去把本批当作空覆掉）', async () => {
  Deno.env.set('SUPABASE_URL', 'https://x');
  await upsertHk([], () => { throw new Error('空批不应报告'); },
    (() => { throw new Error('空批不应发请求'); }) as never);
});

Deno.test('runHkSummary：三态计数 + missing_codes 列出零命中持仓（REIT 缺席必须可见）', () => {
  const rows = [row, computeHk({ ...raw, code: '09988', roic3: [6.4716, 6.909, 10.7987] }),
    computeHk({ ...raw, code: '00004', roic3: [9, null, null] })];
  const s = runHkSummary(rows, '2026-11-14', ['00004', '00700', '00823', '09988'], STAMPS, YEARS);
  assertEquals(s.ok, true);
  assertEquals(s.batch_date, '2026-11-14');
  assertEquals(s.rows, 3);
  assertEquals(s.held_hk, 4);
  assertEquals(s.roic_ok, 1);
  assertEquals(s.roic_fail, 1);
  assertEquals(s.roic_na, 1);
  assertEquals(s.missing_codes, ['00823']);
  assertEquals(s.stamps, STAMPS);
  assertEquals(s.years, YEARS);
});

Deno.test('errorHkBody：wrote 由实际写入过程回答，不得硬编', () => {
  assertEquals(errorHkBody('boom', false), { ok: false, error: 'boom', kept_old_batch: true });
  assertEquals(errorHkBody('boom', true).kept_old_batch, false);
});

Deno.test('接线守卫：无港股持仓的早返回必须在任何 GS 调用之前（spec §5 第2步）', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const skip = src.indexOf("skipped: 'no hk holdings'");
  const gs = src.indexOf('gsHkFetch(buildHkQ1');
  assertEquals(skip > 0, true, '缺 no hk holdings 早返回');
  assertEquals(gs > skip, true, '早返回必须在 GS 调用之前，否则空持仓夜也会发三次调用');
});

Deno.test('接线守卫：Deno.serve 被 DISABLE_SERVE 包住；鉴权与脱敏在位；不 import A 股模块', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(src.includes("if (!Deno.env.get('STOCK_VALUE_HK_DISABLE_SERVE')) {"), true, '测试无法 import（会绑端口）');
  assertEquals(src.includes("req.headers.get('Authorization') !== `Bearer ${token}`"), true, '缺 Bearer 鉴权');
  assertEquals(src.includes(".replace(/\\S*apiKey=\\S*/g, 'apiKey=REDACTED')"), true, '缺凭据脱敏');
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '不得 import A 股模块');
  assertEquals(src.includes('stock_value?'), false, '不得写 A 股表');
});
