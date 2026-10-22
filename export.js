// export.js — de administratie wegschrijven als Excel-bestand met dezelfde
// indeling als het bestand waaruit de app importeert.
//
// Uitgangspunt: wat de app exporteert moet de app zelf weer kunnen inlezen,
// zonder verlies. De kolomposities hieronder zijn daarom exact die welke de
// importfunctie leest; de overige kolommen zijn ingevuld met gegevens die het
// bestand voor jou leesbaar maken maar bij het inlezen worden overgeslagen.

import { isInkomst, maandLabel } from './helpers.js?v=20261022a';
import { HOME_TOTALS, MAAND_SALDOS, groepNaam, state, grootboekNamen, rekeningNamen } from './storage.js?v=20261022a';
import { bankPrijzenNu, inkoopwaardeVan } from './voorraadwaarde.js?v=20261022a';
import { btwRelevant } from './btw.js?v=20261022a';

const CREDITKAART = '1030';

const MAANDEN = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];

/** Bedrag zoals het in de boekhouding staat: uitgaven positief, ontvangsten negatief. */
const grootboekBedrag = t => (isInkomst(t) || t.type === 'prive_storting' ? -t.bedrag : t.bedrag);

/** Bedrag zoals het op een bankafschrift staat: af is negatief. */
const bankBedrag = t => (isInkomst(t) || t.type === 'prive_storting' ? t.bedrag : -t.bedrag);

function boekingenVanJaar(jaar) {
  const bron = jaar === '2026' ? state.TX : state.HIST_TX.filter(t => t.datum.startsWith(jaar));
  return [...bron].sort((a, b) => a.datum.localeCompare(b.datum));
}

// ------------------------------------------------------------ Bank JJJJ-MM

/**
 * Eén werkblad per maand, met de boekingen links (kolom A t/m H), het begin-
 * en eindsaldo in kolom I en J, en de BTW-kolom helemaal rechts in kolom P
 * (index 15) — precies zoals de import het verwacht.
 *
 * Kolom P staat bewust ver van de rest: de import leest per rij niet alleen
 * kolom A t/m H, maar kijkt ook op kolom J t/m O naar een eventueel tweede
 * transactieblok op dezelfde rij (modals.js, bevestigImport(), offset 8).
 * Zou de BTW-kolom binnen dat bereik vallen, dan zou een BTW-bedrag daar per
 * ongeluk als bedrag van een spooktransactie gelezen kunnen worden. Kolom P
 * ligt daar ruim voorbij en wordt door de import simpelweg genegeerd, zoals
 * dit bestand dat al documenteert voor kolommen die niet worden ingelezen.
 */
function bankBlad(maand, boekingen) {
  const REKNM = rekeningNamen();
  const rijen = [[
    'Nr', 'Datum', 'Grootboek', 'Bedrag', 'Omschrijving', 'Naam', 'Rekening', 'Soort',
    '', '', '', '', '', '', '', 'BTW'
  ]];

  boekingen.forEach((t, i) => {
    const rij = [
      i + 1,
      t.datum,
      Number(t.gb) || t.gb,
      Math.round(bankBedrag(t) * 100) / 100,
      t.omschr || '',
      t.naam || '',
      t.rek,
      REKNM[t.rek] || '',
      '', '', '', '', '', '', ''
    ];
    // Leeg, niet nul: alleen als deze boeking daadwerkelijk een BTW-percentage
    // draagt — dus btwRelevant() (geen privé) én geboekt op/na de omslagdatum
    // — staat hier een bedrag. Dezelfde functie als het BTW-scherm gebruikt,
    // geen eigen, evenwijdige berekening.
    rij.push(btwRelevant(t) && t.btw_percentage != null
      ? Math.round((Number(t.btw_bedrag) || 0) * 100) / 100
      : '');
    rijen.push(rij);
  });

  // Saldo's in kolom I en J. De import zoekt hier letterlijk naar de woorden
  // Beginsaldo en Eindsaldo.
  const saldo = MAAND_SALDOS[maand];
  if (saldo) {
    while (rijen.length < 3) rijen.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    if (saldo.begin != null) { rijen[1][8] = 'Beginsaldo'; rijen[1][9] = saldo.begin; }
    if (saldo.eind != null) { rijen[2][8] = 'Eindsaldo'; rijen[2][9] = saldo.eind; }
  }

  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 28 }, { wch: 30 },
                 { wch: 10 }, { wch: 13 }, { wch: 12 }, { wch: 11 },
                 { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 11 }];
  return ws;
}

// ------------------------------------------------------- Creditkaart Prive

/** De import leest hier vanaf rij 3, met datum in kolom H t/m omschrijving in K. */
function creditkaartBlad(boekingen) {
  const rijen = [
    ['Creditkaart Privé', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', 'Datum', 'Grootboek', 'Bedrag', 'Omschrijving']
  ];
  boekingen.forEach(t => {
    rijen.push(['', '', '', '', '', '', '',
      t.datum,
      Number(t.gb) || t.gb,
      Math.round(bankBedrag(t) * 100) / 100,
      t.omschr || t.naam || ''
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = Array.from({ length: 7 }, () => ({ wch: 4 }))
    .concat([{ wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 34 }]);
  return ws;
}

// ---------------------------------------------------- Voorraad & Mutaties

/** De import leest vanaf rij 3: artikel in A, voorraad in C, in- en verkoop in H en I, verkopen in P. */
function voorraadBlad() {
  const rijen = [
    ['Voorraad & Mutaties', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['Artikel', 'Groep', 'Voorraad', 'Inkoopprijs', 'Verkoopprijs', 'Voorraadwaarde', 'Meldgrens',
     'Ingekocht', 'Verkocht', '', '', '', '', '', '', 'Verkopen 2026']
  ];
  // Zelfde definitie als de Voorraadpagina en de aangifte: handmatige prijs
  // als die er staat, anders afgeleid uit de bankboekingen. Hier stond eerder
  // een eigen berekening die alleen naar het handmatige veld keek, waardoor de
  // export een lagere voorraadwaarde gaf dan de app zelf toonde.
  const bankPrijzen = bankPrijzenNu();
  const prijsJaar = String(new Date().getFullYear());
  state.COVERS.forEach(c => {
    const berekend = inkoopwaardeVan(c, { voorraad: Number(c.voorraad) || 0 }, bankPrijzen, prijsJaar);
    const waarde = berekend == null ? '' : berekend;
    rijen.push([
      c.artikel,
      groepNaam(c.categorie),
      Number(c.voorraad) || 0,
      c.inkoopprijs ?? '',
      c.prijs ?? '',
      waarde === '' ? '' : Math.round(waarde * 100) / 100,
      c.minVoorraad ?? '',
      Number(c.inkoop) || 0,
      Number(c.verkoop) || 0,
      '', '', '', '', '', '',
      Number(c.omzet2026) || 0
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 26 }, { wch: 15 }, { wch: 10 }, { wch: 12 }, { wch: 13 }, { wch: 15 }, { wch: 11 },
                 { wch: 11 }, { wch: 10 }].concat(Array.from({ length: 6 }, () => ({ wch: 4 })), [{ wch: 14 }]);
  return ws;
}

// ------------------------------------------------------------ Per Periode

/**
 * Jaartotalen per grootboekrekening, met een kolom per maand en een
 * Totaal-kolom. Ontvangsten staan negatief, zoals in je eigen bestand.
 */
function perPeriodeBlad(jaar, boekingen) {
  const GBNM = grootboekNamen();
  const maanden = Array.from({ length: 12 }, (_, i) => `${jaar}-${String(i + 1).padStart(2, '0')}`);
  const kop = ['Grootboek', 'Omschrijving', ...maanden.map(m => maandLabel(m)), 'Totaal'];

  const perGb = new Map();
  boekingen.forEach(t => {
    if (!perGb.has(t.gb)) perGb.set(t.gb, new Array(12).fill(0));
    const maand = Number(t.datum.slice(5, 7)) - 1;
    perGb.get(t.gb)[maand] += grootboekBedrag(t);
  });

  const afronden = n => Math.round(n * 100) / 100;
  const rijen = [kop];
  [...perGb.keys()].sort().forEach(gb => {
    const perMaand = perGb.get(gb);
    rijen.push([
      Number(gb) || gb,
      GBNM[gb] || 'Onbekende rekening',
      ...perMaand.map(afronden),
      afronden(perMaand.reduce((s, v) => s + v, 0))
    ]);
  });

  // Rekening 9990 is in je bestand het totaal van de kosten. De import gebruikt
  // die regel bij voorkeur, dus die schrijven we expliciet mee.
  const kostenPerMaand = new Array(12).fill(0);
  boekingen.filter(t => t.type === 'uitgave').forEach(t => {
    kostenPerMaand[Number(t.datum.slice(5, 7)) - 1] += t.bedrag;
  });
  rijen.push([9990, 'Kosten', ...kostenPerMaand.map(afronden), afronden(kostenPerMaand.reduce((s, v) => s + v, 0))]);

  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 11 }, { wch: 30 }].concat(Array.from({ length: 13 }, () => ({ wch: 11 })));
  return ws;
}

// ------------------------------------------------- aanvullende werkbladen

/** Loten van HNVI. Wordt bij het inlezen herkend, zodat een herstel compleet is. */
function hnviBlad() {
  // De kolomnamen zijn bewust dezelfde als die de import herkent, zodat een
  // geexporteerd bestand ook weer volledig ingelezen kan worden. Factuurnummer
  // en verkoopdatum stonden hier eerder niet in en gingen bij zo'n rondgang
  // verloren.
  const rijen = [['Datum', 'Omschrijving', 'Factuur', 'Inkoop', 'Verkoop',
                  'Verkoopdatum', 'Winst', 'Status', 'Notitie', 'Id']];
  [...state.HNVI_LOTS].sort((a, b) => String(a.datum).localeCompare(String(b.datum))).forEach(l => {
    const winst = Number(l.verkoop) > 0 ? Number(l.verkoop) - (Number(l.inkoop) || 0) : '';
    rijen.push([
      l.datum || '', l.omschr || '', l.factuur || '',
      Number(l.inkoop) || 0,
      Number(l.verkoop) > 0 ? Number(l.verkoop) : '',
      l.verkoopDatum || '',
      winst === '' ? '' : Math.round(winst * 100) / 100,
      l.status || 'voorraad', l.noot || '', l.id
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 12 }, { wch: 11 }, { wch: 11 },
                 { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 26 }, { wch: 28 }];
  return ws;
}

/** Vastgelegde eindstanden per jaar, zodat je voorraadhistorie niet in de app opgesloten zit. */
function voorraadPerJaarBlad() {
  const rijen = [['Artikel', 'Jaar', 'Eindvoorraad', 'Ingekocht', 'Verkocht', 'Retour']];
  state.COVERS.forEach(c => {
    Object.entries(c.jaren || {}).sort((a, b) => a[0].localeCompare(b[0])).forEach(([jaar, v]) => {
      if (v.eind == null && v.verkocht == null && v.inkoop == null) return;
      rijen.push([c.artikel, jaar, v.eind ?? '', v.inkoop ?? '', v.verkocht ?? '', v.retour ?? '']);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 26 }, { wch: 8 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 9 }];
  return ws;
}

/**
 * De jaartotalen zoals ze in de app staan.
 *
 * Dit blad is er omdat "Per Periode" een berekend overzicht is en niet
 * herleidbaar tot de losse boekingen: de kosten en de privé-stortingen in je
 * eigen administratie wijken af van wat de boekingen optellen. Werd het bestand
 * teruggelezen, dan verving die herberekening je echte jaartotalen. Hier staan
 * ze onaangeroerd, en de import gebruikt dit blad met voorrang.
 */
function jaartotalenBlad() {
  const kolommen = ['Jaar', 'Omzet', 'Kosten', 'Omzet Xtenate', 'Omzet Bol', 'Omzet Helmetstore',
                    'Prive opname', 'Prive storting', 'Inkoop HNVI'];
  const rijen = [kolommen];
  Object.keys(HOME_TOTALS).sort().forEach(jaar => {
    const t = HOME_TOTALS[jaar];
    rijen.push([Number(jaar), t.omzet ?? 0, t.kosten ?? 0, t.omzXt ?? 0, t.omzBol ?? 0,
                t.omzHC ?? 0, t.priveOp ?? 0, t.priveSt ?? 0, t.hnviInv ?? 0]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 8 }].concat(Array.from({ length: 8 }, () => ({ wch: 15 })));
  return ws;
}

/** Naslag: welk nummer hoort bij welke rekening. */
function schemaBlad() {
  const rijen = [['Nummer', 'Omschrijving']];
  Object.entries(grootboekNamen()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([nr, naam]) => rijen.push([Number(nr) || nr, naam]));
  rijen.push([], ['Rekening', 'Omschrijving']);
  Object.entries(rekeningNamen()).forEach(([nr, naam]) => rijen.push([Number(nr) || nr, naam]));
  const ws = XLSX.utils.aoa_to_sheet(rijen);
  ws['!cols'] = [{ wch: 11 }, { wch: 34 }];
  return ws;
}

// ------------------------------------------------------------------ bouwen

/** Stelt het volledige werkboek samen voor één boekjaar. */
export function bouwWerkboek(jaar) {
  const boekingen = boekingenVanJaar(jaar);
  const wb = XLSX.utils.book_new();

  // Eén blad per maand waarin iets gebeurd is, of waarvan we een saldo kennen.
  const maanden = new Set(boekingen.map(t => t.datum.slice(0, 7)));
  Object.keys(MAAND_SALDOS).filter(m => m.startsWith(jaar)).forEach(m => maanden.add(m));

  [...maanden].sort().forEach(maand => {
    const vanMaand = boekingen.filter(t => t.datum.startsWith(maand) && t.rek !== CREDITKAART);
    // Een maand met uitsluitend creditcardboekingen levert een leeg bankblad op;
    // dat voegt niets toe aan het bestand.
    if (!vanMaand.length && !MAAND_SALDOS[maand]) return;
    XLSX.utils.book_append_sheet(wb, bankBlad(maand, vanMaand), `Bank ${maand}`);
  });

  const creditkaart = boekingen.filter(t => t.rek === CREDITKAART);
  XLSX.utils.book_append_sheet(wb, creditkaartBlad(creditkaart), 'Creditkaart Prive');
  XLSX.utils.book_append_sheet(wb, perPeriodeBlad(jaar, boekingen), 'Per Periode');
  XLSX.utils.book_append_sheet(wb, jaartotalenBlad(), 'Jaartotalen');
  XLSX.utils.book_append_sheet(wb, voorraadBlad(), 'Voorraad & Mutaties');
  XLSX.utils.book_append_sheet(wb, voorraadPerJaarBlad(), 'Voorraad per jaar');
  XLSX.utils.book_append_sheet(wb, hnviBlad(), 'HNVI Loten');
  XLSX.utils.book_append_sheet(wb, schemaBlad(), 'Grootboekschema');

  return wb;
}

/** Telt op wat er in het bestand terechtkomt, voor de bevestiging achteraf. */
export function exportSamenvatting(jaar) {
  const boekingen = boekingenVanJaar(jaar);
  const maanden = new Set(boekingen.map(t => t.datum.slice(0, 7)));
  Object.keys(MAAND_SALDOS).filter(m => m.startsWith(jaar)).forEach(m => maanden.add(m));
  return {
    boekingen: boekingen.length,
    bank: boekingen.filter(t => t.rek !== CREDITKAART).length,
    creditkaart: boekingen.filter(t => t.rek === CREDITKAART).length,
    maanden: maanden.size,
    artikelen: state.COVERS.length,
    loten: state.HNVI_LOTS.length
  };
}

/** Welke jaren zitten er in de administratie? */
export function beschikbareJaren() {
  const jaren = new Set(['2026']);
  state.HIST_TX.forEach(t => jaren.add(t.datum.slice(0, 4)));
  Object.keys(MAAND_SALDOS).forEach(m => jaren.add(m.slice(0, 4)));
  return [...jaren].sort().reverse();
}

/**
 * Zet elk boekjaar in een eigen bestand. Bewust niet één groot bestand: de
 * import herkent per bestand één "Per Periode"-tabblad, dus alleen zo is de
 * reservekopie ook echt terug te zetten.
 */
export async function maakVolledigeReservekopie(bijElkJaar = () => {}) {
  const jaren = beschikbareJaren().slice().sort();
  const gemaakt = [];
  for (const jaar of jaren) {
    exporteerNaarExcel(jaar);
    gemaakt.push(jaar);
    bijElkJaar(jaar, gemaakt.length, jaren.length);
    // Even wachten, anders blokkeert de browser de opeenvolgende downloads.
    await new Promise(r => setTimeout(r, 900));
  }
  return gemaakt;
}

export function exporteerNaarExcel(jaar) {
  const wb = bouwWerkboek(jaar);
  XLSX.writeFile(wb, `Administratie_${jaar}.xlsx`);
  return exportSamenvatting(jaar);
}
