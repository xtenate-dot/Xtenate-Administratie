// gegevenscontrole.js — vindt afwijkingen en biedt per stuk een keuze.
//
// Deze module WIJZIGT NIETS. Er staat geen setItem, geen removeItem, geen
// save() en geen verwijderactie in. De keuzes die je maakt worden voorlopig
// alleen in het geheugen van deze sessie bewaard; het wegschrijven ervan wordt
// pas gebouwd nadat je die stap goedkeurt.
//
// Drie mogelijke acties per melding:
//
//   corrigeren — de gegevens gaan naar de nieuwe waarde. Alleen aangeboden als
//                die waarde bewezen is.
//
//   verbergen  — de gegevens blijven staan maar worden ergens niet meer
//                meegenomen. Alleen aangeboden als exact vaststaat wát er dan
//                niet meer meetelt en waar. Zonder zo'n omschrijving is de knop
//                er niet: "verbergen" mag geen vage restcategorie worden.
//
//                Op dit moment kent het datamodel geen zichtbaarheidsvlag. Een
//                boeking heeft alleen datum, bedrag, gb, rek, type, naam,
//                omschr en id; een voorraadartikel heeft er ook geen. Het begrip
//                "verborgen" bestaat in deze app uitsluitend voor méldingen
//                (controle.js), niet voor gegevens. Daarom is verbergen nu bij
//                geen enkele melding beschikbaar. Zodra we vastleggen wat een
//                verborgen record betekent — in welke lijsten, totalen en
//                controles het wegvalt — vult verbergEffect zich vanzelf.
//
//   negeren    — er verandert niets aan de gegevens. Ze blijven volledig
//                functioneren zoals nu, in elke lijst, elk totaal en elke
//                berekening. Alleen deze melding wordt als bewust genegeerd
//                vastgelegd en komt niet terug als nieuwe waarschuwing.
//
// Verwijderen zit hier bewust niet in. Moet een record ooit weg, dan is dat een
// aparte handeling met een eigen bevestiging.

import { HIST_TX_DEFAULT, HOME_TOTALS_DEFAULT, CONTROLE_INSTELLINGEN, state } from './storage.js?v=20261025a';

export const ACTIES = { CORRIGEREN: 'corrigeren', VERBERGEN: 'verbergen', NEGEREN: 'negeren' };

/** Korte hash, om later te kunnen zien of de gegevens sinds de keuze wijzigden. */
async function vingerafdruk(tekst) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tekst));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    let h = 2166136261;
    for (let i = 0; i < tekst.length; i++) { h ^= tekst.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fnv-' + (h >>> 0).toString(16);
  }
}

const kenmerkZonderDatum = t => [
  Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek),
  String(t.naam || '').trim().toLowerCase(), String(t.omschr || '').trim().toLowerCase()
].join('|');

const dagen = (datum, n) => {
  const d = new Date(datum + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const geldigeDatum = t => /^\d{4}-\d{2}-\d{2}$/.test(String(t && t.datum || ''));
const geld = n => '€ ' + Number(n || 0).toFixed(2);

// --------------------------------------------------------------- de controles

/**
 * Koppelt de historie in de browser aan die in de code, op inhoud zonder datum.
 * Levert per boeking de voorgestelde datum en het nieuwe nummer.
 */
function koppelHistorie() {
  const mijn = (Array.isArray(state.HIST_TX) ? state.HIST_TX : []).filter(geldigeDatum);

  // Groeperen op inhoud zonder datum en zonder soort, en binnen elke groep
  // beide kanten op datum sorteren en op volgorde naast elkaar leggen.
  //
  // Per record de "dichtstbijzijnde" tegenhanger zoeken werkt hier niet. Bij
  // reeksen van dezelfde boeking — vijftien keer PostNL van 6,75 op
  // opeenvolgende dagen — pikt de een dan de tegenhanger van de ander in. Dat
  // gaat twee kanten op mis: op verschoven gegevens vindt hij er te weinig, en
  // op al herstelde gegevens ziet hij verschuivingen die er niet zijn, zodat
  // een tweede herstel de boekingen nóg een dag vooruit zou zetten. Koppelen op
  // volgorde houdt de reeks intact en geeft in beide gevallen het juiste beeld.
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
  const mijnGroepen = groepeer(mijn);
  const codeGroepen = groepeer(HIST_TX_DEFAULT);

  const verschoven = [];
  const soortAnders = [];
  const alGoed = [];
  const rest = [];

  new Set([...mijnGroepen.keys(), ...codeGroepen.keys()]).forEach(k => {
    const a = (mijnGroepen.get(k) || []).slice().sort(opDatum);
    const b = (codeGroepen.get(k) || []).slice().sort(opDatum);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const verschil = Math.round(
        (Date.parse(b[i].datum + 'T00:00:00Z') - Date.parse(a[i].datum + 'T00:00:00Z')) / 86400000);
      const paar = { mijn: a[i], code: b[i], eenduidig: true, kandidaten: 1 };
      if (verschil === 0 && a[i].type === b[i].type) alGoed.push(paar);
      else if (verschil === 0) soortAnders.push(paar);
      else if (verschil === 1) {
        if (a[i].type === b[i].type) verschoven.push(paar);
        else soortAnders.push(paar);
      } else rest.push(a[i]);
    }
    for (let i = n; i < a.length; i++) rest.push(a[i]);
  });

  return { verschoven, soortAnders, rest, alGoed, aantalMijn: mijn.length };
}

/** Bouwt alle meldingen op basis van de gegevens die nu in de browser staan. */
export async function bouwMeldingen() {
  const meldingen = [];
  const h = koppelHistorie();

  // De acties worden niet per melding opgegeven maar afgeleid, zodat er geen
  // knop kan opduiken die niet door bewijs of door een omschreven effect wordt
  // gedekt.
  const voegToe = async m => {
    m.vinger = await vingerafdruk(m.vingerBron ?? JSON.stringify(m.voorbeelden ?? m.huidigeWaarde ?? m.id));
    delete m.vingerBron;
    m.bewijsstatus = m.categorie === 'bewezen' ? 'BEWEZEN' : 'ONBEKEND';
    m.acties = [
      ...(m.correctieBewezen ? [ACTIES.CORRIGEREN] : []),
      ...(m.verbergEffect ? [ACTIES.VERBERGEN] : []),
      ACTIES.NEGEREN
    ];
    m.gevolgPerActie = {
      [ACTIES.CORRIGEREN]: m.correctieBewezen
        ? `${m.aantalRecords} record(s) in ${m.sleutel} krijgen de nieuwe waarde; er wordt niets verwijderd`
        : 'niet beschikbaar — de juiste waarde staat niet vast',
      [ACTIES.VERBERGEN]: m.verbergEffect || 'niet beschikbaar — er is niet vastgelegd wat verborgen hier zou betekenen',
      [ACTIES.NEGEREN]: 'de gegevens blijven volledig intact en werken zoals nu; alleen deze melding komt niet terug'
    };
    meldingen.push(m);
  };

  // --- 1. de datumverschuiving, als groep -----------------------------------
  const alleVerschoven = [...h.verschoven, ...h.soortAnders];
  if (alleVerschoven.length) {
    const jaren = {};
    alleVerschoven.forEach(p => { const j = p.code.datum.slice(0, 4); jaren[j] = (jaren[j] || 0) + 1; });
    const overJaargrens = alleVerschoven.filter(p => p.mijn.datum.slice(0, 4) !== p.code.datum.slice(0, 4));
    await voegToe({
      id: 'datum-verschuiving',
      categorie: 'bewezen',
      groep: true,
      titel: 'Historische boekingen staan één dag te vroeg',
      sleutel: 'xtenate_hist_tx_override',
      aantalRecords: alleVerschoven.length,
      reden: 'De Excel-import zette elke datumcel een dag terug door een tijdzonefout in excelDate. '
        + 'Bevestigd tegen het bankafschrift: de Bol.com-betaling van € 98,22 hoort op 2 augustus 2022.',
      huidigeWaarde: `${alleVerschoven.length} boekingen met de datum van de dag ervoor`,
      nieuweWaarde: `dezelfde ${alleVerschoven.length} boekingen, elk één dag later`,
      detail: Object.entries(jaren).sort().map(([j, n]) => `${j}: ${n}`).join(' · ')
        + (overJaargrens.length ? ` · ${overJaargrens.length} boeking(en) komen daardoor in het juiste jaar terecht` : ''),
      recordIds: alleVerschoven.map(p => String(p.mijn.id)),
      // De concrete mutaties, zodat de uitvoering de bestaande records gericht
      // kan aanpassen in plaats van de historie opnieuw op te bouwen. Het id
      // blijft staan; alleen het datumveld verandert.
      mutaties: alleVerschoven.map(p => ({
        sleutel: 'xtenate_hist_tx_override', recordId: String(p.mijn.id),
        veld: 'datum', van: p.mijn.datum, naar: p.code.datum
      })),
      voorbeelden: alleVerschoven.slice(0, 8).map(p => ({
        id: String(p.mijn.id), nu: p.mijn.datum, na: p.code.datum,
        bedrag: Number(p.mijn.bedrag), naam: p.mijn.naam || '(geen naam)', nieuwId: String(p.code.id)
      })),
      nietEenduidig: h.verschoven.filter(p => !p.eenduidig).length,
      correctieBewezen: true,
      vingerBron: alleVerschoven.map(p => p.mijn.id + '|' + p.mijn.datum).join(',')
    });

    if (overJaargrens.length) {
      for (const p of overJaargrens) {
        await voegToe({
          id: 'jaargrens::' + p.mijn.id,
          categorie: 'bewezen',
          titel: 'Boeking staat in het verkeerde jaar',
          sleutel: 'xtenate_hist_tx_override',
          aantalRecords: 1,
          reden: 'Door de datumverschuiving is deze boeking in het voorgaande jaar beland. '
            + `Het nummer draagt nog het voorvoegsel van het juiste jaar (${String(p.mijn.id)}).`,
          huidigeWaarde: `${p.mijn.datum} · ${geld(p.mijn.bedrag)} · ${p.mijn.naam || '(geen naam)'}`,
          nieuweWaarde: `${p.code.datum} · ${geld(p.code.bedrag)} · nummer ${p.code.id}`,
          detail: 'Wordt vanzelf opgelost zodra je de datumverschuiving corrigeert; '
            + 'een aparte correctie zou dubbelop zijn.',
          recordIds: [String(p.mijn.id)],
          correctieBewezen: false,
          vingerBron: JSON.stringify(p.mijn)
        });
      }
    }
  }

  // --- 2. omgewisselde soorten ---------------------------------------------
  for (const p of h.soortAnders) {
    await voegToe({
      id: 'soort::' + p.mijn.id,
      categorie: 'bewezen',
      titel: 'Soort van een privéboeking is omgewisseld',
      sleutel: 'xtenate_hist_tx_override',
      aantalRecords: 1,
      reden: 'De import bepaalt de soort op het teken van het bedrag en negeert het grootboek. '
        + 'In de codehistorie hoort grootboek 600 negen van de negen keer bij een storting en '
        + '601 negentien van de negentien keer bij een opname, zonder uitzondering.',
      huidigeWaarde: `${p.mijn.datum} · ${geld(p.mijn.bedrag)} · gb ${p.mijn.gb} · ${p.mijn.type}`,
      nieuweWaarde: `${p.code.datum} · ${geld(p.code.bedrag)} · gb ${p.code.gb} · ${p.code.type}`,
      detail: `Betreft: ${p.mijn.naam || '(geen naam)'}`,
      recordIds: [String(p.mijn.id)],
      mutaties: [{
        sleutel: 'xtenate_hist_tx_override', recordId: String(p.mijn.id),
        veld: 'type', van: p.mijn.type, naar: p.code.type
      }],
      correctieBewezen: true,
      vingerBron: JSON.stringify(p.mijn)
    });
  }

  // --- 3. jaartotaal 2022 privé-storting ------------------------------------
  // De referentiewaarde komt uit CONTROLE_INSTELLINGEN (Beheer), niet meer uit
  // de code: alleen jij weet welk bedrag het Per Periode-tabblad geeft. Is die
  // instelling nog leeg, dan slaat deze controle gewoon over.
  const referentiePriveSt2022 = CONTROLE_INSTELLINGEN?.jaartotaal2022PriveSt;
  const ht = (() => { try { return JSON.parse(localStorage.getItem('xtenate_home_totals_override') || 'null'); } catch { return null; } })();
  const st22 = ht && ht['2022'] ? Number(ht['2022'].priveSt) : null;
  if (referentiePriveSt2022 != null && st22 !== null && Math.abs(st22 - referentiePriveSt2022) > 0.005) {
    await voegToe({
      id: 'jaartotaal::2022::priveSt',
      categorie: 'bewezen',
      titel: 'Jaartotaal 2022 privé-storting wijkt af van de bron',
      sleutel: 'xtenate_home_totals_override',
      aantalRecords: 1,
      reden: `Het Per Periode-tabblad geeft voor grootboek 600 in 2022 een totaal van ${geld(referentiePriveSt2022)}, `
        + 'opgebouwd uit de periodes 4, 5, 6, 8, 9, 12 en 14. Door jou nagerekend en bevestigd, ingesteld in Beheer.',
      huidigeWaarde: geld(st22),
      nieuweWaarde: geld(referentiePriveSt2022),
      detail: `Verschil ${geld(referentiePriveSt2022 - st22)}. Alleen dit ene veld verandert; `
        + 'omzet, kosten en privé-opname van 2022 blijven staan.',
      recordIds: ['2022.priveSt'],
      mutaties: [{
        sleutel: 'xtenate_home_totals_override', pad: ['2022', 'priveSt'],
        veld: 'priveSt', van: st22, naar: referentiePriveSt2022
      }],
      correctieBewezen: true,
      vingerBron: JSON.stringify(ht['2022'])
    });
  }

  // --- 4. totaalregel in de voorraad ---------------------------------------
  const covers = Array.isArray(state.COVERS) ? state.COVERS : [];
  const totaalRegels = covers.filter(c => String(c.artikel || '').trim().toLowerCase().startsWith('totaal'));
  for (const c of totaalRegels) {
    const index = covers.indexOf(c);
    const erboven = covers.slice(0, index).reduce((s, x) => s + Number(x.voorraad || 0), 0);
    const klopt = Math.abs(erboven - Number(c.voorraad || 0)) < 0.005;
    await voegToe({
      id: 'voorraad-totaal::' + c.id,
      categorie: klopt ? 'bewezen' : 'onbekend',
      titel: 'Een totaalregel staat als voorraadartikel geregistreerd',
      sleutel: 'xtenate_covers',
      aantalRecords: 1,
      reden: klopt
        ? `De voorraad van de ${index} artikelen erboven telt op tot precies ${erboven}, `
          + `gelijk aan de voorraad van deze regel. Het is een subtotaal uit het werkblad, geen product.`
        : 'De naam begint met "totaal", maar de voorraad komt niet overeen met de artikelen erboven.',
      huidigeWaarde: `${c.artikel} · voorraad ${c.voorraad} · nummer ${c.id}`,
      nieuweWaarde: '—  er is geen bewezen vervanging; verwijderen is een aparte handeling',
      detail: 'Deze regel telt nu dubbel mee in de voorraadstand. Wat er in de plaats moet komen '
        + 'staat niet vast, dus er wordt niets voorgesteld en alleen negeren is beschikbaar.',
      recordIds: [String(c.id)],
      correctieBewezen: false,
      vingerBron: JSON.stringify(c)
    });
  }

  // --- 5. gaten in de voorraadnummering ------------------------------------
  const nummers = covers.map(c => Number(c.id)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const gaten = [];
  for (let n = nummers[0]; n <= nummers[nummers.length - 1]; n++) if (!nummers.includes(n)) gaten.push(n);
  if (gaten.length) {
    await voegToe({
      id: 'voorraad-gaten',
      categorie: 'onbekend',
      titel: 'Ontbrekende nummers in de voorraad',
      sleutel: 'xtenate_covers',
      aantalRecords: gaten.length,
      reden: 'De import nummert altijd aaneengesloten, dus deze gaten kunnen alleen door verwijderen '
        + 'zijn ontstaan. Welke artikelen het waren, is niet vast te stellen zonder het Excel-bestand '
        + 'of een oude export.',
      huidigeWaarde: `${covers.length} artikelen, nummers ${nummers[0]} t/m ${nummers[nummers.length - 1]}, ontbrekend: ${gaten.join(', ')}`,
      nieuweWaarde: '—  onbekend, er wordt niets voorgesteld',
      detail: 'De app verandert hier niets aan.',
      recordIds: gaten.map(String),
      correctieBewezen: false,
      vingerBron: nummers.join(',')
    });
  }

  // --- 6. negatieve privébedragen in een jaartotaal -------------------------
  if (ht) {
    for (const [jaar, v] of Object.entries(ht)) {
      const neg = ['priveOp', 'priveSt'].filter(k => Number(v[k]) < 0);
      if (!neg.length) continue;
      await voegToe({
        id: 'jaartotaal-negatief::' + jaar,
        categorie: 'onbekend',
        titel: `Negatieve privébedragen in het jaartotaal van ${jaar}`,
        sleutel: 'xtenate_home_totals_override',
        aantalRecords: neg.length,
        reden: 'Privé-opname en privé-storting horen positief te zijn. De import leest '
          + 'priveSt als -gb600 en priveOp als gb601; staan de tekens in Per Periode anders, '
          + 'dan komt het bedrag negatief binnen. Welke waarde juist is, is niet vastgesteld.',
        huidigeWaarde: neg.map(k => `${k}: ${geld(v[k])}`).join(' · '),
        nieuweWaarde: '—  onbekend, er wordt niets voorgesteld',
        detail: `Ter vergelijking, de waarden in de code: `
          + neg.map(k => `${k}: ${geld(HOME_TOTALS_DEFAULT[jaar]?.[k])}`).join(' · ')
          + '. Die zijn niet bewezen juist en worden dus niet voorgesteld.',
        recordIds: neg.map(k => `${jaar}.${k}`),
        correctieBewezen: false,
        vingerBron: JSON.stringify(v)
      });
    }
  }

  // --- 7. creditcardregel met onbekend teken --------------------------------
  const hist = Array.isArray(state.HIST_TX) ? state.HIST_TX : [];
  const verdacht = hist.find(t => Math.abs(Number(t.bedrag) - 305.99) < 0.005 && String(t.rek) === '1030');
  if (verdacht) {
    await voegToe({
      id: 'teken::' + verdacht.id,
      categorie: 'onbekend',
      titel: 'Creditcardregel waarvan het oorspronkelijke teken onbekend is',
      sleutel: 'xtenate_hist_tx_override',
      aantalRecords: 1,
      reden: 'In de creditcard-import gooit Math.abs het teken weg en wordt de soort altijd "uitgave". '
        + 'Een terugstorting wordt daardoor als uitgave geboekt. Of dat hier gebeurd is, kan pas '
        + 'worden vastgesteld met de bedragcel uit het tabblad Creditkaart Privé.',
      huidigeWaarde: `${verdacht.datum} · ${geld(verdacht.bedrag)} · ${verdacht.type} · ${verdacht.naam || ''}`,
      nieuweWaarde: '—  onbekend, er wordt niets voorgesteld',
      detail: 'Is het bronbedrag negatief, dan staan de kosten van 2022 € 611,98 te hoog.',
      recordIds: [String(verdacht.id)],
      correctieBewezen: false,
      vingerBron: JSON.stringify(verdacht)
    });
  }

  return meldingen;
}

// ------------------------------------------------------- keuzes in het geheugen

const keuzes = new Map();

/** Legt een keuze vast. Alleen in het geheugen van deze sessie. */
export function kiesActie(meldingId, actie, melding) {
  keuzes.set(meldingId, {
    meldingId, actie,
    sleutel: melding.sleutel,
    recordIds: melding.recordIds || [],
    vinger: melding.vinger,
    aantalRecords: melding.aantalRecords,
    gekozenOp: new Date().toISOString()
  });
}

export function wisKeuze(meldingId) { keuzes.delete(meldingId); }
export function keuzeVan(meldingId) { return keuzes.get(meldingId) || null; }
export function alleKeuzes() { return [...keuzes.values()]; }

/**
 * Wat er zou worden weggeschreven als de keuzes worden doorgevoerd. Dit is een
 * beschrijving, geen handeling: er wordt niets opgeslagen.
 */
export function keuzeOverzicht(meldingen) {
  return alleKeuzes().map(k => {
    const m = meldingen.find(x => x.id === k.meldingId);
    return {
      ...k,
      titel: m ? m.titel : k.meldingId,
      huidigeWaarde: m ? m.huidigeWaarde : '',
      nieuweWaarde: k.actie === ACTIES.CORRIGEREN ? (m ? m.nieuweWaarde : '') : 'gegevens blijven ongewijzigd',
      gevolg: m ? m.gevolgPerActie[k.actie] : ''
    };
  });
}

// ------------------------------------------------------- export en integriteit

const csvVeld = v => {
  const s = Array.isArray(v) ? v.join(' ') : String(v ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const KOLOMMEN = ['id', 'titel', 'bewijsstatus', 'sleutel', 'aantalRecords', 'recordIds',
  'huidigeWaarde', 'voorgesteldeWaarde', 'reden', 'detail', 'beschikbareActies',
  'gevolgCorrigeren', 'gevolgVerbergen', 'gevolgNegeren', 'vingerafdruk'];

const naarRij = m => ({
  id: m.id, titel: m.titel, bewijsstatus: m.bewijsstatus, sleutel: m.sleutel,
  aantalRecords: m.aantalRecords, recordIds: m.recordIds,
  huidigeWaarde: m.huidigeWaarde, voorgesteldeWaarde: m.nieuweWaarde,
  reden: m.reden, detail: m.detail || '',
  beschikbareActies: m.acties,
  gevolgCorrigeren: m.gevolgPerActie[ACTIES.CORRIGEREN],
  gevolgVerbergen: m.gevolgPerActie[ACTIES.VERBERGEN],
  gevolgNegeren: m.gevolgPerActie[ACTIES.NEGEREN],
  vingerafdruk: m.vinger
});

/** Zet de meldingen als JSON en CSV op je schijf. Schrijft niets naar de opslag. */
export function exporteerMeldingen(meldingen) {
  const rijen = meldingen.map(naarRij);
  const stempel = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const pakket = {
    soort: 'xtenate-gegevenscontrole-meldingen', versie: 1,
    gemaakt: new Date().toISOString(),
    aantal: rijen.length,
    bewezen: rijen.filter(r => r.bewijsstatus === 'BEWEZEN').length,
    onbekend: rijen.filter(r => r.bewijsstatus === 'ONBEKEND').length,
    toelichting: 'Er is niets gewijzigd. Verbergen is alleen beschikbaar als vaststaat wat het effect is.',
    meldingen: rijen
  };
  const csv = [KOLOMMEN.join(';'), ...rijen.map(r => KOLOMMEN.map(k => csvVeld(r[k])).join(';'))].join('\n');

  const zet = (tekst, naam, type) => {
    const url = URL.createObjectURL(new Blob([tekst], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = naam;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  zet(JSON.stringify(pakket, null, 2), `xtenate-meldingen-${stempel}.json`, 'application/json');
  setTimeout(() => zet(csv, `xtenate-meldingen-${stempel}.csv`, 'text/csv'), 400);
  return { aantal: rijen.length, kolommen: KOLOMMEN.length };
}

/**
 * Neemt een checksum van elke opslagsleutel, zodat je zelf kunt vaststellen dat
 * er tijdens dit scherm niets is weggeschreven.
 */
export async function opslagVingerafdrukken() {
  const uit = {};
  for (let i = 0; i < localStorage.length; i++) {
    const s = localStorage.key(i);
    uit[s] = await vingerafdruk(localStorage.getItem(s) ?? '');
  }
  return uit;
}

export function vergelijkVingerafdrukken(voor, na) {
  const sleutels = [...new Set([...Object.keys(voor), ...Object.keys(na)])].sort();
  return sleutels.map(s => ({
    sleutel: s, voor: voor[s] ?? '—', na: na[s] ?? '—', gelijk: voor[s] === na[s]
  }));
}
