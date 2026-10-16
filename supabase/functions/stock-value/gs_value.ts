// gs_value.ts — GS 列式宽表 → ValueRaw[]。规则权威：spec §2（P-1..P-8）/§2.1（批次编排）
// 列名一律按前缀匹配，绝不硬编码日期戳（GS 的戳随快照漂移）；窗口列按字典序 = 时间序。
export type GsTable = Record<string, (string | number | null)[]>;

export function yearAnchors(now: Date): { annualBase: number } {
  return { annualBase: now.getMonth() + 1 >= 5 ? now.getFullYear() - 1 : now.getFullYear() - 2 };
}

// spec §2.1：V_Q3 独占历史窗口（P-4 混提会把三表科目戳整体改写成年报）；
// V_Q4 独占估值列（P-3 九字段大查询里 PE/PB 整列被丢弃）。
export const V_Q1 = '全部沪深A股的投入资本回报率、股票简称、所属同花顺行业、股票市场类型';
export const V_Q2 = '全部沪深A股的企业自由现金流量fcff、货币资金、带息债务、商誉占净资产比例、股票简称';
export const buildVQ3 = (b: number): string =>
  `全部沪深A股的${b - 2}年报投入资本回报率、${b - 1}年报投入资本回报率、${b}年报投入资本回报率、股票简称`;
export const V_Q4 = '全部沪深A股的市盈率、市净率、总市值、股票简称';
export const V_Q5 = '全部沪深A股的股息率、近5年股息率平均值、净资产收益率roe(摊薄)、股票简称';  // 4 字段，仍在 P-3 安全区内

const BASE = 'https://dgzt.guosen.com.cn/skills/agent/mcp/smart_stock_picking';

export async function gsValueFetch(query: string, apiKey: string, timeoutMs = 150_000): Promise<GsTable> {
  const qs = new URLSearchParams({ searchstring: query, searchtype: 'stock', softName: 'goldsun_skills', skillName: 'gs-smart-stock-picking', apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const j = await r.json();
      if (j?.result?.[0]?.code !== 0) throw new Error(`GS biz code=${j?.result?.[0]?.code}`); // 不带 msg 原文
      const t = j?.data?.[0]?.table as GsTable | undefined;
      if (!t?.['股票代码']) throw new Error('GS table missing');
      return t;
    } catch (e) {
      // TypeError.message 含完整 URL（带 apiKey）→ 折叠（同 stock-score/gs.ts 先例）
      lastErr = e instanceof TypeError ? new Error(`GS network error (attempt ${attempt + 1})`) : e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// 列标签 = 去掉 `[数据日期]` 后缀后的列名。GS 在同一张表里并存兄弟列（`股息率` / `股息率平均`、
// `资产负债率` / `资产负债率同比增长率`、`净资产收益率` / 加权公布值），裸 `find(k => k.startsWith(prefix))`
// 的胜负押在响应键序上（真快照键序明显非字典序）→ 会静默绑错列；更糟的是 REQUIRED 守卫会被兄弟列单独满足，
// 目标列整列缺失也能过 P-3、静默跑完整夜（V1.1 `gs.ts:211-212` 就是这么实炸过的）。
const labelOf = (k: string): string => k.replace(/\[.*$/, '');
export function colByPrefix(t: GsTable, prefix: string): string | undefined {
  const keys = Object.keys(t);
  const exact = keys.find(k => labelOf(k) === prefix);
  if (exact) return exact;
  // 无全等标签时才退到前缀，且只接受“前缀后接的不是中文后缀”：`市盈率` → `市盈率(pe)` 是同一指标的括号别名（收），
  // `股息率` → `股息率平均` 是另一个指标（拒）。候选多个则取标签最短，再用列名字典序兜底——决定性，绝不返回“响应里第一个”。
  return keys
    .filter(k => labelOf(k).startsWith(prefix) && !/^[\u4e00-\u9fff]/.test(labelOf(k).slice(prefix.length)))
    .sort((a, b) => labelOf(a).length - labelOf(b).length || (a < b ? -1 : 1))[0];
}
// 提问措辞与响应标签不保证一致（V_Q5 问的是「近5年股息率平均值」，探针形态是 `股息率平均[...]`）→ 按候选依次试。
const colAnyOf = (t: GsTable | null, names: string[]): string | null =>
  t ? names.map(n => colByPrefix(t, n)).find(Boolean) ?? null : null;
// 严格窗口列 `名称…[yyyyMMdd…]`：排除 "资产负债率同比增长率" 这类同名前缀兄弟列。
// 【2026-10-12 首跑实炸后重写】旧写法 `k.startsWith(name + '[')` 要求名称与戳**紧邻**，而真响应在两者之间
// 夹了英文别名：ROIC 列回 `投入资本回报率roic[20260630]`。colByPrefix 收它（别名以非中文开头），windowCols
// 不收 → assertCols 放行、assertPeriod 一根不认 → 整批 500。两个匹配器必须同一套规则，否则「守卫放行、
// 主逻辑失明」这条路径永远测不到。严格性由「拒绝中文后缀兄弟列 + 必须有 8 位数字戳」两点继续提供，
// 不因允许英文别名而放宽。
export function windowCols(t: GsTable, name: string): string[] {
  return Object.keys(t).filter(k => {
    const l = labelOf(k);
    if (!l.startsWith(name)) return false;
    const rest = l.slice(name.length);
    if (rest.length > 0 && /^[\u4e00-\u9fff]/.test(rest)) return false;   // 中文后缀 = 另一个指标
    return /\[\d{8}/.test(k.slice(l.length));
  }).sort();
}

// 同一指标的「单期年报列族」：按标签前缀取，排除平均值专用列（标签含 `平均`）与区间戳列（`[a-b]`），
// 按戳升序 = 时间升序。真响应的键序是乱的，字典序取首个会绑到最旧一期（见 Task 6B 探针注）。
export function annualCols(t: GsTable, labelPrefix: string, requireAnnualOnly = false): string[] {
  return Object.keys(t)
    .filter(k => {
      const l = labelOf(k);
      return l.startsWith(labelPrefix) && !l.includes('平均') && /^\[\d{8}\]$/.test(k.slice(l.length))
        && (!requireAnnualOnly || stampOf(k).endsWith('1231'));   // 终审 I-4：q3 ROIC 锤死 1231，q5 此前不验 → 中报累计值冒充年报
    })
    .sort((a, b) => {
      if (stampOf(a) !== stampOf(b)) return stampOf(a) < stampOf(b) ? -1 : 1;
      return labelOf(a) < labelOf(b) ? -1 : labelOf(a) > labelOf(b) ? 1 : 0;   // 同戳多别名 → 按标签破平局，绝不依赖响应插入序
    });
}

const num = (v: string | number | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/,/g, '').trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null; // 文本列 / 带百分号列一律 NA
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (v: string | number | null | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export type BatchName = 'q1' | 'q2' | 'q3' | 'q4' | 'q5';
// q3 的列族守卫同时依赖两件事实（Task 2 执行时定形）：① 响应列名为 `投入资本回报率[yyyyMMdd]`（仓内实探针铁证，见 Fixture 注）；
// ② 「恰好 3 根窗口列」守卫在 assertCols 之后把关，缺任一根 → 数量≠3 → 整批拒绝（与 V1.1 roe3y 同纪律）。
const REQUIRED: Record<BatchName, string[]> = {
  q1: ['股票代码', '股票简称', '投入资本回报率', '所属同花顺行业', '股票市场类型'],
  q2: ['股票代码', '企业自由现金流量fcff', '货币资金', '带息债务', '商誉占净资产比例'],
  q3: ['股票代码', '投入资本回报率'],
  q4: ['股票代码', '市盈率', '市净率', '总市值'],
  // 本表能拦住“当期股息率整列缺失”全靠 colByPrefix 的全等标签优先：裸前缀下 `股息率平均` 会单独满足它。
  // ROE 列必须同行把关（Task 3 实测：上游不传 roe 时低 ROE 银行仅凭价格腿过关）——这条静默路径靠「缺列→整批炸」守。
  // 2026-10-11 真响应铁证：列名是 `净资产收益率roe(摊薄,公布值)[yyyyMMdd]`。守卫前缀必须截在 `摊薄`、
  // 不带右括号，否则 colByPrefix 两条通道都不收 → 整夜零产出（Task 6B 的杀手回归）。`股息率` 裸前缀仍安全：
  // 兄弟列 `股息率平均` 的下一字是中文 → 被下面的“中文后缀拒绝”规则挡掉。
  q5: ['股票代码', '股息率', '净资产收益率roe(摊薄'],
};
export function assertCols(t: GsTable, fam: BatchName): void {
  for (const name of REQUIRED[fam]) if (!colByPrefix(t, name)) throw new Error(`GS ${fam} missing column: ${name}`);
}

const stampOf = (key: string): string => key.match(/\[(\d{8})/)?.[1] ?? '';
// 合法报告期只有四种；其余一律拒（乱戳比放行危险得多）。
const PERIOD_MD = new Set([331, 630, 930, 1231]);

// P-4 双守卫：① 同批绝对值列必须共用一个戳（混提会整体改写）；② 戳必须落在合法报告期窗口
export function assertPeriod(t: GsTable, names: string[], now: Date): string {
  const stamps = new Set<string>();
  for (const n of names) for (const k of windowCols(t, n)) { const s = stampOf(k); if (s) stamps.add(s); }
  if (stamps.size === 0) throw new Error('GS period: no dated column found');
  if (stamps.size > 1) throw new Error(`GS period mismatch: ${[...stamps].sort().join(',')}`);
  const s = [...stamps][0];
  const y = Number(s.slice(0, 4)), mmdd = Number(s.slice(4));
  const base = yearAnchors(now).annualBase;
  // 年报可以是 base 年（已披露）或 base+1 年（提前回下年报）；一季/中/三季报告必然属 base+1 年。
  // `mmdd === 331` 必须在内：5 月中至 8 月底 GS 的绝对值列只回 `[yyyy0331]`，原写法（只认 630/930）
  // 会把全年约 1/3 的夜晚拒成炸批零产出。
  const ok = PERIOD_MD.has(mmdd) && (mmdd === 1231 ? y === base || y === base + 1 : y === base + 1);
  if (!ok) throw new Error(`GS period not in allowed window: ${s} (annualBase=${base})`);
  return s;
}

export interface ValueRaw {
  code: string; name: string; ths: string[]; isFin: boolean; isST: boolean;
  // `roic` = 当期 ROIC = 最近一期**年报**值（恒等于 roic3[2]，见 mergeValueTables 内决议 27 注），非中报累计。
  roic: number | null; roic3: (number | null)[];
  fcff: number | null; cash: number | null; debt: number | null; gw: number | null;
  pe: number | null; pb: number | null; mktcap: number | null;
  divYield: number | null; divY5y: number | null;
  // 金融股否决4 的 ROE 对标列（spec §4 附注）。必填：引擎只经 computeValue 的 finRoe 参数读它，从不读 r.roe，
  // 但字段的存在把“上游有没有取 ROE”变成编译期事实，而不是运行时静默降级。
  roe: number | null;
}

export function mergeValueTables(
  t1: GsTable, t2: GsTable, t3: GsTable, t4: GsTable, t5: GsTable | null,
  now: Date = new Date(),
): { rows: ValueRaw[]; stamps: Record<string, string> } {
  assertCols(t1, 'q1'); assertCols(t2, 'q2'); assertCols(t3, 'q3'); assertCols(t4, 'q4');
  if (t5) assertCols(t5, 'q5');
  const stamp2 = assertPeriod(t2, ['货币资金', '带息债务', '企业自由现金流量fcff', '商誉占净资产比例'], now);
  const codes = t1['股票代码'] as string[];
  if ((t3['股票代码'] as string[]).length !== codes.length) throw new Error('GS q3 row count differs from q1');
  const roic3Keys = windowCols(t3, '投入资本回报率');          // 已按戳升序 = 时间升序；与 V1.1 的 windowColsByPrefix 同口径
  if (roic3Keys.length !== 3) throw new Error(`GS q3 expected exactly 3 window columns, got ${roic3Keys.length}`);
  // “恰好 3 根”不保证是 3 根**年报**列：{20231231, 20241231, 20260630} 计数也是 3，roic3[2] 会装一期中报值冒充年报，
  // 相对 V1.1（另叠加 anchorsOk 新鲜度双通道）是弱化。锤死年份与期次，宁拒绝不错位。
  const base = yearAnchors(now).annualBase;
  const wantYears = [base - 2, base - 1, base].join(',');
  const gotYears = roic3Keys.map(k => stampOf(k).slice(0, 4)).join(',');
  if (roic3Keys.some(k => !stampOf(k).endsWith('1231')) || gotYears !== wantYears)
    throw new Error(`GS q3 expected 3 annual columns (${wantYears}@1231), got ${roic3Keys.map(stampOf).join(',')}`);
  const idx = (t: GsTable | null) => new Map(((t?.['股票代码'] as string[] | undefined) ?? []).map((c, i) => [c, i]));
  const i2 = idx(t2), i3 = idx(t3), i4 = idx(t4), i5 = t5 ? idx(t5) : null;
  // 【为什么当期 ROIC 不取 q1 那根（决议 27，2026-10-15 用户裁定「1」）】q1 的绝对值列随报告期漂移，中报季回
  // `投入资本回报率[yyyy0630]` = **期内累计、非年化**（铁证：生产 5026 行 roic_period 全为 20260630，且 roic_cur
  // 与自身最差年报的比值中位数 0.477、75.5% 的行低于自己最差年报）。否决4 拿它与**年化**阈值 ROIC_GATE=8 比
  // （value_engine.ts:63），于是 `med<8 && cur<8` 在中报季退化成单条件 `med<8`：「单低」（该留观察）被错杀成
  // tier=vetoed。改绑 q3 最近一根年报列 = 与上面 :169 和下面 q5 ROE 同一先例，代价是这条腿在中报季滞后半年
  // ——陈旧但正确，且「双双<8」重新是两个独立条件。q1 仍照旧提问、REQUIRED.q1 仍把关该列存在，只是不再绑值。
  const roicCurKey = roic3Keys[2];
  const K = {
    name: colByPrefix(t1, '股票简称')!, ths: colByPrefix(t1, '所属同花顺行业')!, mkt: colByPrefix(t1, '股票市场类型')!,
    fcff: colByPrefix(t2, '企业自由现金流量fcff')!, cash: colByPrefix(t2, '货币资金')!,
    debt: colByPrefix(t2, '带息债务')!, gw: colByPrefix(t2, '商誉占净资产比例')!,
    pe: colByPrefix(t4, '市盈率')!, pb: colByPrefix(t4, '市净率')!, mc: colByPrefix(t4, '总市值')!,
  };
  // 股息率 / ROE 在真响应里都是年报列族（5 根，键序乱）→ 按戳取最新一期；单列老形态同样命中（族里只有一根）。
  // 【为什么 q5 也要锤 1231】否决4 拿 `roe` 与 ROIC_GATE=8 这个**年化**阈值比（value_engine.ts:50-51）。
  // GS 若回 `净资产收益率roe(摊薄)[yyyy0630]`（H1 累计非年化），一只 H1 ROE 4.5%（年化约 9%，达标）的银行会被判
  // `med<8 && cur<8` → 无护城河证据 → tier=vetoed → 整个银行类出榜。此前 q3 会炸整夜、q5 静默落库，是不对称。
  // q5 是可选批，所以这里**剔出列族**（→ roe=null → 否决4 不判定）而不是炸批：宁缺一个判定，不做一个错判定。
  const dyKeys = t5 ? annualCols(t5, '股息率', true) : [];
  const roeKeys = t5 ? annualCols(t5, '净资产收益率roe(摊薄', true) : [];
  const dyCur = dyKeys.length > 0 ? dyKeys[dyKeys.length - 1] : null;
  const roeCur = roeKeys.length > 0 ? roeKeys[roeKeys.length - 1] : null;
  const dy5Col = colAnyOf(t5, ['股息率平均', '近5年股息率平均值', '近5年股息率']);   // GS 若回专用列优先用（2026-10 实测不回）
  const dy5Keys = dyKeys.slice(-5);   // 最新期起最多 5 根年报列
  const at = (t: GsTable, k: string, i: number): number | null => (i >= 0 ? num(t[k]?.[i]) : null);
  const rows: ValueRaw[] = codes.map((code, i) => {
    const j2 = i2.get(code) ?? -1, j3 = i3.get(code) ?? -1, j4 = i4.get(code) ?? -1, j5 = i5?.get(code) ?? -1;
    const name = str(t1[K.name]?.[i]);
    const mkt = str(t1[K.mkt]?.[i]);   // GS 分层标签串（';' 分隔）；缺 "全部A股(非ST)" 即视为该类
    return {
      code, name, ths: str(t1[K.ths]?.[i]).split('-'),
      isST: /ST|退/.test(name) || !mkt.includes('全部A股(非ST)'),
      isFin: !!mkt && !mkt.includes('全部A股(非金融)'),
      roic: at(t3, roicCurKey, j3),
      roic3: roic3Keys.map(k => at(t3, k, j3)),
      fcff: at(t2, K.fcff, j2), cash: at(t2, K.cash, j2), debt: at(t2, K.debt, j2),
      gw: at(t2, K.gw, j2),                                    // 空值语义①：商誉空 → 0（在引擎侧落地）
      pe: at(t4, K.pe, j4), pb: at(t4, K.pb, j4), mktcap: at(t4, K.mc, j4),
      // 空值语义②（三种空不可互换）：整批缺席 → NA；该批成功但表里无此行（j5<0）→ NA；行在而值空 → 0（从不分红）。
      // 原写法 `?? 0` 无行存在性门控，把“行缺席”折叠成“从不分红”，与 V1.1 的 momRowOk/strictWin 先行门控相反。
      divYield: !t5 || dyCur === null || j5 < 0 ? null : num(t5[dyCur]?.[j5]) ?? 0,
      divY5y: !t5 || j5 < 0 || (dy5Col === null && dy5Keys.length === 0) ? null
        : dy5Col !== null ? num(t5[dy5Col]?.[j5]) ?? 0
          : dy5Keys.reduce((a, k) => a + (num(t5[k]?.[j5]) ?? 0), 0) / dy5Keys.length,
      roe: !t5 || roeCur === null ? null : at(t5, roeCur, j5),    // 批次缺席 / 行缺席 → NA（否决4 不判定，不得归 0）
    };
  });
  const stamps: Record<string, string> = {
    fin_period: stamp2, val_period: stampOf(K.pe), roic_period: stampOf(roicCurKey),
  };
  if (dyCur) stamps.div_period = stampOf(dyCur);   // spec §8：q5 绑的是哪一期必须可见
  if (roeCur) stamps.roe_period = stampOf(roeCur); // 首夜若它不是 1231 结尾，ROE 就是非年化累计值 → 否决4 需重新裁定
  return { rows, stamps };
}
