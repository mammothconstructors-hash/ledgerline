import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P=lambda *a: os.path.join(ROOT,*a)
import re, random
idx=open(P('site','index.html')).read()
root=re.search(r':root\{.*?\n:root\[data-theme="dark"\]\{.*?\}',idx,re.S).group(0)
header=re.search(r'<header class="top">.*?</header>',idx,re.S).group(0)
footer=re.search(r'<footer class="wrap">.*?</footer>',idx,re.S).group(0)
brand=re.search(r'<a class="brand".*?</a>',header,re.S).group(0)
header='<header class="top"><div class="wrap">'+brand+'<nav class="tn"><a href="/features.html" aria-current="page">Features</a><a href="/#beta">Beta</a><a class="login" href="/app/">Start here</a></nav></div></header>'
body=open(P('tools','features','body.html')).read()
body=body.replace('<p>Net sales increased <mark>10%</mark> during 2026, driven by comparable sales growth and new warehouses…</p>','<p>Results of operations · <mark>Net sales</mark> · Gross margin · Liquidity and capital resources · Critical accounting estimates</p>')
body=body.replace('<span class="cap real">Costco · Oct 22, 2026</span>','<span class="cap">Illustration · 49% is Costco’s figure on Oct 22, 2026</span>')
# distribution
random.seed(4); import math
xs=[i for i in range(-12,36,2)]; bars=''
for i,x in enumerate(xs):
    h=math.exp(-((x-9.8)/9)**2/2)*100
    c='var(--teal)' if x>=10 else 'var(--line)'
    bars+=f'<i style="height:{h:.0f}%;background:{c}"></i>'
body=body.replace('${DIST}',bars)
# tests
tests=[('Average ROIC',5),('Years ROIC 15%+',5),('Gross margin',3),('Margin stability',5),('FCF margin',2),('Down years',5),('Balance sheet',5)]
body=body.replace('${TESTS}','<span class="mk">Moat · seven tests</span>'+''.join(f'<div class="tr"><span>{a}</span><span class="pips">'+''.join(f'<i class="{"on" if k<v else ""} l{v}"></i>' for k in range(5))+f'</span><b>{v}</b></div>' for a,v in tests))
# chart: costco revenue/NI FY2015-2026 (real, $B)
rev=[116.199,118.719,129.025,141.576,152.703,166.761,195.929,226.954,242.290,254.453,275.235,303.154]
ni=[2.377,2.350,2.679,3.134,3.659,4.002,5.007,5.844,6.292,7.367,8.099,9.226]
yrs=list(range(2015,2027)); W,H=320,150; pb=20; mx=320; L0=34
bw=(W-L0)/len(rev); svg=f'<svg viewBox="0 0 {W} {H}" class="ill" role="img" aria-label="Costco revenue and net income">'
for g in (100,200,300):
    y=H-pb-g/mx*(H-pb-8); svg+=f'<line x1="{L0}" x2="{W}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/><text x="2" y="{y-3:.1f}" class="t">${g}B</text>'
for i,(r,n) in enumerate(zip(rev,ni)):
    x=L0+i*bw; hr=r/mx*(H-pb-8); hn=n*10/mx*(H-pb-8)
    svg+=f'<rect x="{x+bw*.14:.1f}" y="{H-pb-hr:.1f}" width="{bw*.36:.1f}" height="{hr:.1f}" fill="#0D7680"/><rect x="{x+bw*.52:.1f}" y="{H-pb-hn:.1f}" width="{bw*.36:.1f}" height="{hn:.1f}" fill="#990F3D"/>'
    if i%2==1: svg+=f'<text x="{x+bw/2:.1f}" y="{H-6}" class="t" text-anchor="middle">FY{str(yrs[i])[2:]}</text>'
# tooltip on last
x=L0+150; svg+=f'<g><rect x="{x-122:.0f}" y="6" width="148" height="40" rx="3" class="tip"/><text x="{x-114:.0f}" y="21" class="t b">FY2026</text><text x="{x-114:.0f}" y="36" class="t">Revenue $303.2B · +10.1%</text></g>'
svg+='</svg>'
body=body.replace('${CHART}',svg.replace('Revenue $303.2B · +10.1%','Revenue $303.2B +10.1%'))
body=body.replace('<span><i style="background:#990F3D"></i>Net income ×</span>','<span><i style="background:#990F3D"></i>Net income ×10 ×</span>')
# ratios
rat=[('P/E',48.1,'above 10-yr median'),('ROIC',42.6,'above'),('FCF yield',2.1,'below'),('Net debt ÷ EBITDA',-0.6,'net cash')]
body=body.replace('${RATIOS}','<span class="mk">Ratios by fiscal year</span>'+''.join(f'<div class="rr"><span>{a}</span><span class="sp">'+''.join(f'<i style="height:{20+((j*37+len(a)*11)%60)}%"></i>' for j in range(10))+f'</span><b>{b if b>=0 else "cash"}{"%" if a in ("ROIC","FCF yield") else ("×" if b>=0 else "")}</b></div>' for a,b,c in rat))
# quarterly bars
q=[1.6,1.9,1.7,2.4,1.8,2.2,2.0,2.8,2.1,2.5,2.3,3.1]; qs='<svg viewBox="0 0 320 150" class="ill" role="img" aria-label="EPS by quarter">'
for i,v in enumerate(q):
    h=v/3.3*118; qs+=f'<rect x="{i*26.6+4:.1f}" y="{130-h:.1f}" width="18" height="{h:.1f}" fill="{"var(--claret)" if i==11 else "var(--teal)"}" opacity="{1 if i==11 else .75}"/>'
qs+='<text x="2" y="146" class="t">12 quarters</text><text x="318" y="146" class="t" text-anchor="end">latest</text></svg>'
body=body.replace('${QBARS}','<span class="mk">EPS by quarter</span>'+qs)
# OHLC bars black
random.seed(7); p=100; o=''; e=[]; ema=None
for i in range(46):
    op=p; p=p*(1+random.gauss(0.004,0.018)); hi=max(op,p)*(1+abs(random.gauss(0,.006))); lo=min(op,p)*(1-abs(random.gauss(0,.006)))
    e.append((i,op,hi,lo,p))
ps=[v for t in e for v in t[1:]]; mn,mxp=min(ps),max(ps); Y=lambda v:8+(mxp-v)/(mxp-mn)*118
ohlc='<svg viewBox="0 0 320 140" class="ill" role="img" aria-label="Price as OHLC bars">'
em=[];k=2/(12+1);s=None
for i,op,hi,lo,c in e:
    x=6+i*6.8; s=c if s is None else c*k+s*(1-k); em.append((x,s))
    ohlc+=f'<path d="M{x:.1f} {Y(hi):.1f}V{Y(lo):.1f}M{x-2.4:.1f} {Y(op):.1f}H{x:.1f}M{x:.1f} {Y(c):.1f}H{x+2.4:.1f}" stroke="var(--ink)" stroke-width="1.2" fill="none"/>'
ohlc+='<path d="'+' '.join(('M' if j==0 else 'L')+f'{x:.1f} {Y(v):.1f}' for j,(x,v) in enumerate(em))+'" stroke="var(--teal)" stroke-width="1.8" fill="none"/>'
lin=[(x,em[0][1]+(em[-1][1]-em[0][1])*j/(len(em)-1)*0.8) for j,(x,_) in enumerate(em)]
ohlc+='<path d="'+' '.join(('M' if j==0 else 'L')+f'{x:.1f} {Y(v)+10:.1f}' for j,(x,v) in enumerate(lin))+'" stroke="var(--claret)" stroke-width="1.6" fill="none"/></svg>'
body=body.replace('${OHLC}',ohlc)
# vs market
vs=[('Stock',14.2),('SPY',11.1),('QQQ',15.6),('DIA',8.4),('IWM',5.2)]
body=body.replace('${VS}','<span class="mk">5-year return, a year</span>'+''.join(f'<div class="vr{" me" if a=="Stock" else ""}"><span>{a}</span><span class="bar"><i style="width:{v/16*100:.0f}%"></i></span><b>+{v}%</b></div>' for a,v in vs)+'<span class="mk sm">Pick the benchmark on any chart</span>')
# idx real
top=[('NVDA',7.52),('AAPL',6.59),('MSFT',4.30),('AMZN',3.62),('GOOGL',3.25),('AVGO',2.77)]
body=body.replace('${IDX}',''.join(f'<div class="vr"><span>{a}</span><span class="bar"><i style="width:{v/7.6*100:.0f}%"></i></span><b>{v:.2f}%</b></div>' for a,v in top))
# screens
scr=['Cash machines','Shrinking share count','Dividend raisers','Net cash fortresses','Compounders','Fast growers','Quality with low debt','Cash machines buying back','Covered dividend raisers','High-margin businesses','Growing without dilution','Watch the debt']
body=body.replace('${SCREENS}','<div class="sg">'+''.join(f'<span class="{"warn" if s=="Watch the debt" else ""}">{s}</span>' for s in scr)+'</div>')
assert '${' not in body
css=open(P('tools','features','style.css')).read()
head=re.search(r'<!doctype html>.*?<style>',idx,re.S).group(0)
head=head.replace('<title>LedgerLine · Know what you own</title>','<title>LedgerLine Features</title>')
head=re.sub(r'<meta name="description"[^>]*>\s*<meta name="description"[^>]*>','<meta name="description" content="Everything LedgerLine does: scores and a verdict from SEC filings, full statements with interactive charts, earnings reactions with BMO/AMC timing, technicals, prebuilt screens and a plain-English glossary.">',head,1)
out=head+'\n'+root+'\n'+css+'\n</style></head><body>\n'+header+'\n'+body+'\n'+footer+'\n</body></html>'
open(P('site','features.html'),'w').write(out)
print(len(out))
