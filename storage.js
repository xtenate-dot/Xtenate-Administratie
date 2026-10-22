// storage.js — centrale state, localStorage helpers en opslagfuncties
// Fase 1 refactor: identieke logica als het origineel, alleen verplaatst en
// samengevoegd in een gedeeld `state`-object zodat andere modules ernaar kunnen
// verwijzen zonder dat we losse globale variabelen nodig hebben.

// Fase 3A: Import Supabase client v2 (pending queue + RLS)
import {
  loadBoekingenFromSupabase,
  loadHnviFromSupabase,
  loadCoversFromSupabase,
  loadRelatiesFromSupabase,
  loadBankKoppelingenFromSupabase,
  loadPendingQueue,
  syncPendingQueue,
  pendingQueue,
  isSupabaseReady,
  addToPendingQueue,
  savePendingQueue,
  saveAppData,
  loadAppData,
  laatsteAppDataFout
} from './supabase-client-v2.js?v=20261023j';

/**
 * Stuurt een los lijstje (groepen, facturen, tellers) naar de cloud zonder
 * erop te wachten. Mislukt het, dan blijft het lokaal staan en probeert de
 * automatische synchronisatie het straks opnieuw.
 */
const appDataVuil = new Set();

// Aantal mislukte pogingen op rij, per sleutel — alleen opgehoogd door de
// retry-lus hieronder (duwOpenstaandeAppData), niet door de eerste,
// meteen-bij-het-opslaan poging in duwAppData(). Zelfde opzet als attempts/
// maxAttempts bij de boekingen-wachtrij (supabase-client-v2.js), en
// bewust dezelfde drempel (5), zodat "vastgelopen" overal hetzelfde betekent.
const appDataPogingen = {};
const APP_DATA_MAX_POGINGEN = 5;

function duwAppData(sleutel, waarde) {
  appDataVuil.add(sleutel);
  // Een nieuwe wijziging krijgt een schone lei, ook als de vorige waarde van
  // deze sleutel al vastgelopen was — precies zoals addToPendingQueue() een
  // nieuwe boeking-wijziging ook altijd met attempts:0 begint, nooit met de
  // oude, opgelopen teller. Anders zou duwOpenstaandeAppData() deze verse
  // wijziging overslaan totdat er expliciet op "Opnieuw proberen" wordt
  // geklikt, terwijl er net nieuwe data is om te versturen.
  delete appDataPogingen[sleutel];
  saveAppData(sleutel, waarde)
    .then(ok => { if (ok) { appDataVuil.delete(sleutel); delete appDataPogingen[sleutel]; } })
    .catch(() => {});
}

/**
 * Probeert alles wat nog niet aankwam opnieuw. Gebruikt door de autosync.
 * Een sleutel die de pogingendrempel al heeft bereikt, wordt overgeslagen —
 * pas "Opnieuw proberen" (herstartVastgelopenAppData) zet die weer aan.
 * Haalt bij elke poging de ACTUELE waarde op (appDataWaarde(sleutel)), dus
 * een nieuwere wijziging aan dezelfde instelling stuurt vanzelf de nieuwste
 * versie, nooit de oude, vastgelopen waarde.
 */
export async function duwOpenstaandeAppData() {
  for (const sleutel of [...appDataVuil]) {
    if ((appDataPogingen[sleutel] || 0) >= APP_DATA_MAX_POGINGEN) continue;
    const waarde = appDataWaarde(sleutel);
    if (waarde === undefined) { appDataVuil.delete(sleutel); delete appDataPogingen[sleutel]; continue; }
    if (await saveAppData(sleutel, waarde)) {
      appDataVuil.delete(sleutel);
      delete appDataPogingen[sleutel];
    } else {
      appDataPogingen[sleutel] = (appDataPogingen[sleutel] || 0) + 1;
    }
  }
}

/**
 * Synchronisatiestatus van app_data-sleutels, voor het "Synchronisatie"-blok
 * in Beheer — zelfde soort informatie als wachtrijStatus() voor boekingen.
 */
export function appDataStatus() {
  const vastgelopenSleutels = [...appDataVuil].filter(s => (appDataPogingen[s] || 0) >= APP_DATA_MAX_POGINGEN);
  return {
    open: appDataVuil.size - vastgelopenSleutels.length,
    vastgelopen: vastgelopenSleutels.length,
    items: vastgelopenSleutels.map(sleutel => ({
      sleutel,
      pogingen: appDataPogingen[sleutel] || 0,
      laatsteFout: laatsteAppDataFout[sleutel] || 'onbekende fout'
    }))
  };
}

/** Zet vastgelopen app_data-sleutels terug op nul pogingen, zodat de
 *  eerstvolgende sync-ronde ze weer meeneemt. Zelfde rol als
 *  herstartVastgelopen() voor de boekingen-wachtrij. */
export function herstartVastgelopenAppData() {
  let aantal = 0;
  for (const sleutel of Object.keys(appDataPogingen)) {
    if (appDataPogingen[sleutel] >= APP_DATA_MAX_POGINGEN) { delete appDataPogingen[sleutel]; aantal++; }
  }
  return aantal;
}

function appDataWaarde(sleutel) {
  if (sleutel === 'groepen') return state.GROEPEN;
  if (sleutel === 'grootboek') return state.GROOTBOEK;
  if (sleutel === 'rekeningen') return state.REKENINGEN;
  if (sleutel === 'facturen') return { lijst: state.FACTUREN, volgende: state.nxtFactuur };
  if (sleutel === 'factuur_instellingen') return FACTUUR_INSTELLINGEN;
  if (sleutel === 'controle_instellingen') return CONTROLE_INSTELLINGEN;
  if (sleutel === 'btw_instellingen') return BTW_INSTELLINGEN;
  if (sleutel === 'bedrijfsgegevens') return BEDRIJFSGEGEVENS;
  if (sleutel === 'km_instellingen') return KM_INSTELLINGEN;
  if (sleutel === 'ritten') return { lijst: state.RITTEN, volgende: state.nxtRit };
  if (sleutel === 'activa') return { lijst: state.ACTIVA, volgende: state.nxtActivum };
  if (sleutel === 'veiling') return state.VEILING;
  if (sleutel === 'hnvi_datums') return state.HNVI_DATUMS;
  if (sleutel === 'vergrendeld') return state.VERGRENDELD;
  if (sleutel === 'tellers') return { tx: state.nxtTx, cover: state.nxtCover, hnvi: state.nxtHnvi };
  return undefined;
}

/** Zet de tellers apart weg zodat twee apparaten geen gelijke id's uitdelen. */
export function duwTellers() {
  duwAppData('tellers', appDataWaarde('tellers'));
}

export const state = {
  dataKlaar: false,   // pas true als het laden van alle gegevens is afgerond
  TX: [],
  COVERS: [],
  HNVI_LOTS: [],
  HIST_TX: [],
  FACTUREN: [],
  nxtTx: 200,
  nxtFactuur: 1,
  editFactuurId: null,
  nxtCover: 100,
  nxtHnvi: 10,
  huidigJaar: '2026',
  editTxId: null,
  editCoverId: null,
  hnviSellId: null,
  hnviLaatsteDatum: null,
  hnviImportItems: [],
  loadedFromSupabase: false  // Track data source
};

export const HIST_TX_DEFAULT = [];
state.HIST_TX = load('xtenate_hist_tx_override', JSON.parse(JSON.stringify(HIST_TX_DEFAULT)));

// De maandsaldi zoals ze in de app zijn vastgelegd. Apart benoemd zodat een
// herstelactie ze binnen dezelfde sessie kan terugzetten, en niet alleen de
// override uit de browser kan weghalen.
export const MAAND_SALDOS_DEFAULT = {};

export let MAAND_SALDOS = load('xtenate_maand_saldos_override', JSON.parse(JSON.stringify(MAAND_SALDOS_DEFAULT)));

// Jaartotalen (omzet, kosten, privé opname/storting, HNVI-inkoop) zoals ingelezen uit het
// "Per Periode"-tabblad van een Excel-import. Deze zijn leidend boven de losse boekingen,
// want ze komen rechtstreeks uit de boekhouding en zijn dus de betrouwbaarste bron.
// Structuur: { "2025": {omzet, kosten, omzXt, omzBol, omzHC, priveOp, priveSt, hnviInv}, ... }
export const HOME_TOTALS_DEFAULT = {};
export let HOME_TOTALS = load('xtenate_home_totals_override', JSON.parse(JSON.stringify(HOME_TOTALS_DEFAULT)));

const TX_INIT = [];

const COVERS_INIT = [];

export function load(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch(e) { return def; } }

export function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.error(`Opslag is vol: kan niet meer opslaan. (${e.message})`);
      showStorageError('Opslagruimte vol', 'De browser kan niet meer opslaan. Verwijder oude data of maak ruimte vrij.');
    } else {
      console.error(`Fout bij opslaan: ${e.message}`, e);
      showStorageError('Opslagfout', 'Er is een fout opgetreden bij het opslaan. Herlaad de pagina en probeer opnieuw.');
    }
  }
}

function showStorageError(titel, boodschap) {
  if (typeof window !== 'undefined' && window.alert) {
    alert(`⚠️ ${titel}\n\n${boodschap}`);
  }
}

/** Diepe kopie, zodat werkgegevens en standaardwaarden nooit hetzelfde object zijn. */
export const kopie = v => JSON.parse(JSON.stringify(v));

state.TX = load('xtenate_tx', JSON.parse(JSON.stringify(TX_INIT)));

state.COVERS = load('xtenate_covers', JSON.parse(JSON.stringify(COVERS_INIT)));

// Relaties (fase 4a van de facturenmodule): een echte Supabase-tabel, geen
// app_data-lijstje zoals GROEPEN/GROOTBOEK — wat hier lokaal staat is dus
// alleen een offline-cache, ververst zodra loadDataHybrid() lukt, nooit de
// bron van waarheid.
state.RELATIES = load('xtenate_relaties_cache', []);

export function saveRelatiesCache() {
  save('xtenate_relaties_cache', state.RELATIES);
}

// Voorraadartikelen van vóór de categorie-indeling aanvullen. Alles wat er al
// stond is een Funny Cover; inkoopprijs en minimumvoorraad blijven leeg tot ze
// zijn ingevuld, zodat de app niet met verzonnen waarden gaat rekenen.
export const GROEPEN_STANDAARD = [
  { id: 'covers', naam: 'Funny Covers' },
  { id: 'hoezen', naam: 'Hoezen' },
  { id: 'pophouders', naam: 'Pop Houders' },
  { id: 'accessoires', naam: 'Accessoires' },
  { id: 'overig', naam: 'Overig' }
];

// De drempel waaronder de voorraad als 'laag' geldt, voor artikelen die geen
// eigen minimum hebben. Een artikel met een ingevuld `minVoorraad` blijft dat
// gebruiken; deze waarde geldt alleen als terugval. Instelbaar in Beheer.
export const STANDAARD_MIN_VOORRAAD_FABRIEK = 3;

export let VOORRAAD_INSTELLINGEN = load('xtenate_voorraad_instellingen', {
  standaardMin: STANDAARD_MIN_VOORRAAD_FABRIEK
});

/** De geldende standaarddrempel. Lees dit, niet de fabriekswaarde. */
export function standaardMinVoorraad() {
  const n = Number(VOORRAAD_INSTELLINGEN?.standaardMin);
  return Number.isFinite(n) && n >= 0 ? n : STANDAARD_MIN_VOORRAAD_FABRIEK;
}

export function saveVoorraadInstellingen(nieuwe) {
  if (nieuwe) VOORRAAD_INSTELLINGEN = { ...VOORRAAD_INSTELLINGEN, ...nieuwe };
  save('xtenate_voorraad_instellingen', VOORRAAD_INSTELLINGEN);
  duwAppData('voorraad_instellingen', VOORRAAD_INSTELLINGEN);
}

// Productgroepen zijn zelf te beheren, dus ze staan in de opslag en niet vast
// in de code. De vijf hierboven zijn alleen het vertrekpunt.
state.GROEPEN = load('xtenate_voorraad_groepen', GROEPEN_STANDAARD)
  .filter(g => g && g.id && g.naam);
if (!state.GROEPEN.length) state.GROEPEN = [...GROEPEN_STANDAARD];

export function saveGroepen() {
  save('xtenate_voorraad_groepen', state.GROEPEN);
  duwAppData('groepen', state.GROEPEN);
}

/** De groep waar artikelen in vallen als er niets anders bekend is. */
export function standaardGroep() {
  return state.GROEPEN.some(g => g.id === 'covers') ? 'covers' : state.GROEPEN[0].id;
}

export function groepNaam(id) {
  return state.GROEPEN.find(g => g.id === id)?.naam || id || '—';
}

// ─── GROOTBOEK EN REKENINGEN (fase 1, zelfregistratie) ─────────────────────
// Zelfde patroon als GROEPEN hierboven: zelf te beheren, dus in de opslag en
// niet vast in de code.
//
// GROOTBOEK_STANDAARD/REKENINGEN_STANDAARD is de terugval voor iedereen
// zonder eigen, al opgeslagen schema — zowel een gloednieuwe gebruiker als
// (via localStorage/app_data) deze installatie zelf, ná de eenmalige
// overname die eerder vanuit de toen nog hardgecodeerde GBNM/REKNM in
// helpers.js is gebeurd en inmiddels bevestigd in app_data staat (25
// grootboekrekeningen, 5 rekeningen). Die overname was een eenmalige,
// afgeronde stap; GBNM/REKNM zelf bestaan niet meer.

export const GROOTBOEK_STANDAARD = [
  { nummer: '600',  naam: 'Privé storting' },
  { nummer: '601',  naam: 'Privé opname' },
  { nummer: '4300', naam: 'Kantoorkosten' },
  { nummer: '4350', naam: 'Bankkosten' },
  { nummer: '4700', naam: 'Marketing en reclame' },
  { nummer: '4900', naam: 'Overige kosten' },
  { nummer: '7000', naam: 'Inkoop' },
  { nummer: '8000', naam: 'Omzet' }
];

export const REKENINGEN_STANDAARD = [
  { nummer: '1010', naam: 'Bank', isHoofdrekening: true }
];

state.GROOTBOEK = load('xtenate_grootboek', GROOTBOEK_STANDAARD)
  .filter(g => g && g.nummer && g.naam);
if (!state.GROOTBOEK.length) state.GROOTBOEK = [...GROOTBOEK_STANDAARD];

state.REKENINGEN = load('xtenate_rekeningen', REKENINGEN_STANDAARD)
  .filter(r => r && r.nummer && r.naam);
if (!state.REKENINGEN.length) state.REKENINGEN = [...REKENINGEN_STANDAARD];

export function saveGrootboek() {
  save('xtenate_grootboek', state.GROOTBOEK);
  duwAppData('grootboek', state.GROOTBOEK);
}

export function saveRekeningen() {
  save('xtenate_rekeningen', state.REKENINGEN);
  duwAppData('rekeningen', state.REKENINGEN);
}

/** {nummer: naam}, precies de vorm van het vroegere GBNM — voor plekken die
 *  een tabel opzoeken in plaats van één nummer. */
export function grootboekNamen() {
  return Object.fromEntries(state.GROOTBOEK.map(g => [g.nummer, g.naam]));
}

/** {nummer: naam}, precies de vorm van het vroegere REKNM. */
export function rekeningNamen() {
  return Object.fromEntries(state.REKENINGEN.map(r => [r.nummer, r.naam]));
}

/**
 * state.GROOTBOEK gegroepeerd voor een <select>, in dezelfde rubrieken en
 * volgorde als de vaste optgroups die nu nog in index.html staan — bepaald
 * op precies dezelfde nummerbereiken die de rest van de app al aanneemt
 * (isOmzet()/OMZET_GB in de JS, rubriek_van() in Supabase): 8xxx omzet, 7xxx
 * inkoop, 4xxx kosten, 600/601 privé, de rest overig. Geeft alleen niet-lege
 * rubrieken terug.
 */
export function grootboekOptgroepen() {
  const rubriek = nummer => {
    if (nummer === '600' || nummer === '601') return 'Privé';
    if (nummer.startsWith('8')) return 'Omzet';
    if (nummer.startsWith('7')) return 'Inkoop';
    if (nummer.startsWith('4')) return 'Kosten';
    return 'Overig';
  };
  const VOLGORDE = ['Omzet', 'Inkoop', 'Kosten', 'Privé', 'Overig'];
  const groepen = new Map(VOLGORDE.map(v => [v, []]));
  [...state.GROOTBOEK].sort((a, b) => a.nummer.localeCompare(b.nummer)).forEach(g => {
    groepen.get(rubriek(g.nummer)).push(g);
  });
  return VOLGORDE.map(naam => ({ naam, rekeningen: groepen.get(naam) })).filter(g => g.rekeningen.length);
}

/** state.REKENINGEN gesorteerd, hoofdrekening eerst — voor een <select>. */
export function rekeningenLijst() {
  return [...state.REKENINGEN].sort((a, b) =>
    (b.isHoofdrekening ? 1 : 0) - (a.isHoofdrekening ? 1 : 0) || a.nummer.localeCompare(b.nummer));
}

/** Maakt van een naam een bruikbaar, uniek id. */
export function groepId(naam) {
  const basis = String(naam).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'groep';
  let id = basis, n = 2;
  while (state.GROEPEN.some(g => g.id === id)) id = `${basis}-${n++}`;
  return id;
}

/**
 * Vult ontbrekende voorraadvelden aan. Draait niet alleen bij het opstarten,
 * maar ook na een Excel-import of cloud-download: die vervangen de hele lijst
 * en zouden je indeling anders elke keer wissen. `vorige` is de lijst zoals
 * die er vóór de vervanging uitzag, zodat groep, inkoopprijs en meldgrens
 * behouden blijven — gekoppeld op id, en anders op artikelnaam.
 */
/** Jaargegevens samenvoegen zonder een bekend cijfer door een leeg te vervangen. */
function voegJarenSamen(oud = {}, nieuw = {}) {
  const uit = { ...oud };
  for (const [jaar, waarden] of Object.entries(nieuw)) {
    const bestaand = uit[jaar] || {};
    uit[jaar] = {
      // Een bestand van een later jaar noemt oudere jaren wel bij naam, maar
      // kent daar geen eindstand van. Die mag de al bekende stand niet wissen.
      eind: waarden.eind ?? bestaand.eind ?? null,
      inkoop: waarden.inkoop ?? bestaand.inkoop ?? null,
      verkocht: waarden.verkocht ?? bestaand.verkocht ?? null,
      retour: waarden.retour ?? bestaand.retour ?? null
    };
  }
  return uit;
}

/**
 * Jaarcijfers uit een import van een afgesloten jaar toevoegen aan de
 * bestaande artikelen. De huidige voorraad blijft ongemoeid: een bestand uit
 * 2024 zegt niets over wat er vandaag op de plank ligt, alleen over hoe dat
 * jaar is verlopen. Artikelen die je toen wel had en nu niet meer, komen erbij
 * met voorraad 0 zodat je dat jaar kunt terugkijken.
 */
export function voegJaarcijfersToe(huidig, uitBestand) {
  const sleutel = c => String(c.artikel || '').trim().toLowerCase();
  const opNaam = new Map(huidig.map(c => [sleutel(c), c]));

  for (const nieuw of uitBestand || []) {
    const bestaand = opNaam.get(sleutel(nieuw));
    if (bestaand) {
      bestaand.jaren = voegJarenSamen(bestaand.jaren, nieuw.jaren);
      if (bestaand.prijs == null && nieuw.prijs != null) bestaand.prijs = nieuw.prijs;
    } else {
      const toegevoegd = {
        ...nieuw,
        voorraad: 0,
        uitAssortiment: true,
        categorie: nieuw.categorie || standaardGroep()
      };
      huidig.push(toegevoegd);
      opNaam.set(sleutel(toegevoegd), toegevoegd);
    }
  }
  return huidig;
}

export function normaliseerVoorraad(lijst, vorige = []) {
  const sleutel = c => String(c.artikel || '').trim().toLowerCase();
  const opNaam = new Map(vorige.map(c => [sleutel(c), c]));
  const verwerkt = new Set();

  const nieuw = (lijst || []).map(c => {
    // Koppelen gebeurt op naam, niet op nummer. De import deelt nummers uit op
    // volgorde vanaf 200, dus het eerste artikel in het ene bestand kreeg
    // hetzelfde nummer als het eerste in het andere. Daardoor erfde de Kerstman
    // de verkoopcijfers van de luchtcompressor.
    const oud = opNaam.get(sleutel(c)) || {};
    verwerkt.add(sleutel(c));
    const jaren = voegJarenSamen(oud.jaren, c.jaren);
    if (c.omzet2026 != null && jaren['2026']?.verkocht == null) {
      jaren['2026'] = { eind: jaren['2026']?.eind ?? null, verkocht: c.omzet2026 };
    }
    return {
      ...c,
      // Een bestaand artikel houdt zijn eigen nummer, zodat de koppeling met de
      // cloud niet elke import verspringt.
      id: oud.id ?? c.id,
      categorie: c.categorie || oud.categorie || standaardGroep(),
      inkoopprijs: c.inkoopprijs ?? oud.inkoopprijs ?? null,
      minVoorraad: c.minVoorraad ?? oud.minVoorraad ?? null,
      prijs: c.prijs ?? oud.prijs ?? null,
      jaren
    };
  });

  // Artikelen die je vroeger verkocht maar die niet meer in het nieuwste
  // bestand staan, blijven bewaard. Zonder dit verdween een luchtcompressor
  // uit 2024 volledig zodra je 2026 importeerde, inclusief zijn geschiedenis,
  // en kon je dat jaar niet meer terugkijken. Ze staan nu op nul en zijn
  // gemarkeerd als uit het assortiment.
  const bewaard = vorige
    .filter(c => !verwerkt.has(sleutel(c)))
    .map(c => ({ ...c, voorraad: 0, uitAssortiment: true }));

  return [...nieuw, ...bewaard];
}

state.COVERS = normaliseerVoorraad(state.COVERS);

state.HNVI_LOTS = load('xtenate_hnvi', []);

state.HNVI_LOTS = state.HNVI_LOTS.map((i,idx) => ({...i, _key: i._key || String(i.id || idx)}));

state.nxtTx = load('xtenate_nxtTx', 200);

state.nxtCover = load('xtenate_nxtCover', 100);

state.nxtHnvi = load('xtenate_nxtHnvi', 10);

export function saveTxData() { save('xtenate_tx', state.TX); save('xtenate_nxtTx', state.nxtTx); duwTellers(); }

/** Bewaart wijzigingen in de historische jaren (2022 t/m 2025). */
export function saveHistTxData() { save('xtenate_hist_tx_override', state.HIST_TX); }

export function saveCoversData() { save('xtenate_covers', state.COVERS); save('xtenate_nxtCover', state.nxtCover); duwTellers(); }

// Verkoopdatums van HNVI-loten staan ook los in app_data. De tabel hnvi_loten
// heeft daar mogelijk nog geen kolom voor; zonder deze kopie verdwijnt de datum
// zodra de loten opnieuw uit de database komen. Sleutel = lot-sleutel.
state.HNVI_DATUMS = load('xtenate_hnvi_datums', {});

/** Zet de datums van de loten in de aparte lijst; een lot op voorraad verliest zijn datum. */
function werkHnviDatumsBij() {
  let gewijzigd = false;
  for (const l of state.HNVI_LOTS || []) {
    const sleutel = String(l._key || l.id);
    if (l.status === 'verkocht' && l.verkoopDatum) {
      if (state.HNVI_DATUMS[sleutel] !== l.verkoopDatum) { state.HNVI_DATUMS[sleutel] = l.verkoopDatum; gewijzigd = true; }
    } else if (l.status === 'voorraad' && sleutel in state.HNVI_DATUMS) {
      delete state.HNVI_DATUMS[sleutel]; gewijzigd = true;
    }
  }
  return gewijzigd;
}

/** Vult ontbrekende verkoopdatums van de loten aan uit de aparte lijst. */
export function pasHnviDatumsToe() {
  for (const l of state.HNVI_LOTS || []) {
    const d = state.HNVI_DATUMS[String(l._key || l.id)];
    if (d && !l.verkoopDatum && l.status === 'verkocht') l.verkoopDatum = d;
  }
}

pasHnviDatumsToe();

export function saveHnviData() {
  save('xtenate_hnvi', state.HNVI_LOTS); save('xtenate_nxtHnvi', state.nxtHnvi);
  if (werkHnviDatumsBij()) { save('xtenate_hnvi_datums', state.HNVI_DATUMS); duwAppData('hnvi_datums', state.HNVI_DATUMS); }
  duwTellers();
}

// ─── FACTUREN (fase 7) ─────────────────────────────────────────────────────
// Debiteuren en crediteuren staan naast de boekingen, niet erin. Er is geen
// _DEFAULT: facturen beginnen leeg, er valt niets te herstellen naar standaard.
// Een lege of beschadigde opslag levert dus gewoon een lege lijst op, en de
// bestaande 634 boekingen blijven daarbij onaangeroerd.
state.FACTUREN = load('xtenate_facturen', []);
state.nxtFactuur = load('xtenate_nxt_factuur', 1);

export const FACTUUR_INSTELLINGEN_STANDAARD = {
  betaaltermijnDebiteur: 30,
  betaaltermijnCrediteur: 14,
  waarschuwDagen: 7
};
export let FACTUUR_INSTELLINGEN = load('xtenate_factuur_instellingen',
  JSON.parse(JSON.stringify(FACTUUR_INSTELLINGEN_STANDAARD)));

export function saveFacturen() {
  save('xtenate_facturen', state.FACTUREN);
  save('xtenate_nxt_factuur', state.nxtFactuur);
  duwAppData('facturen', { lijst: state.FACTUREN, volgende: state.nxtFactuur });
}

export function saveFactuurInstellingen(nieuwe) {
  if (nieuwe) FACTUUR_INSTELLINGEN = { ...FACTUUR_INSTELLINGEN, ...nieuwe };
  save('xtenate_factuur_instellingen', FACTUUR_INSTELLINGEN);
  duwAppData('factuur_instellingen', FACTUUR_INSTELLINGEN);
}

// ─── CONTROLE (referentiewaarden voor Gegevenscontrole/Uitvoeren/Herstel) ──
// Sommige controles vergelijken de administratie met een getal dat alleen jij
// kunt bevestigen — bijvoorbeeld een jaartotaal dat je zelf hebt nagerekend
// tegen het Per Periode-tabblad. Zulke getallen stonden eerder vast in de
// code; nu staan ze hier, leeg totdat jij ze in Beheer invult. Staat een
// waarde nog op null, dan slaat de bijbehorende controle die stap gewoon over
// in plaats van een verschil te melden tegen 0.
export let CONTROLE_INSTELLINGEN = load('xtenate_controle_instellingen', {
  jaartotaal2022PriveSt: null
});

export function saveControleInstellingen(nieuwe) {
  if (nieuwe) CONTROLE_INSTELLINGEN = { ...CONTROLE_INSTELLINGEN, ...nieuwe };
  save('xtenate_controle_instellingen', CONTROLE_INSTELLINGEN);
  duwAppData('controle_instellingen', CONTROLE_INSTELLINGEN);
}

// ─── BTW (fase 1) ───────────────────────────────────────────────────────────
// De instelling en een simpele afleiding, in hetzelfde patroon als
// CONTROLE_INSTELLINGEN. Inmiddels wel degelijk gebruikt: isBtwPlichtig()
// hieronder bepaalt in bank.js of het BTW-veld op het boekingformulier
// verschijnt, en btw.js gebruikt btwPlichtigVanaf rechtstreeks om het
// overgangskwartaal te herkennen.
export let BTW_INSTELLINGEN = load('xtenate_btw_instellingen', {
  btwPlichtigVanaf: null   // 'YYYY-MM-DD', of null zolang er geen BTW-plicht is
});

export function saveBtwInstellingen(nieuwe) {
  if (nieuwe) BTW_INSTELLINGEN = { ...BTW_INSTELLINGEN, ...nieuwe };
  save('xtenate_btw_instellingen', BTW_INSTELLINGEN);
  duwAppData('btw_instellingen', BTW_INSTELLINGEN);
}

/**
 * Valt deze datum (tekst, 'YYYY-MM-DD') onder de BTW-plicht? Zonder ingestelde
 * datum, of zonder geldige invoerdatum, altijd nee. De omslagdatum zelf telt
 * mee ("vanaf" is inclusief). Vergelijking gebeurt als tekst, net als de rest
 * van de app doet met datums — die blijven hier altijd 'YYYY-MM-DD', nooit
 * een Date-object, dus dat is even betrouwbaar als een echte datumvergelijking
 * en voorkomt tijdzone-eigenaardigheden.
 */
export function isBtwPlichtig(datum) {
  const vanaf = BTW_INSTELLINGEN?.btwPlichtigVanaf;
  if (!vanaf || !datum) return false;
  return String(datum) >= String(vanaf);
}

// ─── BEDRIJFSGEGEVENS (fase 5, zelfregistratie) ────────────────────────────
// Alles optioneel en leeg totdat jij het invult — precies hetzelfde patroon
// als CONTROLE_INSTELLINGEN/BTW_INSTELLINGEN hierboven. Werkt op dit moment
// alleen door in de footer van de factuur-pdf (facturen-ui.js): zonder een
// ingevulde naam blijft die exact de bestaande "Interne kopie"-tekst tonen.
export let BEDRIJFSGEGEVENS = load('xtenate_bedrijfsgegevens', {
  naam: null,
  adres: null,
  postcodePlaats: null,
  kvkNummer: null,
  btwNummer: null
});

export function saveBedrijfsgegevens(nieuwe) {
  if (nieuwe) BEDRIJFSGEGEVENS = { ...BEDRIJFSGEGEVENS, ...nieuwe };
  save('xtenate_bedrijfsgegevens', BEDRIJFSGEGEVENS);
  duwAppData('bedrijfsgegevens', BEDRIJFSGEGEVENS);
}

// ─── KILOMETERREGISTRATIE ───────────────────────────────────────────────────
// Kleinste eerste versie: alleen ritten registreren en het eigen jaartotaal
// zien. Geen boeking, geen koppeling met de IB-berekening (belasting.js) of
// de aangifte-pdf — dat is een latere, bewuste stap.
//
// Het tarief per kilometer is expliciet geen constante in de code: de
// Belastingdienst past dit jaarlijks aan, dus dit is een instelling, precies
// hetzelfde patroon als BTW_INSTELLINGEN/BEDRIJFSGEGEVENS hierboven. Zolang
// er geen tarief is ingevuld, wordt er nergens een bedrag berekend — km.js's
// kmTarief()/kmAftrek() geven dan null terug, nooit een vals nulbedrag.
export let KM_INSTELLINGEN = load('xtenate_km_instellingen', {
  tariefPerKm: null
});

export function saveKmInstellingen(nieuwe) {
  if (nieuwe) KM_INSTELLINGEN = { ...KM_INSTELLINGEN, ...nieuwe };
  save('xtenate_km_instellingen', KM_INSTELLINGEN);
  duwAppData('km_instellingen', KM_INSTELLINGEN);
}

// Ritten zelf: zelfde opzet als FACTUREN — een array plus een eigen teller.
state.RITTEN = load('xtenate_ritten', []);
state.nxtRit = load('xtenate_nxt_rit', 1);

export function saveRitten() {
  save('xtenate_ritten', state.RITTEN);
  save('xtenate_nxt_rit', state.nxtRit);
  duwAppData('ritten', { lijst: state.RITTEN, volgende: state.nxtRit });
}

// ─── ACTIVAREGISTER (afschrijvingen) ───────────────────────────────────────
// Kleinste eerste versie: alleen vastleggen en het eigen jaaroverzicht zien.
// Nog niet gekoppeld aan de winstberekening in belasting.js of aan een
// bankboeking — net als bij kilometers zijn dat bewuste, latere stappen.
//
// Gebruiksduur/restwaarde staan per activum, niet als globale instelling
// zoals KM_INSTELLINGEN: dat verschilt juist per soort bedrijfsmiddel.
state.ACTIVA = load('xtenate_activa', []);
state.nxtActivum = load('xtenate_nxt_activum', 1);

export function saveActiva() {
  save('xtenate_activa', state.ACTIVA);
  save('xtenate_nxt_activum', state.nxtActivum);
  duwAppData('activa', { lijst: state.ACTIVA, volgende: state.nxtActivum });
}

// ─── VEILING (twee tabbladen uit de Excel) ─────────────────────────────────
// Een eigen onderdeel naast HNVI en Voorraad: een kopie van de tabbladen
// "Veiling inkopenVerkopen" en "Veiling Voorraad". Een nieuwe import
// vervangt deze kopie; er wordt niets in HNVI of Voorraad aangepast.
state.VEILING = load('xtenate_veiling', null);

// ─── VERGRENDELDE JAREN ────────────────────────────────────────────────────
// Jaren waarvan de aangifte is ingediend. Boekingen van zo'n jaar wijzig je
// pas na een extra bevestiging, zodat ingediende cijfers niet ongemerkt
// verschuiven.
state.VERGRENDELD = load('xtenate_vergrendeld', []);

export function jaarIsVergrendeld(datum) {
  const j = String(datum || '').slice(0, 4);
  return !!j && (state.VERGRENDELD || []).includes(j);
}

export function zetJaarVergrendeld(jaar, aan) {
  const nu = new Set(state.VERGRENDELD || []);
  if (aan) nu.add(String(jaar)); else nu.delete(String(jaar));
  state.VERGRENDELD = [...nu].sort();
  save('xtenate_vergrendeld', state.VERGRENDELD);
  duwAppData('vergrendeld', state.VERGRENDELD);
}

export function saveVeiling() {
  save('xtenate_veiling', state.VEILING);
  duwAppData('veiling', state.VEILING);
}

// ─── BANKKOPPELINGEN (Enable Banking, fase 4b-1) ───────────────────────────
// Géén app_data meer (dat was de opzet in fase 4a, nu herzien): session_id/
// account_uid/geldig_tot geven tot 90 dagen toegang tot echte bankgegevens
// bij Enable Banking en horen niet in een blob die de frontend rechtstreeks
// leest/schrijft. Deze lijst komt nu rechtstreeks uit de eigen tabel
// bank_koppelingen (RLS + kolomrechten — zie supabase-client-v2.js), en
// wordt bij het opstarten gevuld door loadDataHybrid(). Alleen `rek` wordt
// door de app zelf bewerkt (Beheer); de rest is alleen-lezen client-side.
// Elke koppeling: { id, aspspNaam, iban, rek, geldigTot, status }.
state.BANK_KOPPELINGEN = [];

/** Aantal hele dagen tot het verlopen van de toestemming (negatief = al
 *  verlopen), of null als er geen geldigTot bekend is. Rekent in hele
 *  kalenderdagen, net als de rest van de app doet met datums. */
export function bankKoppelingDagenTotVerval(koppeling) {
  if (!koppeling?.geldigTot) return null;
  const verval = new Date(koppeling.geldigTot);
  if (isNaN(verval.getTime())) return null;
  const msPerDag = 24 * 60 * 60 * 1000;
  return Math.ceil((verval - new Date()) / msPerDag);
}

// ─── STATE INITIALISATIE (identiek aan origineel) ──────────────────────────
// Het jaar stond hier vast op '2025'. Dat is een dode waarde zodra het
// kalenderjaar verder loopt: bij elke refresh viel de app terug op een jaar
// waarin niets meer gebeurt. Nu volgt hij de klok, zodat 2026 vanzelf 2027
// wordt zonder dat er iets aangepast hoeft te worden.
state.huidigJaar = String(new Date().getFullYear());
state.hnviSellId = null;
state.editTxId = null;
state.editCoverId = null;
state.editFactuurId = null;
state.editRitId = null;
state.editActivumId = null;
state.hnviLaatsteDatum = new Date().toISOString().split('T')[0];
state.hnviImportItems = [];

// ─── FASE 3A: HYBRID DATA LOADING ────────────────────────────────────────
/**
 * Load boekingen from Supabase OR localStorage (fallback)
 * Called after auth is complete
 * 
 * Flow:
 * 1. Try Supabase (RLS filters to current user)
 * 2. If fail/timeout: Fall back to localStorage
 * 3. Load pending queue for recovery
 * 4. Retry syncing pending items
 */
export async function loadDataHybrid() {
  console.log('📦 Loading data (hybrid: Supabase → localStorage fallback)...');
  
  // Try Supabase first
  if (isSupabaseReady()) {
    try {
      console.log('🔄 Attempting to load from Supabase...');
      const result = await loadBoekingenFromSupabase();
      const hnviData = await loadHnviFromSupabase();
      const coversData = await loadCoversFromSupabase();
      const relatiesData = await loadRelatiesFromSupabase();
      const bankKoppelingenData = await loadBankKoppelingenFromSupabase();

      if (result && (result.TX.length > 0 || result.HIST_TX.length > 0)) {
        state.TX = result.TX;
        state.HIST_TX = result.HIST_TX;
        state.loadedFromSupabase = true;
        console.log(`✅ Data loaded from Supabase: ${state.TX.length} TX + ${state.HIST_TX.length} HIST_TX`);
      } else if (result) {
        // Empty result but no error = first time or no data
        console.log('ℹ️  Supabase empty (first time?), loading from localStorage');
        state.TX = load('xtenate_tx', JSON.parse(JSON.stringify(TX_INIT)));
        state.HIST_TX = load('xtenate_hist_tx_override', JSON.parse(JSON.stringify(HIST_TX_DEFAULT)));
        state.loadedFromSupabase = false;
      }
      
      // HNVI en Covers
      if (hnviData && hnviData.length > 0) {
        state.HNVI_LOTS = hnviData;
        console.log(`✅ HNVI loaded from Supabase: ${hnviData.length} loten`);
      } else {
        state.HNVI_LOTS = load('xtenate_hnvi', []);
      }
      
      if (coversData && coversData.length > 0) {
        state.COVERS = coversData;
        console.log(`✅ Covers loaded from Supabase: ${coversData.length} artikelen`);
      } else {
        state.COVERS = load('xtenate_covers', []);
      }

      // Relaties (fase 4a): zelfde terugval-patroon als HNVI/Covers hierboven.
      if (relatiesData && relatiesData.length > 0) {
        state.RELATIES = relatiesData;
        saveRelatiesCache();
        console.log(`✅ Relaties uit Supabase: ${relatiesData.length}`);
      } else {
        state.RELATIES = load('xtenate_relaties_cache', []);
      }

      // Bankkoppelingen (fase 4b-1): geen lokale cache, in tegenstelling tot
      // hierboven — session_id/account_uid horen niet in localStorage, en
      // zonder koppeling is een lege lijst gewoon de juiste stand.
      state.BANK_KOPPELINGEN = bankKoppelingenData || [];
      console.log(`✅ Bankkoppelingen uit Supabase: ${state.BANK_KOPPELINGEN.length}`);
    } catch (err) {
      console.warn(`⚠️  Supabase load failed: ${err.message}, falling back to localStorage`);
      state.TX = load('xtenate_tx', JSON.parse(JSON.stringify(TX_INIT)));
      state.HIST_TX = load('xtenate_hist_tx_override', JSON.parse(JSON.stringify(HIST_TX_DEFAULT)));
      state.HNVI_LOTS = load('xtenate_hnvi', []);
      state.COVERS = load('xtenate_covers', []);
      state.RELATIES = load('xtenate_relaties_cache', []);
      state.BANK_KOPPELINGEN = [];
      state.loadedFromSupabase = false;
    }
  } else {
    // Supabase not ready
    console.log('⚠️  Supabase not ready, loading from localStorage');
    state.TX = load('xtenate_tx', JSON.parse(JSON.stringify(TX_INIT)));
    state.HIST_TX = load('xtenate_hist_tx_override', JSON.parse(JSON.stringify(HIST_TX_DEFAULT)));
    state.HNVI_LOTS = load('xtenate_hnvi', []);
    state.COVERS = load('xtenate_covers', []);
    state.RELATIES = load('xtenate_relaties_cache', []);
    state.BANK_KOPPELINGEN = [];
    state.loadedFromSupabase = false;
  }
  
  // Losse lijstjes (groepen, facturen, tellers) terughalen. Deze staan in
  // app_data en zijn niet kritiek: ontbreken ze, dan blijft wat lokaal staat.
  if (isSupabaseReady()) {
    try {
      const extra = await loadAppData();
      if (extra) {
        if (Array.isArray(extra.groepen) && extra.groepen.length) {
          state.GROEPEN = extra.groepen.filter(g => g && g.id && g.naam);
          console.log(`✅ Groepen uit Supabase: ${state.GROEPEN.length}`);
        }
        if (Array.isArray(extra.grootboek) && extra.grootboek.length) {
          state.GROOTBOEK = extra.grootboek.filter(g => g && g.nummer && g.naam);
          console.log(`✅ Grootboek uit Supabase: ${state.GROOTBOEK.length}`);
        }
        if (Array.isArray(extra.rekeningen) && extra.rekeningen.length) {
          state.REKENINGEN = extra.rekeningen.filter(r => r && r.nummer && r.naam);
          console.log(`✅ Rekeningen uit Supabase: ${state.REKENINGEN.length}`);
        }
        if (extra.facturen && Array.isArray(extra.facturen.lijst)) {
          state.FACTUREN = extra.facturen.lijst;
          if (Number(extra.facturen.volgende) > 0) state.nxtFactuur = Number(extra.facturen.volgende);
          console.log(`✅ Facturen uit Supabase: ${state.FACTUREN.length}`);
        }
        if (extra.factuur_instellingen) {
          FACTUUR_INSTELLINGEN = { ...FACTUUR_INSTELLINGEN, ...extra.factuur_instellingen };
        }
        if (extra.controle_instellingen) {
          CONTROLE_INSTELLINGEN = { ...CONTROLE_INSTELLINGEN, ...extra.controle_instellingen };
        }
        if (extra.btw_instellingen) {
          BTW_INSTELLINGEN = { ...BTW_INSTELLINGEN, ...extra.btw_instellingen };
        }
        if (extra.bedrijfsgegevens) {
          BEDRIJFSGEGEVENS = { ...BEDRIJFSGEGEVENS, ...extra.bedrijfsgegevens };
        }
        if (extra.km_instellingen) {
          KM_INSTELLINGEN = { ...KM_INSTELLINGEN, ...extra.km_instellingen };
        }
        if (extra.ritten && Array.isArray(extra.ritten.lijst)) {
          state.RITTEN = extra.ritten.lijst;
          if (Number(extra.ritten.volgende) > 0) state.nxtRit = Number(extra.ritten.volgende);
          console.log(`✅ Ritten uit Supabase: ${state.RITTEN.length}`);
        }
        if (extra.activa && Array.isArray(extra.activa.lijst)) {
          state.ACTIVA = extra.activa.lijst;
          if (Number(extra.activa.volgende) > 0) state.nxtActivum = Number(extra.activa.volgende);
          console.log(`✅ Activa uit Supabase: ${state.ACTIVA.length}`);
        }
        if (extra.hnvi_datums && typeof extra.hnvi_datums === 'object') {
          state.HNVI_DATUMS = { ...extra.hnvi_datums, ...state.HNVI_DATUMS };
          save('xtenate_hnvi_datums', state.HNVI_DATUMS);
        }
        pasHnviDatumsToe();
        if (Array.isArray(extra.vergrendeld)) {
          state.VERGRENDELD = [...new Set([...extra.vergrendeld, ...(state.VERGRENDELD || [])])].sort();
          save('xtenate_vergrendeld', state.VERGRENDELD);
        }
        if (extra.veiling && typeof extra.veiling === 'object') {
          state.VEILING = extra.veiling;
          save('xtenate_veiling', state.VEILING);
          console.log('✅ Veiling uit Supabase');
        }
        // Tellers: het hoogste getal wint, zodat twee apparaten nooit
        // hetzelfde id uitdelen aan verschillende dingen.
        const t = extra.tellers || {};
        if (Number(t.tx) > state.nxtTx) state.nxtTx = Number(t.tx);
        if (Number(t.cover) > state.nxtCover) state.nxtCover = Number(t.cover);
        if (Number(t.hnvi) > state.nxtHnvi) state.nxtHnvi = Number(t.hnvi);
      }
    } catch (err) {
      console.warn('Losse appgegevens laden mislukt:', err.message);
    }
  }

  // Load pending queue (recovery from offline changes)
  loadPendingQueue();
  const pendingCount = Object.keys(pendingQueue).length;
  if (pendingCount > 0) {
    console.log(`⏳ Found ${pendingCount} pending items, attempting sync...`);
    await syncPendingQueue().catch(err => 
      console.warn('Pending sync failed:', err)
    );
  }
  
  state.dataKlaar = true;
  console.log('✅ Data loading complete');
}
