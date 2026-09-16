// daily-update: 每日自动更新基金净值/均线与参考指数行情（由 Supabase pg_cron 经 HTTP 调用）
// v2: + 服务端信号引擎（复刻页面规则）+ 信号变化对比 + QQ 邮箱通知（手写 SMTP，零依赖）
// 触发方式: POST /functions/v1/daily-update，Authorization: Bearer <DAILY_UPDATE_TOKEN>

const GOAL = 200000;
const DEFAULT_TIERS = [{ ret: 20, sell: 10 }, { ret: 40, sell: 20 }, { ret: 60, sell: 30 }, { ret: 80, sell: 50 }];
const DEFAULT_CAPS: Record<string, number> = { '电力/新能源': 20, '全球资源': 20, '机器人/先进制造': 15, '日本股票': 15, '均衡配置': 30, '其他': 15 };
const BENCH: Record<string, { secid: string; name: string; th: number[] }> = {
  HS300: { secid: '1.000300', name: '沪深300', th: [-8, -3, 3, 8] },
  NDX: { secid: '100.NDX', name: '纳斯达克', th: [-8, -3, 3, 8] },
  SPX: { secid: '100.SPX', name: '标普500', th: [-8, -3, 3, 8] },
  DJIA: { secid: '100.DJIA', name: '道琼斯', th: [-8, -3, 3, 8] },
  HSI: { secid: '100.HSI', name: '恒生指数', th: [-8, -3, 3, 8] },
  HSTECH: { secid: '124.HSTECH', name: '恒生科技', th: [-12, -5, 5, 12] }
};

function marketLevel(dev: number | null, th: number[]) {
  if (dev === null) return { level: 'neutral', label: '中性', coef: 1 };
  if (dev <= th[0]) return { level: 'deep-low', label: '深度低位', coef: 1.5 };
  if (dev <= th[1]) return { level: 'low', label: '低位', coef: 1.25 };
  if (dev >= th[3]) return { level: 'deep-high', label: '明显高位', coef: 0.5 };
  if (dev >= th[2]) return { level: 'high', label: '高位', coef: 0.75 };
  return { level: 'neutral', label: '中性', coef: 1 };
}

function computeReturn(f: any, nav: number): number | null {
  const cb = (f.costBasis && f.costBasis > 0) ? f.costBasis
    : ((f.costTotal && f.costTotal > 0 && nav > 0 && f.marketValue > 0) ? f.costTotal / (f.marketValue / f.currentNav) : 0);
  if (!cb) return null;
  return (nav - cb) / cb * 100;
}

// 复刻页面 baseSignal：偏离度 + 估值百分位打分
function baseSignal(dev: number | null, f: any): { label: string; level: string; multiplier: number } {
  let score = 0;
  const pctRaw = f.valuationPercentile;
  const pct = (pctRaw === '' || pctRaw === undefined || pctRaw === null) ? null : parseFloat(pctRaw);
  if (dev !== null) {
    if (dev <= -15) score += 2;
    else if (dev <= -5) score += 1;
    else if (dev >= 10) score -= 2;
    else if (dev >= 3) score -= 1;
  }
  if (pct !== null && !isNaN(pct)) {
    if (pct <= 20) score += 2;
    else if (pct <= 40) score += 1;
    else if (pct >= 80) score -= 2;
    else if (pct >= 60) score -= 1;
  }
  if (score >= 3) return { label: '双倍', level: 'double', multiplier: 2 };
  if (score >= 1) return { label: '加强', level: 'strong', multiplier: 1.5 };
  if (score >= -1) return { label: '正常', level: 'normal', multiplier: 1 };
  if (score >= -3) return { label: '减半', level: 'half', multiplier: 0.5 };
  return { label: '暂停', level: 'pause', multiplier: 0 };
}

// 复刻页面 evalFundSignal：QDII溢价 → 手动暂停/恢复 → 主题上限 → 常规信号
function evalFundSignalServer(f: any, nav: number, ma60: number | null, ma120: number | null, dev: number | null, streak: number | null, themeCaps: Record<string, number>, themeWeight: number) {
  if (f.isQDII && f.qdiiPremium !== '' && f.qdiiPremium !== undefined && !isNaN(parseFloat(f.qdiiPremium))) {
    const prem = parseFloat(f.qdiiPremium);
    if (prem >= 2) return { label: '暂停（QDII溢价）', level: 'pause', multiplier: 0 };
  }
  const cap = themeCaps[f.theme] ?? 100;
  if (themeWeight >= cap) return { label: '暂停（仓位超限）', level: 'pause', multiplier: 0 };
  if (f.manualPause) {
    const rr = f.resumeRule || { requireDays: 3, mode: 'ma_only' };
    const need = rr.requireDays ?? 3;
    const st = streak ?? 0;
    const maOk = st >= need;
    const ret = computeReturn(f, nav);
    let ddOk = true;
    if (rr.mode !== 'ma_only' && rr.targetDrawdown !== null && rr.targetDrawdown !== undefined && rr.targetDrawdown !== '') {
      ddOk = ret !== null && ret <= -Math.abs(parseFloat(rr.targetDrawdown));
    }
    const satisfied = rr.mode === 'ma_only' ? maOk : (rr.mode === 'ma_and_drawdown' ? (maOk && ddOk) : (maOk || ddOk));
    if (satisfied) {
      const base = baseSignal(dev, f);
      return { label: '满足恢复条件 → 建议' + base.label, level: base.level, multiplier: base.multiplier, resumeReady: true };
    }
    return { label: '暂停中', level: 'pause', multiplier: 0 };
  }
  return baseSignal(dev, f);
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
  const sbUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const summary: any = { funds: [], indices: [], notifications: [], users: 0 };

  const post = async (table: string, onConflict: string, rows: any[]) => {
    if (!rows.length) return;
    const r = await fetch(sbUrl + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(table + ' upsert failed ' + r.status + ': ' + (await r.text()).slice(0, 200));
  };

  // 东财接口偶发网络抖动（尤其 IPv6 路由），统一带重试
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

  try {
    // 1. 读取所有用户的基金清单
    const stRes = await fetch(sbUrl + '/rest/v1/dingtou_state?select=user_id,data', { headers: H });
    if (!stRes.ok) throw new Error('state read failed ' + stRes.status);
    const states = await stRes.json();
    summary.users = states.length;

    const jobs: { userId: string; code: string }[] = [];
    const idxSet = new Set<string>();
    for (const st of states) {
      const funds = (st.data && st.data.funds) || [];
      for (const f of funds) {
        const code = String(f.fundCode || '').trim();
        if (/^\d{6}$/.test(code)) jobs.push({ userId: st.user_id, code });
        const k = f.benchmark || 'HS300';
        if (BENCH[k]) idxSet.add(k);
      }
    }

    // 2. 逐基金抓取净值并计算（含信号）
    const uniq = [...new Set(jobs.map(j => j.code))];
    const perUser: Record<string, { code: string; label: string; profitTier: number | null; item: string | null }[]> = {};
    for (const code of uniq) {
      try {
        const r = await fetchRetry('https://fund.eastmoney.com/pingzhongdata/' + code + '.js?dt=' + Date.now(), {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' }
        });
        if (!r.ok) throw new Error('fetch ' + r.status);
        const txt = await r.text();
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
        const ma60 = navs.length >= 60 ? navs.slice(-60).reduce((a: number, b: number) => a + b, 0) / 60 : null;
        const ma120 = navs.length >= 120 ? navs.slice(-120).reduce((a: number, b: number) => a + b, 0) / 120 : null;
        const devs: number[] = [];
        if (ma60) devs.push((close - ma60) / ma60 * 100);
        if (ma120) devs.push((close - ma120) / ma120 * 100);
        const dev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
        const above = ma60 === null ? null : close >= ma60;
        let streak: number | null = null;
        if (navs.length >= 60) {
          streak = 0;
          for (let i = navs.length - 1; i >= 59; i--) {
            const ma = navs.slice(i - 59, i + 1).reduce((a: number, b: number) => a + b, 0) / 60;
            if (navs[i] >= ma) streak++; else break;
          }
        }

        // 每个持有该基金的用户：算信号、对比昨日
        const users = [...new Set(jobs.filter(j => j.code === code).map(j => j.userId))];
        for (const userId of users) {
          const st = states.find((s: any) => s.user_id === userId);
          const funds = (st.data && st.data.funds) || [];
          const f = funds.find((x: any) => String(x.fundCode || '').trim() === code) || {};
          const mv = (f.shares > 0 && close > 0) ? f.shares * close : (parseFloat(f.marketValue) || 0);
          const themeCaps = { ...DEFAULT_CAPS, ...((st.data && st.data.themeCaps) || {}) };
          const themeSum = funds.reduce((s: number, x: any) => {
            const xm = (x.shares > 0 && close > 0 && String(x.fundCode||'').trim() === code) ? mv : (x.marketValue || 0);
            return (x.theme === f.theme) ? s + (parseFloat(xm) || 0) : s;
          }, 0);
          const totalMv = funds.reduce((s: number, x: any) => {
            const isSelf = String(x.fundCode || '').trim() === code;
            const xm = (isSelf && f.shares > 0 && close > 0) ? mv : (parseFloat(x.marketValue) || 0);
            return s + xm;
          }, 0);
          const themeWeight = totalMv > 0 ? themeSum / totalMv * 100 : 0;

          const sig = evalFundSignalServer(f, close, ma60, ma120, dev, streak, themeCaps, themeWeight);
          const ret = computeReturn(f, close);
          const tiers = (f.profitTiers && f.profitTiers.length) ? f.profitTiers : DEFAULT_TIERS;
          let newTier: number | null = null;
          if (ret !== null && ret > 0) {
            for (const t of tiers) { if (ret >= t.ret && !(f.profitTaken || []).includes(t.ret)) newTier = t.ret; }
          }

          (perUser[userId] = perUser[userId] || []).push({ code, label: sig.label, profitTier: newTier, item: null, ret, dev, name: nameMatch ? nameMatch[1] : (f.name || ''), resumeReady: !!sig.resumeReady, theme: f.theme || '' });

          const histRow: any = { user_id: userId, code, nav_date: navDate, nav: close, ma60, ma120, dev_pct: dev, above_ma60: above };
          await post('fund_nav_history', 'user_id,code,nav_date', [histRow]);
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

    // 3. 指数行情 + 档位
    const idxLevels: Record<string, string> = {};
    for (const k of idxSet) {
      try {
        // push2his 有数字前缀镜像；不同函数实例的 IPv6 出口质量不同，轮换域名可绕过单实例网络故障
        const hosts = ['push2his.eastmoney.com', '1.push2his.eastmoney.com', '23.push2his.eastmoney.com', '92.push2his.eastmoney.com'];
        let j: any = null;
        let lastErr: any = null;
        for (const host of hosts) {
          try {
            const r = await fetchRetry('https://' + host + '/api/qt/stock/kline/get?secid=' + BENCH[k].secid + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&klt=101&fqt=1&lmt=130&end=20500101', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2);
            j = await r.json();
            if (j && j.data && j.data.klines && j.data.klines.length) { lastErr = null; break; }
            lastErr = new Error('no klines');
          } catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
        const klines = (j && j.data && j.data.klines) || [];
        if (!klines.length) throw new Error('no klines');
        const rows = klines.map((kl: string) => { const [dd, cc] = kl.split(','); return { idx_code: k, idx_date: dd, close: parseFloat(cc) }; });
        await post('index_history', 'idx_code,idx_date', rows);
        const closes = rows.map(x => x.close);
        const close = closes[closes.length - 1];
        const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;
        const ma120 = closes.length >= 120 ? closes.slice(-120).reduce((a, b) => a + b, 0) / 120 : null;
        const devs: number[] = [];
        if (ma60) devs.push((close - ma60) / ma60 * 100);
        if (ma120) devs.push((close - ma120) / ma120 * 100);
        const dev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
        const lv = marketLevel(dev, BENCH[k].th);
        idxLevels[k] = lv.label;
        const lastParts = klines[klines.length - 1].split(',');
        summary.indices.push({ idx: k, ok: true, date: lastParts[0], close, level: lv.label });
      } catch (e) {
        summary.indices.push({ idx: k, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    // 4. 与昨日信号对比，生成通知项并发邮件
    for (const userId of Object.keys(perUser)) {
      const items: string[] = [];
      const today = perUser[userId];
      const prevRes = await fetch(sbUrl + '/rest/v1/signal_state?select=code,label,profit_tier&user_id=eq.' + userId, { headers: H });
      const prev: any[] = prevRes.ok ? await prevRes.json() : [];
      const prevMap: Record<string, any> = {};
      prev.forEach((p: any) => prevMap[p.code] = p);
      const isFirstRun = prev.length === 0;

      const stateRows: any[] = [];
      for (const t of today) {
        const p = prevMap[t.code];
        if (!p) {
          items.push('【' + t.code + '】' + t.name + '：当前信号 <b>' + t.label + '</b>' + (t.dev === null ? '' : '（偏离 ' + fmtSigned(t.dev) + '）'));
        } else if (p.label !== t.label) {
          items.push('【' + t.code + '】' + t.name + '：信号变化 ' + p.label + ' → <b>' + t.label + '</b>' + (t.dev === null ? '' : '（偏离 ' + fmtSigned(t.dev) + '）'));
        }
        if (t.profitTier !== null && p && p.profit_tier !== t.profitTier) {
          const tier = DEFAULT_TIERS.find(x => x.ret === t.profitTier);
          items.push('【' + t.code + '】' + t.name + '：收益率 <b>' + fmtSigned(t.ret) + '</b> 达到止盈档 +' + t.profitTier + '%，建议止盈 ' + (tier ? tier.sell : 10) + '% 份额');
        }
        if (t.resumeReady) {
          items.push('【' + t.code + '】' + t.name + '：<b>满足恢复条件</b>，当前建议：' + t.label.replace('满足恢复条件 → 建议', ''));
        }
        stateRows.push({ user_id: userId, code: t.code, label: t.label, profit_tier: t.profitTier, updated_at: new Date().toISOString() });
      }
      await post('signal_state', 'user_id,code', stateRows);

      // 指数档位变化
      const idxPrevRes = await fetch(sbUrl + '/rest/v1/index_state?select=idx_code,label', { headers: H });
      const idxPrev: any[] = idxPrevRes.ok ? await idxPrevRes.json() : [];
      const idxPrevMap: Record<string, string> = {};
      idxPrev.forEach((p: any) => idxPrevMap[p.idx_code] = p.label);
      const idxRows: any[] = [];
      for (const k of Object.keys(idxLevels)) {
        const label = idxLevels[k];
        if (idxPrevMap[k] && idxPrevMap[k] !== label) {
          items.push('大盘参考：' + BENCH[k].name + ' 档位变化 ' + idxPrevMap[k] + ' → <b>' + label + '</b>');
        }
        idxRows.push({ idx_code: k, label, updated_at: new Date().toISOString() });
      }
      if (idxRows.length) await post('index_state', 'idx_code', idxRows);

      summary.notifications.push({ userId: userId.slice(0, 8), items: items.length, sent: false });

      // 有变化（或首次运行发基线）才发信
      if (items.length > 0 || isFirstRun) {
        const dateStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
        const title = isFirstRun ? '定投信号基线快照（首次启用通知）' : '定投信号变化提醒（' + items.length + ' 条）';
        const html = '<div style="font-family:-apple-system,PingFang SC,Arial;max-width:560px;margin:0 auto;font-size:14px;color:#1B2436;line-height:1.7;">'
          + '<h2 style="font-size:18px;border-bottom:2px solid #A87C2E;padding-bottom:8px;">定投信号台 · ' + title + '</h2>'
          + '<p style="color:#707C8C;">' + dateStr + ' 收盘数据已自动更新</p>'
          + (items.length
            ? '<ul style="padding-left:18px;margin:12px 0;">' + items.map(i => '<li style="margin:8px 0;">' + i + '</li>').join('') + '</ul>'
            : '<p>以下为当前全部信号：</p><ul style="padding-left:18px;">' + today.map(t => '<li>【' + t.code + '】' + t.name + '：<b>' + t.label + '</b></li>').join('') + '</ul>')
          + '<hr style="border:none;border-top:1px solid #eee;margin:16px 0;">'
          + '<p style="color:#707C8C;font-size:12px;">本邮件由定投信号台自动发送 · 每日 20:30/22:30 自动更新数据 · 仅信号变化时提醒</p>'
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
