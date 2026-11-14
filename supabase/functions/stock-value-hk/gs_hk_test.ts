// supabase/functions/stock-value-hk/gs_hk_test.ts
// 夹具 = 2026-11-14 GS HK_stock 实调原始切片（spec §2.4/§2.5）。键序保持响应原样（乱序），
// 因为「按字典序取首个」正是 A 股踩过的绑错列陷阱；ROIC 是字符串、估值是数字，num() 两种都要收。
import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  HK_Q2, HK_Q3, buildHkQ1, hkYearAnchors, stripHkPrefix, hkCodeOf,
  colByPrefix, windowCols, annualCols, intervalAvgCols, assertHkCols, mergeHkTables, type GsHkTable,
} from './gs_hk.ts';

const thrownMessage = (fn: () => unknown): string => (assertThrows(fn) as Error).message;
const fx = (n: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url))) as GsHkTable;
const NOW = new Date('2026-11-14T13:50:00Z');   // 合成时钟：annualBase=2025，测试不随挂钟腐烂
const HELD = new Set(['00700', '09988']);
const merge = (t1 = fx('hk_q1_sample.json'), t2 = fx('hk_q2_sample.json'), t3 = fx('hk_q3_sample.json'), held = HELD) =>
  mergeHkTables(t1, t2, t3, held, NOW);
// 删掉某表里的一行（模拟 H-7 单码缺席），列名与键序不变
const dropRow = (t: GsHkTable, code: string): GsHkTable => {
  const j = (t['股票代码'] as string[]).indexOf(code);
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) out[k] = (t[k] as (string | number | null)[]).filter((_, i) => i !== j);
  return out;
};
const renameKey = (t: GsHkTable, from: string, to: string): GsHkTable => {
  const out: GsHkTable = {};
  for (const k of Object.keys(t)) out[k === from ? to : k] = t[k];
  return out;
};

Deno.test('查询串措辞：HK_Q1 只由 annualBase 拼装，HK_Q2/HK_Q3 逐字锁定（spec §2.1）', () => {
  assertEquals(hkYearAnchors(new Date('2026-03-01')).annualBase, 2024);   // 1-4 月年报未披露完，锚前年
  assertEquals(hkYearAnchors(new Date('2026-05-01')).annualBase, 2025);
  assertEquals(buildHkQ1(2025), '全部港股的2023年报投入资本回报率、2024年报投入资本回报率、2025年报投入资本回报率、股票简称');
  assertEquals(HK_Q2, '全部港股的股息率、近5年股息率平均值、股票简称');
  assertEquals(HK_Q3, '全部港股的市盈率、市净率、股票简称');
});

Deno.test('H-6 剥前缀：财务/估值列剥 港股@，简称与代码不带前缀则原样', () => {
  const s = stripHkPrefix(fx('hk_q1_sample.json'));
  assertEquals(Object.keys(s).sort(), ['投入资本回报率[20231231]', '投入资本回报率[20241231]', '投入资本回报率[20251231]', '股票代码', '股票简称'].sort());
  assertEquals(s['股票简称'], fx('hk_q1_sample.json')['股票简称']);
});

Deno.test('剥前缀撞名 ⇒ 抛错（两列静默合并成一列比炸批危险）', () => {
  assertMatch(thrownMessage(() => stripHkPrefix({ '港股@股票简称': ['a'], '股票简称': ['b'] })), /column collision after prefix strip: 股票简称/);
});

Deno.test('H-6 代码补零：0700.HK→00700、9988.HK→09988；非港股形态一律 null，不猜', () => {
  assertEquals(hkCodeOf('0700.HK'), '00700');
  assertEquals(hkCodeOf('9988.HK'), '09988');
  assertEquals(hkCodeOf('700'), '00700');
  // 九龙仓真实码是 00004：GS 去了前导零回 '0004.HK'，补零到 5 位得 '00004'（不是 '0004'）。
  // 夹具里另外两只同理：'0062.HK'→'00062'（载通）、'0046.HK'→'00046'（科联系统）。
  assertEquals(hkCodeOf('0004.HK'), '00004');
  assertEquals(hkCodeOf('0062.HK'), '00062');
  assertEquals(hkCodeOf('600031.SH'), null);
  assertEquals(hkCodeOf('600031'), null);      // 6 位 = A 股，不是港股
  assertEquals(hkCodeOf(''), null);
  assertEquals(hkCodeOf(null), null);
});

Deno.test('§2.5 陷阱 1：当期股息率靠「标签最短」胜出，不是靠中文后缀拒绝；键序颠倒也不变', () => {
  const b = stripHkPrefix(fx('hk_q2_sample.json'));
  const cur = '股息率(股票获利率)[20251231]', avg = '股息率(股票获利率)平均[20211231-20251231]';
  // 两个标签都能通过「拒绝中文后缀」规则（别名 (股票获利率) 挡在 平均 前面）
  assertEquals(/^[\u4e00-\u9fff]/.test('股息率(股票获利率)平均'.slice('股息率'.length)), false);
  assertEquals(colByPrefix(b, '股息率'), cur);
  const reversed: GsHkTable = {};
  for (const k of Object.keys(b).reverse()) reversed[k] = b[k];
  assertEquals(colByPrefix(reversed, '股息率'), cur);
  assertEquals(colByPrefix({ [avg]: [1] }, '股息率'), avg);   // 只剩兄弟列时仍会命中 ⇒ 守卫必须另立形态判据
});

Deno.test('§2.5 陷阱 2：5 年平均列是区间戳，annualCols 天然拒它，intervalAvgCols 才收', () => {
  const b = stripHkPrefix(fx('hk_q2_sample.json'));
  assertEquals(annualCols(b, '股息率', true), ['股息率(股票获利率)[20251231]']);
  assertEquals(intervalAvgCols(b, '股息率'), ['股息率(股票获利率)平均[20211231-20251231]']);
});

Deno.test('年报列按戳升序 = 时间升序（真实夹具键序是 2024→2023→2025，字典序取首个会绑错）', () => {
  const a = stripHkPrefix(fx('hk_q1_sample.json'));
  assertEquals(windowCols(a, '投入资本回报率'), ['投入资本回报率[20231231]', '投入资本回报率[20241231]', '投入资本回报率[20251231]']);
  assertEquals(annualCols(a, '投入资本回报率', true).map(k => k.slice(-9, -1)), ['20231231', '20241231', '20251231']);
});

Deno.test('§2.5 陷阱 3：市盈率(pe,ttm) / 市净率(pb) 的括号别名以非中文开头 ⇒ colByPrefix 收', () => {
  const c = stripHkPrefix(fx('hk_q3_sample.json'));
  assertEquals(colByPrefix(c, '市盈率'), '市盈率(pe,ttm)[20261113]');
  assertEquals(colByPrefix(c, '市净率'), '市净率(pb)[20261113]');
});

Deno.test('真实夹具逐位：只落持仓 2 行（夹具 5 行），ROIC 与股息对齐 spec §2.4', () => {
  const { rows, stamps, years } = merge();
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(years, ['2023', '2024', '2025']);
  const t = rows[0], a = rows[1];
  assertEquals(t.name, '腾讯控股');
  assertEquals(t.roic3, [10.5299, 15.8648, 15.8625]);
  assertEquals(t.divYield, 0.8848080133555927);
  assertEquals(t.divY5y, 0.8381616844832607);
  assertEquals(t.pe, 13.078457);
  assertEquals(t.pb, 4.189377);
  assertEquals(a.name, '阿里巴巴-W');
  assertEquals(a.roic3, [6.4716, 6.909, 10.7987]);
  assertEquals(a.divYield, 1.51951171875);
  assertEquals(a.divY5y, 1.6028015582280901);
  assertEquals(stamps, { roic: '20231231,20241231,20251231', div_cur: '20251231', div_5y: '20211231-20251231', pe: '20261113', pb: '20261113' });
});

Deno.test('H-8 混合戳：PE 与 PB 各取自己的戳，不做跨戳比较、不做时点对齐', () => {
  const t3 = renameKey(fx('hk_q3_sample.json'), '港股@市净率(pb)[20261113]', '港股@市净率(pb)[20261112]');
  const { rows, stamps } = merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), t3);
  assertEquals(stamps.pe, '20261113');
  assertEquals(stamps.pb, '20261112');
  assertEquals(rows[0].pb, 4.189377);   // 值照取，不因戳不同而丢弃
});

Deno.test('H-7 单码缺席：某码在估值表缺席 ⇒ 该次字段落 null，不整批失败', () => {
  const { rows } = merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), dropRow(fx('hk_q3_sample.json'), '0700.HK'));
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(rows[0].pe, null);
  assertEquals(rows[0].pb, null);
  assertEquals(rows[0].roic3, [10.5299, 15.8648, 15.8625]);   // 其它两表照取
  assertEquals(rows[0].divYield, 0.8848080133555927);
  assertEquals(rows[1].pe, 21.12736);
});

Deno.test('锚 = 任一表命中：只在估值表出现的持仓码也要落行（ROIC/股息为 null）', () => {
  const { rows } = merge(dropRow(fx('hk_q1_sample.json'), '0700.HK'), dropRow(fx('hk_q2_sample.json'), '0700.HK'));
  assertEquals(rows.map(r => r.code), ['00700', '09988']);
  assertEquals(rows[0].roic3, [null, null, null]);
  assertEquals(rows[0].divYield, null);
  assertEquals(rows[0].name, '腾讯控股');   // 简称从估值表兜回来
  assertEquals(rows[0].pe, 13.078457);
});

Deno.test('股息空值落 null 而非 0（行在而值空，spec §3.3）', () => {
  const t2 = fx('hk_q2_sample.json');
  const j = (t2['股票代码'] as string[]).indexOf('0700.HK');
  (t2['港股@股息率(股票获利率)[20251231]'] as (number | null)[])[j] = null;
  (t2['港股@股息率(股票获利率)平均[20211231-20251231]'] as (number | null)[])[j] = null;
  const { rows } = merge(fx('hk_q1_sample.json'), t2);
  assertEquals(rows[0].divYield, null);
  assertEquals(rows[0].divY5y, null);
});

Deno.test('守卫变异①：年报列变 7 根（裸措辞形态）⇒ 必红', () => {
  const a = fx('hk_q1_sample.json');
  for (const s of ['20221231', '20260331', '20260630', '20260930']) a[`港股@投入资本回报率[${s}]`] = ['1', '1', '1', '1', '1'];
  assertMatch(thrownMessage(() => merge(a)), /expected exactly 3 window columns, got 7/);
});

Deno.test('守卫变异②：年报戳改中报 ⇒ 必红（防中报累计冒充当期，A 股决议27 原型事故）', () => {
  const a = renameKey(fx('hk_q1_sample.json'), '港股@投入资本回报率[20251231]', '港股@投入资本回报率[20250630]');
  assertMatch(thrownMessage(() => merge(a)), /expected 3 annual columns \(2023,2024,2025@1231\)/);
});

Deno.test('守卫变异③：年份错窗 ⇒ 必红', () => {
  const a = renameKey(fx('hk_q1_sample.json'), '港股@投入资本回报率[20231231]', '港股@投入资本回报率[20221231]');
  assertMatch(thrownMessage(() => merge(a)), /got 20221231,20241231,20251231/);
});

Deno.test('守卫变异④：任一查询 0 行 ⇒ 必红（不写空批）', () => {
  const empty: GsHkTable = { '股票代码': [], '股票简称': [], '港股@投入资本回报率[20231231]': [], '港股@投入资本回报率[20241231]': [], '港股@投入资本回报率[20251231]': [] };
  assertMatch(thrownMessage(() => mergeHkTables(empty, fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), HELD, NOW)), /GS hk q1 returned 0 rows/);
});

Deno.test('守卫变异⑤：持仓非空却零命中 ⇒ 必红（代码形态或宇宙变了，不得静默写空）', () => {
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), fx('hk_q2_sample.json'), fx('hk_q3_sample.json'), new Set(['00823']))), /持仓 1 只零命中/);
});

Deno.test('守卫变异⑥：q2 只剩「平均」兄弟列 ⇒ 必红（colByPrefix 会被兄弟列单独满足）', () => {
  const b: GsHkTable = {
    '股票代码': ['0700.HK'], '股票简称': ['腾讯控股'],
    '港股@股息率(股票获利率)平均[20211231-20251231]': [0.8381616844832607],
  };
  assertEquals(colByPrefix(stripHkPrefix(b), '股息率') !== undefined, true);   // 前缀守卫确实放行
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), b)), /GS hk q2 missing column: 股息率\(年报当期列\)/);
});

Deno.test('守卫变异⑦：两根区间平均列 ⇒ 必红（绑哪根不确定，宁拒绝不错位）', () => {
  const b = fx('hk_q2_sample.json');
  b['港股@股息率(股票获利率)平均[20201231-20241231]'] = [1, 1, 1, 1, 1];
  assertMatch(thrownMessage(() => merge(fx('hk_q1_sample.json'), b)), /expected at most 1 interval average column, got 2/);
});

Deno.test('守卫：q1 缺 ROIC 列 / q3 缺市盈率列 ⇒ 必红', () => {
  const a = fx('hk_q1_sample.json');
  for (const k of Object.keys(a)) if (k.startsWith('港股@投入资本回报率')) delete a[k];
  assertMatch(thrownMessage(() => assertHkCols(stripHkPrefix(a), 'q1')), /GS hk q1 missing column: 投入资本回报率/);
  const c = fx('hk_q3_sample.json');
  delete c['港股@市盈率(pe,ttm)[20261113]'];
  assertMatch(thrownMessage(() => assertHkCols(stripHkPrefix(c), 'q3')), /GS hk q3 missing column: 市盈率/);
});

Deno.test('隔离守卫：适配器不 import A 股模块（spec §5.2）', async () => {
  const src = await Deno.readTextFile(new URL('./gs_hk.ts', import.meta.url));
  assertEquals(/from\s*['"]\.\.\/stock-value\//.test(src), false, '适配器不得 import A 股 gs_value.ts');
});
