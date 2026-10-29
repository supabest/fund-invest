// cloudflare/functions/sb/[[path]].ts — Supabase 同源反代（Cloudflare Pages Functions）
//
// 为什么要有它：国内运营商常把浏览器 → *.supabase.co 断流/黑洞，登录会永远卡在「正在登录…」，
// 评分/价值/板块/基本面面板整片空白；而 Pages 自己的域是通的。于是浏览器只认本域 /sb/*，
// 由这里转发到固定上游——前端只改一个基址常量（index.html 的 supabaseBaseUrl）。
//
// 窄口原则：上游写死、只放行 Supabase 的 API 前缀、拒绝穿越与控制字符；它绝不能变成任意主机的
// 中转站。响应侧还要剥掉压缩/定长/逐跳头：body 已被运行时解压，头再透传浏览器会解不开。

export const SUPABASE_ORIGIN = 'https://sfauluwxmdginezbluvo.supabase.co';
export const PROXY_PREFIX = '/sb';

// 只代理 Supabase 的公开 API 面；新增前缀前先想清楚它会不会变成通用代理
const ALLOWED_PREFIXES = ['/auth/v1/', '/rest/v1/', '/functions/v1/', '/storage/v1/', '/realtime/v1/', '/graphql/v1/'];

// host/长度/逐跳头由运行时决定；accept-encoding 必须丢——否则上游可能回压缩体，而我们要解压后再发
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'accept-encoding',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade',
]);

const PATH_CHARS = /^[A-Za-z0-9\-._~/%!$&'()*+,;=:@]+$/;

/** 取「去掉前缀后的 API 路径」，非法（空/越权/穿越/控制字符）返回 null。 */
function apiPathOf(pathname: string): string | null {
  const p = String(pathname || '');
  if (!p.startsWith(PROXY_PREFIX)) return null;
  const rest = p.slice(PROXY_PREFIX.length);
  if (!rest || !rest.startsWith('/')) return null;
  let decoded = '';
  try { decoded = decodeURIComponent(rest); } catch { return null; }
  // 控制字符：挡住 %0d%0a 这类头/路径注入（逐个码点判，避免正则里放控制字符）
  for (const ch of decoded) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return null;
  }
  // 穿越：/rest/../../etc、编码后的 %2e%2e 都要拒
  if (/(^|\/)\.\.(\/|$)/.test(decoded)) return null;
  if (!PATH_CHARS.test(rest)) return null;
  if (!ALLOWED_PREFIXES.some((a) => (decoded + '/').startsWith(a))) return null;
  return rest;
}

export function buildUpstreamUrl(pathname: string, search = '', origin = SUPABASE_ORIGIN): string | null {
  const rest = apiPathOf(pathname);
  if (!rest) return null;
  return String(origin).replace(/\/+$/, '') + rest + String(search || '');
}

export function upstreamRequestHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((v, k) => { if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) out.set(k, v); });
  return out;
}

export function downstreamResponseHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((v, k) => { if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v); });
  return out;
}

function jsonBody(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleProxy(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  origin = SUPABASE_ORIGIN,
): Promise<Response> {
  const u = new URL(request.url);
  const target = buildUpstreamUrl(u.pathname, u.search, origin);
  if (!target) return jsonBody({ error: 'not_found' }, 404);

  const method = String(request.method || 'GET').toUpperCase();
  const init: RequestInit = { method, headers: upstreamRequestHeaders(request.headers), redirect: 'follow' };
  if (method !== 'GET' && method !== 'HEAD') init.body = await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch (e) {
    // 只留归因，不回吐内部地址；浏览器拿到的永远是这条通用错误
    console.error('supabase proxy failed:', (e as Error)?.message || String(e));
    return jsonBody({ error: 'proxy_unavailable' }, 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: downstreamResponseHeaders(upstream.headers),
  });
}

// Pages 路由入口（非 _ 前缀目录 ⇒ /sb/* 全部落到这里）
export const onRequest = (ctx: { request: Request }): Promise<Response> => handleProxy(ctx.request);
