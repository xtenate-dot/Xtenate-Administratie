// bolartikelen.js — Bol-artikelen (op EAN) koppelen aan je eigen artikelen in de voorraad.
// Dit past de voorraad NIET aan: het laat alleen zien hoeveel Bol dit jaar van elk gekoppeld artikel
// heeft verkocht, naast wat jij als verkocht hebt vastgelegd. Zo zie je eerst of de cijfers kloppen
// voordat iets automatisch wordt bijgewerkt.

import { state, saveCoversData } from './storage.js?v=20261025e';
import { esc } from './helpers.js?v=20261025e';
import { lopendJaar } from './jaren.js?v=20261025e';

const eansVan = a => (Array.isArray(a.ean) ? a.ean : a.ean ? [a.ean] : []).map(String);

/** Per EAN: titel en aantal stuks (zonder geannuleerde) in het gegeven jaar en in totaal. */
export function bolPerEan(bestellingen, jaar) {
  const kaart = new Map();
  for (const o of bestellingen || []) {
    for (const it of o.items || []) {
      const ean = String(it.ean || '').trim();
      if (!ean) continue;
      const e = kaart.get(ean) || { ean, titel: it.titel || ean, jaar: 0, totaal: 0 };
      const n = Math.max(0, (Number(it.aantal) || 0) - (Number(it.geannuleerd) || 0));
      e.totaal += n;
      if (String(o.datum || '').startsWith(String(jaar))) e.jaar += n;
      if (it.titel && (!e.titel || e.titel === ean)) e.titel = it.titel;
      kaart.set(ean, e);
    }
  }
  return [...kaart.values()].sort((a, b) => b.jaar - a.jaar || b.totaal - a.totaal);
}

function voorstelVoor(titel) {
  const t = String(titel || '').toLowerCase();
  const kand = (state.COVERS || []).filter(a => a.artikel && String(a.artikel).trim().length >= 3 && t.includes(String(a.artikel).trim().toLowerCase()));
  if (!kand.length) return null;
  return kand.sort((a, b) => String(b.artikel).length - String(a.artikel).length)[0];
}

export function bolArtikelenHtml(bestellingen) {
  const jaar = lopendJaar();
  const covers = state.COVERS || [];
  const perEan = bolPerEan(bestellingen, jaar);
  if (!perEan.length) return '';
  const eigenaar = new Map();
  for (const a of covers) for (const e of eansVan(a)) eigenaar.set(e, a);
  const opties = [...covers].sort((a, b) => String(a.artikel).localeCompare(String(b.artikel), 'nl'))
    .map(a => `<option value="${esc(a.id)}">${esc(a.artikel)}</option>`).join('');

  const rijen = perEan.map(e => {
    const a = eigenaar.get(e.ean);
    const v = a ? null : voorstelVoor(e.titel);
    return `<tr><td>${esc(e.titel)}<div class="muted" style="font-size:11px">EAN ${esc(e.ean)}</div></td>
      <td style="text-align:right">${e.jaar}</td>
      <td>${a ? `<b>${esc(a.artikel)}</b> <button class="btn-details" onclick="ontkoppelBolEan('${esc(e.ean)}')">Loskoppelen</button>`
        : `${v ? `<button class="btn btn-sm btn-primary" onclick="koppelBolEan('${esc(e.ean)}','${esc(v.id)}')">Koppel aan ${esc(v.artikel)}</button> of ` : ''}
           <select onchange="if(this.value)koppelBolEan('${esc(e.ean)}',this.value)" style="font-size:12px;max-width:200px"><option value="">— kies artikel —</option>${opties}</select>`}</td></tr>`;
  }).join('');

  // Vergelijking per gekoppeld artikel
  const som = new Map();
  for (const e of perEan) { const a = eigenaar.get(e.ean); if (a) som.set(a.id, (som.get(a.id) || 0) + e.jaar); }
  const vergelijk = [...som.entries()].map(([id, bol]) => {
    const a = covers.find(x => String(x.id) === String(id));
    const eigen = Number(a?.jaren?.[jaar]?.verkocht ?? a?.verkoop) || 0;
    const verschil = bol - eigen;
    return `<tr><td>${esc(a.artikel)}</td><td style="text-align:right">${bol}</td><td style="text-align:right">${eigen}</td>
      <td style="text-align:right" class="${verschil ? 'neg' : ''}">${verschil > 0 ? '+' : ''}${verschil}</td></tr>`;
  }).join('');

  return `<div class="section-head"><div class="section-titel">Bol-artikelen koppelen aan je voorraad</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Bol-artikel</th><th style="text-align:right">Stuks ${jaar}</th><th>Jouw artikel</th></tr></thead>
      <tbody>${rijen}</tbody></table></div></div>
    ${vergelijk ? `<div class="section-head"><div class="section-titel">Bol versus je voorraadadministratie (${jaar})</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Bol verkocht</th><th style="text-align:right">Jij legde vast</th><th style="text-align:right">Verschil</th></tr></thead>
      <tbody>${vergelijk}</tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-bottom:var(--spacing-4)">Er wordt niets aan je voorraad veranderd. Een verschil kan komen doordat je ook via andere kanalen verkoopt, of doordat je verkopen nog niet hebt bijgewerkt. Retouren zijn hier niet verrekend.</p>` : ''}`;
}

export function koppelBolEan(ean, artikelId) {
  const a = (state.COVERS || []).find(x => String(x.id) === String(artikelId));
  if (!a) return;
  const huidig = eansVan(a);
  if (!huidig.includes(String(ean))) a.ean = [...huidig, String(ean)];
  saveCoversData();
  window.hertekenHuidigePagina?.();
}

export function ontkoppelBolEan(ean) {
  for (const a of state.COVERS || []) {
    const h = eansVan(a);
    if (h.includes(String(ean))) a.ean = h.filter(x => x !== String(ean));
  }
  saveCoversData();
  window.hertekenHuidigePagina?.();
}
