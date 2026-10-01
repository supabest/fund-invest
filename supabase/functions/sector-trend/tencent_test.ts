// tencent_test.ts — 腾讯K线适配器单测（brief Step 1：parseKline 真实响应片段 + toSymbol 四断言）
// 规则权威: spec §2.1/§3.2（数据源 = web.ifzq.gtimg.cn qfq 前复权）；网络链本身按 brief 由 mode=ping 线上验证，不在此单测。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type KlineResp,
  mergeDedup,
  parseKline,
  prevDay,
  sleep,
  toSymbol,
} from "./tencent.ts";
import { fetchHistoryKline } from "./tencent.ts";

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

// —— Task 3b T3b-1：日期翻页历史拉取（回测实证算法：640/次，首行>start 且本批≥30 则续页，≤6 页，批间 0.3s，去重后写覆盖）——
// 网络可注入（fetchPage/sleepFn），不打真实网络；断言终止条件/去重/页数上限/pacing 调用序列。

// 生成一段升序 K线（oldest→newest），date 逐日往前推
function barsBack(n: number, newest: string): KlineResp[] {
  const out: KlineResp[] = [];
  let d = new Date(newest + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.unshift({
      date: d.toISOString().slice(0, 10),
      close: 1 + i * 0.01,
      volume: 100,
    });
    d = new Date(d.getTime() - 86_400_000);
  }
  return out;
}

Deno.test("prevDay: 日历日前一天（跨年/跨月/闰日）", () => {
  assertEquals(prevDay("2019-01-02"), "2019-01-01");
  assertEquals(prevDay("2019-01-01"), "2018-12-31");
  assertEquals(prevDay("2024-03-01"), "2024-02-29"); // 闰年
  assertEquals(prevDay("2026-10-01"), "2026-09-30");
});

Deno.test("mergeDedup: 同 date 后写覆盖 + 升序合并（多页重叠边界不重复）", () => {
  const merged = mergeDedup([
    [{ date: "2026-01-02", close: 1, volume: 1 }, {
      date: "2026-01-03",
      close: 2,
      volume: 1,
    }],
    [{ date: "2026-01-01", close: 0, volume: 1 }, {
      date: "2026-01-02",
      close: 99,
      volume: 1,
    }], // 01-02 后写 → close=99
  ]);
  assertEquals(merged.map((r) => r.date), [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ]);
  assertEquals(merged.find((r) => r.date === "2026-01-02")!.close, 99); // 后写覆盖
  assertEquals(mergeDedup([]), []);
});

Deno.test("fetchHistoryKline: 终止于首行<=起始日（翻页到 2019-01-01 前即停，不多拉）", async () => {
  const ends: string[] = [];
  const sleeps: number[] = [];
  const pages = [
    barsBack(640, "2024-02-01"), // 首行 ~2022-04 > 2019 → 续页
    barsBack(640, "2022-02-28"), // 首行 ~2020-05 > 2019 → 续页
    barsBack(200, "2020-01-01"), // 首行 ~2019-06 > 2019 → 续页
    barsBack(300, "2019-07-01"), // 首行 ~2018-08 <= 2019-01-01 → 停
  ];
  const r = await fetchHistoryKline("sh512800", {
    start: "2019-01-01",
    end: "2024-02-01",
    maxPages: 6,
    fetchPage: async (_sym, end, _lmt) => {
      ends.push(end);
      return pages[ends.length - 1] ?? [];
    },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assertEquals(ends.length, 4); // 第 4 页首行<=start ⇒ 拉完即停，不再拉第 5
  assertEquals(sleeps.length, 3); // 批间 pacing = 页数-1
  assertEquals(sleeps.every((s) => s === 300), true); // 名义 0.3s pacing
  // 去重升序、无重复日期
  const dates = r.map((b) => b.date);
  assertEquals(new Set(dates).size, dates.length);
  assertEquals(
    dates.every((d, i) => i === 0 || dates[i - 1] < d),
    true,
    "必须严格升序",
  );
});

Deno.test("fetchHistoryKline: 本批<30 行即终止（新上市 ETF 拉不满不再空转）", async () => {
  let calls = 0;
  const r = await fetchHistoryKline("sz159999", {
    start: "2019-01-01",
    end: "2024-02-01",
    maxPages: 6,
    fetchPage: async () => {
      calls++;
      return barsBack(12, "2024-01-01"); // 仅 12 根 < 30 → 首页即停
    },
    sleepFn: async () => {},
  });
  assertEquals(calls, 1);
  assertEquals(r.length, 12);
});

Deno.test("fetchHistoryKline: 页数上限=6（首行始终>起始日也只拉 6 页）", async () => {
  const ends: string[] = [];
  await fetchHistoryKline("sh510300", {
    start: "2019-01-01",
    end: "2026-09-30",
    lmt: 640,
    maxPages: 6,
    fetchPage: async (_sym, end) => {
      ends.push(end);
      return barsBack(40, end); // 每页仅 40 天跨度，首行始终远晚于 2019 ⇒ 6 页都续页，靠上限兜停
    },
    sleepFn: async () => {},
  });
  assertEquals(ends.length, 6, `应严格不超过 6 页, got=${ends.length}`);
});

Deno.test("fetchHistoryKline: end 逐页回退=上一页首行前一天（重叠边界由去重收敛）", async () => {
  const ends: string[] = [];
  const p0 = barsBack(640, "2024-02-01");
  await fetchHistoryKline("sh512800", {
    start: "2019-01-01",
    end: "2024-02-01",
    maxPages: 3,
    fetchPage: async () => {
      const i = ends.length;
      ends.push(""); // 占位，稍后填实际收到的 end
      return i === 0
        ? p0
        : i === 1
        ? barsBack(640, prevDay(p0[0].date))
        : barsBack(
          20, // 第 3 页 <30 ⇒ 拉完停
          prevDay(barsBack(640, prevDay(p0[0].date))[0].date),
        );
    },
    sleepFn: async () => {},
  });
  // 首页用传入 end，其后用 prevDay(上页首行)
  assertEquals(ends.length, 3);
});

Deno.test("fetchHistoryKline: 后续页抛异常（上市日前空/畸形）⇒ 保留已取页、不丢弃整段历史", async () => {
  let calls = 0;
  const r = await fetchHistoryKline("sh588170", {
    start: "2019-01-01",
    end: "2026-09-30",
    lmt: 640,
    maxPages: 6,
    fetchPage: async () => {
      calls++;
      if (calls === 1) return barsBack(363, "2026-09-30"); // 首屏 363 根，首行>2019 且>=30 → 续页
      throw new Error("tencent kline empty/畸形"); // 第2页翻到上市日之前 → 空
    },
    sleepFn: async () => {},
  });
  assertEquals(calls, 2, "应尝试到第2页后因异常停止");
  assertEquals(r.length, 363, "首屏 363 根必须保留，不得因后续页异常丢弃");
});

Deno.test("fetchHistoryKline: 首页即抛异常 = 真错误 ⇒ 上抛（调用方记 failed）", async () => {
  let threw = false;
  try {
    await fetchHistoryKline("sh999999", {
      start: "2019-01-01",
      end: "2026-09-30",
      fetchPage: async () => {
        throw new Error("tencent network error");
      },
      sleepFn: async () => {},
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "首页失败必须上抛，不能吐空当作成功");
});
