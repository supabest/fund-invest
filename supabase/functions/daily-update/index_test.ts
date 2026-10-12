// index_test.ts — 覆盖 daily-update 抽出 handle + DISABLE_SERVE 守卫后的三条失败路径可归因日志与恢复结构
// 参照 supabase/functions/sector-trend/index_test.ts 模式：先设 DISABLE_SERVE 再动态 import（避免 import 即绑端口）；
// 失败注入靠 globalThis.fetch 桩（取数/写库）+ handle 的第二参 deps.sendMail 注入位（发信）。
// 每条用例都验证：① 响应仍为约定结构（成功=summary，失败={ok:false,error}）；② console.error 出现带 [daily-update][环节] 标签的可归因失败行。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
Deno.env.set("DAILY_UPDATE_TOKEN", "test-token");
Deno.env.set("SUPABASE_URL", "https://fake.supabase.co");
Deno.env.set("SB_SERVICE_KEY", "svc-placeholder");
const { handle } = await import("./index.ts");

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
