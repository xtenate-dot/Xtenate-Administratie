// cloudbackup.js — automatische back-ups in je eigen Supabase (tabel cloud_backups).
//
// Elke nacht maakt de database zelf een momentopname van boekingen, loten, voorraad,
// relaties en alle instellingen/lijsten. Hier zie je de lijst, maak je er zelf een en
// download je er een als bestand. De back-ups zelf worden alleen door de database
// gemaakt (functie maak_cloud_backup); de app kan ze lezen en verwijderen, niet vervalsen.

import { getClient, heeftClient } from './supabase.js?v=20261024y';
import { esc } from './helpers.js?v=20261024y';
import { state } from './storage.js?v=20261024y';
import { wachtrijStatus } from './supabase-client-v2.js?v=20261024y';

const el = id => document.getElementById(id);
const nl = iso => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });

export let laatsteCloudBackup = null;   // ISO-tijd van de nieuwste back-up, of null

/** Haalt alleen de tijd van de nieuwste back-up op (voor het dashboard). */
export async function laadCloudBackupStatus() {
  if (!heeftClient()) return;
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('cloud_backups').select('gemaakt').order('gemaakt', { ascending: false }).limit(1);
    if (error) return;
    const nieuw = data && data[0] ? data[0].gemaakt : null;
    if (nieuw !== laatsteCloudBackup) {
      laatsteCloudBackup = nieuw;
      window.hertekenHuidigePagina && window.hertekenHuidigePagina();
    }
  } catch { /* niet kritiek */ }
}
window.laadCloudBackupStatus = laadCloudBackupStatus;

export const dagenSindsCloudBackup = () =>
  laatsteCloudBackup ? Math.floor((Date.now() - new Date(laatsteCloudBackup).getTime()) / 86400000) : null;

const aantalTekst = a => {
  const n = a || {};
  return `${n.boekingen ?? 0} boekingen · ${n.hnvi_loten ?? 0} loten · ${n.app_data ?? 0} lijsten en instellingen (o.a. voorraad, facturen)`;
};

export function cloudBackupBlok() {
  setTimeout(() => renderCloudBackups(), 0);
  return `
    <div class="beheer-groep">
      <div class="beheer-groep-kop">Back-ups in de cloud</div>
      <div class="card" style="padding:var(--spacing-4)">
        <div class="muted" style="font-size:12px;margin-bottom:10px">
          Elke nacht maakt je eigen Supabase automatisch een kopie van je administratie (alleen als er iets veranderd is).
          De laatste 30 nachtelijke en 10 handmatige blijven bewaard. Bijlagen (bonnetjes) staan al apart in de cloud.
        </div>
        <div id="cloud-backups"><span class="muted" style="font-size:12px">Laden…</span></div>
        <div style="margin-top:10px"><button class="btn btn-primary" onclick="maakCloudBackupNu()">Nu back-up maken</button>
          <span id="cloud-backup-melding" class="muted" style="font-size:12px;margin-left:8px"></span></div>
      </div>
    </div>`;
}

export async function renderCloudBackups() {
  const doel = el('cloud-backups');
  if (!doel) return;
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('cloud_backups').select('id, gemaakt, reden, aantallen').order('gemaakt', { ascending: false }).limit(40);
    if (error) throw error;
    const nieuw = data && data[0] ? data[0].gemaakt : null;
    if (nieuw !== laatsteCloudBackup) { laatsteCloudBackup = nieuw; window.hertekenHuidigePagina && window.hertekenHuidigePagina(); return; }
    doel.innerHTML = data.length
      ? data.map(b => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="min-width:110px">${esc(nl(b.gemaakt))}</span>
          <span class="muted" style="font-size:11px;min-width:70px">${b.reden === 'nacht' ? 'automatisch' : 'handmatig'}</span>
          <span class="muted" style="flex:1;font-size:12px">${esc(aantalTekst(b.aantallen))}</span>
          <button class="btn btn-sm" onclick="downloadCloudBackup(${Number(b.id)})">Downloaden</button>
          <button class="btn btn-sm" onclick="vraagTerugzetten(${Number(b.id)})">Terugzetten…</button></div>`).join('')
      : '<span class="muted" style="font-size:12px">Nog geen back-ups. De eerste komt vannacht, of klik op "Nu back-up maken".</span>';
  } catch {
    doel.innerHTML = '<span class="muted" style="font-size:12px">De lijst kon niet geladen worden.</span>';
  }
}

export async function maakCloudBackupNu() {
  const m = el('cloud-backup-melding');
  const zet = t => { if (m) m.textContent = t; };
  zet('Bezig…');
  try {
    const sb = await getClient();
    const { error } = await sb.rpc('maak_cloud_backup');
    if (error) { zet(error.message && /wachten/i.test(error.message) ? 'Even wachten: er is net al een back-up gemaakt.' : 'Back-up maken is niet gelukt.'); return; }
    zet('✅ Back-up gemaakt.');
    renderCloudBackups();
  } catch { zet('Back-up maken is niet gelukt.'); }
}

export async function downloadCloudBackup(id) {
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('cloud_backups').select('gemaakt, inhoud').eq('id', id).maybeSingle();
    if (error || !data) { window.alert('Deze back-up kon niet worden opgehaald.'); return; }
    const bestand = new Blob([JSON.stringify({ soort: 'xtenate-cloud-backup', versie: 1, ...data.inhoud }, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(bestand);
    const a = document.createElement('a');
    a.href = url; a.download = `xtenate-cloud-backup-${String(data.gemaakt).slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { window.alert('Downloaden is niet gelukt.'); }
}

// ─── Terugzetten ─────────────────────────────────────────────────────────────

const huidig = () => ({
  boekingen: (state.TX || []).length + (state.HIST_TX || []).length,
  hnvi_loten: (state.HNVI_LOTS || []).length,
  voorraadartikelen: (state.COVERS || []).length,
  relaties: (state.RELATIES || []).length
});

function terugzetLaag() {
  let l = document.getElementById('terugzet-laag');
  if (!l) { l = document.createElement('div'); l.id = 'terugzet-laag'; l.className = 'pm-laag'; l.style.display = 'none'; document.body.appendChild(l); }
  return l;
}
export function sluitTerugzetten() { const l = document.getElementById('terugzet-laag'); if (l) l.style.display = 'none'; }

export async function vraagTerugzetten(id) {
  const l = terugzetLaag();
  l.style.display = 'flex';
  l.innerHTML = `<div class="pm-venster" style="max-width:560px"><div class="pm-inhoud" style="padding:20px"><p class="muted">Back-up ophalen…</p></div></div>`;
  let b;
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('cloud_backups').select('id, gemaakt, reden, aantallen').eq('id', id).maybeSingle();
    if (error || !data) throw new Error('niet gevonden');
    b = data;
  } catch { l.innerHTML = `<div class="pm-venster" style="max-width:560px"><div class="pm-inhoud" style="padding:20px"><p>Deze back-up kon niet worden opgehaald.</p><button class="btn" onclick="sluitTerugzetten()">Sluiten</button></div></div>`; return; }
  const nu = huidig(), a = b.aantallen || {};
  const rij = (naam, n, g) => `<tr><td>${naam}</td><td style="text-align:right">${n}</td><td style="text-align:right">${g ?? 0}</td></tr>`;
  const w = wachtrijStatus(), open = w.open;
  l.innerHTML = `<div class="pm-venster" style="max-width:560px" role="dialog" aria-label="Back-up terugzetten">
    <div class="pm-kop"><div><h3>Terugzetten naar ${esc(nl(b.gemaakt))}</h3><p class="pm-sub">${b.reden === 'nacht' ? 'Automatische' : 'Handmatige'} back-up</p></div><button class="pm-kruis" onclick="sluitTerugzetten()" aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud" style="padding:16px 20px;font-size:13px">
      <table class="tbl-compact" style="width:100%;margin-bottom:12px"><thead><tr><th></th><th style="text-align:right">Nu</th><th style="text-align:right">Na terugzetten</th></tr></thead><tbody>
        ${rij('Boekingen', nu.boekingen, a.boekingen)}${rij('HNVI-loten', nu.hnvi_loten, a.hnvi_loten)}${rij('Relaties', nu.relaties, a.relaties)}
        <tr><td>Lijsten en instellingen (o.a. voorraad, facturen)</td><td style="text-align:right">—</td><td style="text-align:right">${a.app_data ?? 0}</td></tr></tbody></table>
      <p>Alles wat je sinds ${esc(nl(b.gemaakt))} hebt toegevoegd of aangepast in boekingen, loten, voorraad, relaties, instellingen en facturen verdwijnt. Bonnetjes en bijlagen blijven staan.</p>
      <p>Eerst maakt de app een veiligheidskopie van de stand van nu (handmatige back-up), zodat je dit kunt terugdraaien. Gaat er iets mis, dan blijft alles zoals het was.</p>
      ${w.vastgelopen ? `<p class="muted">Let op: ${w.vastgelopen} wijzigingen zijn eerder al niet gelukt op te slaan ("niet opgeslagen" bovenin). Die gaan bij het herladen verloren.</p>` : ''}
      ${open ? `<p style="color:var(--semantic-danger-bright)">Er zijn nog ${open} wijzigingen die niet zijn opgeslagen. Wacht tot alles is opgeslagen en probeer het opnieuw.</p>` : `
      <label style="display:block;margin-top:8px">Typ <b>TERUGZETTEN</b> om te bevestigen:
        <input type="text" id="terugzet-woord" autocomplete="off" style="display:block;margin-top:4px;width:200px" oninput="document.getElementById('terugzet-knop').disabled = this.value.trim().toUpperCase() !== 'TERUGZETTEN'"></label>`}
      <p id="terugzet-melding" style="margin-top:8px"></p></div>
    <div class="pm-voet"><span class="pm-hint">Sluit andere vensters en je telefoon-app zolang dit loopt.</span>
      <div class="pm-knoppen"><button class="btn" onclick="sluitTerugzetten()">Annuleren</button>
      <button class="btn btn-primary" id="terugzet-knop" onclick="voerTerugzettenUit(${Number(b.id)})" disabled>Terugzetten</button></div></div></div>`;
}

export async function voerTerugzettenUit(id) {
  const m = document.getElementById('terugzet-melding'), knop = document.getElementById('terugzet-knop');
  const zet = t => { if (m) m.textContent = t; };
  if (wachtrijStatus().open) { zet('Er zijn nog niet-opgeslagen wijzigingen. Probeer het zo opnieuw.'); return; }
  if (knop) knop.disabled = true;
  zet('Bezig met terugzetten…');
  try {
    const sb = await getClient();
    const { data, error } = await sb.rpc('herstel_cloud_backup', { p_id: id });
    if (error) throw error;
    try { localStorage.removeItem('xtenate_pending_queue_v2'); } catch { /* geen opslag beschikbaar */ }
    zet(`✅ Teruggezet: ${data.boekingen} boekingen, ${data.voorraadartikelen} voorraadartikelen, ${data.relaties} relaties. De pagina wordt opnieuw geladen…`);
    setTimeout(() => location.reload(), 1800);
  } catch (e) {
    zet(`❌ Terugzetten is niet gelukt; er is niets veranderd. (${String(e && e.message || e).slice(0, 140)})`);
    if (knop) knop.disabled = false;
  }
}

Object.assign(window, { maakCloudBackupNu, downloadCloudBackup, vraagTerugzetten, sluitTerugzetten, voerTerugzettenUit });
