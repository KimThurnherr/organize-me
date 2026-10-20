'use strict';
// Flechte - Haushalts-PWA: Chores, To-dos, Gäste-Rhythmus, Teamziel, Web-Push.
// Keine externen Abhängigkeiten: node:http, node:sqlite, node:crypto.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- Konfiguration ----------
const env = process.env;
const PORT = +(env.PORT || 8080);
const PUBLIC_URL = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const TZ = env.TZ || 'Europe/Zurich';
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_URL = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const AI_DAILY_LIMIT = +(env.AI_DAILY_LIMIT || 60);
const DEV_LOGIN = env.DEV_LOGIN === '1'; // nur lokal zum Testen
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
// ALLOWED_USERS="alex:alex@example.com,sam:sam@example.com" (Reihenfolge zählt für die Standard-Aufgaben)
const USERS = Object.fromEntries((env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim().toLowerCase()];
}));
const USER_NAMES = Object.fromEntries((env.USER_NAMES || '').split(',').filter(s => s.includes(':')).map(s => s.split(':').map(x => x.trim())).map(([k, v]) => [k.toLowerCase(), v]));
if (!Object.keys(USERS).length) console.warn('WARNUNG: ALLOWED_USERS ist leer, niemand kann sich anmelden.');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'flechte.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS chores (id INTEGER PRIMARY KEY, name TEXT NOT NULL, interval_days INTEGER NOT NULL, points INTEGER NOT NULL, assignee TEXT NOT NULL, last_done TEXT, last_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, due TEXT, assignee TEXT, done INTEGER NOT NULL DEFAULT 0, done_by TEXT, done_at TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, date TEXT NOT NULL, note TEXT, by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS visit_guests (visit_id INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE, guest_id INTEGER NOT NULL, PRIMARY KEY (visit_id, guest_id));
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, by TEXT, points INTEGER NOT NULL, type TEXT, label TEXT, ref TEXT, date TEXT NOT NULL, at TEXT);
CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, user TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS user_settings (user TEXT PRIMARY KEY, morning TEXT NOT NULL DEFAULT '09:00', evening TEXT NOT NULL DEFAULT '18:00');
CREATE TABLE IF NOT EXISTS push_sent (user TEXT, slot TEXT, date TEXT, PRIMARY KEY (user, slot, date));
CREATE TABLE IF NOT EXISTS meals (date TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT, updated_by TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS ai_usage (user TEXT, date TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user, date));
`);
const q = (sql) => db.prepare(sql);
const meta = {
  get: (k, d) => { const r = q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : d; },
  set: (k, v) => q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
};

// Session-Secret und VAPID-Schlüssel einmalig erzeugen und im Datenvolume halten
let SESSION_SECRET = env.SESSION_SECRET || meta.get('session_secret');
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); meta.set('session_secret', SESSION_SECRET); }
let vapidJwk = meta.get('vapid_jwk');
if (!vapidJwk) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vapidJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  meta.set('vapid_jwk', vapidJwk);
}
const VAPID_PRIVATE = crypto.createPrivateKey({ key: JSON.parse(vapidJwk), format: 'jwk' });
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const VAPID_PUBLIC = (() => { const j = JSON.parse(vapidJwk); return b64u(Buffer.concat([Buffer.from([4]), fromB64u(j.x), fromB64u(j.y)])); })();

// Standard-Aufgaben beim ersten Start: 0 = erste Person in ALLOWED_USERS, 1 = zweite (Entsorgung)
if (meta.get('seeded') !== '1' && Object.keys(USERS).length) {
  const keys = Object.keys(USERS);
  const seed = [
    ['Geschirrspüler ausräumen', 1, 2, 0],
    ['Küche aufräumen und Abdeckungen wischen', 2, 3, 0],
    ['Kehricht rausbringen', 3, 3, 1],
    ['Altpapier und Karton bündeln', 14, 5, 1],
    ['Glas, PET und Alu entsorgen', 14, 5, 1],
    ['Wäsche waschen', 4, 5, 0],
    ['Pflanzen giessen', 4, 3, 0],
    ['Staubsaugen', 7, 10, 0],
    ['Bad putzen', 7, 15, 0],
    ['WC putzen', 7, 8, 0],
    ['Kühlschrank ausmisten', 7, 5, 0],
    ['Wocheneinkauf', 7, 8, 0],
    ['Boden feucht wischen', 14, 10, 0],
    ['Staub wischen', 14, 8, 0],
    ['Bettwäsche wechseln', 14, 10, 0],
    ['Backofen reinigen', 60, 15, 0],
    ['Fenster putzen', 90, 20, 0],
  ];
  const ins = q('INSERT INTO chores(name,interval_days,points,assignee,created_at) VALUES(?,?,?,?,?)');
  for (const [n, iv, p, who] of seed) ins.run(n, iv, p, keys[who] || keys[0], new Date().toISOString());
  meta.set('team_goal', 120);
  meta.set('seeded', '1');
}

// ---------- Datum (lokal in TZ) ----------
const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function localNow() { const p = Object.fromEntries(partsFmt.formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; }
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const daysSince = s => dayNum(localNow().date) - dayNum(s);
const weekStart = s => { const n = dayNum(s); return n - ((new Date(n * 864e5).getUTCDay() + 6) % 7); };
const dateStr = n => new Date(n * 864e5).toISOString().slice(0, 10);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dayNum(s));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// Erste Fälligkeiten verteilen, damit nicht alle Aufgaben am selben Tag fällig sind (einmalig)
if (meta.get('staggered') !== '1') {
  const today = dayNum(localNow().date);
  const rows = q('SELECT * FROM chores WHERE last_done IS NULL ORDER BY interval_days, id').all();
  rows.forEach((c, i) => {
    if (q("SELECT 1 FROM log WHERE type='chore' AND ref=?").get(String(c.id))) return;
    const offset = c.interval_days <= 1 ? 1 : (i % c.interval_days) + 1; // fällig in 0 .. interval-1 Tagen
    q('UPDATE chores SET last_done=? WHERE id=?').run(dateStr(today - offset), c.id);
  });
  meta.set('staggered', '1');
}

// ---------- Session ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeSession(user) { const v = b64u(JSON.stringify({ u: user, exp: Date.now() + 180 * 864e5 })); return v + '.' + sign(v); }
function readSession(req) {
  const c = parseCookies(req).flechte_session; if (!c) return null;
  const [v, s] = c.split('.'); if (!v || !s) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(fromB64u(v)); if (d.exp < Date.now() || !USERS[d.u]) return null; return d.u; } catch { return null; }
}
function parseCookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function cookie(name, val, maxAge) { return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`; }

// ---------- HTTP-Helfer ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com",
};
if (SECURE_COOKIE) SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000';
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, loc, extra = {}) { res.writeHead(302, { Location: loc, ...SEC_HEADERS, ...extra }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const isUser = (u) => Object.prototype.hasOwnProperty.call(USERS, u);

// Login-Versuche begrenzen (Callback)
const rl = new Map();
function rateLimited(ip, limit = 30) { const now = Date.now(); const e = rl.get(ip) || { n: 0, t: now }; if (now - e.t > 6e5) { e.n = 0; e.t = now; } e.n++; rl.set(ip, e); return e.n > limit; }

// ---------- Statische Dateien ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    const cache = ext === '.png' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SEC_HEADERS, ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    res.end(buf);
  });
}

// ---------- Zustand für das Frontend ----------
function state(user) {
  return {
    me: user,
    users: Object.keys(USERS).map(k => ({ key: k, name: USER_NAMES[k] || k.charAt(0).toUpperCase() + k.slice(1) })),
    today: localNow().date,
    teamGoal: +meta.get('team_goal', 120),
    vapidPublicKey: VAPID_PUBLIC,
    settings: q('SELECT morning, evening FROM user_settings WHERE user=?').get(user) || { morning: '09:00', evening: '18:00' },
    chores: q('SELECT * FROM chores ORDER BY name').all(),
    todos: q("SELECT * FROM todos WHERE done=0 OR done_at >= ? ORDER BY done, COALESCE(due, '9999'), id").all(new Date(Date.now() - 14 * 864e5).toISOString()),
    guests: q('SELECT * FROM guests ORDER BY name COLLATE NOCASE').all(),
    visits: q('SELECT * FROM visits ORDER BY date DESC, id DESC LIMIT 200').all().map(v => ({ ...v, guestIds: q('SELECT guest_id FROM visit_guests WHERE visit_id=?').all(v.id).map(r => r.guest_id) })),
    log: q('SELECT by, points, type, date FROM log WHERE date >= ? ORDER BY date').all(new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)),
    totalPoints: q('SELECT COALESCE(SUM(points),0) AS s FROM log').get().s,
    meals: q('SELECT date, title, note FROM meals WHERE date >= ? AND date <= ? ORDER BY date').all(dateStr(weekStart(localNow().date) - 7), dateStr(weekStart(localNow().date) + 13)),
    mealIdeas: q('SELECT title, COUNT(*) AS n FROM meals GROUP BY lower(title) ORDER BY n DESC, max(date) DESC LIMIT 60').all().map(r => r.title),
    aiEnabled: !!ANTHROPIC_API_KEY,
  };
}

function addLog(by, points, type, label, ref, date) {
  q('INSERT INTO log(by,points,type,label,ref,date,at) VALUES(?,?,?,?,?,?,?)').run(by, points, type, label, String(ref ?? ''), date || localNow().date, new Date().toISOString());
}

// ---------- API ----------
async function api(req, res, user, route) {
  const m = req.method;
  // CSRF: schreibende Requests nur mit eigenem Header (SameSite=Lax + kein CORS)
  if (m !== 'GET' && req.headers['x-flechte'] !== '1') return send(res, 403, { error: 'csrf' });
  const body = m === 'GET' ? {} : await readBody(req);
  const today = localNow().date;
  let mm;

  if (m === 'GET' && route === 'state') return send(res, 200, state(user));

  // Chores
  if (m === 'POST' && route === 'chores') {
    const name = str(body.name, 80), iv = int(body.interval_days, 1, 365), pts = int(body.points, 1, 100), as = str(body.assignee, 20);
    if (!name || !iv || !pts || !isUser(as)) return send(res, 400, { error: 'Bitte Name, Intervall, Punkte und Person angeben.' });
    q('INSERT INTO chores(name,interval_days,points,assignee,created_at) VALUES(?,?,?,?,?)').run(name, iv, pts, as, new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if ((mm = route.match(/^chores\/(\d+)$/))) {
    const c = q('SELECT * FROM chores WHERE id=?').get(+mm[1]); if (!c) return send(res, 404, { error: 'Aufgabe nicht gefunden' });
    if (m === 'DELETE') { q('DELETE FROM chores WHERE id=?').run(c.id); return send(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const name = body.name !== undefined ? str(body.name, 80) : c.name;
      const iv = body.interval_days !== undefined ? int(body.interval_days, 1, 365) : c.interval_days;
      const pts = body.points !== undefined ? int(body.points, 1, 100) : c.points;
      const as = body.assignee !== undefined ? str(body.assignee, 20) : c.assignee;
      if (!name || !iv || !pts || !isUser(as)) return send(res, 400, { error: 'Ungültige Angaben' });
      q('UPDATE chores SET name=?, interval_days=?, points=?, assignee=? WHERE id=?').run(name, iv, pts, as, c.id);
      return send(res, 200, { ok: true });
    }
  }
  if ((mm = route.match(/^chores\/(\d+)\/done$/)) && m === 'POST') {
    const c = q('SELECT * FROM chores WHERE id=?').get(+mm[1]); if (!c) return send(res, 404, { error: 'Aufgabe nicht gefunden' });
    if (c.last_done === today) return send(res, 409, { error: 'Heute schon erledigt' });
    q('UPDATE chores SET last_done=?, last_by=? WHERE id=?').run(today, user, c.id);
    addLog(user, c.points, 'chore', c.name, c.id);
    return send(res, 200, { ok: true, points: c.points });
  }

  // To-dos
  if (m === 'POST' && route === 'todos') {
    const title = str(body.title, 140), due = body.due ? str(body.due, 10) : '', as = str(body.assignee, 20);
    if (!title) return send(res, 400, { error: 'Bitte einen Titel angeben.' });
    if (due && !isDate(due)) return send(res, 400, { error: 'Ungültiges Datum' });
    if (as && !isUser(as)) return send(res, 400, { error: 'Ungültige Person' });
    q('INSERT INTO todos(title,due,assignee,created_by,created_at) VALUES(?,?,?,?,?)').run(title, due || null, as || null, user, new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if ((mm = route.match(/^todos\/(\d+)$/)) && m === 'DELETE') { q('DELETE FROM todos WHERE id=?').run(+mm[1]); q("DELETE FROM log WHERE type='todo' AND ref=?").run(mm[1]); return send(res, 200, { ok: true }); }
  if ((mm = route.match(/^todos\/(\d+)\/toggle$/)) && m === 'POST') {
    const t = q('SELECT * FROM todos WHERE id=?').get(+mm[1]); if (!t) return send(res, 404, { error: 'To-do nicht gefunden' });
    if (!t.done) { q('UPDATE todos SET done=1, done_by=?, done_at=? WHERE id=?').run(user, new Date().toISOString(), t.id); addLog(user, 5, 'todo', t.title, t.id); return send(res, 200, { ok: true, points: 5 }); }
    q('UPDATE todos SET done=0, done_by=NULL, done_at=NULL WHERE id=?').run(t.id); q("DELETE FROM log WHERE type='todo' AND ref=?").run(String(t.id));
    return send(res, 200, { ok: true });
  }

  // Essensplan
  if (m === 'POST' && route === 'meals') {
    const r = setMeal(user, body.date, body.title, body.note);
    if (r.error) return send(res, 400, r);
    return send(res, 200, r);
  }

  // KI
  if (m === 'POST' && route === 'ai') return await aiChat(req, res, user, body);

  // Gäste
  if (m === 'POST' && route === 'guests') {
    const name = str(body.name, 80); if (!name) return send(res, 400, { error: 'Bitte einen Namen angeben.' });
    q('INSERT INTO guests(name,created_at) VALUES(?,?)').run(name, new Date().toISOString()); return send(res, 200, { ok: true });
  }
  if ((mm = route.match(/^guests\/(\d+)$/)) && m === 'DELETE') { q('DELETE FROM guests WHERE id=?').run(+mm[1]); q('DELETE FROM visit_guests WHERE guest_id=?').run(+mm[1]); return send(res, 200, { ok: true }); }
  if (m === 'POST' && route === 'visits') {
    const date = str(body.date, 10), note = str(body.note, 200);
    const ids = Array.isArray(body.guestIds) ? [...new Set(body.guestIds.map(Number).filter(Number.isInteger))].slice(0, 30) : [];
    if (!isDate(date) || dayNum(date) > dayNum(today)) return send(res, 400, { error: 'Ungültiges Datum' });
    if (!ids.length) return send(res, 400, { error: 'Bitte mindestens eine Person auswählen.' });
    const r = q('INSERT INTO visits(date,note,by,created_at) VALUES(?,?,?,?)').run(date, note, user, new Date().toISOString());
    const vid = Number(r.lastInsertRowid);
    for (const g of ids) if (q('SELECT 1 FROM guests WHERE id=?').get(g)) q('INSERT OR IGNORE INTO visit_guests(visit_id,guest_id) VALUES(?,?)').run(vid, g);
    for (const u of Object.keys(USERS)) addLog(u, 10, 'visit', 'Gäste', vid, date);
    return send(res, 200, { ok: true, points: 10 });
  }
  if ((mm = route.match(/^visits\/(\d+)$/)) && m === 'DELETE') { q('DELETE FROM visits WHERE id=?').run(+mm[1]); q("DELETE FROM log WHERE type='visit' AND ref=?").run(mm[1]); return send(res, 200, { ok: true }); }

  // Einstellungen
  if (m === 'POST' && route === 'settings') {
    const mo = str(body.morning, 5), ev = str(body.evening, 5);
    if (!isTime(mo) || !isTime(ev)) return send(res, 400, { error: 'Ungültige Uhrzeit' });
    q('INSERT INTO user_settings(user,morning,evening) VALUES(?,?,?) ON CONFLICT(user) DO UPDATE SET morning=excluded.morning, evening=excluded.evening').run(user, mo, ev);
    if (body.teamGoal !== undefined) { const g = int(body.teamGoal, 10, 2000); if (!g) return send(res, 400, { error: 'Ungültiges Teamziel' }); meta.set('team_goal', g); }
    return send(res, 200, { ok: true });
  }

  // Push-Abos
  if (m === 'POST' && route === 'push/subscribe') {
    const ep = str(body.endpoint, 1000), p = str(body.keys?.p256dh, 200), a = str(body.keys?.auth, 100);
    if (!/^https:\/\//.test(ep) || !p || !a) return send(res, 400, { error: 'Ungültiges Abo' });
    q('INSERT INTO subs(endpoint,user,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user=excluded.user, p256dh=excluded.p256dh, auth=excluded.auth').run(ep, user, p, a, new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && route === 'push/unsubscribe') { q('DELETE FROM subs WHERE endpoint=? AND user=?').run(str(body.endpoint, 1000), user); return send(res, 200, { ok: true }); }
  if (m === 'POST' && route === 'push/test') {
    const n = await pushToUser(user, { title: 'Flechte', body: 'Test erfolgreich. So sehen die Erinnerungen aus.', url: '/' });
    return send(res, 200, { ok: true, sent: n });
  }

  return send(res, 404, { error: 'Unbekannte Aktion' });
}

// ---------- Essensplan ----------
function setMeal(user, date, title, note) {
  date = str(date, 10); title = str(title, 120); note = str(note, 300);
  if (!isDate(date)) return { error: 'Ungültiges Datum' };
  if (!title) { q('DELETE FROM meals WHERE date=?').run(date); return { ok: true, removed: true }; }
  q('INSERT INTO meals(date,title,note,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET title=excluded.title, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at').run(date, title, note, user, new Date().toISOString());
  // Wochenplan mit mindestens 5 Tagen gibt einmal pro Woche 10 Punkte
  const ws = weekStart(date);
  const n = q('SELECT COUNT(*) AS n FROM meals WHERE date >= ? AND date <= ?').get(dateStr(ws), dateStr(ws + 6)).n;
  let points = 0;
  if (n >= 5 && !q("SELECT 1 FROM log WHERE type='plan' AND ref=?").get(String(ws))) { addLog(user, 10, 'plan', 'Essensplan', ws); points = 10; }
  return { ok: true, points };
}

// ---------- KI (Anthropic Messages API) ----------
const AI_TOOLS = [
  { name: 'set_meal', description: 'Trägt ein Gericht für ein Datum in den Essensplan ein oder ersetzt es. Leerer Titel löscht den Eintrag.', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, title: { type: 'string' }, note: { type: 'string' } }, required: ['date', 'title'] } },
  { name: 'add_todo', description: 'Legt ein To-do an, z.B. Einkaufsliste oder Erledigungen.', input_schema: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD, optional' }, assignee: { type: 'string', description: 'Schlüssel der Person, leer für beide' } }, required: ['title'] } },
];
function aiContext(user) {
  const st = state(user), today = st.today;
  const names = Object.fromEntries(st.users.map(u => [u.key, u.name]));
  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const lines = [];
  lines.push(`Heute: ${wd[new Date(dayNum(today) * 864e5).getUTCDay()]} ${today}. Angemeldet: ${names[user]} (Schlüssel ${user}). Personen: ${st.users.map(u => `${u.name}=${u.key}`).join(', ')}.`);
  lines.push('Essensplan: ' + (st.meals.map(x => `${x.date} (${wd[new Date(dayNum(x.date) * 864e5).getUTCDay()]}): ${x.title}${x.note ? ' – ' + x.note : ''}`).join('; ') || 'leer'));
  lines.push('Bisher gekochte Gerichte: ' + (st.mealIdeas.slice(0, 40).join(', ') || 'keine'));
  lines.push('Haushaltsaufgaben: ' + st.chores.map(c => `${c.name} (${names[c.assignee]}, alle ${c.interval_days} Tage, zuletzt ${c.last_by ? c.last_done : 'unbekannt'})`).join('; '));
  lines.push('Offene To-dos: ' + (st.todos.filter(t => !t.done).map(t => `${t.title}${t.due ? ' bis ' + t.due : ''}${t.assignee ? ' für ' + names[t.assignee] : ''}`).join('; ') || 'keine'));
  const lastVisit = st.visits[0]?.date;
  lines.push(`Gäste: Ziel jede Woche jemand zu Gast. Letzter Besuch: ${lastVisit || 'noch keiner'}. Freunde: ${st.guests.map(g => g.name).join(', ') || 'keine erfasst'}.`);
  return lines.join('\n');
}
async function aiChat(req, res, user, body) {
  if (!ANTHROPIC_API_KEY) return send(res, 503, { error: 'Die KI ist noch nicht eingerichtet.' });
  const today = localNow().date;
  const used = q('SELECT n FROM ai_usage WHERE user=? AND date=?').get(user, today)?.n || 0;
  if (used >= AI_DAILY_LIMIT) return send(res, 429, { error: 'Tageslimit für Fragen erreicht.' });
  q('INSERT INTO ai_usage(user,date,n) VALUES(?,?,1) ON CONFLICT(user,date) DO UPDATE SET n=n+1').run(user, today);
  const hist = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const messages = hist.filter(x => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && x.content.trim()).map(x => ({ role: x.role, content: x.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return send(res, 400, { error: 'Keine Frage' });
  while (messages[0]?.role !== 'user') messages.shift();
  const system = 'Du bist der Haushaltsassistent in der App «Flechte» eines Paares in der Schweiz. Antworte auf Deutsch (Schweizer Schreibweise mit ss statt ß), kurz, freundlich und konkret, ohne Emojis. ' +
    'Hilf bei Fragen wie «Was soll ich heute kochen?», Rezepten, Einkaufslisten, Haushalt und Einladungen. Nutze die Daten unten. ' +
    'Ändere den Essensplan oder lege To-dos nur an, wenn die Person das ausdrücklich möchte. Erfinde keine Daten.\n\nAktuelle Daten:\n' + aiContext(user);
  const actions = [];
  let reply = '';
  for (let round = 0; round < 5; round++) {
    const r = await fetch(ANTHROPIC_URL + '/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1500, system, tools: AI_TOOLS, messages }) });
    if (!r.ok) { console.error('KI-Fehler', r.status, (await r.text()).slice(0, 300)); return send(res, 502, { error: 'Die KI ist gerade nicht erreichbar.' }); }
    const d = await r.json();
    reply = d.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || reply;
    const uses = d.content.filter(c => c.type === 'tool_use');
    if (d.stop_reason !== 'tool_use' || !uses.length) break;
    messages.push({ role: 'assistant', content: d.content });
    const results = uses.map(u => {
      let out;
      try {
        if (u.name === 'set_meal') { out = setMeal(user, u.input.date, u.input.title, u.input.note); if (!out.error) actions.push(`Essensplan ${fmt(u.input.date)}: ${u.input.title || 'entfernt'}`); }
        else if (u.name === 'add_todo') {
          const title = str(u.input.title, 140), due = u.input.due ? str(u.input.due, 10) : '', as = str(u.input.assignee, 20);
          if (!title || (due && !isDate(due)) || (as && !isUser(as))) out = { error: 'Ungültige Angaben' };
          else { q('INSERT INTO todos(title,due,assignee,created_by,created_at) VALUES(?,?,?,?,?)').run(title, due || null, as || null, user, new Date().toISOString()); out = { ok: true }; actions.push('To-do: ' + title); }
        } else out = { error: 'Unbekanntes Werkzeug' };
      } catch (e) { out = { error: e.message }; }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), is_error: !!out.error };
    });
    messages.push({ role: 'user', content: results });
  }
  return send(res, 200, { reply: reply || 'Erledigt.', actions });
}
const fmt = s => s ? s.split('-').reverse().join('.') : '';

// ---------- Web Push (RFC 8291 / RFC 8292) ----------
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function encryptPayload(sub, payload) {
  const uaPub = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(); const shared = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || PUBLIC_URL }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: VAPID_PRIVATE, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}
async function sendPush(sub, data) {
  const body = encryptPayload(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '43200', Urgency: 'normal', Authorization: vapidAuth(sub.endpoint) }, body });
  if (r.status === 404 || r.status === 410) { q('DELETE FROM subs WHERE endpoint=?').run(sub.endpoint); return false; }
  if (!r.ok) { console.error('Push fehlgeschlagen', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}
async function pushToUser(user, data) {
  let n = 0;
  for (const s of q('SELECT * FROM subs WHERE user=?').all(user)) { try { if (await sendPush(s, data)) n++; } catch (e) { console.error('Push-Fehler', e.message); } }
  return n;
}

// Was ist für diese Person fällig?
function dueFor(user) {
  const today = localNow().date;
  const chores = q('SELECT * FROM chores WHERE assignee=?').all(user).filter(c => !c.last_done || daysSince(c.last_done) >= c.interval_days);
  const todos = q('SELECT * FROM todos WHERE done=0 AND due IS NOT NULL AND due <= ? AND (assignee IS NULL OR assignee=?)').all(today, user);
  const lastVisit = q('SELECT date FROM visits ORDER BY date DESC LIMIT 1').get()?.date;
  const guestDays = lastVisit ? daysSince(lastVisit) : null;
  return { chores, todos, guestOverdue: guestDays === null ? false : guestDays >= 7, guestDays };
}
function buildMessage(user, slot) {
  const d = dueFor(user);
  const lines = [];
  if (d.chores.length) lines.push((d.chores.length === 1 ? 'Fällig: ' : `${d.chores.length} Aufgaben fällig: `) + d.chores.slice(0, 4).map(c => c.name).join(', ') + (d.chores.length > 4 ? ' …' : ''));
  if (d.todos.length) lines.push((d.todos.length === 1 ? 'To-do: ' : `${d.todos.length} To-dos: `) + d.todos.slice(0, 3).map(t => t.title).join(', ') + (d.todos.length > 3 ? ' …' : ''));
  if (d.guestOverdue) lines.push(`Seit ${d.guestDays} Tagen kein Besuch. Wen ladet ihr ein?`);
  const today = localNow().date, dnum = dayNum(today);
  const meal = q('SELECT title FROM meals WHERE date=?').get(today);
  if (slot === 'morning') lines.unshift(meal ? `Heute gibt es: ${meal.title}` : 'Für heute ist noch kein Essen geplant.');
  // Sonntag: Plan für die nächste Woche
  if (new Date(dnum * 864e5).getUTCDay() === 0) {
    const n = q('SELECT COUNT(*) AS n FROM meals WHERE date >= ? AND date <= ?').get(dateStr(dnum + 1), dateStr(dnum + 7)).n;
    if (n < 5) lines.push(`Essensplan für nächste Woche: erst ${n} von 7 Tagen geplant.`);
  }
  if (!lines.length) return null;
  const goal = +meta.get('team_goal', 120);
  const ws = weekStart(localNow().date);
  const team = q('SELECT by, points, date FROM log WHERE date >= ?').all(new Date((ws - 1) * 864e5).toISOString().slice(0, 10)).filter(e => weekStart(e.date) === ws).reduce((a, e) => a + e.points, 0);
  const title = slot === 'morning' ? 'Guten Morgen' : 'Kurzer Check am Abend';
  return { title, body: lines.join('\n') + `\nTeamziel: ${team}/${goal} Punkte`, url: '/', tag: 'flechte-' + slot };
}
async function scheduler() {
  const now = localNow();
  for (const user of Object.keys(USERS)) {
    const s = q('SELECT morning, evening FROM user_settings WHERE user=?').get(user) || { morning: '09:00', evening: '18:00' };
    for (const slot of ['morning', 'evening']) {
      if (now.time < s[slot]) continue;
      // nur innerhalb von 3 Stunden nach der Uhrzeit nachholen, einmal pro Tag
      const [h, mi] = s[slot].split(':').map(Number), [nh, nmi] = now.time.split(':').map(Number);
      if ((nh * 60 + nmi) - (h * 60 + mi) > 180) continue;
      if (q('SELECT 1 FROM push_sent WHERE user=? AND slot=? AND date=?').get(user, slot, now.date)) continue;
      q('INSERT INTO push_sent(user,slot,date) VALUES(?,?,?)').run(user, slot, now.date);
      const msg = buildMessage(user, slot);
      if (msg) await pushToUser(user, msg);
    }
  }
  q('DELETE FROM push_sent WHERE date < ?').run(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
}
setInterval(() => scheduler().catch(e => console.error('Scheduler', e)), 60 * 1000);

// ---------- Google-Login ----------
const REDIRECT_URI = PUBLIC_URL + '/auth/callback';
function loginStart(res) {
  if (!GOOGLE_CLIENT_ID) return send(res, 500, 'Google-Login ist nicht konfiguriert.', 'text/plain; charset=utf-8');
  const st = crypto.randomBytes(16).toString('hex');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email', state: st, prompt: 'select_account' });
  redirect(res, u.toString(), { 'Set-Cookie': cookie('flechte_state', st, 600) });
}
async function loginCallback(req, res, url) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, 'Zu viele Versuche. Bitte später nochmals.', 'text/plain; charset=utf-8');
  const st = parseCookies(req).flechte_state, code = url.searchParams.get('code');
  if (!st || st !== url.searchParams.get('state') || !code) return redirect(res, '/?login=fehler');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }) });
  if (!r.ok) { console.error('Token-Fehler', r.status); return redirect(res, '/?login=fehler'); }
  const tok = await r.json();
  let claims; try { claims = JSON.parse(fromB64u(tok.id_token.split('.')[1])); } catch { return redirect(res, '/?login=fehler'); }
  // id_token kommt direkt von Google über TLS mit Client-Secret: Claims prüfen
  if (claims.aud !== GOOGLE_CLIENT_ID || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.exp * 1000 < Date.now() || !claims.email_verified) return redirect(res, '/?login=fehler');
  const email = String(claims.email).toLowerCase();
  const user = Object.keys(USERS).find(k => USERS[k] === email);
  if (!user) { console.warn('Login abgelehnt für', email); return redirect(res, '/?login=nicht-erlaubt', { 'Set-Cookie': cookie('flechte_state', '', 0) }); }
  res.setHeader('Set-Cookie', [cookie('flechte_session', makeSession(user), 180 * 86400), cookie('flechte_state', '', 0)]);
  redirect(res, '/');
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/auth/login') return loginStart(res);
    if (p === '/auth/callback') return await loginCallback(req, res, url);
    if (p === '/auth/dev' && DEV_LOGIN) { const u = url.searchParams.get('u'); if (isUser(u)) return redirect(res, '/', { 'Set-Cookie': cookie('flechte_session', makeSession(u), 86400) }); }
    if (p === '/auth/logout' && req.method === 'POST') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('flechte_session', '', 0) });
    if (p.startsWith('/api/')) {
      const user = readSession(req);
      if (!user) return send(res, 401, { error: 'Nicht angemeldet' });
      return await api(req, res, user, p.slice(5).replace(/\/$/, ''));
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    return serveStatic(res, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.message === 'too_large' ? 413 : e.message === 'bad_json' ? 400 : 500, { error: 'Fehler' });
  }
});
server.listen(PORT, () => console.log(`Flechte läuft auf Port ${PORT} (${PUBLIC_URL})`));
