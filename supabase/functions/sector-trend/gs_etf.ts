// gs_etf.ts —— 国信 gs-etf-filter「行业型 ETF 截面」适配器（brief Step 2；spec §2.1 15 分段矩阵 / §3.2 纪律）
// 每晚 15 分段串行拉取（class1=1 行业型；endamt 规模段 × temperRegion 估值档），供：
//   ① 当日 V/L/M 因子腿（temperRegion→V、endamt→L、range60d/sharpe1yrank→M）
//   ② Q 景气探测（hayjqidu 当前全空 → Q 腿 null；一旦回填自动回切 Q35 权重，见 engine.computeEtfFactors）
// 控制者裁决 C2：触顶（=100 只）**只记 truncated**，绝不照抄 scripts/build_universe.ts 的 exit(2) 硬退出；
// MIN_ROWS 仅在整个 15 段并集异常（<300）时抛错，交编排层走 stale 降级（spec §3.2）。
import { sleep } from "./tencent.ts";

const BASE =
  "https://dgzt.guosen.com.cn/skills/gsfinancing/selected/ETF/filterSearch/1.0";
export const CAP = 100; // GS filterSearch 单段最多返回 100 只
export const MIN_ROWS = 300; // spec §3.2：并集去重 <300 视为快照异常
const PACING_MS = 400; // brief Step 2：分段间 400ms
const ATTEMPTS = 2; // 首发 + 1 次重试
const RETRY_BACKOFF_MS = 1_500;
const GS_REQ_TIMEOUT_MS = 30_000;

// endamt ∈ {2-10 / 10-30 / 30+亿} × temperRegion ∈ {1..5}（1-高温…5-低温）= 15 分段（与 build_universe 同矩阵）
const AMT_BANDS = ["2,10", "10,30", "30,100000"];
const TEMPERS = ["1", "2", "3", "4", "5"];

export interface EtfSnapRow {
  code: string;
  name: string;
  amt: number | null; // 亿；缺列 → null（brief「缺列→null」语义 ⇒ 可空，编排层按 NA 处理）
  tem: number | null; // 估值档 1..5；缺列 → null
  r60: number | null;
  sharpe: number | null;
  hay: string | null; // hayjqidu：空串/缺列 → null（Q 腿缺席）
}

export function buildSegParams(
  amt: string,
  tem: string,
): Record<string, string> {
  return {
    class1: "1",
    endamt: amt,
    temperRegion: tem,
    orderCol: "nowrange",
    orderType: "0",
    softName: "goldsun_skills",
    skillName: "gs-etf-filter",
  };
}

const gsToNum = (v: unknown): number | null =>
  typeof v === "number"
    ? (Number.isFinite(v) ? v : null)
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    ? Number(v)
    : null;
const toStr = (
  v: unknown,
): string => (typeof v === "string"
  ? v.trim()
  : typeof v === "number"
  ? String(v)
  : "");

// data[] → 行集 + 业务码（终审 I-3：result.code≠0 不得再坑塌成「空截面」）。
// 行为不变：业务失败依旧 rows=[]（MIN_ROWS/重试/pacing 语义一字不改），只是把码与 msg 一并上抛供透传。
// bizMsg 是未脱敏原文（可能回显被打码的 apiKey），调用方必须先过 safeGsMsg 才允许进任何文案。
export interface ParsedSearch {
  rows: EtfSnapRow[];
  fail: boolean; // true ⇒ result[0].code 缺失或非 0（含鉴权失效/参数错误/日限额）
  bizCode: number | null;
  bizMsg: string;
}

export function parseSearchFull(json: unknown): ParsedSearch {
  const j = json as
    | { result?: { code?: number; msg?: unknown }[]; data?: unknown }
    | null;
  if (!j || typeof j !== "object") return { rows: [], fail: true, bizCode: null, bizMsg: "" };
  const first = Array.isArray(j.result) ? j.result[0] : undefined;
  if (first?.code !== 0) {
    // 业务失败码（鉴权/参数/197006 日限额…）或 result 缺失 → 当空截面，但码必须透出
    return {
      rows: [],
      fail: true,
      bizCode: typeof first?.code === "number" ? first.code : null,
      bizMsg: toStr(first?.msg),
    };
  }
  const data = Array.isArray(j.data) ? j.data : null;
  if (!data) return { rows: [], fail: false, bizCode: null, bizMsg: "" };
  const out: EtfSnapRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const code = toStr(r.ofcode);
    const hay = toStr(r.hayjqidu);
    out.push({
      code,
      name: toStr(r.ofname),
      amt: gsToNum(r.endamt),
      tem: gsToNum(r.temperRegion),
      r60: gsToNum(r.range60d),
      sharpe: gsToNum(r.sharpe1yrank),
      hay: hay === "" ? null : hay,
    });
  }
  return { rows: out, fail: false, bizCode: null, bizMsg: "" };
}

// data[] → EtfSnapRow[]（ofcode/ofname/endamt/temperRegion/range60d/sharpe1yrank/hayjqidu；缺列→null）
export function parseSearchResp(json: unknown): EtfSnapRow[] {
  return parseSearchFull(json).rows;
}

// —— 文案加工（终审 I-3）：码必透，msg 只取脱敏后的部分；绝不把可能含凭据的原文拼进去 ——
const MSG_MAX = 40;
const CRED_TOKEN_RE = /[A-Za-z0-9_\-]{12,}/g; // 12+ 位字母数字混排 ⇒ 一律当作凭据形态打码
const URL_RE = /https?:\/\/\S+/g; // URL 可能带 apiKey
const reLit = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function safeGsMsg(msg: string, apiKey: string): string {
  if (!msg) return "";
  let s = String(msg);
  const key = String(apiKey ?? "").trim();
  if (key.length >= 4) {
    s = s.replace(new RegExp(reLit(key), "g"), "***"); // 整串 key
    // 打码后的 key 片段（前 6 位同形 + 任意尾）也一律打码
    s = s.replace(new RegExp(`${reLit(key.slice(0, 6))}[A-Za-z0-9_*\\-]*`, "g"), "***");
  }
  s = s.replace(URL_RE, "<url>").replace(CRED_TOKEN_RE, "***");
  return s.length > MSG_MAX ? s.slice(0, MSG_MAX) : s;
}

export const EMPTY_SNAP_TEXT = "GS 空截面（业务码=0 且 data 为空）"; // 与真空返数据可区分

export function bizFailText(code: number | null, msg: string, apiKey: string): string {
  const tag = `GS 业务码=${code === null ? "未知" : code}`;
  const m = safeGsMsg(msg, apiKey);
  return m ? `${tag} msg="${m}"` : tag;
}

// 整轮降级文案：无业务码时不凭空提及“业务码”（避免误导定性）
export function minRowsText(size: number, tags: string[], segTotal: number): string {
  const base = `MIN_ROWS 违例: 并集去重 ${size} < ${MIN_ROWS}（快照异常）`;
  if (tags.length === 0) return base;
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const dist = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}/${segTotal} 段`)
    .join(", ");
  return `${base} 失败码分布: ${dist}`;
}

async function segFetch(
  amt: string,
  tem: string,
  apiKey: string,
): Promise<EtfSnapRow[]> {
  const qs = new URLSearchParams({ ...buildSegParams(amt, tem), apiKey });
  let lastErr: unknown = new Error("gs_etf fetch failed");
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`${BASE}?${qs}`, {
        signal: AbortSignal.timeout(GS_REQ_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`GS http ${r.status}`);
      const parsed = parseSearchFull(await r.json());
      // 终审 I-3：业务失败码不再与「真空截面」同文案（197006 / 鉴权失效 / 参数错直接现形于 warning）
      if (parsed.fail) throw new Error(bizFailText(parsed.bizCode, parsed.bizMsg, apiKey));
      if (parsed.rows.length === 0) throw new Error(EMPTY_SNAP_TEXT);
      return parsed.rows;
    } catch (e) {
      // 网络错误 message 可能内嵌含 apiKey 的完整 URL → 脱敏（先例：stock-score/gs.ts、tencent.ts）
      lastErr = e instanceof TypeError
        ? new Error(`GS network error (attempt ${attempt})`)
        : e;
      if (attempt < ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("gs_etf fetch failed");
}

export interface SegSnapshot {
  rows: Map<string, EtfSnapRow>;
  truncated: string[];
  warnings: string[];
}

// 15 分段串行 + 400ms pacing；单段失败（重试后）记 warning 继续（warning 文本自带 GS 业务码，I-3）；
// 满 100 记 truncated；并集 <300 → throw(MIN_ROWS + 失败码分布)（段数/重试/pacing/MIN_ROWS 语义一律不变）
const CODE_TAG_RE = /GS 业务码=(?:\d+|未知)/;
const SEG_TOTAL = AMT_BANDS.length * TEMPERS.length;

export async function fetchSegments(apiKey: string): Promise<SegSnapshot> {
  const rows = new Map<string, EtfSnapRow>();
  const truncated: string[] = [];
  const warnings: string[] = [];
  const failTags: string[] = [];
  for (const amt of AMT_BANDS) {
    for (const tem of TEMPERS) {
      const seg = `amt=${amt}×temper${tem}`;
      let segRows: EtfSnapRow[] | null = null;
      try {
        segRows = await segFetch(amt, tem, apiKey);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        warnings.push(
          `${seg} 取数失败（重试 ${ATTEMPTS} 次后跳过）: ${m}`,
        );
        const hit = CODE_TAG_RE.exec(m)?.[0]; // throw 时 warnings 会丢 ⇒ 码另存一份进 throw 文案
        if (hit) failTags.push(hit);
      }
      if (segRows) {
        if (segRows.length === CAP) {
          truncated.push(
            `${seg} 返回满 ${CAP} 只（覆盖未闭合，仅记警告不炸链 C2）`,
          );
        }
        for (const r of segRows) {
          if (r.code && !rows.has(r.code)) rows.set(r.code, r);
        }
      }
      await sleep(PACING_MS);
    }
  }
  if (rows.size < MIN_ROWS) {
    throw new Error(minRowsText(rows.size, failTags, SEG_TOTAL));
  }
  return { rows, truncated, warnings };
}
