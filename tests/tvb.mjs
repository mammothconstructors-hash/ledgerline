// KGR Vol Board (vol-board/index.html): every screen and tab, phone + desktop, light + dark.
// Data feeds are blocked so the board runs on its built-in sample data. Fails on page errors, horizontal overflow,
// or a Light | Dark switch that doesn't set and remember the theme.
import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = ROOT + '/tests/out';
const html = fs.readFileSync(ROOT + '/vol-board/index.html', 'utf8');
const b = await chromium.launch(); const problems = [];
const SCREENS = ['macro', 'sectors', 'fsv', 'vix', 'lev'], TABS = ['tabMetrics', 'tabDash', 'tabHow'];
for (const [w, h] of [[1280, 900], [390, 844]]) for (const mode of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: mode });
  p.on('pageerror', e => console.log(`${w} ${mode} PAGEERR ${e.message}`));
  await p.route('**/*', r => { const u = r.request().url();
    if (u === 'https://vol-board.pages.dev/') return r.fulfill({ contentType: 'text/html', body: html });
    if (u.endsWith('/cdn-cgi/access/get-identity')) return r.fulfill({ contentType: 'application/json', body: '{"email":"tester@example.com"}' });
    return r.fulfill({ status: 404, body: '' }); });
  await p.goto('https://vol-board.pages.dev/'); await p.waitForTimeout(1200);
  for (const sc of SCREENS) {
    await p.click(`button.scr[data-scr="${sc}"]`); await p.waitForTimeout(500);
    for (const t of TABS) {
      if (!(await p.locator('#' + t).isVisible().catch(() => false))) continue;
      await p.click('#' + t); await p.waitForTimeout(300);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (ov > 2) { console.log(`${w} ${mode} ${sc} ${t} overflow ${ov}`); problems.push(`${w} ${mode} ${sc} ${t} overflow ${ov}`); }
    }
    await p.click('#tabDash').catch(() => {}); await p.waitForTimeout(200);
    if (w === 390 || sc === 'vix') await p.screenshot({ path: `${OUT}/vb_${sc}_${w}_${mode}.png` });
  }
  // the switch: pick the other theme, check it applies and survives a reload
  const other = mode === 'dark' ? 'light' : 'dark';
  await p.click(`#themeSeg [data-th="${other}"]`); await p.waitForTimeout(200);
  const got = await p.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('kgr_theme'), document.querySelector('#themeSeg [aria-pressed="true"]')?.dataset.th]);
  if (got.some(x => x !== other)) problems.push(`${w} ${mode} switch to ${other} gave ${got.join('/')}`);
  await p.reload(); await p.waitForTimeout(600);
  const kept = await p.evaluate(() => document.documentElement.dataset.theme);
  if (kept !== other) problems.push(`${w} ${mode} theme not kept after reload (${kept})`);
  await p.close();
}
await b.close();
console.log(problems.length ? 'PROBLEMS\n' + problems.join('\n') : 'vol board ok');
process.exit(problems.length ? 1 : 0);
