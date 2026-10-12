/// <reference lib="deno.ns" />
// value_engine.ts — 价值腿纯函数（无 IO）。规则权威：spec §4（门禁）/§5（排序）/§6（置信度）
// 两层结构是本设计存在理由：门禁用绝对阈值（回答“值不值”，不被行业漂移污染），排序用组内
// 百分位（回答“合格者中谁更靠前”）。一只 60 倍 PE 的芯片股能在半导体组内排到“便宜”，
// 但它必须被门禁挡在 too_rich，绝不因百分位高而混进 Top10。


const ROIC_GATE = 8;             // %  常态资本回报下限（spec §4 硬门禁）
const MOS_GATE = 2;              // pp 相对十年国债的最低超额（软门禁 → too_rich）
const OWNER_YIELD_FLOOR = 6;     // %  cn10y 取不到时的绝对下限（spec §9.2）
const VETO_GUW = 50;             // %  商誉/净资产（否决2）
const VETO_LEV = 2;              // ×  带息债务/货币资金（否决3）
const VCOV_MIN = 0.6;            //    有效覆盖低于此 → 不产出 VQ（spec §6）

const investedCapital = (r: ValueRaw): number | null =>
  r.cash !== null && r.debt !== null ? r.cash + r.debt : null;   // spec §4.1 近似

function roicStats(roic3: (number | null)[]): { med: number | null; min3: number | null } {
  const xs = roic3.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length < 2) return { med: null, min3: null };
  const mid = xs.length >> 1;
  return { med: xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, min3: xs[0] };
}

function ownerYieldOf(r: ValueRaw, roicMed: number | null, _cn10y: number | null) {
  const ok = r.mktcap !== null && r.mktcap > 0;
  const cashY = ok && r.fcff !== null ? r.fcff / r.mktcap! * 100 : null;
  const ic = investedCapital(r);
  const normY = ok && roicMed !== null && ic !== null ? roicMed * ic / r.mktcap! : null;
  const legs = [cashY, normY].filter((x): x is number => x !== null);
  return { cashY, normY, oy: legs.length === 0 ? null : Math.min(...legs) };   // 取小 = 保守
}

function mosOf(oy: number | null, cn10y: number | null): { mos: number | null; rfFallback: boolean } {
  if (oy === null) return { mos: null, rfFallback: cn10y === null };
  if (cn10y === null) return { mos: null, rfFallback: true };
  return { mos: oy - cn10y, rfFallback: false };
}

function vetoesOf(r: ValueRaw, roicMed: number | null, fin?: { roe: number | null }): string[] {
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
  if (med !== null && cur !== null && med < ROIC_GATE && cur < ROIC_GATE) out.push('无护城河证据');
  return out;
}

interface Gate {
  ownerYield: number | null; mos: number | null; cn10y: number | null; rfFallback: boolean;
  icApprox: boolean; roicMed: number | null; fcfYield: number | null; normYield: number | null;
  passed: boolean; tooRich: boolean; vetoed: boolean; vetoReasons: string[];
}

function gateOf(r: ValueRaw, cn10y: number | null, fin?: { roe: number | null }): Gate {
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
const W_VQ = { moat: 35, cash: 25, safety: 25, health: 15 };
const W_MOAT = { roicCur: 12, roicMed: 13, roicMin3: 10 };   // 用“最差年”而非标准差：护城河是穿越周期不掉
const W_CASH = { fcfYield: 20, div5y: 5 };                    // 用户裁定：股息只给 5%
const W_SAFETY = { ep: 10, normYield: 10, bm: 5 };            // B/M 压低（与 normYield 共享净资产项）
const W_HEALTH = { netCash: 8, debtRatio: 4, gw: 3 };

// A3：本块是 stock-score/engine.ts 的 assignGroups + pctFromEntries 的**语义复制**
// （V1.1 已冻结，不抽公共模块）。任一侧改动必须同步另一侧；'A3 复制体守卫' 钉住分组行为。
function assignGroupsV(rows: { code: string; ths: string[] }[]): Map<string, string> {
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
function pctWithinGroupsV(rows: ValueRaw[], get: (r: ValueRaw) => number | null) {
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

interface ValueRow extends ValueRaw {
  gate: Gate; vq: number | null; vMoat: number | null; vCash: number | null; vSafety: number | null; vHealth: number | null;
  vcov: number; tier: 'qualified' | 'too_rich' | 'unqualified' | 'vetoed';
  confidence: 'A' | 'B' | 'C'; grp: string; indRank: number; indN: number; marketRank: number; marketN: number;
  flags: string[];
}

function computeValue(all: ValueRaw[], cn10y: number | null, finRoe?: Map<string, number>): ValueRow[] {
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
    r.confidence = (r.grp === 'MARKET' && r.indN < 20) || nulls >= 2 || r.vcov < VCOV_MIN ? 'C'
      : nulls === 1 || r.flags.length > 0 || r.gate.vetoed ? 'B' : 'A';
  }
  return out;
}

// gs_value.ts — GS 列式宽表 → ValueRaw[]。规则权威：spec §2（P-1..P-8）/§2.1（批次编排）
// 列名一律按前缀匹配，绝不硬编码日期戳（GS 的戳随快照漂移）；窗口列按字典序 = 时间序。
type GsTable = Record<string, (string | number | null)[]>;

function yearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// spec §2.1：V_Q3 独占历史窗口（P-4 混提会把三表科目戳整体改写成年报）；
// V_Q4 独占估值列（P-3 九字段大查询里 PE/PB 整列被丢弃）。
const V_Q1 = '全部沪深A股的投入资本回报率、股票简称、所属同花顺行业、股票市场类型';
const V_Q2 = '全部沪深A股的企业自由现金流量fcff、货币资金、带息债务、商誉占净资产比例、股票简称';
const buildVQ3 = (b: number): string =>
  `全部沪深A股的${b - 2}年报投入资本回报率、${b - 1}年报投入资本回报率、${b}年报投入资本回报率、股票简称`;
const V_Q4 = '全部沪深A股的市盈率、市净率、总市值、股票简称';
const V_Q5 = '全部沪深A股的股息率、近5年股息率平均值、净资产收益率roe(摊薄)、股票简称';  // 4 字段，仍在 P-3 安全区内

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

async function gsValueFetch(query: string, apiKey: string, timeoutMs = 150_000): Promise<GsTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz code=${j?.result?.[0]?.code}`); // 不带 msg 原文
      const t = j?.data?.[0]?.table as GsTable | undefined;
      if (!t?.['股票代码']) throw new Error('GS table missing');
      return t;
    } catch (e) {
      // TypeError.message 含完整 URL（带 apiKey）→ 折叠（同 stock-score/gs.ts 先例）
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// 列标签 = 去掉 `[数据日期]` 后缀后的列名。GS 在同一张表里并存兄弟列（`股息率` / `股息率平均`、
// `资产负债率` / `资产负债率同比增长率`、`净资产收益率` / 加权公布值），裸 `find(k => k.startsWith(prefix))`
// 的胜负押在响应键序上（真快照键序明显非字典序）→ 会静默绑错列；更糟的是 REQUIRED 守卫会被兄弟列单独满足，
// 目标列整列缺失也能过 P-3、静默跑完整夜（V1.1 `gs.ts:211-212` 就是这么实炸过的）。
const labelOf = (k: string): string => k.replace(/\[.*$/, '');
function colByPrefix(t: GsTable, prefix: string): string | undefined {
  const keys = Object.keys(t);
  const exact = keys.find(k => labelOf(k) === prefix);
  if (exact) return exact;
  // 无全等标签时才退到前缀，且只接受“前缀后接的不是中文后缀”：`市盈率` → `市盈率(pe)` 是同一指标的括号别名（收），
  // `股息率` → `股息率平均` 是另一个指标（拒）。候选多个则取标签最短，再用列名字典序兜底——决定性，绝不返回“响应里第一个”。
  return keys
    .filter(k => labelOf(k).startsWith(prefix) && !/^[\u4e00-\u9fff]/.test(labelOf(k).slice(prefix.length)))
    .sort((a, b) => labelOf(a).length - labelOf(b).length || (a < b ? -1 : 1))[0];
}
// 提问措辞与响应标签不保证一致（V_Q5 问的是「近5年股息率平均值」，探针形态是 `股息率平均[...]`）→ 按候选依次试。
const colAnyOf = (t: GsTable | null, names: string[]): string | null =>
  t ? names.map(n => colByPrefix(t, n)).find(Boolean) ?? null : null;
// 严格窗口列 `名称[yyyyMMdd...]`：排除 "资产负债率同比增长率" 这类同名前缀兄弟列
function windowCols(t: GsTable, name: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(name + '[') && /\[\d{8}/.test(k.slice(name.length))).sort();
}

// 同一指标的「单期年报列族」：按标签前缀取，排除平均值专用列（标签含 `平均`）与区间戳列（`[a-b]`），
// 按戳升序 = 时间升序。真响应的键序是乱的，字典序取首个会绑到最旧一期（见 Task 6B 探针注）。
function annualCols(t: GsTable, labelPrefix: string, requireAnnualOnly = false): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length))
        && (!requireAnnualOnly || stampOf(k).endsWith('1231'));   // 终审 I-4：q3 ROIC 锤死 1231，q5 此前不验 → 中报累计值冒充年报
    })
    .sort((a, b) => {
      if (stampOf(a) !== stampOf(b)) return stampOf(a) < stampOf(b) ? -1 : 1;
      return labelOf(a) < labelOf(b) ? -1 : labelOf(a) > labelOf(b) ? 1 : 0;   // 同戳多别名 → 按标签破平局，绝不依赖响应插入序
    });
}

const num = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null; // 文本列 / 带百分号列一律 NA
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

type BatchName = 'q1' | 'q2' | 'q3' | 'q4' | 'q5';
// q3 的列族守卫同时依赖两件事实（Task 2 执行时定形）：① 响应列名为 `投入资本回报率[yyyyMMdd]`（仓内实探针铁证，见 Fixture 注）；
// ② 「恰好 3 根窗口列」守卫在 assertCols 之后把关，缺任一根 → 数量≠3 → 整批拒绝（与 V1.1 roe3y 同纪律）。
const REQUIRED: Record<BatchName, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率', '所属同花顺行业', '股票市场类型'],
  q2: ['股票代码', '企业自由现金流量fcff', '货币资金', '带息债务', '商誉占净资产比例'],
  q3: ['股票代码', '投入资本回报率'],
  q4: ['股票代码', '市盈率', '市净率', '总市值'],
  // 本表能拦住“当期股息率整列缺失”全靠 colByPrefix 的全等标签优先：裸前缀下 `股息率平均` 会单独满足它。
  // ROE 列必须同行把关（Task 3 实测：上游不传 roe 时低 ROE 银行仅凭价格腿过关）——这条静默路径靠「缺列→整批炸」守。
  // 2026-10-11 真响应铁证：列名是 `净资产收益率roe(摊薄,公布值)[yyyyMMdd]`。守卫前缀必须截在 `摊薄`、
  // 不带右括号，否则 colByPrefix 两条通道都不收 → 整夜零产出（Task 6B 的杀手回归）。`股息率` 裸前缀仍安全：
  // 兄弟列 `股息率平均` 的下一字是中文 → 被下面的“中文后缀拒绝”规则挡掉。
  q5: ['股票代码', '股息率', '净资产收益率roe(摊薄'],
};
function assertCols(t: GsTable, fam: BatchName): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS ${fam} missing column: ${name}`);
}

const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';
// 合法报告期只有四种；其余一律拒（乱戳比放行危险得多）。
const PERIOD_MD = new Set([331, 630, 930, 1231]);

// P-4 双守卫：① 同批绝对值列必须共用一个戳（混提会整体改写）；② 戳必须落在合法报告期窗口
function assertPeriod(t: GsTable, names: string[], now: Date): string {
  const stamps = new Set<string>();
  for (const n of names) for (const k of windowCols(t, n)) { const s = stampOf(k); if (s) stamps.add(s); }
  if (stamps.size === 0) throw new Error('GS period: no dated column found');
  if (stamps.size > 1) throw new Error(`GS period mismatch: ${[...stamps].sort().join(',')}`);
  const s = [...stamps][0];
  const y = Number(s.slice(0, 4)), mmdd = Number(s.slice(4));
  const base = yearAnchors(now).annualBase;
  // 年报可以是 base 年（已披露）或 base+1 年（提前回下年报）；一季/中/三季报告必然属 base+1 年。
  // `mmdd === 331` 必须在内：5 月中至 8 月底 GS 的绝对值列只回 `[yyyy0331]`，原写法（只认 630/930）
  // 会把全年约 1/3 的夜晚拒成炸批零产出。
  const ok = PERIOD_MD.has(mmdd) && (mmdd === 1231 ? y === base || y === base + 1 : y === base + 1);
  if (!ok) throw new Error(`GS period not in allowed window: ${s} (annualBase=${base})`);
  return s;
}

interface ValueRaw {
  code: string; name: string; ths: string[]; isFin: boolean; isST: boolean;
  roic: number | null; roic3: (number | null)[];
  fcff: number | null; cash: number | null; debt: number | null; gw: number | null;
  pe: number | null; pb: number | null; mktcap: number | null;
  divYield: number | null; divY5y: number | null;
  // 金融股否决4 的 ROE 对标列（spec §4 附注）。必填：引擎只经 computeValue 的 finRoe 参数读它，从不读 r.roe，
  // 但字段的存在把“上游有没有取 ROE”变成编译期事实，而不是运行时静默降级。
  roe: number | null;
}

function mergeValueTables(
  t1: GsTable, t2: GsTable, t3: GsTable, t4: GsTable, t5: GsTable | null,
  now: Date = new Date(),
): { rows: ValueRaw[]; stamps: Record<string, string> } {
  assertCols(t1, 'q1'); assertCols(t2, 'q2'); assertCols(t3, 'q3'); assertCols(t4, 'q4');
  if (t5) assertCols(t5, 'q5');
  const stamp2 = assertPeriod(t2, ['货币资金', '带息债务', '企业自由现金流量fcff', '商誉占净资产比例'], now);
  // 当期 ROIC 的戳同受 spec §8 时点纪律约束：原先只把 stampOf(K.roic) 直存 extras、从不校验，漂到任意期次都照落。
  const stamp1 = assertPeriod(t1, ['投入资本回报率'], now);
  const codes = t1['股票代码'] as string[];
  if ((t3['股票代码'] as string[]).length !== codes.length) throw new Error('GS q3 row count differs from q1');
  const roic3Keys = windowCols(t3, '投入资本回报率');          // 已按戳升序 = 时间升序；与 V1.1 的 windowColsByPrefix 同口径
  if (roic3Keys.length !== 3) throw new Error(`GS q3 expected exactly 3 window columns, got ${roic3Keys.length}`);
  // “恰好 3 根”不保证是 3 根**年报**列：{20231231, 20241231, 20260630} 计数也是 3，roic3[2] 会装一期中报值冒充年报，
  // 相对 V1.1（另叠加 anchorsOk 新鲜度双通道）是弱化。锤死年份与期次，宁拒绝不错位。
  const base = yearAnchors(now).annualBase;
  const wantYears = [base - 2, base - 1, base].join(',');
  const gotYears = roic3Keys.map(k => stampOf(k).slice(0, 4)).join(',');
  if (roic3Keys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears)
    throw new Error(`GS q3 expected 3 annual columns (${wantYears}@1231), got ${roic3Keys.map(stampOf).join(',')}`);
  const idx = (t: GsTable | null) => new Map(((t?.['股票代码'] as string[] | undefined) ?? []).map((c, i) => [c, i]));
  const i2 = idx(t2), i3 = idx(t3), i4 = idx(t4), i5 = t5 ? idx(t5) : null;
  const K = {
    name: colByPrefix(t1, '股票简称')!, ths: colByPrefix(t1, '所属同花顺行业')!, mkt: colByPrefix(t1, '股票市场类型')!,
    roic: colByPrefix(t1, '投入资本回报率')!,
    fcff: colByPrefix(t2, '企业自由现金流量fcff')!, cash: colByPrefix(t2, '货币资金')!,
    debt: colByPrefix(t2, '带息债务')!, gw: colByPrefix(t2, '商誉占净资产比例')!,
    pe: colByPrefix(t4, '市盈率')!, pb: colByPrefix(t4, '市净率')!, mc: colByPrefix(t4, '总市值')!,
  };
  // 股息率 / ROE 在真响应里都是年报列族（5 根，键序乱）→ 按戳取最新一期；单列老形态同样命中（族里只有一根）。
  // 【为什么 q5 也要锤 1231】否决4 拿 `roe` 与 ROIC_GATE=8 这个**年化**阈值比（value_engine.ts:50-51）。
  // GS 若回 `净资产收益率roe(摊薄)[yyyy0630]`（H1 累计非年化），一只 H1 ROE 4.5%（年化约 9%，达标）的银行会被判
  // `med<8 && cur<8` → 无护城河证据 → tier=vetoed → 整个银行类出榜。此前 q3 会炸整夜、q5 静默落库，是不对称。
  // q5 是可选批，所以这里**剔出列族**（→ roe=null → 否决4 不判定）而不是炸批：宁缺一个判定，不做一个错判定。
  const dyKeys = t5 ? annualCols(t5, '股息率', true) : [];
  const roeKeys = t5 ? annualCols(t5, '净资产收益率roe(摊薄', true) : [];
  const dyCur = dyKeys.length > 0 ? dyKeys[dyKeys.length - 1] : null;
  const roeCur = roeKeys.length > 0 ? roeKeys[roeKeys.length - 1] : null;
  const dy5Col = colAnyOf(t5, ['股息率平均', '近5年股息率平均值', '近5年股息率']);   // GS 若回专用列优先用（2026-10 实测不回）
  const dy5Keys = dyKeys.slice(-5);   // 最新期起最多 5 根年报列
  const at = (t: GsTable, k: string, i: number): number | null => (i >= 0 ? num(t[k]?.[i]) : null);
  const rows: ValueRaw[] = codes.map((code, i) => {
    const j2 = i2.get(code) ?? -1, j3 = i3.get(code) ?? -1, j4 = i4.get(code) ?? -1, j5 = i5?.get(code) ?? -1;
    const name = str(t1[K.name]?.[i]);
    const mkt = str(t1[K.mkt]?.[i]);   // GS 分层标签串（';' 分隔）；缺 "全部A股(非ST)" 即视为该类
    return {
      code, name, ths: str(t1[K.ths]?.[i]).split('-'),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      roic: at(t1, K.roic, i),
      roic3: roic3Keys.map(k => at(t3, k, j3)),
      fcff: at(t2, K.fcff, j2), cash: at(t2, K.cash, j2), debt: at(t2, K.debt, j2),
      gw: at(t2, K.gw, j2),                                    // 空值语义①：商誉空 → 0（在引擎侧落地）
      pe: at(t4, K.pe, j4), pb: at(t4, K.pb, j4), mktcap: at(t4, K.mc, j4),
      // 空值语义②（三种空不可互换）：整批缺席 → NA；该批成功但表里无此行（j5<0）→ NA；行在而值空 → 0（从不分红）。
      // 原写法 `?? 0` 无行存在性门控，把“行缺席”折叠成“从不分红”，与 V1.1 的 momRowOk/strictWin 先行门控相反。
      divYield: !t5 || dyCur === null || j5 < 0 ? null : num(t5[dyCur]?.[j5]) ?? 0,
      divY5y: !t5 || j5 < 0 || (dy5Col === null && dy5Keys.length === 0) ? null
        : dy5Col !== null ? num(t5[dy5Col]?.[j5]) ?? 0
          : dy5Keys.reduce((a, k) => a + (num(t5[k]?.[j5]) ?? 0), 0) / dy5Keys.length,
      roe: !t5 || roeCur === null ? null : at(t5, roeCur, j5),    // 批次缺席 / 行缺席 → NA（否决4 不判定，不得归 0）
    };
  });
  const stamps: Record<string, string> = { fin_period: stamp2, val_period: stampOf(K.pe), roic_period: stamp1 };
  if (dyCur) stamps.div_period = stampOf(dyCur);   // spec §8：q5 绑的是哪一期必须可见
  if (roeCur) stamps.roe_period = stampOf(roeCur); // 首夜若它不是 1231 结尾，ROE 就是非年化累计值 → 否决4 需重新裁定
  return { rows, stamps };
}

// rf.ts — 十年期国债收益率（门禁层的尺子）。规则权威：spec §4/§9.2 + 计划修订 A2
// 数据源是 gs-economy-query skill 的底层端点（Edge 里跑不了 python 脚本），响应为自然语言。
// 因此解析采取「宁缺勿猜」：拿不到就返回 null，由编排层走 OWNER_YIELD_FLOOR 退化路径。
const ECONOMY_BASE = 'https://dgzt.guosen.com.cn/skills/agent/adapter/query';
const CN10Y_TEXT = '中国十年期国债收益率最新值';
const CN10Y_MIN = 0.5, CN10Y_MAX = 5.0;      // %；窗外一律视为解析失败
const OVERRIDE_MAX_AGE_DAYS = 45;

async function fetchCn10yStream(apiKey: string, timeoutMs = 60_000): Promise<string> {
  const qs = new URLSearchParams({ text: CN10Y_TEXT, softName: 'goldsun_skills', apiKey });
  try {
    const r = await fetch(`${ECONOMY_BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return '';
    const j = await r.json();
    if (j?.result?.[0]?.code !== 0) return '';
    return (j?.data ?? []).filter((x: Record<string, unknown>) => x?.type === 'STREAM_MESSAGE')
      .map((x: Record<string, unknown>) => String(x.content ?? '')).join('');
  } catch { return ''; }                      // TypeError.message 含带 key 的 URL → 吐空串，不往上传
}

function pctAt(text: string): { i: number; v: number }[] {
  const out: { i: number; v: number }[] = [];
  const re = /(\d+(?:\.\d+)?)\s*%/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ i: m.index, v: Number(m[1]) });
  return out;
}

function parseCn10y(text: string): number | null {
  const pcts = pctAt(text ?? '');
  if (pcts.length === 0) return null;
  // 优先取“10年/十年/10Y”之后 30 字内第一个百分数（多利率并列时防拿错）
  const anchor = text.search(/10\s*年|十年|10Y/i);
  const cand = anchor >= 0 ? pcts.filter(x => x.i >= anchor && x.i - anchor <= 30) : [];
  const pick = (cand.length ? cand : pcts).find(x => x.v >= CN10Y_MIN && x.v <= CN10Y_MAX);
  return pick ? pick.v : null;
}

function resolveCn10y(i: { override: number | null; overrideOn: string | null; fetched: number | null; today: string }):
  { cn10y: number | null; source: 'override' | 'auto' | 'none' } {
  const fresh = i.override !== null && i.overrideOn !== null &&
    (Date.parse(i.today) - Date.parse(i.overrideOn)) / 86400_000 <= OVERRIDE_MAX_AGE_DAYS;
  if (fresh) return { cn10y: i.override, source: 'override' };
  if (i.fetched !== null) return { cn10y: i.fetched, source: 'auto' };
  return { cn10y: null, source: 'none' };
}


// stock-value 编排层。规则权威：spec §2.1（批次）/§4–§6（引擎）/§8（存储与快照）





const MIN_ROWS = 4000;                       // 与 stock-score 同阈值：短表一律视为接口异常

// 四腿必须进 MainSnap：`toDbRow` 里 `mainLegs` 直接读它们（spec §7.2 归因句）；**不含 roe**，金融股 ROE 走本批 q5（Task 5 裁定 2）
type MainSnap = { final: number | null; confidence: string | null;
  quality: number | null; growth: number | null; value: number | null; momentum: number | null };
type DbRow = Record<string, unknown>;

function buildExtras(
  stamps: Record<string, string>, r: ValueRow,
  meta: { cn10ySource: string; icApprox: boolean; mainLegs: Record<string, number | null> | null },
): Record<string, unknown> {
  return {
    stamps,                                  // 时点纪律（spec §8）：每个字段的 GS 日期戳原样落库
    cn10y_source: meta.cn10ySource,
    ic_approx: meta.icApprox || null,
    main_legs: meta.mainLegs,                // 分歧榜归因用（spec §7.2）：主分四条腿当晚快照
    grp: r.grp,
    owner_cash: r.gate.fcfYield, owner_norm: r.gate.normYield,   // 取小前的两条腿，页面可解释
    veto_reasons: r.gate.vetoReasons,
  };
}

// 池内分位（spec §7.1/§7.4 的「池内 P」）：宇宙 = 本批 in_pool 且 vq 非 null 的行，按 vq 降序。
// 与引擎给 marketRank 的排序口径逐字一致（`sort((a,b)=>b.vq!-a.vq!)`），两套分位才可对照。
// 不在 value_engine 里算：引擎不接 poolSet（池信息是编排层从 stock_pool 取来的）。
function poolRanks(computed: ValueRow[], poolSet: Set<string>): Map<string, { rank: number; n: number }> {
  const inPool = computed
    .filter(r => r.vq !== null && poolSet.has(r.code.split('.')[0]))
    .sort((a, b) => b.vq! - a.vq!);
  const m = new Map<string, { rank: number; n: number }>();
  inPool.forEach((r, i) => m.set(r.code.split('.')[0], { rank: i + 1, n: inPool.length }));
  return m;
}

function toDbRow(
  r: ValueRow, batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none', pool?: Map<string, { rank: number; n: number }>,
): DbRow {
  const bare = r.code.split('.')[0];
  const m = main.get(bare) ?? null;
  return {
    batch_date: batch, code: bare, name: r.name, ths_l1: r.ths[0] ?? null, ths_l2: r.ths[1] ?? null,
    in_pool: poolSet.has(bare),
    roic_cur: r.roic, fcff: r.fcff, mktcap: r.mktcap, pe: r.pe, pb: r.pb,
    cash: r.cash, debt: r.debt, gw_pct: r.gw, div_yield: r.divYield, div_yield_5y: r.divY5y,
    roic_med: r.gate.roicMed, roic_min3: roicStats(r.roic3).min3, ic: investedCapital(r),
    fcf_yield: r.gate.fcfYield, ep: r.pe !== null && r.pe > 0 ? 100 / r.pe : null,
    bm: r.pb !== null && r.pb > 0 ? 100 / r.pb : null, norm_yield: r.gate.normYield,
    net_cash_ratio: r.cash !== null && r.debt !== null && r.mktcap !== null && r.mktcap > 0
      ? (r.cash - r.debt) / r.mktcap : null,
    debt_ratio: !r.isFin && r.debt !== null && r.cash !== null && r.cash + r.debt > 0 ? r.debt / (r.cash + r.debt) : null,
    owner_yield: r.gate.ownerYield, margin_of_safety: r.gate.mos, cn10y: r.gate.cn10y, rf_fallback: r.gate.rfFallback,
    vq: r.vq, v_moat: r.vMoat, v_cash: r.vCash, v_safety: r.vSafety, v_health: r.vHealth,
    vcov: r.vcov, tier: r.tier, confidence: r.confidence,
    vetoed: r.gate.vetoed, veto_reasons: r.gate.vetoReasons, flags: r.flags,
    ind_rank: r.indRank, ind_n: r.indN, market_rank: r.marketRank, market_n: r.marketN,
    pool_rank: pool?.get(bare)?.rank ?? null, pool_n: pool?.get(bare)?.n ?? null,
    main_final: m?.final ?? null, main_confidence: m?.confidence ?? null,
    extras: buildExtras(stamps, r, {
      cn10ySource, icApprox: r.gate.icApprox,
      mainLegs: m ? { quality: m.quality, growth: m.growth, value: m.value, momentum: m.momentum } : null,
    }),
  };
}

// 编排层的落库映射：池内分位必须在这里接线到每一行。抽成导出的纯函数（而不是留在 handler 里两行），
// 是为了让「漏接 pool」这种错误变成可测缺陷 —— 它曾让 pool_rank/pool_n 永远 NULL 而全部测试照绿（终审 I-3 变异检验）。
function buildDbRows(
  computed: ValueRow[], batch: string, poolSet: Set<string>, main: Map<string, MainSnap>,
  stamps: Record<string, string>, cn10ySource = 'none',
): DbRow[] {
  const pool = poolRanks(computed, poolSet);
  return computed.map(r => toDbRow(r, batch, poolSet, main, stamps, cn10ySource, pool));
}

function svcHeaders(): Record<string, string> {
  const k = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
}

async function upsert(rows: DbRow[]) {
  const url = Deno.env.get('SUPABASE_URL')!;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${url}/rest/v1/stock_value?on_conflict=batch_date,code`, {
      method: 'POST', headers: { ...svcHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`upsert stock_value ${r.status} ${await r.text()}`);
  }
}

// 主分快照 + 四条腿（供分歧榜归因）：只读最新批次的 in_pool 行（分歧榜本质是池内对比，无需全宇宙）
async function readMainSnapshot(url: string): Promise<{ batch: string | null; map: Map<string, MainSnap> }> {
  const b = await fetch(`${url}/rest/v1/stock_score?select=batch_date&order=batch_date.desc&limit=1`, { headers: svcHeaders() });
  if (!b.ok) throw new Error(`read stock_score batch ${b.status}`);
  const bb = (await b.json())[0] as { batch_date: string } | undefined;
  if (!bb) throw new Error('stock_score has no batch yet — value leg must run AFTER stock-score');
  const d = await fetch(`${url}/rest/v1/stock_score?select=code,final,confidence,quality,growth,value,momentum&batch_date=eq.${bb.batch_date}&in_pool=eq.true`, { headers: svcHeaders() });
  if (!d.ok) throw new Error(`read stock_score rows ${d.status}`);
  const map = new Map<string, MainSnap>();
  for (const x of await d.json()) map.set(String(x.code), {
    final: x.final ?? null, confidence: x.confidence ?? null,
    quality: x.quality ?? null, growth: x.growth ?? null, value: x.value ?? null, momentum: x.momentum ?? null,
  });
  return { batch: bb.batch_date, map };
}

if (!Deno.env.get('STOCK_VALUE_DISABLE_SERVE')) {
Deno.serve(async (req: Request) => {
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || req.headers.get('Authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const key = Deno.env.get('GS_API_KEY') || '';
  if (!key) return Response.json({ ok: false, error: 'GS_API_KEY missing' }, { status: 500 });
  const mode = new URL(req.url).searchParams.get('mode') || 'run';
  const url = Deno.env.get('SUPABASE_URL')!;
  try {
    if (mode === 'ping') {
      const t = await gsValueFetch(V_Q4, key, 30_000);
      return Response.json({ ok: true, rows: (t['股票代码'] ?? []).length });
    }
    const now = new Date();
    const { annualBase } = yearAnchors(now);
    // 四个硬批次：任一失败/短表/缺列 → assertCols/行守抛错 → 外层 catch 保留旧批次
    const [t1, t2, t3, t4] = await Promise.all([
      gsValueFetch(V_Q1, key), gsValueFetch(V_Q2, key), gsValueFetch(buildVQ3(annualBase), key), gsValueFetch(V_Q4, key),
    ]);
    for (const t of [t1, t2, t3, t4]) if ((t['股票代码']?.length ?? 0) < MIN_ROWS) throw new Error('GS 短表，保留旧批次');
    // 分红+金融 ROE 批是“尽力而为”腿（同 stock-score 现金腿）：失败只置 NA，绝不杀整批
    let t5 = null;
    try { const c = await gsValueFetch(V_Q5, key, 60_000); if ((c['股票代码']?.length ?? 0) >= MIN_ROWS) t5 = c; } catch { t5 = null; }
    const { rows, stamps } = mergeValueTables(t1, t2, t3, t4, t5, now);

    // cn10y：override 优先，其次自动取数，全缺则引擎走 OWNER_YIELD_FLOOR 退化
    const cfgR = await fetch(`${url}/rest/v1/value_config?select=cn10y_override,cn10y_manual_on&limit=1`, { headers: svcHeaders() });
    const cfg = cfgR.ok ? ((await cfgR.json())[0] ?? {}) : {};
    const resolved = resolveCn10y({
      override: cfg.cn10y_override ?? null, overrideOn: cfg.cn10y_manual_on ?? null,
      fetched: parseCn10y(await fetchCn10yStream(key)), today: now.toISOString().slice(0, 10),
    });

    const main = await readMainSnapshot(url);
    const poolR = await fetch(`${url}/rest/v1/stock_pool?select=code`, { headers: svcHeaders() });
    if (!poolR.ok) throw new Error(`read stock_pool ${poolR.status}`);
    const poolSet = new Set(((await poolR.json()) as { code: string }[]).map(x => x.code));

    // 金融股否决4 的 ROE 只认本批自己那一列（Task 5 裁定 2）；钥匙必须是 `ValueRaw.code` 原样（带后缀），与引擎内部 `finRoe?.get(s.code)` 同一把
    const finRoe = new Map<string, number>();
    for (const s of rows) if (s.roe !== null) finRoe.set(s.code, s.roe);
    const computed = computeValue(rows as ValueRaw[], resolved.cn10y, finRoe);
    const batch = now.toISOString().slice(0, 10);
    await upsert(buildDbRows(computed, batch, poolSet, main.map, stamps, resolved.source));

    const by = (t: string) => computed.filter(r => r.tier === t).length;
    return Response.json({ ok: true, batch_date: batch, rows: computed.length, qualified: by('qualified'),
      too_rich: by('too_rich'), vetoed: by('vetoed'), unqualified: by('unqualified'),
      a_level: computed.filter(r => r.confidence === 'A').length,
      cn10y: resolved.cn10y, cn10y_source: resolved.source, div_leg_ok: t5 !== null,
      fin_roe_rows: finRoe.size,   // 遥测（Task 6 评审 M4）：带后缀键的金融股 ROE 行数——它是唯一无单测护栏的否决4 入口，靠这个数才能「首夜看穿」
      main_batch: main.batch, stamps });
  } catch (e) {
    // 不分述原始错误（可能含 URL）；gsValueFetch 已折叠 TypeError，这里再洗一道
    const msg = String(e).replace(/\S*apiKey=\S*/g, 'apiKey=REDACTED').slice(0, 300);
    return Response.json({ ok: false, error: msg, kept_old_batch: true }, { status: 500 });
  }
});
}
