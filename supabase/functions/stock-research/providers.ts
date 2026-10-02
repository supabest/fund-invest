/// <reference lib="deno.ns" />
// providers —— 两家服务商适配器（spec §3）：端点/鉴权/联网参数/响应解析差异全部在此消化，
// 对外只暴露 callResearch。失败纪律（用户 2026-10-02 修订：失败须显示原因）：报「服务商名+可读原因」，
// 绝不换服务商、绝不换渠道、绝不静默降级为无搜索；错误信息经 sanitizeError 抹 key 后才返回。
import { sanitizeError, classifyProviderError } from "./research_core.ts";

export type ProviderSlug = 'zhipu' | 'bailian';

export const PROVIDERS: Record<ProviderSlug, { endpoint: string; defaultModel: string; label: string }> = {
  zhipu:   { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",   defaultModel: "glm-5.3-flash",  label: "智谱" },
  bailian: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", defaultModel: "qwen3.8-flash", label: "阿里百炼" },
};

// 联网参数：智谱平台 web_search 工具形态以官方文档为据，Task 7 联调 curl 实测敲定；
// 若实测不符，只改本函数内 body 构造（callResearch 对外形态不变）——spec §10 风险行 1。
function buildBody(p: ProviderSlug, model: string, prompt: string): Record<string, unknown> {
  const messages = [{ role: "user", content: prompt }];
  if (p === 'zhipu') return { model, messages, tools: [{ type: "web_search" }] };
  return { model, messages, enable_search: true, search_options: { search_strategy: "max" } };
}

export async function callResearch(
  p: ProviderSlug, model: string, apiKey: string, prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const spec = PROVIDERS[p];
  let resp: Response;
  try {
    resp = await fetchImpl(spec.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(p, model, prompt)),
    });
  } catch (e) {
    throw new Error(sanitizeError(`${spec.label}：网络不可达（无法连接服务商）`, apiKey));
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    // 原因分类先对响应体脱敏（抹 key）再判定；外层再套一道 sanitizeError 作双保险。
    const reason = classifyProviderError(resp.status, sanitizeError(text, apiKey));
    throw new Error(sanitizeError(`${spec.label}：${reason}（HTTP ${resp.status}）`, apiKey));
  }
  let j: { choices?: { message?: { content?: string } }[] };
  try { j = JSON.parse(text); } catch {
    throw new Error(sanitizeError(`${spec.label}：响应格式异常（非 JSON）`, apiKey));
  }
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(sanitizeError(`${spec.label}：响应缺少内容（模型未正常返回）`, apiKey));
  }
  return content;
}
