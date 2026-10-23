// jaarafsluiting.js — één pagina om het boekjaar af te sluiten: een
// controlelijst, de inkoop die wel en niet meetelt, het resultaat en de
// aangifte. Alleen kijken; er wordt niets aangepast.

import { state } from './storage.js?v=20261023o';
import { esc, fmt, MND_KORT } from './helpers.js?v=20261023o';
import { aangifteModel, inkoopOverzicht, ibOver, hnviLotenVanJaar, hnviOmzetBuitenBank } from './belasting.js?v=20261023o';
import { korStatus } from './kor.js?v=20261023o';
import { draaiControles } from './controle.js?v=20261023o';

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

  // HNVI-verkopen die niet in de bank te vinden zijn tellen als extra omzet
  const belTX = jaar === HUIDIG ? state.TX : state.HIST_TX.filter(t => String(t.datum || '').startsWith(jaar));
  const buiten = hnviOmzetBuitenBank(hnviLotenVanJaar(jaar), belTX).buitenBank || [];
  uit.push(buiten.length
    ? regel('waarschuwing', `${buiten.length} verkochte HNVI-loten niet terug te vinden in de bank (${fmt(buiten.reduce((s, l) => s + Number(l.verkoop), 0))})`,
        'Deze verkoopprijzen tellen als extra omzet. Klopt dat niet, bijvoorbeeld omdat het geld onder een ander bedrag is binnengekomen, dan staat de omzet te hoog.<br>' +
        buiten.map(l => esc(l.omschr || l.id) + ': ' + fmt(l.verkoop)).join('<br>'), 'hnvi')
    : regel('ok', 'Alle verkochte HNVI-loten zijn in de bank terug te vinden'));

  // 4. Voorraadinkoop verdeeld
  const nietVerdeeld = inkoop.rijen.filter(r => r.soort !== 'direct' && r.teVerdelen >= 1);
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
    <p class="muted" style="font-size:12px;margin-top:6px">Een negatief bedrag bij “Niet toegerekend” betekent dat je dit jaar inkoop aftrekt die je in een eerder jaar hebt betaald (loten uit vorig jaar die nu zijn verkocht). “Wel aftrekbaar” is de inkoop van wat dit jaar is verkocht. “Nog op voorraad” telt pas mee in het jaar van verkoop.</p>`;
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
      ${korKaart(jaar)}
      <div class="section-head"><div class="section-titel">Vergrendelen</div></div>
      <div class="card" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <div>${(state.VERGRENDELD || []).includes(jaar)
          ? `<strong>🔒 ${esc(jaar)} is vergrendeld.</strong><div class="muted" style="font-size:12px">Wijzigen en verwijderen van boekingen uit dit jaar vraagt een extra bevestiging.</div>`
          : `<strong>${esc(jaar)} is niet vergrendeld.</strong><div class="muted" style="font-size:12px">Vergrendel het jaar zodra de aangifte is ingediend. Dan kun je boekingen niet meer per ongeluk wijzigen.</div>`}</div>
        <button class="btn" onclick="wisselVergrendeling('${esc(jaar)}')">${(state.VERGRENDELD || []).includes(jaar) ? 'Ontgrendelen' : 'Jaar vergrendelen'}</button>
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

export function wisselVergrendeling(jaar) {
  const aan = !(state.VERGRENDELD || []).includes(jaar);
  if (!aan && !window.confirm(`${jaar} ontgrendelen? Daarna kun je boekingen weer zonder extra vraag wijzigen.`)) return;
  zetJaarVergrendeld(jaar, aan);
  renderJaarafsluiting();
}

function korKaart(jaar) {
  const k = korStatus(jaar);
  const eur = n => fmt(Math.round(n));
  const kleur = k.niveau === 'over' ? 'var(--semantic-danger-bright)' : k.niveau === 'let-op' ? 'var(--semantic-warning-bright, #d98a00)' : 'var(--semantic-success-bright)';
  return `<div class="section-head"><div class="section-titel">KOR-omzetgrens</div></div>
    <div class="card"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><strong>${eur(k.omzet)} van ${eur(k.grens)}</strong><span style="color:${kleur};font-weight:600">${Math.round(k.pct * 100)}%</span></div>
    <div style="height:10px;border-radius:5px;background:var(--accent-softer);margin:8px 0;overflow:hidden"><div style="height:100%;width:${Math.min(100, k.pct * 100)}%;background:${kleur}"></div></div>
    <div class="muted" style="font-size:12px">${k.niveau === 'over' ? `Je zit ${eur(-k.ruimte)} boven de grens.` : `Nog ${eur(k.ruimte)} ruimte.`}
    ${k.prognose !== null ? ` Op dit tempo kom je dit jaar uit op ongeveer ${eur(k.prognose)}.` : ''}
    Indicatie op basis van de omzet in de aangifte; welke omzet precies meetelt, stem je af met je boekhouder of de Belastingdienst.</div></div>`;
}
