// km.js — kilometerregistratie: gedeelde logica voor de pagina Kilometers.
//
// Kleinste eerste versie: puur ritten registreren en het eigen jaartotaal
// zien. Net als bij BTW fase 1 is dit bewust nog niet gekoppeld aan een
// boeking, aan de winstberekening in belasting.js, of aan de aangifte-pdf —
// dat is een latere, bewuste stap.
//
// Waarom geen boeking: een kilometervergoeding voor een privévoertuig is
// geen echte kasstroom (er gaat geen geld van de bankrekening af), en de
// administratie blijft hier kasstelsel (zie facturen.js). Ritten staan dus
// naast de boekingen, precies zoals facturen dat ook doen.

import { state, saveRitten, KM_INSTELLINGEN } from './storage.js?v=20261024v';

export function vandaagISO() {
  return new Date().toISOString().split('T')[0];
}

/** Bouwt een rit-object. Schrijft niets weg; dat doet voegRitToe(). */
export function maakRit(gegevens = {}) {
  const datum = gegevens.datum || vandaagISO();
  const jaar = datum.slice(0, 4);
  const volgnr = String(state.nxtRit).padStart(3, '0');

  return {
    id: gegevens.id || `km${jaar}_${volgnr}`,
    datum,
    doel: (gegevens.doel || '').trim(),
    km: Math.abs(Number(gegevens.km) || 0),
    aangemaakt: gegevens.aangemaakt || new Date().toISOString()
  };
}

export function voegRitToe(gegevens) {
  const r = maakRit(gegevens);
  state.RITTEN.push(r);
  state.nxtRit++;
  saveRitten();
  return r;
}

export function vindRit(id) {
  return state.RITTEN.find(r => String(r.id) === String(id)) || null;
}

export function werkRitBij(id, wijzigingen) {
  const r = vindRit(id);
  if (!r) return null;
  Object.assign(r, wijzigingen);
  if (r.km != null) r.km = Math.abs(Number(r.km) || 0);
  saveRitten();
  return r;
}

export function verwijderRit(id) {
  const voor = state.RITTEN.length;
  state.RITTEN = state.RITTEN.filter(r => String(r.id) !== String(id));
  const weg = state.RITTEN.length < voor;
  if (weg) saveRitten();
  return weg;
}

/** Ritten van een jaar ('all' voor alles), oplopend op datum. */
export function rittenVanJaar(jaar) {
  return state.RITTEN
    .filter(r => jaar === 'all' || (r.datum || '').startsWith(String(jaar)))
    .sort((a, b) => (a.datum || '').localeCompare(b.datum || ''));
}

export function totaalKmVanJaar(jaar) {
  return rittenVanJaar(jaar).reduce((s, r) => s + (Number(r.km) || 0), 0);
}

/** Het ingestelde tarief, of null zolang dat nog niet is ingevuld. Nooit 0
 *  als "onbekend" behandelen: een tarief van 0 zou wel geldig kunnen zijn,
 *  maar in de praktijk betekent null hier "nog niet ingesteld". */
export function kmTarief() {
  const t = Number(KM_INSTELLINGEN?.tariefPerKm);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Aftrekbedrag voor een jaar, of null zolang er geen tarief is ingesteld —
 *  zodat de interface daar "—" van kan maken in plaats van een vals €0. */
export function kmAftrek(jaar) {
  const tarief = kmTarief();
  if (tarief == null) return null;
  return totaalKmVanJaar(jaar) * tarief;
}
