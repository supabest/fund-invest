// tencent_test.ts — 腾讯K线适配器单测（brief Step 1：parseKline 真实响应片段 + toSymbol 四断言）
// 规则权威: spec §2.1/§3.2（数据源 = web.ifzq.gtimg.cn qfq 前复权）；网络链本身按 brief 由 mode=ping 线上验证，不在此单测。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type KlineResp, parseKline, sleep, toSymbol } from "./tencent.ts";

// fixture 路径锚定到本测试文件目录 → CWD 无关（与 stock-score/index_test.ts 同模式，无网络）
const fx = (n: string) =>
  JSON.parse(
    Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)),
  );

Deno.test("parseKline: 真实 qfqday 片段 → date/close=r[2]/volume=r[5]，顺序原样", () => {
  const rows: KlineResp[] = parseKline(
    fx("tencent_kline_sample.json"),
    "sh512800",
  );
  assertEquals(rows.length, 5);
  assertEquals(rows[0], { date: "2026-09-23", close: 0.833, volume: 7869560 });
  assertEquals(rows[4], { date: "2026-09-30", close: 0.853, volume: 8553513 });
  // r[1]=open / r[3]=high / r[4]=low 不得混入 close
  assertEquals(rows[4].close !== 0.839, true);
  assertEquals(
    rows.every((r) => Number.isFinite(r.close) && Number.isFinite(r.volume)),
    true,
  );
});

Deno.test("parseKline: qfqday 缺失时回落 day（真实片段改造的 day-only 形态）", () => {
  const rows = parseKline(fx("tencent_kline_day_only.json"), "sh512800");
  assertEquals(rows.length, 5);
  assertEquals(rows[4].date, "2026-09-30");
  assertEquals(rows[4].close, 0.853);
});

Deno.test("parseKline: 畸形输入一律 [] —— 非对象/无 data/未知 symbol/空数组/短行/非数值", () => {
  assertEquals(parseKline(null, "sh512800"), []);
  assertEquals(parseKline("oops", "sh512800"), []);
  assertEquals(parseKline({}, "sh512800"), []);
  assertEquals(parseKline({ code: 0, data: {} }, "sh512800"), []);
  assertEquals(parseKline({ code: 0, data: { sh512800: [] } }, "sh512800"), []);
  assertEquals(
    parseKline({ code: 0, data: { sz159770: { qfqday: [] } } }, "sh512800"),
    [],
  ); // symbol 不匹配
  assertEquals(
    parseKline({
      code: 0,
      data: { sh512800: { qfqday: [["2026-09-30", "1"]] } },
    }, "sh512800"),
    [],
  ); // 短行
  assertEquals(
    parseKline({
      code: 0,
      data: {
        sh512800: { qfqday: [["2026-09-30", "1", "-", "3", "1", "10"]] },
      },
    }, "sh512800"),
    [],
  ); // close 非数值
});

Deno.test("toSymbol: market 优先，缺失回退首位 in 56→sh（brief 四断言）", () => {
  assertEquals(toSymbol("512800", null), "sh512800");
  assertEquals(toSymbol("159770", null), "sz159770");
  assertEquals(toSymbol("159770", "1"), "sh159770"); // market 覆盖回退（brief 逐字口径）
  assertEquals(toSymbol("512800", "0"), "sz512800");
  assertEquals(toSymbol("562500", null), "sh562500");
  assertEquals(toSymbol("0xxxxx", null), "sz0xxxxx"); // 首位非 5/6 → sz
});

Deno.test("sleep: 至少等待到点（pacing 用，容差给 15ms）", async () => {
  const t0 = Date.now();
  await sleep(60);
  assertEquals(Date.now() - t0 >= 45, true);
});
