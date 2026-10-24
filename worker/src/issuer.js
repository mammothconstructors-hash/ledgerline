// Daily ETF holdings straight from the fund companies (3.13.0). Tried before SEC N-PORT, which runs about 3-4 months behind.
//   State Street (SPDR: SPY, DIA, MDY, XL*): daily .xlsx       iShares (IWM, IVV, IJH, IJR): daily .csv
//   Invesco (QQQ, RSP): daily JSON                              Vanguard (VOO, VTI, ...): monthly JSON
// Every reader returns { asOf, fund, holdings: [{ symbol, name, weight (percent), shares, value, type }] } or throws;
// the caller falls back to the SEC filing on any failure, so a changed file format never blanks the page.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; LedgerLine/1.0; +https://ledgerline-dv0.pages.dev)', Accept: '*/*' };
const SSGA = new Set(['SPY', 'DIA', 'MDY', 'RSPT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SPLG', 'SPYG', 'SPYV', 'SDY', 'KRE', 'XBI', 'XOP', 'XRT', 'XHB', 'XME', 'GLD']);
// iShares product pages: id and URL slug
const ISHARES = {
  IWM: [239710, 'ishares-russell-2000-etf'], IVV: [239726, 'ishares-core-sp-500-etf'], IJH: [239763, 'ishares-core-sp-midcap-etf'],
  IJR: [239774, 'ishares-core-sp-smallcap-etf'], SOXX: [239705, 'ishares-phlx-semiconductor-etf'], EFA: [239623, 'ishares-msci-eafe-etf'],
  IWF: [239706, 'ishares-russell-1000-growth-etf'], IWD: [239708, 'ishares-russell-1000-value-etf'], ITOT: [239724, 'ishares-core-sp-total-us-stock-market-etf'],
  IEMG: [244050, 'ishares-core-msci-emerging-markets-etf'], IEFA: [244049, 'ishares-core-msci-eafe-etf'], AGG: [239458, 'ishares-core-total-us-bond-market-etf'],
  TLT: [239454, 'ishares-20-year-treasury-bond-etf']
};
const INVESCO = new Set(['QQQ', 'QQQM', 'RSP', 'SPLV', 'PDBC']);
const VANGUARD = new Set(['VOO', 'VTI', 'VT', 'VXUS', 'VEA', 'VWO', 'VIG', 'VYM', 'VNQ', 'VUG', 'VTV', 'VGT', 'BND', 'VB', 'VO']);

const num = v => { if (v == null) return null; const n = Number(String(v).replace(/[,$%\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return isFinite(n) && String(v).trim() !== '' && String(v).trim() !== '-' ? n : null; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(s) {   // "23-Oct-2026", "Oct 22, 2026", "10/22/2026", "2026-10-22"
  s = String(s || '').trim(); let m;
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return m[0];
  if ((m = s.match(/(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{4})/))) return `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = s.match(/([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})/))) return `${m[3]}-${String(MON[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
async function get(url, kind = 'text', headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, redirect: 'follow', cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return kind === 'json' ? r.json() : kind === 'bin' ? new Uint8Array(await r.arrayBuffer()) : r.text();
}
function csvRows(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.map(r => r.map(x => x.replace(/ /g, ' ').trim()));
}
// a table whose header row holds a name column and a weight column: find it, return objects keyed by lower-case header
function table(rows) {
  const hi = rows.findIndex(r => r.some(c => /^(name|holding|security name|description)$/i.test(c)) && r.some(c => /weight|% of (net )?assets|percent/i.test(c)));
  if (hi < 0) throw new Error('no holdings table');
  const head = rows[hi].map(h => h.toLowerCase());
  return { head, meta: rows.slice(0, hi), body: rows.slice(hi + 1).filter(r => r.filter(Boolean).length >= 3).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))) };
}
const col = (o, ...res) => { for (const re of res) for (const k of Object.keys(o)) if (re.test(k) && o[k] !== '' && o[k] != null) return o[k]; return null; };
function normRows(body) {
  return body.map(o => ({
    symbol: (col(o, /^ticker$|^symbol$|^holding ticker$/) || '').replace(/\s+/g, '').replace(/\//g, '-').toUpperCase() || null,
    name: col(o, /^name$|^holding$|^security name$|^description$/) || '',
    weight: num(col(o, /weight|% of (net )?assets|percent/)),
    shares: num(col(o, /shares|quantity|units/)),
    value: num(col(o, /market value|marketvalue|^value/)),
    type: col(o, /asset class/, /security type/, /^type$/, /^sector$/) || ''
  })).filter(h => h.name && h.weight != null && !/^-+$|^cash$/i.test(h.symbol || ''));
}

/* ---- State Street: daily .xlsx (zip of XML). Read shared strings and the first sheet. ---- */
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
  let e = bytes.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    if (!/^xl\/(sharedStrings|worksheets\/sheet1)\.xml$/.test(name)) continue;
    const lo = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), raw = bytes.subarray(lo, lo + csize);
    files[name] = method === 0 ? new TextDecoder().decode(raw) : await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  return files;
}
const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
async function xlsxRows(bytes) {
  const f = await unzip(bytes), ss = [];
  for (const m of (f['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(unx([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const sheet = f['xl/worksheets/sheet1.xml']; if (!sheet) throw new Error('no sheet');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], ref = (a.match(/r="([A-Z]+)\d+"/) || [])[1], t = (a.match(/t="(\w+)"/) || [])[1], inner = cm[2] || '';
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; if (t === 'inlineStr') v = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      if (t === 's' && v != null) v = ss[Number(v)]; v = v == null ? '' : unx(String(v)).trim();
      let ci = 0; if (ref) for (const ch of ref) ci = ci * 26 + ch.charCodeAt(0) - 64; ci = ci ? ci - 1 : row.length;
      row[ci] = v;
    }
    rows.push(Array.from(row, x => x == null ? '' : x));
  }
  return rows;
}
async function ssga(t) {
  const rows = await xlsxRows(await get(`https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${t.toLowerCase()}.xlsx`, 'bin'));
  const { meta, body } = table(rows), flat = meta.map(r => r.join(' ')).join('\n');
  return { asOf: isoDate((flat.match(/as of[:\s]*([^\n]+)/i) || [])[1]), fund: (meta.find(r => /fund name/i.test(r[0])) || [])[1] || null, holdings: normRows(body) };
}
/* ---- iShares: daily .csv with a few lines of fund details on top ---- */
async function ishares(t) {
  const [id, slug] = ISHARES[t];
  let txt;
  try { txt = await get(`https://www.ishares.com/us/products/${id}/${slug}/1467271812596.ajax?fileType=csv&fileName=${t}_holdings&dataType=fund`); }
  catch (e) { txt = await get(`https://www.ishares.com/us/products/${id}/${slug}/latest-holdings.csv`); }
  const rows = csvRows(txt.replace(/^﻿/, '')), { meta, body } = table(rows), flat = meta.map(r => r.join(' ')).join('\n');
  return { asOf: isoDate((flat.match(/holdings as of\s*([^\n]+)/i) || [])[1]), fund: (meta[0] || [])[0] || null, holdings: normRows(body) };
}
/* ---- Invesco: holdings JSON behind their site ---- */
async function invesco(t) {
  const j = await get(`https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/${t}/holdings/fund?idType=ticker&productType=ETF`, 'json');
  const list = j.holdings || (j.data && j.data.holdings) || [];
  const holdings = list.map(h => ({ symbol: (h.ticker || '').toUpperCase() || null, name: h.issuerName || h.securityName || h.name || '', weight: num(h.percentageOfTotalNetAssets ?? h.weight), shares: num(h.units ?? h.shares), value: num(h.marketValue), type: h.securityTypeName || h.assetClass || '' })).filter(h => h.name && h.weight != null);
  return { asOf: isoDate(j.effectiveDate || j.asOfDate || (list[0] && list[0].effectiveDate)), fund: j.fundName || null, holdings };
}
/* ---- Vanguard: monthly portfolio JSON behind their site (paged) ---- */
async function vanguard(t) {
  const out = []; let asOf = null;
  for (let start = 1; start <= 5001 && out.length < 600; start += 500) {
    const j = await get(`https://investor.vanguard.com/investment-products/etfs/profile/api/${t}/portfolio-holding/stock?start=${start}&count=500`, 'json', { Accept: 'application/json' });
    const list = j.fund && j.fund.entity || j.entity || [];
    asOf = asOf || isoDate(j.fund && j.fund.asOfDate || j.asOfDate || (list[0] && list[0].asOfDate));
    for (const h of list) out.push({ symbol: (h.ticker || '').toUpperCase() || null, name: h.longName || h.shortName || h.name || '', weight: num(h.percentWeight ?? h.weight), shares: num(h.sharesHeld), value: num(h.marketValue), type: 'Stock' });
    if (list.length < 500) break;
  }
  return { asOf, fund: null, holdings: out.filter(h => h.name && h.weight != null) };
}

export function issuerFor(t) {
  return SSGA.has(t) ? ['State Street SPDR daily holdings', ssga] : ISHARES[t] ? ['iShares daily holdings', ishares] : INVESCO.has(t) ? ['Invesco daily holdings', invesco] : VANGUARD.has(t) ? ['Vanguard monthly holdings', vanguard] : null;
}
export async function issuerHoldings(t) {
  const it = issuerFor(t); if (!it) return null;
  const r = await it[1](t);
  if (!r.holdings || r.holdings.length < 5) throw new Error('fund file had no holdings');
  const tot = r.holdings.reduce((a, h) => a + (h.weight || 0), 0);
  if (tot > 0 && tot < 1.5) r.holdings.forEach(h => { h.weight *= 100; });   // fractions to percent
  return { ...r, source: it[0] };
}
