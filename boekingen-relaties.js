// boekingen-relaties.js — fase 4b van de facturenmodule: bestaande boekingen
// aan relaties (fase 4a) koppelen.
//
// Twee onafhankelijke voorstel-tiers, allebei puur lezend totdat een cluster
// expliciet wordt bevestigd:
//   - fase 4b-1 ("zeker"): boekingen waarvan `naam` letterlijk dezelfde IBAN
//     is.
//   - fase 4b-2 ("minder zeker"): relatieSleutel() (facturen.js) plus een
//     tweede, lossere ronde die sleutels samenvoegt als de ene als los woord
//     in de andere voorkomt (bijv. "postnl" in "koninklijke postnl") — met
//     een generieke-woordenfilter, zodat bijv. "Inkopen" niet aan "Joybuy
//     inkopen" wordt geplakt puur omdat ze toevallig hetzelfde Nederlandse
//     boekhoudwoord delen. Onderzocht en op de echte 619 boekingen getoetst
//     vóór de bouw hiervan.
//
// Beide berekenen alleen suggesties (puur lezend, state.TX/HIST_TX worden
// hier nooit aangepast) en voeren pas een schrijfactie uit als de aanroeper
// een expliciet bevestigd cluster met zijn precieze boekingen-lijst
// aanlevert. Bevestigen herzoekt nooit live — dat zou ook boekingen kunnen
// raken die niet in het cluster zaten dat de gebruiker heeft gezien.

import { state, saveTxData, saveHistTxData, save, load } from './storage.js?v=20261023h';
import { isIban } from './helpers.js?v=20261023h';
import { relatieSleutel } from './facturen.js?v=20261023h';
import { saveToSupabase, addToPendingQueue } from './supabase-client-v2.js?v=20261023h';

// ───────────────────────────────────────── afgewezen clusters (lokaal, per IBAN)
// Puur een "vraag me hier niet nog eens naar"-voorkeur, geen boekingdata zelf
// — dat mag prima alleen lokaal blijven, net als bijv. een klapstatus in de
// UI. Er wordt hierdoor nooit een boeking gewijzigd, alleen een suggestie
// onderdrukt.
state.AFGEWEZEN_IBAN_CLUSTERS = load('xtenate_afgewezen_iban_clusters', []);

function saveAfgewezenIbanClusters() {
  save('xtenate_afgewezen_iban_clusters', state.AFGEWEZEN_IBAN_CLUSTERS);
}

export function isIbanClusterAfgewezen(iban) {
  return state.AFGEWEZEN_IBAN_CLUSTERS.includes(iban);
}

export function afwijsIbanCluster(iban) {
  if (!state.AFGEWEZEN_IBAN_CLUSTERS.includes(iban)) {
    state.AFGEWEZEN_IBAN_CLUSTERS.push(iban);
    saveAfgewezenIbanClusters();
  }
}

/** Haalt een eerder afgewezen cluster weer naar voren, voor als je van
 *  gedachten verandert. Wijzigt nog steeds geen enkele boeking. */
export function herstelIbanCluster(iban) {
  state.AFGEWEZEN_IBAN_CLUSTERS = state.AFGEWEZEN_IBAN_CLUSTERS.filter(x => x !== iban);
  saveAfgewezenIbanClusters();
}

export function afgewezenIbanClusters() {
  return [...state.AFGEWEZEN_IBAN_CLUSTERS];
}

// ───────────────────────────────────────────────────── clusters berekenen

/**
 * Puur lezend: groepeert boekingen waarvan `naam` exact dezelfde IBAN is
 * (hoofdletterongevoelig vergeleken, IBAN's horen toch al in hoofdletters te
 * staan). Boekingen die al een relatieId hebben, of waarvan het cluster al
 * is afgewezen, worden overgeslagen — die hebben geen voorstel meer nodig.
 *
 * @returns {Array<{iban:string, boekingen:Array, aantal:number, totaal:number,
 *                   vanDatum:string, totDatum:string}>} gesorteerd op aantal, aflopend
 */
export function berekenIbanClusters() {
  const alles = [
    ...(state.TX || []).map(b => ({ ...b, _hist: false })),
    ...(state.HIST_TX || []).map(b => ({ ...b, _hist: true }))
  ];

  const groepen = new Map();
  for (const b of alles) {
    if (b.relatieId) continue;
    const naam = String(b.naam || '').trim();
    if (!isIban(naam)) continue;
    const sleutel = naam.toUpperCase();
    if (!groepen.has(sleutel)) groepen.set(sleutel, []);
    groepen.get(sleutel).push(b);
  }

  const clusters = [];
  for (const [iban, boekingen] of groepen) {
    if (isIbanClusterAfgewezen(iban)) continue;
    const gesorteerd = [...boekingen].sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
    clusters.push({
      iban,
      boekingen: gesorteerd,
      aantal: gesorteerd.length,
      totaal: gesorteerd.reduce((s, b) => s + (Number(b.bedrag) || 0), 0),
      vanDatum: gesorteerd[0]?.datum || '',
      totDatum: gesorteerd[gesorteerd.length - 1]?.datum || ''
    });
  }

  clusters.sort((a, b) => b.aantal - a.aantal);
  return clusters;
}

// ───────────────────────────────────────────────────────── cluster bevestigen

/**
 * Zet relatieId op precies de meegegeven boekingen — nooit een live
 * herzoeken op IBAN. `boekingRefs` moet een array van boekingsobjecten zijn
 * met minstens {id, _hist}, exact zoals ze in het scherm zijn getoond (na een
 * eventuele Aanpassen-uitsluiting). Raakt uitsluitend deze boekingen: geen
 * andere boeking, ook niet één met toevallig dezelfde IBAN in een ander,
 * nog niet-bevestigd cluster.
 *
 * @returns {{ok:boolean, aantalBijgewerkt:number}}
 */
export async function bevestigIbanCluster(boekingRefs, relatieId) {
  if (!relatieId || !Array.isArray(boekingRefs) || !boekingRefs.length) {
    return { ok: false, aantalBijgewerkt: 0 };
  }

  let txGeraakt = false, histGeraakt = false, aantalBijgewerkt = 0;

  for (const ref of boekingRefs) {
    const hist = !!ref._hist;
    const bron = hist ? state.HIST_TX : state.TX;
    const pos = (bron || []).findIndex(t => String(t.id) === String(ref.id));
    if (pos === -1) continue; // ondertussen elders verwijderd: overslaan, niet vastlopen

    bron[pos] = { ...bron[pos], relatieId };
    hist ? (histGeraakt = true) : (txGeraakt = true);
    aantalBijgewerkt++;

    try {
      const ok = await saveToSupabase(bron[pos], hist);
      if (!ok) addToPendingQueue(bron[pos], 'update', hist);
    } catch (err) {
      console.warn('Supabase niet bereikbaar bij koppelen relatie, in wachtrij gezet:', err);
      addToPendingQueue(bron[pos], 'update', hist);
    }
  }

  if (txGeraakt) saveTxData();
  if (histGeraakt) saveHistTxData();

  return { ok: aantalBijgewerkt > 0, aantalBijgewerkt };
}

/** Zelfde schrijfpad als hierboven — er zit niets IBAN-specifieks in de
 *  logica van bevestigIbanCluster() zelf (die kent alleen boekingRefs +
 *  relatieId), dus fase 4b-2 hergebruikt hem rechtstreeks in plaats van een
 *  tweede schrijffunctie te krijgen. */
export const bevestigCluster = bevestigIbanCluster;

// ═══════════════════════════════════════════════════════ fase 4b-2: tekst

// ───────────────────────────────────── afgewezen clusters (lokaal, per cluster-id)
// Zelfde soort lokale "niet meer voorstellen"-voorkeur als bij de IBAN-
// clusters, in een eigen sleutel omdat het hier om een andere soort
// clusters gaat. De id is de gesorteerde, samengevoegde lijst van
// relatieSleutel()-waarden in het cluster — stabiel, ongeacht welke sleutel
// toevallig als "root" uit het samenvoeg-algoritme rolt.
state.AFGEWEZEN_TEKST_CLUSTERS = load('xtenate_afgewezen_tekst_clusters', []);

function saveAfgewezenTekstClusters() {
  save('xtenate_afgewezen_tekst_clusters', state.AFGEWEZEN_TEKST_CLUSTERS);
}

export function isTekstClusterAfgewezen(id) {
  return state.AFGEWEZEN_TEKST_CLUSTERS.includes(id);
}

export function afwijsTekstCluster(id) {
  if (!state.AFGEWEZEN_TEKST_CLUSTERS.includes(id)) {
    state.AFGEWEZEN_TEKST_CLUSTERS.push(id);
    saveAfgewezenTekstClusters();
  }
}

export function herstelTekstCluster(id) {
  state.AFGEWEZEN_TEKST_CLUSTERS = state.AFGEWEZEN_TEKST_CLUSTERS.filter(x => x !== id);
  saveAfgewezenTekstClusters();
}

export function afgewezenTekstClusters() {
  return [...state.AFGEWEZEN_TEKST_CLUSTERS];
}

// ── generieke, niet-onderscheidende boekhoudwoorden ──
// Een match die uitsluitend op zo'n woord berust, zegt niets over een
// gedeelde tegenpartij — "Inkopen" en "Joybuy inkopen" delen alleen het
// woord "inkopen", niet een naam. Onderzocht en getoetst op de echte 619
// boekingen vóór de bouw: met dit filter verdwijnt precies díe ene foute
// samenvoeging, en blijven alle tien andere (HNVI, PostNL, Alipay,
// Marktplaats, Shopify, Vimexx, Google, Bol.com, Stripe, Verpakking
// Voordeel, PayPal) ongewijzigd staan.
const STOPWOORDEN = new Set([
  'inkopen', 'inkoop', 'aankoop', 'aankopen',
  'kosten', 'kost',
  'betaling', 'betalingen',
  'factuur', 'facturen',
  'verkoop', 'verkopen',
  'omzet',
  'dienst', 'diensten',
  'overig', 'overige', 'diversen', 'divers', 'algemeen',
  'verzending', 'verzendkosten',
  'bank', 'bankkosten'
]);

/** True als élk woord in `sleutel` een stopwoord is — de sleutel bevat dan
 *  op zichzelf niets onderscheidends en mag nooit de reden zijn dat twee
 *  andere sleutels worden samengevoegd. */
function isGeneriekeSleutel(sleutel) {
  const woorden = sleutel.split(' ').filter(Boolean);
  return woorden.length > 0 && woorden.every(w => STOPWOORDEN.has(w));
}

/** True als `kort` als aaneengesloten woordenreeks in `lang` voorkomt, op
 *  woordgrenzen — dus geen kale tekst-substring ("cas" matcht bijv. nooit
 *  in "cascade"). relatieSleutel() laat alleen a-z/0-9/spaties over, dus er
 *  zitten hier nooit regex-tekens in die ontsnapt zouden moeten worden. */
function woordgrensBevat(kort, lang) {
  if (!kort || kort === lang) return false;
  return new RegExp(`(?:^|\\s)${kort}(?:$|\\s)`).test(lang);
}

/**
 * Puur lezend, zelfde garanties als berekenIbanClusters(): groepeert eerst
 * exact op relatieSleutel() (identiek aan wat facturen.js al doet), en voegt
 * daarna sleutel-groepen samen als één sleutel als los woord in een andere
 * voorkomt — met het generieke-woordenfilter hierboven. Alleen groepen die
 * daadwerkelijk twee of meer verschillende relatieSleutel()-waarden
 * combineren worden getoond; een sleutel die niets extra's oplevert, hoort
 * niet in dit "minder zeker"-tier.
 *
 * IBAN-namen en boekingen die al een relatieId hebben, worden overgeslagen
 * — die zijn het domein van fase 4b-1, of zijn al gekoppeld.
 *
 * @returns {Array<{id:string, sleutels:string[], matchwoord:string,
 *                   boekingen:Array, aantal:number, totaal:number,
 *                   vanDatum:string, totDatum:string}>} gesorteerd op aantal, aflopend
 */
export function berekenTekstClusters() {
  const alles = [
    ...(state.TX || []).map(b => ({ ...b, _hist: false })),
    ...(state.HIST_TX || []).map(b => ({ ...b, _hist: true }))
  ];

  const perSleutel = new Map();
  for (const b of alles) {
    if (b.relatieId) continue;
    const naam = String(b.naam || '').trim();
    if (!naam || isIban(naam)) continue;
    const sleutel = relatieSleutel(naam);
    if (!sleutel) continue;
    if (!perSleutel.has(sleutel)) perSleutel.set(sleutel, []);
    perSleutel.get(sleutel).push(b);
  }

  const sleutels = [...perSleutel.keys()];

  // Union-Find: welke sleutel-groepen horen, na de losse ronde, bij elkaar.
  const ouder = new Map(sleutels.map(s => [s, s]));
  const vind = x => {
    while (ouder.get(x) !== x) { ouder.set(x, ouder.get(ouder.get(x))); x = ouder.get(x); }
    return x;
  };
  const voegSamen = (a, b) => {
    const ra = vind(a), rb = vind(b);
    if (ra !== rb) ouder.set(rb, ra);
  };

  // Per sleutel de niet-generieke woorden die tot een samenvoeging hebben
  // geleid — voor de "gevonden op"-weergave per cluster.
  const triggerwoorden = new Map(sleutels.map(s => [s, new Set()]));

  for (let i = 0; i < sleutels.length; i++) {
    for (let j = i + 1; j < sleutels.length; j++) {
      const a = sleutels[i], b = sleutels[j];
      const [kort, lang] = a.length <= b.length ? [a, b] : [b, a];
      if (!woordgrensBevat(kort, lang) || isGeneriekeSleutel(kort)) continue;
      voegSamen(a, b);
      triggerwoorden.get(a).add(kort);
      triggerwoorden.get(b).add(kort);
    }
  }

  const groepen = new Map();
  for (const s of sleutels) {
    const r = vind(s);
    if (!groepen.has(r)) groepen.set(r, []);
    groepen.get(r).push(s);
  }

  const clusters = [];
  for (const sls of groepen.values()) {
    if (sls.length < 2) continue; // geen extra samenvoeging -> hoort hier niet thuis

    const id = [...sls].sort().join('|');
    if (isTekstClusterAfgewezen(id)) continue;

    const woorden = new Set();
    for (const s of sls) for (const w of triggerwoorden.get(s)) woorden.add(w);
    const matchwoord = [...woorden].sort((a, b) => a.length - b.length)[0] || sls[0];

    const boekingen = sls.flatMap(s => perSleutel.get(s));
    const gesorteerd = [...boekingen].sort((a, b) => String(a.datum).localeCompare(String(b.datum)));

    clusters.push({
      id,
      sleutels: [...sls],
      matchwoord,
      boekingen: gesorteerd,
      aantal: gesorteerd.length,
      totaal: gesorteerd.reduce((s, b) => s + (Number(b.bedrag) || 0), 0),
      vanDatum: gesorteerd[0]?.datum || '',
      totDatum: gesorteerd[gesorteerd.length - 1]?.datum || ''
    });
  }

  clusters.sort((a, b) => b.aantal - a.aantal);
  return clusters;
}
