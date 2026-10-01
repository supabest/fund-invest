// build.ts — 构建脚本：deno run --allow-read --allow-write build.ts
// 把 engine.ts + tencent.ts + gs_etf.ts + index.ts 拼接为单文件 deploy.ts（Edge 部署只吃一个入口）：
//  - 剥离所有相对模块 import（index→engine/tencent/gs_etf、gs_etf→tencent），含内联 `type` 与多行形式
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
//  - 重名校验：bundle 后各文件顶层私有标识符共作用域，撞名会在 nightly 运行时炸链，构建期先拦（TS2451）
// 模式与 stock-score/build.ts 一致（本仓 deploy.ts 为构建产物，不可手改）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, "");
const rd = (f: string) =>
  stripRefs(Deno.readTextFileSync(f))
    .replace(/^import\s[\s\S]*?from\s*["']\.\/[^"']+["'];?[ \t]*$/gm, "") // 跨文件 import（单行/多行/纯 type）
    .replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "") // 副作用型 import（当前无，防御性）
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

const src = '/// <reference lib="deno.ns" />\n' +
  rd("engine.ts") + "\n" + rd("tencent.ts") + "\n" + rd("gs_etf.ts") + "\n" +
  rd("index.ts");
assertNoDup(src);
Deno.writeTextFileSync("deploy.ts", src);
console.log("deploy.ts bytes:", src.length);
