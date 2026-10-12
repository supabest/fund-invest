// build.ts — deno run --allow-read --allow-write build.ts
// 校验用（不覆盖已提交产物）：deno run --allow-read --allow-write build.ts /tmp/out.ts —— 见 scripts/verify_deploy_bundles.ts
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
// M-7 fail-fast：残留相对 import 会令 Edge 运行时报模块找不到——写盘前断言，非零退出的构建失败优于上线坏包。
if (/from\s+["']\.\/[a-z_]+\.ts["']/.test(src)) throw new Error('deploy.ts 残留相对 import');
// 输出路径可选（缺省 deploy.ts）：一致性门禁把产物写到临时路径再与已提交 deploy.ts 逐字节比对，
// 从而复用同一份拼接逻辑、且校验过程绝不改动功能目录。
const out = Deno.args[0] ?? 'deploy.ts';
Deno.writeTextFileSync(out, src);
console.log(`${out} bytes:`, src.length);
