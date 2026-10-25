// boekingen-relaties-ui.js — scherm voor fase 4b: bestaande boekingen aan
// relaties koppelen. Twee secties in hetzelfde venster:
//   - "Zeker — gelijke IBAN" (fase 4b-1)
//   - "Minder zeker — gelijkende naam" (fase 4b-2)
//
// Zelfde venster-patroon als partijen.js (dynamisch toegevoegde
// .pm-laag/.pm-venster), in een eigen bestand: dit gaat over
// facturenmodule-relaties, niet over de debiteuren/crediteuren-lijst.
//
// Read-only totdat er wordt bevestigd, in beide secties: dit bestand roept
// bevestigCluster() nergens automatisch aan, alleen als directe reactie op
// de Koppelen-knop van één cluster, met precies de op dat moment
// aangevinkte boekingen van dát cluster. Afwijzen schrijft nooit naar een
// boeking — dat verbergt alleen de suggestie.
//
// Belangrijk verschil tussen de twee secties: bij "Zeker" staan de
// boekingen van een uitgeklapt cluster standaard aangevinkt (uitvinken om
// uit te sluiten). Bij "Minder zeker" staat niets standaard aangevinkt —
// je moet er bewust voor kiezen welke boekingen je meeneemt, omdat de
// suggestie zelf minder betrouwbaar is.

import { esc, fmt, ddmm } from './helpers.js?v=20261024p';
import { zoekRelaties, maakRelatie } from './relaties.js?v=20261024p';
import {
  berekenIbanClusters, afwijsIbanCluster, afgewezenIbanClusters, herstelIbanCluster,
  berekenTekstClusters, afwijsTekstCluster, afgewezenTekstClusters, herstelTekstCluster,
  bevestigCluster
} from './boekingen-relaties.js?v=20261024p';

let sluitHuidige = null;

// Schermstatus — puur UI, leeft alleen zolang het venster open staat en
// bepaalt alleen wát je ziet. De daadwerkelijke koppeling gebeurt
// uitsluitend in de Koppelen-knop hieronder, met de dan geldende
// aanvinkingen — nooit als bijeffect van uitklappen of typen.
let uitgeklapt = new Set();        // cluster-sleutels (iban of tekst-cluster-id) die uitgeklapt staan
let uitgeslotenIban = new Map();   // iban -> Set van boekingsleutels die zijn UITgevinkt (standaard: alles mee)
let geselecteerdTekst = new Map(); // cluster-id -> Set van boekingsleutels die zijn AANgevinkt (standaard: niets mee)
let bevestigModus = null;          // {tier:'iban'|'tekst', key:string} of null
let bevestigGekozen = null;        // {id, naam} of null, voor bevestigModus

const boekingSleutel = b => `${b._hist ? 'h' : 't'}_${b.id}`;
const clusterSleutel = (c, tier) => tier === 'iban' ? c.iban : c.id;

function meegenomenBoekingen(c, tier) {
  const key = clusterSleutel(c, tier);
  if (tier === 'iban') {
    const uit = uitgeslotenIban.get(key) || new Set();
    return c.boekingen.filter(b => !uit.has(boekingSleutel(b)));
  }
  const aan = geselecteerdTekst.get(key) || new Set();
  return c.boekingen.filter(b => aan.has(boekingSleutel(b)));
}

export function openIbanClusterScherm() {
  uitgeklapt = new Set();
  uitgeslotenIban = new Map();
  geselecteerdTekst = new Map();
  bevestigModus = null;
  bevestigGekozen = null;
  tekenVenster();
}

function tekenVenster() {
  sluitHuidige?.();

  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.id = 'pm-iban-clusters';
  laag.innerHTML = `<div class="pm-venster" role="dialog" aria-modal="true" style="max-width:920px">${inhoudHtml()}</div>`;
  document.body.appendChild(laag);

  const sluit = () => {
    document.removeEventListener('keydown', opToets, true);
    laag.remove();
    if (sluitHuidige === sluit) sluitHuidige = null;
  };
  function opToets(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); }
  }
  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });

  sluitHuidige = sluit;
  hangKoppelingenOp(laag);
}

function herteken() {
  const laag = document.getElementById('pm-iban-clusters');
  const venster = laag?.querySelector('.pm-venster');
  if (!venster) return;
  venster.innerHTML = inhoudHtml();
  hangKoppelingenOp(laag);
}

function inhoudHtml() {
  const ibanClusters = berekenIbanClusters();
  const tekstClusters = berekenTekstClusters();

  const ibanLijst = ibanClusters.length
    ? ibanClusters.map(c => clusterHtml(c, 'iban')).join('')
    : `<div class="leeg" style="padding:16px 0">Geen openstaande IBAN-clusters.</div>`;

  const tekstLijst = tekstClusters.length
    ? tekstClusters.map(c => clusterHtml(c, 'tekst')).join('')
    : `<div class="leeg" style="padding:16px 0">Geen openstaande naam-clusters.</div>`;

  return `
    <header class="pm-kop">
      <div>
        <h3>Boekingen koppelen aan relaties</h3>
        <p class="pm-sub">Niets wordt gewijzigd totdat je een cluster bevestigt.</p>
      </div>
      <button type="button" class="pm-kruis" data-pm-sluit aria-label="Sluiten">&times;</button>
    </header>
    <div class="pm-inhoud" style="padding:4px 20px 16px">
      <section>
        <h4 style="margin:10px 0 2px;font-size:13px">Zeker — gelijke IBAN</h4>
        <p class="muted" style="font-size:12px;margin:0 0 6px">Boekingen waarvan de naam exact dezelfde IBAN is.</p>
        ${ibanLijst}
        ${afgewezenTellerHtml('iban')}
      </section>
      <section style="margin-top:22px;padding-top:16px;border-top:1px solid var(--border-default)">
        <h4 style="margin:0 0 2px;font-size:13px">Minder zeker — gelijkende naam</h4>
        <p class="muted" style="font-size:12px;margin:0 0 6px">Boekingen waarvan de naam een woord deelt met een andere naam (bijv. "postnl" in "Koninklijke PostNL B.V."). Niets staat hier standaard aangevinkt — controleer per cluster welke boekingen echt bij elkaar horen.</p>
        ${tekstLijst}
        ${afgewezenTellerHtml('tekst')}
      </section>
    </div>
    <footer class="pm-voet">
      <span class="pm-hint">Esc sluit dit venster</span>
      <button type="button" class="btn" data-pm-sluit>Sluiten</button>
    </footer>`;
}

function afgewezenTellerHtml(tier) {
  const afgewezen = tier === 'iban' ? afgewezenIbanClusters() : afgewezenTekstClusters();
  if (!afgewezen.length) return '';
  return `<p class="pm-hint" style="margin:10px 0 0">${afgewezen.length} eerder afgewezen cluster${afgewezen.length === 1 ? '' : 's'} — <a href="#" data-reset-afgewezen="${tier}">allemaal weer tonen</a></p>`;
}

function clusterHtml(c, tier) {
  const key = clusterSleutel(c, tier);
  const open = uitgeklapt.has(key);
  const meegenomen = meegenomenBoekingen(c, tier);
  const aangevinktSet = new Set(meegenomen.map(boekingSleutel));

  const toonNaamKolom = tier === 'tekst';
  const rijen = c.boekingen.map(b => {
    const sleutel = boekingSleutel(b);
    const aan = aangevinktSet.has(sleutel);
    return `
    <tr style="${aan ? '' : 'opacity:.45'}">
      <td style="width:28px"><input type="checkbox" data-tier="${tier}" data-cluster="${esc(key)}" data-boeking="${esc(sleutel)}" ${aan ? 'checked' : ''} aria-label="Boeking van ${esc(ddmm(String(b.datum)))} meenemen"></td>
      <td class="pm-datum">${esc(ddmm(String(b.datum)))}</td>
      <td class="pm-bedrag">${fmt(b.bedrag)}</td>
      ${toonNaamKolom ? `<td class="pm-omschr" title="${esc(b.naam || '')}">${esc(b.naam || '—')}</td>` : `<td class="pm-gb">${esc(b.gb || '—')}</td>`}
      <td class="pm-omschr" title="${esc(b.omschr || '')}">${esc(b.omschr || '—')}</td>
    </tr>`;
  }).join('');

  const titel = tier === 'iban'
    ? esc(c.iban)
    : `“${esc(c.matchwoord)}” <span class="muted" style="font-weight:400;font-size:11px">— minder zeker</span>`;

  return `
    <div class="groep-rij" style="flex-wrap:wrap;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border-default)">
      <div style="flex:1;min-width:220px;cursor:pointer" data-toggle="${esc(key)}">
        <div style="font-weight:600;font-size:13px">${titel} <span class="muted" style="font-weight:400">${open ? '▾' : '▸'}</span></div>
        <div class="muted" style="font-size:12px">${c.aantal} boeking${c.aantal === 1 ? '' : 'en'} &middot; ${fmt(c.totaal)} &middot; ${esc(ddmm(c.vanDatum))}&ndash;${esc(ddmm(c.totDatum))}</div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-bevestig="${esc(key)}" data-tier="${tier}">Bevestigen</button>
      <button type="button" class="btn btn-ghost btn-sm" data-aanpassen="${esc(key)}">Aanpassen</button>
      <button type="button" class="btn btn-ghost btn-sm" data-afwijzen="${esc(key)}" data-tier="${tier}">Afwijzen</button>
      ${open ? `
      <div style="width:100%;overflow:auto;margin-top:8px">
        <table class="pm-tabel">
          <thead><tr><th></th><th class="pm-datum">Datum</th><th class="pm-bedrag">Bedrag</th>${toonNaamKolom ? '<th>Naam</th>' : '<th class="pm-gb">Grootboek</th>'}<th class="pm-omschr">Omschrijving</th></tr></thead>
          <tbody>${rijen}</tbody>
        </table>
      </div>` : ''}
      ${bevestigModus && bevestigModus.tier === tier && bevestigModus.key === key ? bevestigBlokHtml(c, tier, meegenomen) : ''}
    </div>`;
}

function bevestigBlokHtml(c, tier, meegenomen) {
  const key = clusterSleutel(c, tier);

  if (!meegenomen.length) {
    return `<div class="muted" style="width:100%;padding:8px 0;font-size:12px">Er zijn nog geen boekingen aangevinkt om te koppelen. Klap het cluster uit en vink de boekingen aan die je wilt meenemen.
      <button type="button" class="btn btn-ghost btn-sm" data-bevestig-annuleer="${esc(key)}">Annuleren</button></div>`;
  }

  if (bevestigGekozen) {
    return `
    <div style="width:100%;margin-top:10px;padding:10px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-card-hover)">
      <div class="muted" style="font-size:12px;margin-bottom:6px">Koppelen aan relatie voor ${meegenomen.length} boeking${meegenomen.length === 1 ? '' : 'en'}:</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <strong>${esc(bevestigGekozen.naam)}</strong>
        <button type="button" class="btn-details" data-bevestig-anders="${esc(key)}">Andere relatie kiezen</button>
        <button type="button" class="btn btn-primary btn-sm" data-bevestig-koppel="${esc(key)}" data-tier="${tier}">Koppelen</button>
        <button type="button" class="btn btn-ghost btn-sm" data-bevestig-annuleer="${esc(key)}">Annuleren</button>
      </div>
    </div>`;
  }

  return `
    <div style="width:100%;margin-top:10px;padding:10px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-card-hover)">
      <div class="muted" style="font-size:12px;margin-bottom:6px">Koppelen aan relatie voor ${meegenomen.length} boeking${meegenomen.length === 1 ? '' : 'en'} — zoek een bestaande relatie of maak een nieuwe:</div>
      <div style="position:relative;max-width:340px">
        <input type="text" data-bevestig-zoek="${esc(key)}" placeholder="Naam relatie…" autocomplete="off">
        <div class="search-results" data-bevestig-sugg="${esc(key)}"></div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px" data-bevestig-annuleer="${esc(key)}">Annuleren</button>
    </div>`;
}

// ─────────────────────────────────────────────────────────── koppelingen

function hangKoppelingenOp(laag) {
  laag.querySelectorAll('[data-pm-sluit]').forEach(k => k.addEventListener('click', () => sluitHuidige?.()));

  laag.querySelectorAll('[data-toggle]').forEach(k => k.addEventListener('click', () => {
    const key = k.dataset.toggle;
    uitgeklapt.has(key) ? uitgeklapt.delete(key) : uitgeklapt.add(key);
    herteken();
  }));

  laag.querySelectorAll('[data-cluster][data-boeking]').forEach(k => k.addEventListener('change', () => {
    const tier = k.dataset.tier, key = k.dataset.cluster, sleutel = k.dataset.boeking;
    if (tier === 'iban') {
      if (!uitgeslotenIban.has(key)) uitgeslotenIban.set(key, new Set());
      const set = uitgeslotenIban.get(key);
      k.checked ? set.delete(sleutel) : set.add(sleutel);
    } else {
      if (!geselecteerdTekst.has(key)) geselecteerdTekst.set(key, new Set());
      const set = geselecteerdTekst.get(key);
      k.checked ? set.add(sleutel) : set.delete(sleutel);
    }
    herteken();
  }));

  laag.querySelectorAll('[data-bevestig]').forEach(k => k.addEventListener('click', () => {
    bevestigModus = { tier: k.dataset.tier, key: k.dataset.bevestig };
    bevestigGekozen = null;
    uitgeklapt.add(k.dataset.bevestig);
    herteken();
    laag.querySelector('[data-bevestig-zoek]')?.focus();
  }));

  laag.querySelectorAll('[data-aanpassen]').forEach(k => k.addEventListener('click', () => {
    uitgeklapt.add(k.dataset.aanpassen);
    herteken();
  }));

  laag.querySelectorAll('[data-afwijzen]').forEach(k => k.addEventListener('click', () => {
    const tier = k.dataset.tier, key = k.dataset.afwijzen;
    if (!window.confirm(`Dit cluster afwijzen?\n\nEr wordt niets aan deze boekingen gewijzigd. Je kunt dit cluster later weer terugzetten via "allemaal weer tonen".`)) return;
    tier === 'iban' ? afwijsIbanCluster(key) : afwijsTekstCluster(key);
    uitgeklapt.delete(key);
    uitgeslotenIban.delete(key);
    geselecteerdTekst.delete(key);
    if (bevestigModus && bevestigModus.tier === tier && bevestigModus.key === key) bevestigModus = null;
    herteken();
  }));

  laag.querySelectorAll('[data-bevestig-zoek]').forEach(inp => {
    inp.addEventListener('input', () => tekenSuggesties(laag, inp.dataset.bevestigZoek, inp.value));
    inp.addEventListener('blur', () => setTimeout(() => {
      laag.querySelector(`[data-bevestig-sugg="${inp.dataset.bevestigZoek}"]`)?.classList.remove('open');
    }, 150));
  });

  laag.querySelectorAll('[data-bevestig-anders]').forEach(k => k.addEventListener('click', () => {
    bevestigGekozen = null;
    herteken();
    laag.querySelector('[data-bevestig-zoek]')?.focus();
  }));

  laag.querySelectorAll('[data-bevestig-annuleer]').forEach(k => k.addEventListener('click', () => {
    bevestigModus = null;
    bevestigGekozen = null;
    herteken();
  }));

  laag.querySelectorAll('[data-bevestig-koppel]').forEach(k => k.addEventListener('click', async () => {
    const tier = k.dataset.tier, key = k.dataset.bevestigKoppel;
    const c = (tier === 'iban' ? berekenIbanClusters() : berekenTekstClusters())
      .find(x => clusterSleutel(x, tier) === key);
    if (!c || !bevestigGekozen) return;
    const meegenomen = meegenomenBoekingen(c, tier);
    if (!meegenomen.length) return;

    k.disabled = true;
    k.textContent = 'Bezig…';
    const res = await bevestigCluster(meegenomen, bevestigGekozen.id);
    if (!res.ok) {
      alert('Koppelen is niet gelukt. Probeer het nog eens.');
      k.disabled = false;
      k.textContent = 'Koppelen';
      return;
    }

    uitgeklapt.delete(key);
    uitgeslotenIban.delete(key);
    geselecteerdTekst.delete(key);
    bevestigModus = null;
    bevestigGekozen = null;
    herteken();
  }));

  laag.querySelectorAll('[data-reset-afgewezen]').forEach(k => k.addEventListener('click', e => {
    e.preventDefault();
    const tier = k.dataset.resetAfgewezen;
    if (tier === 'iban') afgewezenIbanClusters().forEach(herstelIbanCluster);
    else afgewezenTekstClusters().forEach(herstelTekstCluster);
    herteken();
  }));
}

function tekenSuggesties(laag, key, q) {
  const paneel = laag.querySelector(`[data-bevestig-sugg="${key}"]`);
  if (!paneel) return;
  const term = q.trim();
  if (term.length < 2) { paneel.classList.remove('open'); paneel.innerHTML = ''; return; }

  const resultaten = zoekRelaties(term);
  const exacteMatch = resultaten.some(r => r.naam.toLowerCase() === term.toLowerCase());

  let html = resultaten.map(r => `
    <div class="sr-item" data-relatie-id="${esc(r.id)}" data-relatie-naam="${esc(r.naam)}">
      <div class="sr-main"><div class="sr-title">${esc(r.naam)}</div></div>
    </div>`).join('');
  if (!exacteMatch) {
    html += `<div class="sr-item" data-nieuwe-relatie="1"><div class="sr-main"><div class="sr-title">+ Nieuwe relatie: "${esc(term)}"</div></div></div>`;
  }
  paneel.innerHTML = html || `<div class="sr-empty">Niets gevonden.</div>`;
  paneel.classList.add('open');

  paneel.querySelectorAll('[data-relatie-id]').forEach(k => k.addEventListener('click', () => {
    bevestigGekozen = { id: k.dataset.relatieId, naam: k.dataset.relatieNaam };
    herteken();
  }));
  const nieuweKnop = paneel.querySelector('[data-nieuwe-relatie]');
  if (nieuweKnop) nieuweKnop.addEventListener('click', async () => {
    const r = await maakRelatie(term);
    if (!r) { alert('Relatie aanmaken mislukt. Probeer het nog eens.'); return; }
    bevestigGekozen = { id: r.id, naam: r.naam };
    herteken();
  });
}
