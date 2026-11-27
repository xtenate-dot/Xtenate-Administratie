// logboek.js — een eenvoudig logboek van belangrijke wijzigingen: boekingen, loten,
// artikelen, instellingen en herstelpunten. Alleen om terug te kijken wie/wat/wanneer
// er iets is veranderd; het logboek zelf verandert niets aan je gegevens.
//
// Het staat alleen in deze browser (localStorage) en bewaart de laatste 500 regels.
// Er is bewust geen koppeling met de cloud: een fout hier mag nooit een boeking of
// synchronisatie kunnen verstoren, daarom is elke functie afgeschermd met try/catch.

const SLEUTEL = 'xtenate_logboek';
const MAX = 500;
const SAMENVOEGEN_BINNEN_MS = 5000;

const lees = () => {
  try { const l = JSON.parse(localStorage.getItem(SLEUTEL) || '[]'); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
};

/**
 * Schrijft een regel. Meerdere gelijke regels vlak na elkaar (bijvoorbeeld een import van
 * tientallen boekingen) worden samengevoegd tot één regel met een aantal.
 */
export function logGebeurtenis(soort, actie, tekst) {
  try {
    const nu = Date.now();
    const lijst = lees();
    const laatste = lijst[0];
    if (laatste && laatste.soort === soort && laatste.actie === actie && nu - laatste.ms < SAMENVOEGEN_BINNEN_MS) {
      laatste.n = (laatste.n || 1) + 1;
      laatste.ms = nu; laatste.t = new Date(nu).toISOString();
      laatste.tekst = tekst;
    } else {
      lijst.unshift({ t: new Date(nu).toISOString(), ms: nu, soort, actie, tekst, n: 1 });
    }
    localStorage.setItem(SLEUTEL, JSON.stringify(lijst.slice(0, MAX)));
  } catch (e) { /* een logboekfout mag nooit iets anders stoppen */ }
}

const ACTIE = { create: 'toegevoegd', update: 'gewijzigd', delete: 'verwijderd' };
const SOORT = { boeking: 'Boeking', hnvi: 'HNVI-lot', cover: 'Voorraadartikel' };

/** Voor de wachtrij die alle wijzigingen aan boekingen, loten en artikelen passeert. */
export function logWachtrijWijziging(operation, item, soortHint) {
  try {
    const soort = operation === 'hnvi' ? 'hnvi' : operation === 'cover' ? 'cover' : (soortHint && soortHint !== 'boeking' ? soortHint : 'boeking');
    const echteActie = (operation === 'hnvi' || operation === 'cover') ? 'update' : operation;
    const naam = item && (item.naam || item.omschr || item.artikel || (item.id != null ? '#' + item.id : ''));
    const extra = item && item.bedrag != null && item.bedrag !== '' ? ` · €${Number(item.bedrag).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const dat = item && item.datum ? ` · ${String(item.datum).slice(0, 10)}` : '';
    logGebeurtenis(soort, echteActie, `${naam || 'onbekend'}${extra}${dat}`);
  } catch (e) { /* zie boven */ }
}

const INSTELLING = {
  marge: 'Marge-berekening', veiling_kosten: 'Extra kosten veiling', bol_maandcijfers: 'Bol-maandcijfers', kostenplaats: 'Kostenplaatsen',
  groepen: 'Groepen', grootboek: 'Grootboek', rekeningen: 'Bankrekeningen', facturen: 'Verkoopfacturen', artikelregels: 'Artikelregels',
  factuur_instellingen: 'Factuurinstellingen', controle_instellingen: 'Controle-instellingen', btw_instellingen: 'Btw-instellingen',
  bedrijfsgegevens: 'Bedrijfsgegevens', km_instellingen: 'Kilometerinstellingen', ritten: 'Ritten', voorraad: 'Voorraad',
  uren: 'Uren', activa: 'Activa', veiling: 'Artikelvoorraad (Excel)', hnvi_datums: 'HNVI-verkoopdatums', hnvi_extra: 'HNVI-gegevens',
  relatie_extra: 'Relatiegegevens', vergrendeld: 'Vergrendelde jaren'
};
export function logInstelling(sleutel) {
  logGebeurtenis('instelling', 'update', INSTELLING[sleutel] || String(sleutel));
}

export const logLijst = (maximum = 100) => lees().slice(0, maximum);
export const logTekstActie = (r) => `${SOORT[r.soort] || (r.soort === 'instelling' ? 'Instelling' : r.soort === 'herstelpunt' ? 'Herstelpunt' : r.soort)} ${ACTIE[r.actie] || r.actie}`;
export const soortLabel = r => SOORT[r.soort] || (r.soort === 'instelling' ? 'Instelling' : r.soort === 'herstelpunt' ? 'Herstelpunt' : r.soort);
export const actieLabel = r => ACTIE[r.actie] || r.actie;
