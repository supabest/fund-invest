// scripts/supabase_proxy_test.ts — Pages 同源反代门禁（2026-10-29 立）
//
// 背景：国内运营商常把浏览器 → *.supabase.co 断掉/黑洞（登录卡死、评分/价值/板块面板全空），
// 而 fund-invest888.pages.dev 这条路是通的。于是浏览器只认自己的域：/sb/* 由 Pages Function
// 转发到 Supabase（cloudflare/functions/sb/[[path]].ts），代码里只改一个基址常量。
//
// 这个反代是「固定上游 + 固定前缀白名单」的窄口：它绝不能变成任意主机的中转站，
// 也不能让路径穿越把请求带出 supabase 域，更不能把上游的压缩/定长头原样透传给浏览器。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildUpstreamUrl, downstreamResponseHeaders, handleProxy, SUPABASE_ORIGIN, upstreamRequestHeaders,
} from "../cloudflare/functions/sb/[[path]].ts";

const REF = "https://sfauluwxmdginezbluvo.supabase.co";

Deno.test("反代 URL 映射：/sb/* 剥前缀拼到固定上游，查询串原样保留", () => {
  assertEquals(SUPABASE_ORIGIN, REF, "上游必须写死为项目自己的 Supabase");
  assertEquals(buildUpstreamUrl("/sb/rest/v1/stock_score", "?select=*&limit=1"),
    REF + "/rest/v1/stock_score?select=*&limit=1");
  assertEquals(buildUpstreamUrl("/sb/auth/v1/token", ""), REF + "/auth/v1/token");
  assertEquals(buildUpstreamUrl("/sb/functions/v1/daily-update", ""), REF + "/functions/v1/daily-update");
  assertEquals(buildUpstreamUrl("/sb/storage/v1/object/x", ""), REF + "/storage/v1/object/x");
  assertEquals(buildUpstreamUrl("/sb/auth/v1"), REF + "/auth/v1", "无尾斜杠的白名单根也放行");
});

Deno.test("反代 URL 映射：空路径/未知前缀/穿越/伪装主机一律 null（不是开放中继）", () => {
  assertEquals(buildUpstreamUrl("/sb", ""), null);
  assertEquals(buildUpstreamUrl("/sb/", ""), null);
  assertEquals(buildUpstreamUrl("/rest/v1/stock_score", ""), null, "不在 /sb 下不代理");
  assertEquals(buildUpstreamUrl("/sb/admin/secret", ""), null, "白名单外的前缀不放行");
  assertEquals(buildUpstreamUrl("/sb//evil.example.com/rest", ""), null, "双斜杠不能把主机带走");
  assertEquals(buildUpstreamUrl("/sb/rest/../../etc/passwd", ""), null, "路径穿越必须拒");
  assertEquals(buildUpstreamUrl("/sb/rest/v1/%2e%2e/x", ""), null, "编码后的穿越同样拒");
  assertEquals(buildUpstreamUrl("/sb/rest/v1/x%0d%0aInjected", ""), null, "控制字符（CRLF 头注入）必须拒");
  assertEquals(buildUpstreamUrl("/sb/rest/v1/%", ""), null, "非法百分号编码不猜，直接拒");
});

Deno.test("请求头清洗：保留鉴权三件套，丢掉 Host/CF/长度等由运行时决定或会泄内部信息的头", () => {
  const src = new Headers({
    "apikey": "sb_publishable_x",
    "authorization": "Bearer token-abc",
    "content-type": "application/json",
    "prefer": "resolution=merge-duplicates",
    "accept-encoding": "gzip, br",
    "host": "fund-invest888.pages.dev",
    "content-length": "42",
    "cf-ray": "abc123",
    "x-forwarded-for": "1.2.3.4",
  });
  const out = upstreamRequestHeaders(src);
  assertEquals(out.get("apikey"), "sb_publishable_x");
  assertEquals(out.get("authorization"), "Bearer token-abc");
  assertEquals(out.get("content-type"), "application/json");
  assertEquals(out.get("prefer"), "resolution=merge-duplicates");
  assertEquals(out.get("host"), null);
  assertEquals(out.get("content-length"), null, "长度由 fetch 重算");
  assertEquals(out.get("accept-encoding"), null, "不向上游要压缩，免得头与体对不上");
  assertEquals(out.get("cf-ray"), null);
  assertEquals(out.get("x-forwarded-for"), null);
});

Deno.test("响应头清洗：删掉压缩/定长/逐跳头，保留 content-type", () => {
  const src = new Headers({
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
    "content-length": "1234",
    "transfer-encoding": "chunked",
    "connection": "keep-alive",
  });
  const out = downstreamResponseHeaders(src);
  assertEquals(out.get("content-type"), "application/json; charset=utf-8");
  assertEquals(out.get("content-encoding"), null);
  assertEquals(out.get("content-length"), null);
  assertEquals(out.get("transfer-encoding"), null);
  assertEquals(out.get("connection"), null);
});

Deno.test("handleProxy：方法/请求体/头原样送达上游，状态与响应体原样回来", async () => {
  const seen: { url?: string; method?: string; body?: string; auth?: string | null } = {};
  const stub = ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.method = init?.method;
    seen.auth = new Headers(init?.headers).get("authorization");
    const body = init?.body;
    if (body instanceof ArrayBuffer) seen.body = new TextDecoder().decode(body);
    return Promise.resolve(new Response('{"ok":true}', {
      status: 201, headers: { "content-type": "application/json", "content-encoding": "gzip" },
    }));
  }) as typeof fetch;

  const req = new Request("https://fund-invest888.pages.dev/sb/rest/v1/dingtou_state?on_conflict=user_id", {
    method: "POST",
    headers: { "apikey": "sb_publishable_x", "authorization": "Bearer t", "content-type": "application/json" },
    body: '{"user_id":"u1"}',
  });
  const res = await handleProxy(req, stub);
  assertEquals(seen.url, REF + "/rest/v1/dingtou_state?on_conflict=user_id");
  assertEquals(seen.method, "POST");
  assertEquals(seen.auth, "Bearer t");
  assertEquals(seen.body, '{"user_id":"u1"}', "写请求的 body 必须完整转发（云同步靠它）");
  assertEquals(res.status, 201);
  assertEquals(await res.text(), '{"ok":true}');
  assertEquals(res.headers.get("content-encoding"), null, "上游的压缩头不能透传（body 已解压）");
});

Deno.test("handleProxy：拦下非法路径 404、上游抛错 502（都给可读 JSON，不把内部地址吐给浏览器）", async () => {
  const req = (p: string) => new Request("https://fund-invest888.pages.dev" + p);
  const notCalled = (() => { throw new Error("不该发请求"); }) as typeof fetch;

  const bad = await handleProxy(req("/sb/admin/secret"), notCalled);
  assertEquals(bad.status, 404);

  const empty = await handleProxy(req("/sb"), notCalled);
  assertEquals(empty.status, 404);

  const boom = (() => Promise.reject(new Error("upstream down"))) as typeof fetch;
  const failed = await handleProxy(req("/sb/rest/v1/stock_score"), boom);
  assertEquals(failed.status, 502);
  const body = await failed.text();
  assertEquals(body.includes("upstream down"), false, "错误正文不得透传上游异常细节");
  assertEquals(body.includes("sfauluwxmdginezbluvo"), false, "错误正文不得暴露上游地址");
});
