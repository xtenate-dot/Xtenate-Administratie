// facturen.js — gedeelde logica voor Debiteuren en Crediteuren.
//
// Ontwerpuitgangspunt (fase 7): facturen staan NAAST de boekingen, niet erin.
// De administratie blijft kasstelsel; een factuur is een administratieve laag
// die naar een betaling kan verwijzen. Een boeking blijft zelfstandig geldig
// zonder factuur, en facturen tellen niet mee in de fiscale berekening.
//
// Deze module bevat geen interface. De schermen komen in stap 3 en 4.

import { FACTUUR_INSTELLINGEN, saveFacturen, state } from './storage.js?v=20261023c';

export const SOORTEN = ['debiteur', 'crediteur'];

/** Statussen zoals ze worden OPGESLAGEN. 'vervallen' hoort hier bewust niet bij. */
export const STATUSSEN = ['open', 'betaald', 'oninbaar'];

// ─── Datum-hulp ────────────────────────────────────────────────────────────
// Alles in ISO (YYYY-MM-DD), net als de boekingen. Geen Date-objecten in de
// opslag: tekstvergelijking op ISO-datums is exact en tijdzone-onafhankelijk.

export function vandaagISO() {
  return new Date().toISOString().split('T')[0];
}

/** Telt hele dagen bij een ISO-datum op. Geeft weer een ISO-datum terug. */
export function plusDagen(iso, dagen) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return iso;
  d.setUTCDate(d.getUTCDate() + Number(dagen || 0));
  return d.toISOString().split('T')[0];
}

/** Aantal dagen tussen twee ISO-datums (b - a). Negatief als b vóór a ligt. */
export function dagenTussen(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}

// ─── Aanmaken ──────────────────────────────────────────────────────────────

/** Standaard betaaltermijn voor een soort, uit de instellingen. */
export function standaardTermijn(soort) {
  return soort === 'crediteur'
    ? FACTUUR_INSTELLINGEN.betaaltermijnCrediteur
    : FACTUUR_INSTELLINGEN.betaaltermijnDebiteur;
}

/**
 * Bouwt een factuur-object. Schrijft niets weg; dat doet voegFactuurToe().
 * Het id-patroon volgt de historische boekingen: f + jaar + volgnummer.
 */
export function maakFactuur(gegevens = {}) {
  const datum = gegevens.datum || vandaagISO();
  const soort = SOORTEN.includes(gegevens.soort) ? gegevens.soort : 'debiteur';
  const jaar = datum.slice(0, 4);
  const volgnr = String(state.nxtFactuur).padStart(3, '0');

  return {
    id: gegevens.id || `f${jaar}_${volgnr}`,
    soort,
    relatie: (gegevens.relatie || '').trim(),
    // Fase 4a: optioneel, naast het vrije tekstveld hierboven — nooit in
    // plaats daarvan. Een factuur zonder gekozen relatie heeft hier null,
    // precies zoals elke factuur van vóór deze fase.
    relatieId: gegevens.relatieId || null,
    factuurnummer: (gegevens.factuurnummer || '').trim(),
    datum,
    vervaldatum: gegevens.vervaldatum || plusDagen(datum, standaardTermijn(soort)),
    bedrag: Math.abs(Number(gegevens.bedrag) || 0),
    omschrijving: (gegevens.omschrijving || '').trim(),
    status: STATUSSEN.includes(gegevens.status) ? gegevens.status : 'open',
    txIds: Array.isArray(gegevens.txIds) ? [...gegevens.txIds] : [],
    gb: gegevens.gb || '',
    aangemaakt: gegevens.aangemaakt || new Date().toISOString()
  };
}

export function voegFactuurToe(gegevens) {
  const f = maakFactuur(gegevens);
  state.FACTUREN.push(f);
  state.nxtFactuur++;
  saveFacturen();
  return f;
}

export function vindFactuur(id) {
  return state.FACTUREN.find(f => String(f.id) === String(id)) || null;
}

export function werkFactuurBij(id, wijzigingen) {
  const f = vindFactuur(id);
  if (!f) return null;
  Object.assign(f, wijzigingen);
  if (f.bedrag != null) f.bedrag = Math.abs(Number(f.bedrag) || 0);
  saveFacturen();
  return f;
}

export function verwijderFactuur(id) {
  const voor = state.FACTUREN.length;
  state.FACTUREN = state.FACTUREN.filter(f => String(f.id) !== String(id));
  const weg = state.FACTUREN.length < voor;
  if (weg) saveFacturen();
  return weg;
}

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Werkelijke status op een peildatum. 'vervallen' wordt hier berekend en niet
 * opgeslagen, zodat een factuur niet "vergeten kan worden om te vervallen".
 */
export function factuurStatus(f, peildatum = vandaagISO()) {
  if (!f) return 'open';
  if (f.status === 'oninbaar') return 'oninbaar';
  if (isBetaald(f)) return 'betaald';
  if (f.vervaldatum && f.vervaldatum < peildatum) return 'vervallen';
  return 'open';
}

export function isBetaald(f) {
  return !!(f && (f.status === 'betaald' || (Array.isArray(f.txIds) && f.txIds.length > 0)));
}

/** Telt mee in het openstaande saldo? Oninbaar en betaald niet. */
export function isOpenstaand(f, peildatum = vandaagISO()) {
  const s = factuurStatus(f, peildatum);
  return s === 'open' || s === 'vervallen';
}

/** Dagen te laat. 0 als de factuur niet te laat is. */
export function dagenTeLaat(f, peildatum = vandaagISO()) {
  if (!f || !f.vervaldatum || !isOpenstaand(f, peildatum)) return 0;
  const d = dagenTussen(f.vervaldatum, peildatum);
  return d > 0 ? d : 0;
}

/** Vervalt binnenkort? Gebruikt waarschuwDagen uit de instellingen. */
export function vervaltBinnenkort(f, peildatum = vandaagISO()) {
  if (!f || !f.vervaldatum || !isOpenstaand(f, peildatum)) return false;
  const resterend = dagenTussen(peildatum, f.vervaldatum);
  return resterend >= 0 && resterend <= FACTUUR_INSTELLINGEN.waarschuwDagen;
}

// ─── Selecties en totalen ──────────────────────────────────────────────────

export function facturenVan(soort, { jaar = null, status = null, peildatum = vandaagISO() } = {}) {
  return state.FACTUREN
    .filter(f => f.soort === soort)
    .filter(f => !jaar || jaar === 'all' || (f.datum || '').startsWith(String(jaar)))
    .filter(f => !status || factuurStatus(f, peildatum) === status)
    .sort((a, b) => (a.vervaldatum || a.datum).localeCompare(b.vervaldatum || b.datum));
}

export function openstaandSaldo(soort, peildatum = vandaagISO()) {
  return state.FACTUREN
    .filter(f => f.soort === soort && isOpenstaand(f, peildatum))
    .reduce((som, f) => som + (Number(f.bedrag) || 0), 0);
}

/** Ouderdomsgroep op basis van dagen te laat. */
export function ouderdomsgroep(f, peildatum = vandaagISO()) {
  const d = dagenTeLaat(f, peildatum);
  if (d <= 0) return 'niet vervallen';
  if (d <= 30) return '1-30 dagen';
  if (d <= 60) return '31-60 dagen';
  if (d <= 90) return '61-90 dagen';
  return '90+ dagen';
}

export const OUDERDOM_VOLGORDE = ['niet vervallen', '1-30 dagen', '31-60 dagen', '61-90 dagen', '90+ dagen'];

export function ouderdomsanalyse(soort, peildatum = vandaagISO()) {
  const uit = {};
  for (const g of OUDERDOM_VOLGORDE) uit[g] = { aantal: 0, bedrag: 0 };
  for (const f of state.FACTUREN) {
    if (f.soort !== soort || !isOpenstaand(f, peildatum)) continue;
    const g = ouderdomsgroep(f, peildatum);
    uit[g].aantal++;
    uit[g].bedrag += Number(f.bedrag) || 0;
  }
  return uit;
}

// ─── Koppeling met boekingen ───────────────────────────────────────────────
// Een factuur verwijst naar een boeking; de boeking weet niets van de factuur.
// Zo blijft TX/HIST_TX volledig ongewijzigd en werkt alles zonder facturen.

/** Zoekt een boeking in TX of HIST_TX. Verandert er niets aan. */
export function vindBoeking(txId) {
  return state.TX.find(t => String(t.id) === String(txId))
    || state.HIST_TX.find(t => String(t.id) === String(txId))
    || null;
}

export function koppelBetaling(factuurId, txId) {
  const f = vindFactuur(factuurId);
  if (!f) return { ok: false, reden: 'factuur niet gevonden' };
  if (!vindBoeking(txId)) return { ok: false, reden: 'boeking niet gevonden' };
  if (f.txIds.some(id => String(id) === String(txId))) {
    return { ok: false, reden: 'al gekoppeld' };
  }
  f.txIds.push(txId);
  f.status = 'betaald';
  saveFacturen();
  return { ok: true, factuur: f };
}

export function ontkoppelBetaling(factuurId, txId) {
  const f = vindFactuur(factuurId);
  if (!f) return { ok: false, reden: 'factuur niet gevonden' };
  const voor = f.txIds.length;
  f.txIds = f.txIds.filter(id => String(id) !== String(txId));
  if (f.txIds.length === voor) return { ok: false, reden: 'niet gekoppeld' };
  if (f.txIds.length === 0 && f.status === 'betaald') f.status = 'open';
  saveFacturen();
  return { ok: true, factuur: f };
}

/** Welke facturen verwijzen naar deze boeking? Voor de melding bij verwijderen. */
export function facturenBijBoeking(txId) {
  return state.FACTUREN.filter(f => f.txIds.some(id => String(id) === String(txId)));
}

/**
 * Ontkoppelt alle facturen die naar deze boeking verwijzen — bedoeld om vlak
 * vóór het daadwerkelijk verwijderen van een boeking aan te roepen, zodat een
 * factuur nooit een txId overhoudt die niet meer bestaat. Gebruikt de
 * bestaande ontkoppelBetaling(), die een factuur zonder overgebleven
 * koppeling automatisch terugzet naar status 'open'.
 */
export function ontkoppelAlleFacturenVanBoeking(txId) {
  const geraakt = facturenBijBoeking(txId);
  for (const f of geraakt) ontkoppelBetaling(f.id, txId);
  return geraakt;
}

/**
 * Bestaat er al een factuur met dit factuurnummer bij dezelfde relatie (en
 * dezelfde soort)? Een leeg factuurnummer telt nooit als dubbel. Gebruikt
 * dezelfde naamnormalisatie als relatiesMetOpenstaand(), geen eigen
 * vergelijkingslogica. `uitgezonderdId` laat een factuur zichzelf negeren
 * bij het bewerken.
 */
export function factuurnummerInGebruik(soort, relatie, factuurnummer, uitgezonderdId = null) {
  const fn = String(factuurnummer || '').trim();
  if (!fn) return false;
  const sleutel = relatieSleutel(relatie);
  return state.FACTUREN.some(f =>
    String(f.id) !== String(uitgezonderdId) &&
    f.soort === soort &&
    relatieSleutel(f.relatie) === sleutel &&
    String(f.factuurnummer || '').trim().toLowerCase() === fn.toLowerCase());
}

// ─── Relaties (voorlopig afgeleid uit de naam) ─────────────────────────────
// Nog geen aparte entiteit: de naamkwaliteit in de boekingen is daarvoor te
// wisselend (zie weergaveNaam in helpers.js, waar naam soms een IBAN is).

export function relatieSleutel(naam) {
  return String(naam || '')
    .toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|ltd|limited|gmbh|s\.?a\.?|inc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function relatiesMetOpenstaand(soort, peildatum = vandaagISO()) {
  const per = new Map();
  for (const f of state.FACTUREN) {
    if (f.soort !== soort || !isOpenstaand(f, peildatum)) continue;
    const sleutel = relatieSleutel(f.relatie) || '(geen relatie)';
    const huidig = per.get(sleutel) || { naam: f.relatie || '(geen relatie)', aantal: 0, bedrag: 0 };
    huidig.aantal++;
    huidig.bedrag += Number(f.bedrag) || 0;
    per.set(sleutel, huidig);
  }
  return [...per.values()].sort((a, b) => b.bedrag - a.bedrag);
}

// ─── Samenvatting voor de homepagina (stap 5) ──────────────────────────────

export function factuurSamenvatting(peildatum = vandaagISO()) {
  const tel = soort => {
    const open = state.FACTUREN.filter(f => f.soort === soort && isOpenstaand(f, peildatum));
    return {
      aantal: open.length,
      bedrag: open.reduce((s, f) => s + (Number(f.bedrag) || 0), 0),
      teLaat: open.filter(f => dagenTeLaat(f, peildatum) > 0).length,
      binnenkort: open.filter(f => vervaltBinnenkort(f, peildatum)).length
    };
  };
  return { debiteuren: tel('debiteur'), crediteuren: tel('crediteur') };
}
