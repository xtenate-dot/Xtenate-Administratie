// crediteuren.js — Wie betaal ik en hoeveel?
// De logica staat in partijen.js, zodat debiteuren en crediteuren elkaars
// knoppen niet meer kapen.

import { tekenPartijen } from './partijen.js?v=20261024e';

const opties = {
  lijstId: 'crediteuren-list',
  totaalId: 'crediteuren-totaal',
  soort: 'uitgave',
  leegTekst: 'Geen uitgaven',
  herteken: () => renderCrediteuren()
};

export function renderCrediteuren() {
  tekenPartijen(opties);
}

export function wisselJaarCrediteuren() {
  renderCrediteuren();
}
