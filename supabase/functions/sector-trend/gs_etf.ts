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

// data[] → EtfSnapRow[]（ofcode/ofname/endamt/temperRegion/range60d/sharpe1yrank/hayjqidu；缺列→null）
export function parseSearchResp(json: unknown): EtfSnapRow[] {
  const j = json as { result?: { code?: number }[]; data?: unknown } | null;
  if (!j || typeof j !== "object") return [];
  if (j.result?.[0]?.code !== 0) return []; // 业务失败码（鉴权/参数）当空截面，交由 fetchSegments 记 warning
  const data = Array.isArray(j.data) ? j.data : null;
  if (!data) return [];
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
  return out;
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
      const rows = parseSearchResp(await r.json());
      if (rows.length === 0) throw new Error("GS 空截面/业务失败码"); // 含 result.code≠0（如 apiKey 失效）
      return rows;
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

// 15 分段串行 + 400ms pacing；单段失败（重试后）记 warning 继续；满 100 记 truncated；并集 <300 → throw('MIN_ROWS')
export async function fetchSegments(apiKey: string): Promise<SegSnapshot> {
  const rows = new Map<string, EtfSnapRow>();
  const truncated: string[] = [];
  const warnings: string[] = [];
  for (const amt of AMT_BANDS) {
    for (const tem of TEMPERS) {
      const seg = `amt=${amt}×temper${tem}`;
      let segRows: EtfSnapRow[] | null = null;
      try {
        segRows = await segFetch(amt, tem, apiKey);
      } catch (e) {
        warnings.push(
          `${seg} 取数失败（重试 ${ATTEMPTS} 次后跳过）: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
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
    throw new Error(
      `MIN_ROWS 违例: 并集去重 ${rows.size} < ${MIN_ROWS}（快照异常）`,
    );
  }
  return { rows, truncated, warnings };
}
