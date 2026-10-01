// gs_etf_test.ts — GS「智能选股 ETF 筛选」filterSearch 适配器单测（brief Step 2 + 终审 I-3 业务码透传）
// 纯解析（buildSegParams/parseSearchResp/parseSearchFull/bizFailText/safeGsMsg/minRowsText）零网络；
// fetchSegments 用可注入的 fake fetch（替换 globalThis.fetch），不打真实网络。断言覆盖：全键参数、缺列→null、
// hayjqidu 空→Q 腿 null、触顶 truncated、单段失败 warning、400ms pacing、并集 <300 → throw('MIN_ROWS')、
// 错误信息不泄漏 apiKey；I-3：业务失败码（如 197006 日限额）必须原样进 warning/throw 文案，且与「真空截面」文本可区分。
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bizFailText,
  buildSegParams,
  CAP,
  type EtfSnapRow,
  EMPTY_SNAP_TEXT,
  fetchSegments,
  MIN_ROWS,
  minRowsText,
  parseSearchFull,
  parseSearchResp,
  safeGsMsg,
} from "./gs_etf.ts";

const fx = (n: string) =>
  JSON.parse(
    Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)),
  );
const KEY = "FAKE_KEY_FOR_TEST_ONLY";

Deno.test("buildSegParams: 15 分段矩阵的键集逐字（不含 apiKey，不许多不少）", () => {
  const p = buildSegParams("10,30", "3");
  assertEquals(
    Object.keys(p).sort(),
    [
      "class1",
      "endamt",
      "orderCol",
      "orderType",
      "skillName",
      "softName",
      "temperRegion",
    ].sort(),
  );
  assertEquals(p, {
    class1: "1",
    endamt: "10,30",
    temperRegion: "3",
    orderCol: "nowrange",
    orderType: "0",
    softName: "goldsun_skills",
    skillName: "gs-etf-filter",
  });
  const q = buildSegParams("2,10", "5");
  assertEquals([q.endamt, q.temperRegion], ["2,10", "5"]);
});

Deno.test("parseSearchResp: 真实响应片段 → 七字段接线；空 hayjqidu/空 sharpe1yrank → null", () => {
  const rows = parseSearchResp(fx("gs_etf_segment_sample.json"));
  assertEquals(rows.length, 6); // 5 真实行 + 1 合成行
  const first: EtfSnapRow = rows[0];
  assertEquals(first.code, "589120");
  assertEquals(first.name, "科创创新药ETF汇添富");
  assertEquals(first.amt, 10.94);
  assertEquals(first.tem, 3);
  assertEquals(first.r60, 0.23);
  assertEquals(first.sharpe, 59.9);
  assertEquals(first.hay, null); // hayjqidu 空串 → Q 腿 null（spec S4：当前无数据）
  const synth = rows[5];
  assertEquals([synth.code, synth.tem, synth.r60], ["512800", 1, -1.2]);
  assertEquals(synth.hay, "82.5"); // 有值 → 原样字符串（供 q 命中判定）
  assertEquals(synth.sharpe, null); // 空串 → null
});

Deno.test("parseSearchResp: 缺列/畸形 → 该列 null，绝不 NaN；非对象/无 data → []", () => {
  const rows = parseSearchResp({
    result: [{ code: 0 }],
    data: [{ ofcode: "512800" }, { ofname: "无码" }],
  });
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    code: "512800",
    name: "",
    amt: null,
    tem: null,
    r60: null,
    sharpe: null,
    hay: null,
  });
  assertEquals(rows[1].code, "");
  assertEquals(parseSearchResp(null), []);
  assertEquals(parseSearchResp({ data: "oops" }), []);
  assertEquals(
    parseSearchResp({
      result: [{ code: 197001 }],
      data: [{ ofcode: "512800" }],
    }),
    [],
  ); // 业务失败码
});

// ---- fetchSegments：fake fetch 注入（不落真实网络） ----
interface FakeCall {
  url: string;
  t: number;
}

function stubFetch(
  handler: (params: URLSearchParams, call: number) => unknown | Error,
) {
  const calls: FakeCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, t: Date.now() });
    const params = new URL(url).searchParams;
    const out = handler(params, calls.length - 1);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(
      new Response(JSON.stringify(out), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const segRows = (n: number, tag: string) => ({
  result: [{ code: 0 }],
  data: Array.from({ length: n }, (_, i) => ({
    ofcode: `${tag}${String(i).padStart(3, "0")}`,
    ofname: `${tag}ETF`,
    endamt: "12.3",
    temperRegion: "3",
    range60d: "1.5",
    sharpe1yrank: "50",
    hayjqidu: "",
  })),
});

Deno.test("fetchSegments: 15 段串行 + 400ms pacing + 触顶记 truncated（不硬退出）+ 单段失败记 warning 继续", async () => {
  const s = stubFetch((_p, i) => {
    if (i === 0) return segRows(CAP, "A"); // 触顶：满 100 → truncated（C2：绝不 exit）
    if (i === 1 || i === 2) return new Error("boom"); // 第 2 段首发 + 重试均失败 → warning 继续
    return segRows(25, `S${i}`);
  });
  try {
    const t0 = Date.now();
    const r = await fetchSegments(KEY);
    assertEquals(r.truncated.length, 1);
    assertEquals(
      /2,10/.test(r.truncated[0]) && /temper/.test(r.truncated[0]),
      true,
      `truncated 需含分段标识, got=${r.truncated[0]}`,
    );
    assertEquals(r.warnings.length >= 1, true);
    assertEquals(
      /重试|fail|error/i.test(r.warnings[0]) ||
        r.warnings.some((w) => /重试|fail|error/i.test(w)),
      true,
    );
    assertEquals(
      r.rows.size >= MIN_ROWS,
      true,
      `并集 ${r.rows.size} 应 ≥ ${MIN_ROWS}（触顶/失败段不得炸链）`,
    );
    assertEquals(
      r.warnings.every((w) => !w.includes(KEY)),
      true,
      "warning 不得泄漏 apiKey",
    );
    // 串行 + pacing：15 段全部调用，相邻间隔 ≥350ms（400ms 名义值容忍定时器抖动）
    assertEquals(s.calls.length >= 15, true);
    const gaps: number[] = [];
    for (let i = 1; i < s.calls.length; i++) {
      gaps.push(s.calls[i].t - s.calls[i - 1].t);
    }
    assertEquals(
      Math.min(...gaps) >= 350,
      true,
      `pacing 违例 min gap=${Math.min(...gaps)}ms`,
    );
    assertEquals(
      s.calls.every((c) =>
        c.url.includes("apiKey=" + KEY) && c.url.includes("class1=1")
      ),
      true,
    );
    assertEquals(
      Date.now() - t0 >= 5_000,
      true,
      "15 段 × 400ms 串行 pacing 总耗时下限",
    );
  } finally {
    s.restore();
  }
});

Deno.test("fetchSegments: 并集 <300 → throw MIN_ROWS（整轮异常，交编排层走 stale 降级）", async () => {
  const s = stubFetch(() => segRows(3, "T"));
  try {
    let msg = "";
    try {
      await fetchSegments(KEY);
    } catch (e) {
      msg = String(e instanceof Error ? e.message : e);
    }
    assertEquals(
      msg.includes("MIN_ROWS"),
      true,
      `应抛 MIN_ROWS，实得 "${msg}"`,
    );
    assertEquals(msg.includes(KEY), false, "错误信息不得泄漏 apiKey");
    s.restore();
  } finally {
    s.restore();
  }
});

// ============ 终审 Important-3：GS 业务码透传（不再把 197006/鉴权失效 坑成「快照异常」）============
const bizFail = (code: number, msg: string) => ({
  result: [{ code, msg }],
  data: [],
});
const noKey = (t: string) => {
  assertEquals(t.includes(KEY), false, `文案不得含 apiKey: "${t}"`);
  assertEquals(
    /FAKE_KEY/.test(t),
    false,
    `文案不得含任何 key 片段（含打码形式）: "${t}"`,
  );
};

Deno.test("I-3 parseSearchFull: 业务失败码→fail+bizCode+bizMsg；code=0 且 data 空→非失败（两情形可区分）", () => {
  const fail = parseSearchFull(bizFail(197006, "超过日限额"));
  assertEquals(fail.fail, true);
  assertEquals(fail.bizCode, 197006);
  assertEquals(fail.bizMsg, "超过日限额");
  assertEquals(fail.rows, []); // 行为不变：业务失败仍降级为空（不改 MIN_ROWS/重试/pacing 语义）
  const empty = parseSearchFull({ result: [{ code: 0, msg: "请求成功" }], data: [] });
  assertEquals(empty.fail, false);
  assertEquals(empty.bizCode, null);
  assertEquals(empty.rows.length, 0);
  const noRes = parseSearchFull({ data: [{ ofcode: "512800" }] });
  assertEquals(noRes.fail, true); // result 缺失：依旧走原失败分支，但 code 未知
  assertEquals(noRes.bizCode, null);
  assertEquals(parseSearchFull(null).fail, true);
  const ok = parseSearchFull({ result: [{ code: 0 }], data: [{ ofcode: "512800" }] });
  assertEquals([ok.fail, ok.rows.length], [false, 1]);
});

Deno.test("I-3 safeGsMsg: 截断 + 脱敏（整串 key / 打码 key 片段 / URL）；中文提示不误伤", () => {
  assertEquals(
    safeGsMsg(`apiKey=${KEY} 超过日限额`, KEY),
    "apiKey=*** 超过日限额",
  );
  // 打码后的 key 片段（前 6 位同形）一律打码
  assertEquals(/FAKE_KEY/.test(safeGsMsg("鉴权失败 FAKE_KEY_F***", KEY)), false);
  // 12+ 位字母数字混排 token 形态（防其它凭据回显）
  assertEquals(
    safeGsMsg("bad token aX9kLm2pQ7rT4uV rejected", KEY),
    "bad token *** rejected",
  );
  // 长度截断
  assertEquals(safeGsMsg("x".repeat(200), KEY).length <= 40, true);
  // URL 一列则只留占位
  assertEquals(
    safeGsMsg("见 https://dgzt.guosen.com.cn/x?apiKey=SECRET 文档", KEY),
    "见 <url> 文档",
  );
  assertEquals(safeGsMsg("", KEY), "");
});

Deno.test("I-3 bizFailText / EMPTY_SNAP_TEXT：业务失败码与真空截面文案不重叠", () => {
  const t = bizFailText(197006, `apiKey=${KEY} 超过日限额`, KEY);
  assertEquals(t.includes("GS 业务码=197006"), true, t);
  assertEquals(t.includes("超过日限额"), true, t);
  noKey(t);
  // code 未知（result 缺失）不得编造一个码
  assertEquals(bizFailText(null, "", KEY).includes("GS 业务码=未知"), true);
  // 两情形文本可区分
  assertEquals(EMPTY_SNAP_TEXT.includes("GS 业务码=197006"), false);
  assertEquals(t.includes(EMPTY_SNAP_TEXT), false);
  assertEquals(EMPTY_SNAP_TEXT.includes("空截面"), true);
});

Deno.test("I-3 minRowsText：同码归并进 throw 文案（取证直接看到配额烧穿），无业务码时不凭空提及", () => {
  const t = minRowsText(0, ["GS 业务码=197006", "GS 业务码=197006"], 15);
  assertEquals(t.includes("MIN_ROWS 违例"), true, t);
  assertEquals(t.includes(`并集去重 0 < ${MIN_ROWS}`), true, t);
  assertEquals(t.includes("GS 业务码=197006"), true, t);
  assertEquals(t.includes("2/15"), true, t);
  noKey(t);
  const plain = minRowsText(45, [], 15);
  assertEquals(plain.includes("MIN_ROWS 违例"), true);
  assertEquals(plain.includes("业务码"), false, `无业务码时不得凭空提及: ${plain}`);
});

Deno.test("I-3 e2e：分段回 197006 → warning 含该码且不含 key 片段（不坑塌为「快照异常」）", async () => {
  // ATTEMPTS=2 ⇒ 一个失败段占 2 次 HTTP 调用：calls 0,1 = 段①，calls 2,3 = 段②（均同码）
  const s = stubFetch((_p, i) => {
    if (i <= 3) {
      return bizFail(197006, `apiKey=${KEY} 当日调用次数超限`);
    }
    return segRows(25, `S${i}`); // 13×25=325 ≥300 ⇒ 不炸链（既有降级语义不变）
  });
  try {
    const r = await fetchSegments(KEY);
    const withCode = r.warnings.filter((w) => w.includes("GS 业务码=197006"));
    assertEquals(withCode.length, 2, `两段失败应两条 warning 都带码: ${JSON.stringify(r.warnings)}`);
    assertEquals(withCode.every((w) => w.includes("取数失败")), true);
    r.warnings.forEach(noKey);
    assertEquals(r.rows.size >= MIN_ROWS, true);
  } finally {
    s.restore();
  }
});

Deno.test("I-3 e2e：整轮 197006 导致 MIN_ROWS → throw 文案自带业务码与段数（今晚 30min 人工定性不再需要）", async () => {
  // calls 0,1 = 段① 两次尝试均同码失败；其余 14 段各 3 只 ⇒ 并集 42 < 300 → throw
  const s = stubFetch((_p, i) => i <= 1 ? bizFail(197006, "超过日限额") : segRows(3, `T${i}`));
  try {
    let msg = "";
    try {
      await fetchSegments(KEY);
    } catch (e) {
      msg = String(e instanceof Error ? e.message : e);
    }
    assertEquals(msg.includes("MIN_ROWS"), true, msg);
    assertEquals(msg.includes("GS 业务码=197006"), true, msg);
    assertEquals(msg.includes("1/15"), true, msg);
    noKey(msg);
  } finally {
    s.restore();
  }
});
