'use strict';
const $ = id => document.getElementById(id);
let S = null, tab = 'home', pending = null, editing = null, selected = new Set(), busy = false;
const NAME = k => S?.users.find(u => u.key === k)?.name || k || '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const daysSince = s => dayNum(S.today) - dayNum(s);
const weekStart = s => { const n = dayNum(s); return n - ((new Date(n * 864e5).getUTCDay() + 6) % 7); };
const fmt = s => s ? s.split('-').reverse().join('.') : '';
const ago = n => n === 0 ? 'heute' : n === 1 ? 'gestern' : 'vor ' + n + ' Tagen';

function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600); }
function li(html, cls) { const l = document.createElement('li'); if (cls) l.className = cls; l.innerHTML = html; return l; }
function btn(text, cls, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.addEventListener('click', fn); return b; }
function confirmBtn(key, label, ask, fn) {
  if (pending === key) return btn(ask, 'link danger', () => { pending = null; fn(); });
  return btn(label, 'link', () => { pending = key; render(); });
}

async function call(method, url, body) {
  const r = await fetch('/api/' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Flechte': '1' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { showLogin(); throw new Error('Nicht angemeldet'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Fehler');
  return d;
}
async function act(method, url, body, msg) {
  if (busy) return; busy = true;
  try { const d = await call(method, url, body); if (msg) toast(typeof msg === 'function' ? msg(d) : msg); await load(); return d; }
  catch (e) { toast(e.message); }
  finally { busy = false; }
}
async function load() {
  try { S = await call('GET', 'state'); } catch { return; }
  $('login').hidden = true; $('app').hidden = false;
  $('whoami').textContent = NAME(S.me);
  render(); updatePushUi();
}
function showLogin() {
  $('app').hidden = true; $('login').hidden = false; $('whoami').textContent = '';
  const p = new URLSearchParams(location.search).get('login');
  const m = $('loginMsg');
  if (p === 'nicht-erlaubt') { m.hidden = false; m.textContent = 'Dieses Google-Konto ist nicht freigegeben.'; }
  else if (p === 'fehler') { m.hidden = false; m.textContent = 'Anmeldung fehlgeschlagen. Bitte nochmals versuchen.'; }
}

function choreState(c) {
  if (!c.last_done) return { due: true, over: 0, text: 'noch nie erledigt', cls: 'warn' };
  const left = c.interval_days - daysSince(c.last_done);
  if (left > 0) return { due: false, over: 0, text: left === 1 ? 'fällig morgen' : 'fällig in ' + left + ' Tagen', cls: 'ok' };
  if (left === 0) return { due: true, over: 0, text: 'heute fällig', cls: 'warn' };
  return { due: true, over: -left, text: 'seit ' + (-left) + (left === -1 ? ' Tag' : ' Tagen') + ' überfällig', cls: 'bad' };
}
const lastVisitOf = gid => { for (const v of S.visits) if (v.guestIds.includes(gid)) return v.date; return null; };
function fillSelect(sel, withBoth) {
  const cur = sel.value; sel.innerHTML = '';
  if (withBoth) sel.add(new Option('Beide', ''));
  for (const u of S.users) sel.add(new Option(u.name, u.key));
  sel.value = cur || (withBoth ? '' : S.me);
}

function dueItem(kind, item, sub) {
  const l = li('<div class="who"><b>' + esc(item.name || item.title) + '</b><div>' + sub + '</div></div>' + (kind === 'chore' ? '<span class="pts">+' + item.points + '</span>' : ''));
  if (kind === 'chore') l.appendChild(btn('Erledigt', 'done', () => act('POST', 'chores/' + item.id + '/done', null, d => '+' + d.points + ' Punkte fürs Team')));
  else l.appendChild(btn('Erledigt', 'done', () => act('POST', 'todos/' + item.id + '/toggle', null, '+5 Punkte fürs Team')));
  return l;
}

function render() {
  if (!S) return;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;

  // Teamziel
  const ws = weekStart(S.today), goal = S.teamGoal;
  const weekPts = w => S.log.filter(e => weekStart(e.date) === w).reduce((a, e) => a + e.points, 0);
  const team = weekPts(ws);
  $('teamBig').innerHTML = team + '<small>/ ' + goal + ' Punkte</small>';
  const fill = $('teamFill'); fill.style.width = Math.min(100, team / goal * 100) + '%'; fill.classList.toggle('done', team >= goal);
  let streak = 0; for (let w = ws - 7; ; w -= 7) { if (weekPts(w) >= goal) streak++; else break; }
  const dow = (new Date(dayNum(S.today) * 864e5).getUTCDay() + 6) % 7, daysLeft = 6 - dow;
  $('teamHint').textContent = team >= goal ? 'Ziel erreicht. Alles weitere ist Bonus.' : 'Noch ' + (goal - team) + ' Punkte, ' + (daysLeft === 0 ? 'heute ist der letzte Tag der Woche.' : 'noch ' + daysLeft + (daysLeft === 1 ? ' Tag' : ' Tage') + ' Zeit.');
  const gp = $('goalPill');
  gp.textContent = streak ? streak + (streak === 1 ? ' Woche' : ' Wochen') + ' in Serie' : 'Stufe ' + (1 + Math.floor(S.totalPoints / 500));
  gp.title = 'Insgesamt ' + S.totalPoints + ' Punkte';
  const wk = $('weeks'); wk.innerHTML = '';
  for (let i = 7; i >= 0; i--) {
    const p = weekPts(ws - i * 7), d = document.createElement('div');
    d.className = 'wk' + (p >= goal ? ' hit' : p > 0 ? ' part' : '');
    d.innerHTML = '<span></span>' + (i === 0 ? 'jetzt' : '−' + i);
    d.title = p + ' Punkte'; wk.appendChild(d);
  }

  // Fällig
  const dueChores = u => S.chores.filter(c => c.assignee === u).map(c => ({ c, s: choreState(c) })).filter(x => x.s.due).sort((a, b) => b.s.over - a.s.over);
  const dueTodos = u => S.todos.filter(t => !t.done && t.due && dayNum(t.due) <= dayNum(S.today) && (!t.assignee || t.assignee === u));
  const mine = $('myDue'); mine.innerHTML = '';
  const myC = dueChores(S.me), myT = dueTodos(S.me);
  for (const { c, s } of myC) mine.appendChild(dueItem('chore', c, '<span class="pill ' + s.cls + '">' + s.text + '</span>'));
  for (const t of myT) mine.appendChild(dueItem('todo', t, 'To-do, bis ' + fmt(t.due)));
  if (!mine.children.length) mine.appendChild(li('<p class="empty">Nichts fällig. Schön.</p>'));
  $('badgeHome').hidden = !(myC.length + myT.length); $('badgeHome').textContent = myC.length + myT.length;
  const other = S.users.find(u => u.key !== S.me);
  const od = $('otherDue'); od.innerHTML = '';
  if (other) {
    $('otherTitle').textContent = 'Bei ' + other.name + ' fällig';
    const oc = dueChores(other.key);
    for (const { c, s } of oc) od.appendChild(dueItem('chore', c, '<span class="pill ' + s.cls + '">' + s.text + '</span>'));
    if (!oc.length) od.appendChild(li('<p class="empty">Nichts fällig.</p>'));
  }

  // Gäste-Status
  const last = S.visits[0]?.date;
  const gpill = $('guestPill');
  if (!last) { $('guestBig').textContent = '–'; gpill.className = 'pill warn'; gpill.textContent = 'Noch kein Besuch eingetragen'; }
  else {
    const n = daysSince(last);
    $('guestBig').innerHTML = n + '<small>' + (n === 1 ? 'Tag' : 'Tage') + ' seit dem letzten Besuch</small>';
    const [c, t] = n < 5 ? ['ok', 'Alles im Rhythmus'] : n < 7 ? ['warn', 'Bald wieder jemanden einladen'] : ['bad', 'Überfällig, Zeit für eine Einladung'];
    gpill.className = 'pill ' + c; gpill.textContent = t;
  }

  // Haushalt
  const cl = $('choreList'); cl.innerHTML = '';
  const order = S.chores.map(c => ({ c, s: choreState(c) })).sort((a, b) => (a.c.assignee === S.me ? 0 : 1) - (b.c.assignee === S.me ? 0 : 1) || (b.s.due - a.s.due) || (b.s.over - a.s.over) || a.c.name.localeCompare(b.c.name));
  if (!order.length) cl.appendChild(li('<p class="empty">Noch keine Aufgaben.</p>'));
  for (const { c, s } of order) {
    if (editing === c.id) { cl.appendChild(editRow(c)); continue; }
    const l = li('<div class="who"><b>' + esc(c.name) + '</b><div><span class="pill ' + s.cls + '">' + s.text + '</span> · ' + esc(NAME(c.assignee)) + ' · alle ' + c.interval_days + ' Tage' + (c.last_done ? ' · zuletzt ' + fmt(c.last_done) : '') + '</div></div><span class="pts">+' + c.points + '</span>');
    if (c.last_done !== S.today) l.appendChild(btn('Erledigt', 'done', () => act('POST', 'chores/' + c.id + '/done', null, d => '+' + d.points + ' Punkte fürs Team')));
    l.appendChild(btn('Ändern', 'link', () => { editing = c.id; pending = null; render(); }));
    cl.appendChild(l);
  }

  // To-dos
  const tl = $('todoList'); tl.innerHTML = '';
  if (!S.todos.length) tl.appendChild(li('<p class="empty">Keine To-dos.</p>'));
  for (const t of S.todos) {
    const late = !t.done && t.due && daysSince(t.due) > 0;
    const sub = t.done ? 'erledigt von ' + esc(NAME(t.done_by)) : [t.assignee ? 'für ' + esc(NAME(t.assignee)) : 'für beide', t.due ? (late ? '<span class="pill bad">überfällig seit ' + fmt(t.due) + '</span>' : 'bis ' + fmt(t.due)) : ''].filter(Boolean).join(' · ');
    const l = li('<div class="who"><b>' + esc(t.title) + '</b><div>' + sub + '</div></div>', t.done ? 'isdone' : '');
    l.appendChild(btn(t.done ? 'Wieder öffnen' : 'Erledigt', t.done ? 'link' : 'done', () => act('POST', 'todos/' + t.id + '/toggle', null, t.done ? 'Wieder offen' : '+5 Punkte fürs Team')));
    l.appendChild(confirmBtn('t' + t.id, 'Löschen', 'Wirklich löschen?', () => act('DELETE', 'todos/' + t.id, null, 'To-do gelöscht')));
    tl.appendChild(l);
  }

  // Gäste
  const ch = $('vGuests'); ch.innerHTML = '';
  for (const g of S.guests) { const b = btn(g.name, 'chip', () => { selected.has(g.id) ? selected.delete(g.id) : selected.add(g.id); render(); }); b.setAttribute('aria-pressed', selected.has(g.id)); ch.appendChild(b); }
  $('vGuestsEmpty').hidden = S.guests.length > 0;
  const sg = $('suggest'); sg.innerHTML = '';
  const ranked = S.guests.map(g => ({ g, last: lastVisitOf(g.id) })).sort((a, b) => (a.last ? dayNum(a.last) : -1e9) - (b.last ? dayNum(b.last) : -1e9));
  if (!ranked.length) sg.appendChild(li('<p class="empty">Sobald Freunde erfasst sind, erscheinen hier Vorschläge.</p>'));
  for (const { g, last } of ranked) {
    const l = li('<div class="who"><b>' + esc(g.name) + '</b><div>' + (last ? 'zuletzt am ' + fmt(last) + ', ' + ago(daysSince(last)) : 'noch nie eingetragen') + '</div></div>');
    l.appendChild(confirmBtn('g' + g.id, 'Entfernen', 'Wirklich entfernen?', () => act('DELETE', 'guests/' + g.id, null, 'Person entfernt')));
    sg.appendChild(l);
  }
  const h = $('history'); h.innerHTML = '';
  if (!S.visits.length) h.appendChild(li('<p class="empty">Noch keine Besuche.</p>'));
  const gname = id => S.guests.find(g => g.id === id)?.name || 'Entfernte Person';
  for (const v of S.visits.slice(0, 30)) {
    const l = li('<div class="who"><b>' + esc(v.guestIds.map(gname).join(', ') || 'Ohne Namen') + '</b><div>' + fmt(v.date) + (v.note ? ' · ' + esc(v.note) : '') + '</div></div>');
    l.appendChild(confirmBtn('v' + v.id, 'Löschen', 'Wirklich löschen?', () => act('DELETE', 'visits/' + v.id, null, 'Besuch gelöscht')));
    h.appendChild(l);
  }

  // Formulare
  fillSelect($('cWho'), false); fillSelect($('tWho'), true);
  if (!$('vDate').value) { $('vDate').value = S.today; } $('vDate').max = S.today;
  if (document.activeElement?.closest('#settingsForm') == null) {
    $('sMorning').value = S.settings.morning; $('sEvening').value = S.settings.evening; $('sGoal').value = S.teamGoal;
  }
}

function editRow(c) {
  const l = document.createElement('li');
  const f = document.createElement('form'); f.className = 'edit';
  f.innerHTML = '<label>Aufgabe<input type="text" name="name" maxlength="80" required></label><div class="row"><label>Alle … Tage<input type="number" name="iv" min="1" max="365" required></label><label>Punkte<input type="number" name="pts" min="1" max="100" required></label><label>Wer<select name="who"></select></label></div><div class="row"></div>';
  f.name.value = c.name; f.iv.value = c.interval_days; f.pts.value = c.points;
  for (const u of S.users) f.who.add(new Option(u.name, u.key)); f.who.value = c.assignee;
  const bar = f.querySelectorAll('.row')[1];
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = 'Speichern'; bar.appendChild(save);
  bar.appendChild(btn('Abbrechen', 'link', () => { editing = null; render(); }));
  bar.appendChild(confirmBtn('c' + c.id, 'Aufgabe löschen', 'Wirklich löschen?', async () => { editing = null; await act('DELETE', 'chores/' + c.id, null, 'Aufgabe gelöscht'); }));
  f.addEventListener('submit', async e => { e.preventDefault(); editing = null; await act('PATCH', 'chores/' + c.id, { name: f.name.value, interval_days: +f.iv.value, points: +f.pts.value, assignee: f.who.value }, 'Gespeichert'); });
  l.appendChild(f); return l;
}

// Formulare
$('choreForm').addEventListener('submit', async e => { e.preventDefault(); const d = await act('POST', 'chores', { name: $('cName').value, interval_days: +$('cInt').value, points: +$('cPts').value, assignee: $('cWho').value }, 'Aufgabe hinzugefügt'); if (d) $('cName').value = ''; });
$('todoForm').addEventListener('submit', async e => { e.preventDefault(); const d = await act('POST', 'todos', { title: $('tTitle').value, due: $('tDue').value, assignee: $('tWho').value }, 'To-do hinzugefügt'); if (d) { $('tTitle').value = ''; $('tDue').value = ''; } });
$('personForm').addEventListener('submit', async e => { e.preventDefault(); const n = $('pName').value; const d = await act('POST', 'guests', { name: n }, n.trim() + ' hinzugefügt'); if (d) $('pName').value = ''; });
$('visitForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!selected.size) return toast('Bitte mindestens eine Person antippen');
  const d = await act('POST', 'visits', { date: $('vDate').value, guestIds: [...selected], note: $('vNote').value }, 'Besuch gespeichert, je +10 Punkte');
  if (d) { selected.clear(); $('vNote').value = ''; $('vDate').value = S.today; render(); }
});
$('settingsForm').addEventListener('submit', async e => { e.preventDefault(); await act('POST', 'settings', { morning: $('sMorning').value, evening: $('sEvening').value, teamGoal: +$('sGoal').value }, 'Gespeichert'); });
$('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/'; });
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => { tab = b.dataset.tab; pending = null; editing = null; render(); });

// Push
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentSub() { if (!pushSupported) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function updatePushUi() {
  const hint = $('pushHint'), st = $('pushState');
  if (isIOS && !standalone) {
    hint.hidden = false; hint.textContent = 'Für Erinnerungen auf dem iPhone: In Safari auf «Teilen» tippen, dann «Zum Home-Bildschirm». Danach die App vom Home-Bildschirm öffnen und Push aktivieren.';
    st.textContent = 'Auf dem iPhone geht Push nur aus der installierten App vom Home-Bildschirm.';
    $('pushOn').disabled = true; $('pushTest').disabled = true; $('pushOff').hidden = true; return;
  }
  if (!pushSupported) { st.textContent = 'Dieser Browser unterstützt keine Push-Nachrichten.'; $('pushOn').disabled = true; $('pushTest').disabled = true; $('pushOff').hidden = true; hint.hidden = true; return; }
  const sub = await currentSub();
  const denied = Notification.permission === 'denied';
  st.textContent = denied ? 'Mitteilungen sind für diese App blockiert. Bitte in den Geräte-Einstellungen erlauben.' : sub ? 'Push ist auf diesem Gerät aktiv.' : 'Push ist auf diesem Gerät noch nicht aktiv.';
  $('pushOn').hidden = !!sub; $('pushOn').disabled = denied; $('pushOff').hidden = !sub; $('pushTest').disabled = !sub;
  hint.hidden = !!sub || denied; if (!sub && !denied) hint.textContent = 'Push ist auf diesem Gerät noch nicht aktiv. Unter «Einstellungen» einschalten.';
}
const keyBytes = b64 => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); };
$('pushOn').addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Mitteilungen wurden nicht erlaubt'); return updatePushUi(); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.vapidPublicKey) });
    await call('POST', 'push/subscribe', sub.toJSON());
    toast('Push aktiviert');
  } catch (e) { toast('Push konnte nicht aktiviert werden: ' + e.message); }
  updatePushUi();
});
$('pushOff').addEventListener('click', async () => { const s = await currentSub(); if (s) { await call('POST', 'push/unsubscribe', { endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe(); } toast('Push beendet'); updatePushUi(); });
$('pushTest').addEventListener('click', async () => { try { const d = await call('POST', 'push/test'); toast(d.sent ? 'Test-Push gesendet' : 'Kein aktives Gerät gefunden'); } catch (e) { toast(e.message); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S) load(); });
load().then(() => { if (!S) showLogin(); });
