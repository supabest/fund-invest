import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
Deno.env.set('STOCK_RESEARCH_DISABLE_SERVE', '1');
Deno.env.set('SUPABASE_URL', 'http://localhost:1');
Deno.env.set('SB_SERVICE_KEY', 'svc-placeholder');
const mod = await import("./index.ts");
const handle = (mod as { handle: (req: Request) => Promise<Response> }).handle;

Deno.test("index.ts 可 import（DISABLE_SERVE 守卫生效、无顶层副作用）", () => {
  assertEquals(typeof mod === 'object', true);
});

// —— 编排层单测（终审 I-3：钉死 handle 的鉴权/防重/失败脱敏，替代被推迟的 Task 7 部分取证）——
function mkJwt(role: string): string {
  const h = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const p = btoa(JSON.stringify({ role, sub: 'test-user' }));
  return `${h}.${p}.sig`;
}
const AUTH = "Bearer " + mkJwt('authenticated');
const ANON = "Bearer " + mkJwt('anon');

function post(body: unknown, auth: string): Promise<Response> {
  return handle(new Request("http://edge/stock-research", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  }));
}
const jsonResp = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// 假 fetch：按 URL 分流；记录所有 (url, bodyText)。返回可控。
function withStub(
  routes: { fundRead?: unknown[]; provider?: { status: number; body: string } },
  cb: (calls: { url: string; body: string }[]) => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: { method?: string; body?: string }) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url);
    const bodyText = init && typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body: bodyText });
    if (url.includes('bigmodel') || url.includes('dashscope')) {
      const p = routes.provider ?? { status: 200, body: '{}' };
      return new Response(p.body, { status: p.status, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes('stock_score')) return jsonResp([]);            // 无锚点
    if (url.includes('on_conflict')) return new Response(null, { status: 201 }); // writeRow ok
    if (url.includes('stock_fundamental')) return jsonResp(routes.fundRead ?? []); // readRow
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return cb(calls).finally(() => { globalThis.fetch = orig; });
}

Deno.test("I-1 鉴权：anon token 直接 401，且不触达任何 DB/provider", () => {
  return withStub({}, async (calls) => {
    const r = await post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: 'sk-abcdefgh' }, ANON);
    assertEquals(r.status, 401);
    const j = await r.json();
    assertEquals(j.ok, false);
    assertEquals(String(j.error).includes('登录'), true);
    assertEquals(calls.length, 0); // 拦截在任何外部调用之前
  });
});

Deno.test("I-1 鉴权：无 Authorization 也 401", () => {
  return withStub({}, async (calls) => {
    const r = await post({ action: 'status', code: '600338' }, '');
    assertEquals(r.status, 401);
    assertEquals(calls.length, 0);
  });
});

Deno.test("I-1 model 白名单：非法字符 model 400，不发 provider 调用", () => {
  return withStub({}, async (calls) => {
    const r = await post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: 'sk-abcdefgh', model: '<script>alert(1)</script>' }, AUTH);
    assertEquals(r.status, 400);
    assertEquals((await r.json()).error, 'model 名称非法');
    assertEquals(calls.length, 0);
  });
});

Deno.test("防重：1h 内已 done → cached reuse_done，绝不二调 provider", () => {
  const finished = new Date(Date.now() - 30 * 60_000).toISOString(); // 30min 前
  const doneRow = { code: '600338', status: 'done', verdict: '降温', finished_at: finished, started_at: finished };
  return withStub({ fundRead: [doneRow] }, async (calls) => {
    const r = await post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: 'sk-abcdefgh' }, AUTH);
    assertEquals(r.status, 200);
    const j = await r.json();
    assertEquals(j.ok, true);
    assertEquals(j.cached, 'reuse_done');
    assertEquals(calls.some(c => c.url.includes('bigmodel') || c.url.includes('dashscope')), false); // 未联网、未产生新费用
  });
});

Deno.test("I-2/密钥红线：provider 401（回显 key）→ 502 failed，error 列与响应均不含 key", () => {
  const KEY = 'sk-secret-XYZKEY-9f8e7d';
  return withStub(
    { fundRead: [], provider: { status: 401, body: `{"error":{"message":"Invalid API key: ${KEY}"}}` } },
    async (calls) => {
      const r = await post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: KEY }, AUTH);
      assertEquals(r.status, 502);
      const j = await r.json();
      assertEquals(j.ok, false);
      assertEquals(String(j.error).includes('API Key'), true); // 401 → 可读原因（失败须显示原因）
      assertEquals(String(j.error).includes('401'), true);      // 状态码回显
      assertEquals(String(j.error).includes(KEY), false);          // 响应不回显 key
      const failedWrite = calls.find(c => c.url.includes('on_conflict') && c.body.includes('"failed"'));
      assertEquals(failedWrite ? failedWrite.body.includes(KEY) : true, false); // 落库 error 列不含 key
      assertEquals(failedWrite ? failedWrite.body.includes('sk-secret') : true, false);
    },
  );
});

Deno.test("I-2 裸 500 防护：readRow 失败（REST 500）→ 结构化 502 且**不向库写任何行**（复审 Important-1：不得抹掉共享表已有报告）", () => {
  const orig = globalThis.fetch;
  let conflictWrites = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url);
    if (url.includes('stock_fundamental') && !url.includes('on_conflict')) {
      return new Response("boom", { status: 500 }); // readRow 抛错
    }
    if (url.includes('on_conflict')) { conflictWrites++; return new Response(null, { status: 201 }); }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: 'sk-abcdefgh' }, AUTH)
    .then(async (r) => {
      assertEquals(r.status, 502);
      const j = await r.json();
      assertEquals(j.ok, false);
      assertEquals(String(j.error).includes('数据获取失败'), true);
      assertEquals(conflictWrites, 0); // 读失败在任何 upsert 之前返回 → 已有 done 报告不被 null 覆盖
    })
    .finally(() => { globalThis.fetch = orig; });
});

Deno.test("复审 Important-1：running 写失败 → 502 且不再补写 failed（旧行原样保留）", () => {
  const orig = globalThis.fetch;
  let conflictWrites = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url);
    if (url.includes('stock_fundamental') && !url.includes('on_conflict')) return jsonResp([]); // 无 existing → act=run
    if (url.includes('on_conflict')) { conflictWrites++; return new Response("write boom", { status: 500 }); } // running 写失败
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return post({ action: 'generate', code: '600338', provider: 'zhipu', api_key: 'sk-abcdefgh' }, AUTH)
    .then(async (r) => {
      assertEquals(r.status, 502);
      assertEquals(conflictWrites, 1); // 仅尝试一次 running 写；catch 已返、不会二次 stamp failed
    })
    .finally(() => { globalThis.fetch = orig; });
});

Deno.test("复审 Minor-A：非对象请求体（null）→ 400 bad json而非抛 500", () => {
  return withStub({}, async (calls) => {
    const r = await handle(new Request("http://edge/stock-research", {
      method: "POST", headers: { "content-type": "application/json", Authorization: AUTH }, body: "null",
    }));
    assertEquals(r.status, 400);
    assertEquals((await r.json()).error, 'bad json');
    assertEquals(calls.length, 0);
  });
});
