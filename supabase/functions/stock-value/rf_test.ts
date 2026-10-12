// supabase/functions/stock-value/rf_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseCn10y, resolveCn10y } from './rf.ts';

Deno.test('parseCn10y：带百分号的十年期数值直接取值', () => {
  assertEquals(parseCn10y('中国10年期国债收益率为1.85%（2026-10-10）'), 1.85);
});

Deno.test('parseCn10y：多利率并列时必须拿“10年/十年”邻近那个，不是第一个', () => {
  assertEquals(parseCn10y('1年期1.35%，10年期国债收益率2.10%'), 2.1);
});

Deno.test('parseCn10y：超出合理窗口 [0.5,5.0]% 一律 null（宁可 rf_fallback，不可把 0.0185 当 1.85）', () => {
  assertEquals(parseCn10y('十年期国债收益率 0.0185'), null);      // 无百分号 → 不猜
  assertEquals(parseCn10y('十年期国债收益率 6.20%'), null);      // 窗外
  assertEquals(parseCn10y('今日天气晴'), null);                      // 无数字
});

Deno.test('resolveCn10y：override 优先于 auto', () => {
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-10-01', fetched: 1.85, today: '2026-10-11' }),
    { cn10y: 2.0, source: 'override' });
});

Deno.test('resolveCn10y：override 超过 45 天未更新 → 失效，退回 auto（防手动值腐烂）', () => {
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-01-01', fetched: 1.85, today: '2026-10-11' }),
    { cn10y: 1.85, source: 'auto' });
  assertEquals(resolveCn10y({ override: 2.0, overrideOn: '2026-01-01', fetched: null, today: '2026-10-11' }),
    { cn10y: null, source: 'none' });
});

Deno.test('resolveCn10y：全缺 → source=none（编排层走 rfFallback，不抛错）', () => {
  assertEquals(resolveCn10y({ override: null, overrideOn: null, fetched: null, today: '2026-10-11' }),
    { cn10y: null, source: 'none' });
});
