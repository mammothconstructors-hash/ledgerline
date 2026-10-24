import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const SITE='file://'+ROOT+'/site'; const OUT=ROOT+'/tests/out';
import fs from 'fs';
const sec=JSON.parse(fs.readFileSync(ROOT+'/tests/fixtures/sec.json','utf8'));
sec.key.ffo=sec.key.netIncome.map((v,i)=>v!=null&&sec.key.da[i]!=null?v+sec.key.da[i]:null);
function walk(n,step,start,p0){ const t=[],o=[],h=[],l=[],c=[],v=[]; let p=p0; for(let i=0;i<n;i++){ const ts=start+i*step; const r=(Math.random()-.5)*0.03; const op=p; p=p*(1+r+0.0004); t.push(ts);o.push(op);c.push(p);h.push(Math.max(op,p)*1.01);l.push(Math.min(op,p)*0.99);v.push(1e6); } return {t,o,h,l,c,v}; }
const now=Math.floor(Date.UTC(2026,9,20)/1000);
function market(base){ const w=walk(530,7*86400,now-529*7*86400,base/4); const d=walk(1300,86400*1.4,now-1299*86400*1.4,w.c[w.c.length-1]*0.6); const sc=w.c[w.c.length-1]/d.c[d.c.length-1]; ['o','h','l','c'].forEach(k=>d[k]=d[k].map(x=>x*sc)); return {price:w.c.at(-1), change:1.2, changePct:0.8, high52:500, low52:10, weekly:w, daily:d, source:'Mock feed'}; }
const b=await chromium.launch(); const errs=[];
const mk=async (w,h)=>{ const p=await b.newPage({viewport:{width:w,height:h}}); p.on('pageerror',e=>errs.push(w+' PAGEERR '+e.message)); p.on('console',m=>{ if(m.type()==='error'&&!/ERR_FAILED|net::/.test(m.text())) errs.push('CONSOLE '+m.text()); });
 await p.route('https://fonts.googleapis.com/**',r=>r.abort()); await p.route('https://fonts.gstatic.com/**',r=>r.abort());
 await p.route('https://sec-proxy.mammothconstructors.workers.dev/api/**', async r=>{ const u=new URL(r.request().url()); const t=u.searchParams.get('ticker')||u.searchParams.get('symbol');
  let body, st=200; if(u.pathname==='/api/statements'){ if(['SPY','ASML','VOO','XLK','ZZZQ'].includes(t)){ st=502; body={error:'No annual 10-K data found for '+t}; } else body=JSON.parse(JSON.stringify(sec)); }
  else if(u.pathname==='/api/profile') body={name:'REALTY INCOME CORP',sic:'6798',exchanges:['NYSE'],sector:'Real Estate Investment Trusts'}; else if(u.pathname==='/api/market') body=market(100+t.length*20); else if(u.pathname==='/api/etf-holdings') body= t==='ZZZQ' ? {symbol:t,count:0,holdings:[],sectors:[],unavailable:true,reason:'No public N-PORT filing found yet for '+t+'.'} : {symbol:t,fund:'Technology Select Sector SPDR Fund',asOf:'2026-06-30',filed:'2026-08-28',netAssets:7.2e10,count:68,top10Weight:61.4,sectors:[{sector:'Information Technology',weight:97.1}],sectorCoverage:99,holdings:Array.from({length:30},(_,i)=>({symbol:i%5?'T'+i:null,name:'Holding number '+i+' Incorporated with a long name',weight:15-i*0.4,value:1e9,shares:1e6})),filing:'https://www.sec.gov/Archives/edgar/data/1/2/'}; else if(u.pathname==='/api/section') body={form:'10-K',filed:'2026-02-01',url:'x',text:'Item 1 Business. We own property.'}; else body={results:[]};
  await r.fulfill({status:st,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)}); });
 return p; };
const p=await mk(1280,900);
const BAD=/NaN|undefined|\[object Object\]|Infinity|null%|\$null|−0\.0%|function \(|=>/;
const issues=[]; let clicks=0;
async function scan(pg,where){ const t=await pg.locator('#main').innerText().catch(()=>''); const m=t.match(new RegExp('.{0,40}('+BAD.source+').{0,40}','g')); if(m) issues.push(where+' :: '+[...new Set(m)].slice(0,3).join(' || ')); const ow=await pg.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth); if(ow>2) issues.push(where+' :: horizontal overflow '+ow+'px'); }
const ATTRS=['fin','fg','fh','per','tper','tint','tmode','mode','outmode','bench','strx','ind','exs','cat','exsort'];
async function crawl(pg,where){ await scan(pg,where);
  for(const a of ATTRS){ const n=await pg.locator(`#main [data-${a}]`).count(); for(let i=0;i<Math.min(n,14);i++){ const el=pg.locator(`#main [data-${a}]`).nth(i); if(!(await el.isVisible().catch(()=>false))) continue; const v=await el.getAttribute('data-'+a); await el.click({timeout:2000}).catch(()=>{}); clicks++; await pg.waitForTimeout(120); await scan(pg,where+' ['+a+'='+v+']'); } } }
for(const [w,h] of [[1280,900],[390,800]]){
  const pg=w===1280?p:await mk(w,h); await pg.setViewportSize({width:w,height:h});
  for(const t of ['MSFT','O']){
    await pg.goto(SITE+'/app/index.html?t='+t); await pg.waitForTimeout(1500);
    const steps=await pg.locator('#rail button').evaluateAll(b=>b.map(x=>x.dataset.step));
    for(const s of steps){ await pg.click(`#rail button[data-step="${s}"]`); await pg.waitForTimeout(250); await crawl(pg,`${w} ${t} ${s}`); }
  }
  for(const [btn,name] of [['#etfBtn','etfs'],['#startBtn','guide'],['#exploreBtn','explore'],['#newsBtn','news'],['#methodBtn','help'],['#homeBtn','home']]){ if(await pg.locator(btn).isVisible().catch(()=>false)){ await pg.click(btn); await pg.waitForTimeout(400); await crawl(pg,`${w} ${name}`);} }
  await pg.goto(SITE+'/app/index.html?t=SPY'); await pg.waitForTimeout(1500); if(!(await pg.locator('#ddSec').count())) issues.push(w+' SPY :: drawdowns section missing'); if(!(await pg.locator('#saveTop').count())) issues.push(w+' SPY :: save button missing'); if(await pg.locator('#main th', {hasText:'vs SPY'}).count()) issues.push(w+' SPY :: compares with itself'); await crawl(pg,`${w} SPY-fund`);
  for(const t of ['XLK','ZZZQ']){ await pg.goto(SITE+'/app/index.html?t='+t); await pg.waitForTimeout(1500); const h=await pg.locator('#liveHold').innerText().catch(()=>''); if(t==='XLK'&&!/top 25 holdings/i.test(h)) issues.push(w+' '+t+' :: live holdings did not render'); if(t==='ZZZQ'&&!/no public n-port/i.test(h)) issues.push(w+' '+t+' :: missing-holdings note did not render'); await crawl(pg,`${w} ${t}-fund`); }
}
console.log("clicks",clicks); const g={}; for(const i of issues){ const [w,rest]=i.split(" :: "); const k=rest.replace(/[\d.,+−%$]+/g,"#").slice(0,70); (g[k]=g[k]||[]).push(w);} for(const [k,v] of Object.entries(g)) console.log(v.length+"x", k, "| e.g.", v[0]); console.log("ERR",errs); await b.close();
const must=issues.filter(i=>/:: (live holdings|missing-holdings|drawdowns section|save button|compares with itself)/.test(i)); if(must.length){ console.log("FAILED CHECKS", must); process.exit(1); }
