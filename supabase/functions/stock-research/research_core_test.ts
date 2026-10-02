import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { CODE_RE, VERDICTS, buildPrompt, dedupeAction, parseReport, sanitizeError } from "./research_core.ts";

// ---- 提示词组装（spec §7：五类信号/六段/禁止词表/来源纪律/财务锚点缺失注明） ----
Deno.test("buildPrompt: 五类信号与六段结构在提示词中逐条在位", () => {
  const p = buildPrompt("600338", "潍柴动力", { scoreRow: null, mixRow: null });
  for (const k of ["需求端", "供给端", "价格", "扩产", "管理层措辞"]) {
    assertEquals(p.includes(k), true, `缺信号类别 ${k}`);
  }
  assertEquals(p.includes("六段"), true);
  assertEquals(p.includes("供不应求"), true); // 禁止词表必须原文出现（作为禁止示例）
  assertEquals(p.includes("结论必附来源"), true);
  assertEquals(p.includes("信息不足"), true);  // 允许模型自报信息不足（spec §10 风险行）
});
Deno.test("buildPrompt: 锚点用 stock_score 真实列，评分行带诚实标签，主营结构取 extras.mix", () => {
  const p = buildPrompt("600338", "潍柴动力", {
    scoreRow: {
      roe: 9.1, pe: 14.2, quality: 63.5, growth: 41.2, final: 55.0, ths_l1: "机械",
      extras: { mix: { segments: [{ name: "动力总成", ratio: 0.62 }] } },
    },
    mixRow: null,
  });
  // ① 评分行诚实标签必须原文在位
  assertEquals(p.includes("本库量化评分(0-100 百分位，非财务增长率，不得据此判景气方向)"), true);
  // ② roe/pe 真实数值出现
  assertEquals(p.includes("9.1"), true);
  assertEquals(p.includes("14.2"), true);
  // ③ 主营结构取自 extras.mix.segments
  assertEquals(p.includes("动力总成"), true);
  // ④ 生产表不存在的列名不得出现
  assertEquals(p.includes("revenue_yoy"), false);
});
Deno.test("buildPrompt: 锚点缺失必须注明「无」而非省略（spec §7）", () => {
  const p = buildPrompt("00700", "腾讯控股", { scoreRow: null, mixRow: null });
  assertEquals(p.includes("无本库财务锚点"), true);
});

// ---- 六段 JSON 解析 ----
const GOOD = JSON.stringify({
  verdict: "降温", summary: "重卡行业需求走弱",
  report: [
    { title: "需求", body: "…依据：财报电话会 2026-08" },
    { title: "供给", body: "…" }, { title: "价格与盈利", body: "…" },
    { title: "竞争格局与扩产", body: "…" }, { title: "管理层与市场信号", body: "…" },
    { title: "结论与温度", body: "降温，证据一…证据二…" },
  ],
  sources: [{ title: "业绩说明会纪要", url: "https://example.com/a", date: "2026-08-29" }],
});
Deno.test("parseReport: 正常六段 JSON 解析通过", () => {
  const r = parseReport(GOOD);
  assertEquals(r !== null, true);
  assertEquals(r!.verdict, "降温");
  assertEquals(r!.report.length, 6);
  assertEquals(r!.sources[0].url, "https://example.com/a");
});
Deno.test("parseReport: ```json 围栏包裹可剥", () => {
  assertEquals(parseReport("```json\n" + GOOD + "\n```") !== null, true);
});
Deno.test("parseReport: 残缺/非法拒绝，多余字段容忍", () => {
  assertEquals(parseReport("这不是JSON") === null, true);                 // 非 JSON
  assertEquals(parseReport(JSON.stringify({ ...JSON.parse(GOOD), report: [] })) === null, true); // 段数不足
  assertEquals(parseReport(GOOD.replace('"降温"', '"看涨"')) === null, true);  // verdict 枚举外拒绝
  assertEquals(parseReport(GOOD.replace('"重卡行业需求走弱"', '""')) === null, true); // summary 空拒绝
  const extra = JSON.parse(GOOD); (extra as Record<string, unknown>).foo = 1;
  assertEquals(parseReport(JSON.stringify(extra)) !== null, true);          // 多余字段容忍
});
Deno.test("parseReport: sources 过滤非 https/非法 URL 并去重；summary 缺失拒绝", () => {
  const mixed = JSON.stringify({
    ...JSON.parse(GOOD),
    sources: [
      { title: "ok1", url: "https://example.com/a", date: "2026-08-29" },
      { title: "ftp", url: "ftp://example.com/b", date: "2026-08-29" },        // 协议白名单外
      { title: "noturl", url: "研报见附件", date: "2026-08-29" },               // 非 URL
      { title: "dup", url: "https://example.com/a", date: "2026-08-30" },       // 重复 https
      { title: "ok2", url: "http://example.com/c", date: "2026-08-31" },       // http 也允许
    ],
  });
  const r = parseReport(mixed);
  assertEquals(r !== null, true);
  assertEquals(r!.sources.length, 2); // 合法 https/http 去重后：a（重复 a 被剔除）+ c
  assertEquals(r!.sources.map((s) => s.url).join(","), "https://example.com/a,http://example.com/c");
  const noSummary = JSON.parse(GOOD) as Record<string, unknown>;
  delete noSummary.summary;
  assertEquals(parseReport(JSON.stringify(noSummary)), null);                  // summary 缺失拒绝
});

// ---- 防重矩阵（spec §5 双保险） ----
const NOW = Date.UTC(2026, 9, 2, 8, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
Deno.test("dedupeAction: running<10min 复用；>=10min 视为陈旧可重跑（done/failed 同理窗口）", () => {
  assertEquals(dedupeAction({ status: "running", started_at: iso(9 * 60_000), finished_at: null }, NOW), "reuse_running");
  assertEquals(dedupeAction({ status: "running", started_at: iso(11 * 60_000), finished_at: null }, NOW), "run");
  assertEquals(dedupeAction({ status: "done", started_at: iso(70 * 60_000), finished_at: iso(59 * 60_000) }, NOW), "reuse_done");
  assertEquals(dedupeAction({ status: "done", started_at: iso(130 * 60_000), finished_at: iso(61 * 60_000) }, NOW), "run");
  assertEquals(dedupeAction({ status: "failed", started_at: iso(60_000), finished_at: iso(30_000) }, NOW), "run");
  assertEquals(dedupeAction(null, NOW), "run");
});

// ---- 密钥脱敏（spec §4：错误信息不得含 key） ----
Deno.test("sanitizeError: 任何位置抹除 api_key，长度上限截断", () => {
  const KEY = "sk-secret-abc123def456";
  const raw = `provider 401 Unauthorized: header Bearer ${KEY} rejected, body {"error":{"message":"invalid api key ${KEY}"}}`;
  const out = sanitizeError(raw, KEY);
  assertEquals(out.includes(KEY), false);
  assertEquals(out.includes("***"), true);
  assertEquals(out.length <= 500, true);
});
Deno.test("sanitizeError: >500 字符输入触发截断分支，总长仍 ≤500 且 key 不残留", () => {
  const KEY = "sk-secret-abc123def456";
  const raw = "x".repeat(600) + ` overflow tail: ${KEY} end`;
  const out = sanitizeError(raw, KEY);
  assertEquals(out.length <= 500, true, `截断后长度 ${out.length} 违反 ≤500 契约`);
  assertEquals(out.length, 500);
  assertEquals(out.includes(KEY), false);
  assertEquals(out.endsWith("…"), true); // 省略号语义保留
});
Deno.test("CODE_RE: A股6位/港股5位", () => {
  assertEquals(CODE_RE.test("600338"), true);
  assertEquals(CODE_RE.test("00700"), true);
  assertEquals(CODE_RE.test("6003"), false);
  assertEquals(CODE_RE.test("6003380"), false);
  assertEquals(CODE_RE.test("60033A"), false);
});
Deno.test("VERDICTS 恰四枚举", () => {
  assertEquals([...VERDICTS].sort().join(","), ["升温", "恶化", "平稳", "降温"].sort().join(","));
});
