// zelftest-ui.js — het venster rond de Supabase-zelftest.

import { draaiZelftest } from './zelftest.js?v=20261024a';

const el = id => document.getElementById(id);
let bezig = false;

const VINK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
const KRUIS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function toon(resultaten) {
  el('zelftest-lijst').innerHTML = resultaten.map(r => `
    <div class="ctrl-regel ${r.gelukt ? 'ctrl-ok' : 'ctrl-fout'}">
      <div class="ctrl-kop" style="cursor:default">
        <span class="ctrl-icoon">${r.gelukt ? VINK : KRUIS}</span>
        <span class="ctrl-titel">
          ${esc(r.naam)}
          <span class="ctrl-item-sub" style="display:block">${esc(r.detail)}</span>
        </span>
      </div>
    </div>`).join('');
}

function samenvatting(resultaten) {
  const goed = resultaten.filter(r => r.gelukt).length;
  const totaal = resultaten.length;
  const alles = goed === totaal;
  el('zelftest-samenvatting').innerHTML = `
    <div class="alert ${alles ? 'alert-ok' : 'alert-error'}">
      ${alles
        ? `Alle ${totaal} controles geslaagd. De verbinding met Supabase werkt zoals bedoeld.`
        : `${totaal - goed} van de ${totaal} controles mislukt. Zie hieronder wat er misging.`}
    </div>`;
}

export function openZelftestModal() {
  el('zelftest-lijst').innerHTML = '';
  el('zelftest-samenvatting').innerHTML = '';
  el('zelftest-knop').disabled = false;
  el('zelftest-knop').textContent = 'Test starten';
  el('modal-zelftest').classList.add('open');
}

export function sluitZelftestModal() {
  if (bezig) return;
  el('modal-zelftest').classList.remove('open');
}

export async function startZelftest() {
  if (bezig) return;
  bezig = true;
  el('zelftest-knop').disabled = true;
  el('zelftest-knop').textContent = 'Bezig…';
  el('zelftest-samenvatting').innerHTML = '';
  try {
    const resultaten = await draaiZelftest(toon);
    toon(resultaten);
    samenvatting(resultaten);
  } catch (e) {
    el('zelftest-samenvatting').innerHTML =
      `<div class="alert alert-error">De test kon niet worden uitgevoerd: ${esc(e.message)}</div>`;
  } finally {
    bezig = false;
    el('zelftest-knop').disabled = false;
    el('zelftest-knop').textContent = 'Opnieuw testen';
  }
}
