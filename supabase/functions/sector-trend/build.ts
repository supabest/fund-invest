// build.ts — 构建脚本：deno run --allow-read --allow-write build.ts
// 把 engine.ts + tencent.ts + gs_etf.ts + gs_fund.ts + index.ts 拼接为单文件 deploy.ts（Edge 部署只吃一个入口）：
//  - 剥离所有相对模块 import（index→engine/tencent/gs_etf/gs_fund、gs_etf→tencent、gs_fund→gs_etf），含内联 `type` 与多行形式
//    ⚠ 剥离正则要求 import 语句行尾无内容（引号闭合/分号后直接行尾）；残留由 assertNoResidualImport 在构建期拒绝
//  - 剥离顶层 export 关键字，降级为普通声明
//  - 归一 /// <reference lib="deno.ns" /> 到文件顶部
//  - 重名校验：bundle 后各文件顶层私有标识符共作用域，撞名会在 nightly 运行时炸链，构建期先拦（TS2451）
// 模式与 stock-score/build.ts 一致（本仓 deploy.ts 为构建产物，不可手改）
const stripRefs = (s: string) => s.replace(/^\/\/\/ <reference .*$/gm, "");
const rd = (f: string) =>
  stripRefs(Deno.readTextFileSync(f))
    .replace(/^import\s[^;]*?from\s*["']\.\/[^"']+["'];?[ \t]*$/gm, "") // 跨文件 import（单行/多行/纯 type）；[^;] 防止外扩，不能吞到下一条 import
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

// 残留相对模块引用发生在 rd() 的剥离正则未命中时（如 import 语句带了行尾注释）：
// 语句型残留会与 bundle 内已剥离 export 的同名声明构成重复绑定（TS2440），多行形态与类型位置
// 引用则静默保留一个单文件部署下无法解析的模块路径——两者都使 deploy.ts 不再自包含。
// 不只要“跑不炸”，还要能单独 `deno check`，因此三种形态一并在构建期拦住，不留给人工 sanity。
const RESIDUAL_RES = [
  /\bfrom\s*["']\.\.?\//, // 任何 `from "./"` 行：单行 import、default import、多行收尾 `} from "./x";`
  /^\s*import\s+["']\.\.?\//, // 副作用型 `import "./x.ts";`（无 from）
  /\bimport\s*\(\s*["']\.\.?\//, // 动态 import / 类型位置 import("./x.ts").T（不经剥离正则）
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
  rd("engine.ts") + "\n" + rd("tencent.ts") + "\n" + rd("gs_etf.ts") + "\n" +
  rd("gs_fund.ts") + "\n" + rd("index.ts");
assertNoDup(src);
assertNoResidualImport(src);
Deno.writeTextFileSync("deploy.ts", src);
console.log("deploy.ts bytes:", src.length);
