// build.ts — 构建脚本：deno run --allow-read --allow-write build.ts
// 把 engine.ts + gs.ts + index.ts 拼接为单文件 deploy.ts：
//  - 剥离跨文件 import（index→engine/gs、gs→engine 的 import type）
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\.\/(?:engine|gs)\.ts';?\s*$/gm, '') // 跨文件 import（含内联 type）
  .replace(/^import\s+type\s.*?;?\s*$/gm, '') // gs.ts: import type { Stock } from './engine.ts'
  .replace(/^export\s+(interface|type|const|function|async\s+function)/gm, '$1');
const src = '/// <reference lib="deno.ns" />\n' +
  rd('engine.ts') + '\n' + rd('gs.ts') + '\n' + rd('index.ts');
Deno.writeTextFileSync('deploy.ts', src);
console.log('deploy.ts bytes:', src.length);
