// Account page: Home and Account buttons, profile, beta and paid subscription states, plan cycle switch, comparison table; light + dark, phone + desktop.
import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = ROOT + '/tests/out', HTML = fs.readFileSync(ROOT + '/site/app/index.html', 'utf8');
const b = await chromium.launch(); const bad = [];
for (const [w, h, mode, paid, who] of [[1280, 1000, 'light', false, 'kgrodrigue@yahoo.com'], [1280, 1000, 'dark', true, 'tester@example.com'], [390, 844, 'dark', false, 'a.very.long.customer.name.here@example-company.com'], [390, 844, 'light', true, 'kgrodrigue@yahoo.com']]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: mode }); p.on('pageerror', e => console.log(`${w} PAGEERR ${e.message}`));
  await p.route('https://fonts.googleapis.com/**', r => r.abort());
  await p.route('**/cdn-cgi/access/get-identity', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ email: who }) }));
  await p.route('https://sec-proxy.mammothconstructors.workers.dev/**', r => { const u = new URL(r.request().url());
    if (u.pathname === '/billing/status') return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(paid ? { billing: true, trialDays: 21, open: { monthly: true, annual: true, 'founding-monthly': true, 'founding-annual': true }, subscription: { status: 'trialing', plan: 'Founding member · annual', trialEnd: 1793000000, periodEnd: 1793000000 } } : { billing: false, open: {}, trialDays: 21 }) });
    return r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }); });
  await p.route('https://ledgerline-dv0.pages.dev/app/', r => r.fulfill({ contentType: 'text/html', body: HTML }));
  await p.goto('https://ledgerline-dv0.pages.dev/app/'); await p.waitForTimeout(1200);
  if (!(await p.locator('#homeLink').isVisible())) bad.push(w + ' Home button missing');
  await p.click('#acctBtn'); await p.waitForTimeout(900);
  const t = await p.locator('#main').innerText();
  const owner = who === 'kgrodrigue@yahoo.com';
  for (const need of ['Profile', 'Subscription']) if (!t.includes(need)) bad.push(`${w} missing "${need}"`);
  if (owner) { for (const need of ['Founding member', 'Standard', 'How LedgerLine compares', 'FAST Graphs', 'GuruFocus', 'Bloomberg Terminal', 'Finviz Elite', 'cancel anytime', 'Owner preview']) if (!t.toLowerCase().includes(need.toLowerCase())) bad.push(`${w} owner missing "${need}"`);
    await p.click('[data-cyc="m"]'); await p.waitForTimeout(200); if (!(await p.locator('#main').innerText()).includes('$12')) bad.push(w + ' monthly switch failed'); await p.click('[data-cyc="y"]'); await p.waitForTimeout(200); }
  else { if (/\$1[29]\b|How LedgerLine compares/.test(t)) bad.push(w + ' tester sees prices during beta'); if (!/free during the private beta/i.test(t)) bad.push(w + ' tester beta note missing'); if (paid && !/Trial ends/.test(t)) bad.push(w + ' paid state not shown'); }
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ov > 2) bad.push(`${w} overflow ${ov}`);
  await p.screenshot({ path: `${OUT}/acct_${w}_${mode}.png`, fullPage: true });
  await p.click('#homeLink'); await p.waitForTimeout(300); if (await p.locator('text=How LedgerLine compares').count()) bad.push(w + ' Home did not leave Account');
  await p.close();
}
await b.close(); console.log(bad.length ? 'PROBLEMS\n' + bad.join('\n') : 'account ok'); process.exit(bad.length ? 1 : 0);
