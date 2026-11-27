// webshop.js — pagina Webshop: bestellingen van MijnMagie (WooCommerce) ophalen via de Edge Function
// webshop-koppeling, verkopen per artikel verwerken in de voorraad, en je voorraad naar de webshop sturen.
//
// Zelfde werkwijze als bij Bol: eerst laten zien, dan pas na jouw bevestiging iets veranderen.
//  - Een artikel koppel je aan een webshop-SKU (veld webshopSku op het artikel).
//  - Nieuwe webshopverkopen verwerk je met één knop in de voorraad (staat in het logboek, bron 'webshop').
//  - "Voorraad naar webshop" zet de webshopvoorraad gelijk aan je eigen voorraad, alleen voor gekoppelde artikelen.
//    Artikelen die je niet koppelt (zoals je Bol-aanbod dat je pas na een bestelling inkoopt) gaan dus nooit mee.

import { getClient } from './supabase.js?v=20261126b';
import { state, saveCoversData } from './storage.js?v=20261126b';
import { saveCoverToSupabase, addToPendingQueue } from './supabase-client-v2.js?v=20261126b';
import { legVast } from './voorraadlog.js?v=20261126b';
import { esc, fmt } from './helpers.js?v=20261126b';
import { lopendJaar } from './jaren.js?v=20261126b';

const el = id => document.getElementById(id);
const r2 = n => Math.round(n * 100) / 100;
/** Bestellingen in deze statussen tellen als verkocht. Geannuleerd, mislukt en terugbetaald niet. */
const TELT = new Set(['processing', 'completed', 'on-hold']);
const STATUS = { pending: 'Wacht op betaling', processing: 'Betaald, te versturen', 'on-hold': 'In de wacht', completed: 'Verzonden',
  cancelled: 'Geannuleerd', refunded: 'Terugbetaald', failed: 'Mislukt', 'checkout-draft': 'Concept' };

let bestellingen = null, laadFout = false, melding = '', bezig = false, info = null, laatsteVoorraad = null;

// ─── Gegevens ───────────────────────────────────────────────────────────────

export async function leesWebshopBestellingen() {
  const sb = await getClient();
  const alle = [];
  for (let van = 0; van < 20000; van += 1000) {
    const { data, error } = await sb.from('webshop_bestellingen')
      .select('order_id, nummer, status, besteld, datum, totaal, verzendkosten, terugbetaald, land, items')
      .order('datum', { ascending: false }).range(van, van + 999);
    if (error) throw new Error('lezen mislukt');
    alle.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return alle;
}

async function roep(body) {
  const sb = await getClient();
  const { data, error } = await sb.functions.invoke('webshop-koppeling', { body });
  let fout = data && data.fout;
  if (error && !fout) { try { fout = (await error.context.json())?.fout; } catch { /* geen detail */ } }
  if (error || !data?.ok) throw new Error(fout || 'De webshop-koppeling gaf geen antwoord. Is de functie webshop-koppeling gedeployd in Supabase?');
  return data;
}

/** Haalt een periode op, in stukken van 31 dagen. */
export async function haalBijWebshop(van, tot, voortgang = () => {}) {
  const dag = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let opgeslagen = 0, onvolledig = false, start = van;
  while (start <= tot) {
    const eind = dag(start, 30) < tot ? dag(start, 30) : tot;
    voortgang(`Ophalen ${start} t/m ${eind}…`);
    const d = await roep({ van: start, tot: eind });
    opgeslagen += d.opgeslagen || 0;
    if (d.onvolledig) onvolledig = true;
    start = dag(eind, 1);
  }
  return { opgeslagen, onvolledig };
}

/** Per SKU: naam en verkochte stuks in het gegeven jaar en in totaal (alleen tellende bestellingen). */
export function webshopPerSku(lijst, jaar) {
  const kaart = new Map();
  for (const o of lijst || []) {
    if (!TELT.has(o.status)) continue;
    for (const it of o.items || []) {
      const sku = String(it.sku || '').trim();
      if (!sku) continue;
      const e = kaart.get(sku) || { sku, naam: it.naam || sku, jaar: 0, totaal: 0 };
      const n = Number(it.aantal) || 0;
      e.totaal += n;
      if (String(o.datum || '').startsWith(String(jaar))) e.jaar += n;
      kaart.set(sku, e);
    }
  }
  return [...kaart.values()].sort((a, b) => b.jaar - a.jaar || b.totaal - a.totaal);
}

const skuVan = a => String(a.webshopSku || '').trim();
const basis = (a, jaar) => Number(a.webshopVerwerkt?.[jaar]) || 0;

/** Nieuwe webshopverkopen (dit jaar) per gekoppeld artikel die nog niet in de voorraad zijn verwerkt. */
export function nogTeVerwerkenWebshop(lijst) {
  const jaar = String(lopendJaar());
  const perSku = new Map(webshopPerSku(lijst, jaar).map(e => [e.sku, e.jaar]));
  const uit = [];
  for (const a of state.COVERS || []) {
    const sku = skuVan(a);
    if (!sku) continue;
    const delta = (perSku.get(sku) || 0) - basis(a, jaar);
    if (delta) uit.push({ artikel: a, delta, jaar });
  }
  return uit;
}

/** Omzet en aantallen over de bestellingen die meetellen, in een jaar. */
export function webshopSamenvatting(lijst, jaar) {
  const s = { bestellingen: 0, omzet: 0, verzendkosten: 0, terugbetaald: 0, perLand: {}, open: 0 };
  for (const o of lijst || []) {
    if (!String(o.datum || '').startsWith(String(jaar))) continue;
    if (o.status === 'processing') s.open += 1;
    if (!TELT.has(o.status)) continue;
    s.bestellingen += 1;
    s.omzet += Number(o.totaal) || 0;
    s.verzendkosten += Number(o.verzendkosten) || 0;
    s.terugbetaald += Number(o.terugbetaald) || 0;
    const l = o.land || '?';
    s.perLand[l] = (s.perLand[l] || 0) + 1;
  }
  s.omzet = r2(s.omzet); s.verzendkosten = r2(s.verzendkosten); s.terugbetaald = r2(s.terugbetaald);
  return s;
}

// ─── Acties (aan window gekoppeld in app.js) ───────────────────────────────

export async function haalWebshopOp() {
  if (bezig) return;
  bezig = true; melding = 'Ophalen…'; teken();
  const tot = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 30);
  try {
    const r = await haalBijWebshop(d.toISOString().slice(0, 10), tot, t => { melding = t; teken(); });
    bestellingen = await leesWebshopBestellingen();
    melding = `${r.opgeslagen} bestelling(en) opgehaald over de laatste 31 dagen.${r.onvolledig ? ' Niet alles paste in één keer; haal nog eens op.' : ''}`;
  } catch (e) { melding = e.message; }
  bezig = false; teken();
}

export function koppelWebshopSku(artikelId, sku) {
  sku = String(sku || '').trim();
  const a = (state.COVERS || []).find(x => String(x.id) === String(artikelId));
  if (!a || !sku) return;
  const ander = (state.COVERS || []).find(x => x !== a && skuVan(x) === sku);
  if (ander) { alert(`SKU ${sku} is al gekoppeld aan "${ander.artikel}". Koppel die eerst los.`); return; }
  const jaar = String(lopendJaar());
  // Beginstand: verkopen die al in de webshop stonden voordat je koppelde, tellen als verwerkt,
  // tot het aantal dat je zelf al als verkocht had vastgelegd. Zo trekken we niets dubbel af.
  const stuks = webshopPerSku(bestellingen, jaar).find(e => e.sku === sku)?.jaar || 0;
  const eigen = Number(a.jaren?.[jaar]?.verkocht ?? a.verkoop) || 0;
  a.webshopSku = sku;
  a.webshopVerwerkt = { ...(a.webshopVerwerkt || {}), [jaar]: Math.min(stuks, eigen) };
  saveCoversData();
  teken();
}

export function ontkoppelWebshopSku(artikelId) {
  const a = (state.COVERS || []).find(x => String(x.id) === String(artikelId));
  if (!a) return;
  delete a.webshopSku; delete a.webshopVerwerkt;
  saveCoversData();
  teken();
}

export async function verwerkWebshopVerkopen() {
  let lijst;
  try { lijst = await leesWebshopBestellingen(); } catch { alert('De webshopbestellingen konden niet gelezen worden.'); return; }
  bestellingen = lijst;
  const nieuw = nogTeVerwerkenWebshop(lijst);
  if (!nieuw.length) { alert('Er is niets nieuws te verwerken.'); teken(); return; }
  const tekst = nieuw.map(n => `${n.artikel.artikel}: ${n.delta > 0 ? '+' : ''}${n.delta} verkocht (voorraad ${Number(n.artikel.voorraad) || 0} → ${(Number(n.artikel.voorraad) || 0) - n.delta})`).join('\n');
  if (!confirm(`Deze webshopverkopen verwerken in je voorraad?\n\n${tekst}`)) return;
  const perSku = new Map(webshopPerSku(lijst, lopendJaar()).map(e => [e.sku, e.jaar]));
  for (const { artikel: a, delta, jaar } of nieuw) {
    const j = String(jaar);
    const oud = a.jaren?.[j] || {};
    const verkochtOud = Number(oud.verkocht ?? a.verkoop) || 0;
    const eindOud = oud.eind != null ? Number(oud.eind) : (Number(a.jaren?.[String(Number(j) - 1)]?.eind) || 0) + (Number(oud.inkoop) || 0) - verkochtOud;
    const voorraadOud = Number(a.voorraad) || 0;
    a.jaren = { ...(a.jaren || {}), [j]: { ...oud, verkocht: verkochtOud + delta, eind: eindOud - delta } };
    if (String(a.verkoop ?? '') === String(verkochtOud)) a.verkoop = verkochtOud + delta;
    if (j === String(lopendJaar())) a.omzet2026 = verkochtOud + delta;
    a.voorraad = voorraadOud - delta;
    a.webshopVerwerkt = { ...(a.webshopVerwerkt || {}), [j]: perSku.get(skuVan(a)) || 0 };
    legVast({ artikelId: a.id, artikel: a.artikel, van: voorraadOud, naar: a.voorraad, reden: 'Verkoop', notitie: `Webshop: ${delta} stuk(s) verwerkt via SKU ${skuVan(a)}`, bron: 'webshop' });
  }
  saveCoversData();
  for (const { artikel: a } of nieuw) {
    try { if (!await saveCoverToSupabase(a)) addToPendingQueue(a, 'cover', false); } catch { addToPendingQueue(a, 'cover', false); }
  }
  teken();
}

/** Zet de voorraad in de webshop gelijk aan je eigen voorraad, voor alle gekoppelde artikelen. */
export async function stuurVoorraadNaarWebshop() {
  const regels = (state.COVERS || []).filter(a => skuVan(a)).map(a => ({ sku: skuVan(a), voorraad: Math.max(0, Math.floor(Number(a.voorraad) || 0)), artikel: a.artikel }));
  if (!regels.length) { alert('Er zijn nog geen artikelen aan een webshop-SKU gekoppeld.'); return; }
  const open = nogTeVerwerkenWebshop(bestellingen || []);
  const waarschuwing = open.length ? `\n\n⚠ Er zijn nog ${open.length} artikel(en) met webshopverkopen die je niet hebt verwerkt. Verwerk die eerst, anders zet je de webshop te hoog.` : '';
  if (!confirm(`De voorraad in de webshop wordt gelijk gezet aan je eigen voorraad:\n\n${regels.map(r => `${r.artikel} (${r.sku}): ${r.voorraad}`).join('\n')}${waarschuwing}`)) return;
  bezig = true; melding = 'Voorraad versturen…'; teken();
  try {
    const d = await roep({ actie: 'voorraad', regels: regels.map(({ sku, voorraad }) => ({ sku, voorraad })) });
    laatsteVoorraad = d.resultaat || [];
    const mis = laatsteVoorraad.filter(r => !r.ok).length;
    melding = mis ? `${laatsteVoorraad.length - mis} artikel(en) bijgewerkt, ${mis} niet gelukt (zie hieronder).` : `${laatsteVoorraad.length} artikel(en) bijgewerkt in de webshop.`;
  } catch (e) { melding = e.message; }
  bezig = false; teken();
}

export function laadWebshopOpnieuw() { bestellingen = null; laadFout = false; renderWebshop(); }

// ─── Pagina ─────────────────────────────────────────────────────────────────

export async function renderWebshop() {
  const doel = el('webshop-inhoud');
  if (!doel) return;
  if (bestellingen === null && !laadFout) {
    doel.innerHTML = '<div class="card"><p class="muted">Laden…</p></div>';
    try { bestellingen = await leesWebshopBestellingen(); } catch { laadFout = true; }
    if (!info) roep({ actie: 'info' }).then(d => { info = d; teken(); }).catch(e => { info = { ok: false, fout: e.message }; teken(); });
  }
  teken();
}

function teken() {
  const doel = el('webshop-inhoud');
  if (!doel) return;
  if (laadFout) {
    doel.innerHTML = `<div class="card"><p>De webshopbestellingen konden niet gelezen worden. Is de tabel <code>webshop_bestellingen</code> al aangemaakt in Supabase (bestand <code>webshop_bestellingen.sql</code>)?</p>
      <p><button class="btn" onclick="laadWebshopOpnieuw()">Opnieuw proberen</button></p></div>`;
    return;
  }
  const jaar = String(lopendJaar());
  const lijst = bestellingen || [];
  const s = webshopSamenvatting(lijst, jaar);
  const status = !info ? 'Verbinding controleren…'
    : info.ok === false ? esc(info.fout)
    : !info.ingesteld ? 'Nog niet ingesteld: zet WEBSHOP_URL, WEBSHOP_KEY en WEBSHOP_SECRET als secrets in Supabase.'
    : info.bereikbaar ? 'Verbonden met de webshop.' : `De webshop antwoordt niet goed (status ${esc(info.status)}). Controleer de REST API-sleutel.`;

  const kop = `<div class="card" style="margin-bottom:var(--spacing-4)">
      <p style="margin:0 0 8px">${status}</p>
      <button class="btn btn-primary" ${bezig ? 'disabled' : ''} onclick="haalWebshopOp()">Haal bestellingen op (laatste 31 dagen)</button>
      ${melding ? `<p class="muted" style="margin:8px 0 0">${esc(melding)}</p>` : ''}
    </div>
    <div class="card" style="margin-bottom:var(--spacing-4)">
      <div class="section-titel" style="margin-bottom:8px">${esc(jaar)}</div>
      <p style="margin:0">${s.bestellingen} bestelling(en) · omzet ${fmt(s.omzet)} (waarvan verzending ${fmt(s.verzendkosten)})${s.terugbetaald ? ` · terugbetaald ${fmt(s.terugbetaald)}` : ''}${s.open ? ` · <b>${s.open} nog te versturen</b>` : ''}</p>
      ${Object.keys(s.perLand).length ? `<p class="muted" style="margin:4px 0 0;font-size:13px">Per land: ${Object.entries(s.perLand).map(([l, n]) => `${esc(l)} ${n}`).join(' · ')}</p>` : ''}
      <p class="muted" style="margin:4px 0 0;font-size:13px">Alleen ter controle. Je omzet voor de aangifte en de KOR komt zoals altijd uit je geboekte Mollie-uitbetalingen.</p>
    </div>`;

  const nieuw = nogTeVerwerkenWebshop(lijst);
  const verwerk = nieuw.length ? `<div class="section-head"><div class="section-titel">Nieuwe webshopverkopen, nog niet in je voorraad</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Verkocht erbij</th><th style="text-align:right">Voorraad nu</th><th style="text-align:right">Wordt</th></tr></thead>
      <tbody>${nieuw.map(n => `<tr><td>${esc(n.artikel.artikel)}</td><td style="text-align:right">${n.delta > 0 ? '+' : ''}${n.delta}</td><td style="text-align:right">${Number(n.artikel.voorraad) || 0}</td><td style="text-align:right">${(Number(n.artikel.voorraad) || 0) - n.delta}</td></tr>`).join('')}</tbody></table></div></div>
    <div style="margin-bottom:var(--spacing-4)"><button class="btn btn-primary" onclick="verwerkWebshopVerkopen()">Verwerk in voorraad</button></div>` : '';

  const covers = [...(state.COVERS || [])].sort((a, b) => String(a.artikel).localeCompare(String(b.artikel), 'nl'));
  const gekoppeld = covers.filter(a => skuVan(a));
  const opties = covers.filter(a => !skuVan(a)).map(a => `<option value="${esc(a.id)}">${esc(a.artikel)}</option>`).join('');
  const perSku = webshopPerSku(lijst, jaar);
  const ongekoppeld = perSku.filter(e => !gekoppeld.some(a => skuVan(a) === e.sku));
  const resultaat = new Map((laatsteVoorraad || []).map(r => [r.sku, r]));

  const koppel = `<div class="section-head"><div class="section-titel">Artikelen gekoppeld aan de webshop</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Jouw artikel</th><th>Webshop-SKU</th><th style="text-align:right">Voorraad</th><th style="text-align:right">Webshop ${esc(jaar)}</th><th></th></tr></thead>
      <tbody>${gekoppeld.length ? gekoppeld.map(a => {
        const r = resultaat.get(skuVan(a));
        return `<tr><td>${esc(a.artikel)}</td><td>${esc(skuVan(a))}${r ? `<div class="muted" style="font-size:12px">${r.ok ? `webshop ${r.was ?? '—'} → ${r.voorraad}` : esc(r.melding || 'mislukt')}</div>` : ''}</td>
          <td style="text-align:right">${Number(a.voorraad) || 0}</td><td style="text-align:right">${perSku.find(e => e.sku === skuVan(a))?.jaar || 0}</td>
          <td><button class="btn-details" onclick="ontkoppelWebshopSku('${esc(a.id)}')">Loskoppelen</button></td></tr>`;
      }).join('') : '<tr><td colspan="5" class="muted">Nog niets gekoppeld.</td></tr>'}</tbody></table></div></div>
    <div class="card" style="margin-bottom:var(--spacing-4)">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="webshop-koppel-artikel" style="max-width:240px"><option value="">— kies artikel —</option>${opties}</select>
        <input id="webshop-koppel-sku" placeholder="SKU uit de webshop, bijv. MM-1002" style="max-width:220px">
        <button class="btn btn-sm" onclick="koppelWebshopSku(document.getElementById('webshop-koppel-artikel').value, document.getElementById('webshop-koppel-sku').value)">Koppelen</button>
      </div>
      ${ongekoppeld.length ? `<p class="muted" style="margin:8px 0 0;font-size:13px">Verkocht in de webshop maar nog niet gekoppeld: ${ongekoppeld.map(e => `${esc(e.naam)} (${esc(e.sku)})`).join(', ')}</p>` : ''}
      <p class="muted" style="margin:8px 0 0;font-size:13px">Koppel alleen artikelen die je echt op voorraad hebt. Bol-aanbod dat je pas na een bestelling inkoopt koppel je niet; dat komt dan ook nooit in de webshop.</p>
    </div>
    <div style="margin-bottom:var(--spacing-4)"><button class="btn btn-primary" ${bezig || !gekoppeld.length ? 'disabled' : ''} onclick="stuurVoorraadNaarWebshop()">Voorraad naar webshop sturen</button>
      <span class="muted" style="font-size:13px;margin-left:8px">Zet de voorraad in de webshop gelijk aan je eigen voorraad, alleen voor de artikelen hierboven.</span></div>`;

  const recent = lijst.slice(0, 15);
  const tabel = recent.length ? `<div class="section-head"><div class="section-titel">Laatste bestellingen</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Datum</th><th>Nr.</th><th>Status</th><th>Artikelen</th><th>Land</th><th style="text-align:right">Totaal</th></tr></thead>
      <tbody>${recent.map(o => `<tr><td>${esc(o.datum || '')}</td><td>${esc(o.nummer || o.order_id)}</td><td>${esc(STATUS[o.status] || o.status)}</td>
        <td>${(o.items || []).map(i => `${esc(i.aantal)}× ${esc(i.naam)}`).join('<br>')}</td><td>${esc(o.land || '')}</td><td style="text-align:right">${fmt(Number(o.totaal) || 0)}</td></tr>`).join('')}</tbody></table></div></div>` : '';

  doel.innerHTML = kop + verwerk + koppel + tabel;
}
