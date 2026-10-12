// supabase/functions/stock-value/value_engine_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { roicStats, investedCapital, ownerYieldOf, mosOf, vetoesOf, gateOf, ROIC_GATE, VETO_GUW } from './value_engine.ts';
import type { ValueRaw } from './gs_value.ts';

// 基准样本：市值 200 亿、FCFF 20 亿→cashY=10%；IC=40 亿、roic_med=15%→normY=3%；oy=min=3%
const mk = (o: Partial<ValueRaw> = {}): ValueRaw => ({
  code: '1', name: 'x', ths: ['A', 'B', 'C'], isFin: false, isST: false,
  roic: 15, roic3: [14, 15, 16], fcff: 2e9, cash: 3e9, debt: 1e9, gw: 0,
  pe: 20, pb: 2, mktcap: 2e10, divYield: 2, divY5y: 2, roe: null, ...o,
});

Deno.test('roicStats：3 年取中位与最差年；非空 <2 期 → 双 NA（单值不构成“中位数”）', () => {
  assertEquals(roicStats([14, 16, 15]), { med: 15, min3: 14 });
  assertEquals(roicStats([14, null, 15]), { med: 14.5, min3: 14 });
  assertEquals(roicStats([14, null, null]), { med: null, min3: null });
  assertEquals(roicStats([]), { med: null, min3: null });
});

Deno.test('投入资本 = 货币资金 + 带息债务（近似）；任一缺 → null（不猜）', () => {
  assertEquals(investedCapital(mk()), 4e9);
  assertEquals(investedCapital(mk({ debt: null })), null);
});

Deno.test('owner_yield 取小：同时惩罚烧钱与周期虚高（spec §4 存在理由）', () => {
  const o = ownerYieldOf(mk(), 15, null);
  assertEquals(o.cashY, 10); assertEquals(o.normY, 3); assertEquals(o.oy, 3);
});

Deno.test('owner_yield 单腿 NA → 退回可得腿；双腿全 NA → null（不冒充 0）', () => {
  assertEquals(ownerYieldOf(mk({ fcff: null }), 15, null), { cashY: null, normY: 3, oy: 3 });
  assertEquals(ownerYieldOf(mk({ fcff: null }), null, null).oy, null);
});

Deno.test('mos = owner_yield − cn10y（pp）；cn10y NA → mos=null 且 rfFallback=true', () => {
  assertEquals(mosOf(8, 1.85), { mos: 6.15, rfFallback: false });
  assertEquals(mosOf(8, null), { mos: null, rfFallback: true });
  assertEquals(mosOf(null, 1.85), { mos: null, rfFallback: false });
});

Deno.test('四条硬否决逐条命中；商誉空按 0 不触发（空值语义①）', () => {
  assertEquals(vetoesOf(mk({ pb: -0.5 }), 15), ['资不抵债']);
  assertEquals(vetoesOf(mk({ gw: 55 }), 15), [`商誉/净资产>${VETO_GUW}%`]);
  assertEquals(vetoesOf(mk({ gw: null }), 15), []);
  assertEquals(vetoesOf(mk({ fcff: -1e9, debt: 3e9, cash: 1e9, roic: 5, roic3: [5, 4, null] }), 4.5),
    ['烧钱加杠杆', '无护城河证据']);
});

Deno.test('金融股否决4 走 ROE 对标：roic 天然 NA 不得整类误杀（P-1）', () => {
  const fin = mk({ isFin: true, roic: null, roic3: [null, null, null] });
  assertEquals(vetoesOf(fin, null, { roe: 15 }).includes('无护城河证据'), false);
  assertEquals(vetoesOf(fin, null, { roe: 3 }).includes('无护城河证据'), true);
  assertEquals(vetoesOf(fin, null, undefined).includes('无护城河证据'), false);  // 无 roe 输入 → 不判定，不算触发
});

Deno.test('门禁判定：否决 > oy≤0 > roic_med 不达标 > mos 不足（too_rich 不是卖出）', () => {
  const kind = (o: Partial<ValueRaw>, cn: number | null = 1.85) => {
    const x = gateOf(mk(o), cn);
    return x.vetoed ? 'vetoed' : x.passed ? 'gate_ok' : x.tooRich ? 'too_rich' : 'unqualified';
  };
  assertEquals(kind({ pb: -1 }), 'vetoed');
  assertEquals(kind({ fcff: -1e9 }), 'unqualified');                              // oy≤0（烧钱）
  assertEquals(kind({ roic: 9, roic3: [5, 6, 7] }), 'unqualified');               // 单低：med=6<8 但当期 9≥8 → 不触发否决4，才是“roic_med 不达标”这一档
  assertEquals(kind({ fcff: 1e8 }), 'too_rich');                                  // oy=min(0.5,3)=0.5 → mos=-1.35
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }), 'gate_ok');    // oy=min(15,6.2)=6.2 → mos=4.35
  assertEquals(kind({ fcff: 1e8 }, null), 'too_rich');                             // rfFallback：oy 0.5 < 6
  assertEquals(kind({ fcff: 3e9, roic: 30, roic3: [30, 31, 32] }, null), 'gate_ok'); // rfFallback：oy=6.2 ≥ 6
});

Deno.test('金融股过 gateOf：roic 腿置 true 不得让低 ROE 蒙混（P-1 的误杀/漏判双向都钉住）', () => {
  const fin = { isFin: true, roic: null, roic3: [null, null, null], fcff: 3e9 } as Partial<ValueRaw>;
  // 置 true 生效的一侧：roic3 全 NA 若走非金融分支（`med === null → roicOk = false`），金融股会整类落 unqualified —— 这正是 P-1 要防的误杀形态。
  assertEquals(gateOf(mk(fin), 1.85, { roe: 15 }).passed, true);
  // 低 ROE 靠否决4 拦而不靠 roic 腿兜：这条是 `roicOk = r.isFin ? true` 不被滥用为“金融股免检”的唯一证据。
  const lo = gateOf(mk(fin), 1.85, { roe: 3 });
  assertEquals(lo.vetoed, true);
  assertEquals(lo.vetoReasons.includes('无护城河证据'), true);
  // 上游不传 roe（或传 {roe:null}）时：否决4 不判定 + roicOk 恒 true → 低 ROE 银行仅凭价格腿过关。
  // 该静默路径不由本层守，由 Task 5 把金融股 ROE 列加进 REQUIRED 来守（缺列→整批炸，而不是静默降级）；Task 4 的调用点已写定传 `finRoe.get(code)`。
});

import { computeValue, assignGroupsV, pctWithinGroupsV, VCOV_MIN } from './value_engine.ts';

// 同组宇宙（默认 30 只 ≥20 → 走 L2 分组），各腿均有区分度。
// ⚠ roic 从 20 起算不是调参，是必改（控制方在 Task 4 执行时裁定）：原写 `roic: 5+i, roic3:[4+i,5+i,6+i]` 让尾部几只是**双低**（cur<8 且 med<8）
// → 命中否决4 → tier=vetoed → vq 恒 null → 测试 2 「hi/lo 都有 vq 且单调」与测试 7 的样本均不成立（与 Task 3 已裁的「档位样本选错」完全同型）。
// 同时 `med<8 ⟹ oy≤0.2×med<1.6 ⟹ mos<−0.25<2`，低尾根本不可能过价格腿 —— 这是宇宙构造问题，不是排序层能修的（排序层给否决行算 vq 就是绕过门禁结论）。
const uni = (over: Partial<ValueRaw> = {}, n = 30): ValueRaw[] =>
  Array.from({ length: n }, (_, i) => mk({ code: `u${i}`, ths: ['测试业', '测试Ⅱ', 'x'],
    roic: 20 + i, roic3: [19 + i, 20 + i, 21 + i], fcff: (1 + i) * 1e9, pe: 40 - i / 2, pb: 1 + i / 10, ...over }));

Deno.test('A3 复制体守卫：分组回退与 V1.1 逐字对齐（L2≥20 → L1≥20 → MARKET）', () => {
  const many = uni({}, 20).map((s, i) => ({ ...s, code: `m${i}`, ths: ['传媒', '影视', 'x'] }));
  const few = uni({}, 8).map((s, i) => ({ ...s, code: `f${i}`, ths: ['综合', '综合Ⅱ', 'x'] }));
  const g = assignGroupsV([...many, ...few]);
  assertEquals(g.get('m0'), 'L2:传媒-影视');
  assertEquals(g.get('f0'), 'MARKET');
});

Deno.test('满腿宇宙：vcov=1、四维齐备、A 级、VQ 在合格者中单调', () => {
  const rows = computeValue(uni(), 1.85);
  const hi = rows.find(r => r.code === 'u29')!, lo = rows.find(r => r.code === 'u0')!;
  assertEquals(hi.vcov, 1);
  assertEquals([hi.vMoat, hi.vCash, hi.vSafety, hi.vHealth].every(v => v !== null), true);
  assertEquals(hi.confidence, 'A');
  assertEquals(hi.vq !== null && lo.vq !== null && hi.vq > lo.vq, true);
});

Deno.test('60 倍 PE 行业内相对最低 → 必须落 too_rich（两层结构存在理由，spec §10 黄金样本）', () => {
  // 半导体宇宙：24 只 PE=120、1 只 PE=60（组内估值百分位最优），但 owner_yield 依旧抵不过十年国债
  const semi = Array.from({ length: 25 }, (_, i) => mk({ code: `s${i}`, ths: ['电子', '半导体', 'x'],
    pe: i < 24 ? 120 : 60, fcff: i < 24 ? 1.67e8 : 3.33e8,   // cashY：0.835% vs 1.665%
    roic: 20, roic3: [20, 20, 20], mktcap: 2e10 }));
  const epPct = pctWithinGroupsV(semi, s => (s.pe! > 0 ? 100 / s.pe! : null));
  assertEquals(epPct.get('s24')! > epPct.get('s0')!, true);   // 百分位上它“便宜”
  const rel = computeValue(semi, 1.85).find(r => r.code === 's24')!;
  assertEquals(rel.tier, 'too_rich');                          // 门禁上它不便宜（oy=1.665 → mos=-0.185）
});

Deno.test('三种空值语义分别生效：商誉空→0 参与、股息空→0 参与、PE/PB 非正→NA', () => {
  const u = uni({ roic3: [15, 15, 15], roic: 15, fcff: 3e9 }, 25);
  u[0] = { ...u[0], code: 'e0', gw: null, divYield: null, divY5y: 0, pe: -8, pb: -1 };
  u[1] = { ...u[1], code: 'e1', fcff: null, divY5y: 0 };   // 现金腿只剩股息一条，且它是 0：不得被当成 NA
  const e0 = computeValue(u, 1.85).find(r => r.code === 'e0')!;
  assertEquals(e0.tier, 'vetoed');                              // PB<0 → 否决1，不许用 NA 兑过去
  assertEquals(e0.flags.includes('pe_na_nonpositive'), true);
  assertEquals(e0.flags.includes('gw_empty_as_zero'), true);
  assertEquals(e0.vCash !== null, true);                        // 股息腿以 0 参与，现金腿仍在
  const e1 = computeValue(u, 1.85).find(r => r.code === 'e1')!;
  assertEquals(e1.vCash !== null, true);                        // 不分红记 0 参与排名（P-6/§5.1）：0 被当 NA 的话这条会空
});

Deno.test('vcov<0.6 → vq=null 但原始指标照落（前视需要知道被排除的那批后来如何）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'v0', roic: null, roic3: [], fcff: null, cash: null, divY5y: null };
  const v0 = computeValue(u, 1.85).find(r => r.code === 'v0')!;
  assertEquals(v0.vq, null);
  assertEquals(v0.vcov < VCOV_MIN, true);
  assertEquals(v0.tier, 'unqualified');   // oy=null → 门禁不过
  assertEquals(v0.roic3.length, 0);       // 原始位照留
});

Deno.test('置信度：缺 ≥2 维 或 MARKET 且组内<20 或 vcov<0.6 → C；缺 1 维 或带 flag → B；否则 A', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'c0', roic3: [15, null, null] };   // roicMed/min3 两腿 NA，但 roicCur 在 → 不缺维
  assertEquals(computeValue(u, 1.85).find(r => r.code === 'c0')!.confidence, 'B');  // 带 roic_3y_incomplete flag
  const small = uni({}, 10).map((s, i) => ({ ...s, code: `s${i}`, ths: ['稀有', '稀有Ⅱ', 'x'] }));
  assertEquals(computeValue(small, 1.85).every(r => r.confidence === 'C'), true);   // 组内<20 → MARKET
});

Deno.test('tier 判定顺序 vetoed > unqualified > too_rich > qualified；否决者照落库', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 't0', pb: -1 };
  u[1] = { ...u[1], code: 't1', fcff: -5e8 };
  const rows = computeValue(u, 1.85);
  assertEquals(rows.find(r => r.code === 't0')!.tier, 'vetoed');
  assertEquals(rows.find(r => r.code === 't1')!.tier, 'unqualified');
  assertEquals(rows.filter(r => r.tier === 'qualified').length > 0, true);
});

// ⚠ 以下三条是 Task 4 任务评审（spec+质量座位）打回后补的，逐条对应一处已被实测证实的缺陷。
// 控制方不是按推演写的期望值：把三条测试跑在未打补丁的实现上 → 3 failed（`roic 仅 2 期` 拿到 conf=A、
// `门禁过但 vcov<0.6` 拿到 tier=unqualified、金融股 h1 的 vHealth=77.429 而商誉百分位 pG=50.000）；
// 把 `tier !== 'qualified' → 早退分支` 加回去重跑 → h1 的 `confidence` 变 A、当场红（这就是 R3 此前缺失的回归护栏）。
Deno.test('roic 仅 2 期 → 必须 B（spec §6「roic 仅 1-2 期」：med 算得出来不等于三年齐备）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'r2', roic3: [15, null, 16] };
  const r2 = computeValue(u, 1.85).find(r => r.code === 'r2')!;
  assertEquals(r2.gate.roicMed, 15.5);                            // 陷阱本体：两期就够算中位数与最差年
  assertEquals([r2.vMoat, r2.vCash, r2.vSafety, r2.vHealth].every(v => v !== null), true);
  assertEquals(r2.vcov, 1);
  assertEquals(r2.flags.includes('roic_3y_incomplete'), true);
  assertEquals(r2.confidence, 'B');                               // 四维齐备、满覆盖、无否决 —— 唯一压到 B 的就是这条
});

Deno.test('门禁过但 vcov<0.6 → tier 仍是 qualified、vq=null、置信 C（tier 只表达门禁结论，覆盖度不改它）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'g0', isFin: true, roic: null, roic3: [null, null, null], pe: null, pb: null, fcff: 3e9 };
  const g0 = computeValue(u, 1.85, new Map([['g0', 20]])).find(r => r.code === 'g0')!;
  assertEquals(g0.tier, 'qualified');   // 门禁三项全过（oy=15 → mos=13.15）；旧实现拿 `vcov<VCOV_MIN` 改写成 unqualified = 排序层否决门禁结论
  assertEquals([g0.vMoat, g0.vSafety], [null, null]);              // 护城河（roic 天然 NA）+ 估值（PE/PB 双缺）整维 NA
  assertEquals(g0.vcov < VCOV_MIN, true);
  assertEquals(g0.vq, null);                                        // spec §6：vcov<0.6 不产出 VQ，只落原始指标
  assertEquals(g0.confidence, 'C');
});

Deno.test('金融股「有息负债率」腿 NA（spec §5.1 末格）+ 货币资金 NA 不得当 0 用；置信度对所有行统一判（无 tier 早退分支）', () => {
  const u = uni({}, 25);
  u[0] = { ...u[0], code: 'h1', isFin: true, mktcap: null, roic: null, roic3: [null, null, null], cash: 1e10, debt: 1e9 };
  u[1] = { ...u[1], code: 'h2', mktcap: null, cash: null, debt: 1e9 };   // 非金融，仅货币资金 NA
  const pG = pctWithinGroupsV(u, s => -(s.gw ?? 0));
  const rows = computeValue(u, 1.85, new Map([['h1', 20]]));
  const h1 = rows.find(r => r.code === 'h1')!, h2 = rows.find(r => r.code === 'h2')!;
  // 两条样本的稳健维都只剩「商誉」一条有效腿 → renormV 单腿恒等 → vHealth 必须恰等于商誉百分位；
  // 债务率腿若误产分（金融股那条 / `cash ?? 0` 那条），vHealth 会被拉成 (4·pDr+3·pG)/7，绝不等于此值。
  assertEquals(Math.abs(h1.vHealth! - pG.get('h1')!) < 1e-12, true);
  assertEquals(Math.abs(h2.vHealth! - pG.get('h2')!) < 1e-12, true);
  assertEquals(h1.tier, 'unqualified');   // mktcap NA → oy NA → 门禁不过
  assertEquals(h1.flags.length, 0);       // 金融股不判 roic 三年齐备（P-1），其余腿均有效
  assertEquals(h1.vMoat, null);
  assertEquals(h1.confidence, 'B');       // 缺 1 维 → B。原计划的 `tier !== 'qualified' → 早退` 会把这种「门禁不过且无 flag」的行发 A
});

// ==== 2026-10-12 首跑实数据后的裁定（用户批准「Step 7 三条判据全按推荐改」）====
// 三类**总体级** flag（GS 对无商誉回空 / PE 非正 / PB 非正）不再参与置信度，但仍原样留在 `flags` 里。
// 依据是真数据而不是推演：首跑 5025 行里 gw_empty_as_zero 2522、pe_na_nonpositive 1204、pb_na_nonpositive 0，
// 三类都是「数据源的回填形态」而非「这只票自己的毛病」；而 §6「带任一 flag → B」把它们记在案上，
// 于是 spec §10 要求的 A 级 ≥40% 被数学锁死在实际 10.6%。先例：Task 4 已因同一理由把 `ic_approx` 踢出 flags
//（`value_engine.ts` 的 ic_approx 注），本条是同一判据的延续，不是放宽门禁。
// 拆分的准绳：这条 flag 说的是**数据源形态**，还是**这一行自己的事**。后者（roic 三年不齐、rf_fallback、veto:*）照旧降级。
Deno.test('总体级 flag 不压置信度（gw 空当 0 / PE 非正 / PB 非正），但信息照留 flags；roic 三年不齐仍压 B', () => {
  const u = uni({ roic3: [15, 15, 15], roic: 15, fcff: 3e9 }, 25);
  u[0] = { ...u[0], code: 'g0', gw: null };        // GS 对无商誉公司回空 → 落库按 0 参与，不是缺陷
  u[1] = { ...u[1], code: 'pe0', pe: -8 };         // 亏损：ep 腿 NA 已降覆盖度，flag 只作说明
  u[2] = { ...u[2], code: 'pb0', pb: 0 };          // pb=0 不触发否决1（那是 <0），只触发总体级 flag
  u[3] = { ...u[3], code: 'r3', roic3: [15, null, 16] };   // 对照：三年不齐是它自己的事 → 仍 B
  const rows = computeValue(u, 1.85);
  const by = (c: string) => rows.find(r => r.code === c)!;
  assertEquals(by('u4').confidence, 'A');                                    // 这个宇宙确实产得出 A（否则下面的断言全在测空）
  assertEquals(by('g0').flags.includes('gw_empty_as_zero'), true);           // 信息不丢：仍然留痕
  assertEquals(by('g0').confidence, 'A');
  assertEquals(by('pe0').flags.includes('pe_na_nonpositive'), true);
  assertEquals(by('pe0').confidence, 'A');
  assertEquals(by('pb0').flags.includes('pb_na_nonpositive'), true);
  assertEquals(by('pb0').confidence, 'A');
  assertEquals(by('r3').flags.includes('roic_3y_incomplete'), true);
  assertEquals(by('r3').confidence, 'B');
});

// ==== 上面那轮变异检验（preflight18/mutate_flags.py）揪出的两个覆盖洞，逐条补回归护栏 ====
// 事实先行：MF11（把 rf_fallback 从 CONFIDENCE_FLAGS 里删掉）与 MF15（把两道否决护栏同时删掉）都在 69 绿下**存活**，
// 说明「rf_fallback → B」和「否决 → B」这两条判据此前**一行断言都没有**——不是冗余，是洞。
// 冗余与覆盖洞的区分只能靠「同时删两道」这种变异来做：MF12/MF13 各删一道仍存活（互为护栏，符合预期，如实记录不粉饰），
// 而 MF15 一删两道就应当当场红 —— 下面两条测试就是为了让这个「应当」变成实测。
Deno.test('rf_fallback 压置信度 B（计价锚退化是这一行的事）；同一宇宙有 cn10y 时为 A —— 差异只可能来自这条 flag', () => {
  const u = uni({ roic3: [15, 15, 15], roic: 15, fcff: 3e9 }, 25);
  const fb = computeValue(u, null).find(r => r.code === 'u4')!;   // cn10y NA → mosOf 恒 rfFallback=true
  assertEquals(fb.flags, ['rf_fallback']);                        // 只剩这一条：四维齐备、无否决、无总体级 flag
  assertEquals([fb.vMoat, fb.vCash, fb.vSafety, fb.vHealth].every(v => v !== null), true);
  assertEquals(fb.vcov, 1);
  assertEquals(fb.confidence, 'B');
  assertEquals(computeValue(u, 1.85).find(r => r.code === 'u4')!.confidence, 'A');   // 对照组：宇宙本身产得出 A
});

Deno.test('被否决行归 B 不归 A（spec §6 A 明写「无否决」）：两道护栏 veto:* 与 gate.vetoed 互为冗余，删任一道仍 B', () => {
  const u = uni({ roic3: [15, 15, 15], roic: 15, fcff: 3e9 }, 25);
  u[0] = { ...u[0], code: 'w0', gw: 55 };                         // 否决2：商誉/净资产 > 50%
  const w0 = computeValue(u, 1.85).find(r => r.code === 'w0')!;
  assertEquals(w0.tier, 'vetoed');
  assertEquals(w0.flags, ['veto:商誉/净资产>50%']);
  assertEquals(w0.vcov, 1);                                       // 商誉百分位是有效腿，覆盖度没掉 → 不是靠 vcov 落的 B
  assertEquals(w0.confidence, 'B');
  assertEquals(computeValue(u, 1.85).find(r => r.code === 'u4')!.confidence, 'A');   // 同宇宙非否决行仍是 A
});
