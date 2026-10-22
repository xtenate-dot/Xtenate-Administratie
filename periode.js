// periode.js — de pagina Per periode: omzet, kosten en resultaat per maand,
// kwartaal of jaar. Alleen kijken; er wordt niets aangepast.
//
// Dezelfde regels als de rest van de app: omzet is wat op de omzetrekeningen
// binnenkomt min wat daarvan is terugbetaald, kosten zijn de echte
// bedrijfskosten (geen balansposten, geen HNVI- of voorraadinkoop).
// HNVI-inkoop staat apart, omdat die pas bij verkoop een kostenpost is.

import { state } from './storage.js?v=20261022a';
import { esc, fmt, isInkomst, isOmzet, isUitgave, MND_KORT } from './helpers.js?v=20261022a';
import { isKostenpost } from './belasting.js?v=20261022a';

const el = id => document.getElementById(id);
let stand = 'maand';          // 'maand' | 'kwartaal' | 'jaar'
let gekozenJaar = null;

const alleBoekingen = () => [...(state.HIST_TX || []), ...(state.TX || [])];
const bedrag = t => Number(t.bedrag) || 0;

function sleutelVan(datum, soort) {
  const j = datum.slice(0, 4), m = Number(datum.slice(5, 7));
  if (soort === 'jaar') return j;
  if (soort === 'kwartaal') return `${j}-K${Math.ceil(m / 3)}`;
  return datum.slice(0, 7);
}

function labelVan(sleutel, soort) {
  if (soort === 'jaar') return sleutel;
  if (soort === 'kwartaal') return `${sleutel.slice(5)} ${sleutel.slice(0, 4)}`;
  return `${MND_KORT[Number(sleutel.slice(5, 7)) - 1]} ${sleutel.slice(0, 4)}`;
}

/** Groepeert de boekingen en rekent per periode de kerncijfers uit. */
export function perPeriode(boekingen, soort) {
  const groepen = new Map();
  for (const t of boekingen) {
    if (!t.datum) continue;
    const k = sleutelVan(t.datum, soort);
    if (!groepen.has(k)) groepen.set(k, { sleutel: k, omzet: 0, kosten: 0, hnviInkoop: 0, priveSt: 0, priveOp: 0, aantal: 0 });
    const g = groepen.get(k);
    g.aantal++;
    if (isInkomst(t) && isOmzet(t.gb)) g.omzet += bedrag(t);
    else if (isUitgave(t) && isOmzet(t.gb)) g.omzet -= bedrag(t);   // terugbetaling
    if (isKostenpost(t)) g.kosten += bedrag(t);
    if (isUitgave(t) && String(t.gb) === '7010') g.hnviInkoop += bedrag(t);
    if (t.type === 'prive_storting') g.priveSt += bedrag(t);
    if (t.type === 'prive_opname') g.priveOp += bedrag(t);
  }
  return [...groepen.values()]
    .map(g => ({ ...g, resultaat: g.omzet - g.kosten - g.hnviInkoop }))
    .sort((a, b) => a.sleutel < b.sleutel ? -1 : 1);
}

export function kiesPeriodeSoort(s) {
  if (!['maand', 'kwartaal', 'jaar'].includes(s)) return;
  stand = s;
  renderPeriode();
}

export function kiesPeriodeJaar(j) {
  gekozenJaar = j;
  renderPeriode();
}

const kleur = n => n > 0.005 ? 'var(--semantic-success-bright)' : n < -0.005 ? 'var(--semantic-danger-bright)' : '';

export function renderPeriode() {
  const doel = el('periode-inhoud');
  if (!doel) return;

  const alles = alleBoekingen();
  const jaren = [...new Set(alles.map(t => (t.datum || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (!gekozenJaar || !jaren.includes(gekozenJaar)) gekozenJaar = jaren.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : jaren[0];

  const zichtbaar = stand === 'jaar' ? alles : alles.filter(t => (t.datum || '').startsWith(gekozenJaar));
  const rijen = perPeriode(zichtbaar, stand);

  const tot = rijen.reduce((s, r) => ({
    omzet: s.omzet + r.omzet, kosten: s.kosten + r.kosten, hnviInkoop: s.hnviInkoop + r.hnviInkoop,
    resultaat: s.resultaat + r.resultaat, priveSt: s.priveSt + r.priveSt, priveOp: s.priveOp + r.priveOp, aantal: s.aantal + r.aantal
  }), { omzet: 0, kosten: 0, hnviInkoop: 0, resultaat: 0, priveSt: 0, priveOp: 0, aantal: 0 });

  const knop = (id, naam) => `<div class="vtab${stand === id ? ' active' : ''}" onclick="kiesPeriodeSoort('${id}')" role="tab" tabindex="0" aria-selected="${stand === id}">${naam}</div>`;
  const jaarKeuze = stand === 'jaar' ? '' : `<select onchange="kiesPeriodeJaar(this.value)" aria-label="Jaar">${jaren.map(j => `<option value="${j}"${j === gekozenJaar ? ' selected' : ''}>${j}</option>`).join('')}</select>`;

  const kpi = (l, w, k = '') => `<div class="kpi kpi--secondary"><div class="kpi-lbl">${esc(l)}</div><div class="kpi-val"${k ? ` style="color:${k}"` : ''}>${w}</div></div>`;

  const lijst = rijen.map(r => `<tr>
      <td>${esc(labelVan(r.sleutel, stand))}</td>
      <td style="text-align:right">${fmt(r.omzet)}</td>
      <td style="text-align:right">${fmt(r.kosten)}</td>
      <td style="text-align:right">${fmt(r.hnviInkoop)}</td>
      <td style="text-align:right;color:${kleur(r.resultaat)}"><strong>${fmt(r.resultaat)}</strong></td>
      <td style="text-align:right">${fmt(r.priveSt)}</td>
      <td style="text-align:right">${fmt(r.priveOp)}</td>
      <td style="text-align:right">${r.aantal}</td>
    </tr>`).join('');

  doel.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--spacing-3);flex-wrap:wrap;margin-bottom:var(--spacing-4)">
      <div class="vtabs" role="tablist">${knop('maand', 'Per maand')}${knop('kwartaal', 'Per kwartaal')}${knop('jaar', 'Per jaar')}</div>
      ${jaarKeuze}
    </div>
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      ${kpi('Omzet', fmt(tot.omzet))}
      ${kpi('Kosten', fmt(tot.kosten))}
      ${kpi('HNVI-inkoop (bank)', fmt(tot.hnviInkoop))}
      ${kpi('Resultaat (kas)', fmt(tot.resultaat), kleur(tot.resultaat))}
    </div>
    ${rijen.length ? `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Periode</th><th style="text-align:right">Omzet</th><th style="text-align:right">Kosten</th>
        <th style="text-align:right">HNVI-inkoop</th><th style="text-align:right">Resultaat</th>
        <th style="text-align:right">Privé gestort</th><th style="text-align:right">Privé opgenomen</th>
        <th style="text-align:right">Boekingen</th></tr></thead>
      <tbody>${lijst}</tbody>
      <tfoot><tr style="font-weight:600"><td>Totaal</td><td style="text-align:right">${fmt(tot.omzet)}</td>
        <td style="text-align:right">${fmt(tot.kosten)}</td><td style="text-align:right">${fmt(tot.hnviInkoop)}</td>
        <td style="text-align:right;color:${kleur(tot.resultaat)}">${fmt(tot.resultaat)}</td>
        <td style="text-align:right">${fmt(tot.priveSt)}</td><td style="text-align:right">${fmt(tot.priveOp)}</td>
        <td style="text-align:right">${tot.aantal}</td></tr></tfoot></table></div></div>`
      : '<div class="card"><p>Geen boekingen gevonden.</p></div>'}
    <p class="muted" style="font-size:12px;margin-top:var(--spacing-2)">
      Resultaat (kas) = omzet min kosten min HNVI-inkoop zoals die in de bank staat. Het fiscale resultaat staat op de pagina Belasting:
      daar telt HNVI-inkoop pas mee zodra het lot is verkocht.</p>`;
}
