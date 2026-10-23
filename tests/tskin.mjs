// screenshots of key tabs for visual review (desktop light/dark + phone)
import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const SITE='file://'+ROOT+'/site'; const OUT=ROOT+'/tests/out';
const sec=JSON.parse(fs.readFileSync(ROOT+'/tests/fixtures/sec.json','utf8'));
function walk(n,step,start,p0){ const t=[],o=[],h=[],l=[],c=[],v=[]; let p=p0; for(let i=0;i<n;i++){ const ts=start+i*step; const r=(Math.sin(i/9)+Math.sin(i/31))*0.006+(i%7-3)*0.002; const op=p; p=p*(1+r+0.0006); t.push(ts);o.push(op);c.push(p);h.push(Math.max(op,p)*1.008);l.push(Math.min(op,p)*0.992);v.push(1e6+(i%11)*1e5); } return {t,o,h,l,c,v}; }
const now=Math.floor(Date.UTC(2026,9,20)/1000);
function market(base){ const w=walk(530,7*86400,now-529*7*86400,base/4); const d=walk(1300,86400,now-1299*86400,w.c.at(-1)*0.6); const sc=w.c.at(-1)/d.c.at(-1); ['o','h','l','c'].forEach(k=>d[k]=d[k].map(x=>x*sc)); return {price:w.c.at(-1),change:1.2,changePct:0.8,high52:Math.max(...w.c.slice(-52)),low52:Math.min(...w.c.slice(-52)),asOf:now,weekly:w,daily:d,source:'Marketstack (end of day)'}; }
const b=await chromium.launch(); const errs=[];
const mk=async (w,h,sch)=>{ const p=await b.newPage({viewport:{width:w,height:h},colorScheme:sch||'light'}); p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
 await p.route('https://fonts.**',r=>r.abort());
 await p.route('https://sec-proxy.mammothconstructors.workers.dev/api/**', async r=>{ const u=new URL(r.request().url()); const t=u.searchParams.get('ticker')||u.searchParams.get('symbol'); let body;
  if(u.pathname==='/api/statements') body=sec; else if(u.pathname==='/api/profile') body={name:'COSTCO WHOLESALE CORP',exchanges:['NASDAQ'],earnings:[]}; else if(u.pathname==='/api/market') body=market(100+t.length*20); else body={};
  await r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)}); });
 return p; };
const shots=process.argv.slice(2).length?process.argv.slice(2):['overview','valuation','earnings','financials','metrics','technicals'];
for(const [w,h,sch] of [[1360,1000,'light'],[1360,1000,'dark'],[390,860,'light']]){
  const p=await mk(w,h,sch); await p.goto(SITE+'/app/index.html?t=COST'); await p.waitForTimeout(1300);
  const fh=p.locator('button:has-text("Got it")'); if(await fh.count()) await fh.first().click();
  for(const st of shots){ await p.click(`#rail button[data-step="${st}"]`); await p.waitForTimeout(350); const ov=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth); if(ov>2) console.log('OVER',st,w,ov, JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{ if(e.getBoundingClientRect().right<=innerWidth+2) return false; for(let a=e.parentElement;a;a=a.parentElement){ if(getComputedStyle(a).overflowX!=='visible') return false; } return true; }).slice(0,4).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right))))); await p.screenshot({path:`${OUT}/skin_${st}_${w}_${sch}.png`,fullPage:false}); }
  if(w>1000){ await p.click('#rail button[data-step="overview"]'); await p.waitForTimeout(250); await p.click('[data-pxs="line"]'); await p.waitForTimeout(300); await p.locator('.cwrap').first().screenshot({path:`${OUT}/skin_line_${sch}.png`}); await p.click('[data-pxs="bars"]'); await p.waitForTimeout(200); await p.locator('.cwrap').first().screenshot({path:`${OUT}/skin_bars_${sch}.png`}); }
  if(w>1000&&sch==='light'){ await p.click('#rail button[data-step="financials"]'); await p.waitForTimeout(300); await p.click('[data-mct="line"]'); await p.waitForTimeout(300); await p.locator('.mchart').screenshot({path:`${OUT}/mc_line.png`}); await p.click('[data-mct="bars"]'); await p.waitForTimeout(200); }
  console.log(w,sch,'overflow',await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth));
}
console.log('ERR',errs); await b.close();
