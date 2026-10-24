// dashboard.js — Home: het financiële dashboard.

import { alpha, baseOpts, charts, cssVar, dc, donutMidden, lijn, lijnGloed, palette, staaf } from './charts.js?v=20261024k';
import {
  BEGINSALDO_2026, calcIB, ddmm, esc, fmt, fmtKort, isInkomst, isKostenBoeking, isOmzet, isUitgave,
  maandLabel, rekBadge, saldoDelta, typeBadge, weergaveNaam
} from './helpers.js?v=20261024k';
import { HOME_TOTALS, MAAND_SALDOS, state, grootboekNamen, rekeningNamen, bankKoppelingDagenTotVerval } from './storage.js?v=20261024k';
import { bankPrijzenNu, inkoopwaardeVan } from './voorraadwaarde.js?v=20261024k';
import { draaiControles } from './controle.js?v=20261024k';
import { aangifteModel, ibOver } from './belasting.js?v=20261024k';
import { splitsLoten } from './hnvilot.js?v=20261024k';
import { dagenSindsCloudBackup } from './cloudbackup.js?v=20261024k';
import { factuurSamenvatting } from './facturen.js?v=20261024k';
import { korStatus } from './kor.js?v=20261024k';
import { maakSorteerbaar } from './tables.js?v=20261024k';
import { hertekenHuidigePagina } from './ui.js?v=20261024k';
import { txVanJaar, lopendJaar, isTxJaar, banksaldoTot } from './jaren.js?v=20261024k';
import { tarievenVoor } from './tarieven.js?v=20261024k';


export function wisselJaar() {
  state.huidigJaar = document.getElementById('jaar-selector').value;
  hertekenHuidigePagina();
}

export function getHomeTX() {
  return txVanJaar(state.huidigJaar);
}

// Berekent de hoofdcijfers voor één jaar. Jaartotalen uit een Excel-import
// ("Per Periode") komen rechtstreeks uit de boekhouding en zijn leidend;
// alleen als die ontbreken wordt er opgeteld uit de losse boekingen.
function berekenJaarMetrics(jaar, txVanJaar) {
  // Fase 3B: Excel-overrides UITGESCHAKELD — altijd live van Supabase rekenen
  // const override = HOME_TOTALS[jaar];
  // if (override) return { ...override, uitExcel: true };
  
  return {
    omzet: txVanJaar.filter(t => isInkomst(t) && isOmzet(t.gb)).reduce((s, t) => s + t.bedrag, 0),
    kosten: txVanJaar.filter(isKostenBoeking).reduce((s, t) => s + t.bedrag, 0),
    omzXt: txVanJaar.filter(t => isInkomst(t) && t.gb === '8000').reduce((s, t) => s + t.bedrag, 0),
    omzBol: txVanJaar.filter(t => isInkomst(t) && t.gb === '8010').reduce((s, t) => s + t.bedrag, 0),
    omzHC: txVanJaar.filter(t => isInkomst(t) && t.gb === '8020').reduce((s, t) => s + t.bedrag, 0),
    priveOp: txVanJaar.filter(t => t.type === 'prive_opname').reduce((s, t) => s + t.bedrag, 0),
    priveSt: txVanJaar.filter(t => t.type === 'prive_storting').reduce((s, t) => s + t.bedrag, 0),
    hnviInv: txVanJaar.filter(t => t.gb === '7010').reduce((s, t) => s + t.bedrag, 0),
    uitExcel: false
  };
}

/**
 * Banksaldo van de hoofdrekening. Voor 2026 loopt het door vanaf het beginsaldo;
 * voor afgesloten jaren wordt het eindsaldo van de laatste maand gebruikt.
 */
function berekenBanksaldo(jaar) {
  if (jaar === 'all' || jaar === lopendJaar()) return { saldo: banksaldoTot(), label: 'Bank · nu' };

  const maandenVanJaar = Object.keys(MAAND_SALDOS).filter(m => m.startsWith(jaar)).sort();
  const laatste = maandenVanJaar[maandenVanJaar.length - 1];
  if (laatste) return { saldo: MAAND_SALDOS[laatste].eind, label: `Bank · eind ${maandLabel(laatste)}` };
  if (isTxJaar(jaar)) return { saldo: banksaldoTot(`${jaar}-12-31`), label: `Bank · eind ${jaar}` };
  return { saldo: null, label: 'geen saldo bekend' };
}

/** Waarde van de voorraad: HNVI-loten tegen inkoopprijs, plus het aantal covers. */
function berekenVoorraad() {
  // Kijk je naar een afgesloten jaar, dan tellen alleen de artikelen mee die in
  // dat jaar bestonden — en dan met hun stand van toen, niet die van vandaag.
  const jaarFilter = state.huidigJaar && state.huidigJaar !== 'all' && state.huidigJaar !== 'nu'
    ? state.huidigJaar : null;

  const inVoorraad = splitsLoten(state.HNVI_LOTS).filter(l => l.status === 'voorraad');
  const lotenWaarde = inVoorraad.reduce((s, l) => s + (Number(l.inkoop) || 0), 0);

  // De inkoopprijs komt uit dezelfde bron als de Voorraadpagina en de aangifte:
  // het handmatige veld als dat er staat, anders afgeleid uit de bankboekingen
  // op de inkooprekening. Eerder werd hier alleen naar `c.inkoopprijs` gekeken,
  // waardoor Home een lagere voorraadwaarde toonde dan Voorraad.
  const bankPrijzen = bankPrijzenNu();
  const prijsJaar = jaarFilter || String(new Date().getFullYear());

  let coversWaarde = 0, coversStuks = 0, zonderPrijs = 0, verkochtStuks = 0, ingekochtStuks = 0;
  for (const c of state.COVERS) {
    let aantal, verkocht, ingekocht;
    if (jaarFilter) {
      const j = (c.jaren || {})[jaarFilter];
      // Alleen overslaan als er voor dit jaar niets bekend is. Een stand van 0
      // is een echt gegeven: het artikel bestond, maar was uitverkocht. Eerder
      // stond hier een controle op waarheid, en omdat 0 in JavaScript als
      // onwaar geldt verdwenen juist die artikelen uit beeld.
      if (!j) continue;
      aantal = j.eind ?? 0;
      verkocht = j.verkocht ?? 0;
      ingekocht = j.inkoop ?? 0;
    } else {
      aantal = Number(c.voorraad) || 0;
      verkocht = Number(c.verkoop) || 0;
      ingekocht = Number(c.inkoop) || 0;
    }

    coversStuks += aantal;
    verkochtStuks += verkocht;
    ingekochtStuks += ingekocht;

    const waarde = inkoopwaardeVan(c, { voorraad: aantal }, bankPrijzen, prijsJaar);
    if (waarde != null) coversWaarde += waarde;
    else if (aantal > 0) zonderPrijs++;
  }

  return {
    waarde: lotenWaarde + coversWaarde,
    lotenWaarde,
    coversWaarde,
    loten: inVoorraad.length,
    covers: coversStuks,
    verkochtStuks,
    ingekochtStuks,
    zonderPrijs
  };
}

/* Kleine set iconen voor de KPI-kaarten. Eén tekenstijl: outline, 1.8. */
const KPI_ICONEN = {
  omzet:    '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7h-5v5"/>',
  kosten:   '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 17h-5v-5"/>',
  // Euroteken: boog van de C met de twee dwarsstrepen. Stond hier eerder als
  // dollarteken, terwijl de administratie in euro's is. Alleen het icoon; de
  // bedragen liepen al via fmt() en zijn niet aangepast.
  winst:    '<path d="M18 6.5A7 7 0 0 0 8 12a7 7 0 0 0 10 5.5"/><path d="M4 10.5h9"/><path d="M4 14h9"/>',
  bank:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
  prive:    '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  voorraad: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>',
  belasting:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>'
};

function kpiIcoon(naam, toon = '') {
  const pad = KPI_ICONEN[naam];
  if (!pad) return '';
  return `<span class="kpi-icoon${toon ? ' kpi-icoon--' + toon : ''}" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round">${pad}</svg></span>`;
}

/**
 * Trendlabel op basis van een percentage. Geeft niets terug wanneer er geen
 * betrouwbaar vergelijkingscijfer is — liever leeg dan een verzonnen trend.
 */
function kpiTrend(pct, hogerIsBeter = true) {
  if (!Number.isFinite(pct)) return '';
  const afgerond = Math.round(Math.abs(pct) * 10) / 10;
  if (afgerond === 0) {
    return `<span class="kpi-trend vlak">0%</span>`;
  }
  const omhoog = pct > 0;
  const goed = hogerIsBeter ? omhoog : !omhoog;
  const pijl = omhoog
    ? '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>'
    : '<path d="M7 7l10 10"/><path d="M17 15V7H9"/>';
  return `<span class="kpi-trend ${goed ? 'pos' : 'neg'}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pijl}</svg>
    ${afgerond.toLocaleString('nl-NL')}%</span>`;
}

/**
 * Bouwt een KPI-kaart.
 * opties: { icoon, toon, trend, primair } — allemaal optioneel, zodat
 * bestaande aanroepen met vier argumenten onveranderd blijven werken.
 */
function kpi(label, waarde, klasse = '', sub = '', extra = '', opties = {}) {
  const { icoon = '', toon = '', trend = '', primair = false } = opties;
  const klassen = ['kpi'];
  if (primair) klassen.push('kpi--primair');
  const onder = [trend, sub].filter(Boolean).join(' ');
  return `<div class="${klassen.join(' ')}${extra}">
    <div class="kpi-lbl">${kpiIcoon(icoon, toon)}${label}</div>
    <div class="kpi-val ${klasse}">${waarde}</div>
    ${onder ? `<div class="kpi-sub">${onder}</div>` : ''}
  </div>`;
}

function leegVlak(titel, tekst) {
  return `<div class="empty">
    <div class="empty-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></div>
    <div class="empty-title">${titel}</div>
    <div class="empty-text">${tekst}</div>
  </div>`;
}

/**
 * Zoekt op wat vandaag om aandacht vraagt. Puur afgeleid uit de bestaande
 * gegevens: er wordt niets opgeslagen of gewijzigd.
 */
function aandachtspunten() {
  const punten = [];
  try {
    const jr = state.huidigJaar && state.huidigJaar !== 'all' ? state.huidigJaar : lopendJaar();
    const k = korStatus(jr);
    const eur = n => fmt(Math.round(n));
    punten.push({
      kleur: k.niveau === 'over' ? 'red' : k.niveau === 'let-op' ? 'amber' : 'accent',
      titel: `KOR ${jr}: ${eur(k.omzet)} van ${eur(k.grens)} (${Math.round(k.pct * 100)}%)`,
      tekst: k.niveau === 'over' ? `Je zit ${eur(-k.ruimte)} boven de grens. Overleg met je boekhouder.`
        : `Nog ${eur(k.ruimte)} ruimte${k.prognose !== null ? `. Op dit tempo kom je dit jaar uit op ongeveer ${eur(k.prognose)}.` : '.'}`,
      actie: "nav('jaarafsluiting')", knop: 'Jaarafsluiting'
    });
  } catch (e) { console.warn('KOR-bewaking mislukt:', e); }
  // Zonder cloud staat alles in deze browser; een recente back-up is dan het enige vangnet.
  try {
    const laatste = localStorage.getItem('xtenate_laatste_backup');
    const dagen = laatste ? Math.floor((Date.now() - new Date(laatste).getTime()) / 86400000) : null;
    const cloudDagen = dagenSindsCloudBackup();
    const cloudOk = cloudDagen !== null && cloudDagen <= 3;   // de nachtelijke cloud-back-up draait
    if (!cloudOk && (dagen === null || dagen >= 14)) punten.push({
      kleur: dagen === null || dagen >= 30 ? 'red' : 'amber',
      titel: dagen === null ? 'Nog geen back-up gemaakt' : `Laatste back-up is ${dagen} dagen oud`,
      tekst: 'Je gegevens staan in deze browser. Download een back-up (en bewaar die buiten de browser), zeker voor je een import doet.',
      actie: "openOpslagDiagnose();downloadBackup()", knop: 'Back-up maken'
    });
  } catch { /* geen localStorage: dan ook geen herinnering */ }
  // Facturen die te laat zijn (jij moet betaald krijgen) of binnenkort vervallen (jij moet betalen).
  try {
    const fs = factuurSamenvatting();
    if (fs.debiteuren.teLaat > 0) punten.push({
      kleur: 'red',
      titel: `${fs.debiteuren.teLaat} ${fs.debiteuren.teLaat === 1 ? 'factuur' : 'facturen'} te laat betaald`,
      tekst: 'Klanten die de vervaldatum hebben overschreden. Stuur eventueel een herinnering.',
      actie: "nav('facturen')", knop: 'Facturen'
    });
    if (fs.crediteuren.teLaat + fs.crediteuren.binnenkort > 0) punten.push({
      kleur: fs.crediteuren.teLaat ? 'red' : 'amber',
      titel: `${fs.crediteuren.teLaat + fs.crediteuren.binnenkort} te betalen ${fs.crediteuren.teLaat + fs.crediteuren.binnenkort === 1 ? 'factuur' : 'facturen'}`,
      tekst: fs.crediteuren.teLaat ? `${fs.crediteuren.teLaat} al verlopen, ${fs.crediteuren.binnenkort} vervallen binnenkort.` : 'Vervallen binnenkort.',
      actie: "nav('facturen')", knop: 'Facturen'
    });
  } catch (e) { console.warn('Factuurbewaking mislukt:', e); }
  const min = (c) => Number.isFinite(Number(c.minVoorraad)) ? Number(c.minVoorraad) : 3;

  const uitverkocht = state.COVERS.filter(c => (Number(c.voorraad) || 0) <= 0);
  const laag = state.COVERS.filter(c => {
    const v = Number(c.voorraad) || 0;
    return v > 0 && v <= min(c);
  });
  const zonderPrijs = state.COVERS.filter(c =>
    (Number(c.voorraad) || 0) > 0 && !(Number(c.inkoopprijs) > 0));

  if (uitverkocht.length) punten.push({
    kleur: 'red', titel: `${uitverkocht.length} uitverkocht`,
    tekst: uitverkocht.slice(0, 3).map(c => c.artikel).join(', ') + (uitverkocht.length > 3 ? '…' : ''),
    actie: "nav('voorraad')", knop: 'Bekijk'
  });

  if (laag.length) punten.push({
    kleur: 'amber', titel: `${laag.length} bijna op`,
    tekst: laag.slice(0, 3).map(c => `${c.artikel} (${c.voorraad})`).join(', ') + (laag.length > 3 ? '…' : ''),
    actie: "nav('voorraad')", knop: 'Bekijk'
  });

  if (zonderPrijs.length) punten.push({
    kleur: 'accent', titel: `${zonderPrijs.length} zonder eigen inkoopprijs`,
    tekst: 'Deze krijgen hun prijs uit de bankboekingen. Met de inkoopverdeling stem je dat per artikel af.',
    actie: "nav('voorraad')", knop: 'Verdeling'
  });

  // Bankkoppeling: de toestemming loopt na ~89 dagen af en dan stopt ook de ochtendronde.
  try {
    for (const kp of (state.BANK_KOPPELINGEN || [])) {
      const d = bankKoppelingDagenTotVerval(kp);
      if (d !== null && d <= 14) punten.unshift({
        kleur: d <= 3 ? 'red' : 'amber',
        titel: d < 0 ? 'Bankkoppeling is verlopen' : `Bankkoppeling verloopt over ${d} ${d === 1 ? 'dag' : 'dagen'}`,
        tekst: 'Koppel de rekening opnieuw (Beheer \u2192 Bankrekening koppelen), anders worden er geen nieuwe bankregels meer opgehaald.',
        actie: "nav('beheer')", knop: 'Beheer'
      });
      else if (kp.laatsteFout) punten.push({
        kleur: 'amber', titel: 'Automatisch ophalen bij de bank is mislukt',
        tekst: `${kp.laatsteFout} Open Beheer voor de details; de volgende ochtendronde probeert het opnieuw.`,
        actie: "nav('beheer')", knop: 'Beheer'
      });
    }
  } catch (e) { console.warn('Bankkoppeling-aandachtspunt mislukt:', e); }

  // Uitkomst van de Controle-pagina, zodat "Alles op orde" niet kan blijven
  // staan terwijl daar een fout of waarschuwing open staat.
  try {
    const regels = draaiControles();
    const fouten = regels.filter(r => r.ernst === 'fout' && !r.ok).length;
    const waarschuwingen = regels.filter(r => r.ernst === 'waarschuwing' && !r.ok).length;
    if (fouten + waarschuwingen > 0) punten.unshift({
      kleur: fouten ? 'red' : 'amber',
      titel: `Controle: ${fouten} ${fouten === 1 ? 'fout' : 'fouten'} \u00b7 ${waarschuwingen} ${waarschuwingen === 1 ? 'aandachtspunt' : 'aandachtspunten'}`,
      tekst: 'In de administratie staan punten open die je kunt nakijken.',
      actie: "nav('controle')", knop: 'Controle'
    });
  } catch (e) {
    console.error('Controles konden niet worden gedraaid voor het dashboard:', e);
  }

  return punten;
}

const PIJL_RECHTS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

function tekenAandacht() {
  const doel = document.getElementById('home-aandacht');
  if (!doel) return;
  const punten = aandachtspunten();
  const urgent = punten.some(p => p.kleur === 'red');

  const kop = `<div class="aandacht-kop">
      <span class="aandacht-kop-titel">Aandacht nodig</span>
      <span class="aandacht-teller${urgent ? ' heeft-urgent' : ''}">${punten.length}</span>
    </div>`;

  if (!punten.length) {
    doel.innerHTML = `<div class="aandacht-kaart">${kop}
      <div class="aandacht-item aandacht-groen">
        <span class="aandacht-stip" aria-hidden="true"></span>
        <div class="aandacht-tekst">
          <div class="aandacht-titel">Alles op orde</div>
          <div class="aandacht-sub">Geen artikelen die bijgevuld moeten worden.</div>
        </div>
      </div></div>`;
    return;
  }

  const regels = punten.map(p => `
    <div class="aandacht-item aandacht-${p.kleur}">
      <span class="aandacht-stip" aria-hidden="true"></span>
      <div class="aandacht-tekst">
        <div class="aandacht-titel">${esc(p.titel)}</div>
        <div class="aandacht-sub">${esc(p.tekst)}</div>
      </div>
      <button class="aandacht-actie" onclick="${p.actie}">${esc(p.knop)}${PIJL_RECHTS}</button>
    </div>`).join('');

  doel.innerHTML = `<div class="aandacht-kaart">${kop}${regels}</div>`;
}

/**
 * Cijfers van het boekjaar vóór het gekozen jaar. Geeft null terug wanneer
 * er geen vorig jaar is of dat jaar geen boekingen bevat: dan tonen we geen
 * trend in plaats van een misleidend percentage.
 */
function vorigJaarMetrics(jaar) {
  if (!jaar || jaar === 'all') return null;
  const vorig = String(Number(jaar) - 1);
  if (!/^\d{4}$/.test(vorig)) return null;
  const tx = [...state.HIST_TX, ...state.TX].filter(t => t.datum.startsWith(vorig));
  if (!tx.length) return null;
  return berekenJaarMetrics(vorig, tx);
}

export function renderHome() {
  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();
  const homeTX = getHomeTX();
  const jaar = state.huidigJaar;
  const jaarTekst = jaar === 'all' ? 'alle jaren' : jaar;

  // ---------- Hoofdcijfers ----------
  let metrics;
  if (jaar === 'all') {
    const alleTx = [...state.HIST_TX, ...state.TX];
    const jaren = [...new Set(alleTx.map(t => t.datum.slice(0, 4)))];
    metrics = jaren.reduce((acc, j) => {
      const m = berekenJaarMetrics(j, alleTx.filter(t => t.datum.startsWith(j)));
      ['omzet','kosten','omzXt','omzBol','omzHC','priveOp','priveSt','hnviInv'].forEach(k => acc[k] = (acc[k] || 0) + m[k]);
      acc.uitExcel = acc.uitExcel && m.uitExcel;
      return acc;
    }, { uitExcel: jaren.length > 0 });
  } else {
    metrics = berekenJaarMetrics(jaar, homeTX);
  }

  const { omzet, kosten, omzXt, omzBol, omzHC, priveOp, priveSt, hnviInv, uitExcel } = metrics;
  const winst = omzet - kosten;
  const bank = berekenBanksaldo(jaar);
  const voorraad = berekenVoorraad();
  // De belasting hoort bij dezelfde winst als op de pagina Belasting (verkochte
  // inkoop als kosten, voorraad niet). Het netto resultaat hierboven is het
  // kasresultaat: alles wat is uitgegeven, ook voorraad die nog ligt.
  let fiscaleWinst = winst;
  if (jaar !== 'all') {
    try { fiscaleWinst = aangifteModel(jaar).resultaat.winst; }
    catch (e) { console.error('Belastingwinst kon niet worden berekend:', e); }
  }
  const ib = fiscaleWinst > 0 ? ibOver(fiscaleWinst, jaar) : fiscaleWinst * tarievenVoor(jaar).schijven[0].tarief;
  const reservering = Math.max(0, Math.round(fiscaleWinst * 0.30));

  const bronMerk = uitExcel
    // Herkomstlabel, geen oordeel: deze badge zegt waar de cijfers vandaan
    // komen, niet dat er iets goed is gegaan. Groen zou hier "correct" of
    // "voltooid" suggereren, dus paars als neutrale identiteitskleur.
    ? '<span class="badge badge-purple" title="Overgenomen uit de Per Periode-totalen van je Excel-import">Excel</span>'
    : '';

  const sub = document.getElementById('overzicht-sub');
  if (sub) {
    sub.textContent = jaar === 'all'
      ? 'Een compleet overzicht van je administratie over alle jaren.'
      : `Een compleet overzicht van je administratie voor ${jaarTekst}.`;
  }

  // ---------- Vergelijking met het vorige boekjaar ----------
  // Alleen wanneer er een concreet jaar gekozen is én dat vorige jaar
  // daadwerkelijk boekingen heeft. Anders tonen we geen trend.
  const vorig = vorigJaarMetrics(jaar);
  const groei = (nu, toen) =>
    (vorig && Number.isFinite(toen) && toen !== 0) ? ((nu - toen) / Math.abs(toen)) * 100 : NaN;

  document.getElementById('home-kpi').innerHTML =
    kpi(`Omzet ${jaarTekst} ${bronMerk}`, fmt(omzet), 'pos',
        `Xtenate ${fmt(omzXt)} · Bol ${fmt(omzBol)} · Helmetstore ${fmt(omzHC)}`, '',
        { icoon: 'omzet', trend: kpiTrend(groei(omzet, vorig?.omzet), true), primair: true }) +
    kpi('Totale kosten', fmt(kosten), 'neg',
        hnviInv > 0 ? `waarvan ${fmt(hnviInv)} HNVI-inkoop` : '', '',
        { icoon: 'kosten', trend: kpiTrend(groei(kosten, vorig?.kosten), false) }) +
    kpi('Netto resultaat', fmt(winst), winst >= 0 ? 'pos' : 'neg',
        omzet > 0 ? `kasresultaat · marge ${Math.round(winst / omzet * 100)}%` : '', '',
        { icoon: 'winst',
          trend: kpiTrend(groei(winst, vorig ? vorig.omzet - vorig.kosten : NaN), true) }) +
    kpi('Banksaldo', bank.saldo === null ? '—' : fmt(bank.saldo),
        bank.saldo !== null && bank.saldo < 0 ? 'neg' : '', bank.label, '',
        { icoon: 'bank' });

  document.getElementById('home-kpi2').innerHTML =
    kpi('Privé-opnames', fmt(priveOp), 'muted', '', ' kpi--secondary',
        { icoon: 'prive', toon: 'neutraal' }) +
    kpi('Privé-stortingen', fmt(priveSt), 'muted', '', ' kpi--secondary',
        { icoon: 'prive', toon: 'neutraal' }) +
    kpi(ib <= 0 ? 'Geschatte teruggave' : 'Geschatte inkomstenbelasting',
        (ib <= 0 ? '+' : '') + fmt(Math.abs(Math.round(ib))),
        ib <= 0 ? 'pos' : 'neg',
        fiscaleWinst > 0 ? `over fiscale winst ${fmt(fiscaleWinst)} · reserveer ± ${fmt(reservering)}` : 'geen winst dit jaar', ' kpi--secondary') +
    (state.huidigJaar && state.huidigJaar !== 'all'
      ? kpi(`Voorraadwaarde eind ${jaarTekst}`, fmt(voorraad.waarde), '',
            `${voorraad.loten} loten · ${voorraad.covers} covers op voorraad · ${voorraad.ingekochtStuks} ingekocht · ${voorraad.verkochtStuks} verkocht`,
            ' kpi--secondary')
      : kpi('Voorraadwaarde', fmt(voorraad.waarde), '',
            voorraad.zonderPrijs > 0
              ? `${voorraad.loten} loten · ${voorraad.covers} covers · ${voorraad.zonderPrijs} zonder inkoopprijs`
              : `${voorraad.loten} loten · ${voorraad.covers} covers`, ' kpi--secondary'));

  tekenAandacht();

  // ---------- Uitschieters ----------
  const topIn = [...homeTX].filter(isInkomst).sort((a, b) => b.bedrag - a.bedrag).slice(0, 2);
  const topUit = [...homeTX].filter(isUitgave).sort((a, b) => b.bedrag - a.bedrag).slice(0, 2);
  const uitschieters = [...topIn, ...topUit];
  document.getElementById('home-uitsch').innerHTML = uitschieters.length
    ? uitschieters.map(t => `
      <div class="uitsch-item row-click" data-id="${esc(t.id)}">
        <div class="uitsch-icon" style="background:${isInkomst(t) ? 'var(--semantic-success-soft)' : 'var(--semantic-danger-soft)'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${isInkomst(t) ? 'var(--semantic-success-bright)' : 'var(--semantic-danger-bright)'}" stroke-width="2.5">
            ${isInkomst(t)
              ? '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'
              : '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>'}
          </svg>
        </div>
        <div class="uitsch-info">
          <div class="uitsch-naam">${esc(weergaveNaam(t))}</div>
          <div class="uitsch-meta">${ddmm(t.datum)} · ${esc(GBNM[t.gb] || t.gb)}</div>
        </div>
        <div class="uitsch-bedrag ${isInkomst(t) ? 'pos' : 'neg'}">${isInkomst(t) ? '+' : '–'}${fmt(t.bedrag)}</div>
      </div>`).join('')
    : `<div class="card" style="grid-column:1/-1;margin:0">${leegVlak('Nog geen boekingen', 'Zodra je een Excel-bestand importeert of een transactie toevoegt, zie je hier de grootste in- en uitgaven.')}</div>`;

  // ---------- Grafieken ----------
  const alleMaanden = [...new Set(homeTX.map(t => t.datum.slice(0, 7)))].sort();
  const maanden = jaar === 'all' ? alleMaanden.slice(-24) : alleMaanden;
  const labels = maanden.map(maandLabel);
  // In één doorloop optellen per maand. Per maand opnieuw door alle boekingen
  // lopen was bij "alle jaren" tienduizenden vergelijkingen voor hetzelfde
  // resultaat.
  const perMaand = new Map(maanden.map(m => [m, { omzet: 0, kosten: 0 }]));
  homeTX.forEach(t => {
    const vak = perMaand.get(t.datum.slice(0, 7));
    if (!vak) return;
    if (isInkomst(t) && isOmzet(t.gb)) vak.omzet += t.bedrag;
    else if (isUitgave(t)) vak.kosten += t.bedrag;
  });
  const omzetD = maanden.map(m => perMaand.get(m).omzet);
  const kostenD = maanden.map(m => perMaand.get(m).kosten);

  let loper = 0;
  const cumulatief = maanden.map((_, i) => (loper += omzetD[i] - kostenD[i]));

  const kleur = palette();

  // Bedragen in de tooltip voluit, met euroteken.
  const tipBedrag = (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;

  dc('c-ie');
  if (maanden.length) {
    charts['c-ie'] = new Chart(document.getElementById('c-ie'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          staaf('Omzet', omzetD, cssVar('--chart-revenue')),
          staaf('Kosten', kostenD, cssVar('--chart-costs'))
        ]
      },
      options: baseOpts({ yFmt: fmtKort, tooltipFmt: tipBedrag })
    });
  }

  dc('c-net');
  if (maanden.length) {
    charts['c-net'] = new Chart(document.getElementById('c-net'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          lijn('Resultaat, opgeteld', cumulatief, cssVar('--chart-profit'),
               { punten: maanden.length <= 18, gloed: true })
        ]
      },
      options: baseOpts({ legend: false, yFmt: fmtKort, tooltipFmt: tipBedrag }),
      plugins: [lijnGloed]
    });
  }

  // Kostenverdeling per grootboekrekening
  const perGb = {};
  homeTX.filter(isUitgave).forEach(t => { perGb[t.gb] = (perGb[t.gb] || 0) + t.bedrag; });
  const gesorteerd = Object.entries(perGb).sort((a, b) => b[1] - a[1]);
  const top = gesorteerd.slice(0, 5);
  const restBedrag = gesorteerd.slice(5).reduce((s, [, v]) => s + v, 0);
  const kostLabels = top.map(([gb]) => GBNM[gb] || gb).concat(restBedrag > 0 ? ['Overig'] : []);
  const kostData = top.map(([, v]) => v).concat(restBedrag > 0 ? [restBedrag] : []);

  dc('c-kosten');
  const kostenCanvas = document.getElementById('c-kosten');
  const kostenLeeg = document.getElementById('c-kosten-leeg');
  if (kostData.length) {
    kostenCanvas.style.display = '';
    const kostTotaal = kostData.reduce((s, v) => s + v, 0);
    kostenLeeg.innerHTML = kostLabels.map((n, i) => {
      const deel = kostTotaal > 0 ? Math.round(kostData[i] / kostTotaal * 100) : 0;
      return `<span class="chart-legenda-item">
        <span class="chart-legenda-stip" style="background:${kleur[i % kleur.length]}"></span>
        <span>${esc(n)}</span>
        <span class="muted">${fmt(kostData[i])} · ${deel}%</span>
      </span>`;
    }).join('');
    charts['c-kosten'] = new Chart(kostenCanvas, {
      type: 'doughnut',
      data: {
        labels: kostLabels,
        datasets: [{
          data: kostData,
          backgroundColor: kleur.map(k => alpha(k, 0.88)),
          hoverBackgroundColor: kleur,
          borderColor: cssVar('--bg-card'),
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        ...baseOpts({
          legend: false,
          tooltipFmt: (ctx) => {
            const deel = kostTotaal > 0 ? Math.round(ctx.parsed / kostTotaal * 100) : 0;
            return ` ${ctx.label}: ${fmt(ctx.parsed)} (${deel}%)`;
          }
        }),
        cutout: '70%',
        scales: {}
      },
      plugins: [donutMidden(fmt(kostTotaal))]
    });
  } else {
    kostenCanvas.style.display = 'none';
    kostenLeeg.innerHTML = leegVlak('Nog geen kosten',
      'Zodra er kosten geboekt zijn in deze periode, zie je hier waar het geld naartoe gaat.');
  }

  // ---------- Laatste boekingen ----------
  const recent = [...homeTX].sort((a, b) => b.datum.localeCompare(a.datum)).slice(0, 8);
  const body = document.getElementById('home-recent');
  body.innerHTML = recent.length
    ? recent.map(t => `<tr class="row-click" data-id="${esc(t.id)}">
        <td class="muted" data-v="${t.datum}">${ddmm(t.datum)}</td>
        <td class="td-trunc">${esc(weergaveNaam(t))}</td>
        <td><span class="gbnr">${esc(t.gb)}</span> ${esc(GBNM[t.gb] || '')}</td>
        <td>${rekBadge(t.rek, REKNM[t.rek])}</td>
        <td style="text-align:right" data-v="${t.bedrag}">${typeBadge(t.type, t.bedrag)}</td>
      </tr>`).join('')
    : `<tr data-geen-sort="1"><td colspan="5">${leegVlak('Nog geen boekingen', 'Importeer je Excel-bestand via het menu links, of voeg handmatig een transactie toe op de Bank-pagina.')}</td></tr>`;
  maakSorteerbaar(document.getElementById('tbl-home-recent'));

  // ---------- Laatste voorraadmutaties ----------
  const mutaties = [...state.HNVI_LOTS]
    .filter(l => l.datum)
    .sort((a, b) => b.datum.localeCompare(a.datum))
    .slice(0, 6);
  document.getElementById('home-voorraad').innerHTML = mutaties.length
    ? mutaties.map(l => `<tr>
        <td class="muted">${ddmm(l.datum)}</td>
        <td class="td-trunc">${esc(l.omschr || 'Lot zonder omschrijving')}</td>
        <td><span class="${l.status === 'verkocht' ? 'badge badge-gray' : 'stock-ok'}">${l.status === 'verkocht' ? 'verkocht' : 'op voorraad'}</span></td>
        <td style="text-align:right">${fmt(l.inkoop || 0)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4">${leegVlak('Nog geen loten', 'Voeg loten toe op de HNVI-pagina om je voorraad hier te volgen.')}</td></tr>`;
}
