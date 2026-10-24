// autosync.js — houdt je apparaten gelijk zonder dat je iets hoeft te drukken.
//
// Er zijn twee richtingen. Duwen zet lokale wijzigingen in de cloud, halen
// haalt op wat een ander apparaat intussen veranderd heeft. De volgorde is
// altijd eerst duwen en dan halen: andersom zou je eigen werk overschreven
// worden door een oudere versie uit de cloud.

import { state, loadDataHybrid, duwOpenstaandeAppData, herstartVastgelopenAppData, appDataStatus } from './storage.js?v=20261023y';
import { herstartVastgelopen, isSupabaseReady, syncPendingQueue, wachtrijStatus } from './supabase-client-v2.js?v=20261023y';
import { hertekenHuidigePagina } from './ui.js?v=20261023y';

const TIK_MS = 30000;        // hoe vaak we kijken of er iets te doen is
const MIN_OPHAAL_MS = 20000; // niet vaker ophalen dan dit, ook niet bij snel wisselen

let bezig = false;
let laatsteOphaal = 0;
let aan = false;

/** Zit er een venster open waar je in aan het typen bent? Dan niets vervangen. */
function ietsOpenstaand() {
  if (document.querySelector('.modal-overlay.open')) return true;
  if (document.querySelector('.drawer.open')) return true;
  const a = document.activeElement;
  return !!a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
}

function meldStatus(tekst, soort = '') {
  const doel = document.getElementById('sync-status');
  if (!doel) return;
  doel.textContent = tekst;
  doel.className = `sync-status${soort ? ' sync-' + soort : ''}`;
  if (soort === 'ok') setTimeout(() => { if (doel.textContent === tekst) doel.textContent = ''; }, 2500);
}

/** Zet lokale wijzigingen in de cloud. */
async function duwen() {
  const voor = wachtrijStatus();
  if (voor.totaal) {
    meldStatus('Bezig met opslaan…');
    await syncPendingQueue();
  }
  await duwOpenstaandeAppData();

  // Blijft er iets steken, dan zeggen we dat. Stil blijven proberen is erger
  // dan een melding: je denkt dan dat alles bewaard is terwijl dat niet zo is.
  const na = wachtrijStatus();
  if (na.vastgelopen > 0) {
    meldStatus(`${na.vastgelopen} niet opgeslagen`, 'fout');
  }
  return na;
}

/** Haalt op wat elders veranderd is en tekent de pagina opnieuw. */
async function halen() {
  const voor = JSON.stringify({
    tx: state.TX.length, hist: state.HIST_TX.length,
    covers: state.COVERS.length, hnvi: state.HNVI_LOTS.length
  });

  await loadDataHybrid();
  laatsteOphaal = Date.now();

  const na = JSON.stringify({
    tx: state.TX.length, hist: state.HIST_TX.length,
    covers: state.COVERS.length, hnvi: state.HNVI_LOTS.length
  });

  if (voor !== na) {
    hertekenHuidigePagina();
    meldStatus('Bijgewerkt', 'ok');
    console.log('🔄 Gegevens van een ander apparaat opgehaald.');
    return true;
  }
  return false;
}

/**
 * Eén ronde. `metOphalen` staat uit bij de tik op de achtergrond: dan duwen we
 * alleen, want onnodig ophalen kost verbinding en levert zelden iets op.
 */
export async function syncRonde(metOphalen = false) {
  if (!aan || bezig || !isSupabaseReady()) return;
  if (!navigator.onLine) { meldStatus('Geen verbinding'); return; }

  bezig = true;
  try {
    await duwen();
    if (metOphalen && !ietsOpenstaand() && Date.now() - laatsteOphaal > MIN_OPHAAL_MS) {
      await halen();
    }
  } catch (err) {
    console.warn('Synchronisatie ging mis:', err.message);
    meldStatus('Sync mislukt');
  } finally {
    bezig = false;
  }
}

/** Start de automatische synchronisatie. Aanroepen na het inloggen. */
export function startAutosync() {
  if (aan) return;
  aan = true;
  laatsteOphaal = Date.now();

  setInterval(() => syncRonde(false), TIK_MS);

  // Kom je terug bij dit tabblad, dan is de kans het grootst dat een ander
  // apparaat iets veranderde. Daarom halen we juist dan wel op.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncRonde(true);
  });
  window.addEventListener('focus', () => syncRonde(true));

  // Bij wegklikken of sluiten nog één keer duwen, zodat er niets blijft hangen
  // als je daarna offline raakt.
  window.addEventListener('pagehide', () => { syncRonde(false); });
  window.addEventListener('online', () => { meldStatus('Weer online'); syncRonde(true); });
  window.addEventListener('offline', () => meldStatus('Geen verbinding'));

  console.log(`☁️  Automatische synchronisatie staat aan (elke ${TIK_MS / 1000} seconden).`);
  syncRonde(false);
}

/**
 * Handmatig een volledige ronde. De knop moet ook helpen als er iets is
 * vastgelopen, dus we zetten die pogingen eerst terug op nul.
 */
export async function syncNu() {
  const hersteld = herstartVastgelopen();
  const herstelInstellingen = herstartVastgelopenAppData();
  if (hersteld) console.log(`🔁 ${hersteld} vastgelopen wijziging(en) opnieuw in de rij gezet.`);
  if (herstelInstellingen) console.log(`🔁 ${herstelInstellingen} vastgelopen instelling(en) opnieuw in de rij gezet.`);
  laatsteOphaal = 0;
  await syncRonde(true);
  const status = wachtrijStatus();
  const appStatus = appDataStatus();
  const vastgelopenTotaal = status.vastgelopen + appStatus.vastgelopen;
  meldStatus(vastgelopenTotaal ? `${vastgelopenTotaal} niet opgeslagen` : 'Bijgewerkt',
             vastgelopenTotaal ? 'fout' : 'ok');
}
