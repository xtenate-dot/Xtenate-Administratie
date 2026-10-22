// search.js — globale zoekfunctie over boekingen, voorraad en HNVI-loten.

import { ddmm, esc, fmt, isInkomst, vertraag, weergaveNaam } from './helpers.js?v=20261023a';
import { state, grootboekNamen, rekeningNamen } from './storage.js?v=20261023a';
import { openBoeking } from './drawer.js?v=20261023a';
import { gaNaar } from './ui.js?v=20261023a';

const MAX_PER_GROEP = 6;
let actieveIndex = -1;

/** Alles waar een boeking op gevonden mag worden, als één doorzoekbare tekst. */
function zoekTekst(t, GBNM, REKNM) {
  return [
    t.naam, t.omschr, t.gb, GBNM[t.gb], t.rek, REKNM[t.rek],
    t.datum, t.bedrag != null ? t.bedrag.toFixed(2) : '',
    t.bedrag != null ? String(t.bedrag).replace('.', ',') : ''
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Ook gebruikt door facturen-ui.js om een boeking te koppelen aan een factuur. */
export function zoekBoekingen(q) {
  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();
  return [...state.TX, ...state.HIST_TX]
    .filter(t => zoekTekst(t, GBNM, REKNM).includes(q))
    .sort((a, b) => b.datum.localeCompare(a.datum));
}

function zoekCovers(q) {
  return state.COVERS.filter(c =>
    [c.artikel, c.zoekterm].filter(Boolean).join(' ').toLowerCase().includes(q));
}

function zoekLoten(q) {
  return state.HNVI_LOTS.filter(l =>
    [l.omschr, l.noot, l.datum, l.inkoop, l.verkoop]
      .filter(v => v != null).join(' ').toLowerCase().includes(q));
}

function regelBoeking(t, GBNM, REKNM) {
  const positief = isInkomst(t) || t.type === 'prive_storting';
  return `<div class="sr-item" role="option" data-soort="boeking" data-id="${esc(t.id)}">
    <div class="sr-main">
      <div class="sr-title">${esc(weergaveNaam(t)) || '(geen naam)'}</div>
      <div class="sr-meta">${ddmm(t.datum)} · <span class="gbnr">${esc(t.gb)}</span> ${esc(GBNM[t.gb] || '')} · ${esc(REKNM[t.rek] || t.rek)}</div>
    </div>
    <div class="sr-amount ${positief ? 'pos' : 'neg'}">${positief ? '+' : '–'}${fmt(t.bedrag)}</div>
  </div>`;
}

function regelCover(c) {
  return `<div class="sr-item" role="option" data-soort="cover">
    <div class="sr-main">
      <div class="sr-title">${esc(c.artikel)}</div>
      <div class="sr-meta">${c.voorraad} op voorraad · ${c.verkoop} verkocht</div>
    </div>
  </div>`;
}

function regelLot(l) {
  return `<div class="sr-item" role="option" data-soort="lot">
    <div class="sr-main">
      <div class="sr-title">${esc(l.omschr || 'Lot zonder omschrijving')}</div>
      <div class="sr-meta">${l.datum ? ddmm(l.datum) + ' · ' : ''}${l.status === 'verkocht' ? 'verkocht' : 'in voorraad'}</div>
    </div>
    <div class="sr-amount muted">${fmt(l.inkoop || 0)}</div>
  </div>`;
}

export function zoek() {
  const veld = document.getElementById('global-search');
  const paneel = document.getElementById('search-results');
  const q = veld.value.trim().toLowerCase();
  actieveIndex = -1;

  if (q.length < 2) { paneel.classList.remove('open'); paneel.innerHTML = ''; return; }

  const boekingen = zoekBoekingen(q);
  const covers = zoekCovers(q);
  const loten = zoekLoten(q);

  if (!boekingen.length && !covers.length && !loten.length) {
    paneel.innerHTML = `<div class="sr-empty">Niets gevonden voor “${esc(veld.value.trim())}”.<br>Zoek op naam, bedrag, grootboeknummer of rekening.</div>`;
    paneel.classList.add('open');
    return;
  }

  let html = '';
  if (boekingen.length) {
    const GBNM = grootboekNamen();
    const REKNM = rekeningNamen();
    html += `<div class="sr-group">Boekingen · ${boekingen.length}</div>`;
    html += boekingen.slice(0, MAX_PER_GROEP).map(t => regelBoeking(t, GBNM, REKNM)).join('');
  }
  if (covers.length) {
    html += `<div class="sr-group">Funny Covers · ${covers.length}</div>`;
    html += covers.slice(0, MAX_PER_GROEP).map(regelCover).join('');
  }
  if (loten.length) {
    html += `<div class="sr-group">HNVI-loten · ${loten.length}</div>`;
    html += loten.slice(0, MAX_PER_GROEP).map(regelLot).join('');
  }
  paneel.innerHTML = html;
  paneel.classList.add('open');
}

export function sluitZoek() {
  document.getElementById('search-results')?.classList.remove('open');
  actieveIndex = -1;
}

export function focusZoek() {
  const veld = document.getElementById('global-search');
  veld.focus();
  veld.select();
}

function kiesRegel(el) {
  const soort = el.dataset.soort;
  sluitZoek();
  document.getElementById('global-search').blur();
  if (soort === 'boeking') openBoeking(el.dataset.id);
  else if (soort === 'cover') gaNaar('covers');
  else if (soort === 'lot') gaNaar('hnvi');
}

export function initZoek() {
  const veld = document.getElementById('global-search');
  const paneel = document.getElementById('search-results');
  if (!veld || !paneel) return;

  // Zoeken loopt over alle boekingen; even wachten scheelt veel werk.
  const zoekVertraagd = vertraag(zoek, 140);
  veld.addEventListener('input', zoekVertraagd);
  veld.addEventListener('focus', () => { if (veld.value.trim().length >= 2) zoek(); });

  paneel.addEventListener('click', e => {
    const item = e.target.closest('.sr-item');
    if (item) kiesRegel(item);
  });

  veld.addEventListener('keydown', e => {
    const items = [...paneel.querySelectorAll('.sr-item')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      actieveIndex = e.key === 'ArrowDown'
        ? Math.min(actieveIndex + 1, items.length - 1)
        : Math.max(actieveIndex - 1, 0);
      items.forEach((it, i) => it.classList.toggle('is-active', i === actieveIndex));
      items[actieveIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const doel = items[actieveIndex] || items[0];
      if (doel) { e.preventDefault(); kiesRegel(doel); }
    } else if (e.key === 'Escape') {
      sluitZoek(); veld.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) sluitZoek();
  });
}
