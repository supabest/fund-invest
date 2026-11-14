// scripts/verify_deploy_bundles.ts —— 构建产物一致性门禁（部署前必跑，漂移即非零退出）
// 用法：deno task verify-bundles            （仓库根命令入口，见 deno.json）
//   或：deno run --allow-read --allow-write --allow-run scripts/verify_deploy_bundles.ts
//   可选参数：只校验指定模块，如 `deno task verify-bundles sector-trend stock-score`
//
// 为什么需要：deploy.ts 是各目录 build.ts 拼接源模块的产物（注释明示"不可手改"），Edge 部署推的就是它；
// 而仓库全部单元测试都从源模块（engine.ts / index.ts 等）导入，零测试引用 deploy.ts。
// 于是"改了源模块 → 源码级测试跑绿 → 忘记重跑 build.ts"这条链上没有任何拦截点，
// 已提交/已上线的 deploy.ts 会静默停留在旧拼接结果。本脚本把这种漂移从静默变成可见的失败。
//
// 只读承诺：重跑构建的产物写到系统临时目录，与已提交 deploy.ts 逐字节比对后删除，
// 全程不改动 supabase/functions/ 下任何文件，校验后工作区保持干净。
const MODULES = [
  "sector-trend",
  "stock-score",
  "stock-research",
  "business-mix",
  "stock-value",
  "stock-value-hk",
] as const;
type Module = (typeof MODULES)[number];

const repoRoot = decodeURIComponent(new URL("../", import.meta.url).pathname);

type Outcome = { module: Module; ok: boolean; detail: string };

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n; // 前缀完全相同，差异是长度
}

// 字节偏移 → 该处所在行（1-based）与行内容，用于让报错直接指向漂移位置
function lineAt(
  bytes: Uint8Array,
  offset: number,
): { line: number; text: string } {
  const slice = bytes.subarray(0, offset);
  let line = 1;
  for (const b of slice) if (b === 0x0a) line++;
  const start = slice.lastIndexOf(0x0a) + 1;
  let end = bytes.indexOf(0x0a, offset);
  if (end === -1) end = bytes.length;
  const text = new TextDecoder().decode(bytes.subarray(start, end)).trim()
    .slice(0, 160);
  return { line, text };
}

function describeDrift(committed: Uint8Array, built: Uint8Array): string {
  const p = firstDiff(committed, built);
  const c = lineAt(committed, p);
  const b = lineAt(built, p);
  return `字节级不一致（首个差异 @ byte ${p}）：已提交 deploy.ts ${committed.length}B 第${c.line}行` +
    `\n      已提交: ${c.text || "<空行>"}` +
    `\n      新构建: ${b.text || "<空行>"}` +
    `\n⇒ 源模块与产物已分叉：在该目录重跑 deno run --allow-read --allow-write build.ts 并提交新的 deploy.ts`;
}

async function verifyOne(module: Module, builtPath: string): Promise<Outcome> {
  const dir = `${repoRoot}supabase/functions/${module}`;
  const committedPath = `${dir}/deploy.ts`;

  let committed: Uint8Array;
  try {
    committed = await Deno.readFile(committedPath);
  } catch {
    return {
      module,
      ok: false,
      detail: `${
        committedPath.replace(repoRoot, "")
      } 读取失败（产物缺失或不可读）`,
    };
  }

  // 复用各目录的 build.ts（拼接逻辑唯一权威），只是把输出重定向到临时路径
  const proc = new Deno.Command(Deno.execPath(), {
    cwd: dir,
    args: ["run", "--allow-read", "--allow-write", "build.ts", builtPath],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim().split("\n").slice(
      -3,
    ).join(" | ");
    return {
      module,
      ok: false,
      detail: `构建本身失败（非漂移，是源码问题）：${err}`,
    };
  }

  const built = await Deno.readFile(builtPath);
  if (
    built.length === committed.length &&
    firstDiff(committed, built) === built.length
  ) {
    return { module, ok: true, detail: `${built.length} bytes 逐字节一致` };
  }
  return { module, ok: false, detail: describeDrift(committed, built) };
}

const selected: readonly Module[] = Deno.args.length > 0
  ? MODULES.filter((m) => Deno.args.includes(m))
  : MODULES;

if (selected.length === 0) {
  console.error(
    `未知模块：${Deno.args.join(" ")}（可选：${MODULES.join(", ")}）`,
  );
  Deno.exit(2);
}

const tmpDir = await Deno.makeTempDir({ prefix: "deploy-bundle-verify-" });
const results: Outcome[] = [];
try {
  for (const module of selected) {
    results.push(await verifyOne(module, `${tmpDir}/${module}.deploy.ts`));
  }
} finally {
  await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
}

console.log("deploy.ts ↔ 当前源码重跑构建 一致性校验");
for (const r of results) {
  console.log(
    `${r.ok ? "✅ 一致" : "❌ 漂移"}  ${r.module.padEnd(15)} ${r.detail}`,
  );
}

const bad = results.filter((r) => !r.ok);
if (bad.length > 0) {
  console.error(
    `\n${bad.length}/${results.length} 个函数的 deploy.ts 与源码不一致：上线内容不是当前源码的构建结果。`,
  );
  Deno.exit(1);
}
console.log(
  `\n全部 ${results.length} 个函数的 deploy.ts 与源码构建逐字节一致。`,
);
