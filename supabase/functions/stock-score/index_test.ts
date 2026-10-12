// index_test.ts — 只覆盖 index.ts 抽出的两个纯 helper（编排主体是 Deno.serve+网络，沿用 V1.0 惯例不单测）
// 先关 serve 守卫再动态 import，避免 import 即绑 8000 端口
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeScores } from './engine.ts';
import { mergeTables } from './gs.ts';
Deno.env.set('STOCK_SCORE_DISABLE_SERVE', '1');
const { applyWarnConf, buildRevealExtras, readAllRows, readPoolSet, pickPoolView, fetchMixMap } = await import('./index.ts');
// fixture 路径锚定到本测试文件目录 → CWD 无关（与 gs_test.ts 同模式，无网络）
const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

Deno.test('buildRevealExtras: 正常化PE近似 = pe*(1+gm/100) 两位取整；mix 前二分项+报告期+shift', () => {
  const segs = [{ name: 'A', ratio: 0.5 }, { name: 'B', ratio: 0.3 }, { name: 'C', ratio: 0.2 }];
  const e = buildRevealExtras({ pe: 30, gm: 20 }, { code: '688378', mixed: true, shift: true, segments: segs, report_date: '2025-12-31' });
  assertEquals(e.implied_normal_pe_approx, 36);
  assertEquals((e.mix as { segments: unknown[] }).segments, segs.slice(0, 2));
  assertEquals((e.mix as { report_date: string }).report_date, '2025-12-31');
  assertEquals((e.mix as { shift: boolean }).shift, true);
});

Deno.test('buildRevealExtras: gm≤0 / gm null / pe null → PE 位 null；无 mix 行 → mix null', () => {
  assertEquals(buildRevealExtras({ pe: 30, gm: -5 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 0 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: null }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: null, gm: 20 }).implied_normal_pe_approx, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 20 }, null).mix, null);
  assertEquals(buildRevealExtras({ pe: 30, gm: 20 }, { code: '1' }).mix, { segments: null, report_date: null, shift: false });
});

Deno.test('applyWarnConf: 仅 A→B；B/C 不动；无警示不动；键按全码匹配', () => {
  const rows = [
    { code: '688378.SH', confidence: 'A' as const },
    { code: '000338.SZ', confidence: 'B' as const },
    { code: '600031.SH', confidence: 'C' as const },
    { code: '000001.SZ', confidence: 'A' as const },
  ];
  const warnings = new Map<string, string[]>([
    ['688378.SH', ['单年扣非+150%，需查3年CAGR/周期位置']],
    ['000338.SZ', ['x']], ['600031.SH', ['x']],
    ['688378', []], // bare code 命中不了全码键；且空数组不算警示
  ]);
  applyWarnConf(rows, warnings);
  assertEquals(rows.map(r => r.confidence), ['B', 'B', 'C', 'A']);
});

// C-1 引擎契约（终审回归护栏）：现金腿必须真正进入 Quality——
// 同一宇宙、仅 cash 有无不同 → 目标股 quality 必须变化。若 cash 腿未接入（index.ts 忘记传 cashT），
// 生产批次里所有 s.cash 恒 null；本测试钉住引擎 §4.3 cash 腿参与的契约，wiring 另由下方 mergeTables 3 参测试兜底。
Deno.test('C-1 引擎契约：cash 腿进入 Quality（有 cash vs 无 cash → 目标股 quality 不同）', () => {
  const base = [1, 2, 3, 4, 5, 6].map(i => ({
    code: `60000${i}.SH`, name: `测试${i}`, ths: ['测试业', '测试子'],
    roe: 5 + i, mlr: 20 + i, kc: 10 + i, gm: 8 + i, rev: 15 + i, debt: 40, pe: 20 + i,
    isFin: false, isST: false, r60: i, close: 10 + i, a20: 9 + i, a60: 8 + i,
    cash: null as number | null,
  }));
  // 目标 600001 设 roe/mlr 最低、cash 最高 → cash 分位与 roe/mlr 分位背离，接入后 quality 必然改变
  const cashSeq = [2.0, 1.5, 1.2, 1.0, 0.8, 0.6];
  const rowsA = computeScores(base.map((s, i) => ({ ...s, cash: cashSeq[i] })));
  const rowsB = computeScores(base.map(s => ({ ...s, cash: null })));
  const qa = rowsA.find(r => r.code === '600001.SH')!.quality;
  const qb = rowsB.find(r => r.code === '600001.SH')!.quality;
  assertEquals(qa !== null, true);
  assertEquals(qb !== null, true);
  assertEquals(qa !== qb, true, 'cash 腿应进入 Quality：接入前后 quality 必须不同');
});

// C-1 wiring 兜底：index.ts 生产用 mergeTables(fin,mom,cashT) 3 参——用 fixtures 断言第 3 参确实把 cash 灌进 Stock。
Deno.test('C-1 wiring：mergeTables 3 参（cash fixture）→ 至少一只股票 cash 非 null', () => {
  const stocks = mergeTables(fx('fin_sample.json'), fx('mom_sample.json'), fx('cash_sample.json'));
  assertEquals(stocks.some(s => s.cash != null), true);
});

// ==== 2026-10-12：PostgREST `db-max-rows`=1000 静默截断（与价值腿同型缺陷，用户裁定「三条腿一并修」）====
// 证据不是推演：重跑价值腿后直查得 `stock_score` 今晚 `in_pool` 标记数正好 **1000**，而池 1165 只、
// 宇宙中对得上的是 1116 只 → 116 只池内股的 `in_pool`/池内分位是假阴性（价值腿的 `main_missing=116` 就是它的回声）。
// 分页算法本体在 `stock-value/index.ts` 已有 MP1–MP8 变异检验；本腿要钉的是**接线**：
// 池成员与 mix 表都必须经 readAllRows，不得再回到裸 `?select=code`。
// （上面已把这 3 个符号并进动态 import：静态 import 会被提到 `Deno.env.set` 之前执行，当场把整套测试带倒）

// 桩：按 offset 发页；`prefers` 记录每次请求的 Prefer 头（MP6 同款教训——「不发 count=exact」只能钉在请求上才杀得住）
function pageStub(pages: Record<string, unknown>[][], total: number, bad: 'none' | 'noTotal' | 'http500' = 'none') {
  const offsets: number[] = [];
  const prefers: string[] = [];
  const get = (u: string, init?: RequestInit) => {
    const off = Number(new URL(u).searchParams.get('offset'));
    offsets.push(off);
    prefers.push(String((init?.headers as Record<string, string> | undefined)?.['Prefer'] ?? ''));
    if (bad === 'http500') {
      return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve([]) });
    }
    const rows = pages.find((_, i) => i * pages[0].length === off) ?? [];
    const cr = bad === 'noTotal' ? null : `${off}-${off + rows.length - 1}/${total}`;
    return Promise.resolve({
      ok: true, status: 206,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-range' ? cr : null) },
      json: () => Promise.resolve(rows),
    });
  };
  return { get, offsets, prefers };
}
const codes = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ code: String(600000 + from + i) }));

Deno.test('readAllRows：1165 行分两页收齐（不是只回第一页的 1000），推进量=实收，每页都带 count=exact', async () => {
  const p = pageStub([codes(1000, 0), codes(165, 1000)], 1165);
  const rows = await readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get as never);
  assertEquals(rows.length, 1165);
  assertEquals(p.offsets, [0, 1000]);
  assertEquals(p.prefers, ['count=exact', 'count=exact']);
});

Deno.test('readAllRows：平台把页切得比 pageSize 小时仍按实收推进（500/500/165），不得静默少收', async () => {
  const p = pageStub([codes(500, 0), codes(500, 500), codes(165, 1000)], 1165);
  const rows = await readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get as never, 500);
  assertEquals(rows.length, 1165);
  assertEquals(p.offsets, [0, 500, 1000]);
});

Deno.test('readAllRows：Content-Range 拿不到总数 → 抛（不得退回「拿到多少算多少」）', async () => {
  const p = pageStub([codes(1000, 0)], 1165, 'noTotal');
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get as never),
    Error, 'Content-Range');
});

Deno.test('readAllRows：非 2xx → 抛；params 缺确定性 order= → 直接拒（不重不漏的前提）', async () => {
  const p = pageStub([codes(10, 0)], 10, 'http500');
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code&order=code.asc', p.get as never), Error, '500');
  const q = pageStub([codes(10, 0)], 10);
  await assertRejects(() => readAllRows('https://x.supabase.co', 'stock_pool', 'select=code', q.get as never), Error, 'order=');
});

Deno.test('readPoolSet：1116 只收齐且去重闭合（Set 静默吞重复 → 两个数不等就抛）', async () => {
  const ok = pageStub([codes(1000, 0), codes(116, 1000)], 1116);
  const set = await readPoolSet('https://x.supabase.co', ok.get as never);
  assertEquals(set.size, 1116);
  const dup = pageStub([[...codes(1000, 0), ...codes(116, 0)]], 1116);   // 第二页把前面的码又发来一次
  await assertRejects(() => readPoolSet('https://x.supabase.co', dup.get as never), Error, '去重');
});

Deno.test('fetchMixMap：mix 表过 1000 行也要读全（今晚 972，business-mix 每晚补 300 → 明夜必越线）；失败仍静默空 Map', async () => {
  const mk = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({
    code: String(600000 + from + i), mixed: true, shift: false, segments: null, report_date: '2025-12-31',
  }));
  const p = pageStub([mk(1000, 0), mk(200, 1000)], 1200);
  const map = await fetchMixMap('https://x.supabase.co', p.get as never);
  assertEquals(map.size, 1200);
  assertEquals(map.get('600000')?.mixed, true);
  const bad = pageStub([mk(10, 0)], 10, 'http500');
  assertEquals((await fetchMixMap('https://x.supabase.co', bad.get as never)).size, 0);   // C 层尽力而为的旧语义不变
});

// pickPoolView 钉的是「池读的接线」：本腿缺陷的生产后果（尾部 116 只 in_pool 假阴性）发生在消费点，
// 而消费点若留在 handler 里，MS6（把 readPoolSet 换成裸 fetch）能溜过全部测试——2026-10-12 实测存活过。
Deno.test('pickPoolView：池读必须走分页——第 1001 只往后的 in_pool 不得是假阴性；池内 Top10 与标记同源', async () => {
  const pool = pageStub([codes(1000, 0), codes(165, 1000)], 1165);        // 600000..601164 分两页
  const scored = Array.from({ length: 1166 }, (_, i) => ({ code: `${600000 + i}.SH`, final: 50 }));
  const v = await pickPoolView(scored, 'https://x.supabase.co', pool.get as never);
  assertEquals(v.inPool('600000.SH'), true);                              // 第一页
  assertEquals(v.inPool('601164.SH'), true);                              // 第二页尾部——裸读在这里必返 false
  assertEquals(v.inPool('601165.SH'), false);                             // 真不在池里的才是 false
  assertEquals(scored.filter(r => v.inPool(r.code)).length, 1165);        // 全池一个不漏（=1000 即为截断复发）
  assertEquals(v.top.length, 10);
  assertEquals(v.top[0].code, '600000.SH');                               // 入参顺序即 Top 顺序（handler 传 scored）
  assertEquals(pool.offsets, [0, 1000]);                                  // 确实读到第二页
});
