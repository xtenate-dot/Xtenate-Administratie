// modals.js — beheer-acties: Excel-import, cloud sync, API-sleutel, data wissen.

import { renderHome } from './dashboard.js?v=20261024b';

// De omzetrekeningen. Deze stond eerder binnen `reader.onload`, maar wordt ook
// door `bevestigImport` gebruikt — een andere functie, dus een ander bereik.
// Daardoor viel elke bevestigde import om met "OMZET_GB is not defined", ná het
// wegschrijven van de boekingen en vóór het toepassen van de jaartotalen.
const OMZET_GB = ['8000', '8010', '8020'];
import {
  HIST_TX_DEFAULT, HOME_TOTALS, HOME_TOTALS_DEFAULT, MAAND_SALDOS, normaliseerVoorraad, save,
  saveCoversData, saveHnviData, pasHnviDatumsToe, pasHnviExtraToe, saveTxData, state, voegJaarcijfersToe, rekeningNamen
} from './storage.js?v=20261024b';
import { maakHerstelpunt } from './herstelpunt.js?v=20261024b';
import { isTxJaar, jaarVan } from './jaren.js?v=20261024b';
import { addToPendingQueue, deleteFromSupabase, previewWisJaren, vervangBoekingenInSupabase, wisJarenInSupabase } from './supabase-client-v2.js?v=20261024b';

// Leest het "Per Periode"-tabblad (indien aanwezig): een pivot-overzicht per grootboekrekening
// met een kolom "Totaal" voor het hele boekjaar. Dit is de brontabel van de boekhouding zelf,
// dus betrouwbaarder dan het optellen van losse boekingen (die kunnen ontbreken/verkeerd staan).
// Boekhoudkundige tekenconventie: omzet- en storting-rekeningen staan negatief bij toename,
// dus die draaien we om naar de positieve bedragen die de app elders gebruikt.
function parsePerPeriode(wb, fallback) {
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().replace(/[^a-z]/g, '') === 'perperiode');
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
  if (rows.length < 2) return null;
  const header = rows[0];
  const idxTotaal = header.indexOf('Totaal');
  if (idxTotaal === -1) return null;

  // byGb bevat alleen rekeningen waarvan de Totaal-cel een echt getal is. Cellen met een
  // formulefout (#N/A, #REF! etc — komt voor in oudere boekjaren) worden bewust NIET
  // opgeslagen, zodat hieronder per rekening teruggevallen kan worden op de losse boekingen
  // in plaats van zo'n fout stilzwijgend als €0 te lezen (dat was de eerdere bug).
  const byGb = {};
  rows.slice(1).forEach(row => {
    const nummer = row[0];
    if (nummer === null || nummer === undefined || nummer === '') return;
    const gbStr = String(Math.round(parseFloat(nummer)));
    if (gbStr === 'NaN') return;
    const totaal = row[idxTotaal];
    if (typeof totaal === 'number') byGb[gbStr] = totaal;
  });

  const heeft = gb => gb in byGb;
  const get = gb => byGb[gb];

  const omzXt = heeft('8000') ? -get('8000') : fallback.omzXt;
  const omzBol = heeft('8010') ? -get('8010') : fallback.omzBol;
  const omzHC = heeft('8020') ? -get('8020') : fallback.omzHC;
  const omzet = (heeft('8000') || heeft('8010') || heeft('8020')) ? (omzXt + omzBol + omzHC) : fallback.omzet;
  // Kosten normaal uit rekening 9990 ("Kosten"); anders rubriek 4 + inkopen; anders terugval.
  let kosten;
  if (heeft('9990')) kosten = get('9990');
  else if (heeft('4999') && heeft('7999')) kosten = get('4999') + get('7999');
  else kosten = fallback.kosten;

  return {
    omzet, kosten, omzXt, omzBol, omzHC,
    priveOp: heeft('601') ? get('601') : fallback.priveOp,
    priveSt: heeft('600') ? -get('600') : fallback.priveSt,
    hnviInv: heeft('7010') ? get('7010') : fallback.hnviInv
  };
}

export function importExcel(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  document.getElementById('import-title').textContent = 'Bezig met importeren...';
  document.getElementById('import-body').innerHTML = 'Excel bestand lezen...';
  document.getElementById('import-actions').style.display = 'none';
  document.getElementById('modal-import').classList.add('open');

  // Vers opgehaald per import, niet één keer bij het laden van de module —
  // anders zou een rekening die je net via Beheer hebt toegevoegd of
  // hernoemd, pas na een herlaad van de pagina worden herkend.
  const REKENINGEN = new Set(Object.keys(rekeningNamen()));

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, {type:'array', cellDates:true});
      let log = [];
      let newTx = [];
      let newCovers = [];
      let tid = 500;

      // Een boekhouddatum is een kalenderdatum, geen tijdstip. Eerder liep dit
      // via toISOString(), en dat rekent om naar UTC: middernacht in Amsterdam
      // is de avond ervoor in UTC, dus elke datumcel kwam er een dag te vroeg
      // uit. Dat gebeurde alleen bij een positieve UTC-afwijking, waardoor het
      // in een testomgeving op UTC nooit opviel.
      function excelDate(val) {
        if (val === 0 || !val) return null;
        // SheetJS levert met cellDates:true een Date in lokale tijd. We lezen
        // dag, maand en jaar zoals ze lokaal in de cel staan en rekenen niet om.
        if (val instanceof Date) {
          const j = val.getFullYear(), m = val.getMonth() + 1, d = val.getDate();
          return `${j}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        // Excel telt dagen vanaf 30-12-1899. In hele dagen rekenen vanaf een
        // UTC-referentie, zodat zomertijd er niet tussen kan komen.
        if (typeof val === 'number') {
          const d = new Date(Date.UTC(1899, 11, 30));
          d.setUTCDate(d.getUTCDate() + Math.floor(val));
          return d.toISOString().slice(0,10);
        }
        if (typeof val === 'string' && val.match(/\d{4}-\d{2}-\d{2}/)) return val.slice(0,10);
        if (typeof val === 'string' && val.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) {
          const [m,d,y] = val.split('/');
          return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
        }
        return null;
      }

      // Herken automatisch alle "Bank JJJJ-MM" tabs, welk jaar dan ook
      const bankSheets = wb.SheetNames.filter(n => /^Bank \d{4}-\d{2}$/.test(n));

      // Bepaal welk jaar (of jaren) dit bestand bevat, voor de importmelding
      const gevondenJaren = [...new Set(bankSheets.map(n => n.slice(5,9)))].sort();

      // Bank tabs
      let bankCount = 0;
      bankSheets.forEach(sheetName => {
        if (!wb.SheetNames.includes(sheetName)) return;
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
        rows.slice(1).forEach(row => {
          [0, 8].forEach(offset => {
            const datum = excelDate(row[offset+1]);
            const gb = row[offset+2];
            const bedrag = row[offset+3];
            const naam = row[offset+5];
            // Kolom G kan een rekeningnummer bevatten (staat in onze eigen export).
            // Alleen overnemen als het een rekening is die de app kent.
            const rekKolom = row[offset+6];
            const rek = REKENINGEN.has(String(rekKolom)) ? String(rekKolom) : '1010';
            if (!datum || bedrag === null || bedrag === undefined || gb === null || String(gb) === 'Onbekend') return;
            if (typeof bedrag !== 'number') return;
            const gbStr = String(Math.round(parseFloat(gb)));
            if (gbStr === 'NaN') return;
            const isPrive = ['600','601'].includes(gbStr);
            const isInk = OMZET_GB.includes(gbStr);
            let type;
            // Soort uit het grootboek: 600 is een storting, 601 een opname. Het
            // teken van het bedrag is hiervoor niet betrouwbaar gebleken.
            if (isPrive) type = gbStr === '600' ? 'prive_storting' : 'prive_opname';
            else if (isInk && bedrag > 0) type = 'inkomst';
            else if (bedrag > 0 && !isPrive) type = 'inkomst';
            else type = 'uitgave';
            newTx.push({id:tid++, datum, gb:gbStr, bedrag:Math.abs(bedrag),
              naam: naam ? String(naam) : '', omschr: row[offset+4] ? String(row[offset+4]) : '', rek, type});
            bankCount++;
          });
        });
      });

      // Creditkaart Prive
      let ccCount = 0;
      let ccStortingen = 0;
      let ccStortingBedrag = 0;
      const ccProblemen = [];
      let ccConventie = null;
      const ccSheetName = wb.SheetNames.find(n => n.toLowerCase().replace(/[^a-z]/g, '').includes('creditkaartprive'));
      if (ccSheetName) {
        const ws = wb.Sheets[ccSheetName];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});

        // Eerst alles inlezen zonder te oordelen, want het teken had betekenis.
        // Math.abs gooide dat weg, waardoor een terugstorting als uitgave werd
        // geboekt en het jaartotaal er tweemaal het bedrag naast zat.
        const ruweRegels = [];
        rows.slice(2).forEach(row => {
          const datum = excelDate(row[7]);
          const gb = row[8];
          const bedrag = row[9];
          const omschr = row[10];
          if (!datum) return;
          if (typeof bedrag !== 'number') return;
          const gbStr = gb ? String(Math.round(parseFloat(gb))) : '7010';
          ruweRegels.push({ datum, gbStr, bedrag, omschr });
        });

        // Welk teken staat in dit bestand voor een uitgave? Dat leiden we af uit
        // de meerderheid, in plaats van het te veronderstellen. De uitkomst komt
        // in de preview te staan, zodat je het kunt nakijken.
        const gewoon = ruweRegels.filter(r => !['600','601'].includes(r.gbStr));
        const negatief = gewoon.filter(r => r.bedrag < 0).length;
        const positief = gewoon.filter(r => r.bedrag > 0).length;
        ccConventie = negatief > positief ? 'negatief' : 'positief';

        ruweRegels.forEach(r => {
          const isPrive = ['600','601'].includes(r.gbStr);
          let ccType;
          if (isPrive) {
            // De soort volgt uit het grootboek: 600 = storting, 601 = opname.
            ccType = r.gbStr === '600' ? 'prive_storting' : 'prive_opname';
          } else {
            // Creditkaart staat op privé rekening; alles zonder 600/601 is privé.
            ccType = 'prive_storting';
          }
          newTx.push({id:tid++, datum: r.datum, gb:r.gbStr, bedrag:Math.abs(r.bedrag),
            naam: r.omschr ? String(r.omschr) : 'Creditkaart Privé',
            omschr: r.omschr ? String(r.omschr) : '', rek:'1030', type:ccType});
          ccCount++;

          // GEEN tegenboeking voor creditkaart-regels meer.
          // Creditkaart wordt nu direct als prive_storting ingelezen.
          // Tegenboekingen waren nodig toen creditkaart als 'uitgave' werd ingelezen,
          // maar nu niet meer.
        });
      }

      // Voorraad & Mutaties — de bladnaam wisselt per jaar in hoofdletters.
      const voorraadBlad = wb.SheetNames.find(n => n.toLowerCase().replace(/[^a-z]/g,'') === 'voorraadmutaties');
      let coverCount = 0;
      if (voorraadBlad) {
        const ws = wb.Sheets[voorraadBlad];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});

        // De kopregel staat niet in elk bestand op dezelfde rij: in 2024 op de
        // tweede, in 2025 en 2026 op de derde. Zoek hem op inhoud.
        let kopRij = -1;
        for (let r = 0; r < Math.min(6, rows.length); r++) {
          if (String((rows[r] || [])[0] ?? '').trim().toLowerCase() === 'artikel') { kopRij = r; break; }
        }
        const kop = rows[kopRij] || [];

        // Rechts op het blad staat een jaaroverzicht met per jaar het aantal
        // verkochte stuks. Welke kolom bij welk jaar hoort verschilt per
        // bestand, dus we lezen dat uit de kopregel. Zo landt 2024 ook echt in
        // 2024 in plaats van in het huidige jaar.
        const jaarKolommen = {};
        kop.forEach((cel, i) => {
          const m = String(cel ?? '').trim().match(/^(20\d{2})(\.0)?$/);
          if (m && i >= 12) jaarKolommen[m[1]] = i;
        });
        // Het laatste jaar in dat overzicht is het jaar van dit bestand.
        const bestandsJaar = Object.keys(jaarKolommen).sort().pop() || null;

        let cid = 200;
        const getal = v => (typeof v === 'number' ? v : null);

        rows.slice(kopRij >= 0 ? kopRij + 1 : 2).forEach(row => {
          const artikel = row[0];
          if (!artikel || typeof artikel !== 'string') return;
          const kopNaam = String(artikel).trim().toLowerCase();
          if (kopNaam.startsWith('totaal') ||
              ['artikel', 'artikelen', 'omschrijving', 'product'].includes(kopNaam)) return;

          const voorraad = getal(row[2]);
          const inkoop = getal(row[7]);
          const verkoop = getal(row[8]);
          const retour = getal(row[9]);

          // De bewegingskolommen (Inkoop, Verkoop, Retour) horen bij het
          // boekjaar van dit bestand. Dat blijkt uit de formule waarmee het
          // blad zelf de voorraad berekent:
          //   voorraad = inkoop - verkoop + retour + eindstand vorig jaar
          //
          // Het jaaroverzicht rechts op het blad gebruiken we bewust niet meer
          // voor verkoopaantallen. De kolom van het lopende jaar bevat daar
          // "=C" (de voorraad zelf) en de oudere kolommen zijn in de loop der
          // tijd met de hand bijgesteld, dus die twee betekenen niet hetzelfde.
          const jaren = {};
          if (bestandsJaar) {
            jaren[bestandsJaar] = {
              eind: voorraad,
              inkoop: inkoop ?? 0,
              verkocht: verkoop ?? 0,
              retour: retour ?? 0
            };
          }

          newCovers.push({
            id: cid++,
            artikel: String(artikel).trim(),
            // Kolom 4 is de verkoopprijs in het voorraadblok, kolom 13 dezelfde
            // prijs in het jaaroverzicht. De eerste die gevuld is wint.
            prijs: getal(row[4]) ?? getal(row[13]),
            minVoorraad: getal(row[1]),
            voorraad: voorraad != null ? Math.round(voorraad) : 0,
            inkoop: inkoop != null ? Math.round(inkoop) : 0,
            verkoop: verkoop != null ? Math.round(verkoop) : 0,
            jaren
          });
          coverCount++;
        });
      }

      // HNVI-loten uit onze eigen export terughalen, zodat het Excel-bestand een
      // volledige reservekopie is en niet alleen de bankmutaties bevat.
      //
      // Er bestaan twee opzetten. De oude ("HNVI Loten") had vaste kolommen.
      // De nieuwe ("Veiling inkopen/verkopen") heeft een andere volgorde, een
      // factuurnummer en een aparte verkoopdatum. We lezen daarom de kopregel
      // en zoeken de kolommen op naam op, zodat beide werken en het niet
      // opnieuw breekt als er een kolom bijkomt.
      let nieuweLoten = [];
      const lotBlad = wb.SheetNames.find(n => {
        const k = n.toLowerCase().replace(/[^a-z]/g, '');
        return k === 'hnviloten' || k.includes('veiling');
      });
      if (lotBlad) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[lotBlad], { header: 1, defval: null });

        // De kopregel staat niet altijd op de eerste rij: in het nieuwe bestand
        // staat er een lege regel boven. Zoek de rij die de kolomnamen bevat.
        const normaliseer = v => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
        let kopRij = -1;
        for (let r = 0; r < Math.min(40, rows.length); r++) {
          const cellen = (rows[r] || []).map(normaliseer);
          if (cellen.some(c => c === 'product' || c === 'omschrijving') &&
              cellen.some(c => c.includes('inkoop'))) { kopRij = r; break; }
        }

        // Kolomnamen op hun plaats zoeken. Elk patroon is een lijst van
        // mogelijke namen; de eerste die past wint.
        const kop = kopRij >= 0 ? (rows[kopRij] || []).map(normaliseer) : [];
        const zoekKolom = (...namen) => {
          for (const naam of namen) {
            const i = kop.findIndex(c => c === naam);
            if (i >= 0) return i;
          }
          for (const naam of namen) {
            const i = kop.findIndex(c => c.includes(naam));
            if (i >= 0) return i;
          }
          return -1;
        };

        const kolom = kopRij >= 0 ? {
          product:   zoekKolom('product', 'omschrijving'),
          factuur:   zoekKolom('factnummer', 'factuurnummer', 'factuur'),
          inkDatum:  zoekKolom('inkdatum', 'inkoopdatum', 'datum'),
          inkoop:    zoekKolom('inkoop'),
          verkDatum: zoekKolom('verkdatum', 'verkoopdatum'),
          verkoop:   zoekKolom('verkoopprijs', 'verkoop'),
          status:    zoekKolom('status'),
          notitie:   zoekKolom('notitie', 'noot', 'opmerking'),
          id:        zoekKolom('id')
        } : null;

        // Zonder herkenbare kopregel vallen we terug op de oude vaste volgorde,
        // zodat een bestaand exportbestand blijft werken.
        const oudeVolgorde = { product: 1, factuur: -1, inkDatum: 0, inkoop: 2,
                               verkDatum: -1, verkoop: 3, status: 5, notitie: 6, id: 7 };
        // Een blad van de veiling zonder herkenbare kopregel lezen we liever niet
        // dan dat we de oude vaste volgorde op een nieuwe indeling loslaten: dat
        // gaf eerder rommelregels in plaats van loten.
        const isVeilingBlad = /veiling/i.test(lotBlad);
        const kopOk = kolom && kolom.product >= 0 && kolom.inkoop >= 0;
        if (isVeilingBlad && !kopOk) {
          console.warn(`Tabblad "${lotBlad}": geen kopregel met Omschrijving en Inkoop gevonden; loten niet gelezen.`);
        }
        const k = kopOk ? kolom : oudeVolgorde;
        const startRij = kopRij >= 0 ? kopRij + 1 : 1;

        const haal = (row, index) => (index >= 0 ? row[index] : null);
        const getal = v => (typeof v === 'number' ? v : (parseFloat(String(v ?? '').replace(',', '.')) || null));

        // Dezelfde artikelen komen vaker voor (vier keer "Iphone SE"). Een
        // teller achter de sleutel houdt ze uit elkaar zonder dat een tweede
        // import nieuwe id's verzint en alles dubbel zet.
        const gezien = {};

        for (let r = startRij; r < rows.length && !(isVeilingBlad && !kopOk); r++) {
          const row = rows[r] || [];
          const product = haal(row, k.product);
          const inkoopRuw = haal(row, k.inkoop);
          const naam = product == null ? '' : String(product).trim();

          if (!naam) continue;
          // Tussentotalen zijn geen loten.
          if (/^totaal/i.test(naam)) continue;
          if (inkoopRuw == null && haal(row, k.inkDatum) == null) continue;

          const factuur = haal(row, k.factuur);
          const inkoopDatum = excelDate(haal(row, k.inkDatum)) || '';
          const verkoopDatum = excelDate(haal(row, k.verkDatum)) || '';
          const inkoop = getal(inkoopRuw) || 0;
          const verkoop = getal(haal(row, k.verkoop));
          const statusRuw = haal(row, k.status);

          // Een status uit het bestand telt alleen als het ook echt een status
          // is. In het nieuwe blad staat op die plek een bedrag, en dat mag
          // nooit als status worden overgenomen.
          const statusUitBestand = typeof statusRuw === 'string' &&
            /^(voorraad|verkocht|retour)$/i.test(statusRuw.trim())
            ? statusRuw.trim().toLowerCase() : null;

          const eigenId = haal(row, k.id);
          let sleutel;
          if (eigenId != null && eigenId !== '') {
            sleutel = String(eigenId);
          } else {
            const basis = `${naam}|${factuur ?? ''}|${inkoopDatum}|${inkoop}`
              .toLowerCase().replace(/[^a-z0-9|.-]/g, '');
            gezien[basis] = (gezien[basis] || 0) + 1;
            sleutel = `veiling-${basis}-${gezien[basis]}`;
          }

          nieuweLoten.push({
            id: sleutel,
            _key: String(sleutel),
            datum: inkoopDatum,
            omschr: naam,
            inkoop,
            verkoop: verkoop != null ? verkoop : null,
            verkoopDatum,
            factuur: factuur ? String(factuur).trim() : '',
            status: statusUitBestand || (verkoop != null ? 'verkocht' : 'voorraad'),
            noot: (() => { const n = haal(row, k.notitie); return n ? String(n) : ''; })()
          });
        }
        // Hier wordt bewust NIET geschreven. De loten werden eerder al bij het
        // lezen van het bestand opgeslagen, dus vóór de preview en zonder weg
        // te komen met Annuleren. Ze gaan nu mee in `wachtendeImport` en worden
        // pas in `bevestigImport` toegepast.
      }

      // Vastgelegde voorraadstanden per jaar
      const jaarBlad = wb.SheetNames.find(n => n.toLowerCase().replace(/[^a-z]/g,'') === 'voorraadperjaar');
      let jaarStanden = {};
      if (jaarBlad) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[jaarBlad], {header:1, defval:null});
        rows.slice(1).forEach(row => {
          const artikel = row[0], jaar = row[1];
          if (!artikel || !jaar) return;
          const sleutel = String(artikel).trim().toLowerCase();
          // Kolomvolgorde: Eindvoorraad, Ingekocht, Verkocht, Retour. Oudere
          // exports hadden alleen Eindvoorraad en Verkocht; dan blijft de rest
          // leeg in plaats van dat er een verkeerd getal in landt.
          const g = v => (typeof v === 'number' ? v : null);
          const heeftInkoopKolom = rows[0] && String(rows[0][3] ?? '').toLowerCase().includes('ingekocht');
          (jaarStanden[sleutel] ||= {})[String(jaar)] = heeftInkoopKolom
            ? { eind: g(row[2]), inkoop: g(row[3]), verkocht: g(row[4]), retour: g(row[5]) }
            : { eind: g(row[2]), inkoop: null, verkocht: g(row[3]), retour: null };
        });
        if (newCovers.length) {
          newCovers.forEach(c => {
            const gevonden = jaarStanden[String(c.artikel).trim().toLowerCase()];
            if (gevonden) c.jaren = { ...(c.jaren || {}), ...gevonden };
          });
        }
      }

      // Lees begin/eindsaldo per maand
      let newSaldos = {};
      bankSheets.forEach(sheetName => {
        if (!wb.SheetNames.includes(sheetName)) return;
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
        const maand = sheetName.slice(-7); // bijv. 2026-01
        let begin = null, eind = null;
        rows.forEach(row => {
          if (row[8] === 'Beginsaldo' && typeof row[9] === 'number') begin = row[9];
          if (row[8] === 'Eindsaldo' && typeof row[9] === 'number') eind = row[9];
        });
        if (begin !== null || eind !== null) newSaldos[maand] = {begin, eind};
      });

      // Valideer: alleen opslaan als er transacties zijn
      if (newTx.length === 0) {
        document.getElementById('import-title').textContent = 'Niets gevonden';
        document.getElementById('import-body').innerHTML = '⚠️ Er zijn geen transacties gevonden in dit bestand.<br>Controleer of je het juiste Excel bestand hebt geselecteerd (bijv. Administratie_2026.xlsx).';
        document.getElementById('import-actions').style.display = 'flex';
        return;
      }

      // ---------------------------------------------------------------
      // Vanaf hier wordt er NIETS meer automatisch weggeschreven. Het gelezen
      // bestand gaat eerst als plan naar het scherm; pas na bevestiging wordt
      // het toegepast. Een import overschreef eerder ongemerkt hele jaren,
      // inclusief voorraad en HNVI-loten.
      wachtendeImport = {
        wb, newTx, newCovers, newSaldos, nieuweLoten, gevondenJaren, tid,
        bankCount, ccCount, lotCount: nieuweLoten.length, coverCount: newCovers.length,
        ccProblemen, ccConventie, bestandsnaam: file.name
      };
      toonImportPreview();
    } catch(err) {
      document.getElementById('import-title').textContent = 'Fout bij importeren';
      document.getElementById('import-body').innerHTML = 'Er ging iets mis: ' + err.message + '<br><br>Controleer of je het juiste Excel bestand hebt geselecteerd.';
      document.getElementById('import-actions').style.display = 'flex';
    }
  };
  reader.readAsArrayBuffer(file);
}

// ------------------------------------------------- import: eerst tonen, dan pas schrijven

let wachtendeImport = null;

const _esc = t => String(t ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Wat de import zou doen, zonder het te doen. */
export function bouwImportPlan(p) {
  const isHuidig = p.gevondenJaren.some(isTxJaar);   // het bestand hoort bij de huidige groep (2026 en later)
  const jarenMetRegels = [...new Set(p.newTx.map(t => t.datum.slice(0,4)))].sort();
  const txJaren = p.gevondenJaren.filter(isTxJaar);
  const legeJaren = p.gevondenJaren.filter(j => !jarenMetRegels.includes(j));

  // Welke bestaande records verdwijnen? Bij een historische import worden de
  // jaren met regels volledig vervangen; bij 2026 de hele lijst.
  const bestaandHist = Array.isArray(state.HIST_TX) ? state.HIST_TX : [];
  const bestaandTx = Array.isArray(state.TX) ? state.TX : [];
  const vervangen = isHuidig
    ? bestaandTx.filter(t => txJaren.includes(jaarVan(t.datum))).length
    : bestaandHist.filter(t => jarenMetRegels.some(j => String(t.datum).startsWith(j))).length;

  // Boekingen waarvan de datum buiten het tabblad valt waar ze vandaan komen:
  // dat wijst op een verschoven datum of een jaargrensprobleem.
  const buitenJaar = p.newTx.filter(t => !p.gevondenJaren.includes(t.datum.slice(0,4)));

  const covers = Array.isArray(state.COVERS) ? state.COVERS : [];
  const loten = Array.isArray(state.HNVI_LOTS) ? state.HNVI_LOTS : [];

  return {
    isHuidig, is2026: isHuidig, jarenMetRegels, legeJaren, vervangen, buitenJaar,
    nieuw: p.newTx.length,
    doelSleutel: isHuidig ? 'xtenate_tx' : 'xtenate_hist_tx_override',
    voorraadVervangen: p.newCovers.length > 0 ? { van: covers.length, naar: p.newCovers.length } : null,
    lotenVervangen: p.lotCount > 0 ? { van: loten.length, naar: p.lotCount } : null,
    saldoMaanden: Object.keys(p.newSaldos || {}).length,
    ccProblemen: p.ccProblemen || [],
    ccConventie: p.ccConventie
  };
}

function toonImportPreview() {
  const p = wachtendeImport;
  const plan = bouwImportPlan(p);
  const waarschuwing = plan.buitenJaar.length || plan.ccProblemen.length
    || (plan.voorraadVervangen && plan.voorraadVervangen.naar < plan.voorraadVervangen.van);

  document.getElementById('import-title').textContent = 'Controleer de import';
  document.getElementById('import-body').innerHTML =
    `<div class="alert ${waarschuwing ? 'alert-error' : 'alert-info'}" style="margin-bottom:12px">
       <strong>Er is nog niets opgeslagen.</strong> Dit is wat de import zou doen met
       <code>${_esc(p.bestandsnaam || 'het bestand')}</code>.
     </div>
     <table class="tbl-compact" style="width:100%">
       <tbody>
         <tr><td class="muted" style="width:210px">Doelsleutel</td>
             <td><code>${_esc(plan.doelSleutel)}</code></td></tr>
         <tr><td class="muted">Jaren die worden geraakt</td>
             <td><strong>${_esc(plan.jarenMetRegels.join(', ') || 'geen')}</strong>
             ${plan.legeJaren.length ? `<br><span class="muted">tabbladen zonder boekingen, worden overgeslagen: ${_esc(plan.legeJaren.join(', '))}</span>` : ''}</td></tr>
         <tr><td class="muted">Bestaande records die verdwijnen</td>
             <td class="${plan.vervangen ? 'neg' : ''}"><strong>${plan.vervangen}</strong></td></tr>
         <tr><td class="muted">Nieuwe records die erbij komen</td>
             <td><strong>${plan.nieuw}</strong> — ${p.bankCount} bank, ${p.ccCount} creditcard</td></tr>
         <tr><td class="muted">Maandsaldi</td><td>${plan.saldoMaanden}</td></tr>
         ${plan.voorraadVervangen ? `<tr><td class="muted">Voorraad wordt vervangen</td>
             <td class="${plan.voorraadVervangen.naar < plan.voorraadVervangen.van ? 'neg' : ''}">
             ${plan.voorraadVervangen.van} → ${plan.voorraadVervangen.naar} artikelen</td></tr>` : ''}
         ${plan.lotenVervangen ? `<tr><td class="muted">HNVI-loten worden vervangen</td>
             <td>${plan.lotenVervangen.van} → ${plan.lotenVervangen.naar} loten</td></tr>` : ''}
         <tr><td class="muted">Datums buiten hun eigen jaar</td>
             <td class="${plan.buitenJaar.length ? 'neg' : 'pos'}">${plan.buitenJaar.length}
             ${plan.buitenJaar.length ? `<br><span class="muted">${_esc(plan.buitenJaar.slice(0,5).map(t => t.datum + ' ' + (t.naam||'')).join(' · '))}</span>` : ''}</td></tr>
         <tr><td class="muted">Tekens op de creditcard</td>
             <td>${plan.ccConventie ? `uitgaven staan ${_esc(plan.ccConventie)} in dit bestand` : 'geen creditcardblad'}
             ${plan.ccProblemen.length ? `<br><span class="neg">${plan.ccProblemen.length} regel(s) met een tegengesteld teken, gelezen als terugstorting:</span>
             <br><span class="muted">${_esc(plan.ccProblemen.slice(0,5).map(r => r.datum + ' ' + r.bedrag + ' ' + r.omschr).join(' · '))}</span>` : ''}</td></tr>
       </tbody>
     </table>
     <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
       <button class="btn" onclick="annuleerImport()">Annuleren</button>
       <button class="btn btn-primary" id="import-bevestig-knop" onclick="bevestigImport()">Importeren en opslaan</button>
     </div>`;
  document.getElementById('import-actions').style.display = 'none';
}

export function annuleerImport() {
  wachtendeImport = null;
  document.getElementById('modal-import').classList.remove('open');
}

/** Past de gelezen import toe. Dit is de enige plek die daarbij schrijft. */
/**
 * Toont een duidelijke melding als de cloud-synchronisatie tijdens het
 * importeren mislukt (geheel of gedeeltelijk). De lokale gegevens in deze
 * sessie zijn op dit moment altijd al bijgewerkt \u2014 dat gebeurt v\u00f3\u00f3r de
 * cloud-stap \u2014 dus die worden hier niet teruggedraaid; de melding maakt
 * alleen duidelijk dat de cloud nog niet overeenkomt met wat je nu ziet.
 */
function toonImportCloudFout(fout) {
  document.getElementById('import-title').textContent = 'Import gedeeltelijk gelukt';
  document.getElementById('import-body').innerHTML =
    `<div class="alert alert-error" style="margin-bottom:12px">
       <strong>Niet volledig naar de cloud geschreven.</strong><br>
       De lokale gegevens in deze sessie zijn wel bijgewerkt en hieronder al zichtbaar,
       maar konden niet (volledig) worden opgeslagen in Supabase.<br><br>
       Reden: ${_esc(fout)}
     </div>
     <div class="muted">Probeer de import opnieuw, of controleer je verbinding voordat je verdergaat.
     Na het verversen van de pagina op een ander apparaat kan dit verschil zichtbaar worden.</div>`;
  document.getElementById('import-actions').style.display = 'flex';
  renderHome();
}

export async function bevestigImport() {
  const p = wachtendeImport;
  if (!p) return;
  wachtendeImport = null;

  // Vergrendelen, synchroon, v\u00f3\u00f3r er ook maar iets async gebeurt. De regel
  // hierboven (`wachtendeImport = null`) voorkomt op zichzelf al een dubbele
  // uitvoering \u2014 een tweede klik heeft dan niets meer om te doen \u2014 maar zonder
  // dit bleef de knop nog even aanklikbaar ogen terwijl er al niets meer
  // gebeurde. Dit maakt dat ook zichtbaar, net als bij doWis().
  maakHerstelpunt('vóór Excel-import');
  const bevestigKnop = document.getElementById('import-bevestig-knop');
  if (bevestigKnop) { bevestigKnop.disabled = true; bevestigKnop.textContent = 'Bezig...'; }

  try {
      const isHuidig = p.gevondenJaren.some(isTxJaar);
      const txJaren = p.gevondenJaren.filter(isTxJaar);
      const jaarLabel = p.gevondenJaren.join(', ') || 'onbekend jaar';

      // HNVI-loten: gelezen in de leesfase, maar pas hier toegepast.
      // Veiligheid: levert het bestand veel minder loten op dan er nu staan, dan is
      // er waarschijnlijk iets mis met het blad. Dan laten we de loten ongemoeid.
      const veelMinderLoten = state.HNVI_LOTS.length >= 5 && p.nieuweLoten && p.nieuweLoten.length < state.HNVI_LOTS.length / 2;
      if (veelMinderLoten) {
        console.warn(`Excel levert ${p.nieuweLoten.length} loten op tegen ${state.HNVI_LOTS.length} nu: HNVI-loten niet vervangen.`);
      }
      if (p.nieuweLoten && p.nieuweLoten.length && !veelMinderLoten) {
        // Het blad vervangt de hele lijst. De loten die er niet meer in staan
        // moeten ook uit de cloud, anders blijven ze daar staan en komen ze bij
        // de volgende synchronisatie gewoon weer terug.
        const oudeSleutels = state.HNVI_LOTS.map(l => String(l._key || l.id));
        const nieuweSleutels = new Set(p.nieuweLoten.map(l => String(l._key || l.id)));
        const verdwenen = oudeSleutels.filter(k => !nieuweSleutels.has(k));

        state.HNVI_LOTS = p.nieuweLoten;
        // Wat de Excel niet kent (verkoopdatum, aantal, opbrengst-in-bank) blijft behouden.
        pasHnviDatumsToe(); pasHnviExtraToe();
        saveHnviData();

        for (const sleutel of verdwenen) {
          deleteFromSupabase(sleutel, 'hnvi').catch(() => {
            addToPendingQueue({ id: sleutel }, 'delete', false, 'hnvi');
          });
        }
        if (verdwenen.length) {
          console.log(`\u{1F5D1}\uFE0F  ${verdwenen.length} oud(e) lot(en) opgeruimd uit de cloud.`);
        }
        // De nieuwe loten alsnog in de wachtrij, zodat ze zeker aankomen.
        p.nieuweLoten.forEach(l => addToPendingQueue(l, 'hnvi', false));
      }

      if (isHuidig) {
        // Sla op als huidige data (2026 en later); alleen de jaren uit dit bestand worden vervangen. Handmatig aangemaakte boekingen die
        // niet in het geïmporteerde bestand voorkomen, blijven staan — anders
        // verdwijnt een handmatige toevoeging zodra je later een Excel-bestand
        // voor hetzelfde jaar importeert.
        const overigeJaren = state.TX.filter(t => !txJaren.includes(jaarVan(t.datum)));
        const teBehouden = state.TX.filter(t =>
          txJaren.includes(jaarVan(t.datum)) &&
          t.bron === 'handmatig' && !p.newTx.some(nt => String(nt.id) === String(t.id)));
        // Boekingen van andere jaren blijven staan. Het bestand telt zijn eigen
        // nummers vanaf 500; die mogen niet botsen met wat er al is.
        let volgendNr = p.tid;
        if (overigeJaren.length) {
          const hoogste = state.TX.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
          volgendNr = Math.max(p.tid, hoogste + 1, state.nxtTx || 0);
          p.newTx.forEach(t => { t.id = volgendNr++; });
        }
        state.TX = [...overigeJaren, ...p.newTx, ...teBehouden];
        state.nxtTx = Math.max(volgendNr, p.tid);
        if (p.newCovers.length > 0) { state.COVERS = normaliseerVoorraad(p.newCovers, state.COVERS); state.nxtCover = 300; }
        Object.keys(MAAND_SALDOS).filter(m => txJaren.some(j => m.startsWith(j))).forEach(m=>delete MAAND_SALDOS[m]);
        Object.assign(MAAND_SALDOS, p.newSaldos);
        saveTxData();
        saveCoversData();
        // De maandsaldi stonden hier alleen in het geheugen; na een herlaadbeurt
        // waren ze weg. De historische tak sloeg ze al wel op.
        save('xtenate_maand_saldos_override', MAAND_SALDOS);

        // De boekingen gingen hierboven alleen naar localStorage. Bij het laden
        // haalt de app ze uit Supabase, dus na een refresh kwam de oude set
        // terug en leek de import niet gewerkt te hebben. Het jaar wordt nu in
        // de database vervangen door wat er zojuist is ingelezen.
        //
        // Dit wordt nu afgewacht in plaats van los weggevuurd: "Import
        // geslaagd" mag pas verschijnen als de cloud dat ook echt heeft
        // bevestigd, niet al zodra de lokale kant klaar is.
        document.getElementById('import-title').textContent = 'Bezig met opslaan...';
        document.getElementById('import-body').innerHTML =
          `<div class="muted">De boekingen van ${_esc(txJaren.join(', '))} worden naar de cloud geschreven, dit kan even duren…</div>`;
        document.getElementById('import-actions').style.display = 'none';

        const rHuidig = await vervangBoekingenInSupabase(state.TX, { isHistoric: false });
        if (rHuidig.fout) {
          console.warn('⚠️  Boekingen niet (volledig) naar Supabase geschreven:', rHuidig.fout);
          toonImportCloudFout(rHuidig.fout);
          return;
        }
      } else {
        // Sla op als historische data: vervang alleen de jaren die in dit bestand voorkomen
        // Alleen jaren vervangen waarvoor het bestand ook werkelijk boekingen
        // bevat. Een leeg tabblad "Bank 2023-05" maakte anders het hele jaar
        // 2023 leeg zonder dat er iets voor terugkwam.
        const jarenMetRegels = [...new Set(p.newTx.map(t => t.datum.slice(0,4)))];
        const legeJaren = p.gevondenJaren.filter(j => !jarenMetRegels.includes(j));
        // Handmatig aangemaakte/bewerkte boekingen in een geraakt jaar blijven
        // staan, ook al komen ze niet in dit bestand voor — zelfde reden als
        // bij het lopende jaar hierboven.
        state.HIST_TX = state.HIST_TX.filter(t =>
          !jarenMetRegels.some(j => t.datum.startsWith(j)) || t.bron === 'handmatig');
        state.HIST_TX = [...state.HIST_TX, ...p.newTx.map(t => ({...t, id: 'h' + jaarLabel.replace(/, /g,'_') + '_' + t.id}))];
        jarenMetRegels.forEach(j => {
          Object.keys(MAAND_SALDOS).filter(m=>m.startsWith(j)).forEach(m=>delete MAAND_SALDOS[m]);
        });
        if (legeJaren.length) console.warn('Overgeslagen: tabbladen zonder boekingen voor', legeJaren.join(', '));

        // De voorraadgegevens van een afgesloten jaar werden hier weggegooid,
        // waardoor je na het importeren van 2026 niet meer kon zien wat er in
        // 2024 op voorraad lag. Die cijfers gaan nu wel mee, zonder de huidige
        // voorraad te overschrijven.
        if (p.newCovers.length) {
          state.COVERS = voegJaarcijfersToe(state.COVERS, p.newCovers);
          saveCoversData();
        }
        Object.assign(MAAND_SALDOS, p.newSaldos);
        save('xtenate_hist_tx_override', state.HIST_TX);
        save('xtenate_maand_saldos_override', MAAND_SALDOS);

        // Ook hier gold dat de boekingen alleen lokaal werden bewaard. Alleen
        // de jaren uit dit bestand worden in de database vervangen; de overige
        // archiefjaren blijven staan.
        const nieuwVoorDezeJaren = state.HIST_TX.filter(
          t => jarenMetRegels.some(j => t.datum.startsWith(j)));

        document.getElementById('import-title').textContent = 'Bezig met opslaan...';
        document.getElementById('import-body').innerHTML =
          `<div class="muted">De boekingen van ${_esc(jarenMetRegels.join(', '))} worden naar de cloud geschreven, dit kan even duren…</div>`;
        document.getElementById('import-actions').style.display = 'none';

        const rHistorisch = await vervangBoekingenInSupabase(
          nieuwVoorDezeJaren, { isHistoric: true, jaren: jarenMetRegels });
        if (rHistorisch.fout) {
          console.warn('⚠️  Boekingen niet (volledig) naar Supabase geschreven:', rHistorisch.fout);
          toonImportCloudFout(rHistorisch.fout);
          return;
        }
      }

      // Jaartotalen uit "Per Periode" (indien aanwezig) — leidend voor de Home-cijfers.
      // Terugval per rekening: optellen uit de zojuist ingelezen losse boekingen (p.newTx),
      // voor het geval een deel van het "Per Periode"-tabblad #N/A-fouten bevat.
      const fallbackTotals = {
        omzXt: p.newTx.filter(t => t.type==='inkomst' && t.gb==='8000').reduce((s,t)=>s+t.bedrag,0),
        omzBol: p.newTx.filter(t => t.type==='inkomst' && t.gb==='8010').reduce((s,t)=>s+t.bedrag,0),
        omzHC: p.newTx.filter(t => t.type==='inkomst' && t.gb==='8020').reduce((s,t)=>s+t.bedrag,0),
        omzet: p.newTx.filter(t => t.type==='inkomst' && OMZET_GB.includes(t.gb)).reduce((s,t)=>s+t.bedrag,0),
        kosten: p.newTx.filter(t => t.type==='uitgave').reduce((s,t)=>s+t.bedrag,0),
        priveOp: p.newTx.filter(t => t.type==='prive_opname').reduce((s,t)=>s+t.bedrag,0),
        priveSt: p.newTx.filter(t => t.type==='prive_storting').reduce((s,t)=>s+t.bedrag,0),
        hnviInv: p.newTx.filter(t => t.gb==='7010').reduce((s,t)=>s+t.bedrag,0)
      };
      // Staat er een blad "Jaartotalen" in (dat schrijft onze eigen export weg),
      // dan zijn die cijfers per jaar leidend. Per Periode is een berekend
      // overzicht en levert voor kosten en prive-stortingen andere bedragen op.
      const jtBlad = p.wb.SheetNames.find(n => n.toLowerCase().replace(/[^a-z]/g,'') === 'jaartotalen');
      let uitJaartotalen = 0;
      if (jtBlad) {
        const rows = XLSX.utils.sheet_to_json(p.wb.Sheets[jtBlad], {header:1, defval:null});
        rows.slice(1).forEach(row => {
          const jaar = row[0];
          if (!jaar || typeof row[1] !== 'number') return;
          HOME_TOTALS[String(jaar)] = {
            omzet: row[1] || 0, kosten: row[2] || 0, omzXt: row[3] || 0, omzBol: row[4] || 0,
            omzHC: row[5] || 0, priveOp: row[6] || 0, priveSt: row[7] || 0, hnviInv: row[8] || 0
          };
          uitJaartotalen++;
        });
        if (uitJaartotalen) save('xtenate_home_totals_override', HOME_TOTALS);
      }

      const perPeriodeTotals = uitJaartotalen ? null : parsePerPeriode(p.wb, fallbackTotals);
      if (perPeriodeTotals) {
        p.gevondenJaren.forEach(j => { HOME_TOTALS[j] = perPeriodeTotals; });
        save('xtenate_home_totals_override', HOME_TOTALS);
      }

      const saldoCount = Object.keys(p.newSaldos).length;
      document.getElementById('import-title').textContent = 'Import geslaagd!';
      document.getElementById('import-body').innerHTML =
        `📅 Jaar: <strong>${jaarLabel}</strong><br>` +
        `✅ <strong>${p.bankCount}</strong> banktransacties ingelezen<br>` +
        `✅ <strong>${p.ccCount}</strong> creditkaart boekingen ingelezen<br>` +
        (p.ccStortingen > 0 ? `✅ <strong>${p.ccStortingen}</strong> gekoppelde privé stortingen aangemaakt (€ ${p.ccStortingBedrag.toFixed(2)})<br>` : '') +
        (saldoCount > 0 ? `✅ <strong>${saldoCount}</strong> maandsaldos ingelezen<br>` : '') +
        (p.lotCount > 0 ? `✅ <strong>${p.lotCount}</strong> HNVI-loten ingelezen<br>` : '') +
        (p.newCovers.length > 0 ? `✅ <strong>${p.coverCount}</strong> covers artikelen ingelezen<br>` : '') +
        (perPeriodeTotals ? `✅ Jaartotalen (omzet/kosten/privé) ingelezen uit "Per Periode" — dit is nu leidend voor de Home-cijfers van dit jaar<br>` : `⚠️ Geen "Per Periode" tabblad gevonden — Home-cijfers worden voor dit jaar nog berekend uit losse boekingen<br>`) +
        `<br>Je data is opgeslagen. HNVI-loten blijven bewaard.`;
      document.getElementById('import-actions').style.display = 'flex';


      renderHome();
  } catch (err) {
    document.getElementById('import-title').textContent = 'Fout bij importeren';
    document.getElementById('import-body').innerHTML = 'Er ging iets mis: ' + err.message;
    document.getElementById('import-actions').style.display = 'flex';
  }
}

export function herstelHistorischeData() {
  if (!window.confirm('Dit herstelt de historische jaren (2022 t/m 2025) naar de standaard/gecorrigeerde data uit de app zelf, en overschrijft eventuele lokale wijzigingen in je browser voor die jaren. 2026 blijft ongewijzigd. Doorgaan?')) {
    return;
  }
  try {
    state.HIST_TX = JSON.parse(JSON.stringify(HIST_TX_DEFAULT));
    save('xtenate_hist_tx_override', state.HIST_TX);
    localStorage.removeItem('xtenate_maand_saldos_override');

    // Ook de jaartotalen (omzet/kosten/privé) terugzetten — dit was eerder al eens
    // los gecachet in localStorage (bijv. als leeg object {} uit een oudere versie
    // van de app) en bleef daardoor de nieuwe, gecorrigeerde standaardwaarden overstemmen.
    Object.keys(HOME_TOTALS).forEach(k => delete HOME_TOTALS[k]);
    Object.assign(HOME_TOTALS, JSON.parse(JSON.stringify(HOME_TOTALS_DEFAULT)));
    save('xtenate_home_totals_override', HOME_TOTALS);

    document.getElementById('modal-wis').classList.remove('open');
    renderHome();
    window.alert('Klaar! Historische data (2022-2025) én de jaartotalen zijn hersteld naar de standaardwaarden uit de app.');
  } catch (err) {
    window.alert('Er ging iets mis: ' + err.message);
  }
}

export function openWisModal() {
  document.getElementById('wis-status').textContent = '';
  document.getElementById('modal-wis').classList.add('open');
}

/**
 * Telt wat een wis-actie zou raken, zonder iets te verwijderen. Leest dezelfde
 * checkboxes als `doWis()`, roept `previewWisJaren()` aan (alleen SELECT/count)
 * en toont het resultaat in het venster. Bedoeld om vóór een echte wis-actie
 * te controleren of sessie, tabellen en aantallen kloppen.
 */
export async function toonWisPreview() {
  // gebruikt _esc(), gedefinieerd verderop in dit bestand
  const status = document.getElementById('wis-status');
  const uit = document.getElementById('wis-preview');
  const knop = document.getElementById('wis-preview-knop');

  const jaren = ['2026','2025','2024','2023','2022'].filter(j => {
    const el = document.getElementById('wis-' + j);
    return el && el.checked;
  });
  if (jaren.length === 0) {
    status.textContent = 'Selecteer minimaal één jaar.';
    uit.innerHTML = '';
    return;
  }

  if (knop) { knop.disabled = true; knop.textContent = 'Bezig met tellen…'; }
  status.textContent = '';
  uit.innerHTML = '';

  try {
    const r = await previewWisJaren(jaren);
    if (!r.ok) {
      uit.innerHTML = `<span class="neg">Preview mislukt: ${_esc(r.fout)}</span>`;
      return;
    }

    const regels = [];
    if (r.huidig) {
      regels.push(`2026 — boekingen: <strong>${r.huidig.boekingen}</strong>`);
    }
    for (const [jaar, aantal] of Object.entries(r.historisch)) {
      regels.push(`${jaar} — boekingen: <strong>${aantal}</strong>`);
    }
    if (r.voorraad != null) {
      regels.push(`Voorraadartikelen (alle jaren, want geen jaarveld): <strong>${r.voorraad}</strong>`);
    }
    regels.push('hnvi_loten: <strong>niet meegenomen</strong> — deze telling en de wis-actie raken die tabel nooit.');

    uit.innerHTML =
      `<div style="padding:8px 10px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-card)">` +
      `<div class="muted" style="margin-bottom:4px">Dit zou er geraakt worden bij het wissen van ${_esc(jaren.join(', '))} — er is nog niets verwijderd:</div>` +
      regels.map(r => `<div>${r}</div>`).join('') +
      `</div>`;
  } catch (err) {
    uit.innerHTML = `<span class="neg">Preview mislukt: ${_esc(err.message)}</span>`;
  } finally {
    if (knop) { knop.disabled = false; knop.textContent = 'Preview (alleen tellen)'; }
  }
}

export async function doWis() {
  const status = document.getElementById('wis-status');
  const knop = document.getElementById('wis-bevestig');

  const jaren = ['2026','2025','2024','2023','2022'].filter(j => {
    const el = document.getElementById('wis-' + j);
    return el && el.checked;
  });

  if (jaren.length === 0) {
    status.textContent = 'Selecteer minimaal één jaar.';
    return;
  }

  // "2026 wissen" maakt de hele huidige groep leeg (state.TX), ook de boekingen
  // van latere jaren. Dat laten we niet toe zolang er zulke boekingen zijn.
  const laterJaren = [...new Set(state.TX.map(t => jaarVan(t.datum)))].filter(j => isTxJaar(j) && !jaren.includes(j));
  if (jaren.some(isTxJaar) && laterJaren.length) {
    status.textContent = `Wissen van ${jaren.filter(isTxJaar).join(', ')} is nu niet mogelijk: het zou ook de boekingen van ${laterJaren.join(', ')} verwijderen.`;
    window.alert(status.textContent);
    return;
  }
  const wistVoorraad = jaren.includes('2026');
  const waarschuwing = wistVoorraad
    ? '\n\nLet op: 2026 aanvinken verwijdert ook al je voorraadartikelen volledig, ' +
      'inclusief hun geschiedenis over alle jaren — niet alleen dit boekjaar. ' +
      'Voorraadartikelen kennen geen jaargrens.'
    : '';
  if (!window.confirm(
    'Weet je zeker dat je data van ' + jaren.join(', ') + ' wilt wissen? ' +
    'Dit kan niet ongedaan gemaakt worden.' + waarschuwing
  )) {
    return;
  }

  // Vergrendel de knop: een tweede klik terwijl dit nog loopt zou een tweede
  // wis-actie tegelijk starten, met alle race conditions van dien.
  maakHerstelpunt('vóór het wissen van ' + jaren.join(', '));
  if (knop) { knop.disabled = true; knop.textContent = 'Bezig met wissen…'; }
  status.textContent = 'Bezig: eerst de cloud, dan pas lokaal…';

  try {
    // Eerst de cloud. Lukt dit niet volledig, dan raken we hieronder niets
    // lokaal aan — de administratie blijft dan exact zoals hij was, ook al
    // is er in de cloud misschien al wel iets weg (zie de melding hieronder
    // voor dat specifieke geval).
    const cloud = await wisJarenInSupabase(jaren);

    if (!cloud.ok) {
      if (cloud.stap === 'voorraad') {
        status.textContent =
          `Boekingen zijn verwijderd uit de cloud (${cloud.boekingenVerwijderd}×), ` +
          `voorraad niet: ${cloud.fout}. Er is lokaal niets gewist. ` +
          `Probeer het wissen opnieuw om ook de voorraad te verwijderen.`;
      } else {
        status.textContent = `Niets gewist: ${cloud.fout}`;
      }
      window.alert(status.textContent);
      return;
    }

    // Nu pas lokaal — de cloud is op dit punt bevestigd leeg voor deze jaren.
    let wisLog = [];

    jaren.forEach(j => { delete HOME_TOTALS[j]; });
    save('xtenate_home_totals_override', HOME_TOTALS);

    if (jaren.includes('2026')) {
      state.TX = [];
      state.COVERS = [];
      state.nxtTx = 200; state.nxtCover = 100;
      saveTxData(); saveCoversData();
      wisLog.push(`2026 gewist (${cloud.boekingenVerwijderd} boekingen, ${cloud.voorraadVerwijderd} artikelen — HNVI/Xtenate-loten blijven bewaard)`);
    }

    const histJaren = jaren.filter(j => j !== '2026');
    if (histJaren.length > 0) {
      state.HIST_TX = state.HIST_TX.filter(t => !histJaren.some(j => t.datum.startsWith(j)));
      histJaren.forEach(j => {
        Object.keys(MAAND_SALDOS).filter(m => m.startsWith(j)).forEach(m => delete MAAND_SALDOS[m]);
      });
      save('xtenate_hist_tx_override', state.HIST_TX);
      save('xtenate_maand_saldos_override', MAAND_SALDOS);
      wisLog.push(histJaren.join(', ') + ' gewist');
    }

    document.getElementById('modal-wis').classList.remove('open');
    renderHome();
    window.alert('Klaar! ' + wisLog.join(' / ') + ' — lokaal en in de cloud. Je kunt nu opnieuw importeren.');
  } catch (err) {
    // Een onverwachte fout ná de cloud-stap maar vóór het lokale wissen kan in
    // theorie voorkomen (bijv. een fout in save()); ook dan geldt: als we hier
    // zijn, is een deel van de lokale stappen misschien al gezet en een deel
    // niet. Dat is dezelfde grens die in het ontwerp is benoemd voor stap 9
    // (pagina sluiten tijdens het wissen) — de eerstvolgende keer laden trekt
    // dit recht vanuit de nu al lege cloud.
    status.textContent = 'Fout: ' + err.message;
    window.alert('Er ging iets mis: ' + err.message);
  } finally {
    if (knop) { knop.disabled = false; knop.textContent = 'Wis geselecteerd'; }
  }
}

export function openSyncModal() {
  const url = localStorage.getItem('xtenate_sync_url') || '';
  document.getElementById('sync-url-input').value = url;
  document.getElementById('sync-modal-status').textContent = url ? 'Sync URL is ingesteld.' : 'Nog geen sync URL ingesteld.';
  document.getElementById('modal-sync').classList.add('open');
}

export function saveSyncUrl() {
  const url = document.getElementById('sync-url-input').value.trim();
  if (url) {
    localStorage.setItem('xtenate_sync_url', url);
    document.getElementById('sync-modal-status').textContent = 'Opgeslagen!';
  } else {
    localStorage.removeItem('xtenate_sync_url');
  }
}

export function getSyncUrl() {
  return localStorage.getItem('xtenate_sync_url');
}

export async function syncUpload() {
  const url = getSyncUrl();
  if (!url) { document.getElementById('sync-modal-status').textContent = 'Stel eerst een sync URL in.'; return; }
  document.getElementById('sync-modal-status').textContent = 'Uploaden...';
  try {
    const payload = {
      TX: state.TX,
      Covers: state.COVERS,
      HnviLots: state.HNVI_LOTS,
      Inkoop: typeof INKOOP !== 'undefined' ? INKOOP : [],
      MaandSaldos: MAAND_SALDOS,
      _device: navigator.userAgent.includes('Mobile') ? 'telefoon' : 'computer'
    };
    const response = await fetch(url + '?action=save', {
      method: 'POST',
      headers: {'Content-Type': 'text/plain'},
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('sync-modal-status').textContent = '✅ Geüpload! ' + new Date().toLocaleTimeString('nl-NL');
  } catch (err) {
    document.getElementById('sync-modal-status').textContent = '❌ Fout: ' + err.message;
  }
}

export async function syncDownload() {
  const url = getSyncUrl();
  if (!url) { document.getElementById('sync-modal-status').textContent = 'Stel eerst een sync URL in.'; return; }
  if (!window.confirm('Dit overschrijft je lokale data met de cloud data. Doorgaan?')) return;
  document.getElementById('sync-modal-status').textContent = 'Downloaden...';
  try {
    const response = await fetch(url + '?action=load');
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    if (data.TX && data.TX.length) { state.TX = data.TX; saveTxData(); }
    if (data.Covers && data.Covers.length) { state.COVERS = normaliseerVoorraad(data.Covers, state.COVERS); saveCoversData(); }
    if (data.HnviLots) { state.HNVI_LOTS = data.HnviLots; saveHnviData(); }
    if (data.MaandSaldos) { Object.assign(MAAND_SALDOS, data.MaandSaldos); }

    document.getElementById('sync-modal-status').textContent = '✅ Gedownload! ' + new Date().toLocaleTimeString('nl-NL');
    renderHome();
  } catch (err) {
    document.getElementById('sync-modal-status').textContent = '❌ Fout: ' + err.message;
  }
}

export function openApiKeyModal() {
  const current = localStorage.getItem('xtenate_apikey') || '';
  document.getElementById('apikey-input').value = current;
  document.getElementById('modal-apikey').classList.add('open');
}

export function saveApiKey() {
  const key = document.getElementById('apikey-input').value.trim();
  if (key) localStorage.setItem('xtenate_apikey', key);
  else localStorage.removeItem('xtenate_apikey');
  document.getElementById('modal-apikey').classList.remove('open');
}
