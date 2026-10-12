// index_test.ts — 覆盖 business-mix/index.ts 的分页读与 pickStaleCodes 接线
// （2026-10-12 用户裁定「三条腿一并修」：PostgREST `db-max-rows`=1000 的静默截断在同一条池读上复发）
// 真数据证据：池 1165 只 > 1000 ⇒ 裸 `?select=code` 每晚只回前 1000 只（按 code 升序），
// 第 1001 只往后的池成员**永远进不了「最旧优先补拉 300 只」的候选集**——不是慢，是静默饿死。
// 而 stock_business_mix 今晚 972 行、business-mix 每晚补 300 ⇒ 明夜就过 1000，第二处裸读同时开始丢数据。
// 先关 serve 守卫再动态 import（静态 import 会被提到 Deno.env.set 之前执行，import 即绑 8000 端口）。
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
Deno.env.set('BUSINESS_MIX_DISABLE_SERVE', '1');
const { readAllRows, readPoolSet, pickStaleCodes } = await import('./index.ts');

// 桩：按 offset 发页（页宽取第一页长度）；`prefers` 记录 Prefer 头——MP6 同款教训：
// 「不发 count=exact」这种缺陷桩子无法自行复现，只能把断言钉在**请求**上才杀得住。
function pageStub(pages: Record<string, unknown>[][], total: number, bad: 'none' | 'noTotal' | 'short' = 'none') {
  const offsets: number[] = [];
  const prefers: string[] = [];
  const width = pages[0].length;
  const get = (u: string, init?: RequestInit) => {
    const off = Number(new URL(u).searchParams.get('offset'));
    const rows = pages.find((_, i) => i * width === off) ?? [];
    offsets.push(off);
    prefers.push(String((init?.headers as Record<string, string> | undefined)?.['Prefer'] ?? ''));
    // 声明区间长度：`short` 时故意比实收多一行，用来验「声明 ≠ 实收」这条守卫真的在把关
    const declared = bad === 'short' ? rows.length - 1 : rows.length;
    const cr = bad === 'noTotal' ? null : `${off}-${off + declared - 1}/${total}`;
    return Promise.resolve({
      ok: true, status: 206,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-range' ? cr : null) },
      json: () => Promise.resolve(rows),
    });
  };
  return { get, offsets, prefers };
}
const codes = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ code: String(600000 + from + i) }));

Deno.test('readAllRows：1165 行分两页收齐、推进量=实收、每页都带 count=exact（复制体须与价值腿同判据）', async () => {
  const p = pageStub([codes(1000, 0), codes(165, 1000)], 1165);
  const rows = await readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get);
  assertEquals(rows.length, 1165);
  assertEquals(p.offsets, [0, 1000]);
  assertEquals(p.prefers, ['count=exact', 'count=exact']);
});

Deno.test('readAllRows：平台把页切得比 pageSize 小时仍按实收推进（500/500/165），不得静默少收', async () => {
  const p = pageStub([codes(500, 0), codes(500, 500), codes(165, 1000)], 1165);
  const rows = await readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get, 500);
  assertEquals(rows.length, 1165);
  assertEquals(p.offsets, [0, 500, 1000]);
});

Deno.test('readAllRows：无确定性 order= 直接拒；拿不到总数抛；声明区间≠实收抛', async () => {
  const p = pageStub([codes(10, 0)], 10);
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code', p.get), Error, 'order=');
  const q = pageStub([codes(1000, 0)], 1165, 'noTotal');
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', q.get), Error, 'Content-Range');
  const r = pageStub([codes(1000, 0), codes(165, 1000)], 1165, 'short');
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', r.get), Error, '实得');
});

Deno.test('readPoolSet：1165 只收齐且去重闭合', async () => {
  const ok = pageStub([codes(1000, 0), codes(165, 1000)], 1165);
  assertEquals((await readPoolSet('https://x.supabase.co', ok.get)).size, 1165);
  const dup = pageStub([[...codes(1000, 0), ...codes(165, 0)]], 1165);
  await assertRejects(() => readPoolSet('https://x.supabase.co', dup.get), Error, '去重');
});

// pickStaleCodes 的接线判据（本文件唯一钉「两条读都走分页」的测试）：
// 池 1165 只、mix 表 1100 行（>1000，两页），池中 601100..601164 这 65 只在 mix 里没行 ⇒ 必须排最前。
// 只读第一页的旧写法当场红：池候选缩到 600000..600999 → 那 65 只根本进不了排序，picked[0] 会变成 600800。
Deno.test('pickStaleCodes：池 1165 + mix 1100 都读全；缺失者优先、旧→新、并列按 code、截 BATCH=300', async () => {
  const pool = codes(1165, 0);                                            // 600000 .. 601164
  const mix = Array.from({ length: 1100 }, (_, i) => ({                   // 600000 .. 601099 有行
    code: String(600000 + i),
    updated_at: i < 800 ? '2026-10-01T00:00:00Z'                          // 600000..600799 新
      : i < 835 ? '2026-09-01T00:00:00Z'                                  // 600800..600834 最旧的 35 只
        : '2026-09-15T00:00:00Z',                                         // 600835..601099 次旧
  }));
  const p = pageStub([mix.slice(0, 1000), mix.slice(1000)], mix.length);
  const poolStub = pageStub([pool.slice(0, 1000), pool.slice(1000)], pool.length);
  const get = (u: string, init?: RequestInit) =>
    (u.includes('stock_business_mix') ? p.get(u, init) : poolStub.get(u, init));
  const picked = await pickStaleCodes('https://x.supabase.co', get);
  assertEquals(picked.length, 300);
  assertEquals(picked.slice(0, 65), Array.from({ length: 65 }, (_, i) => String(601100 + i)));   // 缺失优先（nullsfirst）
  assertEquals(picked[65], '600800');                                     // 缺失者只有 65 只 → 剩下的按「最旧优先」
  assertEquals(picked[99], '600834');
  assertEquals(picked[100], '600835');                                    // 09-01 批用完，接 09-15 批的 code 最小者
  assertEquals(poolStub.offsets, [0, 1000]);                              // 池确实读到了第二页
  assertEquals(p.offsets, [0, 1000]);                                     // mix 表也是（972→明夜>1000 的坑就此堵住）
});
