// sector-trend engine 单测 —— 规则权威: docs/superpowers/specs/2026-09-30-sector-rotation-design.md §5
// 覆盖 brief 用例1-11。合成K线（除用例10 真实 fixture）；断言值即验收标准。
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeSectorRows, type Bar, type EtfSnap, type SectorInput } from './engine.ts';

const N = 260; // 合成序列长度（>=250 以启用 pos52 / 标签）

function seq(n: number, f: (i: number) => number): number[] {
  return Array.from({ length: n }, (_, i) => f(i));
}
function bars(closes: number[], vols?: number[] | ((i: number) => number)): Bar[] {
  const v = typeof vols === 'function'
    ? seq(closes.length, vols)
    : (vols ?? new Array(closes.length).fill(100));
  return closes.map((c, i) => ({ date: `d${String(i).padStart(4, '0')}`, close: c, volume: v[i] }));
}
function etf(over: Partial<EtfSnap> = {}): EtfSnap {
  return { code: 'e1', name: 'x', amt: 10, tem: 3, r60: 5, sharpe: 1, hay: null, ...over };
}
function input(barsArr: Bar[], etfs: EtfSnap[] = [etf()], prevMp: number | null = null, ind = 'IND'): SectorInput {
  return { ind, pkEtf: etfs[0]?.code ?? 'e1', nEtf: etfs.length, theme: null, etfs, bars: barsArr, prevMp };
}
function only(inp: SectorInput) {
  return computeSectorRows([inp])[0];
}
// 相对容差断言（±0.01 或显式 tol），renorm 类断言按 brief 用
function assertClose(actual: number | null, expected: number, msg = '', tol = 0.01) {
  assertEquals(
    typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    true,
    `${msg} actual=${actual} expected=${expected} tol=${tol}`,
  );
}

// ---------- 用例1：均线五态判定（各 1） ----------
Deno.test('用例1 五态: 强多头/多头/纠缠/走弱/空头排列', () => {
  const strong = only(input(bars(seq(N, (i) => 100 + 0.1 * i))));
  assertEquals(strong.state, '强多头'); // ma20>ma60>ma120 且 close>ma20

  // 多头（非强）：长期上行 + 末段平台，收尾小幅回踩至 ma20 之下、ma60 之上
  const bullCloses = seq(N, (i) => (i <= 238 ? 100 + 0.1 * i : i <= 258 ? 200 : 197));
  const bull = only(input(bars(bullCloses)));
  assertEquals(bull.state, '多头');
  assertEquals(bull.ma20 > bull.ma60, true);
  assertEquals(bull.close > bull.ma60, true);
  assertEquals(bull.close > bull.ma20, false); // 破强多头 → 落多头

  // 纠缠：100/101 高频交替 → ma20=ma60=ma120，非任一严格组合
  const chop = only(input(bars(seq(N, (i) => (i % 2 === 0 ? 100 : 101)))));
  assertEquals(chop.state, '纠缠');

  // 走弱（非空头）：长期下行 + 末段急跌后微弹，close 高于 ma20 → 破空头排列
  const weakCloses = seq(N, (i) => (i <= 238 ? 200 - 0.1 * i : i <= 258 ? 100 : 103));
  const weak = only(input(bars(weakCloses)));
  assertEquals(weak.state, '走弱');
  assertEquals(weak.ma20 < weak.ma60, true);
  assertEquals(weak.close < weak.ma60, true);

  const bear = only(input(bars(seq(N, (i) => 200 - 0.1 * i))));
  assertEquals(bear.state, '空头排列');
});

// ---------- 用例2：筑底候选 pos52≤20 且 m20>+2% 且 vr≤0.9 ----------
Deno.test('用例2 筑底候选: 触发 + vr 放量边界不触发', () => {
  const closes = seq(N, (i) =>
    i < 10 ? 90 : i <= 89 ? 130 : i <= 238 ? 90 : i <= 258 ? 91 : 93);
  // 触发：末 20 根缩量至 80（vr≈0.83≤0.9）
  const trig = only(input(bars(closes, (i) => (i >= 240 ? 80 : 100))));
  assertEquals(trig.labels.includes('筑底候选'), true);
  // 边界：末 20 根放量至 110（vr≈1.08>0.9）→ 不含
  const noTrig = only(input(bars(closes, (i) => (i >= 240 ? 110 : 100))));
  assertEquals(noTrig.labels.includes('筑底候选'), false);
});

// ---------- 用例3：过热警示 pos52≥90 且 dev60≥15% ----------
Deno.test('用例3 过热警示: dev60≥15% 触发 / =14.9% 不触发', () => {
  // 末根抬高使 close 为窗口最高 → pos52=100；ma60 由前 59 根=100 + 末根决定
  const mk = (final: number) =>
    only(input(bars(seq(N, (i) => (i === N - 1 ? final : 100)))));
  const trig = mk(116); // dev60=(59*116-5900)/(5900+116)=0.1569≥0.15
  assertClose(trig.dev60, (59 * 116 - 5900) / (5900 + 116), 'dev60 触发值');
  assertEquals(trig.pos52 !== null && trig.pos52 >= 90, true);
  assertEquals(trig.labels.includes('过热警示'), true);
  // 边界 dev60≈0.149 < 0.15 → 不含
  const edge = mk(115.1885); // (59c-5900)/(5900+c)=0.149
  assertClose(edge.dev60, 0.149, 'dev60 边界值', 0.001);
  assertEquals(edge.labels.includes('过热警示'), false);
});

// ---------- 用例4：高位放量滞涨 pos52≥70 且 vr≥1.8 且 |m20|≤2% ----------
Deno.test('用例4 高位放量滞涨: |m20|≤2% 触发 / m20=+2.1% 不触发', () => {
  const volFn = (i: number) => (i >= 240 ? 300 : 100); // vr≈2.25≥1.8
  // 触发：末段高位滞涨（close[-20]=130=close）
  const trigCloses = seq(N, (i) => (i <= 238 ? 100 : 130));
  const trig = only(input(bars(trigCloses, volFn)));
  assertEquals(trig.labels.includes('高位放量滞涨'), true);
  // 边界：m20=+2.1%（close[-20]=127.33, close=130）→ 不含
  const edgeCloses = seq(N, (i) => (i <= 238 ? 100 : i === 239 ? 127.33 : 130));
  const edge = only(input(bars(edgeCloses, volFn)));
  assertEquals(Math.abs(edge.m20) > 0.02, true);
  assertEquals(edge.labels.includes('高位放量滞涨'), false);
});

// ---------- 用例5：禁追高 dm20≥+20 且 vr≥1.2 且 m20>+2% ----------
Deno.test('用例5 禁追高: prevMp 使 dm20=+20', () => {
  const closes = seq(N, (i) => (i <= 238 ? 100 : i <= 258 ? 100 : 105));
  const volFn = (i: number) => (i >= 240 ? 200 : 100); // vr≈1.71≥1.2
  // 单行业 mp=50（(0+0.5*1)/1*100）；prevMp=30 → dm20=50-30=+20
  const row = only(input(bars(closes, volFn), [etf()], 30));
  assertEquals(row.mp, 50);
  assertEquals(row.dm20, 20);
  assertEquals(row.m20 > 0.02, true);
  assertEquals(row.labels.includes('禁追高'), true);
});

// ---------- 用例6：退潮观察 pos52≥70 且 dm20≤-20；不扣分 ----------
Deno.test('用例6 退潮观察: pos52≥70 且 dm20≤-20，标签不影响行业分', () => {
  const closes = seq(N, (i) => (i === N - 1 ? 120 : 100)); // 末根最高 → pos52=100≥70
  const e = [etf({ code: 'a', amt: 10 })];
  const withLabel = only(input(bars(closes), e, 70)); // mp=50, dm20=50-70=-20≤-20
  assertEquals(withLabel.dm20, -20);
  assertEquals(withLabel.labels.includes('退潮观察'), true);
  const noLabel = only(input(bars(closes), e, 50)); // dm20=0 → 不含
  assertEquals(noLabel.labels.includes('退潮观察'), false);
  // 不扣分：labels 变化不改变 score（退潮观察为中性，spec S5/§5）
  assertEquals(withLabel.score, noLabel.score);
});

// ---------- 用例7：左侧埋伏 pos52≤15 且 m20≤0 ----------
Deno.test('用例7 左侧埋伏: pos52≤15 且 m20≤0', () => {
  // 窗口 [90,130]：close=96 → pos52=(96-90)/(130-90)*100=15；close[-20]=98 → m20<0
  const closes = seq(N, (i) => (i <= 238 ? 130 : i === 239 ? 98 : i <= 258 ? 90 : 96));
  const row = only(input(bars(closes)));
  assertEquals(row.pos52 !== null && row.pos52 <= 15, true);
  assertEquals(row.m20 <= 0, true);
  assertEquals(row.labels.includes('左侧埋伏'), true);
});

// ---------- 用例7c：左侧埋伏 pos52 运算符方向反向钉（spec §5：pos52≤15 触发） ----------
// pos52 = (c - mn)/(mx - mn)*100（engine.ts L64，窗口需≥250 根）。构造窗口 [90,130]：
// c=96 → pos52=15（边界，必须触发）；c=96.4 → pos52=16（必须不触发）。
// 两组 m20 均<0（close[-20]=98）、barsN=260、vr=1，唯一变量是 pos52 落在 15 两侧。
// 若判据误写成 p52>=T.left.pos52（方向反转），pos52=16 组会误触发 → 本钉变红。
Deno.test('用例7c 左侧埋伏反向钉: pos52=15 边界触发 / pos52=16 不触发（≤ 非 ≥）', () => {
  // pos52=15：窗口 [90,130]，close=96 → (96-90)/40*100=15；m20=96/98-1<0
  const hit = only(input(bars(seq(N, (i) => (i <= 238 ? 130 : i === 239 ? 98 : i <= 258 ? 90 : 96)))));
  assertClose(hit.pos52!, 15, 'pos52 边界值=15', 0.001);
  assertEquals(hit.m20 <= 0, true);
  assertEquals(hit.labels.includes('左侧埋伏'), true); // spec: ≤15 含边界 15

  // pos52=16：close=96.4 → (96.4-90)/40*100=16；m20=96.4/98-1<0 → 按 spec 不得触发
  const miss = only(input(bars(seq(N, (i) => (i <= 238 ? 130 : i === 239 ? 98 : i <= 258 ? 90 : 96.4)))));
  assertClose(miss.pos52!, 16, 'pos52 边界外=16', 0.001);
  assertEquals(miss.m20 <= 0, true);
  assertEquals(miss.pos52! > T_LEFT_POS52, true); // 16 > 15，位于判据 ≤ 的域外
  assertEquals(miss.labels.includes('左侧埋伏'), false);
});
const T_LEFT_POS52 = 15; // spec §5 左侧埋伏 pos52 阈值（与 engine.ts T.left.pos52 一致）

// ---------- 用例7b（M2）：严格边界钉 —— m20/vr 开闭运算符 与 门槛值 精确锁定 ----------
// 说明：m20 = closes[n-1]/closes[n-21] - 1（见 engine.ts pctChange）。因 IEEE754 下 c/b-1 无法精确等于
// 双精度字面量 0.02（102/100-1=0.020000000000000018>0.02），故用边界两侧可达的最近双精度值成对钉住阈值位置；
// 唯独 m20=0 可精确构造 → 直接钉 左侧埋伏 的 m20 `<=`（翻成 `<` 立即变红）。
Deno.test('用例7b M2 边界钉: 筑底>0.02 / 禁追高>0.02 / 滞涨|·|≤0.02 / 左侧 m20≤0 恰等0', () => {
  // 筑底候选 m20 `> 0.02`（钉 >）：其余条件 pos52≤20 且 vr≤0.9 恒满足，唯一变量为 m20 落 0.02 两侧
  const botNo = only(input(bars(seq(N, (i) => (i < 90 ? 130 : i < 259 ? 90 : 91.79)), (i) => (i >= 240 ? 80 : 100))));
  assertEquals(botNo.m20 > 0.02, false); // ≈0.01989 边界下侧
  assertEquals(botNo.labels.includes('筑底候选'), false);
  const botYes = only(input(bars(seq(N, (i) => (i < 90 ? 130 : i < 259 ? 90 : 91.8)), (i) => (i >= 240 ? 80 : 100))));
  assertEquals(botYes.m20 > 0.02, true); // 0.020000000000000018 边界上侧
  assertEquals(botYes.labels.includes('筑底候选'), true);

  // 禁追高 m20 `> 0.02`（钉 >）：dm20=20(≥20) 且 vr≈1.71(≥1.2) 恒满足，prevMp=30 → dm20=50-30=20
  const chNo = only(input(bars(seq(N, (i) => (i <= 258 ? 100 : 101.99)), (i) => (i >= 240 ? 200 : 100)), [etf()], 30));
  assertEquals(chNo.dm20, 20);
  assertEquals(chNo.m20 > 0.02, false);
  assertEquals(chNo.labels.includes('禁追高'), false);
  const chYes = only(input(bars(seq(N, (i) => (i <= 258 ? 100 : 102)), (i) => (i >= 240 ? 200 : 100)), [etf()], 30));
  assertEquals(chYes.m20 > 0.02, true);
  assertEquals(chYes.labels.includes('禁追高'), true);

  // 高位放量滞涨 `|m20| ≤ 0.02`（钉 ≤ 侧）：pos52≥70 且 vr≈2.25≥1.8 恒满足
  const stYes = only(input(bars(seq(N, (i) => (i <= 238 ? 90 : i <= 258 ? 100 : 101.99)), (i) => (i >= 240 ? 300 : 100))));
  assertEquals(Math.abs(stYes.m20) <= 0.02, true); // ≈0.0199 窗内 → 触发
  assertEquals(stYes.labels.includes('高位放量滞涨'), true);
  const stNo = only(input(bars(seq(N, (i) => (i <= 238 ? 90 : i <= 258 ? 100 : 102)), (i) => (i >= 240 ? 300 : 100))));
  assertEquals(Math.abs(stNo.m20) <= 0.02, false); // 0.020000000000000018 越界 → 不触发
  assertEquals(stNo.labels.includes('高位放量滞涨'), false);

  // 左侧埋伏 m20 `≤ 0` 恰等 0（钉 ≤ 非 <）：pos52=15 满足门、closes[239]=closes[259]=96 → m20 精确=0
  const left = only(input(bars(seq(N, (i) => (i < 90 ? 130 : i === 239 ? 96 : i <= 258 ? 90 : 96)))));
  assertEquals(left.m20, 0); // 精确 0：若判据为 m20<0 则不触发 → 本断言立即变红
  assertEquals(left.labels.includes('左侧埋伏'), true);
});

// ---------- 用例8：历史不足 bars<250 → pos52/dm20=null, 五态与 score 仍出, labels=[] ----------
Deno.test('用例8 历史不足: 200根 → pos52/dm20 null, labels 空, 五态与 score 仍出', () => {
  const row = only(input(bars(seq(200, (i) => 100 + 0.1 * i)))); // 上行 → 有状态
  assertEquals(row.barsN, 200);
  assertEquals(row.pos52, null);
  assertEquals(row.dm20, null);
  assertEquals(row.labels.length, 0);
  assertEquals(['强多头', '多头', '纠缠', '走弱', '空头排列'].includes(row.state), true);
  assertEquals(row.score !== null, true);
  // M3 门槛钉：构造一个「除 pos52 外，禁追高全部子条件都满足」的 200 根行 ——
  // dm20=20(≥20，排除 prevMp=null 路径)、vr≈1.71(≥1.2)、m20≈0.0200(>0.02)，唯 pos52 因 <250 根=null。
  // 证明 engine.ts:167 的 barsN≥250/pos52!==null 门槛确实屏蔽了 dm20 类标签：若移除该门槛，禁追高将触发。
  const r8b = only(input(bars(seq(200, (i) => (i <= 198 ? 100 : 102)), (i) => (i >= 180 ? 200 : 100)), [etf()], 30));
  assertEquals(r8b.barsN, 200);
  assertEquals(r8b.pos52, null); // 历史不足 → pos52 null
  assertEquals(r8b.dm20, 20); // dm20 有值（非由 prevMp=null 得到）
  assertEquals(r8b.vr !== null && r8b.vr >= 1.2, true); // 满足禁追高量比子条件
  assertEquals(r8b.m20 > 0.02, true); // 满足禁追高 m20 子条件
  assertEquals(r8b.labels.length, 0); // 但门槛屏蔽 → 全部标签(含禁追高)留空（spec §5 附注）
});

// ---------- 用例9：renorm 权重回切 + V 映射 ----------
Deno.test('用例9 renorm: 全池 hay=null → V/M/L=46.15/38.46/15.38 权重; 注入 hay → 35/30/25/10; V映射', () => {
  // V 映射：tem=5→100, tem=1→20
  const vHigh = only(input(bars(seq(N, () => 100)), [etf({ tem: 5 })]));
  const vLow = only(input(bars(seq(N, () => 100)), [etf({ tem: 1 })]));
  assertEquals(vHigh.v, 100);
  assertEquals(vLow.v, 20);

  // 单 ETF、全池唯一 → r60/sharpe/amt 百分位均为 50 → m=0.6*50+0.4*50=50, l=50
  const sole = etf({ tem: 5, r60: 5, sharpe: 1, amt: 10, hay: null });
  const qAbsent = only(input(bars(seq(N, () => 100)), [sole]));
  assertEquals(qAbsent.q, null); // 全池无 hay → Q 腿剔除
  // 分母=V30+M25+L10=65，Q 缺席 → 有效权重 V=30/65≈46.15%, M=25/65≈38.46%, L=10/65≈15.38%
  // M1 修复：用引擎输出反推 V 有效权重（替换原三行两侧皆字面量的空断言）。
  // 仅变动 V 腿(tem 1→5，v 20→100)，单 ETF 使 M/L 腿恒=50、Q 缺席 → score=(v*30+m*25+l*10)/65，
  // 故 Δscore/Δv 必等于 V 有效权重 30/65；此断言含被测值，改判据即会变红。
  const vBase = only(input(bars(seq(N, () => 100)), [etf({ tem: 1, r60: 5, sharpe: 1, amt: 10, hay: null })]));
  const vHi = only(input(bars(seq(N, () => 100)), [etf({ tem: 5, r60: 5, sharpe: 1, amt: 10, hay: null })]));
  assertClose((vHi.score! - vBase.score!) / (vHi.v! - vBase.v!), 30 / 65, 'V 有效权重=30/65≈46.15%', 0.0001);
  // 用 brief 公式独立验证（非硬编码）：Σ(因子分×w)/Σ(非缺腿 w)
  const expectedAbsent = (qAbsent.v! * 30 + qAbsent.m! * 25 + qAbsent.l! * 10) / (30 + 25 + 10);
  assertClose(qAbsent.score, expectedAbsent, 'Q 缺席 renorm');
  assertClose(qAbsent.score, 4750 / 65, 'Q 缺席 golden=73.08'); // ≈(100*30+50*25+50*10)/65

  // 注入 hay 命中 → qAlive → Q 腿参与，权重回切 35/30/25/10（分母 100）
  const soleHit = etf({ tem: 5, r60: 5, sharpe: 1, amt: 10, hay: '高景气' });
  const qPresent = only(input(bars(seq(N, () => 100)), [soleHit]));
  assertEquals(qPresent.q, 100); // 命中高景气集合 = 100
  const expectedPresent = (qPresent.q! * 35 + qPresent.v! * 30 + qPresent.m! * 25 + qPresent.l! * 10) / 100;
  assertClose(qPresent.score, expectedPresent, 'Q 在场 renorm');
  assertClose(qPresent.score, 82.5, 'Q 在场 golden'); // (100*35+100*30+50*25+50*10)/100
});

Deno.test('用例9b 行业分 = 规模加权 ETF 四因子分（区别于等权）', () => {
  // 同行业两只 ETF：r60/sharpe 并列(→各 50)，amt 30/10 不并列(→a=75,b=25)，Q 全缺席
  const a = etf({ code: 'a', amt: 30, tem: 5, r60: 5, sharpe: 5, hay: null });
  const b = etf({ code: 'b', amt: 10, tem: 1, r60: 5, sharpe: 5, hay: null });
  const row = only(input(bars(seq(N, () => 100)), [a, b]));
  // per-etf: ca=(100*30+50*25+75*10)/65, cb=(20*30+50*25+25*10)/65
  const ca = (100 * 30 + 50 * 25 + 75 * 10) / 65; // 76.9231
  const cb = (20 * 30 + 50 * 25 + 25 * 10) / 65;  // 32.3077
  const sizeW = (ca * 30 + cb * 10) / 40;          // 65.77（规模加权）
  const equalW = (ca + cb) / 2;                    // 54.62（等权，用于证明非等权）
  assertClose(row.score, Math.round(sizeW * 100) / 100, '规模加权行业分', 0.011);
  assertEquals(Math.abs(row.score! - equalW) > 1, true); // 明确区别于等权
  assertClose(row.v!, (100 * 30 + 20 * 10) / 40, '分项 v 规模加权=80');
});

// ---------- 用例10：真实 fixture bank_slice.json 多头态 golden ----------
Deno.test('用例10 golden fixture: 512800 真实段末行 ∈{多头,强多头} 且 ma20>ma60', async () => {
  const url = new URL('./fixtures/bank_slice.json', import.meta.url);
  const raw = JSON.parse(await Deno.readTextFile(url)) as { date: string; close: number; volume: number }[];
  assertEquals(raw.length >= 300, true, `fixture 需≥300根, 实得 ${raw.length}`);
  const row = only(input(bars(raw.map((r) => r.close), raw.map((r) => r.volume))));
  assertEquals(['多头', '强多头'].includes(row.state), true);
  assertEquals(row.ma20 > row.ma60, true);
  assertEquals(row.pos52 !== null, true); // 300+ 根 → pos52 应出
});

// ---------- 用例11：mp 截面方向 ----------
Deno.test('用例11 mp 截面: 高 m60 行业 mp 更大', () => {
  // A: m60≈+10% (close[60]/close[0]=110/100), B: m60≈+2% (102/100)
  const mkM60 = (end: number) => bars(seq(61, (i) => (i === 0 ? 100 : i === 60 ? end : 100)));
  const rows = computeSectorRows([
    input(mkM60(110), [etf()], null, 'A'),
    input(mkM60(102), [etf()], null, 'B'),
  ]);
  const A = rows.find((r) => r.ind === 'A')!;
  const B = rows.find((r) => r.ind === 'B')!;
  assertEquals(A.m60 > B.m60, true);
  assertEquals(A.mp! > B.mp!, true); // 横截面升序秩：高动量 → 高分位
  assertClose(A.mp!, 75, 'A mp=(1+0.5)/2*100');
  assertClose(B.mp!, 25, 'B mp=(0+0.5)/2*100');
});
