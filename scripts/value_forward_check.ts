/// <reference lib="deno.ns" />
// scripts/value_forward_check.ts —— 前视对照（只读）。规则权威：spec §8 前视验证 + §7.2 分歧榜
// 铁律：本脚本全程只 GET（数据库只读 + gtimg 行情），不写任何生产数据；不足 2 个季度的读数不具备判据力。
const TX_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const KLINE_LMT = 250;
const GAP_MS = 200;                     // 限流教训：逐 code 一次请求 + 200ms，绝不用东财 push2his 批量
type Bar = { day: string; close: number };
type ValLike = { code: string; group: string; baseDay?: string };

export function meanReturn(bars: Bar[], baseDay: string, n: number): number | null {
  if (!bars.length) return null;
  const key = baseDay.slice(0, 10);
  let i = bars.findIndex(b => b.day === key);
  if (i < 0) { for (let k = bars.length - 1; k >= 0; k--) if (bars[k].day <= key) { i = k; break; } }  // 取前一根为基准
  if (i < 0) return null;                               // 早于首根 → null（不猜基准价）
  const j = i + n;
  if (j >= bars.length || !(bars[i].close > 0) || !(bars[j].close > 0)) return null;   // 两端任一不可用→null（不得用 0 价算出 -100% 假读数）
  return (bars[j].close / bars[i].close - 1) * 100;
}

export function groupCompare(rows: ValLike[], barsOf: Map<string, Bar[]>, nDays: number)
: { group: string; mean: number | null; median: number | null; n: number; skipped: number }[] {
  const byG = new Map<string, number[]>(); const skip = new Map<string, number>();
  for (const g of new Set(rows.map(r => r.group))) byG.set(g, []);   // 全组无读数也要出行（报告要看见 n=0）
  for (const r of rows) {
    const bars = barsOf.get(r.code) ?? [];
    const m = bars.length ? meanReturn(bars, r.baseDay ?? bars[0].day, nDays) : null;
    if (m === null) { skip.set(r.group, (skip.get(r.group) ?? 0) + 1); continue; }   // 不计入 n，不拉低均值
    byG.get(r.group)!.push(m);
  }
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  return [...byG.entries()].map(([group, xs]) => ({
    group, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    median: xs.length ? med(xs) : null, n: xs.length, skipped: skip.get(group) ?? 0,
  }));
}

// 分位重算（与前端 divergeLists 同公式；前端块靠 new Function 抽取，无法在 Deno import，故本文件重写一份）
// 【同公式两处实现】本函数与前端 divergeLists 的过滤器/阈值必须逐字对齐：两边取的是同一个总体（池内 + A 级 + 两分齐备，见 forwardUniverse），
// 前视对照测的才正是页面展示的那一批。控制方 pre-flight 补的 `confidence==='A'` 过滤就是这条对齐。
function pctMap(xs: number[]): Map<number, number> {
  const s = [...xs].sort((a, b) => a - b);
  return new Map(xs.map(v => [v, (s.filter(x => x < v).length + 0.5 * s.filter(x => x === v).length) / s.length * 100]));
}
// 前视总体（spec §7.2 与 §8 的地基）：只有「池内 + A 级 + 两分都是真数字」的行进两套对比。
// 必须与前端 index.html 的 divergeLists 同过滤器（含 null 守卫），否则十分位/分歧榜的百分位就不是页面展示的那一批。
// 【为什么 null 守卫必须在这里、而不是只靠查询串的承诺】value_engine.ts:211 使 `vq=NULL` 与 `confidence='A'` **必然并存**
// （too_rich/vetoed 行不产出 VQ 但仍是 A 级）；一旦查询串走样，null 会被 classify 的百分位算成极低分位而落进「虚高」，
// 并被 decileTable 的 `a.r[key] - b.r[key]` 强转成 0 而污染 D1。总体的守卫必须是被测函数的一部分。
// 【与前端同一总体】本脚本与 index.html 的 divergeLists 取同一个宇宙：池内 + A 级 + 两分皆为 number。
// 终审 I-1 之前前端缺 in_pool 判据（一只池外的持仓行会挤掉他人分位：600519 由 87.5→70 直接出榜），F-1 已补齐那一侧；
// 此后两侧再分叉就是缺陷，不再作为「已知漂移」声明。数据形态差异（vq 回字符串）另见上方 isScore 的注释。
export type UniRow = { code: string; vq: number; main_final: number; confidence?: string; in_pool?: boolean };
export function forwardUniverse(
  rows: { code: string; vq: number | null; main_final: number | null; confidence?: string; in_pool?: boolean }[],
): UniRow[] {
  const isScore = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
  // 必须 filter、**不得改成 map**：返回的是原对象引用（仍带 confidence/in_pool），
  // 所以 classify(uni) 的再过滤是幂等而非空集——这条隐含契约由第 15 个测试钉住。
  return rows.filter(r => r.in_pool === true && r.confidence === 'A' && isScore(r.vq) && isScore(r.main_final)) as UniRow[];
}

export function classify(rows: { code: string; vq: number; main_final: number; confidence?: string }[]): ValLike[] {
  const use = rows.filter(r => r.confidence === 'A');            // 与前端 divergeLists 同过滤器（spec §7.2：非 A 级不得进分歧结论）
  const vp = pctMap(use.map(r => r.vq)), mp = pctMap(use.map(r => r.main_final));
  return use.flatMap(r => {
    const a = vp.get(r.vq)!, b = mp.get(r.main_final)!;
    if (a >= 80 && b <= 50) return [{ code: r.code, group: 'wronged' }];      // 价值高 / 主分低 → 被错杀
    if (a <= 50 && b >= 80) return [{ code: r.code, group: 'rich' }];          // 价值低 / 主分高 → 虚高
    return [];
  });
}

// 十分位对比（spec §8 L146「VQ 十分位 vs 主分十分位」）：按 key **升序**切十档，D1 = 分最低的一档。
// 每档显式带 n：档内只有 1 只也照实说，不拿“档位齐”伪装样本足。
// 可用样本 < 10 → 返回 []：切不出十档就不切，硬切会造出「一档位 = 一只股」的伪判据。
export function decileTable(
  rows: { code: string; vq: number; main_final: number; baseDay?: string }[],
  barsOf: Map<string, Bar[]>, nDays: number, key: 'vq' | 'main_final',
): { decile: number; mean: number | null; n: number }[] {
  const use = rows
    .map(r => {
      const bars = barsOf.get(r.code) ?? [];
      return { r, m: bars.length ? meanReturn(bars, r.baseDay ?? bars[0].day, nDays) : null };
    })
    .filter(x => x.m !== null) as { r: { code: string; vq: number; main_final: number }; m: number }[];
  if (use.length < 10) return [];
  use.sort((a, b) => a.r[key] - b.r[key]);
  const out: { decile: number; mean: number | null; n: number }[] = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor(use.length * d / 10), hi = Math.floor(use.length * (d + 1) / 10);
    const xs = use.slice(lo, hi).map(x => x.m);
    out.push({ decile: d + 1, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: xs.length });
  }
  return out;
}

// 市场前缀只认沪/深：6 开头 = sh（含 688 科创），0/3 开头 = sz；4/8 开头是北交所，gtimg 该入口无历史
// → 返回 ''（该行归「无读数」），**不得**默默拼个 sz 前缀去拿别的标的的 K 线。失方向是 fail-safe：少一个样本，不是错一个样本。
export function klineSymbol(code: string): string {
  return code.startsWith('6') ? 'sh' : (/^[03]/.test(code) ? 'sz' : '');
}

async function fetchKline(sym: string): Promise<Bar[]> {
  const url = `${TX_BASE}?param=${encodeURIComponent(`${sym},day,,${KLINE_LMT},qfq`)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = await r.json();
      const node = j?.data?.[sym];
      const raw = (node?.qfqday ?? node?.day ?? []) as (string | number)[][];
      return raw.map(x => ({ day: String(x[0]), close: Number(x[2]) })).filter(b => b.day && isFinite(b.close));
    } catch { if (attempt === 3) return []; await new Promise(r => setTimeout(r, 1500 * attempt)); }
  }
  return [];
}

// 控方 pre-flight 修正：原文 `Deno.args[Deno.args.indexOf(k) + 1] ?? d` 在 k 缺席时 indexOf=-1 → 读到 args[0]（一个标志名本身），
// `--batch` 漏传时会把下一个标志名当成日期、绕过下面的用法检查去查一个不存在的批次。改为显式判位置。
const arg = (k: string, d = '') => { const i = Deno.args.indexOf(k); return i >= 0 ? (Deno.args[i + 1] ?? d) : d; };
if (import.meta.main) {
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_ANON_KEY')!;
  const batch = arg('--batch'), horizons = (arg('--horizons', '20,60,120')).split(',').map(Number);
  if (!url || !key || !batch) { console.error('usage: --batch YYYY-MM-DD --horizons 20,60,120'); Deno.exit(2); }
  const hzRaw = arg('--horizons', '20,60,120');
  if (!horizons.length || horizons.some(h => !Number.isInteger(h) || h <= 0)) { console.error(`--horizons 必须是正整数逗号表（收到「${hzRaw}」）`); Deno.exit(2); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(batch)) { console.error(`--batch 必须是 YYYY-MM-DD（收到「${batch}」）`); Deno.exit(2); }
  const q = `select=code,vq,main_final,tier,confidence,in_pool&batch_date=eq.${batch}&vq=not.is.null&main_final=not.is.null`;
  const res = await fetch(`${url}/rest/v1/stock_value?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) { console.error(`read stock_value ${res.status}`); Deno.exit(1); }
  const rows = (await res.json()) as { code: string; vq: number; main_final: number; confidence: string; in_pool: boolean }[];
  if (rows.length === 0) { console.error('该批次无 (vq, main_final) 齐备行——先确认 Task 6 已落库'); Deno.exit(1); }
  console.log('【前视对照】不足 2 个季度（每季 1 个批次前沿）的读数不具备判据力（spec §8）\n');
  const uni = forwardUniverse(rows);                                    // 【本轮核心】两套对比共用同一个总体
  if (uni.length === 0) { console.error('该批次无「池内 + A 级 + 两分皆为 number」行——前视无从算起（先确认 Task 6 已落库且池非空；若两分以字符串形态返回，isScore 会照实拒绝——那是数据形态问题，不是抽样问题）'); Deno.exit(1); }
  console.log(`总体：池内 A 级且两分齐备 ${uni.length} 只（与前端分歧榜同一总体，F-1 已补齐前端的 in_pool 判据）\n`);
  console.log(`拉 K 线 ${uni.length} 只 × ${GAP_MS}ms 限流 ≈ ${Math.round(uni.length * GAP_MS / 1000)}s + 每次请求往返耗时（季度手动跑，一次拉完两张表共用）`);
  const groups = classify(uni).map(g => ({ ...g, baseDay: batch }));
  const scored = uni.map(r => ({ ...r, baseDay: batch }));
  const barsOf = new Map<string, Bar[]>();
  for (const u of uni) {                                                // ← 以前只给 groups 拉，十分位表永远是空；现在给整个总体拉
    const mkt = klineSymbol(u.code);                 // 北交所等无历史入口 → ''（归无读数，绝不拼错前缀去拿别人的 K 线）
    barsOf.set(u.code, mkt ? await fetchKline(`${mkt}${u.code}`) : []);
    await new Promise(r => setTimeout(r, GAP_MS));
  }
  for (const n of horizons) {
    const cmp = groupCompare(groups, barsOf, n);
    // 组里一个成员都没有时，groupCompare 无从知道该组存在（byG 的键来自 rows）→ 由 CLI 补出 n=0 行。
    // 「分歧榜某一组空了」是前视复盘**最有信息量的读数之一**，绝不允许它在输出里静默消失。
    const shown = ['wronged', 'rich'].map(g => cmp.find(x => x.group === g) ?? { group: g, mean: null, median: null, n: 0, skipped: 0 });
    console.log(`窗口 ${n} 日：` + shown.map(x => ` ${x.group} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}% 中位=${x.median?.toFixed(2) ?? 'NA'}% 无读数=${x.skipped}`).join(' |'));
    const fmt = (t: { decile: number; mean: number | null; n: number }[]) =>
      t.length ? t.map(x => `D${x.decile} n=${x.n} 均值=${x.mean?.toFixed(2) ?? 'NA'}%`).join(' | ')
               : '可用样本不足 10，不切十档（诚实：硬切会得到一档位=一只股的伪判据）';
    console.log('  VQ 十分位（D1=分最低）：' + fmt(decileTable(scored, barsOf, n, 'vq')));
    console.log('  主分十分位（D1=分最低）：' + fmt(decileTable(scored, barsOf, n, 'main_final')));
  }
}
