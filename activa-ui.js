// activa-ui.js — de pagina Activa: bedrijfsmiddelen vastleggen en het
// jaaroverzicht met de berekende afschrijving.
//
// Kleinste eerste versie: geen koppeling met boekingen of de winstberekening
// in belasting.js — dat is een latere, bewuste stap, net als bij kilometers.

import { state } from './storage.js?v=20261025e';
import { esc, fmt, ddmm } from './helpers.js?v=20261025e';
import {
  activaLijst, jaarlijkseAfschrijving, afschrijvingInJaar, boekwaardeEindJaar,
  vindActivum, voegActivumToe, werkActivumBij, verwijderActivum, vandaagISO
} from './activa.js?v=20261025e';

const el = id => document.getElementById(id);

export function renderActiva() {
  const doel = el('activa-inhoud');
  if (!doel) return;

  const jaarKeuze = state.huidigJaar || String(new Date().getFullYear());
  // Afschrijving "over alle jaren" is geen zinnige, optelbare grootheid
  // zoals een omzetcijfer dat wel is — bij 'all' tonen we daarom gewoon het
  // huidige kalenderjaar, net zoals een pas geopende pagina dat als
  // vertrekpunt zou tonen.
  const peiljaar = jaarKeuze === 'all' ? new Date().getFullYear() : Number(jaarKeuze);

  const activa = activaLijst();
  const totaalDitJaar = activa.reduce((s, a) => s + afschrijvingInJaar(a, peiljaar), 0);
  const totaalBoekwaarde = activa.reduce((s, a) => s + boekwaardeEindJaar(a, peiljaar), 0);

  const disclaimer = `
    <div class="alert alert-warn" style="margin-bottom:var(--spacing-3)">
      ⚠ Indicatieve afschrijving, lineair, met de gebruiksduur die je zelf instelt. Fiscale regels
      rond afschrijving — waaronder wettelijke minimumtermijnen, de aparte regels voor gebouwen
      (gekoppeld aan de WOZ-waarde) en de kleinschaligheidsinvesteringsaftrek (KIA) — worden hier
      niet gecontroleerd of toegepast. Raadpleeg een belastingadviseur.<br><br>
      <strong>Let op dubbeltelling:</strong> boek de aanschaf van een bedrijfsmiddel dat je hier
      vastlegt niet óók als gewone kostenpost bij je bankboekingen — anders telt hetzelfde bedrag
      twee keer mee.
    </div>`;

  const kop = `
    <div class="page-head" style="margin-bottom:var(--spacing-3);align-items:flex-end">
      <div class="kpi-grid" style="flex:1">
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Bedrijfsmiddelen</div><div class="kpi-val">${activa.length}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Afschrijving ${peiljaar}</div><div class="kpi-val">${fmt(totaalDitJaar)}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Boekwaarde totaal</div><div class="kpi-val">${fmt(totaalBoekwaarde)}</div></div>
      </div>
      <button class="btn btn-primary" onclick="openActivumModal()">Nieuw bedrijfsmiddel</button>
    </div>`;

  const rijen = activa.map(a => {
    const pct = a.gebruiksduurJaren > 0 ? (100 / a.gebruiksduurJaren) : 0;
    return `
    <tr>
      <td>${esc(a.naam || '—')}</td>
      <td>${esc(ddmm(a.aanschafdatum))}</td>
      <td style="text-align:right">${fmt(a.aanschafwaarde)}</td>
      <td>${a.gebruiksduurJaren} jaar (${pct.toFixed(1)}%/jaar)</td>
      <td style="text-align:right">${fmt(afschrijvingInJaar(a, peiljaar))}</td>
      <td style="text-align:right">${fmt(boekwaardeEindJaar(a, peiljaar))}</td>
      <td style="text-align:right">
        <button type="button" class="btn-details" onclick="openActivumModal('${esc(a.id)}')">Bewerk</button>
        <button type="button" class="btn-details" onclick="verwijderActivumUi('${esc(a.id)}')">Verwijder</button>
      </td>
    </tr>`;
  }).join('');

  const tabel = activa.length
    ? `<div class="table-wrap"><table class="tbl-compact" id="tbl-activa">
         <thead><tr><th>Naam</th><th>Aanschaf</th><th style="text-align:right">Aanschafwaarde</th><th>Gebruiksduur</th><th style="text-align:right">Afschrijving ${peiljaar}</th><th style="text-align:right">Boekwaarde</th><th></th></tr></thead>
         <tbody>${rijen}</tbody>
       </table></div>`
    : `<div class="leeg">Nog geen bedrijfsmiddelen vastgelegd.</div>`;

  doel.innerHTML = disclaimer + kop + tabel;
}

export function openActivumModal(id) {
  const a = id ? vindActivum(id) : null;
  state.editActivumId = a ? a.id : null;

  el('activum-modal-title').textContent = a ? 'Bedrijfsmiddel bewerken' : 'Nieuw bedrijfsmiddel';
  el('activum-naam').value = a ? (a.naam || '') : '';
  el('activum-aanschafdatum').value = a ? a.aanschafdatum : vandaagISO();
  el('activum-aanschafwaarde').value = a ? a.aanschafwaarde : '';
  el('activum-restwaarde').value = a ? a.restwaarde : 0;
  el('activum-gebruiksduur').value = a ? a.gebruiksduurJaren : '';
  el('activum-fout').textContent = '';
  el('activum-delete-btn').style.display = a ? '' : 'none';

  document.getElementById('modal-activum').classList.add('open');
  el('activum-naam').focus();
}

export function sluitActivumModal() {
  document.getElementById('modal-activum')?.classList.remove('open');
}

export function saveActivum() {
  const fout = el('activum-fout');
  const naam = el('activum-naam').value.trim();
  const aanschafdatum = el('activum-aanschafdatum').value;
  const aanschafwaarde = Number(el('activum-aanschafwaarde').value);
  const restwaarde = Number(el('activum-restwaarde').value || 0);
  const gebruiksduurJaren = Number(el('activum-gebruiksduur').value);

  if (!naam) { fout.textContent = 'Vul een naam in.'; return; }
  if (!aanschafdatum) { fout.textContent = 'Vul een aanschafdatum in.'; return; }
  if (!(aanschafwaarde > 0)) { fout.textContent = 'Vul een aanschafwaarde groter dan 0 in.'; return; }
  if (!(gebruiksduurJaren > 0)) { fout.textContent = 'Vul een gebruiksduur groter dan 0 in.'; return; }
  if (restwaarde >= aanschafwaarde) { fout.textContent = 'De restwaarde moet lager zijn dan de aanschafwaarde.'; return; }

  const gegevens = { naam, aanschafdatum, aanschafwaarde, restwaarde, gebruiksduurJaren };
  if (state.editActivumId) {
    werkActivumBij(state.editActivumId, gegevens);
  } else {
    voegActivumToe(gegevens);
  }

  sluitActivumModal();
  renderActiva();
}

export function verwijderActivumUitModal() {
  if (state.editActivumId) verwijderActivumUi(state.editActivumId, true);
}

export function verwijderActivumUi(id, uitModal = false) {
  const a = vindActivum(id);
  if (!a) return;
  if (!confirm(`Bedrijfsmiddel "${a.naam}" (${fmt(a.aanschafwaarde)}, aangeschaft ${ddmm(a.aanschafdatum)}) verwijderen?`)) return;
  verwijderActivum(id);
  if (uitModal) sluitActivumModal();
  renderActiva();
}
