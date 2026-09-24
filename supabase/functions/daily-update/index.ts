// daily-update: 每日自动更新基金净值/均线、股票收盘行情与参考指数行情（pg_cron 经 HTTP 调用）
// v4: + 分析报告（每只基金/股票：信号→状态→趋势→下一步操作），修正报告条目与状态表
// 触发方式: POST /functions/v1/daily-update，Authorization: Bearer <DAILY_UPDATE_TOKEN>
// 可选 body: {"force":true} 无变化也发送报告
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
const KLINE_HOSTS = ['push2his.eastmoney.com', '1.push2his.eastmoney.com', '23.push2his.eastmoney.com', '33.push2his.eastmoney.com', '44.push2his.eastmoney.com', '92.push2his.eastmoney.com', '98.push2his.eastmoney.com', '99.push2his.eastmoney.com'];

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
function evalFundSignalServer(f: any, nav: number, dev: number | null, streak: number | null, themeCaps: Record<string, number>, themeMv: number, goal: number) {
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

  const fetchRetry = async (url: string, headers: any, tries = 3, timeoutMs = 9000): Promise<Response> => {
    let lastErr: any = null;
    for (let i = 0; i < tries; i++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_r=' + Date.now(), { headers, signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) return r;
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { clearTimeout(to); lastErr = (e && (e as any).name === 'AbortError') ? new Error('timeout ' + timeoutMs + 'ms') : e; }
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
    // 1. 读取所有用户的资产清单
    const stRes = await fetch(sbUrl + '/rest/v1/dingtou_state?select=user_id,data', { headers: H });
    if (!stRes.ok) throw new Error('state read failed ' + stRes.status);
    const states = await stRes.json();
    summary.users = states.length;

    const fundJobs: { userId: string; code: string }[] = [];
    const stockJobs: { userId: string; code: string }[] = [];
    const invalidStocks: Record<string, { code: string; name: string }[]> = {};
    const idxSet = new Set<string>();
    for (const st of states) {
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
        else (invalidStocks[st.user_id] = invalidStocks[st.user_id] || []).push({ code: code || '(空)', name: s.name || '' });
      }
    }

    const ma = (closes: number[], n: number) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
    const avgDev = (close: number, ma60: number | null, ma120: number | null) => {
      const devs: number[] = [];
      if (ma60) devs.push((close - ma60) / ma60 * 100);
      if (ma120) devs.push((close - ma120) / ma120 * 100);
      return devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
    };

    // 2. 先取参考指数行情与档位（基金/股票报告的建议金额需要用到系数）
    const idxLevels: Record<string, { label: string; coef: number }> = {};
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
        idxLevels[k] = { label: lv.label, coef: lv.coef };
        await post('index_history', 'idx_code,idx_date', [{ idx_code: k, idx_date: kk.date, close }]);
        summary.indices.push({ idx: k, ok: true, date: kk.date, close, level: lv.label });
      } catch (e) {
        summary.indices.push({ idx: k, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 3. 基金：净值/均线/信号 + 分析报告数据
    const fundUniq = [...new Set(fundJobs.map(j => j.code))];
    const fundSignalRows: any[] = [];
    const fundMeta: Record<string, { name: string; nav: number; navDate: string }> = {};
    const fundReport: Record<string, any[]> = {};
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
        let streak: number | null = null;
        if (navs.length >= 60) {
          streak = 0;
          for (let i = navs.length - 1; i >= 59; i--) {
            const m = navs.slice(i - 59, i + 1).reduce((a: number, b: number) => a + b, 0) / 60;
            if (navs[i] >= m) streak++; else break;
          }
        }
        fundMeta[code] = { name: nameMatch ? nameMatch[1] : '', nav: close, navDate };

        const users = [...new Set(fundJobs.filter(j => j.code === code).map(j => j.userId))];
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
          const sig = evalFundSignalServer(f, close, dev, streak, themeCaps, themeSum, goal);
          const ret = computeReturn(close, f);
          const tiers = (f.profitTiers && f.profitTiers.length) ? f.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) {
            for (const t of tiers) { if (ret >= t.ret && !(f.profitTaken || []).includes(t.ret)) newTier = t.ret; }
          }
          const label = sig.label + (newTier !== null ? '｜止盈' + newTier + '%达标' : '');
          fundSignalRows.push({ user_id: userId, code, label, profit_tier: newTier, benchmark: f.benchmark || 'HS300', updated_at: new Date().toISOString() });

          // 分析报告数据（大盘系数已知）
          const bkey = f.benchmark || 'HS300';
          const bl = idxLevels[bkey] || null;
          const coef = (bl && sig.multiplier > 0) ? bl.coef : 1;
          const amount = (parseFloat(f.baseAmount) || 0) * sig.multiplier * coef;
          const taken = f.profitTaken || [];
          const nextTier = tiers.find((x: any) => !taken.includes(x.ret)) || null;
          (fundReport[userId] = fundReport[userId] || []).push({
            code, name: nameMatch ? nameMatch[1] : (f.name || ''), nav: close, navDate,
            dev, ma60, ma120, streak, label: sig.label, multiplier: sig.multiplier,
            amount: Math.round(amount), benchmarkName: bl ? BENCH[bkey].name : '', benchmarkLevel: bl ? bl.label : '',
            ret, nextTier, resumeReady: !!sig.resumeReady, theme: f.theme || ''
          });

          await post('fund_nav_history', 'user_id,code,nav_date', [{ user_id: userId, code, nav_date: navDate, nav: close, ma60, ma120, dev_pct: dev, above_ma60: above }]);
          await post('fund_latest', 'user_id,code', [{
            user_id: userId, code, name: nameMatch ? nameMatch[1] : null, nav: close, nav_date: navDate,
            ma60, ma120, dev_pct: dev, streak, updated_at: new Date().toISOString()
          }]);
        }
        summary.funds.push({ code, ok: true, nav_date: navDate, nav: close, dev: dev === null ? null : Math.round(dev * 1000) / 1000, streak });
      } catch (e) {
        summary.funds.push({ code, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 4. 股票（A股/港股）：收盘价/均线/信号 + 分析报告数据
    const stockUniq = [...new Set(stockJobs.map(j => j.code))];
    const stockSignalRows: any[] = [];
    const stockReport: Record<string, any[]> = {};
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
          const ret = stockReturn(s, close);
          const tier = baseSignalLabel(dev);
          const tiers = (s.profitTiers && s.profitTiers.length) ? s.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) { for (const t of tiers) { if (ret >= t.ret && !(s.profitTaken || []).includes(t.ret)) newTier = t.ret; } }

          const label = tier.label + (newTier !== null ? '｜止盈' + newTier + '%' : '');
          stockSignalRows.push({ user_id: userId, code, tier: tier.label, profit_tier: newTier, updated_at: new Date().toISOString() });

          const sname = s.name || k.name || '';
          const taken = s.profitTaken || [];
          const nextTier = tiers.find((x: any) => !taken.includes(x.ret)) || null;
          (stockReport[userId] = stockReport[userId] || []).push({
            code, name: sname || code, close, date: k.date, dev, ma60, ma120, below,
            tier: tier.label, ret, nextTier
          });

          await post('stock_history', 'user_id,code,price_date', [{ user_id: userId, code, price_date: k.date, close, ma20, ma60, ma120, dev_pct: dev }]);
          await post('stock_latest', 'user_id,code', [{
            user_id: userId, code, name: sname || null, close, price_date: k.date, ma20, ma60, ma120, dev_pct: dev,
            below_streak: below, updated_at: new Date().toISOString()
          }]);
        }
        summary.stocks.push({ code, ok: true, date: k.date, close });
      } catch (e) {
        const msg = String((e as any)?.message || e).slice(0, 140);
        summary.stocks.push({ code, ok: false, error: msg });
        const errUsers = [...new Set(stockJobs.filter(j => j.code === code).map(j => j.userId))];
        for (const uid of errUsers) {
          const stt = states.find((s: any) => s.user_id === uid);
          const arr = (stt && stt.data && stt.data.stocks) || [];
          const rec = arr.find((x: any) => String(x.code || '').trim() === code);
          const nm = (rec && rec.name) || '';
          (stockReport[uid] = stockReport[uid] || []).push({ fetchError: '【' + code + (nm ? ' ' + nm : '') + '】行情抓取失败：' + msg + '（本次未纳入分析，下次运行会自动重试；若持续失败请核对该代码是否为有效 A股6位/港股5位）' });
        }
      }
    }

    // 5. 股票总仓位上限提醒
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
      stockSignalRows.push({ user_id: userId, code: '__STOCK_CAP__', tier: over ? 'over' : 'ok', profit_tier: null, updated_at: new Date().toISOString() });
      if (over && !wasOver) {
        (stockReport[userId] = stockReport[userId] || []).push({ capAlert: '股票总仓位 ¥' + Math.round(total).toLocaleString() + ' 已超过总额上限 ¥' + Math.round(cap).toLocaleString() + '，建议暂停买入' });
      }
    }

    // 6. 分析报告 + 与昨日信号对比的变化提醒 + 邮件
    for (const userId of new Set([...Object.keys(fundReport), ...Object.keys(stockReport), ...Object.keys(invalidStocks)])) {
      const st = states.find((s: any) => s.user_id === userId);
      const items: string[] = [];

      // 将“代码无效”的股票并入告警，确保误填代码不再被静默丢弃
      for (const iv of (invalidStocks[userId] || [])) {
        (stockReport[userId] = stockReport[userId] || []).push({ fetchError: '【' + iv.code + (iv.name ? ' ' + iv.name : '') + '】代码格式无效（应为 A股6位/港股5位纯数字），未能获取行情，请在股票页修正' });
      }
      const stockWarnCount = (stockReport[userId] || []).filter((r: any) => r.fetchError).length;
      if (stockWarnCount > 0) items.push('⚠️ 有 ' + stockWarnCount + ' 只股票行情获取异常，详见下方股票分析');

      // 6a. 与昨日 signal_state 对比：基金常规信号变化
      const todayRows = fundSignalRows.filter(r => r.user_id === userId);
      const prevRes = await fetch(sbUrl + '/rest/v1/signal_state?select=code,label&user_id=eq.' + userId, { headers: H });
      const prev: any[] = prevRes.ok ? await prevRes.json() : [];
      const prevMap: Record<string, string> = {};
      prev.forEach((p: any) => prevMap[p.code] = p.label);
      const isFirstRun = prev.length === 0;
      const stateRows = todayRows.map(r => ({ user_id: userId, code: r.code, label: r.label, profit_tier: r.profit_tier, benchmark: r.benchmark, updated_at: new Date().toISOString() }));
      await post('signal_state', 'user_id,code', stateRows);
      for (const r of stateRows) {
        const p = prevMap[r.code];
        const curBase = String(r.label).split('｜')[0];
        const prevBase = p ? String(p).split('｜')[0] : null;
        const meta = fundMeta[r.code];
        const nameStr = meta && meta.name ? ' ' + meta.name : '';
        if (p && prevBase !== curBase) items.push('【' + r.code + nameStr + '】基金信号变化：' + prevBase + ' → <b>' + curBase + '</b>');
      }

      // 6b. 指数档位变化
      const idxPrevRes = await fetch(sbUrl + '/rest/v1/index_state?select=idx_code,label', { headers: H });
      const idxPrev: any[] = idxPrevRes.ok ? await idxPrevRes.json() : [];
      const idxPrevMap: Record<string, string> = {};
      idxPrev.forEach((p: any) => idxPrevMap[p.idx_code] = p.label);
      const idxRows: any[] = [];
      for (const k of Object.keys(idxLevels)) {
        if (idxPrevMap[k] && idxPrevMap[k] !== idxLevels[k].label) items.push('大盘参考：' + BENCH[k].name + ' 档位变化 ' + idxPrevMap[k] + ' → <b>' + idxLevels[k].label + '</b>');
        idxRows.push({ idx_code: k, label: idxLevels[k].label, updated_at: new Date().toISOString() });
      }
      if (idxRows.length) await post('index_state', 'idx_code', idxRows);

      summary.notifications.push({ userId: userId.slice(0, 8), items: items.length, sent: false });

      // 6c. 组装分析报告邮件：信号 → 状态 → 趋势 → 操作
      const dateStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const title = isFirstRun ? '定投分析报告（首次启用）' : (items.length ? '定投分析报告 · ' + items.length + ' 条信号变化' : '定投分析报告 · 信号平稳');

      const fundBlock = (fundReport[userId] || []).map(r => {
        const zone = r.dev === null ? '数据不足' : (r.dev <= -15 ? '深度低位' : r.dev <= -5 ? '低位区' : r.dev < 3 ? '中性区间' : r.dev < 10 ? '偏高区' : '明显高位');
        const benchmarkStr = r.benchmarkLevel ? '｜基准 ' + r.benchmarkName + ' ' + r.benchmarkLevel : '';
        // 下一买入档位：按偏离度边界换算成具体净值触发价
        let buyNextStr = '';
        if (r.dev !== null && r.ma60 && r.ma120) {
          const maAvg = (r.ma60 + r.ma120) / 2;
          if (r.dev < -15) buyNextStr = '｜已达最高买入档（双倍）';
          else if (r.dev < -5) buyNextStr = '｜下一买入档：净值跌至 ' + (maAvg * 0.85).toFixed(4) + '（-15%）升为双倍';
          else if (r.dev < 3) buyNextStr = '｜下一买入档：净值跌至 ' + (maAvg * 0.95).toFixed(4) + '（-5%）升为加强';
          else buyNextStr = '｜下一买入档：净值回落至 ' + (maAvg * 1.03).toFixed(4) + '（+3%内）恢复正常';
        }
        const statusStr = '净值 ' + r.nav + '（' + r.navDate + '）｜较均线 ' + (r.dev === null ? '--' : fmtSigned(r.dev)) + '（' + zone + '）' + (r.streak !== null ? '｜连续 ' + r.streak + ' 日站上60日线' : '') + benchmarkStr + buyNextStr;
        const signalStr = '信号 <b>' + r.label + '</b>' + (r.multiplier > 0 && r.amount > 0 ? ' · 本期建议买入 <b>¥' + r.amount + '</b>/期' : ' · 暂停买入');
        let actionStr: string;
        if (r.label.includes('QDII溢价')) actionStr = '溢价率过高，暂停买入，等待溢价回落';
        else if (r.label.includes('仓位超限')) actionStr = '主题仓位已达上限，停止买入该主题；浮盈可按止盈档分批兑现';
        else if (r.label === '暂停中') actionStr = '已按你的要求暂停定投，恢复条件满足时系统会提醒你';
        else if (r.resumeReady) actionStr = '恢复条件已满足，可恢复定投';
        else if (r.dev === null) actionStr = '自动获取数据后即可分析';
        else if (r.dev <= -15) actionStr = '加大买入，积极拉低成本';
        else if (r.dev <= -5) actionStr = '维持或加大定投节奏';
        else if (r.dev < 3) actionStr = '按计划定投，持有不动';
        else if (r.dev < 10) actionStr = '放缓定投节奏，关注止盈档位';
        else actionStr = '停止加码，浮盈分批止盈锁定收益';
        const profitStr = r.ret === null ? '' : ('当前收益率 ' + fmtSigned(r.ret) + (r.nextTier ? '｜下一止盈档 +' + r.nextTier.ret + '%（卖' + r.nextTier.sell + '%）' : '｜各止盈档已执行完毕'));
        return '<li style="margin:12px 0;padding:10px 12px;background:#FAF8F2;border-radius:8px;">'
          + '<b>【' + r.code + '】' + r.name + '</b>'
          + '<div style="margin:4px 0;">📊 信号：<b style="color:#A87C2E;">' + r.label + '</b>' + (r.multiplier > 0 && r.amount > 0 ? ' · 本期建议买入 <b>¥' + r.amount + '</b>/期' : ' · 暂停买入') + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">📈 ' + statusStr + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">💰 ' + profitStr + '</div>'
          + '<div style="margin-top:4px;">👉 ' + actionStr + '</div>'
          + '</li>';
      }).join('');

      const stockBlock = (stockReport[userId] || []).map(r => {
        if (r.fetchError) return '<li style="margin:12px 0;padding:10px 12px;background:#B14A341A;border-radius:8px;color:#B14A34;">⚠️ ' + r.fetchError + '</li>';
        if (r.capAlert) return '<li style="margin:12px 0;padding:10px 12px;background:#B14A341A;border-radius:8px;color:#B14A34;">⚠️ ' + r.capAlert + '</li>';
        const zone = r.dev === null ? '数据不足' : (r.dev <= -15 ? '深度低位' : r.dev <= -5 ? '低位区' : r.dev < 3 ? '中性区间' : r.dev < 10 ? '偏高区' : '明显高位');
        let actionStr: string;
        if (r.dev === null) actionStr = '等待行情数据';
        else if (r.dev <= -15) actionStr = '深度低位，可分批买入拉低成本';
        else if (r.dev <= -5) actionStr = '低位区，可考虑分批买入';
        else if (r.dev < 3) actionStr = '持有观察';
        else if (r.dev < 10) actionStr = '偏高区，不再追高，关注止盈档';
        else actionStr = '明显高位，浮盈分批止盈锁定收益';
        const trendStr = r.ma60 ? (r.below > 0 ? '已连续 ' + r.below + ' 日低于60日线' : (r.above > 0 ? '已连续 ' + r.above + ' 日站上60日线' : '')) : '';
        const profitStr = r.ret === null ? '' : ('当前收益率 ' + fmtSigned(r.ret) + (r.nextTier ? '｜下一止盈档 +' + r.nextTier.ret + '%（卖' + r.nextTier.sell + '%）' : ''));
        return '<li style="margin:12px 0;padding:10px 12px;background:#FAF8F2;border-radius:8px;">'
          + '<b>【' + r.code + '】' + r.name + '</b>'
          + '<div style="margin:4px 0;">📊 买入参考：<b style="color:#A87C2E;">' + r.tier + '</b> · 现价 ' + r.close + '（' + r.date + '）</div>'
          + '<div style="color:#707C8C;font-size:13px;">📈 较均线 ' + (r.dev === null ? '--' : fmtSigned(r.dev)) + '（' + zone + '）' + (trendStr ? '｜' + trendStr : '') + '</div>'
          + '<div style="color:#707C8C;font-size:13px;">💰 ' + profitStr + '</div>'
          + '<div style="margin-top:4px;">👉 ' + actionStr + '</div>'
          + '</li>';
      }).join('');

      const html = '<div style="font-family:-apple-system,PingFang SC,Arial;max-width:600px;margin:0 auto;font-size:14px;color:#1B2436;line-height:1.7;">'
        + '<h2 style="font-size:18px;border-bottom:2px solid #A87C2E;padding-bottom:8px;">定投信号台 · ' + title + '</h2>'
        + '<p style="color:#707C8C;">' + dateStr + ' 收盘数据已自动更新</p>'
        + (items.length
          ? '<h3 style="font-size:16px;margin:20px 0 12px;">📢 今日重要提醒</h3><ul style="padding-left:18px;margin:12px 0;">' + items.map(i => '<li style="margin:8px 0;">' + i + '</li>').join('') + '</ul>'
          : '<p style="color:#3F8A68;">✅ 今日无信号变化，各资产按计划执行即可。</p>')
        + '<h3 style="font-size:16px;margin:20px 0 12px;">📊 基金分析</h3>'
        + (fundBlock ? '<ul style="padding-left:0;list-style:none;">' + fundBlock + '</ul>' : '<p style="color:#707C8C;">暂无基金</p>')
        + '<h3 style="font-size:16px;margin:20px 0 12px;">💹 股票分析</h3>'
        + (stockBlock ? '<ul style="padding-left:0;list-style:none;">' + stockBlock + '</ul>' : '<p style="color:#707C8C;">暂无股票（可在股票标签页添加）</p>')
        + '<div style="background:#F1EDE3;padding:14px;border-radius:8px;margin:16px 0;font-size:13px;">'
        + '<b>📖 信号规则速查</b>：双倍/加强 = 加大买入拉低成本｜正常 = 按计划定投｜减半/暂停 = 少买或停买<br>'
        + '止盈档位达到时系统会提醒分批卖出；大盘参考指数升至高位会降低买入系数。'
        + '</div>'
        + '<p style="color:#707C8C;font-size:12px;">本邮件由定投信号台自动发送 · 每日 20:30/22:30 自动更新</p>'
        + '</div>';

      if (items.length > 0 || isFirstRun || force) {
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
