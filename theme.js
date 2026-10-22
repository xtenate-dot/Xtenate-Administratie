// theme.js — donkere modus, inklapbaar zijmenu, mobiel menu en sneltoetsen.

import { destroyAll } from './charts.js?v=20261023f';
import { hertekenHuidigePagina } from './ui.js?v=20261023f';

const THEMA_KEY = 'xtenate_thema';
const MENU_KEY = 'xtenate_menu_ingeklapt';

/**
 * Licht is de standaard van Xtenate. Alleen wanneer iemand zelf voor de
 * donkere modus kiest via de knop in de bovenbalk, wordt die keuze
 * onthouden en gerespecteerd.
 */
export function huidigThema() {
  const gekozen = localStorage.getItem(THEMA_KEY);
  return gekozen === 'light' || gekozen === 'dark' ? gekozen : 'dark';
}

function pasThemaToe(thema, herteken) {
  document.documentElement.setAttribute('data-theme', thema);
  const knop = document.getElementById('thema-knop');
  if (knop) {
    knop.setAttribute('aria-label', thema === 'dark' ? 'Naar lichte modus' : 'Naar donkere modus');
    knop.title = thema === 'dark' ? 'Lichte modus' : 'Donkere modus';
    knop.innerHTML = thema === 'dark'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
  }
  if (herteken) {
    // Grafieken lezen hun kleuren bij het tekenen uit; opnieuw opbouwen dus.
    destroyAll();
    hertekenHuidigePagina();
  }
}

export function wisselThema() {
  const nieuw = huidigThema() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEMA_KEY, nieuw);
  pasThemaToe(nieuw, true);
}

export function wisselMenu() {
  const ingeklapt = document.body.classList.toggle('nav-collapsed');
  localStorage.setItem(MENU_KEY, ingeklapt ? '1' : '0');
}

export function wisselMobielMenu() {
  const open = document.body.classList.toggle('nav-open');
  document.getElementById('nav-backdrop')?.classList.toggle('open', open);
}

export function sluitMobielMenu() {
  document.body.classList.remove('nav-open');
  document.getElementById('nav-backdrop')?.classList.remove('open');
}

export function initUiVoorkeuren() {
  pasThemaToe(huidigThema(), false);
  if (localStorage.getItem(MENU_KEY) === '1') document.body.classList.add('nav-collapsed');
}
