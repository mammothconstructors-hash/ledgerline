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
const mk=async (w,h)=>{ const p=await b.newPage({viewport:{width:w,height:h}}); p.on('pageerror',e=>errs.push(w+' PAGEERR '+e.message+' '+(e.stack||'').split('\n').slice(1,3).join(' | '))); p.on('console',m=>{ if(m.type()==='error'&&!/ERR_FAILED|net::/.test(m.text())) errs.push('CONSOLE '+m.text()); });
 await p.route('https://fonts.googleapis.com/**',r=>r.abort()); await p.route('https://fonts.gstatic.com/**',r=>r.abort());
 await p.route('https://sec-proxy.mammothconstructors.workers.dev/api/**', async r=>{ const u=new URL(r.request().url()); const t=u.searchParams.get('ticker')||u.searchParams.get('symbol');
  let body, st=200; if(u.pathname==='/api/statements'){ if(['SPY','ASML','VOO'].includes(t)){ st=502; body={error:'No annual 10-K data found for '+t}; } else body=JSON.parse(JSON.stringify(sec)); }
  else if(u.pathname==='/api/profile') body={name:'COSTCO',exchanges:['NASDAQ'],earnings:earn}; else if(u.pathname==='/api/market') body=market(100+t.length*20); else if(u.pathname==='/api/section') body={form:'10-K',filed:'2026-02-01',url:'x',text:'Item 1 Business. We own property.'}; else body={results:[]};
  await r.fulfill({status:st,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)}); });
 return p; };
const p=await mk(1280,900);
await p.goto(SITE+'/app/index.html?t=COST'); await p.waitForTimeout(1500);
await p.click('#rail button[data-step="metrics"]'); await p.waitForTimeout(300);
if(await p.locator('[data-mview="years"]').count()) await p.click('[data-mview="years"]'); await p.waitForTimeout(200);
console.log('chart link', (await p.locator('.cblink').innerText()).replace(/\n/g,' '));
const h1=await p.locator('.mtbl thead th').nth(1).innerText(); await p.click('[data-sord="old"]'); await p.waitForTimeout(200); const h2=await p.locator('.mtbl thead th').nth(1).innerText(); console.log('order', h1,'->',h2);
await p.locator('tr.pickrow', {hasText:'Net margin'}).first().click(); await p.waitForTimeout(200); console.log('after pick', (await p.locator('.cblink').innerText()).replace(/\n/g,' ').slice(0,80));
await p.screenshot({path:OUT+'/metq_annual.png'});
await p.click('[data-rper="q"]'); await p.waitForTimeout(300); console.log('quarterly rows', await p.locator('.mtbl tbody tr.pickrow').count(), 'head', await p.locator('.mtbl thead th').nth(1).innerText());
await p.click('[data-sord="new"]'); await p.click('[data-rper="a"]');
const m=await mk(390,800); await m.goto(SITE+'/app/index.html?t=COST'); await m.waitForTimeout(1500); await m.click('#rail button[data-step="metrics"]'); await m.waitForTimeout(300); console.log('mobile overflow', await m.evaluate(()=>document.documentElement.scrollWidth-innerWidth));
console.log('ERR',errs.filter(e=>!/get-identity/.test(e))); await b.close();
