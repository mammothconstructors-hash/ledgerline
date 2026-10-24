// Owner-only tester management for LedgerLine (Cloudflare Pages Function, behind Cloudflare Access).
// Access puts the signed-in email on every request; only the owner's emails may read or change testers.
// Changes are queued in D1 (tester_queue); the sec-proxy worker applies them with its own token within about 2 minutes
// and keeps a copy of every site's tester list in settings.tester_cache.
const OWNERS = ['kgrodrigue@yahoo.com'];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export async function onRequest({ request, env }) {
  const who = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (!OWNERS.includes(who)) return json({ error: 'Owner only' }, 403);
  if (!env.DB) return json({ error: 'Database not connected to the site' }, 500);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tester_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, name TEXT, sites TEXT DEFAULT 'LedgerLine', action TEXT DEFAULT 'add', done INTEGER DEFAULT 0, result TEXT)").run();
  if (request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (b.action === 'admins') {   // up to 5 admin emails, left out of the user count with the two owner emails
      const list = [...new Set((Array.isArray(b.admins) ? b.admins : []).map(x => String(x).trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && !OWNERS.includes(x)))];
      if (list.length > 5) return json({ error: 'Up to 5 admins.' }, 400);
      await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('admins', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(list)).run();
      return json({ ok: true, admins: list });
    }
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 80), action = ['add', 'remove', 'rename'].includes(b.action) ? b.action : 'add';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'That is not an email address' }, 400);
    if (action === 'remove' && OWNERS.includes(email)) return json({ error: 'You can’t remove the owner (that would lock you out).' }, 400);
    if (action === 'rename') { await env.DB.prepare('CREATE TABLE IF NOT EXISTS testers (email TEXT PRIMARY KEY, name TEXT, added INTEGER)').run(); await env.DB.prepare('INSERT INTO testers (email, name, added) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name').bind(email, name, Date.now()).run(); return json({ ok: true, renamed: true }); }
    const sites = Array.isArray(b.sites) && b.sites.length ? b.sites.map(String).join(',') : 'LedgerLine';
    await env.DB.prepare('INSERT INTO tester_queue (email, name, sites, action) VALUES (?, ?, ?, ?)').bind(email, name, sites, action).run();
    if (name) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS testers (email TEXT PRIMARY KEY, name TEXT, added INTEGER)').run(); await env.DB.prepare('INSERT INTO testers (email, name, added) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name').bind(email, name, Date.now()).run(); }
    return json({ ok: true, queued: true });
  }
  const c = await env.DB.prepare("SELECT v FROM settings WHERE k = 'tester_cache'").first().catch(() => null);
  const q = (await env.DB.prepare('SELECT id, email, name, sites, action, done, result FROM tester_queue ORDER BY id DESC LIMIT 15').all()).results || [];
  let names = {}; try { ((await env.DB.prepare('SELECT email, name FROM testers').all()).results || []).forEach(r => { names[r.email] = r.name; }); } catch (e) { }
  const cache = c && c.v ? JSON.parse(c.v) : null;
  if (cache) cache.sites.forEach(s => s.emails.forEach(e => { e.name = names[e.email.toLowerCase()] || e.name || ''; }));
  // live presence: both sites ping the worker on open and every 60 s while on screen (worker 3.18.0), read straight from D1
  let presence = [], signins = [];
  try { presence = (await env.DB.prepare('SELECT email, site, first_ts, last_ts, screen FROM presence ORDER BY last_ts DESC LIMIT 200').all()).results || []; } catch (e) { }
  try { signins = (await env.DB.prepare('SELECT email, site, ts FROM signins ORDER BY ts DESC LIMIT 30').all()).results || []; } catch (e) { }
  presence.forEach(p => { p.name = names[p.email] || ''; }); signins.forEach(p => { p.name = names[p.email] || ''; });
  let admins = []; try { const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admins'").first(); admins = r && r.v ? JSON.parse(r.v) : []; } catch (e) { }
  return json({ me: who, owners: OWNERS, admins, cache, queue: q, presence, signins, now: Math.floor(Date.now() / 1000) });
}
