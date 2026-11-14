// supabase/functions/stock-value-hk/hk_engine_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { HK_ROIC_GATE, roicStats3, computeHk, type HkRaw } from './hk_engine.ts';

// 夹具值取自 2026-11-14 GS HK_stock 实调（spec §2.4）。估值两数逐日漂移，这里只当形态样本。
const raw = (over: Partial<HkRaw> = {}): HkRaw => ({
  code: '00700', name: '腾讯控股', roic3: [10.5299, 15.8648, 15.8625],
  divYield: 0.8848080133555927, divY5y: 0.8381616844832607, pe: 13.078457, pb: 4.189377, ...over,
});

Deno.test('roicStats3：三年窗取中位与最差年（腾讯/阿里真实值）', () => {
  assertEquals(roicStats3([10.5299, 15.8648, 15.8625]), { med: 15.8625, min3: 10.5299 });
  assertEquals(roicStats3([6.4716, 6.909, 10.7987]), { med: 6.909, min3: 6.4716 });
});

Deno.test('roicStats3：负 ROIC 参与统计（九龙仓真实形态，最差年 −2.036）', () => {
  assertEquals(roicStats3([0.5646, -2.036, 0.0313]), { med: 0.0313, min3: -2.036 });
});

Deno.test('roicStats3：偶数期取中间两数均值；<2 期 med 与 min3 同生同死皆 null', () => {
  assertEquals(roicStats3([4, 10, null, null]), { med: 7, min3: 4 });
  assertEquals(roicStats3([9, null, null]), { med: null, min3: null });
  assertEquals(roicStats3([null, null, null]), { med: null, min3: null });
  assertEquals(roicStats3([]), { med: null, min3: null });
});

Deno.test('roicStats3：非有限值与 null 同待遇，不参与统计', () => {
  assertEquals(roicStats3([NaN, 12, Infinity, 6]), { med: 9, min3: 6 });
});

Deno.test('roic_ok 三态：med=null ⇒ null（不是 false）', () => {
  assertEquals(computeHk(raw({ roic3: [9, null, null] })).roicOk, null);
  assertEquals(computeHk(raw({ roic3: [null, null, null] })).roicOk, null);
});

Deno.test('8% 参照线：夹具离阈值留富余（浮点边界会让变异检验假活）', () => {
  assertEquals(HK_ROIC_GATE, 8);
  assertEquals(computeHk(raw({ roic3: [11, 12, 13] })).roicOk, true);    // med 12，高出 4pp
  assertEquals(computeHk(raw({ roic3: [3, 4, 5] })).roicOk, false);      // med 4，低 4pp
});

Deno.test('达标只看 med：cur 与 med 相互独立（阿里真实形态 cur 10.80 而 med 6.91 ⇒ 未达标）', () => {
  const r = computeHk(raw({ code: '09988', name: '阿里巴巴-W', roic3: [6.4716, 6.909, 10.7987] }));
  assertEquals(r.roicCur, 10.7987);
  assertEquals(r.roicMed, 6.909);
  assertEquals(r.roicMin3, 6.4716);
  assertEquals(r.roicOk, false);
});

Deno.test('只缺最新一期：roic_cur=null 而 med 照样有值，不得断言成无护城河证据', () => {
  const r = computeHk(raw({ roic3: [11, 13, null] }));
  assertEquals(r.roicCur, null);
  assertEquals(r.roicMed, 12);
  assertEquals(r.roicMin3, 11);
  assertEquals(r.roicOk, true);
  assertEquals(r.missing.includes('roic_cur'), true);
});

Deno.test('PE/PB ≤0 ⇒ null（亏损股 PE 无经济含义；PB≤0 不推断资不抵债）', () => {
  const r = computeHk(raw({ pe: -145.178781, pb: 0 }));
  assertEquals(r.pe, null);
  assertEquals(r.pb, null);
  assertEquals(r.missing.includes('pe'), true);
  assertEquals(r.missing.includes('pb'), true);
});

Deno.test('股息空值落 null 而非 0（港股未确认「空=从不分红」，spec §3.3）', () => {
  const r = computeHk(raw({ divYield: null, divY5y: null }));
  assertEquals(r.divYield, null);
  assertEquals(r.divY5y, null);
  assertEquals(r.missing.includes('div_yield'), true);
  assertEquals(r.missing.includes('div_yield_5y'), true);
});

Deno.test('missing 只列真缺的字段；齐备时为空数组；code/name 原样透传', () => {
  const r = computeHk(raw());
  assertEquals(r.missing, []);
  assertEquals(r.code, '00700');
  assertEquals(r.name, '腾讯控股');
});

Deno.test('门槛三处同值：港股引擎 = A 股引擎 = 前端常量（改一端必须改另两端）', async () => {
  const a = await Deno.readTextFile(new URL('../stock-value/value_engine.ts', import.meta.url));
  const m = /export const ROIC_GATE = (\d+(?:\.\d+)?)/.exec(a);
  assertEquals(m !== null, true, 'A 股引擎里找不到 ROIC_GATE');
  assertEquals(HK_ROIC_GATE, Number(m![1]), '港股引擎与 A 股引擎门槛漂移');
  const html = await Deno.readTextFile(new URL('../../../index.html', import.meta.url));
  const f = /var ROIC_GATE_PCT = (\d+(?:\.\d+)?);/.exec(html);
  assertEquals(f !== null, true, '前端找不到 ROIC_GATE_PCT');
  assertEquals(HK_ROIC_GATE, Number(f![1]), '港股引擎与前端门槛文案漂移');
});

Deno.test('隔离守卫：港股引擎不 import A 股模块、不做 ROE 替代（spec §5.2 / §3.2）', async () => {
  const src = await Deno.readTextFile(new URL('./hk_engine.ts', import.meta.url));
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '港股引擎不得 import A 股模块');
  // 港股不返回「股票市场类型」⇒ 无法识别金融股 ⇒ 不做 ROE 对标（ROE 与 ROIC 量纲不同源，
  // 拿它跟 8% 比等于造一个假比较）。引擎里连 roe 这个词都不该出现，缺数就走「无数据」。
  assertEquals(/roe/i.test(src), false, '不得引入 ROE 替代或按名字猜金融股');
});
