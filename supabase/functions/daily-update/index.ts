// daily-update: 每日自动更新基金净值/均线与参考指数行情（由 Supabase pg_cron 经 HTTP 调用）
// 触发方式: POST /functions/v1/daily-update，Authorization: Bearer <DAILY_UPDATE_TOKEN>
Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') || '';
  const token = Deno.env.get('DAILY_UPDATE_TOKEN') || '';
  if (!token || auth !== 'Bearer ' + token) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  }
  const sbUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SB_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const H = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const summary: any = { funds: [], indices: [], users: 0 };

  const post = async (table: string, onConflict: string, rows: any[]) => {
    const r = await fetch(sbUrl + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(table + ' upsert failed ' + r.status + ': ' + (await r.text()).slice(0, 200));
  };

  try {
    // 1. 读取所有用户的基金清单（service role 绕过 RLS）
    const stRes = await fetch(sbUrl + '/rest/v1/dingtou_state?select=user_id,data', { headers: H });
    if (!stRes.ok) throw new Error('state read failed ' + stRes.status);
    const states = await stRes.json();
    summary.users = states.length;

    const BENCH: Record<string, string> = {
      HS300: '1.000300', NDX: '100.NDX', SPX: '100.SPX',
      DJIA: '100.DJIA', HSI: '100.HSI', HSTECH: '124.HSTECH'
    };
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

    // 2. 逐基金抓取全历史净值，计算并落库
    const uniq = [...new Set(jobs.map(j => j.code))];
    for (const code of uniq) {
      try {
        const r = await fetch('https://fund.eastmoney.com/pingzhongdata/' + code + '.js?dt=' + Date.now(), {
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
        const users = [...new Set(jobs.filter(j => j.code === code).map(j => j.userId))];
        for (const userId of users) {
          await post('fund_nav_history', 'user_id,code,nav_date', [{
            user_id: userId, code, nav_date: navDate, nav: close, ma60, ma120, dev_pct: dev, above_ma60: above
          }]);
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

    // 3. 参考指数日行情落库
    for (const k of idxSet) {
      try {
        const r = await fetch('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + BENCH[k] + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&klt=101&fqt=1&lmt=3&end=20500101', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const j = await r.json();
        const klines = (j && j.data && j.data.klines) || [];
        if (!klines.length) throw new Error('no klines');
        const rows = klines.map((kl: string) => {
          const [dd, cc] = kl.split(',');
          return { idx_code: k, idx_date: dd, close: parseFloat(cc) };
        });
        await post('index_history', 'idx_code,idx_date', rows);
        const lastParts = klines[klines.length - 1].split(',');
        summary.indices.push({ idx: k, ok: true, date: lastParts[0], close: parseFloat(lastParts[1]) });
      } catch (e) {
        summary.indices.push({ idx: k, ok: false, error: String((e as any)?.message || e).slice(0, 140) });
      }
    }

    summary.ok = true;
    summary.at = new Date().toISOString();
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e).slice(0, 200) }), { status: 500 });
  }
});
