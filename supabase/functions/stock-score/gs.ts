// GS（国信智能选股）宽表解析适配器：把列式（column-oriented）返回的批量表
// 归一化为 engine.ts 的 Stock[]。GS 列名内嵌数据日期戳（如 [20260924] /
// [20260703-20260924]），日期会随快照漂移，因此所有列一律按前缀匹配，
// 窗口列按起始日字典序（=时间序）取第 0 个 / 最后一个，绝不硬编码日期。
import type { Stock } from './engine.ts';

export type GsTable = Record<string, (string | number | null)[]>;

// V1.1 措辞（探针实证的最终版）：不写「销售毛利率同比增长率」——GS 会把同查询里
// 的销售毛利率/roe(摊薄) 当期列连带替换成同比增长率列（污染）；改用 2025年中报/
// 2025年报两个历史绝对值窗口列，mlrYoy 由适配器自行派生（与 GS 同比列逐位一致）。
// 现金流指标同理必须留在独立 Q_CASH（并入会被误解析成同比增长率列）。
export const Q_FIN = '全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、2023年报净资产收益率、2024年报净资产收益率、2025年报净资产收益率、近3年营业总收入复合增长率、2025年报销售毛利率、2025年中报销售毛利率、所属同花顺行业';
export const Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业';
export const Q_CASH = '全部沪深A股的经营活动产生的现金流量净额、归属于母公司所有者的净利润、股票简称';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}

// 同一指标的多个窗口列（列名内嵌 yyyyMMdd 起始日）按字典序 = 时间序升序：
// 最早起始日 = 长窗（60日），最晚起始日 = 短窗（20日）；单一列时首尾同为该列。
export function sortedWindowCols(t: GsTable, prefix: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(prefix)).sort();
}

// 严格窗口列：`名称[yyyyMMdd...]` 才入选，排除同名前缀的先兄弟列
// （销售毛利率同比增长率 / 归属于母公司所有者的净利润同比增长率等），
// mlrYoy 与 mlrDelta 是不同字段，绝不互换。仍按字典序 = 时间序升序。
export function windowColsByPrefix(t: GsTable, name: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(name + '[') && /^\d{8}/.test(k.slice(name.length + 1))).sort();
}

const num = (v: string | number | null | undefined): number | null => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);

const col = (t: GsTable, prefix: string, i: number) => {
  const k = colByPrefix(t, prefix);
  return k ? t[k]?.[i] ?? null : null;
};

// 按窗口前缀取第 idx 个窗口（0 = 最早起始日 = 长窗；idx 越界则回退到最后一个窗口）
const windowCol = (t: GsTable, prefix: string, i: number, idx: number): number | null => {
  const keys = sortedWindowCols(t, prefix);
  if (keys.length === 0) return null;
  const key = keys[Math.min(idx, keys.length - 1)];
  return num(t[key]?.[i]);
};
const lastWindowCol = (t: GsTable, prefix: string, i: number): number | null => {
  const keys = sortedWindowCols(t, prefix);
  if (keys.length === 0) return null;
  return num(t[keys[keys.length - 1]]?.[i]);
};

// 严格窗口列版本（同上纪律，但排除增长率先兄弟列）：idx=0 最早期，-1 最新期；
// 行索引越界 = 该 code 在此表无行 → null（优雅缺席，不 clamp 取值）
const strictWin = (t: GsTable, name: string, i: number, idx: number): number | null => {
  const keys = windowColsByPrefix(t, name);
  if (keys.length === 0) return null;
  const key = idx < 0 ? keys[keys.length + idx] : keys[Math.min(idx, keys.length - 1)];
  if (!key || i < 0 || i >= (t[key]?.length ?? 0)) return null;
  return num(t[key]?.[i]);
};

// 利润现金含量 = 经营现金流净额 ÷ 归母净利（各自窗口列最新值）；
// R-CASHNEG：分母≤0 时比值无经济意义 → null（Quality 缺腿由引擎 renorm 处理）
const cashRatio = (cf: number | null, np: number | null): number | null =>
  cf !== null && np !== null && np > 0 ? cf / np : null;

export async function gsFetch(query: string, apiKey: string, timeoutMs = 90_000): Promise<GsTable> {
  const qs = new URLSearchParams({
    searchstring: query,
    searchtype: 'stock',
    softName: 'goldsun_skills',
    skillName: 'gs-smart-stock-picking',
    apiKey,
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz ${JSON.stringify(j?.result?.[0])}`);
      const table = j?.data?.[0]?.table as GsTable | undefined;
      if (!table?.['股票代码']) throw new Error('GS table missing');
      return table;
    } catch (e) {
      // 网络错误（fetch 本身失败的 TypeError）的 message 可能内嵌含 apiKey 的完整 URL，
      // 脱敏为不含 URL 的通用信息后再保留；3 次重试用尽由末尾 throw lastErr 抛出。
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// 从严格窗口列名中取 yyyyMMdd 日期戳（'销售毛利率[20250630]' → 20250630）
const colDate = (key: string): number => Number(key.match(/\[(\d{8})/)?.[1] ?? NaN);
const mmdd = (d: number): number => d % 10000;

// cash = 独立第 3 次 GS 调用（Q_CASH）的原始值宽表；null/缺省 → Stock.cash 全 null
// （Task 6 编排接入前的兼容形态：两参调用照旧可用，缺失表现为 C 层风格优雅缺席）。
export function mergeTables(fin: GsTable, mom: GsTable, cash: GsTable | null = null): Stock[] {
  const codes = (fin['股票代码'] as string[] | undefined) ?? [];
  // 守卫：有数据行却缺失“股票市场类型”列时，下方 isST 判定会把全部股票静默标为 ST
  // （0 可用行且无报错）——在此 fail loudly，避免编排层拿到空宇宙。
  if (codes.length > 0 && !colByPrefix(fin, '股票市场类型')) {
    throw new Error('GS fin table missing 股票市场类型 column');
  }
  const momCodes = (mom['股票代码'] as string[] | undefined) ?? [];
  const momIdx = new Map(momCodes.map((c, i) => [c, i]));
  const cashCodes = (cash?.['股票代码'] as string[] | undefined) ?? [];
  const cashIdx = new Map(cashCodes.map((c, i) => [c, i]));
  const thsK = colByPrefix(fin, '所属同花顺行业');
  const mktK = colByPrefix(fin, '股票市场类型');

  // 销售毛利率三个绝对值窗口列（本期 / 上年同期 / 上年年报）按日期定位，不按下标猜测：
  // 本期=日期最大；上年同期=年份减一且月日相同；上年年报=日期最大的 12月31日列。
  const mlrKeys = windowColsByPrefix(fin, '销售毛利率').filter(k => Number.isFinite(colDate(k)));
  const mlrKeyOf = (i: number, pick: (ds: number[]) => number): number | null => {
    const dates = mlrKeys.map(colDate);
    const d = pick(dates);
    return Number.isFinite(d) ? num(fin[mlrKeys[dates.indexOf(d)]]?.[i]) : null;
  };
  const at = (i: number) => ({
    latest: mlrKeyOf(i, ds => Math.max(...ds)),
    prevYoy: mlrKeyOf(i, ds => {
      const y = Math.max(...ds);
      const want = (Math.floor(y / 10000) - 1) * 10000 + mmdd(y);
      return ds.filter(d => d === want)[0] ?? NaN;
    }),
    // 上年年报 = 日期严格早于本期的最近 12月31日列；若年报本身已成为本期列
    // （跑批撞上年报披露日）则不得用自身作差 → mlrDelta 退回 null 而非恒 0
    prevAnnual: mlrKeyOf(i, ds => {
      const y = Math.max(...ds);
      return ds.filter(d => mmdd(d) === 1231 && d < y).sort((a, b) => a - b).at(-1) ?? NaN;
    }),
  });

  // roe3y：近三年年报加权 ROE 窗口列，按日期升序（=[2023,2024,2025]，裁定 4）
  const roe3Keys = windowColsByPrefix(fin, '净资产收益率roe(加权,公布值)');
  const out: Stock[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = str(col(fin, '股票简称', i));
    // 市场类型是 GS 的分层标签串（';' 分隔），缺 "全部A股(非ST)" / "(非金融)" 标记即视为该类
    const mkt = mktK ? str(fin[mktK]?.[i]) : '';
    const j = momIdx.get(code) ?? -1;
    const momRowOk = j >= 0;
    const m = at(i);
    const k = cashIdx.get(code) ?? -1;
    const out2: Stock = {
      code,
      name,
      ths: (thsK ? str(fin[thsK]?.[i]) : '').split('-'),
      // 当期 ROE 严格取摊薄列（只写 '净资产收益率roe' 会被 3 年加权列误匹配）
      roe: num(col(fin, '净资产收益率roe(摊薄', i)),
      mlr: m.latest,
      kc: num(col(fin, '归属母公司股东的净利润-扣除', i)),
      gm: num(col(fin, '归属母公司股东的净利润(同比', i)),
      rev: num(col(fin, '营业总收入(同比', i)),
      debt: num(col(fin, '资产负债率', i)),
      pe: num(col(fin, '市盈率(pe)', i)),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      // 动量四字段全部经窗口列排序接线：涨跌幅长窗(起始日最早)→r60；
      // 均价长窗→a60、短窗(起始日最晚)→a20；收盘价取字典序最大的窗口。
      r60: momRowOk ? windowCol(mom, '区间涨跌幅:前复权', j, 0) : null,
      close: momRowOk ? lastWindowCol(mom, '区间收盘价', j) : null,
      a20: momRowOk ? lastWindowCol(mom, '区间成交均价', j) : null,
      a60: momRowOk ? windowCol(mom, '区间成交均价', j, 0) : null,
      // ---- V1.1 新增（缺列 → null/空数组，引擎侧走 NA renorm）----
      // 利润现金含量：独立第 3 次 GS 调用的两个原始值列最新窗口值之比
      cash: k >= 0
        ? cashRatio(
          strictWin(cash!, '经营活动产生的现金流量净额', k, -1),
          strictWin(cash!, '归属于母公司所有者的净利润', k, -1))
        : null,
      // mlrYoy：本期毛利率对上年同期（与 GS 同比列逐位一致的派生值）；与 mlrDelta 不同字段
      mlrYoy: m.latest !== null && m.prevYoy !== null && m.prevYoy !== 0
        ? (m.latest / m.prevYoy - 1) * 100 : null,
      // mlrDelta（R6 利润率恢复代理）：本期 − 上年年报，两者均非 null 才接线
      mlrDelta: m.latest !== null && m.prevAnnual !== null ? m.latest - m.prevAnnual : null,
      roe3y: roe3Keys.map(key => num(fin[key]?.[i])),
      // 裁定 1：取日期最新的窗口列（[20251231] = 2022→2025 年报 3 年 CAGR）
      cagr3: strictWin(fin, '营业总收入复合年增长率', i, -1),
    };
    out.push(out2);
  }
  return out;
}
