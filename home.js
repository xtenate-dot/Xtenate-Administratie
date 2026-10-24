// home.js — de startpagina: een portaal met tegels naar de hoofdonderdelen.
//
// Dit is bewust GEEN financieel overzicht. Dat is de pagina 'Overzicht'
// (dashboard.js), die ongewijzigd blijft bestaan als onderdeel van de
// administratie. Home is het startpunt na inloggen: waar wil ik heen?
//
// De tegels tonen hooguit een paar cijfers om te laten zien of er aandacht
// nodig is. Alle gebruikte functies zijn alleen-lezend; deze module wijzigt
// nooit data.

import { draaiControles } from './controle.js?v=20261024a';
import { factuurSamenvatting } from './facturen.js?v=20261024a';
import { esc, fmt } from './helpers.js?v=20261024a';
import { standaardMinVoorraad, state } from './storage.js?v=20261024a';

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

  const tegels = [
    tegel({
      titel: 'Boekhouding', uitleg: 'Overzicht, bank, grootboek en boekingen', icoon: I.boekhouding,
      pagina: 'overzicht',
      regels: [`${bk.jaar} boekingen dit jaar`, `${bk.historisch} historisch`]
    }),
    tegel({
      titel: 'Beheer', uitleg: 'Controle, import, export en onderhoud', icoon: I.beheer,
      pagina: 'beheer',
      nadruk: ctr && ctr.fout > 0
        ? { soort: 'fout', tekst: `${ctr.fout} te doen` }
        : (ctr && ctr.waarschuwing > 0
          ? { soort: 'waarschuwing', tekst: `${ctr.waarschuwing} let op` } : null),
      regels: ctr
        ? [ctr.fout + ctr.waarschuwing === 0 ? 'Controle: alles in orde' : `Controle: ${ctr.fout} fout \u00b7 ${ctr.waarschuwing} waarschuwing`]
        : ['Gegevens, onderhoud en systeem']
    }),
    tegel({
      titel: 'Facturen', uitleg: 'Debiteuren en crediteuren', icoon: I.facturen,
      pagina: 'facturen',
      nadruk: (fac.debiteuren.teLaat + fac.crediteuren.teLaat) > 0
        ? { soort: 'fout', tekst: `${fac.debiteuren.teLaat + fac.crediteuren.teLaat} te laat` }
        : (fac.crediteuren.binnenkort > 0
          ? { soort: 'waarschuwing', tekst: `${fac.crediteuren.binnenkort} bijna` }
          : ((fac.debiteuren.aantal + fac.crediteuren.aantal) > 0
            ? { soort: 'info', tekst: `${fac.debiteuren.aantal + fac.crediteuren.aantal} open` } : null)),
      regels: (fac.debiteuren.aantal + fac.crediteuren.aantal)
        ? [`Te ontvangen ${fmt(fac.debiteuren.bedrag)}`, `Te betalen ${fmt(fac.crediteuren.bedrag)}`]
        : ['Niets openstaand']
    }),
    tegel({
      titel: 'Voorraad', uitleg: 'Artikelen, groepen en voorraadstanden', icoon: I.voorraad,
      pagina: 'voorraad',
      nadruk: vrd.op > 0
        ? { soort: 'waarschuwing', tekst: `${vrd.op} op` }
        : (vrd.bijna > 0 ? { soort: 'info', tekst: `${vrd.bijna} bijna op` } : null),
      regels: [`${vrd.totaal} artikelen`, vrd.op || vrd.bijna ? `${vrd.op} op \u00b7 ${vrd.bijna} bijna op` : 'Voorraad op peil']
    }),
    tegel({
      titel: 'Belasting', uitleg: 'Inkomstenbelasting en aftrekposten', icoon: I.belasting,
      pagina: 'belasting',
      regels: [`Boekjaar ${state.huidigJaar}`]
    }),
    tegel({
      titel: 'HNVI / Xtenate', uitleg: 'Loten inkopen, verkopen en marge', icoon: I.hnvi,
      pagina: 'hnvi',
      regels: [`${hn.voorraad} in voorraad`, `${hn.totaal} loten totaal`]
    })
  ].join('');

  doel.innerHTML = `
    <div class="home-welkom">
      <h1 class="home-titel">Welkom bij Xtenate Administratie</h1>
      <p class="home-sub">Kies waar je heen wilt.</p>
    </div>
    <div class="home-tegels">${tegels}</div>`;
}
