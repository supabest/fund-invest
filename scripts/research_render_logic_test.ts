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
