import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import * as P from "./research_render_logic.ts";

const done = { status:'done', verdict:'降温', summary:'需求走弱', started_at:'2026-10-02T07:00:00Z', finished_at:'2026-10-02T07:05:00Z',
  report:[{title:'需求',body:'…'},{title:'供给',body:'…'},{title:'价格与盈利',body:'…'},{title:'竞争格局与扩产',body:'…'},{title:'管理层与市场信号',body:'…'},{title:'结论与温度',body:'…'}],
  sources:[{title:'纪要',url:'https://x.com/a',date:'2026-08-29'}], provider:'zhipu', model:'glm-5.3-flash', error:null };
const NOW = Date.parse('2026-10-02T07:30:00Z');

Deno.test("researchPillHtml: 无记录→空串（非研究股不放灰胶囊，spec §8）", () => {
  assertEquals(P.researchPillHtml(null), '');
});
Deno.test("researchPillHtml: 四态温度各配色 + running/failed 文案", () => {
  assertEquals(P.researchPillHtml(done).includes('rp-cool'), true);
  assertEquals(P.researchPillHtml(done).includes('降温'), true);
  assertEquals(P.researchPillHtml({...done, verdict:'恶化'}).includes('rp-bad'), true);
  assertEquals(P.researchPillHtml({status:'running'}).includes('研究中'), true);
  assertEquals(P.researchPillHtml({status:'failed', error:'数据获取失败（智谱：HTTP 401）'}).includes('研究失败'), true);
});
Deno.test("researchPillHtml: title 属性带研究时间；XSS 纪律——summary 经 escapeHtml", () => {
  const evil = {...done, summary:'<img src=x onerror=alert(1)>'};
  const html = P.researchPillHtml(evil);
  assertEquals(html.includes('<img'), false);
  assertEquals(html.includes('&lt;img'), true);
});
Deno.test("researchReportHtml: 六段全渲+来源链接+免责行「不构成买卖建议」", () => {
  const html = P.researchReportHtml(done);
  for (const s of done.report) assertEquals(html.includes(s.title), true);
  assertEquals(html.includes('https://x.com/a'), true);
  assertEquals(html.includes('不构成买卖建议'), true);
  assertEquals(P.researchReportHtml(null), '');
});
Deno.test("researchRetryDisabled: done<1h 禁点、>1h 可点；failed/running/无记录可点（falsy 自查：0/空串≠缺省）", () => {
  assertEquals(P.researchRetryDisabled(done, NOW), true);                    // 25min
  assertEquals(P.researchRetryDisabled(done, NOW + 2*3600_000), false);      // 2h
  assertEquals(P.researchRetryDisabled({...done, finished_at:null}, NOW), false); // falsy 陷阱：null 不得算「<1h」
  assertEquals(P.researchRetryDisabled({status:'failed'}, NOW), false);
  assertEquals(P.researchRetryDisabled({status:'running'}, NOW), true);
  assertEquals(P.researchRetryDisabled(null, NOW), false);
});
Deno.test("cred 脱敏摘要：只显示尾4位，绝不回显全 key", () => {
  const m = P.researchCredMasked({provider:'zhipu', key:'sk-abcdef123456'});
  assertEquals(m.includes('sk-abcdef123456'), false);
  assertEquals(m.includes('3456'), true);
  assertEquals(m.includes('智谱'), true);
});
Deno.test("researchCredGet/Set：无 sessionStorage 环境（node/沙箱）try/catch 静默降级 null", () => {
  assertEquals(P.researchCredGet(), null); // Deno 测试环境无 sessionStorage，不得 throw
});

// —— 「记住 Key」：本机 localStorage opt-in 存储（用户 2026-10-02 批准；零远端零固化，仅限本浏览器）——
// 坑（实测取证）：Deno 自带**持久化** localStorage（-A 下跨运行保留），且其 setter 会静默吞掉
// `globalThis.localStorage = fake` 赋值（getter 总返回真实 Storage）→ 必须用 defineProperty 换掉访问器并在 finally 还原描述符。
// deno-lint-ignore no-explicit-any
function withLocalStorageStub(stub: any, body: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: stub });
  try { body(); } finally { Object.defineProperty(globalThis, 'localStorage', orig); }
}
function fakeLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
}
Deno.test("credLocal：存储访问抛异常（隐私模式/权限拒绝）→ 静默 null 不抛", () => {
  withLocalStorageStub({ getItem(){ throw new Error('denied'); }, setItem(){ throw new Error('denied'); }, removeItem(){ throw new Error('denied'); } }, () => {
    assertEquals(P.researchCredLocalGet('zhipu'), null);
    assertEquals(P.researchCredLocalMasked('zhipu'), null);
    P.researchCredLocalSet('zhipu', 'sk-x'); // 不得 throw
    P.researchCredLocalClear('zhipu');
  });
});
Deno.test("credLocal：set/get 往回 + 两服务商隔离 + clear + masked 仅尾4位", () => {
  withLocalStorageStub(fakeLocalStorageStub(), () => {
    assertEquals(P.researchCredLocalGet('zhipu'), null);
    P.researchCredLocalSet('zhipu', 'sk-zp-1234');
    P.researchCredLocalSet('bailian', 'sk-bl-9876');
    assertEquals(P.researchCredLocalGet('zhipu'), 'sk-zp-1234');
    assertEquals(P.researchCredLocalGet('bailian'), 'sk-bl-9876'); // 各记各的
    assertEquals(P.researchCredLocalMasked('zhipu'), '智谱 ····1234');
    assertEquals(P.researchCredLocalMasked('bailian'), '阿里百炼 ····9876');
    P.researchCredLocalClear('zhipu');
    assertEquals(P.researchCredLocalGet('zhipu'), null);
    assertEquals(P.researchCredLocalGet('bailian'), 'sk-bl-9876'); // 清除不串家
  });
});
Deno.test("credLocal：原型链键（constructor/toString）→ null，不被 inherited 值骗过", () => {
  withLocalStorageStub(fakeLocalStorageStub(), () => {
    assertEquals(P.researchCredLocalGet('constructor'), null);
    assertEquals(P.researchCredLocalGet('toString'), null);
  });
});
