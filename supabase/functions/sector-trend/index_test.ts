// index_test.ts — 覆盖 index.ts 抽出的纯编排位 + 非交易日守卫的编排顺序（终审 I-1）+ bars_n 落库载荷（终审 I-2）
// 覆盖：theme 字典映射 / 未命中字典键 / SectorRow→DB 行 snake_case 整形（含 bars_n）/ C3 accumulating 分流与榜单排序纪律 /
//       stale 行整形 / warnings 聚合 / Q 复活判定 / assembleInputs（宇宙×截面×K线×prevMp）/
//       tradingDayGuard 判据 + handle() 端到端（fetch 桩 + GS spy）证明「守卫在 ②K线后、③GS 前」。
// 先关 serve 守卫再动态 import，避免 import 即绑端口（与 stock-score/index_test.ts 同模式）。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Bar, EtfSnap, SectorRow } from "./engine.ts";
import type { EtfSnapRow, SegSnapshot } from "./gs_etf.ts";
import type { MapRow } from "./index.ts";

Deno.env.set("SECTOR_TREND_DISABLE_SERVE", "1");
const {
  themeOf,
  unmatchedThemeKeys,
  toDbRow,
  splitByBarsN,
  rankLists,
  shapeStaleRow,
  aggregateWarnings,
  isQResurrected,
  assembleInputs,
  klineOneQuery,
  shouldFlush,
  tradingDayGuard,
  handle,
  BARS_FULL,
} = await import("./index.ts");

function row(over: Partial<SectorRow> = {}): SectorRow {
  return {
    ind: "银行",
    pkEtf: "512800",
    nEtf: 8,
    theme: null,
    close: 0.853,
    ma20: 0.84,
    ma60: 0.83,
    ma120: 0.82,
    m20: 0.01,
    m60: 0.05,
    pos52: 60,
    dev60: 0.02,
    vr: 1.1,
    mp: 70,
    dm20: null,
    state: "强多头",
    labels: ["过热警示"],
    barsN: 640,
    score: 55.5,
    v: 60,
    m: 50,
    l: 40,
    q: null,
    ...over,
  };
}

// ---------- theme 字典（brief Step 3 逐字 + R1 改名补偿键） ----------
Deno.test("themeOf: brief 字典逐字（电力/绿电、新能源车族、全球资源族、机器人）", () => {
  assertEquals(themeOf("电力"), "电力/绿电");
  assertEquals(themeOf("绿色电力"), "电力/绿电");
  assertEquals(themeOf("机器人"), "机器人");
  assertEquals(themeOf("新能源车"), "新能源车");
  assertEquals(themeOf("电池"), "新能源车");
  assertEquals(themeOf("充电桩"), "新能源车");
  for (
    const ind of [
      "资源",
      "稀土",
      "煤炭",
      "石油",
      "油气",
      "粮食",
      "大宗商品",
      "黄金",
    ]
  ) {
    assertEquals(themeOf(ind), "全球资源", ind);
  }
  assertEquals(themeOf("有色"), "全球资源"); // Task1b R1: 有色金属→有色 改名补偿（报告偏离 3）
  assertEquals(themeOf("银行"), null);
  assertEquals(themeOf(""), null);
});

Deno.test("unmatchedThemeKeys: 字典中在库里没有对应行业的键（只报，不落库）", () => {
  // 宇宙仅 银行/有色/电力 → 除 电力、有色（R1 补偿键）外全部字典键未命中，按字典序原样报
  assertEquals(unmatchedThemeKeys(["银行", "有色", "电力"]), [
    "绿色电力",
    "机器人",
    "新能源车",
    "电池",
    "充电桩",
    "资源",
    "有色金属",
    "稀土",
    "煤炭",
    "石油",
    "油气",
    "粮食",
    "大宗商品",
    "黄金",
  ]);
  // 字典全部键都在宇宙 → 空
  assertEquals(
    unmatchedThemeKeys([
      "电力",
      "绿色电力",
      "机器人",
      "新能源车",
      "电池",
      "充电桩",
      "资源",
      "有色金属",
      "有色",
      "稀土",
      "煤炭",
      "石油",
      "油气",
      "粮食",
      "大宗商品",
      "黄金",
    ]),
    [],
  );
});

// ---------- SectorRow → DB 行（T3↔T4 交接面：列名必须贴 DDL snake_case） ----------
// 终审 I-2：sector_rotation_daily 补 bars_n 列 ⇒ barsN 必须落库（免歧义区分「样本不足的 0 兜底」与「真实平盘 0」）
Deno.test("toDbRow: 24 引擎字段 → 25 列 DDL 形状；barsN → bars_n 原样落库（不 r4 取整、不丢）", () => {
  const r = toDbRow(row({ theme: "机器人", barsN: 133 }), "2026-10-01", false);
  assertEquals(r, {
    batch_date: "2026-10-01",
    ind: "银行",
    pk_etf: "512800",
    n_etf: 8,
    close: 0.853,
    ma20: 0.84,
    ma60: 0.83,
    ma120: 0.82,
    m20: 0.01,
    m60: 0.05,
    pos52: 60,
    dev60: 0.02,
    vr: 1.1,
    mp: 70,
    dm20: null,
    state: "强多头",
    labels: ["过热警示"],
    score: 55.5,
    v: 60,
    m: 50,
    l: 40,
    q: null,
    theme: "机器人",
    stale: false,
    bars_n: 133,
  });
  assertEquals(r.bars_n, 133);
  assertEquals("barsN" in r, false); // 落库一律 snake_case
  assertEquals(toDbRow(row({ barsN: 0 }), "2026-10-01", false).bars_n, 0); // 0 根也要如实落，不得兜成 null
});

// ---------- C3：barsN<250 不得当真实涨跌参与排序 ----------
Deno.test("splitByBarsN: 250 门槛（含边界 250 归 tradable）", () => {
  const { tradable, accumulating } = splitByBarsN([
    row({ ind: "a", barsN: BARS_FULL }),
    row({ ind: "b", barsN: 12 }),
  ]);
  assertEquals(tradable.map((r) => r.ind), ["a"]);
  assertEquals(accumulating.map((r) => r.ind), ["b"]);
});

Deno.test("rankLists: 向上/调整榜仅在 barsN≥250 子集内排（m60 兜底 0 不当真值），纠缠计数与 accumulating 单列", () => {
  const rows = [
    row({ ind: "多头强", state: "强多头", m60: 0.30, barsN: 640 }),
    row({ ind: "多头弱", state: "多头", m60: 0.10, barsN: 400 }),
    row({ ind: "调整深", state: "空头排列", m60: -0.20, barsN: 640 }),
    row({ ind: "调整浅", state: "走弱", m60: -0.05, barsN: 640 }),
    row({ ind: "纠缠", state: "纠缠", m60: 0.07, barsN: 640 }),
    // 历史不足组：m60=0 是 engine 兜底值，绝不允许挤进榜单
    row({
      ind: "积累中-多头",
      state: "强多头",
      m60: 9.9,
      barsN: 30,
      labels: [],
    }),
    row({
      ind: "积累中-调整",
      state: "走弱",
      m60: -9.9,
      barsN: 30,
      labels: [],
    }),
  ];
  const { up, down, entangled, accumulating } = rankLists(rows);
  assertEquals(up.map((r) => r.ind), ["多头强", "多头弱"]); // m60 降序
  assertEquals(down.map((r) => r.ind), ["调整深", "调整浅"]); // m60 升序
  assertEquals(entangled, 1);
  assertEquals(accumulating, 2);
});

// ---------- C5 stale 行整形 ----------
Deno.test("shapeStaleRow: 换 batch_date + stale=true，其余（含 labels）原样，绝不重算", () => {
  const prev = toDbRow(
    row({ ind: "半导体", state: "走弱", labels: [], m60: -0.1, pos52: null }),
    "2026-09-30",
    false,
  );
  const s = shapeStaleRow(prev, "2026-10-01");
  assertEquals(s.batch_date, "2026-10-01");
  assertEquals(s.stale, true);
  assertEquals(s.ind, "半导体");
  assertEquals(s.state, "走弱");
  assertEquals(s.labels, []);
  assertEquals(s.m60, -0.1);
  assertEquals(s.pos52, null);
  assertEquals(s.bars_n, 640); // stale copy 整行搬，bars_n 原样沿用昨日（不重算）
  assertEquals(Object.keys(s).length, 25);
});

Deno.test("shapeStaleRow: 不改传入对象（纯函数）", () => {
  const prev = toDbRow(row(), "2026-09-30", false);
  shapeStaleRow(prev, "2026-10-01");
  assertEquals(prev.batch_date, "2026-09-30");
  assertEquals(prev.stale, false);
});

// ---------- warnings 聚合（C1/C2：一切降级只记警告） ----------
Deno.test("aggregateWarnings: 展平 + 去重 + 保序 + 上限，溢出记一条", () => {
  assertEquals(aggregateWarnings([["a", "b"], undefined, ["b", "c"]]), [
    "a",
    "b",
    "c",
  ]);
  assertEquals(aggregateWarnings([]), []);
  const many = aggregateWarnings([
    Array.from({ length: 60 }, (_, i) => `w${i}`),
  ], 50);
  assertEquals(many.length, 51);
  assertEquals(many[50], "…另有 10 条警告未展开");
});

// ---------- S4：Q 腿复活探测（false→true 才报） ----------
Deno.test("isQResurrected: 昨日 q 全 null 且今日 qAlive=true → true", () => {
  assertEquals(isQResurrected([], true), true); // 首跑无昨日行：qAlive 即视为复活（保守报警）
  assertEquals(isQResurrected([{ q: null }, { q: null }], true), true);
  assertEquals(isQResurrected([{ q: 80 }], true), false);
  assertEquals(isQResurrected([{ q: null }], false), false);
});

// ---------- assembleInputs：宇宙(C1) × 截面 × K线 × prevMp ----------
const mapRow = (
  etf_code: string,
  canonical_ind: string,
  is_rep: boolean,
  amt: number | null = 10,
): MapRow => ({
  etf_code,
  etf_name: `name-${etf_code}`,
  canonical_ind,
  amt,
  is_rep,
});
const snap = (code: string, over: Partial<EtfSnapRow> = {}): EtfSnapRow => ({
  code,
  name: `name-${code}`,
  amt: 20,
  tem: 3,
  r60: 1.5,
  sharpe: 60,
  hay: null,
  ...over,
});
const barsOf = (n: number, base = 1): Bar[] =>
  Array.from(
    { length: n },
    (_, i) => ({ date: `d${i}`, close: base + i * 0.01, volume: 100 }),
  );

Deno.test("assembleInputs: 每行业=rep 起点；etfs=行业全 ETF ∩ GS 截面；prevMp 缺→null", () => {
  const mapRows = [
    mapRow("512800", "银行", true, 99),
    mapRow("512880", "银行", false, 500),
    mapRow("562500", "机器人", true, 164),
  ];
  const snapMap = new Map<string, EtfSnapRow>([
    ["512800", snap("512800", { amt: 99.4 })],
    ["512880", snap("512880", { hay: "77" })],
    // 机器人 562500 不在截面里 → noSnap
  ]);
  const barsByCode = new Map<string, Bar[]>([["512800", barsOf(300)], [
    "562500",
    barsOf(30),
  ]]);
  const { inputs, noSnap } = assembleInputs(
    mapRows,
    snapMap,
    barsByCode,
    new Map([["银行", 42]]),
  );
  assertEquals(inputs.length, 2);
  assertEquals(noSnap, ["机器人"]); // C5：截面整体缺该行业 → 编排层走 stale，不静默丢
  const bank = inputs.find((i) => i.ind === "银行")!;
  assertEquals(bank.pkEtf, "512800");
  assertEquals(bank.nEtf, 2);
  assertEquals(bank.prevMp, 42);
  assertEquals(bank.theme, null);
  assertEquals(bank.bars.length, 300);
  assertEquals((bank.etfs as EtfSnap[]).map((e) => e.code).sort(), [
    "512800",
    "512880",
  ]);
  assertEquals(bank.etfs[0].amt, 99.4); // 用截面 amt（当日最新），不用 map 里的旧值
});

Deno.test("assembleInputs: 行业无任何 K线 → 仍出行（barsN=0，engine 侧 accumulating），不丢行业", () => {
  const mapRows = [{
    etf_code: "159996",
    etf_name: "家电ETF",
    canonical_ind: "家电",
    amt: 6.4,
    is_rep: true,
  }];
  const { inputs, noSnap } = assembleInputs(
    mapRows,
    new Map([["159996", snap("159996")]]),
    new Map(),
    new Map(),
  );
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0].bars, []);
  assertEquals(noSnap, []);
});

Deno.test("assembleInputs: 截面 amt 缺失(NA) 的 ETF 不入池（不可加权），行业仍可出（其余 ETF 在）", () => {
  const mapRows = [
    {
      etf_code: "512800",
      etf_name: "银行ETF",
      canonical_ind: "银行",
      amt: 99,
      is_rep: true,
    },
    {
      etf_code: "512880",
      etf_name: "证券ETF",
      canonical_ind: "银行",
      amt: 10,
      is_rep: false,
    },
  ];
  const snapMap = new Map<string, EtfSnapRow>([
    ["512800", snap("512800")],
    ["512880", snap("512880", { amt: null })],
  ]);
  const { inputs } = assembleInputs(
    mapRows,
    snapMap,
    new Map([["512800", barsOf(250)]]),
    new Map(),
  );
  assertEquals(inputs[0].nEtf, 1);
  assertEquals(inputs[0].etfs.map((e) => e.code), ["512800"]);
});

// ---------- PostgREST 尾读查询串（线上首次冒烟跑出 PGRST100：in(...) 不是合法操作符形式） ----------
Deno.test("klineOneQuery: 单 ETF 尾读（order desc + limit 钉住，绝不依赖 PostgREST 默认行上限）", () => {
  // 线上冒烟实测：一次 in.() 取 20 只×302 行被 1000 行上限静默截断（limit=6 的探针 kline_added=1826，limit=3 为 0）
  assertEquals(
    klineOneQuery("512800", "2025-07-18", 300),
    "sector_kline?select=trade_date,close,volume&etf_code=eq.512800&trade_date=gte.2025-07-18&order=trade_date.desc&limit=300",
  );
});

Deno.test("klineOneQuery: 非 [A-Za-z0-9._-] 的 code → null（防过滤器注入）", () => {
  assertEquals(klineOneQuery("1'or'1=1", "2025-07-18", 300), null);
  assertEquals(klineOneQuery("a b", "2025-07-18", 300), null);
  assertEquals(klineOneQuery("", "2025-07-18", 300), null);
});

// （旧 klineTailQuery 批量 in.() 形式已删除：单请求行上限不可靠，改走单 ETF 查询）

// ---------- K线落库分批冲刷（防 Edge wall-clock 截断时丢整轮已拉取的 bar） ----------
Deno.test("shouldFlush: 每 N 只冲刷一次 + 最后一只必冲刷（1-based 索引）", () => {
  assertEquals(shouldFlush(20, 110, 20), true); // 整批
  assertEquals(shouldFlush(21, 110, 20), false);
  assertEquals(shouldFlush(110, 110, 20), true); // 收尾
  assertEquals(shouldFlush(40, 40, 20), true); // 总数恰为批大小：既是整批也是收尾
  assertEquals(shouldFlush(1, 1, 20), true); // 单只也要冲刷
});

// ============ 终审 Important-1：非交易日不写新批次 ============
// 判据（用户拍板逐字）：全宇宙 kline_added === 0 && kline_failed === 0 ⇒ 非交易日 ⇒ 不 mint、不写库。
// 腾讯整体宕机（failed>0）属失败不属假日 ⇒ 不得 skip，走既有 per-industry stale copy。
Deno.test("tradingDayGuard: added=0&failed=0 → skip；failed>0 或 added>0 → 不 skip；今日已有批次 → reason 区分", () => {
  assertEquals(
    tradingDayGuard({
      klineAdded: 0,
      klineFailed: 0,
      latestBatch: "2026-09-30",
      today: "2026-10-01",
    }),
    { skip: true, reason: "non_trading_day_skip" },
  );
  // 腾讯整体宕机：那是失败，不是非交易日
  assertEquals(
    tradingDayGuard({
      klineAdded: 0,
      klineFailed: 110,
      latestBatch: null,
      today: "2026-10-01",
    }),
    { skip: false, reason: null },
  );
  // 部分行业有新 bar ⇒ 真实交易日
  assertEquals(
    tradingDayGuard({
      klineAdded: 1,
      klineFailed: 0,
      latestBatch: null,
      today: "2026-10-01",
    }),
    { skip: false, reason: null },
  );
  // 同夜幂等重跑（真实交易日已写过今日）：仍不重写，但 reason 必须能区分
  assertEquals(
    tradingDayGuard({
      klineAdded: 0,
      klineFailed: 0,
      latestBatch: "2026-10-01",
      today: "2026-10-01",
    }),
    { skip: true, reason: "already_written_today" },
  );
  // 空库（首跑无任何批次）
  assertEquals(
    tradingDayGuard({
      klineAdded: 0,
      klineFailed: 0,
      latestBatch: null,
      today: "2026-10-01",
    }),
    { skip: true, reason: "non_trading_day_skip" },
  );
});

// ---- handle() 端到端：fetch 桩（REST + 腾讯）+ GS 截面 spy（顺序硬证明）----
const TODAY = new Date().toISOString().slice(0, 10);
const YDAY = new Date(
  Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000,
).toISOString().slice(0, 10);
const TOKEN = "test-token";
const GS_KEY = "FAKE_KEY_FOR_TEST_ONLY";
const REST_BASE = "https://fake.supabase.co";

const barRow = (d: string) => [d, "1.20", "1.25", "1.26", "1.19", "1000"]; // [date,open,close,high,low,vol]
const tailRow = (d: string) => ({
  trade_date: d,
  close: 1.25,
  volume: 1000,
});
const MAP_ROWS: MapRow[] = [{
  etf_code: "512800",
  etf_name: "银行ETF",
  canonical_ind: "银行",
  amt: 99,
  is_rep: true,
}];
const SNAP: SegSnapshot = {
  rows: new Map<string, EtfSnapRow>([[
    "512800",
    { code: "512800", name: "银行ETF", amt: 99, tem: 3, r60: 1.5, sharpe: 60, hay: null },
  ]]),
  truncated: [],
  warnings: [],
};

interface NetStub {
  writes: { table: string; body: Record<string, unknown>[] }[];
  gsHttpCalls: number;
  tencentCalls: number;
  restore: () => void;
}

function stubNetwork(o: {
  tail: { trade_date: string; close: number; volume: number }[];
  tencent: (string | number)[][] | "malformed"; // "malformed" ⇒ 腾讯宕机/吐畸形（fetchRecentKline 3 次退避后 throw）
  dailyLatest: { batch_date: string }[]; // 守卫读库（select=batch_date&order=desc&limit=1）
  prevBatch?: Record<string, unknown>[]; // ④ 昨日整批
}): NetStub {
  const writes: NetStub["writes"] = [];
  let gsHttpCalls = 0;
  let tencentCalls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("ifzq.gtimg.cn")) {
      tencentCalls++;
      if (o.tencent === "malformed") {
        return Promise.resolve(Response.json({ data: { unexpected: {} } }));
      }
      const sym = decodeURIComponent(
        new URL(url).searchParams.get("param")!.split(",")[0],
      );
      return Promise.resolve(Response.json({ data: { [sym]: { qfqday: o.tencent } } }));
    }
    if (url.includes("guosen.com.cn")) {
      gsHttpCalls++; // skip 分支下必须为 0（即使依赖了真 fetchSegments 也会被发现）
      return Promise.resolve(Response.json({ result: [{ code: 0 }], data: [] }));
    }
    const u = new URL(url);
    const q = u.pathname + u.search;
    if (method === "POST") {
      const table = q.replace("/rest/v1/", "").split("?")[0];
      writes.push({
        table,
        body: JSON.parse(String(init?.body ?? "[]")) as Record<string, unknown>[],
      });
      return Promise.resolve(Response.json([], { status: 201 }));
    }
    if (q.startsWith("/rest/v1/sector_etf_map")) {
      return Promise.resolve(Response.json(MAP_ROWS));
    }
    if (q.startsWith("/rest/v1/sector_kline")) {
      return Promise.resolve(Response.json(o.tail));
    }
    if (q.startsWith("/rest/v1/sector_rotation_daily")) {
      if (q.includes("select=batch_date&")) {
        return Promise.resolve(Response.json(o.dailyLatest));
      }
      return Promise.resolve(Response.json(o.prevBatch ?? []));
    }
    return Promise.resolve(Response.json([], { status: 200 }));
  }) as typeof fetch;
  return {
    writes,
    get gsHttpCalls() {
      return gsHttpCalls;
    },
    get tencentCalls() {
      return tencentCalls;
    },
    restore: () => (globalThis.fetch = real),
  };
}

function runReq(): Request {
  return new Request(`${REST_BASE}/functions/v1/sector-trend?mode=run`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function gsSpy(box: { n: number }): { fetchSegments: () => Promise<SegSnapshot> } {
  return {
    fetchSegments: async () => {
      box.n++;
      return SNAP;
    },
  };
}

Deno.test("I-1 非交易日 skip：GS 截面一次都没被调用（顺序硬证明）+ 零写库 + reason/取证字段齐全", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)],
    tencent: [barRow(YDAY)], // 全宇宙无新 bar ⇒ added=0
    dailyLatest: [{ batch_date: YDAY }],
  });
  const box = { n: 0 };
  try {
    const j = await (await handle(runReq(), gsSpy(box))).json() as Record<
      string, unknown
    >;
    assertEquals(box.n, 0, "守卫必须在 ③GS 之前提前返回，否则整晚 15 段配额白烧");
    assertEquals(s.gsHttpCalls, 0, "不得有任何 GS HTTP 调用");
    assertEquals(s.writes.length, 0, "skip 分支不得产生任何写库调用");
    assertEquals(j.ok, true);
    assertEquals(j.skipped, true);
    assertEquals(j.reason, "non_trading_day_skip");
    assertEquals(j.kline_added, 0);
    assertEquals(j.kline_failed, 0);
    assertEquals(j.latest_batch_date, YDAY); // 保留上一真实批次为最新
    assertEquals(j.industries, 0);
    assertEquals(j.batch_date, TODAY); // 既有字段语义不变（请求日）
    assertEquals(j.mode, "run");
    assertEquals(s.tencentCalls, 1, "②K线增量已完整跑过（守卫是在它之后判的）");
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.delete("SUPABASE_URL");
  }
});

Deno.test("I-1 同夜幂等重跑：今日批次已存在且 added=0 → 仍 skip，reason=already_written_today（与假日可区分）", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)],
    tencent: [barRow(YDAY)],
    dailyLatest: [{ batch_date: TODAY }], // 今日已写过
  });
  const box = { n: 0 };
  try {
    const j = await (await handle(runReq(), gsSpy(box))).json() as Record<
      string, unknown
    >;
    assertEquals(j.skipped, true);
    assertEquals(j.reason, "already_written_today");
    assertEquals(j.latest_batch_date, TODAY);
    assertEquals(box.n, 0);
    assertEquals(s.writes.length, 0);
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.delete("SUPABASE_URL");
  }
});

Deno.test("I-1 腾讯整体宕机（failed>0）→ 不得 skip：照旧打 GS 并走 per-industry stale 路径", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)],
    tencent: "malformed", // 吐不出可用 bar ⇒ fetchRecentKline 3 次退避后 throw ⇒ kline_failed>0
    dailyLatest: [{ batch_date: YDAY }],
  });
  const box = { n: 0 };
  try {
    const j = await (await handle(runReq(), gsSpy(box))).json() as Record<
      string, unknown
    >;
    assertEquals(box.n, 1, "failed>0 属失败不属假日，必须继续 ③GS");
    assertEquals(j.skipped, undefined);
    assertEquals(j.reason, undefined);
    assertEquals(j.kline_failed, 1);
    assertEquals(j.industries, 1, "不静默丢行业");
    assertEquals(j.stale_rows, 1); // C5：无昨日行可 copy ⇒ 当日行置 stale
    assertEquals((j.warnings as string[]).some((w) => w.includes("kline 失败")), true);
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.delete("SUPABASE_URL");
  }
});

Deno.test("I-1 added>0 → 不 skip；I-2 写库载荷 bars_n 等于引擎入参 bar 数", async () => {
  Deno.env.set("SECTOR_TREND_TOKEN", TOKEN);
  Deno.env.set("GS_API_KEY", GS_KEY);
  Deno.env.set("SUPABASE_URL", REST_BASE);
  const s = stubNetwork({
    tail: [tailRow(YDAY)],
    tencent: [barRow(YDAY), barRow(TODAY)], // 今日新 bar ⇒ added=1（真实交易日）
    dailyLatest: [{ batch_date: YDAY }],
  });
  const box = { n: 0 };
  try {
    const j = await (await handle(runReq(), gsSpy(box))).json() as Record<
      string, unknown
    >;
    assertEquals(box.n, 1);
    assertEquals(j.skipped, undefined);
    assertEquals(j.reason, undefined);
    assertEquals(j.kline_added, 1);
    const dailyWrite = s.writes.find((w) =>
      w.table === "sector_rotation_daily"
    );
    assertEquals(dailyWrite !== undefined, true, "真实交易日必写 sector_rotation_daily");
    const row0 = dailyWrite!.body[0] as Record<string, unknown>;
    assertEquals(row0.bars_n, 2, "bars_n = 本轮引擎入参的 K 线根数（YDAY+TODAY）");
    assertEquals(row0.batch_date, TODAY);
    assertEquals(row0.stale, false);
    // 新 bar 确实先落 sector_kline
    assertEquals(s.writes.some((w) => w.table === "sector_kline"), true);
  } finally {
    s.restore();
    Deno.env.delete("SECTOR_TREND_TOKEN");
    Deno.env.delete("GS_API_KEY");
    Deno.env.delete("SUPABASE_URL");
  }
});
