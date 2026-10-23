// herstel.js — berekent wat een herstel zou opleveren. Deze versie kán niet
// wijzigen: er staat geen enkele schrijfactie in.
//
// Geen setItem, geen removeItem, geen save(), geen aanpassing van `state`,
// geen Supabase. De uitvoerende helft wordt pas gebouwd nadat de preview is
// goedgekeurd. Zolang dat niet zo is, is dit bestand met opzet machteloos.
//
// Wat het herstel straks moet doen, en waarom:
//
// 1. De historie 2022-2025 uit de code terugzetten. Bij jou staat alleen 2022
//    nog in de browser; 2023, 2024 en 2025 zijn afgedekt door een import.
//
// 2. De datums van 2022 corrigeren. De Excel-import zette elke datum één dag
//    te vroeg weg (tijdzonefout in `excelDate`), bevestigd tegen het
//    bankafschrift: de Bol.com-betaling van 98,22 hoort op 2 augustus 2022.
//
// 3. De boekingen die alleen in de browser staan behouden — maar mét dezelfde
//    datumcorrectie. Dat is het gevoelige punt. Die dertien regels van 2022
//    zijn privé-stortingen die bij een creditcard-uitgave op dezelfde dag
//    horen. Corrigeer je de uitgave wel en de storting niet, dan vallen de
//    paren uit elkaar en schuiven Internet en Reiskosten over de jaargrens.

import { HIST_TX_DEFAULT, HOME_TOTALS, MAAND_SALDOS, MAAND_SALDOS_DEFAULT, CONTROLE_INSTELLINGEN, state }
  from './storage.js?v=20261023r';

const HISTORISCHE_JAREN = ['2022', '2023', '2024', '2025'];
const HUIDIG_JAAR = '2026';

/** Alle sleutels die deze app in de browser gebruikt. */
export const OPSLAGSLEUTELS = [
  'xtenate_tx', 'xtenate_hist_tx_override', 'xtenate_covers', 'xtenate_hnvi',
  'xtenate_voorraad_groepen', 'xtenate_maand_saldos_override',
  'xtenate_home_totals_override', 'xtenate_controle_negeer',
  'xtenate_nxtTx', 'xtenate_nxtCover', 'xtenate_thema', 'xtenate_menu_ingeklapt'
];

/**
 * Een verschuiving wordt alleen toegepast als álle gekoppelde boekingen van
 * dat jaar dezelfde afwijking hebben, en er genoeg zijn om van een patroon te
 * spreken. Bij twijfel gebeurt er niets en wordt het jaar gemeld.
 */
const MINIMUM_KOPPELINGEN = 5;
const MAX_DAGEN = 31;

const jaarVan = t => String(t && t.datum || '').slice(0, 4);
const geldigeDatum = t => /^\d{4}-\d{2}-\d{2}$/.test(String(t && t.datum || ''));

/** Volledig kenmerk, inclusief datum. */
const kenmerk = t => [
  t.datum, Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek), String(t.type),
  String(t.naam || '').trim().toLowerCase(), String(t.omschr || '').trim().toLowerCase()
].join('|');

/** Kenmerk zonder datum: hiermee vinden we dezelfde boeking op een andere dag. */
const kenmerkZonderDatum = t => [
  Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek), String(t.type),
  String(t.naam || '').trim().toLowerCase(), String(t.omschr || '').trim().toLowerCase()
].join('|');

const dagenTussen = (a, b) =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

const verschuif = (datum, dagen) => {
  const d = new Date(datum + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dagen);
  return d.toISOString().slice(0, 10);
};

export const beschrijf = t =>
  `${t.datum} · ${t.naam || t.omschr || '(geen naam)'} · ${Number(t.bedrag).toFixed(2)}`;

/**
 * Koppelt mijn boekingen aan die uit de code. Binnen een groep met hetzelfde
 * kenmerk worden beide kanten op datum gesorteerd en op volgorde naast elkaar
 * gelegd — niet op kortste afstand. Dat laatste gaat mis bij reeksen: vijftien
 * keer PostNL van 6,75 in één jaar, waarbij de een dan de partner van de ander
 * inpikt en er verschuivingen van drie of vier dagen uit de lucht komen vallen.
 */
function koppel(vanMij, vanCode) {
  const gekoppeld = [];
  const mijnOver = [];
  const codeOver = [];

  const groepeer = lijst => {
    const m = new Map();
    lijst.forEach(t => {
      const k = kenmerkZonderDatum(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    });
    return m;
  };
  const opDatum = (a, b) => String(a.datum).localeCompare(String(b.datum));
  const mijnGroepen = groepeer(vanMij);
  const codeGroepen = groepeer(vanCode);

  new Set([...mijnGroepen.keys(), ...codeGroepen.keys()]).forEach(k => {
    const a = (mijnGroepen.get(k) || []).slice().sort(opDatum);
    const b = (codeGroepen.get(k) || []).slice().sort(opDatum);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (!geldigeDatum(a[i])) { mijnOver.push(a[i]); i++; continue; }
      const dagen = dagenTussen(a[i].datum, b[j].datum);
      if (Math.abs(dagen) <= MAX_DAGEN) { gekoppeld.push({ mijn: a[i], code: b[j], dagen }); i++; j++; }
      else if (dagen < 0) { mijnOver.push(a[i]); i++; }
      else { codeOver.push(b[j]); j++; }
    }
    while (i < a.length) mijnOver.push(a[i++]);
    while (j < b.length) codeOver.push(b[j++]);
  });

  return { gekoppeld, mijnOver, codeOver };
}

/** Rekent één historisch jaar door. Wijzigt niets. */
function planJaar(jaar, vanMij, vanCode) {
  const { gekoppeld, mijnOver, codeOver } = koppel(vanMij, vanCode);

  // Is er één systematische verschuiving, of lopen de afwijkingen door elkaar?
  const afwijkingen = [...new Set(gekoppeld.map(g => g.dagen))];
  const eenduidig = gekoppeld.length >= MINIMUM_KOPPELINGEN && afwijkingen.length === 1;
  const verschuiving = eenduidig ? -afwijkingen[0] : 0;   // wat er bij mijn datums op moet
  const verschoven = gekoppeld.filter(g => g.dagen !== 0);

  // De gekoppelde boekingen komen uit de code, want die heeft de juiste datum.
  const uitCode = gekoppeld.map(g => ({ ...g.code }));

  // Alles wat alleen bij mij staat blijft behouden. Is er een eenduidige
  // verschuiving vastgesteld, dan krijgen deze regels dezelfde correctie: ze
  // komen uit dezelfde import en dragen dus dezelfde fout. Zo blijven de
  // privé-stortingen op dezelfde dag staan als de uitgave waar ze bij horen.
  const eigen = mijnOver.map(t => (verschuiving && geldigeDatum(t)
    ? { ...t, datum: verschuif(t.datum, verschuiving), datumWas: t.datum }
    : { ...t }));

  const ontbrekend = codeOver.map(t => ({ ...t }));
  const regels = [...uitCode, ...ontbrekend, ...eigen]
    .sort((a, b) => String(a.datum).localeCompare(String(b.datum)));

  // Controle: elke regel van mij moet terug te vinden zijn in de uitkomst.
  const tel = lijst => {
    const m = new Map();
    lijst.forEach(t => m.set(kenmerk(t), (m.get(kenmerk(t)) || 0) + 1));
    return m;
  };
  const naTelling = tel(regels);
  const verwachtVanMij = tel(vanMij.map(t => (verschuiving && geldigeDatum(t)
    ? { ...t, datum: verschuif(t.datum, verschuiving) } : t)));
  let kwijt = 0;
  verwachtVanMij.forEach((n, k) => { if ((naTelling.get(k) || 0) < n) kwijt += n - (naTelling.get(k) || 0); });
  const codeTelling = tel(vanCode);
  let codeKwijt = 0;
  codeTelling.forEach((n, k) => { if ((naTelling.get(k) || 0) < n) codeKwijt += n - (naTelling.get(k) || 0); });

  // Identieke boekingen die echt meerdere keren bestaan, met hun aantal na afloop.
  const dubbelen = [];
  tel(vanMij).forEach((n, k) => {
    if (n < 2) return;
    const voorbeeld = vanMij.find(t => kenmerk(t) === k);
    const naK = verschuiving && geldigeDatum(voorbeeld)
      ? kenmerk({ ...voorbeeld, datum: verschuif(voorbeeld.datum, verschuiving) }) : k;
    dubbelen.push({ aantal: n, na: naTelling.get(naK) || 0, voorbeeld });
  });

  return {
    jaar,
    nu: vanMij.length,
    inCode: vanCode.length,
    gekoppeld: gekoppeld.length,
    verschoven: verschoven.length,
    verschuiving,
    eenduidig,
    afwijkingen,
    eigen: eigen.length,
    eigenVoorbeelden: eigen.slice(0, 15),
    ontbrekend: ontbrekend.length,
    na: regels.length,
    kwijt,
    codeKwijt,
    dubbelen,
    regels
  };
}

const OMZET_GB = ['8000', '8010', '8020'];
/** Telt de hoofdcijfers van een lijst boekingen, zoals de app dat ook doet. */
function metrics(lijst) {
  const som = f => lijst.filter(f).reduce((s, t) => s + Number(t.bedrag), 0);
  return {
    omzet: som(t => t.type === 'inkomst' && OMZET_GB.includes(String(t.gb))),
    kosten: som(t => t.type === 'uitgave'),
    priveOp: som(t => t.type === 'prive_opname'),
    priveSt: som(t => t.type === 'prive_storting')
  };
}

/**
 * De volledige preview. Leest en rekent; verandert niets.
 */
export function herstelPreview() {
  const nuHistorisch = Array.isArray(state.HIST_TX) ? state.HIST_TX : [];
  const nuHuidig = Array.isArray(state.TX) ? state.TX : [];

  const jaren = HISTORISCHE_JAREN.map(jaar => planJaar(
    jaar,
    nuHistorisch.filter(t => jaarVan(t) === jaar),
    HIST_TX_DEFAULT.filter(t => jaarVan(t) === jaar)
  ));

  // Boekingen in de historie die buiten 2022-2025 vallen, blijven ongemoeid.
  const buitenBereik = nuHistorisch.filter(t => !HISTORISCHE_JAREN.includes(jaarVan(t)));
  const nieuweHistorie = [...jaren.flatMap(j => j.regels), ...buitenBereik];

  // Het lopende jaar wordt niet aangeraakt, maar we melden wel wat erin zit.
  const perJaarInTx = {};
  nuHuidig.forEach(t => {
    const j = jaarVan(t) || 'geen datum';
    perJaarInTx[j] = (perJaarInTx[j] || 0) + 1;
  });
  const buitenHuidigJaar = nuHuidig.filter(t => jaarVan(t) !== HUIDIG_JAAR);
  const telTx = new Map();
  nuHuidig.forEach(t => telTx.set(kenmerk(t), (telTx.get(kenmerk(t)) || 0) + 1));
  const identiekInTx = [...telTx.entries()].filter(([, n]) => n > 1)
    .map(([k, n]) => ({ aantal: n, voorbeeld: nuHuidig.find(t => kenmerk(t) === k) }));

  // Jaartotalen: HOME_TOTALS is de Excel-waarde zoals die nu leeft in de app
  // (ingelezen via een eerdere import, zie storage.js) en is leidend. We tonen
  // erbij wat de boekingen zelf opleveren, zodat een verschil zichtbaar is in
  // plaats van verstopt. Er was hier eerder ook een vergelijking met
  // HOME_TOTALS_DEFAULT — een in de broncode bevroren kopie die alleen als
  // noodgreep diende als de browser-opslag leeg was. Die dataset is sinds de
  // privacy-opschoning blijvend leeg, dus die vergelijking verviel.
  const jaartotalen = Object.keys(HOME_TOTALS).sort().map(jaar => {
    const nu = HOME_TOTALS[jaar] || null;
    const regelsVanJaar = jaar === HUIDIG_JAAR
      ? nuHuidig.filter(t => jaarVan(t) === jaar)
      : nieuweHistorie.filter(t => jaarVan(t) === jaar);
    const berekend = metrics(regelsVanJaar);
    const velden = ['omzet', 'kosten', 'priveOp', 'priveSt'];
    return {
      jaar,
      nu,
      berekend,
      afwijking: nu ? Object.fromEntries(velden.map(v => [v, +(berekend[v] - (nu[v] ?? 0)).toFixed(2)])) : null
    };
  });

  const totaalNu = nuHistorisch.length + nuHuidig.length;
  const totaalNa = nieuweHistorie.length + nuHuidig.length;

  return {
    jaren,
    perJaarNa: Object.fromEntries(jaren.map(j => [j.jaar, j.na])),
    historieNa: nieuweHistorie.length,
    totaalNu,
    totaalNa,
    huidigJaar: {
      aantal: nuHuidig.length,
      perJaar: perJaarInTx,
      buitenHuidigJaar,
      identiek: identiekInTx,
      identiekExtra: identiekInTx.reduce((s, x) => s + x.aantal - 1, 0)
    },
    jaartotalen,
    maandsaldi: { nu: Object.keys(MAAND_SALDOS).length, na: Object.keys(MAAND_SALDOS_DEFAULT).length },
    onaangeroerd: {
      voorraadartikelen: (state.COVERS || []).length,
      productgroepen: (state.GROEPEN || []).length,
      hnviLoten: (state.HNVI_LOTS || []).length
    },
    // De uitkomsten van de ingebouwde controles, zodat het scherm ze kan tonen
    // in plaats van dat je ze op mijn woord moet geloven.
    controles: bouwControles(jaren, nieuweHistorie, nuHuidig, totaalNa)
  };
}

function bouwControles(jaren, nieuweHistorie, nuHuidig, totaalNa) {
  const j = jaar => jaren.find(x => x.jaar === jaar) || {};
  const uit = [];
  const zet = (titel, goed, waarde) => uit.push({ titel, goed, waarde });

  zet('2022 komt uit op 71 boekingen', j('2022').na === 71, String(j('2022').na));
  zet('2023 komt uit op 86 boekingen', j('2023').na === 86, String(j('2023').na));
  zet('2024 komt uit op 107 boekingen', j('2024').na === 107, String(j('2024').na));
  zet('2025 komt uit op 222 boekingen', j('2025').na === 222, String(j('2025').na));
  zet('2026 blijft op 219 boekingen',
    (nuHuidig.filter(t => jaarVan(t) === HUIDIG_JAAR)).length === 219,
    String(nuHuidig.filter(t => jaarVan(t) === HUIDIG_JAAR).length));
  zet('Totaal komt uit op 706 boekingen', totaalNa === 706, String(totaalNa));

  const v22 = j('2022');
  zet('De 58 verschoven regels van 2022 worden één dag gecorrigeerd',
    v22.verschoven === 58 && v22.verschuiving === 1,
    `${v22.verschoven} regels, correctie ${v22.verschuiving >= 0 ? '+' : ''}${v22.verschuiving} dag`);
  zet('De 13 eigen privé-stortingen blijven behouden',
    v22.eigen === 13, `${v22.eigen} regels`);

  const nullen = nieuweHistorie.filter(t =>
    Number(t.bedrag) === 0 && String(t.datum).startsWith('2022-08'));
  zet('De vier €0,00-boekingen blijven alle vier bestaan',
    nullen.length === 4 && nullen.every(t => t.datum === '2022-08-02'),
    `${nullen.length} stuks op ${[...new Set(nullen.map(t => t.datum))].join(', ') || '—'}`);

  const dub = jaren.flatMap(x => x.dubbelen);
  zet('Identieke echte boekingen worden niet samengevoegd',
    dub.length > 0 && dub.every(d => d.na === d.aantal),
    dub.map(d => `${d.aantal}× blijft ${d.na}×`).join(', ') || 'geen gevonden');

  zet('Er raakt geen enkele boeking van jou kwijt',
    jaren.every(x => x.kwijt === 0), String(jaren.reduce((s, x) => s + x.kwijt, 0)) + ' kwijt');
  zet('Er ontbreekt geen enkele boeking uit de code',
    jaren.every(x => x.codeKwijt === 0), String(jaren.reduce((s, x) => s + x.codeKwijt, 0)) + ' ontbreekt');

  const st22 = nieuweHistorie.filter(t => t.datum.startsWith('2022') && t.type === 'prive_storting');
  const op22 = nieuweHistorie.filter(t => t.datum.startsWith('2022') && t.type === 'prive_opname');
  const somSt = st22.reduce((s, t) => s + Number(t.bedrag), 0);
  const somOp = op22.reduce((s, t) => s + Number(t.bedrag), 0);
  zet('2022 privé-opnames volgens de boekingen: € 250,00',
    Math.abs(somOp - 250) < 0.01, '€ ' + somOp.toFixed(2));
  // Referentie komt uit CONTROLE_INSTELLINGEN (Beheer). Vergeleken wordt met
  // HOME_TOTALS (de huidige, live stand) — HOME_TOTALS_DEFAULT bevat sinds de
  // opschoning geen jaartotalen meer om tegen te vergelijken. Staat de
  // instelling nog leeg, dan slaat deze controle over.
  const referentiePriveSt2022 = CONTROLE_INSTELLINGEN?.jaartotaal2022PriveSt;
  if (referentiePriveSt2022 != null) {
    zet(`2022 privé-stortingen volgens het jaartotaal: € ${referentiePriveSt2022.toFixed(2).replace('.', ',')}`,
      Math.abs((HOME_TOTALS['2022']?.priveSt ?? 0) - referentiePriveSt2022) < 0.01,
      '€ ' + Number(HOME_TOTALS['2022']?.priveSt ?? 0).toFixed(2));
  }
  zet('2022 privé-stortingen volgens de 13 boekingen', null, '€ ' + somSt.toFixed(2));

  // Elke privé-storting van 2022 moet op dezelfde dag staan als de uitgave
  // waar hij bij hoort; dat is de reden dat de correctie ook op deze regels valt.
  let los = 0;
  st22.forEach(st => {
    const partner = nieuweHistorie.find(t => t.type === 'uitgave' && String(t.rek) === '1030'
      && t.datum === st.datum && Math.abs(Number(t.bedrag) - Number(st.bedrag)) < 0.005);
    if (!partner) los++;
  });
  zet('Elke privé-storting staat op dezelfde dag als zijn uitgave',
    los === 0, `${st22.length - los} van ${st22.length} gekoppeld`);

  return uit;
}
