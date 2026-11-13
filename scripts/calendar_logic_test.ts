// scripts/calendar_logic_test.ts —— 财报日历（决议：两级口径）双端一致性 + 接线门禁
//
// 背景（2026-11-01 用户裁定 R3：「只持仓股」+「第3条指日历，即提醒发财报时间」）：
// 页面股票卡片与夜间邮件都必须回答同一个问题——「这只持仓下一次披露是什么时候」，
// 且口径只有两级：东财排期已公布 → 用预约披露日（含改期后的有效日）；未公布 → 法定截止。
// 探针实测（台账「续三十五」）：REPORT_DATE='2026-12-31' 现在查为空 ⇒ 法定兜底腿不是可选项；
// IS_PUBLISH 是字符串 "0"/"1"；日期一律带 " 00:00:00"；改期后有效日在 APPOINT_PUBLISH_DATE，首约在 FIRST_APPOINT_DATE。
//
// 本测试把 index.html 的 CAL_PURE 块当真源（scripts/calendar_logic.ts 逐字抽取执行），
// 与 supabase/functions/daily-update/index.ts 的镜像实现做矩阵比对：只改一侧必红。
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAL_SOON_DAYS, CAL_WINDOW_DAYS, calDaysBetween, calFilter, calPeriods, calSupported,
  calWindow, disclosurePillHtml, disclosureText, nextDisclosure, periodLabel, statutorySchedule,
} from "./calendar_logic.ts";

Deno.env.set("DAILY_UPDATE_DISABLE_SERVE", "1");
// deno-lint-ignore no-explicit-any
const D: any = await import("../supabase/functions/daily-update/index.ts");

// ---- 夹具：字段形态逐字照抄 2026-11-01 探针实测响应，不美化 ----
// 已披露行：IS_PUBLISH="1"，RESIDUAL_DAYS=null，实际披露日落在 ACTUAL_PUBLISH_DATE
const PUBLISHED_H1 = {
  SECURITY_CODE: "000338", REPORT_DATE: "2026-06-30 00:00:00", IS_PUBLISH: "1",
  FIRST_APPOINT_DATE: "2026-08-28 00:00:00", APPOINT_PUBLISH_DATE: "2026-08-28 00:00:00",
  ACTUAL_PUBLISH_DATE: "2026-08-28 00:00:00", RESIDUAL_DAYS: null,
};
// 未披露 + 改期（688235 实测：首约 10-31 → 变更 11-10，服务端 RESIDUAL_DAYS=9 于 11-01）
const DELAYED_Q3 = {
  SECURITY_CODE: "688235", REPORT_DATE: "2026-09-30 00:00:00", IS_PUBLISH: "0",
  FIRST_APPOINT_DATE: "2026-10-31 00:00:00", APPOINT_PUBLISH_DATE: "2026-11-10 00:00:00",
  ACTUAL_PUBLISH_DATE: null, RESIDUAL_DAYS: 9,
};
// 未披露 + 无改期
const APPOINT_ANNUAL = {
  SECURITY_CODE: "600031", REPORT_DATE: "2026-12-31 00:00:00", IS_PUBLISH: "0",
  FIRST_APPOINT_DATE: "2027-03-20 00:00:00", APPOINT_PUBLISH_DATE: "2027-03-20 00:00:00",
  ACTUAL_PUBLISH_DATE: null, RESIDUAL_DAYS: 139,
};

Deno.test("calSupported：只有 6 位纯数字（A股）有口径；港股 5 位与带后缀写法都不判", () => {
  assertEquals(calSupported("600031"), true);
  assertEquals(calSupported("000338"), true);
  assertEquals(calSupported("688235"), true);   // 科创板同样在表内（探针实测有行）
  assertEquals(calSupported("00700"), false);   // 港股：探针实测该表返回空 ⇒ 不许说法定截止
  assertEquals(calSupported("600031.SH"), false);
  assertEquals(calSupported(""), false);
  assertEquals(calSupported(null), false);
  // 数字形态按字符串读：600031 这类没有前导零的代码在 JSON 里掉成 number 仍应识别；
  // 而 000338 掉成 338 已经无法还原 ⇒ 判 false（宁可少一行提示，不报一个凭猜的代码）
  assertEquals(calSupported(600031), true);
  assertEquals(calSupported(338), false);
});

Deno.test("periodLabel：四种报告期月份各归一名；其它月份不猜", () => {
  assertEquals(periodLabel("2026-03-31"), "2026 一季报");
  assertEquals(periodLabel("2026-06-30"), "2026 半年报");
  assertEquals(periodLabel("2026-09-30"), "2026 三季报");
  assertEquals(periodLabel("2026-12-31"), "2026 年报");
  assertEquals(periodLabel("2026-05-31"), "");
  assertEquals(periodLabel(null), "");
});

Deno.test("statutorySchedule：法定截止序列（年报次年 4-30；截止当夜仍算在期内）", () => {
  // 2026-11-01：三季报 10-31 已过 ⇒ 下一期是 2026 年报，法定 2027-04-30
  assertEquals(statutorySchedule("2026-11-01", 2), [
    { reportDate: "2026-12-31", deadline: "2027-04-30", label: "2026 年报" },
    { reportDate: "2027-03-31", deadline: "2027-04-30", label: "2027 一季报" },
  ]);
  // 4-30 当天：年报与一季报同日截止，年报排前面（一季报不得早于年报披露）
  assertEquals(statutorySchedule("2026-04-30", 2).map((p) => p.reportDate), ["2025-12-31", "2026-03-31"]);
  assertEquals(statutorySchedule("2026-05-01", 1)[0].reportDate, "2026-06-30");   // 过 4-30 即翻页
  assertEquals(statutorySchedule("2026-08-31", 1)[0].reportDate, "2026-06-30");   // 8-31 当夜仍算半年报期内
  assertEquals(statutorySchedule("2026-09-01", 1)[0].reportDate, "2026-09-30");
  assertEquals(statutorySchedule("2026-01-01", 4).map((p) => p.label),
    ["2025 年报", "2026 一季报", "2026 半年报", "2026 三季报"]);
});

Deno.test("calPeriods：向前多取一期（逾期延后未披露的行在这里），向后两期覆盖预约排期", () => {
  // 2026-11-01：三季报刚过截止，仍要查它（延后未披露的样本在这里）；再查年报与下一年一季报
  assertEquals(calPeriods("2026-11-01"), ["2026-09-30", "2026-12-31", "2027-03-31"]);
  assertEquals(calPeriods("2026-08-01"), ["2026-03-31", "2026-06-30", "2026-09-30"]);
  assertEquals(calPeriods("2026-11-01", 0, 1), ["2026-12-31"]);
});

Deno.test("calDaysBetween：与探针实测 RESIDUAL_DAYS 同口径（11-01→11-10 = 9 天）", () => {
  assertEquals(calDaysBetween("2026-11-01", "2026-11-10"), 9);
  assertEquals(calDaysBetween("2026-11-01", "2026-11-01"), 0);
  assertEquals(calDaysBetween("2026-11-01", "2026-10-31"), -1);
  assertEquals(calDaysBetween("2026-12-31", "2027-01-01"), 1);   // 跨年不串行
  assertEquals(calDaysBetween("2026-02-28", "2026-03-01"), 1);   // 非闰年 2 月只有 28 日
  assertEquals(calDaysBetween("2028-02-28", "2028-03-01"), 2);   // 闰年 2-29 要算进去
});

Deno.test("nextDisclosure 两级口径之法定兜底：表里没有行就报法定截止，并点名是哪一期（探针实测 2026-12-31 排期尚未公布）", () => {
  assertEquals(nextDisclosure([], "600031", "2026-11-01"), {
    code: "600031", date: "2027-04-30", kind: "statutory", changed: false,
    fromDate: null, label: "2026 年报", daysTo: calDaysBetween("2026-11-01", "2027-04-30"),
  });
  // 只有已披露行 ⇒ 本期结束，仍退到下一期法定截止（不许把「已披露」当「下次披露」）
  assertEquals(nextDisclosure([PUBLISHED_H1], "000338", "2026-11-01")!.kind, "statutory");
});

Deno.test("nextDisclosure 两级口径之预约优先：未披露行用 APPOINT_PUBLISH_DATE，且必须截掉时间部分", () => {
  const e = nextDisclosure([APPOINT_ANNUAL], "600031", "2026-11-01");
  assertEquals(e, {
    code: "600031", date: "2027-03-20", kind: "appoint", changed: false,
    fromDate: null, label: "2026 年报", daysTo: calDaysBetween("2026-11-01", "2027-03-20"),
  });
});

Deno.test("nextDisclosure 改期：有效日取 APPOINT_PUBLISH_DATE（不是首约日），并带出原预约日", () => {
  // 探针实测 688235：首约 10-31 → 变更 11-10。若读 FIRST 会把「延后 10 天」念成「今天到期」
  const e = nextDisclosure([DELAYED_Q3], "688235", "2026-11-01");
  assertEquals(e!.date, "2026-11-10");
  assertEquals(e!.kind, "appoint");
  assertEquals(e!.changed, true);
  assertEquals(e!.fromDate, "2026-10-31");
  assertEquals(e!.daysTo, 9);
});

Deno.test("nextDisclosure 逾期：法定截止已过但未披露，仍如实报延后的预约日（不许静默跳到下一期）", () => {
  // 11-01 已过三季报法定截止 10-31，688235 的 11-10 是逾期延后 —— 这正是邮件最需要提醒的一条
  assertEquals(nextDisclosure([DELAYED_Q3], "688235", "2026-11-01")!.date, "2026-11-10");
});

Deno.test("nextDisclosure 多期取最近：已过期的预约行要被跳过，绝不再报过去的日期", () => {
  const stale = { ...DELAYED_Q3, SECURITY_CODE: "600031", APPOINT_PUBLISH_DATE: "2026-10-20 00:00:00" };
  const e = nextDisclosure([stale, APPOINT_ANNUAL], "600031", "2026-11-01");
  assertEquals(e!.date, "2027-03-20", "过期行没被跳过就会渲染成 10-20（已经过去了）");
  assertEquals(e!.code, "600031");
  // 同一期两条行（脏数据）取较近的未披露那条
  const early = { ...APPOINT_ANNUAL, APPOINT_PUBLISH_DATE: "2027-03-10 00:00:00" };
  assertEquals(nextDisclosure([APPOINT_ANNUAL, early], "600031", "2026-11-01")!.date, "2027-03-10");
});

Deno.test("nextDisclosure 无口径与非 A 股返回 null（不拿 A 股法定截止冒充港股结论）", () => {
  assertEquals(nextDisclosure([DELAYED_Q3], "00700", "2026-11-01"), null);
  assertEquals(nextDisclosure([DELAYED_Q3], "600031.SH", "2026-11-01"), null);
  // 别人的行不算我的：按代码过滤，不能命中任意一行
  assertEquals(nextDisclosure([DELAYED_Q3], "600031", "2026-11-01")!.code, "600031");
  assertEquals(nextDisclosure([DELAYED_Q3], "600031", "2026-11-01")!.kind, "statutory");
});

Deno.test("calWindow：14 天窗口 + 临近 3 天单独归档；按日期升序、同日按代码；窗口外一律不进", () => {
  const mk = (code: string, date: string) => nextDisclosure([
    { SECURITY_CODE: code, REPORT_DATE: "2026-09-30 00:00:00", IS_PUBLISH: "0",
      FIRST_APPOINT_DATE: date + " 00:00:00", APPOINT_PUBLISH_DATE: date + " 00:00:00" },
  ], code, "2026-11-01")!;
  const list = [mk("600031", "2026-11-04"), mk("000338", "2026-11-02"), mk("601899", "2026-11-15"),
    mk("300750", "2026-11-16"), mk("688235", "2026-11-01"), null];
  const w = calWindow(list, "2026-11-01");
  assertEquals(w.soon.map((x) => x.code), ["688235", "000338", "600031"]);   // daysTo 0/1/3 都算临近
  assertEquals(w.later.map((x) => x.code), ["601899"]);                       // 14 天档；11-16 = 15 天出局
  assertEquals(CAL_WINDOW_DAYS, 14);
  assertEquals(CAL_SOON_DAYS, 3);
  // 空/全 null 输入不得抛，且给出两个空数组（邮件小节要靠它决定「无」的文案）
  assertEquals(calWindow([], "2026-11-01"), { soon: [], later: [] });
  assertEquals(calWindow([null, null], "2026-11-01"), { soon: [], later: [] });
});

Deno.test("calFilter：一次请求覆盖持仓（探针实测 in 过滤可用，2375B/3 只）；只放行 6 位数字，杜绝拼注入", () => {
  // 引号风格是实测出来的，不是风格偏好：日期用双引号服务端直接 success:false「filter字段中日期参数格式错误」，
  // 代码改单引号同样 success:false ⇒ 代码双引号 + 日期单引号是唯一可用形态（2026-11-01 隔离变量复测）
  assertEquals(
    calFilter(["600031", "000338"], ["2026-09-30", "2026-12-31"]),
    '(SECURITY_CODE in ("000338","600031"))(REPORT_DATE in (\'2026-09-30\',\'2026-12-31\'))',
  );
  assertEquals(calFilter(["00700", "600031.SH", "600031", "600031"], ["2026-09-30"]),
    '(SECURITY_CODE in ("600031"))(REPORT_DATE in (\'2026-09-30\'))', "去重 + 剔除非 A 股代码");
  assertEquals(calFilter([], ["2026-09-30"]), "", "无持仓 A 股就不该发请求");
  assertEquals(calFilter(['600031")(REPORT_DATE in ("1', "600031"], ["2026-09-30"]),
    '(SECURITY_CODE in ("600031"))(REPORT_DATE in (\'2026-09-30\'))', "带引号/括号的脏代码必须整条丢弃");
  assertEquals(calFilter(["600031"], ["2026-09-30', '1"]), "", "报告期含引号 ⇒ 整条不发：既防拼注入，也防退化成无 REPORT_DATE 过滤的 12 页全表");
});

Deno.test("disclosurePillHtml：三态齐全——有值 / 取数失败 / 无口径（空串=界面无感，正是本仓记过的静默降级）", () => {
  const appt = nextDisclosure([APPOINT_ANNUAL], "600031", "2026-11-01")!;
  const stat = nextDisclosure([], "600031", "2026-11-01")!;
  const chg = nextDisclosure([DELAYED_Q3], "688235", "2026-11-01")!;
  assert(disclosurePillHtml(appt, "ok").includes("03-20"), "预约日要显示月-日");
  assertEquals(/预约/.test(disclosurePillHtml(appt, "ok")), true);
  assertEquals(/法定/.test(disclosurePillHtml(stat, "ok")), true);
  const chgHtml = disclosurePillHtml(chg, "ok");
  assert(chgHtml.includes("11-10") && chgHtml.includes("10-31"), "改期必须把原预约日一起写出，否则读者以为公司从未改口");
  // 失败态必须点名失败，不能与「无口径」共用一句话
  assertEquals(/失败/.test(disclosurePillHtml(null, "failed")), true);
  assertEquals(disclosurePillHtml(null, "ok"), "", "无口径（非 A 股）不给话");
  assertEquals(disclosurePillHtml(null, null), "", "还没取过就不渲染，避免首屏闪一条假消息");
});

Deno.test("disclosureText：两级口径的共用文案（页面胶囊与邮件小节拼同一段，禁两套话术）", () => {
  assertEquals(disclosureText(nextDisclosure([APPOINT_ANNUAL], "600031", "2026-11-01")), "03-20（预约）");
  assertEquals(disclosureText(nextDisclosure([], "600031", "2026-11-01")), "~04-30（法定截止）");
  assertEquals(disclosureText(nextDisclosure([DELAYED_Q3], "688235", "2026-11-01")), "11-10（预约·改期 10-31→11-10）");
  assertEquals(disclosureText(null), "");
});

// ---- 双端一致性：页面 CAL_PURE 与邮件镜像必须逐场景同结论 ----
Deno.test("双端一致：statutorySchedule / calPeriods / nextDisclosure / calWindow / calFilter / disclosurePillHtml", () => {
  const days = ["2026-01-01", "2026-04-15", "2026-04-30", "2026-08-01", "2026-08-31", "2026-09-01", "2026-11-01"];
  const rowsByCode: Record<string, unknown[]> = {
    "000338": [PUBLISHED_H1], "688235": [DELAYED_Q3], "600031": [APPOINT_ANNUAL],
    "300750": [], "00700": [DELAYED_Q3],
  };
  for (const d of days) {
    assertEquals(D.statutorySchedule(d, 3), statutorySchedule(d, 3), "statutorySchedule @" + d);
    assertEquals(D.calPeriods(d), calPeriods(d), "calPeriods @" + d);
    for (const code of Object.keys(rowsByCode)) {
      const rows = [{ SECURITY_CODE: code, REPORT_DATE: "2026-09-30 00:00:00", IS_PUBLISH: "0",
        FIRST_APPOINT_DATE: "2026-10-31 00:00:00", APPOINT_PUBLISH_DATE: "2026-10-31 00:00:00" },
      ...(rowsByCode[code] as [])];
      assertEquals(D.nextDisclosure(rows, code, d), nextDisclosure(rows, code, d),
        `nextDisclosure ${code} @${d}`);
      assertEquals(D.disclosurePillHtml(nextDisclosure(rows, code, d), "ok"),
        disclosurePillHtml(nextDisclosure(rows, code, d), "ok"), `pill ${code} @${d}`);
      assertEquals(D.disclosureText(nextDisclosure(rows, code, d)),
        disclosureText(nextDisclosure(rows, code, d)), `text ${code} @${d}`);
    }
  }
  assertEquals(D.calFilter(["600031", "000338"], calPeriods("2026-11-01")),
    calFilter(["600031", "000338"], calPeriods("2026-11-01")), "calFilter 双端必须同串（同一份 URL 才算同一个请求）");
  assertEquals(D.CAL_WINDOW_DAYS, CAL_WINDOW_DAYS);
  assertEquals(D.CAL_SOON_DAYS, CAL_SOON_DAYS);
  const mk = (code: string, date: string) => nextDisclosure([
    { SECURITY_CODE: code, REPORT_DATE: "2026-09-30 00:00:00", IS_PUBLISH: "0",
      FIRST_APPOINT_DATE: date + " 00:00:00", APPOINT_PUBLISH_DATE: date + " 00:00:00" },
  ], code, "2026-11-01")!;
  const mixed = [mk("600031", "2026-11-04"), mk("000338", "2026-11-02"), null, mk("601899", "2027-01-05")];
  assertEquals(D.calWindow(mixed, "2026-11-01"), calWindow(mixed, "2026-11-01"), "calWindow 双端分档必须一致");
});

// ---- 接线守卫：纯函数绿了但没接进生产路径，正是 dom.md 记过的假绿 ----
Deno.test("接线守卫：页面卡片与夜间邮件都必须真的调用这套判据（不建表、夜间现算、一次过滤请求）", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  const server = await Deno.readTextFile(new URL("../supabase/functions/daily-update/index.ts", import.meta.url));
  assert(/\/\/ ==== CAL_PURE_BEGIN ====/.test(html) && /\/\/ ==== CAL_PURE_END ====/.test(html),
    "index.html 必须有 CAL_PURE 标记块（本测试的抽取来源）");

  const bodyOf = (src: string, name: string) => {
    const at = src.indexOf("function " + name + "(");
    assertEquals(at >= 0, true, "找不到 " + name + "，接线守卫需要重写");
    return src.slice(at, src.indexOf("\n}", at));
  };
  // 页面：详情事实区渲染 + 取数（硬超时是东财挂起会拖死整批的既有教训）
  // 2026-11-12 概览+详情改造：披露胶囊从列表卡移进 stockDetailFactsHtml（refreshDetail 回灌），锚随布局走
  assertEquals(/disclosurePillHtml\(/.test(bodyOf(html, "stockDetailFactsHtml")), true,
    "股票详情不调用 disclosurePillHtml = 判据写好了但界面上永远看不见");
  assertEquals(/AbortSignal\.timeout\(/.test(bodyOf(html, "fetchDisclosureCalendar")), true,
    "没有硬超时：东财挂起会把首屏 renderStockSection 一起拖住");
  assertEquals(/calFilter\(/.test(bodyOf(html, "fetchDisclosureCalendar")), true,
    "页面必须用统一 filter 构造（探针实测按代码过滤一次请求即可，禁止拉 12 页全表）");
  assertEquals(/fetchDisclosureCalendar\(/.test(bodyOf(html, "refreshDisclosures")), true, "入口函数没调用取数函数");
  assertEquals(/nextDisclosure\(/.test(bodyOf(html, "refreshDisclosures")), true,
    "取到的行没走统一判据（就地重算日期会漂口径，双端就不是一条结论）");
  assertEquals(/renderStockSection\(/.test(bodyOf(html, "refreshDisclosures")), true,
    "算完没回灌渲染 = 数据在内存里，界面永远看不见");
  assertEquals(/refreshDisclosures\(/.test(bodyOf(html, "autoRefreshAll")), true,
    "refreshDisclosures 没进自动刷新序列 = 死代码（页面打开自动刷数据是既有约定）");
  // 邮件：取数一次 + 小节渲染 + 只提醒不进信号
  assertEquals(/fetchDisclosureCalendar\(/.test(server), true, "夜间路径没取日历 = 邮件小节永远只报法定截止");
  assertEquals(/calWindow\(/.test(server), true, "邮件没按 14/3 天分档，小节会整池倾倒");
  assert(/📅 财报窗口/.test(server), "邮件必须有「📅 财报窗口」小节标题");
  assertEquals(/calendarSectionHtml\(/.test(server), true, "小节函数写了却没拼进邮件 HTML");
  assertEquals(/disclosureText\(/.test(bodyOf(server, "calendarSectionHtml")), true,
    "邮件小节自己拼日期文案 = 两处话术分叉的开始");
  // 只提醒不改指令：日历不得进入任何信号/档位/金额的入参
  assertEquals(/stockBuyRef\([^)]*disclos/i.test(server), false, "披露日不得作为买入参考的入参（用户裁定：只提醒）");
  assertEquals(/stockBuyRef\([^)]*disclos/i.test(html), false, "页面同律：披露日历不参与三腿合成");
});
