// scripts/sector_normalize.ts —— 规则权威: spec §2.2；未命中一律原样返回并计入"待审名单"
const MERGE: Record<string, string> = {
  地产: '房地产', 房产: '房地产',
  券商: '证券', 证券保险: '证券',
  芯片: '半导体', 集成电路: '半导体', 科创半导体: '半导体',
  科创半导体设备: '半导体设备',
  绿电: '电力', 储能电池: '电池', 消费50: '消费', 军工龙头: '军工',
  科创信息: '信息技术', 创业板新能源: '新能源', 科创新能源: '新能源',
};
const FUND_PREFIXES = ['华泰柏瑞','易方达','华夏','南方','鹏华','广发','富国','嘉实','博时','银华','国泰','华宝','天弘','汇添富','招商','工银','建信','兴银','平安','安联','东财','爬墙','万家中信','万家','中信保诚','中银','交银','浦银','泰信','申万菱信','诺安','长城','前海开源','红土','联博','摩根','贝莱德','芝商所'];
export function extractInd(etfName: string): string {
  let s = etfName;
  for (const p of FUND_PREFIXES) if (s.startsWith(p)) { s = s.slice(p.length); break; }
  return normalizeInd(s.split(/ETF/)[0].replace(/[A-Za-z0-9·\-—]/g, '')) || s;
}
export function normalizeInd(raw: string): string { return MERGE[raw] ?? raw; }
