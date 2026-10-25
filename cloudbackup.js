// cloudbackup.js — automatische back-ups in je eigen Supabase (tabel cloud_backups).
//
// Elke nacht maakt de database zelf een momentopname van boekingen, loten, voorraad,
// relaties en alle instellingen/lijsten. Hier zie je de lijst, maak je er zelf een en
// download je er een als bestand. De back-ups zelf worden alleen door de database
// gemaakt (functie maak_cloud_backup); de app kan ze lezen en verwijderen, niet vervalsen.

import { getClient, heeftClient } from './supabase.js?v=20261024p';
import { esc } from './helpers.js?v=20261024p';

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
          <button class="btn btn-sm" onclick="downloadCloudBackup(${Number(b.id)})">Downloaden</button></div>`).join('')
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

Object.assign(window, { maakCloudBackupNu, downloadCloudBackup });
