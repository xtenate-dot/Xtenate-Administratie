// ui.js — navigatie tussen pagina's en het onthouden van de actieve pagina.

import { renderBank } from './bank.js?v=20261022d';
import { renderBelasting } from './belasting.js?v=20261022d';
import { renderBtw } from './btw.js?v=20261022d';
import { renderCrediteuren } from './crediteuren.js?v=20261022d';
import { renderDebiteuren } from './debiteuren.js?v=20261022d';
import { renderHome } from './dashboard.js?v=20261022d';
import { renderPortaal } from './home.js?v=20261022d';
import { renderGrootboek } from './grootboek.js?v=20261022d';
import { renderHNVI } from './hnvi.js?v=20261022d';
import { renderControle } from './controle.js?v=20261022d';
import { renderCovers } from './voorraad.js?v=20261022d';
import { renderFacturen } from './facturen-ui.js?v=20261022d';
import { renderKm } from './km-ui.js?v=20261022d';
import { renderActiva } from './activa-ui.js?v=20261022d';
import { renderVeiling } from './veiling-ui.js?v=20261022d';
import { renderPeriode } from './periode.js?v=20261022d';
import { renderBeheer } from './beheer.js?v=20261022d';
import { toonGroepVan } from './navgroepen.js?v=20261022d';

const RENDERS = {
  home: renderPortaal,      // de startpagina: tegels naar de onderdelen
  overzicht: renderHome,    // het financiële dashboard (voorheen 'home')
  bank: renderBank,
  facturen: renderFacturen,
  crediteuren: renderCrediteuren,
  debiteuren: renderDebiteuren,
  grootboek: renderGrootboek,
  belasting: renderBelasting,
  btw: renderBtw,
  controle: renderControle,
  voorraad: renderCovers,
  hnvi: renderHNVI,
  veiling: renderVeiling,
  periode: renderPeriode,
  km: renderKm,
  activa: renderActiva,
  beheer: renderBeheer
};

const TITELS = {
  home: 'Home',
  overzicht: 'Overzicht',
  bank: 'Bank',
  facturen: 'Facturen',
  crediteuren: 'Leveranciers',
  debiteuren: 'Klanten',
  grootboek: 'Grootboek',
  belasting: 'Belasting',
  btw: 'BTW',
  controle: 'Controle',
  voorraad: 'Voorraad',
  hnvi: 'HNVI / Xtenate',
  veiling: 'Artikelvoorraad',
  periode: 'Per periode',
  km: 'Kilometers',
  activa: 'Activa',
  beheer: 'Beheer'
};

export let huidigePagina = 'home';

export function nav(p, btn) {
  if (!RENDERS[p]) return;
  huidigePagina = p;

  // De hash bijwerken zodat een refresh en de terugknop de pagina onthouden.
  // De gelijkheidscontrole voorkomt een lus: hashchange roept gaNaar aan, die
  // roept nav aan, die anders de hash opnieuw zou zetten.
  if (location.hash.slice(1) !== p) location.hash = p;

  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page], .tab-item[data-page]').forEach(x => x.classList.remove('active'));
  document.getElementById('p-' + p).classList.add('active');

  // Zit de pagina in een dichtgeklapte menugroep, klap die dan open, zodat
  // je na een deeplink of sneltoets ziet waar je bent.
  toonGroepVan(p);

  // Zowel het zijmenu als de tabbalk onderaan oplichten, zodat je op een
  // telefoon ziet waar je bent ook als je via het zijmenu navigeerde.
  document.querySelectorAll(`.nav-item[data-page="${p}"], .tab-item[data-page="${p}"]`)
    .forEach(x => x.classList.add('active'));
  if (btn) btn.classList.add('active');

  const titel = document.getElementById('topbar-title');
  if (titel) titel.textContent = TITELS[p] || '';

  document.body.classList.remove('nav-open');
  document.getElementById('nav-backdrop')?.classList.remove('open');
  window.scrollTo({ top: 0 });

  RENDERS[p]();
}

/** Tekent de pagina die nu open staat opnieuw (na thema- of datawijziging). */
export function hertekenHuidigePagina() {
  RENDERS[huidigePagina]?.();
}

/** Springt naar een pagina zonder dat er een knop is aangeklikt. */
export function gaNaar(p) {
  nav(p, document.querySelector(`.nav-item[data-page="${p}"]`));
}

// Debiteuren en crediteuren zijn weer eigen pagina's. Hier stond eerder een
// alias die #debiteuren en #crediteuren doorstuurde naar de tabbladen van
// Facturen. Dat botste met nav(): die zette de hash, waarna hashchange de
// bezoeker meteen naar Facturen gooide — de pagina flitste dan even voorbij.

/** Welke pagina hoort er bij de huidige hash? 'home' als de hash leeg of onbekend is. */
export function paginaUitHash() {
  const p = location.hash.slice(1);
  return RENDERS[p] ? p : 'home';
}

// Terug- en vooruitknop van de browser, en handmatig aangepaste hash.
window.addEventListener('hashchange', () => {
  const p = paginaUitHash();
  if (p !== huidigePagina) gaNaar(p);
});
