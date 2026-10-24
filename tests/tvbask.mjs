// KGR Vol Board Ask AI panel: opens, sends the screen and glossary in vol mode, renders the answer and sources, phone + desktop, light + dark.
import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = ROOT + '/tests/out';
const html = fs.readFileSync(ROOT + '/vol-board/index.html', 'utf8');
const b = await chromium.launch(); const bad = []; let sent = null;
for (const [w, h] of [[1280, 900], [390, 844]]) for (const mode of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: mode });
  p.on('pageerror', e => console.log(`${w} ${mode} PAGEERR ${e.message}`));
  await p.route('**/*', r => { const u = r.request().url();
    if (u === 'https://vol-board.pages.dev/') return r.fulfill({ contentType: 'text/html', body: html });
    if (u.endsWith('/api/ask')) { sent = JSON.parse(r.request().postData()); return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ question: sent.question, answer: "**Vol drag ≈ (L² − L)/2 × σ².** For TQQQ, L = 3, so drag ≈ 3 × σ² [D].\n\n- QQQ IV30 is 24% [D:QQQ], so drag ≈ 3 × 0.24² ≈ **17% a year**\n- Rates are steady this week [W1]\n\n| L | σ 20% | σ 30% |\n|---|---|---|\n| 3 | 12% | 27% |", webSources: [{ id: 'W1', url: 'https://example.com/a', title: 'Rates steady' }] }) }); }
    return r.fulfill({ status: 404, body: '' }); });
  await p.goto('https://vol-board.pages.dev/'); await p.waitForTimeout(1200);
  await p.click('#kaskFab'); await p.waitForTimeout(400);
  await p.click('#kaskB .kask-chips button'); await p.waitForTimeout(800);
  const ok = await p.evaluate(() => { const a = document.querySelector('.kask-item'); return !!a && !!a.querySelector('ul li') && !/\*\*/.test(a.textContent) && a.querySelectorAll('.kask-src a').length === 1 && document.getElementById('kask').classList.contains('open'); });
  if (!ok) bad.push(`${w} ${mode} answer did not render`);
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ov > 2) bad.push(`${w} ${mode} overflow ${ov}`);
  await p.screenshot({ path: `${OUT}/vbask_${w}_${mode}.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  if (await p.evaluate(() => document.getElementById('kask').classList.contains('open'))) bad.push(`${w} ${mode} Escape did not close`);
  await p.close();
}
await b.close();
if (!sent || sent.mode !== 'vol' || !/Board glossary/.test(sent.context) || sent.context.length < 2000) bad.push('context not sent in vol mode (' + (sent && sent.context.length) + ')');
console.log(bad.length ? 'PROBLEMS\n' + bad.join('\n') : 'vol board ask ok (context ' + sent.context.length + ' chars)');
process.exit(bad.length ? 1 : 0);
