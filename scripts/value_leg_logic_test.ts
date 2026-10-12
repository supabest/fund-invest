// scripts/value_leg_logic_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { valueFmtPct, valueTierLabel, valuePillHtml, valueGateHtml, renderValueTop10 } from "./value_leg_logic.ts";

const row = { code:'600031', name:'潍柴', vq:78.4, tier:'qualified', confidence:'A', vetoed:false,
  owner_yield:6.2, margin_of_safety:4.35, cn10y:1.85, roic_med:18.0, v_moat:80, v_cash:70, v_safety:75, v_health:66,
  market_rank:12, market_n:2200, ind_rank:3, ind_n:40, veto_reasons:[], flags:['ic_approx'] };

Deno.test('valueFmtPct：null → NA（不显示 0.0% 冒充“收益为零”）', () => {
  assertEquals(valueFmtPct(null), 'NA');
  assertEquals(valueFmtPct(6.234, 1), '6.2%');
  assertEquals(valueFmtPct(-0.187, 2), '-0.19%');
  // 控制方 pre-flight 实证（计划原文这里写的是 '-0.19%'，与实现体矛盾）：toFixed 的二进制舍入不是“四舍五入进位”，
  // -0.185 实际存成 0.18499… → '-0.18%'。展示层沿用页面既有 toFixed 口径（scorePillHtml 也是 toFixed(1)），
  // 不为价值腿另造舍入函数；这条断言是把它钉成文档。
  assertEquals(valueFmtPct(-0.185, 2), '-0.18%');
});

Deno.test('valueTierLabel：四档均有中文文案，too_rich 不得读成“卖”', () => {
  assertEquals(valueTierLabel('qualified'), '合格');
  assertEquals(valueTierLabel('too_rich'), '质量达标、价太贵');
  assertEquals(valueTierLabel('vetoed'), '硬否决');
  assertEquals(valueTierLabel('unqualified'), '不合格');
  assertEquals(valueTierLabel(null), '—');
});

Deno.test('valuePillHtml：无行→空串；有分→分 + 池内分位；否决行（引擎真实形状 vq=null）必须可见', () => {
  assertEquals(valuePillHtml(null), '');
  assertEquals(valuePillHtml({ ...row, pool_rank: 12, pool_n: 200 }).includes('池内 P94'), true);
  // 否决行 = 引擎产出的 { tier:'vetoed', vetoed:true, vq:null }。旧断言写 vq:78.4 是被测代码永不收到的形状。
  const vetoedRow = { ...row, vq: null, tier: 'vetoed', vetoed: true };
  const h = valuePillHtml(vetoedRow);
  assertEquals(h.includes('硬否决'), true);
  assertEquals(h.includes('score-pill-warn'), true);
  assertEquals(h.includes('⛔'), true);
  assertEquals(h === '', false);                                              // 这条才是 I-2 的实质：胶囊不得整颗消失
  // 无分且未被否决（如覆盖度不足）→ 仍不渲染，别把「还没算出来」伪装成结论
  assertEquals(valuePillHtml({ ...row, vq: null, tier: 'unqualified', vetoed: false }), '');
});

Deno.test('valueGateHtml：四维度横条 + owner_yield 明细 + mos/cn10y 判定过程均可见；mos null 时走 rfFallback 文案', () => {
  const h = valueGateHtml(row);
  for (const t of ['资本回报护城河', '现金回报', '安全边际', '财务稳健', '6.2%', '1.85%']) {
    assertEquals(h.includes(t), true, `缺少：${t}`);
  }
  assertEquals(valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: true }).includes('无风险利率口径缺失'), true);
});

Deno.test('renderValueTop10：state=null → 空串（降级文案由调用点根据 valueTried 决定，纯逻辑不读全局）', () => {
  assertEquals(renderValueTop10(null), '');
});

Deno.test('renderValueTop10：只渲染 tier=qualified 且 A 级；否决/too_rich 不混进榜（spec §7.1）', () => {
  const rows = [row, { ...row, code: 'x2', vq: 90, tier: 'vetoed' }, { ...row, code: 'x3', vq: 88, confidence: 'C' }];
  const html = renderValueTop10({ batch: '2026-10-11', top10: rows as never[] });
  assertEquals(html.includes('600031'), true);
  assertEquals(html.includes('x2'), false);
  assertEquals(html.includes('x3'), false);
  assertEquals(html.includes('不构成买卖建议'), true);   // 固定免责脚注
});

// ==== Step 0（Task 7 评审结转）：补两条 valueGateHtml 覆盖面 ====
Deno.test('valueGateHtml：mos=null 且非 rf_fallback → 显示 NA，且不得冒出“无风险利率口径缺失”', () => {
  const h = valueGateHtml({ ...row, margin_of_safety: null, rf_fallback: false });
  assertEquals(h.includes('NA'), true);
  assertEquals(h.includes('无风险利率口径缺失'), false);
});

Deno.test('valueGateHtml：veto_reasons 非空 → 硬否决块 + 每条否决串均可见（这张卡最该被人看见的部分）', () => {
  const h = valueGateHtml({ ...row, veto_reasons: ['gw_high', 'roe_low'] });
  assertEquals(h.includes('⛔ 硬否决'), true);
  assertEquals(h.includes('gw_high'), true);
  assertEquals(h.includes('roe_low'), true);
});

// ==== Step 1（Task 8）：分歧榜 + 换仓提示行失败测试 ====
import { divergeLists, swapSuggest, renderDivergeBoard, SWAP_GAP } from "./value_leg_logic.ts";

const v = (code: string, vq: number, main: number, mos: number) =>
  ({ code, name: code, vq, main_final: main, margin_of_safety: mos, tier: 'qualified', confidence: 'A', rf_fallback: false });

Deno.test('SWAP_GAP 常数为 5pp（改动需先改 spec，不得局部改代码）', () => {
  assertEquals(SWAP_GAP, 5);
});

Deno.test('divergeLists：被错杀 = VQ 前 20 分位 × 主分后 50 分位；两组均只取 A 级', () => {
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code).includes('a'), true);
  assertEquals(d.rich.map(r => r.code).includes('c'), true);
  assertEquals(d.wronged.every(r => r.confidence === 'A'), true);
});

Deno.test('divergeLists：main_final 缺失的行不参与（无主分快照就无从谈分歧）', () => {
  const rows = [v('a', 95, 30, 6), { ...v('z', 99, 1, 8), main_final: null }];
  assertEquals(divergeLists(rows).wronged.map(r => r.code).includes('z'), false);
});

Deno.test('swapSuggest：X 的 mos 比 Y 高 ≥5pp 才给建议；4.9pp 不给（边界包含等于）', () => {
  const pool = [v('x', 80, 60, 8.0), v('y', 70, 60, 3.0)];
  assertEquals(swapSuggest(pool[1], pool)!.gap, 5.0);
  assertEquals(swapSuggest({ ...pool[1], margin_of_safety: 3.1 }, pool), null);   // 差 4.9pp
});

Deno.test('swapSuggest：任一侧 rf_fallback（口径不一致）→ 整体静默 null，不混用尺子算优势', () => {
  const pool = [ { ...v('x', 80, 60, 8.0), rf_fallback: true }, v('y', 70, 60, 3.0) ];
  assertEquals(swapSuggest(pool[1], pool), null);
});

Deno.test('renderDivergeBoard：两组标题 + 归因句（含主分四条腿）+ 免责脚注；null 降级为空串', () => {
  // 样本必须足量且真正存在分歧：单行时百分位恒为 50，永远进不了 ≥80 / ≤50 双条件
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4) ]
    .map(r => ({ ...r, owner_yield: 6.2, roic_med: 18, extras: { main_legs: { quality: 82, growth: 40, value: 44, momentum: 30 } } }));
  const state = { batch: '2026-10-11', top10: rows, rows: new Map(rows.map(r => [r.code, r])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('被错杀'), true);
  assertEquals(html.includes('虚高'), true);
  assertEquals(html.includes('主分腿：Q82/G40/V44/M30'), true);        // 归因句（spec §7.2）
  assertEquals(html.includes('不构成买卖建议'), true);
  assertEquals(renderDivergeBoard(null), '');
});

// ==== Task 8 修复轮 1：5 条新测试（接在既有 14 条之后）====
Deno.test('swapSuggest：目标必须“未持有”（spec §7.3）——已持有的更优标的不得当换仓目标', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, v('w', 80, 60, 9.0), v('x', 80, 60, 8.0)];
  assertEquals(swapSuggest(y, pool, ['w', 'y'])!.target.code, 'x');   // w 更好但已持有 → 应退而求 x
  assertEquals(swapSuggest(y, pool, [])!.target.code, 'w');           // 不持有 w 时它就是目标
  assertEquals(swapSuggest(y, pool, ['w', 'x', 'y']), null);          // 更优的都持有 → 无建议
});

Deno.test('swapSuggest：浮点边界不得靠运气——真实差恰为 5.0pp 必须给建议', () => {
  const pool = [v('x', 80, 60, 8.2), v('y', 70, 60, 3.2)];            // 8.2-3.2 = 4.999999999999999
  assertEquals(8.2 - 3.2 < 5, true);                                  // 先把这个二进制事实钉在测试里
  const s = swapSuggest(pool[1], pool, []);
  assertEquals(s !== null, true);
  assertEquals(Number(s!.gap.toFixed(1)), 5);
});

Deno.test('divergeLists：非 A 级行不得上榜（spec §7.2/§6：缺数据造成的便宜不得混进结论）', () => {
  // 样本必须够多：只剩一行 A 级时 pctOf 恒为 50，谁都进不了榜——那就测不到过滤器了。
  const rows = [ v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4),
    { ...v('z1', 99, 1, 9), confidence: 'C' }, { ...v('z2', 1, 99, 0), confidence: 'B' } ];
  const d = divergeLists(rows);
  assertEquals(d.wronged.map(r => r.code), ['a']);    // z1 比 a 更“被错杀”，但它是 C 级 → 必须不在榜上
  assertEquals(d.rich.map(r => r.code), ['c']);       // z2 同理（B 级）
});

Deno.test('divergeLists：池外持仓行既不进榜、也不挤掉他人的分位（终审 I-1，spec §7.2「池内」）', () => {
  const base = [
    { ...v('a', 95, 30, 6), in_pool: true }, { ...v('b', 50, 50, 3), in_pool: true },
    { ...v('c', 10, 95, 1), in_pool: true }, { ...v('d', 92, 28, 5), in_pool: true },
  ];
  assertEquals(divergeLists(base).wronged.map(r => r.code), ['a']);          // 池内 4 行：a 的 VQ 分位 87.5 ≥80 → 进榜（终审实测值）
  assertEquals(divergeLists(base).rich.map(r => r.code), ['c']);
  const withOut = base.concat([{ ...v('x', 99, 20, 9), in_pool: false }]);   // x：已从 stock_pool 摘除但两分齐备的持仓行
  const d = divergeLists(withOut);
  assertEquals(d.wronged.map(r => r.code), ['a']);                            // x 不得进榜，且 a 不得被挤掉
  assertEquals(d.rich.map(r => r.code), ['c']);
});

Deno.test('swapSuggest：候选必须 tier=qualified（too_rich/vetoed/unqualified 都不算“更便宜的合格标的”）', () => {
  const y = v('y', 70, 60, 3.0);
  const pool = [y, { ...v('rich', 80, 60, 9.0), tier: 'too_rich' }, { ...v('veto', 80, 60, 8.5), tier: 'vetoed' }];
  assertEquals(swapSuggest(y, pool, []), null);
});

Deno.test('renderDivergeBoard：state.rows 缺席时优雅降级为空串（不抛）', () => {
  assertEquals(renderDivergeBoard({ batch: '2026-10-11' } as never), '');
});

// ==== 终审修复单（F-7g / F-8 配套测试）====
Deno.test('renderDivergeBoard：归因句带上让样本入选的分位 (P90)/(P50)（spec §7.2 示例、终审 M-4）', () => {
  const rows = [v('a', 95, 30, 6), v('b', 50, 50, 3), v('c', 10, 95, 1), v('d', 92, 28, 5), v('e', 90, 20, 4)];
  const state = { batch: '2026-10-11', rows: new Map(rows.map(r => [r.code, r as never])) } as never;
  const html = renderDivergeBoard(state);
  assertEquals(html.includes('VQ 95.0(P90) / 主分 30.0(P50)'), true);
  assertEquals(html.includes('VQ 10.0(P10) / 主分 95.0(P90)'), true);
});

Deno.test('安全边际三处统一按 pp 渲染，旧单位 4.35% 不得残留（终审 N-1）；Top10 另带池内分位（F-3e）', () => {
  assertEquals(valueGateHtml(row).includes('安全边际 4.35pp'), true);
  assertEquals(valueGateHtml(row).includes('4.35%'), false);
  const top = { batch: '2026-10-11', top10: [{ ...row, pool_rank: 12, pool_n: 200 }] };
  assertEquals(renderValueTop10(top).includes('安全边际 4.35pp'), true);
  assertEquals(renderValueTop10(top).includes('池内 P94'), true);
  const drows = [v('a',95,30,6), v('b',50,50,3), v('c',10,95,1), v('d',92,28,5), v('e',90,20,4)];
  const dstate = { batch: '2026-10-11', rows: new Map(drows.map(r => [r.code, r as never])) } as never;
  assertEquals(renderDivergeBoard(dstate).includes('安全边际 6.00pp'), true);  // 第三处沿用 2 位小数
});
