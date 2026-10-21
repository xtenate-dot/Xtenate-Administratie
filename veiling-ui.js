// veiling-ui.js — de pagina Veiling: de twee veilingtabbladen uit de Excel
// naast elkaar te bekijken, met een knop om ze opnieuw in te lezen.
//
// Alleen kijken en importeren. Er wordt niets in HNVI, Voorraad of de
// boekingen aangepast; de Excel blijft de bron.

import { state, saveVeiling } from './storage.js?v=20261021a';
import { esc, fmt } from './helpers.js?v=20261021a';
import {
  leesVeilingWerkboek, verrijkInkoop, inkoopTotalen, voorraadRegels
} from './veiling.js?v=20261021a';

const el = id => document.getElementById(id);
let actiefTab = 'inkoop';
let melding = '';

const TABS = [
  { id: 'inkoop', naam: 'Inkopen & verkopen' },
  { id: 'voorraad', naam: 'Voorraad per artikel' }
];

const vandaag = () => new Date().toISOString().slice(0, 10);
const datum = iso => iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—';
const pct = n => n === null || n === undefined ? '—' : (n * 100).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
const geld = n => n === null || n === undefined ? '—' : fmt(n);
const tint = n => n === null || n === undefined || n === 0 ? '' : (n > 0 ? 'var(--semantic-success-bright)' : 'var(--semantic-danger-bright)');

export function kiesVeilingTab(id) {
  if (!TABS.some(t => t.id === id)) return;
  actiefTab = id;
  renderVeiling();
}

export function kiesVeilingBestand() {
  const veld = el('veiling-bestand');
  if (veld) { veld.value = ''; veld.click(); }
}

/** Leest het gekozen Excelbestand en vervangt de veilingkopie in de app. */
export async function importeerVeiling(event) {
  const bestand = event.target.files && event.target.files[0];
  if (!bestand) return;
  melding = '⏳ Inlezen…';
  renderVeiling();
  try {
    if (!window.XLSX) throw new Error('De Excel-bibliotheek is niet geladen. Ververs de pagina en probeer opnieuw.');
    const wb = window.XLSX.read(await bestand.arrayBuffer(), { cellDates: false });
    const uit = leesVeilingWerkboek(window.XLSX, wb);
    if (!uit.inkopen && !uit.voorraad) {
      throw new Error('In dit bestand staan de tabbladen "Veiling inkopenVerkopen" en "Veiling Voorraad" niet.');
    }
    // Ontbreekt één tabblad, dan blijft het vorige exemplaar daarvan staan.
    const oud = state.VEILING || {};
    state.VEILING = {
      geimporteerd: new Date().toISOString(),
      bestand: bestand.name,
      inkopen: uit.inkopen || oud.inkopen || null,
      voorraad: uit.voorraad || oud.voorraad || null
    };
    saveVeiling();
    const n = state.VEILING.inkopen ? state.VEILING.inkopen.lijst.length : 0;
    melding = `✅ Ingelezen uit ${bestand.name}: ${n} partijen.` +
      (uit.ontbreekt.length ? ` Let op: tabblad "${uit.ontbreekt.join('", "')}" ontbrak; het vorige exemplaar is bewaard.` : '');
  } catch (e) {
    console.error('Veiling-import mislukt:', e);
    melding = `❌ Inlezen mislukt: ${e.message}`;
  }
  renderVeiling();
}

function kpi(label, waarde, sub = '', kleur = '') {
  return `<div class="kpi kpi--secondary"><div class="kpi-lbl">${esc(label)}</div>
    <div class="kpi-val"${kleur ? ` style="color:${kleur}"` : ''}>${waarde}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function tekenInkoop(data) {
  const vandaagISO = vandaag();
  const regels = data.inkopen.lijst.map(r => verrijkInkoop(r, vandaagISO));
  const t = inkoopTotalen(data.inkopen.lijst);

  const kpis = `<div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
    ${kpi('Totaal ingekocht', geld(t.totaalIngekocht), `${t.partijen} partijen`)}
    ${kpi('Omzet verkocht', geld(t.omzet), `${t.verkocht} verkocht`)}
    ${kpi('Winst', geld(t.winst), `rendement ${pct(t.rendement)}`, tint(t.winst))}
    ${kpi('Inkoopwaarde voorraad', geld(t.inkoopwaardeVoorraad), `${t.opVoorraad + t.deels} nog niet verkocht`)}
    ${kpi('Saldo', geld(t.saldo), 'omzet min totaal ingekocht', tint(t.saldo))}
  </div>`;

  const status = r => r.status === 'verkocht' ? '<span class="badge badge-green">Verkocht</span>'
    : r.status === 'deels' ? '<span class="badge badge-amber">Deels verkocht</span>'
    : '<span class="badge badge-gray">Op voorraad</span>';

  const rijen = regels.map(r => `<tr>
      <td>${esc(r.omschr)}</td>
      <td>${esc(r.factuur || '—')}</td>
      <td>${datum(r.datum)}</td>
      <td style="text-align:right">${geld(r.hamer)}</td>
      <td style="text-align:right">${r.opgeld === null ? '—' : pct(r.opgeld)}</td>
      <td style="text-align:right">${geld(r.inkoop)}</td>
      <td style="text-align:right">${r.aantal}</td>
      <td style="text-align:right">${geld(r.prijsPerStuk)}</td>
      <td>${datum(r.verkoopDatum)}</td>
      <td style="text-align:right">${geld(r.verkoop)}</td>
      <td style="text-align:right;color:${tint(r.winst)}">${geld(r.winst)}</td>
      <td style="text-align:right">${pct(r.rendement)}</td>
      <td>${status(r)}</td>
      <td style="text-align:right">${r.dagen === null ? '—' : r.dagen}</td>
    </tr>`).join('');

  return kpis + `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
    <thead><tr><th>Omschrijving</th><th>Factuurnr.</th><th>Inkoopdatum</th>
      <th style="text-align:right">Hamerprijs</th><th style="text-align:right">Opgeld</th>
      <th style="text-align:right">Inkoop</th><th style="text-align:right">Aantal</th>
      <th style="text-align:right">Prijs p/s</th><th>Verkoopdatum</th>
      <th style="text-align:right">Verkoopprijs</th><th style="text-align:right">Winst / verlies</th>
      <th style="text-align:right">Rendement</th><th>Status</th><th style="text-align:right">Dagen</th></tr></thead>
    <tbody>${rijen}</tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-top:var(--spacing-2)">
      Dagen: bij verkochte partijen tot de verkoopdatum, bij de rest tot vandaag.
      Het btw-tarief in het bestand is ${data.inkopen.btw === null ? 'niet gevonden' : pct(data.inkopen.btw)}.</p>`;
}

function tekenVoorraad(data) {
  const regels = voorraadRegels(data.voorraad.artikelen);
  const tot = regels.find(r => r.soort === 'totaal');
  const kpis = `<div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
    ${kpi('Ingekocht', tot.ingekocht, 'stuks')}
    ${kpi('Eerder verkocht', tot.eerder, 'stuks')}
    ${kpi('Verkocht via log', tot.log, 'stuks')}
    ${kpi('Op voorraad', tot.voorraad, 'stuks')}
  </div>`;

  const rijen = regels.map(r => {
    if (r.soort === 'artikel') {
      const klaar = r.voorraad <= 0;
      return `<tr><td>${esc(r.artikel)}</td><td>${esc(r.groep || '—')}</td>
        <td style="text-align:right">${r.ingekocht}</td><td style="text-align:right">${r.eerder}</td>
        <td style="text-align:right">${r.log}</td><td style="text-align:right"><strong>${r.voorraad}</strong></td>
        <td>${klaar ? '<span class="badge badge-gray">Uitverkocht</span>' : '<span class="badge badge-green">Op voorraad</span>'}</td></tr>`;
    }
    return `<tr style="font-weight:600;background:var(--accent-softer)"><td colspan="2">${esc(r.artikel)}</td>
      <td style="text-align:right">${r.ingekocht}</td><td style="text-align:right">${r.eerder}</td>
      <td style="text-align:right">${r.log}</td><td style="text-align:right">${r.voorraad}</td><td></td></tr>`;
  }).join('');

  const v = data.voorraad.verkopen || [];
  const vt = data.voorraad.verkopenTotaal;
  const verkoopRijen = v.map(x => `<tr><td>${esc(x.artikel)}</td>
      <td style="text-align:right">${x.aantal ?? '—'}</td><td style="text-align:right">${geld(x.prijs)}</td>
      <td style="text-align:right">${geld(x.opbrengst)}</td><td style="text-align:right">${geld(x.overig)}</td></tr>`).join('') +
    (vt ? `<tr style="font-weight:600;background:var(--accent-softer)"><td>Totaal</td>
      <td style="text-align:right">${vt.aantal ?? '—'}</td><td></td>
      <td style="text-align:right">${geld(vt.opbrengst)}</td><td style="text-align:right">${geld(vt.overig)}</td></tr>` : '');

  return kpis + `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
    <thead><tr><th>Artikel</th><th>Groep</th><th style="text-align:right">Ingekocht</th>
      <th style="text-align:right">Eerder verkocht</th><th style="text-align:right">Verkocht via log</th>
      <th style="text-align:right">Voorraad</th><th>Status</th></tr></thead>
    <tbody>${rijen}</tbody></table></div></div>` +
    (v.length ? `<div class="section-head"><div class="section-titel">Verkopen spellen (eerder)</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Aantal</th><th style="text-align:right">Prijs</th>
        <th style="text-align:right">Opbrengst</th><th style="text-align:right">Overig</th></tr></thead>
      <tbody>${verkoopRijen}</tbody></table></div></div>` : '');
}

export function renderVeiling() {
  const doel = el('veiling-inhoud');
  if (!doel) return;
  const data = state.VEILING;

  const knop = `<div style="display:flex;align-items:center;gap:var(--spacing-3);margin-bottom:var(--spacing-4);flex-wrap:wrap">
    <button class="btn btn-primary" onclick="kiesVeilingBestand()">${data ? 'Excel opnieuw inlezen' : 'Excel inlezen'}</button>
    <span class="muted" style="font-size:12px">${data
      ? `Laatst ingelezen ${esc(datum(String(data.geimporteerd).slice(0, 10)))} uit ${esc(data.bestand || 'onbekend bestand')}`
      : 'Nog niets ingelezen.'}</span>
    ${melding ? `<span style="font-size:13px">${esc(melding)}</span>` : ''}
  </div>`;

  if (!data || (!data.inkopen && !data.voorraad)) {
    doel.innerHTML = knop + `<div class="card"><p>Kies je Excel (Administratie 2026) met de tabbladen
      <strong>Veiling inkopenVerkopen</strong> en <strong>Veiling Voorraad</strong>. Ze verschijnen hier zoals in je Excel.
      Je HNVI- en voorraadgegevens blijven ongemoeid.</p></div>`;
    return;
  }

  const tabs = `<div class="vtabs" role="tablist" style="margin-bottom:var(--spacing-4)">${TABS.map(t => `
    <div class="vtab${t.id === actiefTab ? ' active' : ''}" onclick="kiesVeilingTab('${t.id}')"
         role="tab" tabindex="0" aria-selected="${t.id === actiefTab}">${esc(t.naam)}</div>`).join('')}</div>`;

  let inhoud;
  try {
    inhoud = actiefTab === 'inkoop'
      ? (data.inkopen ? tekenInkoop(data) : '<div class="card"><p>Het tabblad "Veiling inkopenVerkopen" is nog niet ingelezen.</p></div>')
      : (data.voorraad ? tekenVoorraad(data) : '<div class="card"><p>Het tabblad "Veiling Voorraad" is nog niet ingelezen.</p></div>');
  } catch (e) {
    console.error('Veiling tekenen mislukt:', e);
    inhoud = '<div class="card"><p>Deze gegevens konden niet worden getoond. Lees de Excel opnieuw in.</p></div>';
  }
  doel.innerHTML = knop + tabs + inhoud;
}
