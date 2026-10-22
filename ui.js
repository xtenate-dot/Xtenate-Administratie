// ui.js — navigatie tussen pagina's en het onthouden van de actieve pagina.

import { state } from './storage.js?v=20261023k';
import { renderBank } from './bank.js?v=20261023k';
import { renderBelasting } from './belasting.js?v=20261023k';
import { renderBtw } from './btw.js?v=20261023k';
import { renderCrediteuren } from './crediteuren.js?v=20261023k';
import { renderDebiteuren } from './debiteuren.js?v=20261023k';
import { renderHome } from './dashboard.js?v=20261023k';
import { renderPortaal } from './home.js?v=20261023k';
import { renderGrootboek } from './grootboek.js?v=20261023k';
import { renderHNVI } from './hnvi.js?v=20261023k';
import { renderControle } from './controle.js?v=20261023k';
import { renderCovers } from './voorraad.js?v=20261023k';
import { renderFacturen } from './facturen-ui.js?v=20261023k';
import { renderKm } from './km-ui.js?v=20261023k';
import { renderActiva } from './activa-ui.js?v=20261023k';
import { renderVeiling } from './veiling-ui.js?v=20261023k';
import { renderPeriode } from './periode.js?v=20261023k';
import { renderBankimport } from './bankimport.js?v=20261023k';
import { renderJaarafsluiting } from './jaarafsluiting.js?v=20261023k';
import { renderBeheer } from './beheer.js?v=20261023k';
import { toonGroepVan } from './navgroepen.js?v=20261023k';

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
  jaarafsluiting: renderJaarafsluiting,
  bankimport: renderBankimport,
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
  jaarafsluiting: 'Jaarafsluiting',
  bankimport: 'Bankimport',
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

  tekenPagina(p);
}

/** Tekent de pagina die nu open staat opnieuw (na thema- of datawijziging). */
export function hertekenHuidigePagina() {
  if (RENDERS[huidigePagina]) tekenPagina(huidigePagina);
}

/**
 * Tekent een pagina, maar pas als alle gegevens binnen zijn. Anders zou je
 * cijfers zien van een half geladen administratie (bijvoorbeeld zonder de
 * oude jaren), en die lijken dan gewoon te kloppen.
 */
function tekenPagina(p) {
  if (!state.dataKlaar) {
    const doel = document.getElementById('p-' + p);
    if (doel && !doel.querySelector('.laden-melding')) {
      doel.insertAdjacentHTML('afterbegin', '<div class="card laden-melding"><p>Gegevens worden geladen…</p></div>');
    }
    setTimeout(() => { if (huidigePagina === p) tekenPagina(p); }, 500);
    return;
  }
  document.querySelectorAll('.laden-melding').forEach(x => x.remove());
  RENDERS[p]();
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
