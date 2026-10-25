// bonnetjesoverzicht.js — pagina "Bonnetjes": alle bijlagen op één plek, gesplitst in
// inkoopfacturen/bonnetjes (bij uitgaven) en verkoopfacturen (bij inkomsten).
// De indeling volgt het soort boeking waar de bijlage aan hangt; je hoeft niets apart in te stellen.

import { state } from './storage.js?v=20261024z';
import { esc, fmt, ddmm, isUitgave, isInkomst, weergaveNaam } from './helpers.js?v=20261024z';
import { alleBonnetjes, heeftBonnetje, bonnetjesBeschikbaar } from './bonnetjes.js?v=20261024z';

const el = id => document.getElementById(id);
let jaarKeuze = 'alle';       // 'alle' of 'JJJJ'
let toonOntbrekend = false;

const alleTx = () => [...(state.TX || []), ...(state.HIST_TX || [])];

function verzamel() {
  const perId = new Map(alleTx().map(t => [String(t.id), t]));
  const groepen = { inkoop: [], verkoop: [], overig: [] };
  for (const b of alleBonnetjes()) {
    const t = perId.get(String(b.txId));
    const rij = { b, t };
    if (t && isUitgave(t)) groepen.inkoop.push(rij);
    else if (t && isInkomst(t)) groepen.verkoop.push(rij);
    else groepen.overig.push(rij);
  }
  return groepen;
}

const jaarVan = r => (r.t && r.t.datum ? String(r.t.datum).slice(0, 4) : '');
const opJaar = r => jaarKeuze === 'alle' || jaarVan(r) === jaarKeuze;
const datumVan = r => (r.t && r.t.datum) || String(r.b.toegevoegd || '').slice(0, 10);

function tabel(rijen, leegTekst) {
  if (!rijen.length) return `<div class="card" style="padding:12px 16px"><span class="muted">${leegTekst}</span></div>`;
  const gesorteerd = [...rijen].sort((a, b) => (datumVan(b) > datumVan(a) ? 1 : -1));
  return `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
    <thead><tr><th>Datum</th><th>Boeking</th><th style="text-align:right">Bedrag</th><th>Bijlage</th></tr></thead>
    <tbody>${gesorteerd.map(r => `<tr><td class="muted" style="white-space:nowrap">${r.t ? esc(ddmm(r.t.datum)) + '-' + esc(String(r.t.datum).slice(0, 4)) : '—'}</td>
      <td>${r.t ? esc(weergaveNaam(r.t)) : '<span class="muted">boeking niet gevonden</span>'}${r.t && r.t.omschr && r.t.omschr !== r.t.naam ? ` <span class="muted" style="font-size:11px">· ${esc(String(r.t.omschr).slice(0, 50))}</span>` : ''}</td>
      <td style="text-align:right">${r.t ? fmt(r.t.bedrag) : ''}</td>
      <td><a href="#" onclick="openBonnetje('${esc(r.b.bid)}');return false">📎 ${esc(r.b.naam)}</a></td></tr>`).join('')}</tbody></table></div></div>`;
}

export function renderBonnetjesPagina() {
  const doel = el('bonnetjes-inhoud');
  if (!doel) return;
  const g = verzamel();
  const jaren = [...new Set([...g.inkoop, ...g.verkoop, ...g.overig].map(jaarVan).filter(Boolean))].sort().reverse();
  const ink = g.inkoop.filter(opJaar), ver = g.verkoop.filter(opJaar), ove = g.overig.filter(opJaar);
  const zonder = alleTx().filter(t => isUitgave(t) && !heeftBonnetje(t.id) && (jaarKeuze === 'alle' || String(t.datum).slice(0, 4) === jaarKeuze))
    .sort((a, b) => (b.datum > a.datum ? 1 : -1));
  doel.innerHTML = `
    ${!bonnetjesBeschikbaar ? `<div class="card" style="padding:12px 16px;margin-bottom:12px;color:var(--semantic-danger-bright)">Bijlagen zijn in deze browser niet beschikbaar (privévenster?).</div>` : ''}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:var(--spacing-4)">
      <select onchange="zetBonnetjesJaar(this.value)" aria-label="Jaar" style="font-size:13px"><option value="alle">Alle jaren</option>${jaren.map(j => `<option value="${j}"${j === jaarKeuze ? ' selected' : ''}>${j}</option>`).join('')}</select>
      <button class="btn btn-primary" onclick="openBonScan()">📷 Bonnetje scannen</button>
      <span class="muted" style="font-size:12px">Een bijlage voeg je toe bij een boeking (Bank), of via de scanner. De indeling volgt het soort boeking.</span>
    </div>
    <div class="section-head"><div class="section-titel">Inkoopfacturen en bonnetjes (${ink.length})</div></div>
    <div style="margin-bottom:var(--spacing-4)">${tabel(ink, 'Nog geen bijlagen bij uitgaven.')}
      <p style="margin:8px 0 0;font-size:13px"><a href="#" onclick="zetBonnetjesOntbrekend(${toonOntbrekend ? 'false' : 'true'});return false">${toonOntbrekend ? '▾' : '▸'} ${zonder.length} uitgaven nog zonder bijlage</a>
        <span class="muted" style="font-size:12px"> (niet bij alles is een bon nodig, bijvoorbeeld bankkosten of een overboeking)</span></p>
      ${toonOntbrekend ? `<div class="card card-flush" style="margin-top:6px"><div class="table-wrap" style="max-height:340px;overflow:auto"><table class="tbl-compact"><tbody>${zonder.slice(0, 300).map(t => `<tr><td class="muted" style="white-space:nowrap">${esc(ddmm(t.datum))}-${esc(String(t.datum).slice(0, 4))}</td><td>${esc(weergaveNaam(t))}</td><td style="text-align:right">${fmt(t.bedrag)}</td></tr>`).join('')}</tbody></table></div></div>${zonder.length > 300 ? `<p class="muted" style="font-size:12px">Alleen de nieuwste 300 getoond.</p>` : ''}` : ''}
    </div>
    <div class="section-head"><div class="section-titel">Verkoopfacturen (${ver.length})</div></div>
    <div style="margin-bottom:var(--spacing-4)">${tabel(ver, 'Nog geen bijlagen bij inkomsten.')}</div>
    ${ove.length ? `<div class="section-head"><div class="section-titel">Overig (${ove.length})</div></div>
    <div style="margin-bottom:var(--spacing-4)">${tabel(ove, '')}<p class="muted" style="font-size:12px;margin-top:6px">Bijlagen bij privéstortingen, opnames of boekingen die niet meer bestaan.</p></div>` : ''}`;
}

export function zetBonnetjesJaar(j) { jaarKeuze = j; renderBonnetjesPagina(); }
export function zetBonnetjesOntbrekend(b) { toonOntbrekend = !!b; renderBonnetjesPagina(); }
Object.assign(window, { zetBonnetjesJaar, zetBonnetjesOntbrekend });
