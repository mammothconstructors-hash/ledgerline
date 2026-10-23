import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const SITE='file://'+ROOT+'/site'; const OUT=ROOT+'/tests/out';
import fs from 'fs';
const sec=JSON.parse(fs.readFileSync(ROOT+'/tests/fixtures/sec.json','utf8'));
const per=[], rows={eps:[],revenue:[],grossProfit:[],opIncome:[],netIncome:[],fcf:[],ocf:[]}, earn=[];
const add=(s,k)=>{ const x=new Date(s+'T12:00:00Z'); x.setUTCDate(x.getUTCDate()+k); return x.toISOString().slice(0,10); };
for(let i=0;i<24;i++){ const end=add('2020-11-30',i*91); per.push({fy:2021+Math.floor(i/4),q:i%4+1,end,src:{filed:add(end,35),form:i%4==3?'10-K':'10-Q',accn:'0000-'+i,cik:'1'}});
 rows.eps.push(1+i*0.05+(i%3==0?-0.3:0)); rows.revenue.push(1e10+i*2e8); rows.grossProfit.push(4e9); rows.opIncome.push(2e9); rows.netIncome.push(1.5e9); rows.fcf.push(1e9); rows.ocf.push(1.4e9);
 earn.push({d:add(end,5),tm:'20:10',accn:'s'+i,url:'https://www.sec.gov/x'+i}); if(i<23) earn.push({d:add(end,28),tm:i%2?'21:05':'12:00',accn:'e'+i,url:'https://www.sec.gov/e'+i}); }
sec.quarters={periods:per,rows,cik:'1'};
sec.key.ffo=sec.key.netIncome.map((v,i)=>v!=null&&sec.key.da[i]!=null?v+sec.key.da[i]:null);
function walk(n,step,start,p0){ const t=[],o=[],h=[],l=[],c=[],v=[]; let p=p0; for(let i=0;i<n;i++){ const ts=start+i*step; const r=(Math.random()-.5)*0.03; const op=p; p=p*(1+r+0.0004); t.push(ts);o.push(op);c.push(p);h.push(Math.max(op,p)*1.01);l.push(Math.min(op,p)*0.99);v.push(1e6); } return {t,o,h,l,c,v}; }
const now=Math.floor(Date.UTC(2026,9,20)/1000);
function market(base){ const w=walk(530,7*86400,now-529*7*86400,base/4); const d=walk(1300,86400*1.4,now-1299*86400*1.4,w.c[w.c.length-1]*0.6); const sc=w.c[w.c.length-1]/d.c[d.c.length-1]; ['o','h','l','c'].forEach(k=>d[k]=d[k].map(x=>x*sc)); return {price:w.c.at(-1), change:1.2, changePct:0.8, high52:500, low52:10, weekly:w, daily:d, source:'Mock feed'}; }
const b=await chromium.launch(); const errs=[];
const mk=async (w,h)=>{ const p=await b.newPage({viewport:{width:w,height:h}}); p.on('pageerror',e=>errs.push(w+' PAGEERR '+e.message)); p.on('console',m=>{ if(m.type()==='error'&&!/ERR_FAILED|net::/.test(m.text())) errs.push('CONSOLE '+m.text()); });
 await p.route('https://fonts.googleapis.com/**',r=>r.abort()); await p.route('https://fonts.gstatic.com/**',r=>r.abort());
 await p.route('https://sec-proxy.mammothconstructors.workers.dev/api/**', async r=>{ const u=new URL(r.request().url()); const t=u.searchParams.get('ticker')||u.searchParams.get('symbol');
  let body, st=200; if(u.pathname==='/api/statements'){ if(['SPY','ASML','VOO'].includes(t)){ st=502; body={error:'No annual 10-K data found for '+t}; } else body=JSON.parse(JSON.stringify(sec)); }
  else if(u.pathname==='/api/profile') body={name:'COSTCO',exchanges:['NASDAQ'],earnings:earn}; else if(u.pathname==='/api/market'){ body=market(100+t.length*20); if(t==='SPY'){ const d=body.daily, n=d.t.length; d.t.push(d.t[n-1]+86400); ['o','h','l','c'].forEach(k=>d[k].push(d[k][n-1]*0.97)); if(d.v) d.v.push(1); } } else if(u.pathname==='/api/section') body={form:'10-K',filed:'2026-02-01',url:'x',text:'Item 1 Business. We own property.'}; else body={results:[]};
  await r.fulfill({status:st,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)}); });
 return p; };
const p=await mk(1280,900);
await p.goto(SITE+'/app/index.html?t=COST'); await p.waitForTimeout(1500);
const fh=p.locator('button:has-text("Got it")'); if(await fh.count()) await fh.first().click();
// SPY has one more session than the stock (-3% on it); returns must stop at the shared close, so 1D for SPY is not -3%
const r=await p.evaluate(()=>{ const X=window.__ov, o=X.ovSeries('1d'), B=X.bm(X.bench()); return {me:X.retOver(o.p,null,'1d'), sp:X.retOver(o.spy,null,'1d'), lastMe:o.p.t.at(-1), lastSp:o.spy.t.at(-1), rawSp:B.d.t.at(-1), lab:X.asOfClose()}; });
console.log('align',JSON.stringify(r));
if(r.lastMe!==r.lastSp) throw new Error('stock and benchmark end on different sessions');
if(Math.abs(r.sp+3)<0.01) throw new Error('benchmark 1D used the extra session');
const strip=await p.locator('.pshead').innerText(); console.log('strip',strip); if(!/as of/.test(strip)) throw new Error('no as-of label');
// weekly periods end on the same close too
const w=await p.evaluate(()=>{ const X=window.__ov, o=X.ovSeries('5y'); return [X.dayOf(o.p.t.at(-1))<=X.commonDay(), X.dayOf(o.spy.t.at(-1))<=X.commonDay()]; }); if(w.includes(false)) throw new Error('weekly series past the shared close');
// definition tips: on by default, statement and metric labels get one, toggle turns them off
await p.click('#rail button[data-step="financials"]'); await p.waitForTimeout(400);
const n1=await p.locator('#main [data-gl]').count(); console.log('tips labelled',n1); if(n1<5) throw new Error('tips not attached');
await p.locator('#main [data-gl]').first().hover(); await p.waitForTimeout(100); const tip=await p.locator('#glTip').innerText(); console.log('tip',tip.slice(0,80).replace(/\n/g,' | ')); if(!tip) throw new Error('no tip');
await p.click('#tipsBtn'); await p.waitForTimeout(100); const n2=await p.locator('#main [data-gl]').count(); if(n2) throw new Error('tips still on'); await p.click('#tipsBtn');
// glossary has EBT
const hasEBT=await p.evaluate(()=>window.__ov.hasGloss('EBT')); if(!hasEBT) throw new Error('EBT missing');
console.log('ERR',errs.filter(e=>!/get-identity/.test(e))); if(errs.filter(e=>!/get-identity/.test(e)).length) process.exit(1); await b.close();
