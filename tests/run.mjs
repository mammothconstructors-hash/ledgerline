// Runs every test against the built site in ./site. Fails (exit 1) on any page error, console error or horizontal overflow.
import { spawnSync } from 'child_process';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const dir=path.dirname(fileURLToPath(import.meta.url)); fs.mkdirSync(dir+'/out',{recursive:true});
const tests=['audit.mjs','treact.mjs','tres2.mjs','tmet.mjs','tmetq.mjs','tov.mjs','tcb.mjs','tqs.mjs','tfeat.mjs','tskin.mjs'];
let bad=0;
for(const t of tests){
  const t0=Date.now(); const r=spawnSync(process.execPath,[path.join(dir,t)],{encoding:'utf8',timeout:240000});
  if(process.env.GITHUB_ACTIONS) console.log(`::notice::${t} ${((Date.now()-t0)/1000).toFixed(0)}s exit ${r.status}${r.error?' '+r.error.code:''}`);
  const out=(r.stdout||'')+(r.stderr||'');
  const errs=[...out.matchAll(/PAGEERR[^\n]*/g)].map(m=>m[0]).concat([...out.matchAll(/overflow (\d+)/g)].filter(m=>+m[1]>2).map(m=>'overflow '+m[1]));
  const ok=r.status===0&&!errs.length;
  console.log((ok?'PASS ':'FAIL ')+t+(ok?'':'\n  '+(errs.join('\n  ')||out.split('\n').slice(-8).join('\n  '))));
  if(!ok){ bad++; if(process.env.GITHUB_ACTIONS) console.log('::error::'+t+' failed: '+(errs.join(' | ')||out.split('\n').slice(-6).join(' | ')).slice(0,900)); }
}
console.log(bad?`${bad} test file(s) failed`:'all tests passed'); process.exit(bad?1:0);
