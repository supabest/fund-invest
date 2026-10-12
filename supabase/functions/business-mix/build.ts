// build.ts — 构建脚本：deno run --allow-read --allow-write build.ts
// 校验用（不覆盖已提交产物）：deno run --allow-read --allow-write build.ts /tmp/out.ts —— 见 scripts/verify_deploy_bundles.ts
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
// 输出路径可选（缺省 deploy.ts）：一致性门禁把产物写到临时路径再与已提交 deploy.ts 逐字节比对，
// 从而复用同一份拼接逻辑、且校验过程绝不改动功能目录。
const out = Deno.args[0] ?? 'deploy.ts';
Deno.writeTextFileSync(out, src);
console.log(`${out} bytes:`, src.length);
