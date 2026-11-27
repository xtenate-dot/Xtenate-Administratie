// stijlen.js — kiest de uiterlijke stijl van de app: glass (standaard), lavendel of rood.
// Alleen uiterlijk. De keuze staat lokaal in de browser (xtenate_stijl).

import { destroyAll } from './charts.js?v=20261127b';
import { hertekenHuidigePagina } from './ui.js?v=20261127b';

const KEY = 'xtenate_stijl';
const STIJLEN = [
  { id: 'glass', naam: 'Glass' },
  { id: 'lavendel', naam: 'Lavendel' },
  { id: 'rood', naam: 'Rood' }
];

export function huidigeStijl() {
  try { const s = localStorage.getItem(KEY); return STIJLEN.some(x => x.id === s) ? s : 'glass'; } catch { return 'glass'; }
}

function toepassen(stijl, herteken) {
  document.documentElement.setAttribute('data-stijl', stijl);
  const knop = document.getElementById('stijl-knop');
  if (knop) {
    const naam = STIJLEN.find(x => x.id === stijl)?.naam || stijl;
    knop.title = `Stijl: ${naam} (klik voor de volgende)`;
    knop.setAttribute('aria-label', knop.title);
  }
  if (herteken) {
    // Grafieken lezen hun kleuren bij het tekenen; dus opnieuw opbouwen.
    destroyAll();
    hertekenHuidigePagina();
  }
}

export function wisselStijl() {
  const i = STIJLEN.findIndex(x => x.id === huidigeStijl());
  const volgende = STIJLEN[(i + 1) % STIJLEN.length].id;
  try { localStorage.setItem(KEY, volgende); } catch {}
  toepassen(volgende, true);
}

/** De navigatiebalk bovenin (rode stijl) volgt de actieve pagina. */
function volgActievePagina() {
  const zet = () => {
    const actief = document.querySelector('.page.active')?.id?.replace(/^p-/, '') || 'home';
    document.querySelectorAll('#pillnav [data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === actief));
  };
  zet();
  const obs = new MutationObserver(zet);
  document.querySelectorAll('.page').forEach(p => obs.observe(p, { attributes: true, attributeFilter: ['class'] }));
}

export function initStijl() {
  toepassen(huidigeStijl(), false);
  volgActievePagina();
}
