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

Deno.test("边界钉死：缺数据不造词（dev=null & pct=null → 正常），单腿可用时另一腿照常参与", () => {
  setState({ funds: [], themeCaps: {}, goal: 200000 });
  // 两腿全缺：页面口径不给「缺数据」标签，报告里由状态行（zone=数据不足）披露
  assertEquals(evalFundSignal({ ma60: null, ma120: null, currentNav: 100, valuationPercentile: null }), {
    level: "normal", label: "正常", multiplier: 1,
    reasons: ["未填写均线数据，偏离度信号缺省为中性"],
  });
  // 只缺均线腿、百分位可用 → 百分位腿单独定档（页面与服务端都不许退化成中性）
  assertEquals(evalFundSignal({ ma60: null, ma120: null, currentNav: 100, valuationPercentile: 10 }).label, "加强");
  // 只有一条均线（ma120 缺）→ 单腿偏离照常参与（-6% → 加强）
  assertEquals(evalFundSignal({ ma60: 100, ma120: null, currentNav: 94, valuationPercentile: null }).label, "加强");
});

Deno.test("golden nails：档位词表与仲裁规则（页面侧，服务端同值由矩阵守护）", () => {
  setState({ funds: [], themeCaps: {}, goal: 200000 });
  const cases: [Record<string, unknown>, string, number][] = [
    [{ ma60: 100, ma120: 100, currentNav: 94 }, "加强", 1.5],                      // dev −6
    [{ ma60: 100, ma120: 100, currentNav: 94, valuationPercentile: 95 }, "正常", 1], // 两腿抵消：+1 −2
    [{ ma60: 100, ma120: 100, currentNav: 100, valuationPercentile: 10 }, "加强", 1.5],
    [{ ma60: 100, ma120: 100, currentNav: 80, valuationPercentile: 10 }, "双倍", 2],
    [{ ma60: 100, ma120: 100, currentNav: 112, valuationPercentile: 95 }, "暂停", 0],
    [{ ma60: 100, ma120: 100, currentNav: 100, valuationPercentile: 90 }, "减半", 0.5],
  ];
  for (const [f, label, mult] of cases) {
    const r = baseSignal(f);
    assertEquals({ label: r.label, mult: r.multiplier }, { label, mult });
  }
  // 仲裁规则：百分位 ≥80（高估区）时回撤加仓被「不追跌」否决
  const vetoed = dualSignal(90, 35);
  assertEquals({ addPct: vetoed.addPct, vetoed: vetoed.vetoed, label: vetoed.label }, { addPct: 0, vetoed: true, label: "暂停" });
  // 未高估时回撤阶梯照常累加：百分位中性 ×1 + 回撤 35% 档 +40% → 加强
  const ok = dualSignal(50, 35);
  assertEquals({ addPct: ok.addPct, vetoed: ok.vetoed, label: ok.label }, { addPct: 40, vetoed: false, label: "加强" });
  assertEquals(pctTier(null), null, "百分位缺数据必须是 null（不许落 0 被读成低估）");
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

Deno.test("接线守卫：页面卡片与夜间批处理都必须调用被比对的函数（防「测试绿但生产走岔路」）", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(/const sig = evalFundSignal\(f\);/.test(html), "页面基金卡片必须调用 evalFundSignal(f)");
  assert(/const bkey = fundBenchKey\(f\);/.test(html), "页面基金卡片必须用 fundBenchKey(f) 裁决参考指数（含「不参考」豁免）");
  assert(/\/\/ ==== SIGNAL_PURE_BEGIN ====/.test(html) && /\/\/ ==== SIGNAL_PURE_END ====/.test(html),
    "index.html 必须有 SIGNAL_PURE 标记块（本测试的抽取来源）");
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
});
