// gs_etf_test.ts — GS「智能选股 ETF 筛选」filterSearch 适配器单测（brief Step 2）
// 纯解析（buildSegParams/parseSearchResp）零网络；fetchSegments 用可注入的 fake fetch（替换 globalThis.fetch），
// 不打真实网络。断言覆盖：全键参数、缺列→null、hayjqidu 空→Q 腿 null、触顶 truncated、
// 单段失败 warning、400ms pacing、并集 <300 → throw('MIN_ROWS')、错误信息不泄漏 apiKey。
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildSegParams, parseSearchResp, fetchSegments, MIN_ROWS, CAP, type EtfSnapRow } from './gs_etf.ts';

const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const KEY = 'FAKE_KEY_FOR_TEST_ONLY';

Deno.test('buildSegParams: 15 分段矩阵的键集逐字（不含 apiKey，不许多不少）', () => {
  const p = buildSegParams('10,30', '3');
  assertEquals(Object.keys(p).sort(), ['class1', 'endamt', 'orderCol', 'orderType', 'skillName', 'softName', 'temperRegion'].sort());
  assertEquals(p, {
    class1: '1',
    endamt: '10,30',
    temperRegion: '3',
    orderCol: 'nowrange',
    orderType: '0',
    softName: 'goldsun_skills',
    skillName: 'gs-etf-filter',
  });
  const q = buildSegParams('2,10', '5');
  assertEquals([q.endamt, q.temperRegion], ['2,10', '5']);
});

Deno.test('parseSearchResp: 真实响应片段 → 七字段接线；空 hayjqidu/空 sharpe1yrank → null', () => {
  const rows = parseSearchResp(fx('gs_etf_segment_sample.json'));
  assertEquals(rows.length, 6); // 5 真实行 + 1 合成行
  const first: EtfSnapRow = rows[0];
  assertEquals(first.code, '589120');
  assertEquals(first.name, '科创创新药ETF汇添富');
  assertEquals(first.amt, 10.94);
  assertEquals(first.tem, 3);
  assertEquals(first.r60, 0.23);
  assertEquals(first.sharpe, 59.9);
  assertEquals(first.hay, null); // hayjqidu 空串 → Q 腿 null（spec S4：当前无数据）
  const synth = rows[5];
  assertEquals([synth.code, synth.tem, synth.r60], ['512800', 1, -1.2]);
  assertEquals(synth.hay, '82.5'); // 有值 → 原样字符串（供 q 命中判定）
  assertEquals(synth.sharpe, null); // 空串 → null
});

Deno.test('parseSearchResp: 缺列/畸形 → 该列 null，绝不 NaN；非对象/无 data → []', () => {
  const rows = parseSearchResp({ result: [{ code: 0 }], data: [{ ofcode: '512800' }, { ofname: '无码' }] });
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { code: '512800', name: '', amt: null, tem: null, r60: null, sharpe: null, hay: null });
  assertEquals(rows[1].code, '');
  assertEquals(parseSearchResp(null), []);
  assertEquals(parseSearchResp({ data: 'oops' }), []);
  assertEquals(parseSearchResp({ result: [{ code: 197001 }], data: [{ ofcode: '512800' }] }), []); // 业务失败码
});

// ---- fetchSegments：fake fetch 注入（不落真实网络） ----
interface FakeCall { url: string; t: number }

function stubFetch(handler: (params: URLSearchParams, call: number) => unknown | Error) {
  const calls: FakeCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, t: Date.now() });
    const params = new URL(url).searchParams;
    const out = handler(params, calls.length - 1);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const segRows = (n: number, tag: string) => ({
  result: [{ code: 0 }],
  data: Array.from({ length: n }, (_, i) => ({
    ofcode: `${tag}${String(i).padStart(3, '0')}`, ofname: `${tag}ETF`, endamt: '12.3', temperRegion: '3',
    range60d: '1.5', sharpe1yrank: '50', hayjqidu: '',
  })),
});

Deno.test('fetchSegments: 15 段串行 + 400ms pacing + 触顶记 truncated（不硬退出）+ 单段失败记 warning 继续', async () => {
  const s = stubFetch((_p, i) => {
    if (i === 0) return segRows(CAP, 'A'); // 触顶：满 100 → truncated（C2：绝不 exit）
    if (i === 1 || i === 2) return new Error('boom'); // 第 2 段首发 + 重试均失败 → warning 继续
    return segRows(25, `S${i}`);
  });
  try {
    const t0 = Date.now();
    const r = await fetchSegments(KEY);
    assertEquals(r.truncated.length, 1);
    assertEquals(/2,10/.test(r.truncated[0]) && /temper/.test(r.truncated[0]), true, `truncated 需含分段标识, got=${r.truncated[0]}`);
    assertEquals(r.warnings.length >= 1, true);
    assertEquals(/重试|fail|error/i.test(r.warnings[0]) || r.warnings.some((w) => /重试|fail|error/i.test(w)), true);
    assertEquals(r.rows.size >= MIN_ROWS, true, `并集 ${r.rows.size} 应 ≥ ${MIN_ROWS}（触顶/失败段不得炸链）`);
    assertEquals(r.warnings.every((w) => !w.includes(KEY)), true, 'warning 不得泄漏 apiKey');
    // 串行 + pacing：15 段全部调用，相邻间隔 ≥350ms（400ms 名义值容忍定时器抖动）
    assertEquals(s.calls.length >= 15, true);
    const gaps: number[] = [];
    for (let i = 1; i < s.calls.length; i++) gaps.push(s.calls[i].t - s.calls[i - 1].t);
    assertEquals(Math.min(...gaps) >= 350, true, `pacing 违例 min gap=${Math.min(...gaps)}ms`);
    assertEquals(s.calls.every((c) => c.url.includes('apiKey=' + KEY) && c.url.includes('class1=1')), true);
    assertEquals(Date.now() - t0 >= 5_000, true, '15 段 × 400ms 串行 pacing 总耗时下限');
  } finally {
    s.restore();
  }
});

Deno.test('fetchSegments: 并集 <300 → throw MIN_ROWS（整轮异常，交编排层走 stale 降级）', async () => {
  const s = stubFetch(() => segRows(3, 'T'));
  try {
    let msg = '';
    try {
      await fetchSegments(KEY);
    } catch (e) {
      msg = String(e instanceof Error ? e.message : e);
    }
    assertEquals(msg.includes('MIN_ROWS'), true, `应抛 MIN_ROWS，实得 "${msg}"`);
    assertEquals(msg.includes(KEY), false, '错误信息不得泄漏 apiKey');
    s.restore();
  } finally {
    s.restore();
  }
});
