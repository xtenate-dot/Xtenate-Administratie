// km-ui.js — de pagina Kilometers: ritten invoeren en een jaaroverzicht met
// het berekende aftrekbedrag.
//
// Kleinste eerste versie: geen boeking, geen koppeling met de
// winstberekening (belasting.js) of de aangifte-pdf — dat is een latere,
// bewuste stap. Dit scherm laat alleen zien wat er zelf is ingevoerd.

import { state } from './storage.js?v=20261024z';
import { esc, fmt, ddmm } from './helpers.js?v=20261024z';
import {
  rittenVanJaar, totaalKmVanJaar, kmTarief, kmAftrek,
  vindRit, voegRitToe, werkRitBij, verwijderRit, vandaagISO
} from './km.js?v=20261024z';

const el = id => document.getElementById(id);

export function renderKm() {
  const doel = el('km-inhoud');
  if (!doel) return;

  const jaar = state.huidigJaar || String(new Date().getFullYear());
  const ritten = rittenVanJaar(jaar);
  const totaalKm = totaalKmVanJaar(jaar);
  const tarief = kmTarief();
  const aftrek = kmAftrek(jaar);

  const melding = tarief == null
    ? `<div class="muted" style="font-size:12px;margin-bottom:var(--spacing-3)">
         Nog geen tarief per kilometer ingesteld — vul dat in bij Beheer. Zolang dat leeg is, tonen bedragen "—".
       </div>`
    : '';

  const kop = `
    <div class="page-head" style="margin-bottom:var(--spacing-3);align-items:flex-end">
      <div class="kpi-grid" style="flex:1">
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Ritten</div><div class="kpi-val">${ritten.length}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Totaal km</div><div class="kpi-val">${totaalKm.toLocaleString('nl-NL')}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Aftrekbedrag</div><div class="kpi-val">${aftrek == null ? '—' : fmt(aftrek)}</div></div>
      </div>
      <button class="btn btn-primary" onclick="openRitModal()">Nieuwe rit</button>
    </div>`;

  const rijen = ritten.map(r => `
    <tr>
      <td>${esc(ddmm(r.datum))}</td>
      <td>${esc(r.doel || '—')}</td>
      <td style="text-align:right">${Number(r.km).toLocaleString('nl-NL')}</td>
      <td style="text-align:right">${tarief == null ? '—' : fmt(r.km * tarief)}</td>
      <td style="text-align:right">
        <button type="button" class="btn-details" onclick="openRitModal('${esc(r.id)}')">Bewerk</button>
        <button type="button" class="btn-details" onclick="verwijderRitUi('${esc(r.id)}')">Verwijder</button>
      </td>
    </tr>`).join('');

  const tabel = ritten.length
    ? `<div class="table-wrap"><table class="tbl-compact" id="tbl-km">
         <thead><tr><th>Datum</th><th>Doel</th><th style="text-align:right">Km</th><th style="text-align:right">Bedrag</th><th></th></tr></thead>
         <tbody>${rijen}</tbody>
       </table></div>`
    : `<div class="leeg">Nog geen ritten in ${jaar === 'all' ? 'de administratie' : jaar}.</div>`;

  doel.innerHTML = melding + kop + tabel;
}

export function openRitModal(id) {
  const r = id ? vindRit(id) : null;
  state.editRitId = r ? r.id : null;

  el('rit-modal-title').textContent = r ? 'Rit bewerken' : 'Nieuwe rit';
  el('rit-datum').value = r ? r.datum : vandaagISO();
  el('rit-doel').value = r ? (r.doel || '') : '';
  el('rit-km').value = r ? r.km : '';
  el('rit-fout').textContent = '';
  el('rit-delete-btn').style.display = r ? '' : 'none';

  document.getElementById('modal-rit').classList.add('open');
  el('rit-datum').focus();
}

export function sluitRitModal() {
  document.getElementById('modal-rit')?.classList.remove('open');
}

export function saveRit() {
  const fout = el('rit-fout');
  const datum = el('rit-datum').value;
  const doel = el('rit-doel').value.trim();
  const km = Number(el('rit-km').value);

  if (!datum) { fout.textContent = 'Vul een datum in.'; return; }
  if (!(km > 0)) { fout.textContent = 'Vul een aantal kilometers groter dan 0 in.'; return; }

  const gegevens = { datum, doel, km };
  if (state.editRitId) {
    werkRitBij(state.editRitId, gegevens);
  } else {
    voegRitToe(gegevens);
  }

  sluitRitModal();
  renderKm();
}

export function verwijderRitUitModal() {
  if (state.editRitId) verwijderRitUi(state.editRitId, true);
}

export function verwijderRitUi(id, uitModal = false) {
  const r = vindRit(id);
  if (!r) return;
  if (!confirm(`Rit van ${ddmm(r.datum)} (${r.doel || '(geen doel)'}, ${r.km} km) verwijderen?`)) return;
  verwijderRit(id);
  if (uitModal) sluitRitModal();
  renderKm();
}
