// index_test.ts — 覆盖 daily-update 抽出 handle + DISABLE_SERVE 守卫后的三条失败路径可归因日志与恢复结构
// 参照 supabase/functions/sector-trend/index_test.ts 模式：先设 DISABLE_SERVE 再动态 import（避免 import 即绑端口）；
// 失败注入靠 globalThis.fetch 桩（取数/写库）+ handle 的第二参 deps.sendMail 注入位（发信）。
// 每条用例都验证：① 响应仍为约定结构（成功=summary，失败={ok:false,error}）；② console.error 出现带 [daily-update][环节] 标签的可归因失败行。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
Deno.env.set("DAILY_UPDATE_TOKEN", "test-token");
Deno.env.set("SUPABASE_URL", "https://fake.supabase.co");
Deno.env.set("SB_SERVICE_KEY", "svc-placeholder");
const { handle, holdingsSummaryHtml } = await import("./index.ts");

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
