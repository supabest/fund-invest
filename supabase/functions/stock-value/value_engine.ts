// value_engine.ts — 价值腿纯函数（无 IO）。规则权威：spec §4（门禁）/§5（排序）/§6（置信度）
// 两层结构是本设计存在理由：门禁用绝对阈值（回答“值不值”，不被行业漂移污染），排序用组内
// 百分位（回答“合格者中谁更靠前”）。一只 60 倍 PE 的芯片股能在半导体组内排到“便宜”，
// 但它必须被门禁挡在 too_rich，绝不因百分位高而混进 Top10。
import type { ValueRaw } from './gs_value.ts';

export const ROIC_GATE = 8;             // %  常态资本回报下限（spec §4 硬门禁）
export const MOS_GATE = 2;              // pp 相对十年国债的最低超额（软门禁 → too_rich）
export const OWNER_YIELD_FLOOR = 6;     // %  cn10y 取不到时的绝对下限（spec §9.2）
export const VETO_GUW = 50;             // %  商誉/净资产（否决2）
export const VETO_LEV = 2;              // ×  带息债务/货币资金（否决3）
export const VCOV_MIN = 0.6;            //    有效覆盖低于此 → 不产出 VQ（spec §6）

// 置信度只读「这一行自己的事」那一类 flag（2026-10-12 首跑实数据后用户裁定，spec §6 同步修订）。
// `flags` 里另有三类说的是**数据源的回填形态**：`gw_empty_as_zero`（GS 对无商誉公司回空 → 落库按 0 参与）、
// `pe_na_nonpositive` / `pb_na_nonpositive`（亏损股 PE、净资产为负者 PB 非正）。真数据首跑 5025 行里它们盖了 89%（2522/1204/0），
// 而原 §6「带任一 flag → B」把它们与个股风险同口径记账 → spec §10 要求的 A 级 ≥40% 数学上不可达（实测 10.6%）。
// 先例：Task 4 已因同一理由把 `ic_approx` 踢出 flags（见 computeValue 里那条注），本项是同一判据的延续。
// 不是放宽门禁：三类仍原样留在 `flags` 落库（前视与页面都看得到）；而它们的**数值后果本来就在别处已经付过了**——
// ep/bm 腿置 NA 拉低 vcov，商誉按 0 进百分位。降级判据只该回答“这一行的数据可不可信”，不该重复罚一遍形态。
// 反面清单仍在本行降级：`roic_3y_incomplete`（spec §6 原文列了「roic 仅 1-2 期」）、`rf_fallback`（计价锚退化）、`veto:*`。
const CONFIDENCE_FLAGS = ['roic_3y_incomplete', 'rf_fallback'];
export const flagsDepressConfidence = (flags: string[]): boolean =>
  flags.some(f => CONFIDENCE_FLAGS.includes(f) || f.startsWith('veto:'));

export const investedCapital = (r: ValueRaw): number | null =>
  r.cash !== null && r.debt !== null ? r.cash + r.debt : null;   // spec §4.1 近似

export function roicStats(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

export function ownerYieldOf(r: ValueRaw, roicMed: number | null, _cn10y: number | null) {
  const ok = r.mktcap !== null && r.mktcap > 0;
  const cashY = ok && r.fcff !== null ? r.fcff / r.mktcap! * 100 : null;
  const ic = investedCapital(r);
  const normY = ok && roicMed !== null && ic !== null ? roicMed * ic / r.mktcap! : null;
  const legs = [cashY, normY].filter((x): x is number => x !== null);
  return { cashY, normY, oy: legs.length === 0 ? null : Math.min(...legs) };   // 取小 = 保守
}

export function mosOf(oy: number | null, cn10y: number | null): { mos: number | null; rfFallback: boolean } {
  if (oy === null) return { mos: null, rfFallback: cn10y === null };
  if (cn10y === null) return { mos: null, rfFallback: true };
  return { mos: oy - cn10y, rfFallback: false };
}

export function vetoesOf(r: ValueRaw, roicMed: number | null, fin?: { roe: number | null }): string[] {
  const out: string[] = [];
  if (r.pb !== null && r.pb < 0) out.push('资不抵债');                                       // 否决1
  if ((r.gw ?? 0) > VETO_GUW) out.push(`商誉/净资产>${VETO_GUW}%`);                             // 否决2（空=无商誉=0）
  if (r.fcff !== null && r.fcff < 0 && r.debt !== null && r.cash !== null && r.cash > 0 && r.debt / r.cash > VETO_LEV) {
    out.push('烧钱加杠杆');                                                                     // 否决3（价值陷阱标准形态）
    // ⚠ 已知偏离 spec §4 第 3 条（“近 2 期 fcff<0”）：P-1 实测 `fcff` 只能单次取到当期一列（无两期序列），
    // 而 spec §2 的实测结论是硬约束 → 降为单期判定。方向是“多杀”不是“漏杀”（fail-loudly 侧安全），Task 10 验收时须向用户点名此偏离。
  }
  // 否决4 附注：金融股 roic 天然 NA（P-1）→ 改用 ROE 对标；无 roe 输入则不判定
  const med = r.isFin ? fin?.roe ?? null : roicMed;
  const cur = r.isFin ? fin?.roe ?? null : r.roic;
  // 决议 29（2026-11-01 用户批准）撤销 2026-10-16 的「缺失即视为不达标」兜底，改回**两腿都有值才判**。
  // 那次兜底防的是决议 27 之前的形态：`cur` 绑中报累计列、换年报口径后 411 行静默不判，方向是漏杀。
  // 决议 27 生效后同一形态只剩 55 行（2026-10-31 批次），且它们的 `med` 照样算得出——缺的只是最新一期。
  // 关键事实：门禁层 `roicOk` 只看 `med`（本文件 :84），med<8 的行过不了门禁 → 撤销兜底**不扩大合格池**，
  // 只是不再把「只缺最新一期」这个数据事实断言成「无护城河证据」这个经营结论。落点从 vetoed 变 unqualified。
  if (med !== null && med < ROIC_GATE && cur !== null && cur < ROIC_GATE) out.push('无护城河证据');
  return out;
}

export interface Gate {
  ownerYield: number | null; mos: number | null; cn10y: number | null; rfFallback: boolean;
  icApprox: boolean; roicMed: number | null; fcfYield: number | null; normYield: number | null;
  passed: boolean; tooRich: boolean; vetoed: boolean; vetoReasons: string[];
}

export function gateOf(r: ValueRaw, cn10y: number | null, fin?: { roe: number | null }): Gate {
  const { med } = roicStats(r.roic3);
  const { cashY, normY, oy } = ownerYieldOf(r, med, cn10y);
  const { mos, rfFallback } = mosOf(oy, cn10y);
  const vetoReasons = vetoesOf(r, med, fin);
  const oyPos = oy !== null && oy > 0;
  // 金融股不判 roic 腿（置 true，交排序层 NA 重归一与置信度体现）；非金融 NA 视为不达标（保守）
  const roicOk = r.isFin ? true : med === null ? false : med >= ROIC_GATE;
  const priceOk = oy === null ? false : mos !== null ? mos >= MOS_GATE : oy >= OWNER_YIELD_FLOOR;
  return {
    ownerYield: oy, mos, cn10y, rfFallback, icApprox: investedCapital(r) !== null,
    roicMed: med, fcfYield: cashY, normYield: normY,
    vetoed: vetoReasons.length > 0, vetoReasons,
    tooRich: vetoReasons.length === 0 && oyPos && roicOk && !priceOk,
    passed: vetoReasons.length === 0 && oyPos && roicOk && priceOk,
  };
}

// ---- 排序层（spec §5）：四维百分位加权合成。组内 P1/P99 截尾 + 并列取中，沿用 V1.1 语义 ----
export const W_VQ = { moat: 35, cash: 25, safety: 25, health: 15 };
const W_MOAT = { roicCur: 12, roicMed: 13, roicMin3: 10 };   // 用“最差年”而非标准差：护城河是穿越周期不掉
const W_CASH = { fcfYield: 20, div5y: 5 };                    // 用户裁定：股息只给 5%
const W_SAFETY = { ep: 10, normYield: 10, bm: 5 };            // B/M 压低（与 normYield 共享净资产项）
const W_HEALTH = { netCash: 8, debtRatio: 4, gw: 3 };

// A3：本块是 stock-score/engine.ts 的 assignGroups + pctFromEntries 的**语义复制**
// （V1.1 已冻结，不抽公共模块）。任一侧改动必须同步另一侧；'A3 复制体守卫' 钉住分组行为。
export function assignGroupsV(rows: { code: string; ths: string[] }[]): Map<string, string> {
  const l2 = new Map<string, number>(), l1 = new Map<string, number>();
  for (const s of rows) {
    if (s.ths.length >= 2) l2.set(`${s.ths[0]}-${s.ths[1]}`, (l2.get(`${s.ths[0]}-${s.ths[1]}`) ?? 0) + 1);
    if (s.ths.length >= 1) l1.set(s.ths[0], (l1.get(s.ths[0]) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of rows) {
    const k2 = s.ths.length >= 2 ? `${s.ths[0]}-${s.ths[1]}` : '';
    const k1 = s.ths.length >= 1 ? s.ths[0] : '';
    out.set(s.code, k2 && (l2.get(k2) ?? 0) >= 20 ? `L2:${k2}` : k1 && (l1.get(k1) ?? 0) >= 20 ? `L1:${k1}` : 'MARKET');
  }
  return out;
}

interface PEntry { code: string; grp: string; v: number }
function pctFrom(rows: ValueRaw[], get: (r: ValueRaw) => number | null): Map<string, number> {
  const gs = assignGroupsV(rows);
  const byG = new Map<string, PEntry[]>();
  for (const s of rows) {
    const v = get(s);
    if (v !== null && Number.isFinite(v)) {
      const grp = gs.get(s.code)!;
      const arr = byG.get(grp); if (arr) arr.push({ code: s.code, grp, v }); else byG.set(grp, [{ code: s.code, grp, v }]);
    }
  }
  const out = new Map<string, number>();
  for (const [, ms] of byG) {
    if (ms.length < 5) continue;                        // 组内有效样本 <5 不产生分数（V1.1 纪律）
    const nums = ms.map(m => m.v).sort((a, b) => a - b);
    const p1 = nums[Math.floor(nums.length * 0.01)];
    const p99 = nums[Math.min(nums.length - 1, Math.floor(nums.length * 0.99))];
    const sv = nums.map(v => Math.min(Math.max(v, p1), p99)).sort((a, b) => a - b);
    for (const m of ms) {
      const v = Math.min(Math.max(m.v, p1), p99);
      out.set(m.code, (sv.filter(x => x < v).length + 0.5 * sv.filter(x => x === v).length) / sv.length * 100);
    }
  }
  return out;
}
export function pctWithinGroupsV(rows: ValueRaw[], get: (r: ValueRaw) => number | null) {
  return pctFrom(rows, get);
}

// NA 重归一：有效腿按各自权重重分配；返回 [得分, 有效权重之和]（单腿恒等，避免浮点往返）
function renormV(pairs: [number | null, number][]): [number | null, number] {
  const valid = pairs.filter(([v]) => v !== null) as [number, number][];
  const tot = valid.reduce((a, [, w]) => a + w, 0);
  if (tot === 0) return [null, 0];
  if (valid.length === 1) return [valid[0][0], valid[0][1]];
  return [valid.reduce((a, [v, w]) => a + v * w, 0) / tot, tot];
}

export interface ValueRow extends ValueRaw {
  gate: Gate; vq: number | null; vMoat: number | null; vCash: number | null; vSafety: number | null; vHealth: number | null;
  vcov: number; tier: 'qualified' | 'too_rich' | 'unqualified' | 'vetoed';
  confidence: 'A' | 'B' | 'C'; grp: string; indRank: number; indN: number; marketRank: number; marketN: number;
  flags: string[];
}

export function computeValue(all: ValueRaw[], cn10y: number | null, finRoe?: Map<string, number>): ValueRow[] {
  const rows = all.filter(s => !s.isST);                        // 唯一硬过滤（V1.0 决策 2）
  const gates = new Map(rows.map(s => [s.code, gateOf(s, cn10y, s.isFin ? { roe: finRoe?.get(s.code) ?? null } : undefined)]));
  // 贵者先取倒数（ep=100/pe、bm=100/pb），使全链统一正向高分，reverse 分支不散落
  const epOf = (s: ValueRaw) => (s.pe !== null && s.pe > 0 ? 100 / s.pe : null);   // 空值语义③：PE≤0 → NA
  const bmOf = (s: ValueRaw) => (s.pb !== null && s.pb > 0 ? 100 / s.pb : null);
  const p = {
    roicCur: pctFrom(rows, s => s.roic),
    roicMed: pctFrom(rows, s => gates.get(s.code)!.roicMed),
    roicMin3: pctFrom(rows, s => roicStats(s.roic3).min3),
    fcfY: pctFrom(rows, s => gates.get(s.code)!.fcfYield),
    div5: pctFrom(rows, s => s.divY5y),                         // 空 → 0 已在适配器落地（批次失败才是 NA）
    ep: pctFrom(rows, epOf), normY: pctFrom(rows, s => gates.get(s.code)!.normYield), bm: pctFrom(rows, bmOf),
    netCash: pctFrom(rows, s => (s.cash !== null && s.debt !== null && s.mktcap !== null && s.mktcap > 0
      ? (s.cash - s.debt) / s.mktcap : null)),
    // 有息负债率 = debt/(cash+debt)：严格单调于 debt/cash，百分位不变；存正数口径，取负只用于排序方向（列名不再撒谎）
    // ⚠ 两处 NA 门控都是控制方在 Task 4 评审座位后补的（均为 spec 明文，不是调参）：
    // ① `s.isFin ? null`：spec §5.1 财务稳健行末格明写「金融股 `有息负债率` 腿 NA → renorm」——银行的资产负债口径与产业股不可比；
    // ② 要求 `s.cash !== null`：原写法 `(s.cash ?? 0)` 把「货币资金 NA」当 0 用 → 算成满杠杆，是在三种已批空值语义之外自造第四种，
    //    与同文件 netCash 腿（cash 缺 → 整腿 NA）和 Task 3 的 `investedCapital`（注释原文「任一缺 → null（不猜）」）直接矛盾。方向保守不等于正确：缺数据应该降覆盖度，不应该臆造一个百分比。
    debtRatio: pctFrom(rows, s => (s.isFin ? null
      : s.debt !== null && s.cash !== null && s.cash + s.debt > 0
      ? -s.debt / (s.cash + s.debt) : null)),
    gw: pctFrom(rows, s => -(s.gw ?? 0)),
  };
  const g = (m: Map<string, number>, s: ValueRaw) => m.get(s.code) ?? null;
  const groups = assignGroupsV(rows);

  const out: ValueRow[] = rows.map(s => {
    const gt = gates.get(s.code)!;
    const [vMoat] = renormV([[g(p.roicCur, s), W_MOAT.roicCur], [g(p.roicMed, s), W_MOAT.roicMed], [g(p.roicMin3, s), W_MOAT.roicMin3]]);
    const [vCash] = renormV([[g(p.fcfY, s), W_CASH.fcfYield], [g(p.div5, s), W_CASH.div5y]]);
    const [vSafety] = renormV([[g(p.ep, s), W_SAFETY.ep], [g(p.normY, s), W_SAFETY.normYield], [g(p.bm, s), W_SAFETY.bm]]);
    const [vHealth] = renormV([[g(p.netCash, s), W_HEALTH.netCash], [g(p.debtRatio, s), W_HEALTH.debtRatio], [g(p.gw, s), W_HEALTH.gw]]);
    const [vq0, wSum] = renormV([[vMoat, W_VQ.moat], [vCash, W_VQ.cash], [vSafety, W_VQ.safety], [vHealth, W_VQ.health]]);
    const vcov = wSum / 100;

    const flags: string[] = [];
    // ⚠ 判据必须是「有效期个数」而不是「med 能否算出」（控制方在 Task 4 评审座位后裁定，Critical-1）：
    // `roicStats` 两期就能算出 med/min3 → 原写 `gt.roicMed === null` 只检出 ≤1 期，
    // 让「roic 仅 2 期」的行四维齐备、vcov=1、无 flag → 拿 A 级 → 直接进 spec §7.2「只从 A 级取」的分歧榜（实测：旧实现 conf=A）。
    // spec §6 B 原文是「缺 1 维度，或 `roic` 仅 1-2 期，或带任一 flag」——1-2 期包含 2 期，没有歧义。`roic3` 长度恒 3 由适配器保证（gs_value 的 q3 列族）。
    // 保留 `!s.isFin`：金融股 roic 天然 NA（P-1），护城河整维 NA 已经把它降到 B，不叠加一个假 flag。
    if (!s.isFin && s.roic3.filter(x => x !== null && Number.isFinite(x)).length < 3) flags.push('roic_3y_incomplete');
    if (s.gw === null) flags.push('gw_empty_as_zero');
    if (s.pe !== null && s.pe <= 0) flags.push('pe_na_nonpositive');
    if (s.pb !== null && s.pb <= 0) flags.push('pb_na_nonpositive');
    if (gt.rfFallback) flags.push('rf_fallback');
    // ⚠ `ic_approx` 不得进 flags（控制方在 Task 4 执行时裁定）：spec §4.1 原文只要求“近似状态记入 value_extras.ic_approx=true”，
    // 而 P-1 实测 5224 行里货币资金空 45 / 带息债务空 1 → 约 99% 的行 `icApprox=true`。一旦进 flags，
    // 「带任一 flag → B」会把几乎全市场压成 B → 本任务测试 2 的 `hi.confidence === 'A'` 与 spec §10「A 级占比 ≥40%」数学上不可达，
    // 分歧榜（spec §7 只从 A 级取）直接空榜。近似状态只走 `gate.icApprox` → Task 6 的 extras，信息不丢。
    if (gt.vetoed) flags.push(...gt.vetoReasons.map(x => `veto:${x}`));

    // tier 顺序：否决 > 门禁不过 > 太贵 > 合格。**tier 只翻译门禁层的结论，覆盖度不得改写它**（控制方在 Task 4 评审座位后裁定，Important-2）：
    // 原计划多了一行 `: vcov < VCOV_MIN ? 'unqualified' : 'qualified'`，而 spec §4 对 `unqualified` 的定义就是「门禁不过」（§4 门禁判据表），
    // §6 对 `vcov < 0.6` 的定义是「不产出 VQ（final=null）」——两者不是同一个概念。拿覆盖度把一只在门禁上真的合格的股
    // 改标「不合格」，会让 §8 前视验证没法回答「被门槛挡掉的那批后来如何」（它挡的是覆盖度，不是价值）。
    // 同时该分支与本行上方的旧注释「vcov 只决定 vq，不改 tier」直接矛盾——代码与自己的注释互斥，必须选一边：这里选注释（= spec）。
    // 信息不丢：覆盖度不足的行仍然可见（vcov 照落、四维分照落、vq=null、confidence=C），只是不再伪装成门禁结论。
    const tier: ValueRow['tier'] = gt.vetoed ? 'vetoed' : !gt.passed ? (gt.tooRich ? 'too_rich' : 'unqualified') : 'qualified';
    // spec §6：`vcov < 0.6` → 不产出 VQ。它靠 vq=null 体现，不靠改 tier。下游安全：§7.1 Top10 与 §7.2 分歧榜均要求 `confidence === 'A'`，
    // 而 `vcov < 0.6` 在置信度判据里直接落 C → 不可能有「qualified 且 A 但 vq=null」的行；前端 L1608 还额外写了 `r.vq !== null`。
    const vq = tier === 'qualified' && vcov >= VCOV_MIN ? vq0 : null;
    return { ...s, gate: gt, vq, vMoat, vCash, vSafety, vHealth,
      vcov, tier, confidence: 'A' as const, grp: groups.get(s.code)!,
      indRank: 0, indN: 0, marketRank: 0, marketN: 0, flags };
  });

  // 排名与置信度在成行后回填（indN 需先知道；照 V1.1 先命中先得 C>B>A）
  const scored = out.filter(r => r.vq !== null).sort((a, b) => b.vq! - a.vq!);
  scored.forEach((r, i) => { r.marketRank = i + 1; r.marketN = scored.length; });
  for (const r of scored) {
    const mate = scored.filter(x => x.grp === r.grp);
    r.indN = mate.length; r.indRank = mate.indexOf(r) + 1;
  }
  for (const r of out) {
    // 置信度对所有行统一判 C>B>A，**不分 tier**（控制方在 Task 4 执行时裁定，原计划的 `tier !== 'qualified' → 早退分支` 已删）：
    // ① spec §6 标题明写“照搬 V1.1 §4.7 纪律”，而 V1.1 `engine.ts:239` 对全批统一判、无 tier 概念（它的注释还写明
    //    `final===null` 的行照样算，由编排层过滤）；早退分支是本计划自创，且它自己的 else 支路也会给否决行发 A。
    // ② 不删它则 spec §6 的 C 判据“分组退化到 MARKET 且组内<20”对非 qualified 行永远不生效（那些行 indN 保持 0、从不进这条判据）。
    // 补 `|| r.gate.vetoed` 进 B 档：vetoed 归 B 不归 C（C 的三条判据里没有否决，不发明 spec 没写的降级）。
    // ⚠ 本项当前是**冗余护栏**（控制方在 Task 4 评审座位后改口，Minor-6）：上一行已把否决原因推成 `veto:${原因}` flag，
    // 而「带任一 flag → B」先命中 → 被否决行无论如何落 B。评审坐席实测：删掉本项后 7 个测试宇宙 165 行判定零差异（`changed: NONE`）。
    // 原写「不补就会蒙 A」的反事实**不成立**，已推翻；保留本项只是为了防止日后有人删掉 `veto:*` 那条 push（spec §6 A 明写「无否决」）。
    // （字段位置：否决位只存在 `ValueRow.gate.vetoed` 上，无顶层 `vetoed`；面值写 `r.vetoed` 会 TS2339。已由 Task 4 修复轮实测证实。）
    // 早退分支本身的回归护栏：新增测试「金融股『有息负债率』腿 NA…」的 `h1.confidence === 'B'` 断言——把早退分支加回去该行变 A、当场红。
    const nulls = [r.vMoat, r.vCash, r.vSafety, r.vHealth].filter(x => x === null).length;
    // 「带任一 flag」收窄为「带任一**个股级** flag」（`flagsDepressConfidence`，2026-10-12 裁定）。
    // `r.gate.vetoed` 那项仍是冗余护栏（上方 Minor-6 的注不变）：`flagsDepressConfidence` 已经收了 `veto:*`，
    // 保留它是防日后有人删掉 `gt.vetoed → flags.push('veto:…')` 那一行时，被否决行静默拿到 A
    r.confidence = (r.grp === 'MARKET' && r.indN < 20) || nulls >= 2 || r.vcov < VCOV_MIN ? 'C'
      : nulls === 1 || flagsDepressConfidence(r.flags) || r.gate.vetoed ? 'B' : 'A';
  }
  return out;
}
