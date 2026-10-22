// jaarafsluiting.js — één pagina om het boekjaar af te sluiten: een
// controlelijst, de inkoop die wel en niet meetelt, het resultaat en de
// aangifte. Alleen kijken; er wordt niets aangepast.

import { state } from './storage.js?v=20261023d';
import { esc, fmt, MND_KORT } from './helpers.js?v=20261023d';
import { aangifteModel, inkoopOverzicht, ibOver } from './belasting.js?v=20261023d';
import { draaiControles } from './controle.js?v=20261023d';

const el = id => document.getElementById(id);
const HUIDIG = '2026';
const jr = x => String(x || '').slice(0, 4);

function regel(ernst, titel, uitleg = '', ga = '') {
  const icoon = { ok: '✅', waarschuwing: '⚠️', fout: '❌', info: 'ℹ️' }[ernst];
  return `<div class="ctrl-regel ctrl-${ernst === 'info' ? 'ok' : ernst}" style="padding:10px 14px;display:flex;gap:10px;align-items:flex-start">
    <span aria-hidden="true">${icoon}</span>
    <div style="flex:1"><div style="font-weight:600">${esc(titel)}</div>
    ${uitleg ? `<div class="muted" style="font-size:12px;margin-top:2px">${uitleg}</div>` : ''}</div>
    ${ga ? `<button class="btn btn-sm" onclick="nav('${ga}')">Openen →</button>` : ''}</div>`;
}

/** Maanden van het jaar zonder één boeking (voor het lopende jaar tot nu). */
function legeMaanden(jaar, tx) {
  const tot = jaar === HUIDIG ? new Date().getMonth() + 1 : 12;
  const heeft = new Set(tx.map(t => String(t.datum || '').slice(5, 7)));
  const leeg = [];
  for (let m = 1; m <= tot; m++) if (!heeft.has(String(m).padStart(2, '0'))) leeg.push(MND_KORT[m - 1]);
  return leeg;
}

function checks(jaar, tx, inkoop) {
  const uit = [];

  // 1. Controles van de app
  let ctrl = [];
  try { ctrl = draaiControles(); } catch (e) { console.error(e); }
  const fouten = ctrl.filter(c => c.ernst === 'fout');
  const warn = ctrl.filter(c => c.ernst === 'waarschuwing');
  if (fouten.length) uit.push(regel('fout', `${fouten.length} controle(s) met een fout`, fouten.map(c => esc(c.titel)).join('<br>'), 'controle'));
  else if (warn.length) uit.push(regel('waarschuwing', `${warn.length} controle(s) met een waarschuwing`, warn.map(c => esc(c.titel)).join('<br>'), 'controle'));
  else uit.push(regel('ok', 'Alle controles van de app zijn in orde'));

  // 2. Boekingen compleet
  const leeg = legeMaanden(jaar, tx);
  uit.push(leeg.length
    ? regel('waarschuwing', `Geen boekingen in: ${leeg.join(', ')}`, 'Mogelijk is de bank voor die maand nog niet geïmporteerd.', 'bank')
    : regel('ok', 'Elke maand heeft boekingen'));

  // 3. HNVI-loten
  const loten = state.HNVI_LOTS || [];
  const zonderDatum = loten.filter(l => l.status === 'verkocht' && !l.verkoopDatum && jr(l.datum) <= jaar);
  uit.push(zonderDatum.length
    ? regel('waarschuwing', `${zonderDatum.length} verkochte HNVI-loten zonder verkoopdatum`, 'Zonder verkoopdatum telt het lot in het jaar van inkoop, niet in het jaar van verkoop.', 'hnvi')
    : regel('ok', 'Alle verkochte HNVI-loten hebben een verkoopdatum'));
  const omgekeerd = loten.filter(l => l.verkoopDatum && l.datum && l.verkoopDatum < l.datum);
  if (omgekeerd.length) uit.push(regel('fout', `${omgekeerd.length} HNVI-loten met verkoopdatum vóór de inkoopdatum`, '', 'hnvi'));
  const metOmzetGeenPrijs = loten.filter(l => l.status === 'verkocht' && !(Number(l.verkoop) > 0));
  if (metOmzetGeenPrijs.length) uit.push(regel('waarschuwing', `${metOmzetGeenPrijs.length} verkochte loten zonder verkoopprijs`, '', 'hnvi'));

  // 4. Voorraadinkoop verdeeld
  const nietVerdeeld = inkoop.rijen.filter(r => r.soort !== 'direct' && Math.abs(r.teVerdelen) >= 1);
  if (nietVerdeeld.length) {
    uit.push(regel('waarschuwing', `Nog ${fmt(nietVerdeeld.reduce((s, r) => s + r.teVerdelen, 0))} inkoop niet toegerekend`,
      nietVerdeeld.map(r => `${esc(r.rekening)} ${esc(r.naam)}: ${fmt(r.teVerdelen)} — ${esc(r.opmerking)}`).join('<br>'), 'voorraad'));
  } else uit.push(regel('ok', 'Alle inkoop is toegerekend (verkocht of op voorraad)'));

  return uit;
}

function inkoopTabel(inkoop) {
  const r = inkoop.rijen.map(x => `<tr><td>${esc(x.rekening)} ${esc(x.naam)}</td>
    <td style="text-align:right">${fmt(x.ingekocht)}</td><td style="text-align:right"><strong>${fmt(x.aftrekbaar)}</strong></td>
    <td style="text-align:right">${fmt(x.voorraad)}</td><td style="text-align:right">${fmt(x.teVerdelen)}</td></tr>`).join('');
  const t = inkoop.totaal;
  return `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
    <thead><tr><th>Inkoop</th><th style="text-align:right">Betaald</th><th style="text-align:right">Wel aftrekbaar</th>
    <th style="text-align:right">Nog op voorraad</th><th style="text-align:right">Niet toegerekend</th></tr></thead>
    <tbody>${r}<tr style="font-weight:600;background:var(--accent-softer)"><td>Totaal</td>
    <td style="text-align:right">${fmt(t.ingekocht)}</td><td style="text-align:right">${fmt(t.aftrekbaar)}</td>
    <td style="text-align:right">${fmt(t.voorraad)}</td><td style="text-align:right">${fmt(t.teVerdelen)}</td></tr></tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-top:6px">“Wel aftrekbaar” is de inkoop van wat dit jaar is verkocht. “Nog op voorraad” telt pas mee in het jaar van verkoop.</p>`;
}

export function renderJaarafsluiting() {
  const doel = el('jaarafsluiting-inhoud');
  if (!doel) return;
  const jaar = state.huidigJaar || HUIDIG;
  if (jaar === 'all') {
    doel.innerHTML = '<div class="card"><p>Kies rechtsboven één boekjaar om dat jaar af te sluiten.</p></div>';
    return;
  }
  try {
    const tx = jaar === HUIDIG ? state.TX : state.HIST_TX.filter(t => String(t.datum || '').startsWith(jaar));
    const inkoop = inkoopOverzicht(jaar);
    const m = aangifteModel(jaar);
    const { omzet, winst } = m.resultaat;
    const ib = ibOver(winst);
    doel.innerHTML = `
      <div class="section-head"><div class="section-titel">Controlelijst ${esc(jaar)}</div></div>
      <div class="card" style="padding:0">${checks(jaar, tx, inkoop).join('')}</div>
      <div class="section-head"><div class="section-titel">Inkoop: wel en niet meegeteld</div></div>
      ${inkoopTabel(inkoop)}
      <div class="section-head"><div class="section-titel">Resultaat</div></div>
      <div class="kpi-grid">
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Omzet</div><div class="kpi-val">${fmt(omzet)}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Fiscale winst</div><div class="kpi-val">${fmt(winst)}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Geschatte inkomstenbelasting</div><div class="kpi-val">${fmt(ib)}</div></div>
      </div>
      <div class="section-head"><div class="section-titel">Aangifte</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="downloadAangiftePdf()">Download aangifte als pdf</button>
        <button class="btn" onclick="kopieerAangifte()">Kopieer aangiftegegevens</button>
        <button class="btn" onclick="downloadPeriodeExcel()">Per periode als Excel</button>
      </div>`;
  } catch (e) {
    console.error('Jaarafsluiting mislukt:', e);
    doel.innerHTML = '<div class="card"><p>De jaarafsluiting kon niet worden berekend.</p></div>';
  }
}
