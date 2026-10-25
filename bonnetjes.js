// bonnetjes.js — bonnetjes en facturen als bijlage bij een boeking.
//
// De bestanden staan in IndexedDB van deze browser (niet in localStorage: te
// klein) en gaan daarnaast naar een PRIVÉ-opslag in je eigen Supabase-project
// (bucket "bonnetjes", per gebruiker afgeschermd), zodat telefoon en computer
// dezelfde bijlagen zien en ze niet kwijt zijn als de browser wordt gewist.
// Foto's worden verkleind tot een leesbare jpg; pdf's blijven zoals ze zijn.
// De koppeling loopt via het boekingnummer. Een back-up als bestand staat in
// Beheer: de fiscus wil de stukken zeven jaar zien.

import { state } from './storage.js?v=20261024t';
import { esc } from './helpers.js?v=20261024t';
import { getClient, heeftClient } from './supabase.js?v=20261024t';

const DB_NAAM = 'xtenate_bonnetjes';
const MAX_PDF = 8 * 1024 * 1024;
const el = id => document.getElementById(id);

let db = null;
const perTx = new Map();     // txId -> [meta, ...]
let wachtend = [];           // bijlagen voor een boeking die nog geen nummer heeft
export let bonnetjesBeschikbaar = false;

const vraag = r => new Promise((ok, fout) => { r.onsuccess = () => ok(r.result); r.onerror = () => fout(r.error); });

function openDb() {
  return new Promise((ok, fout) => {
    if (typeof indexedDB === 'undefined') { fout(new Error('geen IndexedDB')); return; }
    const o = indexedDB.open(DB_NAAM, 1);
    o.onupgradeneeded = () => {
      const d = o.result;
      d.createObjectStore('meta', { keyPath: 'bid' });
      d.createObjectStore('blob', { keyPath: 'bid' });
    };
    o.onsuccess = () => ok(o.result);
    o.onerror = () => fout(o.error);
  });
}

function opslaanInMeta(m) {
  const lijst = perTx.get(String(m.txId)) || [];
  lijst.push(m);
  perTx.set(String(m.txId), lijst);
}

/** Opstarten: database openen en de lijst met bijlagen inlezen (zonder de bestanden zelf). */
export async function initBonnetjes() {
  try {
    db = await openDb();
    const alle = await vraag(db.transaction('meta').objectStore('meta').getAll());
    perTx.clear();
    alle.forEach(opslaanInMeta);
    bonnetjesBeschikbaar = true;
    setTimeout(() => synchroniseerBonnetjes(), 3000);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* niet erg */ }
  } catch (e) {
    console.warn('Bonnetjes niet beschikbaar:', e);
    bonnetjesBeschikbaar = false;
  }
}

export const aantalBonnetjes = txId => (perTx.get(String(txId)) || []).length;
export const heeftBonnetje = txId => aantalBonnetjes(txId) > 0;
export const totaalBonnetjes = () => [...perTx.values()].reduce((s, l) => s + l.length, 0);


// ─── Cloud (Supabase Storage + tabel bonnetjes) ────────────────────────────
// Alles hieronder is "best effort": lukt het niet (offline, niet ingelogd), dan
// blijft het bestand lokaal staan en probeert de volgende synchronisatie het opnieuw.

const WIS_KEY = 'xtenate_bonnetjes_wis';
let bezigMetSync = false;
let gebruikersId = null;

async function cloudClient() {
  if (!heeftClient()) return null;
  try {
    const sb = await getClient();
    if (!gebruikersId) {
      const { data } = await sb.auth.getUser();
      gebruikersId = data?.user?.id || null;
    }
    return gebruikersId ? sb : null;
  } catch { return null; }
}

const padVan = bid => `${gebruikersId}/${bid}`;
const leesWis = () => { try { return JSON.parse(localStorage.getItem(WIS_KEY)) || []; } catch { return []; } };
const zetWis = l => { try { localStorage.setItem(WIS_KEY, JSON.stringify(l)); } catch { /* niet erg */ } };

async function zetMeta(m) {
  const t = db.transaction('meta', 'readwrite');
  t.objectStore('meta').put(m);
  await new Promise(ok => { t.oncomplete = ok; t.onerror = ok; t.onabort = ok; });
}

/** Zet één lokaal bestand in de cloud. Geeft true als dat gelukt is. */
async function uploadBijlage(sb, m) {
  try {
    const r = await vraag(db.transaction('blob').objectStore('blob').get(m.bid));
    if (!r) return false;
    const up = await sb.storage.from('bonnetjes').upload(padVan(m.bid), r.blob, { contentType: m.type, upsert: true });
    if (up.error) return false;
    const { error } = await sb.from('bonnetjes').upsert({
      user_id: gebruikersId, bid: m.bid, tx_id: String(m.txId), naam: m.naam, type: m.type,
      grootte: m.grootte, toegevoegd: m.toegevoegd
    }, { onConflict: 'user_id,bid' });
    if (error) return false;
    m.cloud = true;
    await zetMeta(m);
    return true;
  } catch { return false; }
}

async function haalBlobUitCloud(bid) {
  const sb = await cloudClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.storage.from('bonnetjes').download(padVan(bid));
    if (error || !data) return null;
    const t = db.transaction('blob', 'readwrite');
    t.objectStore('blob').put({ bid, blob: data });
    await new Promise(ok => { t.oncomplete = ok; t.onerror = ok; t.onabort = ok; });
    return data;
  } catch { return null; }
}

/** Gelijktrekken met de cloud: ontbrekende bijlagen ophalen (alleen de gegevens), lokale uploaden, verwijderingen doorvoeren. */
export async function synchroniseerBonnetjes() {
  if (!bonnetjesBeschikbaar || bezigMetSync) return;
  bezigMetSync = true;
  try {
    const sb = await cloudClient();
    if (!sb) return;
    // 1. Eerst openstaande verwijderingen.
    let wis = leesWis();
    if (wis.length) {
      const over = [];
      for (const bid of wis) {
        const a = await sb.storage.from('bonnetjes').remove([padVan(bid)]);
        const b = await sb.from('bonnetjes').delete().eq('bid', bid);
        if (a.error || b.error) over.push(bid);
      }
      zetWis(over);
      wis = over;
    }
    // 2. Wat staat er in de cloud?
    const { data: rijen, error } = await sb.from('bonnetjes').select('bid, tx_id, naam, type, grootte, toegevoegd').limit(5000);
    if (error) return;
    const cloudBids = new Set(rijen.map(r => r.bid));
    const lokaal = await vraag(db.transaction('meta').objectStore('meta').getAll());
    const lokaalBids = new Set(lokaal.map(m => m.bid));
    let veranderd = false;
    // 3. In de cloud, hier nog niet: alleen de gegevens overnemen (het bestand volgt bij openen).
    for (const r of rijen) {
      if (lokaalBids.has(r.bid) || wis.includes(r.bid)) continue;
      const m = { bid: r.bid, txId: String(r.tx_id), naam: r.naam, type: r.type, grootte: r.grootte, toegevoegd: r.toegevoegd, cloud: true };
      await zetMeta(m); opslaanInMeta(m); veranderd = true;
    }
    // 4. Hier wel, in de cloud niet: óf nog nooit geüpload (uploaden), óf elders verwijderd (hier ook weg).
    for (const m of lokaal) {
      if (cloudBids.has(m.bid)) { if (!m.cloud) { m.cloud = true; await zetMeta(m); } continue; }
      if (m.cloud === true && rijen.length) {
        const t = db.transaction(['meta', 'blob'], 'readwrite');
        t.objectStore('meta').delete(m.bid); t.objectStore('blob').delete(m.bid);
        await new Promise(ok => { t.oncomplete = ok; t.onerror = ok; t.onabort = ok; });
        for (const [k, l] of perTx) {
          const rest = l.filter(x => x.bid !== m.bid);
          if (rest.length) perTx.set(k, rest); else perTx.delete(k);
        }
        veranderd = true;
      } else if (m.cloud !== true) {
        await uploadBijlage(sb, m);
      }
    }
    if (veranderd) window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
  } catch (e) {
    console.warn('Bonnetjes synchroniseren mislukt:', e);
  } finally {
    bezigMetSync = false;
  }
}
window.synchroniseerBonnetjes = synchroniseerBonnetjes;

// ─── Bestand voorbereiden ──────────────────────────────────────────────────

function verkleinAfbeelding(bestand) {
  return new Promise((ok, fout) => {
    const url = URL.createObjectURL(bestand);
    const img = new Image();
    img.onload = () => {
      const schaal = Math.min(1, 1800 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * schaal));
      cv.height = Math.max(1, Math.round(img.height * schaal));
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);   // transparante png's niet zwart
      cx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? ok(b) : fout(new Error('verkleinen mislukt')), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); fout(new Error('geen leesbare afbeelding')); };
    img.src = url;
  });
}

async function maakBijlage(bestand) {
  const naamBasis = String(bestand.name || 'bonnetje');
  if (bestand.type === 'application/pdf' || /\.pdf$/i.test(naamBasis)) {
    if (bestand.size > MAX_PDF) throw new Error(`${naamBasis} is groter dan 8 MB`);
    return { naam: naamBasis, type: 'application/pdf', blob: bestand };
  }
  if (/^image\//.test(bestand.type)) {
    const blob = await verkleinAfbeelding(bestand);
    return { naam: naamBasis.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', blob };
  }
  throw new Error(`${naamBasis}: alleen foto's en pdf's`);
}

async function schrijf(txId, bijlage) {
  const bid = `${txId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const m = { bid, txId: String(txId), naam: bijlage.naam, type: bijlage.type, grootte: bijlage.blob.size, toegevoegd: new Date().toISOString() };
  const t = db.transaction(['meta', 'blob'], 'readwrite');
  t.objectStore('meta').put(m);
  t.objectStore('blob').put({ bid, blob: bijlage.blob });
  await new Promise((ok, fout) => { t.oncomplete = ok; t.onerror = () => fout(t.error); t.onabort = () => fout(t.error); });
  opslaanInMeta(m);
  cloudClient().then(sb => sb && uploadBijlage(sb, m));
  return m;
}

// ─── Het boekingsvenster ───────────────────────────────────────────────────

export function startModalBonnetjes() {
  wachtend = [];
  tekenModalBonnetjes();
}
export function sluitModalBonnetjes() { wachtend = []; }

const grootteTekst = n => n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export function tekenModalBonnetjes() {
  const host = el('tx-bonnetjes');
  if (!host) return;
  if (!bonnetjesBeschikbaar) {
    host.innerHTML = '<span class="muted" style="font-size:12px">Bijlagen zijn in deze browser niet beschikbaar.</span>';
    return;
  }
  const txId = state.editTxId;
  const bestaand = txId != null ? (perTx.get(String(txId)) || []) : [];
  const rij = (naam, grootte, acties) => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13px">
      <span aria-hidden="true">📎</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</span>
      <span class="muted" style="font-size:11px">${grootteTekst(grootte)}</span>${acties}</div>`;
  host.innerHTML =
    bestaand.map(m => rij(m.naam, m.grootte,
      `<button type="button" class="btn btn-sm" onclick="openBonnetje('${esc(m.bid)}')">Openen</button>
       <button type="button" class="btn btn-sm" onclick="verwijderBonnetje('${esc(m.bid)}')" aria-label="Bijlage ${esc(m.naam)} verwijderen">×</button>`)).join('') +
    wachtend.map((w, n) => rij(w.naam, w.blob.size,
      `<span class="muted" style="font-size:11px">wordt bewaard bij Opslaan</span>
       <button type="button" class="btn btn-sm" onclick="schrapWachtendBonnetje(${n})" aria-label="Bijlage ${esc(w.naam)} weghalen">×</button>`)).join('') +
    `<input type="file" id="tx-bonnetje-bestand" accept="image/*,application/pdf" multiple style="display:none" onchange="kiesBonnetjes(event)">
     <button type="button" class="btn btn-sm" style="margin-top:4px" onclick="document.getElementById('tx-bonnetje-bestand').click()">+ Bonnetje of factuur toevoegen</button>
     <div id="tx-bonnetje-fout" style="font-size:12px;color:var(--semantic-danger-bright);margin-top:4px"></div>`;
}

export async function kiesBonnetjes(ev) {
  const bestanden = [...(ev.target.files || [])];
  ev.target.value = '';
  const fouten = [];
  for (const b of bestanden) {
    try {
      const bijlage = await maakBijlage(b);
      if (state.editTxId != null) await schrijf(state.editTxId, bijlage);
      else wachtend.push(bijlage);
    } catch (e) { fouten.push(e.message || String(e)); }
  }
  tekenModalBonnetjes();
  if (fouten.length && el('tx-bonnetje-fout')) el('tx-bonnetje-fout').textContent = fouten.join(' · ');
  window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
}

export function schrapWachtendBonnetje(n) { wachtend.splice(n, 1); tekenModalBonnetjes(); }

/** Aangeroepen door saveTx: de wachtende bijlagen krijgen nu het echte boekingnummer. */
export function bewaarWachtende(txId) {
  const lijst = wachtend;
  wachtend = [];
  if (!lijst.length || !bonnetjesBeschikbaar) return Promise.resolve();
  return (async () => {
    for (const b of lijst) {
      try { await schrijf(txId, b); } catch (e) { console.warn('Bijlage niet bewaard:', e); }
    }
    window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
  })();
}

export async function openBonnetje(bid) {
  try {
    const r = await vraag(db.transaction('blob').objectStore('blob').get(bid));
    const blob = r ? r.blob : await haalBlobUitCloud(bid);
    if (!blob) { alert('Dit bestand is niet gevonden (en kon niet uit de cloud worden gehaald).'); return; }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Openen mislukt: ' + (e.message || e)); }
}

export async function verwijderBonnetje(bid) {
  if (!confirm('Deze bijlage verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
  const t = db.transaction(['meta', 'blob'], 'readwrite');
  t.objectStore('meta').delete(bid);
  t.objectStore('blob').delete(bid);
  await new Promise(ok => { t.oncomplete = ok; t.onerror = ok; t.onabort = ok; });
  for (const [k, l] of perTx) {
    const rest = l.filter(m => m.bid !== bid);
    if (rest.length) perTx.set(k, rest); else perTx.delete(k);
  }
  zetWis([...new Set([...leesWis(), bid])]);   // ook in de cloud verwijderen (bij de volgende kans)
  synchroniseerBonnetjes();
  tekenModalBonnetjes();
  window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
}

/** Regel voor het detailpaneel: de bijlagen van een boeking als links. */
export function bonnetjesRegelHtml(txId) {
  const l = perTx.get(String(txId)) || [];
  if (!l.length) return '';
  return `<div class="dl-row"><span class="dl-key">Bijlagen</span><span class="dl-val">${l.map(m =>
    `<a href="#" onclick="openBonnetje('${esc(m.bid)}');return false">📎 ${esc(m.naam)}</a>`).join('<br>')}</span></div>`;
}

// ─── Back-up als bestand ───────────────────────────────────────────────────

const naarDataUrl = blob => new Promise((ok, fout) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => fout(r.error); r.readAsDataURL(blob); });
const vanDataUrl = async url => (await fetch(url)).blob();

export async function downloadBonnetjesBackup() {
  if (!bonnetjesBeschikbaar) { alert('Bijlagen zijn in deze browser niet beschikbaar.'); return; }
  const metas = await vraag(db.transaction('meta').objectStore('meta').getAll());
  if (!metas.length) { alert('Er zijn nog geen bonnetjes om te bewaren.'); return; }
  const items = [];
  for (const m of metas) {
    const r = await vraag(db.transaction('blob').objectStore('blob').get(m.bid));
    const blob = r ? r.blob : await haalBlobUitCloud(m.bid);
    if (blob) items.push({ ...m, data: await naarDataUrl(blob) });
  }
  const bestand = new Blob([JSON.stringify({ soort: 'xtenate-bonnetjes', versie: 1, gemaakt: new Date().toISOString(), aantal: items.length, items })], { type: 'application/json' });
  const url = URL.createObjectURL(bestand);
  const a = document.createElement('a');
  a.href = url; a.download = `bonnetjes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function kiesBonnetjesBackup() {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = 'application/json,.json';
  i.onchange = () => herstelBonnetjesUitBestand(i.files[0]);
  i.click();
}

async function herstelBonnetjesUitBestand(bestand) {
  if (!bestand) return;
  try {
    const o = JSON.parse(await bestand.text());
    if (o.soort !== 'xtenate-bonnetjes' || !Array.isArray(o.items)) throw new Error('Dit is geen bonnetjes-back-up.');
    let nieuw = 0;
    for (const it of o.items) {
      if (!it.bid || !it.data || perTx.get(String(it.txId))?.some(m => m.bid === it.bid)) continue;   // bestaat al
      const blob = await vanDataUrl(it.data);
      const m = { bid: it.bid, txId: String(it.txId), naam: it.naam, type: it.type, grootte: blob.size, toegevoegd: it.toegevoegd };
      const t = db.transaction(['meta', 'blob'], 'readwrite');
      t.objectStore('meta').put(m);
      t.objectStore('blob').put({ bid: it.bid, blob });
      await new Promise((ok, fout) => { t.oncomplete = ok; t.onerror = () => fout(t.error); t.onabort = () => fout(t.error); });
      opslaanInMeta(m);
      nieuw++;
    }
    alert(`${nieuw} bijlage${nieuw === 1 ? '' : 'n'} teruggezet${o.items.length - nieuw ? ` (${o.items.length - nieuw} stonden er al)` : ''}.`);
    window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
  } catch (e) { alert('Terugzetten mislukt: ' + (e.message || e)); }
}

Object.assign(window, {
  kiesBonnetjes, schrapWachtendBonnetje, openBonnetje, verwijderBonnetje,
  downloadBonnetjesBackup, kiesBonnetjesBackup
});

/** Voegt een bestand (foto of pdf) toe als bijlage bij een bestaande boeking. Gebruikt door de bonnetjes-scanner. */
export async function voegBonnetjeToe(txId, bestand) {
  if (!bonnetjesBeschikbaar) throw new Error('Bijlagen zijn in deze browser niet beschikbaar.');
  const bijlage = await maakBijlage(bestand);
  const m = await schrijf(txId, bijlage);
  window.hertekenBankNaBonnetje && window.hertekenBankNaBonnetje();
  return m;
}
