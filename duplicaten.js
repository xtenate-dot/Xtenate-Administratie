// duplicaten.js — herkennen van mogelijk dubbele boekingen.
//
// Een gelijk bedrag zegt op zichzelf weinig: PostNL schrijft € 5,95 op 29
// verschillende dagen af, en twee pakketten op één dag is doodnormaal. Daarom
// wordt er op meerdere kenmerken tegelijk gewogen, met een score die ook aan de
// gebruiker wordt getoond, en worden terugkerende tarieven overgeslagen.

import { weergaveNaam } from './helpers.js?v=20261025f';

/** Minimale score waarbij we een paar als verdacht beschouwen. */
export const DREMPEL = 85;

/** Boekingen verder dan dit aantal dagen uit elkaar zijn geen dubbele import. */
const MAX_DAGEN = 7;

/** Vanaf zoveel losse datums beschouwen we een bedrag als vast tarief. */
const TARIEF_DATUMS = 3;

/**
 * Een tegenpartij waarmee je op zoveel losse dagen zaken doet, is een vaste
 * leverancier of een verkoopkanaal. Twee identieke afschrijvingen op één dag
 * horen daar bij de normale gang van zaken — twee pakketten, twee bestellingen,
 * twee verkopen — en zijn geen teken van een dubbele import.
 */
const VASTE_PARTIJ_DATUMS = 10;

function normaliseer(tekst) {
  return String(tekst || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(b\.?v\.?|n\.?v\.?|ltd|limited|sa|s\.a|gmbh|inc|koninklijke)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein-afstand, begrensd zodat lange omschrijvingen niet ontsporen. */
function afstand(a, b) {
  a = a.slice(0, 60); b = b.slice(0, 60);
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let vorige = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const huidige = [i];
    for (let j = 1; j <= b.length; j++) {
      huidige[j] = Math.min(
        vorige[j] + 1,
        huidige[j - 1] + 1,
        vorige[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    vorige = huidige;
  }
  return vorige[b.length];
}

/** 0 tot 1: hoe sterk lijken twee omschrijvingen op elkaar. */
export function gelijkenis(a, b) {
  const x = normaliseer(a), y = normaliseer(b);
  if (!x && !y) return 0;
  if (x === y) return 1;
  const langste = Math.max(x.length, y.length);
  return langste ? Math.max(0, 1 - afstand(x, y) / langste) : 0;
}

const dagen = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/** De tekst waarop we een boeking herkennen: naam, anders de omschrijving. */
const noemer = t => weergaveNaam(t) || t.omschr || '';

/**
 * Welke combinaties van tegenpartij en bedrag zijn een vast tarief? Dat zijn de
 * bedragen die bij dezelfde partij op veel verschillende dagen terugkomen —
 * verzendkosten, abonnementen. Twee daarvan op één dag is geen dubbele boeking.
 */
function patronen(alleBoekingen) {
  const perCombinatie = new Map();
  const perPartij = new Map();

  alleBoekingen.forEach(t => {
    const partij = normaliseer(noemer(t));
    const combinatie = `${partij}|${t.bedrag}`;
    if (!perCombinatie.has(combinatie)) perCombinatie.set(combinatie, new Set());
    perCombinatie.get(combinatie).add(t.datum);
    if (!perPartij.has(partij)) perPartij.set(partij, new Set());
    perPartij.get(partij).add(t.datum);
  });

  const tarieven = new Set();
  perCombinatie.forEach((datums, sleutel) => { if (datums.size >= TARIEF_DATUMS) tarieven.add(sleutel); });

  const vastePartijen = new Set();
  perPartij.forEach((datums, partij) => { if (partij && datums.size >= VASTE_PARTIJ_DATUMS) vastePartijen.add(partij); });

  return { tarieven, vastePartijen };
}

/** Weegt één paar boekingen en legt uit waarom. */
function beoordeel(a, b) {
  const redenen = [];
  // Bedrag, rekening en richting zijn voorwaarde; zonder die drie is er niets
  // om over te praten.
  let score = 40;
  redenen.push('zelfde bedrag, rekening en richting');

  const lijkt = gelijkenis(noemer(a), noemer(b));
  const beideLeeg = !normaliseer(noemer(a)) && !normaliseer(noemer(b));
  if (beideLeeg) {
    score += 10;
    redenen.push('geen van beide heeft een omschrijving');
  } else {
    score += Math.round(lijkt * 30);
    if (lijkt === 1) redenen.push('identieke omschrijving');
    else if (lijkt >= 0.8) redenen.push('vrijwel gelijke omschrijving');
    else if (lijkt >= 0.6) redenen.push('sterk gelijkende omschrijving');
  }

  const verschil = dagen(a.datum, b.datum);
  if (verschil === 0) { score += 25; redenen.push('zelfde datum'); }
  else if (verschil <= 3) { score += 15; redenen.push(`${verschil} dag${verschil === 1 ? '' : 'en'} ertussen`); }
  else { score += 8; redenen.push(`${verschil} dagen ertussen`); }

  if (a.gb === b.gb) { score += 5; redenen.push('zelfde grootboekrekening'); }

  return { score: Math.min(100, score), redenen, gelijkenis: lijkt };
}

/**
 * Zoekt paren die waarschijnlijk een dubbele boeking zijn.
 * Levert per gevonden paar het tweede exemplaar met de score en de reden.
 */
export function vindDuplicaten(boekingen) {
  const { tarieven, vastePartijen } = patronen(boekingen);
  const groepen = new Map();

  // Alleen boekingen met hetzelfde bedrag, dezelfde rekening en dezelfde
  // richting kunnen elkaars duplicaat zijn.
  boekingen.forEach(t => {
    if (!(Number(t.bedrag) > 0)) return;
    const sleutel = `${t.bedrag}|${t.rek}|${t.type}`;
    if (!groepen.has(sleutel)) groepen.set(sleutel, []);
    groepen.get(sleutel).push(t);
  });

  const gevonden = [];
  const alGemeld = new Set();

  groepen.forEach(groep => {
    if (groep.length < 2) return;
    const opDatum = [...groep].sort((a, b) => a.datum.localeCompare(b.datum));
    for (let i = 0; i < opDatum.length; i++) {
      for (let j = i + 1; j < opDatum.length; j++) {
        const a = opDatum[i], b = opDatum[j];
        const verschil = dagen(a.datum, b.datum);
        if (isNaN(verschil)) continue;
        if (verschil > MAX_DAGEN) break; // gesorteerd, dus verder kijken heeft geen zin

        const partij = normaliseer(noemer(a));
        // Terugkerend tarief bij dezelfde partij: normale bedrijfsvoering.
        if (tarieven.has(`${partij}|${a.bedrag}`)) continue;
        // Vaste leverancier of verkoopkanaal: herhaling hoort bij het werk.
        if (vastePartijen.has(partij)) continue;

        const oordeel = beoordeel(a, b);
        if (oordeel.score < DREMPEL) continue;
        if (alGemeld.has(String(b.id))) continue;

        alGemeld.add(String(b.id));
        gevonden.push({ origineel: a, duplicaat: b, ...oordeel });
      }
    }
  });

  return gevonden.sort((x, y) => y.score - x.score);
}
