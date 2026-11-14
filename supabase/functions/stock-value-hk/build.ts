// supabase/functions/stock-value-hk/build.ts —— 与 stock-value/build.ts 同构（拼接顺序：引擎→适配器→index）
// 本仓 deploy.ts 为构建产物，不可手改；改源模块后必须重跑本脚本再跑 deno task verify-bundles。
//  - 剥离所有相对模块 import（index→hk_engine/gs_hk），含内联 type 与多行形式
//    ⚠ 剥离正则要求 import 语句行尾无内容（引号闭合/分号后直接行尾）；残留由 assertNoResidualImport 在构建期拒绝
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
//  - 重名校验：bundle 后各文件顶层私有标识符共作用域，撞名会在 nightly 运行时炸链，构建期先拦（TS2451）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, "");
const rd = (f: string) =>
  stripRefs(Deno.readTextFileSync(f))
    .replace(/^import\s[^;]*?from\s*["']\.\/[^"']+["'];?[ \t]*$/gm, "")
    .replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(
      /^export\s+(interface|type|const|function|async\s+function)/gm,
      "$1",
    );

const DUP_RE =
  /^(?:const|let|var|function|async\s+function|class|interface|type)\s+([A-Za-z0-9_$]+)/gm;
function assertNoDup(src: string) {
  const seen = new Map<string, number>();
  for (const m of src.matchAll(DUP_RE)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const bad = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (bad.length > 0) {
    throw new Error(
      `bundle 顶层标识符重名: ${
        bad.join(", ")
      } ⇒ 请重命名所属文件的私有常量/助手`,
    );
  }
}

const RESIDUAL_RES = [
  /\bfrom\s*["']\.\.?\//,
  /^\s*import\s+["']\.\.?\//,
  /\bimport\s*\(\s*["']\.\.?\//,
  /\bfrom\s*["'](https?:|jsr:|npm:|node:)/,
];
function assertNoResidualImport(src: string) {
  const bad = src
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => RESIDUAL_RES.some((re) => re.test(l)));
  if (bad.length > 0) {
    throw new Error(
      `bundle 残留相对模块引用（剥离正则未命中）:\n` +
        bad.map(([n, l]) => `  deploy.ts 大致 L${n}: ${l}`).join("\n") +
        `\n⇒ 单文件部署必须自包含：import 语句行尾不得带注释/额外内容，` +
        `类型位置改用已拼接文件的裸类型名`,
    );
  }
}

const src = '/// <reference lib="deno.ns" />\n' +
  rd("hk_engine.ts") + "\n" + rd("gs_hk.ts") + "\n" + rd("index.ts");
assertNoDup(src);
assertNoResidualImport(src);
// 输出路径可选（缺省 deploy.ts）：一致性门禁把产物写到临时路径再与已提交 deploy.ts 逐字节比对
const out = Deno.args[0] ?? "deploy.ts";
Deno.writeTextFileSync(out, src);
console.log(`${out} bytes:`, src.length);
