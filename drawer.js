// drawer.js — detailpaneel rechts met alle gegevens van één boeking.

import { esc, fmt, isInkomst, rekBadge, weergaveNaam } from './helpers.js?v=20261024j';
import { state, grootboekNamen, rekeningNamen } from './storage.js?v=20261024j';
import { bonnetjesRegelHtml } from './bonnetjes.js?v=20261024j';

const TYPE_LABEL = {
  inkomst: 'Inkomst',
  uitgave: 'Uitgave',
  prive_opname: 'Privé opname',
  prive_storting: 'Privé storting'
};

/** Zoekt een boeking op id, in zowel de huidige als de historische data. */
export function vindBoeking(id) {
  return state.TX.find(t => String(t.id) === String(id))
      || state.HIST_TX.find(t => String(t.id) === String(id));
}

function langeDatum(d) {
  const maanden = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const [j, m, dag] = d.split('-');
  return `${parseInt(dag, 10)} ${maanden[parseInt(m, 10) - 1]} ${j}`;
}

export function openBoeking(id) {
  const t = vindBoeking(id);
  if (!t) return;

  const positief = isInkomst(t) || t.type === 'prive_storting';
  const teken = positief ? '+' : '–';
  const anderen = [...state.TX, ...state.HIST_TX]
    .filter(x => x.id !== t.id && x.naam && x.naam === t.naam).length;
  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();

  document.getElementById('drawer-body').innerHTML = `
    <div class="drawer-amount ${positief ? 'pos' : 'neg'}">${teken}${fmt(t.bedrag)}</div>
    <div class="drawer-when">${esc(langeDatum(t.datum))}</div>
    <div class="dl-row"><span class="dl-key">Naam</span><span class="dl-val">${esc(weergaveNaam(t)) || '—'}</span></div>
    <div class="dl-row"><span class="dl-key">Grootboek</span><span class="dl-val"><span class="gbnr">${esc(t.gb)}</span> ${esc(GBNM[t.gb] || 'onbekende rekening')}</span></div>
    <div class="dl-row"><span class="dl-key">Rekening</span><span class="dl-val">${rekBadge(t.rek, REKNM[t.rek])}</span></div>
    <div class="dl-row"><span class="dl-key">Soort</span><span class="dl-val">${TYPE_LABEL[t.type] || esc(t.type)}</span></div>
    <div class="dl-row"><span class="dl-key">Omschrijving</span><span class="dl-val">${esc(t.omschr) || '—'}</span></div>
    <div class="dl-row"><span class="dl-key">Tegenpartij (ruw)</span><span class="dl-val">${esc(t.naam) || '—'}</span></div>
    <div class="dl-row"><span class="dl-key">Boekingsnummer</span><span class="dl-val gbnr">${esc(t.id)}</span></div>
    ${bonnetjesRegelHtml(t.id)}
    ${anderen > 0 ? `<div class="dl-row"><span class="dl-key">Zelfde tegenpartij</span><span class="dl-val">${anderen} andere boeking${anderen === 1 ? '' : 'en'}</span></div>` : ''}
    <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:var(--spacing-5)"
            data-bewerk-tx="${esc(t.id)}">Deze boeking bewerken</button>
  `;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
  document.querySelector('#drawer .icon-btn')?.focus();
}

export function sluitDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
  document.querySelectorAll('.row-click.is-selected').forEach(r => r.classList.remove('is-selected'));
}

/** Markeert de aangeklikte rij en opent het paneel. */
export function toonBoeking(id, rij) {
  document.querySelectorAll('.row-click.is-selected').forEach(r => r.classList.remove('is-selected'));
  if (rij) rij.classList.add('is-selected');
  openBoeking(id);
}
