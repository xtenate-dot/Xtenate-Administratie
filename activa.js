// activa.js — activaregister voor afschrijvingen: gedeelde logica voor de
// pagina Activa.
//
// Kleinste eerste versie: puur vastleggen en het eigen jaaroverzicht zien.
// Nog niet gekoppeld aan de winstberekening in belasting.js of aan een
// bankboeking — dat zijn bewuste, latere stappen, net als bij kilometers.
//
// Let op dubbeltelling: als de aanschaf van een bedrijfsmiddel óók als
// gewone bankboeking op een kostenrekening staat, telt die aanschaf twee
// keer mee — eenmaal volledig via de boeking, en nogmaals gespreid via dit
// register. Dit bestand kan dat niet detecteren (er is geen koppeling met
// boekingen zoals facturen die via txIds hebben); de disclaimer op het
// scherm zelf (activa-ui.js) waarschuwt hiervoor.

import { state, saveActiva } from './storage.js?v=20261024x';

export function vandaagISO() {
  return new Date().toISOString().split('T')[0];
}

/** Bouwt een activum-object. Schrijft niets weg; dat doet voegActivumToe(). */
export function maakActivum(gegevens = {}) {
  const datum = gegevens.aanschafdatum || vandaagISO();
  const jaar = datum.slice(0, 4);
  const volgnr = String(state.nxtActivum).padStart(3, '0');

  return {
    id: gegevens.id || `act${jaar}_${volgnr}`,
    naam: (gegevens.naam || '').trim(),
    aanschafdatum: datum,
    aanschafwaarde: Math.abs(Number(gegevens.aanschafwaarde) || 0),
    restwaarde: Math.max(0, Number(gegevens.restwaarde) || 0),
    gebruiksduurJaren: Math.abs(Number(gegevens.gebruiksduurJaren) || 0),
    aangemaakt: gegevens.aangemaakt || new Date().toISOString()
  };
}

export function voegActivumToe(gegevens) {
  const a = maakActivum(gegevens);
  state.ACTIVA.push(a);
  state.nxtActivum++;
  saveActiva();
  return a;
}

export function vindActivum(id) {
  return state.ACTIVA.find(a => String(a.id) === String(id)) || null;
}

export function werkActivumBij(id, wijzigingen) {
  const a = vindActivum(id);
  if (!a) return null;
  Object.assign(a, wijzigingen);
  if (a.aanschafwaarde != null) a.aanschafwaarde = Math.abs(Number(a.aanschafwaarde) || 0);
  if (a.restwaarde != null) a.restwaarde = Math.max(0, Number(a.restwaarde) || 0);
  if (a.gebruiksduurJaren != null) a.gebruiksduurJaren = Math.abs(Number(a.gebruiksduurJaren) || 0);
  saveActiva();
  return a;
}

export function verwijderActivum(id) {
  const voor = state.ACTIVA.length;
  state.ACTIVA = state.ACTIVA.filter(a => String(a.id) !== String(id));
  const weg = state.ACTIVA.length < voor;
  if (weg) saveActiva();
  return weg;
}

/** Alle activa, oplopend op aanschafdatum — nooit gefilterd op jaar: een
 *  ouder bedrijfsmiddel blijft relevant zolang het nog afschrijft. */
export function activaLijst() {
  return [...state.ACTIVA].sort((a, b) => (a.aanschafdatum || '').localeCompare(b.aanschafdatum || ''));
}

/** Lineaire jaarafschrijving: (aanschafwaarde − restwaarde) / gebruiksduur. */
export function jaarlijkseAfschrijving(activum) {
  const duur = Number(activum?.gebruiksduurJaren) || 0;
  if (!(duur > 0)) return 0;
  const basis = Math.max(0, (Number(activum.aanschafwaarde) || 0) - (Number(activum.restwaarde) || 0));
  return basis / duur;
}

function aanschafMaandJaar(activum) {
  const datum = String(activum?.aanschafdatum || '');
  return { jaar: Number(datum.slice(0, 4)), maand: Number(datum.slice(5, 7)) };
}

/**
 * Cumulatief aantal afgeschreven maanden tot en met het einde van `jaar`.
 * Het eerste jaar telt alleen de maanden vanaf de aanschafmaand (naar rato);
 * de laatste maanden van de looptijd vallen symmetrisch in het laatste jaar,
 * zodat het totaal na de volledige looptijd precies totaalMaanden is —
 * geen cent meer of minder door afronding.
 */
function cumulatieveMaanden(activum, jaar) {
  const { jaar: aanschafJaar, maand: aanschafMaand } = aanschafMaandJaar(activum);
  if (!aanschafJaar || !aanschafMaand) return 0;
  const totaalMaanden = Math.round((Number(activum.gebruiksduurJaren) || 0) * 12);
  if (!(totaalMaanden > 0)) return 0;
  if (jaar < aanschafJaar) return 0;

  const maandenEersteJaar = 13 - aanschafMaand; // aanschaf in juli (7) -> 6 (jul t/m dec)
  if (jaar === aanschafJaar) return Math.min(maandenEersteJaar, totaalMaanden);
  return Math.min(maandenEersteJaar + (jaar - aanschafJaar) * 12, totaalMaanden);
}

/** Afschrijving in precies dit kalenderjaar. 0 vóór het aanschafjaar en ná
 *  volledige afschrijving. */
export function afschrijvingInJaar(activum, jaar) {
  const jaarBedrag = jaarlijkseAfschrijving(activum);
  if (!(jaarBedrag > 0)) return 0;
  const maanden = cumulatieveMaanden(activum, jaar) - cumulatieveMaanden(activum, jaar - 1);
  return jaarBedrag * maanden / 12;
}

/** Totale afschrijving vanaf aanschaf tot en met het einde van `jaar`. */
export function cumulatieveAfschrijving(activum, jaar) {
  return jaarlijkseAfschrijving(activum) * cumulatieveMaanden(activum, jaar) / 12;
}

/** Boekwaarde aan het eind van `jaar` — nooit onder de restwaarde. */
export function boekwaardeEindJaar(activum, jaar) {
  const aanschafwaarde = Number(activum?.aanschafwaarde) || 0;
  const restwaarde = Number(activum?.restwaarde) || 0;
  const boekwaarde = aanschafwaarde - cumulatieveAfschrijving(activum, jaar);
  return Math.max(restwaarde, boekwaarde);
}

/**
 * Som van afschrijvingInJaar() over alle geregistreerde activa, voor de
 * winstberekening in belasting.js. Afschrijving over "alle jaren" is geen
 * zinnige, optelbare grootheid (zie ook activa-ui.js) — 'all' valt daarom
 * terug op het huidige kalenderjaar, net als op het scherm zelf.
 */
export function totaalAfschrijvingVanJaar(jaar) {
  const peiljaar = jaar === 'all' ? new Date().getFullYear() : Number(jaar);
  return activaLijst().reduce((s, a) => s + afschrijvingInJaar(a, peiljaar), 0);
}
