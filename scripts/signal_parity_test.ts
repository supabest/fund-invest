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
  fundHistPeak as pageFundHistPeak, dipAlertFundLump as pageDipFundLump,
  fundLumpPlan as pageFundLumpPlan, fundHistPeakLine as pageFundHistLine, fundDipList as pageFundDipList,
  dipAlertFundDeep as pageDipFundDeep, fundDeepLine as pageFundDeepLine, fundPadLine as pageFundPadLine,
  dipAlertStockCost as pageDipStockCost,
  stockPadSet as pageStockPadSet, stockPadInfo as pageStockPadInfo, stockDipGate as pageStockDipGate,
  stockBuyRef as pageStockBuyRef,
  buyBannerHtml as pageBuyBanner,
  stockAddPlan as pageStockAddPlan, stockBuyBannerHtml as pageStockBuyBanner,
  stockSellPlan as pageStockSellPlan, stockSellBannerHtml as pageStockSellBanner,
  sellBannerHtml as pageSellBanner,
  profitNextTier as pageProfitNextTier,
  profitAlertFromRet as pageProfitAlert,
  stockLotSizeOf as pageStockLotSizeOf, lotFromTxQuote as pageLotFromTxQuote,
  supabaseBaseUrl as pageSupabaseBaseUrl,
} from "./signal_parity.ts";
// 三栏收口后卡片走 profitRefHtml（VALUE_PURE 块），旧的 profitMetaText 已删；矩阵里「页面文案与三态判据自洽」这条校验改用栏函数。
import { profitRefHtml as pageProfitRefHtml } from "./value_leg_logic.ts";

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

// ── 股票侧「目标跌幅安全垫」（2026-10-31 加）：与基金 dipAlertFund 同判据的成本口径腿 ──
// 阈值来自股票表单新增的 s.targetDrawdown（每只自填，未填永不亮，不替用户定数）；
// 股票侧没有「暂停定投」概念，喊买仲裁改用既有的均线档边界 dev≥+10%（邮件里就叫「明显高位」）。
Deno.test("股票成本安全垫：未填/脏值/0/缺成本/缺现价都不亮，恰好踩线必亮，明显高位只陈述", () => {
  const s = (tdd: unknown, cost = 10, price = 8) => ({ targetDrawdown: tdd, cost, currentPrice: price });
  assertEquals(pageDipStockCost(s(""), 0), null, "未填不亮");
  assertEquals(pageDipStockCost(s(null), 0), null);
  assertEquals(pageDipStockCost(s(undefined), 0), null);
  assertEquals(pageDipStockCost(s(0), 0), null, "0 按未填：否则任何浮亏都算跌穿 -0%");
  assertEquals(pageDipStockCost(s("abc"), 0), null, "脏值按未填，绝不输出 NaN% 安全垫");
  assertEquals(pageDipStockCost(s(20, 0, 8), 0), null, "缺成本不亮");
  assertEquals(pageDipStockCost(s(20, 10, 0), 0), null, "缺现价不亮");
  assertEquals(pageDipStockCost(s(20, 10, 8.1), 0), null, "收益 -19% 尚未跌穿 -20%");
  const hit = pageDipStockCost(s(20, 10, 8), 0)!;
  assertEquals(hit.kind, "cost");
  assertEquals(hit.target, -20);
  assertEquals(hit.ret.toFixed(1), "-20.0", "恰好踩线要亮（1e-9 容差，同基金口径）");
  assertEquals(hit.shout, true);
  assertEquals(pageDipStockCost(s(-20, 10, 7), 0)!.target, -20, "负数输入按绝对值口径，不比反");
  assertEquals(pageDipStockCost(s(20, 10, 7), 12)!.shout, false, "现价较均线 +12%（明显高位）不给买入指令");
  assertEquals(pageDipStockCost(s(20, 10, 7), 9.9)!.shout, true, "+9.9% 未到既有高位边界，仍给指令");
  assertEquals(pageDipStockCost(s(20, 10, 7), null)!.shout, true, "均线缺失时不因未知压掉指令");
  // 容差必须实测到：24.5 → 19.6 真实跌幅就是 -20%，但浮点算出 -19.999999999999996，严格比较会漏亮
  const driftRet = (19.6 - 24.5) / 24.5 * 100;
  assert(driftRet > -20, "夹具本身得是浮点退化格，否则这条测不到 1e-9");
  assertEquals(pageDipStockCost(s(20, 24.5, 19.6), 0) !== null, true, "浮点退化不能漏亮（页面）");
  assertEquals(D.stockDipAlert({ targetDrawdown: 20 }, driftRet, 0) !== null, true, "浮点退化不能漏亮（服务端）");
});

Deno.test("股票成本安全垫双端矩阵：页面 dipAlertStockCost 与服务端 stockDipAlert 逐格一致", () => {
  const targets: Array<unknown> = ["", null, undefined, 0, 10, 20, 20.5, "abc", -20, "20"];
  const prices = [10, 9, 8.1, 8, 7.95, 7, 5];
  const devs: Array<number | null> = [null, -20, -6, 0, 9.9, 10, 25];
  for (const t of targets) {
    for (const price of prices) {
      // 与服务端 stockReturn 同式：成本 10、今夜收盘 price
      const ret = (price - 10) / 10 * 100;
      for (const dev of devs) {
        const page = pageDipStockCost({ targetDrawdown: t, cost: 10, currentPrice: price }, dev);
        const srv = D.stockDipAlert({ targetDrawdown: t }, ret, dev);
        const tag = `t=${String(t)} price=${price} dev=${dev}`;
        assertEquals(page === null, srv === null, `亮灭 ${tag}`);
        assertEquals(page?.target ?? null, srv?.target ?? null, `阈值 ${tag}`);
        assertEquals(page?.ret.toFixed(6) ?? null, srv?.ret.toFixed(6) ?? null, `收益 ${tag}`);
        assertEquals(page?.shout ?? null, srv?.shout ?? null, `喊买仲裁 ${tag}`);
      }
    }
  }
  // 缺数据这一格：服务端 ret=null（无成本）与页面缺成本/缺现价同判不亮
  assertEquals(D.stockDipAlert({ targetDrawdown: 20 }, null, 0), null);
  assertEquals(pageDipStockCost({ targetDrawdown: 20, cost: 0, currentPrice: 8 }, 0), null);
});

// ── 2026-10-31 用户裁决：股票抄底改为「双腿齐备才亮」──
// 市场腿（距 52 周高点回撤 ≥30%）与安全垫腿（跌穿自设目标跌幅）必须同时突破才出抄底灯与买入指令；
// 安全垫未填/脏值/0 而回撤已达标 → 灯灭但必须显式提示补填（该字段本日才上线，现存持仓一律为空，
// 静默闭灯会把「缺数据」读成「市场没给机会」）。
Deno.test("双信号仲裁：双腿同时突破才亮，单腿一律不亮，未设安全垫要提示补填", () => {
  const ladder = { dd: 36, add: 40 };
  const cost = { kind: "cost", ret: -23.4, target: -20, shout: true };
  const g = pageStockDipGate(ladder, cost, true);
  assertEquals(g.light, true, "双腿齐备才亮");
  assertEquals(g.needPad, false);
  assertEquals(g.shout, true, "非明显高位才给买入指令");
  assertEquals(pageStockDipGate(ladder, null, true).light, false, "已设安全垫但没跌穿 → 不亮");
  assertEquals(pageStockDipGate(ladder, null, true).needPad, false, "已填未破是正常状态，不该催补填");
  assertEquals(pageStockDipGate(null, cost, true).light, false, "只跌穿安全垫、回撤未达 30% → 不亮");
  assertEquals(pageStockDipGate(null, cost, true).needPad, false, "回撤未达标谈不上补填");
  const miss = pageStockDipGate(ladder, null, false);
  assertEquals(miss.light, false);
  assertEquals(miss.needPad, true, "回撤已达标而安全垫未设 → 必须提示补填，不能静默");
  assertEquals(pageStockDipGate(null, null, false), { light: false, needPad: false, shout: false });
  assertEquals(pageStockDipGate(null, null, true).needPad, false);
  const hushed = pageStockDipGate(ladder, { ...cost, shout: false }, true);
  assertEquals(hushed.light, true, "明显高位仍然亮灯");
  assertEquals(hushed.shout, false, "但拿不到买入指令");
  assertEquals(pageStockDipGate(ladder, null, false).shout, false, "灯灭时 shout 恒 false，不留「不亮却喊买」的组合");
});

Deno.test("安全垫是否已设：未填/空白/脏值/0 都算没设，负数与小数算设了", () => {
  const P = pageStockPadSet;
  assertEquals(P({}), false, "整只股票没有该字段（今天之前的存量持仓）");
  assertEquals(P({ targetDrawdown: undefined }), false);
  assertEquals(P({ targetDrawdown: null }), false);
  assertEquals(P({ targetDrawdown: '' }), false, "保存时清空会留下空串");
  assertEquals(P({ targetDrawdown: '   ' }), false, "纯空白也是未填");
  assertEquals(P({ targetDrawdown: 0 }), false, "0 会被当成 -0% 门槛，任何浮亏都算跌穿");
  assertEquals(P({ targetDrawdown: 'abc' }), false);
  assertEquals(P({ targetDrawdown: {} }), false, "对象脏值不得当成已设");
  assertEquals(P({ targetDrawdown: [] }), false);
  assertEquals(P({ targetDrawdown: 20 }), true);
  assertEquals(P({ targetDrawdown: '20' }), true);
  assertEquals(P({ targetDrawdown: 20.5 }), true);
  assertEquals(P({ targetDrawdown: -20 }), true, "负数仍是有效阈值（判据侧按绝对值口径）");
});

Deno.test("双端矩阵：stockDipGate 与 stockPadSet 在（双腿 × 是否已设）全格一致", () => {
  const ladders: Array<Any> = [null, { dd: 30, add: 30 }, { dd: 55, add: 60 }];
  const costs: Array<Any> = [
    null,
    { kind: "cost", ret: -20, target: -20, shout: true },
    { kind: "cost", ret: -35, target: -30, shout: false },
  ];
  for (const l of ladders) {
    for (const c of costs) {
      for (const set of [true, false]) {
        const tag = `ladder=${l ? l.dd : 'null'} cost=${c ? c.ret : 'null'} padSet=${set}`;
        assertEquals(D.stockDipGate(l, c, set), pageStockDipGate(l, c, set), `双端仲裁必须同值：${tag}`);
      }
    }
  }
  const tdds: Array<Any> = ["", "   ", null, undefined, 0, "abc", {}, [], "20", 20, 20.5, -20, 1e-9];
  for (const t of tdds) {
    const s = { targetDrawdown: t };
    assertEquals(D.stockPadSet(s), pageStockPadSet(s), `是否已设必须同判：t=${String(t)}`);
  }
});

// ── 2026-11-01 用户裁决：股票「买入参考」不再只吃均线单腿，改三腿合成 ──
// 现场：000338 折叠卡只显示「买入参考·加强」，用户看不出这个「加强」是均线给的还是回撤给的，
// 而同一张卡片上其实已经算着 52 周回撤达档（dipAlertStock）与成本安全垫（dipAlertStockCost）。
// 三腿沿用既有词表与档位区间（双倍≥3/加强≥1/正常≥−1/减半≥−3/其余暂停），不新增阈值数字；
// 价值硬否决仍只标注、不参与降级（2026-10-31 裁决不变）。
const LAD_NA = null;                                    // 回撤未达档
const LAD_30 = { dd: 32, add: 30 };
const LAD_40 = { dd: 40, add: 40 };
const LAD_60 = { dd: 55, add: 60 };
const PAD_ON = { kind: "cost", ret: -12, target: -8, shout: true };
const PAD_HUSH = { kind: "cost", ret: -12, target: -8, shout: false };

Deno.test("三腿明细 = 白话句子：不显示打分，只讲每条腿的事实（用户投诉「均线+2·回撤+2·安全垫未破」读不懂）", () => {
  const R = pageStockBuyRef;
  const UNSET = "未设成本安全垫（填「目标跌幅」才启用这条腿）";
  const DD_NA = "52 周回撤未达 30% 档";
  const nail = (dev: number | null, ladder: Any, cost: Any, padSet: boolean, label: string, score: number, text: string, pad?: Any) => {
    const tag = `dev=${dev} add=${ladder ? ladder.add : '未达档'} pad=${cost ? cost.shout : 'null'} padSet=${padSet}`;
    const r = R(dev, ladder, cost, padSet, pad);
    assertEquals(`${r.label}/${r.score}`, `${label}/${score}`, tag);
    assertEquals(r.text, text, `三腿明细 ${tag}`);
  };
  // 均线腿：数字 + 邮件端在用的同一套位置词表（深度低位/低位区/中性区间/偏高区/明显高位），不另造术语
  nail(-20, LAD_NA, null, false, "加强", 2, `现价较均线 -20.0%（深度低位）；${DD_NA}；${UNSET}`);
  nail(-10, LAD_NA, null, false, "加强", 1, `现价较均线 -10.0%（低位区）；${DD_NA}；${UNSET}`);
  nail(-4, LAD_NA, null, false, "正常", 0, `现价较均线 -4.0%（中性区间）；${DD_NA}；${UNSET}`);
  nail(0, LAD_NA, null, false, "正常", 0, `现价较均线 +0.0%（中性区间）；${DD_NA}；${UNSET}`);
  nail(4, LAD_NA, null, false, "正常", -1, `现价较均线 +4.0%（偏高区）；${DD_NA}；${UNSET}`);
  nail(15, LAD_NA, null, false, "减半", -2, `现价较均线 +15.0%（明显高位）；${DD_NA}；${UNSET}`);
  nail(null, LAD_NA, null, false, "正常", 0, `均线数据缺失；${DD_NA}；${UNSET}`);
  // 回撤腿：ladder.dd 就是当前 52 周回撤，直接报数；档位深浅沿用 DD_STEPS 的 add，不显示 +1/+2
  nail(-10, LAD_30, null, true, "加强", 2, "现价较均线 -10.0%（低位区）；52 周回撤 32.0%，回撤达档；尚未跌穿成本安全垫");
  nail(-10, LAD_40, null, true, "双倍", 3, "现价较均线 -10.0%（低位区）；52 周回撤 40.0%，回撤较深；尚未跌穿成本安全垫");
  nail(-10, LAD_60, null, true, "双倍", 3, "现价较均线 -10.0%（低位区）；52 周回撤 55.0%，回撤较深；尚未跌穿成本安全垫");
  nail(0, LAD_40, null, true, "加强", 2, "现价较均线 +0.0%（中性区间）；52 周回撤 40.0%，回撤较深；尚未跌穿成本安全垫");
  // 安全垫腿：跌穿与未跌穿是两回事，「未跌穿」不再写成容易被读成坏消息的「未破」
  nail(0, LAD_NA, PAD_ON, true, "加强", 1, "现价较均线 +0.0%（中性区间）；52 周回撤未达 30% 档；已跌穿成本安全垫（目标 -8%，现价相对成本 -12.0%）");
  nail(0, LAD_NA, null, true, "正常", 0, "现价较均线 +0.0%（中性区间）；52 周回撤未达 30% 档；尚未跌穿成本安全垫");
  nail(-10, LAD_40, PAD_ON, true, "双倍", 4, "现价较均线 -10.0%（低位区）；52 周回撤 40.0%，回撤较深；已跌穿成本安全垫（目标 -8%，现价相对成本 -12.0%）");
  // 未跌穿时把「目标跌幅」与「现价相对成本」两个数一并报出来（第 5 个参数由调用点供给）
  nail(-10, LAD_40, null, true, "双倍", 3, "现价较均线 -10.0%（低位区）；52 周回撤 40.0%，回撤较深；尚未跌穿成本安全垫（目标 -15%，现价相对成本 +7.0%）", { target: -15, ret: 7 });
  // 明显高位（dev≥10）：后两条腿点名「高位期不采纳」，不悄悄消失，也不再出现「不计」这种账房话
  nail(12, LAD_40, PAD_HUSH, true, "减半", -2, "现价较均线 +12.0%（明显高位）；52 周回撤 40.0%（高位期不采纳）；已跌穿成本安全垫（现价相对成本 -12.0%），高位期不采纳");
  nail(12, LAD_40, null, true, "减半", -2, "现价较均线 +12.0%（明显高位）；52 周回撤 40.0%（高位期不采纳）；尚未跌穿成本安全垫");
  nail(12, LAD_NA, null, false, "减半", -2, `现价较均线 +12.0%（明显高位）；${DD_NA}；${UNSET}`);
  // 均线缺数据 + 双腿齐备：缺的是哪条腿由句子自己披露
  nail(null, LAD_40, PAD_ON, true, "双倍", 3, "均线数据缺失；52 周回撤 40.0%，回撤较深；已跌穿成本安全垫（目标 -8%，现价相对成本 -12.0%）");
  // 用户投诉的这三个字不得再出现在任何面向用户的字符串里
  assertEquals(pageStockBuyRef(-10, LAD_40, null, true).text.includes("三腿"), false, "明细里不许残留内部术语「三腿」");
  assertEquals(pageStockBuyRef(-10, LAD_40, null, true).text.includes("+"), false, "明细里不许残留打分（用户选了只看事实）");
});

Deno.test("三腿合成后「双倍」终于可达、「暂停」仍不可达（最负只到 −2，不为此造负腿）", () => {
  const devs: Array<number | null> = [null, -20, -15, -10, -6, -5, -4, 0, 2, 3, 5, 9.9, 10, 25];
  const ladders: Array<Any> = [LAD_NA, LAD_30, LAD_40, LAD_60];
  const costs: Array<Any> = [null, PAD_ON, PAD_HUSH];
  const labels = new Set<string>();
  let minScore = Infinity, maxScore = -Infinity;
  for (const dev of devs) for (const l of ladders) for (const c of costs) for (const set of [true, false]) {
    const r = pageStockBuyRef(dev, l, c, set);
    labels.add(r.label);
    minScore = Math.min(minScore, r.score);
    maxScore = Math.max(maxScore, r.score);
  }
  assertEquals(labels.has("双倍"), true, "深回撤 + 均线低位 + 跌穿安全垫要能报到「双倍」（均线单腿时代最高 +2，永远够不到）");
  assertEquals(labels.has("暂停"), false, "三条腿最负 −2+0+0，「暂停」不可达是事实，不为了凑出它臆造负腿");
  assertEquals(minScore, -2);
  assertEquals(maxScore, 5);
});

Deno.test("三腿合成双端矩阵：页面 stockBuyRef 与邮件端镜像在（dev × 回撤档 × 安全垫 × 是否已设 × 有无未跌穿数字）全格一致", () => {
  const devs: Array<number | null> = [null, -20, -15, -14.9, -10, -6, -5.1, -5, -4.9, -4, 0, 2, 2.9, 3, 5, 9.9, 10, 10.1, 25];
  const ladders: Array<Any> = [LAD_NA, LAD_30, LAD_40, LAD_60];
  const costs: Array<Any> = [null, PAD_ON, PAD_HUSH];
  const pads: Array<Any> = [undefined, { target: -15, ret: 7 }, { target: -15, ret: null }];
  let cells = 0;
  for (const dev of devs) {
    for (const l of ladders) {
      for (const c of costs) {
        for (const set of [true, false]) {
          for (const p of pads) {
          const tag = `dev=${dev} add=${l ? l.add : 'null'} pad=${c ? c.shout : 'null'} padSet=${set} padInfo=${p ? p.ret : 'none'}`;
          const page = pageStockBuyRef(dev, l, c, set, p);
          const srv = D.stockBuyRef(dev, l, c, set, p);
          assertEquals(srv, page, `双端三腿合成必须逐字同值：${tag}`);
          cells++;
          }
        }
      }
    }
  }
  assert(cells >= 100, `矩阵格数不足（${cells}）说明循环写坏了`);
});

// 明细里那两个数（目标跌幅 / 现价相对成本）只有页面和邮件各自算一次的可能，这里钉住两端同值。
Deno.test("stockPadInfo 双端同值：未跌穿才给数，没设垫或缺成本/现价一律 null", () => {
  const cases = [
    { code: "600031", cost: "20", currentPrice: "21.4", targetDrawdown: 15 },
    { code: "600031", cost: "20", currentPrice: "17", targetDrawdown: 15 },
    { code: "600031", cost: "20", currentPrice: "21.4", targetDrawdown: "" },
    { code: "600031", cost: "0", currentPrice: "21.4", targetDrawdown: 15 },
    { code: "600031", cost: "20", currentPrice: "", targetDrawdown: -15 },
  ];
  for (const s of cases) {
    const ret = (parseFloat(s.cost) > 0 && parseFloat(s.currentPrice) > 0)
      ? (parseFloat(s.currentPrice) - parseFloat(s.cost)) / parseFloat(s.cost) * 100 : null;
    const page = pageStockPadInfo(s, ret);
    const srv = (D as Any).stockPadInfo(s, ret);
    assertEquals(srv, page, `stockPadInfo 双端必须同值：${JSON.stringify(s)}`);
  }
  assertEquals(pageStockPadInfo(cases[0], null), { target: -15, ret: null }, "已设垫但取不到收益 ⇒ 给目标、不给假数");
  assertEquals(pageStockPadInfo(cases[2], 7), null, "没设垫不给数（明细会说「未设成本安全垫」）");
});

// 规则翻转（本日上线）：旧行为「任一腿突破就出横幅」全部作废，单腿一律空串。
Deno.test("股票抄底横幅：双腿齐备才出，单腿一律空串；明显高位只陈述、不留悬空箭头", () => {
  const ladder = { dd: 36, add: 40 };
  const plan = pageStockAddPlan(10000, 10, 40, 100)!;
  const cost = { kind: "cost", ret: -23.4, target: -20, shout: true };
  const both = pageStockBuyBanner(ladder, plan, cost);
  assert(both.includes("成本口径：收益 -23.4% 已跌破 -20% 安全垫"), both);
  assert(both.includes("较52周高点回撤 36.0% 已达 +40% 加仓档"), both);
  assert(both.includes("建议买入 4 手"), "双腿齐备且非高位仍按档位给整手金额：" + both);
  assertEquals(pageStockBuyBanner(null, null, cost), "", "只有安全垫腿不得出抄底横幅");
  assertEquals(pageStockBuyBanner(ladder, plan, null), "", "只有回撤腿不得出抄底横幅");
  assertEquals(pageStockBuyBanner(ladder, plan, undefined), "", "不传成本腿按单腿处理");
  assertEquals(pageStockBuyBanner(null, null, null), "");
  const hushed = pageStockBuyBanner(ladder, plan, { ...cost, shout: false });
  assert(hushed.includes("成本口径：收益 -23.4% 已跌破 -20% 安全垫"), hushed);
  assert(hushed.includes("较52周高点回撤 36.0%"), hushed);
  assert(hushed.includes("建议买入") === false, `明显高位不得给买入指令：${hushed}`);
  assert(hushed.includes("→") === false, `删掉指令后不留悬空箭头：${hushed}`);
  assert(hushed.includes("明显高位"), `要说清是谁压住了指令：${hushed}`);
  assert(/NaN|Infinity|undefined/.test(both + hushed) === false);
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
  // 双腿齐备才有横幅（2026-10-31 裁决），本条只验金额与整手话术，成本腿给一个恒成立的
  const cost = { kind: "cost", ret: -25, target: -20, shout: true };
  const ok = pageStockBuyBanner(dip, pageStockAddPlan(9035, 18.07, 40), cost);
  assert(ok.includes("建议买入 2 手（200 股）"), "手数与股数都要写：" + ok);
  assert(ok.includes("¥3,614"), "按手计的金额要写：" + ok);
  assert(ok.includes("占持仓 40.0%"), "要说清这是占整体持仓的比例：" + ok);
  const tiny = pageStockBuyBanner(dip, pageStockAddPlan(1807, 18.07, 40), cost);
  assert(tiny.includes("目标加仓 ¥723，不足 1 手（每手 100 股）"), "不足一手要如实说：" + tiny);
  assert(tiny.includes("0 手") === false, "不许出现「买 0 手」这种空指令");
  const noPos = pageStockBuyBanner(dip, null, cost);
  assert(noPos.includes("建议买入"), "没有持仓股数时仍给方向性建议");
  assert(/NaN|Infinity|undefined/.test(ok + tiny + noPos) === false);
});

Deno.test("股票止盈计划：档位比例 × 持仓股数 → 整手向下取整，双端逐格一致", () => {
  const cases: Array<[number, number, number, number]> = [
    [300, 28.5, 10, 100],    // 002415 现场：10% = 30 股，不足 1 手
    [1500, 10, 10, 100],     // 150 股 → 1 手（向下取整，不四舍五入）
    [1000, 10, 20, 100],     // 200 股 → 2 手
    [1000, 10, 50, 100],     // 500 股 → 5 手
    [999, 7.3, 30, 100],     // 299.7 股 → 2 手
    [100, 10, 100, 100],     // 满仓档：100 股 → 1 手
    [2000, 50, 30, 500],     // 港股每手 500：600 股 → 1 手
    [1000, 50, 20, 500],     // 港股每手 500：200 股 → 0 手
  ];
  for (const [sh, px, pct, lot] of cases) {
    assertEquals(pageStockSellPlan(sh, px, pct, lot), D.stockSellPlan(sh, px, pct, lot),
      `双端口径必须一致：${sh} 股 × ${pct}% / 每手 ${lot}`);
    const p = pageStockSellPlan(sh, px, pct, lot)!;
    assert(p.qty <= sh, "卖出股数不得超过持仓");
    assert(p.qty % lot === 0, "可成交股数必须是整手的倍数");
  }
  const tiny = pageStockSellPlan(300, 28.5, 10, 100)!;
  assertEquals(tiny.lots, 0);
  assertEquals(tiny.wantShares, 30, "不足一手时仍要报出目标股数");
  assertEquals(tiny.qty, 0);
  assertEquals(tiny.amount, 0);
  const one = pageStockSellPlan(1500, 10, 10, 100)!;
  assertEquals([one.lots, one.qty, one.amount], [1, 100, 1000]);
  assert(Math.abs(one.ratio - 6.6666667) < 1e-6, "占持仓比例按实际卖出股数反算，不按目标比例");
  assertEquals(pageStockSellPlan(20000, 10, 10)!.lotSize, 100, "不传手数时按 A 股 100 股");
  assertEquals(pageStockSellPlan(300, 28.5, 10, 0), null, "港股手数未知 → 不给手数，不猜 100");
  assertEquals(pageStockSellPlan(0, 28.5, 10, 100), null, "没填股数 → 无从折算");
  assertEquals(pageStockSellPlan(300, 0, 10, 100), null, "没现价 → 不给金额");
  assertEquals(pageStockSellPlan(300, 28.5, 0, 100), null, "档位比例缺失 → 不给计划");
});

Deno.test("股票止盈横幅：整手写手数/股数/金额，不足一手只陈述目标、绝不出指令", () => {
  const a = { ret: 36.4, tier: { ret: 20, sell: 10 } };
  const ok = pageStockSellBanner(a, pageStockSellPlan(1500, 10, 10, 100));
  assert(ok.includes("建议卖出 1 手（100 股）"), "手数与股数都要写：" + ok);
  assert(ok.includes("¥1,000"), "按手计的金额要写：" + ok);
  assert(ok.includes("占持仓 6.7%"), "要说清这是占持仓的比例：" + ok);
  assert(ok.includes("目标 10%"), "档位目标是 10%，向下取整后的偏离要可见：" + ok);
  const tiny = pageStockSellBanner(a, pageStockSellPlan(300, 28.5, 10, 100));
  assert(tiny.includes("目标卖出 10%（约 30 股），不足 1 手（每手 100 股）"), tiny);
  assert(tiny.includes("建议卖出") === false, "不足一手不许给卖出指令（2026-10-30 用户裁决）");
  assert(tiny.includes("0 手") === false, "不许出现「卖 0 手」这种空指令");
  const noPos = pageStockSellBanner(a, null);
  assert(noPos.includes("未折算手数"), "缺股数/手数要如实说，且不给手数：" + noPos);
  assert(/NaN|Infinity|undefined/.test(ok + tiny + noPos) === false);
  // 夜间邮件同一套文案（页面与邮件不许各说各的）
  const sOk = D.sellMarkHtml(a, D.stockSellPlan(1500, 10, 10, 100));
  const sTiny = D.sellMarkHtml(a, D.stockSellPlan(300, 28.5, 10, 100));
  for (const frag of ["建议卖出 1 手（100 股）", "¥1,000", "占持仓 6.7%", "目标 10%"]) {
    assert(sOk.includes(frag), "邮件侧缺「" + frag + "」：" + sOk);
  }
  assert(sTiny.includes("目标卖出 10%（约 30 股），不足 1 手（每手 100 股）"), sTiny);
  assert(sTiny.includes("建议卖出") === false, "邮件侧不足一手同样不许给指令");
});

Deno.test("基金止盈横幅维持百分比份额（基金份额可小数赎回，不折算手数）", () => {
  const a = { ret: 36.4, tier: { ret: 20, sell: 10 } };
  assert(pageSellBanner(a).includes("建议卖出 10% 份额"), pageSellBanner(a));
  assert(D.sellMarkHtml(a).includes("建议卖出 10% 份额"), D.sellMarkHtml(a));
});

Deno.test("止盈下一档：只取高于当前收益率且未执行的档，执行过的档不回头", () => {
  const tiers = PAGE_TIERS;
  assertEquals(pageProfitNextTier(tiers, [], 83), null, "83% 已越过全部默认档，不存在「下一档 +20%」");
  assertEquals(pageProfitNextTier(tiers, [], 50), { ret: 60, sell: 30 });
  assertEquals(pageProfitNextTier(tiers, [60], 50), { ret: 80, sell: 50 }, "60 档已执行则顺延到 80");
  assertEquals(pageProfitNextTier(tiers, [20, 40, 60, 80], 83), null);
  assertEquals(pageProfitNextTier(tiers, [], null), { ret: 20, sell: 10 }, "无收益数据时维持旧行为：报第一档");
  assertEquals(pageProfitNextTier(tiers, [20], 83), null, "高收益下已执行档不影响「没有下一档」");
});

// 「已达 / 下一档 / 已执行完毕」三态的单句断言已迁到 value_leg_logic_test（profitRefHtml 栏），
// 本文件只在下面的 125 格矩阵里逐格校验「页面文案与该格判据自洽」。

// 2026-10-31 用户裁决 A：邮件端 sellAlert 的「回退到更低的已越过档」改掉——
// 页面只看最高达标档，该档标记已执行就整条闭嘴；邮件曾从「达标且未执行」里取最高档，
// 于是 taken=[40] 且收益 +50% 时宣布「已达到 +20% 止盈档（卖10%）」，把早就越过的档包装成待办指令。
Deno.test("止盈达标判定双端同判据（42 格）：最高达标档已执行即闭嘴，绝不回退到更低的已越过档", () => {
  const TAKENS = [[], [20], [40], [20, 40], [20, 40, 60], [40, 80], [20, 40, 60, 80]];
  const RETS = [5, 25, 36, 50, 65, 85];
  // deno-lint-ignore no-explicit-any
  const key = (x: any) => (x ? "已达+" + x.tier.ret + "/卖" + x.tier.sell : "闭嘴");
  const bad: string[] = [];
  for (const taken of TAKENS) {
    for (const ret of RETS) {
      const item = { profitTaken: taken };
      const p = key(pageProfitAlert(ret, item));
      const e = key(D.sellAlert(ret, item));
      if (p !== e) bad.push("taken=[" + taken.join(",") + "] ret=+" + ret + "% → 页面 " + p + " / 邮件 " + e);
    }
  }
  assertEquals(bad, [], "双端 " + bad.length + "/" + TAKENS.length * RETS.length + " 格不一致：\n" + bad.join("\n"));
});

// 邮件端 nextTier 必须吃同一个 profitNextTier（含 ret 过滤）：数组非升序时旧 find 会挑出已越过的档。
Deno.test("下一止盈档双端同判据：邮件必须调 profitNextTier，ret 过滤防住非升序自定义档", () => {
  assertEquals(typeof D.profitNextTier, "function", "邮件端必须导出 profitNextTier（两腿 nextTier 走它，不许各自 find）");
  const TIER_SETS = [PAGE_TIERS, [{ ret: 60, sell: 30 }, { ret: 20, sell: 10 }]];
  for (const tiers of TIER_SETS) {
    for (const taken of [[], [20], [40], [20, 40], [20, 40, 60, 80]]) {
      for (const ret of [null, 5, 50, 65, 85]) {
        const item = { profitTiers: tiers, profitTaken: taken };
        const p = pageProfitNextTier(tiers, taken, ret);
        const e = D.profitNextTier(tiers, taken, ret);
        assertEquals(e, p, "nextTier 不一致 tiers=" + JSON.stringify(tiers) + " taken=[" + taken + "] ret=" + ret);
        if (p && ret !== null) assert(p.ret > ret, "下一档 " + p.ret + "% 不高于当前收益 " + ret + "%（ret 过滤失守）");
        // 三态（已达 / 下一档 / 收尾）双端必须同态：邮件 tierNote 的分支条件与此一致
        const state = (hit: unknown, next: unknown) => (hit ? "已达" : next ? "下一档" : "收尾");
        assertEquals(state(D.sellAlert(ret, item), e), state(D.sellAlert(ret, item), p),
          "双端三态分叉：taken=[" + taken + "] ret=" + ret);
        const pageText = pageProfitRefHtml(D.sellAlert(ret, item), p, ret, null, {}).replace(/<[^>]*>/g, "");
        assertEquals(state(D.sellAlert(ret, item), p),
          pageText.includes("已达") ? "已达" : pageText.includes("下一止盈档") ? "下一档" : "收尾",
          "页面文案与三态判据不自洽：" + pageText);
      }
    }
  }
});

Deno.test("股票止盈横幅：剩余 1 手时不再给百分比分批指令，改给「继续持有或清仓」", () => {
  const a = { ret: 83, tier: { ret: 80, sell: 50 } };
  const plan = pageStockSellPlan(100, 31.1, 50, 100)!;
  assertEquals(plan.shares, 100, "计划要带上总股数");
  assertEquals(plan.price, 31.1, "计划要带现价（清仓金额用）");
  const h = pageStockSellBanner(a, plan);
  assert(h.includes("剩余 1 手（100 股）"), h);
  assert(h.includes("已无法按 50% 分批"), h);
  assert(h.includes("继续持有"), h);
  assert(h.includes("清仓 100 股"), h);
  assert(h.includes("¥3,110"), h);
  assert(h.includes("建议卖出") === false, "不足一手不给卖出指令");
  assert(!/卖 0 手|至少 1 手/.test(h), h);
  const many = pageStockSellBanner({ ret: 36, tier: { ret: 20, sell: 10 } }, pageStockSellPlan(1500, 10, 10, 100));
  assert(many.includes("建议卖出 1 手（100 股）"), "多手场景保持原口径：" + many);
});

Deno.test("接线守卫：止盈卡片下一档与已达档走纯函数；标记执行写 profitTaken 并保存", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/const nextTier = nextProfitTier\(f, ret\);/.test(html), "基金卡片必须把当前收益率传给 nextProfitTier");
  assert(/profitRefHtml\(alert, nextTier, ret, null, f\)/.test(html),
    "基金「止盈参考」栏必须吃 profitAlertFromRet + nextProfitTier 的结果（判据不许在模板里就地重算）");
  assert(/const nextTier = nextProfitTier\(s, ret\);/.test(html), "股票卡片必须把当前收益率传给 nextProfitTier");
  assert(/profitRefHtml\(sAlert, nextTier, ret, sSellPlan, s\)/.test(html),
    "股票「止盈参考」栏同上，并把整手卖出计划一起传入");
  // 2026-11-01 三栏收口：档位消歧（已达档 / 下一档 / 各档执行完毕）从元信息行挪进「止盈参考」栏，
  // 一个口径只许有一处话术——模板里再各自拼一遍，就会与栏内文案漂成两套。
  assertEquals(/profitMetaText/.test(html), false,
    "旧的 profitMetaText 已随三栏收口整簇删除（页面不得再出现该符号，档位话术只由 profitRefHtml 一处说）");
  const profitRefBody = (html.match(/function profitRefHtml\([\s\S]*?\n\}/) || [''])[0];
  assert(/已达/.test(profitRefBody) && /下一止盈档/.test(profitRefBody),
    "「已达档 / 下一档」的消歧必须在 profitRefHtml 这一处实现体里");
  assert(/不足 1 手/.test(profitRefBody), "整手不足时股票侧要如实说不足 1 手，不报虚构手数");
  assert(/function markProfitTaken\(/.test(html), "必须有标记已执行的写入口");
  assert(/item\.profitTaken = Array\.from\(new Set\(/.test(html), "标记执行必须写入 profitTaken（去重）");
  assert(/const add = tiers\.filter\(t => t\.ret <= hit\)\.map\(t => t\.ret\);/.test(html), "标记高档时更低档也要一并写入");
  const markFn = (html.match(/function markProfitTaken\([\s\S]*?\n\}/) || [""])[0];
  assert(markFn.includes("await saveFunds();") && markFn.includes("await saveStocks();"),
    "标记后必须落盘并云同步（股票与基金两条路都在）");
  assert(/data-ret="\$\{Number\(ret\)\}"/.test(html), "按钮必须携带档位 ret");
});

Deno.test("接线守卫：邮件两腿的达标档与下一档都必须走 sellAlert/profitNextTier，禁止各自扫表", async () => {
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  // 达标档必须复用 sellAlert（页面口径：只看最高达标档，已执行即闭嘴），
  // 一旦退回「扫最高达标且未执行」的循环，标记 60 后就会重新喊出已越过的 40%
  assertEquals((server.match(/const newTier: number \| null = sell \? sell\.tier\.ret : null;/g) || []).length,
    2, "基金腿与股票腿都要从 sellAlert 派生达标档");
  assert(/const sell = sellAlert\(ret, f\);/.test(server), "基金腿必须先算 sellAlert 再派生 newTier");
  assert(/const sell = sellAlert\(ret, s\);/.test(server), "股票腿必须先算 sellAlert 再派生 newTier");
  assert(/for \(const t of tiers\) \{ if \(ret >= t\.ret && !\(f\.profitTaken/.test(server) === false,
    "基金腿不得保留旧的「最高达标且未执行」扫描循环（回退已越过档）");
  assert(/for \(const t of tiers\) \{ if \(ret >= t\.ret && !\(s\.profitTaken/.test(server) === false,
    "股票腿不得保留旧的「最高达标且未执行」扫描循环");
  // 下一档必须走纯函数：旧写法只看 profitTaken、不看当前收益，非升序自定义档会挑出已越过的档
  assert(/export function profitNextTier\(/.test(server), "邮件端必须导出 profitNextTier");
  assert(/const nextTier = profitNextTier\(tiers, f\.profitTaken \|\| \[\], ret\);/.test(server),
    "基金腿下一档必须走 profitNextTier 并传当前收益率");
  assert(/const nextTier = profitNextTier\(tiers, s\.profitTaken \|\| \[\], ret\);/.test(server),
    "股票腿下一档必须走 profitNextTier 并传当前收益率");
  assert(/tiers\.find\(\(x: any\) => !taken\.includes\(x\.ret\)\)/.test(server) === false,
    "两腿不得再各自 tiers.find 下一档");
  assert(/const taken = (f|s)\.profitTaken \|\| \[\];/.test(server) === false,
    "下一档改用纯函数后，局部 taken 变量应随之删除（留着说明还有手写扫描）");
  // 卡片横幅与「止盈X%达标」标记必须来自同一次判定，不许各算一次（算两次就能算出两套口径）
  assert(/sell:\s*sellAlert\(/.test(server) === false,
    "报告行的 sell 必须复用同一个 sellAlert 结果，不能再就地调用一次");
});

Deno.test("接线守卫：档位备注三态两腿共用一个函数，「执行完毕」态与页面同文案", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/export function tierNoteHtml\(/.test(server), "档位备注要抽成可测函数并导出");
  assertEquals((server.match(/const tierNote = tierNoteHtml\(r\);/g) || []).length, 2,
    "基金腿与股票腿必须调用同一个 tierNoteHtml(r)（各自手写就会漂成两套话术）");
  // 每句档位话术在整个文件里只许出现一次：出现在 tierNoteHtml 内 = 1；某条腿又手写一遍 = 2（就是漂移的开始）
  assertEquals((server.match(/'｜已达到 \+'/g) || []).length, 1, "已达档话术只准写在 tierNoteHtml 里");
  assertEquals((server.match(/'｜下一止盈档 \+'/g) || []).length, 1, "下一档话术只准写在 tierNoteHtml 里");
  assertEquals((server.match(/各止盈档已执行完毕/g) || []).length, 1, "第三态只准写在 tierNoteHtml 里");
  // 第三态（全部执行完）此前只有基金腿和页面有，股票腿留白——邮件与页面必须说同一句话
  const done = "各止盈档已执行完毕";
  assert(new RegExp("function tierNoteHtml[\\s\\S]{0,400}?" + done).test(server),
    "「执行完毕」态必须由共用的 tierNoteHtml 给出，不是某条腿临时补的字符串");
  const profitRefBody = html.slice(html.indexOf('function profitRefHtml('), html.indexOf('function buyRefHtml('));
  assert(html.includes('function profitRefHtml(') && profitRefBody.includes(done),
    "页面这一态仍是同一句文案，且必须由卡片实际调用的 profitRefHtml 给出（旧 profitMetaText 已不被调用）");
  assert(/profitMetaText/.test(html) === false,
    '页面不得再残留 profitMetaText（三栏收口后它是零调用死代码，已随本簇删除）');
});

Deno.test("接线守卫：股票安全垫有输入框、保存写 s.targetDrawdown、页面与邮件都走双腿仲裁", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/data-sk="targetDrawdown"/.test(html), "股票表单必须有「目标跌幅安全垫」输入框");
  assert(/s\.targetDrawdown = get\('targetDrawdown'\)\.value\.trim\(\);/.test(html),
    "保存必须写回 s.targetDrawdown（空串即未填，与判据的未填分支对齐）");
  assert(/const dCostStock = dipAlertStockCost\(s, dev\);/.test(html), "股票卡片必须评估成本口径安全垫");
  // 灯与指令一律由仲裁函数决定，模板里不许再手写 `sDip || dCostStock`（那是旧的单腿即亮）
  assert(/const sDipGate = stockDipGate\(sDip, dCostStock, stockPadSet\(s\)\);/.test(html),
    "股票卡片必须走 stockDipGate 双腿仲裁");
  assert(/sDip \|\| dCostStock/.test(html) === false, "旧的「任一腿突破就亮」表达式必须彻底删掉");
  // 2026-11-01 三栏收口：横幅与补填提示先按灯算成变量，再由 buyRefHtml 收进「买入参考」栏——
  // 判据（light / needPad）一个字没动，只是位置从模板内联挪到了调用点
  assert(/const buyBanner = sDipGate\.light \? stockBuyBannerHtml\(sDip, sPlan, dCostStock\) : '';/ .test(html),
    "横幅只在双腿齐备时出现");
  assert(/\$\{buyRef\}/.test(html), "买入参考栏要渲染进卡片");
  assert(/const buyRef = buyRefHtml\(sRef, pillCls, s, dev, sDipGate, sPlan, dCostStock, dualHtml, sDip, dipPadHtml, buyBanner\);/.test(html),
    "横幅与补填提示必须经 buyRefHtml 传入，不能在栏外另起一处");
  assert(/if\(buyBannerHtml\) parts\.push\(/.test(html), "buyRefHtml 内部要按传入判空，未传入不得凭空出横幅");
  assert(/\$\{sDipGate\.light\?'<span class="trade-badge buy">🟢 抄底<\/span>':''\}/.test(html),
    "🟢 抄底角标必须与横幅同判据（只看 light）");
  assert(/const sPlan = sDipGate\.light \? stockAddPlan\(stockMvOf\(s\), parseFloat\(s\.currentPrice\)\|\|0, sDip\.add, stockLotSizeOf\(s\)\) : null;/.test(html),
    "加仓计划也要按灯来算（灯灭就不该折算金额）");
  assert(/const dipPadHtml = sDipGate\.needPad \? dipPadHintHtml\(\) : '';/ .test(html),
    "回撤达标但未设安全垫时，卡片必须显式提示补填");
  assert(/未设目标跌幅安全垫/.test(html), "补填提示的文案要写清缺的是哪一腿");
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/export function stockDipAlert\(/.test(server), "邮件端必须导出同判据的 stockDipAlert（供双端比对）");
  assert(/const sCostDip = stockDipAlert\(s, ret, dev\);/.test(server), "邮件股票路径必须评估安全垫");
  assert(/const sGate = stockDipGate\(sLadder, sCostDip, stockPadSet\(s\)\);/.test(server),
    "邮件端必须走同一个双腿仲裁");
  assert(/\(stockDips\[userId\] = stockDips\[userId\] \|\| \[\]\)\.push\(\{ code, name: sname \|\| code, \.\.\.sCostDip! \}\)/.test(server),
    "命中的股票必须进 stockDips 汇总");
  assert(/if \(sGate\.light\)/.test(server), "邮件的抄底汇总也必须是 light 才收（与页面同规则）");
  assert(/dipLight: sGate\.light/.test(server), "邮件股票行要带灯位，卡片标志按灯渲染");
  assert(/padMissing: sGate\.needPad/.test(server), "邮件股票行要带上「未设安全垫」这一事实");
  assert(/dipShout: sGate\.shout/.test(server), "明显高位（shout=false）也必须压住邮件里的买入标志（与页面横幅同规则）");
  assert(/未设目标跌幅安全垫/.test(server), "邮件也必须提示补填，不能只在页面说");
  assert(/buyMarkHtml\(r\.dipShout \? r\.ladder : null, r\.dipShout \? r\.addPlan : null\)/.test(server),
    "股票行的 🟢 建议买入标志必须由灯位+高位仲裁驱动（灯灭或明显高位则连金额一起收，但回撤事实仍要写）");
  assert(/buyMarkHtml\(r\.multiplier > 0 \? r\.ladder : null\)/.test(server),
    "基金行不受本次规则影响（基金没有安全垫输入，仍按主信号发）；阶梯标记与一次性腿三腿并列，互不吞掉");
  assert(/dipBannerHtml\(\[\.\.\.\(fundDips\[userId\] \|\| \[\]\), \.\.\.\(stockDips\[userId\] \|\| \[\]\)\]\)/.test(server),
    "顶部「🟢 抄底提示」横幅必须同时列基金与股票（否则邮件里股票永远不出现）");
  assert(/成本安全垫/.test(server), "股票行必须如实写出成本安全垫状态");
});

// 2026-11-01 两件事必须由源码钉住，否则「矩阵全绿而生产走岔路」的老毛病会重犯：
// ① 页面折叠行的胶囊条要换行——.fund-card 是 overflow:hidden，缺 flex-wrap 时右侧胶囊被剪在视口外
//    （390px 视口实测：四颗需 456px、可用 388px，整颗看不见）；三栏收口后股票条上剩评分/研究/披露三颗，
//    基金条上仍是双信号那颗，换行规则两者都还要；
// ② 买入参考两端都必须走同一个三腿合成函数，禁止任何一侧还留均线单腿。
Deno.test("接线守卫：折叠行胶囊条必须换行，股票买入参考两端都走 stockBuyRef", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/\.signal-strip\{[^}]*flex-wrap:wrap[^}]*\}/.test(html),
    ".signal-strip 必须带 flex-wrap:wrap（否则手机端最右侧胶囊被 overflow:hidden 剪掉）");
  assert(/const sRef = stockBuyRef\(dev, sDip, dCostStock, stockPadSet\(s\), stockPadInfo\(s, ret\)\);/.test(html),
    "页面股票卡片必须由 dipAlertStock + dipAlertStockCost + stockPadSet 的合成结果出档位，并把安全垫的目标/现价比传进明细（未跌穿也要报数）");
  assert(/const pillCls = dualPillClass\(sRef\.label\);/.test(html),
    "页面买入参考胶囊配色必须跟着合成档位走（沿用现成的 dualPillClass，不再按 dev 手写）");
  assert(/'<span class="signal-pill ' \+ pillCls \+ '">买入参考·' \+ sRef\.label \+ '<\/span>'/.test(html),
    "页面胶囊文案 = 买入参考·<合成档位>（2026-11-01 起由 buyRefHtml 渲染，判据不变）");
  assert(/'<div class="ref-row"[^+]*\+ escapeHtml\(sRef\.text\)/.test(html),
    "页面必须把三条腿的白话事实整句渲染进栏，且要转义（用户投诉胶囊条里的「三腿 +2/+2/未破」读不懂）");
  assert(/<span class="dual-tag">三腿 \$\{sRef\.text\}<\/span>/.test(html) === false,
    "折叠行胶囊条里不得再塞打分编码的「三腿」标签（那是内部术语，且 +2 没有单位）");
  assert(/三腿 \$\{/.test(html) === false, "页面不得再有把「三腿」拼进用户可见文案的地方");
  assert(/function stockTierLabel\(/.test(html) === false,
    "均线单腿函数必须随合成上线一起删掉（留着说明还有卡片没换）");
  assert(/买入参考·\$\{tier\}/.test(html) === false, "胶囊不得再渲染单腿变量 tier");

  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/export function stockBuyRef\(/.test(server), "邮件端必须导出同判据的 stockBuyRef");
  assert(/const sRef = stockBuyRef\(dev, sLadder, sCostDip, stockPadSet\(s\), stockPadInfo\(s, ret\)\);/.test(server),
    "邮件股票腿必须把回撤档与安全垫两条腿并进买入参考（与页面同一格输入，含安全垫目标/现价比）");
  assert(/const tier = baseSignalLabel\(dev\);/.test(server) === false,
    "邮件股票腿不得再退回均线单腿（baseSignalLabel 只留给基金腿）");
  assertEquals((server.match(/tier: sRef\.label \+ \(dev === null \? '（数据不足）' : ''\)/g) || []).length,
    2, "落库行与报告行都要用合成档位，并保留「缺均线数据」的事随后缀");
  assert(/refText: sRef\.text/.test(server), "邮件报告行要带上三条腿的白话明细");
  assert(/<div style="color:#707C8C;font-size:13px;">' \+ r\.refText/.test(server),
    "邮件必须把白话明细单独放一行灰字（与页面 .signal-reason 同款），不再挤在买入参考后面");
  assert(/r\.tier \+ '<\/b>｜三腿/.test(server) === false,
    "邮件正文不得再把档位后面接一段打分编码（那句「｜三腿 均线+2·…」是本次要下线的写法）");
  assert(/三腿/.test(server.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')) === false,
    "去掉注释后的邮件源码不得再出现内部术语「三腿」");
  assert(/📈 较均线/.test(server) === false, "均线位置已在明细行报过，📈 行不得重复一遍");
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
  assert(/const sPlan = sDipGate\.light \? stockAddPlan\(stockMvOf\(s\), parseFloat\(s\.currentPrice\)\|\|0, sDip\.add, stockLotSizeOf\(s\)\) : null;/.test(html),
    "页面股票卡片必须用 stockAddPlan(stockMvOf(s), 现价, sDip.add, stockLotSizeOf(s)) 算加仓计划");
  assert(/stockBuyBannerHtml\(sDip, sPlan, dCostStock\)/.test(html), "页面股票抄底横幅必须由 stockBuyBannerHtml(sDip, sPlan, dCostStock) 渲染（成本腿要并进同一条）");
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
  // 2026-10-28 立这条时股票腿确实只有均线一条腿；2026-11-01 用户裁决改三腿合成后，
  // 「单腿」守卫由上一条（stockBuyRef 接线）取代，这里只保留「邮件不得凭空多出一条页面没有的腿」。
  assert(/baseSignalLabel\([^)]*,/.test(server) === false,
    "基金侧取消估值分位后，baseSignalLabel 不得再接受第二个参数（基金腿只传 dev）");
  assert(/const ladder = dipLadder\(f, close, null\);/.test(server),
    "邮件基金腿必须走统一门槛的 dipLadder，且不传分位（基金侧无高估否决）");
  assert(/const sLadder = dipLadder\(s, close, readPct\(s\)\);/.test(server),
    "邮件股票腿必须走统一门槛的 dipLadder（股票侧保留高估否决）");
  assert(/const addPlan = sLadder \? stockAddPlan\(sMv, close, sLadder\.add, lotSize\) : null;/.test(server),
    "邮件股票腿必须按整体持仓市值（sMv）与标的整手股数折算");
  assert(/const lotSize = \/\^\\d\{5\}\$\/\.test\(code\) \? \(\(await fetchHkLot\(code\)\) \|\| Number\(s\.lotSize\) \|\| 0\) : 100;/.test(server),
    "港股手数必须按标的读（腾讯行情 → 状态 lotSize → 0），A股固定 100");
  assert(/buyMarkHtml\(r\.dipShout \? r\.ladder : null, r\.dipShout \? r\.addPlan : null\)/.test(server),
    "股票邮件卡片必须把整手计划传给 buyMarkHtml，且由「双腿齐备 + 非明显高位」驱动（2026-10-31 起不再无条件发指令）");
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

  // --- 2026-10-30 止盈要按可成交单位说：股票必须折算整手，基金维持百分比份额 ---
  assert(/const sSellPlan = sAlert \? stockSellPlan\(parseFloat\(s\.shares\)\|\|0, parseFloat\(s\.currentPrice\)\|\|0, sAlert\.tier\.sell, stockLotSizeOf\(s\)\) : null;/.test(html),
    "页面股票卡必须用 stockSellPlan(股数, 现价, 档位比例, stockLotSizeOf(s)) 折算手数");
  assert(/stockSellBannerHtml\(sAlert, sSellPlan\)/.test(html), "页面股票止盈横幅必须由 stockSellBannerHtml(sAlert, sSellPlan) 渲染");
  assert(/sellBannerHtml\(alert\)/.test(html), "基金卡仍走百分比口径的 sellBannerHtml(alert)");
  assert(/const sellPlan = sell \? stockSellPlan\(sShare, close, sell\.tier\.sell, lotSize\) : null;/.test(server),
    "夜间股票路径必须用 stockSellPlan(sShare, close, 档位比例, lotSize) 折算手数");
  assert(/sellMarkHtml\(r\.sell, r\.sellPlan\)/.test(server), "邮件股票段必须把整手计划传给 sellMarkHtml");
  assert(/sellMarkHtml\(r\.sell\)/.test(server), "邮件基金段仍走百分比口径（不传计划）");

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

// ==== 2026-11-02 裁定：手机端正文字号上抬（B 档）====
// 用户原话「手机端字体适当加大一些方便阅读」。字号是纯 CSS，行为矩阵测不到它，所以用源码契约钉住三件事：
// ① 基础块（= 手机端读的这套）每条字号必须等于 B 档值；② 桌面覆盖值一字未动；
// ③ 桌面 ≥ 手机（既有约定，抬基础值时不许反向覆盖桌面）。
// .score-pill / .trend-badge / .conf-badge 只有基础值、没有桌面覆盖，抬它们会破坏 ③，所以本轮不参与。
Deno.test("字号契约：手机端 B 档 20 条 + 桌面覆盖未被动", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const cut = html.indexOf("@media (min-width: 768px)");
  assert(cut > 0, "桌面块必须存在，否则切片锚失效");
  const base = html.slice(0, cut);
  const desk = html.slice(cut);
  // 只认「整行以该选择器开头 + 紧跟 {」的规则，避免 .signal-pill 被 .dual-strip .signal-pill 顶掉
  const fontOf = (css: string, sel: string): number => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
    const m = new RegExp(`(?:^|\\n)\\s*${esc}\\{[^}]*?font-size:([\\d.]+)px`).exec(css);
    if (!m) throw new Error(`该块里找不到 ${sel} 的 font-size`);
    return Number(m[1]);
  };
  const CONTRACT: [string, number, number][] = [
    [".fund-meta", 13, 13.5],
    [".signal-pill", 13, 14],
    [".signal-amount", 13, 14],
    [".signal-reason", 13, 14],
    [".ref-title", 11.5, 12],
    [".ref-row", 13.5, 14],
    [".ref-empty", 13, 13],
    [".value-dim", 13, 13],
    [".value-dim .dim-label", 11.5, 11.5],
    [".value-verdict", 13.5, 14],
    [".value-note", 11.5, 11.5],
    [".dual-tag", 11.5, 12.5],
    [".disclosure-pill", 11.5, 12.5],
    [".disclosure-na", 11.5, 12.5],
    [".dual-amt", 13, 13.5],
    [".valpct-chip", 11.5, 12.5],
    [".valpct-na", 11.5, 12.5],
    [".valpct-stale", 11, 11.5],
    [".trade-banner", 13.5, 14.5],
    [".trade-badge", 11.5, 12],
  ];
  for (const [sel, mobile, desktop] of CONTRACT) {
    assertEquals(fontOf(base, sel), mobile, `手机端 ${sel} 基础字号应为 B 档 ${mobile}px`);
    assertEquals(fontOf(desk, sel), desktop, `桌面 ${sel} 覆盖字号本轮不许动（应为 ${desktop}px）`);
    assert(desktop >= mobile, `${sel} 桌面(${desktop}) 必须 ≥ 手机(${mobile})`);
  }
});

// ==== 2026-11-07 基金「持仓亏损率」一次性买入腿 + 「距历史最高净值」事实行 ====
// 裁定更正（2026-11-07，作废 2026-11-02 的口径）：>40% 指的是**持仓亏损率**——
// 现净值相对每份成本的跌幅（computeReturn），不是距历史最高净值的回撤。
// 基数 = 相同持仓数量 × 成本单价 = 当前持仓总成本，语义是把成本价拉低的一次性投入；
// 档位取 DD_STEPS 同表。三条腿各管一件事、互不接管：成本安全垫＝恢复定投边界，
// 一次性＝拉低成本，52 周阶梯＝市场口径加仓档。距历史最高净值只作事实展示，不进判据。
// 主信号暂停时只陈述事实，不给指令。

Deno.test("历史峰口径：fromPeak 是「现值距历史最高」，不是「曾经最深」——深跌后已修复的基金不得常亮", () => {
  const a = pageFundHistPeak([1.0, 2.0, 1.2]);
  assertEquals(a?.histHigh, 2.0);
  assertEquals(Number(a?.fromPeak.toFixed(6)), -0.4, "1.2/2.0−1 = −40%");

  const up = pageFundHistPeak([1.0, 1.5, 2.0]);
  assertEquals(up?.histHigh, 2.0);
  assertEquals(up?.fromPeak, 0, "现值就是历史峰 ⇒ 0，不触发");

  // 关键区分：这一串曾经从 2.0 跌到 0.5（mdd = −75%），但已修复到 1.9 ⇒ 现在只距峰 −5%
  const healed = pageFundHistPeak([1.0, 2.0, 0.5, 1.9]);
  assertEquals(healed?.histHigh, 2.0);
  assertEquals(Number(healed?.fromPeak.toFixed(6)), -0.05, "误用 mdd 会把这只判成 −75% 而永久喊买");

  assertEquals(pageFundHistPeak([]), null, "空历史不得产出 0 冒充「没回撤」");
  assertEquals(pageFundHistPeak([0, -1, NaN]), null, "脏值全滤掉后为空 ⇒ null");
  assertEquals(pageFundHistPeak([1.5])?.fromPeak, 0, "单点即峰");
});

Deno.test("一次性腿门槛：持仓亏损率严格超过 40% 才亮，40.0% 整与 30–40% 区间一律不亮", () => {
  const at = (nav: number) => ({ currentNav: nav, costBasis: 100, shares: 1000, marketValue: nav * 1000 });
  assertEquals(pageDipFundLump(at(70), { level: "watch" }), null, "亏 30% 不亮");
  assertEquals(pageDipFundLump(at(65), { level: "watch" }), null, "亏 35% 不亮");
  assertEquals(pageDipFundLump(at(60), { level: "watch" }), null, "亏 40.0% 整不算「超过」");
  assertEquals(pageDipFundLump(at(59.9), { level: "watch" })?.add, 40, "亏 40.1% → 40 档");
  assertEquals(pageDipFundLump(at(50.1), { level: "watch" })?.add, 40, "亏 49.9% 仍 40 档");
  assertEquals(pageDipFundLump(at(50), { level: "watch" })?.add, 60, "亏 50% → 60 档（DD_STEPS 最深档）");
  assertEquals(Number(pageDipFundLump(at(54.9), { level: "watch" })?.loss.toFixed(6)), 45.1);
});

Deno.test("一次性腿踩线容差：数学上恰好 40% 的亏损率不得因浮点误差被读成「超过」", () => {
  // 1.20006 / 2.0001 数学上是 0.6，但 (1.20006−2.0001)/2.0001×100 会落成 −40.000000000000014
  const f = { currentNav: 1.20006, costBasis: 2.0001, shares: 1000, marketValue: 1200.06 };
  assertEquals(Number(pageComputeReturn(f as Any)!.toFixed(9)), -40, "夹具本身必须踩在 40% 上");
  assertEquals(pageDipFundLump(f as Any, { level: "watch" }), null, "浮点尾巴不许把它推进一次性档");
  // 差 2e-6 个百分点（在 1e-9 容差之外）必须亮
  const just = { ...f, currentNav: 2.0001 * 0.59999998 };
  assertEquals(Number(pageComputeReturn(just as Any)!.toFixed(6)), -40.000002);
  assertEquals(pageDipFundLump(just as Any, { level: "watch" })?.add, 40, "超出容差就要亮");
});

Deno.test("一次性腿缺值与仲裁：无成本数据不亮、不拿 0 冒充；基金侧不吃估值分位否决", () => {
  for (const f of [
    { currentNav: 1, shares: 1000 },
    { currentNav: 1, costBasis: 0, shares: 1000 },
    { currentNav: 0, costBasis: 100, shares: 1000 },
  ]) {
    assertEquals(pageDipFundLump(f, { level: "watch" }), null, "缺成本/净值不得亮灯：" + JSON.stringify(f));
  }
  assertEquals(pageDipFundLump({ currentNav: 50, costBasis: 100, shares: 1000, valuationPercentile: 95 }, { level: "watch" })?.add,
    60, "基金侧 2026-10-28 已取消估值分位，95 无权否决");
  assertEquals(pageDipFundLump({ currentNav: 0, costBasis: 100, shares: 1000 }, { level: "watch" }), null,
    "现净值 0 是取数缺失，不是亏光——不许据此喊出巨额一次性买入");
  assertEquals(pageDipFundLump({ currentNav: -1, costBasis: 100, shares: 1000 }, { level: "watch" }), null,
    "现净值为负同样是脏数据");
});

Deno.test("一次性腿主信号仲裁：暂停时仍报事实但 shout=false，非暂停才 shout=true", () => {
  const f = { currentNav: 54.9, costBasis: 100, shares: 1000 };
  assertEquals(pageDipFundLump(f, { level: "pause" })?.shout, false);
  assertEquals(pageDipFundLump(f, { level: "watch" })?.shout, true);
  assertEquals(pageDipFundLump(f, null)?.shout, true, "无主信号对象时不凭空暂停");
});

Deno.test("一次性金额：基数为「持仓份额×成本单价」，占持仓成本与占当前市值并列，可算时给投后成本价", () => {
  const f = { shares: 1000, costBasis: 10, currentNav: 7, marketValue: 7000 };
  const p = pageFundLumpPlan(f, 40, 1);
  assertEquals(p?.baseCost, 10000, "基数 = 1000 份 × 10 元 = 10000，不是每期定投基数");
  assertEquals(p?.amount, 4000, "10000 × 40% = 4000");
  assertEquals(p?.basePct, 40);
  assertEquals(Number(p?.posPct?.toFixed(4)), 57.1429, "4000 / 7000");
  assertEquals(Number(p?.afterCost?.toFixed(6)), 8.909091, "(10000+4000) / (1000 + 4000/7)");

  const half = pageFundLumpPlan(f, 40, 0.5);
  assertEquals(half?.amount, 2000, "大盘系数 0.5 ⇒ 金额减半");
  assertEquals(half?.basePct, 20, "占成本比例随系数走，不能仍写 40%");
  assertEquals(Number(half?.posPct?.toFixed(4)), 28.5714);
  assertEquals(pageFundLumpPlan(f, 40, null)?.amount, 4000, "系数缺失按 1");

  assertEquals(pageFundLumpPlan({ ...f, marketValue: 0 }, 40, 1)?.posPct, null, "市值 0 ⇒ 不编占比");
  assertEquals(pageFundLumpPlan({ shares: 1000, costBasis: 10, currentNav: 7 }, 40, 1)?.posPct, null, "市值缺失 ⇒ null");
  // 份额缺失时退到 costTotal 当基数，但拿不到投后成本价（没有份额就算不出新的每份成本）
  const byTotal = pageFundLumpPlan({ costTotal: 10000, currentNav: 7, marketValue: 7000 }, 40, 1);
  assertEquals(byTotal?.baseCost, 10000);
  assertEquals(byTotal?.amount, 4000);
  assertEquals(byTotal?.afterCost, null);
  assertEquals(pageFundLumpPlan(f, 40, 1, 5)?.afterCost, 14000 / (1000 + 4000 / 5), "第 4 参数换现价（邮件用今夜收盘）");
  assertEquals(pageFundLumpPlan({ shares: 0, costBasis: 0, costTotal: 0 }, 40, 1), null, "成本全缺 ⇒ 不折算金额");
  assertEquals(pageFundLumpPlan(f, 0, 1), null, "档位 0 ⇒ null");
});

Deno.test("历史峰事实行：报「距历史最高净值」而非「历史最大回撤」，缺值显式说未取到", () => {
  const line = pageFundHistLine({ fromPeakHist: -0.401, histHigh: 2.3456, navDate: "2026-11-01" });
  assert(line.includes("距历史最高净值"), "口径是 fromPeak，文案必须与它相符：" + line);
  assert(line.includes("40.1%"), "回撤读数一位小数：" + line);
  assert(line.includes("2.3456"), "历史最高净值四位小数：" + line);
  assert(line.includes("2026-11-01"), "带截至日：" + line);
  assertEquals(line.includes("历史最大回撤"), false, "「历史最大回撤」是 mdd（曾经最深），写它就是假话");

  const missing = pageFundHistLine({});
  assert(missing.includes("历史净值未取到"), "缺值要显式说，不能静默：" + missing);
  assertEquals(/NaN|null|undefined/.test(missing), false, "缺值行不得漏出脏字面量：" + missing);

  const dirty = pageFundHistLine({ fromPeakHist: -0.45, histHigh: 2.0, navDate: '<img src=x onerror=alert(1)>' });
  assertEquals(dirty.includes("<img"), false, "非日期格式的 navDate 不得原样进 HTML：" + dirty);
});

Deno.test("三腿组装：成本安全垫、持仓亏损一次性、52周阶梯各自独立，命中即并列不接管", () => {
  // 亏 45.1% 且 52 周回撤 45.1%：一次性 + 阶梯同时成立，两条都要在
  const deep = { currentNav: 54.9, costBasis: 100, shares: 1000, marketValue: 54900, high52w: 100 };
  const cost = { kind: "cost", ret: -45.1, target: -40, shout: true };
  assertEquals(pageFundDipList(cost, deep, { level: "watch" }, 1).map(d => d.kind), ["cost", "lump", "ladder"],
    "三条腿各管一件事，不得互相吞掉");
  assertEquals(pageFundDipList(null, deep, { level: "watch" }, 1).map(d => d.kind), ["lump", "ladder"]);

  // 亏 35%、52 周回撤 35% ⇒ 只有阶梯
  const mid = { currentNav: 65, costBasis: 100, shares: 1000, marketValue: 65000, high52w: 100 };
  assertEquals(pageFundDipList(null, mid, { level: "watch" }, 1).map(d => d.kind), ["ladder"]);
  // 亏 25%、52 周回撤 25% ⇒ 空列表
  assertEquals(pageFundDipList(null, { ...mid, currentNav: 75 }, { level: "watch" }, 1), [],
    "三腿都不达标 ⇒ 空列表，不留空壳");
  // 无成本数据 ⇒ 一次性腿不出，市场口径照旧
  assertEquals(pageFundDipList(null, { currentNav: 50, high52w: 100 }, { level: "watch" }, 1).map(d => d.kind), ["ladder"]);
});

Deno.test("一次性横幅：喊买时给金额、两个比例与投后成本价；暂停时只陈述事实", () => {
  const plan = { amount: 2919.95, basePct: 40, baseCost: 7299.89, posPct: 68.3, afterCost: 2.5385 };
  const shout = pageBuyBanner([{ kind: "lump", loss: 41.5, add: 40, shout: true, plan }]);
  assert(shout.includes("持仓亏损 41.5%"), "横幅报的是持仓亏损率，不是距峰回撤：" + shout);
  assertEquals(shout.includes("距历史最高净值"), false, "历史峰只作事实行，不进判据句：" + shout);
  assert(shout.includes("一次性投入"), "语义是一次性，不是分期加仓：" + shout);
  assert(shout.includes("2,920"), "金额要落地：" + shout);
  assert(shout.includes("占持仓成本 40%"), "基数口径是持仓成本：" + shout);
  assert(shout.includes("占当前市值 68.3%"), "持仓口径：" + shout);
  assert(shout.includes("投后成本价约 2.5385"), "要兑现「拉低成本价」这个目的：" + shout);
  assertEquals(shout.includes("建议加仓/多投"), false, "一次性指令已在句内，不得再追一条加仓指令重复喊");

  const paused = pageBuyBanner([{ kind: "lump", loss: 41.5, add: 40, shout: false, plan }]);
  assert(paused.includes("持仓亏损 41.5%"), "暂停也要报事实：" + paused);
  assertEquals(/建议|一次性投入|投后成本价/.test(paused), false, "暂停时不得出现任何指令文案：" + paused);

  const noPlan = pageBuyBanner([{ kind: "lump", loss: 41.5, add: 40, shout: true, plan: null }]);
  assert(noPlan.includes("持仓数量/成本单价不全"), "缺数据要显式说，不编金额：" + noPlan);
  assertEquals(/NaN|undefined/.test(noPlan), false);

  // 三腿并列：成本腿、一次性腿、阶梯腿各说各的，谁也不吞谁
  const all = pageBuyBanner([
    { kind: "cost", ret: -41.5, target: -40, shout: true },
    { kind: "lump", loss: 41.5, add: 40, shout: true, plan },
    { kind: "ladder", dd: 54.8, add: 60, shout: true },
  ]);
  assert(all.includes("成本口径"), "cost 腿要保留：" + all);
  assert(all.includes("一次性投入"));
  assert(all.includes("较52周高点回撤 54.8%"), "阶梯腿不再被一次性腿吞掉：" + all);
  assert(all.includes("建议加仓/多投"), "非一次性腿 shouting 时尾巴照旧：" + all);
});

Deno.test("接线守卫：历史峰从全历史算并只作事实行，卡片三腿走 fundDipList", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  // 全历史已在手（Data_netWorthTrend），事实行零新增请求；判据只许有 fundHistPeak 一处实现体
  assert(/const hp = fundHistPeak\(navs\);/.test(html), "computeNavMetrics 必须复用 fundHistPeak，不许就地再算一遍峰");
  assert(/histHigh: hp \? hp\.histHigh : null, fromPeakHist: hp \? hp\.fromPeak : null, mddHist: hp \? hp\.mddHist : null/.test(html),
    "取不到历史峰要给 null，不拿 0 冒充「没回撤」；mdd 与峰同源带出");
  assert(/f\.histHigh = Math\.round\(m\.histHigh\*10000\)\/10000;/.test(html), "自动刷新要把历史最高净值落到基金上（四位小数）");
  assert(/f\.fromPeakHist = Math\.round\(m\.fromPeakHist\*10000\)\/10000;/.test(html), "距峰比例同样落盘，否则事实行永远读不到");
  // 手动「获取净值」也走同一个峰函数：否则新加的基金要等下次开页自动刷新才看得到这一行
  assertEquals((html.match(/const hp = fundHistPeak\(navs\);/g) || []).length, 2,
    "自动刷新与手动获取两条取数路都要算历史峰，且都只调 fundHistPeak");
  assert(/fundObj\.histHigh = hp\.histHigh;/.test(html) && /fundObj\.fromPeakHist = hp\.fromPeak;/.test(html),
    "手动获取后要把峰落到该基金上（与 high52w 同一处）");
  // 三腿必须是装配层的一次调用：模板里各拼一遍就会出现互相吞掉或重复喊
  assert(/const dips = fundDipList\(dCost, f, sig, coef\);/.test(html), "卡片三腿必须走 fundDipList（含大盘系数）");
  assertEquals(/\[dCost, dLadder\]\.filter\(Boolean\)/.test(html), false, "旧的两腿并列表达式必须删掉");
  assertEquals(/const dLadder = dipAlertFundLadder\(f, sig\);/.test(html), false,
    "阶梯腿改由 fundDipList 内部统一组装，调用点不得再单独算一次");
  assert(/\$\{fundHistPeakLine\(f\)\}/.test(html), "「距历史最高净值」事实行要常驻买入参考栏（与灯位无关）");
  assert(/\$\{dips\.length\?'<span class="trade-badge buy">🟢 抄底<\/span>':''\}/.test(html),
    "🟢 抄底角标必须与横幅同判据（同一个 dips）");
  // 一次性腿的判据量必须是持仓亏损率：读 fromPeakHist 就是回到被作废的口径
  const lumpFn = html.slice(html.indexOf("function dipAlertFundLump("), html.indexOf("function fundHistPeakLine("));
  assert(/const ret = computeReturn\(f\);/.test(lumpFn), "一次性腿必须用持仓收益率（computeReturn）作判据");
  assert(/const loss = -ret;/.test(lumpFn) && /loss > 40 \+ 1e-9/.test(lumpFn), "门槛量是持仓亏损率，且保留 1e-9 容差");
  assertEquals(/fromPeakHist/.test(lumpFn), false, "一次性腿不得再读 fromPeakHist——那是事实行的量");
  // 金额基数必须是「份额 × 成本单价」，退回每期定投基数就是把口径改回去了
  const planFn = html.slice(html.indexOf("function fundLumpPlan("), html.indexOf("function dipAlertFundLump("));
  assert(/const cost = effectiveCost\(f\);/.test(planFn) && /shares \* cost/.test(planFn),
    "一次性金额基数 = 持仓份额 × 成本单价");
  assertEquals(/baseAmount/.test(planFn), false, "每期定投基数不得再参与一次性金额");
  // 五个新函数必须在 LADDER_PURE 块内，否则门面抽不到（块外的 dipAlertFund 正是靠参数传入绕开这条限制）
  const ladder = html.slice(html.indexOf("// ==== LADDER_PURE_BEGIN ===="), html.indexOf("// ==== LADDER_PURE_END ===="));
  for (const fn of ["fundHistPeak", "fundLumpPlan", "dipAlertFundLump", "fundHistPeakLine", "fundDipList"]) {
    assert(ladder.includes("function " + fn + "("), fn + " 必须在 LADDER_PURE 块内才能被双端矩阵钉住");
  }
});

// ==== 邮件端镜像（2026-11-02）：历史峰口径 / 一次性门槛 / 金额 / 文案四处逐格比对 ====

Deno.test("历史峰双端矩阵：页面 fundHistPeak 与邮件 fundHistPeak 对同一串净值给同一个峰与距峰比例", () => {
  const series: unknown[] = [
    [], [1.5], [1, 2, 1.2], [1, 1.5, 2], [1, 2, 0.5, 1.9], [1, 2.0001, 1.20006],
    [0, -1, NaN], [1, NaN, 2, null, 1.1], ["1.0", "2.0", "1.2"], [3, 2, 1, 0.5],
  ];
  for (const navs of series) {
    const p = pageFundHistPeak(navs);
    const s = D.fundHistPeak(navs);
    assertEquals(p === null, s === null, "亮灯口径 navs=" + JSON.stringify(navs));
    assertEquals(p?.histHigh ?? null, s?.histHigh ?? null, "历史最高 navs=" + JSON.stringify(navs));
    assertEquals(p ? Number(p.fromPeak.toFixed(9)) : null, s ? Number(s.fromPeak.toFixed(9)) : null,
      "距峰比例 navs=" + JSON.stringify(navs));
  }
});

Deno.test("一次性门槛双端矩阵：持仓亏损率严格 >40%（含 1e-9 容差）与 DD_STEPS 档位逐格一致", () => {
  const costs = [2.0001, 10, 100];
  const navs: unknown[] = [undefined, null, NaN, "", 0, -1, 1.20006, 1.9, 2, 6, 5.9, 5.9999998, 5, 4.9, 3];
  for (const cost of costs) {
    for (const nav of navs) {
      const f = { currentNav: nav, costBasis: cost, shares: 1000 };
      const ret = pageComputeReturn(f as Any);
      const p = pageDipFundLump(f as Any, { level: "watch" });
      const s = D.fundLumpAlert(ret);
      const key = JSON.stringify({ cost, nav });
      assertEquals(p === null, s === null, "亮灯判定 " + key);
      assertEquals(p?.add ?? null, s?.add ?? null, "档位 " + key);
      assertEquals(p ? Number(p.loss.toFixed(9)) : null, s ? Number(s.loss.toFixed(9)) : null, "亏损率读数 " + key);
    }
  }
});

Deno.test("一次性金额双端矩阵：份额×成本单价为基数，两个比例与投后成本价逐格一致", () => {
  for (const shares of [0, 500, 1000]) {
    for (const costBasis of [0, 2.5, 10]) {
      for (const costTotal of [0, 10000]) {
        for (const mv of [0, 7000]) {
          for (const add of [40, 60]) {
            for (const coef of [null, 0.5, 1.5]) {
              const f = { shares, costBasis, costTotal, currentNav: 7, marketValue: mv };
              const p = pageFundLumpPlan(f, add, coef);
              const s = D.fundLumpPlan(f, add, coef);
              const key = JSON.stringify(f) + " add=" + add + " coef=" + coef;
              assertEquals(p === null, s === null, "金额判空 " + key);
              assertEquals(p ? Number(p.amount.toFixed(6)) : null, s ? Number(s.amount.toFixed(6)) : null, "金额 " + key);
              assertEquals(p ? Number(p.basePct.toFixed(6)) : null, s ? Number(s.basePct.toFixed(6)) : null, "占成本 " + key);
              assertEquals(p?.posPct ?? null, s?.posPct ?? null, "占市值（缺失须同为 null）" + key);
              const pa = p && p.afterCost !== null ? Number(p.afterCost.toFixed(9)) : null;
              const sa = s && s.afterCost !== null ? Number(s.afterCost.toFixed(9)) : null;
              assertEquals(pa, sa, "投后成本价（缺失须同为 null）" + key);
            }
          }
        }
      }
    }
  }
  // 第 4 参数（今夜收盘价）也必须两端同解
  const f = { shares: 1000, costBasis: 10, currentNav: 7, marketValue: 7000 };
  assertEquals(Number((pageFundLumpPlan(f, 40, 1, 5)?.afterCost as number).toFixed(9)),
    Number((D.fundLumpPlan(f, 40, 1, 5)?.afterCost as number).toFixed(9)), "换现价后两端投后成本必须一致");
});

Deno.test("历史峰事实行双端同句：邮件 📈 行与页面买入参考栏说的是同一句话", () => {
  const cases = [
    { fromPeakHist: -0.401, histHigh: 2.3456, navDate: "2026-11-01" },
    { fromPeakHist: -0.05, histHigh: 1.8, navDate: "2026-11-01" },
    { fromPeakHist: 0, histHigh: 1.8, navDate: "2026-11-01" },
    {},
    { fromPeakHist: -0.45, histHigh: 2.0, navDate: '<img src=x onerror=alert(1)>' },
  ];
  for (const f of cases) {
    const pageText = pageFundHistLine(f).replace(/<[^>]*>/g, "");
    assertEquals(D.fundHistPeakText(f), pageText, "事实行文案漂移 " + JSON.stringify(f));
  }
});

Deno.test("一次性横幅双端同句：喊买/暂停/缺数据三态，邮件与页面去掉固定前缀后逐字相同", () => {
  const plan = { amount: 2919.95, basePct: 40, baseCost: 7299.89, posPct: 68.3 as number | null, afterCost: 2.5385 as number | null };
  const cases: Array<[{ loss: number; add: number }, typeof plan | null, boolean]> = [
    [{ loss: 41.5, add: 40 }, plan, true],
    [{ loss: 41.5, add: 40 }, plan, false],
    [{ loss: 41.5, add: 40 }, null, true],
    [{ loss: 52.5, add: 60 }, { amount: 7299.89, basePct: 60, baseCost: 7299.89, posPct: null, afterCost: null }, true],
  ];
  for (const [l, p, shout] of cases) {
    const pageText = pageBuyBanner([{ kind: "lump", loss: l.loss, add: l.add, shout, plan: p }])
      .replace(/<[^>]*>/g, "").replace("🟢 抄底信号 · ", "");
    const srvText = D.fundLumpMarkHtml(l, p, shout).replace(/<[^>]*>/g, "");
    assertEquals(srvText, pageText, "一次性横幅文案漂移 " + JSON.stringify({ l, p, shout }));
  }
});

Deno.test("接线守卫：邮件基金腿用今夜收益率判一次性腿，三腿并列，📈 行带历史峰事实", async () => {
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/const hp = fundHistPeak\(navs\);/.test(server), "邮件必须用手上已有的全历史 navs 现算峰（零新增请求）");
  assert(/const lump = fundLumpAlert\(ret\);/.test(server),
    "一次性腿吃的是持仓收益率（与成本安全垫同一读数），不是历史峰");
  assert(/const lumpPlan = lump \? fundLumpPlan\(f, lump\.add, coef, close\) : null;/.test(server),
    "金额基数取自持仓（份额×成本单价），投后成本价用今夜收盘价");
  assert(/sell, ladder, lump, lumpPlan, histHigh: hp \? hp\.histHigh : null, fromPeakHist: hp \? hp\.fromPeak : null, mddHist: hp \? hp\.mddHist : null, deep/.test(server),
    "报告行要把峰、mdd 与各腿一起带下去");
  // 三腿并列：阶梯标记照旧发，不再被一次性腿吞掉
  assert(/buyMarkHtml\(r\.multiplier > 0 \? r\.ladder : null\)/.test(server),
    "阶梯标记必须照旧发（一次性腿不再接管）");
  assert(/fundLumpMarkHtml\(r\.lump, r\.lumpPlan, r\.multiplier > 0\)/.test(server),
    "一次性标记与页面同一仲裁门（暂停只报事实）");
  assert(/\+ '｜' \+ fundHistPeakText\(r\)/.test(server), "📈 行要常驻历史峰事实（与灯位无关）");
  assert(/if \(lump\) reasons\.push\('持仓亏损 '/.test(server), "恢复旗标里一次性腿报持仓亏损率");
  assert(/if \(ladder\) reasons\.push\('较52周高点回撤 '/.test(server), "阶梯句照旧");
  assertEquals(/else if \(ladder\) reasons\.push\('较52周高点回撤 '/.test(server), false,
    "else-if 会让一次性命中时丢掉阶梯事实——三腿并列必须是两条独立 if");
  // 反向钉住：用户可见文案里不得出现 mdd 口径的说法（注释里解释口径不算，所以查输出不查源码）
  for (const f of [{ fromPeakHist: -0.45, histHigh: 2, navDate: "2026-11-01" }, {}]) {
    assertEquals(/历史最大回撤/.test(D.fundHistPeakText(f)), false, "口径是 fromPeak，写「历史最大回撤」就是假话");
  }
  const lumpOut = D.fundLumpMarkHtml({ loss: 41.5, add: 40 }, { amount: 2920, basePct: 40, posPct: 68.3, afterCost: 2.5385 }, true);
  assertEquals(/历史最大回撤/.test(lumpOut), false);
  assertEquals(/距历史最高净值/.test(lumpOut), false, "一次性腿报的是持仓亏损率，混进距峰口径就是两件事串台");
});

// ==== 基金「历史最深回撤」深水腿（2026-11-08 用户裁决）：完成度 ≥90% 触发的第四条腿 ====

Deno.test("历史最深回撤双端矩阵：fundHistPeak 同一串净值给出同一个 mdd", () => {
  const series: unknown[] = [
    [], [1.5], [1, 1.2, 1.1], [1, 2, 1.2], [1, 2, 0.5, 1.9], [0, -1, NaN],
    [1, NaN, 2, null, 1.1], ["1.0", "2.0", "1.2"], [3, 2, 1, 0.5], [1, 2, 2.0001, 1.2],
  ];
  for (const navs of series) {
    const p = pageFundHistPeak(navs);
    const s = D.fundHistPeak(navs);
    assertEquals(p === null, s === null, "空值口径 navs=" + JSON.stringify(navs));
    const pm = p ? Number(p.mddHist.toFixed(12)) : null;
    const sm = s ? Number(s.mddHist.toFixed(12)) : null;
    assertEquals(pm, sm, "历史最深回撤 navs=" + JSON.stringify(navs));
  }
});

Deno.test("深水腿双端矩阵：完成度 ≥90% 触发、边界与暂停逐格一致", () => {
  const mdds = [-0.5, -0.2, -0.05];
  const fps = [0, -0.01, -0.0449, -0.045, -0.09, -0.1, -0.18, -0.4495, -0.45, -0.55];
  for (const mdd of mdds) {
    for (const fp of fps) {
      for (const paused of [false, true]) {
        const p = pageDipFundDeep({ mddHist: mdd, fromPeakHist: fp }, { level: paused ? "pause" : "watch" });
        const s = D.fundDeepAlert({ mddHist: mdd, fromPeak: fp }, !paused);
        const key = "mdd=" + mdd + " fp=" + fp + " paused=" + paused;
        assertEquals(p === null, s === null, "亮灯判定 " + key);
        assertEquals(p?.shout ?? null, s?.shout ?? null, "暂停仲裁 " + key);
        assertEquals(p ? Number(p.completion.toFixed(9)) : null, s ? Number(s.completion.toFixed(9)) : null,
          "完成度 " + key);
      }
    }
  }
  // 90.0% 整必须亮（1e-9 容差挡浮点尾巴）；89.9% 不亮；净值跌破历史最深（>100%）仍亮
  assert(pageDipFundDeep({ mddHist: -0.5, fromPeakHist: -0.45 }, null) !== null, "90.0% 要亮");
  assertEquals(pageDipFundDeep({ mddHist: -0.5, fromPeakHist: -0.4495 }, null), null, "89.9% 不亮");
  assert(pageDipFundDeep({ mddHist: -0.5, fromPeakHist: -0.55 }, null) !== null, "跌破历史最深仍亮");
  // 缺数据 / 零回撤 / 正值 / 净值高于历史峰：都不亮，也不拿 0 冒充「完成 0%」参与判定
  for (const f of [{}, { mddHist: 0, fromPeakHist: 0 }, { mddHist: 0.3, fromPeakHist: -0.1 }, { mddHist: -0.5 }, { mddHist: -0.5, fromPeakHist: 0.02 }]) {
    assertEquals(pageDipFundDeep(f as Any, null), null, "脏数据不得亮：" + JSON.stringify(f));
  }
  // 用户裁决：只给定性建议，这条腿不带任何金额字段
  const hit = pageDipFundDeep({ mddHist: -0.5, fromPeakHist: -0.48 }, null) as Any;
  assertEquals(hit.amount, undefined);
  assertEquals(hit.plan, undefined);
  assertEquals(hit.add, undefined);
});

Deno.test("深水事实行双端同句：历史最深回撤与当前完成度", () => {
  const cases = [
    { mddHist: -0.548, fromPeakHist: -0.504, navDate: "2026-11-07" },
    { mddHist: -0.185, fromPeakHist: -0.154 },
    { mddHist: 0, fromPeakHist: 0 },
    { mddHist: -0.548 },
    {},
    { mddHist: -0.548, fromPeakHist: 0.01 },
  ];
  for (const f of cases) {
    const pageText = pageFundDeepLine(f).replace(/<[^>]*>/g, "");
    assertEquals(D.fundDeepText(f), pageText, "深水事实行漂移 " + JSON.stringify(f));
  }
  const normal = pageFundDeepLine({ mddHist: -0.548, fromPeakHist: -0.504 }).replace(/<[^>]*>/g, "");
  assert(normal.includes("历史最深回撤 −54.8%"), normal);
  assert(normal.includes("当前完成 92%"), normal);
});

Deno.test("深水横幅双端同句：喊买/暂停两态，且不追加重复的加仓指令", () => {
  const d = { kind: "deep", completion: 92.4, mddHist: -0.548, fromPeak: -0.5067, shout: true };
  const pageShout = pageBuyBanner([d]).replace(/<[^>]*>/g, "").replace("🟢 抄底信号 · ", "");
  const srvShout = D.fundDeepMarkHtml({ completion: 92.4, mddHist: -0.548, fromPeak: -0.5067 }, true).replace(/<[^>]*>/g, "");
  assertEquals(srvShout, pageShout, "深水横幅文案漂移");
  assert(pageShout.includes("历史回撤完成度 92%"), pageShout);
  assert(pageShout.includes("历史最深 −54.8%"), pageShout);
  assert(pageShout.includes("当前 −50.7%"), pageShout);
  assert(pageShout.includes("可分批加仓"), pageShout);
  assertEquals(pageShout.includes("建议加仓/多投"), false, "指令已在句内，不得重复喊");

  const paused = { ...d, shout: false };
  const pagePaused = pageBuyBanner([paused]).replace(/<[^>]*>/g, "").replace("🟢 抄底信号 · ", "");
  const srvPaused = D.fundDeepMarkHtml({ completion: 92.4, mddHist: -0.548, fromPeak: -0.5067 }, false).replace(/<[^>]*>/g, "");
  assertEquals(srvPaused, pagePaused, "暂停态文案漂移");
  assertEquals(/可分批|建议|加仓/.test(pagePaused), false, "暂停时只报事实：" + pagePaused);
});

Deno.test("接线守卫：深水腿是第四条腿，页面与邮件同源接线", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const ladder = html.slice(html.indexOf("// ==== LADDER_PURE_BEGIN ===="), html.indexOf("// ==== LADDER_PURE_END ===="));
  for (const fn of ["fundDeepLine", "dipAlertFundDeep"]) {
    assert(ladder.includes("function " + fn + "("), fn + " 必须在 LADDER_PURE 块内才能被双端矩阵钉住");
  }
  // 装配层：四腿并列，deep 是第四条；顺序 cost → lump → ladder → deep
  const dipListFn = ladder.slice(ladder.indexOf("function fundDipList("), ladder.indexOf("function dipAlertStock("));
  assert(/const deep = dipAlertFundDeep\(f, sig\);/.test(dipListFn), "fundDipList 要装配深水腿");
  const order = ["dipAlertFundLump", "dipAlertFundLadder", "dipAlertFundDeep"].map(n => dipListFn.indexOf(n));
  assertEquals(order.every((v, i) => i === 0 || v > order[i - 1]), true, "腿的顺序必须是 cost → lump → ladder → deep");
  // 卡片：事实行常驻、与灯位无关
  assert(/\$\{fundDeepLine\(f\)\}/.test(html), "「历史最深回撤」事实行要常驻买入参考栏");
  // 全历史一处实现：两条取数路都要把 mdd 落到基金上
  assert(/mddHist: hp \? hp\.mddHist : null/.test(html), "computeNavMetrics 要把 mdd 带出来");
  assert(/f\.mddHist = Math\.round\(m\.mddHist\*10000\)\/10000;/.test(html), "自动刷新要把 mdd 落盘（四位小数）");
  assert(/fundObj\.mddHist = hp\.mddHist;/.test(html), "手动获取后也要落到该基金上");
  // 横幅：deep 自己有分支，且排除出 anyShout（指令已在句内）
  const bannerFn = ladder.slice(ladder.indexOf("function buyBannerHtml("), ladder.indexOf("function sellBannerHtml("));
  assert(/d\.kind==='deep'/.test(bannerFn), "横幅要处理深水腿");
  assert(/list\.some\(d=>d\.kind!=='lump' && d\.kind!=='deep' && d\.shout\)/.test(bannerFn),
    "深水腿与一次性腿一样不再追尾巴");

  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/export function fundDeepAlert\(/.test(server), "邮件端要有同判据的深水腿");
  assert(/export function fundDeepText\(/.test(server), "邮件端要有同句的事实行");
  assert(/export function fundDeepMarkHtml\(/.test(server), "邮件端要有同句的标记");
  assert(/const deep = fundDeepAlert\(hp\);/.test(server), "邮件用今夜全历史现算的峰与 mdd 判深水腿");
  assert(/\+ '｜' \+ fundDeepText\(r\)/.test(server), "📈 行常驻深水事实");
  assert(/fundDeepMarkHtml\(r\.deep, r\.multiplier > 0\)/.test(server), "深水标记与页面同一仲裁门");
  assert(/if \(deep\) reasons\.push\('历史回撤完成度 '/.test(server), "暂停旗标里深水腿也只报事实");
});

// ==== 基金「目标跌幅安全垫」常驻事实行（2026-11-08 用户裁决 A）====
// 现状：安全垫只在「跌穿横幅」或「暂停且未满足恢复条件」时偶然露一次，未踩线就等于看不见。
// 裁决：设了安全垫的基金常驻一行事实；没设的保持沉默。页面与邮件逐字同句。

Deno.test("安全垫事实行双端同句：未设沉默，未触发/触发线/已跌穿三态逐字一致", () => {
  const cases: Array<[unknown, number | null, string]> = [
    ["30", 0, "目标跌幅安全垫 30%｜当前 0.0%，还需再跌 30.0 个百分点才触发"],
    ["30", -12.4, "目标跌幅安全垫 30%｜当前 −12.4%，还需再跌 17.6 个百分点才触发"],
    ["30", -30, "目标跌幅安全垫 30%｜当前 −30.0%，已到触发线"],
    ["30", -32.4, "目标跌幅安全垫 30%｜当前 −32.4%，已跌穿 2.4 个百分点"],
    ["30", -29.96, "目标跌幅安全垫 30%｜当前 −29.96%，还需再跌 0.04 个百分点才触发"],
    ["-30", 0, "目标跌幅安全垫 30%｜当前 0.0%，还需再跌 30.0 个百分点才触发"],
    ["12.5", -20, "目标跌幅安全垫 12.5%｜当前 −20.0%，已跌穿 7.5 个百分点"],
    [30, NaN, "目标跌幅安全垫 30%｜当前收益未取到"],
    ["30", null, "目标跌幅安全垫 30%｜当前收益未取到"],
  ];
  for (const [pad, ret, want] of cases) {
    const pageText = pageFundPadLine({ resumeRule: { targetDrawdown: pad } }, ret).replace(/<[^>]*>/g, "");
    assertEquals(pageText, want, "页面文案 " + JSON.stringify([pad, ret]));
    assertEquals(D.fundPadText(pad, ret), want, "邮件文案 " + JSON.stringify([pad, ret]));
  }
  // 没设 / 空白 / 脏值 / 0：一律沉默，不拿 0 当「-0% 门槛」渲染出一行永远贴线的假事实
  for (const pad of [null, undefined, "", "   ", "0", 0, "abc", NaN]) {
    assertEquals(pageFundPadLine({ resumeRule: { targetDrawdown: pad } }, 0), "", "未设要沉默：" + String(pad));
    assertEquals(D.fundPadText(pad, 0), "", "邮件未设要沉默：" + String(pad));
    assertEquals(pageFundPadLine({ resumeRule: { targetDrawdown: pad } }, -50), "", "未设遇跌穿也沉默：" + String(pad));
  }
  // 无 resumeRule / resumeRule 为 null：同样沉默，不抛
  assertEquals(pageFundPadLine({}, 0), "");
  assertEquals(pageFundPadLine({ resumeRule: null }, 0), "");
});

Deno.test("安全垫事实行默认口径：页面对外调用不传 ret 时自己算持仓收益率", () => {
  const hit = pageFundPadLine({ resumeRule: { targetDrawdown: "30" }, costBasis: 1, currentNav: 0.676 }).replace(/<[^>]*>/g, "");
  assertEquals(hit, "目标跌幅安全垫 30%｜当前 −32.4%，已跌穿 2.4 个百分点");
  const live = pageFundPadLine({ resumeRule: { targetDrawdown: "30" }, costBasis: 1, currentNav: 0.873 }).replace(/<[^>]*>/g, "");
  assertEquals(live, "目标跌幅安全垫 30%｜当前 −12.7%，还需再跌 17.3 个百分点才触发");
  // 缺成本：只报「收益未取到」，不默认 0% 也不当作跌穿
  const blind = pageFundPadLine({ resumeRule: { targetDrawdown: "30" } }).replace(/<[^>]*>/g, "");
  assertEquals(blind, "目标跌幅安全垫 30%｜当前收益未取到");
});

Deno.test("接线守卫：安全垫事实行常驻买入参考栏，页面与邮件同源接线", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const ladder = html.slice(html.indexOf("// ==== LADDER_PURE_BEGIN ===="), html.indexOf("// ==== LADDER_PURE_END ===="));
  assert(ladder.includes("function fundPadLine("), "fundPadLine 必须在 LADDER_PURE 块内才能被双端矩阵钉住");
  // 卡片：常驻行紧跟在历史最深回撤之后，与灯位无关
  const card = html.slice(html.indexOf("const fundBuyRef ="), html.indexOf("card.innerHTML = `"));
  assert(/\$\{fundPadLine\(f\)\}/.test(card), "安全垫事实行要常驻买入参考栏");
  assert(card.indexOf("${fundPadLine(f)}") > card.indexOf("${fundDeepLine(f)}"), "安全垫行排在历史最深回撤之后");

  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/export function fundPadText\(/.test(server), "邮件端要有同句的事实行");
  assert(/pad: f\.resumeRule \? f\.resumeRule\.targetDrawdown : null/.test(server), "报告行要带上目标跌幅原文");
  assert(/const padStr = fundPadText\(r\.pad, r\.ret\);/.test(server), "邮件用同口径收益率拼安全垫事实");
  assert(/\+ \(padStr \? '｜' \+ padStr : ''\)/.test(server), "📈 行常驻安全垫事实，未设时不拖一个空尾巴");
});
