// bolartikelen.js — Bol-artikelen (op EAN) koppelen aan je eigen artikelen in de voorraad.
// Dit past de voorraad NIET aan: het laat alleen zien hoeveel Bol dit jaar van elk gekoppeld artikel
// heeft verkocht, naast wat jij als verkocht hebt vastgelegd. Zo zie je eerst of de cijfers kloppen
// voordat iets automatisch wordt bijgewerkt.

import { state, saveCoversData } from './storage.js?v=20261025f';
import { saveCoverToSupabase, addToPendingQueue } from './supabase-client-v2.js?v=20261025f';
import { legVast } from './voorraadlog.js?v=20261025f';
import { leesBestellingen } from './bol.js?v=20261025f';
import { esc } from './helpers.js?v=20261025f';
import { lopendJaar } from './jaren.js?v=20261025f';

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

const basis = (a, ean, jaar) => Number(a.bolVerwerkt?.[ean]?.[jaar]) || 0;

/** Nieuwe Bol-verkopen (dit jaar) per gekoppeld artikel die nog niet in de voorraad zijn verwerkt. */
export function nogTeVerwerken(bestellingen) {
  const jaar = String(lopendJaar());
  const perEan = new Map(bolPerEan(bestellingen, jaar).map(e => [e.ean, e.jaar]));
  const uit = [];
  for (const a of state.COVERS || []) {
    const eans = eansVan(a);
    if (!eans.length) continue;
    const delta = eans.reduce((som, e) => som + (perEan.get(e) || 0) - basis(a, e, jaar), 0);
    if (delta) uit.push({ artikel: a, delta, jaar });
  }
  return uit;
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

  const nieuw = nogTeVerwerken(bestellingen);
  const verwerk = nieuw.length ? `<div class="section-head"><div class="section-titel">Nieuwe Bol-verkopen, nog niet in je voorraad</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Verkocht erbij</th><th style="text-align:right">Voorraad nu</th><th style="text-align:right">Wordt</th></tr></thead>
      <tbody>${nieuw.map(n => `<tr><td>${esc(n.artikel.artikel)}</td><td style="text-align:right">${n.delta > 0 ? '+' : ''}${n.delta}</td><td style="text-align:right">${Number(n.artikel.voorraad) || 0}</td><td style="text-align:right">${(Number(n.artikel.voorraad) || 0) - n.delta}</td></tr>`).join('')}</tbody></table></div></div>
    <div style="margin-bottom:var(--spacing-4)"><button class="btn btn-primary" onclick="verwerkBolVerkopen()">Verwerk in voorraad</button>
    <span class="muted" style="font-size:12px;margin-left:8px">Verhoogt "verkocht" en verlaagt de voorraad en de eindstand van dit jaar; staat in het logboek. Inkoop en retour blijf je zelf bijwerken.</span></div>` : '';

  return `${verwerk}<div class="section-head"><div class="section-titel">Bol-artikelen koppelen aan je voorraad</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Bol-artikel</th><th style="text-align:right">Stuks ${jaar}</th><th>Jouw artikel</th></tr></thead>
      <tbody>${rijen}</tbody></table></div></div>
    ${vergelijk ? `<div class="section-head"><div class="section-titel">Bol versus je voorraadadministratie (${jaar})</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Bol verkocht</th><th style="text-align:right">Jij legde vast</th><th style="text-align:right">Verschil</th></tr></thead>
      <tbody>${vergelijk}</tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-bottom:var(--spacing-4)">Er wordt niets aan je voorraad veranderd. Een verschil kan komen doordat je ook via andere kanalen verkoopt, of doordat je verkopen nog niet hebt bijgewerkt. Retouren zijn hier niet verrekend.</p>` : ''}`;
}

export async function koppelBolEan(ean, artikelId) {
  const a = (state.COVERS || []).find(x => String(x.id) === String(artikelId));
  if (!a) return;
  ean = String(ean);
  const huidig = eansVan(a);
  if (huidig.includes(ean)) return;
  const jaar = String(lopendJaar());
  // Beginstand: wat jij al als verkocht hebt vastgelegd, telt als verwerkt (maximaal het aantal Bol-stuks).
  // Zo worden verkopen die je al zelf had bijgewerkt niet nog eens afgetrokken.
  let bolStuks = 0;
  try { bolStuks = bolPerEan(await leesBestellingen(), jaar).find(e => e.ean === ean)?.jaar || 0; } catch { /* zonder stand: alles telt als nieuw */ }
  const eigen = Number(a.jaren?.[jaar]?.verkocht ?? a.verkoop) || 0;
  const reedsVerwerkt = huidig.reduce((som, e) => som + basis(a, e, jaar), 0);
  const ruimte = Math.max(0, eigen - reedsVerwerkt);
  a.ean = [...huidig, ean];
  a.bolVerwerkt = { ...(a.bolVerwerkt || {}), [ean]: { ...(a.bolVerwerkt?.[ean] || {}), [jaar]: Math.min(bolStuks, ruimte) } };
  saveCoversData();
  window.hertekenHuidigePagina?.();
}

/** Zet de nieuwe Bol-verkopen om in de voorraad. Vraagt eerst bevestiging met de lijst. */
export async function verwerkBolVerkopen() {
  let best;
  try { best = await leesBestellingen(); } catch { alert('De Bol-bestellingen konden niet gelezen worden.'); return; }
  const lijst = nogTeVerwerken(best);
  if (!lijst.length) { alert('Er is niets nieuws te verwerken.'); return; }
  const tekst = lijst.map(n => `${n.artikel.artikel}: ${n.delta > 0 ? '+' : ''}${n.delta} verkocht (voorraad ${Number(n.artikel.voorraad) || 0} → ${(Number(n.artikel.voorraad) || 0) - n.delta})`).join('\n');
  if (!confirm(`Deze Bol-verkopen verwerken in je voorraad?\n\n${tekst}`)) return;
  const perEan = new Map(bolPerEan(best, lopendJaar()).map(e => [e.ean, e.jaar]));
  for (const { artikel: a, delta, jaar } of lijst) {
    const j = String(jaar);
    const oud = a.jaren?.[j] || {};
    const verkochtOud = Number(oud.verkocht ?? a.verkoop) || 0;
    const eindOud = oud.eind != null ? Number(oud.eind) : (Number(a.jaren?.[String(Number(j) - 1)]?.eind) || 0) + (Number(oud.inkoop) || 0) - verkochtOud;
    const voorraadOud = Number(a.voorraad) || 0;
    a.jaren = { ...(a.jaren || {}), [j]: { ...oud, verkocht: verkochtOud + delta, eind: eindOud - delta } };
    if (String(a.verkoop ?? '') === String(verkochtOud)) a.verkoop = verkochtOud + delta;
    if (j === String(lopendJaar())) a.omzet2026 = verkochtOud + delta;
    a.voorraad = voorraadOud - delta;
    a.bolVerwerkt = { ...(a.bolVerwerkt || {}) };
    for (const e of eansVan(a)) a.bolVerwerkt[e] = { ...(a.bolVerwerkt[e] || {}), [j]: perEan.get(e) || 0 };
    legVast({ artikelId: a.id, artikel: a.artikel, van: voorraadOud, naar: a.voorraad, reden: 'Verkoop', notitie: `Bol: ${delta} stuk(s) verwerkt via EAN-koppeling`, bron: 'bol' });
  }
  saveCoversData();
  for (const { artikel: a } of lijst) {
    try { if (!await saveCoverToSupabase(a)) addToPendingQueue(a, 'cover', false); } catch { addToPendingQueue(a, 'cover', false); }
  }
  window.hertekenHuidigePagina?.();
}

export function ontkoppelBolEan(ean) {
  for (const a of state.COVERS || []) {
    const h = eansVan(a);
    if (h.includes(String(ean))) {
      a.ean = h.filter(x => x !== String(ean));
      if (a.bolVerwerkt) { const n = { ...a.bolVerwerkt }; delete n[String(ean)]; a.bolVerwerkt = n; }
    }
  }
  saveCoversData();
  window.hertekenHuidigePagina?.();
}
