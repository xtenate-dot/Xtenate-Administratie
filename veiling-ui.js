// veiling-ui.js — de pagina Artikelvoorraad: het tabblad "Veiling Voorraad"
// uit de Excel, met een knop om het opnieuw in te lezen.
//
// Alleen kijken en importeren. Er wordt niets in HNVI, Voorraad of de
// boekingen aangepast; de Excel blijft de bron.

import { state, saveVeiling } from './storage.js?v=20261024z';
import { esc, fmt } from './helpers.js?v=20261024z';
import {
  leesVeilingWerkboek, voorraadRegels
} from './veiling.js?v=20261024z';

const el = id => document.getElementById(id);
let melding = '';

const vandaag = () => new Date().toISOString().slice(0, 10);
const datum = iso => iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—';
const pct = n => n === null || n === undefined ? '—' : (n * 100).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
const geld = n => n === null || n === undefined ? '—' : fmt(n);
const tint = n => n === null || n === undefined || n === 0 ? '' : (n > 0 ? 'var(--semantic-success-bright)' : 'var(--semantic-danger-bright)');

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
    if (!uit.voorraad) {
      throw new Error('In dit bestand staat het tabblad "Veiling Voorraad" niet.');
    }
    state.VEILING = {
      geimporteerd: new Date().toISOString(),
      bestand: bestand.name,
      voorraad: uit.voorraad
    };
    saveVeiling();
    const n = state.VEILING.voorraad.artikelen.filter(a => a.soort === 'artikel').length;
    melding = `✅ Ingelezen uit ${bestand.name}: ${n} artikelen.`;
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

  if (!data || !data.voorraad) {
    doel.innerHTML = knop + `<div class="card"><p>Kies je Excel (Administratie 2026) met het tabblad
      <strong>Veiling Voorraad</strong>. Het verschijnt hier zoals in je Excel.
      Je HNVI- en voorraadgegevens blijven ongemoeid.</p></div>`;
    return;
  }

  let inhoud;
  try { inhoud = tekenVoorraad(data); }
  catch (e) {
    console.error('Artikelvoorraad tekenen mislukt:', e);
    inhoud = '<div class="card"><p>Deze gegevens konden niet worden getoond. Lees de Excel opnieuw in.</p></div>';
  }
  doel.innerHTML = knop + inhoud;
}
