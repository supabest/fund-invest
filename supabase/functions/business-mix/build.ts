// build.ts — 构建脚本：deno run --allow-read --allow-write build.ts
// 把 mix.ts + index.ts 拼接为单文件 deploy.ts（镜像 stock-score/build.ts）：
//  - 剥离跨文件 import（index→mix 的行内 type import）
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\.\/mix\.ts';?\s*$/gm, '') // 跨文件 import（含内联 type）
  .replace(/^import\s+type\s.*?;?\s*$/gm, '')
  .replace(/^export\s+(interface|type|const|function|async\s+function)/gm, '$1');
const src = '/// <reference lib="deno.ns" />\n' +
  rd('mix.ts') + '\n' + rd('index.ts');
Deno.writeTextFileSync('deploy.ts', src);
console.log('deploy.ts bytes:', src.length);
