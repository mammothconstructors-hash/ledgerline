import re, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P=lambda *a: os.path.join(ROOT,*a)
s=open(P('app-src','Stockings.html')).read()
def rep(a,b,cnt=1):
    global s
    assert a in s, 'MISSING: '+a[:90]
    s=s.replace(a,b,cnt)
API="https://sec-proxy.mammothconstructors.workers.dev"
# --- page chrome for a real website
s=s.replace('<title>LedgerLine</title>','<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>LedgerLine</title>\n<link rel="icon" href="/logo.svg">',1)
rep('<meta name="claude:viewport-fit-sides" content="cover">\n','')
rep('</style>\n','</style>\n</head><body>\n')
s=s.rstrip()+'\n</body></html>\n'
rep('body{background:var(--bg);color:var(--ink);font-family:var(--sans);','html,body{margin:0}\n:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\n[hidden]{display:none!important}\nbody{background:var(--bg);color:var(--ink);font-family:var(--sans);')
rep('<div class="toplinks"><span id="bugSlot"></span><button id="startBtn" class="startbtn" type="button">Start here</button><button id="resBtn" type="button" aria-haspopup="true" aria-expanded="false">Library ▾</button><button id="listBtn" type="button">My list</button><button id="tipsBtn" type="button" class="tipsbtn" aria-pressed="true" title="Show or hide definitions on every line item and metric">ⓘ Tips</button></div>',
    '<div class="toplinks"><span id="bugSlot"></span><button id="startBtn" class="startbtn" type="button">Start here</button><button id="resBtn" type="button" aria-haspopup="true" aria-expanded="false">Library ▾</button><button id="listBtn" type="button">My list</button><button id="tipsBtn" type="button" class="tipsbtn" aria-pressed="true" title="Show or hide definitions on every line item and metric">ⓘ Tips</button><a class="toplink" href="'+API+'/billing/portal">Account</a><a class="toplink" href="/cdn-cgi/access/logout">Log out</a></div>')
rep('.toplinks button:hover{background:rgba(255,255,255,.08)}','.toplinks button:hover,.toplinks a:hover{background:rgba(255,255,255,.08)}\n.toplink{color:var(--onnavy);font-size:13px;font-weight:600;padding:8px 10px;border-radius:2px;text-decoration:none}')
import re as _re
s=_re.sub(r'<footer class="wrap foot">.*?</footer>', lambda _m: open(P('tools','site_footer.txt')).read(), s, count=1, flags=_re.S)
# --- brand mark in the app top bar
rep('<button class="brand" id="homeBtn" type="button" title="Home: the market and watchlists">LedgerLine</button>', '<button class="brand" id="homeBtn" type="button" title="Home: the market and watchlists" style="display:flex;align-items:center;gap:8px"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 48 48\" width=\"34\" height=\"34\" aria-hidden=\"true\" style=\"flex:none;display:block\"><rect width=\"48\" height=\"48\" rx=\"11\" fill=\"#FBF7F1\"/><path d=\"M10 14h20.5l6-6\" fill=\"none\" stroke=\"#1E8C52\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M30 7.5h7v7\" fill=\"none\" stroke=\"#1E8C52\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 24h17\" fill=\"none\" stroke=\"#A39C93\" stroke-width=\"4\" stroke-linecap=\"round\"/><path d=\"M10 34h14.5l6 6\" fill=\"none\" stroke=\"#8E1B33\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M24 40.5h7v-7\" fill=\"none\" stroke=\"#8E1B33\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>LedgerLine</button>')
# --- data layer
rep("const TV = 'Tradingview', SEC = 'SEC EDGAR', SITE = false, API = '';", "const TV = 'Tradingview', SEC = 'SEC EDGAR', SITE = true, API = '"+API+"';")
rep("""const capsReady = (async () => {
  if(!window.claude || !window.claude.use){ caps={mcp:'none',sample:'none',db:'none'}; return; }""","""const capsReady = (async () => {
  if(SITE || !window.claude || !window.claude.use){ caps={mcp:'none',sample:'none',db:'none'}; return; }""")
rep("""async function loadCompany(q){
  await capsReady;""","""async function getJSON(path){
  let r; try{ r = await fetch(API+path); }catch(e){ throw {code:'net', message:'Couldn’t reach the LedgerLine data service. Check your connection and try again.'}; }
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw {code:'tool_error', message: j.error || ('Data service error '+r.status)};
  return j;
}
async function loadCompany(q){ return SITE ? loadCompanySite(q) : loadCompanyClaude(q); }
async function loadCompanySite(q){
  const seq=++loadSeq;
  view='loading'; errState=null; S={sym:q.toUpperCase(), name:''}; render();
  try{
    let t=q.trim().toUpperCase().replace(/^\$/,'').replace(/\.+$/,'');   // $TSLA, KO.
    if(t.includes(':')) t=t.split(':')[1];
    t=t.replace(/^([A-Z]{1,4})[ .\/]([A-Z]{1,2})$/,'$1-$2');   // class shares one way everywhere: BRK.B, BRK B, BRK/B → BRK-B
    if(/^\^|-USD$|=[XF]$/.test(t)) throw {code:'tool_error', message:'Indexes, crypto, currencies and futures aren’t covered. LedgerLine covers US stocks, and SPY, QQQ, DIA and IWM stand in for the indexes.'};
    if(!/^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t)){
      const sr=await getJSON('/api/search?q='+encodeURIComponent(q.trim()));
      if(!sr.results||!sr.results.length) throw {code:'tool_error', message:'No US-listed company matched “'+q+'”. Try the ticker.'};
      t=sr.results[0].ticker;
    }
    const bad=e=>({__err:e});
    const [st, pf, mk, spy, qqq, dia, iwm] = await Promise.all([
      FUNDS[t] ? Promise.resolve(bad({message:'fund'})) : getJSON('/api/statements?ticker='+encodeURIComponent(t)+'&years=20').catch(bad),
      getJSON('/api/profile?ticker='+encodeURIComponent(t)).catch(()=>({})),
      getJSON('/api/market?symbol='+encodeURIComponent(t)).catch(bad),
      getJSON('/api/market?symbol=SPY').catch(()=>null),
      getJSON('/api/market?symbol=QQQ').catch(()=>null),
      getJSON('/api/market?symbol=DIA').catch(()=>null),
      getJSON('/api/market?symbol=IWM').catch(()=>null)
    ]);
    if(seq!==loadSeq) return;
    const bmx={}; [['SPY',spy],['QQQ',qqq],['DIA',dia],['IWM',iwm]].forEach(([k,m])=>{ if(m&&m.weekly) bmx[k]={w:m.weekly,d:m.daily||null,chg:isNum(m.changePct)?m.changePct:null}; });
    if(!MKT) MKT={bmx};
    if(mk.__err&&st.__err&&!FUNDS[t]&&/[A-Za-z]{3}/.test(q)&&!/:/.test(q)){   // not a ticker after all (“apple”): try it as a company name
      const sr=await getJSON('/api/search?q='+encodeURIComponent(q.trim())).catch(()=>null);
      const hit=sr&&sr.results&&sr.results[0]; if(hit&&hit.ticker&&hit.ticker!==t){ $('#q')&&($('#q').value=hit.ticker); return loadCompanySite(hit.ticker); }
    }
    if(mk.__err&&!st.__err) throw {code:'tool_error', message:'No price data for '+t+' yet. It files with the SEC, but new listings and ticker changes can take a few days to reach the price feed.'};
    if(mk.__err) throw (st.__err||mk.__err);
    if(st.__err){   // ETFs, funds and 20-F filers: no 10-K data, so price performance and technicals only
      S={sym:t, ticker:t, name:(FUNDS[t]&&FUNDS[t][0])||niceName(t, pf.name||t), exch:FUNDS[t]?'ETF':''};
      S.px=mk.weekly; S.d=mk.daily||null; S.spy=spy&&spy.weekly; S.spyD=spy&&spy.daily||null; S.qqq=qqq&&qqq.weekly||null; S.qqqD=qqq&&qqq.daily||null; S.bmx=bmx; S.pf=pf||{};
      S.priceSource=mk.source; S.quoteTime=mk.quoteTime||null;
      S.sd={description:S.name, close:mk.price, change:mk.changePct, change_abs:mk.change, price_52_week_high:mk.high52, price_52_week_low:mk.low52, sector:FUNDS[t]?'Exchange-traded fund':'No SEC 10-K filings'};
      S.fund=true; LS.set('last', t); noteRecent(t); view='fund'; render(); return;
    }
    const ex=((pf.exchanges||[])[0]||'').toUpperCase();
    S={sym:(ex?ex+':':'')+t, ticker:t, name:niceName(t, pf.name||st.name||t), exch:ex};
    S.sec=fixShareUnits(splitAdjust(st)); S.src='SEC'; S.secErr=null;
    S.px=mk.weekly; S.spy=spy&&spy.weekly; S.priceSource=mk.source; S.asOf=mk.asOf||null;
    S.pf=pf||{}; S.d=mk.daily||null; S.quoteTime=mk.quoteTime||null; S.spyChg=spy&&isNum(spy.changePct)?spy.changePct:null; S.spyD=spy&&spy.daily||null; S.qqq=qqq&&qqq.weekly||null; S.qqqD=qqq&&qqq.daily||null; S.bmx=bmx;
    S.otherClass=null; S.capNote=null;
    if(TWO_PRICE[t]){ const o=await getJSON('/api/market?symbol='+TWO_PRICE[t].other).catch(()=>null); if(o&&isNum(o.price)) S.otherClass={t:TWO_PRICE[t].other, price:o.price}; }
    buildSiteStats(mk, pf);
    S.ai={state:'none'}; S.docs={}; S.saved=null; S.notes='';
    derive();
    if(isNum(S.sd.price_earnings_ttm)&&isNum(S.F.epsCagr5)&&S.F.epsCagr5>0) S.sd.price_earnings_growth_ttm=S.sd.price_earnings_ttm/S.F.epsCagr5;
    LS.set('last', t); noteRecent(t);
    view='company'; render();
    loadSaved(seq);
    loadPeers(seq);
  }catch(e){ if(seq!==loadSeq) return; errState=e; view='error'; render(); }
}
// Market stats the TradingView version gets ready-made, computed here from filings + prices
// Berkshire tags per-share data only per Class A equivalent (1 A = 1,500 B) and stopped tagging the count; Class A equivalent shares from its latest 10-Q
const CLASS_EQ={'BRK-B':{sh:1428850*1500,why:'1.43M Class A equivalent shares × 1,500 (1 A = 1,500 B)'},'BRK-A':{sh:1428850,why:'Class A equivalent shares (each B is 1/1,500 of an A)'},
  'V':{sh:1.867e9,why:'Class A shares as converted (B and C shares convert into A)'},'STZ':{sh:169.2e6,why:'Class A and Class 1 shares combined'}};
const TWO_PRICE={HEI:{other:'HEI-A',commonIs:'HEI',classA:'HEI-A'},'HEI-A':{other:'HEI',commonIs:'HEI',classA:'HEI-A'}};
function buildSiteStats(mk, pf){
  const sec=S.sec, T=sec.ttm||{}, K=sec.key, L=sec.years.length-1;
  // latest figure from the last two fiscal years only: a share count or EPS from 2009 isn't today's (Berkshire stopped tagging them)
  const last=a=>{ if(!Array.isArray(a)) return null; for(let i=a.length-1;i>=Math.max(0,a.length-2);i--) if(isNum(a[i])) return a[i]; return null; };
  const price=mk.price;
  // the newest share count wins: the latest 10-Q's diluted shares beat last year's 10-K (buybacks: Salesforce), and a
  // 10-K count well above it is shares issued, not outstanding (Boeing reports 1.01B issued, ~790M outstanding)
  const qr=(sec.quarters&&sec.quarters.rows)||{}, lastOf=a=>{ if(!Array.isArray(a)) return null; for(let i=a.length-1;i>=Math.max(0,a.length-2);i--) if(isNum(a[i])&&a[i]>0) return a[i]; return null; };
  const qDil=lastOf(qr.dilShares), qOut=lastOf(qr.sharesOut);
  let shares = isNum(T.sharesOut)?T.sharesOut : qOut ?? qDil ?? last(K.sharesOut) ?? T.dilShares ?? last(K.dilShares);
  if(isNum(qDil)&&isNum(shares)&&(shares>qDil*1.12||shares<qDil*0.6&&!isNum(qOut))) shares=qDil;
  // a cover count far below diluted shares is one class of a two-class stock (HEICO): diluted shares count every class
  { const dl=isNum(T.dilShares)?T.dilShares:last(K.dilShares); if(isNum(shares)&&isNum(dl)&&shares<dl*0.6) shares=dl; }
  // two-class stocks that tag no single share count (Berkshire, Visa, Constellation): a class-converted count
  const ce=CLASS_EQ[S.ticker];
  if(!isNum(shares)&&ce){ shares=ce.sh; S.classNote=ce; T.sharesOut=shares; T.dilShares=shares; if(isNum(T.netIncome)) T.eps=T.netIncome/shares; }
  let mcap = isNum(shares)&&isNum(price) ? shares*price : null;
  // two classes at two prices (HEICO): the 10-K count is the common class; diluted shares minus it is Class A
  const tp=TWO_PRICE[S.ticker], common=last(K.sharesOut);
  if(tp&&S.otherClass&&isNum(common)&&isNum(shares)&&shares>common*1.1){ const pC=tp.commonIs===S.ticker?price:S.otherClass.price, pA=tp.commonIs===S.ticker?S.otherClass.price:price, nA=shares-common;
    mcap=common*pC+nA*pA; const M=v=>(v/1e6).toFixed(1)+'M';
    S.capNote=`${M(common)} ${tp.commonIs} shares × $${pC.toFixed(2)} + ${M(nA)} ${tp.classA} shares × $${pA.toFixed(2)}: each class at its own price`; }
  if(!isNum(shares)) S.capNote='Not shown: the filings report shares only by class, with no total to price.';
  // companies that issue shares fast (Strategy): the latest 10-Q count trails today's
  { const qd=((sec.quarters&&sec.quarters.rows)||{}).dilShares||[]; const v=qd.filter(isNum); if(v.length>=3){ const g=v[v.length-1]/v[v.length-3]-1; if(g>0.08&&!S.capNote) S.capNote=`Diluted shares rose ${(g*100).toFixed(0)}% in two quarters. This count is from the latest 10-Q, so market cap can run low until the next filing.`; } }
  const netDebt = isNum(T.netDebt)?T.netDebt : last(K.netDebt);
  const inc=r=>{ const row=sec.statements.income.rows.find(x=>x.key===r); return row? (isNum(row.last)?row.last:row.values[L]) : null; };
  const pretax=inc('pretax'), tax=inc('tax');
  let taxRate = isNum(pretax)&&pretax>0&&isNum(tax) ? Math.abs(tax)/pretax : 0.21; taxRate=Math.min(Math.max(taxRate,0),0.35);
  const equity = isNum(T.equity)?T.equity:last(K.equity), debt=isNum(T.debt)?T.debt:last(K.debt), cash=isNum(T.cash)?T.cash:last(K.cash);
  const invested = (equity||0)+(debt||0)-(cash||0);
  const ttmv=k=>isNum(T[k])?T[k]:last(K[k]);
  const opInc=ttmv('opIncome'), rev=ttmv('revenue');
  const c=S.px.c, t=S.px.t, n=c.length;
  const atOrBefore=ts=>{ let k=0; for(let i=0;i<n;i++) if(t[i]<=ts) k=i; return k; };
  const yStart=Date.UTC(new Date().getUTCFullYear(),0,1)/1000;
  const ytdBase=c[Math.max(0,atOrBefore(yStart))], yrBase=c[Math.max(0,atOrBefore(t[n-1]-365*86400))];
  let beta=null;
  if(S.spy&&S.spy.c&&S.spy.c.length>60){ const m=new Map(S.spy.t.map((x,i)=>[x,S.spy.c[i]])); const a=[],b=[]; for(let i=Math.max(1,n-104);i<n;i++){ const s0=m.get(t[i-1]), s1=m.get(t[i]); if(s0&&s1){ a.push(c[i]/c[i-1]-1); b.push(s1/s0-1); } } if(a.length>40){ const ma=mean(a), mb=mean(b); let cov=0,vb=0; a.forEach((v,i)=>{ cov+=(v-ma)*(b[i]-mb); vb+=(b[i]-mb)**2; }); beta=vb?cov/vb:null; } }
  const revA=K.revenue, epsA=K.eps;
  const yoyLast=a=>{ const v=(a||[]).filter(isNum); return v.length>1&&v[v.length-2]>0 ? (v[v.length-1]/v[v.length-2]-1)*100 : null; };
  const eps=ttmv('eps'), fcf=ttmv('fcf'), ebitda=ttmv('ebitda'), divs=ttmv('dividends');
  S.sd={ description:S.name, close:price, change:mk.changePct, change_abs:mk.change, market_cap_basic:mcap,
    sector:pf.sector||'', industry:'', country:'United States',
    price_earnings_ttm: isNum(eps)&&eps>0?price/eps:null,
    price_sales_current: isNum(mcap)&&rev>0?mcap/rev:null,
    price_free_cash_flow_ttm: isNum(mcap)&&fcf>0?mcap/fcf:null,
    enterprise_value_ebitda_ttm: isNum(mcap)&&ebitda>0?(mcap+(netDebt||0))/ebitda:null,
    dividends_yield_current: isNum(mcap)&&mcap>0&&isNum(divs)? divs/mcap*100 : 0,
    return_on_invested_capital: isNum(opInc)&&invested>0 ? opInc*(1-taxRate)/invested*100 : null,
    net_debt: netDebt, beta_1_year: beta,
    'Perf.YTD': ytdBase?(price/ytdBase-1)*100:null, 'Perf.Y': yrBase?(price/yrBase-1)*100:null,
    price_52_week_high: mk.high52, price_52_week_low: mk.low52, number_of_employees:null, earnings_release_next_date:null };
  const gp=ttmv('grossProfit'), ni=ttmv('netIncome');
  S.fin={ total_revenue_ttm:rev, total_revenue_yoy_growth_ttm:yoyLast(revA), earnings_per_share_diluted_ttm:eps, earnings_per_share_diluted_yoy_growth_ttm:yoyLast(epsA),
    gross_margin: rev>0&&isNum(gp)?gp/rev*100:null, operating_margin: rev>0&&isNum(opInc)?opInc/rev*100:null, net_margin: rev>0&&isNum(ni)?ni/rev*100:null,
    free_cash_flow_ttm:fcf, ebitda_ttm:ebitda, gross_profit_ttm:gp, oper_income_ttm:opInc, net_income_ttm:ni,
    return_on_equity: isNum(ni)&&equity>0?ni/equity*100:null, price_target_1y:null, dividends_yield: isNum(mcap)&&mcap>0&&isNum(divs)?divs/mcap*100:0 };
}
async function loadCompanyClaude(q){
  await capsReady;""")
# saved list in browser storage for the site
rep("""async function loadSaved(seq){
  await capsReady; if(!db||!S) return;""","""function siteList(){ return LS.get('list')||{}; }
async function loadSaved(seq){
  if(SITE){ const d=siteList()[S.sym]; if(d){ S.saved=d; S.notes=d.notes||''; render(); } return; }
  await capsReady; if(!db||!S) return;""")
rep("""  await capsReady;
  if(!db){ toast('Saving needs Claude. Open this page in Claude.'); return; }
  const o=overall(), now=Date.now();""","""  await capsReady;
  if(!db&&!SITE){ toast('Saving needs Claude. Open this page in Claude.'); return; }
  const o=overall(), now=Date.now();""")
rep("""  try{ await db.doc('analyses/'+S.sym).set(JSON.parse(JSON.stringify(doc))); S.saved=doc; toast('Saved to My list'); render(); }""",
    """  try{ if(SITE){ const L=siteList(); L[S.sym]=JSON.parse(JSON.stringify(doc)); LS.set('list',L); } else await db.doc('analyses/'+S.sym).set(JSON.parse(JSON.stringify(doc))); S.saved=doc; toast('Saved to My list'); render(); }""")
rep("""  if(caps.db==='none') return `<div class="notice"><h4>My list lives in Claude</h4>""","""  if(SITE&&listDocs==null) listDocs=Object.values(siteList());
  if(caps.db==='none'&&!SITE) return `<div class="notice"><h4>My list lives in Claude</h4>""")
rep("""async function openList(){
  view='list'; render(); await capsReady;""","""async function openList(){
  if(SITE){ listDocs=Object.values(siteList()); view='list'; render(); return; }
  view='list'; render(); await capsReady;""")
rep("""  if(d.delyes){ db.doc('analyses/'+d.delyes).delete()""","""  if(d.delyes&&SITE){ const L=siteList(); delete L[d.delyes]; LS.set('list',L); listDocs=Object.values(L); toast('Removed'); render(); return; }
  if(d.delyes){ db.doc('analyses/'+d.delyes).delete()""")
rep("""<h2>Nothing saved yet.</h2><p class="prose" style="margin:0">Search a stock, open its Verdict tab and press Save. It lands here with its scores and the price on the day.</p>""",
    """<h2>Nothing saved yet.</h2><p class="prose" style="margin:0">Search a stock, open its Verdict tab and press Save. It lands here with its scores and the price on the day${SITE?'. Your list is kept in this browser':''}.</p>""")
# filing sections from the API
rep("""    try{ d=await call(SEC,'sec_section',{ticker:S.ticker, section:sec, form:'10-K', maxChars:DOCS[sec].max}); }""",
    """    if(SITE) d=await getJSON('/api/section?ticker='+encodeURIComponent(S.ticker)+'&section='+sec+'&maxChars='+DOCS[sec].max);
    else try{ d=await call(SEC,'sec_section',{ticker:S.ticker, section:sec, form:'10-K', maxChars:DOCS[sec].max}); }""")
# judgment-call factors don't exist on the site: drop them instead of showing "No read"
rep("""function aiFactor(tab, key, opts){""","""function aiFactor(tab, key, opts){
  if(SITE) return {na:true};""")
rep("""    else add('Moat width', null);""","""    else if(!SITE) add('Moat width', null);""")
rep("""  return out;
}
function tabScore(tab){""","""  return out.filter(o=>!(o.f&&o.f.na));
}
function tabScore(tab){""")
rep("""Fundamentals: <b>${S.src==='SEC'?'SEC EDGAR, XBRL-tagged 10-K and 10-Q filings':'TradingView'}</b> · Prices: <b>TradingView</b> · Judgment calls: <b>${S.ai.state==='done'?'Claude':S.ai.state==='busy'?'Claude (reading…)':'unavailable'}</b>""",
    """${SITE?`Fundamentals: <b>SEC EDGAR, XBRL-tagged 10-K and 10-Q filings</b> · Prices: <b>${S.quoteTime?(+new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false})>=16?`last trade ${(()=>{ const d=new Date(Math.min(S.quoteTime+900,Math.floor(Date.now()/1000))*1000), hm=d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:false,timeZone:'America/New_York'}).split(':').map(Number); return hm[0]*60+hm[1]>=960?'4:00 PM':d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}); })()} ET</b> (official close posts this evening)<b>`:`15-min delayed as of ${new Date(S.quoteTime*1000).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})} ET`):`closing price${S.asOf?' on '+new Date(S.asOf*1000).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}):''}`}</b>${S.quoteTime?'':' (end of day: updates after each market close)'} · Every score computed from the numbers`:`Fundamentals: <b>${S.src==='SEC'?'SEC EDGAR, XBRL-tagged 10-K and 10-Q filings':'TradingView'}</b> · Prices: <b>TradingView</b> · Judgment calls: <b>${S.ai.state==='done'?'Claude':S.ai.state==='busy'?'Claude (reading…)':'unavailable'}</b>`}""")
rep("""function aiNote(){
""","""function aiNote(){
  if(SITE) return `<p class="fine">Every factor here is computed from the company’s SEC filings and its price history. Nothing is hand-picked.</p>`;
""")
rep("""Business, moat, growth, management, risk and valuation are each scored automatically from the filings and price history, with Claude filling in the judgment calls.""",
    """Business, moat, growth, management, risk and valuation are each scored automatically from SEC filings and price history.""")
# boot
rep("""capsReady.then(()=>{ if(view==='empty'&&mcp){""","""if(SITE){ const first=new URLSearchParams(location.search).get('t'); if(first||last){ $('#q').value=(first||last).split(':').pop(); loadCompany(first||last); } }
else capsReady.then(()=>{ if(view==='empty'&&mcp){""")
open(P('site','app','index.html'),'w').write(s)
# also mark the Claude version explicitly
c=open(P('app-src','Stockings.html')).read()
print('ok', len(s))
