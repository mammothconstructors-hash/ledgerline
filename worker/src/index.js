import UNIVERSE from './universe.js';
import { issuerHoldings } from './issuer.js';
// sec-proxy — one Worker, two jobs:
//   1. GET /?u=<sec.gov url>   the original relay your Google Sheet uses (unchanged)
//   2. POST /mcp               an MCP server the LedgerLine page reads through a claude.ai
//                              custom connector named "SEC EDGAR". Tools:
//                                sec_statements  income statement, balance sheet, cash flow,
//                                                comprehensive income (10-K years + TTM / latest quarter)
//                                sec_section     MD&A, notes to the financials, risk factors, business,
//                                                legal proceedings text from the latest 10-K / 10-Q
//                                sec_mdna        Management's Discussion & Analysis text from the
//                                                latest 10-K (Item 7) or 10-Q (Item 2)
//   3. GET /api/...            JSON for the LedgerLine site (ledgerline-dv0.pages.dev):
//   4. /billing/... and /stripe/webhook   subscriptions: Stripe checkout (21-day trial) and Access login sync
//                                /api/search?q=  /api/profile?ticker=  /api/statements?ticker=
//                                /api/section?ticker=&section=  /api/market?symbol=
// Needs Workers Paid ($5/mo): companyfacts JSON for large companies takes more CPU than the
// free plan's 10 ms per request.
// Deploy: Cloudflare dashboard → Workers & Pages → sec-proxy → Edit code → replace all → Deploy.

const WORKER_VERSION = '3.19.0';
// the usage passphrase is matched loosely: case, spaces and quotes don't matter (phones capitalize the first letter)
const keyNorm = k => String(k || '').replace(/[\s'"`“”‘’]+/g, '').toLowerCase();
async function keyOk(given, env) {   // matches the USAGE_KEY secret, or the owner key kept in the database
  const g = keyNorm(given); if (!g) return false;
  if (env.USAGE_KEY && g === keyNorm(env.USAGE_KEY)) return true;
  try { const r = USAGE_DB && await USAGE_DB.prepare("SELECT v FROM settings WHERE k = 'usage_key'").first(); return !!(r && r.v && g === keyNorm(r.v)); } catch (e) { return false; }
}

const UA = 'Kevin Rodrigue kgrodrigue@yahoo.com';
const SEC_HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': 'application/json,text/html,text/plain,*/*' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    USAGE_DB = env && env.DB || null; MS_LIMIT = Number(env && env.MARKETSTACK_LIMIT) || 10000;
    if (url.pathname === '/usage/testers') return testersApi(req, url, env || {});
    if (url.pathname === '/usage' || url.pathname.startsWith('/usage/')) return usagePage(url, env || {});
    if (!url.searchParams.get('u') && /^\/[A-Za-z0-9_-]{6,64}\/?$/.test(url.pathname) && await keyOk(url.pathname.replace(/\//g, ''), env || {})) return usagePage(new URL(url.origin + '/usage?key=' + encodeURIComponent(url.pathname.replace(/\//g, ''))), env || {});
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return mcp(req);
    if (url.pathname.startsWith('/api/')) return api(req, url, env || {}, ctx);
    if (url.pathname.startsWith('/billing/') || url.pathname === '/stripe/webhook') return billing(req, url, env || {});
    return relay(req);
  },
  // every 2 minutes: if tonight's sector ranks are not built yet, do the next few Marketstack calls (see rankStep)
  async scheduled(event, env, ctx) {
    USAGE_DB = env && env.DB || null;
    if (env && env.DB && env.CF_ACCESS_TOKEN) ctx.waitUntil(testerQueue(env).catch(e => rankLog(env, 'error', 'testers: ' + String(e && e.message || e))));
    if (env && env.DB) ctx.waitUntil(rankLog(env, 'cron', event && event.cron || '').then(() => env.MARKETSTACK_KEY ? rankStep(env, 3) : rankLog(env, 'error', 'no MARKETSTACK_KEY')).catch(e => rankLog(env, 'error', String(e && e.message || e))));
  }
};

/* ================= sector ranks: S&P 500 total returns over a week, month, quarter and year, ranked within each GICS sector =================
   3.10.0: closes are stored in D1 (rank_hist) and returns are worked out from that history, so each stock costs one
   Marketstack lookup a night instead of five. Marketstack bills a many-symbol request once per symbol, so that is what we count.
     backfill (once, and again for any stock more than 12 days behind): one symbol per request, ~13 months of daily closes
     nightly: 80 symbols per request, last 10 sessions; if a dividend or split re-based adj_close, the stored history is rescaled to match */
const RANK_WINS = [['w', 7], ['m', 30], ['q', 91], ['y', 365]], RANK_BATCH = 80, RANK_KEEP_DAYS = 400, RANK_BACKFILL_DAYS = 380;
async function rankLog(env, kind, msg) { try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS worker_log (ts INTEGER, kind TEXT, msg TEXT)').run(); await env.DB.batch([env.DB.prepare('INSERT INTO worker_log (ts, kind, msg) VALUES (?, ?, ?)').bind(Date.now(), kind, String(msg).slice(0, 300)), env.DB.prepare('DELETE FROM worker_log WHERE ts < ?').bind(Date.now() - 3 * 864e5)]); } catch (e) { } }
// a page view also nudges the build along (at most once a minute per instance), so ranks fill in even before the schedule fires
let RANK_NUDGE = 0;
function rankNudge(env, ctx) { if (!env.DB || !env.MARKETSTACK_KEY || !ctx || !ctx.waitUntil || Date.now() - RANK_NUDGE < 60e3) return; RANK_NUDGE = Date.now(); ctx.waitUntil(rankStep(env, 2).then(r => r && r.error ? rankLog(env, 'error', r.error) : null).catch(e => rankLog(env, 'error', String(e && e.message || e)))); }
async function rankSchema(DB) {
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS universe (ticker TEXT PRIMARY KEY, sector TEXT, sub TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS rank_hist (ticker TEXT, date TEXT, adj REAL, PRIMARY KEY (ticker, date))'),
    DB.prepare('CREATE TABLE IF NOT EXISTS rank_tk (ticker TEXT PRIMARY KEY, last TEXT)'),   // latest close stored per stock
    DB.prepare('CREATE TABLE IF NOT EXISTS rank_job (session TEXT PRIMARY KEY, step INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, updated INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS ranks (ticker TEXT PRIMARY KEY, sector TEXT, sub TEXT, session TEXT, w REAL, m REAL, q REAL, y REAL)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'),
    DB.prepare('DROP TABLE IF EXISTS rank_px')   // the old five-lookups-per-stock scratch table
  ]);
  const has = await DB.prepare('SELECT COUNT(*) AS n FROM universe').first();
  if (!has || !has.n) { const st = DB.prepare('INSERT OR REPLACE INTO universe (ticker, sector, sub) VALUES (?, ?, ?)'); for (let i = 0; i < UNIVERSE.length; i += 100) await DB.batch(UNIVERSE.slice(i, i + 100).map(r => st.bind(r[0], r[1], r[2]))); }
}
const dayShift = (iso, d) => new Date(Date.parse(iso + 'T12:00:00Z') - d * 864e5).toISOString().slice(0, 10);
const msSym = t => t.replace('-', '.');
// one build at a time: the 2-minute schedule and page-view nudges can overlap, and an overlap would pay for the same stocks twice
async function rankLock(DB, take) {
  const now = Date.now();
  if (!take) { await DB.prepare("DELETE FROM settings WHERE k = 'rank_lock'").run(); return true; }
  await DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('rank_lock', '0')").run();
  const r = await DB.prepare("UPDATE settings SET v = ? WHERE k = 'rank_lock' AND CAST(v AS INTEGER) < ?").bind(String(now), now - 100e3).run();
  return !!(r.meta && r.meta.changes);
}
async function rankPull(env, symbols, from, to, limit) {
  const u = `https://api.marketstack.com/v2/eod?access_key=${encodeURIComponent(env.MARKETSTACK_KEY)}&symbols=${encodeURIComponent(symbols.map(msSym).join(','))}&date_from=${from}&date_to=${to}&limit=${limit}`;
  const r = await msFetch(u, { headers: { Accept: 'application/json' } }, 'ranks', symbols.length);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Marketstack: ' + ((j.error && (j.error.message || j.error.code)) || r.status));
  const back = Object.fromEntries(symbols.map(t => [msSym(t), t])), out = {};
  for (const row of j.data || []) {
    const t = back[row.symbol] || row.symbol, d = String(row.date).slice(0, 10), v = Number(row.adj_close ?? row.close);
    if (!isFinite(v) || v <= 0 || d > to) continue;
    (out[t] = out[t] || {})[d] = v;
  }
  return out;
}
// store one stock's closes; if the overlap with what is stored shows adj_close was re-based, rescale the old rows first
async function rankStore(DB, t, px, session) {
  const dates = Object.keys(px).sort(); if (!dates.length) return null;
  const ops = [], first = dates[0];
  const prev = await DB.prepare('SELECT date, adj FROM rank_hist WHERE ticker = ? AND date >= ? ORDER BY date DESC LIMIT 1').bind(t, first).first();
  if (prev && px[prev.date] && prev.adj > 0) {
    const k = px[prev.date] / prev.adj;
    if (Math.abs(k - 1) > 1e-6) ops.push(DB.prepare('UPDATE rank_hist SET adj = adj * ? WHERE ticker = ? AND date < ?').bind(k, t, first));
  }
  const st = DB.prepare('INSERT OR REPLACE INTO rank_hist (ticker, date, adj) VALUES (?, ?, ?)');
  for (const d of dates) ops.push(st.bind(t, d, px[d]));
  ops.push(DB.prepare('INSERT INTO rank_tk (ticker, last) VALUES (?, ?) ON CONFLICT (ticker) DO UPDATE SET last = excluded.last').bind(t, dates[dates.length - 1]));
  ops.push(DB.prepare('DELETE FROM rank_hist WHERE ticker = ? AND date < ?').bind(t, dayShift(session, RANK_KEEP_DAYS)));
  for (let i = 0; i < ops.length; i += 400) await DB.batch(ops.slice(i, i + 400));
  return dates[dates.length - 1];
}
async function rankStep(env, calls = 3) {
  const DB = env.DB; await rankSchema(DB);
  const session = expectedSession();
  const job = await DB.prepare('SELECT done FROM rank_job WHERE session = ?').bind(session).first();
  if (job && job.done) return { session, done: true };
  if (!job) await DB.prepare('INSERT OR IGNORE INTO rank_job (session, step, done, updated) VALUES (?, 0, 0, ?)').bind(session, Date.now()).run();
  if (!(await rankLock(DB, true))) return { session, busy: true };
  try {
    const rows = (await DB.prepare('SELECT u.ticker, t.last FROM universe u LEFT JOIN rank_tk t ON t.ticker = u.ticker ORDER BY u.ticker').all()).results || [];
    if (!rows.length) return { session, error: 'universe is empty' };
    const stale = dayShift(session, 12);
    const backfill = rows.filter(r => !r.last || r.last < stale).map(r => r.ticker);
    const nightly = rows.filter(r => r.last && r.last >= stale && r.last < session).map(r => r.ticker);
    let used = 0;
    // 1. backfill: one symbol per request so a year of closes fits in a single 1,000-row page (one billed call per stock)
    for (const t of backfill) {
      if (used >= calls * 8) break;
      used++;
      const got = await rankPull(env, [t], dayShift(session, RANK_BACKFILL_DAYS), session, 1000);
      if (!(await rankStore(DB, t, got[t] || {}, session))) await DB.prepare('INSERT INTO rank_tk (ticker, last) VALUES (?, ?) ON CONFLICT (ticker) DO UPDATE SET last = excluded.last').bind(t, session).run();   // no data (halted or delisted): don't retry nightly
    }
    // 2. nightly: the last 10 sessions for up to 80 stocks per request
    for (let i = 0; i < nightly.length && used < calls; i += RANK_BATCH, used++) {
      const batch = nightly.slice(i, i + RANK_BATCH), got = await rankPull(env, batch, dayShift(session, 14), session, 1000);
      for (const t of batch) { if (!(await rankStore(DB, t, got[t] || {}, session))) await DB.prepare('UPDATE rank_tk SET last = ? WHERE ticker = ?').bind(session, t).run(); }
    }
    await DB.prepare('UPDATE rank_job SET updated = ? WHERE session = ?').bind(Date.now(), session).run();
    const left = await DB.prepare('SELECT COUNT(*) AS n FROM universe u LEFT JOIN rank_tk t ON t.ticker = u.ticker WHERE t.last IS NULL OR t.last < ?').bind(session).first();
    if (left && left.n) return { session, left: left.n };
    // 3. everything is current: returns from stored closes (latest close on or before each target date, within 9 days)
    const at = col => `(SELECT h.adj FROM rank_hist h WHERE h.ticker = u.ticker AND h.date <= ${col} AND h.date >= date(${col}, '-9 days') ORDER BY h.date DESC LIMIT 1)`;
    const tg = Object.fromEntries(RANK_WINS.map(([k, back]) => [k, dayShift(session, back)]));
    await DB.batch([
      DB.prepare(`INSERT OR REPLACE INTO ranks (ticker, sector, sub, session, w, m, q, y)
        SELECT ticker, sector, sub, ?1, p0 / pw - 1, p0 / pm - 1, p0 / pq - 1, p0 / py - 1 FROM (
          SELECT u.ticker, u.sector, u.sub, ${at('?1')} AS p0, ${at('?2')} AS pw, ${at('?3')} AS pm, ${at('?4')} AS pq, ${at('?5')} AS py FROM universe u
        ) WHERE p0 IS NOT NULL`).bind(session, tg.w, tg.m, tg.q, tg.y),
      DB.prepare('DELETE FROM ranks WHERE session <> ?').bind(session),
      DB.prepare('UPDATE rank_job SET done = 1, updated = ? WHERE session = ?').bind(Date.now(), session),
      DB.prepare('DELETE FROM rank_job WHERE session < ?').bind(dayShift(session, 30))
    ]);
    return { session, done: true };
  } finally { await rankLock(DB, false); }
}
/* ================= ETF holdings from SEC Form N-PORT (3.12.0) =================
   Marketstack's ETF holdings are N-PORT data resold at 20x the call count, so we read N-PORT from EDGAR directly: free.
   ticker -> fund series (company_tickers_mf.json) -> latest public NPORT-P for that series -> primary_doc.xml -> holdings.
   Public N-PORT is the third month of each quarter, released about 60 days later, so lists run 2-3 months behind.
   Funds missing from the SEC fund list (unit trusts such as SPY, QQQ, DIA) are found by their company CIK instead. Kept in D1 for a day per ETF. */
const xTag = (x, tag) => { const m = x.match(new RegExp('<(?:\\w+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>')); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').trim() : null; };
const xAttr = (x, tag, attr) => { const m = x.match(new RegExp('<(?:\\w+:)?' + tag + '\\b[^>]*\\b' + attr + '="([^"]*)"')); return m ? m[1].trim() : null; };
async function fundSeries(ticker) {
  const r = await secGet('https://www.sec.gov/files/company_tickers_mf.json', 86400);
  if (!r) throw new Error('SEC fund ticker list unavailable');
  const j = await r.json(), f = j.fields || ['cik', 'seriesId', 'classId', 'symbol'], iS = f.indexOf('symbol'), iC = f.indexOf('cik'), iSe = f.indexOf('seriesId');
  const row = (j.data || []).find(d => String(d[iS]).toUpperCase() === ticker);
  if (row) return { cik: String(row[iC]), series: String(row[iSe]) };
  // unit trusts have no series: use the trust's own CIK from the company ticker list
  try { const co = await cikFor(ticker); return { cik: co.cikInt, series: co.cik, name: co.name }; } catch (e) { return null; }
}
async function latestNport(fs) {
  // EDGAR's company browser takes a series id in place of a CIK
  const r = await secGet(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fs.series}&type=NPORT-P&dateb=&owner=include&count=10&output=atom`, 21600);
  if (!r) return null;
  const atom = await r.text();
  for (const e of atom.split(/<entry>/).slice(1)) {
    const form = xTag(e, 'filing-type') || xAttr(e, 'category', 'term');
    if (form && !/^NPORT-P$/i.test(form)) continue;   // skip NPORT-P/A amendments only when an original exists further down; take the first original
    const acc = xTag(e, 'accession-number') || ((e.match(/\d{10}-\d{2}-\d{6}/) || [])[0]);
    if (!acc) continue;
    return { acc, filed: xTag(e, 'filing-date'), href: xTag(e, 'filing-href') };
  }
  return null;
}
// 3.12.2: SEC first (free); if the SEC has nothing, Marketstack's ETF endpoint once (it bills 20 calls). Either answer,
// found or not, is kept for the day, so a fund costs at most one Marketstack lookup a day.
async function etfHoldings(symbol, env) {
  const sym = String(symbol || '').trim().toUpperCase().replace('.', '-');
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(sym)) throw new Error('symbol is required');
  const DB = env.DB, day = etDay();
  if (DB) {
    await DB.prepare('CREATE TABLE IF NOT EXISTS etf_hold (symbol TEXT PRIMARY KEY, day TEXT, body TEXT)').run();
    const hit = await DB.prepare('SELECT day, body FROM etf_hold WHERE symbol = ?').bind(sym).first();
    if (hit && hit.day === day && (!/"count":0,/.test(hit.body) || /"checked":true/.test(hit.body))) return JSON.parse(hit.body);
  }
  // 3.13.0: the fund company's own daily file first; SEC N-PORT (3-4 months behind) only if that fails
  let out = null, why = '';
  try { const r = await issuerHoldings(sym); if (r) out = await finishHoldings(sym, day, r, env); } catch (e) { why = String(e && e.message || e); }
  if (!out || !out.count) { try { out = await secHoldings(sym, env, day); } catch (e) { out = { symbol: sym, day, count: 0, holdings: [], sectors: [], unavailable: true, reason: 'SEC lookup failed: ' + String(e && e.message || e).slice(0, 160) }; } if (why) out.issuerError = why.slice(0, 300); }
  if (!out.count && env.MARKETSTACK_KEY) {
    const ms = await msHoldings(sym, env, day).catch(e => ({ count: 0, reason: String(e && e.message || e) }));
    if (ms.count) out = ms; else out = { ...out, reason: out.reason + ' Marketstack has no holdings for it either.' };
  }
  out = { ...out, checkedAt: Date.now() };
  if (DB) await DB.prepare('INSERT INTO etf_hold (symbol, day, body) VALUES (?, ?, ?) ON CONFLICT (symbol) DO UPDATE SET day = excluded.day, body = excluded.body').bind(sym, day, JSON.stringify({ ...out, checked: true })).run();
  return out;
}
async function msHoldings(sym, env, day) {
  const r = await msFetch(`https://api.marketstack.com/v2/etfholdings?access_key=${encodeURIComponent(env.MARKETSTACK_KEY)}&ticker=${encodeURIComponent(sym.replace('-', '.'))}&limit=1000`, { headers: { Accept: 'application/json' } }, 'etf', 20);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || (j.code && Number(j.code) >= 400)) return { count: 0 };
  const pickNum = (o, ks) => { for (const k of ks) { const v = o && o[k]; if (v !== undefined && v !== null && v !== '' && isFinite(Number(v))) return Number(v); } return null; };
  const pickStr = (o, ks) => { for (const k of ks) { const v = o && o[k]; if (v && typeof v === 'string') return v.trim(); } return null; };
  const WK = ['pct_val', 'pctVal', 'weight', 'weight_percentage', 'percentage', 'pct_of_net_assets'];
  let list = [], seen = new Set(), stack = [j];
  while (stack.length) { const o = stack.shift(); if (!o || typeof o !== 'object' || seen.has(o)) continue; seen.add(o);
    if (Array.isArray(o) && o.length && typeof o[0] === 'object' && o.some(h => pickNum(h, WK) != null)) { list = o; break; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === 'object') stack.push(v); }
  let rows = list.map(h => ({ symbol: pickStr(h, ['ticker', 'symbol']), name: pickStr(h, ['name', 'title', 'holding_name']) || '', cusip: pickStr(h, ['cusip']),
    weight: pickNum(h, WK), value: pickNum(h, ['val_usd', 'valUSD', 'value', 'market_value']), shares: pickNum(h, ['balance', 'shares']), type: pickStr(h, ['asset_cat', 'assetCat', 'asset_type']) || '' })).filter(h => h.name && h.weight != null);
  const tot = rows.reduce((a, h) => a + h.weight, 0); if (tot > 0 && tot < 1.5) rows.forEach(h => { h.weight *= 100; });
  const isCash = h => h.type === 'STIV' || /money market|cash collateral|liquidity fund|government (money|cash)|cash management/i.test(h.name);
  const cashW = rows.filter(isCash).reduce((a, h) => a + h.weight, 0);
  rows = rows.filter(h => !isCash(h)).sort((a, b) => b.weight - a.weight);
  if (!rows.length) return { count: 0 };
  const top10 = rows.slice(0, 10).reduce((a, h) => a + h.weight, 0), b = j.basics || (j.data && j.data.basics) || {}, at = (j.output && j.output.attributes) || {};
  return { symbol: sym, fund: pickStr(at, ['series_name']) || pickStr(b, ['fund_name']) || sym, day, asOf: pickStr(at, ['rep_pd_date', 'report_date', 'date']) || null, count: rows.length,
    top10Weight: Math.round(top10 * 100) / 100, cashWeight: Math.round(cashW * 100) / 100, sectors: [], holdings: rows.slice(0, 500), source: 'Marketstack ETF holdings (SEC N-PORT)' };
}
/* ================= 3x leverage board (3.15.0) =================
   Each 3x fund next to the ETF that holds its index: price and returns (Marketstack end of day), 30-day implied vol (Cboe),
   realized vol, realized leverage and beta, expected drag at implied and realized vol, and last year's decay split from costs.
   IV30 is stored once a day per symbol (D1 iv_hist) so IV rank and percentile build up from today. Cached 15 minutes. */
const LEV_PAIRS = [['QQQ', 'Nasdaq-100', [['TQQQ', 3]]], ['SPY', 'S&P 500', [['UPRO', 3]]], ['DIA', 'Dow 30', [['UDOW', 3]]], ['IWM', 'Russell 2000', [['TNA', 3], ['URTY', 3]]], ['SOXX', 'NYSE Semiconductor (SOXL’s index)', [['SOXL', 3]]], ['XLK', 'Technology Select Sector', [['TECL', 3]]]];
const lvRet = (c, k) => c && c.length > k && c[c.length - 1 - k] > 0 ? (c[c.length - 1] / c[c.length - 1 - k] - 1) * 100 : null;
const lvLogs = c => { const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1])); return r; };
const lvSd = r => { if (r.length < 5) return null; const m = r.reduce((a, v) => a + v, 0) / r.length; return Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1)); };
const lvHv = (c, n) => c && c.length > n + 1 ? (lvSd(lvLogs(c.slice(-n - 1))) || 0) * Math.sqrt(252) * 100 : null;
const lvDrag = (L, vol) => vol == null ? null : (L * L - L) / 2 * (vol / 100) ** 2 * 100;
const lvR = (v, d = 2) => v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
function lvStats(d) {
  const c = d.c, n = c.length, last = c[n - 1], t = d.t, yr = new Date(t[n - 1] * 1000).getUTCFullYear();
  const y0 = t.findIndex(x => new Date(x * 1000).getUTCFullYear() === yr), ytd = y0 > 0 ? (last / c[y0 - 1] - 1) * 100 : null;
  const st5 = t[n - 1] - 5 * 365.25 * 86400; let i5 = t.findIndex(x => x >= st5); if (i5 < 0) i5 = 0;
  // running drawdown over 5 years: worst, today's depth percentile (share of days shallower than today), average 10%+ drop
  let pk = c[i5], pkAt = i5, worst = 0; const dd = [], drops = []; let cur = 0;
  for (let i = i5; i < n; i++) { if (c[i] >= pk) { if (cur <= -10) drops.push(cur); cur = 0; pk = c[i]; pkAt = i; } const v = (c[i] / pk - 1) * 100; dd.push(v); cur = Math.min(cur, v); worst = Math.min(worst, v); }
  if (cur <= -10) drops.push(cur);
  const today = dd[dd.length - 1], ddPct = dd.filter(v => v > today).length / dd.length * 100, avg10 = drops.length ? drops.reduce((a, v) => a + v, 0) / drops.length : null;
  return { price: last, d1: lvRet(c, 1), w1: lvRet(c, 5), m1: lvRet(c, 21), m3: lvRet(c, 63), ytd, y1: lvRet(c, 252), hv20: lvHv(c, 20), hv60: lvHv(c, 60), hv252: lvHv(c, 252),
    ddPct, avg10, drops10: drops.length,
    below: (last / Math.max(...c.slice(i5)) - 1) * 100, highAt: new Date(t[c.slice(i5).indexOf(Math.max(...c.slice(i5))) + i5] * 1000).toISOString().slice(0, 10), worst5: worst };
}
function lvPair(fd, ud, L) {   // matched days: realized leverage, beta, and last year's decay vs costs
  const key = x => new Date(x * 1000).toISOString().slice(0, 10), U = {}; ud.t.forEach((x, i) => { U[key(x)] = ud.c[i]; });
  const rows = []; fd.t.forEach((x, i) => { const u = U[key(x)]; if (u) rows.push([fd.c[i], u, x]); });
  const tail = (k) => rows.slice(-k - 1), rr = a => { const f = [], u = []; for (let i = 1; i < a.length; i++) { f.push(a[i][0] / a[i - 1][0] - 1); u.push(a[i][1] / a[i - 1][1] - 1); } return [f, u]; };
  const [f60, u60] = rr(tail(60)), mu = u60.reduce((a, v) => a + v, 0) / (u60.length || 1), mf = f60.reduce((a, v) => a + v, 0) / (f60.length || 1);
  let cov = 0, vu = 0; for (let i = 0; i < u60.length; i++) { cov += (f60[i] - mf) * (u60[i] - mu); vu += (u60[i] - mu) ** 2; }
  const beta = vu ? cov / vu : null, sdU = lvSd(u60), sdF = lvSd(f60);
  const end = rows.length ? rows[rows.length - 1][2] : 0, yr = rows.filter(r => r[2] >= end - 365.25 * 86400);
  let y = null;
  if (yr.length > 200) { let comp = 1; for (let i = 1; i < yr.length; i++) comp *= 1 + L * (yr[i][1] / yr[i - 1][1] - 1);
    const uR = (yr[yr.length - 1][1] / yr[0][1] - 1) * 100, fR = (yr[yr.length - 1][0] / yr[0][0] - 1) * 100, cR = (comp - 1) * 100;
    y = { under: uR, simple: L * uR, compounded: cR, fund: fR, decay: cR - L * uR, costs: fR - cR, days: yr.length }; }
  // the same split month to date and over 3 months
  const win = k => { const a = tail(k); if (a.length < k * 0.8) return null; let comp = 1; for (let i = 1; i < a.length; i++) comp *= 1 + L * (a[i][1] / a[i - 1][1] - 1); const uR = (a[a.length - 1][1] / a[0][1] - 1) * 100; return { decay: (comp - 1) * 100 - L * uR, fund: (a[a.length - 1][0] / a[0][0] - 1) * 100, simple: L * uR }; };
  return { beta: lvR(beta, 2), realizedLev: sdU && sdF ? lvR(sdF / sdU, 2) : null, y1: y, m1: win(21), m3: win(63) };
}
// 3.16.0: drag-regime backtest. Ten years of daily closes for a 3x fund and its index; every day is labelled with the drag
// the index's 20-day realized vol implied that day (Light under 8%/yr, Moderate 8-20%, Heavy 20%+, same cut-offs as the cards),
// then the next 1 and 3 months are measured: the fund, 3x the index, the index, and 1/3 fund + 2/3 T-bills.
const TB3 = '2015:0.03,0.02,0.03,0.02,0.02,0.02,0.03,0.07,0.02,0.02,0.12,0.23|2016:0.26,0.31,0.29,0.23,0.27,0.27,0.30,0.30,0.29,0.33,0.45,0.51|2017:0.51,0.52,0.74,0.80,0.89,0.98,1.07,1.01,1.03,1.07,1.23,1.32|2018:1.41,1.57,1.70,1.76,1.86,1.90,1.96,2.03,2.13,2.25,2.33,2.37|2019:2.37,2.39,2.40,2.38,2.35,2.17,2.10,1.95,1.89,1.65,1.54,1.54|2020:1.52,1.52,0.29,0.14,0.13,0.16,0.13,0.10,0.11,0.10,0.09,0.09|2021:0.08,0.04,0.03,0.02,0.02,0.04,0.05,0.05,0.04,0.05,0.05,0.06|2022:0.15,0.33,0.44,0.76,0.98,1.49,2.23,2.63,3.13,3.72,4.15,4.25|2023:4.54,4.65,4.69,4.92,5.14,5.16,5.25,5.30,5.32,5.34,5.27,5.24|2024:5.22,5.24,5.24,5.24,5.25,5.24,5.20,5.05,4.72,4.51,4.42,4.27|2025:4.21,4.22,4.20,4.21,4.25,4.23,4.25,4.12,3.92,3.82,3.78,3.59|2026:3.57,3.60,3.61,3.61,3.60,3.66,3.73,3.72,3.94';
const TBM = (() => { const m = {}; for (const yr of TB3.split('|')) { const [y, v] = yr.split(':'); v.split(',').forEach((x, i) => { m[`${y}-${String(i + 1).padStart(2, '0')}`] = Number(x); }); } return m; })();
const TB_LAST = Object.keys(TBM).sort().pop();
const tbill = iso => { const k = iso.slice(0, 7); return TBM[k] != null ? TBM[k] : k > TB_LAST ? TBM[TB_LAST] : 0.03; };
async function lvLong(sym, env, ctx) {   // ten years of split-adjusted daily closes, cached a day
  const day = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10), key = new Request(`https://ledgerline-cache.internal/levlong/v2/${sym}/${day}`), cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  if (!env.MARKETSTACK_KEY) throw new Error('Price feed not configured');
  const m = await marketstack(sym, env.MARKETSTACK_KEY, 2700), d = { t: m.daily.t, c: m.daily.c };
  // the price feed has no history for some funds before mid-2020 (UPRO, UDOW, URTY): splice in earlier daily closes, scaled to meet at the first shared day
  const want = Date.now() / 1000 - 10 * 365.25 * 86400;
  if (d.t.length && d.t[0] > want + 120 * 86400) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json(), res = j && j.chart && j.chart.result && j.chart.result[0], ts = res && res.timestamp, cl = res && res.indicators && res.indicators.quote && res.indicators.quote[0].close;
      if (ts && cl) {
        const day = x => Math.floor((x - 4 * 3600) / 86400), first = day(d.t[0]); let k = null;
        for (let i = 0; i < ts.length; i++) if (day(ts[i]) === first && cl[i] > 0) { k = d.c[0] / cl[i]; break; }
        if (k) { const T = [], C = []; for (let i = 0; i < ts.length; i++) { if (day(ts[i]) >= first) break; if (cl[i] > 0) { T.push(Date.UTC(1970, 0, 1 + day(ts[i])) / 1000); C.push(Math.round(cl[i] * k * 1e4) / 1e4); } }
          if (T.length > 100) { d.t = T.concat(d.t); d.c = C.concat(d.c); d.spliced = T.length; } }
      }
    } catch (e) { d.spliceErr = String(e.message || e); }
  }
  if (cache) { const put = cache.put(key, new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  return d;
}
async function levRegime(fund, env, ctx) {
  fund = String(fund).trim().toUpperCase();
  let pair = null; for (const [u, name, fs] of LEV_PAIRS) for (const [f, L] of fs) if (f === fund) pair = { u, name, L };
  if (!pair) throw new Error('Not a 3x fund on the board: ' + fund);
  const key = new Request(`https://ledgerline-cache.internal/levregime/v6/${fund}/${new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10)}`), cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const [fd, ud] = await Promise.all([lvLong(fund, env, ctx), lvLong(pair.u, env, ctx)]);
  const iso = x => new Date(x * 1000).toISOString().slice(0, 10), U = {}; ud.t.forEach((x, i) => { U[iso(x)] = ud.c[i]; });
  const D = [], F = [], X = []; fd.t.forEach((x, i) => { const k = iso(x), u = U[k]; if (u > 0 && fd.c[i] > 0) { D.push(k); F.push(fd.c[i]); X.push(u); } });
  const n = D.length, L = pair.L, B = [1]; for (let i = 1; i < n; i++) B.push(B[i - 1] * (1 + tbill(D[i]) / 100 / 252));
  const cut = { light: 8, heavy: 20 }, rd = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
  // forward windows: 1M, 3M, 6M, 1Y, 2Y, 3Y. Short ones start every day; 6M and longer start every 5th day (neighbours are near-identical anyway).
  const HZ = [21, 63, 126, 252, 504, 756], cols = { d: [], reg: [], hv: [], fd1: [], ud1: [], fdh: [], udh: [] }, W = {};
  const FH = [], XH = []; for (let i = 0; i < n; i++) { FH.push(Math.max(F[i], i ? FH[i - 1] : 0)); XH.push(Math.max(X[i], i ? XH[i - 1] : 0)); }
  for (const h of HZ) W[h] = { i: [], f: [], u: [], s: [], m: [], mdd: [], udd: [], fdd: [], lo: [] };
  for (let t = 21; t < n; t++) {
    const lg = []; for (let i = t - 19; i <= t; i++) lg.push(Math.log(X[i] / X[i - 1]));
    const hv = (lvSd(lg) || 0) * Math.sqrt(252) * 100, drag = lvDrag(L, hv), row = cols.d.length;
    cols.d.push(D[t]); cols.reg.push(drag < cut.light ? 0 : drag < cut.heavy ? 1 : 2); cols.hv.push(rd(hv));
    cols.fd1.push(rd((F[t] / F[t - 1] - 1) * 100)); cols.ud1.push(rd((X[t] / X[t - 1] - 1) * 100));
    cols.fdh.push(Math.round((F[t] / FH[t] - 1) * 1000) / 10); cols.udh.push(Math.round((X[t] / XH[t] - 1) * 1000) / 10);
    for (const h of HZ) {
      if (t + h >= n || (h > 63 && row % 5)) continue;
      let mdd = 0, udd = 0, fdd = 0, lo = 1, mpk = 1, upk = 1, fpk = 1;
      for (let k = 1; k <= h; k++) {
        const ur = X[t + k] / X[t], fr0 = F[t + k] / F[t], mr = fr0 / L + (1 - 1 / L) * B[t + k] / B[t];
        if (fr0 < lo) lo = fr0; if (fr0 > fpk) fpk = fr0; else if (fr0 / fpk - 1 < fdd) fdd = fr0 / fpk - 1;
        if (mr > mpk) mpk = mr; else if (mr / mpk - 1 < mdd) mdd = mr / mpk - 1;
        if (ur > upk) upk = ur; else if (ur / upk - 1 < udd) udd = ur / upk - 1;
      }
      const fr = F[t + h] / F[t] - 1, ur = X[t + h] / X[t] - 1, w = W[h];
      w.i.push(row); w.f.push(rd(fr * 100)); w.u.push(rd(ur * 100)); w.s.push(rd(L * ur * 100));
      w.m.push(rd((fr / L + (1 - 1 / L) * (B[t + h] / B[t] - 1)) * 100)); w.mdd.push(rd(mdd * 100)); w.udd.push(rd(udd * 100)); w.fdd.push(rd(fdd * 100)); w.lo.push(rd((lo - 1) * 100));
    }
  }
  // older pages (2.11.0) read 1M and 3M as day-aligned columns: keep them until every copy is replaced
  for (const h of [21, 63]) { const w = W[h]; for (const k of ['f', 'u', 's', 'm', 'mdd', 'udd', 'fdd']) cols[k + h] = Array(cols.d.length).fill(null); w.i.forEach((r, j) => { for (const k of ['f', 'u', 's', 'm', 'mdd', 'udd']) cols[k + h][r] = w[k][j]; cols['fdd' + h][r] = w.fdd[j]; }); }
  const last = cols.reg.length - 1, avg = a => a.length ? rd(a.reduce((x, y) => x + y, 0) / a.length) : null, sum = {};
  for (const h of HZ) { const w = W[h], st = h > 63 ? 5 : 1; sum[h] = [0, 1, 2].map(g => { const ix = []; w.i.forEach((r, j) => { if (cols.reg[r] === g) ix.push(j); }); const c = k => ix.map(j => w[k][j]);
    const f = c('f'), sx = c('s'), u = c('u'), m = c('m'), mdd = c('mdd'), udd = c('udd'), mA = avg(m), uA = avg(u), mD = avg(mdd), uD = avg(udd);
    return { n: ix.length, ind: Math.floor(ix.length * st / h), fAvg: avg(f), sAvg: avg(sx), gap: avg(f.map((v, i) => v - sx[i])), fWin: f.length ? rd(f.filter(v => v > 0).length / f.length * 100) : null, fWorst: f.length ? Math.min(...f) : null, fBest: f.length ? Math.max(...f) : null,
      mAvg: mA, uAvg: uA, beat: m.length ? rd(m.filter((v, i) => v > u[i]).length / m.length * 100) : null, mDd: mD, uDd: uD, mEff: mD < 0 ? rd(mA / -mD) : null, uEff: uD < 0 ? rd(uA / -uD) : null, mWorst: m.length ? Math.min(...m) : null, uWorst: u.length ? Math.min(...u) : null }; }); }
  const out = { fund, index: pair.u, indexName: pair.name, lev: L, from: cols.d[0] || null, to: cols.d[last] || null, days: cols.d.length, cut, todayReg: cols.reg[last], todayHv20: cols.hv[last], sum, w: W, stride: { 21: 1, 63: 1, 126: 5, 252: 5, 504: 5, 756: 5 },
    bills: 'Mix = 1/' + L + ' in ' + fund + ' and the rest in 3-month T-bills (monthly average rate, held without rebalancing), the same starting market exposure as 100% ' + pair.u + '.',
    method: 'Each day is labelled by the drag (L^2 - L)/2 x HV20^2 of ' + pair.u + ' that day. Forward windows are 21, 63, 126, 252, 504 and 756 trading days and overlap; 126 and longer start every 5th day.', checkedAt: Date.now(), worker: WORKER_VERSION, cols };
  if (cache) { const put = cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  return out;
}
// 3.17.2: Edge finder summary computed here too (same rules as the Vol Board page), for checks and alerts
const EDGE_SU = [
  ['all', 'Any day', () => true, 0], ['u2', 'Red day: index −2%', (C, r) => C.ud1[r] <= -2, 0], ['u3', 'Big red day: index −3%', (C, r) => C.ud1[r] <= -3, 0],
  ['dn3', 'Losing streak: 3 red days', (C, r) => r >= 2 && C.ud1[r] < 0 && C.ud1[r - 1] < 0 && C.ud1[r - 2] < 0, 0],
  ['i5', 'Pullback: index −5%', (C, r) => C.udh[r] <= -5, 1], ['i10', 'Correction: index −10%', (C, r) => C.udh[r] <= -10, 1], ['i20', 'Bear market: index −20%', (C, r) => C.udh[r] <= -20, 1],
  ['f20', 'Trough: fund −20%', (C, r) => C.fdh[r] <= -20, 1], ['f30', 'Deep trough: fund −30%', (C, r) => C.fdh[r] <= -30, 1], ['f40', 'Crash zone: fund −40%', (C, r) => C.fdh[r] <= -40, 1], ['f50', 'Washout: fund −50%', (C, r) => C.fdh[r] <= -50, 1],
  ['crush', 'Vol crush', (C, r) => r > 0 && C.reg[r - 1] === 2 && C.reg[r] < 2, 0], ['calm', 'Calm at the highs', (C, r) => C.reg[r] === 0 && C.udh[r] >= -2, 0]];
async function levEdge(fund, env, ctx) {
  const R = await levRegime(fund, env, ctx), C = R.cols, n = C.d.length, out = { fund: R.fund, index: R.index, from: R.from, to: R.to, worker: WORKER_VERSION, hz: {} };
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null;
  for (const h of [21, 63, 126, 252]) {
    const w = R.w[h], m = new Map(), st = R.stride[h] || 1; w.i.forEach((r, j) => m.set(r, j));
    out.hz[h] = EDGE_SU.map(([k, t, fn, cross]) => {
      const ev = []; let last = -1e9;
      for (let r = 1; r < n; r++) { const on = cross ? fn(C, r) && !fn(C, r - 1) : fn(C, r); if (!on || (k !== 'all' && r - last < 10)) continue; ev.push(r); last = r; }
      const rows = []; ev.forEach(r => { let j; for (let q = 0; q < st; q++) { j = m.get(r + q); if (j != null) break; } if (j != null) rows.push([r, w.f[j], w.u[j], w.m[j], w.lo[j]]); });
      let sep = 0, l2 = -1e9; rows.forEach(z => { if (z[0] - l2 >= h) { sep++; l2 = z[0]; } });
      const f = rows.map(z => z[1]);
      return { k, t, n: rows.length, sep, avg: avg(f), win: f.length ? Math.round(f.filter(v => v > 0).length / f.length * 100) : null, worst: f.length ? Math.min(...f) : null, lo: avg(rows.map(z => z[4])), loW: rows.length ? Math.min(...rows.map(z => z[4])) : null, idx: avg(rows.map(z => z[2])), beat: rows.length ? Math.round(rows.filter(z => z[3] > z[2]).length / rows.length * 100) : null, lastFired: ev.length && k !== 'all' ? C.d[ev[ev.length - 1]] : null };
    });
    const P = [1]; for (let r = 1; r < n; r++) P.push(P[r - 1] * (1 + (C.fd1[r] || 0) / 100));
    for (const [k, t, lv, key] of [['ladf', 'Add ladder: fund −20/−30/−40', [-20, -30, -40], 'fdh'], ['ladi', 'Add ladder: index −5/−10/−15', [-5, -10, -15], 'udh']]) {
      const cond = (r, L) => C[key][r] <= L, ev = []; let last = -1e9;
      for (let r = 1; r < n - h; r++) if (cond(r, lv[0]) && !cond(r - 1, lv[0]) && r - last >= 10) { ev.push(r); last = r; }
      const fv = [], los = [], dep = [];
      ev.forEach(r => { const buys = [r]; for (let q2 = 1; q2 < lv.length; q2++) { for (let q = buys[buys.length - 1]; q <= r + h; q++) if (cond(q, lv[q2])) { buys.push(q); break; } if (buys.length <= q2) break; }
        const units = buys.map(b => 1 / P[b]), end = r + h; let worst = 0;
        for (let q = r; q <= end; q++) { let u = 0, c = 0; buys.forEach((b, i2) => { if (b <= q) { u += units[i2]; c++; } }); worst = Math.min(worst, u * P[q] / c - 1); }
        fv.push((units.reduce((a, u) => a + u * P[end], 0) - buys.length) / lv.length * 100); los.push(worst * 100); dep.push(buys.length / lv.length * 100); });
      let sep = 0, l2 = -1e9; ev.forEach(r => { if (r - l2 >= h) { sep++; l2 = r; } });
      out.hz[h].push({ k, t, n: fv.length, sep, avg: avg(fv), win: fv.length ? Math.round(fv.filter(v => v > 0).length / fv.length * 100) : null, worst: fv.length ? Math.min(...fv) : null, lo: avg(los), loW: los.length ? Math.min(...los) : null, stake: avg(dep) });
    }
  }
  return out;
}
async function ivRank(env, sym, iv) {   // store today's IV30, then where it sits in the stored history
  if (!env.DB || iv == null) return { n: 0 };
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS iv_hist (sym TEXT, day TEXT, iv REAL, PRIMARY KEY (sym, day))').run();
    await env.DB.prepare('INSERT OR REPLACE INTO iv_hist (sym, day, iv) VALUES (?, ?, ?)').bind(sym, etDay(), iv).run();
    const h = ((await env.DB.prepare('SELECT iv FROM iv_hist WHERE sym = ? AND day >= ? ORDER BY day').bind(sym, new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10)).all()).results || []).map(r => r.iv);
    if (h.length < 5) return { n: h.length };
    const lo = Math.min(...h), hi = Math.max(...h);
    return { n: h.length, rank: hi > lo ? lvR((iv - lo) / (hi - lo) * 100, 0) : null, pctile: lvR(h.filter(v => v <= iv).length / h.length * 100, 0), lo: lvR(lo, 1), hi: lvR(hi, 1) };
  } catch (e) { return { n: 0 }; }
}
async function levBoard(env, ctx) {
  const key = new Request(`https://ledgerline-cache.internal/levboard/v1/${Math.floor(Date.now() / 900e3)}`), cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const syms = [...new Set(LEV_PAIRS.flatMap(([u, , fs]) => [u, ...fs.map(f => f[0])]))];
  const mk = {}, iv = {};
  await Promise.all(syms.map(async s => {
    try { mk[s] = await market(s, env, ctx); } catch (e) { mk[s] = null; }
    try { iv[s] = await impliedVol(s); } catch (e) { iv[s] = null; }
  }));
  const one = async (s) => { const m = mk[s], d = m && m.daily && m.daily.c && m.daily.c.length > 60 ? m.daily : null, q = iv[s] || {};
    const st = d ? lvStats(d) : null, ivv = q.iv30 != null ? q.iv30 : null;
    return { symbol: s, ...(st ? Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'number' ? lvR(v, 2) : v])) : {}), price: q.price || (st && st.price) || null,
      iv30: lvR(ivv, 2), ivChg: lvR(q.iv30Change, 2), ivMinusHv: ivv != null && st && st.hv20 != null ? lvR(ivv - st.hv20, 2) : null, ivRank: await ivRank(env, s, ivv), ivStamp: q.stamp || null }; };
  const groups = [];
  for (const [u, name, fs] of LEV_PAIRS) {
    const U = await one(u), ud = mk[u] && mk[u].daily;
    const funds = [];
    for (const [f, L] of fs) {
      const F = await one(f), fd = mk[f] && mk[f].daily, p = fd && ud && fd.c && ud.c ? lvPair(fd, ud, L) : {};
      funds.push({ ...F, lev: L, ...p,
        dragIV: lvR(lvDrag(L, U.iv30), 2), dragHV20: lvR(lvDrag(L, U.hv20), 2), dragHV60: lvR(lvDrag(L, U.hv60), 2), dragHV1y: lvR(lvDrag(L, U.hv252), 2),
        dragIVmonth: U.iv30 != null ? lvR(lvDrag(L, U.iv30) / 12, 2) : null,
        ivVs3x: F.iv30 != null && U.iv30 ? lvR(F.iv30 / (L * U.iv30), 2) : null });
    }
    groups.push({ index: name, underlying: U, funds });
  }
  const out = { asOf: new Date().toISOString(), checkedAt: Date.now(), worker: WORKER_VERSION, method: 'drag = (L^2 - L)/2 x vol^2; decay = L-times-daily compounded minus L x period return; costs = fund minus L-times-daily compounded', groups };
  if (cache) { const put = cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  return out;
}
// 3.14.0: implied volatility (IV30) and the day's quote from Cboe's free delayed quotes, cached 15 minutes per symbol
async function impliedVol(symbol) {
  const sym = String(symbol || '').trim().toUpperCase().replace('.', '-');
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(sym)) throw new Error('symbol is required');
  const key = new Request(`https://ledgerline-cache.internal/iv/${sym}/${Math.floor(Date.now() / 900e3)}`), cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${encodeURIComponent(sym)}.json`, { headers: { 'User-Agent': 'Mozilla/5.0 (LedgerLine)', Accept: 'application/json' } });
  let out;
  if (!r.ok) out = { symbol: sym, iv30: null, reason: r.status === 403 || r.status === 404 ? 'Cboe has no options quote for ' + sym : 'Cboe returned ' + r.status };
  else {
    const j = await r.json().catch(() => ({})), q = j.data || {}, n = v => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
    out = { symbol: sym, iv30: n(q.iv30), iv30Change: n(q.iv30_change), price: n(q.current_price), prevClose: n(q.prev_day_close), stamp: j.timestamp || null, source: 'Cboe delayed quote (15 minutes)' };
    if (!out.iv30) out.reason = 'Cboe has no implied volatility for ' + sym;
  }
  out.checkedAt = Date.now();
  if (cache) await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } }));
  return out;
}
async function finishHoldings(sym, day, r, env) {
  const isCash = h => /money market|cash collateral|liquidity fund|government (money|cash)|cash management|^cash\b|us dollar/i.test(h.name) || /cash|money market/i.test(h.type || '');
  const cashW = r.holdings.filter(isCash).reduce((a, h) => a + (h.weight || 0), 0);
  const rows = r.holdings.filter(h => !isCash(h)).sort((a, b) => (b.weight || 0) - (a.weight || 0));
  let sectors = [], coverage = null;
  if (env.DB) { try {
    const uni = Object.fromEntries((((await env.DB.prepare('SELECT ticker, sector FROM universe').all()).results) || []).map(u => [u.ticker, u.sector]));
    const m = {}; let covered = 0;
    for (const h of rows) { const s = h.symbol && uni[String(h.symbol).replace('.', '-')]; if (s && h.weight > 0) { m[s] = (m[s] || 0) + h.weight; covered += h.weight; } }
    sectors = Object.entries(m).map(([sector, weight]) => ({ sector, weight: Math.round(weight * 100) / 100 })).sort((a, b) => b.weight - a.weight);
    coverage = sectors.length ? Math.round(covered * 10) / 10 : null;
  } catch (e) { } }
  const top10 = rows.slice(0, 10).reduce((a, h) => a + (h.weight || 0), 0);
  return { symbol: sym, fund: r.fund || sym, day, asOf: r.asOf || null, count: rows.length, top10Weight: Math.round(top10 * 100) / 100,
    totalWeight: Math.round(rows.reduce((a, h) => a + (h.weight || 0), 0) * 10) / 10, cashWeight: Math.round(cashW * 100) / 100,
    sectors, sectorCoverage: coverage, holdings: rows.slice(0, 500), source: r.source, daily: !/monthly/i.test(r.source) };
}
async function secHoldings(sym, env, day) {
  const DB = env.DB;
  const none = reason => ({ symbol: sym, day, count: 0, holdings: [], sectors: [], unavailable: true, reason, source: 'SEC Form N-PORT' });
  const fs = await fundSeries(sym);
  if (!fs) return none(`${sym} isn't in the SEC's fund list, so it has no N-PORT holdings filing.`);
  const f = await latestNport(fs);
  if (!f) return none(`No public N-PORT filing found yet for ${sym}.`);
  const folder = `https://www.sec.gov/Archives/edgar/data/${Number(fs.cik)}/${f.acc.replace(/-/g, '')}/`;
  const xr = await secGet(folder + 'primary_doc.xml', 604800);
  if (!xr) return none('The N-PORT filing has no readable holdings file.');
  const x = await xr.text();
  const fund = xTag(x, 'seriesName') || xTag(x, 'regName') || fs.name || sym, asOf = xTag(x, 'repPdDate'), net = Number(xTag(x, 'netAssets')) || null;
  let rows = [];
  for (const blk of x.split(/<(?:\w+:)?invstOrSec>/).slice(1)) {
    const b = blk.split(/<\/(?:\w+:)?invstOrSec>/)[0];
    const pct = Number(xTag(b, 'pctVal')), val = Number(xTag(b, 'valUSD')), bal = Number(xTag(b, 'balance'));
    rows.push({
      symbol: xAttr(b, 'ticker', 'value') || null, name: xTag(b, 'name') || xTag(b, 'title') || '', cusip: xTag(b, 'cusip'),
      weight: isFinite(pct) ? pct : null, value: isFinite(val) ? val : null, shares: isFinite(bal) ? bal : null,
      type: xTag(b, 'assetCat') || '', long: (xTag(b, 'payoffProfile') || 'Long') !== 'Short'
    });
  }
  rows = rows.filter(h => h.name && h.weight != null);
  // cash sweeps and securities-lending collateral (money market funds, asset category STIV) aren't holdings: report them as one line
  const isCash = h => h.type === 'STIV' || /money market|cash collateral|liquidity fund|treasury (cash|obligations) fund|government (money|cash)|cash management/i.test(h.name);
  const cashW = rows.filter(isCash).reduce((a, h) => a + (h.weight || 0), 0);
  rows = rows.filter(h => !isCash(h)).sort((a, b) => (b.weight || 0) - (a.weight || 0));
  // tickers: filings often give only CUSIP and name; match names to SEC's company list so the page can link and group by sector
  try {
    const tr = await secGet('https://www.sec.gov/files/company_tickers.json', 86400), tj = tr ? await tr.json() : {};
    const norm = s => String(s || '').toUpperCase().replace(/&AMP;/g, '&').replace(/[.,'()]/g, ' ').replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|PLC|LLC|HOLDINGS?|GROUP|CLASS [A-C]|CL [A-C]|COM|NEW|SA|NV|AG|SE)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const byName = {}; for (const o of Object.values(tj)) { const k = norm(o.title); if (k && !byName[k]) byName[k] = o.ticker; }
    for (const h of rows) if (!h.symbol) h.symbol = byName[norm(h.name)] || null;
  } catch (e) { }
  let sectors = [], coverage = null;
  if (DB) {
    try {
      const uni = Object.fromEntries((((await DB.prepare('SELECT ticker, sector FROM universe').all()).results) || []).map(u => [u.ticker, u.sector]));
      const m = {}; let covered = 0;
      for (const h of rows) { const s = h.symbol && uni[String(h.symbol).replace('.', '-')]; if (s && h.weight > 0) { m[s] = (m[s] || 0) + h.weight; covered += h.weight; } }
      sectors = Object.entries(m).map(([sector, weight]) => ({ sector, weight: Math.round(weight * 100) / 100 })).sort((a, b) => b.weight - a.weight);
      coverage = sectors.length ? Math.round(covered * 10) / 10 : null;
    } catch (e) { }
  }
  const sumW = rows.reduce((a, h) => a + (h.weight || 0), 0), top10 = rows.slice(0, 10).reduce((a, h) => a + (h.weight || 0), 0);
  const body = {
    symbol: sym, fund, day, asOf, filed: f.filed, netAssets: net, count: rows.length,
    top10Weight: Math.round(top10 * 100) / 100, totalWeight: Math.round(sumW * 10) / 10, cashWeight: Math.round(cashW * 100) / 100, sectors, sectorCoverage: coverage,
    holdings: rows.slice(0, 500), source: 'SEC Form N-PORT', filing: folder
  };
  return rows.length ? body : none('The latest N-PORT filing listed no holdings.');
}

async function sectorRank(ticker, env) {
  const DB = env.DB; if (!DB) throw new Error('No database');
  const t = String(ticker).trim().toUpperCase().replace('.', '-');
  let me; try { me = await DB.prepare('SELECT * FROM ranks WHERE ticker = ?').bind(t).first(); } catch (e) { me = null; }
  if (!me) return { ticker: t, covered: false };
  const everyone = (await DB.prepare('SELECT ticker, sector, sub, w, m, q, y FROM ranks WHERE session = ?').bind(me.session).all()).results || [], peers = everyone.filter(p => p.sector === me.sector);
  const per = {};
  for (const k of ['w', 'm', 'q', 'y']) {
    const v = me[k], all = peers.filter(p => p[k] != null), sub = all.filter(p => p.sub === me.sub), srt = a => a.map(p => p[k]).sort((a, b) => b - a);
    const sa = srt(all), ss = srt(sub), med = a => a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
    const top = all.slice().sort((a, b) => b[k] - a[k]).slice(0, 3).map(p => [p.ticker, p[k]]);
    const sx = srt(everyone.filter(p => p[k] != null));
    per[k] = v == null ? null : { ret: v, rank: sa.filter(x => x > v).length + 1, n: sa.length, median: med(sa), subRank: ss.filter(x => x > v).length + 1, subN: ss.length, subMedian: med(ss), spRank: sx.filter(x => x > v).length + 1, spN: sx.length, spMedian: med(sx), best: sa[0], worst: sa[sa.length - 1], top };
  }
  return { ticker: t, covered: true, sector: me.sector, sub: me.sub, session: me.session, basis: 'total return (dividends reinvested), split-adjusted closes', periods: per };
}

/* ================= Marketstack usage counter (D1 database bound as DB) ================= */
let USAGE_DB = null, MS_LIMIT = 10000, MONTH_CACHE = { t: 0, n: 0 };
const etDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // YYYY-MM-DD, New York time
async function msFetch(u, init, kind, n = 1) {   // every Marketstack call goes through here and is counted; n = symbols in the request (Marketstack bills each one)
  const r = await fetch(u, init);
  if (USAGE_DB) { try { await USAGE_DB.prepare('INSERT INTO usage (day, kind, n) VALUES (?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET n = n + excluded.n').bind(etDay(), kind, n).run(); MONTH_CACHE.n += n; } catch (e) { } }
  return r;
}
async function usageRows() {
  if (!USAGE_DB) return null;
  const m = etDay().slice(0, 7);
  const { results } = await USAGE_DB.prepare('SELECT day, kind, n FROM usage WHERE day >= ? ORDER BY day').bind(m + '-01').all();
  return results || [];
}
async function monthUsed() {   // cached five minutes per worker instance
  if (!USAGE_DB) return 0;
  if (Date.now() - MONTH_CACHE.t < 300e3) return MONTH_CACHE.n;
  try { const rows = await usageRows(); MONTH_CACHE = { t: Date.now(), n: rows.reduce((a, r) => a + r.n, 0) }; } catch (e) { }
  return MONTH_CACHE.n;
}
async function usageData() {
  const rows = await usageRows();
  if (!rows) return { error: 'Usage counter not connected: bind the D1 database "ledgerline" to this worker as DB.' };
  const today = etDay(), m = today.slice(0, 7), dom = Number(today.slice(8, 10));
  const dim = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const days = {}; let used = 0, eod = 0, intraday = 0, other = 0;
  for (const r of rows) { used += r.n; if (r.kind === 'eod') eod += r.n; else if (r.kind === 'intraday') intraday += r.n; else other += r.n; days[r.day] = (days[r.day] || 0) + r.n; }
  const projected = Math.round(used / dom * dim);
  return { month: m, used, limit: MS_LIMIT, pct: Math.round(used / MS_LIMIT * 1000) / 10, today: days[today] || 0, projected, byKind: { eod, intraday, other }, days, intradayPaused: used >= MS_LIMIT * 0.95, since: rows.length ? rows[0].day : null };
}
/* ---- who uses LedgerLine: one row per email per day (New York time); a visit is an app open 30+ minutes after the last ---- */
/* 3.18.0 presence: both sites (LedgerLine and the KGR Vol Board) post here when a signed-in person opens them and then
   every 60 seconds while the page is on screen. presence keeps each person's first and last moment on each site; signins
   logs a new row when someone arrives after 20+ minutes away. The owner's Testers tab reads both straight from D1, so a
   sign-in shows within a minute. visits (LedgerLine's daily counts) is unchanged and only counts LedgerLine. */
const SITE_NAMES = { 'https://vol-board.pages.dev': 'KGR Vol Board' };
async function presenceTables(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS presence (email TEXT, site TEXT, first_ts INTEGER, last_ts INTEGER, screen TEXT, PRIMARY KEY (email, site))'),
    db.prepare('CREATE TABLE IF NOT EXISTS signins (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, site TEXT, ts INTEGER)')]);
}
async function recordVisit(req, env) {
  if (!USAGE_DB) return { ok: false };
  const home = (env.SITE_URL || 'https://ledgerline-dv0.pages.dev').replace(/\/+$/, ''), origin = req.headers.get('Origin') || '';
  const siteName = origin === home ? 'LedgerLine' : SITE_NAMES[origin];
  if (!siteName) return { ok: false };   // browsers always send Origin on this call; anything else is a script
  let b = {}; try { b = JSON.parse(await req.text()); } catch (e) { }
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/.test(email)) return { ok: false };
  const now = Math.floor(Date.now() / 1000), day = etDay(), screen = String(b.screen || '').slice(0, 40);
  await presenceTables(USAGE_DB);
  const p = await USAGE_DB.prepare('SELECT last_ts FROM presence WHERE email = ? AND site = ?').bind(email, siteName).first();
  const writes = [USAGE_DB.prepare("INSERT INTO presence (email, site, first_ts, last_ts, screen) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, site) DO UPDATE SET last_ts = excluded.last_ts, screen = CASE WHEN excluded.screen <> '' THEN excluded.screen ELSE presence.screen END").bind(email, siteName, now, now, screen)];
  if (!p || !p.last_ts || now - p.last_ts >= 1200) writes.push(USAGE_DB.prepare('INSERT INTO signins (email, site, ts) VALUES (?, ?, ?)').bind(email, siteName, now));
  if (siteName === 'LedgerLine' && !b.beat) {
    const last = await USAGE_DB.prepare('SELECT MAX(last_ts) AS t FROM visits WHERE email = ?').bind(email).first();
    const add = !last || !last.t || now - last.t >= 1800 ? 1 : 0;
    writes.push(USAGE_DB.prepare('INSERT INTO visits (email, day, n, first_ts, last_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, day) DO UPDATE SET n = n + ?, last_ts = ?').bind(email, day, add, now, now, add, now));
  }
  await USAGE_DB.batch(writes);
  return { ok: true, site: siteName };
}
async function activityData() {
  if (!USAGE_DB) return { error: 'not connected' };
  const now = Date.now(), since7 = etDay(new Date(now - 6 * 86400e3)), since30 = etDay(new Date(now - 29 * 86400e3)), today = etDay();
  const users = (await USAGE_DB.prepare('SELECT email, SUM(n) AS total, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS week, MIN(first_ts) AS first, MAX(last_ts) AS last FROM visits GROUP BY email ORDER BY last DESC').bind(since7).all()).results || [];
  const daily = (await USAGE_DB.prepare('SELECT day, COUNT(DISTINCT email) AS users, SUM(n) AS visits FROM visits WHERE day >= ? GROUP BY day ORDER BY day').bind(since30).all()).results || [];
  const nowS = now / 1000;
  return { users, daily, activeToday: users.filter(u => etDay(new Date(u.last * 1000)) === today).length, active7: users.filter(u => nowS - u.last < 7 * 86400).length, active30: users.filter(u => nowS - u.last < 30 * 86400).length, total: users.length };
}
async function activityHtml(url, env) {
  if (false) return `\x3ch2>Who’s using LedgerLine\x3c/h2>\x3cp class="fine">Private. To switch it on, add a secret named \x3cb>USAGE_KEY\x3c/b> to this worker (Settings → Variables and Secrets) with a passphrase of your choosing, then open this page as \x3cb>/usage?key=\x3c/b> followed by that passphrase, and bookmark it.\x3c/p>`;
  if (!(await keyOk(url.searchParams.get('key') || url.pathname.split('/')[2], env))) return `\x3ch2>Who’s using LedgerLine\x3c/h2>${url.searchParams.get('key') ? '\x3cp style="color:#990F3D">\x3cb>That key didn’t match.\x3c/b> Type it again, or set a new one in Cloudflare (sec-proxy → Settings → USAGE_KEY).\x3c/p>' : '\x3cp class="fine">Private. Type your usage key to see who’s using LedgerLine and to add or remove testers.\x3c/p>'}\x3cform method="get" action="/usage" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px">\x3cinput name="key" type="password" placeholder="Usage key" autocomplete="current-password" required style="flex:1;min-width:220px;font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:inherit">\x3cbutton style="font:600 15px system-ui;padding:10px 20px;border:0;border-radius:999px;background:#0D7680;color:#fff;cursor:pointer">Open\x3c/button>\x3c/form>`;
  const a = await activityData();
  if (a.error) return `\x3ch2>Who’s using LedgerLine\x3c/h2>\x3cp>${a.error}\x3c/p>`;
  const f = n => Number(n || 0).toLocaleString('en-US'), esc = x => String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const when = t => t ? new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' days ago'; };
  const maxU = Math.max(1, ...a.daily.map(d => d.users));
  const days = a.daily.map(d => `\x3ctr>\x3ctd>${d.day.slice(5)}\x3c/td>\x3ctd>${f(d.users)}\x3c/td>\x3ctd>${f(d.visits)}\x3c/td>\x3ctd>\x3cspan style="display:inline-block;height:10px;background:#0D7680;width:${Math.max(2, Math.round(d.users / maxU * 200))}px">\x3c/span>\x3c/td>\x3c/tr>`).join('');
  const names = await testerNames(env).catch(() => ({}));
  const rows = a.users.map(u => `\x3ctr>\x3ctd>${names[String(u.email).toLowerCase()] ? '\x3cb>' + esc(names[String(u.email).toLowerCase()]) + '\x3c/b>\x3cbr>' : ''}${esc(u.email)}\x3c/td>\x3ctd>${when(u.last)}\x3cbr>\x3cspan class="fine">${ago(u.last)}\x3c/span>\x3c/td>\x3ctd>${f(u.week)}\x3c/td>\x3ctd>${f(u.total)}\x3c/td>\x3ctd>${when(u.first)}\x3c/td>\x3c/tr>`).join('');
  return `\x3ch2>Who’s using LedgerLine\x3c/h2>
\x3cp class="big2">${f(a.activeToday)} \x3csmall>today\x3c/small> · ${f(a.active7)} \x3csmall>this week\x3c/small> · ${f(a.active30)} \x3csmall>in 30 days\x3c/small> · ${f(a.total)} \x3csmall>ever\x3c/small>\x3c/p>
\x3ctable>\x3cthead>\x3ctr>\x3cth>Email\x3c/th>\x3cth>Last visit\x3c/th>\x3cth>Visits, 7 days\x3c/th>\x3cth>All visits\x3c/th>\x3cth>First seen\x3c/th>\x3c/tr>\x3c/thead>\x3ctbody>${rows || '\x3ctr>\x3ctd colspan="5">No visits recorded yet.\x3c/td>\x3c/tr>'}\x3c/tbody>\x3c/table>
\x3ch3>Daily active users, last 30 days\x3c/h3>
\x3ctable>\x3cthead>\x3ctr>\x3cth>Day\x3c/th>\x3cth>Users\x3c/th>\x3cth>Visits\x3c/th>\x3cth>\x3c/th>\x3c/tr>\x3c/thead>\x3ctbody>${days || '\x3ctr>\x3ctd colspan="4">None yet.\x3c/td>\x3c/tr>'}\x3c/tbody>\x3c/table>
\x3cp class="fine">A visit is opening the app, counted again after 30 minutes away. Times are New York. Counting started Oct 22, 2026. Which stocks people look at is not recorded.\x3c/p>`;
}
async function usagePage(url, env) {
  const d = await usageData().catch(e => ({ error: String(e.message || e) }));
  const esc = x => String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const f = n => Number(n).toLocaleString('en-US');
  let body;
  if (d.error) body = `\x3cp>${esc(d.error)}\x3c/p>`;
  else {
    const tone = d.intradayPaused ? '#990F3D' : d.projected > d.limit ? '#B36200' : '#0D7680';
    const msg = d.intradayPaused ? 'Over 95% used: 15-minute prices are paused until the 1st and pages show the last close.' : d.projected > d.limit ? 'On pace to run out before month end. Consider the next Marketstack plan.' : 'On pace to stay under the limit.';
    const bars = Object.entries(d.days).map(([k, v]) => `\x3ctr>\x3ctd>${k.slice(5)}\x3c/td>\x3ctd>${f(v)}\x3c/td>\x3ctd>\x3cspan style="display:inline-block;height:10px;background:${tone};width:${Math.max(2, Math.round(v / Math.max(...Object.values(d.days)) * 220))}px">\x3c/span>\x3c/td>\x3c/tr>`).join('');
    body = `\x3cp class="big" style="color:${tone}">${f(d.used)} \x3csmall>of ${f(d.limit)} requests · ${d.pct}%\x3c/small>\x3c/p>
\x3cdiv class="bar">\x3cspan style="width:${Math.min(100, d.pct)}%;background:${tone}">\x3c/span>\x3c/div>
\x3cp>\x3cb>${esc(msg)}\x3c/b>\x3c/p>
\x3cp>Today: \x3cb>${f(d.today)}\x3c/b> · Projected for ${esc(d.month)}: \x3cb>${f(d.projected)}\x3c/b> · Price history (end of day): ${f(d.byKind.eod)} · 15-minute quotes: ${f(d.byKind.intraday)}${d.byKind.other ? ' · Checks: ' + f(d.byKind.other) : ''}\x3c/p>
\x3ctable>\x3cthead>\x3ctr>\x3cth>Day\x3c/th>\x3cth>Requests\x3c/th>\x3cth>\x3c/th>\x3c/tr>\x3c/thead>\x3ctbody>${bars || '\x3ctr>\x3ctd colspan="3">No requests yet this month.\x3c/td>\x3c/tr>'}\x3c/tbody>\x3c/table>
\x3cp class="fine">Counted by LedgerLine from ${esc(d.since || 'today')}${d.since && d.since > d.month + '-01' ? ', so this month started before counting did; Marketstack’s own dashboard is the official number' : ''}. Days are New York time. The limit resets on the 1st.\x3c/p>`;
  }
  const html = `\x3c!doctype html>\x3chtml lang="en">\x3chead>\x3cmeta charset="utf-8">\x3cmeta name="viewport" content="width=device-width,initial-scale=1">\x3ctitle>LedgerLine · usage\x3c/title>
\x3cstyle>:root{--bg:#FFF1E5;--ink:#33302E;--muted:#66605C;--line:#CCC1B7}@media (prefers-color-scheme:dark){:root{--bg:#1C1E23;--ink:#F2DFCE;--muted:#B0A497;--line:#3E434E}}
body{background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px}h1{font:700 28px Georgia,serif;margin:4px 0 12px}.k{font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#990F3D}
.big{font:700 40px Georgia,serif;margin:8px 0}.big small{font:400 16px system-ui,sans-serif;color:var(--muted)}.bar{height:10px;background:var(--line);margin:4px 0 16px}.bar span{display:block;height:100%}
table{border-collapse:collapse;width:100%;font-size:14px;margin-top:12px}h2{font:700 22px Georgia,serif;margin:28px 0 6px}h3{font-size:15px;margin:22px 0 4px}.big2{font:700 26px Georgia,serif;margin:6px 0}.big2 small{font:400 14px system-ui,sans-serif;color:var(--muted)}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}.fine{font-size:13px;color:var(--muted)}\x3c/style>\x3c/head>
\x3cbody>\x3cdiv class="k">LedgerLine\x3c/div>\x3ch1>Usage\x3c/h1>${(await keyOk(url.searchParams.get('key') || url.pathname.split('/')[2], env)) ? testersHtml(url, env) : ''}${await activityHtml(url, env).catch(e => '\x3cp>' + String(e.message || e) + '\x3c/p>')}\x3ch2>Marketstack price data this month\x3c/h2>${body}\x3c/body>\x3c/html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* ================= testers: who may sign in to each site behind Cloudflare Access (needs the CF_ACCESS_TOKEN secret) ================= */
const CF_ACCOUNT = '51799e9e2cfaf727a3bc287626828255';
async function cfApi(env, path, init = {}) {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + (env.CF_ACCOUNT_ID || CF_ACCOUNT) + path, { ...init, headers: { Authorization: 'Bearer ' + String(env.CF_ACCESS_TOKEN).replace(/\s+/g, '').replace(/^Bearer/i, ''), 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error('Cloudflare: ' + ((j.errors && j.errors[0] && j.errors[0].message) || r.status));
  return j.result;
}
// every site behind Access, the Allow policies on it, and the emails each one lets in (directly or through an email list)
async function accessSites(env) {
  const [apps, lists, users] = await Promise.all([cfApi(env, '/access/apps'), cfApi(env, '/gateway/lists').catch(() => []), cfApi(env, '/access/users?per_page=200').catch(() => [])]);
  const listItems = {};
  for (const l of (lists || []).filter(l => l.type === 'EMAIL')) listItems[l.id] = { name: l.name, emails: ((await cfApi(env, '/gateway/lists/' + l.id + '/items').catch(() => [])) || []).flat().map(i => i.value).filter(Boolean) };
  const last = {}; (users || []).forEach(u => { if (u.email) last[u.email.toLowerCase()] = u.last_successful_login || null; });
  const byApp = {};   // per-site sign-ins from the Access log, newest first (skipped if the token can't read audit logs)
  const logs = await cfApi(env, '/access/logs/access_requests?limit=500&direction=desc').catch(() => null);
  (Array.isArray(logs) ? logs : []).forEach(l => { if (!l || !l.user_email || l.allowed === false) return; const k = String(l.app_uid || l.app_domain || '') + '|' + l.user_email.toLowerCase(); if (!byApp[k]) byApp[k] = l.created_at; });
  const sites = [];
  for (const a of (apps || []).filter(a => a.type === 'self_hosted' || a.domain)) {
    const pols = (a.policies || []).filter(p => (p.decision || 'allow') === 'allow');
    const emails = new Set(), targets = [];
    for (const p of pols) for (const inc of p.include || []) {
      if (inc.email_list && listItems[inc.email_list.id]) { listItems[inc.email_list.id].emails.forEach(e => emails.add(e)); targets.push({ kind: 'list', id: inc.email_list.id, name: listItems[inc.email_list.id].name }); }
      if (inc.email && inc.email.email) { emails.add(inc.email.email); if (!targets.some(t => t.kind === 'policy' && t.id === p.id)) targets.push({ kind: 'policy', id: p.id, app: a.id, reusable: !!p.reusable, name: p.name }); }
    }
    sites.push({ id: a.id, name: a.name, domain: a.domain, emails: [...emails].sort().map(e => ({ email: e, last: last[e.toLowerCase()] || null, login: byApp[a.id + '|' + e.toLowerCase()] || byApp[a.domain + '|' + e.toLowerCase()] || null })), targets, logs: Array.isArray(logs) });
  }
  return sites;
}
async function policyEdit(env, t, fn) {   // read a policy, change its include list, write it back
  const path = t.reusable ? '/access/policies/' + t.id : '/access/apps/' + t.app + '/policies/' + t.id;
  const p = await cfApi(env, path).catch(() => cfApi(env, '/access/policies/' + t.id));
  const body = { name: p.name, decision: p.decision, include: fn(p.include || []), exclude: p.exclude || [], require: p.require || [], session_duration: p.session_duration };
  await cfApi(env, p.reusable || t.reusable ? '/access/policies/' + t.id : path, { method: 'PUT', body: JSON.stringify(body) });
}
async function testerNames(env) { if (!env.DB) return {}; await env.DB.prepare('CREATE TABLE IF NOT EXISTS testers (email TEXT PRIMARY KEY, name TEXT, added INTEGER)').run(); const r = (await env.DB.prepare('SELECT email, name FROM testers').all()).results || []; const m = {}; r.forEach(x => { m[x.email] = x.name; }); return m; }
async function testersApi(req, url, env) {
  const j = o => new Response(JSON.stringify(o), { status: o.error ? 400 : 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!env.__queue && !(await keyOk(url.searchParams.get('key'), env))) return j({ error: 'Private' });
  if (!env.CF_ACCESS_TOKEN) return j({ error: 'Add the CF_ACCESS_TOKEN secret first' });
  try {
    if (req.method !== 'POST') { const [sites, names] = await Promise.all([accessSites(env), testerNames(env)]); sites.forEach(s => s.emails.forEach(e => { e.name = names[e.email.toLowerCase()] || ''; })); return j({ sites }); }
    const b = await req.json().catch(() => ({})), email = String(b.email || '').trim().toLowerCase(), add = b.action !== 'remove', nm = String(b.name || '').trim().slice(0, 80);
    if (b.action === 'rename') { await testerNames(env); await env.DB.prepare('INSERT INTO testers (email, name, added) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name').bind(email, nm, Date.now()).run(); return j({ ok: true, email, action: 'renamed', sites: [] }); }
    if (add && nm && env.DB) { await testerNames(env); await env.DB.prepare('INSERT INTO testers (email, name, added) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name').bind(email, nm, Date.now()).run(); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return j({ error: 'That is not an email address' });
    const sites = await accessSites(env), pick = sites.filter(s => (b.sites || []).includes(s.id)), done = [];
    const touched = new Set();
    for (const s of pick) {
      const t = s.targets.find(t => t.kind === 'list') || s.targets.find(t => t.kind === 'policy');
      if (!t) { done.push(s.name + ': no Allow policy to change'); continue; }
      const k = t.kind + t.id; if (touched.has(k)) { done.push(s.name); continue; } touched.add(k);
      if (t.kind === 'list') await cfApi(env, '/gateway/lists/' + t.id, { method: 'PATCH', body: JSON.stringify(add ? { append: [{ value: email }] } : { remove: [email] }) });
      else await policyEdit(env, t, inc => add ? (inc.some(i => i.email && i.email.email.toLowerCase() === email) ? inc : [...inc, { email: { email } }]) : inc.filter(i => !(i.email && i.email.email.toLowerCase() === email)));
      done.push(s.name);
    }
    return j({ ok: true, email, action: add ? 'added' : 'removed', sites: done });
  } catch (e) { return j({ error: String(e.message || e) }); }
}
// owner shortcut: rows put in tester_queue (email, name, sites = 'all' or site names, action add|remove) are carried out here and marked done
async function testerQueue(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tester_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, name TEXT, sites TEXT DEFAULT 'LedgerLine', action TEXT DEFAULT 'add', done INTEGER DEFAULT 0, result TEXT)").run();
  const rows = (await env.DB.prepare('SELECT * FROM tester_queue WHERE done = 0 LIMIT 10').all()).results || [];
  const cacheRow = await env.DB.prepare("SELECT v FROM settings WHERE k = 'tester_cache'").first().catch(() => null), cacheAge = cacheRow ? Date.now() - (JSON.parse(cacheRow.v).t || 0) : Infinity;
  if (!rows.length && cacheAge < 90e3) return;   // nothing queued: refresh the tester lists and sign-ins on every 2-minute run
  let sites = await accessSites(env);
  for (const r of rows) {
    const want = String(r.sites || 'LedgerLine').toLowerCase(), ids = sites.filter(s => want === 'all' || want.split(',').some(w => s.name.toLowerCase().includes(w.trim()))).map(s => s.id);
    const req = new Request('https://x/usage/testers', { method: 'POST', body: JSON.stringify({ email: r.email, name: r.name, sites: ids, action: r.action || 'add' }) });
    const res = await (await testersApi(req, new URL('https://x/usage/testers?key=__queue__'), { ...env, __queue: true })).json().catch(e => ({ error: String(e) }));
    await env.DB.prepare('UPDATE tester_queue SET done = 1, result = ? WHERE id = ?').bind(JSON.stringify(res).slice(0, 500), r.id).run();
  }
  if (rows.length) sites = await accessSites(env);
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('tester_cache', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ t: Date.now(), sites: sites.map(s => ({ id: s.id, name: s.name, domain: s.domain, emails: s.emails, logs: s.logs })) })).run();
}
function testersHtml(url, env) {
  const key = url.searchParams.get('key') || url.pathname.split('/')[2] || '';
  if (!env.CF_ACCESS_TOKEN) return `\x3ch2>Testers\x3c/h2>\x3cp>To add and remove testers here, create a Cloudflare API token (My Profile → API Tokens → Create custom token) with \x3cb>Account → Access: Apps and Policies → Edit\x3c/b>, \x3cb>Account → Zero Trust → Edit\x3c/b> and \x3cb>Account → Access: Users → Read\x3c/b>, then save it on this worker as the secret \x3cb>CF_ACCESS_TOKEN\x3c/b>.\x3c/p>`;
  return `\x3ch2>Testers\x3c/h2>\x3cp class="fine">Who can sign in to each site. Adding someone takes effect at once; they sign in with a code sent to that email.\x3c/p>
\x3cform id="tf" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0">\x3cinput id="tn" type="text" placeholder="Name" style="flex:0 1 180px;font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:inherit">\x3cinput id="te" type="email" placeholder="tester@email.com" required style="flex:1;min-width:220px;font:inherit;padding:10px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:inherit">\x3cspan id="ts">loading sites…\x3c/span>\x3cbutton style="font:600 15px system-ui;padding:10px 20px;border:0;border-radius:999px;background:#0D7680;color:#fff;cursor:pointer">Add tester\x3c/button>\x3c/form>\x3cp id="tm" class="fine">\x3c/p>\x3cdiv id="tl">\x3c/div>
\x3cscript>(()=>{const K=${JSON.stringify(key)},U='/usage/testers?key='+encodeURIComponent(K),$=s=>document.querySelector(s),E=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));let S=[];
const when=t=>t?new Date(t).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'never signed in';
async function load(){ const r=await fetch(U).then(r=>r.json()); if(r.error){ $('#ts').textContent=''; $('#tm').textContent=r.error; return; } S=r.sites;
 $('#ts').innerHTML=S.map((s,i)=>'\x3clabel style="white-space:nowrap">\x3cinput type="checkbox" value="'+s.id+'" checked> '+E(s.name)+'\x3c/label>').join(' ');
 $('#tl').innerHTML=S.map(s=>'\x3ch3>'+E(s.name)+' \x3cspan class="fine">'+E(s.domain||'')+'\x3c/span>\x3c/h3>\x3ctable>\x3cthead>\x3ctr>\x3cth style="text-align:left">Name\x3c/th>\x3cth style="text-align:left">Email\x3c/th>\x3cth style="text-align:left">Last sign-in\x3c/th>\x3cth>\x3c/th>\x3c/tr>\x3c/thead>\x3ctbody>'+(s.emails.map(e=>'\x3ctr>\x3ctd>\x3cb>'+E(e.name||'—')+'\x3c/b> \x3cbutton data-nm="'+E(e.email)+'" title="Set name" style="font:inherit;border:0;background:transparent;color:var(--muted);cursor:pointer">✎\x3c/button>\x3c/td>\x3ctd>'+E(e.email)+'\x3c/td>\x3ctd>'+when(e.last)+'\x3c/td>\x3ctd style="text-align:right">\x3cbutton data-rm="'+E(e.email)+'" data-site="'+s.id+'" style="font:inherit;border:1px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:4px 12px;cursor:pointer">Remove\x3c/button>\x3c/td>\x3c/tr>').join('')||'\x3ctr>\x3ctd colspan=4>No one yet\x3c/td>\x3c/tr>')+'\x3c/tbody>\x3c/table>').join(''); }
async function send(email,sites,action,name){ $('#tm').textContent='Saving…'; const r=await fetch(U,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,sites,action,name})}).then(r=>r.json()); $('#tm').textContent=r.error?r.error:(r.email+' '+r.action+' · '+r.sites.join(', ')); await load(); }
$('#tf').addEventListener('submit',e=>{e.preventDefault(); const sites=[...document.querySelectorAll('#ts input:checked')].map(x=>x.value); if(!sites.length){ $('#tm').textContent='Tick at least one site'; return; } send($('#te').value.trim(),sites,'add',$('#tn').value.trim()); $('#te').value=''; $('#tn').value=''; });
document.addEventListener('click',e=>{const n=e.target.closest('[data-nm]'); if(n){ const v=prompt('Name for '+n.dataset.nm); if(v!==null) send(n.dataset.nm,[],'rename',v.trim()); return; } const b=e.target.closest('[data-rm]'); if(b&&confirm('Remove '+b.dataset.rm+'?')) send(b.dataset.rm,[b.dataset.site],'remove');});
load();})();\x3c/script>`;
}

/* ================= 1. original relay ================= */
async function relay(req) {
  const u = new URL(req.url).searchParams.get('u');
  if (!u) return new Response('missing u', { status: 400 });
  let t; try { t = new URL(u); } catch (e) { return new Response('bad url', { status: 400 }); }
  if (!/(^|\.)sec\.gov$/.test(t.hostname)) return new Response('sec.gov only', { status: 403 });
  const r = await fetch(t.toString(), { headers: SEC_HEADERS, cf: { cacheTtl: 21600, cacheEverything: true } });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json' } });
}

/* ================= 2. MCP over streamable HTTP (stateless, JSON replies) ================= */
const TOOLS = [
  {
    name: 'sec_statements',
    description: 'Full financial statements for a US SEC filer from EDGAR XBRL as filed (latest restatement wins): income statement, balance sheet, cash flow statement and comprehensive income, by fiscal year from 10-Ks, plus a TTM column (flows, from the latest 10-Q) and the latest quarter-end balance sheet. Also returns a "key" block of series for analysis.',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string', description: 'US ticker, e.g. AAPL or BRK-B' }, years: { type: 'integer', description: 'Fiscal years to return, default 12, max 20' } }, required: ['ticker'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'sec_section',
    description: "Text of one section of a company's latest 10-K or 10-Q: mdna (Management's Discussion and Analysis), notes (notes to the financial statements), risk (risk factors), business (10-K only) or legal (legal proceedings). Plain text with filing date and link.",
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, section: { type: 'string', description: 'mdna, notes, risk, business or legal' }, form: { type: 'string', description: '10-K (default) or 10-Q' }, maxChars: { type: 'integer', description: 'Cap on returned characters, default 60000 (120000 for notes), max 200000' } }, required: ['ticker', 'section'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'sec_mdna',
    description: "Management's Discussion and Analysis text from a company's latest 10-K (Item 7) or 10-Q (Item 2), plain text, with filing date and link.",
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, form: { type: 'string', description: '10-K (default) or 10-Q' }, maxChars: { type: 'integer', description: 'Cap on returned characters, default 60000, max 150000' } }, required: ['ticker'] },
    annotations: { readOnlyHint: true }
  }
];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function mcp(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('SEC EDGAR MCP server ' + WORKER_VERSION + '. POST JSON-RPC here.', { status: 405, headers: { ...CORS, Allow: 'POST' } });
  let body; try { body = await req.json(); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const list = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of list) { const r = await handle(m); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? out : out[0]);
}

async function handle(m) {
  if (!m || m.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  if (m.id === undefined || m.id === null) return null; // notifications
  const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sec-edgar', version: WORKER_VERSION } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name, args = m.params?.arguments || {};
      try {
        const data = name === 'sec_statements' ? await secStatements(args) : name === 'sec_mdna' ? await secMdna(args) : name === 'sec_section' ? await secSection(args) : null;
        if (!data) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } };
        return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        return ok({ isError: true, content: [{ type: 'text', text: String(e && e.message || e) }] });
      }
    }
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }
}

/* ================= EDGAR helpers ================= */
async function secGet(url, ttl = 21600) {
  let r;
  for (let tries = 0; tries < 4; tries++) {   // SEC allows 10 requests a second and answers 403/429 when busy: back off and retry
    r = await fetch(url, { headers: SEC_HEADERS, cf: { cacheTtl: ttl, cacheEverything: true } });
    if (r.status !== 403 && r.status !== 429 && r.status !== 503) break;
    await new Promise(res => setTimeout(res, 700 * (tries + 1) + Math.random() * 500));
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('SEC returned ' + r.status + ' for ' + url);
  return r;
}
async function cikFor(ticker) {
  const r = await secGet('https://www.sec.gov/files/company_tickers.json', 86400);
  if (!r) throw new Error('SEC ticker list unavailable');
  const txt = await r.text();
  const t = String(ticker).toUpperCase().trim().replace('.', '-');
  const i = txt.indexOf('"ticker":"' + t + '"');
  if (i < 0) {   // SEC's ticker file leaves some filers out (Equity Residential): ask EDGAR's company lookup, which takes a ticker
    if (/^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t)) {
      const lr = await secGet(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(t)}&type=10-K&count=1&output=atom`, 86400);
      const x = lr ? await lr.text() : '';
      const c = (x.match(/\x3ccik\x3e(\d+)\x3c\/cik\x3e/) || [])[1], nm = (x.match(/\x3cconformed-name\x3e([^\x3c]+)\x3c\/conformed-name\x3e/) || [])[1];
      if (c) return { cik: c.padStart(10, '0'), cikInt: String(Number(c)), name: (nm || t).replace(/&amp;/g, '&') };
    }
    throw new Error(ticker + ' is not an SEC filer with XBRL data (foreign 20-F/OTC names often are not).');
  }
  const o = JSON.parse(txt.slice(txt.lastIndexOf('{', i), txt.indexOf('}', i) + 1));
  return { cik: String(o.cik_str).padStart(10, '0'), cikInt: String(o.cik_str), name: o.title };
}
// companies that re-registered under a new SEC filer number: history stays under the old one
const PREDECESSOR = { '2115436': { cik: '0000034088', cikInt: '34088', name: 'Exxon Mobil Corp' } };   // ExxonMobil Holdings (2026) <- Exxon Mobil Corp
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const shiftYear = d => { const x = new Date(Date.parse(d)); x.setUTCFullYear(x.getUTCFullYear() - 1); return x.toISOString().slice(0, 10); };

/* ================= statement layouts =================
   [key, label, tags (priority order), opts]  opts: b=bold total, i=indent, s=-1 show as outflow, u=unit, d=derived */
const IS = [
  ['revenue', 'Revenue', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense', 'SalesRevenueGoodsNet', 'RevenuesExcludingInterestAndDividends', 'RegulatedAndUnregulatedOperatingRevenue', 'RevenueFromContractWithCustomerProductAndService', 'HomeBuildingRevenue', 'OilAndGasRevenue', 'SalesRevenueServicesNet', 'RegulatedOperatingRevenue', 'ElectricUtilityRevenue', 'HealthCareOrganizationRevenue', 'OperatingLeaseLeaseIncome', 'GrossInvestmentIncomeOperating'], { b: 1, max: 1 }],
  ['nii', 'Net interest income', ['InterestIncomeExpenseNet', 'InterestIncomeExpenseAfterProvisionForLoanLoss'], { i: 1 }],
  ['nonII', 'Noninterest income', ['NoninterestIncome'], { i: 1 }],
  ['cogs', 'Cost of revenue', ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'], { i: 1, s: -1 }],
  ['grossProfit', 'Gross profit', ['GrossProfit'], { b: 1 }],
  ['rnd', 'Research & development', ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'], { i: 1, s: -1 }],
  ['sga', 'Selling, general & admin', ['SellingGeneralAndAdministrativeExpense'], { i: 1, s: -1 }],
  ['opex', 'Total operating expenses', ['OperatingExpenses', 'CostsAndExpenses'], { s: -1 }],
  ['opIncome', 'Operating income', ['OperatingIncomeLoss'], { b: 1 }],
  ['interestExp', 'Interest expense', ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestExpenseBorrowings', 'InterestExpenseOperating'], { i: 1, s: -1 }],
  ['otherInc', 'Other income (expense)', ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'], { i: 1 }],
  ['pretax', 'Pretax income', ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic'], { b: 1 }],
  ['tax', 'Income tax', ['IncomeTaxExpenseBenefit'], { i: 1, s: -1 }],
  ['discOps', 'Discontinued operations', ['IncomeLossFromDiscontinuedOperationsNetOfTax', 'IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity'], { i: 1 }],
  ['nci', 'Noncontrolling interests', ['NetIncomeLossAttributableToNoncontrollingInterest'], { i: 1, s: -1 }],
  ['netIncome', 'Net income to common', ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'], { b: 1 }],
  ['epsBasic', 'EPS, basic', ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'], { u: 'USD/shares' }],
  ['eps', 'EPS, diluted', ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], { u: 'USD/shares', b: 1 }],
  ['shBasic', 'Weighted shares, basic', ['WeightedAverageNumberOfSharesOutstandingBasic'], { u: 'shares' }],
  ['dilShares', 'Weighted shares, diluted', ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'], { u: 'shares' }],
  ['dps', 'Dividends per share', ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'], { u: 'USD/shares' }]
];
const BS = [
  ['cash', 'Cash & equivalents', ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'], { i: 1 }],
  ['stInv', 'Short-term investments', ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'], { i: 1 }],
  ['receivables', 'Receivables', ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'], { i: 1 }],
  ['inventory', 'Inventory', ['InventoryNet'], { i: 1 }],
  ['otherCA', 'Other current assets', ['OtherAssetsCurrent', 'PrepaidExpenseAndOtherAssetsCurrent'], { i: 1 }],
  ['curAssets', 'Total current assets', ['AssetsCurrent'], { b: 1 }],
  ['ppe', 'Property, plant & equipment', ['PropertyPlantAndEquipmentNet', 'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'], { i: 1 }],
  ['rouAsset', 'Operating lease assets', ['OperatingLeaseRightOfUseAsset'], { i: 1 }],
  ['ltInv', 'Long-term investments', ['LongTermInvestments', 'MarketableSecuritiesNoncurrent'], { i: 1 }],
  ['goodwill', 'Goodwill', ['Goodwill'], { i: 1 }],
  ['intang', 'Intangible assets', ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet'], { i: 1 }],
  ['assets', 'Total assets', ['Assets'], { b: 1 }],
  ['ap', 'Accounts payable', ['AccountsPayableCurrent', 'AccountsPayableAndAccruedLiabilitiesCurrent'], { i: 1 }],
  ['accrued', 'Accrued liabilities', ['AccruedLiabilitiesCurrent'], { i: 1 }],
  ['defRev', 'Deferred revenue', ['ContractWithCustomerLiabilityCurrent', 'DeferredRevenueCurrent'], { i: 1 }],
  ['curDebt', 'Current debt', ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'], { i: 1 }],
  ['curLiab', 'Total current liabilities', ['LiabilitiesCurrent'], { b: 1 }],
  ['ltDebt', 'Long-term debt', ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'], { i: 1 }],
  ['leaseLiab', 'Operating lease liabilities', ['OperatingLeaseLiabilityNoncurrent'], { i: 1 }],
  ['liabilities', 'Total liabilities', ['Liabilities'], { b: 1 }],
  ['apic', 'Common stock & paid-in capital', ['CommonStocksIncludingAdditionalPaidInCapital', 'AdditionalPaidInCapitalCommonStock', 'AdditionalPaidInCapital'], { i: 1 }],
  ['retained', 'Retained earnings', ['RetainedEarningsAccumulatedDeficit'], { i: 1 }],
  ['aoci', 'Accumulated other comprehensive income', ['AccumulatedOtherComprehensiveIncomeLossNetOfTax'], { i: 1 }],
  ['treasury', 'Treasury stock', ['TreasuryStockValue', 'TreasuryStockCommonValue'], { i: 1, s: -1 }],
  ['equity', 'Shareholders’ equity', ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], { b: 1 }],
  ['nciEq', 'Noncontrolling interest', ['MinorityInterest'], { i: 1 }],
  ['liabEq', 'Total liabilities & equity', ['LiabilitiesAndStockholdersEquity'], { b: 1 }],
  ['sharesOut', 'Shares outstanding', ['CommonStockSharesOutstanding'], { u: 'shares' }]
];
const CF = [
  ['cfNI', 'Net income', ['ProfitLoss', 'NetIncomeLoss'], {}],
  ['da', 'Depreciation & amortization', ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization', 'Depreciation'], { i: 1 }],
  ['gainRE', 'Gain on sale of real estate', ['GainLossOnSaleOfProperties', 'GainsLossesOnSalesOfInvestmentRealEstate', 'GainLossOnSaleOfRealEstateInvestmentProperty', 'GainLossOnDispositionOfRealEstateDiscontinuedOperations'], { i: 1, s: -1 }],
  ['impairRE', 'Real estate impairments', ['ImpairmentOfRealEstate'], { i: 1 }],
  ['sbc', 'Stock-based compensation', ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'], { i: 1 }],
  ['defTax', 'Deferred income taxes', ['DeferredIncomeTaxExpenseBenefit', 'DeferredIncomeTaxesAndTaxCredits'], { i: 1 }],
  ['chgRec', 'Change in receivables', ['IncreaseDecreaseInAccountsReceivable'], { i: 1, s: -1 }],
  ['chgInv', 'Change in inventory', ['IncreaseDecreaseInInventories'], { i: 1, s: -1 }],
  ['chgAp', 'Change in payables', ['IncreaseDecreaseInAccountsPayable'], { i: 1 }],
  ['ocf', 'Operating cash flow', ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'], { b: 1 }],
  ['capexPPE', 'Capital expenditures', ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'], { i: 1, s: -1 }],
  ['software', 'Capitalized software', ['PaymentsToDevelopSoftware', 'PaymentsForSoftware'], { i: 1, s: -1 }],
  ['acq', 'Acquisitions', ['PaymentsToAcquireBusinessesNetOfCashAcquired'], { i: 1, s: -1 }],
  ['buyInv', 'Purchases of investments', ['PaymentsToAcquireAvailableForSaleSecuritiesDebt', 'PaymentsToAcquireInvestments', 'PaymentsToAcquireMarketableSecurities'], { i: 1, s: -1 }],
  ['sellInv', 'Sales & maturities of investments', ['ProceedsFromSaleMaturityAndCollectionsOfInvestments', 'ProceedsFromMaturitiesPrepaymentsAndCallsOfAvailableForSaleSecurities', 'ProceedsFromSaleOfAvailableForSaleSecuritiesDebt'], { i: 1 }],
  ['icf', 'Investing cash flow', ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'], { b: 1 }],
  ['debtIss', 'Debt issued', ['ProceedsFromIssuanceOfLongTermDebt', 'ProceedsFromIssuanceOfDebt'], { i: 1 }],
  ['debtRep', 'Debt repaid', ['RepaymentsOfLongTermDebt', 'RepaymentsOfDebt'], { i: 1, s: -1 }],
  ['buybacks', 'Share repurchases', ['PaymentsForRepurchaseOfCommonStock'], { i: 1, s: -1 }],
  ['dividends', 'Dividends paid', ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'], { i: 1, s: -1 }],
  ['fincf', 'Financing cash flow', ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'], { b: 1 }],
  ['fx', 'Exchange-rate effect', ['EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'EffectOfExchangeRateOnCashAndCashEquivalents'], { i: 1 }],
  ['netChg', 'Net change in cash', ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect', 'CashAndCashEquivalentsPeriodIncreaseDecrease'], { b: 1 }],
  ['fcf', 'Free cash flow (OCF − capex − software)', [], { b: 1, d: 1 }]
];
const OCI = [
  ['ociNI', 'Net income (incl. noncontrolling)', ['ProfitLoss', 'NetIncomeLoss'], { b: 1 }],
  ['ociFx', 'Foreign currency translation', ['OtherComprehensiveIncomeLossForeignCurrencyTransactionAndTranslationAdjustmentNetOfTax', 'OtherComprehensiveIncomeForeignCurrencyTransactionAndTranslationAdjustmentNetOfTax'], { i: 1 }],
  ['ociSec', 'Unrealized gains on securities', ['OtherComprehensiveIncomeLossAvailableForSaleSecuritiesAdjustmentNetOfTax', 'OtherComprehensiveIncomeUnrealizedHoldingGainLossOnSecuritiesArisingDuringPeriodNetOfTax'], { i: 1 }],
  ['ociHedge', 'Cash-flow hedges', ['OtherComprehensiveIncomeLossCashFlowHedgeGainLossAfterReclassificationAndTax', 'OtherComprehensiveIncomeLossDerivativesQualifyingAsHedgesNetOfTax'], { i: 1 }],
  ['ociPension', 'Pension & retiree plans', ['OtherComprehensiveIncomeLossPensionAndOtherPostretirementBenefitPlansAdjustmentNetOfTax'], { i: 1 }],
  ['ociTotal', 'Other comprehensive income', ['OtherComprehensiveIncomeLossNetOfTax', 'OtherComprehensiveIncomeLossNetOfTaxPortionAttributableToParent'], { b: 1 }],
  ['compInc', 'Comprehensive income', ['ComprehensiveIncomeNetOfTax', 'ComprehensiveIncomeNetOfTaxIncludingPortionAttributableToNoncontrollingInterest'], { b: 1 }],
  ['aociEnd', 'Accumulated OCI, period end', ['AccumulatedOtherComprehensiveIncomeLossNetOfTax'], { inst: 1 }]
];
const SECTIONS = [['income', 'Income statement', IS, 'flow'], ['balance', 'Balance sheet', BS, 'inst'], ['cashflow', 'Cash flow statement', CF, 'flow'], ['oci', 'Comprehensive income', OCI, 'flow']];

/* ================= sec_statements ================= */
async function secStatements(args) {
  const ticker = String(args.ticker || '').trim();
  if (!ticker) throw new Error('ticker is required');
  const nYears = Math.min(Math.max(parseInt(args.years) || 12, 1), 20);
  const co = await cikFor(ticker);
  const r = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${co.cik}.json`);
  if (!r) throw new Error('No XBRL company facts on EDGAR for ' + ticker);
  const facts = (await r.json()).facts || {};
  const gaap = facts['us-gaap'] || {};
  const pred = PREDECESSOR[co.cikInt];
  if (pred) {   // merge the predecessor's filings underneath; the successor wins on any period both reported
    const pr = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pred.cik}.json`);
    const pg = pr ? (((await pr.json()).facts || {})['us-gaap'] || {}) : {};
    for (const [tag, o] of Object.entries(pg)) {
      if (!gaap[tag]) gaap[tag] = { units: {} };
      for (const [u, arr] of Object.entries(o.units || {})) gaap[tag].units[u] = [...arr.map(f => ({ ...f, _cik: pred.cikInt })), ...(gaap[tag].units[u] || [])];
    }
  }

  // tag -> Map(periodKey -> fact), only 10-K/10-Q family, latest filing wins
  const cache = new Map();
  const index = (tag, unit, inst) => {
    const ck = tag + '|' + unit + '|' + (inst ? 'i' : 'f');
    if (cache.has(ck)) return cache.get(ck);
    const arr = gaap[tag]?.units?.[unit] || [];
    const m = new Map();
    for (const f of arr) {
      if (!/^(10-K|10-Q|10-KT)/.test(f.form || '')) continue;
      if (!inst && !f.start) continue;
      if (inst && f.start) continue;
      const key = inst ? f.end : f.start + '|' + f.end;
      const p = m.get(key);
      // latest filing wins, except a 10-Q never overrides a 10-K's full-year figure (FIX tagged a quarter as the year)
      const annual = !inst && days(f.start, f.end) > 350, isK = x => /^10-K/.test(x.form || '');
      if (!p) m.set(key, f);
      else if (annual && isK(p) && !isK(f)) { /* keep the 10-K */ }
      else if ((annual && isK(f) && !isK(p)) || (f.filed || '') > (p.filed || '')) m.set(key, f);
    }
    cache.set(ck, m);
    return m;
  };
  const flow = (tags, unit, s, e) => { for (const t of tags) { const f = index(t, unit, false).get(s + '|' + e); if (f) return f.val; } return null; };
  const inst = (tags, unit, e) => { for (const t of tags) { const f = index(t, unit, true).get(e); if (f) return f.val; } return null; };
  const near = (tags, unit, s, e, len) => { for (const t of tags) for (const f of index(t, unit, false).values()) if (Math.abs(days(f.start, s)) < 8 && Math.abs(days(f.end, e)) < 8 && Math.abs(days(f.start, f.end) - len) < 12) return f.val; return null; };

  // fiscal years = annual periods on the anchor lines
  const periods = new Map();
  for (const t of [...IS[0][2], 'NetIncomeLoss', 'NetCashProvidedByUsedInOperatingActivities', 'OperatingIncomeLoss'])
    for (const f of index(t, 'USD', false).values()) { const d = days(f.start, f.end); if (d > 350 && d < 380 && /^10-K/.test(f.form || '')) periods.set(f.end, f.start); }   // 10-Qs can carry trailing-twelve-month figures (Amazon): only 10-Ks define fiscal years
  // 52/53-week years can leave two ends a few days apart for one fiscal year (Domino's): keep the later one
  const allEnds = [...periods.keys()].sort(), dedup = [];
  for (const e of allEnds) { if (dedup.length && Math.abs(days(dedup[dedup.length - 1], e)) < 20) dedup[dedup.length - 1] = e; else dedup.push(e); }
  const ends = dedup.slice(-nYears);
  if (!ends.length) throw new Error('No annual 10-K data found for ' + ticker);
  const lastEnd = ends[ends.length - 1];

  // latest YTD after last FY (for TTM) and latest balance-sheet date
  let ytd = null;
  for (const t of [...IS[0][2], 'NetIncomeLoss']) for (const f of index(t, 'USD', false).values()) {
    const d = days(f.start, f.end);
    if (f.end > lastEnd && d > 80 && d < 300 && (!ytd || f.end > ytd.end || (f.end === ytd.end && f.start < ytd.start))) ytd = f;
  }
  const fyStartLast = periods.get(lastEnd);

  const statements = {};
  for (const [id, title, rows, kind] of SECTIONS) {
    const outRows = [];
    for (const [key, label, tags, o] of rows) {
      if (o.d) continue;
      const unit = o.u || 'USD', s = o.s || 1, isInst = kind === 'inst' || o.inst;
      // revenue: companies switch tags (ASC 606 split lease and contract revenue), so take the largest total reported
      const maxOver = fn => { let m = null; for (const t of tags) { if (/IncludingAssessedTax/.test(t)) continue; const v = fn([t]); if (v != null && (m == null || v > m)) m = v; } return m ?? fn(tags.filter(t => /IncludingAssessedTax/.test(t))); };   // net of excise taxes unless only the gross figure exists
      const flowNear = (tg, s0, e) => flow(tg, unit, s0, e) ?? (s0 ? near(tg, unit, s0, e, days(s0, e)) : null);   // filings can date a fiscal year a day or two differently
      const pickFlow = (s0, e) => o.max ? maxOver(tg => flowNear(tg, s0, e)) : flowNear(tags, s0, e);
      const values = ends.map(e => { const v = isInst ? inst(tags, unit, e) : pickFlow(periods.get(e), e); return v == null ? null : v * s; });
      let last = null;
      if (isInst) { if (ytd) { const v = inst(tags, unit, ytd.end); last = v == null ? null : v * s; } }
      else if (ytd) {
        const len = days(ytd.start, ytd.end);
        const ttmOf = tg => { const fy = flow(tg, unit, fyStartLast, lastEnd), cur = near(tg, unit, ytd.start, ytd.end, len), pri = near(tg, unit, shiftYear(ytd.start), shiftYear(ytd.end), len); return unit === 'shares' ? cur : (fy != null && cur != null && pri != null ? fy + cur - pri : null); };
        const v = o.max ? maxOver(ttmOf) : ttmOf(tags);
        if (v != null) last = unit === 'shares' ? v : v * s;
      }
      outRows.push({ key, label, bold: !!o.b, indent: !!o.i, unit, values, last });
    }
    statements[id] = { title, kind: id === 'balance' ? 'instant' : 'duration', rows: outRows };
  }

  // derived rows and fills
  const R = (sec, k) => statements[sec].rows.find(r => r.key === k);
  const derive = (sec, key, label, fn, opt = {}) => {
    const rows = statements[sec].rows; const n = ends.length;
    const values = Array.from({ length: n }, (_, i) => fn(k => R(sec, k)?.values[i] ?? null));
    const last = fn(k => R(sec, k)?.last ?? null);
    const existing = R(sec, key);
    if (existing) { existing.values = existing.values.map((v, i) => v ?? values[i]); existing.last = existing.last ?? last; }
    else rows.splice(opt.at ?? rows.length, 0, { key, label, bold: !!opt.b, indent: false, unit: 'USD', values, last, derived: true });
  };
  // share count: diluted, else basic, else balance-sheet shares, else the cover-page count; fix filings that report shares in thousands or millions
  const coverShares = (() => { const a = ((facts.dei || {}).EntityCommonStockSharesOutstanding?.units?.shares) || []; return e => { let best = null; for (const f of a) { const d = days(e, f.end); if (d >= -10 && d <= 120 && (!best || Math.abs(d) < Math.abs(days(e, best.end)))) best = f; } return best ? best.val : null; }; })();
  { const sh = R('income', 'dilShares'), bs = R('income', 'shBasic'), so = R('balance', 'sharesOut'), ni = R('income', 'netIncome'), ep = R('income', 'eps');
    if (sh) sh.values = sh.values.map((v, i) => v ?? bs?.values[i] ?? so?.values[i] ?? coverShares(ends[i]));
    if (sh && ni && ep) sh.values = sh.values.map((v, i) => { const n = ni.values[i], e = ep.values[i]; if (v == null || !n || !e) return v; const r = n / (e * v); for (const m of [1e3, 1e6]) if (Math.abs(r / m - 1) < 0.25) return v * m; return v; });
    if (sh && ni && ep && sh.last && ni.last && ep.last) { const r = ni.last / (ep.last * sh.last); for (const m of [1e3, 1e6]) if (Math.abs(r / m - 1) < 0.25) sh.last *= m; }
    if (sh && sh.last == null) sh.last = bs?.last ?? so?.last ?? null; }
  derive('income', 'eps', 'EPS, diluted', g => g('eps') ?? (g('netIncome') != null && g('dilShares') ? Math.round(g('netIncome') / g('dilShares') * 100) / 100 : null));
  { const ep = R('income', 'eps'), ni = R('income', 'netIncome'), sh = R('income', 'dilShares');   // some filers tag a loss per share as a positive number
    if (ep && ni && sh) { const fixS = (e, n, c) => e > 0 && n < 0 && c > 0 && Math.abs(n / (e * c) + 1) < 0.25 ? -e : e; ep.values = ep.values.map((e, i) => fixS(e, ni.values[i], sh.values[i])); ep.last = fixS(ep.last, ni.last, sh.last); } }
  { const rv = R('income', 'revenue'), a = R('income', 'nii'), b = R('income', 'nonII');   // banks: net interest income + noninterest income, when larger than whatever was tagged as revenue
    if (rv && a && b) { const fix = (v, x, y) => x != null && y != null && (v == null || x + y > v) ? x + y : v; rv.values = rv.values.map((v, i) => fix(v, a.values[i], b.values[i])); rv.last = fix(rv.last, a.last, b.last); } }
  derive('income', 'opIncome', 'Operating income', g => g('opIncome')
    ?? (g('pretax') != null && g('nii') != null ? g('pretax')   // banks: interest is their cost of goods, so pretax income is the operating line
    : g('pretax') != null ? g('pretax') + Math.abs(g('interestExp') || 0)   // no operating-income line (Deere, oil majors, homebuilders): EBIT = pretax + interest
    : g('netIncome') != null && g('interestExp') != null ? g('netIncome') + (g('nci') || 0) + Math.abs(g('interestExp')) + (g('tax') || 0) : null));   // REITs file no pretax line: net income + interest + tax
  derive('income', 'grossProfit', 'Gross profit', g => g('revenue') != null && g('cogs') != null ? g('revenue') + g('cogs') : null);
  derive('cashflow', 'fcf', 'Free cash flow (OCF − capex − software)', g => g('ocf') != null && g('capexPPE') != null ? g('ocf') + g('capexPPE') + (g('software') || 0) : null, { b: 1 });
  derive('balance', 'liabilities', 'Total liabilities', g => g('liabEq') != null && g('equity') != null ? g('liabEq') - g('equity') - (g('nciEq') || 0) : null);

  // gross profit must equal revenue − cost as shown: some filers tag GrossProfit on a different revenue base in a single year
  { const gp = R('income', 'grossProfit'), rv = R('income', 'revenue'), cg = R('income', 'cogs');
    if (gp && rv && cg) { const fx = (v, r, c) => (v != null && r != null && c != null && Math.abs(v - (r + c)) > Math.abs(r) * 0.02) ? r + c : v;
      gp.values = gp.values.map((v, i) => fx(v, rv.values[i], cg.values[i])); gp.last = fx(gp.last, rv.last, cg.last); } }
  // dividends per share: when the per-share tag is missing for a year, dividends paid ÷ shares
  { const dp = R('income', 'dps'), dv = R('cashflow', 'dividends'), sh = R('income', 'shBasic') || R('income', 'dilShares');
    if (dp && dv && sh) dp.values = dp.values.map((v, i) => { if (v != null) return v; const d = dv.values[i], n = sh.values[i]; return d != null && n > 0 && d !== 0 ? Math.round(Math.abs(d) / n * 100) / 100 : null; }); }
  // key series for analysis (annual + ttm)
  const val = (sec, k) => R(sec, k) || { values: ends.map(() => null), last: null };
  const pickV = (sec, k, i) => i === -1 ? val(sec, k).last : val(sec, k).values[i];
  const keyRow = i => {
    const g = (sec, k) => pickV(sec, k, i);
    const debt = (g('balance', 'ltDebt') || 0) + (g('balance', 'curDebt') || 0);
    const hasDebt = g('balance', 'ltDebt') != null || g('balance', 'curDebt') != null;
    const cash = g('balance', 'cash') != null ? g('balance', 'cash') + (g('balance', 'stInv') || 0) : null;
    const opInc = g('income', 'opIncome'), da = g('cashflow', 'da');
    return {
      revenue: g('income', 'revenue'), grossProfit: g('income', 'grossProfit'), opIncome: opInc, netIncome: g('income', 'netIncome'),
      eps: g('income', 'eps'), dilShares: g('income', 'dilShares'), sharesOut: g('balance', 'sharesOut'), dps: g('income', 'dps'),
      ocf: g('cashflow', 'ocf'), capex: g('cashflow', 'capexPPE') != null ? -(g('cashflow', 'capexPPE') + (g('cashflow', 'software') || 0)) : null,
      fcf: g('cashflow', 'fcf'), sbc: g('cashflow', 'sbc'), da, ebitda: opInc != null && da != null ? opInc + da : null,
      dividends: g('cashflow', 'dividends') != null ? -g('cashflow', 'dividends') : null, buybacks: g('cashflow', 'buybacks') != null ? -g('cashflow', 'buybacks') : null,
      cash, debt: hasDebt ? debt : null, equity: g('balance', 'equity'), netDebt: hasDebt && cash != null ? debt - cash : null,
      // funds from operations (NAREIT style): net income + depreciation − gains on property sales + real-estate impairments
      ffo: g('income', 'netIncome') != null && da != null ? g('income', 'netIncome') + da + (g('cashflow', 'gainRE') || 0) + (g('cashflow', 'impairRE') || 0) : null
    };
  };
  const keyYears = ends.map((_, i) => keyRow(i));
  const key = {}; for (const k of Object.keys(keyYears[0])) key[k] = keyYears.map(r => r[k]);
  const ttm = ytd ? keyRow(-1) : null;

  // quarterly view: discrete fiscal quarters from year-to-date filings (fiscal Q4 = full year − nine months)
  function quarterly() {
    try {
      const ALL = [...IS, ...BS, ...CF];
      const spec = k => { const r = ALL.find(x => x[0] === k); return r ? { tags: r[2], s: (r[3] && r[3].s) || 1, u: (r[3] && r[3].u) || 'USD' } : null; };
      const q3 = (tags, unit, e) => { for (const t of tags) for (const f of index(t, unit, false).values()) { const d = days(f.start, f.end); if (d > 80 && d < 100 && Math.abs(days(f.end, e)) < 4) return f.val; } return null; };
      const cum = (tags, unit, s0, e) => flow(tags, unit, s0, e) ?? near(tags, unit, s0, e, days(s0, e));
      const fyList = ends.slice(-5).map(e => [periods.get(e), e]);
      if (ytd && !ends.includes(ytd.end)) fyList.push([ytd.start, null]);
      const anchors = [...IS[0][2], 'NetIncomeLoss', 'NetCashProvidedByUsedInOperatingActivities'];
      const qs = [];
      for (const [s0, fyEnd] of fyList) {
        if (!s0) continue;
        const set = new Set(fyEnd ? [fyEnd] : []);
        for (const t of anchors) for (const f of index(t, 'USD', false).values()) {
          if (Math.abs(days(f.start, s0)) > 6) continue;
          const d = days(f.start, f.end); if (d > 80 && d < 300) set.add(f.end);
        }
        const list = [...set].sort(), clean = [];
        for (const e of list) if (!clean.length || days(clean[clean.length - 1], e) > 20) clean.push(e);
        const fyGuess = new Date(Date.parse(s0) + 360 * 864e5).toISOString().slice(0, 10);
        const fy = Number(fyGuess.slice(0, 4)) - (Number(fyGuess.slice(5, 7)) <= 3 ? 1 : 0);
        clean.forEach((e, i) => (i || days(s0, e) < 100) && qs.push({ s0, end: e, prev: i ? clean[i - 1] : null, fy, q: Math.min(4, Math.round(days(s0, e) / 91.3)) || i + 1 }));
      }
      const pick = qs.slice(-16);
      const flowQ = k => { const sp = spec(k); if (!sp) return pick.map(() => null);
        if (k === 'revenue') { const qv = (t, p) => { let v = q3([t], sp.u, p.end); if (v == null) { const a = cum([t], sp.u, p.s0, p.end), b = p.prev ? cum([t], sp.u, p.s0, p.prev) : 0; v = a != null && b != null ? a - b : null; } return v; };
          return pick.map(p => { let m = null; for (const t of sp.tags) { if (/IncludingAssessedTax/.test(t)) continue; const v = qv(t, p); if (v != null && (m == null || v > m)) m = v; }
            if (m == null) for (const t of sp.tags.filter(t => /IncludingAssessedTax/.test(t))) { const v = qv(t, p); if (v != null) { m = v; break; } }   // refiners and others report only the gross figure
            return m; }); }
        return pick.map(p => { let v = q3(sp.tags, sp.u, p.end);
          if (v == null) { const a = cum(sp.tags, sp.u, p.s0, p.end), b = p.prev ? cum(sp.tags, sp.u, p.s0, p.prev) : 0; v = a != null && b != null ? a - b : null; }
          if (v != null && sp.u === 'shares') return v;
          return v == null ? null : v * sp.s; }); };
      const instQ = k => { const sp = spec(k); if (!sp) return pick.map(() => null); return pick.map(p => { const v = inst(sp.tags, sp.u, p.end); return v == null ? null : v * sp.s; }); };
      const rows = {};
      for (const k of ['revenue', 'cogs', 'grossProfit', 'opIncome', 'netIncome', 'eps', 'ocf', 'capexPPE', 'software', 'da', 'sbc', 'dividends', 'buybacks']) rows[k] = flowQ(k);
      rows.dilShares = pick.map(p => { const sp = spec('dilShares'); for (const t of sp.tags) for (const f of index(t, 'shares', false).values()) { const d = days(f.start, f.end); if (d > 80 && d < 100 && Math.abs(days(f.end, p.end)) < 4) return f.val; } return null; });
      for (const k of ['cash', 'stInv', 'curDebt', 'ltDebt', 'equity', 'sharesOut']) rows[k] = instQ(k);
      { const a = flowQ('nii'), b = flowQ('nonII');   // banks: net interest income + noninterest income, as in the annual figures
        rows.revenue = rows.revenue.map((v, i) => a[i] != null && b[i] != null && (v == null || a[i] + b[i] > v) ? a[i] + b[i] : v); }
      { const rvA = R('income', 'revenue'), fyRev = p => { const i = ends.findIndex(e => Math.abs(days(periods.get(e), p.s0)) < 8); return i >= 0 ? rvA?.values[i] : null; };
        const lastFY = rvA ? [...rvA.values].reverse().find(v => v != null) : null;
        rows.revenue = rows.revenue.map((v, i) => { const cap = fyRev(pick[i]) ?? (lastFY ? lastFY * 1.6 : null); return v != null && cap && v > cap * 0.6 ? null : v; }); }   // a quarter can't be most of a year: mismatched tags
      rows.grossProfit = rows.grossProfit.map((v, i) => { const d = rows.revenue[i] != null && rows.cogs[i] != null ? rows.revenue[i] + rows.cogs[i] : null; return v == null ? d : (d != null && Math.abs(v - d) > Math.abs(rows.revenue[i]) * 0.02 ? d : v); });
      rows.fcf = rows.ocf.map((v, i) => v != null && rows.capexPPE[i] != null ? v + rows.capexPPE[i] + (rows.software[i] || 0) : null);
      rows.capex = rows.capexPPE.map((v, i) => v != null ? -(v + (rows.software[i] || 0)) : null);
      rows.ebitda = rows.opIncome.map((v, i) => v != null && rows.da[i] != null ? v + rows.da[i] : null);
      // where each quarter's numbers come from: the filing (form, date, accession) and XBRL tag behind its revenue
      const srcFor = p => {
        let best = null;
        for (const t of [...IS[0][2], 'NetIncomeLoss']) for (const f of index(t, 'USD', false).values()) {
          if (Math.abs(days(f.end, p.end)) > 4) continue;
          const d = days(f.start, f.end);
          const direct = d > 80 && d < 100, ytdMatch = Math.abs(days(f.start, p.s0)) < 7;
          if (!direct && !ytdMatch) continue;
          const score = (direct ? 2 : 1);
          if (!best || score > best.score) best = { score, form: f.form, filed: f.filed, accn: f.accn, tag: t, months: Math.round(d / 30.4), cik: f._cik || co.cikInt };
        }
        if (!best) return null;
        const derived = !(best.months <= 3);
        return { form: best.form, filed: best.filed, accn: best.accn, cik: best.cik, tag: best.tag, derived, how: derived ? (best.months >= 11 ? 'full year in the ' + best.form + ' minus nine months from the 10-Qs' : best.months + '-month year-to-date minus the prior year-to-date') : 'three-month figures as filed' };
      };
      return { cik: co.cikInt || String(Number(co.cik)), periods: pick.map(p => ({ end: p.end, fy: p.fy, q: p.q, label: 'Q' + p.q + ' FY' + p.fy, src: srcFor(p) })), rows };
    } catch (e) { return null; }
  }

  return {
    ticker: ticker.toUpperCase(), cik: co.cik, name: co.name,
    source: 'SEC EDGAR XBRL company facts — 10-K and 10-Q as filed, latest restatement wins',
    years: (() => { const ys = ends.map(e => ({ fy: Number(e.slice(0, 4)) - (Number(e.slice(5, 7)) <= 3 ? 1 : 0), end: e })); for (let i = ys.length - 2; i >= 0; i--) if (ys[i].fy >= ys[i + 1].fy) ys[i].fy = ys[i + 1].fy - 1; return ys; })(),   // a change of fiscal year-end can give two years one name
    lastPeriod: ytd ? { end: ytd.end, label: 'TTM to ' + ytd.end, balanceLabel: 'Q ' + ytd.end } : null,
    statements, key, ttm, quarters: quarterly(),
    links: { filings: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${co.cik}&type=10-K&dateb=&owner=include&count=40` }
  };
}

/* ================= filing sections: MD&A, notes, risk factors, business, legal ================= */
const D = '\\s*[\\-–—:.]?\\s*';
const SECTIONS_10K = {
  mdna:     [`item\\s*7${D}management[’'\`s]*\\s+discussion`, `item\\s*(7a|8)${D}(quantitative|financial\\s+statements)`],
  notes:    [`item\\s*8${D}financial\\s+statements`, `item\\s*9${D}(changes|controls)`],
  risk:     [`item\\s*1a${D}risk\\s+factors`, `item\\s*(1b|1c|2)${D}(unresolved|cybersecurity|properties)`],
  business: [`item\\s*1${D}business`, `item\\s*1a${D}risk\\s+factors`],
  legal:    [`item\\s*3${D}legal\\s+proceedings`, `item\\s*4${D}mine`]
};
const SECTIONS_10Q = {
  mdna:     [`item\\s*2${D}management[’'\`s]*\\s+discussion`, `item\\s*(3|4)${D}(quantitative|controls)`],
  notes:    [`item\\s*1${D}financial\\s+statements`, `item\\s*2${D}management[’'\`s]*\\s+discussion`],
  risk:     [`item\\s*1a${D}risk\\s+factors`, `item\\s*(2|5|6)${D}(unregistered|other|exhibits)`],
  legal:    [`item\\s*1${D}legal\\s+proceedings`, `item\\s*1a${D}risk\\s+factors`]
};
const SECTION_NAMES = { mdna: "Management's Discussion and Analysis", notes: 'Notes to the financial statements', risk: 'Risk factors', business: 'Business', legal: 'Legal proceedings' };

// longest span from a start heading to the first end heading after it (skips the table of contents)
function sliceSection(text, startSrc, endSrc, minLen = 500) {
  const startRe = new RegExp(startSrc, 'gi'), endRe = new RegExp(endSrc, 'gi');
  let best = null, m;
  const starts = []; while ((m = startRe.exec(text))) starts.push(m.index);
  const ends = []; while ((m = endRe.exec(text))) ends.push(m.index);
  starts.forEach((s, i) => { const e = ends.find(x => x > s); if (!e || (starts[i + 1] && starts[i + 1] < e)) return; if (e - s > minLen && (!best || e - s > best[1] - best[0])) best = [s, e]; });
  return best ? text.slice(best[0], best[1]) : '';
}
// the legal-proceedings part of the notes (usually under Commitments and Contingencies)
function legalFromNotes(text) {
  const notes = trimToNotes(sliceSection(text, ...SECTIONS_10K.notes) || text);
  const re = /(legal\s+proceedings|litigation|legal\s+matters)/gi; let m, best = null;
  while ((m = re.exec(notes))) { const before = notes.slice(Math.max(0, m.index - 3), m.index); if (/\n\s*$/.test(before) || /^\s*$/.test(before)) { best = m.index; break; } if (best == null) best = m.index; }
  if (best == null) return '';
  let out = notes.slice(best, best + 20000);
  const stop = out.slice(200).search(/\n\s*(note\s+\d+|\d{1,2}\s*[\.—–-]\s*[A-Z][A-Za-z ,&]{3,60}\n)/i); if (stop > 0) out = out.slice(0, stop + 200);
  return out.trim();
}
// inside Item 8, skip the statements themselves and start at the first note
function trimToNotes(body) {
  const re = /notes\s+to\s+(the\s+)?(condensed\s+)?(consolidated\s+|combined\s+)?financial\s+statements/gi;
  let m; const hits = [];
  while ((m = re.exec(body))) hits.push(m.index);
  for (const h of hits) { const after = body.slice(h, h + 600); if (/(note\s*1\b|\n\s*1\.\s+[A-Z])/i.test(after)) return body.slice(h); }
  return hits.length > 1 ? body.slice(hits[1]) : body;
}

async function secSection(args) {
  const ticker = String(args.ticker || '').trim();
  if (!ticker) throw new Error('ticker is required');
  const form = /10-?q/i.test(args.form || '') ? '10-Q' : '10-K';
  const section = String(args.section || 'mdna').toLowerCase();
  const table = form === '10-K' ? SECTIONS_10K : SECTIONS_10Q;
  if (!table[section]) throw new Error('section must be one of: ' + Object.keys(table).join(', ') + ' for a ' + form);
  const maxChars = Math.min(Math.max(parseInt(args.maxChars) || (section === 'notes' ? 120000 : 60000), 2000), 200000);
  let co = await cikFor(ticker);
  const findForm = async c => { const sr = await secGet(`https://data.sec.gov/submissions/CIK${c.cik}.json`, 3600); if (!sr) return { rec: {}, idx: -1 }; const rec = (await sr.json()).filings?.recent || {}; let idx = -1, skip = Math.max(0, parseInt(args.nth) || 0); for (let i = 0; i < (rec.form || []).length; i++) if (rec.form[i] === form) { if (skip-- > 0) continue; idx = i; break; } return { rec, idx }; };
  let { rec, idx } = await findForm(co);
  if (idx < 0 && PREDECESSOR[co.cikInt]) { co = { ...co, ...PREDECESSOR[co.cikInt] }; ({ rec, idx } = await findForm(co)); }
  if (idx < 0) throw new Error('No recent ' + form + ' found for ' + ticker);
  const acc = rec.accessionNumber[idx], doc = rec.primaryDocument[idx];
  const url = `https://www.sec.gov/Archives/edgar/data/${co.cikInt}/${acc.replace(/-/g, '')}/${doc}`;
  const hr = await secGet(url, 86400);
  if (!hr) throw new Error('Filing document not found');
  const text = htmlToText(await hr.text());
  let body = sliceSection(text, ...table[section], section === 'legal' ? 30 : 500);
  // a short legal item usually just points to a note ("see Note 11"): add that note's legal-proceedings text
  if (section === 'legal' && body.length < 2500 && /note|commitments|contingenc/i.test(body)) { const extra = legalFromNotes(text); if (extra) body = body.trim() + '\n\n— From the notes to the financial statements —\n\n' + extra; }
  if (body && section === 'notes') body = trimToNotes(body);
  if (!body && section === 'notes') { const t = trimToNotes(text); if (t !== text) body = t; }
  if (!body) throw new Error("Couldn't locate the " + SECTION_NAMES[section] + ' section in ' + url);
  const truncated = body.length > maxChars;
  if (truncated) body = body.slice(0, maxChars);
  return {
    ticker: ticker.toUpperCase(), name: co.name, form, section, sectionName: SECTION_NAMES[section],
    filed: rec.filingDate[idx], periodOfReport: rec.reportDate?.[idx] || null,
    url, chars: body.length, truncated, text: body.trim()
  };
}
const secMdna = args => secSection({ ...args, section: 'mdna' });

/* ================= AI: ask the filings, and plain-English screens (Anthropic API, key in the ANTHROPIC_API_KEY secret) ================= */
const AI_MODEL = 'claude-sonnet-5-5', AI_DAILY_PER_IP = 40, AI_DAILY_ALL = 600;
async function aiQuota(env, req) {
  if (!env.DB) return true;
  const day = etDay(), who = req.headers.get('CF-Connecting-IP') || 'unknown';
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT, who TEXT, n INTEGER, PRIMARY KEY (day, who))').run();
  const me = await env.DB.prepare('SELECT n FROM ai_usage WHERE day = ? AND who = ?').bind(day, who).first(), all = await env.DB.prepare('SELECT SUM(n) AS n FROM ai_usage WHERE day = ?').bind(day).first();
  if ((me && me.n >= AI_DAILY_PER_IP) || (all && all.n >= AI_DAILY_ALL)) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, who, n) VALUES (?, ?, 1) ON CONFLICT (day, who) DO UPDATE SET n = n + 1').bind(day, who).run();
  return true;
}
async function claude(env, system, user, maxTokens = 900) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.AI_MODEL || AI_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('AI service: ' + ((j.error && j.error.message) || r.status));
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
}
const STOP = new Set('the a an and or of to in on for is are was were be been it its this that what why how did does do with by as at from about their they our we which who whom will would can could has have had not no than then there these those into over under more most less much many any all'.split(' '));
const terms = t => String(t || '').toLowerCase().replace(/[^a-z0-9% ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
async function askFilings(ticker, question, env) {
  const t = String(ticker || '').trim(), qn = String(question || '').trim().slice(0, 500);
  if (!t || !qn) throw new Error('ticker and question are required');
  const want = [['10-K', 'business'], ['10-K', 'risk'], ['10-K', 'mdna'], ['10-K', 'legal'], ['10-Q', 'mdna'], ['10-Q', 'risk'], ['10-Q', 'notes'], ['10-K', 'notes']];
  const docs = (await Promise.all(want.map(([form, section]) => secSection({ ticker: t, form, section, maxChars: 150000 }).catch(() => null)))).filter(Boolean);
  if (!docs.length) throw new Error('No filings found for ' + t);
  const qt = terms(qn), qs = new Set(qt), chunks = [];
  for (const d of docs) for (const p of paras(d.text)) { const w = terms(p); let sc = 0; const seen = new Set(); for (const x of w) if (qs.has(x) && !seen.has(x)) { seen.add(x); sc += 1; } if (sc) chunks.push({ d, p: p.length > 1600 ? p.slice(0, 1600) : p, sc: sc / Math.sqrt(1 + w.length / 80) + (d.form === '10-Q' ? 0.15 : 0) }); }
  chunks.sort((a, b) => b.sc - a.sc);
  const pickd = []; let len = 0; for (const c of chunks) { if (len + c.p.length > 22000 || pickd.length >= 28) break; pickd.push(c); len += c.p.length; }
  if (!pickd.length) for (const d of docs.slice(0, 2)) for (const p of paras(d.text).slice(0, 8)) pickd.push({ d, p });
  const src = pickd.map((c, i) => ({ id: 'S' + (i + 1), form: c.d.form, section: c.d.sectionName, filed: c.d.filed, period: c.d.periodOfReport, url: c.d.url, text: c.p }));
  const system = 'You are a precise equity analyst answering questions about one company using only the SEC filing excerpts provided. Rules: answer in at most 180 words, plain English, no hype; every factual claim cites its excerpt like [S3]; quote short exact phrases where they matter; if the excerpts do not answer the question, say so plainly and say what the filings do cover; never invent numbers; no investment advice.';
  const user = `Company: ${docs[0].name} (${t.toUpperCase()})\nQuestion: ${qn}\n\nExcerpts:\n` + src.map(x => `[${x.id}] ${x.form} filed ${x.filed}, ${x.section}:\n${x.text}`).join('\n\n');
  const answer = await claude(env, system, user, 700);
  const used = new Set((answer.match(/\[S\d+\]/g) || []).map(x => x.slice(1, -1)));
  return { ticker: t.toUpperCase(), name: docs[0].name, question: qn, answer, model: env.AI_MODEL || AI_MODEL, sources: src.filter(x => used.has(x.id)).map(x => ({ ...x, text: x.text.slice(0, 600) })) };
}
/* ================= Ask AI research agent (3.19.0) =================
   The model answers with everything LedgerLine shows for the open stock (sent by the page as text, cited [D]), and can go get more:
   stock_data (prices, returns, technicals and key financials for any ticker), filing_section (any 10-K/10-Q section, cited [S#])
   and a live web search (news, lawsuits, analyst moves; cited [W#]). Up to 8 rounds, 4 web searches. Falls back to no web search
   if the account doesn't allow it. */
const askNum = (v, d = 2) => v == null || !isFinite(v) ? null : +Number(v).toFixed(d);
function priceFacts(m) {
  const d = m && m.daily; if (!d || !d.c || !d.c.length) return { error: 'no price history' };
  const c = d.c, n = c.length, last = m.price || c[n - 1], at = k => n > k ? c[n - 1 - k] : null, ret = k => { const b = at(k); return b ? askNum((last / b - 1) * 100, 1) : null; };
  const sma = k => n >= k ? c.slice(-k).reduce((a, x) => a + x, 0) / k : null;
  let g = 0, l = 0; for (let i = Math.max(1, n - 14); i < n; i++) { const ch = c[i] - c[i - 1]; if (ch > 0) g += ch; else l -= ch; } const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  const lr = []; for (let i = Math.max(1, n - 60); i < n; i++) lr.push(Math.log(c[i] / c[i - 1])); const sd = a => { const mu = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1)); };
  const yStart = Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000; let yi = d.t.findIndex(t => t >= yStart); const ytd = yi > 0 ? askNum((last / c[yi - 1] - 1) * 100, 1) : null;
  const w = m.weekly && m.weekly.c || [], wk = k => w.length > k ? askNum((last / w[w.length - 1 - k] - 1) * 100, 1) : null, hi5 = w.length ? Math.max(...w.slice(-260), last) : null;
  const vol30 = d.v ? d.v.slice(-30).reduce((a, x) => a + x, 0) / Math.min(30, d.v.length) : null;
  return { price: askNum(last), asOf: new Date((m.quoteTime || m.asOf) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', priceNote: m.delayed ? '15-min delayed' : 'end of day',
    changeToday: askNum(m.changePct, 2), ret1W: ret(5), ret1M: ret(21), ret3M: ret(63), ret6M: ret(126), ret1Y: ret(252), ytd, ret3Y: wk(156), ret5Y: wk(260),
    high52: askNum(m.high52), low52: askNum(m.low52), fromHigh52: m.high52 ? askNum((last / m.high52 - 1) * 100, 1) : null, fromHigh5Y: hi5 ? askNum((last / hi5 - 1) * 100, 1) : null,
    sma50: askNum(sma(50)), sma200: askNum(sma(200)), rsi14: askNum(rsi, 0), realizedVol20: lr.length > 20 ? askNum(sd(lr.slice(-20)) * Math.sqrt(252) * 100, 1) : null, realizedVol60: lr.length > 30 ? askNum(sd(lr) * Math.sqrt(252) * 100, 1) : null,
    avgVolume30: vol30 ? Math.round(vol30) : null };
}
function finFacts(st) {
  if (!st || !st.key || !st.years) return null;
  const k = st.key, ys = st.years, n = ys.length, pick = ['revenue', 'grossProfit', 'opIncome', 'netIncome', 'eps', 'fcf', 'ocf', 'capex', 'sbc', 'cash', 'debt', 'netDebt', 'equity', 'sharesOut', 'dps', 'buybacks'];
  const rows = {}; for (const f of pick) if (k[f]) rows[f] = k[f].slice(-5).map(v => v == null ? null : (Math.abs(v) >= 1e5 ? askNum(v / 1e6, 0) : askNum(v, 2)));
  const out = { name: st.name, fiscalYears: ys.slice(-5).map(y => y.fy), unitNote: 'money in $ millions except eps and dps (per share)', annual: rows };
  if (st.ttm) { out.ttm = {}; for (const f of pick) if (st.ttm[f] != null) out.ttm[f] = Math.abs(st.ttm[f]) >= 1e5 ? askNum(st.ttm[f] / 1e6, 0) : askNum(st.ttm[f], 2); out.ttmLabel = st.lastPeriod && st.lastPeriod.label; }
  return out;
}
async function stockData(ticker, env, ctx) {
  const t = String(ticker || '').trim().toUpperCase(); if (!/^[A-Z0-9.\-^]{1,12}$/.test(t)) return { error: 'bad ticker' };
  const [m, st] = await Promise.all([market(t, env, ctx).catch(e => ({ error: String(e.message || e) })), secStatements({ ticker: t, years: 6 }).catch(() => null)]);
  return { ticker: t, prices: m.error ? { error: m.error } : priceFacts(m), financials: finFacts(st) || 'no SEC financials (fund, ETF or foreign filer)' };
}
const ASK_TOOLS = [
  { name: 'stock_data', description: 'LedgerLine data for any US stock or ETF: latest price and change, returns (1W to 5Y, YTD), 52-week and 5-year high distance, 50/200-day averages, RSI, realized volatility, volume, and five years of key annual financials plus trailing twelve months (revenue, profits, EPS, free cash flow, cash, debt, shares, dividends, buybacks). Use for any ticker other than the open one, or to check numbers.', input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'US ticker, e.g. NVDA, SPY, BRK-B' } }, required: ['ticker'] } },
  { name: 'filing_section', description: 'Full text of one section of a company’s latest 10-K (annual) or 10-Q (quarterly) from SEC EDGAR. sections: business, risk (risk factors), mdna (management discussion of results, outlook, liquidity), legal (lawsuits, investigations, contingencies), notes (financial statement notes: debt maturities, segments, leases, commitments). 10-Q has no business section.', input_schema: { type: 'object', properties: { ticker: { type: 'string' }, form: { type: 'string', enum: ['10-K', '10-Q'] }, section: { type: 'string', enum: ['business', 'risk', 'mdna', 'legal', 'notes'] }, nth: { type: 'integer', description: '0 = latest (default), 1 = the one before, 2 = two back; use for year-ago or prior-quarter comparisons' } }, required: ['ticker', 'section'] } },
  { name: 'list_filings', description: 'A company’s recent SEC filings of any type (8-K, 10-K, 10-Q, DEF 14A proxy, S-1, 13D/13G, SC TO, 424B, 4 and more) with dates, descriptions and document links. Use it to find a specific filing, then read_filing to open it.', input_schema: { type: 'object', properties: { ticker: { type: 'string' }, form: { type: 'string', description: 'optional form filter, e.g. 8-K or DEF 14A' } }, required: ['ticker'] } },
  { name: 'read_filing', description: 'Open any document on sec.gov (a link from list_filings) and return its text, cited by the [S#] label at the top of the result. offset lets you read further into long documents.', input_schema: { type: 'object', properties: { url: { type: 'string' }, offset: { type: 'integer', description: 'character offset to start from, default 0' } }, required: ['url'] } }
];
async function listFilings(ticker, form) {
  const co = await cikFor(ticker); const r = await secGet(`https://data.sec.gov/submissions/CIK${co.cik}.json`, 3600); if (!r) throw new Error('No SEC filings found for ' + ticker);
  const rec = (await r.json()).filings?.recent || {}, out = [], want = String(form || '').trim().toUpperCase();
  for (let i = 0; i < (rec.form || []).length && out.length < 40; i++) { if (want && rec.form[i].toUpperCase() !== want) continue; out.push({ form: rec.form[i], filed: rec.filingDate[i], period: rec.reportDate?.[i] || '', items: rec.items?.[i] || '', description: rec.primaryDocDescription?.[i] || '', url: `https://www.sec.gov/Archives/edgar/data/${co.cikInt}/${rec.accessionNumber[i].replace(/-/g, '')}/${rec.primaryDocument[i]}` }); }
  return { ticker: String(ticker).toUpperCase(), name: co.name, filings: out };
}
async function readFiling(url, offset) {
  const u = String(url || ''); if (!/^https:\/\/(www\.)?sec\.gov\//.test(u)) throw new Error('read_filing only opens sec.gov documents');
  const r = await secGet(u, 86400); if (!r) throw new Error('Document not found'); const raw = await r.text();
  const text = /<html|<body|<div|<p[ >]/i.test(raw.slice(0, 5000)) ? htmlToText(raw) : raw; const from = Math.max(0, parseInt(offset) || 0);
  return { url: u, chars: text.length, from, text: text.slice(from, from + 40000) };
}
const WEB_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 }, FETCH_TOOL = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, max_content_tokens: 20000 };
async function claudeMsg(env, body, beta) {
  let last;
  for (let k = 0; k < 4; k++) {
    const headers = { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }; if (beta) headers['anthropic-beta'] = beta;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: env.AI_MODEL || AI_MODEL, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    last = new Error('AI service: ' + ((j.error && j.error.message) || r.status)); last.status = r.status;
    if (![429, 500, 502, 503, 504, 529].includes(r.status)) throw last;   // busy or overloaded: wait and try again
    await new Promise(res => setTimeout(res, 1500 * (k + 1)));
  }
  throw last;
}
async function askAgent(ticker, question, context, env, ctx) {
  const t = String(ticker || '').trim().toUpperCase(), qn = String(question || '').trim().slice(0, 600), pageData = String(context || '').slice(0, 45000);
  if (!qn) throw new Error('question is required');
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are LedgerLine's research analyst. Today is ${today}. Answer the user's question about stocks, funds and markets directly and completely, like a sharp buy-side analyst talking to an experienced investor.
Sources you have, in order of preference:
- [D] LedgerLine's own data for the stock open on the page (prices, returns, technicals, valuation, fair value, scores, verdict, earnings, metrics, statements), given below. Use it first for anything about price, valuation or numbers.
- stock_data tool: the same kind of numbers for any other ticker, cited [D:TICKER].
- filing_section tool: the full text of a 10-K or 10-Q section, cited by the [S#] label at the top of each result. Use legal for lawsuits and investigations, notes for debt and segments, mdna for results and outlook, risk for risk factors.
- web_search: current events the data and filings can't have: news, lawsuits and their status, regulatory action, analyst ratings and price targets, guidance, why the stock moved. Search whenever the question is about anything recent or outside the filings, and always for lawsuits, news or "why is it up/down".
- list_filings and read_filing: any other SEC filing (8-K earnings releases and events, DEF 14A proxy for pay and board, S-1, 13D/13G stakes, Form 4 insider trades, older annual reports). Find it with list_filings, open it with read_filing; cite [S#].
- web_fetch: open a full web page (a search result, an investor-relations page, a press release) when the search snippet isn't enough.
Work like a researcher: use as many lookups as the question needs, check numbers against a second source when it matters, and never give up with "the excerpts don't say" when another tool could find it. If a tool errors, try another route.
Rules: lead with the direct answer in the first sentence. Use real numbers. Cite every factual claim with [D], [D:TICKER] or [S#]; web facts are cited automatically. If sources conflict, say so and prefer the newest. If something can't be found, say exactly what you checked. No hype, no filler, no investment advice disclaimers. Format in Markdown: short paragraphs, **bold** key figures sparingly, "- " bullets for lists, at most about 300 words unless the question needs a table.`;
  const user = [ t ? `Stock open on the page: ${t}` : 'No stock is open on the page.', `Question: ${qn}`, pageData ? `[D] LedgerLine page data for ${t}, as shown on the site right now:\n${pageData}` : ''].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: user }], sources = [], web = [], data = new Set();
  let useFetch = true, webOn = true, finalBlocks = [], rounds = 0, done = false;
  const toolSet = () => [...ASK_TOOLS, ...(webOn ? [WEB_TOOL] : []), ...(webOn && useFetch ? [FETCH_TOOL] : [])];
  for (let turn = 0; turn < 14 && !done; turn++) {
    let r;
    try { r = await claudeMsg(env, { system, messages, tools: toolSet(), max_tokens: 3000 }, webOn && useFetch ? 'web-fetch-2025-09-10' : undefined); }
    catch (e) { if (useFetch && /fetch|beta/i.test(e.message) && e.status === 400) { useFetch = false; turn--; continue; } if (webOn && /web_search|tool|beta/i.test(e.message) && e.status === 400) { webOn = false; turn--; continue; } throw e; }
    messages.push({ role: 'assistant', content: r.content });
    if (r.stop_reason === 'pause_turn') { finalBlocks.push(...r.content); continue; }
    if (r.stop_reason === 'tool_use' && rounds < 10) {
      rounds++; finalBlocks = [];
      const results = [];
      for (const b of r.content.filter(b => b.type === 'tool_use')) {
        let text;
        try {
          if (b.name === 'stock_data') { const d = await stockData(b.input.ticker, env, ctx); data.add(d.ticker); text = `[D:${d.ticker}] ` + JSON.stringify(d); }
          else if (b.name === 'filing_section') {
            const form = b.input.form === '10-Q' ? '10-Q' : '10-K', section = b.input.section === 'business' && form === '10-Q' ? 'mdna' : b.input.section;
            const sec = await secSection({ ticker: b.input.ticker || t, form, section, maxChars: 30000, nth: b.input.nth });
            const id = 'S' + (sources.length + 1); sources.push({ id, ticker: sec.ticker, form: sec.form, section: sec.sectionName, filed: sec.filed, period: sec.periodOfReport, url: sec.url, text: sec.text.slice(0, 600) });
            text = `[${id}] ${sec.ticker} ${sec.form} filed ${sec.filed}, ${sec.sectionName}${sec.truncated ? ' (first 30,000 characters)' : ''}:\n${sec.text}`;
          } else if (b.name === 'list_filings') { text = JSON.stringify(await listFilings(b.input.ticker || t, b.input.form)); }
          else if (b.name === 'read_filing') {
            const d = await readFiling(b.input.url, b.input.offset); const id = 'S' + (sources.length + 1);
            sources.push({ id, ticker: t, form: 'Filing', section: (d.url.split('/').pop() || '').slice(0, 60), filed: '', url: d.url, text: d.text.slice(0, 600) });
            text = `[${id}] ${d.url} (characters ${d.from}–${d.from + d.text.length} of ${d.chars}${d.from + d.text.length < d.chars ? '; call again with offset to read more' : ''}):\n${d.text}`;
          } else text = 'Unknown tool';
        } catch (e) { text = 'Error: ' + String(e.message || e); }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: text.slice(0, 60000) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (r.stop_reason === 'tool_use') {   // out of tool rounds: answer with what it has
      messages.push({ role: 'user', content: r.content.filter(b => b.type === 'tool_use').map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Tool limit reached. Answer now with what you have.' })) });
      const f = await claudeMsg(env, { system, messages, tools: toolSet(), tool_choice: { type: 'none' }, max_tokens: 3000 }, webOn && useFetch ? 'web-fetch-2025-09-10' : undefined);
      finalBlocks = f.content; done = true; break;
    }
    finalBlocks.push(...r.content); done = true;
  }
  // build the answer: text blocks in order, web citations turned into [W#] markers
  let answer = '';
  for (const b of finalBlocks) {
    if (b.type !== 'text') continue;
    answer += b.text;
    const marks = [];
    for (const c of b.citations || []) { if (!c.url) continue; let w = web.find(x => x.url === c.url); if (!w) { w = { id: 'W' + (web.length + 1), url: c.url, title: c.title || c.url }; web.push(w); } if (!marks.includes(w.id)) marks.push(w.id); }
    if (marks.length) answer += ' ' + marks.map(m => `[${m}]`).join('');
  }
  answer = answer.replace(/[ \t]+\n/g, '\n').trim() || 'I couldn’t put an answer together for that. Try asking it a different way.';
  const usedS = new Set((answer.match(/\[S\d+\]/g) || []).map(x => x.slice(1, -1)));
  return { ticker: t, question: qn, answer, model: env.AI_MODEL || AI_MODEL, web: webOn, sources: sources.filter(x => usedS.has(x.id)), webSources: web, looked: [...data] };
}
// plain-English screen: the model turns a request into filters over the columns the app sends
async function aiScreen(query, fields, env) {
  const qn = String(query || '').trim().slice(0, 300); if (!qn) throw new Error('query is required');
  const f = (Array.isArray(fields) ? fields : []).slice(0, 40).map(x => ({ key: String(x.key).slice(0, 30), label: String(x.label).slice(0, 60), unit: String(x.unit || '').slice(0, 10) }));
  const system = 'Turn a stock-screen request into JSON filters over the given fields. Reply with JSON only: {"filters":[{"key":..., "op":">"|">="|"<"|"<="|"between", "value":number, "value2":number?}], "sort":{"key":...,"dir":"desc"|"asc"}, "explain":"one short sentence"}. Percent fields are in percent units (20 means 20%). Use only the listed keys. If something cannot be expressed, leave it out and mention it in explain.';
  const txt = await claude(env, system, 'Fields: ' + JSON.stringify(f) + '\nRequest: ' + qn, 400);
  const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error('Could not read the screen');
  const j = JSON.parse(m[0]), keys = new Set(f.map(x => x.key));
  j.filters = (j.filters || []).filter(x => keys.has(x.key) && ['>', '>=', '<', '<=', 'between'].includes(x.op) && isFinite(x.value));
  if (j.sort && !keys.has(j.sort.key)) delete j.sort;
  return j;
}

/* ================= insiders: Form 4 filings for the company, last 12 months ================= */
const F4_CODES = { P: 'Buy (open market)', S: 'Sale (open market)', A: 'Award', M: 'Option exercise', F: 'Tax withholding', G: 'Gift', C: 'Conversion', D: 'Disposed to company', X: 'Option exercise', J: 'Other' };
function xmlVal(x, tag) { const m = x.match(new RegExp('<' + tag + '>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>)?\\s*</' + tag + '>')); return m ? m[1].replace(/&amp;/g, '&').trim() : null; }
function parseForm4(x, meta) {
  const owner = xmlVal(x, 'rptOwnerName') || '', title = xmlVal(x, 'officerTitle') || '', dir = /<isDirector>\s*(1|true)/i.test(x), ten = /<isTenPercentOwner>\s*(1|true)/i.test(x), off = /<isOfficer>\s*(1|true)/i.test(x);
  const role = [off && title ? title : off ? 'Officer' : '', dir ? 'Director' : '', ten ? '10% owner' : ''].filter(Boolean).join(', ') || 'Insider';
  const out = [];
  for (const m of x.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const t = m[1], code = (t.match(/<transactionCode>\s*([A-Z])\s*</) || [])[1] || '?', sh = Number(xmlVal(t, 'transactionShares')), px = Number(xmlVal(t, 'transactionPricePerShare')), ad = xmlVal(t, 'transactionAcquiredDisposedCode'), after = Number(xmlVal(t, 'sharesOwnedFollowingTransaction'));
    out.push({ date: xmlVal(t, 'transactionDate') || meta.filed, filed: meta.filed, owner, role, code, type: F4_CODES[code] || code, shares: isFinite(sh) ? sh : null, price: isFinite(px) && px > 0 ? px : null, value: isFinite(sh) && isFinite(px) ? sh * px : null, acquired: ad === 'A', after: isFinite(after) ? after : null, plan: /10b5-1/i.test(x), url: meta.url });
  }
  return out;
}
async function insiders(ticker) {
  const co = await cikFor(ticker), sr = await secGet(`https://data.sec.gov/submissions/CIK${co.cik}.json`, 3600); if (!sr) throw new Error('No SEC filings for ' + ticker);
  const rec = (await sr.json()).filings?.recent || {}, since = new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10), list = [];
  for (let i = 0; i < (rec.form || []).length && list.length < 60; i++) if (rec.form[i] === '4' && rec.filingDate[i] >= since) list.push(i);
  const tx = [];
  for (let k = 0; k < list.length; k += 6) {   // six at a time keeps well under SEC's 10 requests a second
    const got = await Promise.all(list.slice(k, k + 6).map(async i => { const acc = rec.accessionNumber[i].replace(/-/g, ''), doc = String(rec.primaryDocument[i]).replace(/^xsl[^/]*\//, ''), url = `https://www.sec.gov/Archives/edgar/data/${co.cikInt}/${acc}/${doc}`;
      try { const r = await secGet(url, 604800); return r ? parseForm4(await r.text(), { filed: rec.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${co.cikInt}/${acc}/` }) : []; } catch (e) { return []; } }));
    got.forEach(a => tx.push(...a));
  }
  tx.sort((a, b) => (a.date < b.date ? 1 : -1));
  const sum = days => { const c = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), w = tx.filter(t => t.date >= c);
    const buys = w.filter(t => t.code === 'P'), sells = w.filter(t => t.code === 'S'), v = a => a.reduce((x, t) => x + (t.value || 0), 0);
    return { buys: buys.length, buyValue: v(buys), buyers: new Set(buys.map(t => t.owner)).size, sells: sells.length, sellValue: v(sells), sellers: new Set(sells.map(t => t.owner)).size, net: v(buys) - v(sells) }; };
  return { ticker: String(ticker).toUpperCase(), name: co.name, filings: list.length, summary: { m3: sum(91), m6: sum(182), y1: sum(366) }, transactions: tx.slice(0, 80) };
}

/* ================= what changed: the latest 10-Q or 10-K against the one before it ================= */
// paragraphs, normalised so that changed numbers alone don't count as new text
function paras(text) {
  return String(text || '').split(/\n\s*\n|\n(?=[A-Z•●·\-–])/).map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length >= 120 && !/^(table of contents|item \d)/i.test(p));
}
const normP = p => p.toLowerCase().replace(/[\d,.$%()]+/g, '#').replace(/[^a-z# ]+/g, ' ').replace(/\s+/g, ' ').trim();
function shingles(p) { const w = normP(p).split(' '), out = new Set(); for (let i = 0; i + 4 < w.length; i++) out.add(w.slice(i, i + 5).join(' ')); if (!out.size && w.length) out.add(w.join(' ')); return out; }
// for each paragraph in A, its best overlap with any paragraph in B (shared 5-word phrases), via an index rather than all pairs
function bestOverlap(A, B) {
  const idx = new Map(); B.forEach((p, j) => { for (const sh of p.sh) { let a = idx.get(sh); if (!a) idx.set(sh, a = []); if (a[a.length - 1] !== j) a.push(j); } });
  return A.map(p => { const hit = new Map(); for (const sh of p.sh) for (const j of idx.get(sh) || []) hit.set(j, (hit.get(j) || 0) + 1);
    let best = 0, bj = -1; for (const [j, n] of hit) { const sc = n / Math.max(p.sh.size, B[j].sh.size); if (sc > best) { best = sc; bj = j; } } return { best, bj }; });
}
function diffSections(newText, oldText) {
  const A = paras(newText).map(t => ({ t, sh: shingles(t) })), B = paras(oldText).map(t => ({ t, sh: shingles(t) }));
  if (!A.length || !B.length) return null;
  const fa = bestOverlap(A, B), fb = bestOverlap(B, A), clip = t => t.length > 700 ? t.slice(0, 700).replace(/\s+\S*$/, '') + ' …' : t;
  const added = [], changed = [], removed = [];
  A.forEach((p, i) => { const b = fa[i].best; if (b < 0.25) added.push({ text: clip(p.t), len: p.t.length }); else if (b < 0.8 && normP(p.t) !== normP(B[fa[i].bj].t)) changed.push({ text: clip(p.t), was: clip(B[fa[i].bj].t), sim: Math.round(b * 100), len: p.t.length }); });
  B.forEach((p, j) => { if (fb[j].best < 0.25) removed.push({ text: clip(p.t), len: p.t.length }); });
  const top = (a, n) => a.sort((x, y) => y.len - x.len).slice(0, n).map(({ len, ...o }) => o);
  return { paragraphs: { now: A.length, before: B.length }, added: top(added, 8), changed: top(changed, 6), removed: top(removed, 6), counts: { added: added.length, changed: changed.length, removed: removed.length } };
}
async function filingChanges(ticker) {
  const t = String(ticker || '').trim(); if (!t) throw new Error('ticker is required');
  const pick = async form => { try { return await secSection({ ticker: t, form, section: 'mdna', maxChars: 200000 }); } catch (e) { return null; } };
  const [q, k] = await Promise.all([pick('10-Q'), pick('10-K')]);
  const latest = !q ? k : !k ? q : (q.filed > k.filed ? q : k); if (!latest) throw new Error('No recent 10-Q or 10-K for ' + t);
  const form = latest.form, out = { ticker: t.toUpperCase(), name: latest.name, form, filed: latest.filed, period: latest.periodOfReport, url: latest.url, sections: {} };
  for (const sec of ['mdna', 'risk']) {
    const now = sec === 'mdna' ? latest : await secSection({ ticker: t, form, section: sec, maxChars: 200000 }).catch(() => null);
    const before = await secSection({ ticker: t, form, section: sec, nth: 1, maxChars: 200000 }).catch(() => null);
    if (!out.prior && before) out.prior = { filed: before.filed, period: before.periodOfReport, url: before.url };
    if (!now) { out.sections[sec] = { missing: true }; continue; }
    if (sec === 'risk' && form === '10-Q' && now.text.length < 2500) { out.sections[sec] = { note: now.text.replace(/\s+/g, ' ').slice(0, 600) }; continue; }   // most 10-Qs just say "no material changes"
    if (!before) { out.sections[sec] = { missing: true }; continue; }
    out.sections[sec] = diffSections(now.text, before.text) || { missing: true };
  }
  return out;
}

/* ================= 3. JSON API for the LedgerLine site ================= */
async function api(req, url, env, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const q = url.searchParams, path = url.pathname.replace(/\/+$/, '');
  const out = (o, status = 200, maxAge = 300) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge, 'X-Worker-Version': WORKER_VERSION } });
  try {
    if (path === '/api/search') return out(await searchTickers(q.get('q') || ''), 200, 86400);
    if (path === '/api/profile') return out(await profile(q.get('ticker') || ''), 200, 3600);
    if (path === '/api/statements') return out(await secStatements({ ticker: q.get('ticker'), years: q.get('years') }), 200, 3600);
    if (path === '/api/ask' || path === '/api/screen') {
      if (!env.ANTHROPIC_API_KEY) return out({ error: 'AI is not switched on yet', needsKey: true }, 503, 0);
      if (!(await aiQuota(env, req))) return out({ error: 'Daily question limit reached; try again tomorrow' }, 429, 0);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      if (path === '/api/ask') return out(await askAgent(body.ticker || q.get('ticker'), body.question || q.get('q'), body.context, env, ctx), 200, 0);
      return out(await aiScreen(body.query || q.get('q'), body.fields, env), 200, 0);
    }
    if (path === '/api/insiders') return out(await insiders(q.get('ticker') || ''), 200, 21600);
    if (path === '/api/changes') { const ck = new Request('https://ledgerline-cache.internal/changes/v1/' + encodeURIComponent((q.get('ticker') || '').toUpperCase()) + '/' + new Date().toISOString().slice(0, 10)); const cache = typeof caches !== 'undefined' ? caches.default : null; const hit = cache && await cache.match(ck); if (hit) return out(await hit.json(), 200, 3600); const res = await filingChanges(q.get('ticker')); if (cache) ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(res), { headers: { 'Cache-Control': 'public, max-age=86400' } }))); return out(res, 200, 3600); }
    if (path === '/api/section') return out(await secSection({ ticker: q.get('ticker'), section: q.get('section'), form: q.get('form'), maxChars: q.get('maxChars') }), 200, 3600);
    if (path === '/api/market') { rankNudge(env, ctx); return out(await market(q.get('symbol') || '', env, ctx), 200, 900); }
    if (path === '/api/ranks') { rankNudge(env, ctx); return out(await sectorRank(q.get('ticker') || '', env), 200, 600); }
    if (path === '/api/levboard') return out(await levBoard(env, ctx), 200, 900);
    if (path === '/api/levraw') { try { const sym = String(q.get('symbol') || '').toUpperCase(), from = q.get('from') || '2016-01-01', to = q.get('to') || '2021-01-01';
      const u = `https://api.marketstack.com/v2/eod?access_key=${encodeURIComponent(env.MARKETSTACK_KEY)}&symbols=${encodeURIComponent(sym)}&date_from=${from}&date_to=${to}&limit=1000&sort=ASC`;
      const r = await msFetch(u, { headers: { Accept: 'application/json' } }, 'eod'), j = await r.json(); const d = j.data || [], jumps = [];
      for (let i = 1; i < d.length; i++) { const k = d[i].close / d[i - 1].close; if (k > 1.5 || k < 0.67) jumps.push([String(d[i].date).slice(0, 10), Math.round(k * 1000) / 1000, d[i].split_factor, d[i].exchange]); }
      return out({ total: j.pagination && j.pagination.total, n: d.length, first: d[0] && [String(d[0].date).slice(0, 10), d[0].close, d[0].exchange], last: d.length ? [String(d[d.length - 1].date).slice(0, 10), d[d.length - 1].close] : null, jumps, err: j.error || null }, 200, 0); } catch (e) { return out({ error: String(e.message || e) }, 200, 0); } }
    if (path === '/api/levraw') { try { const sym = String(q.get('symbol') || '').toUpperCase(), from = q.get('from') || '2016-01-01', to = q.get('to') || '2021-01-01';
      const u = `https://api.marketstack.com/v2/eod?access_key=${encodeURIComponent(env.MARKETSTACK_KEY)}&symbols=${encodeURIComponent(sym)}&date_from=${from}&date_to=${to}&limit=1000&sort=ASC`;
      const r = await msFetch(u, { headers: { Accept: 'application/json' } }, 'eod'), j = await r.json(); const d = j.data || [], jumps = [];
      for (let i = 1; i < d.length; i++) { const k = d[i].close / d[i - 1].close; if (k > 1.5 || k < 0.67) jumps.push([String(d[i].date).slice(0, 10), Math.round(k * 1000) / 1000, d[i].split_factor]); }
      return out({ total: j.pagination && j.pagination.total, n: d.length, first: d[0] ? [String(d[0].date).slice(0, 10), d[0].close] : null, last: d.length ? [String(d[d.length - 1].date).slice(0, 10), d[d.length - 1].close] : null, jumps, err: j.error || null }, 200, 0); } catch (e) { return out({ error: String(e.message || e) }, 200, 0); } }
    if (path === '/api/levedge') { try { return out(await levEdge(q.get('fund') || '', env, ctx), 200, 3600); } catch (e) { return out({ error: String(e.message || e) }, 200, 0); } }
    if (path === '/api/levlong') { try { const d = await lvLong(String(q.get('symbol') || '').toUpperCase(), env, ctx), iso = x => new Date(x * 1000).toISOString().slice(0, 10), j = []; for (let i = 1; i < d.c.length; i++) { const r = d.c[i] / d.c[i - 1]; if (r > 1.35 || r < 0.65) j.push([iso(d.t[i]), Math.round(r * 1000) / 1000]); } return out({ n: d.c.length, spliced: d.spliced || 0, spliceErr: d.spliceErr || null, first: d.t.length ? iso(d.t[0]) : null, last: d.t.length ? iso(d.t[d.t.length - 1]) : null, jumps: j }, 200, 600); } catch (e) { return out({ error: String(e.message || e) }, 200, 0); } }
    if (path === '/api/levregime') { try { return out(await levRegime(q.get('fund') || '', env, ctx), 200, 3600); } catch (e) { return out({ error: String(e.message || e) }, 200, 0); } }
    if (path === '/api/iv') return out(await impliedVol(q.get('symbol') || q.get('ticker') || ''), 200, 600);
    if (path === '/api/etf-holdings') return out(await etfHoldings(q.get('symbol') || q.get('ticker') || '', env), 200, 3600);
    if (path === '/api/usage') return out(await usageData(), 200, 0);
    if (path === '/api/hit' && req.method === 'POST') return out(await recordVisit(req, env), 200, 0);
    if (path === '/api/activity') return (await keyOk(q.get('key'), env)) ? out(await activityData(), 200, 0) : out({ error: 'Private: add ?key= with your USAGE_KEY' }, 403, 0);
    if (path === '/api/quote-check') { const sym = String(q.get('symbol') || 'AAPL').toUpperCase(); if (!env.MARKETSTACK_KEY) return out({ error: 'no key' }, 200, 0); const r = await msFetch(`https://api.marketstack.com/v2/intraday/latest?access_key=${encodeURIComponent(env.MARKETSTACK_KEY)}&symbols=${encodeURIComponent(sym)}&interval=15min`, undefined, 'check'); const j = await r.json().catch(() => ({})); return out({ status: r.status, error: j.error ? { code: j.error.code, message: j.error.message } : null, row: (j.data || [])[0] || null }, 200, 0); }
    return out({ error: 'Unknown endpoint' }, 404);
  } catch (e) {
    return out({ error: String(e && e.message || e) }, 502, 0);
  }
}

async function searchTickers(qs) {
  const query = qs.trim().toUpperCase();
  if (!query) return { results: [] };
  const r = await secGet('https://www.sec.gov/files/company_tickers.json', 86400);
  const txt = await r.text();
  const re = /\{"cik_str":(\d+),"ticker":"([^"]+)","title":"([^"]+)"\}/g;
  const exact = [], starts = [], name = [];
  let m;
  while ((m = re.exec(txt))) {
    const t = m[2], title = m[3];
    if (t === query || t === query.replace('.', '-')) exact.push({ ticker: t, name: title });
    else if (t.startsWith(query) && starts.length < 8) starts.push({ ticker: t, name: title });
    else if (query.length > 2 && title.toUpperCase().includes(query) && name.length < 8) name.push({ ticker: t, name: title });
  }
  return { results: [...exact, ...starts, ...name].slice(0, 8) };
}

async function profile(ticker) {
  const co = await cikFor(ticker);
  const r = await secGet(`https://data.sec.gov/submissions/CIK${co.cik}.json`, 3600);
  const j = await r.json();
  let earnings = [];
  try { earnings = await earningsDates(co, j); } catch (e) { }
  return { ticker: String(ticker).toUpperCase(), cik: co.cik, name: j.name || co.name, sic: j.sic, sector: j.sicDescription || '', exchanges: j.exchanges || [], fiscalYearEnd: j.fiscalYearEnd || '', state: j.stateOfIncorporation || '', category: j.category || '', earnings };
}

// Earnings releases: 8-Ks carrying Item 2.02 (Results of Operations), with the SEC acceptance time in New York time
async function earningsDates(co, j) {
  const out = [], cut = new Date(Date.now() - 6 * 365.25 * 86400e3).toISOString().slice(0, 10);
  const take = rec => {
    const n = (rec.form || []).length;
    for (let i = 0; i < n; i++) {
      if (!/^8-K/.test(rec.form[i]) || !/(^|,)\s*2\.02/.test(rec.items?.[i] || '')) continue;
      const acc = rec.acceptanceDateTime?.[i] || '', ms = Date.parse(acc);
      let d = rec.filingDate[i], tm = '';
      if (isFinite(ms)) { const et = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); d = et.getFullYear() + '-' + String(et.getMonth() + 1).padStart(2, '0') + '-' + String(et.getDate()).padStart(2, '0'); tm = String(et.getHours()).padStart(2, '0') + ':' + String(et.getMinutes()).padStart(2, '0'); }
      out.push({ d, tm, accn: rec.accessionNumber[i], doc: rec.primaryDocument?.[i] || '' });
    }
  };
  const rec = j.filings?.recent || {};
  take(rec);
  const dates = rec.filingDate || [], oldest = dates.length ? dates[dates.length - 1] : '';
  if (oldest > cut) for (const f of (j.filings?.files || []).slice(0, 2)) {
    const r = await secGet('https://data.sec.gov/submissions/' + f.name, 86400); if (!r) break;
    const older = await r.json(); take(older);
    const od = older.filingDate || []; if (!od.length || od[od.length - 1] <= cut) break;
  }
  return out.filter(e => e.d >= cut).sort((a, b) => (a.d < b.d ? 1 : -1)).map(e => ({ ...e, url: `https://www.sec.gov/Archives/edgar/data/${co.cikInt}/${e.accn.replace(/-/g, '')}/${e.doc}` }));
}

const YH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept': 'application/json' };
// Prices: Marketstack (licensed, commercial use) when MARKETSTACK_KEY is set; Yahoo/Stooq only as an unlicensed test fallback.
// One upstream pull per symbol per day, then everyone is served from Cloudflare's cache.
async function market(symbol, env = {}, ctx) {
  const sym = String(symbol).trim().toUpperCase().replace('.', '-');
  if (!/^[A-Z0-9^\-=]{1,12}$/.test(sym)) throw new Error('Bad symbol');
  const day = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
  const key = new Request(`https://ledgerline-cache.internal/market/ms6/${sym}/${day}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  let data = null;
  if (cache) { const hit = await cache.match(key); if (hit) data = await hit.json(); }
  if (data && env.MARKETSTACK_KEY && cache) {   // after the close, square every symbol up to the latest session: re-pull end-of-day prices at most once an hour until it posts
    const exp = expectedSession(), last = new Date(data.asOf * 1000).toISOString().slice(0, 10);
    if (exp && last < exp) {
      const hk = new Request(`https://ledgerline-cache.internal/market-retry/${sym}/${exp}/${Math.floor(Date.now() / 3600e3)}`);
      if (!(await cache.match(hk))) {
        await cache.put(hk, new Response('1', { headers: { 'Cache-Control': 'public, max-age=3600' } }));
        try { const fresh = await marketstack(sym, env.MARKETSTACK_KEY); if (fresh && fresh.asOf > data.asOf) { data = fresh; const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; } } catch (e) { }
      }
    }
  }
  if (data) { if (env.MARKETSTACK_KEY) { try { const q = await liveQuote(sym, env.MARKETSTACK_KEY, cache, ctx, data.asOf); if (q) return applyQuote(data, q); } catch (e) { } } return data; }
  if (env.MARKETSTACK_KEY) data = await marketstack(sym, env.MARKETSTACK_KEY);
  else throw new Error('Price feed not configured: add MARKETSTACK_KEY to the worker.');
  if (cache) { const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  if (env.MARKETSTACK_KEY) { try { const q = await liveQuote(sym, env.MARKETSTACK_KEY, cache, ctx, data.asOf); if (q) return applyQuote(data, q); } catch (e) { /* keep end-of-day */ } }
  return data;
}


// New York time without Intl time zones: UTC−4 from the second Sunday of March to the first Sunday of November, else UTC−5
function nyNow(ms = Date.now()) {
  const y = new Date(ms).getUTCFullYear(), sun = (m, nth) => { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return Date.UTC(y, m, first + 7 * (nth - 1)); };
  const dstStart = sun(2, 2) + 7 * 3600e3, dstEnd = sun(10, 1) + 6 * 3600e3, off = ms >= dstStart && ms < dstEnd ? 4 : 5;
  return new Date(ms - off * 3600e3);   // read with getUTC* fields
}
// the last session whose official close should be out by now (after 6 PM New York time today, else the previous weekday)
function expectedSession() {
  const ny = nyNow(); let d = new Date(Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate()));
  if (ny.getUTCHours() < 18) d = new Date(d.getTime() - 86400e3);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - 86400e3);
  return d.toISOString().slice(0, 10);
}
// 15-minute delayed quote (IEX via Marketstack intraday), cached 15 minutes per symbol
async function liveQuote(sym, apiKey, cache, ctx, eodAsOf) {
  const now = new Date(), et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes(), dow = et.getDay();
  const open = !(dow === 0 || dow === 6 || mins < 9 * 60 + 30 || mins > 16 * 60 + 30);
  // closed: keep showing the last 15-minute price until the feed posts that day's official close (usually that evening)
  const eodDay = eodAsOf ? new Date(eodAsOf * 1000).toISOString().slice(0, 10) : '';
  if (await monthUsed() >= MS_LIMIT * 0.95) return null;   // save what's left of the month for price history
  const slot = Math.floor(now.getTime() / ((open ? 15 : 120) * 60e3));
  const key = new Request(`https://ledgerline-cache.internal/quote/${sym}/${slot}`);
  if (cache) { const hit = await cache.match(key); if (hit) return await hit.json(); }
  const variants = [...new Set([sym, sym.replace('-', '.')])];
  let row = null;
  for (const v of variants) {
    const r = await msFetch(`https://api.marketstack.com/v2/intraday/latest?access_key=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(v)}&interval=15min`, { headers: { Accept: 'application/json' } }, 'intraday');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) continue;
    const x = (j.data || [])[0], tx = x ? Date.parse(x.date) : NaN, px = x ? Number(x.last ?? x.marketstack_last ?? x.mid) : NaN;
    const fresh = open ? Date.now() - tx < 3 * 3600e3 : new Date(tx - 4 * 3600e3).toISOString().slice(0, 10) > eodDay;
    if (x && isFinite(tx) && fresh && isFinite(px) && px > 0) { row = x; break; }   // IEX answers BRK.B with yesterday's bar and only BRK-B with today's: keep trying spellings
  }
  if (!row) return null;
  const price = Number(row.last ?? row.marketstack_last ?? row.mid ?? row.close), t = Date.parse(row.date);   // intraday 'close' is the prior close
  if (!isFinite(price) || price <= 0 || !isFinite(t)) return null;
  const q = { price, t: Math.floor(t / 1000), high: Number(row.high) || null, low: Number(row.low) || null, volume: Number(row.volume) || null };
  if (cache) { const put = cache.put(key, new Response(JSON.stringify(q), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  return q;
}
function applyQuote(d, q) {
  const out = { ...d }, lastEod = d.weekly && d.daily ? d.daily.c[d.daily.c.length - 1] : d.price;
  const sameDay = d.asOf && new Date(d.asOf * 1000).toISOString().slice(0, 10) === new Date(q.t * 1000).toISOString().slice(0, 10);
  const prev = sameDay ? d.prevClose : lastEod;
  out.price = q.price; out.prevClose = prev; out.change = q.price - prev; out.changePct = (q.price / prev - 1) * 100;
  out.quoteTime = q.t; out.source = 'IEX via Marketstack, 15-min delayed'; out.delayed = true;
  if (q.high && q.high > out.high52) out.high52 = q.high;
  if (q.low && q.low < out.low52) out.low52 = q.low;
  return out;
}

// last ~5 years of daily bars, rounded to keep the payload small
function dailyOf(bars) {
  const r = x => Math.round(x * 1e4) / 1e4, d = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const b of bars) { d.t.push(Date.parse(b.date) / 1000); d.o.push(r(b.o)); d.h.push(r(b.h)); d.l.push(r(b.l)); d.c.push(r(b.c)); d.v.push(Math.round(b.v)); }
  return d;
}
async function marketstack(sym, apiKey, keepDaily = 1320) {
  const from = new Date(Date.now() - 10.2 * 365.25 * 86400e3).toISOString().slice(0, 10);
  const pull = async ticker => {
    const rows = [];
    for (let offset = 0; offset < 4000; offset += 1000) {
      const u = `https://api.marketstack.com/v2/eod?access_key=${encodeURIComponent(apiKey)}&symbols=${encodeURIComponent(ticker)}&date_from=${from}&limit=1000&offset=${offset}&sort=ASC`;
      let r, j;
      for (let tries = 0; tries < 5; tries++) {   // Marketstack limits requests per second: back off and retry
        r = await msFetch(u, { headers: { Accept: 'application/json' } }, 'eod');
        j = await r.json().catch(() => ({}));
        const limited = r.status === 429 || /rate|limit/i.test(String(j.error && (j.error.code || j.error.message) || ''));
        if (!limited) break;
        await new Promise(res => setTimeout(res, 800 * (tries + 1) + Math.random() * 400));
      }
      if (!r.ok || j.error) throw new Error('Marketstack: ' + ((j.error && (j.error.message || j.error.code)) || r.status));
      rows.push(...(j.data || []));
      const p = j.pagination || {};
      if (!p.total || rows.length >= p.total || !(j.data || []).length) break;
    }
    return rows;
  };
  // class shares are spelled differently by different feeds (BRK-B, BRK.B, BRKB)
  const variants = [...new Set([sym.replace('-', '.'), sym, sym.replace('-', ''), sym.replace('-', '/')])];
  let rows = [];
  for (const v of variants) { rows = await pull(v); if (rows.length) break; }
  if (!rows.length) throw new Error('Marketstack has no prices for ' + sym);
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Raw prices, split-adjusted here (not dividend-adjusted) so they line up with per-share numbers from the filings.
  const n = rows.length, f = Array(n).fill(1);
  const CLEAN = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50];
  let cum = 1;
  for (let i = n - 1; i >= 1; i--) {
    f[i] = cum;
    const sf = Number(rows[i].split_factor);
    const r = rows[i - 1].close / rows[i].close, gap = rows[i - 1].close / (rows[i].open || rows[i].close);
    let k = 0;
    // adjust only where the prices actually jump by the split ratio; the feed is sometimes already adjusted
    if (sf && sf !== 1 && isFinite(sf)) {   // feeds write the ratio either way round (2 or 0.5 for a 2-for-1)
      for (const c of [sf, 1 / sf]) if (Math.abs(r / c - 1) < 0.25 || Math.abs(gap / c - 1) < 0.25) { k = c; break; }
    }
    if (!k) { const kk = CLEAN.find(c => Math.abs(r / c - 1) < 0.06 && Math.abs(gap / c - 1) < 0.08); if (kk) k = kk; }
    if (k) cum *= k;
  }
  f[0] = cum;
  const bars = rows.map((r, i) => {
    const c = r.close / f[i], o = (r.open ?? r.close) / f[i];
    let h = (r.high ?? r.close) / f[i], l = (r.low ?? r.close) / f[i];
    const ref = Math.max(o, c), refLo = Math.min(o, c);
    if (h > ref * 1.25) h = ref;           // bad prints
    if (l < refLo * 0.75) l = refLo;
    return { date: r.date, o, h, l, c, v: (r.volume || 0) * f[i] };
  }).filter(b => isFinite(b.c) && b.c > 0);
  // single-day bad prints: a close 2.5x away from both neighbours is dropped
  for (let i = bars.length - 2; i >= 1; i--) { const a = bars[i].c / bars[i - 1].c, b2 = bars[i].c / bars[i + 1].c; if ((a > 2.5 && b2 > 2.5) || (a < 0.4 && b2 < 0.4)) bars.splice(i, 1); }
  // a 2.5x+ jump at a clean split ratio means the feed adjusted only part of the history: rescale the older part.
  // any other 2.5x+ jump means the ticker belonged to a different security before it: keep only the recent history.
  for (let i = bars.length - 1; i >= 1; i--) {
    const j = bars[i].c / bars[i - 1].c, jj = j > 1 ? j : 1 / j;
    if (jj < 1.85) continue;
    const up = j > 1, k = CLEAN.find(c => Math.abs(jj / c - 1) < (jj > 5 ? 0.15 : jj > 2.5 ? 0.08 : 0.04));   // a 5x+ one-day move near a split ratio is a split, even on a volatile stock   // a 2-for-1 the feed missed shows as an exact doubling
    if (!k && jj <= 2.5) continue;
    if (k) { const m = up ? k : 1 / k; for (let x = 0; x < i; x++) { const b = bars[x]; b.o *= m; b.h *= m; b.l *= m; b.c *= m; b.v /= m; } cum *= m; continue; }
    bars.splice(0, i); break;
  }
  // daily -> weekly bars (weeks start Monday)
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let wk = null;
  for (const b of bars) {
    const d = new Date(b.date), dow = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) / 1000;
    if (wk !== monday) { wk = monday; t.push(monday); o.push(b.o); h.push(b.h); l.push(b.l); c.push(b.c); v.push(b.v); }
    else { const i = t.length - 1; h[i] = Math.max(h[i], b.h); l[i] = Math.min(l[i], b.l); c[i] = b.c; v[i] += b.v; }
  }
  const last = bars[bars.length - 1], prev = bars[bars.length - 2] || last, yr = bars.slice(-252);
  return {
    symbol: sym, name: sym, currency: 'USD', exchange: rows[n - 1].exchange || '', price: last.c, prevClose: prev.c, change: last.c - prev.c, changePct: (last.c / prev.c - 1) * 100,
    high52: Math.max(...yr.map(b => b.h)), low52: Math.min(...yr.map(b => b.l)),
    asOf: Date.parse(last.date) / 1000, weekly: { t, o, h, l, c, v }, daily: dailyOf(bars.slice(-keepDaily)), source: 'Marketstack (end of day)', splitsAdjusted: cum
  };
}

/* ================= 4. Subscriptions: Stripe checkout + webhook -> Cloudflare Access group ================= */
// Secrets (Cloudflare → sec-proxy → Settings → Variables and Secrets):
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, CF_API_TOKEN (Access: Organizations, Identity Providers, and Groups — Edit), MARKETSTACK_KEY
// Plain variables: STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL, SITE_URL, CF_ACCOUNT_ID, ACCESS_GROUP_ID, STRIPE_PORTAL_URL
const TRIAL_DAYS = 21;

async function billing(req, url, env) {
  const path = url.pathname.replace(/\/+$/, '');
  const site = (env.SITE_URL || 'https://ledgerline-dv0.pages.dev').replace(/\/+$/, '');
  try {
    if (path === '/billing/health') {
      const has = k => !!env[k];
      return json({ ok: true, trialDays: TRIAL_DAYS, configured: Object.fromEntries(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL', 'SITE_URL', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'ACCESS_GROUP_ID', 'STRIPE_PORTAL_URL', 'MARKETSTACK_KEY'].map(k => [k, has(k)])) });
    }
    if (path === '/billing/checkout') {
      const plan = url.searchParams.get('plan') === 'annual' ? 'annual' : 'monthly';
      const price = plan === 'annual' ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
      if (!env.STRIPE_SECRET_KEY || !price) return new Response('Subscriptions are not open yet.', { status: 503 });
      const form = new URLSearchParams({
        mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
        'subscription_data[trial_period_days]': String(TRIAL_DAYS), payment_method_collection: 'always',
        allow_promotion_codes: 'true', billing_address_collection: 'auto',
        success_url: site + '/welcome.html?session_id={CHECKOUT_SESSION_ID}', cancel_url: site + '/#pricing'
      });
      const email = url.searchParams.get('email'); if (email) form.set('customer_email', email);
      const s = await stripe(env, 'POST', '/v1/checkout/sessions', form);
      return Response.redirect(s.url, 303);
    }
    if (path === '/billing/portal') {
      if (!env.STRIPE_PORTAL_URL) return new Response('Billing portal not set up yet.', { status: 503 });
      return Response.redirect(env.STRIPE_PORTAL_URL, 302);
    }
    if (path === '/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, env);
    return new Response('Not found', { status: 404 });
  } catch (e) {
    return new Response('Billing error: ' + String(e && e.message || e), { status: 500 });
  }
}

async function stripe(env, method, path, form) {
  const r = await fetch('https://api.stripe.com' + path, { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? form.toString() : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + (j.error && j.error.message || r.status));
  return j;
}

async function verifyStripe(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
  const t = parts.t; if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && [...s].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

const ACTIVE = new Set(['trialing', 'active', 'past_due']);
async function stripeWebhook(req, env) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return new Response('Bad signature', { status: 400 });
  const ev = JSON.parse(raw), obj = ev.data && ev.data.object || {};
  let email = null, allow = null;
  if (ev.type === 'checkout.session.completed') { email = obj.customer_details && obj.customer_details.email || obj.customer_email; allow = true; }
  else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(ev.type)) {
    allow = ev.type !== 'customer.subscription.deleted' && ACTIVE.has(obj.status);
    if (obj.customer) { const cu = await stripe(env, 'GET', '/v1/customers/' + obj.customer); email = cu.email; }
  } else return json({ received: true, ignored: ev.type });
  if (!email) return json({ received: true, note: 'no email' });
  const changed = await setAccess(env, email, allow);
  return json({ received: true, email, allow, changed });
}

// Adds or removes one email in the Cloudflare Access group that guards the app.
async function setAccess(env, email, allow) {
  const e = String(email).trim().toLowerCase();
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const H = { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' };
  const g = await (await fetch(base, { headers: H })).json();
  if (!g.success) throw new Error('Access group read failed: ' + JSON.stringify(g.errors || []));
  const grp = g.result;
  const include = (grp.include || []).filter(r => !(r.email && String(r.email.email).toLowerCase() === e));
  const had = include.length !== (grp.include || []).length;
  if (allow) include.push({ email: { email: e } });
  if ((allow && had) || (!allow && !had)) return false;
  if (!include.length) include.push({ email: { email: 'nobody@invalid.example' } }); // Access groups need at least one rule
  const body = { name: grp.name, include, exclude: grp.exclude || [], require: grp.require || [] };
  const r = await (await fetch(base, { method: 'PUT', headers: H, body: JSON.stringify(body) })).json();
  if (!r.success) throw new Error('Access group update failed: ' + JSON.stringify(r.errors || []));
  return true;
}

function htmlToText(h) {
  return h
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(new RegExp('<(scr' + 'ipt|style)[\\s\\S]*?</\\1>', 'gi'), ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#8217;|&#x2019;|&rsquo;/gi, '’').replace(/&#8216;|&lsquo;/gi, '‘').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#8212;|&mdash;/gi, '—').replace(/&#8211;|&ndash;/gi, '–').replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
