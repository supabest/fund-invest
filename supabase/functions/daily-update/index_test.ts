// index_test.ts — 覆盖 daily-update 抽出 handle + DISABLE_SERVE 守卫后的三条失败路径可归因日志与恢复结构
// 参照 supabase/functions/sector-trend/index_test.ts 模式：先设 DISABLE_SERVE 再动态 import（避免 import 即绑端口）；
// 失败注入靠 globalThis.fetch 桩（取数/写库）+ handle 的第二参 deps.sendMail 注入位（发信）。
// 每条用例都验证：① 响应仍为约定结构（成功=summary，失败={ok:false,error}）；② console.error 出现带 [daily-update][环节] 标签的可归因失败行。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
Deno.env.set("DAILY_UPDATE_TOKEN", "test-token");
Deno.env.set("SUPABASE_URL", "https://fake.supabase.co");
Deno.env.set("SB_SERVICE_KEY", "svc-placeholder");
const { handle, holdingsSummaryHtml, fundDipAlert, dipBannerHtml, runRow } = await import("./index.ts");

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

Deno.test("dipBannerHtml：空列表返回空串；暂停那条不得出现「建议加仓」", () => {
  assertEquals(dipBannerHtml([]), "");
  const html = dipBannerHtml([
    { code: "000001", name: "测试基金A", ret: -23.4, target: -20, shout: true },
    { code: "000002", name: "测试基金B", ret: -20.5, target: -20, shout: false },
  ]);
  assertEquals(html.includes("抄底提示"), true);
  assertEquals(html.includes("【000001】测试基金A 收益 -23.4% 已跌破 -20% 安全垫"), true);
  assertEquals(html.includes("建议加仓/多投"), true);
  assertEquals(html.includes("主信号暂停中，暂不新增（仅状态提示）"), true);
  // 暂停那条自己不能带买入指令：把第二行单独截出来验
  const lineB = html.slice(html.indexOf("【000002】"));
  assertEquals(lineB.includes("建议加仓"), false, "暂停的基金不许被第一条的「建议加仓」文案沾到");
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
