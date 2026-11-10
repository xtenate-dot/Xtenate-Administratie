// partijen.js — gedeelde logica voor de pagina's Debiteuren en Crediteuren.
//
// Twee dingen waar je hier op moet letten:
//
// 1. Beide pagina's staan tegelijk in de DOM. Alles werkt daarom op een
//    meegegeven container en nooit op document.querySelectorAll: anders pakt
//    de ene pagina de knoppen van de andere over.
//
// 2. Alle eigen klassenamen beginnen met 'pm-'. De app gebruikt zelf al
//    .modal-overlay en .modal voor zijn vijftien bestaande vensters. Die staan
//    op display:none en gaan alleen open via .open. Een eigen regel voor
//    .modal-overlay zou dat overschrijven en elk venster tegelijk tonen.

import { state, saveTxData, saveHistTxData } from './storage.js?v=20261110i';
import { fmt } from './helpers.js?v=20261110i';
import {
  saveToSupabase,
  deleteFromSupabase,
  addToPendingQueue
} from './supabase-client-v2.js?v=20261110i';
import { facturenBijBoeking, ontkoppelAlleFacturenVanBoeking, facturenVan, isOpenstaand, factuurStatus, restBedrag, isDeelsBetaald } from './facturen.js?v=20261110i';
import { voegRelatiesSamen, voegNaamToeAlsAlias } from './relaties.js?v=20261110i';
import { vindRelatie, relatieNummer, vindRelatieOpNaam, zorgRelatieVoorNaam, relatieExtra, bewaarRelatieGegevens, zorgRelatienummer } from './relaties.js?v=20261110i';
import { txVanJaar, lopendJaar } from './jaren.js?v=20261110i';

export const veilig = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Historische boekingen hebben een id als 'h2025_12', lopende een getal. */
const isHistorisch = b => String(b?.id ?? '').startsWith('h');

/** Alle boekingen van één jaar, uit het lopende jaar én de historie. */
export function boekingenVoorJaar(jaar) {
  return txVanJaar(jaar);
}

const norm0 = t => String(t || '').trim().toLowerCase();
const eersteSpelling = new Map();   // genormaliseerde naam -> eerst geziene schrijfwijze (voor namen zonder relatie)

/** Eén naam voor één partij: via de gekoppelde relatie, via een alias van een relatie, of hoofdletterongevoelig. */
export function canoniekeNaam(naam, relatieId) {
  const r = (relatieId && vindRelatie(relatieId)) || vindRelatieOpNaam(naam);
  if (r) return r.naam;
  const t = String(naam || '').trim();
  if (!t) return '(geen naam)';
  const k = norm0(t);
  if (!eersteSpelling.has(k)) eersteSpelling.set(k, t);
  return eersteSpelling.get(k);
}
const partijNaamVan = b => canoniekeNaam(b.naam, b.relatieId);
let lijstNamen = [];   // namen in de getoonde lijst, als suggestie bij samenvoegen

// ------------------------------------------------------------ facturen per partij

const norm = t => String(t || '').trim().toLowerCase();
const factuurSoortVan = o => o.soort === 'inkomst' ? 'debiteur' : 'crediteur';

/** Facturen die bij deze partij horen: zelfde gekozen relatie als de boekingen, of dezelfde naam. */
function facturenVanPartij(naam, boekingen, o) {
  const relIds = new Set(boekingen.map(b => b.relatieId).filter(Boolean));
  return facturenVan(factuurSoortVan(o)).filter(f => {
    if (f.relatieId && relIds.has(f.relatieId)) return true;
    if (norm(f.relatie) === norm(naam) || canoniekeNaam(f.relatie, f.relatieId) === naam) return true;
    const r = f.relatieId ? vindRelatie(f.relatieId) : null;
    return !!(r && norm(r.naam) === norm(naam));
  });
}

/** Nummer van de relatie (10000-reeks of 20000-reeks), als die er is. */
function nummerVanPartij(facturen, boekingen, o, naam) {
  const soort = factuurSoortVan(o);
  const ids = [...new Set([...facturen.map(f => f.relatieId), ...boekingen.map(b => b.relatieId)].filter(Boolean))];
  for (const id of ids) { const n = relatieNummer(vindRelatie(id), soort); if (n) return n; }
  return naam ? relatieNummer(vindRelatieOpNaam(naam), soort) : null;
}

/** De relatie bij een partij: via een gekoppelde factuur/boeking, anders op naam. */
function relatieVanPartij(naam, facturen, boekingen) {
  const ids = [...new Set([...facturen.map(f => f.relatieId), ...boekingen.map(b => b.relatieId)].filter(Boolean))];
  for (const id of ids) { const r = vindRelatie(id); if (r) return r; }
  return vindRelatieOpNaam(naam);
}

// ------------------------------------------------------------------ lijst

/**
 * Tekent de partijenlijst en hangt de Details-knoppen op.
 *
 * @param {object}   o
 * @param {string}   o.lijstId    id van de container
 * @param {string}   o.totaalId   id van het totaalveld
 * @param {string}   o.soort      'inkomst' of 'uitgave'
 * @param {string}   o.leegTekst  tekst als er niets is
 * @param {Function} o.herteken   opnieuw tekenen na een wijziging
 */
export function tekenPartijen(o) {
  const lijst = document.getElementById(o.lijstId);
  const totaalVeld = document.getElementById(o.totaalId);
  if (!lijst || !totaalVeld) return;

  const jaar = state.huidigJaar || lopendJaar();
  const boekingen = boekingenVoorJaar(jaar).filter(t => t.type === o.soort);

  const soortF = factuurSoortVan(o);
  const openF = facturenVan(soortF).filter(f => isOpenstaand(f));
  if (boekingen.length === 0 && openF.length === 0) {
    const periode = jaar === 'all' ? 'de administratie' : jaar;
    lijst.innerHTML = `<div class="leeg">${o.leegTekst} in ${veilig(periode)}</div>`;
    totaalVeld.textContent = fmt(0);
    return;
  }

  // Per partij samenvoegen: één regel per naam, niet per betaling.
  const groepen = new Map();
  for (const b of boekingen) {
    const naam = partijNaamVan(b);
    const g = groepen.get(naam) || { totaal: 0, aantal: 0 };
    g.totaal += Number(b.bedrag) || 0;
    g.aantal += 1;
    groepen.set(naam, g);
  }

  // Wie nog een open factuur heeft maar dit jaar geen boekingen, hoort er toch bij te staan.
  for (const f of openF) {
    const naam = canoniekeNaam(f.relatie, f.relatieId);
    if (![...groepen.keys()].some(k => norm(k) === norm(naam))) groepen.set(naam, { totaal: 0, aantal: 0 });
  }

  const gesorteerd = [...groepen.entries()].sort((a, b) => b[1].totaal - a[1].totaal);
  lijstNamen = gesorteerd.map(([n]) => n);
  const teken = o.soort === 'inkomst' ? 'pos' : 'neg';
  const plus = o.soort === 'inkomst' ? '+&nbsp;' : '';

  const perPartij = gesorteerd.map(([naam]) => {
    const bk = boekingen.filter(b => partijNaamVan(b) === naam);
    const fs = facturenVanPartij(naam, bk, o);
    const open = fs.filter(f => isOpenstaand(f));
    return { fs, open, bedragOpen: open.reduce((t, f) => t + restBedrag(f), 0), nr: nummerVanPartij(fs, bk, o, naam) };
  });

  const zonderNr = perPartij.filter(p => !p.nr).length;
  const toekenId = `pm-toeken-${o.lijstId}`;
  let balk = document.getElementById(toekenId);
  if (!balk) { balk = document.createElement('div'); balk.id = toekenId; balk.style.cssText = 'padding:0 16px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap'; lijst.parentNode.insertBefore(balk, lijst); }
  balk.innerHTML = zonderNr
    ? `<span class="muted" style="font-size:13px">${zonderNr} van ${perPartij.length} hebben nog geen ${factuurSoortVan(o)}nummer.</span> <button type="button" class="btn btn-sm" data-toeken>Nummers toekennen</button>`
    : `<span class="muted" style="font-size:13px">Alle ${perPartij.length} hebben een ${factuurSoortVan(o)}nummer.</span>`;
  balk.querySelector('[data-toeken]')?.addEventListener('click', async e => {
    const knop = e.currentTarget;
    if (!window.confirm(`${zonderNr} partijen krijgen een ${factuurSoortVan(o)}nummer (${o.soort === 'inkomst' ? 'vanaf 10000' : 'vanaf 20000'}). Voor partijen die nog geen relatie zijn, wordt er één aangemaakt. Doorgaan?`)) return;
    knop.disabled = true;
    let klaar = 0, mislukt = 0;
    for (let i = 0; i < gesorteerd.length; i++) {
      const naam = gesorteerd[i][0], p = perPartij[i];
      if (p.nr || naam === '(geen naam)') continue;
      knop.textContent = `Bezig… ${klaar}/${zonderNr}`;
      const bk = boekingen.filter(b => partijNaamVan(b) === naam);
      const rel = relatieVanPartij(naam, p.fs, bk) || await zorgRelatieVoorNaam(naam);
      if (rel && await zorgRelatienummer(rel.id, soortF)) klaar++; else mislukt++;
    }
    if (mislukt) window.alert(`${klaar} nummers toegekend, ${mislukt} mislukt (controleer je verbinding en probeer opnieuw).`);
    o.herteken?.();
  });

  lijst.innerHTML = gesorteerd.map(([naam, g], i) => `
    <div class="partij-rij">
      <span class="partij-naam" title="${veilig(naam)}">${perPartij[i].nr ? `<span class="muted" style="font-size:12px">${perPartij[i].nr}</span> ` : ''}${veilig(naam)}${perPartij[i].open.length ? ` <span class="badge badge-amber" title="Openstaande facturen">${perPartij[i].open.length} open · ${fmt(perPartij[i].bedragOpen)}</span>` : ''}</span>
      <span class="partij-aantal">${g.aantal}&times;</span>
      <span class="partij-bedrag ${teken}">${plus}${fmt(g.totaal)}</span>
      <span class="partij-acties"><button type="button" class="btn-details" data-gegevens="${i}" title="Nummer, KVK, BTW, contact en samenvoegen">Gegevens</button><button type="button" class="btn-details" data-rij="${i}">Details</button></span>
    </div>`).join('');

  // Alleen binnen deze lijst zoeken, niet in het hele document.
  lijst.querySelectorAll('.btn-details').forEach(knop => {
    knop.addEventListener('click', () => {
      const metGegevens = knop.dataset.gegevens != null;
      const naam = gesorteerd[Number(metGegevens ? knop.dataset.gegevens : knop.dataset.rij)][0];
      openPartijVenster(naam, boekingen.filter(b => partijNaamVan(b) === naam), o, metGegevens);
    });
  });

  totaalVeld.textContent = fmt(gesorteerd.reduce((s, [, g]) => s + g.totaal, 0));
}

// ------------------------------------------------------------------ venster

let sluitHuidige = null;

/** Zet een venster neer dat met Esc, de knop of een klik ernaast dichtgaat. */
function toonVenster(id, inhoudHtml) {
  sluitHuidige?.();

  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.id = id;
  laag.innerHTML = `<div class="pm-venster" role="dialog" aria-modal="true">${inhoudHtml}</div>`;
  document.body.appendChild(laag);

  const sluit = () => {
    document.removeEventListener('keydown', opToets, true);
    laag.remove();
    if (sluitHuidige === sluit) sluitHuidige = null;
  };

  // In de capture-fase: de app heeft zelf een Escape-handler die alle vensters
  // met .open sluit, en die mag hier niet doorheen fietsen.
  function opToets(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); }
  }

  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });
  laag.querySelectorAll('[data-pm-sluit]').forEach(k => k.addEventListener('click', sluit));

  sluitHuidige = sluit;
  return { laag, sluit };
}

function gegevensHtml(naam, nr, o, rel, open = false) {
  const x = relatieExtra(rel && rel.id), r = rel || {};
  const soort = factuurSoortVan(o);
  const veld = (id, label, waarde, extra = '', breed = false) =>
    `<label${breed ? ' class="pm-breed"' : ''}>${label}<input type="text" id="pm-g-${id}" value="${veilig(waarde || '')}" ${extra}></label>`;
  return `<details class="pm-gegevens" id="pm-gegevens" ${open ? 'open' : ''} style="margin:0 0 14px;border:1px solid var(--border-default);border-radius:8px">
    <summary style="cursor:pointer;font-weight:600;padding:10px 14px">Gegevens van deze ${soort === 'debiteur' ? 'klant' : 'leverancier'}
      <span class="muted" style="font-weight:400;font-size:13px" id="pm-g-nr">${nr ? `${soort}nummer ${nr}` : 'nog geen nummer, wordt toegekend bij opslaan'}</span></summary>
    <div class="pm-velden" style="padding:6px 14px 14px">
      ${veld('zoeksleutel', 'Zoeksleutel', x.zoeksleutel, 'placeholder="korte code, bijv. BOL"')}
      ${veld('bedrijfsnaam', 'Bedrijfsnaam (officieel)', x.bedrijfsnaam)}
      ${veld('kvk', 'KVK-nummer', r.kvkNummer)}
      ${veld('btw', 'BTW-nummer', r.btwNummer)}
      <label>BTW-plichtig<select id="pm-g-plichtig">
        ${[['', 'Onbekend'], ['ja', 'Ja'], ['nee', 'Nee (KOR of vrijgesteld)']].map(([v, t]) => `<option value="${v}" ${(x.btwPlichtig || '') === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      ${veld('termijn', 'Betaaltermijn (dagen)', x.termijn, 'inputmode="numeric"')}
      ${veld('adres', 'Adres', r.adres, '', true)}
      ${veld('plaats', 'Postcode en plaats', r.postcodePlaats)}
      ${veld('email', 'E-mail', x.email)}
      ${veld('telefoon', 'Telefoon', x.telefoon)}
      ${veld('iban', 'IBAN', x.iban)}
      <label class="pm-breed">Notitie<textarea id="pm-g-notitie" rows="2">${veilig(x.notitie || '')}</textarea></label>
      <label class="pm-breed">Zelfde partij onder een andere naam? Voeg samen (bijv. een andere schrijfwijze)
        <span style="display:flex;gap:8px"><input type="text" id="pm-g-samen" list="pm-g-samen-lijst" placeholder="typ of kies de andere naam" style="flex:1" autocomplete="off">
        <button type="button" class="btn btn-sm" id="pm-g-voegsamen">Samenvoegen</button></span>
        <datalist id="pm-g-samen-lijst">${lijstNamen.filter(n => n !== naam).map(n => `<option value="${veilig(n)}"></option>`).join('')}</datalist></label>
      <div class="pm-breed" style="display:flex;gap:12px;align-items:center">
        <button type="button" class="btn btn-primary btn-sm" id="pm-g-opslaan">Gegevens opslaan</button>
        <span class="muted" id="pm-g-melding" style="font-size:13px"></span>
      </div>
    </div>
  </details>`;
}

function openPartijVenster(naam, boekingen, o, metGegevens = false) {
  const opDatum = [...boekingen].sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  const totaal = opDatum.reduce((s, b) => s + (Number(b.bedrag) || 0), 0);

  const rijen = opDatum.map((b, i) => `
    <tr>
      <td class="pm-datum">${veilig(b.datum || '—')}</td>
      <td class="pm-bedrag">${fmt(b.bedrag)}</td>
      <td class="pm-gb">${veilig(b.gb || '—')}</td>
      <td class="pm-omschr" title="${veilig(b.omschr || '')}">${veilig(b.omschr || '—')}</td>
      <td class="pm-acties">
        <button type="button" class="pm-mini" data-bewerk="${i}">Bewerk</button>
        <button type="button" class="pm-mini pm-mini-rood" data-verwijder="${i}">Verwijder</button>
      </td>
    </tr>`).join('');

  const fs = facturenVanPartij(naam, boekingen, o).sort((a, b) => String(b.datum).localeCompare(String(a.datum)));
  const nr = nummerVanPartij(fs, boekingen, o, naam);
  const openBedrag = fs.filter(f => isOpenstaand(f)).reduce((t, f) => t + restBedrag(f), 0);
  const STAT = { open: 'open', vervallen: 'te laat', betaald: 'betaald', oninbaar: 'oninbaar' };
  const factuurHtml = fs.length ? `
      <h4 style="margin:18px 0 6px">Facturen${openBedrag ? ` &middot; nog open ${fmt(openBedrag)}` : ' &middot; alles betaald'}</h4>
      <table class="pm-tabel"><thead><tr><th>Factuur</th><th>Datum</th><th>Vervalt</th><th class="pm-bedrag">Bedrag</th><th>Status</th><th>Betaald met</th></tr></thead><tbody>
      ${fs.map(f => {
        const st = factuurStatus(f);
        const bet = (f.txIds || []).map(id => boekingenVoorJaar('all').find(t => String(t.id) === String(id))).filter(Boolean).map(t => t.datum).join(', ');
        return `<tr><td>${veilig(f.factuurnummer || f.id)}</td><td class="pm-datum">${veilig(f.datum)}</td><td class="pm-datum">${veilig(f.vervaldatum || '—')}</td><td class="pm-bedrag">${fmt(f.bedrag)}</td><td>${veilig(isDeelsBetaald(f) ? 'deels betaald, nog ' + fmt(restBedrag(f)) : (STAT[st] || st))}</td><td>${veilig(bet || '—')}</td></tr>`;
      }).join('')}</tbody></table>` : '';

  const { laag } = toonVenster('pm-partij', `
    <header class="pm-kop">
      <div>
        <h3><span id="pm-nr-kop">${nr ? nr + ' · ' : ''}</span>${veilig(naam)}</h3>
        <p class="pm-sub">${opDatum.length} boeking${opDatum.length === 1 ? '' : 'en'} &middot; ${fmt(totaal)}</p>
      </div>
      <span style="display:flex;gap:8px;align-items:center"><button type="button" class="btn btn-sm" id="pm-open-gegevens">Gegevens invullen of wijzigen</button>
      <button type="button" class="pm-kruis" data-pm-sluit aria-label="Sluiten">&times;</button></span>
    </header>
    <div class="pm-inhoud">
      ${gegevensHtml(naam, nr, o, relatieVanPartij(naam, fs, boekingen), metGegevens)}
      <table class="pm-tabel">
        <thead>
          <tr>
            <th class="pm-datum">Datum</th>
            <th class="pm-bedrag">Bedrag</th>
            <th class="pm-gb">Grootboek</th>
            <th class="pm-omschr">Omschrijving</th>
            <th class="pm-acties">Acties</th>
          </tr>
        </thead>
        <tbody>${rijen}</tbody>
      </table>${factuurHtml}
    </div>
    <footer class="pm-voet">
      <span class="pm-hint">Esc sluit dit venster</span>
      <button type="button" class="btn" data-pm-sluit>Sluiten</button>
    </footer>`);

  laag.querySelectorAll('[data-bewerk]').forEach(k => k.addEventListener('click',
    () => openBewerkVenster(opDatum[Number(k.dataset.bewerk)], o)));

  laag.querySelector('#pm-open-gegevens')?.addEventListener('click', () => {
    const d = laag.querySelector('#pm-gegevens'); d.open = true; d.scrollIntoView({ block: 'start', behavior: 'smooth' });
    laag.querySelector('#pm-g-zoeksleutel')?.focus({ preventScroll: true });
  });
  if (metGegevens) setTimeout(() => laag.querySelector('#pm-g-zoeksleutel')?.focus({ preventScroll: true }), 0);

  laag.querySelector('#pm-g-voegsamen')?.addEventListener('click', async () => {
    const ander = laag.querySelector('#pm-g-samen').value.trim();
    const melding = laag.querySelector('#pm-g-melding');
    if (!ander || norm0(ander) === norm0(naam)) { melding.textContent = 'Kies een andere naam om samen te voegen.'; return; }
    if (!window.confirm(`"${ander}" wordt dezelfde partij als "${naam}". De boekingen blijven staan zoals ze zijn; alleen de lijst telt ze samen. Doorgaan?`)) return;
    melding.textContent = 'Bezig met samenvoegen…';
    const rel = relatieVanPartij(naam, fs, boekingen) || await zorgRelatieVoorNaam(naam);
    if (!rel) { melding.textContent = 'Samenvoegen mislukt (verbinding?).'; return; }
    const andere = vindRelatieOpNaam(ander);
    const ok = andere && andere.id !== rel.id ? await voegRelatiesSamen(rel.id, andere.id) : await voegNaamToeAlsAlias(rel.id, ander);
    if (!ok) { melding.textContent = 'Samenvoegen mislukt (verbinding?).'; return; }
    melding.textContent = 'Samengevoegd.';
    o.herteken?.();
    laag.querySelector('[data-pm-sluit]')?.click();
  });

  laag.querySelector('#pm-g-opslaan')?.addEventListener('click', async () => {
    const w = id => laag.querySelector('#pm-g-' + id)?.value ?? '';
    const melding = laag.querySelector('#pm-g-melding'), knop = laag.querySelector('#pm-g-opslaan');
    knop.disabled = true; melding.textContent = 'Bezig met opslaan…';
    const soort = factuurSoortVan(o);
    const rel = relatieVanPartij(naam, fs, boekingen) || await zorgRelatieVoorNaam(naam);
    if (!rel) { melding.textContent = 'Opslaan mislukt: de relatie kon niet worden aangemaakt (verbinding?).'; knop.disabled = false; return; }
    const ok = await bewaarRelatieGegevens(rel.id, {
      zoeksleutel: w('zoeksleutel'), bedrijfsnaam: w('bedrijfsnaam'), kvkNummer: w('kvk'), btwNummer: w('btw'),
      btwPlichtig: w('plichtig'), adres: w('adres'), postcodePlaats: w('plaats'), email: w('email'),
      telefoon: w('telefoon'), iban: w('iban'), termijn: w('termijn'), notitie: w('notitie')
    });
    if (!ok) { melding.textContent = 'Opslaan mislukt (verbinding?). Probeer het opnieuw.'; knop.disabled = false; return; }
    const nieuwNr = await zorgRelatienummer(rel.id, soort);
    laag.querySelector('#pm-g-nr').textContent = nieuwNr ? `${soort}nummer ${nieuwNr}` : 'nog geen nummer';
    laag.querySelector('#pm-nr-kop').textContent = nieuwNr ? nieuwNr + ' · ' : '';
    melding.textContent = 'Opgeslagen.'; knop.disabled = false;
    o.herteken?.();
  });

  laag.querySelectorAll('[data-verwijder]').forEach(k => k.addEventListener('click',
    () => verwijderBoeking(opDatum[Number(k.dataset.verwijder)], o)));
}

function openBewerkVenster(boeking, o) {
  const { laag, sluit } = toonVenster('pm-bewerk', `
    <header class="pm-kop">
      <h3>Boeking bewerken</h3>
      <button type="button" class="pm-kruis" data-pm-sluit aria-label="Sluiten">&times;</button>
    </header>
    <div class="pm-inhoud">
      <div class="pm-velden">
        <label>Datum<input type="date" id="pm-datum" value="${veilig(boeking.datum || '')}"></label>
        <label>Bedrag (&euro;)<input type="number" step="0.01" id="pm-bedrag" value="${Number(boeking.bedrag) || 0}"></label>
        <label>Grootboek<input type="text" id="pm-gb" value="${veilig(boeking.gb || '')}"></label>
        <label>Rekening<input type="text" id="pm-rek" value="${veilig(boeking.rek || '')}"></label>
        <label class="pm-breed">Naam / partij<input type="text" id="pm-naam" value="${veilig(boeking.naam || '')}"></label>
        <label class="pm-breed">Omschrijving<input type="text" id="pm-omschr" value="${veilig(boeking.omschr || '')}"></label>
      </div>
    </div>
    <footer class="pm-voet">
      <span class="pm-hint">Esc annuleert</span>
      <div class="pm-knoppen">
        <button type="button" class="btn" data-pm-sluit>Annuleren</button>
        <button type="button" class="btn btn-primary" id="pm-opslaan">Opslaan</button>
      </div>
    </footer>`);

  const waarde = id => laag.querySelector('#' + id)?.value ?? '';

  laag.querySelector('#pm-opslaan').addEventListener('click', async () => {
    const gewijzigd = {
      ...boeking,
      datum: waarde('pm-datum') || boeking.datum,
      bedrag: Number(waarde('pm-bedrag')) || 0,
      naam: waarde('pm-naam'),
      omschr: waarde('pm-omschr'),
      gb: waarde('pm-gb'),
      rek: waarde('pm-rek')
    };

    // Op id zoeken, niet op de index uit de gefilterde schermlijst: die index
    // hoort bij het scherm en niet bij state.TX, dus daarmee zou je een heel
    // andere boeking overschrijven.
    const hist = isHistorisch(boeking);
    const bron = hist ? state.HIST_TX : state.TX;
    const pos = (bron || []).findIndex(t => String(t.id) === String(boeking.id));
    if (pos === -1) { alert('Boeking niet meer gevonden.'); sluit(); return; }

    bron[pos] = gewijzigd;
    hist ? saveHistTxData() : saveTxData();

    try {
      const ok = await saveToSupabase(gewijzigd, hist);
      if (!ok) addToPendingQueue(gewijzigd, 'update', hist);
    } catch (err) {
      console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
      addToPendingQueue(gewijzigd, 'update', hist);
    }

    sluit();
    o.herteken();
  });

  laag.querySelector('#pm-datum')?.focus();
}

async function verwijderBoeking(boeking, o) {
  const regel = `${boeking.datum} — ${fmt(boeking.bedrag)} — ${boeking.naam || '(geen naam)'}`;

  // Een boeking waar een factuur naar verwijst blijft anders "betaald" tonen
  // terwijl de onderliggende betaling niet meer bestaat — dus eerst
  // waarschuwen, en bij doorzetten de koppeling netjes losmaken.
  const gekoppeld = facturenBijBoeking(boeking.id);
  const koppelTekst = gekoppeld.length
    ? `\n\nLet op: gekoppeld aan ${gekoppeld.length > 1 ? 'de facturen' : 'de factuur'} ` +
      gekoppeld.map(f => `${f.factuurnummer || f.id} (${fmt(f.bedrag)})`).join(', ') +
      `. Bij verwijderen wordt die koppeling losgemaakt en komt ${gekoppeld.length > 1 ? 'ze' : 'die'} weer op "openstaand" te staan.`
    : '';

  if (!confirm(`Deze boeking verwijderen?\n\n${regel}${koppelTekst}`)) return;

  ontkoppelAlleFacturenVanBoeking(boeking.id);

  const hist = isHistorisch(boeking);
  if (hist) {
    state.HIST_TX = (state.HIST_TX || []).filter(t => String(t.id) !== String(boeking.id));
    saveHistTxData();
  } else {
    state.TX = (state.TX || []).filter(t => String(t.id) !== String(boeking.id));
    saveTxData();
  }

  try {
    const ok = await deleteFromSupabase(boeking.id, 'boeking');
    if (!ok) addToPendingQueue(boeking, 'delete', hist, 'boeking');
  } catch (err) {
    console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
    addToPendingQueue(boeking, 'delete', hist, 'boeking');
  }

  sluitHuidige?.();
  o.herteken();
}
