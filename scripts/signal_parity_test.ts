// scripts/signal_parity_test.ts — 双端信号一致性门禁（2026-10-18 立）
//
// 背景：daily-update 在注释里自称「复刻页面 evalFundSignal」，但历史上存在两处漂移——
//   ① 优先级顺序不同（页面：QDII → 手动暂停/恢复 → 仓位超限 → 常规；服务端曾把上限排在手动暂停之前，
//      于是「恢复条件已满足」的基金在邮件里仍报「仓位超限」，与页面结论相反）；
//   ② 估值百分位腿缺失（页面档位 = 均线偏离 + 估值百分位两腿，邮件只有均线腿，同一只基金两处档位不同）。
// 同时大盘系数表 / 默认主题上限 / 止盈档 / 偏离度算法在页面与服务端各写了一份，没有护栏。
//
// 本测试把两侧都当真源：index.html 的 SIGNAL_PURE 块经 scripts/signal_parity.ts 逐字抽取执行，
// 与 supabase/functions/daily-update/index.ts 的导出函数做穷举矩阵比对。口径改动只有三条路：
//   改页面 + 改服务端（测试保持绿）｜只改一侧（测试红，指出首个不一致的场景）。
//
// 比对契约：标签词表允许差异（页面 QDII 只写「暂停」+理由，邮件保留「暂停（QDII溢价）」后缀供动作文案识别），
// 但「结论类别」与「倍数」必须一致——这两个量正是页面卡片与邮件建议金额的驱动量。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BENCHMARKS, DEFAULT_THEMES as PAGE_THEMES, DEFAULT_CAPS as PAGE_CAPS, DEFAULT_TIERS as PAGE_TIERS,
  marketLevel as pageMarketLevel, baseSignal, evalFundSignal, fundBenchKey, computeDeviation,
  computeReturn as pageComputeReturn, dualSignal, pctTier, setState,
  dipAlertStock as pageDipAlertStock, dipAlertFundLadder as pageDipFundLadder,
  buyBannerHtml as pageBuyBanner,
  stockAddPlan as pageStockAddPlan, stockBuyBannerHtml as pageStockBuyBanner,
  stockLotSizeOf as pageStockLotSizeOf, lotFromTxQuote as pageLotFromTxQuote,
  supabaseBaseUrl as pageSupabaseBaseUrl,
} from "./signal_parity.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
const D = await import("../supabase/functions/daily-update/index.ts");

// deno-lint-ignore no-explicit-any
type Any = any;

type Canon = { kind: "qdii" | "cap" | "manual-paused" | "resume" | "base"; mult: number };
function canon(r: Any): Canon {
  const label = String(r?.label ?? "");
  const mult = Number(r?.multiplier);
  if (label.includes("QDII")) return { kind: "qdii", mult };
  if (label === "暂停（仓位超限）") return { kind: "cap", mult };
  if (label === "暂停中") return { kind: "manual-paused", mult };
  if (r?.resumeReady || r?.level === "resume-ready") return { kind: "resume", mult };
  if (r?.forced) return { kind: "qdii", mult };   // 页面 QDII 暂停的标签只有「暂停」，靠 forced 区分
  return { kind: "base", mult };
}

type RetMode = "flat" | "up" | "down" | "deep";

function makeFund(dev: number | null, pctRaw: unknown, opts: {
  theme?: string; manualPause?: boolean; streak?: number; resumeRule?: unknown; retMode?: RetMode;
} = {}): Record<string, unknown> {
  // 两条均线都钉在 100，净值 = 100×(1+dev%) ⇒ 页面 computeDeviation 与服务端 avgDev 应同为 dev
  const ma = dev === null ? null : 100;
  const nav = dev === null ? 100 : 100 * (1 + dev / 100);
  // 成本决定收益率（只对手动暂停的跌幅腿有意义）：flat ⇒ 收益 = dev%；up ⇒ +42.9%；down ⇒ −4.8%；deep ⇒ −16.7%
  const costBasis = opts.retMode === "up" ? nav * 0.7
    : opts.retMode === "down" ? nav * 1.05
    : opts.retMode === "deep" ? nav * 1.2
    : 1.0;
  const f: Record<string, unknown> = {
    theme: opts.theme ?? "T", ma60: ma, ma120: ma, currentNav: nav,
    costBasis, valuationPercentile: pctRaw,
  };
  if (opts.manualPause) {
    f.manualPause = true;
    f.aboveMaStreak = opts.streak ?? 0;
    if (opts.resumeRule !== undefined) f.resumeRule = opts.resumeRule;
  }
  return f;
}

// 单场景双端比对：注入相同全局态（主题市值 / 上限表 / 目标额），两侧各算一次
function compareOne(f: Record<string, unknown>, mv: number, caps: Record<string, number>, tag: string): void {
  setState({ funds: [{ theme: f.theme as string, marketValue: mv }], themeCaps: caps, goal: 200000 });
  const dev = computeDeviation(f);
  // deno-lint-ignore no-explicit-any
  const page = evalFundSignal(f as any);
  // deno-lint-ignore no-explicit-any
  const server = D.evalFundSignalServer(f, f.currentNav as number, dev, (f.aboveMaStreak ?? null) as number | null, caps, mv, 200000);
  assertEquals(canon(server), canon(page),
    `${tag}：双端结论不一致（页面 ${page.label} ×${page.multiplier}｜服务端 ${server.label} ×${server.multiplier}）`);
}

const DEVS: (number | null)[] = [null, -20, -15, -14.9, -6, -5, -4.9, -3, 0, 2.9, 3, 4.9, 5, 10, 12];
const PCTS: unknown[] = [null, "", undefined, 10, 20, 20.1, 40, 40.1, 59.9, 60, 70, 79.9, 80, 95, "85", "abc"];

type ManualCase = { tag: string; manualPause?: boolean; streak?: number; resumeRule?: unknown; retMode?: RetMode };
const MANUAL: ManualCase[] = [
  { tag: "未暂停" },
  { tag: "暂停·全默认(resumeRule 缺省)", manualPause: true, streak: 0 },
  { tag: "暂停·全默认(连续天数已够)", manualPause: true, streak: 3 },
  { tag: "暂停·ma_only 满足", manualPause: true, streak: 3, resumeRule: { requireDays: 3, mode: "ma_only" } },
  { tag: "暂停·ma_only 未满足", manualPause: true, streak: 2, resumeRule: { requireDays: 3, mode: "ma_only" } },
  { tag: "暂停·and 双满足", manualPause: true, streak: 5, resumeRule: { requireDays: 4, mode: "ma_and_drawdown", targetDrawdown: 10 }, retMode: "deep" },
  { tag: "暂停·and 均线够但跌幅未达", manualPause: true, streak: 5, resumeRule: { requireDays: 4, mode: "ma_and_drawdown", targetDrawdown: 10 }, retMode: "up" },
  { tag: "暂停·or 跌幅腿满足", manualPause: true, streak: 0, resumeRule: { requireDays: 4, mode: "ma_or_drawdown", targetDrawdown: 8 }, retMode: "deep" },
  { tag: "暂停·or 两腿都不满足", manualPause: true, streak: 0, resumeRule: { requireDays: 4, mode: "ma_or_drawdown", targetDrawdown: 8 }, retMode: "up" },
  { tag: "暂停·targetDrawdown 空串(跌幅腿不参与)", manualPause: true, streak: 0, resumeRule: { requireDays: 2, mode: "ma_or_drawdown", targetDrawdown: "" } },
];

type CapCase = { tag: string; mv: number; caps: Record<string, number>; theme?: string };
const CAPS: CapCase[] = [
  { tag: "未超限(差 1 元)", mv: 19999, caps: { T: 10 } },
  { tag: "恰好等于上限(≥ 即超限)", mv: 20000, caps: { T: 10 } },
  { tag: "已超限", mv: 25000, caps: { T: 10 } },
  { tag: "主题无上限条目→默认 100%", mv: 199999, caps: {}, theme: "U" },
  { tag: "主题无上限条目·恰好等于目标额", mv: 200000, caps: {}, theme: "U" },
];

type QdiiCase = { tag: string; isQDII?: boolean; premium?: unknown };
const QDIIS: QdiiCase[] = [
  { tag: "非 QDII" },
  { tag: "QDII·无溢价" },
  { tag: "QDII·溢价空串", isQDII: true, premium: "" },
  { tag: "QDII·溢价 1.9%(未触发)", isQDII: true, premium: 1.9 },
  { tag: "QDII·溢价 2%(触发)", isQDII: true, premium: 2 },
  { tag: "QDII·溢价字符串 3.5%", isQDII: true, premium: "3.5" },
  { tag: "QDII·溢价非数值(不触发)", isQDII: true, premium: "abc" },
  { tag: "QDII·溢价 null(不触发)", isQDII: true, premium: null },
];

Deno.test("穷举矩阵：均线腿 × 估值百分位腿 × 手动暂停/恢复 × 仓位上限 × QDII 优先级，双端逐格一致", () => {
  let n = 0;
  for (const cap of CAPS) {
    for (const m of MANUAL) {
      for (const q of QDIIS) {
        for (const dev of DEVS) {
          for (const pct of PCTS) {
            const f = makeFund(dev, pct, { theme: cap.theme ?? "T", manualPause: m.manualPause, streak: m.streak, resumeRule: m.resumeRule, retMode: m.retMode });
            if (q.isQDII) {
              f.isQDII = true;
              // premium 缺省（undefined）由 makeFund 不写入字段来覆盖
              if (q.premium !== undefined) f.qdiiPremium = q.premium;
            }
            const tag = `[${cap.tag}｜${m.tag}｜${q.tag}｜dev=${dev}｜pct=${String(pct)}]`;
            compareOne(f, cap.mv, cap.caps, tag);
            n++;
          }
        }
      }
    }
  }
  assert(n > 30000, `矩阵规模异常小：${n}`);   // 防「循环写错导致根本没跑」的静默空转
});

Deno.test("边界钉死：缺数据不造词（dev=null → 正常），估值分位对基金已无影响", () => {
  setState({ funds: [], themeCaps: {}, goal: 200000 });
  // 均线腿全缺：页面口径不给「缺数据」标签，报告里由状态行（zone=数据不足）披露
  assertEquals(evalFundSignal({ ma60: null, ma120: null, currentNav: 100 }), {
    level: "normal", label: "正常", multiplier: 1,
    reasons: ["未填写均线数据，偏离度信号缺省为中性"],
  });
  // 基金侧取消估值分位（2026-10-28 用户裁决）：填了也不参与，缺均线一律回中性（旧规则会抬成加强）
  assertEquals(evalFundSignal({ ma60: null, ma120: null, currentNav: 100, valuationPercentile: 10 }).label, "正常");
  // 只有一条均线（ma120 缺）→ 单腿偏离照常参与（-6% → 加强）；pct 95 不许把它抵成正常
  assertEquals(evalFundSignal({ ma60: 100, ma120: null, currentNav: 94, valuationPercentile: 95 }).label, "加强");
});

Deno.test("golden nails：档位词表（基金侧只吃均线腿，分位填什么都无感）", () => {
  setState({ funds: [], themeCaps: {}, goal: 200000 });
  const cases: [Record<string, unknown>, string, number][] = [
    [{ ma60: 100, ma120: 100, currentNav: 94 }, "加强", 1.5],   // dev −6（+1）
    [{ ma60: 100, ma120: 100, currentNav: 100 }, "正常", 1],
    [{ ma60: 100, ma120: 100, currentNav: 99 }, "正常", 1],     // dev −1（0）
    // 均线单腿最高 +2 / 最低 −2 ⇒ 「双倍」(≥3) 与「暂停」(≤−3) 在基金侧已不可达（2026-10-28 取消分位腿的后果）
    [{ ma60: 100, ma120: 100, currentNav: 80 }, "加强", 1.5],   // dev −20 封顶 +2
    [{ ma60: 100, ma120: 100, currentNav: 112 }, "减半", 0.5],  // dev +12 封底 −2
  ];
  for (const [f, label, mult] of cases) {
    const r = baseSignal(f);
    assertEquals({ label: r.label, mult: r.multiplier }, { label, mult });
  }
  // 分位字段在基金侧已下线：同一组均线，填 10/60/95 的结论必须与不填完全一致
  for (const pct of [10, 60, 95]) {
    const r = baseSignal({ ma60: 100, ma120: 100, currentNav: 94, valuationPercentile: pct });
    assertEquals({ label: r.label, mult: r.multiplier }, { label: "加强", mult: 1.5 }, "pct=" + pct);
  }
  // 双信号仲裁仍在（股票腿还在用）：百分位 ≥80 时回撤加仓被「不追跌」否决
  const vetoed = dualSignal(90, 35);
  assertEquals({ addPct: vetoed.addPct, vetoed: vetoed.vetoed, label: vetoed.label }, { addPct: 0, vetoed: true, label: "暂停" });
  // 未高估时回撤阶梯照常累加：百分位中性 ×1 + 回撤 35% 档 +40% → 加强
  const ok = dualSignal(50, 35);
  assertEquals({ addPct: ok.addPct, vetoed: ok.vetoed, label: ok.label }, { addPct: 40, vetoed: false, label: "加强" });
  assertEquals(pctTier(null), null, "百分位缺数据必须是 null（不许落 0 被读成低估）");
});

Deno.test("基金侧取消估值分位：pct 10→95 对双端结论零影响（旧规则会改档）", () => {
  setState({ funds: [], themeCaps: {}, goal: 200000 });
  for (const dev of DEVS) {
    const refF = makeFund(dev, null);
    const pageRef = evalFundSignal(refF);
    const srvRef = D.evalFundSignalServer(refF, refF.currentNav as number, computeDeviation(refF), null, {}, 0, 200000);
    for (const pct of [10, 20, 40, 60, 79.9, 80, 95]) {
      const f = makeFund(dev, pct);
      const pageR = evalFundSignal(f);
      const srvR = D.evalFundSignalServer(f, f.currentNav as number, computeDeviation(f), null, {}, 0, 200000);
      assertEquals({ label: pageR.label, multiplier: pageR.multiplier },
        { label: pageRef.label, multiplier: pageRef.multiplier }, `页面 dev=${dev} pct=${pct} 仍受分位影响`);
      assertEquals({ label: srvR.label, multiplier: srvR.multiplier },
        { label: pageR.label, multiplier: pageR.multiplier }, `服务端 dev=${dev} pct=${pct}`);
      assertEquals({ label: srvRef.label, multiplier: srvRef.multiplier },
        { label: pageRef.label, multiplier: pageRef.multiplier }, `服务端无分位基准 dev=${dev}`);
    }
  }
});

Deno.test("双信号条：基金 withPct=false 不再提估值分位，股票侧仍提示未填", () => {
  const fundSide = dualSignal(null, 36, false);
  assertEquals(fundSide.reasons.some(r => r.includes("估值")), false, "基金侧已无该指标，理由里不许再提");
  assertEquals({ addPct: fundSide.addPct, total: fundSide.total.toFixed(2) }, { addPct: 40, total: "1.40" });
  const stockSide = dualSignal(null, 36);
  assertEquals(stockSide.reasons.some(r => r.includes("未填估值百分位")), true, "股票侧仍保留提示");
});

Deno.test("常量同源：大盘系数表 / 默认主题上限 / 止盈档 两端逐值一致", () => {
  assertEquals(Object.keys(D.BENCH), Object.keys(BENCHMARKS), "大盘指数键集合");
  for (const k of Object.keys(D.BENCH)) {
    assertEquals(D.BENCH[k].secid, BENCHMARKS[k].secid, `${k} secid`);
    assertEquals(D.BENCH[k].name, BENCHMARKS[k].name, `${k} name`);
    assertEquals(D.BENCH[k].th, BENCHMARKS[k].th, `${k} 阈值`);
  }
  assertEquals(D.DEFAULT_CAPS, PAGE_CAPS, "默认主题上限");
  assertEquals(PAGE_THEMES, Object.keys(PAGE_CAPS), "主题清单与上限表键序必须一致（表单按此渲染）");
  assertEquals(D.DEFAULT_TIERS, PAGE_TIERS, "默认止盈档");
});

Deno.test("大盘档位：系数阶梯与阈值边界两端逐值一致（dev 网格 × 每个指数的阈值）", () => {
  const devs = [null, -20, -12.1, -12, -8.1, -8, -5, -4.9, -3.1, -3, -2.9, 0, 2.9, 3, 3.1, 5, 7.9, 8, 8.1, 12, 12.1, 20];
  for (const k of Object.keys(BENCHMARKS)) {
    for (const dev of devs) {
      const page = pageMarketLevel(dev, BENCHMARKS[k].th);
      const server = D.marketLevel(dev, D.BENCH[k].th);
      assertEquals({ level: server.level, coef: server.coef, label: server.label },
        { level: page.level, coef: page.coef, label: page.label },
        `${k}｜dev=${dev}`);
    }
  }
});

Deno.test("偏离度与成本口径：页面 computeDeviation/computeReturn 与服务端 avgDev/computeReturn 同值", () => {
  const cases: { close: number; ma60: number | null; ma120: number | null }[] = [
    { close: 94, ma60: 100, ma120: 100 },
    { close: 80, ma60: 100, ma120: null },
    { close: 120, ma60: null, ma120: 100 },
    { close: 100, ma60: null, ma120: null },
    { close: 100, ma60: 0, ma120: 100 },      // 均线 0 视为缺失（两侧同款 `if (ma)` 守卫）
  ];
  for (const c of cases) {
    const page = computeDeviation({ currentNav: c.close, ma60: c.ma60, ma120: c.ma120 });
    const server = D.avgDev(c.close, c.ma60, c.ma120);
    assertEquals(server, page, `dev: close=${c.close} ma60=${c.ma60} ma120=${c.ma120}`);
    if (page === null) assertEquals(server, null, "两腿全缺必须是 null（不是 0）");
  }
  const costCases: Record<string, unknown>[] = [
    { currentNav: 1.2, costBasis: 1.2 },
    { currentNav: 1.2, costBasis: 0, costTotal: 12000, marketValue: 12000 },
    { currentNav: 1.2, costBasis: 0, costTotal: 12000, marketValue: 0 },   // 折算不出份额 ⇒ 无收益率
    { currentNav: 1.2 },                                                    // 什么都没填 ⇒ 无收益率
  ];
  for (const f of costCases) {
    // deno-lint-ignore no-explicit-any
    assertEquals(D.computeReturn(f.currentNav as number, f), pageComputeReturn(f as any), JSON.stringify(f));
  }
});

Deno.test("大盘参考键：空串 = 豁免（不参考），未填 = HS300，未知键两端同判", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ benchmark: "" }, ""],              // 用户明确选「不参考」
    [{}, "HS300"],                        // 未填 → 默认
    [{ benchmark: undefined }, "HS300"],
    [{ benchmark: "HS300" }, "HS300"],
    [{ benchmark: "HSTECH" }, "HSTECH"],
    [{ benchmark: "不存在的指数" }, "不存在的指数"],   // 未知键：两端都拿不到档位 → 系数 1
  ];
  for (const [f, expected] of cases) {
    assertEquals(D.fundBenchKey(f), expected, `服务端 ${JSON.stringify(f)}`);
    assertEquals(fundBenchKey(f), expected, `页面 ${JSON.stringify(f)}`);
  }
});

Deno.test("回撤抄底门槛：基金与股票统一 30%，页面 dipAlert* 与服务端 dipLadder 逐格一致", () => {
  const high = 100;
  const pcts: Array<number | null> = [null, 0, 79.9, 80, 95];
  for (let dd = 0; dd <= 60; dd += 0.5) {
    const price = high * (1 - dd / 100);
    for (const pct of pcts) {
      const srvS = D.dipLadder({ high52w: high }, price, pct);
      const pageS = pageDipAlertStock({ high52w: high, currentPrice: price, valuationPercentile: pct });
      assertEquals(pageS === null, srvS === null, `股票亮灯 dd=${dd} pct=${pct}`);
      assertEquals(pageS?.add ?? null, srvS?.add ?? null, `股票档位 dd=${dd} pct=${pct}`);
      assertEquals(pageS?.dd.toFixed(6) ?? null, srvS?.dd.toFixed(6) ?? null, `股票回撤 dd=${dd} pct=${pct}`);

      // 基金侧不再传分位（2026-10-28）：页面腿把 valuationPercentile 显式置空，服务端传 null
      const srvF = D.dipLadder({ high52w: high }, price, null);
      const pageF = pageDipFundLadder({ high52w: high, currentNav: price, valuationPercentile: pct }, { level: "watch" });
      assertEquals(pageF === null, srvF === null, `基金亮灯 dd=${dd} pct=${pct}`);
      assertEquals(pageF?.add ?? null, srvF?.add ?? null, `基金档位 dd=${dd} pct=${pct}`);
      assertEquals(pageF?.dd.toFixed(6) ?? null, srvF?.dd.toFixed(6) ?? null, `基金回撤 dd=${dd} pct=${pct}`);
    }
  }
  // 门槛本身钉死：29.5 不亮、30.0 亮；30–34.9 是 +30 档、35 起 +40 档、50 起 +60 档
  const at = (d: number) => ({
    high52w: high, currentPrice: high * (1 - d / 100), currentNav: high * (1 - d / 100),
  });
  assertEquals(pageDipAlertStock(at(20)), null, "股票 dd 20% 不再亮（统一 30%）");
  assertEquals(pageDipFundLadder(at(20), { level: "watch" }), null, "基金 dd 20% 不亮");
  assertEquals(pageDipAlertStock(at(29.5)), null, "29.5% 不亮");
  assertEquals(pageDipFundLadder(at(29.5), { level: "watch" }), null, "基金 29.5% 不亮");
  assertEquals(pageDipAlertStock(at(30))?.add, 30, "股票 30.0% → +30 档");
  assertEquals(pageDipFundLadder(at(30), { level: "watch" })?.add, 30, "基金 30.0% → +30 档");
  assertEquals(pageDipAlertStock(at(34.5))?.add, 30, "34.5% 仍 +30 档");
  assertEquals(pageDipFundLadder(at(34.5), { level: "watch" })?.add, 30, "基金 34.5% 仍 +30 档");
  assertEquals(pageDipAlertStock(at(35))?.add, 40, "35% → +40 档");
  assertEquals(pageDipFundLadder(at(35), { level: "watch" })?.add, 40, "基金 35% → +40 档");
  assertEquals(pageDipAlertStock(at(50))?.add, 60, "50% → +60 档（最深档）");
  // 仲裁只留股票：同一只 dd 40% 的标的，股票填 pct 95 被否，基金填什么都不否
  assertEquals(pageDipAlertStock({ ...at(40), valuationPercentile: 95 }), null, "股票侧高估≥80 仍否决");
  assertEquals(pageDipFundLadder({ ...at(40), valuationPercentile: 95 }, { level: "watch" })?.add, 40,
    "基金侧已取消估值分位，95 无权否决");
});

Deno.test("抄底横幅：用户的定投暂停状态不再被写成「暂不新增」指令", () => {
  const paused = pageBuyBanner([{ kind: "ladder", dd: 36, add: 40, shout: false }]);
  assertEquals(paused.includes("暂不新增"), false, "暂停只是用户当前的定投状态，不是系统指令");
  assertEquals(paused.includes("仅状态提示"), false);
  assertEquals(paused.includes("→"), false, "删掉指令后不许留悬空箭头");
  assertEquals(paused.includes("已达 +40% 加仓档"), true, "事实仍要如实写出");
  const live = pageBuyBanner([{ kind: "ladder", dd: 36, add: 40, shout: true }]);
  assertEquals(live.includes("建议加仓/多投"), true, "非暂停仍给出加仓建议");
  const cost = pageBuyBanner([{ kind: "cost", ret: -23.4, target: -20, shout: false }]);
  assertEquals(cost.includes("成本口径：收益 -23.4% 已跌破 -20% 安全垫"), true);
  assertEquals(cost.includes("暂不新增"), false);
});

Deno.test("股票加仓计划：整体持仓占比 × 档位比例，按整手（100 股）折算，双端逐格一致", () => {
  const mvs = [0, 1, 500, 1807, 9035, 18070, 123456.78];
  const prices = [0, 3.33, 18.07, 250];
  const adds = [0, 30, 40, 60];
  for (const mv of mvs) {
    for (const price of prices) {
      for (const add of adds) {
        const p = pageStockAddPlan(mv, price, add);
        const s = D.stockAddPlan(mv, price, add);
        assertEquals(p, s, `页面与服务端必须同值：mv=${mv} price=${price} add=${add}`);
        if (p === null) continue;
        assertEquals(p.lotSize, 100, "A 股每手 100 股");
        assertEquals(p.lots, Math.floor(p.lots), "手数必须是整数（只买整手）");
        assertEquals(p.amount, p.lots * price * p.lotSize, "金额 = 手数 × 每手股数 × 现价");
        assert(p.amount <= p.want + 1e-9, "整手金额不得超过目标加仓额（只往下取整）");
        assertEquals(Number.isFinite(p.ratio), true, "占持仓比例不得为 NaN/Infinity");
      }
    }
  }
  // 语义钉死：500 股 × 18.07、+40% ⇒ 目标 3,614 元，正合 2 手
  const p = pageStockAddPlan(9035, 18.07, 40)!;
  assertEquals(p.want.toFixed(2), "3614.00");
  assertEquals(p.lots, 2);
  assertEquals(p.amount.toFixed(2), "3614.00");
  assertEquals(p.ratio.toFixed(1), "40.0");
  // 不足一手：目标 722.8 元 < 1,807 元
  const tiny = pageStockAddPlan(1807, 18.07, 40)!;
  assertEquals(tiny.lots, 0);
  assertEquals(tiny.amount, 0);
  assertEquals(tiny.ratio, 0);
  // 恰好一手：不许被浮点误差吃掉
  assertEquals(pageStockAddPlan(1807, 18.07, 100)!.lots, 1);
  assertEquals(pageStockAddPlan(1807 * 0.99, 18.07, 100)!.lots, 0);
  // 缺持仓/缺价格/档位为 0 → null（页面回落到不带金额的「建议买入」）
  assertEquals(pageStockAddPlan(0, 18.07, 40), null);
  assertEquals(pageStockAddPlan(9035, 0, 40), null);
  assertEquals(pageStockAddPlan(9035, 18.07, 0), null);
});

Deno.test("港股整手股数：手数按标的取（100/200/400/500/1000），未知不编金额，双端逐格一致", () => {
  const lots = [0, -400, 100, 200, 400, 500, 1000];
  for (const lot of lots) {
    for (const mv of [0, 1807, 20000, 123456.78]) {
      for (const price of [0, 3.33, 10, 135.6]) {
        for (const add of [0, 30, 40, 60]) {
          assertEquals(pageStockAddPlan(mv, price, add, lot), D.stockAddPlan(mv, price, add, lot),
            `双端必须同值：lot=${lot} mv=${mv} price=${price} add=${add}`);
        }
      }
    }
  }
  // 语义钉死：20,000 元持仓、+30% ⇒ 目标 6,000；每手 500 股 = 5,000 ⇒ 1 手，实付占持仓 25%
  const hk = pageStockAddPlan(20000, 10, 30, 500)!;
  assertEquals(hk.lots, 1);
  assertEquals(hk.amount, 5000);
  assertEquals(hk.ratio, 25);
  assertEquals(hk.lotSize, 500);
  assertEquals(pageStockAddPlan(20000, 10, 30, 1000)!.lots, 0, "每手 1000 股时 6,000 元不足一手");
  assertEquals(pageStockAddPlan(20000, 10, 30, 0), null, "手数未知 → 不给金额");
  assertEquals(pageStockAddPlan(20000, 10, 30)!.lotSize, 100, "不传时按 A 股 100 股一手");
  // 手数解析：A股固定 100；港股读状态里的 lotSize（页面同步/夜间任务写入），没有就是 0（不给金额）
  assertEquals(pageStockLotSizeOf({ code: "600031" }), 100, "A股主板每手 100");
  assertEquals(pageStockLotSizeOf({ code: "600031", lotSize: 400 }), 100, "A股不受港股字段影响");
  assertEquals(pageStockLotSizeOf({ code: "00005", lotSize: 400 }), 400);
  assertEquals(pageStockLotSizeOf({ code: "00005", lotSize: "500" }), 500, "状态里可能是字符串");
  assertEquals(pageStockLotSizeOf({ code: "00005" }), 0, "港股手数未知 → 0 → 不给金额");
  assertEquals(pageStockLotSizeOf({ code: "00005", lotSize: "abc" }), 0);
  assertEquals(pageStockLotSizeOf({ code: "00005", lotSize: -1 }), 0);
  assertEquals(pageStockLotSizeOf({}), 100, "空记录按 A 股口径");
});

Deno.test("腾讯港股行情解析：第 61 字段是每手股数，脏值/旧格式双端同判 null", () => {
  const quote = (lot: string, len = 78) => {
    const f = new Array(len).fill("0");
    f[0] = "100"; f[1] = "测试港股"; f[2] = "00005"; f[60] = lot;
    return 'v_hk00005="' + f.join("~") + '";';
  };
  const samples = [quote("400"), quote("1000"), quote("0"), quote(""), quote("abc"), quote("12.5"), quote(" 400 "), quote("400", 60), "", "garbage", 'v_hk00700="100~腾讯~00700"'];
  for (const s of samples) {
    assertEquals(pageLotFromTxQuote(s), D.lotFromTxQuote(s), "双端解析口径必须一致：" + JSON.stringify(s));
  }
  assertEquals(pageLotFromTxQuote(quote("400")), 400);
  assertEquals(pageLotFromTxQuote(quote("1000")), 1000);
  assertEquals(pageLotFromTxQuote(quote("0")), null, "0 手不是有效手数");
  assertEquals(pageLotFromTxQuote(quote("12.5")), null, "小数手数是脏数据");
  assertEquals(pageLotFromTxQuote(quote(" 400 ")), 400, "两侧空白允许");
  // 只到第 60 个字段（没有 0 基 60）的旧格式：不猜 100
  assertEquals(pageLotFromTxQuote('v_hk00005="' + new Array(60).fill("0").join("~") + '"'), null);
  assertEquals(D.lotFromTxQuote('v_hk00005="' + new Array(60).fill("0").join("~") + '"'), null);
  // 浏览器里 <script> 执行后 window.v_hk00005 已是去引号的字符串（DOM 实测踩过）：
  // 解析器必须两种形态都认，否则页面永远取不到手数
  const bare = new Array(78).fill("0"); bare[0] = "100"; bare[1] = "汇丰控股"; bare[60] = "400";
  assertEquals(pageLotFromTxQuote(bare.join("~")), 400, "去引号的纯字段串（浏览器 window 变量）也要能解析");
  assertEquals(D.lotFromTxQuote(bare.join("~")), 400, "双端口径一致");
});

Deno.test("股票抄底横幅：整手时写手数+按手金额，不足一手如实说，缺持仓数据回落纯建议", () => {
  const dip = { dd: 39.8, add: 40 };
  const ok = pageStockBuyBanner(dip, pageStockAddPlan(9035, 18.07, 40));
  assert(ok.includes("建议买入 2 手（200 股）"), "手数与股数都要写：" + ok);
  assert(ok.includes("¥3,614"), "按手计的金额要写：" + ok);
  assert(ok.includes("占持仓 40.0%"), "要说清这是占整体持仓的比例：" + ok);
  const tiny = pageStockBuyBanner(dip, pageStockAddPlan(1807, 18.07, 40));
  assert(tiny.includes("目标加仓 ¥723，不足 1 手（每手 100 股）"), "不足一手要如实说：" + tiny);
  assert(tiny.includes("0 手") === false, "不许出现「买 0 手」这种空指令");
  const noPos = pageStockBuyBanner(dip, null);
  assert(noPos.includes("建议买入"), "没有持仓股数时仍给方向性建议");
  assert(/NaN|Infinity|undefined/.test(ok + tiny + noPos) === false);
});

Deno.test("接线守卫：页面卡片与夜间批处理都必须调用被比对的函数（防「测试绿但生产走岔路」）", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/const sig = evalFundSignal\(f\);/.test(html), "页面基金卡片必须调用 evalFundSignal(f)");
  assert(/const bkey = fundBenchKey\(f\);/.test(html), "页面基金卡片必须用 fundBenchKey(f) 裁决参考指数（含「不参考」豁免）");
  assert(/\/\/ ==== SIGNAL_PURE_BEGIN ====/.test(html) && /\/\/ ==== SIGNAL_PURE_END ====/.test(html),
    "index.html 必须有 SIGNAL_PURE 标记块（本测试的抽取来源）");
  assert(/\/\/ ==== LADDER_PURE_BEGIN ====/.test(html) && /\/\/ ==== LADDER_PURE_END ====/.test(html),
    "index.html 必须有 LADDER_PURE 标记块（回撤抄底判据的抽取来源）");
  assert(/dipAlertStock\(\{ \.\.\.f, currentPrice: parseFloat\(f\.currentNav\)\|\|0, valuationPercentile: null \}\)/.test(html),
    "页面基金腿复用 dipAlertStock，但必须显式把估值分位置空（基金侧已取消该指标）");
  assert(/const sDip = dipAlertStock\(s\);/.test(html), "页面股票腿调用同一个 dipAlertStock");
  // 股票加仓金额必须走同一套纯函数（档位比例 × 整体持仓市值 → 整手），不许在模板里手写折算
  assert(/const sPlan = sDip \? stockAddPlan\(stockMvOf\(s\), parseFloat\(s\.currentPrice\)\|\|0, sDip\.add, stockLotSizeOf\(s\)\) : null;/.test(html),
    "页面股票卡片必须用 stockAddPlan(stockMvOf(s), 现价, sDip.add, stockLotSizeOf(s)) 算加仓计划");
  assert(/stockBuyBannerHtml\(sDip, sPlan\)/.test(html), "页面股票抄底横幅必须由 stockBuyBannerHtml(sDip, sPlan) 渲染");
  // 港股手数必须真的去取（否则 stockLotSizeOf 永远为 0，卡片永远不出金额）：按标的读腾讯行情第 61 字段
  assert(/function fetchHkLot\(code\)\{/.test(html), "页面必须有港股每手股数取数函数 fetchHkLot");
  assert(/https:\/\/qt\.gtimg\.cn\/q=hk' \+ code/.test(html), "fetchHkLot 必须打腾讯港股行情（第 61 字段是每手股数）");
  assert(/if\(!\/\^\\d\{5\}\$\/\.test\(String\(s\.code\|\|''\)\.trim\(\)\)\) continue;[\s\S]{0,200}await fetchHkLot\(String\(s\.code\)\.trim\(\)\)/.test(html),
    "autoRefreshStocks 必须为 5 位（港股）代码取手数，A股跳过");
  assert(/s\.lotSize = lot;/.test(html), "取到的手数必须落到本地状态（saveStocks 同步到云端，夜间邮件据此回落）");
  // 基金侧取消估值分位：表单不再有这个输入、卡片双信号条不再读它
  assert(/data-k="valuationPercentile"/.test(html) === false, "基金表单不得再有估值分位输入框");
  assert(/dualSignalHtml\(f, parseFloat\(f\.currentNav\)\|\|0, parseFloat\(f\.baseAmount\)\|\|0, false\)/.test(html),
    "基金卡片双信号条必须以 withPct=false 调用（否则「未填估值百分位」理由会回灌）");
  assert(/dualSignalHtml\(s, parseFloat\(s\.currentPrice\)\|\|0, 0\)/.test(html), "股票卡片保持读估值分位");
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/evalFundSignalServer\(f, close, dev, streak, themeCaps, themeSum, goal\)/.test(server),
    "夜间基金路径必须调用 evalFundSignalServer（被比对的函数）");
  assert(/const bkey = fundBenchKey\(f\);/.test(server), "夜间基金路径必须用 fundBenchKey(f) 裁决参考指数");
  // 系数只看档位是否就绪（与页面同款）：暂停时 multiplier=0，金额本就为 0，不许再加 multiplier 守卫
  assert(/const coef = bl \? bl\.coef : 1;/.test(server),
    "邮件系数必须写成 `const coef = bl ? bl.coef : 1;`（与页面同款；加 multiplier>0 守卫会让「不参考」豁免再次失效）");
  // 股票腿刻意只传 dev：页面对股票没有「均线档位」，只有对照策略（估值分位 × 回撤）——
  // 若哪天把 pct 也传进股票腿，必须同期在页面造出对应展示，否则邮件会出现页面没有的档位。
  assert(/const tier = baseSignalLabel\(dev\);/.test(server),
    "股票腿必须保持 dev 单腿（页面对股票无均线档位；改动需同步 spec 与页面）");
  assert(/baseSignalLabel\([^)]*,/.test(server) === false,
    "基金侧取消估值分位后，baseSignalLabel 不得再接受第二个参数（基金/股票都只传 dev）");
  assert(/const ladder = dipLadder\(f, close, null\);/.test(server),
    "邮件基金腿必须走统一门槛的 dipLadder，且不传分位（基金侧无高估否决）");
  assert(/const sLadder = dipLadder\(s, close, readPct\(s\)\);/.test(server),
    "邮件股票腿必须走统一门槛的 dipLadder（股票侧保留高估否决）");
  assert(/const addPlan = sLadder \? stockAddPlan\(sMv, close, sLadder\.add, lotSize\) : null;/.test(server),
    "邮件股票腿必须按整体持仓市值（sMv）与标的整手股数折算");
  assert(/const lotSize = \/\^\\d\{5\}\$\/\.test\(code\) \? \(\(await fetchHkLot\(code\)\) \|\| Number\(s\.lotSize\) \|\| 0\) : 100;/.test(server),
    "港股手数必须按标的读（腾讯行情 → 状态 lotSize → 0），A股固定 100");
  assert(/buyMarkHtml\(r\.ladder, r\.addPlan\)/.test(server), "股票邮件卡片必须把整手计划传给 buyMarkHtml");
  assert(/buyMarkHtml\(r\.multiplier > 0 \? r\.ladder : null\)/.test(server),
    "基金邮件卡片不得传整手计划（基金按定投基数倍数，不按手）");
  assert(/pct: readPct\(f\)/.test(server) === false, "邮件基金报告不得再带 pct 字段");
  // 2026-10-28 用户裁决：「暂停」只代表用户当前在该基金的定投状态，不是系统指令
  assert(/暂不新增|仅状态提示/.test(html) === false, "页面抄底横幅不得把用户的定投暂停状态写成系统指令");
  assert(/暂不新增|仅状态提示/.test(server) === false, "邮件抄底横幅不得把用户的定投暂停状态写成系统指令");

  // --- 2026-10-29 国内可达性：Supabase 走 Pages 同源反代 + SDK 自托管 ---
  assert(/cdn\.jsdelivr\.net/.test(html) === false, "页面不得再从 jsDelivr 加载 SDK（国内常被断，且是第三方单点）");
  assert(/<script src="\.\/supabase-js\.js"/.test(html), "supabase-js 必须自托管（同源 ./supabase-js.js）");
  assert(/const SUPABASE_URL = supabaseBaseUrl\(location\.hostname, location\.origin, SUPABASE_DIRECT\);/.test(html),
    "SUPABASE_URL 必须由 supabaseBaseUrl 按域名分派，不许写死：否则 Pages 上仍会直连 *.supabase.co");
  const vendor = await Deno.readTextFile(new URL("../supabase-js.js", import.meta.url));
  assert(/var supabase=/.test(vendor), "自托管的 SDK 必须是 UMD 构建（暴露全局 supabase）");
  assert(/supabase-js@2\.\d+\.\d+/.test(vendor), "自托管文件必须留明确版本号，升级时才有据可查");
  const fn = await Deno.readTextFile(new URL("../cloudflare/functions/sb/[[path]].ts", import.meta.url));
  assert(/export const onRequest/.test(fn), "Pages Function 必须导出 onRequest（否则 /sb/* 全部 404）");
  assert(/buildUpstreamUrl\(/.test(fn), "Pages Function 必须走被测试的 buildUpstreamUrl（白名单与穿越防护都在那里）");

  // --- 2026-10-29 免登录（用户裁定 A）：只记住邮箱，密码/令牌一律不落盘 ---
  assert(/const LOGIN_EMAIL_KEY = 'dinvest_login_email';/.test(html), "记住登录邮箱需要一个独立的本地 key");
  assert(/document\.getElementById\('loginEmail'\)\.value = lastLoginEmail\(\);/.test(html),
    "登录弹窗必须回填上次邮箱：每次都清空等于白抵消浏览器钥匙串的自动填充");
  assert(/rememberLoginEmail\(sbUser\.email\)/.test(html), "登录成功与恢复会话后都要记住该邮箱");
  assert(/loginPass['"]\)\.value\s*=\s*''/.test(html), "密码框每次打开必须清空，不许回填");
  assert(/localStorage\.setItem\([^)]*loginPass/.test(html) === false, "密码不得写进 localStorage");
  assert(/leening222@126\.com/.test(html) === false, "账号不得硬编码进页面（站点公开，源码即凭据）");
});

Deno.test("国内可达性：Supabase 基址按域名分派（Pages 走同源 /sb 反代，其余直连）", () => {
  const direct = "https://sfauluwxmdginezbluvo.supabase.co";
  assertEquals(pageSupabaseBaseUrl("fund-invest888.pages.dev", "https://fund-invest888.pages.dev", direct),
    "https://fund-invest888.pages.dev/sb");
  assertEquals(pageSupabaseBaseUrl("b7b48496.fund-invest888.pages.dev", "https://b7b48496.fund-invest888.pages.dev", direct),
    "https://b7b48496.fund-invest888.pages.dev/sb", "预览部署的子域同样走反代");
  assertEquals(pageSupabaseBaseUrl("fund-invest888.vercel.app", "https://fund-invest888.vercel.app", direct), direct,
    "Vercel 那份没有 Pages Function，必须直连（否则登录直接打死）");
  assertEquals(pageSupabaseBaseUrl("localhost", "http://localhost:8765", direct), direct, "本地静态服务同理");
  assertEquals(pageSupabaseBaseUrl("", "", direct), direct);
  // 子串伪装不得骗过判定（只认真正的 .pages.dev 结尾）
  assertEquals(pageSupabaseBaseUrl("pages.dev.evil.example", "https://pages.dev.evil.example", direct), direct);
  assertEquals(pageSupabaseBaseUrl("xpages.dev", "https://xpages.dev", direct), direct);
  assertEquals(pageSupabaseBaseUrl("PAGES.DEV", "https://PAGES.DEV", direct), direct, "裸域名不是 Pages 项目域");
  // 末尾斜杠不许把路径叠成 //sb
  assertEquals(pageSupabaseBaseUrl("a.pages.dev", "https://a.pages.dev/", direct), "https://a.pages.dev/sb");
});
