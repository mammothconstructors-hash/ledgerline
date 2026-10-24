import { chromium } from 'playwright'; import fs from 'fs';
import path from 'path'; import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), SITE='file://'+ROOT+'/site', OUT=ROOT+'/tests/out';
const sec=JSON.parse(fs.readFileSync(ROOT+'/tests/fixtures/sec.json','utf8'));
const b=await chromium.launch(); const errs=[]; let sent=null;
for(const mode of ['light','dark']){
const p=await b.newPage({viewport:{width:1200,height:1300},colorScheme:mode}); p.on('pageerror',e=>errs.push(e.message));
await p.addInitScript(()=>{ window.SITE=true; });
await p.route('https://fonts.googleapis.com/**',r=>r.abort());
await p.route('https://sec-proxy.mammothconstructors.workers.dev/api/**', async r=>{ const u=new URL(r.request().url()); let body={};
 if(u.pathname==='/api/statements') body=sec; else if(u.pathname==='/api/profile') body={name:'ADVANCED MICRO DEVICES',sic:'3674',exchanges:['NASDAQ']};
 else if(u.pathname==='/api/market'){ const n=600,t=[],c=[]; let x=80; for(let i=0;i<n;i++){t.push(1700000000+i*86400);x*=1+(Math.random()-.5)*.02;c.push(x);} body={daily:{t,o:c,h:c,l:c,c,v:c.map(()=>1e6)},weekly:{t,o:c,h:c,l:c,c,v:c.map(()=>1e6)},price:x,prevClose:x,high52:x*1.2,low52:x*.8,asOf:t[n-1]}; }
 else if(u.pathname==='/api/ask'){ sent=JSON.parse(r.request().postData()); body={ticker:'AMD',question:sent.question,answer:"**Yes, one notable case.** AMD is defending a patent suit in Delaware [S1], and press reports say a ruling is due next month [W1].\n\nWhat matters for the stock:\n- Price is **12% below** its 52-week high [D]\n- NVDA trades at a higher multiple [D:NVDA]\n\n| Item | AMD | NVDA |\n|---|---|---|\n| P/E | 38 | 45 |",sources:[{id:'S1',ticker:'AMD',form:'10-K',section:'Legal proceedings',filed:'2026-02-04',url:'https://www.sec.gov/x'}],webSources:[{id:'W1',url:'https://www.reuters.com/a',title:'AMD patent trial set'}],looked:['NVDA']}; }
 await r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)}); });
await p.goto(SITE+'/app/index.html?t=AMD'); await p.waitForTimeout(1800);
await p.click('#rail button[data-step="ask"]'); await p.waitForTimeout(300);
await p.fill('#askQ','any lawsuits?'); await p.click('[data-askgo]'); await p.waitForTimeout(1200);
const ok=await p.evaluate(()=>{ const a=document.querySelector('.askans'); return a&&a.querySelector('ul li')&&a.querySelector('b')&&!/\*\*/.test(a.textContent)&&a.querySelectorAll('.asksrc .srcrow').length===3; }); if(!ok) console.log('PAGEERR answer did not render ('+mode+')');
await p.locator('.askans').first().screenshot({path:`${OUT}/ask_${mode}.png`});
await p.locator('#rail').screenshot({path:`${OUT}/rail_${mode}.png`});
await p.close(); }
const bad=[]; if(!sent||sent.context.length<5000) bad.push('page data not sent'); for(const t of ['Overview','Valuation','Technicals','Financials']) if(!sent.context.includes('## '+t)) bad.push('missing tab '+t);
errs.forEach(e=>console.log('PAGEERR '+e)); bad.forEach(e=>console.log('PAGEERR '+e)); await b.close(); console.log(bad.length||errs.length?'ask FAILED':'ask ok'); process.exit(bad.length||errs.length?1:0);
