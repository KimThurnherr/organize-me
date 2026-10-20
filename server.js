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
const GUEST_REMIND_DAYS = +(env.GUEST_REMIND_DAYS || 60); // so lange nicht mehr da -> Erinnerung
const GUEST_REMIND_REPEAT = +(env.GUEST_REMIND_REPEAT || 14); // danach alle n Tage wiederholen
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
CREATE TABLE IF NOT EXISTS guest_reminders (guest_id INTEGER NOT NULL, user TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (guest_id, user));
CREATE TABLE IF NOT EXISTS health_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, person TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS health_checks (item_id INTEGER NOT NULL, user TEXT NOT NULL, date TEXT NOT NULL, at TEXT, PRIMARY KEY (item_id, user, date));
CREATE TABLE IF NOT EXISTS meals (date TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT, updated_by TEXT, updated_at TEXT);
`);
const q = (sql) => db.prepare(sql);
try { db.exec('ALTER TABLE chores ADD COLUMN due_override TEXT'); } catch { /* Spalte existiert schon */ }
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

if (meta.get('health_seeded') !== '1') {
  const ins = q('INSERT INTO health_items(name,person,created_at) VALUES(?,?,?)');
  for (const n of ['Grüner Shake', 'Nahrungsergänzungsmittel']) ins.run(n, null, new Date().toISOString());
  meta.set('health_seeded', '1');
}

// ---------- Datum (lokal in TZ) ----------
const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function localNow() { const p = Object.fromEntries(partsFmt.formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; }
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const daysSince = s => dayNum(localNow().date) - dayNum(s);
const weekStart = s => { const n = dayNum(s); return n - ((new Date(n * 864e5).getUTCDay() + 6) % 7); };
const dateStr = n => new Date(n * 864e5).toISOString().slice(0, 10);
// Tage bis zur Fälligkeit einer Haushaltsaufgabe (0 = heute, negativ = überfällig)
const choreDueIn = c => c.due_override ? dayNum(c.due_override) - dayNum(localNow().date) : (c.last_done ? c.interval_days - (dayNum(localNow().date) - dayNum(c.last_done)) : 0);
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
    healthToday: healthDay(user),
    longAbsent: longAbsentGuests(),
    guestRemindDays: GUEST_REMIND_DAYS,
    mealIdeas: q('SELECT title, COUNT(*) AS n FROM meals GROUP BY lower(title) ORDER BY n DESC, max(date) DESC LIMIT 60').all().map(r => r.title),
  };
}

function addLog(by, points, type, label, ref, date) {
  q('INSERT INTO log(by,points,type,label,ref,date,at) VALUES(?,?,?,?,?,?,?)').run(by, points, type, label, String(ref ?? ''), date || localNow().date, new Date().toISOString());
}

// ---------- Fachlogik (von Web-API und MCP gemeinsam genutzt) ----------
class OpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new OpError(status, msg); };
const nowIso = () => new Date().toISOString();
const ops = {
  choreAdd(user, b) {
    const name = str(b.name, 80), iv = int(b.interval_days, 1, 365), pts = int(b.points ?? 10, 1, 100), as = str(b.assignee, 20);
    if (!name || !iv || !pts || !isUser(as)) fail(400, 'Bitte Name, Intervall (1-365 Tage), Punkte (1-100) und Person angeben.');
    const due = b.next_due ? str(b.next_due, 10) : '';
    if (due && !isDate(due)) fail(400, 'Ungültiges Datum (YYYY-MM-DD)');
    const r = q('INSERT INTO chores(name,interval_days,points,assignee,due_override,created_at) VALUES(?,?,?,?,?,?)').run(name, iv, pts, as, due || null, nowIso());
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  choreGet(id) { const c = q('SELECT * FROM chores WHERE id=?').get(+id); if (!c) fail(404, 'Aufgabe nicht gefunden'); return c; },
  choreUpdate(id, b) {
    const c = ops.choreGet(id);
    const name = b.name !== undefined ? str(b.name, 80) : c.name;
    const iv = b.interval_days !== undefined ? int(b.interval_days, 1, 365) : c.interval_days;
    const pts = b.points !== undefined ? int(b.points, 1, 100) : c.points;
    const as = b.assignee !== undefined ? str(b.assignee, 20) : c.assignee;
    if (!name || !iv || !pts || !isUser(as)) fail(400, 'Ungültige Angaben');
    let due = c.due_override;
    if (b.next_due !== undefined) { const d = b.next_due === null ? '' : str(b.next_due, 10); if (d && !isDate(d)) fail(400, 'Ungültiges Datum (YYYY-MM-DD)'); due = d || null; }
    q('UPDATE chores SET name=?, interval_days=?, points=?, assignee=?, due_override=? WHERE id=?').run(name, iv, pts, as, due, c.id);
    return { ok: true };
  },
  choreDelete(id) { const c = ops.choreGet(id); q('DELETE FROM chores WHERE id=?').run(c.id); return { ok: true }; },
  choreDone(user, id, date) {
    const c = ops.choreGet(id), today = localNow().date;
    const d = date ? str(date, 10) : today;
    if (!isDate(d) || d > today || dayNum(today) - dayNum(d) > 60) fail(400, 'Ungültiges Datum (nicht in der Zukunft, höchstens 60 Tage zurück)');
    if (q("SELECT 1 FROM log WHERE type='chore' AND ref=? AND date=?").get(String(c.id), d)) fail(409, d === today ? 'Heute schon erledigt' : 'An diesem Tag schon erledigt');
    if (!c.last_by || !c.last_done || d >= c.last_done) q('UPDATE chores SET last_done=?, last_by=?, due_override=NULL WHERE id=?').run(d, user, c.id);
    addLog(user, c.points, 'chore', c.name, c.id, d);
    return { ok: true, points: c.points, date: d };
  },
  choreCompletionDelete(logId) {
    const l = q("SELECT * FROM log WHERE id=? AND type='chore'").get(+logId);
    if (!l) fail(404, 'Eintrag nicht gefunden');
    q('DELETE FROM log WHERE id=?').run(l.id);
    const c = q('SELECT * FROM chores WHERE id=?').get(+l.ref);
    if (c && c.last_by && c.last_done === l.date) {
      const prev = q("SELECT by, date FROM log WHERE type='chore' AND ref=? ORDER BY date DESC, id DESC LIMIT 1").get(String(c.id));
      q('UPDATE chores SET last_done=?, last_by=? WHERE id=?').run(prev?.date || null, prev?.by || null, c.id);
    }
    return { ok: true };
  },
  todoAdd(user, b) {
    const title = str(b.title, 140), due = b.due ? str(b.due, 10) : '', as = b.assignee ? str(b.assignee, 20) : '';
    if (!title) fail(400, 'Bitte einen Titel angeben.');
    if (due && !isDate(due)) fail(400, 'Ungültiges Datum');
    if (as && !isUser(as)) fail(400, 'Ungültige Person');
    const r = q('INSERT INTO todos(title,due,assignee,created_by,created_at) VALUES(?,?,?,?,?)').run(title, due || null, as || null, user, nowIso());
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  todoGet(id) { const t = q('SELECT * FROM todos WHERE id=?').get(+id); if (!t) fail(404, 'To-do nicht gefunden'); return t; },
  todoSetDone(user, id, done) {
    const t = ops.todoGet(id);
    if (done && !t.done) { q('UPDATE todos SET done=1, done_by=?, done_at=? WHERE id=?').run(user, nowIso(), t.id); addLog(user, 5, 'todo', t.title, t.id); return { ok: true, points: 5 }; }
    if (!done && t.done) { q('UPDATE todos SET done=0, done_by=NULL, done_at=NULL WHERE id=?').run(t.id); q("DELETE FROM log WHERE type='todo' AND ref=?").run(String(t.id)); }
    return { ok: true };
  },
  todoUpdate(id, b) {
    const t = ops.todoGet(id);
    const title = b.title !== undefined ? str(b.title, 140) : t.title;
    const due = b.due !== undefined ? (b.due === null ? '' : str(b.due, 10)) : (t.due || '');
    const as = b.assignee !== undefined ? (b.assignee === null ? '' : str(b.assignee, 20)) : (t.assignee || '');
    if (!title) fail(400, 'Titel darf nicht leer sein');
    if (due && !isDate(due)) fail(400, 'Ungültiges Datum (YYYY-MM-DD)');
    if (as && !isUser(as)) fail(400, 'Ungültige Person');
    q('UPDATE todos SET title=?, due=?, assignee=? WHERE id=?').run(title, due || null, as || null, t.id);
    return { ok: true };
  },
  todoDelete(id) { const t = ops.todoGet(id); q('DELETE FROM todos WHERE id=?').run(t.id); q("DELETE FROM log WHERE type='todo' AND ref=?").run(String(t.id)); return { ok: true }; },
  mealSet(user, date, title, note) { const r = setMeal(user, date, title, note); if (r.error) fail(400, r.error); return r; },
  guestAdd(b) { const name = str(b.name, 80); if (!name) fail(400, 'Bitte einen Namen angeben.'); const r = q('INSERT INTO guests(name,created_at) VALUES(?,?)').run(name, nowIso()); return { ok: true, id: Number(r.lastInsertRowid) }; },
  guestDelete(id) { if (!q('SELECT 1 FROM guests WHERE id=?').get(+id)) fail(404, 'Person nicht gefunden'); q('DELETE FROM guests WHERE id=?').run(+id); q('DELETE FROM visit_guests WHERE guest_id=?').run(+id); q('DELETE FROM guest_reminders WHERE guest_id=?').run(+id); return { ok: true }; },
  visitAdd(user, b) {
    const date = str(b.date, 10), note = str(b.note, 200), today = localNow().date;
    const ids = Array.isArray(b.guestIds) ? [...new Set(b.guestIds.map(Number).filter(Number.isInteger))].slice(0, 30) : [];
    if (!isDate(date) || dayNum(date) > dayNum(today)) fail(400, 'Ungültiges Datum (nicht in der Zukunft)');
    const valid = ids.filter(g => q('SELECT 1 FROM guests WHERE id=?').get(g));
    if (!valid.length) fail(400, 'Bitte mindestens eine erfasste Person angeben.');
    const r = q('INSERT INTO visits(date,note,by,created_at) VALUES(?,?,?,?)').run(date, note, user, nowIso());
    const vid = Number(r.lastInsertRowid);
    for (const g of valid) q('INSERT OR IGNORE INTO visit_guests(visit_id,guest_id) VALUES(?,?)').run(vid, g);
    for (const u of Object.keys(USERS)) addLog(u, 10, 'visit', 'Gäste', vid, date);
    return { ok: true, id: vid, points: 10 };
  },
  visitDelete(id) { if (!q('SELECT 1 FROM visits WHERE id=?').get(+id)) fail(404, 'Besuch nicht gefunden'); q('DELETE FROM visits WHERE id=?').run(+id); q("DELETE FROM log WHERE type='visit' AND ref=?").run(String(+id)); return { ok: true }; },
  healthItemGet(id) { const h = q('SELECT * FROM health_items WHERE id=?').get(+id); if (!h) fail(404, 'Eintrag nicht gefunden'); return h; },
  healthItemAdd(b) {
    const name = str(b.name, 80), person = b.person ? str(b.person, 20).toLowerCase() : '';
    if (!name) fail(400, 'Bitte einen Namen angeben.');
    if (person && !isUser(person)) fail(400, 'Ungültige Person');
    const r = q('INSERT INTO health_items(name,person,created_at) VALUES(?,?,?)').run(name, person || null, nowIso());
    return { ok: true, id: Number(r.lastInsertRowid) };
  },
  healthItemUpdate(id, b) {
    const h = ops.healthItemGet(id);
    const name = b.name !== undefined ? str(b.name, 80) : h.name;
    const person = b.person !== undefined ? (b.person ? str(b.person, 20).toLowerCase() : '') : (h.person || '');
    const active = b.active !== undefined ? (b.active ? 1 : 0) : h.active;
    if (!name) fail(400, 'Name darf nicht leer sein');
    if (person && !isUser(person)) fail(400, 'Ungültige Person');
    q('UPDATE health_items SET name=?, person=?, active=? WHERE id=?').run(name, person || null, active, h.id);
    return { ok: true };
  },
  healthItemDelete(id) { const h = ops.healthItemGet(id); q('DELETE FROM health_checks WHERE item_id=?').run(h.id); q('DELETE FROM health_items WHERE id=?').run(h.id); return { ok: true }; },
  healthCheck(user, itemId, date, done) {
    const h = ops.healthItemGet(itemId), today = localNow().date, d = date ? str(date, 10) : today;
    if (!isDate(d) || d > today || dayNum(today) - dayNum(d) > 60) fail(400, 'Ungültiges Datum (nicht in der Zukunft, höchstens 60 Tage zurück)');
    if (h.person && h.person !== user) fail(400, `«${h.name}» gilt nur für ${nameOf(h.person)}`);
    if (done) q('INSERT OR IGNORE INTO health_checks(item_id,user,date,at) VALUES(?,?,?,?)').run(h.id, user, d, nowIso());
    else q('DELETE FROM health_checks WHERE item_id=? AND user=? AND date=?').run(h.id, user, d);
    return { ok: true, date: d, done: !!done };
  },
  settingsSet(user, b) {
    const cur = q('SELECT morning, evening FROM user_settings WHERE user=?').get(user) || { morning: '09:00', evening: '18:00' };
    const mo = b.morning !== undefined ? str(b.morning, 5) : cur.morning, ev = b.evening !== undefined ? str(b.evening, 5) : cur.evening;
    if (!isTime(mo) || !isTime(ev)) fail(400, 'Ungültige Uhrzeit (HH:MM)');
    q('INSERT INTO user_settings(user,morning,evening) VALUES(?,?,?) ON CONFLICT(user) DO UPDATE SET morning=excluded.morning, evening=excluded.evening').run(user, mo, ev);
    if (b.teamGoal !== undefined) { const g = int(b.teamGoal, 10, 2000); if (!g) fail(400, 'Ungültiges Teamziel (10-2000)'); meta.set('team_goal', g); }
    return { ok: true };
  },
};

// ---------- Gesundheit & Statistik ----------
const nameOf = u => USER_NAMES[u] || (u ? u.charAt(0).toUpperCase() + u.slice(1) : '');
const monthOf = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') ? m : localNow().date.slice(0, 7);
function monthRange(m) {
  const [y, mo] = m.split('-').map(Number), first = `${m}-01`;
  const last = dateStr(dayNum(first) + new Date(Date.UTC(y, mo, 0)).getUTCDate() - 1);
  const today = localNow().date;
  return { first, last, end: last < today ? last : today };
}
const healthItemsFor = (user, all) => q(`SELECT * FROM health_items WHERE (person IS NULL OR person=?)${all ? '' : ' AND active=1'} ORDER BY id`).all(user);
function healthDay(user, date) {
  const d = isDate(date) ? date : localNow().date;
  const done = new Set(q('SELECT item_id FROM health_checks WHERE user=? AND date=?').all(user, d).map(r => r.item_id));
  return { person: user, date: d, items: healthItemsFor(user).map(h => ({ id: h.id, name: h.name, only_for: h.person, done: done.has(h.id) })) };
}
function healthStreak(itemId, user) {
  const set = new Set(q('SELECT date FROM health_checks WHERE item_id=? AND user=? ORDER BY date DESC LIMIT 400').all(itemId, user).map(r => r.date));
  let n = dayNum(localNow().date); if (!set.has(dateStr(n))) n--;
  let streak = 0; while (set.has(dateStr(n))) { streak++; n--; }
  return streak;
}
function healthStats(user, month) {
  const m = monthOf(month), { first, end } = monthRange(m);
  const items = healthItemsFor(user, true).filter(h => h.active || q('SELECT 1 FROM health_checks WHERE item_id=? AND user=? AND date BETWEEN ? AND ?').get(h.id, user, first, end));
  const rows = items.map(h => {
    const earliest = q('SELECT min(date) AS d FROM health_checks WHERE item_id=? AND user=?').get(h.id, user)?.d;
    let created = (h.created_at || first).slice(0, 10); if (earliest && earliest < created) created = earliest;
    const start = created > first ? created : first;
    const possible = end >= start ? dayNum(end) - dayNum(start) + 1 : 0;
    const dates = q('SELECT date FROM health_checks WHERE item_id=? AND user=? AND date BETWEEN ? AND ? ORDER BY date').all(h.id, user, first, end).map(r => r.date);
    return { id: h.id, name: h.name, active: !!h.active, since: start, done_days: dates.length, possible_days: possible, percent: possible ? Math.round(dates.length / possible * 100) : 0, streak: healthStreak(h.id, user), dates };
  });
  let full = 0;
  if (end >= first) for (let n = dayNum(rows.length ? rows.map(r => r.since).sort()[0] : first); n <= dayNum(end); n++) {
    const d = dateStr(n), need = rows.filter(r => r.active && r.since <= d);
    if (need.length && need.every(r => r.dates.includes(d))) full++;
  }
  const since = rows.length ? rows.map(r => r.since).sort()[0] : first;
  return { person: user, month: m, days: end >= since ? dayNum(end) - dayNum(since) + 1 : 0, complete_days: full, items: rows };
}
function choreHistory(month, choreId) {
  const { first, last } = monthRange(monthOf(month));
  return q(`SELECT l.id AS log_id, l.date, l.by, l.points, CAST(l.ref AS INTEGER) AS chore_id, COALESCE(c.name, l.label) AS name FROM log l LEFT JOIN chores c ON c.id = CAST(l.ref AS INTEGER) WHERE l.type='chore' AND l.date BETWEEN ? AND ?${choreId ? ' AND l.ref=?' : ''} ORDER BY l.date DESC, l.id DESC`).all(...(choreId ? [first, last, String(+choreId)] : [first, last]));
}
function choreStats(month) {
  const m = monthOf(month), { first, last } = monthRange(m);
  const all = q("SELECT by, date, ref FROM log WHERE type='chore' ORDER BY date, id").all();
  const byRef = new Map(); for (const e of all) { if (!byRef.has(e.ref)) byRef.set(e.ref, []); byRef.get(e.ref).push(e); }
  const people = Object.fromEntries(Object.keys(USERS).map(k => [k, 0]));
  let total = 0, onTime = 0, rated = 0;
  const chores = q('SELECT * FROM chores ORDER BY name').all().map(c => {
    const list = byRef.get(String(c.id)) || [], perPerson = Object.fromEntries(Object.keys(USERS).map(k => [k, 0]));
    let count = 0, gaps = [], ok = 0, late = 0, maxLate = 0;
    list.forEach((e, i) => {
      if (e.date < first || e.date > last) return;
      count++; if (perPerson[e.by] !== undefined) perPerson[e.by]++;
      if (i > 0) { const gap = dayNum(e.date) - dayNum(list[i - 1].date); gaps.push(gap); if (gap <= c.interval_days) ok++; else { late++; maxLate = Math.max(maxLate, gap - c.interval_days); } }
    });
    total += count; onTime += ok; rated += ok + late;
    for (const k in perPerson) people[k] += perPerson[k];
    const created = (c.created_at || first).slice(0, 10), firstLog = list[0]?.date;
    let since = created; if (firstLog && firstLog < since) since = firstLog; if (since < first) since = first;
    const daysInRange = Math.max(0, dayNum(monthRange(m).end) - dayNum(since) + 1);
    return { id: c.id, name: c.name, assignee: c.assignee, interval_days: c.interval_days, count, expected: Math.max(0, Math.round(daysInRange / c.interval_days)), by_person: perPerson, avg_gap_days: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10 : null, on_time: ok, late, max_days_late: maxLate };
  });
  return { month: m, total, by_person: people, on_time_percent: rated ? Math.round(onTime / rated * 100) : null, chores };
}

// ---------- API ----------
async function api(req, res, user, route) {
  const m = req.method;
  // CSRF: schreibende Requests nur mit eigenem Header (SameSite=Lax + kein CORS)
  if (m !== 'GET' && req.headers['x-flechte'] !== '1') return send(res, 403, { error: 'csrf' });
  const body = m === 'GET' ? {} : await readBody(req);
  const qs = new URL(req.url, 'http://x').searchParams;
  let mm;
  try {
    if (m === 'GET' && route === 'state') return send(res, 200, state(user));
    if (m === 'POST' && route === 'chores') return send(res, 200, ops.choreAdd(user, body));
    if ((mm = route.match(/^chores\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.choreDelete(mm[1]));
    if ((mm = route.match(/^chores\/(\d+)$/)) && m === 'PATCH') return send(res, 200, ops.choreUpdate(mm[1], body));
    if ((mm = route.match(/^chores\/(\d+)\/done$/)) && m === 'POST') return send(res, 200, ops.choreDone(user, mm[1], body.date));
    if (m === 'GET' && route === 'chores/history') return send(res, 200, { history: choreHistory(qs.get('month')), stats: choreStats(qs.get('month')) });
    if ((mm = route.match(/^chores\/history\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.choreCompletionDelete(mm[1]));
    if (m === 'GET' && route === 'health') return send(res, 200, { day: healthDay(user, qs.get('date')), stats: healthStats(isUser(qs.get('person')) ? qs.get('person') : user, qs.get('month')), items: q('SELECT * FROM health_items ORDER BY active DESC, id').all() });
    if (m === 'POST' && route === 'health/check') return send(res, 200, ops.healthCheck(user, body.item_id, body.date, !!body.done));
    if (m === 'POST' && route === 'health/items') return send(res, 200, ops.healthItemAdd(body));
    if ((mm = route.match(/^health\/items\/(\d+)$/)) && m === 'PATCH') return send(res, 200, ops.healthItemUpdate(mm[1], body));
    if ((mm = route.match(/^health\/items\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.healthItemDelete(mm[1]));
    if (m === 'POST' && route === 'todos') return send(res, 200, ops.todoAdd(user, body));
    if ((mm = route.match(/^todos\/(\d+)$/)) && m === 'PATCH') return send(res, 200, ops.todoUpdate(mm[1], body));
    if ((mm = route.match(/^todos\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.todoDelete(mm[1]));
    if ((mm = route.match(/^todos\/(\d+)\/toggle$/)) && m === 'POST') return send(res, 200, ops.todoSetDone(user, mm[1], !ops.todoGet(mm[1]).done));
    if (m === 'POST' && route === 'meals') return send(res, 200, ops.mealSet(user, body.date, body.title, body.note));
    if (m === 'POST' && route === 'guests') return send(res, 200, ops.guestAdd(body));
    if ((mm = route.match(/^guests\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.guestDelete(mm[1]));
    if (m === 'POST' && route === 'visits') return send(res, 200, ops.visitAdd(user, body));
    if ((mm = route.match(/^visits\/(\d+)$/)) && m === 'DELETE') return send(res, 200, ops.visitDelete(mm[1]));
    if (m === 'POST' && route === 'settings') return send(res, 200, ops.settingsSet(user, body));
  } catch (e) {
    if (e instanceof OpError) return send(res, e.status, { error: e.message });
    throw e;
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
  const chores = q('SELECT * FROM chores WHERE assignee=?').all(user).filter(c => choreDueIn(c) <= 0);
  const todos = q('SELECT * FROM todos WHERE done=0 AND due IS NOT NULL AND due <= ? AND (assignee IS NULL OR assignee=?)').all(today, user);
  const lastVisit = q('SELECT date FROM visits ORDER BY date DESC LIMIT 1').get()?.date;
  const guestDays = lastVisit ? daysSince(lastVisit) : null;
  return { chores, todos, guestOverdue: guestDays === null ? false : guestDays >= 7, guestDays };
}
// Freunde, die seit GUEST_REMIND_DAYS nicht mehr da waren (ohne Besuch: ab Erfassungsdatum)
function longAbsentGuests() {
  const today = dayNum(localNow().date);
  return q('SELECT g.id, g.name, g.created_at, (SELECT max(v.date) FROM visits v JOIN visit_guests vg ON vg.visit_id=v.id WHERE vg.guest_id=g.id) AS last_visit FROM guests g').all()
    .map(g => { const since = g.last_visit || (g.created_at || '').slice(0, 10); return { id: g.id, name: g.name, last_visit: g.last_visit, days: isDate(since) ? today - dayNum(since) : 0 }; })
    .filter(g => g.days >= GUEST_REMIND_DAYS).sort((a, b) => b.days - a.days);
}

function buildMessage(user, slot) {
  const d = dueFor(user);
  const lines = [];
  const over = d.chores.filter(c => choreDueIn(c) < 0).sort((a, b) => choreDueIn(a) - choreDueIn(b)), dueToday = d.chores.filter(c => choreDueIn(c) === 0);
  if (over.length) lines.push('Überfällig: ' + over.slice(0, 4).map(c => `${c.name} (${-choreDueIn(c)} ${-choreDueIn(c) === 1 ? 'Tag' : 'Tage'})`).join(', ') + (over.length > 4 ? ' …' : ''));
  if (dueToday.length) lines.push('Heute fällig: ' + dueToday.slice(0, 4).map(c => c.name).join(', ') + (dueToday.length > 4 ? ' …' : ''));
  if (d.todos.length) lines.push((d.todos.length === 1 ? 'To-do: ' : `${d.todos.length} To-dos: `) + d.todos.slice(0, 3).map(t => t.title).join(', ') + (d.todos.length > 3 ? ' …' : ''));
  if (d.guestOverdue) lines.push(`Seit ${d.guestDays} Tagen kein Besuch. Wen ladet ihr ein?`);
  const today = localNow().date, dnum = dayNum(today);
  if (slot === 'evening') {
    const due = longAbsentGuests().filter(g => { const r = q('SELECT date FROM guest_reminders WHERE guest_id=? AND user=?').get(g.id, user); return !r || dnum - dayNum(r.date) >= GUEST_REMIND_REPEAT; });
    if (due.length) {
      lines.push('Lange nicht gesehen: ' + due.slice(0, 4).map(g => `${g.name} (${g.last_visit ? 'seit ' + g.days + ' Tagen' : 'noch nie da'})`).join(', ') + (due.length > 4 ? ' …' : '') + '. Zeit für eine Einladung?');
      for (const g of due) q('INSERT INTO guest_reminders(guest_id,user,date) VALUES(?,?,?) ON CONFLICT(guest_id,user) DO UPDATE SET date=excluded.date').run(g.id, user, today);
    }
  }
  if (slot === 'evening') {
    const open = healthDay(user, today).items.filter(i => !i.done);
    if (open.length) lines.push('Gesundheit, noch offen: ' + open.map(i => i.name).join(', '));
  }
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

// ---------- MCP-Schnittstelle (Streamable HTTP, zustandslos, JSON-RPC 2.0) ----------
// MCP_TOKENS="shared:<token>" für ein gemeinsam genutztes Konto (Person je Aufruf über den Parameter person)
// oder "alex:<token>,sam:<token>" für ein Token pro Person. Tokens mindestens 32 Zeichen.
const MCP_TOKENS = (env.MCP_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; }).filter(([u, t]) => (u === 'shared' || isUser(u)) && t.length >= 32);
// Wer handelt? Explizit angegebene Person, sonst Token-Person, sonst Fallback (oder Fehler)
function actor(tokenUser, a, fallback) {
  const p = a && typeof a.person === 'string' ? a.person.trim().toLowerCase() : '';
  if (p) { if (!isUser(p)) fail(400, 'Unbekannte Person: ' + p + '. Gültig: ' + Object.keys(USERS).join(', ')); return p; }
  if (tokenUser !== 'shared') return tokenUser;
  if (fallback) return fallback;
  fail(400, 'Bitte mit dem Parameter person angeben, wer das ist (' + Object.keys(USERS).join(', ') + ').');
}
const PERSON = { type: 'string', description: 'Wer handelt (Schlüssel aus get_overview.people). Das Claude-Konto wird gemeinsam genutzt: wenn aus dem Gespräch nicht klar ist, wer schreibt, nachfragen.' };
function mcpUser(req) {
  const h = String(req.headers.authorization || ''), m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const given = crypto.createHash('sha256').update(m[1].trim()).digest();
  let found = null;
  for (const [u, t] of MCP_TOKENS) { if (crypto.timingSafeEqual(given, crypto.createHash('sha256').update(t).digest())) found = u; }
  return found;
}
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const wdOf = d => WD[new Date(dayNum(d) * 864e5).getUTCDay()];
function choreView(c) {
  const today = localNow().date;
  const left = choreDueIn(c);
  return { id: c.id, name: c.name, assignee: c.assignee, interval_days: c.interval_days, points: c.points, last_done: c.last_by ? c.last_done : null, last_done_by: c.last_by || null, due_in_days: left, due_date: dateStr(dayNum(today) + Math.max(left, 0)), overdue: left < 0 };
}
function overview() {
  const today = localNow().date, ws = weekStart(today), goal = +meta.get('team_goal', 120);
  const log = q('SELECT points, date FROM log WHERE date >= ?').all(dateStr(ws - 70));
  const pts = w => log.filter(e => weekStart(e.date) === w).reduce((a, e) => a + e.points, 0);
  let streak = 0; for (let w = ws - 7; ; w -= 7) { if (pts(w) >= goal) streak++; else break; }
  const chores = q('SELECT * FROM chores ORDER BY name').all().map(choreView);
  const lastVisit = q('SELECT date FROM visits ORDER BY date DESC LIMIT 1').get()?.date || null;
  return {
    today, weekday: wdOf(today),
    people: Object.keys(USERS).map(k => ({ key: k, name: nameOf(k) })),
    team_goal: { goal, points_this_week: pts(ws), weeks_in_a_row: streak },
    due_chores: chores.filter(c => c.due_in_days <= 0),
    open_todos: q('SELECT id, title, due, assignee FROM todos WHERE done=0 ORDER BY COALESCE(due, \'9999\'), id').all(),
    meals: q('SELECT date, title, note FROM meals WHERE date >= ? AND date <= ? ORDER BY date').all(dateStr(ws), dateStr(ws + 13)).map(m => ({ ...m, weekday: wdOf(m.date) })),
    health_today: Object.keys(USERS).map(k => healthDay(k, today)),
    guests: { last_visit: lastVisit, days_since: lastVisit ? dayNum(today) - dayNum(lastVisit) : null, goal: 'jede Woche jemand zu Gast', long_absent: longAbsentGuests(), long_absent_threshold_days: GUEST_REMIND_DAYS },
  };
}
const P = (type, description, extra = {}) => ({ type, description, ...extra });
const MCP_TOOLS = [
  { name: 'get_overview', description: 'Überblick: heutiges Datum, Personen, Teamziel der Woche, fällige Haushaltsaufgaben, offene To-dos, Essensplan dieser und nächster Woche, Gäste-Status, Gesundheits-Checkliste heute. Zuerst aufrufen, um den Kontext zu kennen.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: () => overview() },
  { name: 'list_chores', description: 'Alle wiederkehrenden Haushaltsaufgaben mit Person, Intervall, Punkten und Fälligkeit.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: () => q('SELECT * FROM chores ORDER BY name').all().map(choreView) },
  { name: 'add_chore', description: 'Neue wiederkehrende Haushaltsaufgabe anlegen, optional mit erstem Fälligkeitsdatum.', inputSchema: { type: 'object', properties: { name: P('string', 'Bezeichnung'), interval_days: P('integer', 'Alle wie viele Tage (1-365)'), points: P('integer', 'Punkte fürs Teamziel (1-100), Standard 10'), assignee: P('string', 'Schlüssel der zuständigen Person (siehe get_overview.people)'), next_due: P('string', 'Erste Fälligkeit YYYY-MM-DD (optional, sonst sofort fällig)') }, required: ['name', 'interval_days', 'assignee'] }, run: (u, a) => ops.choreAdd(u, a) },
  { name: 'update_chore', description: 'Haushaltsaufgabe ändern (nur angegebene Felder), auch die nächste Fälligkeit verschieben.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID der Aufgabe'), name: P('string', 'Neue Bezeichnung'), interval_days: P('integer', 'Neues Intervall in Tagen'), points: P('integer', 'Neue Punkte'), assignee: P('string', 'Neue zuständige Person'), next_due: P('string', 'Nächste Fälligkeit YYYY-MM-DD setzen (gilt bis zur nächsten Erledigung, danach wieder nach Intervall). Leerer String entfernt die manuelle Fälligkeit.') }, required: ['id'] }, run: (u, a) => ops.choreUpdate(a.id, a) },
  { name: 'delete_chore', description: 'Haushaltsaufgabe löschen.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID der Aufgabe') }, required: ['id'] }, destructive: true, run: (u, a) => ops.choreDelete(a.id) },
  { name: 'complete_chore', description: 'Haushaltsaufgabe als erledigt markieren (heute oder an einem früheren Tag nachtragen). Zählt fürs Teamziel.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID der Aufgabe'), person: { ...PERSON, description: 'Wer hat es erledigt. Ohne Angabe zählt es für die zuständige Person.' }, date: P('string', 'Erledigt am YYYY-MM-DD (optional, Standard heute, höchstens 60 Tage zurück)') }, required: ['id'] }, run: (u, a) => ops.choreDone(actor(u, a, ops.choreGet(a.id).assignee), a.id, a.date) },
  { name: 'list_todos', description: 'To-dos auflisten.', inputSchema: { type: 'object', properties: { include_done: P('boolean', 'Auch erledigte der letzten 30 Tage') } }, readOnly: true, run: (u, a) => q('SELECT id, title, due, assignee, done, done_by, done_at FROM todos WHERE done=0 OR (? AND done_at >= ?) ORDER BY done, COALESCE(due, \'9999\'), id').all(a.include_done ? 1 : 0, new Date(Date.now() - 30 * 864e5).toISOString()) },
  { name: 'add_todo', description: 'Einmaliges To-do anlegen, z.B. Einkauf oder Erledigung.', inputSchema: { type: 'object', properties: { title: P('string', 'Was ist zu tun'), due: P('string', 'Fällig bis YYYY-MM-DD (optional)'), assignee: P('string', 'Schlüssel der Person, leer = beide'), person: PERSON }, required: ['title'] }, run: (u, a) => ops.todoAdd(actor(u, a, Object.keys(USERS)[0]), a) },
  { name: 'set_todo_done', description: 'To-do als erledigt oder wieder offen markieren.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID des To-dos'), done: P('boolean', 'true = erledigt, false = wieder offen'), person: { ...PERSON, description: 'Wer hat es erledigt. Ohne Angabe zählt es für die eingetragene Person, bei To-dos für beide muss sie angegeben werden.' } }, required: ['id', 'done'] }, run: (u, a) => ops.todoSetDone(actor(u, a, ops.todoGet(a.id).assignee), a.id, !!a.done) },
  { name: 'update_todo', description: 'To-do ändern: Titel, Fälligkeitsdatum oder Person (nur angegebene Felder).', inputSchema: { type: 'object', properties: { id: P('integer', 'ID des To-dos'), title: P('string', 'Neuer Titel'), due: P('string', 'Fällig bis YYYY-MM-DD, leerer String entfernt das Datum'), assignee: P('string', 'Schlüssel der Person, leerer String = beide') }, required: ['id'] }, run: (u, a) => ops.todoUpdate(a.id, a) },
  { name: 'delete_todo', description: 'To-do löschen.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID des To-dos') }, required: ['id'] }, destructive: true, run: (u, a) => ops.todoDelete(a.id) },
  { name: 'get_meal_plan', description: 'Essensplan für einen Zeitraum lesen, plus die am häufigsten gekochten Gerichte.', inputSchema: { type: 'object', properties: { from: P('string', 'YYYY-MM-DD, Standard Montag dieser Woche'), to: P('string', 'YYYY-MM-DD, Standard Sonntag nächster Woche') } }, readOnly: true, run: (u, a) => {
      const ws = weekStart(localNow().date), from = isDate(a.from) ? a.from : dateStr(ws), to = isDate(a.to) ? a.to : dateStr(ws + 13);
      return { from, to, meals: q('SELECT date, title, note FROM meals WHERE date >= ? AND date <= ? ORDER BY date').all(from, to).map(m => ({ ...m, weekday: wdOf(m.date) })), favorites: q('SELECT title, COUNT(*) AS times FROM meals GROUP BY lower(title) ORDER BY times DESC, max(date) DESC LIMIT 30').all() };
    } },
  { name: 'set_meals', description: 'Gerichte in den Essensplan eintragen oder ersetzen (ein oder mehrere Tage). Leerer Titel löscht den Tag. Ab 5 geplanten Tagen einer Woche gibt es einmalig 10 Punkte.', inputSchema: { type: 'object', properties: { meals: { type: 'array', maxItems: 31, items: { type: 'object', properties: { date: P('string', 'YYYY-MM-DD'), title: P('string', 'Gericht'), note: P('string', 'Notiz, z.B. Rezeptlink oder Zutaten') }, required: ['date', 'title'] } }, person: PERSON }, required: ['meals'] }, run: (u, a) => {
      const who = actor(u, a, Object.keys(USERS)[0]);
      if (!Array.isArray(a.meals) || !a.meals.length) fail(400, 'meals fehlt');
      return { ok: true, results: a.meals.slice(0, 31).map(m => ({ date: m.date, ...ops.mealSet(who, m.date, m.title, m.note) })) };
    } },
  { name: 'list_guests', description: 'Erfasste Freunde mit letztem Besuch, sortiert nach «am längsten nicht mehr da».', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: () => q('SELECT g.id, g.name, (SELECT max(v.date) FROM visits v JOIN visit_guests vg ON vg.visit_id=v.id WHERE vg.guest_id=g.id) AS last_visit FROM guests g ORDER BY last_visit IS NOT NULL, last_visit, g.name').all() },
  { name: 'add_guest', description: 'Freund oder Paar zur Gästeliste hinzufügen.', inputSchema: { type: 'object', properties: { name: P('string', 'Name') }, required: ['name'] }, run: (u, a) => ops.guestAdd(a) },
  { name: 'delete_guest', description: 'Person aus der Gästeliste entfernen.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID') }, required: ['id'] }, destructive: true, run: (u, a) => ops.guestDelete(a.id) },
  { name: 'log_visit', description: 'Besuch eintragen (gibt beiden Personen je 10 Punkte).', inputSchema: { type: 'object', properties: { date: P('string', 'YYYY-MM-DD, nicht in der Zukunft'), guest_ids: { type: 'array', items: { type: 'integer' }, description: 'IDs aus list_guests' }, note: P('string', 'Notiz (optional)'), person: PERSON }, required: ['date', 'guest_ids'] }, run: (u, a) => ops.visitAdd(actor(u, a, Object.keys(USERS)[0]), { date: a.date, guestIds: a.guest_ids, note: a.note }) },
  { name: 'list_visits', description: 'Letzte Besuche.', inputSchema: { type: 'object', properties: { limit: P('integer', 'Anzahl, Standard 20') } }, readOnly: true, run: (u, a) => q('SELECT id, date, note FROM visits ORDER BY date DESC, id DESC LIMIT ?').all(int(a.limit, 1, 200) || 20).map(v => ({ ...v, guests: q('SELECT g.name FROM visit_guests vg JOIN guests g ON g.id=vg.guest_id WHERE vg.visit_id=?').all(v.id).map(r => r.name) })) },
  { name: 'delete_visit', description: 'Besuch löschen (Punkte werden zurückgenommen).', inputSchema: { type: 'object', properties: { id: P('integer', 'ID') }, required: ['id'] }, destructive: true, run: (u, a) => ops.visitDelete(a.id) },
  { name: 'get_settings', description: 'Push-Zeiten beider Personen und Teamziel.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: () => ({ push_times: Object.keys(USERS).map(k => ({ person: k, ...(q('SELECT morning, evening FROM user_settings WHERE user=?').get(k) || { morning: '09:00', evening: '18:00' }) })), team_goal: +meta.get('team_goal', 120) }) },
  { name: 'update_settings', description: 'Push-Zeiten (HH:MM) einer Person und/oder das gemeinsame Wochen-Teamziel ändern. Für Push-Zeiten ist person nötig.', inputSchema: { type: 'object', properties: { person: PERSON, morning: P('string', 'HH:MM'), evening: P('string', 'HH:MM'), team_goal: P('integer', 'Punkte pro Woche (10-2000)') } }, run: (u, a) => {
      if (a.morning === undefined && a.evening === undefined) { if (a.team_goal === undefined) fail(400, 'Nichts zu ändern'); const g = int(a.team_goal, 10, 2000); if (!g) fail(400, 'Ungültiges Teamziel (10-2000)'); meta.set('team_goal', g); return { ok: true }; }
      return ops.settingsSet(actor(u, a), { morning: a.morning, evening: a.evening, teamGoal: a.team_goal });
    } },
  { name: 'get_chore_history', description: 'Verlauf: wann welche Haushaltsaufgabe von wem erledigt wurde, für einen Monat.', inputSchema: { type: 'object', properties: { month: P('string', 'YYYY-MM, Standard aktueller Monat'), chore_id: P('integer', 'Nur diese Aufgabe (optional)') } }, readOnly: true, run: (u, a) => ({ month: monthOf(a.month), entries: choreHistory(a.month, a.chore_id) }) },
  { name: 'get_chore_stats', description: 'Monatsstatistik Haushalt: Anzahl Erledigungen pro Aufgabe und Person, erwartete Anzahl laut Intervall, durchschnittlicher Abstand, pünktlich/verspätet.', inputSchema: { type: 'object', properties: { month: P('string', 'YYYY-MM, Standard aktueller Monat') } }, readOnly: true, run: (u, a) => choreStats(a.month) },
  { name: 'delete_chore_completion', description: 'Eine Erledigung aus dem Verlauf löschen (z.B. versehentlich abgehakt). Punkte werden zurückgenommen.', inputSchema: { type: 'object', properties: { log_id: P('integer', 'log_id aus get_chore_history') }, required: ['log_id'] }, destructive: true, run: (u, a) => ops.choreCompletionDelete(a.log_id) },
  { name: 'list_health_items', description: 'Gesundheits-Checkliste: tägliche Punkte wie Grüner Shake oder Nahrungsergänzungsmittel. only_for leer = gilt für beide.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: () => q('SELECT id, name, person AS only_for, active FROM health_items ORDER BY active DESC, id').all() },
  { name: 'add_health_item', description: 'Neuen täglichen Gesundheitspunkt anlegen.', inputSchema: { type: 'object', properties: { name: P('string', 'Bezeichnung'), only_for: P('string', 'Schlüssel einer Person, leer = für beide') }, required: ['name'] }, run: (u, a) => ops.healthItemAdd({ name: a.name, person: a.only_for }) },
  { name: 'update_health_item', description: 'Gesundheitspunkt ändern oder pausieren (active=false blendet ihn aus, Statistik bleibt).', inputSchema: { type: 'object', properties: { id: P('integer', 'ID'), name: P('string', 'Neue Bezeichnung'), only_for: P('string', 'Person, leerer String = für beide'), active: P('boolean', 'Aktiv') }, required: ['id'] }, run: (u, a) => ops.healthItemUpdate(a.id, { name: a.name, person: a.only_for, active: a.active }) },
  { name: 'delete_health_item', description: 'Gesundheitspunkt samt Verlauf löschen. Zum blossen Ausblenden besser update_health_item mit active=false.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID') }, required: ['id'] }, destructive: true, run: (u, a) => ops.healthItemDelete(a.id) },
  { name: 'get_health_day', description: 'Tagesliste Gesundheit: was an einem Tag abgehakt ist. Ohne person für beide.', inputSchema: { type: 'object', properties: { date: P('string', 'YYYY-MM-DD, Standard heute'), person: P('string', 'Schlüssel der Person (optional)') } }, readOnly: true, run: (u, a) => {
      const p = a.person ? actor(u, a) : null;
      return p ? healthDay(p, a.date) : Object.keys(USERS).map(k => healthDay(k, a.date));
    } },
  { name: 'set_health_check', description: 'Gesundheitspunkt für einen Tag abhaken oder zurücksetzen.', inputSchema: { type: 'object', properties: { item_id: P('integer', 'ID aus list_health_items'), done: P('boolean', 'true = gemacht, false = zurücksetzen'), date: P('string', 'YYYY-MM-DD, Standard heute, höchstens 60 Tage zurück'), person: PERSON }, required: ['item_id', 'done'] }, run: (u, a) => {
      const h = ops.healthItemGet(a.item_id);
      return ops.healthCheck(actor(u, a, h.person || undefined), a.item_id, a.date, !!a.done);
    } },
  { name: 'get_health_stats', description: 'Monatsstatistik Gesundheit pro Person: an wie vielen Tagen welcher Punkt gemacht wurde, Prozent, aktuelle Serie, Tage mit allem erledigt. Ohne person für beide.', inputSchema: { type: 'object', properties: { month: P('string', 'YYYY-MM, Standard aktueller Monat'), person: P('string', 'Schlüssel der Person (optional)') } }, readOnly: true, run: (u, a) => {
      const p = a.person ? actor(u, a) : null;
      return p ? healthStats(p, a.month) : Object.keys(USERS).map(k => healthStats(k, a.month));
    } },
];
const MCP_INSTRUCTIONS = 'Flechte ist die Haushalts-App eines Paares: wiederkehrende Aufgaben mit fester Zuständigkeit, To-dos, Essensplan (sonntags für die nächste Woche planen), Gäste-Rhythmus (Ziel: jede Woche jemand zu Gast) und ein gemeinsames Wochen-Teamziel in Punkten. Dazu gibt es eine tägliche Gesundheits-Checkliste pro Person mit Monatsstatistik sowie einen Verlauf und eine Monatsstatistik der Haushaltsaufgaben. Rufe zuerst get_overview auf. Daten sind auf Deutsch, Datumsformat YYYY-MM-DD, Zeitzone ' + TZ + '. Das Konto kann von beiden Personen gemeinsam genutzt werden: Gib bei Aktionen, die einer Person zugerechnet werden, den Parameter person an und frage nach, wenn nicht klar ist, wer gerade schreibt. Haushaltsaufgaben haben eine feste zuständige Person (assignee).';
const mcpRate = new Map();
async function handleMcp(req, res) {
  if (req.method === 'GET' || req.method === 'DELETE') return send(res, 405, { error: 'Nur POST' }, undefined, { Allow: 'POST' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Nur POST' });
  const user = mcpUser(req);
  if (!user) return send(res, 401, { error: 'unauthorized' }, undefined, { 'WWW-Authenticate': 'Bearer' });
  const e = mcpRate.get(user) || { n: 0, t: Date.now() }; if (Date.now() - e.t > 6e4) { e.n = 0; e.t = Date.now(); } e.n++; mcpRate.set(user, e);
  if (e.n > 120) return send(res, 429, { error: 'Zu viele Anfragen' });
  let body; try { body = await readBody(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const handle = async (msg) => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const isNote = msg.id === undefined;
    const ok = result => isNote ? null : { jsonrpc: '2.0', id: msg.id, result };
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'flechte', title: 'Flechte Haushalt', version: '1.2.0' }, instructions: MCP_INSTRUCTIONS });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false } })) });
      case 'tools/call': {
        const t = MCP_TOOLS.find(x => x.name === msg.params?.name);
        if (!t) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unbekanntes Werkzeug' } };
        try {
          const out = await t.run(user, msg.params?.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: Array.isArray(out) ? { items: out } : out });
        } catch (err) {
          if (!(err instanceof OpError)) console.error('MCP-Fehler', t.name, err);
          return ok({ content: [{ type: 'text', text: err instanceof OpError ? err.message : 'Interner Fehler' }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        return isNote ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map(handle))).filter(Boolean);
    return out.length ? send(res, 200, out) : (res.writeHead(202, SEC_HEADERS), res.end());
  }
  const out = await handle(body);
  if (!out) { res.writeHead(202, SEC_HEADERS); return res.end(); }
  return send(res, 200, out);
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/mcp') return await handleMcp(req, res);
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
