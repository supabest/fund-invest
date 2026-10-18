// scripts/check_secrets.ts — 凭据泄漏门禁（2026-10-18 立）
//
// 起因：test-email.sh / DASHBOARD_TEST.md / EMAIL_TEST_GUIDE.md 曾硬编码真实 DAILY_UPDATE_TOKEN（已清理并轮换）。
// 本门禁扫 git 跟踪文件（本地未跟踪的一次性目录不在范围），命中即 exit 1，用于推送/部署前把关。
//
// 规则（宁缺毋滥：只认高置信形态，避免噪音让人绕开门禁）：
//   1. 64 位十六进制串（token 常见形态；deno.lock 的 integrity 哈希除外）
//   2. Bearer <20+ 位实值>（占位符 <NAME> / $VAR / ${VAR} 不算）
//   3. JWT（eyJ…）
//   4. apiKey=<16+ 位实值>（国信 GS key 的调用形态）
//   5. sb_secret_ / service_role= 明文；sb_publishable_ 放行（设计上可公开，读路径靠 RLS 兜底）
//
// 白名单：行内含 `secret-scan: allow` 注释（必须写明原因，供评审）。二进制与锁文件按扩展名/文件名跳过。
// 输出纪律：只打印脱敏预览（前 8 位 + …），绝不回显完整秘密——门禁自己不能变成泄漏面。

export type Finding = { rule: string; line: number; preview: string };

const RULES: { name: string; re: RegExp }[] = [
  { name: '64位十六进制串(疑似token)', re: /\b[0-9a-f]{64}\b/ },
  { name: 'Bearer 实值', re: /\bBearer[ \t]+(?!<)(?!\$)[A-Za-z0-9._\-]{20,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{20,}/ },
  { name: 'apiKey=实值', re: /\bapiKey=(?!<)(?!\$)[A-Za-z0-9%._\-]{16,}/ },
  { name: 'sb_secret_/service_role 明文', re: /\b(sb_secret_[A-Za-z0-9_-]+|service_role[ \t]*=[ \t]*["']?[A-Za-z0-9._\-]{16,})/ },
];

/** 按扩展名跳过的文件（二进制/压缩/媒体）。 */
export const SKIP_EXT = new Set([  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.xlsx', '.xls', '.zip', '.gz', '.woff', '.woff2', '.ttf',
]);
/** 按文件名跳过的文件：锁文件里的哈希是依赖完整性摘要，不是凭据。 */
export const SKIP_FILES = new Set(['deno.lock', 'package-lock.json']);

/** 本地实现：不为一行字符串操作引入依赖（edge 函数零依赖纪律的延伸）。 */
function extname(p: string): string {
  const base = p.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** 脱敏：只留前 8 位与长度，避免门禁输出本身成为泄漏面。 */
export function mask(secret: string): string {
  const head = secret.length <= 8 ? secret.slice(0, 2) : secret.slice(0, 8);
  return head + '…(len ' + secret.length + ')';
}

/** 纯函数：扫一段文本，返回命中（供测试与 CLI 共用）。 */
export function scanText(text: string, _path = '<text>'): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/secret-scan:\s*allow/i.test(line)) continue;   // 行级白名单（要求写原因）
    for (const r of RULES) {
      const m = line.match(r.re);
      if (m) out.push({ rule: r.name, line: i + 1, preview: mask(m[0]) });
    }
  }
  return out;
}

/** CLI：git ls-files → 逐个扫描。 */
async function main(): Promise<number> {
  const cmd = new Deno.Command('git', { args: ['ls-files', '-z'], stdout: 'piped', stderr: 'piped' });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    console.error('❌ git ls-files 失败：' + new TextDecoder().decode(stderr).trim());
    return 2;
  }
  const files = new TextDecoder().decode(stdout).split('\0').filter(Boolean);
  let scanned = 0, hits = 0;
  for (const f of files) {
    if (SKIP_FILES.has(f.split('/').pop() || '') || SKIP_EXT.has(extname(f))) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(f);
    } catch {
      continue;   // 读不了的（符号链接/权限）跳过，不静默当作安全
    }
    scanned++;
    for (const fnd of scanText(text, f)) {
      hits++;
      console.log(`❌ ${f}:${fnd.line} ${fnd.rule} → ${fnd.preview}`);
    }
  }
  if (hits > 0) {
    console.error(`\n❌ 检出 ${hits} 处疑似真实凭据（扫描 ${scanned} 个跟踪文件）。`);
    console.error('   处理：把凭据换成环境变量或占位符；确属假阳性时在该行加 `secret-scan: allow` 注释并写明原因。');
    console.error('   若确认泄漏过真实凭据：先轮换（重建 token → 更新函数 secrets → 更新 pg_cron 里的 Bearer），再提交清理。');
    return 1;
  }
  console.log(`✅ 未发现真实凭据（扫描 ${scanned} 个跟踪文件）。`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
