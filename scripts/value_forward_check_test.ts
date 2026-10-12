// scripts/value_forward_check_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { meanReturn, groupCompare, classify, decileTable, forwardUniverse, klineSymbol } from "./value_forward_check.ts";

const bars = ['2026-01-01','2026-01-02','2026-01-03','2026-01-04'].map((d,i)=>({day:d, close:8*(i+1)}));   // 8,16,24,32
const wknd = [ {day:'2026-01-01', close:8}, {day:'2026-01-02', close:16}, {day:'2026-01-05', close:24}, {day:'2026-01-06', close:32} ];

Deno.test('meanReturn：以 baseDay 收盘为基准算 n 日后涨幅（基准日在序列内）', () => {
  assertEquals(meanReturn(bars, '2026-01-01', 2), 200);          // 8 → 24
});
Deno.test('meanReturn：baseDay 只取前 10 字符（ISO 时间戳进来也能用）', () => {
  assertEquals(meanReturn(bars, '2026-01-02T09:30:00Z', 1), 50); // 16 → 24
});
Deno.test('meanReturn：baseDay 不在序列内 → 取其前一根为基准（真实 K 线有周末/停牌缺口）；早于首根 → null', () => {
  assertEquals(meanReturn(wknd, '2026-01-03', 1), 50);           // 基准落到 01-02（前一根），1 根后是 01-05：16 → 24
  assertEquals(meanReturn(wknd, '2025-12-01', 1), null);         // 早于首根 → null（不猜基准价）
});
Deno.test('meanReturn：窗口越界（不足 n 根）→ null（新批次拿不到读数就是拿不到，不填 0）', () => {
  assertEquals(meanReturn(bars, '2026-01-04', 20), null);
});
Deno.test('groupCompare：奇/偶样本各一组，均值≠中位数才测得出中位数取的是哪一支（评审 N-1）', () => {
  const mk = (end: number) => [{ day:'2026-01-01', close:8 }, { day:'2026-01-02', close:12 }, { day:'2026-01-03', close:end }, { day:'2026-01-04', close:end }];
  const rows = [
    { code:'a', group:'wronged' }, { code:'b', group:'wronged' }, { code:'e', group:'wronged' }, { code:'f', group:'wronged' },
    { code:'d', group:'wronged' },                                                 // d 无历史 → skipped
    { code:'c', group:'rich' }, { code:'g', group:'rich' }, { code:'h', group:'rich' },
  ];
  const barsOf = new Map<string, { day:string; close:number }[]>([
    ['a', mk(16)], ['b', mk(24)], ['e', mk(32)], ['f', mk(88)],                    // +100% / +200% / +300% / +1000%
    ['c', mk(24)], ['g', mk(32)], ['h', mk(88)],                                   // +200% / +300% / +1000%
  ]);
  const out = groupCompare(rows, barsOf, 2);
  const w = out.find(x => x.group === 'wronged')!, r = out.find(x => x.group === 'rich')!;
  assertEquals(w.n, 4); assertEquals(w.skipped, 1);
  assertEquals(w.mean, 400); assertEquals(w.median, 250);                           // 偶数支 [100,200,300,1000]：(200+300)/2=250 ≠ 均值 400
  assertEquals(r.n, 3);
  assertEquals(r.mean, 500); assertEquals(r.median, 300);                           // 奇数支 [200,300,1000]：中位 300 ≠ 均值 500
});
Deno.test('groupCompare：无价格历史的 code 不拉低样本数（计入跳过原因供报告）', () => {
  const out = groupCompare([{code:'zz', group:'wronged'}], new Map(), 20);
  assertEquals(out.find(x=>x.group==='wronged')!.n, 0);
  assertEquals(out.find(x=>x.group==='wronged')!.mean, null);
});
Deno.test('classify：只取 A 级（与前端 divergeLists 同过滤器），阈值与前端逐字一致（spec §7.2）', () => {
  const rows = [
    { code:'a', vq:95, main_final:30, confidence:'A' },
    { code:'b', vq:50, main_final:50, confidence:'A' },
    { code:'c', vq:10, main_final:95, confidence:'A' },
    { code:'d', vq:92, main_final:28, confidence:'A' },
    { code:'e', vq:90, main_final:20, confidence:'A' },
    { code:'z1', vq:99, main_final:1,  confidence:'C' },   // 比 a 更“被错杀”，但非 A 级 → 不得混进前视样本
  ];
  const g = classify(rows);
  assertEquals(g.filter(x => x.group === 'wronged').map(x => x.code), ['a']);
  assertEquals(g.filter(x => x.group === 'rich').map(x => x.code), ['c']);
  assertEquals(g.some(x => x.code === 'z1'), false);
});

Deno.test('meanReturn：终点收盘为 0（停牌/退市/脏数据）→ null，不得算成 -100% 假读数', () => {
  assertEquals(meanReturn([{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 0 }], '2026-01-01', 1), null);
});

Deno.test('decileTable：按分数升序切十档，D1=分最低；涨幅逐档递增时表格单调（spec §8）', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 10 - i }));
  // 第 i 只的前视涨幅恰为 i*100%（8 → 8*(i+1)，二进制的精确整数比，断言继续用精确相等）
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const t = decileTable(rows, barsOf, 1, 'vq');
  assertEquals(t.map(x => x.decile), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(t.map(x => x.n), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assertEquals(t.map(x => x.mean), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
});

Deno.test('decileTable：同一个样本集换 key 就换序——主分十分位与 VQ 十分位反向', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 10 - i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const m = decileTable(rows, barsOf, 1, 'main_final').map(x => x.mean);
  assertEquals(m, [900, 800, 700, 600, 500, 400, 300, 200, 100, 0]);
});

Deno.test('decileTable：可用样本 <10 → 空表（不硬切十档）；无价格历史的行不入样本而是直接被排除', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.slice(0, 9).map(r => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 16 }]]));
  assertEquals(decileTable(rows, barsOf, 1, 'vq').length, 0);   // c9 无历史 → 可用 9 只
});

Deno.test('forwardUniverse：只有「池内 + A 级」进前视总体（与前端 divergeLists 同过滤器，spec §7.2）', () => {
  const rows = [
    { code: 'a', vq: 80, main_final: 40, confidence: 'A', in_pool: true },
    { code: 'b', vq: 70, main_final: 50, confidence: 'B', in_pool: true },    // 非 A 级 → 排除
    { code: 'c', vq: 90, main_final: 30, confidence: 'A', in_pool: false },   // 池外 → 排除
    { code: 'd', vq: 60, main_final: 60, confidence: 'A', in_pool: true },
  ];
  assertEquals(forwardUniverse(rows).map(r => r.code), ['a', 'd']);
});

Deno.test('decileTable 吃的是全体可用样本（不是分歧榜人数）——修复轮 1 C-1 的回归锁', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, vq: i + 1, main_final: 12 - i }));
  const barsOf = new Map<string, { day: string; close: number }[]>(
    rows.map((r, i) => [r.code, [{ day: '2026-01-01', close: 8 }, { day: '2026-01-02', close: 8 * (i + 1) }]]));
  const t = decileTable(rows, barsOf, 1, 'vq');
  assertEquals(t.length, 10);
  assertEquals(t.reduce((a, x) => a + x.n, 0), 12);   // 12 只全体入档；若只喂分歧榜几行，这条必红
});

Deno.test('klineSymbol：沪 6*→sh（含 688）、深 0/3*→sz、北交所 4/8*→空（无历史入口，不得默默拼前缀）', () => {
  assertEquals(klineSymbol('600519'), 'sh');
  assertEquals(klineSymbol('688981'), 'sh');
  assertEquals(klineSymbol('000001'), 'sz');
  assertEquals(klineSymbol('300750'), 'sz');
  assertEquals(klineSymbol('430047'), '');
  assertEquals(klineSymbol('830799'), '');
});

Deno.test('forwardUniverse↔classify 契约锁：null 分不得进总体，进得来的行必须还能分到组（评审 F2/F6）', () => {
  const rows = [
    { code: 'a', vq: 95, main_final: 30, confidence: 'A', in_pool: true },
    { code: 'b', vq: 50, main_final: 50, confidence: 'A', in_pool: true },
    { code: 'c', vq: 10, main_final: 95, confidence: 'A', in_pool: true },
    { code: 'd', vq: 92, main_final: 28, confidence: 'A', in_pool: true },
    { code: 'e', vq: 90, main_final: 20, confidence: 'A', in_pool: true },
    { code: 'n1', vq: null, main_final: 40, confidence: 'A', in_pool: true },    // value_engine.ts:211 的真实组合：vq=NULL 且 A 级
    { code: 'n2', vq: 88, main_final: null, confidence: 'A', in_pool: true },    // 主分快照缺失 → 同样不得进总体（与前端 divergeLists 同款守卫）
  ];
  const uni = forwardUniverse(rows);
  assertEquals(uni.map(r => r.code), ['a', 'b', 'c', 'd', 'e']);
  assertEquals(classify(uni).length > 0, true);                                   // 若有人把 filter 改成 map（丢 confidence），这条立刻红
  assertEquals(classify(uni).some(x => x.code === 'n1' || x.code === 'n2'), false);
});
