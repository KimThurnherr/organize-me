'use strict';
const $ = id => document.getElementById(id);
let S = null, tab = 'home', pending = null, editing = null, selected = new Set(), busy = false;
let weekOffset = null, mealsDirty = false, mealsKey = '';
let H = null, hDate = null, hMonth = null, hPerson = null, hEditing = null, CH = null, cMonth = null;
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WDS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const dstrN = n => new Date(n * 864e5).toISOString().slice(0, 10);
const monthLabel = m => MONTHS[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
const shiftMonth = (m, d) => { let y = +m.slice(0, 4), mo = +m.slice(5) + d; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return y + '-' + String(mo).padStart(2, '0'); };
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
  if (tab === 'health') loadHealth();
  if (tab === 'chores') loadChoreHist();
}
function showLogin() {
  $('app').hidden = true; $('login').hidden = false; $('whoami').textContent = '';
  const p = new URLSearchParams(location.search).get('login');
  const m = $('loginMsg');
  if (p === 'nicht-erlaubt') { m.hidden = false; m.textContent = 'Dieses Google-Konto ist nicht freigegeben.'; }
  else if (p === 'fehler') { m.hidden = false; m.textContent = 'Anmeldung fehlgeschlagen. Bitte nochmals versuchen.'; }
}

function choreState(c) {
  const monthly = !!(c.month_nth && c.month_wday);
  if (!monthly && !c.last_done && !c.due_override) return { due: true, over: 0, text: 'noch nie erledigt', cls: 'warn' };
  const left = typeof c.due_in === 'number' ? c.due_in : (c.due_override ? dayNum(c.due_override) - dayNum(S.today) : c.interval_days - daysSince(c.last_done));
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

  // Essen
  renderMeals();

  // Gesundheit heute (Startseite)
  const hh = $('healthHome'); hh.innerHTML = '';
  for (const it of S.healthToday.items) hh.appendChild(checkItem(it, S.today));
  $('healthHomeCard').hidden = !S.healthToday.items.length;
  const hOpen = S.healthToday.items.filter(i => !i.done).length;
  $('badgeHealth').hidden = !hOpen; $('badgeHealth').textContent = hOpen;
  if (tab === 'health') renderHealth();
  if (tab === 'chores') renderChoreHist();

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

  // Lange nicht gesehen
  $('absentBox').hidden = !S.longAbsent.length;
  $('absentHint').textContent = 'Seit über ' + Math.round(S.guestRemindDays / 30) + ' Monaten nicht mehr da:';
  const al = $('absentList'); al.innerHTML = '';
  for (const g of S.longAbsent) al.appendChild(li('<div class="who"><b>' + esc(g.name) + '</b><div>' + (g.last_visit ? 'zuletzt am ' + fmt(g.last_visit) + ', vor ' + g.days + ' Tagen' : 'noch nie da') + '</div></div>'));

  // Haushalt
  const cl = $('choreList'); cl.innerHTML = '';
  const order = S.chores.map(c => ({ c, s: choreState(c) })).sort((a, b) => (a.c.assignee === S.me ? 0 : 1) - (b.c.assignee === S.me ? 0 : 1) || (b.s.due - a.s.due) || (b.s.over - a.s.over) || a.c.name.localeCompare(b.c.name));
  if (!order.length) cl.appendChild(li('<p class="empty">Noch keine Aufgaben.</p>'));
  for (const { c, s } of order) {
    if (editing === c.id) { cl.appendChild(editRow(c)); continue; }
    const l = li('<div class="who"><b>' + esc(c.name) + '</b><div><span class="pill ' + s.cls + '">' + s.text + '</span> · ' + esc(NAME(c.assignee)) + ' · ' + esc(c.rule || ('alle ' + c.interval_days + ' Tage')) + (c.event_date ? ' · nächster Termin ' + fmt(c.event_date) : '') + (c.last_done && c.last_by ? ' · zuletzt ' + fmt(c.last_done) : '') + '</div></div><span class="pts">+' + c.points + '</span>');
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

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const dstr = n => new Date(n * 864e5).toISOString().slice(0, 10);
function renderMeals() {
  const todayN = dayNum(S.today), isSunday = new Date(todayN * 864e5).getUTCDay() === 0;
  if (weekOffset === null) weekOffset = isSunday ? 1 : 0;
  const meal = S.meals.find(m => m.date === S.today);
  const mt = $('mealToday');
  mt.className = 'meal-today' + (meal ? '' : ' none');
  mt.textContent = meal ? meal.title + (meal.note ? ' (' + meal.note + ')' : '') : 'Noch nichts geplant.';
  const nextPlanned = S.meals.filter(m => dayNum(m.date) > todayN && dayNum(m.date) <= todayN + 7).length;
  const ph = $('planHint');
  ph.hidden = !(isSunday && nextPlanned < 5);
  ph.textContent = 'Heute ist Planungstag: Für die nächste Woche sind erst ' + nextPlanned + ' von 7 Tagen geplant.';
  // Woche
  const ws = weekStart(S.today) + weekOffset * 7;
  $('weekLabel').textContent = weekOffset === 0 ? 'Diese Woche' : weekOffset === 1 ? 'Nächste Woche' : weekOffset === -1 ? 'Letzte Woche' : fmt(dstr(ws));
  $('weekPrev').disabled = weekOffset <= -1; $('weekNext').disabled = weekOffset >= 1;
  const key = ws + '|' + JSON.stringify(S.meals);
  if (mealsDirty || key === mealsKey) return;
  mealsKey = key;
  const dl = $('mealIdeas'); dl.innerHTML = '';
  for (const t of S.mealIdeas) dl.appendChild(new Option(t));
  const ul = $('mealList'); ul.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = dstr(ws + i), m = S.meals.find(x => x.date === d);
    const l = document.createElement('li');
    l.innerHTML = '<div class="day' + (d === S.today ? ' today' : '') + '"><label class="dl" for="meal-' + d + '">' + WD[new Date((ws + i) * 864e5).getUTCDay()] + '<small>' + fmt(d).slice(0, 6) + '</small></label><input type="text" id="meal-' + d + '" data-date="' + d + '" list="mealIdeas" maxlength="120" placeholder="Gericht"></div>';
    const inp = l.querySelector('input'); inp.value = m ? m.title : ''; inp.dataset.orig = inp.value;
    inp.addEventListener('input', () => { mealsDirty = true; });
    ul.appendChild(l);
  }
}

// ---------- Gesundheit ----------
function checkItem(it, date) {
  const l = document.createElement('li');
  const b = document.createElement('button'); b.type = 'button'; b.className = 'check'; b.setAttribute('aria-pressed', it.done);
  b.innerHTML = '<span class="box">' + (it.done ? '✓' : '') + '</span><span class="lbl">' + esc(it.name) + (it.only_for ? ' <small>nur ' + esc(NAME(it.only_for)) + '</small>' : '') + '</span>';
  b.addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { await call('POST', 'health/check', { item_id: it.id, date, done: !it.done }); } catch (e) { toast(e.message); }
    busy = false; await load();
  });
  l.appendChild(b); return l;
}
async function loadHealth() {
  if (!hDate) hDate = S.today; if (!hMonth) hMonth = S.today.slice(0, 7); if (!hPerson) hPerson = S.me;
  try { H = await call('GET', 'health?date=' + hDate + '&month=' + hMonth + '&person=' + hPerson); } catch (e) { return toast(e.message); }
  renderHealth();
}
function renderHealth() {
  if (!H) return;
  const d = H.day, back = dayNum(S.today) - dayNum(d.date);
  $('hdLabel').textContent = back === 0 ? 'Heute' : back === 1 ? 'Gestern' : WDS[new Date(dayNum(d.date) * 864e5).getUTCDay()] + ' ' + fmt(d.date).slice(0, 6);
  $('hdNext').disabled = back <= 0; $('hdPrev').disabled = back >= 60;
  const done = d.items.filter(i => i.done).length;
  const pill = $('hdPill'); pill.textContent = done + ' von ' + d.items.length; pill.className = 'pill ' + (done === d.items.length && done ? 'ok' : 'warn');
  const ul = $('healthDay'); ul.innerHTML = '';
  for (const it of d.items) ul.appendChild(checkItem(it, d.date));
  if (!d.items.length) ul.appendChild(li('<p class="empty">Keine Punkte für dich. Unten hinzufügen.</p>'));

  const st = H.stats;
  $('hmLabel').textContent = monthLabel(st.month);
  $('hmNext').disabled = st.month >= S.today.slice(0, 7);
  const pc = $('hsPeople'); pc.innerHTML = '';
  for (const u of S.users) { const b = btn(u.name, 'chip', () => { hPerson = u.key; loadHealth(); }); b.setAttribute('aria-pressed', u.key === hPerson); pc.appendChild(b); }
  const act = st.items.filter(i => i.possible_days);
  const avg = act.length ? Math.round(act.reduce((a, i) => a + i.percent, 0) / act.length) : 0;
  $('healthSummary').innerHTML = '<div class="stat"><b>' + st.complete_days + '</b><span>Tage alles erledigt</span></div><div class="stat"><b>' + avg + ' %</b><span>Durchschnitt</span></div><div class="stat"><b>' + st.days + '</b><span>Tage erfasst</span></div>';
  const box = $('healthStats'); box.innerHTML = '';
  const [y, m] = st.month.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (const it of st.items) {
    const dv = document.createElement('div'); dv.className = 'hitem';
    let cal = '';
    for (let i = 1; i <= dim; i++) {
      const ds = st.month + '-' + String(i).padStart(2, '0');
      const cls = ds > S.today ? 'future' : it.dates.includes(ds) ? 'on' : ds < it.since ? 'na' : '';
      cal += '<i class="' + cls + '" title="' + fmt(ds) + '"></i>';
    }
    dv.innerHTML = '<div class="top"><b>' + esc(it.name) + (it.active ? '' : ' <small class="hint">(pausiert)</small>') + '</b><span>' + it.done_days + ' von ' + it.possible_days + ' Tagen · ' + it.percent + ' %' + (it.streak > 1 ? ' · Serie ' + it.streak + ' Tage' : '') + '</span></div><div class="cal">' + cal + '</div>';
    box.appendChild(dv);
  }
  if (!st.items.length) box.innerHTML = '<p class="empty">Keine Daten in diesem Monat.</p>';

  // Verwaltung
  const il = $('healthItems'); il.innerHTML = '';
  for (const it of H.items) {
    if (hEditing === it.id) {
      const l = document.createElement('li'); const f = document.createElement('form'); f.className = 'row'; f.style.width = '100%';
      f.innerHTML = '<label class="grow">Name<input type="text" name="n" maxlength="80" required></label><label style="flex:0 1 140px">Für<select name="p"></select></label>';
      f.n.value = it.name; f.p.add(new Option('Beide', '')); for (const u of S.users) f.p.add(new Option(u.name, u.key)); f.p.value = it.person || '';
      const sv = document.createElement('button'); sv.type = 'submit'; sv.className = 'primary'; sv.textContent = 'Speichern'; f.appendChild(sv);
      f.appendChild(btn('Abbrechen', 'link', () => { hEditing = null; renderHealth(); }));
      f.addEventListener('submit', async e => { e.preventDefault(); hEditing = null; await act('PATCH', 'health/items/' + it.id, { name: f.n.value, person: f.p.value }, 'Gespeichert'); });
      l.appendChild(f); il.appendChild(l); continue;
    }
    const l = li('<div class="who"><b>' + esc(it.name) + '</b><div>' + (it.person ? 'nur ' + esc(NAME(it.person)) : 'für beide') + (it.active ? '' : ' · pausiert') + '</div></div>');
    l.appendChild(btn('Ändern', 'link', () => { hEditing = it.id; pending = null; renderHealth(); }));
    l.appendChild(btn(it.active ? 'Pausieren' : 'Aktivieren', 'link', () => act('PATCH', 'health/items/' + it.id, { active: !it.active }, it.active ? 'Pausiert' : 'Aktiviert')));
    l.appendChild(confirmBtn('h' + it.id, 'Löschen', 'Samt Verlauf löschen?', () => act('DELETE', 'health/items/' + it.id, null, 'Gelöscht')));
    il.appendChild(l);
  }
  fillSelect($('hiWho'), true);
}

// ---------- Haushalt: Verlauf & Statistik ----------
async function loadChoreHist() {
  if (!cMonth) cMonth = S.today.slice(0, 7);
  try { CH = await call('GET', 'chores/history?month=' + cMonth); } catch (e) { return toast(e.message); }
  renderChoreHist();
}
function renderChoreHist() {
  if (!CH) return;
  const st = CH.stats;
  $('cmLabel').textContent = monthLabel(st.month);
  $('cmNext').disabled = st.month >= S.today.slice(0, 7);
  let sum = '<div class="stat"><b>' + st.total + '</b><span>Erledigungen</span></div>';
  for (const u of S.users) sum += '<div class="stat"><b>' + (st.by_person[u.key] || 0) + '</b><span>' + esc(u.name) + '</span></div>';
  sum += '<div class="stat"><b>' + (st.on_time_percent === null ? '–' : st.on_time_percent + ' %') + '</b><span>pünktlich</span></div>';
  $('choreSummary').innerHTML = sum;
  let t = '<thead><tr><th>Aufgabe</th><th>Wer</th><th>Erledigt</th><th>Ø Abstand</th><th>Verspätet</th></tr></thead><tbody>';
  for (const c of st.chores.slice().sort((a, b) => (b.count / (b.expected || 1)) - (a.count / (a.expected || 1)) || a.name.localeCompare(b.name))) {
    const ratio = c.expected ? c.count / c.expected : 1;
    const cls = ratio >= 1 ? 'ok-t' : ratio >= .5 ? 'warn-t' : 'bad-t';
    t += '<tr><td class="name">' + esc(c.name) + '</td><td>' + esc(NAME(c.assignee)) + '</td><td class="n ' + cls + '">' + c.count + ' / ' + c.expected + '</td><td class="n">' + (c.avg_gap_days === null ? '–' : c.avg_gap_days + ' T') + ' <small class="hint">(' + (c.rule && c.rule.includes('im Monat') ? 'monatl.' : c.interval_days) + ')</small></td><td class="n">' + (c.late ? '<span class="bad-t">' + c.late + '×, max ' + c.max_days_late + ' T</span>' : (c.on_time ? '<span class="ok-t">nie</span>' : '–')) + '</td></tr>';
  }
  $('choreStats').innerHTML = t + '</tbody>';
  const hl = $('choreHistory'); hl.innerHTML = '';
  if (!CH.history.length) hl.appendChild(li('<p class="empty">Noch nichts erledigt in diesem Monat.</p>'));
  for (const e of CH.history) {
    const l = li('<div class="who"><b>' + esc(e.name) + '</b><div>' + WDS[new Date(dayNum(e.date) * 864e5).getUTCDay()] + ' ' + fmt(e.date) + ' · ' + esc(NAME(e.by)) + ' · +' + e.points + '</div></div>');
    l.appendChild(confirmBtn('ch' + e.log_id, 'Entfernen', 'Wirklich entfernen?', () => act('DELETE', 'chores/history/' + e.log_id, null, 'Eintrag entfernt')));
    hl.appendChild(l);
  }
}

// Felder für den Rhythmus: alle n Tage oder n-ter Wochentag im Monat
const WD_FULL = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
function rhythmHtml() {
  return '<div class="row"><label>Rhythmus<select name="mode"><option value="days">Alle … Tage</option><option value="month">Monatlich (Wochentag)</option></select></label></div>' +
    '<div class="row" data-m="days"><label>Alle … Tage<input type="number" name="iv" min="1" max="365" value="7"></label></div>' +
    '<div class="row" data-m="month" hidden><label>Welcher<select name="nth"><option value="1">1.</option><option value="2">2.</option><option value="3">3.</option><option value="4">4.</option><option value="-1">letzter</option></select></label>' +
    '<label>Wochentag<select name="wd">' + WD_FULL.map((w, i) => '<option value="' + (i + 1) + '">' + w + '</option>').join('') + '</select></label>' +
    '<label>Tage vorher<input type="number" name="lead" min="0" max="14" value="0"></label>' +
    '<label>Erinnerung<select name="slot"><option value="both">Morgen und Abend</option><option value="morning">Morgen</option><option value="evening">Abend</option></select></label></div>';
}
function rhythmWire(f, c) {
  const sync = () => f.querySelectorAll('[data-m]').forEach(r => { r.hidden = r.dataset.m !== f.mode.value; r.querySelectorAll('input').forEach(i => { i.required = !r.hidden; }); });
  if (c) {
    if (c.month_nth && c.month_wday) { f.mode.value = 'month'; f.nth.value = c.month_nth; f.wd.value = c.month_wday; f.lead.value = c.lead_days || 0; f.slot.value = c.remind_slot || 'both'; }
    else f.iv.value = c.interval_days;
  }
  f.mode.addEventListener('change', sync); sync();
}
function rhythmBody(f) {
  if (f.mode.value === 'month') return { monthly_nth: +f.nth.value, monthly_weekday: +f.wd.value, lead_days: +f.lead.value || 0, remind_slot: f.slot.value };
  return { interval_days: +f.iv.value, monthly_nth: 0 };
}

function editRow(c) {
  const l = document.createElement('li');
  const f = document.createElement('form'); f.className = 'edit';
  f.innerHTML = '<label>Aufgabe<input type="text" name="name" maxlength="80" required></label>' + rhythmHtml() + '<div class="row"><label>Punkte<input type="number" name="pts" min="1" max="100" required></label><label>Wer<select name="who"></select></label></div><div class="row"></div>';
  f.name.value = c.name; f.pts.value = c.points; rhythmWire(f, c);
  for (const u of S.users) f.who.add(new Option(u.name, u.key)); f.who.value = c.assignee;
  const bar = f.querySelectorAll('.row')[1];
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = 'Speichern'; bar.appendChild(save);
  bar.appendChild(btn('Abbrechen', 'link', () => { editing = null; render(); }));
  bar.appendChild(confirmBtn('c' + c.id, 'Aufgabe löschen', 'Wirklich löschen?', async () => { editing = null; await act('DELETE', 'chores/' + c.id, null, 'Aufgabe gelöscht'); }));
  f.addEventListener('submit', async e => { e.preventDefault(); editing = null; await act('PATCH', 'chores/' + c.id, { name: f.name.value, ...rhythmBody(f), points: +f.pts.value, assignee: f.who.value }, 'Gespeichert'); });
  l.appendChild(f); return l;
}

// Formulare
$('cRhythm').innerHTML = rhythmHtml(); rhythmWire($('choreForm'));
$('choreForm').addEventListener('submit', async e => { e.preventDefault(); const body = rhythmBody($('choreForm')); if (body.monthly_nth === 0) delete body.monthly_nth; const d = await act('POST', 'chores', { name: $('cName').value, ...body, points: +$('cPts').value, assignee: $('cWho').value }, 'Aufgabe hinzugefügt'); if (d) $('cName').value = ''; });
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
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => { tab = b.dataset.tab; pending = null; editing = null; hEditing = null; render(); if (tab === 'health') loadHealth(); if (tab === 'chores') loadChoreHist(); });

// Gesundheit & Verlauf
$('toHealth').addEventListener('click', () => { tab = 'health'; render(); loadHealth(); });
$('hdPrev').addEventListener('click', () => { hDate = dstrN(dayNum(hDate) - 1); loadHealth(); });
$('hdNext').addEventListener('click', () => { hDate = dstrN(dayNum(hDate) + 1); loadHealth(); });
$('hmPrev').addEventListener('click', () => { hMonth = shiftMonth(hMonth, -1); loadHealth(); });
$('hmNext').addEventListener('click', () => { hMonth = shiftMonth(hMonth, 1); loadHealth(); });
$('cmPrev').addEventListener('click', () => { cMonth = shiftMonth(cMonth, -1); loadChoreHist(); });
$('cmNext').addEventListener('click', () => { cMonth = shiftMonth(cMonth, 1); loadChoreHist(); });
$('healthItemForm').addEventListener('submit', async e => { e.preventDefault(); const d = await act('POST', 'health/items', { name: $('hiName').value, person: $('hiWho').value }, 'Hinzugefügt'); if (d) $('hiName').value = ''; });

// Essen
$('toMeals').addEventListener('click', () => { tab = 'meals'; render(); });
$('weekPrev').addEventListener('click', () => { if (mealsDirty) return toast('Bitte zuerst speichern'); weekOffset--; mealsKey = ''; render(); });
$('weekNext').addEventListener('click', () => { if (mealsDirty) return toast('Bitte zuerst speichern'); weekOffset++; mealsKey = ''; render(); });
$('mealForm').addEventListener('submit', async e => {
  e.preventDefault();
  const changed = [...document.querySelectorAll('#mealList input')].filter(i => i.value.trim() !== i.dataset.orig);
  if (!changed.length) { mealsDirty = false; return toast('Nichts geändert'); }
  let pts = 0;
  try { for (const i of changed) { const d = await call('POST', 'meals', { date: i.dataset.date, title: i.value }); pts += d.points || 0; } }
  catch (err) { return toast(err.message); }
  mealsDirty = false; mealsKey = '';
  toast(pts ? 'Plan gespeichert, +' + pts + ' Punkte fürs Team' : 'Plan gespeichert');
  await load();
});

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
