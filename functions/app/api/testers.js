// Owner-only tester management for LedgerLine (Cloudflare Pages Function, behind Cloudflare Access).
// Access puts the signed-in email on every request; only the owner's emails may read or change testers.
// Changes are queued in D1 (tester_queue); the sec-proxy worker applies them with its own token within about 2 minutes
// and keeps a copy of every site's tester list in settings.tester_cache.
const OWNERS = ['kgrodrigue@yahoo.com', 'mammothconstructors@gmail.com'];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export async function onRequest({ request, env }) {
  const who = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (!OWNERS.includes(who)) return json({ error: 'Owner only' }, 403);
  if (!env.DB) return json({ error: 'Database not connected to the site' }, 500);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tester_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, name TEXT, sites TEXT DEFAULT 'LedgerLine', action TEXT DEFAULT 'add', done INTEGER DEFAULT 0, result TEXT)").run();
  if (request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 80), action = ['add', 'remove', 'rename'].includes(b.action) ? b.action : 'add';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'That is not an email address' }, 400);
    if (action === 'remove' && OWNERS.includes(email)) return json({ error: 'You can’t remove the owner (that would lock you out).' }, 400);
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
  return json({ me: who, cache, queue: q });
}
