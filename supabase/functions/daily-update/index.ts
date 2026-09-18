// daily-update: 每日自动更新基金净值/均线、股票收盘行情与参考指数行情（pg_cron 经 HTTP 调用）
// v3: + 股票(沪深/港股)行情/买卖信号/总额限制 + 日经225基准
// 触发方式: POST /functions/v1/daily-update，Authorization: Bearer <DAILY_UPDATE_TOKEN>
const GOAL_DEFAULT = 200000;
const DEFAULT_TIERS = [{ ret: 20, sell: 10 }, { ret: 40, sell: 20 }, { ret: 60, sell: 30 }, { ret: 80, sell: 50 }];
const DEFAULT_CAPS: Record<string, number> = { '电力/新能源': 20, '全球资源': 20, '机器人/先进制造': 15, '日本股票': 15, '均衡配置': 30, '其他': 15 };
const BENCH: Record<string, { secid: string; name: string; th: number[] }> = {
  HS300: { secid: '1.000300', name: '沪深300', th: [-8, -3, 3, 8] },
  NDX: { secid: '100.NDX', name: '纳斯达克', th: [-8, -3, 3, 8] },
  SPX: { secid: '100.SPX', name: '标普500', th: [-8, -3, 3, 8] },
  DJIA: { secid: '100.DJIA', name: '道琼斯', th: [-8, -3, 3, 8] },
  HSI: { secid: '100.HSI', name: '恒生指数', th: [-8, -3, 3, 8] },
  HSTECH: { secid: '124.HSTECH', name: '恒生科技', th: [-12, -5, 5, 12] },
  N225: { secid: '100.N225', name: '日经225', th: [-8, -3, 3, 8] }
};
const KLINE_HOSTS = ['push2his.eastmoney.com', '1.push2his.eastmoney.com', '23.push2his.eastmoney.com', '92.push2his.eastmoney.com'];

function marketLevel(dev: number | null, th: number[]) {
  if (dev === null) return { level: 'neutral', label: '中性', coef: 1 };
  if (dev <= th[0]) return { level: 'deep-low', label: '深度低位', coef: 1.5 };
  if (dev <= th[1]) return { level: 'low', label: '低位', coef: 1.25 };
  if (dev >= th[3]) return { level: 'deep-high', label: '明显高位', coef: 0.5 };
  if (dev >= th[2]) return { level: 'high', label: '高位', coef: 0.75 };
  return { level: 'neutral', label: '中性', coef: 1 };
}

function computeReturn(price: number, f: any): number | null {
  const cb = (f.costBasis && f.costBasis > 0) ? f.costBasis
    : ((f.costTotal && f.costTotal > 0 && f.currentNav > 0 && f.marketValue > 0) ? f.costTotal / (f.marketValue / f.currentNav) : 0);
  if (!cb) return null;
  return (price - cb) / cb * 100;
}
function stockReturn(f: any, close: number): number | null {
  const cost = parseFloat(f.cost) || 0;
  if (!cost) return null;
  return (close - cost) / cost * 100;
}

function baseSignalLabel(dev: number | null): { label: string; multiplier: number } {
  if (dev === null) return { label: '中性(缺数据)', multiplier: 1 };
  let score = 0;
  if (dev <= -15) score += 2;
  else if (dev <= -5) score += 1;
  else if (dev >= 10) score -= 2;
  else if (dev >= 3) score -= 1;
  if (score >= 3) return { label: '双倍', multiplier: 2 };
  if (score >= 1) return { label: '加强', multiplier: 1.5 };
  if (score >= -1) return { label: '正常', multiplier: 1 };
  if (score >= -3) return { label: '减半', multiplier: 0.5 };
  return { label: '暂停', multiplier: 0 };
}

// 复刻页面 evalFundSignal：QDII溢价 → 手动暂停/恢复 → 主题上限(金额锚定) → 常规信号
function evalFundSignalServer(f: any, nav: number, dev: number | null, streak: number | null, belowStreak: number | null, themeCaps: Record<string, number>, themeMv: number, goal: number) {
  if (f.isQDII && f.qdiiPremium !== '' && f.qdiiPremium !== undefined && !isNaN(parseFloat(f.qdiiPremium))) {
    const prem = parseFloat(f.qdiiPremium);
    if (prem >= 2) return { label: '暂停（QDII溢价）', level: 'pause', multiplier: 0 };
  }
  const capPct = themeCaps[f.theme] ?? 100;
  if (themeMv >= capPct / 100 * goal) return { label: '暂停（仓位超限）', level: 'pause', multiplier: 0 };
  if (f.manualPause) {
    const rr = f.resumeRule || { requireDays: 3, mode: 'ma_only' };
    const need = rr.requireDays ?? 3;
    const st = streak ?? 0;
    const maOk = st >= need;
    const ret = computeReturn(nav, f);
    let ddOk = true;
    if (rr.mode !== 'ma_only' && rr.targetDrawdown !== null && rr.targetDrawdown !== undefined && rr.targetDrawdown !== '') {
      ddOk = ret !== null && ret <= -Math.abs(parseFloat(rr.targetDrawdown));
    }
    const satisfied = rr.mode === 'ma_only' ? maOk : (rr.mode === 'ma_and_drawdown' ? (maOk && ddOk) : (maOk || ddOk));
    if (satisfied) {
      const base = baseSignalLabel(dev);
      return { label: '满足恢复条件 → 建议' + base.label, level: base.level, multiplier: base.multiplier, resumeReady: true };
    }
    return { label: '暂停中', level: 'pause', multiplier: 0 };
  }
  return baseSignalLabel(dev);
}

function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 极简 SMTP 会话（QQ 邮箱 465 端口隐式 TLS + AUTH LOGIN），零第三方依赖
class SmtpIO {
  conn: Deno.TlsConn;
  private buf = new Uint8Array(4096);
  private bufLen = 0;
  private bufPos = 0;
  constructor(conn: Deno.TlsConn) { this.conn = conn; }
  async readLine(): Promise<string> {
    let line = '';
    for (;;) {
      if (this.bufPos >= this.bufLen) {
        const n = await this.conn.read(this.buf);
        if (n === null) throw new Error('smtp connection closed');
        this.bufPos = 0; this.bufLen = n;
        continue;
      }
      const idx = this.buf.indexOf(10, this.bufPos);
      if (idx === -1) {
        line += new TextDecoder().decode(this.buf.subarray(this.bufPos, this.bufLen));
        this.bufPos = this.bufLen;
      } else {
        line += new TextDecoder().decode(this.buf.subarray(this.bufPos, idx));
        this.bufPos = idx + 1;
        return line.replace(/\r$/, '');
      }
    }
  }
  async writeLine(s: string): Promise<void> {
    await this.conn.write(new TextEncoder().encode(s + '\r\n'));
  }
}

async function sendMail(subject: string, html: string): Promise<void> {
  const user = Deno.env.get('SMTP_USER') || '';
  const pass = Deno.env.get('SMTP_PASS') || '';
  const conn = await Deno.connectTls({ hostname: 'smtp.qq.com', port: 465 });
  const io = new SmtpIO(conn);
  const expect = async (prefix: string, what: string) => {
    const l = await io.readLine();
    if (!l.startsWith(prefix)) throw new Error('SMTP ' + what + ': ' + l.slice(0, 120));
    return l;
  };
  try {
    await expect('220', 'greeting');
    await io.writeLine('EHLO dingtou');
    for (;;) { const l = await io.readLine(); if (l.startsWith('250 ')) break; if (l.startsWith('4') || l.startsWith('5')) throw new Error('EHLO: ' + l); }
    await io.writeLine('AUTH LOGIN');
    await expect('334', 'auth user prompt');
    await io.writeLine(base64Utf8(user));
    await expect('334', 'auth pass prompt');
    await io.writeLine(base64Utf8(pass));
    await expect('235', 'auth');
    await io.writeLine('MAIL FROM:<' + user + '>');
    await expect('250', 'mail from');
    await io.writeLine('RCPT TO:<' + user + '>');
    await expect('250', 'rcpt to');
    await io.writeLine('DATA');
    await expect('354', 'data');
    const mail = [
      'From: =?UTF-8?B?' + base64Utf8('定投信号台') + '?= <' + user + '>',
      'To: <' + user + '>',
      'Subject: =?UTF-8?B?' + base64Utf8(subject) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Utf8(html).replace(/(.{76})/g, '$1\r\n'),
      '.'
    ].join('\r\n');
    await io.writeLine(mail);
    await expect('250', 'send');
    await io.writeLine('QUIT');
  } finally {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') || '';
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || auth !== 'Bearer ' + token) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  }
  // force=true（测试用）：即使无信号变化也发送当前信号一览
  let force = false;
  try { const b = await req.json(); if (b && (b as any).force) force = true; } catch (e) { /* body 可为空 */ }
  const sbUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const summary: any = { funds: [], stocks: [], indices: [], notifications: [], users: 0 };

  const post = async (table: string, onConflict: string, rows: any[]) => {
    if (!rows.length) return;
    const r = await fetch(sbUrl + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(table + ' upsert failed ' + r.status + ': ' + (await r.text()).slice(0, 200));
  };

  // 东财接口偶发网络抖动（IPv6 出口抽签），带重试 + 镜像域名轮换
  const fetchRetry = async (url: string, headers: any, tries = 3): Promise<Response> => {
    let lastErr: any = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_r=' + Date.now(), { headers });
        if (r.ok) return r;
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { lastErr = e; }
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
    throw lastErr;
  };
  const fetchKline = async (secid: string, fqt: number, lmt: number): Promise<{ date: string; close: number; closes: number[]; name: string }> => {
    let lastErr: any = null;
    for (const host of KLINE_HOSTS) {
      try {
        const r = await fetchRetry('https://' + host + '/api/qt/stock/kline/get?secid=' + secid + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&klt=101&fqt=' + fqt + '&lmt=' + lmt + '&end=20500101', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2);
        const j = await r.json();
        const klines = (j && j.data && j.data.klines) || [];
        if (!klines.length) { lastErr = new Error('no klines'); continue; }
        const rows = klines.map((kl: string) => { const [dd, cc] = kl.split(','); return { date: dd, close: parseFloat(cc) }; });
        return { date: rows[rows.length - 1].date, close: rows[rows.length - 1].close, closes: rows.map(x => x.close), name: (j && j.data && j.data.name) || '' };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all kline hosts failed');
  };

  try {
    // 1. 读取所有用户的资产清单（基金 + 股票）
    const stRes = await fetch(sbUrl + '/rest/v1/dingtou_state?select=user_id,data', { headers: H });
    if (!stRes.ok) throw new Error('state read failed ' + stRes.status);
    const states = await stRes.json();
    summary.users = states.length;

    const fundJobs: { userId: string; code: string }[] = [];
    const stockJobs: { userId: string; code: string }[] = [];
    const idxSet = new Set<string>();
    for (const st of states) {
      const goal = (st.data && st.data.goal) || GOAL_DEFAULT;
      const funds = (st.data && st.data.funds) || [];
      for (const f of funds) {
        const code = String(f.fundCode || '').trim();
        if (/^\d{6}$/.test(code)) fundJobs.push({ userId: st.user_id, code });
        const k = f.benchmark || 'HS300';
        if (BENCH[k]) idxSet.add(k);
      }
      const stocks = (st.data && st.data.stocks) || [];
      for (const s of stocks) {
        const code = String(s.code || '').trim();
        if (/^\d{5,6}$/.test(code)) stockJobs.push({ userId: st.user_id, code });
      }
    }

    const ma = (closes: number[], n: number) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
    const avgDev = (close: number, ma60: number | null, ma120: number | null) => {
      const devs: number[] = [];
      if (ma60) devs.push((close - ma60) / ma60 * 100);
      if (ma120) devs.push((close - ma120) / ma120 * 100);
      return devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
    };

    // 2. 基金：净值/均线/信号（含卖出维度）
    const fundUniq = [...new Set(fundJobs.map(j => j.code))];
    const perUserFundItems: Record<string, string[]> = {};
    const fundSignalRows: any[] = [];
    const fundMeta: Record<string, { name: string; nav: number; navDate: string }> = {};
    for (const code of fundUniq) {
      try {
        const pzRes = await fetchRetry('https://fund.eastmoney.com/pingzhongdata/' + code + '.js?dt=' + Date.now(), {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' }
        });
        const txt = await pzRes.text();
        const nameMatch = txt.match(/var fS_name\s*=\s*"([^"]*)"/);
        const trendMatch = txt.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
        if (!trendMatch) throw new Error('no trend in source');
        const trend = JSON.parse(trendMatch[1]);
        if (!trend.length) throw new Error('no trend');
        const navs = trend.map((p: any) => parseFloat(p.y)).filter((n: number) => !isNaN(n));
        if (!navs.length) throw new Error('no nav');
        const last = trend[trend.length - 1];
        const d = new Date(last.x);
        const navDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const close = navs[navs.length - 1];
        const ma60 = ma(navs, 60);
        const ma120 = ma(navs, 120);
        const dev = avgDev(close, ma60, ma120);
        const above = ma60 === null ? null : close >= ma60;
        let streak: number | null = null, belowStreak: number | null = null;
        if (ma60 !== null) {
          streak = 0; belowStreak = 0;
          for (let i = navs.length - 1; i >= 59; i--) {
            const m = navs.slice(i - 59, i + 1).reduce((a: number, b: number) => a + b, 0) / 60;
            if (navs[i] >= m) { if (belowStreak === 0) streak++; else break; } else { if (streak === 0) belowStreak++; else break; }
          }
        }
        const users = [...new Set(fundJobs.filter(j => j.code === code).map(j => j.userId))];
        fundMeta[code] = { name: nameMatch ? nameMatch[1] : '', nav: close, navDate };
        for (const userId of users) {
          const st = states.find((s: any) => s.user_id === userId);
          const goal = (st.data && st.data.goal) || GOAL_DEFAULT;
          const funds = (st.data && st.data.funds) || [];
          const f = funds.find((x: any) => String(x.fundCode || '').trim() === code) || {};
          const fm = (f.shares > 0 && close > 0) ? f.shares * close : (parseFloat(f.marketValue) || 0);
          const themeCaps = { ...DEFAULT_CAPS, ...((st.data && st.data.themeCaps) || {}) };
          const themeSum = funds.reduce((s: number, x: any) => {
            const isSelf = String(x.fundCode || '').trim() === code;
            const xm = (isSelf && f.shares > 0 && close > 0) ? fm : (parseFloat(x.marketValue) || 0);
            return (x.theme === f.theme) ? s + (parseFloat(xm) || 0) : s;
          }, 0);
          const themeMv = themeSum;
          const sig = evalFundSignalServer(f, close, dev, streak, belowStreak, themeCaps, themeMv, goal);
          const ret = computeReturn(close, f);
          const tiers = (f.profitTiers && f.profitTiers.length) ? f.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) {
            for (const t of tiers) { if (ret >= t.ret && !(f.profitTaken || []).includes(t.ret)) newTier = t.ret; }
          }
          (perUserFundItems[userId] = perUserFundItems[userId] || []);
          const label = sig.label + (newTier !== null ? '｜止盈' + newTier + '%达标' : '');
          fundSignalRows.push({ user_id: userId, code, label, profit_tier: newTier, updated_at: new Date().toISOString() });

          await post('fund_nav_history', 'user_id,code,nav_date', [{ user_id: userId, code, nav_date: navDate, nav: close, ma60, ma120, dev_pct: dev, above_ma60: above }]);
          await post('fund_latest', 'user_id,code', [{
            user_id: userId, code, name: nameMatch ? nameMatch[1] : null, nav: close, nav_date: navDate,
            ma60, ma120, dev_pct: dev, streak, below_streak: belowStreak, updated_at: new Date().toISOString()
          }]);
        }
        summary.funds.push({ code, ok: true, nav_date: navDate, nav: close, dev: dev === null ? null : Math.round(dev * 1000) / 1000, streak });
      } catch (e) {
        summary.funds.push({ code, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 3. 股票（A股/港股）：收盘价/均线/买卖信号
    const stockUniq = [...new Set(stockJobs.map(j => j.code))];
    const perUserStockItems: Record<string, string[]> = {};
    const stockSignalRows: any[] = [];
    for (const code of stockUniq) {
      try {
        const secid = code.length === 5 ? ('116.' + code) : (code.startsWith('6') ? ('1.' + code) : ('0.' + code));
        const k = await fetchKline(secid, 1, 130);
        const close = k.close;
        const ma20 = ma(k.closes, 20);
        const ma60 = ma(k.closes, 60);
        const ma120 = ma(k.closes, 120);
        const dev = avgDev(close, ma60, ma120);
        let above = 0, below = 0;
        if (ma60 !== null) {
          for (let i = k.closes.length - 1; i >= 59; i--) {
            const m = k.closes.slice(i - 59, i + 1).reduce((a, b) => a + b, 0) / 60;
            if (k.closes[i] >= m) { if (below === 0) above++; else break; } else { if (above === 0) below++; else break; }
          }
        }
        const users = [...new Set(stockJobs.filter(j => j.code === code).map(j => j.userId))];
        for (const userId of users) {
          const st = states.find((s: any) => s.user_id === userId);
          const arr = (st.data && st.data.stocks) || [];
          const s = arr.find((x: any) => String(x.code || '').trim() === code) || {};
          const smv = (s.shares > 0) ? s.shares * close : 0;
          const ret = stockReturn(s, close);
          const tier = baseSignalLabel(dev);
          const tiers = (s.profitTiers && s.profitTiers.length) ? s.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) { for (const t of tiers) { if (ret >= t.ret && !(s.profitTaken || []).includes(t.ret)) newTier = t.ret; } }

          const label = tier.label + (newTier !== null ? '｜止盈' + newTier + '%' : '');
          const prevRes = await fetch(sbUrl + '/rest/v1/stock_signal_state?select=tier,break_hit,stop_hit,profit_tier&user_id=eq.' + userId + '&code=eq.' + code, { headers: H });
          const prevArr: any[] = prevRes.ok ? await prevRes.json() : [];
          const p = prevArr[0] || null;
          const sm = arr.find((x: any) => String(x.code || '').trim() === code);
          // 名称：用户填写 > K线响应自带名称；纯数字视为历史污染数据，忽略以打断"名称=代码"循环
          const cleanName = (v: any) => { const t = String(v || '').trim(); return (t && !/^\d+$/.test(t)) ? t : ''; };
          const sname = cleanName(s.name) || cleanName(sm?.name) || k.name || '';
          const displayName = sname || code;
          if (!p) {
            (perUserStockItems[userId] = perUserStockItems[userId] || []).push('【' + code + '】' + displayName + '：买入参考档位 <b>' + tier.label + '</b>' + (dev === null ? '' : '（偏离 ' + fmtSigned(dev) + '）'));
          } else {
            if (p.tier !== tier.label) (perUserStockItems[userId] = perUserStockItems[userId] || []).push('【' + code + '】' + displayName + '：买入参考档位变化 ' + p.tier + ' → <b>' + tier.label + '</b>' + (dev === null ? '' : '（偏离 ' + fmtSigned(dev) + '）'));
            if (newTier !== null && p.profit_tier !== newTier) (perUserStockItems[userId] = perUserStockItems[userId] || []).push('【' + code + '】' + displayName + '：收益率 <b>' + fmtSigned(ret) + '</b> 达到止盈档 +' + newTier + '%，建议分批止盈');
          }
          stockSignalRows.push({ user_id: userId, code, tier: tier.label, profit_tier: newTier, updated_at: new Date().toISOString() });

          await post('stock_history', 'user_id,code,price_date', [{ user_id: userId, code, price_date: k.date, close, ma20, ma60, ma120, dev_pct: dev }]);
          await post('stock_latest', 'user_id,code', [{
            user_id: userId, code, name: sname || null, close, price_date: k.date, ma20, ma60, ma120, dev_pct: dev,
            below_streak: below, updated_at: new Date().toISOString()
          }]);
        }
        summary.stocks.push({ code, ok: true, date: k.date, close });
      } catch (e) {
        summary.stocks.push({ code, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 4. 股票总仓位上限提醒
    for (const st of states) {
      const userId = st.user_id;
      const arr = (st.data && st.data.stocks) || [];
      if (!arr.length) continue;
      const cap = parseFloat(st.data.stockCap) || 0;
      if (!cap) continue;
      let total = 0;
      for (const s of arr) {
        const code = String(s.code || '').trim();
        const lx = summary.stocks.find((x: any) => x.code === code && x.ok);
        const px = lx ? lx.close : (parseFloat(s.currentPrice) || 0);
        total += (parseFloat(s.shares) || 0) * px;
      }
      const over = total > cap;
      const prevRes = await fetch(sbUrl + '/rest/v1/stock_signal_state?select=code,tier&user_id=eq.' + userId + '&code=eq.__STOCK_CAP__', { headers: H });
      const prevArr: any[] = prevRes.ok ? await prevRes.json() : [];
      const wasOver = prevArr.length ? prevArr[0].tier === 'over' : false;
      if (over && !wasOver) (perUserStockItems[userId] = perUserStockItems[userId] || []).push('股票总仓位 <b>¥' + Math.round(total).toLocaleString() + '</b> 已超过总额上限 ¥' + Math.round(cap).toLocaleString() + '，建议暂停买入');
      if (!over && wasOver) (perUserStockItems[userId] = perUserStockItems[userId] || []).push('股票总仓位回落至上限内（当前 ¥' + Math.round(total).toLocaleString() + ' / ¥' + Math.round(cap).toLocaleString() + '）');
      stockSignalRows.push({ user_id: userId, code: '__STOCK_CAP__', tier: over ? 'over' : 'ok', profit_tier: null, updated_at: new Date().toISOString() });
    }

    // 5. 指数行情 + 档位
    const idxLevels: Record<string, string> = {};
    for (const k of idxSet) {
      try {
        const kk = await fetchKline(BENCH[k].secid, 1, 130);
        const close = kk.close;
        const ma60 = ma(kk.closes, 60);
        const ma120 = ma(kk.closes, 120);
        const devs: number[] = [];
        if (ma60) devs.push((close - ma60) / ma60 * 100);
        if (ma120) devs.push((close - ma120) / ma120 * 100);
        const dev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
        const lv = marketLevel(dev, BENCH[k].th);
        idxLevels[k] = lv.label;
        await post('index_history', 'idx_code,idx_date', [{ idx_code: k, idx_date: kk.date, close }]);
        summary.indices.push({ idx: k, ok: true, date: kk.date, close, level: lv.label });
      } catch (e) {
        summary.indices.push({ idx: k, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 6. 与昨日信号对比，生成通知项并发邮件
    const allItems: string[] = [];
    const perUserAll: Record<string, string[]> = {};
    for (const userId of Object.keys(perUserFundItems)) perUserAll[userId] = perUserFundItems[userId].concat(perUserStockItems[userId] || []);
    for (const userId of Object.keys(perUserStockItems)) if (!perUserAll[userId]) perUserAll[userId] = perUserStockItems[userId];

    for (const userId of Object.keys(perUserAll)) {
      const items = perUserAll[userId];
      // signal_state 只存基金信号（股票信号有自己的 stock_signal_state）
      const todayRows = fundSignalRows.filter(r => r.user_id === userId);
      const prevRes = await fetch(sbUrl + '/rest/v1/signal_state?select=code,label&user_id=eq.' + userId, { headers: H });
      const prev: any[] = prevRes.ok ? await prevRes.json() : [];
      const prevMap: Record<string, string> = {};
      prev.forEach((p: any) => prevMap[p.code] = p.label);
      const isFirstRun = prev.length === 0;

      const stateRows = todayRows.map(r => ({ user_id: userId, code: r.code, label: r.label, profit_tier: r.profit_tier, updated_at: new Date().toISOString() }));
      await post('signal_state', 'user_id,code', stateRows);

      // 基金常规信号变化（label 前半段变化，不含卖出标记）
      for (const r of stateRows) {
        if (r.code === '__STOCK_CAP__') continue;
        const p = prevMap[r.code];
        const curBase = String(r.label).split('｜')[0];
        const prevBase = p ? String(p).split('｜')[0] : null;
        const meta = fundMeta[r.code];
        const nameStr = meta && meta.name ? ' ' + meta.name : '';
        const navStr = meta ? '（净值 ' + meta.nav + '，' + meta.navDate + '）' : '';
        if (p && prevBase !== curBase) {
          items.unshift('【' + r.code + nameStr + '】基金信号变化：' + prevBase + ' → <b>' + curBase + '</b>' + navStr);
        } else if (!p) {
          items.unshift('【' + r.code + nameStr + '】基金当前信号：<b>' + curBase + '</b>' + navStr);
        }
      }

      // 指数档位变化
      const idxPrevRes = await fetch(sbUrl + '/rest/v1/index_state?select=idx_code,label', { headers: H });
      const idxPrev: any[] = idxPrevRes.ok ? await idxPrevRes.json() : [];
      const idxPrevMap: Record<string, string> = {};
      idxPrev.forEach((p: any) => idxPrevMap[p.idx_code] = p.label);
      const idxRows: any[] = [];
      for (const k of Object.keys(idxLevels)) {
        const label = idxLevels[k];
        if (idxPrevMap[k] && idxPrevMap[k] !== label) items.push('大盘参考：' + BENCH[k].name + ' 档位变化 ' + idxPrevMap[k] + ' → <b>' + label + '</b>');
        idxRows.push({ idx_code: k, label, updated_at: new Date().toISOString() });
      }
      if (idxRows.length) await post('index_state', 'idx_code', idxRows);

      summary.notifications.push({ userId: userId.slice(0, 8), items: items.length, sent: false });

      if (items.length > 0 || isFirstRun || force) {
        const dateStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
        const title = isFirstRun ? '定投信号基线快照（首次启用通知）' : (items.length ? '定投信号变化提醒（' + items.length + ' 条）' : '定投信号一览（无变化）');
        const html = '<div style="font-family:-apple-system,PingFang SC,Arial;max-width:560px;margin:0 auto;font-size:14px;color:#1B2436;line-height:1.7;">'
          + '<h2 style="font-size:18px;border-bottom:2px solid #A87C2E;padding-bottom:8px;">定投信号台 · ' + title + '</h2>'
          + '<p style="color:#707C8C;">' + dateStr + ' 收盘数据已自动更新</p>'
          + (items.length
            ? '<ul style="padding-left:18px;margin:12px 0;">' + items.map(i => '<li style="margin:8px 0;">' + i + '</li>').join('') + '</ul>'
            : '<p>各基金当前信号：</p><ul style="padding-left:18px;">' + stateRows.map(r => { const meta = fundMeta[r.code]; return '<li>【' + r.code + (meta && meta.name ? ' ' + meta.name : '') + '】：<b>' + String(r.label).split('｜')[0] + '</b>' + (meta ? '（净值 ' + meta.nav + '，' + meta.navDate + '）' : '') + '</li>'; }).join('') + '</ul>')
          + '<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">'
          + '<p style="color:#707C8C;font-size:12px;">本邮件由定投信号台自动发送 · 每日 20:30/22:30 自动更新 · 仅信号变化时提醒</p>'
          + '</div>';
        try {
          await sendMail('【定投信号台】' + title + ' - ' + dateStr, html);
          summary.notifications[summary.notifications.length - 1].sent = true;
        } catch (e) {
          summary.notifications[summary.notifications.length - 1].mailError = String((e as any)?.message || e).slice(0, 200);
        }
      }
    }

    summary.ok = true;
    summary.at = new Date().toISOString();
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e).slice(0, 200) }), { status: 500 });
  }
});
