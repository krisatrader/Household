(() => {
'use strict';

/* ---------- Segédfüggvények ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayIso = () => iso(new Date());
const daysUntil = s => Math.round((parse(s) - parse(todayIso())) / 86400000);
const fmtDate = s => s ? parse(s).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const money = n => new Intl.NumberFormat('hu-HU').format(Math.round(n)) + ' Ft';
const sum = a => a.reduce((x, y) => x + y, 0);
const UNITS = [['day', 'nap'], ['week', 'hét'], ['month', 'hónap'], ['year', 'év']];
const unitLabel = u => (UNITS.find(x => x[0] === u) || [])[1] || u;

function addInterval(dateStr, n, unit) {
  const d = parse(dateStr);
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'week') d.setDate(d.getDate() + 7 * n);
  else if (unit === 'month') d.setMonth(d.getMonth() + n);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
  return iso(d);
}
// Következő esedékesség: utolsó elvégzés + gyakoriság; ha még sosem volt, azonnal esedékes.
const nextDue = task => task.lastDone ? addInterval(task.lastDone, task.every, task.unit) : todayIso();
const statusOf = s => { const d = daysUntil(s); return d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 7 ? 'soon' : 'ok'; };
const dueText = s => { const d = daysUntil(s); return d < 0 ? `${-d} napja lejárt` : d === 0 ? 'ma esedékes' : `${d} nap múlva`; };

/* ---------- Adattárolás ---------- */
const KEY = 'hhm.v1';
const COLS = ['tasks', 'reminders', 'documents', 'costs', 'notes', 'info'];
let state = load();
let tab = 'tasks';

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.topics)) {
      s.topics.forEach(t => COLS.forEach(c => { t[c] ||= []; }));
      return s;
    }
  } catch { /* hibás adat: üres állapot */ }
  return { topics: [] };
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  document.dispatchEvent(new Event('hhm:changed')); // Drive automatikus mentéshez
}
const topicById = id => state.topics.find(t => t.id === id);
function findItem(col, id) {
  for (const topic of state.topics) {
    const item = topic[col].find(x => x.id === id);
    if (item) return { topic, item };
  }
  return null;
}
function newTopic(name, icon) {
  const t = { id: uid(), name, icon };
  COLS.forEach(c => { t[c] = []; });
  return t;
}

/* ---------- Fájlok (IndexedDB) ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('hhm-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbTx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}
const idbPut = (k, v) => idbTx('readwrite', s => s.put(v, k));
const idbGet = k => idbTx('readonly', s => s.get(k));
const idbDel = k => idbTx('readwrite', s => s.delete(k));

/* ---------- Űrlap-sémák ---------- */
const SCHEMA = {
  tasks: { title: 'Feladat', fields: [
    { name: 'name', label: 'Feladat neve', required: true },
    { name: 'every', label: 'Gyakoriság (szám)', type: 'number', min: 1, required: true, value: 1 },
    { name: 'unit', label: 'Egység', type: 'select', options: UNITS, value: 'month' },
    { name: 'lastDone', label: 'Utoljára elvégezve', type: 'date' },
    { name: 'notes', label: 'Megjegyzés', type: 'textarea' }
  ] },
  reminders: { title: 'Emlékeztető', fields: [
    { name: 'title', label: 'Mi legyen?', required: true },
    { name: 'date', label: 'Dátum', type: 'date', required: true, value: todayIso }
  ] },
  documents: { title: 'Dokumentum', fields: [
    { name: 'name', label: 'Megnevezés', required: true },
    { name: 'expires', label: 'Lejárat (ha van)', type: 'date' },
    { name: 'location', label: 'Hol található?' },
    { name: 'notes', label: 'Megjegyzés', type: 'textarea' },
    { name: 'file', label: 'Fájl csatolása (PDF, kép)', type: 'file' }
  ] },
  costs: { title: 'Költség', fields: [
    { name: 'date', label: 'Dátum', type: 'date', required: true, value: todayIso },
    { name: 'amount', label: 'Összeg (Ft)', type: 'number', min: 0, required: true },
    { name: 'category', label: 'Kategória', value: '' },
    { name: 'note', label: 'Megjegyzés' }
  ] },
  notes: { title: 'Jegyzet', fields: [
    { name: 'date', label: 'Dátum', type: 'date', required: true, value: todayIso },
    { name: 'text', label: 'Szöveg', type: 'textarea', required: true }
  ] },
  info: { title: 'Információ', fields: [
    { name: 'key', label: 'Megnevezés (pl. Ügyfélszám)', required: true },
    { name: 'value', label: 'Érték', required: true }
  ] }
};
const TABS = [
  { id: 'tasks', label: 'Feladatok', col: 'tasks' },
  { id: 'reminders', label: 'Emlékeztetők', col: 'reminders' },
  { id: 'docs', label: 'Dokumentumok', col: 'documents' },
  { id: 'costs', label: 'Költségek', col: 'costs' },
  { id: 'notes', label: 'Jegyzetek', col: 'notes' },
  { id: 'info', label: 'Infók', col: 'info' }
];

/* ---------- Összesített lista (főoldal és értesítés) ---------- */
function collectItems() {
  const out = [];
  for (const t of state.topics) {
    t.tasks.forEach(k => out.push({ date: nextDue(k), title: k.name, topic: t, kind: 'Feladat', act: 'done-task', id: k.id }));
    t.reminders.filter(r => !r.done).forEach(r => out.push({ date: r.date, title: r.title, topic: t, kind: 'Emlékeztető', act: 'toggle-reminder', id: r.id }));
    t.documents.filter(d => d.expires).forEach(d => out.push({ date: d.expires, title: `${d.name} lejár`, topic: t, kind: 'Dokumentum' }));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- Nézetek ---------- */
const empty = () => '<p class="muted empty-line">Még nincs bejegyzés.</p>';
const btn = (act, id, label, cls = 'ghost small') => `<button class="btn ${cls}" data-act="${act}" data-id="${id}">${label}</button>`;
const editDel = (col, id) => `<button class="btn ghost small" data-act="edit" data-col="${col}" data-id="${id}">Szerk.</button><button class="btn danger small" data-act="del" data-col="${col}" data-id="${id}">Töröl</button>`;

function itemRow(i) {
  const action = i.act ? btn(i.act, i.id, 'Kész', 'primary small') : '';
  return `<div class="item ${statusOf(i.date)}"><div class="grow">
    <div class="item-title">${esc(i.title)}</div>
    <div class="small muted">${esc(i.topic.icon)} ${esc(i.topic.name)} · ${esc(i.kind)} · ${fmtDate(i.date)} (${dueText(i.date)})</div>
  </div><div class="actions">${action}</div></div>`;
}

function topicCard(t) {
  const next = t.tasks.length ? t.tasks.map(nextDue).sort()[0] : '';
  return `<button class="card topic" data-act="open-topic" data-id="${t.id}">
    <span class="icon">${esc(t.icon)}</span>
    <span class="grow"><strong>${esc(t.name)}</strong>
      <span class="muted small block">${t.tasks.length} feladat · ${t.documents.length} dok. · ${t.costs.length} költség</span>
      ${next ? `<span class="small block ${statusOf(next)}">Következő feladat: ${fmtDate(next)}</span>` : ''}
    </span></button>`;
}

function renderHome() {
  const soon = collectItems().filter(i => daysUntil(i.date) <= 30);
  const emptyState = `<div class="card empty"><p>Még nincs téma. Hozz létre egyet, vagy tölts be példa adatokat.</p>
    <button class="btn" data-act="seed">Példa adatok betöltése</button></div>`;
  $('#app').innerHTML = `
    <section>
      <h2>Következő 30 nap</h2>
      ${soon.length ? soon.map(itemRow).join('') : '<p class="muted">Nincs esedékes feladat. 🎉</p>'}
    </section>
    <section>
      <div class="row between"><h2>Témák</h2><button class="btn" data-act="new-topic">+ Új téma</button></div>
      ${state.topics.length ? `<div class="grid">${state.topics.map(topicCard).join('')}</div>` : emptyState}
    </section>`;
}

const LIST = {
  tasks: t => t.tasks.length ? t.tasks.map(k => {
    const due = nextDue(k);
    return `<div class="item ${statusOf(due)}"><div class="grow">
      <div class="item-title">${esc(k.name)}</div>
      <div class="small muted">Gyakoriság: ${k.every} ${unitLabel(k.unit)} · Következő: ${fmtDate(due)} (${dueText(due)})</div>
      ${k.lastDone ? `<div class="small muted">Utoljára: ${fmtDate(k.lastDone)}</div>` : ''}
      ${k.notes ? `<div class="note pre">${esc(k.notes)}</div>` : ''}
    </div><div class="actions">${btn('done-task', k.id, 'Kész', 'primary small')} ${editDel('tasks', k.id)}</div></div>`;
  }).join('') : empty(),

  reminders: t => t.reminders.length ? t.reminders.slice().sort((a, b) => a.date.localeCompare(b.date)).map(r => `
    <div class="item ${r.done ? 'done' : statusOf(r.date)}"><div class="grow">
      <div class="item-title">${esc(r.title)}</div>
      <div class="small muted">${fmtDate(r.date)}${r.done ? ' · kész' : ' · ' + dueText(r.date)}</div>
    </div><div class="actions">${btn('toggle-reminder', r.id, r.done ? 'Visszaállít' : 'Kész', 'primary small')} ${editDel('reminders', r.id)}</div></div>`).join('') : empty(),

  docs: t => t.documents.length ? t.documents.map(d => `
    <div class="item ${d.expires ? statusOf(d.expires) : ''}"><div class="grow">
      <div class="item-title">${esc(d.name)}</div>
      ${d.expires ? `<div class="small muted">Lejár: ${fmtDate(d.expires)} (${dueText(d.expires)})</div>` : ''}
      ${d.location ? `<div class="small muted">📍 ${esc(d.location)}</div>` : ''}
      ${d.fileName ? `<div class="small muted">📎 ${esc(d.fileName)}</div>` : ''}
      ${d.notes ? `<div class="note pre">${esc(d.notes)}</div>` : ''}
    </div><div class="actions">${d.fileKey ? btn('open-file', d.fileKey, 'Megnyit', 'primary small') : ''} ${editDel('documents', d.id)}</div></div>`).join('') : empty(),

  costs: t => {
    const month = todayIso().slice(0, 7);
    const cats = {};
    t.costs.forEach(c => { const k = c.category || 'Egyéb'; cats[k] = (cats[k] || 0) + c.amount; });
    const monthTotal = sum(t.costs.filter(c => c.date.startsWith(month)).map(c => c.amount));
    const rows = t.costs.slice().sort((a, b) => b.date.localeCompare(a.date)).map(c => `
      <div class="item"><div class="grow">
        <div class="item-title">${money(c.amount)} · ${esc(c.category || 'Egyéb')}</div>
        <div class="small muted">${fmtDate(c.date)}${c.note ? ' · ' + esc(c.note) : ''}</div>
      </div><div class="actions">${editDel('costs', c.id)}</div></div>`).join('');
    return `<div class="stats">
        <div><span class="muted small">Összesen</span><strong>${money(sum(t.costs.map(c => c.amount)))}</strong></div>
        <div><span class="muted small">Ebben a hónapban</span><strong>${money(monthTotal)}</strong></div>
      </div>
      ${Object.keys(cats).length ? `<div class="chips">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)}: ${money(v)}</span>`).join('')}</div>` : ''}
      ${rows || empty()}`;
  },

  notes: t => t.notes.length ? t.notes.slice().sort((a, b) => b.date.localeCompare(a.date)).map(n => `
    <div class="item"><div class="grow">
      <div class="small muted">${fmtDate(n.date)}</div>
      <div class="pre">${esc(n.text)}</div>
    </div><div class="actions">${editDel('notes', n.id)}</div></div>`).join('') : empty(),

  info: t => t.info.length ? t.info.map(i => `
    <div class="item"><div class="grow">
      <div class="small muted">${esc(i.key)}</div>
      <div class="item-title pre">${esc(i.value)}</div>
    </div><div class="actions">${btn('copy', i.id, 'Másol')} ${editDel('info', i.id)}</div></div>`).join('') : empty()
};

function renderTopic(t) {
  const current = TABS.find(x => x.id === tab);
  $('#app').innerHTML = `
    <div class="topic-head">
      <span class="icon big">${esc(t.icon)}</span>
      <h2 class="grow">${esc(t.name)}</h2>
      <button class="btn ghost small" data-act="edit-topic" data-id="${t.id}">Téma szerk.</button>
      <button class="btn danger small" data-act="del-topic" data-id="${t.id}">Téma törlése</button>
    </div>
    <nav class="tabs">${TABS.map(x => `<button class="tab ${x.id === tab ? 'active' : ''}" data-act="tab" data-id="${x.id}">${x.label}</button>`).join('')}</nav>
    <div class="row between"><h3>${current.label}</h3>
      <button class="btn" data-act="add" data-col="${current.col}" data-id="${t.id}">+ Hozzáad</button></div>
    <div id="list">${LIST[tab](t)}</div>`;
}

function render() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const topic = p[0] === 'topic' && p[1] ? topicById(p[1]) : null;
  $('#back').classList.toggle('hidden', !topic);
  if (!topic) {
    $('#title').textContent = 'Háztartás';
    if (p[0] === 'topic') { location.hash = ''; return; }
    return renderHome();
  }
  $('#title').textContent = `${topic.icon} ${topic.name}`;
  renderTopic(topic);
}

/* ---------- Modális ablakok és űrlapok ---------- */
const modal = $('#modal');
const openModal = html => { $('#modal-body').innerHTML = html; modal.classList.remove('hidden'); };
const closeModal = () => modal.classList.add('hidden');

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 2200);
}

function fieldHtml(f, v, hasFile) {
  const val = v ?? (typeof f.value === 'function' ? f.value() : f.value) ?? '';
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') {
    input = `<select name="${f.name}">${f.options.map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" rows="3" ${req}>${esc(val)}</textarea>`;
  } else if (f.type === 'file') {
    input = `<input type="file" name="${f.name}" accept="application/pdf,image/*,.doc,.docx,.txt">
      ${hasFile ? '<small class="muted">Már van csatolt fájl; új kiválasztásával lecserélhető.</small>' : ''}`;
  } else {
    input = `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(val)}" ${req}
      ${f.min != null ? `min="${f.min}"` : ''} ${f.type === 'number' ? 'step="any"' : ''}>`;
  }
  return `<label class="field"><span>${esc(f.label)}</span>${input}</label>`;
}

function openForm(title, fields, values, hasFile, onSubmit) {
  openModal(`<h2>${esc(title)}</h2>
    <form class="form">${fields.map(f => fieldHtml(f, values[f.name], hasFile && f.type === 'file')).join('')}
      <div class="row end">
        <button type="button" class="btn ghost" data-close>Mégse</button>
        <button class="btn" type="submit">Mentés</button>
      </div>
    </form>`);
  const form = $('#modal-body form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      data[f.name] = f.type === 'file' ? (el.files[0] || null) : el.value.trim();
    }
    closeModal();
    await onSubmit(data);
  });
}

function openCrud(col, topic, itemId) {
  const s = SCHEMA[col];
  const found = itemId ? findItem(col, itemId) : null;
  const cur = found ? found.item : {};
  const target = found ? found.topic : topic;
  openForm(`${found ? 'Szerkesztés' : 'Új'}: ${s.title}`, s.fields, cur, col === 'documents' && !!cur.fileKey, async data => {
    const obj = {};
    for (const f of s.fields) if (f.type !== 'file') obj[f.name] = f.type === 'number' ? Number(data[f.name]) : data[f.name];
    if (col === 'documents' && data.file) {
      if (cur.fileKey) await idbDel(cur.fileKey);
      obj.fileKey = uid();
      obj.fileName = data.file.name;
      await idbPut(obj.fileKey, data.file);
    }
    if (found) Object.assign(found.item, obj);
    else target[col].push({ id: uid(), ...obj });
    save();
    render();
    toast('Mentve');
  });
}

function openTopicForm(t) {
  openForm(t ? 'Téma szerkesztése' : 'Új téma', [
    { name: 'icon', label: 'Ikon (emoji)', value: '🏠' },
    { name: 'name', label: 'Téma neve (pl. Autó, Kert, Biztosítások)', required: true }
  ], t || {}, false, data => {
    if (t) {
      t.name = data.name;
      t.icon = data.icon || '📁';
    } else {
      const nt = newTopic(data.name, data.icon || '📁');
      state.topics.push(nt);
      location.hash = `#/topic/${nt.id}`;
    }
    save();
    render();
  });
}

async function deleteItem(col, id) {
  const f = findItem(col, id);
  if (!f || !confirm('Biztosan törlöd?')) return;
  if (f.item.fileKey) await idbDel(f.item.fileKey);
  f.topic[col] = f.topic[col].filter(x => x.id !== id);
  save();
  render();
}

async function deleteTopic(t) {
  if (!confirm(`Törlöd a „${t.name}” témát minden adatával együtt?`)) return;
  for (const d of t.documents) if (d.fileKey) await idbDel(d.fileKey);
  state.topics = state.topics.filter(x => x.id !== t.id);
  save();
  location.hash = '';
  render();
}

/* ---------- Példa adatok ---------- */
function seedData() {
  const ago = n => addInterval(todayIso(), -n, 'day');
  const ahead = n => addInterval(todayIso(), n, 'day');

  const lakas = newTopic('Lakás', '🏠');
  lakas.tasks.push({ id: uid(), name: 'Légszűrő csere', every: 3, unit: 'month', lastDone: ago(40), notes: '' });
  lakas.tasks.push({ id: uid(), name: 'Kazán éves szerviz', every: 1, unit: 'year', lastDone: ago(200), notes: 'Szerviz telefonszáma: (ide írd)' });
  lakas.tasks.push({ id: uid(), name: 'Füstérzékelő tesztelése', every: 1, unit: 'month', lastDone: '', notes: '' });
  lakas.info.push({ id: uid(), key: 'Gázszolgáltató ügyfélszáma', value: '(ide írd be)' });
  lakas.notes.push({ id: uid(), date: todayIso(), text: 'Példa jegyzet: a szerelő csütörtökön jön.' });

  const auto = newTopic('Autó', '🚗');
  auto.tasks.push({ id: uid(), name: 'Olajcsere', every: 12, unit: 'month', lastDone: ago(300), notes: '' });
  auto.reminders.push({ id: uid(), title: 'Műszaki vizsga időpont', date: ahead(20), done: false });
  auto.costs.push({ id: uid(), date: ago(10), amount: 18500, category: 'Szerviz', note: 'Olajcsere' });

  const dok = newTopic('Dokumentumok', '📄');
  dok.documents.push({ id: uid(), name: 'Lakásbiztosítási kötvény', expires: ahead(45), location: 'Irattartó, A mappa', notes: '' });

  state.topics.push(lakas, auto, dok);
  save();
}

/* ---------- Beállítások, export, import ---------- */
function openMenu() {
  openModal(`<h2>Beállítások</h2>
    <h3>Google Drive</h3>
    <p class="small muted">${esc(window.HHM?.driveStatus?.() ?? '')}</p>
    <div class="menu-list">
      <button class="btn" data-act="drive-connect">Csatlakozás / mentés most</button>
      <button class="btn" data-act="drive-restore">Visszaállítás Drive-ról</button>
      <button class="btn ghost" data-act="drive-setup">Google kliensazonosító beállítása</button>
      <button class="btn ghost" data-act="drive-disconnect">Leválasztás a Drive-ról</button>
    </div>
    <h3>Helyi adatok</h3>
    <div class="menu-list">
      <button class="btn" data-act="export">Adatok exportálása (JSON)</button>
      <button class="btn" data-act="import">Adatok importálása (JSON)</button>
      <button class="btn" data-act="notif">Értesítések engedélyezése</button>
      <button class="btn danger" data-act="wipe">Minden adat törlése</button>
      <button class="btn ghost" data-close>Bezár</button>
    </div>
    <p class="small muted">A Drive-mentés a szöveges adatokat és a csatolt fájlokat is tartalmazza. Az exportfájl csak a szöveges adatokat tartalmazza.</p>`);
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `haztartas-${todayIso()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    if (!Array.isArray(obj.topics)) throw new Error('bad');
    if (!confirm('A jelenlegi szöveges adatok felülíródnak. Folytatod?')) return;
    state = obj;
    state.topics.forEach(t => COLS.forEach(c => { t[c] ||= []; }));
    save();
    closeModal();
    render();
    toast('Importálva');
  } catch {
    toast('Hibás fájl');
  }
});

async function openFile(key) {
  const blob = await idbGet(key);
  if (!blob) return toast('A fájl nem található');
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- Értesítések ---------- */
function checkDue() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (localStorage.getItem('hhm.notified') === todayIso()) return;
  const n = collectItems().filter(i => i.act && daysUntil(i.date) <= 0).length;
  if (!n) return;
  new Notification('Háztartás', { body: `${n} esedékes feladat vagy emlékeztető` });
  localStorage.setItem('hhm.notified', todayIso());
}

/* ---------- Eseménykezelés ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act],[data-close]');
  if (!el) {
    if (e.target === modal) closeModal();
    return;
  }
  if (el.hasAttribute('data-close')) return closeModal();

  const { act, id, col } = el.dataset;
  switch (act) {
    case 'seed': seedData(); render(); break;
    case 'new-topic': openTopicForm(null); break;
    case 'open-topic': tab = 'tasks'; location.hash = `#/topic/${id}`; break;
    case 'edit-topic': openTopicForm(topicById(id)); break;
    case 'del-topic': await deleteTopic(topicById(id)); break;
    case 'tab': tab = id; render(); break;
    case 'add': openCrud(col, topicById(id)); break;
    case 'edit': openCrud(col, null, id); break;
    case 'del': await deleteItem(col, id); break;
    case 'done-task': {
      const f = findItem('tasks', id);
      if (f) { f.item.lastDone = todayIso(); save(); render(); toast('Elvégezve, a következő időpont frissült'); }
      break;
    }
    case 'toggle-reminder': {
      const f = findItem('reminders', id);
      if (f) { f.item.done = !f.item.done; save(); render(); }
      break;
    }
    case 'open-file': await openFile(id); break;
    case 'copy': {
      const f = findItem('info', id);
      if (f) { await navigator.clipboard?.writeText(f.item.value); toast('Vágólapra másolva'); }
      break;
    }
    case 'menu': openMenu(); break;
    case 'export': exportData(); break;
    case 'import': $('#import-file').click(); break;
    case 'notif': {
      if (!('Notification' in window)) return toast('A böngésző nem támogatja');
      const perm = await Notification.requestPermission();
      toast(perm === 'granted' ? 'Értesítések bekapcsolva' : 'Nincs engedély');
      checkDue();
      break;
    }
    case 'wipe': {
      if (!confirm('Minden adat véglegesen törlődik. Biztos?')) break;
      await idbTx('readwrite', s => s.clear());
      state = { topics: [] };
      save();
      closeModal();
      location.hash = '';
      render();
      toast('Minden adat törölve');
      break;
    }
  }
});

$('#menu').addEventListener('click', openMenu);
$('#back').addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', render);

// Felület a drive.js modul számára
window.HHM = {
  get state() { return state; },
  setState(s) {
    state = s;
    state.topics.forEach(t => COLS.forEach(c => { t[c] ||= []; }));
    save();
    render();
  },
  save, render, toast, openForm, closeModal, idbGet, idbPut,
  driveStatus: null
};

render();
checkDue();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline nélkül is működik */ });
}
})();
