// btw.js — BTW-aangifte-overzicht per kwartaal (fase 4, indicatief).
//
// Dit vervangt geen echte aangifte. Zie de vaste waarschuwing bovenaan het
// scherm zelf (index.html, #p-btw) — die staat expliciet ook zichtbaar in de
// interface, niet alleen hier als commentaar.
//
// Privé-opnames en -stortingen tellen nooit mee, ongeacht wat er op zo'n
// boeking staat: btwRelevant() filtert op isInkomst()/isUitgave(), niet op
// de aan-/afwezigheid van btw_bedrag. Zo blijft een eventuele fout elders
// (een privé-boeking die per ongeluk toch een btw_bedrag zou dragen) hier
// zonder gevolg.

import { isInkomst, isUitgave, fmt } from './helpers.js?v=20261023z';
import { state, BTW_INSTELLINGEN } from './storage.js?v=20261023z';
import { downloadModelPdf } from './pdf.js?v=20261023z';

const el = id => document.getElementById(id);

let gekozenKwartaal = null; // 'JJJJ-Q#'; wordt bij de eerste render op "nu" gezet

function alleBoekingen() {
  return [...state.HIST_TX, ...state.TX];
}

/** 'JJJJ-Q#' voor een datum 'JJJJ-MM-DD'. */
function kwartaalVan(datum) {
  const jaar = datum.slice(0, 4);
  const maand = Number(datum.slice(5, 7));
  return `${jaar}-Q${Math.ceil(maand / 3)}`;
}

function kwartaalNu() {
  const nu = new Date();
  return `${nu.getFullYear()}-Q${Math.ceil((nu.getMonth() + 1) / 3)}`;
}

function kwartaalLabel(kwartaal) {
  const [jaar, q] = kwartaal.split('-Q');
  return `${q}e kwartaal ${jaar}`;
}

/** Eerste en laatste kalenderdag van een kwartaal, als 'JJJJ-MM-DD'. */
function kwartaalGrenzen(kwartaal) {
  const [jaarTekst, qTekst] = kwartaal.split('-Q');
  const jaar = Number(jaarTekst), q = Number(qTekst);
  const eersteMaand = (q - 1) * 3 + 1;
  const laatsteMaand = eersteMaand + 2;
  const laatsteDag = new Date(jaar, laatsteMaand, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  return {
    start: `${jaar}-${pad(eersteMaand)}-01`,
    eind: `${jaar}-${pad(laatsteMaand)}-${pad(laatsteDag)}`
  };
}

/** Alle kwartalen waarin minstens één boeking valt, plus altijd het huidige. */
function beschikbareKwartalen() {
  const set = new Set(alleBoekingen().map(t => kwartaalVan(t.datum)));
  set.add(kwartaalNu());
  return [...set].sort().reverse();
}

/**
 * Valt de omslagdatum binnen dit kwartaal? Dan is dit het overgangskwartaal:
 * boekingen van vóór en na de grens staan er dan allebei in, en die worden
 * bewust apart getoond — nooit als één gemengd totaal met alleen een
 * waarschuwing erbij.
 */
function isOvergangskwartaal(kwartaal) {
  const vanaf = BTW_INSTELLINGEN?.btwPlichtigVanaf;
  if (!vanaf) return false;
  const { start, eind } = kwartaalGrenzen(kwartaal);
  return vanaf >= start && vanaf <= eind;
}

/**
 * Nooit privé, ongeacht wat er verder op de boeking staat. Geëxporteerd zodat
 * export.js dezelfde functie rechtstreeks kan gebruiken voor de BTW-kolom in
 * het Excel-bestand — geen eigen, evenwijdige berekening daar.
 */
export function btwRelevant(t) {
  return isInkomst(t) || isUitgave(t);
}

function totalenVan(boekingen) {
  const afTeDragen = boekingen.filter(isInkomst)
    .reduce((s, t) => s + (Number(t.btw_bedrag) || 0), 0);
  const voorbelasting = boekingen.filter(isUitgave)
    .reduce((s, t) => s + (Number(t.btw_bedrag) || 0), 0);
  return { afTeDragen, voorbelasting, saldo: afTeDragen - voorbelasting };
}

function saldoTekst(saldo) {
  if (Math.abs(saldo) < 0.005) return 'Niets te betalen of te ontvangen.';
  return saldo > 0
    ? `Te betalen aan de Belastingdienst: ${fmt(saldo)}.`
    : `Te ontvangen van de Belastingdienst: ${fmt(Math.abs(saldo))}.`;
}

function totalenKaart(titel, boekingen) {
  const t = totalenVan(boekingen);
  return `
    <div class="card">
      ${titel ? `<div class="card-title">${titel}</div>` : ''}
      <div class="metrics">
        <div class="metric"><div class="lbl">Af te dragen (verkopen)</div><div class="val neg">${fmt(t.afTeDragen)}</div></div>
        <div class="metric"><div class="lbl">Voorbelasting (inkopen/kosten)</div><div class="val pos">${fmt(t.voorbelasting)}</div></div>
        <div class="metric"><div class="lbl">Saldo</div><div class="val ${t.saldo > 0 ? 'neg' : 'pos'}">${fmt(t.saldo)}</div></div>
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:8px">${saldoTekst(t.saldo)} ${boekingen.length} boeking(en) meegeteld.</div>
    </div>`;
}

export function renderBtw() {
  const doel = el('btw-inhoud');
  if (!doel) return;

  if (!gekozenKwartaal) gekozenKwartaal = kwartaalNu();

  const kwartalen = beschikbareKwartalen();
  if (!kwartalen.includes(gekozenKwartaal)) gekozenKwartaal = kwartalen[0];
  const kiezer = el('btw-kwartaal');
  if (kiezer) {
    kiezer.innerHTML = kwartalen
      .map(q => `<option value="${q}"${q === gekozenKwartaal ? ' selected' : ''}>${kwartaalLabel(q)}</option>`)
      .join('');
  }

  if (!BTW_INSTELLINGEN?.btwPlichtigVanaf) {
    doel.innerHTML = `<div class="card"><div class="muted">
      Er is nog geen BTW-plicht ingesteld. Stel eerst een omslagdatum in bij Beheer → BTW.
    </div></div>`;
    return;
  }

  const boekingenInKwartaal = alleBoekingen()
    .filter(t => kwartaalVan(t.datum) === gekozenKwartaal && btwRelevant(t));

  if (isOvergangskwartaal(gekozenKwartaal)) {
    const vanaf = BTW_INSTELLINGEN.btwPlichtigVanaf;
    const voor = boekingenInKwartaal.filter(t => t.datum < vanaf);
    const na = boekingenInKwartaal.filter(t => t.datum >= vanaf);
    doel.innerHTML = `
      <div class="alert alert-warn" style="margin-bottom:var(--spacing-4)">
        Dit is het overgangskwartaal: de BTW-plicht gaat in op ${vanaf}, middenin dit kwartaal.
        De boekingen van vóór en na die datum staan daarom hieronder apart, niet als één gemengd totaal.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-4);align-items:start">
        <div class="card">
          <div class="card-title">Vóór ${vanaf} — buiten de BTW-plicht</div>
          <div class="muted" style="font-size:12.5px">
            ${voor.length} boeking(en). Geen BTW van toepassing, ongeacht wat er verder op deze
            boekingen staat.
          </div>
        </div>
        ${totalenKaart(`Vanaf ${vanaf} — onder de BTW-plicht`, na)}
      </div>`;
    return;
  }

  doel.innerHTML = totalenKaart(kwartaalLabel(gekozenKwartaal), boekingenInKwartaal);
}

export function wisselBtwKwartaal() {
  const kiezer = el('btw-kwartaal');
  gekozenKwartaal = kiezer?.value || kwartaalNu();
  renderBtw();
}

/**
 * Het pdf-model voor het gekozen kwartaal — bouwt rechtstreeks voort op
 * btwRelevant(), isOvergangskwartaal() en totalenVan() hierboven, dezelfde
 * functies die renderBtw() ook gebruikt. Geen eigen, evenwijdige berekening:
 * wat hier in de pdf komt, komt uit exact dezelfde optelsom als het scherm
 * op dit moment toont. Voor het overgangskwartaal krijgt de pdf dezelfde
 * twee-aparte-blokken-indeling als het scherm, nooit één gemengd totaal.
 */
export function btwModel(kwartaal = gekozenKwartaal || kwartaalNu()) {
  const boekingenInKwartaal = alleBoekingen()
    .filter(t => kwartaalVan(t.datum) === kwartaal && btwRelevant(t));

  const voetTekst = `Opgesteld met de Xtenate-administratie op ${new Date().toLocaleDateString('nl-NL')}. ` +
    'Indicatief overzicht, geen vervanging van een echte BTW-aangifte. Internationale verkopen en ' +
    'verlegde BTW zijn hier niet in meegenomen. Raadpleeg een belastingadviseur voordat je aangifte doet.';

  if (isOvergangskwartaal(kwartaal)) {
    const vanaf = BTW_INSTELLINGEN.btwPlichtigVanaf;
    const voor = boekingenInKwartaal.filter(t => t.datum < vanaf);
    const na = boekingenInKwartaal.filter(t => t.datum >= vanaf);
    const t = totalenVan(na);
    return {
      titel: 'BTW-overzicht (indicatief)',
      ondertitel: `${kwartaalLabel(kwartaal)} — overgangskwartaal`,
      blokken: [
        { type: 'kop', tekst: `Vóór ${vanaf} — buiten de BTW-plicht` },
        { type: 'tekst', tekst: `${voor.length} boeking(en). Geen BTW van toepassing, ongeacht wat er verder op deze boekingen staat.` },

        { type: 'kop', tekst: `Vanaf ${vanaf} — onder de BTW-plicht` },
        { type: 'regel', label: 'Af te dragen (verkopen)', bedrag: t.afTeDragen },
        { type: 'regel', label: 'Voorbelasting (inkopen/kosten)', bedrag: t.voorbelasting, aftrek: true },
        { type: 'regel', label: 'Saldo', bedrag: t.saldo, totaal: true },
        { type: 'tekst', tekst: `${saldoTekst(t.saldo)} ${na.length} boeking(en) meegeteld.` },

        { type: 'voet', tekst: voetTekst }
      ]
    };
  }

  const t = totalenVan(boekingenInKwartaal);
  return {
    titel: 'BTW-overzicht (indicatief)',
    ondertitel: kwartaalLabel(kwartaal),
    blokken: [
      { type: 'kop', tekst: 'Totalen' },
      { type: 'regel', label: 'Af te dragen (verkopen)', bedrag: t.afTeDragen },
      { type: 'regel', label: 'Voorbelasting (inkopen/kosten)', bedrag: t.voorbelasting, aftrek: true },
      { type: 'regel', label: 'Saldo', bedrag: t.saldo, totaal: true },
      { type: 'tekst', tekst: `${saldoTekst(t.saldo)} ${boekingenInKwartaal.length} boeking(en) meegeteld.` },

      { type: 'voet', tekst: voetTekst }
    ]
  };
}

export function downloadBtwPdf() {
  const kwartaal = gekozenKwartaal || kwartaalNu();
  downloadModelPdf(btwModel(kwartaal), `btw-${kwartaal}.pdf`);
}
