// home.js — de startpagina: een portaal met tegels naar de hoofdonderdelen.
//
// Dit is bewust GEEN financieel overzicht. Dat is de pagina 'Overzicht'
// (dashboard.js), die ongewijzigd blijft bestaan als onderdeel van de
// administratie. Home is het startpunt na inloggen: waar wil ik heen?
//
// De tegels tonen hooguit een paar cijfers om te laten zien of er aandacht
// nodig is. Alle gebruikte functies zijn alleen-lezend; deze module wijzigt
// nooit data.

import { draaiControles } from './controle.js?v=20261110a';
import { factuurSamenvatting } from './facturen.js?v=20261110a';
import { esc, fmt } from './helpers.js?v=20261110a';
import { standaardMinVoorraad, state } from './storage.js?v=20261110a';
import { telInbox } from './bankinbox.js?v=20261110a';
import { onverwerkteInkoop } from './artikelregels.js?v=20261110a';
import { berekenJaarMetrics, berekenBanksaldo, vorigJaarMetrics, berekenVoorraad, kpi, kpiTrend } from './dashboard.js?v=20261110a';
import { txVanJaar, lopendJaar } from './jaren.js?v=20261110a';
import { charts, cssVar, dc, baseOpts, lijn } from './charts.js?v=20261110a';
import { fmtKort, isInkomst, isOmzet, ddmm, weergaveNaam } from './helpers.js?v=20261110a';

const el = id => document.getElementById(id);

// ─── Kleine, alleen-lezende tellers ────────────────────────────────────────

function voorraadStand() {
  const drempel = c => (c.minVoorraad != null && c.minVoorraad !== ''
    ? Number(c.minVoorraad) : standaardMinVoorraad());
  const artikelen = state.COVERS || [];
  const op = artikelen.filter(c => Number(c.voorraad) === 0).length;
  const bijna = artikelen.filter(c => Number(c.voorraad) > 0 && Number(c.voorraad) <= drempel(c)).length;
  return { totaal: artikelen.length, op, bijna };
}

function controleStand() {
  try {
    const regels = draaiControles();
    return {
      fout: regels.filter(r => r.ernst === 'fout' && !r.ok).length,
      waarschuwing: regels.filter(r => r.ernst === 'waarschuwing' && !r.ok).length
    };
  } catch (e) {
    // Een kapotte controle mag de startpagina niet meeslepen.
    console.error('Controles konden niet worden gedraaid voor de startpagina:', e);
    return null;
  }
}

function hnviStand() {
  const loten = state.HNVI_LOTS || [];
  return {
    voorraad: loten.filter(l => l.status === 'voorraad').length,
    totaal: loten.length
  };
}

function boekingenStand() {
  return { jaar: (state.TX || []).length, historisch: (state.HIST_TX || []).length };
}

// ─── Cijfertegels en jaarvergelijk ─────────────────────────────────────────
// Alleen-lezen. De cijfers komen uit dezelfde functies als de pagina
// Overzicht, zodat Home en Overzicht nooit verschillende bedragen tonen.

function homeJaar() {
  const j = String(state.huidigJaar);
  return /^\d{4}$/.test(j) ? j : String(lopendJaar());
}

function kpiRij(jaar) {
  try {
    const m = berekenJaarMetrics(jaar, txVanJaar(jaar));
    const vorig = vorigJaarMetrics(jaar);
    const winst = m.omzet - m.kosten;
    const bank = berekenBanksaldo(jaar);
    const groei = (nu, toen) =>
      (vorig && Number.isFinite(toen) && toen !== 0) ? ((nu - toen) / Math.abs(toen)) * 100 : NaN;
    return `<div class="kpi-grid home-kpi-rij">` +
      kpi(`Omzet ${jaar}`, fmt(m.omzet), 'pos', `Xtenate ${fmt(m.omzXt)} \u00b7 Bol ${fmt(m.omzBol)}`, '',
          { icoon: 'omzet', trend: kpiTrend(groei(m.omzet, vorig?.omzet), true), primair: true }) +
      kpi('Totale kosten', fmt(m.kosten), 'neg', '', '',
          { icoon: 'kosten', trend: kpiTrend(groei(m.kosten, vorig?.kosten), false) }) +
      kpi('Netto resultaat', fmt(winst), winst >= 0 ? 'pos' : 'neg',
          m.omzet > 0 ? `kasresultaat \u00b7 marge ${Math.round(winst / m.omzet * 100)}%` : '', '',
          { icoon: 'winst', trend: kpiTrend(groei(winst, vorig ? vorig.omzet - vorig.kosten : NaN), true) }) +
      kpi('Banksaldo', bank.saldo === null ? '\u2014' : fmt(bank.saldo), bank.saldo !== null && bank.saldo < 0 ? 'neg' : '', bank.label, '',
          { icoon: 'bank' }) +
      `</div>`;
  } catch (e) {
    console.error('Cijfertegels voor Home konden niet worden berekend:', e);
    return '';
  }
}

const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** Omzet per maand, opgeteld. Zelfde omzetdefinitie als de tegel Omzet. */
function omzetOpgeteld(jaar, tot = 12) {
  const alle = [...(state.HIST_TX || []), ...(state.TX || [])]
    .filter(t => t.datum && t.datum.startsWith(jaar) && isInkomst(t) && isOmzet(t.gb));
  const perMaand = Array(12).fill(0);
  for (const t of alle) perMaand[Number(t.datum.slice(5, 7)) - 1] += t.bedrag;
  let som = 0;
  return perMaand.map((v, i) => (i < tot ? (som += v) : null));
}

function tekenJaarVergelijk(jaar) {
  const canvas = document.getElementById('c-home-jaren');
  if (!canvas || typeof Chart === 'undefined') return;
  dc('c-home-jaren');
  const vorigJaar = String(Number(jaar) - 1);
  const tot = jaar === String(lopendJaar()) ? new Date().getMonth() + 1 : 12;
  const dit = omzetOpgeteld(jaar, tot);
  const toen = omzetOpgeteld(vorigJaar);
  const heeftVorig = toen.some(v => v);
  const sets = [lijn(jaar, dit, cssVar('--chart-revenue'), { punten: false })];
  if (heeftVorig) {
    const s = lijn(vorigJaar, toen, cssVar('--text-muted'), { vulling: false, punten: false });
    s.borderDash = [5, 5]; s.borderWidth = 1.6;
    sets.push(s);
  }
  charts['c-home-jaren'] = new Chart(canvas, {
    type: 'line',
    data: { labels: MND, datasets: sets },
    options: baseOpts({
      legend: heeftVorig, yFmt: fmtKort,
      tooltipFmt: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`
    })
  });
}

function bijzakenBalk(fac) {
  try {
    const vrd = berekenVoorraad();
    const open = f => `${f.aantal} open${f.teLaat ? ` \u00b7 ${f.teLaat} te laat` : ''}`;
    return `<div class="kpi-grid home-kpi-rij">` +
      kpi('Voorraadwaarde', fmt(vrd.waarde), '', `Covers ${fmt(vrd.coversWaarde)} \u00b7 HNVI ${fmt(vrd.lotenWaarde)}`, ' kpi--secondary') +
      kpi('Te ontvangen', fmt(fac.debiteuren.bedrag), '', open(fac.debiteuren), ' kpi--secondary') +
      kpi('Te betalen', fmt(fac.crediteuren.bedrag), '', open(fac.crediteuren), ' kpi--secondary') +
      `</div>`;
  } catch (e) {
    console.error('Bijzaken-balk voor Home kon niet worden berekend:', e);
    return '';
  }
}

function recenteBoekingen() {
  const rijen = [...(state.TX || [])]
    .filter(t => t.datum)
    .sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0))
    .slice(0, 8);
  if (!rijen.length) return '<div class="muted" style="font-size:13px">Nog geen boekingen.</div>';
  return `<table class="tbl-compact"><tbody>${rijen.map(t => {
    const plus = isInkomst(t) || t.type === 'prive_storting';
    return `<tr class="row-click" onclick="gaNaar('dagboeken')">
      <td style="width:54px;color:var(--text-muted)">${esc(ddmm(t.datum))}</td>
      <td class="td-trunc">${esc(weergaveNaam(t))}</td>
      <td class="td-num ${plus ? 'pos' : 'neg'}">${plus ? '+' : '\u2013'}${fmt(t.bedrag)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

// ─── Tegel ─────────────────────────────────────────────────────────────────

/**
 * Eén tegel. `pagina` is een route uit ui.js; `actie` is een globale functie
 * voor tegels die een modal openen in plaats van te navigeren.
 */
function tegel({ titel, uitleg, icoon, pagina, actie, regels = [], nadruk = null }) {
  const doel = pagina
    ? `onclick="gaNaar('${pagina}')"`
    : `onclick="${actie}"`;
  const merk = nadruk
    ? `<span class="home-tegel-merk home-tegel-merk-${nadruk.soort}">${esc(nadruk.tekst)}</span>`
    : '';
  const detail = regels.length
    ? `<div class="home-tegel-regels">${regels.map(r => `<span>${esc(r)}</span>`).join('')}</div>`
    : '';

  return `
    <button type="button" class="home-tegel" ${doel}
            aria-label="${esc(titel)}${uitleg ? ' — ' + esc(uitleg) : ''}">
      <span class="home-tegel-kop">
        <span class="home-tegel-icoon">${icoon}</span>
        ${merk}
      </span>
      <span class="home-tegel-titel">${esc(titel)}</span>
      <span class="home-tegel-uitleg">${esc(uitleg)}</span>
      ${detail}
    </button>`;
}

const I = {
  boekhouding: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>',
  facturen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16l3-2 3 2 3-2 3 2V8z"/><path d="M14 2v6h6"/><path d="M8 12h6M8 16h4"/></svg>',
  voorraad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>',
  belasting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  hnvi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg>',
  beheer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 3.68 1.65 1.65 0 0010 2.17V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0020.32 8v0a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>'
};

// ─── Renderen ──────────────────────────────────────────────────────────────

export function renderPortaal() {
  const doel = el('home-inhoud');
  if (!doel) return;

  const fac = factuurSamenvatting();
  const vrd = voorraadStand();
  const ctr = controleStand();
  const hn = hnviStand();
  const bk = boekingenStand();
  const jaar = homeJaar();

  const open = fac.debiteuren.aantal + fac.crediteuren.aantal;
  const teLaat = fac.debiteuren.teLaat + fac.crediteuren.teLaat;
  const ctrlTekst = ctr
    ? (ctr.fout + ctr.waarschuwing === 0 ? 'Controle: alles in orde' : `Controle: ${ctr.fout} fout \u00b7 ${ctr.waarschuwing} aandachtspunt${ctr.waarschuwing === 1 ? '' : 'en'}`)
    : 'Controle niet beschikbaar';

  const tegels = [
    tegel({
      titel: 'Bank en facturen', uitleg: 'Bank, inkoop- en verkoopfacturen, vaste posten', icoon: I.facturen,
      pagina: 'bank',
      nadruk: teLaat > 0 ? { soort: 'fout', tekst: `${teLaat} te laat` }
        : (open > 0 ? { soort: 'info', tekst: `${open} open` } : null),
      regels: open ? [`Te ontvangen ${fmt(fac.debiteuren.bedrag)}`, `Te betalen ${fmt(fac.crediteuren.bedrag)}`] : ['Niets openstaand']
    }),
    tegel({
      titel: 'Relaties', uitleg: 'Klanten en leveranciers met hun facturen', icoon: I.boekhouding,
      pagina: 'debiteuren',
      regels: [`${fac.debiteuren.aantal} open bij klanten`, `${fac.crediteuren.aantal} open bij leveranciers`]
    }),
    tegel({
      titel: 'Handel en voorraad', uitleg: 'Bol, voorraad, veiling en HNVI-loten', icoon: I.voorraad,
      pagina: 'voorraad',
      nadruk: vrd.op > 0 ? { soort: 'waarschuwing', tekst: `${vrd.op} op` }
        : (vrd.bijna > 0 ? { soort: 'info', tekst: `${vrd.bijna} bijna op` } : null),
      regels: [`${vrd.totaal} artikelen`, `${hn.voorraad} HNVI-loten in voorraad`]
    }),
    tegel({
      titel: 'Overzichten', uitleg: 'Resultaat, perioden en grootboek', icoon: I.boekhouding,
      pagina: 'overzicht',
      regels: [`${bk.jaar} boekingen dit jaar`, `${bk.historisch} historisch`]
    }),
    tegel({
      titel: 'Belasting en aangifte', uitleg: 'Inkomstenbelasting, jaarafsluiting, uren en kilometers', icoon: I.belasting,
      pagina: 'jaarafsluiting',
      regels: [`Boekjaar ${state.huidigJaar}`, 'Jaarafsluiting met controlelijst']
    }),
    tegel({
      titel: 'Beheer', uitleg: 'Controle, import, back-up en onderhoud', icoon: I.beheer,
      pagina: 'beheer',
      nadruk: ctr && ctr.fout > 0 ? { soort: 'fout', tekst: `${ctr.fout} te doen` }
        : (ctr && ctr.waarschuwing > 0 ? { soort: 'waarschuwing', tekst: `${ctr.waarschuwing} let op` } : null),
      regels: [ctrlTekst]
    })
  ].join('');

  const taak = (tekst, pagina) => `<li><button type="button" class="btn-details" onclick="gaNaar('${pagina}')">${esc(tekst)} \u2192</button></li>`;
  const taken = [];
  if (teLaat > 0) taken.push(taak(`${teLaat} factuur${teLaat === 1 ? '' : 'en'} te laat`, 'inkoopfacturen'));
  const openInkoop = onverwerkteInkoop(String(state.huidigJaar));
  if (openInkoop > 0) taken.push(`<li><button type="button" class="btn-details" onclick="openInkoopLijst()">${openInkoop} inkoopbetaling${openInkoop === 1 ? '' : 'en'} zonder artikelen \u2192</button></li>`);
  if (ctr && ctr.fout > 0) taken.push(taak(`${ctr.fout} fout${ctr.fout === 1 ? '' : 'en'} in de controle`, 'controle'));
  if (ctr && ctr.waarschuwing > 0) taken.push(taak(`${ctr.waarschuwing} aandachtspunt${ctr.waarschuwing === 1 ? '' : 'en'} in de controle`, 'controle'));

  doel.innerHTML = `
    <div class="home-welkom">
      <h1 class="home-titel">Welkom bij Xtenate Administratie</h1>
      <p class="home-sub">Kies waar je heen wilt.</p>
    </div>
    ${kpiRij(jaar)}
    <div class="card" id="home-todo" style="margin-bottom:16px;padding:14px 18px">
      <div style="font-weight:600;margin-bottom:6px">Nog te doen</div>
      <ul id="home-todo-lijst" style="margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px">${taken.join('')}</ul>
      <div id="home-todo-leeg" class="muted" style="font-size:14px;display:${taken.length ? 'none' : 'block'}">Alles op orde.</div>
    </div>
    ${bijzakenBalk(fac)}
    <div class="home-twee">
      <div class="card home-jaren">
        <div style="font-weight:600">Omzet, opgeteld per maand</div>
        <div class="muted" style="font-size:13px;margin-bottom:8px">${esc(jaar)} tegenover het jaar ervoor</div>
        <div class="chart-box"><canvas id="c-home-jaren" role="img" aria-label="Omzet opgeteld per maand, dit jaar tegenover vorig jaar"></canvas></div>
      </div>
      <div class="card home-recent">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-weight:600">Recente boekingen</span>
          <button type="button" class="btn-details" onclick="gaNaar('dagboeken')">Alle boekingen \u2192</button>
        </div>
        ${recenteBoekingen()}
      </div>
    </div>
    <div class="home-tegels">${tegels}</div>`;
  tekenJaarVergelijk(jaar);

  // De bank-inbox komt uit Supabase en wordt daarom pas daarna toegevoegd.
  telInbox().then(n => {
    if (document.getElementById('home-todo-inbox')) return;
    const lijst = document.getElementById('home-todo-lijst');
    if (!lijst || !n) return;
    lijst.insertAdjacentHTML('afterbegin', taak(`${n} nieuwe bankregel${n === 1 ? '' : 's'} in de inbox`, 'bank').replace('<li>', '<li id="home-todo-inbox">'));
    const leeg = document.getElementById('home-todo-leeg');
    if (leeg) leeg.style.display = 'none';
  });
}
