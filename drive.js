// Háztartás – Google Drive mentés (a felhasználó saját Drive-ján, a rejtett „appDataFolder” mappában).
// A kliensazonosítót a felhasználó a Beállítások > Google kliensazonosító menüpontban adja meg.
(() => {
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const BACKUP = 'haztartas-backup.json';
const CLIENT_KEY = 'hhm.gclient';
const CONN_KEY = 'hhm.gconn';
const LAST_KEY = 'hhm.glast';

let token = null;
let tokenExp = 0;
let syncTimer = null;
let busy = false;
let pending = false;
let restoring = false;

const H = () => window.HHM;
const clientId = () => localStorage.getItem(CLIENT_KEY) || '';
const connected = () => localStorage.getItem(CONN_KEY) === '1';

/* ---------- Azonosítás (Google Identity Services) ---------- */
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = res;
    s.onerror = () => rej(new Error('nem tölthető be a Google azonosító'));
    document.head.appendChild(s);
  });
}

// A popup-hoz szükség van a felhasználói kattintásra, ezért a GIS-t előre betöltjük,
// és nem köztesen várunk, mielőtt a token-kérés elindul.
async function getToken(interactive) {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (!clientId()) throw new Error('nincs beállítva a Google kliensazonosító');
  if (!window.google?.accounts?.oauth2) await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: r => {
        if (r.error) return rej(new Error(r.error));
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        res(token);
      },
      error_callback: e => rej(new Error(e.message || e.type || 'azonosítási hiba'))
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

async function api(url, opts = {}) {
  const t = await getToken(false);
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (res.status === 401) token = null;
  if (!res.ok) throw new Error(`Drive hiba (${res.status})`);
  return res;
}

/* ---------- Drive műveletek ---------- */
async function listFiles() {
  const res = await api(`${API}?spaces=appDataFolder&pageSize=1000&fields=files(id,name)`);
  return (await res.json()).files || [];
}

async function createFile(name, body, mime) {
  const boundary = 'hhm' + Date.now().toString(36);
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const payload = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    body,
    `\r\n--${boundary}--`
  ]);
  return api(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: payload
  });
}

async function backup(knownFiles) {
  const st = H().state;
  const files = knownFiles || await listFiles();
  const names = new Set(files.map(f => f.name));
  const used = new Set();

  // Csatolmányok: egyszer töltődnek fel, a kulcsuk egyedi (csere esetén új kulcs jön létre).
  for (const t of st.topics) for (const d of t.documents) {
    if (!d.fileKey) continue;
    const name = 'file-' + d.fileKey;
    used.add(name);
    if (!names.has(name)) {
      const blob = await H().idbGet(d.fileKey);
      if (blob) await createFile(name, blob, blob.type || 'application/octet-stream');
    }
  }
  // Árva csatolmányok (már törölt dokumentumok) eltávolítása a Drive-ról.
  for (const f of files) {
    if (f.name.startsWith('file-') && !used.has(f.name)) await api(`${API}/${f.id}`, { method: 'DELETE' });
  }

  const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), data: st });
  const main = files.find(f => f.name === BACKUP);
  if (main) {
    await api(`${UPLOAD}/${main.id}?uploadType=media&fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
    });
  } else {
    await createFile(BACKUP, body, 'application/json');
  }
  localStorage.setItem(LAST_KEY, new Date().toISOString());
}

async function restore() {
  const files = await listFiles();
  const main = files.find(f => f.name === BACKUP);
  if (!main) throw new Error('nincs mentés a Drive-on');
  const obj = await (await api(`${API}/${main.id}?alt=media`)).json();
  if (!obj?.data || !Array.isArray(obj.data.topics)) throw new Error('hibás mentésfájl');

  for (const t of obj.data.topics) for (const d of t.documents || []) {
    if (!d.fileKey) continue;
    const f = files.find(x => x.name === 'file-' + d.fileKey);
    if (f) await H().idbPut(d.fileKey, await (await api(`${API}/${f.id}?alt=media`)).blob());
  }

  restoring = true;
  try { H().setState(obj.data); } finally { restoring = false; }
  if (obj.savedAt) localStorage.setItem(LAST_KEY, obj.savedAt);
}

/* ---------- Mentés futtatása és automatikus mentés ---------- */
async function runBackup(silent) {
  if (busy) { pending = true; return; }
  busy = true;
  try {
    await backup();
    if (!silent) H().toast('Mentve a Google Drive-ra');
  } catch (e) {
    H().toast(`Drive mentés sikertelen: ${e.message}`);
  } finally {
    busy = false;
    if (pending) { pending = false; syncTimer = setTimeout(() => runBackup(true), 1000); }
  }
}

function onChanged() {
  if (restoring || !connected() || !clientId()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runBackup(true), 5000);
}

async function connect() {
  if (!clientId()) return setup();
  try {
    await getToken(true); // felhasználói kattintásra nyíló azonosítási ablak
    localStorage.setItem(CONN_KEY, '1');
    const files = await listFiles();
    const hasRemote = files.some(f => f.name === BACKUP);
    if (hasRemote && H().state.topics.length === 0) {
      await restore();
      H().toast('Visszaállítva a Drive-ról');
    } else {
      await backup(files);
      H().toast('Csatlakoztatva, a mentés kész');
    }
  } catch (e) {
    H().toast(`Csatlakozás sikertelen: ${e.message}`);
  }
}

function setup() {
  H().openForm('Google Drive beállítása', [
    { name: 'id', label: 'OAuth kliensazonosító (Client ID)', required: true, value: clientId() }
  ], {}, false, data => {
    localStorage.setItem(CLIENT_KEY, data.id);
    loadGis().catch(() => {});
    H().toast('Mentve. Most már csatlakozhatsz.');
  });
}

function disconnect() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExp = 0;
  localStorage.removeItem(CONN_KEY);
  H().toast('Leválasztva. A Drive-on lévő mentés megmarad.');
}

function status() {
  if (!clientId()) return 'Google Drive: nincs kliensazonosító beállítva.';
  if (!connected()) return 'Google Drive: nincs csatlakoztatva.';
  const last = new Date(localStorage.getItem(LAST_KEY) || '');
  return `Google Drive: csatlakoztatva${isNaN(last) ? '' : ' · utolsó mentés: ' + last.toLocaleString('hu-HU')}`;
}

/* ---------- Eseménykezelés ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act^="drive-"]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'drive-connect':
      if (!connected() || !clientId() || !token) return connect();
      return runBackup(false);
    case 'drive-restore':
      if (!connected()) return connect();
      try {
        await getToken(true);
        if (!confirm('A helyi adatok felülíródnak a Drive-on lévő mentéssel. Folytatod?')) return;
        await restore();
        H().toast('Visszaállítva a Drive-ról');
      } catch (err) {
        H().toast(`Visszaállítás sikertelen: ${err.message}`);
      }
      return;
    case 'drive-setup': return setup();
    case 'drive-disconnect': return disconnect();
  }
});

document.addEventListener('hhm:changed', onChanged);
H().driveStatus = status;
if (connected() && clientId()) loadGis().catch(() => {});
})();
