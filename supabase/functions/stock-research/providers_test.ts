import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { PROVIDERS, callResearch } from "./providers.ts";

const KEY = "sk-test-key-DO-NOT-LEAK-9f8e7d";
// 假 fetch：记录请求、按脚本返回
function fakeFetch(status: number, body: unknown, recorder: { url?: string; init?: RequestInit }) {
  // deno-lint-ignore require-await -- 假 fetch：同步构造 Response，无 await 但须保持 async 函数形态
  return (async (url: string | URL, init?: RequestInit) => {
    recorder.url = String(url); recorder.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}
const okBody = (text: string) => ({ choices: [{ message: { content: text } }] });

Deno.test("PROVIDERS: 两家端点/默认模型与 spec §3 一致", () => {
  assertEquals(PROVIDERS.zhipu.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assertEquals(PROVIDERS.zhipu.defaultModel, "glm-5.3-flash");
  assertEquals(PROVIDERS.bailian.endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assertEquals(PROVIDERS.bailian.defaultModel, "qwen3.8-flash");
});

Deno.test("zhipu: 请求形态——Bearer key 头 + web_search 工具 + model 覆盖", async () => {
  const rec: Record<string, unknown> = {};
  const f = fakeFetch(200, okBody("答案"), rec as { url: string; init: RequestInit });
  const out = await callResearch('zhipu', 'glm-5.3-flash', KEY, "PROMPT", f);
  assertEquals(out, "答案");
  const h = (rec.init as RequestInit).headers as Record<string, string>;
  assertEquals(h.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(String((rec.init as RequestInit).body));
  assertEquals(body.model, "glm-5.3-flash");
  assertEquals(JSON.stringify(body).includes("web_search"), true); // 联网参数在位
  assertEquals(body.messages.at(-1).content, "PROMPT");
});

Deno.test("bailian: enable_search + search_strategy=max", async () => {
  const rec: Record<string, unknown> = {};
  const f = fakeFetch(200, okBody("R"), rec as { url: string; init: RequestInit });
  await callResearch('bailian', 'qwen3.8-flash', KEY, "P", f);
  const body = JSON.parse(String((rec.init as RequestInit).body));
  assertEquals(body.enable_search, true);
  assertEquals(body.search_options.search_strategy, "max");
});

Deno.test("HTTP 非 2xx → reject，错误信息不含 key（脉敏纪律）、带状态码与可读原因", async () => {
  const f = fakeFetch(401, { error: { message: `bad key ${KEY}` } }, {} as never);
  // as Error：catch 回调把 Promise<string> 并成 string|Error，显式收窄才能访问 message
  const err = (await callResearch('zhipu', 'm', KEY, "P", f).catch((e: Error) => e)) as Error;
  assertEquals(err instanceof Error, true);
  assertEquals(err.message.includes(KEY), false);
  assertEquals(err.message.includes('401'), true); // 状态码回显
  assertEquals(err.message.includes('API Key'), true); // 401 → 鉴权失败原因
  assertEquals(err.message.includes('智谱'), true); // 服务商名
});

// 钉死边界：key 落在 180-199 区间时，若先 slice 后 sanitize，残片可逃出全串替换。
Deno.test("HTTP 非 2xx + key 跨 slice 边界 → 先脱敏后截断，无 ≥6 字符 key 残片逃逸", async () => {
  const body = "x".repeat(190) + KEY; // KEY 恰好跨界：旧写法 slice(0,200) 会截走前 10 字符成为残片
  const f = fakeFetch(401, body, {} as never);
  const err = (await callResearch('zhipu', 'm', KEY, "P", f).catch((e: Error) => e)) as Error;
  const out = err.message;
  assertEquals(out.includes(KEY), false);
  assertEquals(out.includes(KEY.slice(0, 12)), false); // 头部探针
  for (let i = 0; i + 6 <= KEY.length; i++) {
    assertEquals(out.includes(KEY.slice(i, i + 6)), false, `key 残片逃逸：窗口 ${i} 「${KEY.slice(i, i + 6)}」出现在输出中`);
  }
});

Deno.test("真·非 JSON 响应（status 200）→ reject 「响应格式异常」", async () => {
  const f = fakeFetch(200, "{not json", {} as never);
  const err = (await callResearch('bailian', 'm', KEY, "P", f).catch((e: Error) => e)) as Error;
  assertEquals(err.message.includes('响应格式异常'), true);
});

Deno.test("200 + content 为空白字符串 → reject（不交空白报告）", async () => {
  const f = fakeFetch(200, { choices: [{ message: { content: "  " } }] }, {} as never);
  await assertRejects(() => callResearch('zhipu', 'm', KEY, "P", f), Error, '响应缺少内容');
});

Deno.test("响应缺 choices/content → reject 带服务商名", async () => {
  const f = fakeFetch(200, { foo: 1 }, {} as never);
  await assertRejects(() => callResearch('bailian', 'm', KEY, "P", f), Error, '响应缺少内容');
});

Deno.test("网络异常（fetch throw）→ 「网络不可达」，不回显 URL 细节", async () => {
  // deno-lint-ignore require-await -- 模拟网络层 throw，函数体无 await 但须为 async 形态
  const f = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  const err = (await callResearch('zhipu', 'm', KEY, "P", f).catch((e: Error) => e)) as Error;
  assertEquals(err.message.includes('网络不可达'), true);
  assertEquals(err.message.includes(KEY), false);
});
