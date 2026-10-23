// voorraadwaarde.js — de vier geldbegrippen van de voorraad, op één plek.
//
// Deze functies stonden eerder in voorraad.js, terwijl dashboard.js en
// export.js hun eigen versie hadden die alleen naar het handmatige veld
// `inkoopprijs` keek. Home toonde daardoor een lagere voorraadwaarde dan de
// Voorraadpagina, zonder dat ergens stond welke van de twee klopte.
//
// De vier begrippen lijken op elkaar en betekenen iets anders:
//
//   inkoopwaarde   voorraad x inkoopprijs    wat er ligt heeft gekost
//   verkoopwaarde  voorraad x verkoopprijs   wat er ligt kan opbrengen
//   marge          verkoopwaarde - inkoopwaarde
//   omzet          verkocht x verkoopprijs   wat er werkelijk verkocht is
//
// Alleen omzet gaat over het verleden; de andere drie over wat er nu ligt.
//
// De inkoopprijs komt uit `prijsPerStuk()` in belasting.js. Die neemt het
// handmatige veld als dat er staat, en leidt hem anders af uit de bank: het
// bedrag op de inkooprekening gedeeld over het gewogen aantal ingekochte
// stuks. Dat is niet een noodgreep maar de fiscaal bedoelde bron — de
// aangifte berekent de balanspost voorraad met dezelfde functie
// (`voorraadEind` in belasting.js). Home en Excel horen daar niet van af te
// wijken, anders staan er twee voorraadwaarden in dezelfde administratie.

import { inkoopprijzenUitBank, prijsPerStuk } from './belasting.js?v=20261023t';
import { PRIJS_COVER } from './helpers.js?v=20261023t';
import { state } from './storage.js?v=20261023t';

/**
 * De uit de bank afgeleide prijzen. Loopt over alle boekingen, dus bereken je
 * hem één keer per weergave en geef je hem daarna mee.
 */
export function bankPrijzenNu() {
  try {
    return inkoopprijzenUitBank([...state.HIST_TX, ...state.TX], state.COVERS);
  } catch (err) {
    console.warn('Inkoopprijzen uit bank niet beschikbaar:', err);
    return null;
  }
}

/**
 * De inkoopprijs per stuk voor dit artikel in dit jaar.
 * Handmatig ingevuld bedrag wint; anders de afgeleide prijs uit de bank.
 * Levert null op als geen van beide een bruikbaar bedrag geeft.
 */
export function inkoopprijsVan(c, bankPrijzen, jaar) {
  const handmatig = Number(c?.inkoopprijs);
  if (Number.isFinite(handmatig) && handmatig > 0) return handmatig;
  if (!bankPrijzen) return null;
  const uitBank = Number(prijsPerStuk(c, bankPrijzen, jaar));
  return Number.isFinite(uitBank) && uitBank > 0 ? uitBank : null;
}

/** De verkoopprijs per stuk. */
export function verkoopprijsVan(c) {
  if (c?.prijs != null && c.prijs !== '') {
    const p = Number(c.prijs);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  return c?.categorie === 'covers' ? PRIJS_COVER : null;
}

/** voorraad x inkoopprijs. */
export function inkoopwaardeVan(c, stand, bankPrijzen, jaar) {
  if (stand?.voorraad == null) return null;
  const prijs = inkoopprijsVan(c, bankPrijzen, jaar);
  if (prijs == null) return null;
  return stand.voorraad * prijs;
}

/** voorraad x verkoopprijs. */
export function verkoopwaardeVan(c, stand) {
  if (stand?.voorraad == null) return null;
  const vk = verkoopprijsVan(c);
  if (vk == null) return null;
  return stand.voorraad * vk;
}

/**
 * verkoopwaarde min inkoopwaarde. Alleen als beide kanten bekend zijn: anders
 * vergelijk je een volledige verkoopwaarde met een halve inkoopwaarde en lijkt
 * de marge veel hoger dan hij is.
 */
export function margeVan(c, stand, bankPrijzen, jaar) {
  const inkoop = inkoopwaardeVan(c, stand, bankPrijzen, jaar);
  const verkoop = verkoopwaardeVan(c, stand);
  if (inkoop == null || verkoop == null) return null;
  return verkoop - inkoop;
}

/** verkocht x verkoopprijs: wat er in het gekozen tijdvak werkelijk verkocht is. */
export function omzetVan(c, stand) {
  const vk = verkoopprijsVan(c);
  if (vk == null) return null;
  if (!stand?.verkocht) return null;
  return stand.verkocht * vk;
}

/**
 * De optelling over een lijst artikelen. Home, Voorraad en de Excel-export
 * gebruiken deze, zodat een totaal nergens anders wordt samengesteld.
 * `standVan` bepaalt welke stand telt; de Voorraadpagina kijkt naar een
 * gekozen boekjaar, Home naar de actuele stand.
 */
export function totalenVan(artikelen, standVan, bankPrijzen, jaar) {
  const uit = {
    stuks: 0, inkoopwaarde: 0, verkoopwaarde: 0, marge: 0, omzet: 0,
    ingekocht: 0, verkocht: 0, retour: 0,
    zonderInkoopprijs: 0, zonderVerkoopprijs: 0, metMarge: 0
  };
  for (const c of artikelen || []) {
    const s = standVan(c);
    uit.stuks += s?.voorraad ?? 0;
    uit.ingekocht += s?.inkoop || 0;
    uit.verkocht += s?.verkocht || 0;
    uit.retour += s?.retour || 0;

    const iw = inkoopwaardeVan(c, s, bankPrijzen, jaar);
    const vw = verkoopwaardeVan(c, s);
    const mg = margeVan(c, s, bankPrijzen, jaar);
    const oz = omzetVan(c, s);

    if (iw != null) uit.inkoopwaarde += iw;
    else if (s?.voorraad > 0) uit.zonderInkoopprijs++;
    if (vw != null) uit.verkoopwaarde += vw;
    else if (s?.voorraad > 0) uit.zonderVerkoopprijs++;
    if (mg != null) { uit.marge += mg; uit.metMarge++; }
    if (oz != null) uit.omzet += oz;
  }
  // Percentage over de verkoopwaarde van dezelfde artikelen die de marge
  // opleveren, niet over de volledige verkoopwaarde.
  const vwMetMarge = (artikelen || []).reduce((t, c) => {
    const s = standVan(c);
    return margeVan(c, s, bankPrijzen, jaar) == null ? t : t + verkoopwaardeVan(c, s);
  }, 0);
  uit.margePct = vwMetMarge > 0 ? Math.round(uit.marge / vwMetMarge * 100) : null;
  return uit;
}
