// Testers tab (owner only): User count leaves out both owner emails and the named admins; Save admins posts the list; phone + desktop, light + dark.
import { chromium } from 'playwright';
import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT = ROOT + '/tests/out', HTML = fs.readFileSync(ROOT + '/site/app/index.html', 'utf8');
const now = Math.floor(Date.now() / 1000), E = (email, login) => ({ email, name: '', login: login ? Date.now() : null });
const DATA = { me: 'kgrodrigue@yahoo.com', admins: ['help@example.com'], now, queue: [], signins: [],
  presence: [{ email: 'ann@example.com', site: 'LedgerLine', first_ts: now - 300, last_ts: now - 20 }, { email: 'kgrodrigue@yahoo.com', site: 'LedgerLine', first_ts: now - 300, last_ts: now - 10 }],
  cache: { t: Date.now(), sites: [
    { name: 'LedgerLine', domain: 'ledgerline-dv0.pages.dev', emails: [E('kgrodrigue@yahoo.com', 1), E('help@example.com', 1), E('ann@example.com', 1), E('bob@example.com', 0)] },
    { name: 'KGR Vol Board', domain: 'vol-board.pages.dev', emails: [E('kgrodrigue@yahoo.com', 1), E('ann@example.com', 1), E('cy@example.com', 1)] }] } };
const b = await chromium.launch(); const bad = [];
for (const [w, h, mode] of [[1280, 1000, 'light'], [390, 844, 'dark']]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: mode }); p.on('pageerror', e => bad.push(`${w} PAGEERR ${e.message}`));
  let posted = null;
  await p.route('**/*', r => { const u = r.request().url();
    if (u === 'https://ledgerline-dv0.pages.dev/app/') return r.fulfill({ contentType: 'text/html', body: HTML });
    if (u.endsWith('/cdn-cgi/access/get-identity')) return r.fulfill({ contentType: 'application/json', body: '{"email":"kgrodrigue@yahoo.com"}' });
    if (u.endsWith('/app/api/testers')) { if (r.request().method() === 'POST') { posted = JSON.parse(r.request().postData()); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, admins: posted.admins }) }); } return r.fulfill({ contentType: 'application/json', body: JSON.stringify(DATA) }); }
    return r.fulfill({ status: 404, body: '' }); });
  await p.goto('https://ledgerline-dv0.pages.dev/app/'); await p.waitForTimeout(1200);
  await p.click('#tstBtn'); await p.waitForTimeout(800);
  const t = await p.locator('#main').innerText();
  // users = ann, bob, cy (3); signed in = ann, cy (2); online = ann (1); seats = everyone signed in: owner, help, ann, cy (4)
  for (const need of ['User count', '3\nUsers', '2\nHave signed in', '1\nOnline now', '4 / 50']) if (!t.includes(need)) bad.push(`${w} missing "${need.replace('\n', ' ')}"`);
  if (!/admin/.test(t)) bad.push(w + ' admin tag missing');
  await p.fill('#tsAdmins', 'help@example.com, two@example.com'); await p.click('[data-tsadm]'); await p.waitForTimeout(500);
  if (!posted || posted.action !== 'admins' || posted.admins.join() !== 'help@example.com,two@example.com') bad.push(w + ' save admins posted ' + JSON.stringify(posted));
  await p.fill('#tsAdmins', 'a@x.co,b@x.co,c@x.co,d@x.co,e@x.co,f@x.co'); posted = null; await p.click('[data-tsadm]'); await p.waitForTimeout(300);
  if (posted) bad.push(w + ' allowed 6 admins');
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ov > 2) bad.push(`${w} overflow ${ov}`);
  await p.screenshot({ path: `${OUT}/testers_${w}_${mode}.png`, fullPage: true }); await p.close();
}
await b.close(); console.log(bad.length ? 'PROBLEMS\n' + bad.join('\n') : 'testers ok'); process.exit(bad.length ? 1 : 0);
