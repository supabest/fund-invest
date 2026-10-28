// index_test.ts — 覆盖 daily-update 抽出 handle + DISABLE_SERVE 守卫后的三条失败路径可归因日志与恢复结构
// 参照 supabase/functions/sector-trend/index_test.ts 模式：先设 DISABLE_SERVE 再动态 import（避免 import 即绑端口）；
// 失败注入靠 globalThis.fetch 桩（取数/写库）+ handle 的第二参 deps.sendMail 注入位（发信）。
// 每条用例都验证：① 响应仍为约定结构（成功=summary，失败={ok:false,error}）；② console.error 出现带 [daily-update][环节] 标签的可归因失败行。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
Deno.env.set("DAILY_UPDATE_TOKEN", "test-token");
Deno.env.set("SUPABASE_URL", "https://fake.supabase.co");
Deno.env.set("SB_SERVICE_KEY", "svc-placeholder");
const { handle, holdingsSummaryHtml, fundDipAlert, dipBannerHtml, runRow, txSource, parseTxKline, klineFailNote,
  ddAddPct, drawdownFrom, dipLadder, sellAlert, retChipHtml, baseSignalLabel,
  evalFundSignalServer, stockAddPlan, lotFromTxQuote } = await import("./index.ts");

const SB = "https://fake.supabase.co";
const TOKEN = "test-token";

function req(body?: unknown): Request {
  return new Request(SB + "/functions/v1/daily-update", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// 捕获 console.error（默认 level=error 会污染测试输出，同时便于断言可归因失败行）
function captureErrorLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(" "));
  };
  return { lines, restore: () => (console.error = real) };
}

// 断言至少存在一条带 [daily-update] 前缀且匹配指定环节标签的可归因失败日志
function hasStageLog(lines: string[], stage: string): boolean {
  return lines.some((l) => l.includes("[daily-update]") && l.includes("[" + stage + "]"));
}

// pingzhongdata 返回体：满足 index.ts 中 fS_name + Data_netWorthTrend 两个正则，且 trend 非空可解析出净值序列
const PZ_TEXT =
  'var fS_name = "测试基金";\nvar Data_netWorthTrend = [{"x":1700000000000,"y":"1.50"},{"x":1700086400000,"y":"1.60"}];\n';

Deno.test("handle 可被 import 且 DISABLE_SERVE 守卫生效（未绑端口、无顶层副作用）", () => {
  assertEquals(typeof handle, "function");
});

Deno.test("取数异常（dingtou_state 读失败）→ 500 且响应为约定 {ok:false,error} + [daily-update][取数] 可归因日志", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("dingtou_state")) {
      return Promise.resolve(new Response("db down", { status: 500 }));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req());
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 500);
    assertEquals(body.ok, false);
    assertEquals(typeof body.error, "string");
    assertEquals(String(body.error).includes("state read failed"), true, "error 须可归因到状态读取环节");
    assertEquals(
      hasStageLog(logs.lines, "取数"),
      true,
      "应输出一条带 [daily-update][取数] 标签的可归因失败日志行",
    );
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("发信异常（deps.sendMail 抛错）→ 非致命：仍返回 200 约定 summary、sent=false、mailError 记录 + [daily-update][发信] 可归因日志", async () => {
  const real = globalThis.fetch;
  // 用一只非法股票代码（'XYZ' 不匹配 A股6位/港股5位正则）走通 invalidStocks → items.length>0 → 触发发信分支，
  // 无需真实基金/股票行情链路（该链路对 fetch 桩要求更复杂）。
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { stocks: [{ code: "XYZ", name: "非法代码测试" }] },
      }]));
    }
    // signal_state / index_state 等读取一律空数组（不发信相关的写库）
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  const deps = {
    sendMail: async () => {
      throw new Error("smtp connect failed");
    },
  };
  try {
    const res = await handle(req({ force: true }), deps);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 200, "发信失败不应让整个 nightly 任务判死");
    assertEquals(body.ok, true);
    const notifications = body.notifications as Record<string, unknown>[];
    assertEquals(notifications.length >= 1, true);
    const last = notifications[notifications.length - 1];
    assertEquals(last.sent, false, "sendMail 抛错 → 该次通知 sent 必须为 false（不能虚报已发送）");
    assertEquals(typeof last.mailError, "string", "mailError 应记录具体失败原因");
    assertEquals(
      hasStageLog(logs.lines, "发信"),
      true,
      "应输出一条带 [daily-update][发信] 标签的可归因失败日志行",
    );
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("写库异常（signal_state upsert 失败）→ 500 且响应为约定 {ok:false,error} + [daily-update][写库] 可归因日志", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("pingzhongdata")) {
      return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    }
    // 精确制造"基金已成功计算并进入第 6 步 → 写 signal_state 失败"这条唯一非本地 try/catch 包裹的写库路径
    // （index_history/fund_nav_history/fund_latest/stock_history/stock_latest 的 post() 失败均被各自
    //  per-code try/catch 吞掉转 summary，不会走到顶层 catch；唯有第 6 步 signal_state/index_state 的
    // post() 抛出会直达顶层 catch → 500）。
    if (method === "POST" && url.includes("/rest/v1/signal_state")) {
      return Promise.resolve(new Response("write boom", { status: 500 }));
    }
    if (method === "POST") {
      return Promise.resolve(Response.json({}, { status: 201 }));
    }
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        // benchmark 取不在 BENCH 字典里的键 → idxSet 为空 → 跳过参考指数取数环节，本用例只验证写库失败路径
        data: { funds: [{ fundCode: "000001", name: "测试基金", benchmark: "ZZZ", marketValue: 1000 }] },
      }]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req());
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 500);
    assertEquals(body.ok, false);
    assertEquals(typeof body.error, "string");
    assertEquals(String(body.error).includes("signal_state"), true, "error 须可归因到 signal_state 写库失败");
    assertEquals(
      hasStageLog(logs.lines, "写库"),
      true,
      "应输出一条带 [daily-update][写库] 标签、含表名的可归因失败日志行",
    );
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── 持仓概览汇总块（2026-10-24 加）：纯函数 4 条 + 接线 1 条 ──
// 加这层的起因：web 端顶部有三宫格大号「基金收益率/股票收益率」，邮件只在每张卡片第三行
// 用小号灰字印当前收益率，没有汇总。用户要求"在明显位置显示持仓的当前收益率"。
// 判据不动（信号/止盈/系数一字未改），只多渲染一块纯展示。

Deno.test("holdingsSummaryHtml：正负号、着色、千分位金额一次说全", () => {
  const html = holdingsSummaryHtml(
    { mv: 128400, cost: 120250, n: 5, nCost: 5 },
    { mv: 64900, cost: 67040, n: 4, nCost: 4 },
    "2026-10-24",
  );
  assertEquals(html.includes("持仓概览"), true);
  assertEquals(html.includes("按 2026-10-24 最新净值 / 收盘价"), true, "口径必须写在块里，别让读者猜");
  // 基金：(128400-120250)/120250 = +6.777% → +6.8%
  assertEquals(html.includes("+6.8%"), true);
  assertEquals(html.includes("#3F8A68"), true, "正收益用绿");
  assertEquals(html.includes("¥128,400"), true, "金额要带千分位");
  assertEquals(html.includes("浮盈 +¥8,150"), true);
  // 股票：(64900-67040)/67040 = -3.192% → -3.2%
  assertEquals(html.includes("-3.2%"), true);
  assertEquals(html.includes("#B14A34"), true, "负收益用红");
  assertEquals(html.includes("浮亏 -¥2,140"), true);
});

Deno.test("holdingsSummaryHtml：成本全缺 → 收益率必须是 --，绝不拿 0 当分母", () => {
  const html = holdingsSummaryHtml({ mv: 10000, cost: 0, n: 2, nCost: 0 }, null, "2026-10-24");
  assertEquals(html.includes("--"), true);
  assertEquals(html.includes("未填成本"), true, "缺成本要说清是缺，不是 0");
  assertEquals(/NaN|Infinity/.test(html), false, "cost=0 若当分母会算出 NaN/Infinity 直接甩到用户眼前");
  assertEquals(html.includes("股票"), false, "没有股票持仓就不渲染股票段，不留空壳");
});

Deno.test("holdingsSummaryHtml：部分缺成本 → 如实标「成本已填 3/4 只」", () => {
  const html = holdingsSummaryHtml(null, { mv: 4000, cost: 3000, n: 4, nCost: 3 }, "2026-10-24");
  assertEquals(html.includes("成本已填 3/4 只"), true);
  assertEquals(html.includes("基金"), false);
});

Deno.test("holdingsSummaryHtml：两边都没持仓 → 空串（不留空壳标题）", () => {
  assertEquals(holdingsSummaryHtml(null, null, "2026-10-24"), "");
  assertEquals(
    holdingsSummaryHtml({ mv: 0, cost: 0, n: 0, nCost: 0 }, { mv: 0, cost: 0, n: 0, nCost: 0 }, "2026-10-24"),
    "",
  );
});

Deno.test("接线：汇总块必须真出现在发出去的邮件里，且位置在日期之后、基金分析之前", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 500 份 × 今夜净值 1.60 = 市值 800；成本净值 1.00 → 成本 500 → 收益率 +60.0%
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [{ fundCode: "000001", name: "测试基金", benchmark: "ZZZ", marketValue: 800, shares: 500, costBasis: 1 }] },
      }]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const deps = { sendMail: async (_s: string, html: string) => { mail = html; } };
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), deps);
    assertEquals(res.status, 200);
    const iHead = mail.indexOf("收盘数据已自动更新");
    const iSum = mail.indexOf("持仓概览");
    const iFund = mail.indexOf("基金分析");
    assertEquals(iSum > 0, true, "邮件里必须有持仓概览块（纯函数绿了不代表接上了）");
    assertEquals(iHead < iSum && iSum < iFund, true, "位置：日期之后、基金分析之前");
    // 卡片里本来就印着「当前收益率 +60.0%」，所以必须只在汇总块这一段里断言，否则会假绿
    const block = mail.slice(iSum, iFund);
    assertEquals(block.includes("+60.0%"), true, "汇总块自己必须算出 +60.0%");
    assertEquals(block.includes("成本已填 1/1 只"), true);
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── 抄底提示（2026-10-25 加）：跌穿「目标跌幅安全垫」时在邮件顶部明显提示买入 ──
// 与页面 dipAlertFund 同一语义：当前跌幅 ≥ 目标跌幅才亮（不是"还没跌到就喊买"）。
// 主信号暂停时不喊买，只报状态——避免一封邮件里同时出现"暂停"和"建议加仓"。

Deno.test("fundDipAlert：恰好踩线 -20% 必须亮（1e-9 容差），-19.9% 不亮", () => {
  const f = { resumeRule: { targetDrawdown: "20" } };
  const hit = fundDipAlert(f, -20, "normal");
  assertEquals(hit !== null, true);
  assertEquals(hit!.target, -20);
  assertEquals(hit!.shout, true);
  // 浮点退化：-19.999999 在页面口径里算踩线，不能被判成"差一点"而漏亮
  assertEquals(fundDipAlert(f, -20 + 1e-12, "normal") !== null, true, "浮点误差不能漏亮");
  assertEquals(fundDipAlert(f, -19.9, "normal"), null, "没跌到就不亮");
  assertEquals(fundDipAlert(f, -35, "normal")?.ret, -35, "跌得更深当然亮");
});

Deno.test("fundDipAlert：未填安全垫 / 没填成本 / 非数字一律不亮", () => {
  assertEquals(fundDipAlert({}, -30, "normal"), null);
  assertEquals(fundDipAlert({ resumeRule: { targetDrawdown: "" } }, -30, "normal"), null);
  assertEquals(fundDipAlert({ resumeRule: {} }, -30, "normal"), null);
  assertEquals(fundDipAlert({ resumeRule: { targetDrawdown: "20" } }, null, "normal"), null, "没填成本算不出收益率，不能凭空喊买");
  assertEquals(fundDipAlert({ resumeRule: { targetDrawdown: "abc" } }, -30, "normal"), null, "脏值不亮（页面此处是潜在 NaN 穿透点）");
  assertEquals(fundDipAlert({ resumeRule: { targetDrawdown: "-20" } }, -25, "normal")?.target, -20, "负数录入要归一");
});

Deno.test("fundDipAlert：主信号暂停 → 仍返回触发但 shout=false（只报状态）", () => {
  const d = fundDipAlert({ resumeRule: { targetDrawdown: "20" } }, -25, "pause");
  assertEquals(d !== null, true);
  assertEquals(d!.shout, false);
});

Deno.test("dipBannerHtml：空列表返回空串；暂停那条只陈述事实，不写「暂不新增」指令", () => {
  assertEquals(dipBannerHtml([]), "");
  const html = dipBannerHtml([
    { code: "000001", name: "测试基金A", ret: -23.4, target: -20, shout: true },
    { code: "000002", name: "测试基金B", ret: -20.5, target: -20, shout: false },
  ]);
  assertEquals(html.includes("抄底提示"), true);
  assertEquals(html.includes("【000001】测试基金A 收益 -23.4% 已跌破 -20% 安全垫"), true);
  assertEquals(html.includes("建议加仓/多投"), true);
  // 2026-10-28 用户裁决：「暂停」只代表用户当前在该基金的定投状态，不是系统指令
  assertEquals(html.includes("暂不新增"), false);
  assertEquals(html.includes("仅状态提示"), false);
  assertEquals(html.includes("主信号暂停中"), false);
  // 暂停那条自己不能带买入指令，也不留一个指向空指令的箭头
  const lineB = html.slice(html.indexOf("【000002】"));
  assertEquals(lineB.includes("建议加仓"), false, "暂停的基金不许被第一条的「建议加仓」文案沾到");
  assertEquals(lineB.includes("→"), false, "删掉指令后不许留悬空箭头");
  assertEquals(lineB.includes("已跌破 -20% 安全垫"), true, "事实仍要如实写出");
  assertEquals(/NaN|Infinity/.test(html), false);
});

Deno.test("接线：抄底横幅真进邮件，位置在日期之后、持仓概览之前", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 每份成本 2.00、今夜净值 1.60 → 收益率 -20.0%，恰好踩线目标跌幅 20%
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{
            fundCode: "000001", name: "测试基金", benchmark: "ZZZ",
            marketValue: 800, shares: 500, costBasis: 2,
            resumeRule: { requireDays: 3, mode: "ma_only", targetDrawdown: 20 },
          }],
        },
      }]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const deps = { sendMail: async (_s: string, html: string) => { mail = html; } };
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), deps);
    assertEquals(res.status, 200);
    const iHead = mail.indexOf("收盘数据已自动更新");
    const iDip = mail.indexOf("抄底提示");
    const iHold = mail.indexOf("持仓概览");
    const iFund = mail.indexOf("基金分析");
    assertEquals(iDip > 0, true, "邮件里必须有抄底横幅（纯函数绿了不代表接上了）");
    assertEquals(iHead < iDip && iDip < iHold && iHold < iFund, true, "位置：日期之后 → 抄底 → 持仓概览 → 基金分析");
    assertEquals(mail.includes("收益 -20.0% 已跌破 -20% 安全垫"), true);
    assertEquals(mail.includes("建议加仓/多投"), true);
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("并发预取后单项失败仍隔离：坏基金不拖倒好基金，也不整链失败", async () => {
  // 并发改造最容易引入的回归是"一个 worker 抛错把整池炸掉"，这条就是钉这个边界。
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("pingzhongdata")) {
      if (url.includes("000002")) {
        // 结构合法但趋势为空：走解析分支报错，不会触发重试退避，测试不必等 3.6s
        return Promise.resolve(new Response('var fS_name="坏基金"; var Data_netWorthTrend = [];', { status: 200 }));
      }
      return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    }
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [
            { fundCode: "000001", name: "好基金", benchmark: "ZZZ", marketValue: 1000, shares: 100, costBasis: 2 },
            { fundCode: "000002", name: "坏基金", benchmark: "ZZZ", marketValue: 500, shares: 50, costBasis: 2 },
          ],
        },
      }]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const deps = { sendMail: async () => {} };
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), deps);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    const byCode: Record<string, boolean> = {};
    for (const f of body.funds) byCode[f.code] = f.ok;
    assertEquals(byCode["000001"], true, "好基金不能因为邻居失败被带走");
    assertEquals(byCode["000002"], false, "坏基金要如实标 ok:false");
    assertEquals(body.funds.length, 2);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── C: stock_signal_state 写库接线 + D: daily_update_run 运行台账（2026-10-27 加）──
// 起因（2026-10-27 只读盘点实测）：
//   ① stockSignalRows 在 :685/:735 只 push 从未 post，全仓 grep `stock_signal_state` 只有 :732 一处"读"，
//      ⇒ 表恒为空 ⇒ wasOver 永远 false ⇒ 股票总仓位超限提醒每夜重复发。
//   ② nightly 任务由 pg_cron 经 HTTP 触发、响应体被丢弃，且本机到 {ref}.supabase.co 数据面 TLS 被切，
//      console 的 [daily-update][计时] 行拿不到 ⇒ 事后无法归因"哪一段吃掉了 150s"。加一张运行台账表。
// 判据一字未动（信号/止盈/系数/邮件文案），只补写库与台账。

// POST 捕获桩：按 URL 还原表名与 on_conflict，断言"真发了什么"而不是"源码里有没有这个词"
function capturePosts(): { out: { table: string; conflict: string; rows: any[] }[]; record: (url: string, init?: RequestInit) => void } {
  const out: { table: string; conflict: string; rows: any[] }[] = [];
  return {
    out,
    record(url: string, init?: RequestInit) {
      const t = /\/rest\/v1\/([A-Za-z0-9_]+)/.exec(url);
      const c = /[?&]on_conflict=([^&]+)/.exec(url);
      let parsed: unknown = null;
      try { parsed = JSON.parse(String(init?.body ?? "null")); } catch { /* 非 JSON 体不阻断断言 */ }
      out.push({ table: t ? t[1] : url, conflict: c ? c[1] : "", rows: Array.isArray(parsed) ? parsed : [parsed] });
    },
  };
}

// 唯一不依赖 K线成功就能产出 stock_signal_state 行的路径：股票行情全失败，但仓位上限用 currentPrice 兜底仍能算。
// 1000 股 × 100 元 = 10 万 > 上限 5 万 ⇒ over。K线桩返回 {data:{}}（无 klines），8 个镜像各一次快失败，不退避。
function capOnlyStates(cap: number) {
  return [{ user_id: "u1", data: { stockCap: cap, stocks: [{ code: "600000", name: "测试股", shares: 1000, currentPrice: 100 }] } }];
}

function capOnlyStub(posts: ReturnType<typeof capturePosts>, inject?: (url: string, init?: RequestInit) => Response | null) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const forced = inject ? inject(url, init) : null;
    if (forced) return Promise.resolve(forced);
    if (method === "POST") { posts.record(url, init); return Promise.resolve(Response.json({}, { status: 201 })); }
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(capOnlyStates(50000)));
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
}

Deno.test("C：股票信号真写库 —— POST /rest/v1/stock_signal_state 带 __STOCK_CAP__ tier=over", async () => {
  const posts = capturePosts();
  const real = globalThis.fetch;
  capOnlyStub(posts);
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    assertEquals(res.status, 200);
    const writes = posts.out.filter((p) => p.table === "stock_signal_state");
    assertEquals(writes.length >= 1, true, "必须真发一次 POST stock_signal_state（此前只读不写，表恒为空）");
    assertEquals(writes[0].conflict, "user_id,code", "PK 是 (user_id,code)，upsert 冲突键要对");
    const capRow = writes[0].rows.find((r: any) => r && r.code === "__STOCK_CAP__");
    assertEquals(capRow && capRow.tier, "over", "10 万 > 上限 5 万 → 落库档位必须是 over，次日才能识别「已是 over 不重复提醒」");
    assertEquals(capRow && capRow.user_id, "u1");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("C：stock_signal_state 写库失败不致命 —— 仍 200、邮件照发、[写库] 日志可归因", async () => {
  const posts = capturePosts();
  const real = globalThis.fetch;
  capOnlyStub(posts, (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/rest/v1/stock_signal_state")) {
      return new Response("boom", { status: 500 });
    }
    return null;
  });
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 200, "台账类信号表写失败不许把整晚任务判死（邮件是第一交付物）");
    assertEquals(body.ok, true);
    const mails = (body.notifications as Record<string, unknown>[]).filter((n) => n.sent === true);
    assertEquals(mails.length >= 1, true, "信号表失败后邮件仍须真发出");
    assertEquals(hasStageLog(logs.lines, "写库"), true, "要留下一条带表名的可归因失败日志");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("D：runRow 纯函数 —— 计数、邮件口径、时长、timings 串一次说全", () => {
  assertEquals(typeof runRow, "function", "runRow 必须先导出，否则台账内容无从验证");
  const summary = {
    users: 2,
    funds: [{ ok: true }, { ok: false }, { ok: true }],
    stocks: [{ ok: true }, { ok: false }],
    indices: [{ ok: false }],
    notifications: [{ sent: true }, { sent: false, mailError: "smtp down" }, { sent: false }],
  };
  const row = runRow(summary, ["state 10ms", "mail 120ms"], {
    runAt: "2026-10-27T14:30:00.000Z", status: "ok", force: false, msTotal: 1234,
  });
  assertEquals(row.run_at, "2026-10-27T14:30:00.000Z");
  assertEquals(row.status, "ok");
  assertEquals(row.force, false);
  assertEquals(row.users, 2);
  assertEquals(row.ms_total, 1234);
  assertEquals(row.timings, "state 10ms | mail 120ms");
  assertEquals(row.funds_ok, 2);
  assertEquals(row.funds_fail, 1);
  assertEquals(row.stocks_ok, 1);
  assertEquals(row.stocks_fail, 1);
  assertEquals(row.index_ok, 0);
  assertEquals(row.index_fail, 1);
  assertEquals(row.mail_sent, 1);
  assertEquals(row.mail_failed, 1, "没尝试发送的静默用户（sent=false 且无 mailError）不计失败");
  assertEquals(row.error, null);
});

Deno.test("D：runRow 边界 —— running 空汇总全零、error 截断 200", () => {
  const running = runRow({ users: 0, funds: [], stocks: [], indices: [], notifications: [] }, [], {
    runAt: "2026-10-27T14:30:00.000Z", status: "running", force: true, msTotal: 42,
  });
  assertEquals(running.status, "running");
  assertEquals(running.force, true);
  assertEquals(running.funds_ok, 0);
  assertEquals(running.mail_sent, 0);
  assertEquals(running.timings, "");
  const err = runRow({ users: 1 }, [], {
    runAt: "2026-10-27T14:30:00.000Z", status: "error", force: false, msTotal: 151000,
    error: "x".repeat(300),
  });
  assertEquals(err.error.length, 200, "error 必须截断，台账列宽有限且不能把整段堆栈塞进去");
  assertEquals(err.status, "error");
});

Deno.test("D：成功链路写两行台账 —— 先 running 再 ok", async () => {
  const posts = capturePosts();
  const real = globalThis.fetch;
  capOnlyStub(posts);
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    assertEquals(res.status, 200);
    const runs = posts.out.filter((p) => p.table === "daily_update_run");
    assertEquals(runs.length, 2, "开始一行 + 收尾一行，中间被墙钟砍掉时表里只剩 running，这就是断点证据");
    assertEquals(runs[0].rows[0].status, "running");
    assertEquals(runs[0].conflict, "run_at");
    assertEquals(runs[1].rows[0].status, "ok");
    assertEquals(runs[1].rows[0].force, true);
    assertEquals(runs[1].rows[0].stocks_fail, 1, "行情全失败要如实落在台账里");
    assertEquals(typeof runs[1].rows[0].ms_total, "number");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("D：致命链路也留台账 —— dingtou_state 读失败 → 500 + 一行 status=error", async () => {
  const posts = capturePosts();
  const real = globalThis.fetch;
  capOnlyStub(posts, (url) => {
    if (url.includes("dingtou_state")) return new Response("db down", { status: 500 });
    return null;
  });
  const logs = captureErrorLogs();
  try {
    const res = await handle(req());
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 500);
    assertEquals(body.ok, false);
    const runs = posts.out.filter((p) => p.table === "daily_update_run");
    assertEquals(runs.length, 1, "状态读取就失败 → 只有收尾那一行（running 行在 mark('state') 之后才写）");
    assertEquals(runs[0].rows[0].status, "error");
    assertEquals(String(runs[0].rows[0].error).includes("state read failed"), true);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("D：台账写库自身失败不改判 —— daily_update_run 500 时仍返回约定 200", async () => {
  const posts = capturePosts();
  const real = globalThis.fetch;
  capOnlyStub(posts, (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/rest/v1/daily_update_run")) {
      return new Response("no such table", { status: 500 });
    }
    return null;
  });
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, unknown>;
    assertEquals(res.status, 200, "台账是观测件，绝不能因为表还没建就把整晚任务打挂");
    assertEquals(body.ok, true);
    assertEquals(hasStageLog(logs.lines, "写库"), true);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── A: 股票/指数腿加腾讯 gtimg 兜底（2026-10-28 加）──
// 起因（实测，非推断）：push2his 对 Edge 出口 IP 连续 3 晚拒连 ⇒ stock_latest 停在 10-24 20:31、
// index_history 停在 10-23、index_state 停在 10-24 force，股票+指数两条腿全废；邮件只喊得出股票那半。
// 板块腿当年因同一问题迁到腾讯（sector-trend/tencent.ts 头注释「东财 push2/push2his 已被 WAF IP 封禁」）。
// 口径核对（2026-10-28 本机逐根对账）：10-27 收盘 600031=18.070 / 000338=21.000 / 002415=34.250，
// 与东财 fqt=1 分毫不差 ⇒ 兜底接管时判据输入不变。腾讯行格式 [date, open, close, high, low, volume]，收盘是 r[2]。
// 顺序承诺：东财仍是首选，腾讯只在东财整段失败后补一次（T4 钉住这条，防止哪天变成静默换源改口径）。

// 腾讯真实响应形状的最小可用样本（含一行畸形，验证剔除）
function txJson(symbol: string, rows: unknown[]): string {
  return JSON.stringify({ code: 0, msg: "", data: { [symbol]: { qfqday: rows, qt: {} } } });
}
// 腾讯港股行情样本：第 61 个字段（0 基 60）是每手股数，其余位置填 0 占位
function txQuote(symbol: string, lot: string): string {
  const f = new Array(78).fill("0");
  f[0] = "100"; f[1] = "测试港股"; f[2] = symbol.slice(2); f[60] = lot;
  return 'v_' + symbol + '="' + f.join("~") + '";';
}
const TX_STOCK_ROWS = [
  ["2026-10-23", "17.680", "18.320", "18.320", "17.590", "927042.000"],
  ["2026-10-26", "18.210", "18.270", "18.380", "17.850", "622222.000"],
  ["2026-10-27", "18.170", "18.070", "18.280", "18.020", "454393.000"],
  ["畸形行"],
];

// 一只 A股 + 一只基准为 HS300 的基金：一条链路同时压到股票腿与指数腿
function aLegStates() {
  return [{
    user_id: "u1",
    data: {
      funds: [{ fundCode: "000001", name: "测试基金", benchmark: "HS300", marketValue: 1000, shares: 100, costBasis: 2 }],
      stocks: [{ code: "600031", name: "三一重工", shares: 100, currentPrice: 18 }],
    },
  }];
}

Deno.test("A：txSource 映射 —— A股/港股/指数特判，腾讯无源的标的返回 null", () => {
  assertEquals(typeof txSource, "function", "txSource 必须先导出");
  assertEquals(txSource("1.600031"), { symbol: "sh600031", endpoint: "fqkline" });
  assertEquals(txSource("0.000338"), { symbol: "sz000338", endpoint: "fqkline" });
  assertEquals(txSource("116.00700"), { symbol: "hk00700", endpoint: "fqkline" });
  assertEquals(txSource("1.000300"), { symbol: "sh000300", endpoint: "fqkline" }, "沪深300 走同一 sh 前缀");
  assertEquals(txSource("100.HSI"), { symbol: "hkHSI", endpoint: "fqkline" }, "恒指在腾讯是 hk 前缀，不能按 100 拼 us");
  assertEquals(txSource("124.HSTECH"), { symbol: "hkHSTECH", endpoint: "fqkline" });
  assertEquals(txSource("100.NDX"), { symbol: "usNDX", endpoint: "usfqkline" }, "美股指数必须走 usfqkline，fqkline 只回 1 根");
  assertEquals(txSource("100.SPX"), { symbol: "usINX", endpoint: "usfqkline" });
  assertEquals(txSource("100.DJIA"), { symbol: "usDJI", endpoint: "usfqkline" });
  // 腾讯无日本市场源（2026-10-28 实测 jpN225/jpNKY 均 type error）⇒ 不许瞎猜一个源，交回东财
  assertEquals(txSource("100.N225"), null);
  assertEquals(txSource("garbage"), null);
  assertEquals(txSource("1.ABCDEF"), null, "沪市段只认 6 位数字，防把指数码拼成个股");
});

Deno.test("A：parseTxKline 取 r[2] 收盘（不是 r[1] 开盘），畸形行剔除", () => {
  const p = parseTxKline(JSON.parse(txJson("sh600031", TX_STOCK_ROWS)), "sh600031");
  assertEquals(p !== null, true);
  assertEquals(p!.closes, [18.32, 18.27, 18.07], "收盘取 r[2]；取错列会整条均线腿偏 0.5%");
  assertEquals(p!.date, "2026-10-27");
  assertEquals(p!.close, 18.07);
  // 只吃过 6 列格式（[date, open, close, high, low, volume]）。列数不足的半截行宁可整行丢弃，
  // 不能顺手拿 r[2] 当收盘——格式一旦漂移，静默错位比直接判失败更坏。
  const half = parseTxKline(JSON.parse(txJson("sh600031", [
    ["2026-10-27", "18.170", "18.070", "18.280", "18.020", "454393.000"],
    ["2026-10-28", "18.000", "19.900"],
  ])), "sh600031");
  assertEquals(half!.closes, [18.07], "半截行必须丢弃：收进去会让均线偏一个开市价");
  assertEquals(half!.close, 18.07, "最新一根被丢弃后日期也要跟着退，不能留一个不存在的交易日");
  assertEquals(parseTxKline(JSON.parse(txJson("sh600031", [])), "sh600031"), null, "空数组要判失败，不能让兜底假装成功");
  assertEquals(parseTxKline({ data: {} }, "sh600031"), null, "响应里没有该 symbol → null");
  assertEquals(parseTxKline(null, "sh600031"), null);
});

// 端到端：东财 8 镜像全 "no klines"（快速失败，不退避）→ 股票腿与指数腿都必须被腾讯补上
Deno.test("A 接线：东财整段失败时股票与指数由腾讯补上，任务不再双腿全废", async () => {
  const real = globalThis.fetch;
  const txHits: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(aLegStates()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) {
      if (url.includes("sh600031")) { txHits.push("sh600031"); return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 })); }
      if (url.includes("sh000300")) { txHits.push("sh000300"); return Promise.resolve(new Response(txJson("sh000300", [["2026-10-27", "4030", "4049.55", "4060", "4020", "123"]]), { status: 200 })); }
      txHits.push("other");
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, any>;
    assertEquals(res.status, 200);
    assertEquals(body.stocks[0].ok, true, "股票腿必须被兜底救回来（现网已连续 3 晚 false）");
    assertEquals(body.stocks[0].close, 18.07, "收盘价取腾讯 r[2]，与东财 10-27 实测一致");
    assertEquals(body.indices[0].ok, true, "指数腿同样共用 fetchKline，必须一起救回");
    assertEquals(body.indices[0].close, 4049.55);
    assertEquals(body.indices[0].idx, "HS300");
    assertEquals(txHits.includes("sh600031") && txHits.includes("sh000300"), true, "两只都该问到腾讯");
    assertEquals(/NaN|Infinity/.test(JSON.stringify(body)), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("A 承诺：东财成功时绝不请求腾讯（首选源不变 ⇒ 判据口径不变）", async () => {
  const real = globalThis.fetch;
  let txCalled = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(aLegStates()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("ifzq.gtimg.cn")) { txCalled++; return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 })); }
    if (url.includes("push2his")) {
      return Promise.resolve(Response.json({ data: { name: "三一重工", klines: ["2026-10-23,18.32", "2026-10-26,18.27", "2026-10-27,18.07"] } }));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, any>;
    assertEquals(body.stocks[0].ok, true);
    assertEquals(body.stocks[0].close, 18.07);
    assertEquals(txCalled, 0, "东财给得出数据就不许改口问腾讯——静默换源等于偷偷改判据输入");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("A 边界：两个源都失败仍如实标失败，邮件照发不误判", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(aLegStates()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(Response.json({ code: 0, msg: "param error", data: [] }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, any>;
    assertEquals(res.status, 200, "取不到也不把整晚判死");
    assertEquals(body.stocks[0].ok, false, "两源皆失败要如实 false");
    assertEquals(typeof body.stocks[0].error, "string");
    assertEquals(body.indices[0].ok, false);
    assertEquals(hasStageLog(logs.lines, "取数"), true, "两条失败都要留下可归因日志");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── B: 失败原因别再只进计数（2026-10-28 加）──
// 起因（生产实测）：NDX 指数腿从 2026-09-24 起静默停更一个月，邮件里一个字没有；台账只有 index_fail=1，
// 因为 summary.indices 的 error 文本（index.ts:627）既不进邮件也不落库 ⇒ 现网在骗人，事后无从归因。
// 另：fetchKline 只保留 lastErr，8 个镜像与腾讯各自怎么死的全丢了 ⇒ 兜底段错误串无信息量。

const runOpts = { runAt: "2026-10-28T12:00:00.000Z", status: "ok" as const, force: false, msTotal: 1000 };

Deno.test("B：runRow 把所有失败原因汇成 errors（基金→股票→指数 顺序、全绿为 null、超长截断）", () => {
  const summary = {
    users: 1,
    funds: [{ code: "000001", ok: false, error: "净值接口 500" }],
    stocks: [{ code: "600031", ok: false, error: "东财8镜像失败(no klines)｜腾讯sh600031无有效K线" }],
    indices: [{ idx: "NDX", ok: false, error: "东财8镜像失败(timeout 6000ms)｜腾讯usNDX无有效K线" }],
    notifications: [],
  };
  const row = runRow(summary, [], runOpts);
  assertEquals(typeof row.errors, "string", "runRow 必须把失败原因汇总到 errors（现在只有计数）");
  assertEquals(row.errors!.includes("基金 000001：净值接口 500"), true);
  assertEquals(row.errors!.includes("股票 600031："), true);
  assertEquals(row.errors!.includes("指数 NDX："), true);
  assertEquals(row.errors!.indexOf("基金") < row.errors!.indexOf("股票"), true, "顺序按链路走：基金→股票→指数");
  assertEquals(row.errors!.indexOf("股票") < row.errors!.indexOf("指数"), true);
  // 成功项不许混进来：errors 只写失败
  const mixed = { ...summary, funds: [{ code: "000002", ok: true }] };
  assertEquals(runRow(mixed, [], runOpts).errors!.includes("000002"), false, "成功的不进 errors");
  // 全绿 → null，不留空串占位
  const green = runRow({ users: 1, funds: [{ code: "1", ok: true }], stocks: [], indices: [], notifications: [] }, [], runOpts);
  assertEquals(green.errors, null);
  // 40 条长错误必须截断，台账一行不许撑爆
  const many = {
    users: 1, funds: [], notifications: [],
    stocks: Array.from({ length: 40 }, (_, i) => ({ code: "6000" + i, ok: false, error: "x".repeat(60) })),
    indices: [],
  };
  const long = runRow(many, [], runOpts).errors!;
  assertEquals(long.length <= 1200, true, "errors 必须截断（实测上限 1200）");
});

Deno.test("B：klineFailNote 一次说清东财镜像段与腾讯兜底各自怎么死的，且不超 140 字", () => {
  assertEquals(typeof klineFailNote, "function", "klineFailNote 必须先导出");
  const both = klineFailNote({ hosts: 8, budgetHit: false, mirrorErr: "no klines", txSymbol: "usNDX", txErr: "无有效K线" });
  assertEquals(both.includes("东财8镜像"), true, "要如实报试了几个镜像，否则看不出是整段拒连还是个别超时");
  assertEquals(both.includes("no klines"), true);
  assertEquals(both.includes("腾讯usNDX"), true, "兜底问到哪个 symbol 要写出来，方便直接复现");
  assertEquals(both.length <= 140, true);
  const budget = klineFailNote({ hosts: 3, budgetHit: true, mirrorErr: "timeout 6000ms", txSymbol: null, txErr: null });
  assertEquals(budget.includes("超预算"), true, "被预算切断必须写明，不然看的人以为 8 个镜像都试完了");
  assertEquals(budget.includes("腾讯无源"), true, "txSource 返回 null 时必须说明没兜底源，不能让人以为兜底也失败了");
  const txOnly = klineFailNote({ hosts: 8, budgetHit: false, mirrorErr: "error sending request", txSymbol: "sh600031", txErr: null });
  assertEquals(txOnly.includes("error sending request"), true);
  assertEquals(txOnly.includes("腾讯") && txOnly.includes("sh600031"), true);
});

// 端到端：东财无 klines + 腾讯畸形 ⇒ 错误串必须同时带两段归因（旧实现只剩腾讯那一句）
Deno.test("B 接线：两个源都失败时，落库/返回的错误串带东财与腾讯两段归因", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(aLegStates()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("whatever", []), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async () => {} });
    const body = await res.json() as Record<string, any>;
    assertEquals(res.status, 200);
    assertEquals(body.stocks[0].ok, false);
    assertEquals(/东财8镜像/.test(body.stocks[0].error), true, "股票腿错误要写东财段：" + body.stocks[0].error);
    assertEquals(/no klines/.test(body.stocks[0].error), true, "东财的死法要留住，不能只报最后一句");
    assertEquals(/腾讯/.test(body.stocks[0].error), true, "兜底的死法也要在");
    assertEquals(/腾讯sh600031/.test(body.stocks[0].error), true, "写到 symbol，便于直接复现");
    assertEquals(/指数|HS300/.test(JSON.stringify(body.indices[0])), true);
    assertEquals(/东财8镜像/.test(body.indices[0].error), true, "指数腿共用 fetchKline，归因口径必须一致");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// 端到端：指数腿失败必须①在邮件里显性出现 ②随台账 errors 落库
Deno.test("B 接线：指数腿失败显性进邮件，并随台账 errors 真落库", async () => {
  const real = globalThis.fetch;
  const posts = capturePosts();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") { posts.record(url, init); return Promise.resolve(Response.json({}, { status: 201 })); }
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(aLegStates()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) {
      if (url.includes("sh600031")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
      return Promise.resolve(new Response(txJson("sh000300", []), { status: 200 })); // 指数兜底畸形
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async (_s: string, html: string) => { mail = html; } });
    assertEquals(res.status, 200);
    const body = await res.json() as Record<string, any>;
    assertEquals(body.stocks[0].ok, true, "股票腿照常兜底成功，这条只钉指数腿");
    assertEquals(body.indices[0].ok, false, "沪深300 两个源都失败要如实 false");
    assertEquals(mail.includes("沪深300"), true, "邮件里必须点名哪个大盘参考挂了");
    assertEquals(/大盘参考.*(获取失败|拿不到)/.test(mail), true, "要像股票腿那样显式报错，不许静默跳过：" + mail.slice(0, 400));
    assertEquals(mail.includes("未更新"), true, "要说清后果：本次档位没更新，别把上次的档位当今天的");
    const ledger = posts.out.filter((p) => p.table === "daily_update_run");
    assertEquals(ledger.length >= 2, true, "台账应有 running + ok 两行");
    const last = ledger[ledger.length - 1].rows[0];
    assertEquals(last.index_fail, 1);
    assertEquals(typeof last.errors, "string", "台账必须落错误原因，只留数字下次还是查不到");
    assertEquals(String(last.errors).includes("指数 HS300"), true);
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// 2026-10-28 取证结论：日经225 无历史源——腾讯 5 endpoint × 5 symbol 全无节点、
// 新浪 int_* 比已验证的腾讯值低 11.7%~24.2%（陈旧快照）、东财 push2his 8 镜像两个出口全断，
// 只有 push2 实时可用（拿不到 120 根）。用户裁定：停尝试、接受无大盘折扣，邮件不再报这条噪声。
function n225States() {
  return [{
    user_id: "u1",
    data: {
      funds: [
        { fundCode: "000001", name: "沪深300基金", benchmark: "HS300", marketValue: 1000, shares: 100, costBasis: 2 },
        { fundCode: "000002", name: "摩根日本精选(QDII)C", benchmark: "N225", marketValue: 1000, shares: 100, costBasis: 2 },
      ],
      stocks: [],
    },
  }];
}

Deno.test("N225：无源标的不再尝试取数，也不再进邮件与台账（停噪声）", async () => {
  const real = globalThis.fetch;
  const posts = capturePosts();
  const n225Hits: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") { posts.record(url, init); return Promise.resolve(Response.json({}, { status: 201 })); }
    if (url.includes("dingtou_state")) return Promise.resolve(Response.json(n225States()));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("push2his")) {
      if (url.includes("1.000300")) {
        return Promise.resolve(Response.json({ data: { name: "沪深300", klines: ["2026-10-27,4049.55", "2026-10-28,4083.87"] } }));
      }
      n225Hits.push(url);
      return Promise.resolve(Response.json({ data: {} }));
    }
    if (url.includes("ifzq.gtimg.cn")) {
      if (url.includes("N225")) n225Hits.push(url);
      return Promise.resolve(new Response(txJson("whatever", []), { status: 200 }));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: async (_s: string, html: string) => { mail = html; } });
    assertEquals(res.status, 200);
    const body = await res.json() as Record<string, any>;
    assertEquals(n225Hits.length, 0, "无源就不该再每晚白跑 6s 镜像预算：" + n225Hits.length + " 次");
    assertEquals(body.indices.some((i: any) => i.idx === "N225"), false, "N225 不应出现在取数结果里");
    assertEquals(body.indices.every((i: any) => i.idx !== "HS300" || i.ok === true), true, "其余指数照常取");
    assertEquals(mail.includes("日经225"), false, "邮件不再报这条固定告警");
    const ledger = posts.out.filter((p) => p.table === "daily_update_run");
    const last = ledger[ledger.length - 1].rows[0];
    assertEquals(last.index_fail, 0, "台账里不该留一个永久失败的腿");
    assertEquals(last.errors, null, "全绿时 errors 为 null");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

// ── 2026-10-28 三条需求：非定投状态/需恢复、名称右侧收益率、卖出与买入标志 ──
// 判据不动：档位与系数仍由 evalFundSignalServer 决定；这里只加"看得见"的层。

Deno.test("ddAddPct：回撤加仓阶梯与页面同表（5/10/15/20/35/50 → 5/10/20/30/40/60）", () => {
  const cases: [number, number][] = [[0, 0], [4.99, 0], [5, 5], [9.9, 5], [10, 10], [15, 20], [19.9, 20], [20, 30], [34.9, 30], [35, 40], [50, 60], [80, 60]];
  for (const [dd, add] of cases) assertEquals(ddAddPct(dd), add, "dd=" + dd);
});

Deno.test("drawdownFrom：高点缺失/非正 → null，创新高给 0", () => {
  assertEquals(drawdownFrom(0, 10), null);
  assertEquals(drawdownFrom(10, 0), null);
  assertEquals(drawdownFrom(10, 12), 0);
  assertEquals(drawdownFrom(23.8, 17.86)!.toFixed(2), "24.96");
});

Deno.test("基金侧取消估值分位（2026-10-28 用户裁决）：主信号只吃均线腿，pct 不再改档", () => {
  const base = { theme: "T", ma60: 100, ma120: 100, currentNav: 94, costBasis: 1 };
  assertEquals(baseSignalLabel(-6).label, "加强", "dev −6 单腿（+1）→ 加强");
  // 旧规则：pct 95 会抵成「正常」、pct 10 会抬成「双倍」——基金侧现在都必须无感
  for (const pct of ["", undefined, null, 0, 10, 40, 60, 80, 95, "abc"]) {
    const f = { ...base, valuationPercentile: pct };
    const r = evalFundSignalServer(f, 94, -6, null, {}, 0, 200000);
    assertEquals({ label: r.label, multiplier: r.multiplier }, { label: "加强", multiplier: 1.5 }, "pct=" + String(pct));
  }
});

Deno.test("dipLadder：回撤 ≥30% 门槛与档位表（股票侧保留高估≥80 否决；基金侧见上条不再传分位）", () => {
  const f = { high52w: 10 };
  assertEquals(dipLadder(f, 7.5, null), null, "dd 25% 未到统一门槛");
  assertEquals(dipLadder(f, 7.01, null), null, "29.9% 不亮");
  assertEquals(dipLadder(f, 7.0, null)!.dd.toFixed(1), "30.0", "30.0% 恰好亮");
  assertEquals(dipLadder(f, 7.0, null)?.add, 30);
  assertEquals(dipLadder(f, 6.51, null)?.add, 30, "34.9% → +30 档");
  assertEquals(dipLadder(f, 6.5, null)?.add, 40, "35% → +40 档");
  assertEquals(dipLadder(f, 5.0, null)?.add, 60, "50% → +60 档");
  assertEquals(dipLadder(f, 2.0, null)?.add, 60, "80% 仍是 +60（最深档不升）");
  assertEquals(dipLadder(f, 7.0, 79.9)?.add, 30, "79.9 不否决");
  assertEquals(dipLadder(f, 7.0, 80), null, "百分位≥80 高估 → 不追跌");
  assertEquals(dipLadder({}, 7.0, null), null, "没填 52 周高点就不亮");
});

Deno.test("stockAddPlan：整体持仓占比 × 档位 → 按整手（100 股）折算出加仓手数与金额", () => {
  // 持仓 500 股 × 18.07 = 9,035；+40% ⇒ 目标 3,614 元 ⇒ 正好 2 手
  const p = stockAddPlan(500 * 18.07, 18.07, 40)!;
  assertEquals(p.want.toFixed(2), "3614.00");
  assertEquals(p.lots, 2);
  assertEquals(p.amount.toFixed(2), "3614.00");
  assertEquals(p.lotSize, 100);
  // 目标额不足 1 手 ⇒ 0 手、金额 0（不许编造半手）
  const small = stockAddPlan(100 * 18.07, 18.07, 40)!;
  assertEquals(small.lots, 0);
  assertEquals(small.amount, 0);
  // 边界：目标恰好等于 1 手金额 ⇒ 1 手（浮点容差）；略低 ⇒ 0 手
  assertEquals(stockAddPlan(100 * 18.07, 18.07, 100)!.lots, 1);
  assertEquals(stockAddPlan(100 * 18.07 * 0.99, 18.07, 100)!.lots, 0);
  // 缺份额/价格/档位 ⇒ null（页面与邮件都不许编造金额）
  assertEquals(stockAddPlan(0, 18.07, 40), null);
  assertEquals(stockAddPlan(9035, 0, 40), null);
  assertEquals(stockAddPlan(9035, 18.07, 0), null);
});

Deno.test("lotFromTxQuote：腾讯港股行情第 61 个字段即每手股数，脏值不猜", () => {
  assertEquals(lotFromTxQuote(txQuote("hk00005", "400")), 400);
  assertEquals(lotFromTxQuote(txQuote("hk00939", "1000")), 1000);
  assertEquals(lotFromTxQuote(txQuote("hk00700", "0")), null, "0 手不是有效手数");
  assertEquals(lotFromTxQuote(txQuote("hk00700", "")), null);
  assertEquals(lotFromTxQuote(txQuote("hk00700", "abc")), null);
  assertEquals(lotFromTxQuote(txQuote("hk00700", "12.5")), null, "小数手数是脏数据 → 不猜");
  assertEquals(lotFromTxQuote(""), null);
  assertEquals(lotFromTxQuote("v_hk00700="), null);
  assertEquals(lotFromTxQuote('v_hk00700="100~腾讯~00700"'), null, "字段不够长（旧格式）不猜 100");
});

Deno.test("stockAddPlan：港股按标的整手股数折算（400/500/1000 股一手），手数未知不编造金额", () => {
  // 2000 股 × 10 = 20,000；+30% ⇒ 目标 6,000；每手 500 股 = 5,000 元 ⇒ 1 手（实付占持仓 25%）
  const p = stockAddPlan(20000, 10, 30, 500)!;
  assertEquals(p.want, 6000);
  assertEquals(p.lots, 1);
  assertEquals(p.amount, 5000);
  assertEquals(p.ratio, 25);
  assertEquals(p.lotSize, 500);
  assertEquals(stockAddPlan(20000, 10, 30, 1000)!.lots, 0, "每手 1000 股时 6,000 元不足一手");
  assertEquals(stockAddPlan(20000, 10, 30, 0), null, "手数未知 → 不编造金额");
  assertEquals(stockAddPlan(20000, 10, 30, -400), null);
  assertEquals(stockAddPlan(20000, 10, 30, NaN), null);
  assertEquals(stockAddPlan(20000, 10, 30)!.lotSize, 100, "不传时按 A 股 100 股一手");
});

Deno.test("sellAlert：达到止盈档且未执行才报，已执行不重复报", () => {
  const f = { profitTiers: [{ ret: 10, sell: 30 }, { ret: 20, sell: 30 }, { ret: 35, sell: 20 }, { ret: 50, sell: 20 }], profitTaken: [] };
  assertEquals(sellAlert(12, f), { ret: 12, tier: { ret: 10, sell: 30 } });
  assertEquals(sellAlert(45, f)?.tier.ret, 35, "取已触及的最高档");
  assertEquals(sellAlert(5, f), null, "没到第一档不报");
  assertEquals(sellAlert(null, f), null, "算不出收益率不报");
  assertEquals(sellAlert(12, { ...f, profitTaken: [10] }), null, "该档已执行过");
  assertEquals(sellAlert(25, { ...f, profitTaken: [10] }), { ret: 25, tier: { ret: 20, sell: 30 } }, "跳过已执行档继续往上判");
});

Deno.test("retChipHtml：赚绿亏砖红、无成本显示 --，绝不吐 NaN", () => {
  assertEquals(retChipHtml(5.34).includes("#3F8A68"), true);
  assertEquals(retChipHtml(5.34).includes("+5.3%"), true);
  assertEquals(retChipHtml(-2.04).includes("#B14A34"), true);
  assertEquals(retChipHtml(-2.04).includes("-2.0%"), true);
  const nil = retChipHtml(null);
  assertEquals(nil.includes("--"), true);
  assertEquals(/NaN|Infinity|undefined/.test(nil), false);
});

// 三条需求的接线（2026-10-28）：判据不动，只把状态/收益率/买卖标志做成看得见的层。
// 用户原话：「已按你的要求暂停定投」不是我要求你暂停，是目前此基金的非定投状态。

Deno.test("邮件接线：手动暂停的基金不再说「你要求暂停」，回撤达加仓档要打「需恢复定投」旗标", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("dingtou_state")) {
      // 成本 1.60 = 今夜净值 1.60 ⇒ 收益 0%（成本安全垫不触发）；52周高点 2.50 ⇒ 回撤 36% ≥ 20% 加仓档
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{
            fundCode: "000001", name: "测试基金", benchmark: "",
            marketValue: 160, shares: 100, costBasis: 1.6, high52w: 2.5,
            manualPause: true,
            resumeRule: { requireDays: 5, mode: "ma_and_drawdown", targetDrawdown: 10 },
          }],
          stocks: [],
        },
      }]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("已按你的要求暂停定投"), false, "这是系统状态，不是用户的要求");
    assertEquals(mail.includes("当前处于非定投状态"), true, "先把状态说对");
    assertEquals(mail.includes("暂停中"), true, "判据不动：档位标签仍如实显示暂停中");
    assertEquals(mail.includes("需恢复定投"), true, "回撤 36% 已达 +40% 加仓档 → 必须醒目提示恢复");
    assertEquals(mail.includes("36.0%"), true, "要写出回撤幅度，不能只喊恢复");
    assertEquals(mail.includes("建议买入"), false, "暂停中按 10-09 仲裁不喊买入（买入指令只由主信号发）");
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：达止盈档打「建议卖出」，基金与股票名称右侧都有按赚亏着色的收益率", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("dingtou_state")) {
      // 基金 成本 1.00 / 净值 1.60 ⇒ +60%，命中默认 60% 档（卖 30%）
      // 股票 成本 20 / 收盘 18.07 ⇒ -9.7%，只验着色不验档位
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{ fundCode: "000001", name: "测试基金", benchmark: "", marketValue: 160, shares: 100, costBasis: 1 }],
          stocks: [{ code: "600031", name: "三一重工", shares: 100, cost: 20 }],
        },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("建议卖出 30% 份额"), true, "+60% 命中 60% 档（卖 30%）要在明显位置喊出来：" + mail.slice(0, 600));
    assertEquals(/【000001】测试基金<\/b>\s*<span[^>]*#3F8A68[^>]*>\+60\.0%/.test(mail), true, "基金名右侧要跟正收益绿块");
    assertEquals(/【600031】三一重工<\/b>\s*<span[^>]*#B14A34[^>]*>-9\.[67]%/.test(mail), true, "股票名右侧要跟负收益红块");
    const fundSeg = mail.slice(mail.indexOf("【000001】"), mail.indexOf("💹 股票分析"));
    assertEquals(fundSeg.includes("已达到 +60% 止盈档"), true, "已达标就写已达标");
    assertEquals(fundSeg.includes("下一止盈档"), false, "已达 60% 档时不许再写「下一止盈档 +20%」自相矛盾");
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：非暂停的基金与股票在回撤达 +30% 加仓档时都打「建议买入」标志", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("dingtou_state")) {
      // 基金 52周高点 2.50 / 净值 1.60 ⇒ 回撤 36%（+40% 档）；股票 30 / 18.07 ⇒ 39.8%（+40% 档）
      // 股票给 500 股：整手折算后确实买得起（2 手），本条只验「达档即打买入标志」
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{ fundCode: "000001", name: "测试基金", benchmark: "", marketValue: 160, shares: 100, costBasis: 1.6, high52w: 2.5 }],
          stocks: [{ code: "600031", name: "三一重工", shares: 500, cost: 20, high52w: 30 }],
        },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals((mail.match(/建议买入/g) || []).length >= 2, true, "基金和股票各一条买入标志：" + mail.slice(0, 600));
    assertEquals(mail.includes("36.0%"), true, "基金回撤幅度要写出来");
    assertEquals(mail.includes("39.8%"), true, "股票回撤幅度要写出来");
    assertEquals(mail.includes("+40% 加仓档"), true, "档位要与页面回撤阶梯同表（dd≥35 → +40%）");
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：门槛统一 30% 后，dd 27.3% 的基金与 dd 24.7% 的股票都不喊买入", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("dingtou_state")) {
      // 基金 2.20 / 1.60 ⇒ 27.3%；股票 24 / 18.07 ⇒ 24.7%——旧股票门槛(20)会喊，统一 30% 后必须哑
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{ fundCode: "000001", name: "测试基金", benchmark: "", marketValue: 160, shares: 100, costBasis: 1.6, high52w: 2.2 }],
          stocks: [{ code: "600031", name: "三一重工", shares: 100, cost: 20, high52w: 24 }],
        },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    const fundSeg = mail.slice(mail.indexOf("【000001】"), mail.indexOf("💹 股票分析"));
    const stockSeg = mail.slice(mail.indexOf("💹 股票分析"));
    assertEquals(fundSeg.includes("建议买入"), false, "基金 dd 27.3% 未到 30%，不许喊买入");
    assertEquals(stockSeg.includes("建议买入"), false, "股票门槛也抬到 30%，dd 24.7% 不许喊买入");
    assertEquals((mail.match(/建议买入/g) || []).length, 0);
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：基金不再读估值分位——pct 95 也照常亮回撤加仓档，报告不出现估值分位", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("pingzhongdata")) return Promise.resolve(new Response(PZ_TEXT, { status: 200 }));
    if (url.includes("dingtou_state")) {
      // 52周高点 2.50 / 净值 1.60 ⇒ 回撤 36%（+40% 档）；旧规则下 pct 95 会把这条买入标否掉
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: {
          funds: [{
            fundCode: "000001", name: "测试基金", benchmark: "", marketValue: 160, shares: 100,
            costBasis: 1.6, high52w: 2.5, valuationPercentile: 95,
          }],
          stocks: [],
        },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    const fundSeg = mail.slice(mail.indexOf("【000001】"), mail.indexOf("💹 股票分析") === -1 ? mail.length : mail.indexOf("💹 股票分析"));
    assertEquals(fundSeg.includes("建议买入"), true, "基金侧不看估值分位：pct 95 无权再否掉回撤加仓档");
    assertEquals(fundSeg.includes("+40% 加仓档"), true);
    assertEquals(fundSeg.includes("估值分位"), false, "基金报告不再出现估值分位");
    assertEquals(/NaN|Infinity/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：股票达止盈档时同样写「已达到」，不与「下一止盈档」自相矛盾", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 成本 10 / 收盘 18.07 ⇒ +80.7%，命中默认 80% 档（卖 50%）
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "600031", name: "三一重工", shares: 100, cost: 10 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("建议卖出 50% 份额"), true, "+80.7% 命中 80% 档（卖 50%）");
    const seg = mail.slice(mail.indexOf("【600031】"));
    assertEquals(seg.includes("已达到 +80% 止盈档"), true);
    assertEquals(seg.includes("下一止盈档"), false, "已达 80% 档时不许再写「下一止盈档 +20%」");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：股票回撤加仓档折算成整手——写出手数、股数与按手金额，并标占持仓比例", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 500 股 × 18.07 = 9,035；高点 30 ⇒ 回撤 39.8%（+40% 档）⇒ 目标 3,614 元，正合 2 手
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "600031", name: "三一重工", shares: 500, cost: 30, high52w: 30 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("建议买入 2 手（200 股）≈ ¥3,614（占持仓 40.0%）"), true, "整手金额要写出来：" + mail.slice(mail.indexOf("【600031】"), mail.indexOf("【600031】") + 400));
    assertEquals(/NaN|Infinity|undefined/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：目标加仓额不足一手时如实说「不足 1 手」，不许四舍五入成 0 股或虚构金额", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 100 股 × 18.07 = 1,807；+40% ⇒ 目标 722.8 元 < 一手 1,807 元
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "600031", name: "三一重工", shares: 100, cost: 30, high52w: 30 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    const seg = mail.slice(mail.indexOf("【600031】"));
    assertEquals(seg.includes("目标加仓 ¥723，不足 1 手（每手 100 股）"), true, "不足一手要如实说：" + seg.slice(0, 400));
    assertEquals(seg.includes("0 手"), false, "不许写「买 0 手」这种空指令");
    assertEquals(/NaN|Infinity|undefined/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：港股按腾讯行情里的每手股数折算——00005 每手 400 股，2000 股报 2 手", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      // 2000 股 × 18.07 = 36,140；高点 30 ⇒ 回撤 39.8%（+40 档）⇒ 目标 14,456；每手 400 股 = 7,228 元 ⇒ 2 手
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "00005", name: "汇丰控股", shares: 2000, cost: 30, high52w: 30 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("qt.gtimg.cn")) return Promise.resolve(new Response(txQuote("hk00005", "400"), { status: 200 }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("hk00005", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("建议买入 2 手（800 股）≈ ¥14,456（占持仓 40.0%）"), true,
      "港股手数要按标的读（400 股/手）：" + mail.slice(mail.indexOf("【00005】"), mail.indexOf("【00005】") + 400));
    assertEquals(/NaN|Infinity|undefined/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：腾讯手数取不到时回落状态里存的 lotSize（页面同步来的），不瞎猜 100", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "00005", name: "汇丰控股", shares: 2000, cost: 30, high52w: 30, lotSize: 400 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("qt.gtimg.cn")) return Promise.resolve(new Response("bad gateway", { status: 502 }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("hk00005", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(mail.includes("建议买入 2 手（800 股）≈ ¥14,456（占持仓 40.0%）"), true,
      "回落链：腾讯 → 状态里的 lotSize → 无金额；本用例应命中状态值 400");
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：港股手数全网都取不到时只给「建议买入」，不按 100 股编金额", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "00005", name: "汇丰控股", shares: 2000, cost: 30, high52w: 30 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("qt.gtimg.cn")) return Promise.resolve(new Response("", { status: 500 }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("hk00005", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    const seg = mail.slice(mail.indexOf("【00005】"));
    assertEquals(seg.includes("建议买入"), true);
    assertEquals(seg.includes("手（"), false, "手数未知时不许出现手数");
    assertEquals(/¥\d/.test(seg), false, "手数未知时不许给金额");
    assertEquals(/NaN|Infinity|undefined/.test(mail), false);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});

Deno.test("邮件接线：A股每手固定 100 股，不去腾讯多打一次行情请求", async () => {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(Response.json({}, { status: 201 }));
    if (url.includes("dingtou_state")) {
      return Promise.resolve(Response.json([{
        user_id: "u1",
        data: { funds: [], stocks: [{ code: "600031", name: "三一重工", shares: 500, cost: 30, high52w: 30 }] },
      }]));
    }
    if (url.includes("push2his")) return Promise.resolve(Response.json({ data: {} }));
    if (url.includes("ifzq.gtimg.cn")) return Promise.resolve(new Response(txJson("sh600031", TX_STOCK_ROWS), { status: 200 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  let mail = "";
  const logs = captureErrorLogs();
  try {
    const res = await handle(req({ force: true }), { sendMail: (_s: string, html: string) => { mail = html; return Promise.resolve(); } });
    assertEquals(res.status, 200);
    assertEquals(urls.some(u => u.includes("qt.gtimg.cn")), false, "A股手数固定 100，无需额外请求");
    assertEquals(mail.includes("建议买入 2 手（200 股）≈ ¥3,614（占持仓 40.0%）"), true);
  } finally {
    globalThis.fetch = real;
    logs.restore();
  }
});
