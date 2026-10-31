// daily-update: 每日自动更新基金净值/均线、股票收盘行情与参考指数行情（pg_cron 经 HTTP 调用）
// v4: + 分析报告（每只基金/股票：信号→状态→趋势→下一步操作），修正报告条目与状态表
// v5 (2026-10-18): 信号双端一致性整改——基金档位改「均线偏离 + 估值百分位」两腿合成、优先级顺序对齐页面
//   （QDII → 手动暂停/恢复 → 主题上限 → 常规）、参考指数「不参考」空串恢复豁免语义；
//   双端一致性由 scripts/signal_parity_test.ts 穷举矩阵守护（改这里必须同步改 index.html 的 SIGNAL_PURE 块）。
//   本改动未部署前邮件仍按旧口径发送。
// v6 (2026-10-24): 邮件加「📋 持仓概览」汇总块——基金/股票各自的总市值、收益率、浮盈浮亏，
//   位置在日期行之后、分析正文之前，对齐页面顶部三宫格。纯展示层：信号/止盈/买入系数一字未动。
//   市值用今夜价重估（基金今晚拉到的净值、股票今收盘），成本沿用页面 effectiveCost 的每份成本口径。
// v7 (2026-10-25): 邮件加「🟢 抄底提示」横幅——某只基金当前跌幅已跌破自己的「目标跌幅安全垫」时，
//   在日期行后、持仓概览前逐只点名。补齐页面已有、邮件缺失的抄底提示；同样纯展示层，不进 items、不改发信条件。
//   主信号暂停时不喊买，只报状态；判据与页面 dipAlertFund 一致（含 1e-9 踩线容差）。
// v8 (2026-10-25): 提速整改——取数改并发池（基金/指数/股票各 3 并发），重试 3→2、超时 9s→6s，
//   并加阶段计时日志 `[daily-update][计时] state/fundFetch/write/mail`。
//   起因：force 触发撞上 Edge 150s 墙钟（546 @151s），而 10 只基金串行取数一旦遇上游限流就必然超时；
//   取数是网络等待，串行纯亏墙钟，写库仍是串行（单次几十毫秒，且失败需要逐表归因）。
// v9 (2026-10-27): 两处只读盘点查出的缺陷整改，判据一字未动：
//   ① stock_signal_state 补写库——第 4/5 步一直在 push stockSignalRows，但全函数从未 post，
//     表恒为空 ⇒ 第 5 步读回的 wasOver 永远 false ⇒ 仓位超限提醒每夜重复。写入失败自吞，不拖垮邮件。
//   ② 新增运行台账 daily_update_run——每次运行先落 status='running'，收尾落 'ok'/'error'
//     （状态、force、用户数、总耗时、各段计时串、基金/股票/指数成功失败计数、邮件送达数、error）。
//     用途：pg_cron 丢弃响应体且 Edge console 无抽取通道，被 150s 墙钟砍掉的那晚表里只剩 'running'，
//     断点位置即证据；台账写入同样自吞（表没建也不能改变响应契约）。
// v10 (2026-10-28): 股票/指数腿加腾讯 gtimg 兜底 + 东财镜像段单标的 6s 硬预算。
//   起因（实测）：push2his 对 Edge 出口 IP 连接层拒连，10-25/26/27 连续三晚股票与指数双腿全废
//   （stock_latest 停在 10-24 20:31、index_history 停在 10-23）；旧实现 8 镜像 × 2 试最坏 ≈125s/标的，
//   一个标的就能吃穿 150s 墙钟，兜底若排在镜像轮询之后等于永远走不到。
//   口径已逐根核对（见 txSource 注释），且**东财仍是首选**：东财给得出数据就绝不问腾讯，判据输入不变。
//   遗留：日经225 腾讯无源（实测 type error），该基准仍只吃东财，取不到即如实失败。
// v11 (2026-10-31): 股票侧补「目标跌幅安全垫」成本口径腿（页面同批新增，判据一字不差）。
//   起因：邮件与页面都只对股票看 52 周回撤，用户自填的成本安全垫只有基金吃得到——浮亏踩线却不提示。
//   阈值来源：股票表单新增 targetDrawdown（每只自填；未填/脏值/0 一律不亮，不替用户定数）。
//   仲裁：股票没有「暂停定投」状态可用，改吃本邮件既有的「明显高位」边界 dev≥+10%（与 stockTierLabel 同一条线），
//   高位只陈述事实、不发买入指令；抄底提示横幅与基金并入同一条，卡片 📈 行只追加事实，不动 👉 动作行。
// v12 (2026-10-31): 股票抄底改「双信号 AND」——回撤腿与安全垫腿必须同时突破才亮灯（页面同批）。
//   用户裁定四条：未填安全垫 ⇒ 不亮但显式提示补填（该字段本日才上线，存量持仓一律为空，
//   静默闭灯会被读成「市场没给机会」）；口径沿用 52 周高点回撤 ≥30%（全历史最深回撤 −30% 几乎恒真，无区分度）；
//   否决三态只在页面标注、不改任何买入指令；AND 规则双端同步。
//   顺带修一处 v11 遗留：股票行 🟢 标志此前只看回撤腿，明显高位（dev≥+10%）照样打印「建议买入 N 手」，
//   与同页「只陈述事实」的口径自相矛盾——现在与页面横幅同吃 sGate.shout。
//   灯灭时回撤事实与缺腿原因仍写进 📈 行（事实保留，收紧的只是灯）。
// 触发方式: POST /functions/v1/daily-update，Authorization: Bearer <DAILY_UPDATE_TOKEN>
// 可选 body: {"force":true} 无变化也发送报告
const GOAL_DEFAULT = 200000;
export const DEFAULT_TIERS = [{ ret: 20, sell: 10 }, { ret: 40, sell: 20 }, { ret: 60, sell: 30 }, { ret: 80, sell: 50 }];
export const DEFAULT_CAPS: Record<string, number> = { '机器人/先进制造': 10, '电力/新能源': 15, '全球资源': 20, '日本股票': 15, '美国股票': 30, '均衡配置': 10 };
export const BENCH: Record<string, { secid: string; name: string; th: number[]; noHistorySource?: boolean }> = {
  HS300: { secid: '1.000300', name: '沪深300', th: [-8, -3, 3, 8] },
  NDX: { secid: '100.NDX', name: '纳斯达克', th: [-8, -3, 3, 8] },
  SPX: { secid: '100.SPX', name: '标普500', th: [-8, -3, 3, 8] },
  DJIA: { secid: '100.DJIA', name: '道琼斯', th: [-8, -3, 3, 8] },
  HSI: { secid: '100.HSI', name: '恒生指数', th: [-8, -3, 3, 8] },
  HSTECH: { secid: '124.HSTECH', name: '恒生科技', th: [-12, -5, 5, 12] },
  // 2026-10-28 取证：腾讯无日本指数通道（5 endpoint × 5 symbol 全无节点）、新浪 int_* 是陈旧快照
  // （比现网已验证的腾讯道指/标普/纳指低 11.7%/14.0%/24.2%）、东财 push2his 8 镜像本机与 Edge 双向断，
  // 仅 push2 实时可用（拿不到 120 根）。用户裁定停尝试、接受无大盘折扣，不再每晚白跑 6s。
  N225: { secid: '100.N225', name: '日经225', th: [-8, -3, 3, 8], noHistorySource: true },
};
const KLINE_HOSTS = ['push2his.eastmoney.com', '1.push2his.eastmoney.com', '23.push2his.eastmoney.com', '33.push2his.eastmoney.com', '44.push2his.eastmoney.com', '92.push2his.eastmoney.com', '98.push2his.eastmoney.com', '99.push2his.eastmoney.com'];
// 单标的在东财镜像段上的时间预算：超了就转腾讯，不再逐个镜像耗墙钟（150s 是硬上限）。
const MIRROR_BUDGET_MS = 6000;

export function marketLevel(dev: number | null, th: number[]) {
  if (dev === null) return { level: 'neutral', label: '中性', coef: 1 };
  if (dev <= th[0]) return { level: 'deep-low', label: '深度低位', coef: 1.5 };
  if (dev <= th[1]) return { level: 'low', label: '低位', coef: 1.25 };
  if (dev >= th[3]) return { level: 'deep-high', label: '明显高位', coef: 0.5 };
  if (dev >= th[2]) return { level: 'high', label: '高位', coef: 0.75 };
  return { level: 'neutral', label: '中性', coef: 1 };
}

// 每份成本：优先「持仓成本净值」；只填「持仓总成本」时按 份额=市值/当前净值 折算（与页面 effectiveCost 同式）。
// 提取独立函数是为了让 computeReturn 与「持仓概览」汇总用同一个成本口径；两处各算一遍迟早漂。
export function effectiveCost(f: any): number {
  const cb = Number(f.costBasis) || 0;
  if (cb > 0) return cb;
  const ct = Number(f.costTotal) || 0;
  const nav = Number(f.currentNav) || 0;
  const mv = Number(f.marketValue) || 0;
  if (ct > 0 && nav > 0 && mv > 0) return ct / (mv / nav);
  return 0;
}

export function computeReturn(price: number, f: any): number | null {
  const cb = effectiveCost(f);
  if (!cb) return null;
  return (price - cb) / cb * 100;
}

// 均线与「较双均线平均偏离」：提到模块级以便与页面 computeDeviation 做双端一致性比对（scripts/signal_parity_test.ts）。
// 口径与页面一致：均线为 0/缺失时该腿不参与，两腿全缺返回 null（不是 0）。
export function ma(closes: number[], n: number): number | null {
  return closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
}
export function avgDev(close: number, ma60: number | null, ma120: number | null): number | null {
  const devs: number[] = [];
  if (ma60) devs.push((close - ma60) / ma60 * 100);
  if (ma120) devs.push((close - ma120) / ma120 * 100);
  return devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
}
function stockReturn(f: any, close: number): number | null {
  const cost = parseFloat(f.cost) || 0;
  if (!cost) return null;
  return (close - cost) / cost * 100;
}

// evalFundSignalServer 返回结构：level/resumeReady 均可选（baseSignalLabel 与仓位超限路径不带 level）
interface SignalResult {
  label: string;
  level?: string;
  multiplier: number;
  resumeReady?: boolean;
}

// 估值百分位读取：与页面 baseSignal 同口径（''/undefined/null → 无此腿；NaN → 无此腿）
function readPct(f: any): number | null {
  const raw = f.valuationPercentile;
  if (raw === '' || raw === undefined || raw === null) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

// 大盘参考键裁决：空串 = 用户明确选「不参考」→ 豁免系数；未填 = 默认沪深300；未知键 → 无系数可用。
// 与页面 fundBenchKey 同款（邮件曾把「不参考」当 HS300 用系数，2026-10-18 双端一致性整改）。
export function fundBenchKey(f: any): string {
  if (f.benchmark === '') return '';
  return f.benchmark || 'HS300';
}

// 常规档位：只吃均线偏离腿（2026-10-28 用户裁决：基金侧取消估值分位，只有手动填写、无法联网取数）。
// 标签词表与页面一致（双倍/加强/正常/减半/暂停）；数据缺失不在标签里造词，由报告状态行的 zone='数据不足' 披露。
// 双端一致性由 scripts/signal_parity_test.ts 穷举矩阵守护：这里改语义必须同步改页面，或同步改测试。
export function baseSignalLabel(dev: number | null): SignalResult {
  let score = 0;
  if (dev !== null) {
    if (dev <= -15) score += 2;
    else if (dev <= -5) score += 1;
    else if (dev >= 10) score -= 2;
    else if (dev >= 3) score -= 1;
  }
  if (score >= 3) return { label: '双倍', level: 'double', multiplier: 2 };
  if (score >= 1) return { label: '加强', level: 'strong', multiplier: 1.5 };
  if (score >= -1) return { label: '正常', level: 'normal', multiplier: 1 };
  if (score >= -3) return { label: '减半', level: 'half', multiplier: 0.5 };
  return { label: '暂停', level: 'pause', multiplier: 0 };
}

// 复刻页面 evalFundSignal，顺序也照页面：QDII溢价 → 手动暂停/恢复 → 主题上限(金额锚定) → 常规信号。
// 旧版顺序（上限在手动暂停之前）会让「恢复条件已满足」的资金在邮件里仍报「仓位超限」，与页面结论相反——已整改。
export function evalFundSignalServer(f: any, nav: number, dev: number | null, streak: number | null, themeCaps: Record<string, number>, themeMv: number, goal: number): SignalResult {
  // 1. QDII 溢价独立触发（页面标签为「暂停」+理由；这里保留后缀供邮件动作文案识别）
  if (f.isQDII && f.qdiiPremium !== '' && f.qdiiPremium !== undefined && !isNaN(parseFloat(f.qdiiPremium))) {
    const prem = parseFloat(f.qdiiPremium);
    if (prem >= 2) return { label: '暂停（QDII溢价）', level: 'pause', multiplier: 0 };
  }
  // 2. 手动暂停 / 恢复条件（页面排在仓位超限之前：恢复条件满足即可恢复，与主题上限无关）
  if (f.manualPause) {
    const rr = f.resumeRule || { requireDays: 3, mode: 'ma_only' };
    const need = rr.requireDays ?? 3;
    const st = streak ?? 0;
    const maOk = st >= need;
    const ret = computeReturn(nav, f);
    let ddOk = true;
    if (rr.mode !== 'ma_only' && rr.targetDrawdown !== null && rr.targetDrawdown !== undefined && rr.targetDrawdown !== '') {
      ddOk = ret !== null && ret <= -Math.abs(parseFloat(rr.targetDrawdown));
    }
    const satisfied = rr.mode === 'ma_only' ? maOk : (rr.mode === 'ma_and_drawdown' ? (maOk && ddOk) : (maOk || ddOk));
    if (satisfied) {
      const base = baseSignalLabel(dev);
      return { label: '满足恢复条件 → 建议' + base.label, level: base.level, multiplier: base.multiplier, resumeReady: true };
    }
    return { label: '暂停中', level: 'pause', multiplier: 0 };
  }
  // 3. 主题上限（金额锚定：市值 ≥ 上限% × 目标总额）
  const capPct = themeCaps[f.theme] ?? 100;
  if (themeMv >= capPct / 100 * goal) return { label: '暂停（仓位超限）', level: 'pause', multiplier: 0 };
  // 4. 常规信号
  return baseSignalLabel(dev);
}

function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

// ── 持仓概览（2026-10-24 加）：纯展示，不进任何判据 ──
const C_UP = '#3F8A68';
const C_DOWN = '#B14A34';
const C_MUTED = '#707C8C';

export interface HoldingsAgg {
  mv: number; // 市值（今夜价重估）
  cost: number; // 已填成本小计
  n: number; // 持仓只数（仅计可估值的那部分）
  nCost: number; // 其中已填成本的只数
}

function money(n: number): string {
  return '¥' + Math.abs(Math.round(n)).toLocaleString('en-US');
}

// 成本金额：每份成本 × 份额；没填份额时按「市值 × 每份成本 ÷ 净值」折算。
// 与页面 render() 的 mv*cost/currentNav 同式，差别只是净值取今夜刚拉到的那一个（口径见文件头 v6）。
// 返回 0 表示成本缺失 —— 调用方据此把收益率记为 null，绝不拿 0 当分母。
export function holdingCostOf(costPerUnit: number, shares: number, mv: number, nav: number): number {
  const per = Number(costPerUnit) || 0;
  if (per <= 0) return 0;
  const sh = Number(shares) || 0;
  if (sh > 0) return sh * per;
  if (mv > 0 && nav > 0) return mv * per / nav;
  return 0;
}

function holdingsRow(label: string, ag: HoldingsAgg): string {
  const pnl = ag.cost > 0 ? ag.mv - ag.cost : null;
  const rate = pnl === null ? null : pnl / ag.cost * 100;
  const color = rate === null ? C_MUTED : (rate >= 0 ? C_UP : C_DOWN);
  const rateStr = rate === null ? '--' : (rate >= 0 ? '+' : '') + rate.toFixed(1) + '%';
  const costNote = ag.nCost === 0 ? '未填成本，收益率暂不可算' : '成本已填 ' + ag.nCost + '/' + ag.n + ' 只';
  const pnlStr = pnl === null ? '' : (pnl >= 0 ? '浮盈 +' : '浮亏 -') + money(pnl) + ' · ';
  return '<tr>'
    + '<td style="padding:6px 10px 0 0;font-size:13px;color:' + C_MUTED + ';white-space:nowrap;">' + label + '</td>'
    + '<td style="padding:6px 10px 0 0;font-size:17px;font-weight:700;color:' + color + ';white-space:nowrap;">' + rateStr + '</td>'
    + '<td style="padding:6px 0 0;font-size:13px;color:#1B2436;white-space:nowrap;">市值 ' + money(ag.mv) + '</td>'
    + '</tr>'
    + '<tr><td></td><td colspan="2" style="padding:0 0 4px;font-size:12px;color:' + C_MUTED + ';">' + pnlStr + costNote + '</td></tr>';
}

// 汇总块：任一大类没持仓就整段不渲染（不留空壳），两边都没有则返回空串。
export function holdingsSummaryHtml(
  fund: HoldingsAgg | null,
  stock: HoldingsAgg | null,
  dateStr: string,
): string {
  const rows: string[] = [];
  if (fund && fund.n > 0 && fund.mv > 0) rows.push(holdingsRow('基金', fund));
  if (stock && stock.n > 0 && stock.mv > 0) rows.push(holdingsRow('股票', stock));
  if (!rows.length) return '';
  return '<div style="background:#F1EDE3;border-radius:8px;padding:12px 14px;margin:14px 0;">'
    + '<div style="font-size:14px;font-weight:700;color:#1B2436;">💼 持仓概览'
    + '<span style="font-weight:400;font-size:12px;color:' + C_MUTED + ';">（按 ' + dateStr + ' 最新净值 / 收盘价）</span></div>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">'
    + rows.join('')
    + '</table></div>';
}

// 抄底提示：跌穿「目标跌幅安全垫」才亮（当前跌幅 ≥ 目标跌幅），与 index.html 的 dipAlertFund 同判据。
// 两个细节沿用页面已有的决定：
//   1) 1e-9 容差——恰好踩线时浮点退化（-19.999…）不能漏亮；
//   2) 主信号暂停时 shout=false——只报状态，不在同一封信里既说暂停又喊加仓。
// 与页面唯一的口径差异：这里用今夜净值算，页面用存量 currentNav（同持仓概览的收敛窗口，不当 bug 修）。
export interface FundDip { ret: number; target: number; shout: boolean; }

export function fundDipAlert(f: any, ret: number | null, sigLevel?: string): FundDip | null {
  const raw = f && f.resumeRule ? f.resumeRule.targetDrawdown : undefined;
  if (raw === null || raw === undefined || raw === '') return null;
  const tdd = parseFloat(String(raw));
  // 页面此处没挡 NaN：脏值会让 target 变 NaN、比较恒假而误亮。邮件侧按「未填」处理，宁可不喊。
  if (!Number.isFinite(tdd) || tdd === 0) return null;
  if (ret === null || !Number.isFinite(ret)) return null;
  const target = -Math.abs(tdd);
  if (ret > target + 1e-9) return null;
  return { ret, target, shout: sigLevel !== 'pause' };
}

// 股票抄底·成本口径：与页面 dipAlertStockCost 同判据（同样挡 NaN/0、同样留 1e-9 踩线容差）。
// 股票侧没有「暂停定投」可仲裁，改用页面同一条均线档边界：dev≥+10% 即本邮件的「明显高位」，只陈述不喊买。
export const STOCK_HOT_DEV = 10;

// 安全垫是否已设：与页面 stockPadSet 同判据——未填/空白/脏值/0 都算没设。
// 0 尤其危险：会被当成 -0% 门槛，任何浮亏都算跌穿，比不设更糟；负数与小数是有效阈值。
export function stockPadSet(s: { targetDrawdown?: unknown } | null | undefined): boolean {
  const raw = s ? s.targetDrawdown : undefined;
  if (raw === null || raw === undefined || String(raw).trim() === '') return false;
  const tdd = parseFloat(String(raw));
  return Number.isFinite(tdd) && tdd !== 0;
}

export function stockDipAlert(s: any, ret: number | null, dev: number | null): FundDip | null {
  if (!stockPadSet(s)) return null;
  const tdd = parseFloat(String(s.targetDrawdown));
  if (ret === null || !Number.isFinite(ret)) return null;
  const target = -Math.abs(tdd);
  if (ret > target + 1e-9) return null;
  const hot = dev !== null && Number.isFinite(dev) && dev >= STOCK_HOT_DEV;
  return { ret, target, shout: !hot };
}

// 双信号仲裁（2026-10-31 用户裁决，与页面 stockDipGate 逐格一致）：
// 市场腿（52 周回撤 ≥30%）与安全垫腿必须同时突破才亮抄底灯；
// 回撤已达标而安全垫压根没设 ⇒ 灯灭但 needPad=true，邮件必须点名缺的是哪一腿，不许静默。
export type StockDipGate = { light: boolean; needPad: boolean; shout: boolean };
export function stockDipGate(
  ladder: { dd: number; add: number } | null,
  cost: { shout?: boolean } | null,
  padSet: boolean,
): StockDipGate {
  const light = !!(ladder && cost);
  return { light, needPad: !!(ladder && !padSet && !cost), shout: light ? !!(cost && cost.shout) : false };
}

// 回撤加仓阶梯：与页面 DD_STEPS（index.html 2562）同表；改表必须双端同步，否则页面与邮件给出不同加仓档。
export const DD_STEPS = [{ dd: 50, add: 60 }, { dd: 35, add: 40 }, { dd: 20, add: 30 }, { dd: 15, add: 20 }, { dd: 10, add: 10 }, { dd: 5, add: 5 }];
export function ddAddPct(dd: number): number {
  for (const s of DD_STEPS) if (dd >= s.dd) return s.add;
  return 0;
}
export function drawdownFrom(high: number, price: number): number | null {
  if (!(high > 0) || !(price > 0)) return null;
  return price >= high ? 0 : (high - price) / high * 100;
}
// 基金/股票共用的「回撤达加仓档」：52 周回撤 ≥30% 才亮（2026-10-28 用户裁决基金与股票统一门槛）；
// 档位数值取 DD_STEPS 同表；pct 非空时按估值分位≥80 高估区仲裁否决——仅股票侧会传（基金侧已取消该指标）。
export function dipLadder(
  f: { high52w?: number | string } | null | undefined,
  price: number,
  pct: number | null,
): { dd: number; add: number } | null {
  const dd = drawdownFrom(Number(f && f.high52w) || 0, price);
  if (dd === null) return null;
  if (dd < 30) return null;
  if (pct !== null && Number.isFinite(pct) && pct >= 80) return null;
  return { dd, add: ddAddPct(dd) };
}
// 止盈档：与页面 profitAlertFromRet 同判据——取已触及的最高未执行档；已执行档跳过，不重复喊。
export function sellAlert(
  ret: number | null,
  f: { profitTiers?: Array<{ ret: number; sell: number }>; profitTaken?: number[] } | null | undefined,
): { ret: number; tier: { ret: number; sell: number } } | null {
  if (ret === null || !Number.isFinite(ret) || ret <= 0) return null;
  const tiers = (f && f.profitTiers && f.profitTiers.length) ? f.profitTiers : DEFAULT_TIERS;
  const taken: number[] = (f && f.profitTaken) || [];
  let hit: { ret: number; sell: number } | null = null;
  for (const t of tiers) if (ret >= t.ret && !taken.includes(t.ret)) hit = t;
  return hit ? { ret, tier: hit } : null;
}
// 名称右侧的收益率色块：赚绿亏红（与持仓概览同色）；无成本给 --，绝不吐 NaN。
export function retChipHtml(ret: number | null): string {
  if (ret === null || !Number.isFinite(ret)) {
    return '<span style="font-size:13px;font-weight:700;color:' + C_MUTED + ';">--</span>';
  }
  const sign = ret >= 0 ? '+' : '';
  return '<span style="font-size:15px;font-weight:700;color:' + (ret >= 0 ? C_UP : C_DOWN) + ';white-space:nowrap;">'
    + sign + ret.toFixed(1) + '%</span>';
}

// 卡片顶部的买卖标志：止盈档与回撤加仓档各一条，未触发返回空串（不留空壳）。
// plan 省略 = 基金（份额可小数赎回，保持百分比）；plan 为 null = 股票但缺股数/现价/手数，只报比例。
export function sellMarkHtml(
  a: { ret: number; tier: { ret: number; sell: number } } | null,
  plan?: { wantShares: number; lots: number; qty: number; amount: number; lotSize: number; ratio: number } | null,
): string {
  if (!a) return '';
  const head = '🔴 达到止盈档：+' + a.ret.toFixed(1) + '% ≥ +' + a.tier.ret + '% 档 → ';
  const tail = plan === undefined
    ? '建议卖出 ' + a.tier.sell + '% 份额'
    : !plan
      ? '建议卖出 ' + a.tier.sell + '%（持仓/现价/每手股数不全，未折算手数）'
      : plan.lots < 1
        ? '目标卖出 ' + a.tier.sell + '%（约 ' + Math.round(plan.wantShares) + ' 股），不足 1 手（每手 ' + plan.lotSize + ' 股）'
        : '建议卖出 ' + plan.lots + ' 手（' + plan.qty + ' 股）≈ ' + money(plan.amount) + '（占持仓 ' + plan.ratio.toFixed(1) + '%，目标 ' + a.tier.sell + '%）';
  return '<div style="margin:6px 0;padding:8px 10px;background:#B14A341A;border-left:3px solid ' + C_DOWN + ';border-radius:6px;color:' + C_DOWN + ';font-weight:700;">'
    + head + tail + '</div>';
}
// 股票加仓计划：档位比例按「整体持仓市值」计（2026-10-29 用户裁决：不是定投基数），
// 按标的整手股数向下折算（A股 100、港股按标的读）——不足一手时只报目标金额，绝不四舍五入出虚构手数
export function stockAddPlan(mv: number, price: number, add: number, lotSize = 100): { want: number; lots: number; amount: number; lotSize: number; ratio: number } | null {
  if (!(mv > 0) || !(price > 0) || !(add > 0) || !(lotSize > 0)) return null;
  const want = mv * add / 100;
  const lots = Math.floor(want / (price * lotSize) + 1e-9);
  const amount = lots * price * lotSize;
  return { want, lots, amount, lotSize, ratio: amount / mv * 100 };
}
// 股票止盈计划：档位比例 × 持仓股数 → 整手向下取整（A股 100、港股按标的读）。
// 不足一手时 lots=0：横幅只陈述目标股数，不出「卖 0 手」或「至少 1 手」这类指令
// （2026-10-30 用户裁决，与买入侧同一条规矩；页面 stockSellPlan 同式）
export function stockSellPlan(shares: number, price: number, sellPct: number, lotSize = 100): { wantShares: number; lots: number; qty: number; amount: number; lotSize: number; ratio: number; sell: number; shares: number; price: number } | null {
  const sh = Number(shares) || 0;
  const px = Number(price) || 0;
  const pct = Number(sellPct) || 0;
  const lot = Number(lotSize) || 0;
  if (!(sh > 0) || !(px > 0) || !(pct > 0) || !(lot > 0)) return null;
  const wantShares = sh * pct / 100;
  const lots = Math.floor(wantShares / lot + 1e-9);
  const qty = lots * lot;
  return { wantShares, lots, qty, amount: qty * px, lotSize: lot, ratio: qty / sh * 100, sell: pct, shares: sh, price: px };
}
function buyMarkHtml(l: { dd: number; add: number } | null, plan?: { want: number; lots: number; amount: number; lotSize: number; ratio: number } | null): string {
  if (!l) return '';
  const head = '🟢 较52周高点回撤 ' + l.dd.toFixed(1) + '% 已达 +' + l.add + '% 加仓档 → ';
  const tail = !plan ? '建议买入'
    : plan.lots < 1
      ? '目标加仓 ' + money(plan.want) + '，不足 1 手（每手 ' + plan.lotSize + ' 股）'
      : '建议买入 ' + plan.lots + ' 手（' + plan.lots * plan.lotSize + ' 股）≈ ' + money(plan.amount) + '（占持仓 ' + plan.ratio.toFixed(1) + '%）';
  return '<div style="margin:6px 0;padding:8px 10px;background:#EAF3EE;border-left:3px solid ' + C_UP + ';border-radius:6px;color:' + C_UP + ';font-weight:700;">'
    + head + tail + '</div>';
}

// 需恢复定投：仅对手动暂停（档位仍是「暂停中」）的基金，且两条恢复指标至少一条已触发。
// 只做提示，不改档位/金额（10-09 仲裁：买入指令只由主信号发），所以这里给的是状态旗标不是买入指令。
export interface ResumeHit { code: string; name?: string; reasons: string[]; }
export function resumeBannerHtml(list: ResumeHit[]): string {
  if (!list.length) return '';
  const lines = list.map(d => '【' + d.code + '】' + (d.name ? d.name + ' ' : '') + d.reasons.join('；'));
  return '<div style="background:#FBF1E4;border-left:3px solid #A87C2E;border-radius:8px;padding:12px 14px;margin:14px 0;">'
    + '<div style="font-size:15px;font-weight:700;color:#A87C2E;">🟠 需恢复定投'
    + '<span style="font-weight:400;font-size:12px;color:' + C_MUTED + ';">（当前处于非定投状态，以下恢复指标已触发）</span></div>'
    + '<div style="font-size:13px;color:#1B2436;margin-top:4px;">' + lines.join('<br>') + '</div></div>';
}

// 抄底横幅：每只触发基金一行；空列表返回空串，不留空壳。
// 目标跌幅用 String() 而不是 toFixed(1)：页面回显是 -20%，邮件不能写成 -20.0% 增加噪音。
// shout=false 表示当前处于非定投状态——只陈述事实、不给系统指令（2026-10-28 用户裁决）。
export function dipBannerHtml(list: Array<{ code: string; name?: string; ret: number; target: number; shout: boolean }>): string {
  if (!list.length) return '';
  const lines = list.map(d => {
    const who = '【' + d.code + '】' + (d.name ? d.name + ' ' : '');
    const tail = d.shout ? ' → 建议加仓/多投' : '';
    return who + '收益 ' + d.ret.toFixed(1) + '% 已跌破 ' + String(d.target) + '% 安全垫' + tail;
  });
  return '<div style="background:#EAF3EE;border-left:3px solid ' + C_UP + ';border-radius:8px;padding:12px 14px;margin:14px 0;">'
    + '<div style="font-size:14px;font-weight:700;color:' + C_UP + ';">🟢 抄底提示'
    + '<span style="font-weight:400;font-size:12px;color:' + C_MUTED + ';">（当前跌幅已跌破「目标跌幅安全垫」）</span></div>'
    + '<div style="font-size:13px;color:#1B2436;margin-top:4px;">' + lines.join('<br>') + '</div></div>';
}

// 并发池：限制同时在飞的请求数。取数改并发的理由见 v8 头注释——串行 + 3 次重试会把整段拖到 150s 墙钟边缘。
// fn 自己负责吞错（返回结果对象），所以这里不需要 allSettled；单项失败不能拖倒其余项。
async function mapPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 极简 SMTP 会话（QQ 邮箱 465 端口隐式 TLS + AUTH LOGIN），零第三方依赖
class SmtpIO {
  conn: Deno.TlsConn;
  private buf = new Uint8Array(4096);
  private bufLen = 0;
  private bufPos = 0;
  constructor(conn: Deno.TlsConn) { this.conn = conn; }
  async readLine(): Promise<string> {
    let line = '';
    for (;;) {
      if (this.bufPos >= this.bufLen) {
        const n = await this.conn.read(this.buf);
        if (n === null) throw new Error('smtp connection closed');
        this.bufPos = 0; this.bufLen = n;
        continue;
      }
      const idx = this.buf.indexOf(10, this.bufPos);
      if (idx === -1) {
        line += new TextDecoder().decode(this.buf.subarray(this.bufPos, this.bufLen));
        this.bufPos = this.bufLen;
      } else {
        line += new TextDecoder().decode(this.buf.subarray(this.bufPos, idx));
        this.bufPos = idx + 1;
        return line.replace(/\r$/, '');
      }
    }
  }
  async writeLine(s: string): Promise<void> {
    await this.conn.write(new TextEncoder().encode(s + '\r\n'));
  }
}

async function sendMail(subject: string, html: string): Promise<void> {
  const user = Deno.env.get('SMTP_USER') || '';
  const pass = Deno.env.get('SMTP_PASS') || '';
  const conn = await Deno.connectTls({ hostname: 'smtp.qq.com', port: 465 });
  const io = new SmtpIO(conn);
  const expect = async (prefix: string, what: string) => {
    const l = await io.readLine();
    if (!l.startsWith(prefix)) throw new Error('SMTP ' + what + ': ' + l.slice(0, 120));
    return l;
  };
  try {
    await expect('220', 'greeting');
    await io.writeLine('EHLO dingtou');
    for (;;) { const l = await io.readLine(); if (l.startsWith('250 ')) break; if (l.startsWith('4') || l.startsWith('5')) throw new Error('EHLO: ' + l); }
    await io.writeLine('AUTH LOGIN');
    await expect('334', 'auth user prompt');
    await io.writeLine(base64Utf8(user));
    await expect('334', 'auth pass prompt');
    await io.writeLine(base64Utf8(pass));
    await expect('235', 'auth');
    await io.writeLine('MAIL FROM:<' + user + '>');
    await expect('250', 'mail from');
    await io.writeLine('RCPT TO:<' + user + '>');
    await expect('250', 'rcpt to');
    await io.writeLine('DATA');
    await expect('354', 'data');
    const mail = [
      'From: =?UTF-8?B?' + base64Utf8('定投信号台') + '?= <' + user + '>',
      'To: <' + user + '>',
      'Subject: =?UTF-8?B?' + base64Utf8(subject) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Utf8(html).replace(/(.{76})/g, '$1\r\n'),
      '.'
    ].join('\r\n');
    await io.writeLine(mail);
    await expect('250', 'send');
    await io.writeLine('QUIT');
  } finally {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
}

// —— 可注入依赖位（比照 sector-trend NightlyDeps）：单测传失败桩验证发信异常不拖垮整链；线上走真 sendMail。
export interface DailyUpdateDeps {
  sendMail: (subject: string, html: string) => Promise<void>;
}
const REAL_DEPS: DailyUpdateDeps = { sendMail };

// 可读失败日志：统一 `[daily-update][环节]` 前缀，便于 pg_cron/Edge 运行日志按环节归因。
// 背景：本函数由 pg_cron 经 HTTP 触发、响应体通常被调用方丢弃，失败若只落在 body 里则事后无法定位；
// 故取数/写库/发信三类失败除写入 summary/抛出外，一律额外打一条可归因日志行。
function logFailure(
  stage: "取数" | "写库" | "发信" | "致命",
  detail: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[daily-update][${stage}] ${detail}: ${msg}`);
}

// 编排主体 = 原 Deno.serve 内联回调逐字提出为具名导出函数（可调用 + 可注入）；逻辑一字未改。
// 注册守卫仅针对单测场景（index_test.ts 先设 DAILY_UPDATE_DISABLE_SERVE 再动态 import）；
// 线上 Edge 不会注入该变量，Deno.serve 注册行为不变（同 sector-trend/stock-score）。
// 运行台账行（2026-10-27 加）：本函数由 pg_cron 经 HTTP 触发、响应体被调用方丢弃，且 Edge console
// 无日志抽取通道，事后既查不到"昨晚跑没跑"也查不到"钱花在哪一段"。故每次运行往 daily_update_run 落一行，
// 中途被 150s 墙钟砍掉时表里只剩 status='running' 那一行 —— 断点位置即证据。
// 纯函数导出：行内容（各段成功/失败计数、邮件口径、error 截断）可被单测直接验证，不靠正则守卫。
export interface RunRowOpts {
  runAt: string;
  status: 'running' | 'ok' | 'error';
  force: boolean;
  msTotal: number;
  error?: string | null;
}

// 失败原因汇总：只有计数时，NDX 停更一个月这种事在库里查不到任何线索（2026-10-28 现网取证）。
// 逐条 `链路 标的：原因`，按基金→股票→指数顺序，整体截断 1200——台账列宽与写入稳定性优先。
function collectErrors(summary: any): string | null {
  const pick = (arr: any[], kind: string, key: string) =>
    (arr || []).filter((x) => x && x.ok === false)
      .map((x) => kind + ' ' + (x[key] || '?') + '：' + (x.error || '未知原因'));
  const all = [
    ...pick(summary.funds, '基金', 'code'),
    ...pick(summary.stocks, '股票', 'code'),
    ...pick(summary.indices, '指数', 'idx'),
  ];
  return all.length ? all.join(' | ').slice(0, 1200) : null;
}

export function runRow(summary: any, timings: string[], opts: RunRowOpts): Record<string, any> {
  const cnt = (arr: any[], wantOk: boolean) => (arr || []).filter((x) => !!x && !!x.ok === wantOk).length;
  const notes: any[] = summary.notifications || [];
  return {
    run_at: opts.runAt,
    status: opts.status,
    force: opts.force,
    users: summary.users || 0,
    ms_total: opts.msTotal,
    timings: timings.join(' | '),
    funds_ok: cnt(summary.funds, true),
    funds_fail: cnt(summary.funds, false),
    stocks_ok: cnt(summary.stocks, true),
    stocks_fail: cnt(summary.stocks, false),
    index_ok: cnt(summary.indices, true),
    index_fail: cnt(summary.indices, false),
    mail_sent: notes.filter((n) => n && n.sent === true).length,
    // 只把"真尝试发送且失败"计为失败：无信号变化的静默用户 sent 保持 false 但从未尝试，不算投递失败
    mail_failed: notes.filter((n) => n && n.sent !== true && n.mailError).length,
    errors: collectErrors(summary),
    error: opts.error ? String(opts.error).slice(0, 200) : null,
  };
}

// 腾讯 gtimg 兜底源（2026-10-28）：东财 push2his 对 Edge 出口 IP 连续 3 晚拒连（error sending request，
// 连接层被断），股票腿与指数腿同时全废——stock_latest 停在 10-24 20:31、index_history 停在 10-23。
// 板块腿当年因同一问题迁到腾讯（见 sector-trend/tencent.ts 头注释）。本函数只在东财整段失败后补一次，
// 首选源不变 ⇒ 判据输入口径不变；口径已逐根核对：10-27 收盘 600031=18.070/000338=21.000/002415=34.250
// 与东财 fqt=1 分毫不差（腾讯行格式 [date, open, close, high, low, volume]，收盘取 r[2]）。
// 腾讯无日本市场源（jpN225/jpNKY 实测 type error）⇒ N225 返回 null，继续只吃东财，不瞎猜代理。
export function txSource(secid: string): { symbol: string; endpoint: string } | null {
  const m = /^(\d+)\.(.+)$/.exec(secid);
  if (!m) return null;
  const [, market, code] = m;
  // 美股指数必须走 usfqkline：同一个 symbol 在 fqkline 下只回 1 根（实测），拿不到 120 日均线
  if (market === '1' && /^\d{6}$/.test(code)) return { symbol: 'sh' + code, endpoint: 'fqkline' };
  if (market === '0' && /^\d{6}$/.test(code)) return { symbol: 'sz' + code, endpoint: 'fqkline' };
  if (market === '116' && /^\d{5}$/.test(code)) return { symbol: 'hk' + code, endpoint: 'fqkline' };
  const IDX: Record<string, [string, string]> = {
    '100.HSI': ['hkHSI', 'fqkline'],
    '124.HSTECH': ['hkHSTECH', 'fqkline'],
    '100.NDX': ['usNDX', 'usfqkline'],
    '100.SPX': ['usINX', 'usfqkline'],
    '100.DJIA': ['usDJI', 'usfqkline'],
  };
  const hit = IDX[secid];
  return hit ? { symbol: hit[0], endpoint: hit[1] } : null;
}

// 腾讯 K线解析 → {date, close, closes}；空/畸形一律 null（让调用方按"兜底也没拿到"处理，不假装成功）
export function parseTxKline(json: unknown, symbol: string): { date: string; close: number; closes: number[] } | null {
  let node: any;
  try { node = (json as any)?.data?.[symbol]; } catch { return null; }
  const rows = Array.isArray(node?.qfqday) ? node.qfqday : Array.isArray(node?.day) ? node.day : null;
  if (!rows) return null;
  const closes: number[] = [];
  let date = '';
  let close = NaN;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const d = typeof r[0] === 'string' ? r[0] : '';
    const c = Number(r[2]);
    if (!d || !Number.isFinite(c)) continue;
    closes.push(c);
    date = d;
    close = c;
  }
  return closes.length ? { date, close, closes } : null;
}

// 港股每手股数：腾讯行情 qt.gtimg.cn/q=hk00005 的第 61 个字段（0 基 60）。
// 实测 2026-10-28：00005=400、00700=100、00939=1000、01299=200、00016=500、02318=500。
// 港股每手股数因股而异（拆股/并股会变）⇒ 必须按标的读，不许按 100 猜；脏值一律 null，让调用方退回「不给金额」。
// 两种形态都要认：原始响应 v_hk00005="..." 与去掉赋值外壳的纯字段串（浏览器 window 变量），
// 否则同一条报价在两端会得出不同结论
export function lotFromTxQuote(text: string): number | null {
  const body = String(text || '');
  const m = /"([^"]*)"/.exec(body);
  const f = (m ? m[1] : body).split('~');
  if (f.length < 61) return null;
  const raw = String(f[60]).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

// 取数失败的归因串：旧实现只留 lastErr，于是"8 个镜像怎么死的""兜底有没有源"全丢在日志里，
// 而日志本身拿不到（Edge console 无抽取通道）⇒ 现网 NDX 静默停更一个月无人可查。
// 长度封顶 140：调用方按 140 截断进 summary/台账，超了会互相吃掉。
export interface KlineFailParts {
  hosts: number;
  budgetHit: boolean;
  mirrorErr: string;
  txSymbol?: string | null;
  txErr?: string | null;
}
export function klineFailNote(p: KlineFailParts): string {
  let s = '东财' + p.hosts + '镜像失败(' + (p.mirrorErr || '未知') + ')';
  if (p.budgetHit) s += '｜镜像段超预算提前转兜底';
  s += p.txSymbol
    ? '｜腾讯' + p.txSymbol + (p.txErr ? '失败(' + p.txErr + ')' : '无有效K线')
    : '｜腾讯无源(未兜底)';
  return s.slice(0, 140);
}

export async function handle(
  req: Request,
  deps: DailyUpdateDeps = REAL_DEPS,
): Promise<Response> {
  const auth = req.headers.get('Authorization') || '';
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || auth !== 'Bearer ' + token) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  }
  let force = false;
  try { const b = await req.json(); if (b && (b as any).force) force = true; } catch (e) { /* body 可为空 */ }

  const sbUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const summary: any = { funds: [], stocks: [], indices: [], notifications: [], users: 0 };
  // 阶段计时（v8）：150s 墙钟是硬上限，出问题时要能直接从日志看出钱花在哪一段，而不是靠推断。
  const T0 = Date.now();
  const timings: string[] = [];
  const mark = (label: string) => timings.push(label + ' ' + (Date.now() - T0) + 'ms');
  const runAt = new Date().toISOString();
  // 台账写入一律自吞异常：观测件坏了不能把交付件（邮件）拖挂，也不能改变响应契约。
  const logRun = async (status: 'running' | 'ok' | 'error', error: string | null = null) => {
    try {
      const row = runRow(summary, timings, { runAt, status, force, msTotal: Date.now() - T0, error });
      const r = await fetch(sbUrl + '/rest/v1/daily_update_run?on_conflict=run_at', {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([row])
      });
      if (!r.ok) logFailure('写库', 'daily_update_run ' + status + ' 落库失败 ' + r.status, new Error((await r.text()).slice(0, 200)));
    } catch (e) {
      logFailure('写库', 'daily_update_run ' + status + ' 落库异常', e);
    }
  };

  const post = async (table: string, onConflict: string, rows: any[]) => {
    if (!rows.length) return;
    const r = await fetch(sbUrl + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      logFailure('写库', table + ' upsert 失败 ' + r.status, new Error(txt));
      throw new Error(table + ' upsert failed ' + r.status + ': ' + txt);
    }
  };

  const fetchRetry = async (url: string, headers: any, tries = 2, timeoutMs = 6000): Promise<Response> => {
    let lastErr: any = null;
    for (let i = 0; i < tries; i++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_r=' + Date.now(), { headers, signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) return r;
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { clearTimeout(to); lastErr = (e && (e as any).name === 'AbortError') ? new Error('timeout ' + timeoutMs + 'ms') : e; }
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
    throw lastErr;
  };
  // 港股每手股数（同一轮批处理里同代码只取一次）：取不到返回 null，由调用方回落；
  // A股不走这里（每手固定 100）
  const hkLotCache = new Map<string, number | null>();
  const fetchHkLot = async (code: string): Promise<number | null> => {
    if (hkLotCache.has(code)) return hkLotCache.get(code)!;
    let lot: number | null = null;
    try {
      const r = await fetchRetry('https://qt.gtimg.cn/q=hk' + code, { 'User-Agent': 'Mozilla/5.0' }, 2, 5000);
      lot = lotFromTxQuote(await r.text());
    } catch (e) {
      logFailure('取数', '港股 ' + code + ' 每手股数获取失败', e);
    }
    hkLotCache.set(code, lot);
    return lot;
  };
  const fetchKline = async (secid: string, fqt: number, lmt: number): Promise<{ date: string; close: number; closes: number[]; name: string }> => {
    // 归因位：镜像段试了几个、死法是什么、有没有被预算提前切断、兜底问到哪个 symbol。
    // 东财镜像段硬预算：8 镜像 × 2 试最坏 ≈125s/标的，一个标的就能吃穿 150s 墙钟（现网 3 只股票 48s 全失败）。
    // 预算只限制"还在不在东财上耗"，不改变成功路径的口径；超时即转腾讯兜底。
    let hostsTried = 0;
    let budgetHit = false;
    let mirrorErr = '未取到数据';
    const tMirror = Date.now();
    for (const host of KLINE_HOSTS) {
      if (Date.now() - tMirror > MIRROR_BUDGET_MS) { budgetHit = true; break; }
      hostsTried++;
      try {
        const r = await fetchRetry('https://' + host + '/api/qt/stock/kline/get?secid=' + secid + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&klt=101&fqt=' + fqt + '&lmt=' + lmt + '&end=20500101', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2);
        const j = await r.json();
        const klines: string[] = (j && j.data && j.data.klines) || [];
        if (!klines.length) { mirrorErr = 'no klines'; continue; }
        const rows = klines.map((kl: string) => { const [dd, cc] = kl.split(','); return { date: dd, close: parseFloat(cc) }; });
        return { date: rows[rows.length - 1].date, close: rows[rows.length - 1].close, closes: rows.map(x => x.close), name: (j && j.data && j.data.name) || '' };
      } catch (e) {
        mirrorErr = String((e as any)?.message || e).slice(0, 60);
      }
    }
    const tx = txSource(secid);
    let txErr: string | null = null;
    if (tx) {
      try {
        const r = await fetchRetry('https://web.ifzq.gtimg.cn/appstock/app/' + tx.endpoint + '/get?param=' + encodeURIComponent(tx.symbol + ',day,,,' + lmt + ',qfq'), { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2, 6000);
        const p = parseTxKline(await r.json(), tx.symbol);
        if (p) return { ...p, name: '' };
        // 拿到响应却解析不出有效根：txErr 留 null ⇒ 文案走"无有效K线"，与"网络/HTTP 挂了"区分开
      } catch (e) {
        txErr = String((e as any)?.message || e).slice(0, 60);
      }
    }
    throw new Error(klineFailNote({
      hosts: hostsTried,
      budgetHit,
      mirrorErr,
      txSymbol: tx ? tx.symbol : null,
      txErr,
    }));
  };

  try {
    // 1. 读取所有用户的资产清单
    const stRes = await fetch(sbUrl + '/rest/v1/dingtou_state?select=user_id,data', { headers: H });
    if (!stRes.ok) {
      logFailure('取数', 'dingtou_state 读取失败 status=' + stRes.status, new Error('state read failed ' + stRes.status));
      throw new Error('state read failed ' + stRes.status);
    }
    const states = await stRes.json();
    summary.users = states.length;
    mark('state');
    await logRun('running');

    const fundJobs: { userId: string; code: string }[] = [];
    const stockJobs: { userId: string; code: string }[] = [];
    const invalidStocks: Record<string, { code: string; name: string }[]> = {};
    const idxSet = new Set<string>();
    for (const st of states) {
      const funds = (st.data && st.data.funds) || [];
      for (const f of funds) {
        const code = String(f.fundCode || '').trim();
        if (/^\d{6}$/.test(code)) fundJobs.push({ userId: st.user_id, code });
        const k = f.benchmark || 'HS300';
        if (BENCH[k] && !BENCH[k].noHistorySource) idxSet.add(k);
      }
      const stocks = (st.data && st.data.stocks) || [];
      for (const s of stocks) {
        const code = String(s.code || '').trim();
        if (/^\d{5,6}$/.test(code)) stockJobs.push({ userId: st.user_id, code });
        else (invalidStocks[st.user_id] = invalidStocks[st.user_id] || []).push({ code: code || '(空)', name: s.name || '' });
      }
    }

    // ma / avgDev 已提到模块级并导出（见文件头），此处直接使用模块级实现，保证双端一致性可测。

    // 2. 先取参考指数行情与档位（基金/股票报告的建议金额需要用到系数）
    const idxLevels: Record<string, { label: string; coef: number }> = {};
    // 先并发把指数 K 线拿回来（并发 3），再串行算档位 + 落库——取数是网络等待，串行纯亏墙钟。
    const idxKeys = [...idxSet];
    const idxKMap = new Map<string, { kk?: { date: string; close: number; closes: number[]; name: string }; err?: any }>();
    await mapPool(idxKeys, 3, async (k) => {
      try { idxKMap.set(k, { kk: await fetchKline(BENCH[k].secid, 1, 130) }); }
      catch (e) { idxKMap.set(k, { err: e }); }
    });
    for (const k of idxKeys) {
      try {
        const pre = idxKMap.get(k);
        if (!pre || pre.kk === undefined) throw (pre && pre.err) || new Error('index fetch failed');
        const kk = pre.kk;
        const close = kk.close;
        const ma60 = ma(kk.closes, 60);
        const ma120 = ma(kk.closes, 120);
        const devs: number[] = [];
        if (ma60) devs.push((close - ma60) / ma60 * 100);
        if (ma120) devs.push((close - ma120) / ma120 * 100);
        const dev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
        const lv = marketLevel(dev, BENCH[k].th);
        idxLevels[k] = { label: lv.label, coef: lv.coef };
        await post('index_history', 'idx_code,idx_date', [{ idx_code: k, idx_date: kk.date, close }]);
        summary.indices.push({ idx: k, ok: true, date: kk.date, close, level: lv.label });
      } catch (e) {
        logFailure('取数', '指数 ' + k + ' 行情获取失败', e);
        summary.indices.push({ idx: k, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 3. 基金：净值/均线/信号 + 分析报告数据
    const fundUniq = [...new Set(fundJobs.map(j => j.code))];
    const fundSignalRows: any[] = [];
    const fundMeta: Record<string, { name: string; nav: number; navDate: string }> = {};
    const fundReport: Record<string, any[]> = {};
    const fundHold: Record<string, HoldingsAgg> = {};
    const fundDips: Record<string, Array<{ code: string; name: string } & FundDip>> = {};
    const fundResume: Record<string, ResumeHit[]> = {};
    // 3a. 基金净值原文并发预取（并发 5、重试 2 次 / 8s）。
    // 原实现串行 + 3 次重试，10 只基金一旦遇上游限流，最坏 10×（9×3+退避）就越过 150s 墙钟。
    // 并发 3/6s 实测：每只都在 6s 撞超时再重试（东财单文件 6–10s），整段仍要 57s ⇒ 提到 5 并发、8s。
    const pzMap = new Map<string, { txt?: string; err?: string; ms: number }>();
    await mapPool(fundUniq, 5, async (code) => {
      const t = Date.now();
      try {
        const r = await fetchRetry('https://fund.eastmoney.com/pingzhongdata/' + code + '.js?dt=' + Date.now(), {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' }
        }, 2, 8000);
        pzMap.set(code, { txt: await r.text(), ms: Date.now() - t });
      } catch (e) {
        pzMap.set(code, { err: String((e as any)?.message || e), ms: Date.now() - t });
      }
    });
    const pzTop = fundUniq.map(c => ({ c, ms: pzMap.get(c)?.ms || 0 })).sort((a, b) => b.ms - a.ms).slice(0, 3);
    if (pzTop.length && pzTop[0].ms > 3000) {
      console.log('[daily-update][计时] 最慢基金取数 ' + pzTop.map(x => x.c + ' ' + x.ms + 'ms').join(', '));
    }
    mark('fundFetch');
    for (const code of fundUniq) {
      try {
        const pz = pzMap.get(code);
        if (!pz || pz.txt === undefined) throw new Error('pingzhongdata ' + (pz ? pz.err : 'not fetched'));
        const txt = pz.txt;
        const nameMatch = txt.match(/var fS_name\s*=\s*"([^"]*)"/);
        const trendMatch = txt.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
        if (!trendMatch) throw new Error('no trend in source');
        const trend = JSON.parse(trendMatch[1]);
        if (!trend.length) throw new Error('no trend');
        const navs = trend.map((p: any) => parseFloat(p.y)).filter((n: number) => !isNaN(n));
        if (!navs.length) throw new Error('no nav');
        const last = trend[trend.length - 1];
        const d = new Date(last.x);
        const navDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const close = navs[navs.length - 1];
        const ma60 = ma(navs, 60);
        const ma120 = ma(navs, 120);
        const dev = avgDev(close, ma60, ma120);
        const above = ma60 === null ? null : close >= ma60;
        let streak: number | null = null;
        if (navs.length >= 60) {
          streak = 0;
          for (let i = navs.length - 1; i >= 59; i--) {
            const m = navs.slice(i - 59, i + 1).reduce((a: number, b: number) => a + b, 0) / 60;
            if (navs[i] >= m) streak++; else break;
          }
        }
        fundMeta[code] = { name: nameMatch ? nameMatch[1] : '', nav: close, navDate };

        const users = [...new Set(fundJobs.filter(j => j.code === code).map(j => j.userId))];
        for (const userId of users) {
          const st = states.find((s: any) => s.user_id === userId);
          const goal = (st.data && st.data.goal) || GOAL_DEFAULT;
          const funds = (st.data && st.data.funds) || [];
          const f = funds.find((x: any) => String(x.fundCode || '').trim() === code) || {};
          const fm = (f.shares > 0 && close > 0) ? f.shares * close : (parseFloat(f.marketValue) || 0);
          // 持仓概览累加（只计可估值的持仓：mv>0；成本缺失时 nCost 不增，收益率显示 --）
          if (fm > 0) {
            const fcost = holdingCostOf(effectiveCost(f), f.shares, fm, close);
            const ag = (fundHold[userId] = fundHold[userId] || { mv: 0, cost: 0, n: 0, nCost: 0 });
            ag.mv += fm;
            ag.cost += fcost;
            ag.n += 1;
            if (fcost > 0) ag.nCost += 1;
          }
          const themeCaps = { ...DEFAULT_CAPS, ...((st.data && st.data.themeCaps) || {}) };
          // themeSum 与页面 themeMarketValue 的口径差异（已确认可收敛，勿当漂移修）：
          // 这里对本只基金用「份额×最新净值」（今夜刚拉到），其余用存量 marketValue；页面用存量 marketValue 求和。
          // 用户下次打开页面会自动刷新存量值 ⇒ 两处收敛；差值只出现在「今夜已拉净值但页面尚未再打开」的窗口内。
          const themeSum = funds.reduce((s: number, x: any) => {
            const isSelf = String(x.fundCode || '').trim() === code;
            const xm = (isSelf && f.shares > 0 && close > 0) ? fm : (parseFloat(x.marketValue) || 0);
            return (x.theme === f.theme) ? s + (xm || 0) : s;
          }, 0);
          const sig = evalFundSignalServer(f, close, dev, streak, themeCaps, themeSum, goal);
          const ret = computeReturn(close, f);
          const fname = nameMatch ? nameMatch[1] : (f.name || '');
          // 抄底提示：跌穿成本安全垫就点名（主信号暂停时不喊买，只报状态）
          const dip = fundDipAlert(f, ret, sig.level);
          if (dip) {
            (fundDips[userId] = fundDips[userId] || []).push({ code, name: fname, ...dip });
          }
          // 回撤达加仓档：暂停中 → 只进「需恢复定投」旗标；非暂停才在卡片里喊买入（10-09 仲裁）
          // 基金侧取消估值分位（2026-10-28）：分位位传 null，不吃高估否决
          const ladder = dipLadder(f, close, null);
          if (f.manualPause && sig.label === '暂停中') {
            const reasons: string[] = [];
            if (dip) reasons.push('收益 ' + dip.ret.toFixed(1) + '% 已跌破 ' + String(dip.target) + '% 成本安全垫');
            if (ladder) reasons.push('较52周高点回撤 ' + ladder.dd.toFixed(1) + '%（已达 +' + ladder.add + '% 加仓档）');
            if (reasons.length) (fundResume[userId] = fundResume[userId] || []).push({ code, name: fname, reasons });
          }
          const tiers = (f.profitTiers && f.profitTiers.length) ? f.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) {
            for (const t of tiers) { if (ret >= t.ret && !(f.profitTaken || []).includes(t.ret)) newTier = t.ret; }
          }
          const label = sig.label + (newTier !== null ? '｜止盈' + newTier + '%达标' : '');
          fundSignalRows.push({ user_id: userId, code, label, profit_tier: newTier, benchmark: fundBenchKey(f), updated_at: new Date().toISOString() });

          // 分析报告数据（大盘系数已知）
          const bkey = fundBenchKey(f);
          const bl = bkey ? (idxLevels[bkey] || null) : null;
          // 与页面同款：系数只看参考档位是否就绪，不看 multiplier（暂停时 multiplier=0，金额本就为 0）
          const coef = bl ? bl.coef : 1;
          const amount = (parseFloat(f.baseAmount) || 0) * sig.multiplier * coef;
          const taken = f.profitTaken || [];
          const nextTier = tiers.find((x: any) => !taken.includes(x.ret)) || null;
          (fundReport[userId] = fundReport[userId] || []).push({
            code, name: fname, nav: close, navDate,
            dev, ma60, ma120, streak, label: sig.label, multiplier: sig.multiplier,
            amount: Math.round(amount), benchmarkName: bl ? BENCH[bkey].name : '', benchmarkLevel: bl ? bl.label : '',
            ret, nextTier, resumeReady: !!sig.resumeReady, theme: f.theme || '',
            sell: sellAlert(ret, f), ladder
          });

          await post('fund_nav_history', 'user_id,code,nav_date', [{ user_id: userId, code, nav_date: navDate, nav: close, ma60, ma120, dev_pct: dev, above_ma60: above }]);
          await post('fund_latest', 'user_id,code', [{
            user_id: userId, code, name: nameMatch ? nameMatch[1] : null, nav: close, nav_date: navDate,
            ma60, ma120, dev_pct: dev, streak, updated_at: new Date().toISOString()
          }]);
        }
        summary.funds.push({ code, ok: true, nav_date: navDate, nav: close, dev: dev === null ? null : Math.round(dev * 1000) / 1000, streak });
      } catch (e) {
        logFailure('取数', '基金 ' + code + ' 净值获取/解析失败', e);
        summary.funds.push({ code, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 4. 股票（A股/港股）：收盘价/均线/信号 + 分析报告数据
    const stockUniq = [...new Set(stockJobs.map(j => j.code))];
    const stockSignalRows: any[] = [];
    const stockReport: Record<string, any[]> = {};
    const stockHold: Record<string, HoldingsAgg> = {};
    const stockDips: Record<string, Array<{ code: string; name: string } & FundDip>> = {};
    // 先并发取 K 线，再串行算信号 + 落库（理由同基金：取数才是墙钟大户）。
    const stKMap = new Map<string, { k?: { date: string; close: number; closes: number[]; name: string }; err?: any }>();
    await mapPool(stockUniq, 3, async (code) => {
      const secid = code.length === 5 ? ('116.' + code) : (code.startsWith('6') ? ('1.' + code) : ('0.' + code));
      try { stKMap.set(code, { k: await fetchKline(secid, 1, 130) }); }
      catch (e) { stKMap.set(code, { err: e }); }
    });
    for (const code of stockUniq) {
      try {
        const pre = stKMap.get(code);
        if (!pre || pre.k === undefined) throw (pre && pre.err) || new Error('kline fetch failed');
        const k = pre.k;
        const close = k.close;
        const ma20 = ma(k.closes, 20);
        const ma60 = ma(k.closes, 60);
        const ma120 = ma(k.closes, 120);
        const dev = avgDev(close, ma60, ma120);
        let above = 0, below = 0;
        if (ma60 !== null) {
          for (let i = k.closes.length - 1; i >= 59; i--) {
            const m = k.closes.slice(i - 59, i + 1).reduce((a, b) => a + b, 0) / 60;
            if (k.closes[i] >= m) { if (below === 0) above++; else break; } else { if (above === 0) below++; else break; }
          }
        }
        const users = [...new Set(stockJobs.filter(j => j.code === code).map(j => j.userId))];
        for (const userId of users) {
          const st = states.find((s: any) => s.user_id === userId);
          const arr = (st.data && st.data.stocks) || [];
          const s = arr.find((x: any) => String(x.code || '').trim() === code) || {};
          const ret = stockReturn(s, close);
          // 持仓概览累加：市值 = 份额 × 今夜收盘（没填份额就不计，避免把 0 混进收益率）
          const sShare = Number(s.shares) || 0;
          const sMv = (sShare > 0 && close > 0) ? sShare * close : 0;
          if (sMv > 0) {
            const scost = holdingCostOf(parseFloat(s.cost) || 0, sShare, sMv, close);
            const ag = (stockHold[userId] = stockHold[userId] || { mv: 0, cost: 0, n: 0, nCost: 0 });
            ag.mv += sMv;
            ag.cost += scost;
            ag.n += 1;
            if (scost > 0) ag.nCost += 1;
          }
          const tier = baseSignalLabel(dev);
          const tiers = (s.profitTiers && s.profitTiers.length) ? s.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) { for (const t of tiers) { if (ret >= t.ret && !(s.profitTaken || []).includes(t.ret)) newTier = t.ret; } }

          stockSignalRows.push({ user_id: userId, code, tier: tier.label + (dev === null ? '（数据不足）' : ''), profit_tier: newTier, updated_at: new Date().toISOString() });

          const sname = s.name || k.name || '';
          const taken = s.profitTaken || [];
          const nextTier = tiers.find((x: any) => !taken.includes(x.ret)) || null;
          const sLadder = dipLadder(s, close, readPct(s));
          const sCostDip = stockDipAlert(s, ret, dev);
          const sGate = stockDipGate(sLadder, sCostDip, stockPadSet(s));
          // 2026-10-31 用户裁决：双腿（回撤达档 + 跌穿安全垫）齐备才进顶部抄底横幅，与页面同判据
          if (sGate.light) (stockDips[userId] = stockDips[userId] || []).push({ code, name: sname || code, ...sCostDip! });
          // 手数：A股主板固定 100；港股按标的读（腾讯行情），取不到再回落页面同步来的 lotSize，仍无则不给金额
          const lotSize = /^\d{5}$/.test(code) ? ((await fetchHkLot(code)) || Number(s.lotSize) || 0) : 100;
          const addPlan = sLadder ? stockAddPlan(sMv, close, sLadder.add, lotSize) : null;
          const sell = sellAlert(ret, s);
          const sellPlan = sell ? stockSellPlan(sShare, close, sell.tier.sell, lotSize) : null;
          (stockReport[userId] = stockReport[userId] || []).push({
            code, name: sname || code, close, date: k.date, dev, ma60, ma120, below,
            tier: tier.label + (dev === null ? '（数据不足）' : ''), ret, nextTier,
            sell, sellPlan, ladder: sLadder, addPlan, costDip: sCostDip,
            dipLight: sGate.light, padMissing: sGate.needPad, dipShout: sGate.shout
          });

          await post('stock_history', 'user_id,code,price_date', [{ user_id: userId, code, price_date: k.date, close, ma20, ma60, ma120, dev_pct: dev }]);
          await post('stock_latest', 'user_id,code', [{
            user_id: userId, code, name: sname || null, close, price_date: k.date, ma20, ma60, ma120, dev_pct: dev,
            below_streak: below, updated_at: new Date().toISOString()
          }]);
        }
        summary.stocks.push({ code, ok: true, date: k.date, close });
      } catch (e) {
        const msg = String((e as any)?.message || e).slice(0, 140);
        logFailure('取数', '股票 ' + code + ' 行情获取失败', e);
        summary.stocks.push({ code, ok: false, error: msg });
        const errUsers = [...new Set(stockJobs.filter(j => j.code === code).map(j => j.userId))];
        for (const uid of errUsers) {
          const stt = states.find((s: any) => s.user_id === uid);
          const arr = (stt && stt.data && stt.data.stocks) || [];
          const rec = arr.find((x: any) => String(x.code || '').trim() === code);
          const nm = (rec && rec.name) || '';
          (stockReport[uid] = stockReport[uid] || []).push({ fetchError: '【' + code + (nm ? ' ' + nm : '') + '】行情抓取失败：' + msg + '（本次未纳入分析，下次运行会自动重试；若持续失败请核对该代码是否为有效 A股6位/港股5位）' });
        }
      }
    }

    // 5. 股票总仓位上限提醒
    for (const st of states) {
      const userId = st.user_id;
      const arr = (st.data && st.data.stocks) || [];
      if (!arr.length) continue;
      const cap = parseFloat(st.data.stockCap) || 0;
      if (!cap) continue;
      let total = 0;
      for (const s of arr) {
        const code = String(s.code || '').trim();
        const lx = summary.stocks.find((x: any) => x.code === code && x.ok);
        const px = lx ? lx.close : (parseFloat(s.currentPrice) || 0);
        total += (parseFloat(s.shares) || 0) * px;
      }
      const over = total > cap;
      const prevRes = await fetch(sbUrl + '/rest/v1/stock_signal_state?select=code,tier&user_id=eq.' + userId + '&code=eq.__STOCK_CAP__', { headers: H });
      const prevArr: any[] = prevRes.ok ? await prevRes.json() : [];
      const wasOver = prevArr.length ? prevArr[0].tier === 'over' : false;
      stockSignalRows.push({ user_id: userId, code: '__STOCK_CAP__', tier: over ? 'over' : 'ok', profit_tier: null, updated_at: new Date().toISOString() });
      if (over && !wasOver) {
        (stockReport[userId] = stockReport[userId] || []).push({ capAlert: '股票总仓位 ¥' + Math.round(total).toLocaleString() + ' 已超过总额上限 ¥' + Math.round(cap).toLocaleString() + '，建议暂停买入' });
      }
    }

    // 5b. 股票侧信号落库（2026-10-27 补）：上面 :685/:735 一直在往 stockSignalRows push，
    // 但全函数从未 post —— 表恒为空 ⇒ :733 读回的 wasOver 永远 false ⇒ 仓位超限提醒每夜重复发一次。
    // 这里补上写库；失败自吞（不致命），因为邮件才是第一交付物。
    try {
      await post('stock_signal_state', 'user_id,code', stockSignalRows);
    } catch (e) {
      logFailure('写库', 'stock_signal_state 落库失败（本次跳过，明日重试，不影响邮件）', e);
    }

    mark('write');
    console.log('[daily-update][计时] ' + timings.join(' | '));

    // 6. 分析报告 + 与昨日信号对比的变化提醒 + 邮件
    for (const userId of new Set([...Object.keys(fundReport), ...Object.keys(stockReport), ...Object.keys(invalidStocks)])) {
      const st = states.find((s: any) => s.user_id === userId);
      const items: string[] = [];

      // 将“代码无效”的股票并入告警，确保误填代码不再被静默丢弃
      for (const iv of (invalidStocks[userId] || [])) {
        (stockReport[userId] = stockReport[userId] || []).push({ fetchError: '【' + iv.code + (iv.name ? ' ' + iv.name : '') + '】代码格式无效（应为 A股6位/港股5位纯数字），未能获取行情，请在股票页修正' });
      }
      const stockWarnCount = (stockReport[userId] || []).filter((r: any) => r.fetchError).length;
      if (stockWarnCount > 0) items.push('⚠️ 有 ' + stockWarnCount + ' 只股票行情获取异常，详见下方股票分析');

      // 6a. 与昨日 signal_state 对比：基金常规信号变化
      const todayRows = fundSignalRows.filter(r => r.user_id === userId);
      const prevRes = await fetch(sbUrl + '/rest/v1/signal_state?select=code,label&user_id=eq.' + userId, { headers: H });
      const prev: any[] = prevRes.ok ? await prevRes.json() : [];
      const prevMap: Record<string, string> = {};
      prev.forEach((p: any) => prevMap[p.code] = p.label);
      const isFirstRun = prev.length === 0;
      const stateRows = todayRows.map(r => ({ user_id: userId, code: r.code, label: r.label, profit_tier: r.profit_tier, benchmark: r.benchmark, updated_at: new Date().toISOString() }));
      await post('signal_state', 'user_id,code', stateRows);
      for (const r of stateRows) {
        const p = prevMap[r.code];
        const curBase = String(r.label).split('｜')[0];
        const prevBase = p ? String(p).split('｜')[0] : null;
        const meta = fundMeta[r.code];
        const nameStr = meta && meta.name ? ' ' + meta.name : '';
        if (p && prevBase !== curBase) items.push('【' + r.code + nameStr + '】基金信号变化：' + prevBase + ' → <b>' + curBase + '</b>');
      }

      // 6b. 指数档位变化
      const idxPrevRes = await fetch(sbUrl + '/rest/v1/index_state?select=idx_code,label', { headers: H });
      const idxPrev: any[] = idxPrevRes.ok ? await idxPrevRes.json() : [];
      const idxPrevMap: Record<string, string> = {};
      idxPrev.forEach((p: any) => idxPrevMap[p.idx_code] = p.label);
      const idxRows: any[] = [];
      for (const k of Object.keys(idxLevels)) {
        if (idxPrevMap[k] && idxPrevMap[k] !== idxLevels[k].label) items.push('大盘参考：' + BENCH[k].name + ' 档位变化 ' + idxPrevMap[k] + ' → <b>' + idxLevels[k].label + '</b>');
        idxRows.push({ idx_code: k, label: idxLevels[k].label, updated_at: new Date().toISOString() });
      }
      if (idxRows.length) await post('index_state', 'idx_code', idxRows);

      // 6b-补. 指数腿挂掉时逐名报出：只落一个 index_fail 计数，用户会把昨天的档位当今天的。
      // 系数取 bl 缺失时的 1，所以后果必须写明白——不是"沿用上次"，是"本次不打折"。
      const benchFailed: Record<string, string> = {};
      for (const it of summary.indices) if (it && it.ok === false) benchFailed[it.idx] = it.error || '未知原因';
      const myFailedBench = [...new Set(todayRows.map((r: any) => r.benchmark).filter((b: string) => !!benchFailed[b]))];
      for (const k of myFailedBench) {
        items.push('⚠️ 大盘参考：' + BENCH[k].name + ' 本次获取失败（' + benchFailed[k]
          + '），档位未更新，本次买入系数按 1 计（不打折）');
      }

      summary.notifications.push({ userId: userId.slice(0, 8), items: items.length, sent: false });

      // 6c. 组装分析报告邮件：信号 → 状态 → 趋势 → 操作
      const dateStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const title = isFirstRun ? '定投分析报告（首次启用）' : (items.length ? '定投分析报告 · ' + items.length + ' 条信号变化' : '定投分析报告 · 信号平稳');

      const fundBlock = (fundReport[userId] || []).map(r => {
        const zone = r.dev === null ? '数据不足' : (r.dev <= -15 ? '深度低位' : r.dev <= -5 ? '低位区' : r.dev < 3 ? '中性区间' : r.dev < 10 ? '偏高区' : '明显高位');
        const benchmarkStr = r.benchmarkLevel ? '｜基准 ' + r.benchmarkName + ' ' + r.benchmarkLevel : '';
        // 均线腿下一档：把偏离度边界换算成具体净值触发价（基金档位只由均线腿决定）
        let buyNextStr = '';
        if (r.dev !== null && r.ma60 && r.ma120) {
          const maAvg = (r.ma60 + r.ma120) / 2;
          if (r.dev < -15) buyNextStr = '｜均线腿已在最深档';
          else if (r.dev < -5) buyNextStr = '｜均线腿下一档：净值跌至 ' + (maAvg * 0.85).toFixed(4) + '（-15% 档）';
          else if (r.dev < 3) buyNextStr = '｜均线腿下一档：净值跌至 ' + (maAvg * 0.95).toFixed(4) + '（-5% 档）';
          else buyNextStr = '｜均线腿回归中性：净值回落至 ' + (maAvg * 1.03).toFixed(4) + '（+3% 内）';
        }
        const statusStr = '净值 ' + r.nav + '（' + r.navDate + '）｜较均线 ' + (r.dev === null ? '--' : fmtSigned(r.dev)) + '（' + zone + '）' + (r.streak !== null ? '｜连续 ' + r.streak + ' 日站上60日线' : '') + benchmarkStr + buyNextStr;
        // 动作文案按档位标签走：基金档位由均线偏离单腿决定（2026-10-28 起估值分位已下线）
        let actionStr: string;
        if (r.label.includes('QDII溢价')) actionStr = '溢价率过高，暂停买入，等待溢价回落';
        else if (r.label.includes('仓位超限')) actionStr = '主题仓位已达上限，停止买入该主题；浮盈可按止盈档分批兑现';
        else if (r.label === '暂停中') actionStr = '当前处于非定投状态，恢复条件满足时系统会提醒你';
        else if (r.resumeReady) actionStr = '恢复条件已满足，可恢复定投';
        else if (r.label === '暂停') actionStr = '停止加码，浮盈分批止盈锁定收益';
        else if (r.label === '减半') actionStr = '放缓定投节奏，关注止盈档位';
        else if (r.label === '双倍') actionStr = '加大买入，积极拉低成本';
        else if (r.label === '加强') actionStr = '维持或加大定投节奏';
        else if (r.dev === null) actionStr = '自动获取净值/均线数据后即可分析';
        else actionStr = '按计划定投，持有不动';
        // 已达档时不再写「下一止盈档」：nextTier 取的是第一个未执行档，+60% 时会写成 +20%，与上方卖出标志自相矛盾
        const tierNote = r.sell ? '｜已达到 +' + r.sell.tier.ret + '% 止盈档'
          : (r.nextTier ? '｜下一止盈档 +' + r.nextTier.ret + '%（卖' + r.nextTier.sell + '%）' : '｜各止盈档已执行完毕');
        const profitStr = r.ret === null ? '' : ('当前收益率 ' + fmtSigned(r.ret) + tierNote);
        return '<li style="margin:12px 0;padding:10px 12px;background:#FAF8F2;border-radius:8px;">'
          + '<b>【' + r.code + '】' + r.name + '</b> ' + retChipHtml(r.ret)
          + sellMarkHtml(r.sell)
          + buyMarkHtml(r.multiplier > 0 ? r.ladder : null)
          + '<div style="margin:4px 0;">📊 信号：<b style="color:#A87C2E;">' + r.label + '</b>' + (r.multiplier > 0 && r.amount > 0 ? ' · 本期建议买入 <b>¥' + r.amount + '</b>/期' : ' · 暂停买入') + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">📈 ' + statusStr + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">💰 ' + profitStr + '</div>'
          + '<div style="margin-top:4px;">👉 ' + actionStr + '</div>'
          + '</li>';
      }).join('');

      const stockBlock = (stockReport[userId] || []).map(r => {
        if (r.fetchError) return '<li style="margin:12px 0;padding:10px 12px;background:#B14A341A;border-radius:8px;color:#B14A34;">⚠️ ' + r.fetchError + '</li>';
        if (r.capAlert) return '<li style="margin:12px 0;padding:10px 12px;background:#B14A341A;border-radius:8px;color:#B14A34;">⚠️ ' + r.capAlert + '</li>';
        const zone = r.dev === null ? '数据不足' : (r.dev <= -15 ? '深度低位' : r.dev <= -5 ? '低位区' : r.dev < 3 ? '中性区间' : r.dev < 10 ? '偏高区' : '明显高位');
        let actionStr: string;
        if (r.dev === null) actionStr = '等待行情数据';
        else if (r.dev <= -15) actionStr = '深度低位，可分批买入拉低成本';
        else if (r.dev <= -5) actionStr = '低位区，可考虑分批买入';
        else if (r.dev < 3) actionStr = '持有观察';
        else if (r.dev < 10) actionStr = '偏高区，不再追高，关注止盈档';
        else actionStr = '明显高位，浮盈分批止盈锁定收益';
        const trendStr = r.ma60 ? (r.below > 0 ? '已连续 ' + r.below + ' 日低于60日线' : (r.above > 0 ? '已连续 ' + r.above + ' 日站上60日线' : '')) : '';
        const tierNote = r.sell ? '｜已达到 +' + r.sell.tier.ret + '% 止盈档'
          : (r.nextTier ? '｜下一止盈档 +' + r.nextTier.ret + '%（卖' + r.nextTier.sell + '%）' : '');
        const profitStr = r.ret === null ? '' : ('当前收益率 ' + fmtSigned(r.ret) + tierNote);
        // 灯灭时回撤事实仍要如实写出，并点名缺的是哪一腿（2026-10-31 裁决：双腿齐备才亮，缺数据不许静默）
        const legNote = (r.ladder && !r.dipLight)
          ? ('｜较52周高点回撤 ' + r.ladder.dd.toFixed(1) + '% 已达 +' + r.ladder.add + '% 档，'
            + (r.padMissing ? '但未设目标跌幅安全垫（请到页面股票卡片补填）' : '但收益未跌穿成本安全垫')
            + '——抄底需双腿齐备')
          : '';
        return '<li style="margin:12px 0;padding:10px 12px;background:#FAF8F2;border-radius:8px;">'
          + '<b>【' + r.code + '】' + r.name + '</b> ' + retChipHtml(r.ret)
          + sellMarkHtml(r.sell, r.sellPlan)
          + buyMarkHtml(r.dipShout ? r.ladder : null, r.dipShout ? r.addPlan : null)
          + '<div style="margin:4px 0;">📊 买入参考：<b style="color:#A87C2E;">' + r.tier + '</b> · 现价 ' + r.close + '（' + r.date + '）</div>'
          + '<div style="color:#707C8C;font-size:13px;">📈 较均线 ' + (r.dev === null ? '--' : fmtSigned(r.dev)) + '（' + zone + '）' + (trendStr ? '｜' + trendStr : '')
          + (r.costDip ? '｜收益 ' + fmtSigned(r.costDip.ret) + ' 已跌破 ' + String(r.costDip.target) + '% 成本安全垫' : '') + legNote + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">💰 ' + profitStr + '</div>'
          + '<div style="margin-top:4px;">👉 ' + actionStr + '</div>'
          + '</li>';
      }).join('');

      const html = '<div style="font-family:-apple-system,PingFang SC,Arial;max-width:600px;margin:0 auto;font-size:14px;color:#1B2436;line-height:1.7;">'
        + '<h2 style="font-size:18px;border-bottom:2px solid #A87C2E;padding-bottom:8px;">定投信号台 · ' + title + '</h2>'
        + '<p style="color:#707C8C;">' + dateStr + ' 收盘数据已自动更新</p>'
        + resumeBannerHtml(fundResume[userId] || [])
        + dipBannerHtml([...(fundDips[userId] || []), ...(stockDips[userId] || [])])
        + holdingsSummaryHtml(fundHold[userId] || null, stockHold[userId] || null, dateStr)
        + (items.length
          ? '<h3 style="font-size:16px;margin:20px 0 12px;">📢 今日重要提醒</h3><ul style="padding-left:18px;margin:12px 0;">' + items.map(i => '<li style="margin:8px 0;">' + i + '</li>').join('') + '</ul>'
          : '<p style="color:#3F8A68;">✅ 今日无信号变化，各资产按计划执行即可。</p>')
        + '<h3 style="font-size:16px;margin:20px 0 12px;">📊 基金分析</h3>'
        + (fundBlock ? '<ul style="padding-left:0;list-style:none;">' + fundBlock + '</ul>' : '<p style="color:#707C8C;">暂无基金</p>')
        + '<h3 style="font-size:16px;margin:20px 0 12px;">💹 股票分析</h3>'
        + (stockBlock ? '<ul style="padding-left:0;list-style:none;">' + stockBlock + '</ul>' : '<p style="color:#707C8C;">暂无股票（可在股票标签页添加）</p>')
        + '<div style="background:#F1EDE3;padding:14px;border-radius:8px;margin:16px 0;font-size:13px;">'
        + '<b>📖 信号规则速查</b>：双倍/加强 = 加大买入拉低成本｜正常 = 按计划定投｜减半/暂停 = 少买或停买<br>'
        + '档位 = 均线偏离 + 估值百分位两腿合成，与页面同口径；QDII溢价 / 主题仓位超限 / 手动暂停可覆盖档位<br>'
        + '止盈档位达到时系统会提醒分批卖出；大盘参考指数升至高位会降低买入系数。'
        + '</div>'
        + '<p style="color:#707C8C;font-size:12px;">本邮件由定投信号台自动发送 · 每日 22:30（北京时间）自动更新</p>'
        + '</div>';

      if (items.length > 0 || isFirstRun || force) {
        try {
          await deps.sendMail('【定投信号台】' + title + ' - ' + dateStr, html);
          summary.notifications[summary.notifications.length - 1].sent = true;
        } catch (e) {
          logFailure('发信', '用户 ' + userId + ' 报告邮件发送失败', e);
          summary.notifications[summary.notifications.length - 1].mailError = String((e as any)?.message || e).slice(0, 200);
        }
      }
    }

    summary.ok = true;
    summary.at = new Date().toISOString();
    mark('mail');
    console.log('[daily-update][计时] 全链 ' + timings.join(' | '));
    await logRun('ok');
    summary.timings = timings;
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    logFailure('致命', 'nightly 任务异常终止', e);
    console.log('[daily-update][计时] 未完成 ' + timings.join(' | ') + ' | 已耗时 ' + (Date.now() - T0) + 'ms');
    await logRun('error', String((e as any)?.message || e));
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e).slice(0, 200), timings }), { status: 500 });
  }
}

if (!Deno.env.get('DAILY_UPDATE_DISABLE_SERVE')) {
  Deno.serve((req: Request) => handle(req));
}
