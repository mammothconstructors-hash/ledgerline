import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const SITE='file://'+ROOT+'/site'; const OUT=ROOT+'/tests/out';
const b=await chromium.launch(); const errs=[];
for(const pg of ['features.html','index.html','terms.html','privacy.html','welcome.html']) for(const [w,h,sch] of [[1280,900,'light'],[390,800,'light'],[1280,900,'dark']]){
 const p=await b.newPage({viewport:{width:w,height:h},colorScheme:sch}); p.on('pageerror',e=>errs.push(e.message));
 await p.route('https://fonts.**',r=>r.abort());
 await p.goto(SITE+'/'+pg); await p.waitForTimeout(300);
 console.log(pg,w,sch,'overflow',await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth));
 await p.screenshot({path:`${OUT}/${pg.replace('.html','')}_${w}_${sch}.png`,fullPage:true});
}
console.log('ERR',errs); await b.close();
