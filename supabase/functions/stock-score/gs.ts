// GS（国信智能选股）宽表解析适配器：把列式（column-oriented）返回的批量表
// 归一化为 engine.ts 的 Stock[]。GS 列名内嵌数据日期戳（如 [20260924] /
// [20260703-20260924]），日期会随快照漂移，因此所有列一律按前缀匹配，
// 窗口列按起始日字典序（=时间序）取第 0 个 / 最后一个，绝不硬编码日期。
import type { Stock } from './engine.ts';

export type GsTable = Record<string, (string | number | null)[]>;

export const Q_FIN = '全部沪深A股的加权净资产收益率、归属母公司股东的净利润同比增长率、扣非净利润同比增长率、营业总收入同比增长率、销售毛利率、资产负债率、市盈率PE、所属同花顺行业';
export const Q_MOM = '全部沪深A股的60日涨跌幅、20日涨跌幅、最新收盘价、20日均价、60日均价、所属同花顺行业';

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  return Object.keys(t).find(k => k.startsWith(prefix));
}

// 同一指标的多个窗口列（列名内嵌 yyyyMMdd 起始日）按字典序 = 时间序升序：
// 最早起始日 = 长窗（60日），最晚起始日 = 短窗（20日）；单一列时首尾同为该列。
export function sortedWindowCols(t: GsTable, prefix: string): string[] {
  return Object.keys(t).filter(k => k.startsWith(prefix)).sort();
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
      lastErr = e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function mergeTables(fin: GsTable, mom: GsTable): Stock[] {
  const codes = (fin['股票代码'] as string[] | undefined) ?? [];
  const momCodes = (mom['股票代码'] as string[] | undefined) ?? [];
  const momIdx = new Map(momCodes.map((c, i) => [c, i]));
  const thsK = colByPrefix(fin, '所属同花顺行业');
  const mktK = colByPrefix(fin, '股票市场类型');
  const out: Stock[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = str(col(fin, '股票简称', i));
    // 市场类型是 GS 的分层标签串（';' 分隔），缺 "全部A股(非ST)" / "(非金融)" 标记即视为该类
    const mkt = mktK ? str(fin[mktK]?.[i]) : '';
    const j = momIdx.get(code) ?? -1;
    const momRowOk = j >= 0;
    out.push({
      code,
      name,
      ths: (thsK ? str(fin[thsK]?.[i]) : '').split('-'),
      roe: num(col(fin, '净资产收益率roe', i)),
      mlr: num(col(fin, '销售毛利率', i)),
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
    });
  }
  return out;
}
