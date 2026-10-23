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

const WORKER_VERSION = '3.6.1';
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
    if (url.pathname === '/usage' || url.pathname.startsWith('/usage/')) return usagePage(url, env || {});
    if (!url.searchParams.get('u') && /^\/[A-Za-z0-9_-]{6,64}\/?$/.test(url.pathname) && await keyOk(url.pathname.replace(/\//g, ''), env || {})) return usagePage(new URL(url.origin + '/usage?key=' + encodeURIComponent(url.pathname.replace(/\//g, ''))), env || {});
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') return mcp(req);
    if (url.pathname.startsWith('/api/')) return api(req, url, env || {}, ctx);
    if (url.pathname.startsWith('/billing/') || url.pathname === '/stripe/webhook') return billing(req, url, env || {});
    return relay(req);
  }
};

/* ================= Marketstack usage counter (D1 database bound as DB) ================= */
let USAGE_DB = null, MS_LIMIT = 10000, MONTH_CACHE = { t: 0, n: 0 };
const etDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // YYYY-MM-DD, New York time
async function msFetch(u, init, kind) {   // every Marketstack call goes through here and is counted
  const r = await fetch(u, init);
  if (USAGE_DB) { try { await USAGE_DB.prepare('INSERT INTO usage (day, kind, n) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1').bind(etDay(), kind).run(); MONTH_CACHE.n++; } catch (e) { } }
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
async function recordVisit(req, env) {
  if (!USAGE_DB) return { ok: false };
  const site = (env.SITE_URL || 'https://ledgerline-dv0.pages.dev').replace(/\/+$/, ''), origin = req.headers.get('Origin') || '';
  if (origin !== site) return { ok: false };   // browsers always send Origin on this call; anything else is a script
  let b = {}; try { b = JSON.parse(await req.text()); } catch (e) { }
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/.test(email)) return { ok: false };
  const now = Math.floor(Date.now() / 1000), day = etDay();
  const last = await USAGE_DB.prepare('SELECT MAX(last_ts) AS t FROM visits WHERE email = ?').bind(email).first();
  const add = !last || !last.t || now - last.t >= 1800 ? 1 : 0;
  await USAGE_DB.prepare('INSERT INTO visits (email, day, n, first_ts, last_ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, day) DO UPDATE SET n = n + ?, last_ts = ?').bind(email, day, add, now, now, add, now).run();
  return { ok: true };
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
  if (!(await keyOk(url.searchParams.get('key') || url.pathname.split('/')[2], env))) return `\x3ch2>Who’s using LedgerLine\x3c/h2>\x3cp class="fine">Private. Open this page with your key: /usage?key=…\x3c/p>`;
  const a = await activityData();
  if (a.error) return `\x3ch2>Who’s using LedgerLine\x3c/h2>\x3cp>${a.error}\x3c/p>`;
  const f = n => Number(n || 0).toLocaleString('en-US'), esc = x => String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const when = t => t ? new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' days ago'; };
  const maxU = Math.max(1, ...a.daily.map(d => d.users));
  const days = a.daily.map(d => `\x3ctr>\x3ctd>${d.day.slice(5)}\x3c/td>\x3ctd>${f(d.users)}\x3c/td>\x3ctd>${f(d.visits)}\x3c/td>\x3ctd>\x3cspan style="display:inline-block;height:10px;background:#0D7680;width:${Math.max(2, Math.round(d.users / maxU * 200))}px">\x3c/span>\x3c/td>\x3c/tr>`).join('');
  const rows = a.users.map(u => `\x3ctr>\x3ctd>${esc(u.email)}\x3c/td>\x3ctd>${when(u.last)}\x3cbr>\x3cspan class="fine">${ago(u.last)}\x3c/span>\x3c/td>\x3ctd>${f(u.week)}\x3c/td>\x3ctd>${f(u.total)}\x3c/td>\x3ctd>${when(u.first)}\x3c/td>\x3c/tr>`).join('');
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
\x3cbody>\x3cdiv class="k">LedgerLine\x3c/div>\x3ch1>Usage\x3c/h1>${await activityHtml(url, env).catch(e => '\x3cp>' + String(e.message || e) + '\x3c/p>')}\x3ch2>Marketstack price data this month\x3c/h2>${body}\x3c/body>\x3c/html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
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
  const findForm = async c => { const sr = await secGet(`https://data.sec.gov/submissions/CIK${c.cik}.json`, 3600); if (!sr) return { rec: {}, idx: -1 }; const rec = (await sr.json()).filings?.recent || {}; let idx = -1; for (let i = 0; i < (rec.form || []).length; i++) if (rec.form[i] === form) { idx = i; break; } return { rec, idx }; };
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

/* ================= 3. JSON API for the LedgerLine site ================= */
async function api(req, url, env, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const q = url.searchParams, path = url.pathname.replace(/\/+$/, '');
  const out = (o, status = 200, maxAge = 300) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge, 'X-Worker-Version': WORKER_VERSION } });
  try {
    if (path === '/api/search') return out(await searchTickers(q.get('q') || ''), 200, 86400);
    if (path === '/api/profile') return out(await profile(q.get('ticker') || ''), 200, 3600);
    if (path === '/api/statements') return out(await secStatements({ ticker: q.get('ticker'), years: q.get('years') }), 200, 3600);
    if (path === '/api/section') return out(await secSection({ ticker: q.get('ticker'), section: q.get('section'), form: q.get('form'), maxChars: q.get('maxChars') }), 200, 3600);
    if (path === '/api/market') return out(await market(q.get('symbol') || '', env, ctx), 200, 900);
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
async function marketstack(sym, apiKey) {
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
    asOf: Date.parse(last.date) / 1000, weekly: { t, o, h, l, c, v }, daily: dailyOf(bars.slice(-1320)), source: 'Marketstack (end of day)', splitsAdjusted: cum
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
