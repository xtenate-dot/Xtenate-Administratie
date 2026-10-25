// jaren.js — dé plek die bepaalt welk jaar wat is. Eerder stond "2026" op tientallen
// plekken vast in de code; op 1 januari 2027 zouden nieuwe boekingen dan als 2026
// zijn geteld. Alles wat een jaar nodig heeft, vraagt het nu hier.
//
// Hoe de opslag werkt (en blijft werken, ook in de cloud):
//   state.TX       alle boekingen vanaf EERSTE_TX_JAAR (nu 2026, straks ook 2027, ...)
//                  In Supabase: archief_jaar = NULL.
//   state.HIST_TX  alle boekingen van vóór EERSTE_TX_JAAR (2022 t/m 2025).
//                  In Supabase: archief_jaar = het jaar.
// Een jaar opvragen gaat altijd op de DATUM van de boeking, niet op de groep waarin
// hij zit. Zo verdwijnt er niets als een boeking toevallig in de "verkeerde" groep staat.

import { state } from './storage.js?v=20261024n';
import { BEGINSALDO_2026, saldoDelta } from './helpers.js?v=20261024n';

/** Eerste jaar dat in state.TX staat. Eerdere jaren staan in state.HIST_TX. */
export const EERSTE_TX_JAAR = '2026';

/** Het kalenderjaar van vandaag. Tests kunnen dit overschrijven met zetVandaag(). */
let vandaagOverschrijf = null;
export function zetVandaag(iso) { vandaagOverschrijf = iso || null; }
export function vandaagIso() { return vandaagOverschrijf || new Date().toISOString().slice(0, 10); }

/** Het lopende boekjaar: het kalenderjaar, maar nooit eerder dan het eerste TX-jaar. */
export function lopendJaar() {
  const j = vandaagIso().slice(0, 4);
  return j < EERSTE_TX_JAAR ? EERSTE_TX_JAAR : j;
}

/** Hoort dit jaar bij de "huidige" groep (state.TX)? Alleen echte jaartallen, niet 'all'. */
export const isTxJaar = jaar => /^\d{4}$/.test(String(jaar)) && String(jaar) >= EERSTE_TX_JAAR;

/** Alle boekingen van één jaar, of van alle jaren ('all'), op datum. */
export function txVanJaar(jaar) {
  if (!jaar || jaar === 'all') return [...state.HIST_TX, ...state.TX];
  const j = String(jaar);
  return [...state.HIST_TX, ...state.TX].filter(t => String(t.datum).startsWith(j));
}

/** Alle jaren waarvoor er boekingen zijn, plus het lopende jaar. Nieuwste eerst. */
export function jarenMetBoekingen() {
  const s = new Set([lopendJaar()]);
  for (const t of [...state.HIST_TX, ...state.TX]) {
    const j = String(t.datum).slice(0, 4);
    if (/^\d{4}$/.test(j)) s.add(j);
  }
  return [...s].sort().reverse();
}

/** De bankrekening waarop BEGINSALDO_2026 staat. */
export const HOOFDREKENING = '1010';

/**
 * Berekend saldo van de hoofdrekening aan het eind van een dag: het beginsaldo
 * van 1 januari 2026 plus alle boekingen tot en met die dag. Dit is hetzelfde
 * rekenwerk als "Bank · nu" op het overzicht. Zonder einddatum: nu.
 */
export function banksaldoTot(einddatum = null) {
  return state.TX
    .filter(t => t.rek === HOOFDREKENING && (!einddatum || String(t.datum) <= einddatum))
    .reduce((s, t) => s + saldoDelta(t), BEGINSALDO_2026);
}

/** Laatste dag van een maand ("2027-02" -> "2027-02-28"). */
export function maandEinde(maand) {
  const d = new Date(maand + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** Begin- en eindsaldo van een maand, berekend uit de boekingen (alleen vanaf het eerste TX-jaar). */
export function berekendMaandSaldo(maand) {
  if (maand < EERSTE_TX_JAAR) return null;
  const dagErvoor = new Date(maand + '-01T00:00:00Z');
  dagErvoor.setUTCDate(0);
  return { begin: banksaldoTot(dagErvoor.toISOString().slice(0, 10)), eind: banksaldoTot(maandEinde(maand)) };
}

/** Het jaar van een datum ("2027-03-04" -> "2027"). */
export const jaarVan = datum => String(datum || '').slice(0, 4);
