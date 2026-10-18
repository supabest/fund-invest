// scripts/check_secrets_test.ts — 凭据门禁自测（2026-10-18 立）
// 注意：本文件不写任何真实凭据字面量（用 repeat 拼接构造），所以它自己不需要 secret-scan 白名单。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scanText, mask, SKIP_FILES } from "./check_secrets.ts";

const HEX64 = "a1b2c3d4".repeat(8);          // 64 位十六进制（非真实 token）
const JWT = "eyJ" + "QWxnc0dvb2xk".repeat(4); // eyJ 开头的 JWT 形态
const BEARER = "Bearer " + "Zx9".repeat(8);   // 20+ 位实值

Deno.test("规则①：64 位十六进制串命中，且预览脱敏（不回显完整秘密）", () => {
  const hits = scanText(`TOKEN="${HEX64}"`);
  assertEquals(hits.length, 1);
  assertEquals(hits[0].line, 1);
  assert(hits[0].preview.includes("len 64"), "预览必须带长度但不含完整值");
  assert(!hits[0].preview.includes(HEX64), "预览不得包含完整秘密");
});

Deno.test("规则②：Bearer 实值命中；占位符三形态（<NAME> / $VAR / ${VAR}）一律放行", () => {
  assertEquals(scanText(BEARER).length, 1);
  assertEquals(scanText("Authorization: Bearer <DAILY_UPDATE_TOKEN>"), []);
  assertEquals(scanText("Authorization: Bearer $DAILY_UPDATE_TOKEN"), []);
  assertEquals(scanText('headers: { Authorization: "Bearer ${TOKEN}" }'), []);
});

Deno.test("规则③：JWT 形态命中（同时会命中 Bearer 规则——同一行两条命中是预期行为）", () => {
  const hits = scanText(`-H "Authorization: Bearer ${JWT}"`);
  assert(hits.some(h => h.rule === "JWT"), "JWT 规则必须命中");
  assert(hits.every(h => !h.preview.includes(JWT)), "任何命中的预览都不得包含完整秘密");
});

Deno.test("规则④：apiKey 实值命中，apiKey=${GS_API_KEY} / apiKey=REDACTED 放行", () => {
  assertEquals(scanText("?apiKey=" + "Ab3".repeat(8)).length, 1);
  assertEquals(scanText("?softName=goldsun_skills&apiKey=${GS_API_KEY}"), []);
  assertEquals(scanText("replace(/\\S*apiKey=\\S*/g, 'apiKey=REDACTED')"), []);
});

Deno.test("规则⑤：sb_secret_/service_role 明文命中；sb_publishable_ 放行（设计上可公开）", () => {
  assertEquals(scanText("KEY=sb_secret_" + "Xy7".repeat(6)).length, 1);
  assertEquals(scanText("const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_" + "ogx_OZOqR0tEgr24Dt1DSg_VZasrzuM" + "';"), []);
});

Deno.test("行级白名单：`secret-scan: allow` 抑制该行（必须写明原因）", () => {
  assertEquals(scanText(`const FAKE = "${HEX64}"; // secret-scan: allow — 自测用假样本`), []);
  // 白名单只作用于所在行，不牵连下一行
  assertEquals(scanText(`// secret-scan: allow — 本行是注释\nconst REAL = "${HEX64}";`).length, 1);
});

Deno.test("多行：行号逐行独立报，命中数与行号都要准", () => {
  const text = ["第一行干净", `Bearer ${"Qw8".repeat(8)}`, "第三行干净", "JWT=" + JWT].join("\n");
  const hits = scanText(text);
  assertEquals(hits.map(h => h.line), [2, 4]);
});

Deno.test("掩码与跳过清单：mask 不泄露、deno.lock 在跳过名单里", () => {
  assertEquals(mask("short"), "sh…(len 5)");
  assert(SKIP_FILES.has("deno.lock"), "deno.lock 的 integrity 哈希必须跳过（否则门禁永远红）");
});
