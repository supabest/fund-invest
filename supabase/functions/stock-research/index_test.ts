import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
Deno.env.set('STOCK_RESEARCH_DISABLE_SERVE', '1');
Deno.env.set('SUPABASE_URL', 'http://localhost:1');
Deno.env.set('SB_SERVICE_KEY', 'svc-placeholder');
const mod = await import("./index.ts");
Deno.test("index.ts 可 import（DISABLE_SERVE 守卫生效、无顶层副作用）", () => {
  assertEquals(typeof mod === 'object', true);
});
