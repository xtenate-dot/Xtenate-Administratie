// migratie.js — de overstap van lokale opslag naar Supabase.
//
// Dit bestand bouwt het migratieplan en voert de proefmigratie uit. Er wordt in
// deze fase niets naar Supabase geschreven: `bouwPlan` leest alleen, en
// `dryRun` vergelijkt dat plan met wat er nu in de database staat.
//
// De bron van waarheid is en blijft de lokale administratie. Er wordt nergens
// iets uit localStorage verwijderd of overschreven.

import {
  BEGINSALDO_2026, calcIB, isInkomst, isOmzet, isUitgave, teltBij
} from './helpers.js?v=20261025e';
import {
  HIST_TX_DEFAULT, HOME_TOTALS, HOME_TOTALS_DEFAULT, MAAND_SALDOS, state,
  grootboekNamen, rekeningNamen
} from './storage.js?v=20261025e';
import { verborgenOverzicht } from './negeren.js?v=20261025e';
import { getClient, leesbareFout } from './supabase.js?v=20261025e';

const HOOFDREKENING = '1010';

/** Alle boekingen, met het jaar er los bij. */
function alleBoekingen() {
  return [...state.HIST_TX, ...state.TX].map(t => ({ ...t, jaar: String(t.datum || '').slice(0, 4) }));
}

// ------------------------------------------------------------------ diagnose

/**
 * Leest de ruwe opslag uit, zonder oordeel. Bedoeld om te kunnen zien wat er
 * werkelijk in deze browser staat wanneer de cijfers onverwacht zijn.
 */
export function diagnose() {
  const perJaar = lijst => {
    const uit = {};
    (lijst || []).forEach(t => {
      const j = String(t.datum || '').slice(0, 4) || 'geen datum';
      uit[j] = (uit[j] || 0) + 1;
    });
    return uit;
  };

  const leesSleutel = sleutel => {
    let ruw = null;
    try { ruw = localStorage.getItem(sleutel); } catch { /* opslag niet leesbaar */ }
    if (ruw === null) return { sleutel, aanwezig: false, tekens: 0, waarde: null };
    let waarde = null;
    try { waarde = JSON.parse(ruw); } catch { /* geen geldige JSON */ }
    return { sleutel, aanwezig: true, tekens: ruw.length, waarde };
  };

  // ---- de vier bronnen van boekingen ----
  const tx = leesSleutel('xtenate_tx');
  const hist = leesSleutel('xtenate_hist_tx_override');

  const bronnen = [
    { naam: 'xtenate_tx (browser)', soort: 'browser',
      aanwezig: tx.aanwezig, aantal: tx.waarde?.length ?? 0, perJaar: perJaar(tx.waarde) },
    { naam: 'xtenate_hist_tx_override (browser)', soort: 'browser',
      aanwezig: hist.aanwezig, aantal: hist.waarde?.length ?? 0, perJaar: perJaar(hist.waarde) },
    { naam: 'HIST_TX_DEFAULT (in de code)', soort: 'code',
      aanwezig: true, aantal: HIST_TX_DEFAULT.length, perJaar: perJaar(HIST_TX_DEFAULT) },
    { naam: 'In gebruik door de app', soort: 'actief',
      aanwezig: true, aantal: state.TX.length + state.HIST_TX.length,
      perJaar: perJaar([...state.TX, ...state.HIST_TX]) }
  ];

  // ---- welke jaren zijn afgedekt door de override? ----
  const inDefault = perJaar(HIST_TX_DEFAULT);
  const inGebruik = perJaar([...state.TX, ...state.HIST_TX]);
  const afgedekt = Object.keys(inDefault)
    .filter(j => (inGebruik[j] || 0) < inDefault[j])
    .map(j => ({ jaar: j, inCode: inDefault[j], inGebruik: inGebruik[j] || 0 }));

  // ---- jaartotalen: wat staat er, en wat zou het moeten zijn? ----
  const jaartotalen = [...new Set([...Object.keys(HOME_TOTALS), ...Object.keys(HOME_TOTALS_DEFAULT)])]
    .sort().map(jaar => {
      const nu = HOME_TOTALS[jaar] || {};
      const standaard = HOME_TOTALS_DEFAULT[jaar] || {};
      const velden = ['omzet', 'kosten', 'priveOp', 'priveSt'];
      return {
        jaar,
        nu: Object.fromEntries(velden.map(v => [v, nu[v] ?? null])),
        standaard: Object.fromEntries(velden.map(v => [v, standaard[v] ?? null])),
        wijktAf: velden.some(v => Math.abs((nu[v] ?? 0) - (standaard[v] ?? 0)) > 0.01),
        negatief: velden.filter(v => Number(nu[v]) < 0)
      };
    });

  // ---- maandsaldi ----
  const maandenNu = {};
  Object.keys(MAAND_SALDOS).forEach(mnd => { (maandenNu[mnd.slice(0, 4)] ||= []).push(mnd.slice(5)); });

  return {
    opslag: ['xtenate_tx', 'xtenate_hist_tx_override', 'xtenate_covers', 'xtenate_hnvi',
             'xtenate_voorraad_groepen', 'xtenate_maand_saldos_override',
             'xtenate_home_totals_override', 'xtenate_controle_negeer']
      .map(s => {
        const g = leesSleutel(s);
        return {
          sleutel: s, aanwezig: g.aanwezig, tekens: g.tekens,
          aantal: Array.isArray(g.waarde) ? g.waarde.length
                : g.waarde && typeof g.waarde === 'object' ? Object.keys(g.waarde).length : null
        };
      }),
    bronnen,
    afgedekt,
    overrideActief: hist.aanwezig,
    txBuitenJaar: state.TX.filter(t => !String(t.datum || '').startsWith('2026')).length,
    txBuitenJaarPerJaar: perJaar(state.TX.filter(t => !String(t.datum || '').startsWith('2026'))),
    histIn2026: state.HIST_TX.filter(t => String(t.datum || '').startsWith('2026')).length,
    jaartotalen,
    maandenPerJaar: Object.fromEntries(Object.entries(maandenNu).map(([j, m]) => [j, m.sort()])),
    maandenTotaal: Object.keys(MAAND_SALDOS).length,
    artikelen: state.COVERS.length,
    artikelenZonderKostprijs: state.COVERS.filter(c => c.inkoopprijs == null || c.inkoopprijs === '').length,
    stuks: state.COVERS.reduce((s, c) => s + (Number(c.voorraad) || 0), 0),
    groepen: state.GROEPEN.map(g => g.naam),
    loten: state.HNVI_LOTS.length
  };
}

/** Diagnose als platte tekst, om te kunnen doorsturen. */
export function diagnoseAlsTekst(d) {
  const r = ['DIAGNOSE LOKALE OPSLAG — ' + new Date().toLocaleString('nl-NL'), ''];
  const jaren = ['2022', '2023', '2024', '2025', '2026'];

  r.push('BOEKINGEN PER BRON EN PER JAAR');
  r.push('Bron'.padEnd(38) + jaren.map(j => j.padStart(7)).join('') + '   totaal');
  d.bronnen.forEach(b => r.push(
    (b.aanwezig ? b.naam : b.naam + ' [AFWEZIG]').padEnd(38) +
    jaren.map(j => String(b.perJaar[j] ?? 0).padStart(7)).join('') +
    String(b.aantal).padStart(9)));

  r.push('');
  r.push('ZIJN 2023 EN 2024 NOG ERGENS AANWEZIG?');
  if (!d.afgedekt.length) {
    r.push('  Elk jaar is in de app even volledig als in de code.');
  } else {
    d.afgedekt.forEach(a => r.push(
      `  ${a.jaar}: in de code ${a.inCode} boekingen, in de app ${a.inGebruik} — ${a.inCode - a.inGebruik} afgedekt`));
    r.push('  De boekingen staan dus nog in de code en zijn niet verdwenen.');
  }
  r.push(`  xtenate_hist_tx_override aanwezig: ${d.overrideActief ? 'JA — die overstemt de code' : 'nee'}`);

  r.push('');
  r.push('BOEKINGEN IN DE VERKEERDE BAK');
  r.push(`  Niet-2026 boekingen in xtenate_tx : ${d.txBuitenJaar} ` +
    (d.txBuitenJaar ? `(${Object.entries(d.txBuitenJaarPerJaar).map(([j, n]) => j + ': ' + n).join(', ')})` : ''));
  r.push(`  2026-boekingen in de historie      : ${d.histIn2026}`);

  r.push('');
  r.push('JAARTOTALEN — nu in de app tegenover de standaard in de code');
  d.jaartotalen.forEach(t => {
    r.push(`  ${t.jaar}${t.wijktAf ? '  WIJKT AF' : ''}${t.negatief.length ? '  NEGATIEF: ' + t.negatief.join(', ') : ''}`);
    r.push(`     nu        omzet ${String(t.nu.omzet).padStart(10)}  kosten ${String(t.nu.kosten).padStart(10)}` +
           `  priveOp ${String(t.nu.priveOp).padStart(10)}  priveSt ${String(t.nu.priveSt).padStart(10)}`);
    r.push(`     standaard omzet ${String(t.standaard.omzet).padStart(10)}  kosten ${String(t.standaard.kosten).padStart(10)}` +
           `  priveOp ${String(t.standaard.priveOp).padStart(10)}  priveSt ${String(t.standaard.priveSt).padStart(10)}`);
  });

  r.push('');
  r.push(`MAANDSALDI — ${d.maandenTotaal} maanden (standaard zijn er 39)`);
  Object.entries(d.maandenPerJaar).sort().forEach(([j, m]) => r.push(`  ${j}: ${m.join(' ')}`));

  r.push('');
  r.push('VOORRAAD');
  r.push(`  artikelen ${d.artikelen}, waarvan zonder kostprijs ${d.artikelenZonderKostprijs}`);
  r.push(`  stuks ${d.stuks}, HNVI-loten ${d.loten}`);
  r.push(`  groepen: ${d.groepen.join(', ')}`);

  r.push('');
  r.push('OPSLAGSLEUTELS IN DEZE BROWSER');
  d.opslag.forEach(o => r.push(`  ${o.sleutel.padEnd(32)} ${o.aanwezig ? 'aanwezig' : 'AFWEZIG '} ` +
    `${o.aantal != null ? String(o.aantal).padStart(5) + ' regels' : '           '}  ${o.tekens} tekens`));

  return r.join('\n');
}

// ------------------------------------------------------------------ het plan

/**
 * Zet de hele lokale administratie om in een plan: wat zou er per tabel naar
 * Supabase gaan. Leest uitsluitend; verandert niets.
 */
export function bouwPlan() {
  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();
  const boekingen = alleBoekingen();

  const jaren = [...new Set(boekingen.map(t => t.jaar).filter(Boolean))].sort();
  const perJaar = jaren.map(jaar => ({
    jaar,
    aantal: boekingen.filter(t => t.jaar === jaar).length
  }));

  // Grootboeknummers die in de boekingen voorkomen
  const gebruikteNummers = [...new Set(boekingen.map(t => t.gb).filter(Boolean))].sort();
  const ontbrekendeNummers = gebruikteNummers.filter(nr => !GBNM[nr]);

  // Bankrekeningen die in de boekingen voorkomen
  const gebruikteRekeningen = [...new Set(boekingen.map(t => t.rek).filter(Boolean))].sort();
  const ontbrekendeRekeningen = gebruikteRekeningen.filter(nr => !REKNM[nr]);

  const maandsaldi = Object.entries(MAAND_SALDOS)
    .filter(([, v]) => v && (v.begin != null || v.eind != null))
    .map(([maand, v]) => ({ maand, ...v }));

  const jaartotalen = Object.entries(HOME_TOTALS).map(([jaar, v]) => ({ jaar, ...v }));

  const voorraadstanden = [];
  state.COVERS.forEach(c => {
    Object.entries(c.jaren || {}).forEach(([jaar, v]) => {
      if (v.eind == null && v.verkocht == null) return;
      voorraadstanden.push({ artikel: c.artikel, jaar, ...v });
    });
  });

  const verborgen = verborgenOverzicht();

  return {
    boekingen,
    jaren,
    perJaar,
    gebruikteNummers,
    ontbrekendeNummers,
    gebruikteRekeningen,
    ontbrekendeRekeningen,
    maandsaldi,
    jaartotalen,
    productgroepen: state.GROEPEN,
    artikelen: state.COVERS,
    voorraadstanden,
    // Eén beginstandregel per artikel, zoals afgesproken.
    voorraadmutaties: state.COVERS.map(c => ({ artikel: c.artikel, aantal: Number(c.voorraad) || 0 })),
    loten: state.HNVI_LOTS,
    genegeerdeMeldingen: verborgen.meldingen,
    uitgezetteControles: verborgen.controles
  };
}

// --------------------------------------------------------- financiële totalen

/** De cijfers waarop je na de migratie wilt kunnen controleren. */
export function financieleTotalen(plan) {
  const perJaar = plan.jaren.map(jaar => {
    const vanJaar = plan.boekingen.filter(t => t.jaar === jaar);
    const uitExcel = HOME_TOTALS[jaar];

    // Uit de losse boekingen opgeteld
    const omzet = vanJaar.filter(t => isInkomst(t) && isOmzet(t.gb)).reduce((s, t) => s + t.bedrag, 0);
    const kosten = vanJaar.filter(isUitgave).reduce((s, t) => s + t.bedrag, 0);
    const priveOp = vanJaar.filter(t => t.type === 'prive_opname').reduce((s, t) => s + t.bedrag, 0);
    const priveSt = vanJaar.filter(t => t.type === 'prive_storting').reduce((s, t) => s + t.bedrag, 0);

    // De jaartotalen uit "Per Periode" zijn leidend op Home; die nemen we
    // apart mee, zodat een verschil zichtbaar wordt in plaats van verstopt.
    const winst = (uitExcel ? uitExcel.omzet - uitExcel.kosten : omzet - kosten);

    return {
      jaar,
      aantal: vanJaar.length,
      omzet: afronden(omzet),
      kosten: afronden(kosten),
      priveOp: afronden(priveOp),
      priveSt: afronden(priveSt),
      excelOmzet: uitExcel ? afronden(uitExcel.omzet) : null,
      excelKosten: uitExcel ? afronden(uitExcel.kosten) : null,
      excelPriveOp: uitExcel ? afronden(uitExcel.priveOp) : null,
      excelPriveSt: uitExcel ? afronden(uitExcel.priveSt) : null,
      winst: afronden(winst),
      ib: Math.round(calcIB(winst))
    };
  });

  const banksaldo = BEGINSALDO_2026 + state.TX
    .filter(t => t.rek === HOOFDREKENING)
    .reduce((s, t) => s + (teltBij(t) ? t.bedrag : -t.bedrag), 0);

  const inVoorraad = state.HNVI_LOTS.filter(l => l.status === 'voorraad');
  const voorraadwaardeArtikelen = state.COVERS.reduce((s, c) =>
    s + (c.inkoopprijs != null && c.inkoopprijs !== '' ? Number(c.voorraad) * Number(c.inkoopprijs) : 0), 0);

  return {
    perJaar,
    banksaldo: afronden(banksaldo),
    voorraadwaardeArtikelen: afronden(voorraadwaardeArtikelen),
    artikelenZonderKostprijs: state.COVERS.filter(c => c.inkoopprijs == null || c.inkoopprijs === '').length,
    voorraadStuks: state.COVERS.reduce((s, c) => s + (Number(c.voorraad) || 0), 0),
    hnviVoorraadwaarde: afronden(inVoorraad.reduce((s, l) => s + (Number(l.inkoop) || 0), 0)),
    hnviInVoorraad: inVoorraad.length
  };
}

const afronden = n => Math.round(n * 100) / 100;

// ------------------------------------------------------------- waarschuwingen

/**
 * Zoekt vooraf naar regels die de database zou weigeren. Beter nu weten dan
 * halverwege de migratie stuklopen.
 */
export function controleerPlan(plan, stam = null) {
  const punten = [];
  const voegToe = (ernst, titel, aantal, uitleg, voorbeelden = []) =>
    punten.push({ ernst, titel, aantal, uitleg, voorbeelden: voorbeelden.slice(0, 5) });

  const zonderDatum = plan.boekingen.filter(t => !/^\d{4}-\d{2}-\d{2}$/.test(t.datum || ''));
  if (zonderDatum.length) {
    voegToe('fout', 'Boekingen zonder geldige datum', zonderDatum.length,
      'De kolom datum mag niet leeg zijn. Deze regels zouden de migratie laten mislukken.',
      zonderDatum.map(t => `${t.naam || '(geen naam)'} · ${t.bedrag}`));
  }

  const negatief = plan.boekingen.filter(t => Number(t.bedrag) < 0);
  if (negatief.length) {
    voegToe('fout', 'Boekingen met een negatief bedrag', negatief.length,
      'De database weigert negatieve bedragen; de richting volgt uit de soort mutatie.',
      negatief.map(t => `${t.datum} · ${t.naam} · ${t.bedrag}`));
  }

  const nul = plan.boekingen.filter(t => Number(t.bedrag) === 0);
  if (nul.length) {
    voegToe('let op', 'Boekingen met een bedrag van nul', nul.length,
      'Deze gaan gewoon mee — de database laat ze toe zodat de controlepagina ze kan blijven melden.',
      nul.map(t => `${t.datum} · ${t.naam || '(geen naam)'}`));
  }

  const nieuweNummers = plan.nieuweNummers ?? plan.ontbrekendeNummers;
  if (nieuweNummers.length) {
    voegToe('let op', 'Grootboeknummers die nog niet in de database staan', nieuweNummers.length,
      'Deze worden tijdens de migratie aangemaakt met de omschrijving "Nog te classificeren", zodat geen enkele boeking zijn nummer verliest.',
      nieuweNummers);
  }

  const nieuweRekeningen = plan.nieuweRekeningen ?? plan.ontbrekendeRekeningen;
  if (nieuweRekeningen.length) {
    voegToe('fout', 'Bankrekeningen die nog niet in de database staan', nieuweRekeningen.length,
      'Elke boeking moet aan een bankrekening hangen. Maak deze eerst aan.',
      nieuweRekeningen);
  }

  const ids = new Map();
  const dubbel = [];
  plan.boekingen.forEach(t => {
    const sleutel = String(t.id);
    if (ids.has(sleutel)) dubbel.push(sleutel); else ids.set(sleutel, t);
  });
  if (dubbel.length) {
    voegToe('fout', 'Boekingen met een dubbel nummer', dubbel.length,
      'Het oude nummer wordt als legacy_id bewaard en moet uniek zijn. Los deze eerst op via de controlepagina.',
      [...new Set(dubbel)]);
  }

  const naamloos = plan.artikelen.filter(c => !String(c.artikel || '').trim());
  if (naamloos.length) {
    voegToe('fout', 'Voorraadartikelen zonder naam', naamloos.length,
      'Een artikel moet een naam hebben.');
  }

  const koppelbaar = plan.genegeerdeMeldingen.filter(m =>
    ids.has(String(m.itemSleutel)) || plan.artikelen.some(c => String(c.id) === String(m.itemSleutel)));
  const nietKoppelbaar = plan.genegeerdeMeldingen.length - koppelbaar.length;
  if (nietKoppelbaar > 0) {
    voegToe('let op', 'Genegeerde meldingen zonder herkenbaar doel', nietKoppelbaar,
      'Deze verwijzen naar een grootboeknummer of naar iets dat inmiddels is verwijderd. Ze gaan mee op hun oude sleutel en blijven werken.');
  }

  return punten;
}

/**
 * Zet de uitkomst om in platte tekst, zodat je hem in één keer kunt kopiëren
 * en doorsturen. Bewust zonder opmaak: dan blijft hij overal leesbaar.
 */
export function alsTekst({ plan, totalen, waarschuwingen, regels, inDatabase }) {
  const r = [];
  const bedrag = n => Number(n || 0).toFixed(2).padStart(12);

  r.push('DRY-RUN XTENATE ADMINISTRATIE — ' + new Date().toLocaleString('nl-NL'));
  r.push('');
  r.push('WAT ER ZOU WORDEN OVERGEZET');
  r.push('Onderdeel'.padEnd(22) + 'Erbij'.padStart(7) + '  Nu in DB  Toelichting');
  regels.forEach(x => r.push(
    x.tabel.padEnd(22) + String(x.toevoegen).padStart(7) +
    String(inDatabase?.[x.tabel] ?? '-').padStart(10) + '  ' + x.toelichting));

  r.push('');
  r.push('BOEKINGEN PER JAAR');
  plan.perJaar.forEach(j => r.push(`  ${j.jaar}: ${j.aantal}`));
  r.push(`  totaal: ${plan.boekingen.length}`);

  r.push('');
  r.push('FINANCIELE TOTALEN PER JAAR');
  r.push('Jaar  Boekingen        Omzet       Kosten     Prive op     Prive st  Gesch. IB');
  totalen.perJaar.forEach(j => r.push(
    j.jaar.padEnd(6) + String(j.aantal).padStart(9) +
    bedrag(j.excelOmzet ?? j.omzet) + bedrag(j.excelKosten ?? j.kosten) +
    bedrag(j.excelPriveOp ?? j.priveOp) + bedrag(j.excelPriveSt ?? j.priveSt) +
    String(j.ib).padStart(11)));

  r.push('');
  r.push('VOORRAAD EN SALDO');
  r.push('  Banksaldo                : ' + totalen.banksaldo.toFixed(2));
  r.push('  Voorraadwaarde artikelen : ' + totalen.voorraadwaardeArtikelen.toFixed(2) +
    ` (${totalen.artikelenZonderKostprijs} zonder kostprijs)`);
  r.push('  Stuks op voorraad        : ' + totalen.voorraadStuks);
  r.push('  HNVI in voorraad         : ' + totalen.hnviVoorraadwaarde.toFixed(2) +
    ` (${totalen.hnviInVoorraad} loten)`);

  r.push('');
  r.push('STAMGEGEVENS');
  r.push('  Grootboeknummers in gebruik : ' + plan.gebruikteNummers.length +
    ', nieuw aan te maken: ' + (plan.nieuweNummers?.length ?? '?'));
  r.push('  Bankrekeningen in gebruik   : ' + plan.gebruikteRekeningen.join(', ') +
    ', nieuw: ' + (plan.nieuweRekeningen?.length ?? '?'));
  r.push('  Productgroepen              : ' + plan.productgroepen.map(g => g.naam).join(', '));
  r.push('  Nieuwe productgroepen       : ' + (plan.nieuweGroepen?.length ?? '?'));

  r.push('');
  r.push('AANDACHTSPUNTEN');
  if (!waarschuwingen.length) r.push('  geen');
  waarschuwingen.forEach(w => {
    r.push(`  [${w.ernst}] ${w.titel} — ${w.aantal}`);
    if (w.voorbeelden.length) r.push('      ' + w.voorbeelden.join(' | '));
  });

  return r.join('\n');
}

// ------------------------------------------------------------------- dry-run

/** Welke stamgegevens staan er al in Supabase? Nodig om te weten wat er
 *  werkelijk bij zou komen, in plaats van wat de code standaard kent. */
async function huidigeStamgegevens(sb) {
  const haal = async (tabel, veld) => {
    const { data, error } = await sb.from(tabel).select(veld).is('deleted_at', null);
    if (error) throw error;
    return new Set((data || []).map(r => String(r[veld])));
  };
  return {
    grootboeknummers: await haal('grootboekrekeningen', 'nummer'),
    bankrekeningnummers: await haal('bankrekeningen', 'nummer'),
    groepnamen: new Set([...(await haal('productgroepen', 'naam'))].map(n => n.toLowerCase()))
  };
}

/** Wat staat er op dit moment in Supabase? */
async function huidigeAantallen(sb) {
  const tabellen = [
    'grootboekrekeningen', 'bankrekeningen', 'productgroepen', 'transacties',
    'maandsaldi', 'jaartotalen', 'voorraadartikelen', 'voorraadstanden',
    'voorraadmutaties', 'hnvi_loten', 'controle_negeer'
  ];
  const uit = {};
  for (const tabel of tabellen) {
    const { count, error } = await sb.from(tabel)
      .select('id', { count: 'exact', head: true }).is('deleted_at', null);
    uit[tabel] = error ? null : count;
  }
  // controle_negeer heeft geen deleted_at
  const { count: negeerAantal } = await sb.from('controle_negeer')
    .select('id', { count: 'exact', head: true });
  uit.controle_negeer = negeerAantal ?? uit.controle_negeer;
  return uit;
}

/**
 * De proefmigratie. Leest de lokale administratie, leest de stand in Supabase,
 * en zet ernaast wat er zou gebeuren. Schrijft niets.
 */
export async function dryRun() {
  const plan = bouwPlan();
  const totalen = financieleTotalen(plan);

  let inDatabase = null, stam = null, fout = null;
  try {
    const sb = await getClient();
    inDatabase = await huidigeAantallen(sb);
    stam = await huidigeStamgegevens(sb);
  } catch (e) {
    fout = leesbareFout(e);
  }

  // Wat er werkelijk nog ontbreekt, gemeten aan de database zelf. Zonder deze
  // stap zou de proefmigratie rekeningen tellen die er allang staan.
  const nieuweNummers = stam
    ? plan.gebruikteNummers.filter(nr => !stam.grootboeknummers.has(nr))
    : plan.ontbrekendeNummers;
  const nieuweRekeningen = stam
    ? plan.gebruikteRekeningen.filter(nr => !stam.bankrekeningnummers.has(nr))
    : plan.ontbrekendeRekeningen;
  const nieuweGroepen = stam
    ? plan.productgroepen.filter(g => !stam.groepnamen.has(String(g.naam).toLowerCase()))
    : plan.productgroepen;

  plan.nieuweNummers = nieuweNummers;
  plan.nieuweRekeningen = nieuweRekeningen;
  plan.nieuweGroepen = nieuweGroepen;

  // Wat er per tabel bij zou komen. Grootboekrekeningen en bankrekeningen
  // staan er al; daar komen alleen de ontbrekende nummers bij.
  const regels = [
    { tabel: 'transacties', toevoegen: plan.boekingen.length,
      toelichting: plan.perJaar.map(j => `${j.jaar}: ${j.aantal}`).join(' · ') },
    { tabel: 'grootboekrekeningen', toevoegen: nieuweNummers.length,
      toelichting: nieuweNummers.length
        ? `${plan.gebruikteNummers.length} nummers in gebruik, nieuw: ${nieuweNummers.join(', ')}`
        : `${plan.gebruikteNummers.length} nummers in gebruik, staan er allemaal al` },
    { tabel: 'bankrekeningen', toevoegen: nieuweRekeningen.length,
      toelichting: nieuweRekeningen.length
        ? `nieuw: ${nieuweRekeningen.join(', ')}`
        : `${plan.gebruikteRekeningen.length} in gebruik, staan er al` },
    { tabel: 'maandsaldi', toevoegen: plan.maandsaldi.length,
      toelichting: plan.maandsaldi.length ? `${plan.maandsaldi[0].maand} t/m ${plan.maandsaldi[plan.maandsaldi.length - 1].maand}` : '' },
    { tabel: 'jaartotalen', toevoegen: plan.jaartotalen.length,
      toelichting: plan.jaartotalen.map(j => j.jaar).join(', ') },
    { tabel: 'productgroepen', toevoegen: nieuweGroepen.length,
      toelichting: nieuweGroepen.length
        ? `nieuw: ${nieuweGroepen.map(g => g.naam).join(', ')}`
        : `${plan.productgroepen.length} groepen, staan er al en worden gekoppeld` },
    { tabel: 'voorraadartikelen', toevoegen: plan.artikelen.length, toelichting: '' },
    { tabel: 'voorraadstanden', toevoegen: plan.voorraadstanden.length,
      toelichting: 'vastgelegde eindstanden per jaar' },
    { tabel: 'voorraadmutaties', toevoegen: plan.voorraadmutaties.length,
      toelichting: 'één beginstand per artikel' },
    { tabel: 'hnvi_loten', toevoegen: plan.loten.length, toelichting: '' },
    { tabel: 'controle_negeer', toevoegen: plan.genegeerdeMeldingen.length + plan.uitgezetteControles.length,
      toelichting: `${plan.genegeerdeMeldingen.length} meldingen, ${plan.uitgezetteControles.length} uitgezette controles` }
  ];

  const waarschuwingen = controleerPlan(plan);
  const heeftFouten = waarschuwingen.some(w => w.ernst === 'fout');

  return { plan, totalen, waarschuwingen, regels, inDatabase, fout, heeftFouten };
}
