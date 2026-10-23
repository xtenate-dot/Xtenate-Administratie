// voorraadlog.js — geschiedenis van voorraadwijzigingen.
//
// UITGANGSPUNT, en dit is geen detail: het veld `voorraad` op het artikel is de
// enige bron van waarheid. Dit logboek berekent nooit een voorraad, corrigeert
// er nooit een en overschrijft er nooit een. Het beantwoordt één vraag:
// waarom staan er nu 2 stuks terwijl het er eerder 5 waren?
//
// Zou het logboek wel gaan optellen, dan krijg je twee voorraadadministraties
// die na één gemiste regel uiteenlopen, en dan is er geen manier meer om te
// zeggen welke van de twee klopt. Daarom is dit bewust eenrichtingsverkeer:
// het artikel schrijft naar het logboek, het logboek nooit terug.
//
// Een regel:
//   { id, artikelId, artikel, datum, van, naar, reden, notitie, bron }
//
// `bron` zegt wie de wijziging maakte: 'handmatig' (bewerkscherm), 'import'
// (Excel), 'bulk' (meerdere artikelen tegelijk). Later kan daar 'bank' bij,
// als een verkoop vanuit een boeking de voorraad aanpast.

import { load, save, state } from './storage.js?v=20261023o';

export const REDENEN = [
  'Verkoop', 'Inkoop', 'Retour', 'Schade', 'Eigen gebruik', 'Correctie', 'Overig'
];

/** Regels staan nieuwste eerst, zodat tonen geen sortering vraagt. */
export let VOORRAAD_LOG = load('xtenate_voorraad_mutaties', []);

const MAX_REGELS = 5000;

function bewaar() {
  if (VOORRAAD_LOG.length > MAX_REGELS) VOORRAAD_LOG = VOORRAAD_LOG.slice(0, MAX_REGELS);
  save('xtenate_voorraad_mutaties', VOORRAAD_LOG);
}

/**
 * Legt een wijziging vast. Geeft de nieuwe regel terug, of null als er niets
 * te melden viel.
 *
 * Wordt aangeroepen nádat de voorraad is aangepast, niet ervoor: het logboek
 * beschrijft wat er is gebeurd en stuurt het niet aan.
 */
export function legVast({ artikelId, artikel, van, naar, reden, notitie = '', bron = 'handmatig' }) {
  const v = van == null || van === '' ? null : Number(van);
  const n = naar == null || naar === '' ? null : Number(naar);
  // Geen verandering, niets te loggen. Anders vult het logboek zich met ruis
  // bij elke keer dat iemand een artikel opent en weer opslaat.
  if (v === n) return null;
  if (!artikelId) return null;

  const regel = {
    id: `vm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    artikelId: String(artikelId),
    artikel: artikel || '',
    datum: new Date().toISOString(),
    van: v,
    naar: n,
    reden: REDENEN.includes(reden) ? reden : 'Overig',
    notitie: String(notitie || '').slice(0, 300),
    bron
  };
  VOORRAAD_LOG.unshift(regel);
  bewaar();
  return regel;
}

/** De regels van één artikel, nieuwste eerst. */
export function logVan(artikelId) {
  const id = String(artikelId);
  return VOORRAAD_LOG.filter(r => r.artikelId === id);
}

/** Het hele logboek, eventueel beperkt tot een aantal regels. */
export function heleLog(maximum = 200) {
  return VOORRAAD_LOG.slice(0, maximum);
}

/**
 * Meldt of het logboek aansluit op de huidige voorraad van een artikel: de
 * laatst gelogde `naar` zou gelijk moeten zijn aan wat er nu staat.
 *
 * Dit is uitdrukkelijk alleen een signaal, geen correctie. Wijkt het af, dan is
 * er een wijziging langs het logboek heen gegaan (bijvoorbeeld een import).
 * Het artikel blijft leidend; deze functie vertelt alleen dat de geschiedenis
 * niet compleet is.
 */
export function sluitAan(artikel) {
  const regels = logVan(artikel?.id);
  if (!regels.length) return { bekend: false };
  const laatste = regels[0];
  const nu = Number(artikel?.voorraad);
  return {
    bekend: true,
    klopt: laatste.naar === nu,
    volgensLog: laatste.naar,
    werkelijk: Number.isFinite(nu) ? nu : null
  };
}

/** Het verschil als tekst, met teken. */
export function verschilTekst(regel) {
  if (regel.van == null || regel.naar == null) return '';
  const d = regel.naar - regel.van;
  return (d > 0 ? '+' : '\u2212') + Math.abs(d);
}

/** Datum en tijd zoals de rest van de app die toont. */
export function datumTekst(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Verwijdert regels van artikelen die niet meer bestaan. Handmatig aan te
 * roepen; er gebeurt niets automatisch, zodat een import die tijdelijk minder
 * artikelen oplevert niet stilzwijgend geschiedenis weggooit.
 */
export function ruimWeesRegelsOp() {
  const bestaat = new Set((state.COVERS || []).map(c => String(c.id)));
  const voor = VOORRAAD_LOG.length;
  VOORRAAD_LOG = VOORRAAD_LOG.filter(r => bestaat.has(r.artikelId));
  bewaar();
  return voor - VOORRAAD_LOG.length;
}
