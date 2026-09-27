import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ma, parseKline, retN, sinaSymbol, dailyKline, type Kbar } from './sina.ts';

Deno.test('sinaSymbol: SH/SZ/BJ 三市场映射', () => {
  assertEquals(sinaSymbol('600000.SH'), 'sh600000');
  assertEquals(sinaSymbol('000338.SZ'), 'sz000338');
  assertEquals(sinaSymbol('832566.BJ'), 'bj832566');
  // 无市场后缀时按代码首位推断
  assertEquals(sinaSymbol('688378'), 'sh688378');
  assertEquals(sinaSymbol('430047'), 'bj430047');
  assertEquals(sinaSymbol('300750'), 'sz300750');
  // fix 轮 4：裸代码首位 /9/ 也是北交所（含 920xxx 新号段）→ bj
  assertEquals(sinaSymbol('920001'), 'bj920001');
  assertEquals(sinaSymbol('920819.BJ'), 'bj920819');
});

Deno.test('ma: 尾部 n 均值的硬值 + 长度不足/空数组 → null', () => {
  const closes = [10, 20, 30, 40, 50];
  assertEquals(ma(closes, 1), 50);
  assertEquals(ma(closes, 2), 45); // (40+50)/2
  assertEquals(ma(closes, 5), 30); // 全序列
  assertEquals(ma(closes, 6), null); // n 超长
  assertEquals(ma([], 1), null);
});

Deno.test('retN: 区间涨跌幅 % 的硬值（含负值与降级）', () => {
  const near = (a: number | null, b: number) => assertEquals(a !== null && Math.abs(a - b) < 1e-9, true);
  const bars: Kbar[] = [100, 110, 121, 120, 132].map((c, i) => ({ day: `2026-09-2${i}`, close: c }));
  near(retN(bars, 1), 10); // 132/120-1
  near(retN(bars, 4), 32); // 132/100-1
  const fall: Kbar[] = [{ day: 'a', close: 50 }, { day: 'b', close: 40 }];
  near(retN(fall, 1), -20);
  assertEquals(retN(bars.slice(0, 3), 3), null); // 需 n+1 根
  assertEquals(retN([], 1), null);
  assertEquals(retN([{ day: 'a', close: 0 }, { day: 'b', close: 5 }], 1), null); // 基准价≤0 → 无意义
});

Deno.test('parseKline: 字符串数字正常解析；坏 payload 抛错不含内容；非法单根被丢弃', () => {
  const ok = parseKline([
    { day: '2026-09-24', open: '8.990', close: '9.000', volume: '1' },
    { day: '2026-09-25', close: 9.5 }, // 数值型也接受
  ]);
  assertEquals(ok, [{ day: '2026-09-24', close: 9 }, { day: '2026-09-25', close: 9.5 }]);
  // 坏 payload：对象/字符串/null → 抛错，且 message 不含 payload 片段
  for (const bad of [{ error: 'secret-payload-leak' }, 'html-not-json', null, 42]) {
    const err = assertThrows(() => parseKline(bad as unknown)) as Error;
    assertEquals(err.message, 'sina bad payload');
  }
  // 防御式：close 解析失败/缺失的 bar 丢弃，其余保留
  const mixed = parseKline([
    { day: '2026-09-24', close: 'abc' },
    { day: '', close: '1' },
    { close: '2' },
    { day: '2026-09-25', close: '3' },
  ]);
  assertEquals(mixed, [{ day: '2026-09-25', close: 3 }]);
});

// fix 轮 3：网关拦截页（HTML）使 r.json() 抛 SyntaxError（message 内嵌 payload 片段），
// dailyKline 必须单独冒住并归一为 'sina bad payload'，不让片段泄露到错误链。
Deno.test('dailyKline: r.json() 抛 SyntaxError → 脱敏为 sina bad payload（不含片段）', async () => {
  const origFetch = globalThis.fetch;
  const leaky = new SyntaxError('Unexpected token < in JSON at position 0: <html>SECRET-GATE-PAGE</html>');
  // @ts-ignore test stub
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(leaky) });
  try {
    const err = await dailyKline('sh600000').catch((e: unknown) => e as Error);
    assertEquals(err instanceof Error, true);
    assertEquals((err as Error).message, 'sina bad payload');
    assertEquals((err as Error).message.includes('SECRET'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
