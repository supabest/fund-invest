// build.ts — deno run --allow-read --allow-write build.ts
// 把 research_core.ts + providers.ts + index.ts 拼接为单文件 deploy.ts（stock-score 先例）：
//  - 剥离跨文件 import（index→core/providers、providers→core）
//  - 剥离顶层 export 关键字
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, '');
const rd = (f: string) => stripRefs(Deno.readTextFileSync(f))
  .replace(/^import\s.*?from\s*'\.\/(?:research_core|providers)\.ts';?\s*$/gm, '')
  .replace(/^import\s+type\s.*?;?\s*$/gm, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*"\.\/(?:research_core|providers)\.ts";?\s*$/gm, '')
  .replace(/^export\s+(interface|type|const|function|async\s+function)/gm, '$1');
const src = '/// <reference lib="deno.ns" />\n' +
  rd('research_core.ts') + '\n' + rd('providers.ts') + '\n' + rd('index.ts');
Deno.writeTextFileSync('deploy.ts', src);
console.log('deploy.ts bytes:', src.length);
