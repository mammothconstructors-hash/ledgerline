// Builds the glossary data (line items with their XBRL tags, every metric, SEC filing terms, market terms) into app-src.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const load=f=>{ const src=fs.readFileSync(path.join(ROOT,'tools',f),'utf8'); return new Function(src+';return {GL_LINES:typeof GL_LINES!=="undefined"?GL_LINES:null,GL_METRICS:typeof GL_METRICS!=="undefined"?GL_METRICS:null,GL_SEC:typeof GL_SEC!=="undefined"?GL_SEC:null,GL_MARKET:typeof GL_MARKET!=="undefined"?GL_MARKET:null};')(); };
const A=load('glossary_items.js'), B=load('glossary_sec.js');
const W=fs.readFileSync(path.join(ROOT,'worker/src/index.js'),'utf8');
// statement sections: which rows belong to which statement
const secOf={}; const secNames={IS:'Income statement',BS:'Balance sheet',CF:'Cash flow',OCI:'Comprehensive income'};
for(const [v,label] of Object.entries(secNames)){ const m=W.match(new RegExp('const '+v+' = \\[([\\s\\S]*?)\\n\\];')); if(!m) continue; for(const r of m[1].matchAll(/\['([a-zA-Z]+)', '([^']*)', \[([^\]]*)\]/g)) secOf[r[1]]={label,name:r[2],tags:[...r[3].matchAll(/'([A-Za-z]+)'/g)].map(x=>x[1]).slice(0,4)}; }
const secId={'Income statement':'income','Balance sheet':'balance','Cash flow':'cashflow','Comprehensive income':'oci'};
const out=[];
for(const [k,[aka,def]] of Object.entries(A.GL_LINES)){ const r=secOf[k]; if(!r){ console.error('no row for',k); continue; }
  out.push({t:r.name,c:r.label,a:aka,d:def,x:r.tags,tab:'Financials',id:secId[r.label]+'|'+k}); }
const app=fs.readFileSync(path.join(ROOT,'app-src/Stockings.html'),'utf8');
const a=app.indexOf('function ratiosHtml(collect)'), blk=app.slice(app.indexOf('const defs=[',a), app.indexOf('\n  ];',app.indexOf('const defs=[',a)));
let grp=''; const grpOf={}; for(const m of blk.matchAll(/\['([^'\]]+)'(\]|,)/g)){ if(m[2]===']') grp=m[1]; else grpOf[m[1]]=grp; }
for(const [n,[f,d,g]] of Object.entries(A.GL_METRICS)){ if(!grpOf[n]) console.error('metric not on All metrics:',n);
  out.push({t:n,c:'Metrics',s:grpOf[n]||'',f,d,g:g||'',tab:'All metrics',id:'r|'+n.toLowerCase()}); }
for(const [t,s,a2,d,g] of B.GL_SEC) out.push({t,c:'SEC filings',s,a:a2,d,g:g||''});
for(const [t,s,a2,d,g] of B.GL_MARKET) out.push({t,c:s==='Concepts'?'Investing concepts':'Price & risk',a:a2,d,g:g||''});
out.sort((x,y)=>x.t.localeCompare(y.t,'en',{numeric:true,sensitivity:'base'}));
const json=JSON.stringify(out);
let s=app; const i=s.indexOf('const GLOSS=');
const j=s.includes('/*END_GL*/')?s.indexOf('/*END_GL*/;',i)+11:s.indexOf('\n];',i)+3;
if(i<0||j<11) throw new Error('GLOSS block not found');
s=s.slice(0,i)+'const GLOSS=/*GL_DATA*/'+json+'/*END_GL*/;'+s.slice(j);
fs.writeFileSync(path.join(ROOT,'app-src/Stockings.html'),s);
const by={}; out.forEach(o=>by[o.c]=(by[o.c]||0)+1); console.log('glossary',out.length,JSON.stringify(by));
