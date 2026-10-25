// factuurupload.js — factuur uploaden in het factuurvenster: links het voorbeeld, rechts de velden.
// Foto's worden met OCR gelezen, pdf's met pdf.js (en bij een gescande pdf ook met OCR). Daarmee worden
// de velden alvast ingevuld; jij controleert en drukt op Opslaan. Niets verlaat de browser.

import { state } from './storage.js?v=20261025d';
import { leesBon, leesFoto, laadTesseract } from './bonnetscan.js?v=20261025d';
import { bijlagenVan, bijlageBlob } from './bonnetjes.js?v=20261025d';
import { esc, fmt } from './helpers.js?v=20261025d';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFWORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const el = id => document.getElementById(id);
let wachtend = null;
let blobUrl = null;
let leesNr = 0;

export const wachtendFactuurBestand = () => wachtend;

function zetHint(html) { const h = el('fact-lees-hint'); if (h) h.innerHTML = html; }

export function resetFactuurUpload() {
  wachtend = null; leesNr++;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  el('fact-modal-box')?.classList.remove('fact-breed');
  const v = el('fact-voorbeeld'); if (v) v.innerHTML = '';
  const n = el('fact-upload-naam'); if (n) n.textContent = '';
  zetHint('');
}

function toonBlob(blob, naam, type) {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);
  const pdf = type === 'application/pdf' || /\.pdf$/i.test(naam);
  el('fact-voorbeeld').innerHTML = pdf
    ? `<iframe src="${blobUrl}#navpanes=0&zoom=page-width" title="Factuur"></iframe>`
    : `<img src="${blobUrl}" alt="Factuur">`;
  el('fact-modal-box').classList.add('fact-breed');
}

/** Bij Bewerken: toon de al bewaarde bijlage (de eerste) naast de velden. */
export async function toonBestaandeBijlage(factuurId) {
  const m = bijlagenVan('F-' + factuurId)[0];
  if (!m) return;
  const blob = await bijlageBlob(m.bid);
  if (blob) { toonBlob(blob, m.naam, m.type); el('fact-upload-naam').textContent = m.naam; }
}

export function kiesFactuurUpload() {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = 'image/*,application/pdf';
  i.onchange = () => { if (i.files[0]) zetBestand(i.files[0]); };
  i.click();
}

export async function zetBestand(f) {
  if (f.size > 12 * 1024 * 1024) { zetHint('⚠️ Dit bestand is te groot (max 12 MB).'); return; }
  wachtend = f;
  const mijn = ++leesNr;
  toonBlob(f, f.name, f.type);
  el('fact-upload-naam').textContent = f.name + ' (wordt bewaard bij Opslaan)';
  zetHint('⏳ Factuur wordt gelezen…');
  try {
    const tekst = await leesTekst(f, t => { if (mijn === leesNr) zetHint('⏳ ' + esc(t)); });
    if (mijn !== leesNr) return;
    vulIn(tekst);
  } catch (e) {
    if (mijn === leesNr) zetHint('⚠️ Automatisch lezen lukte niet (' + esc(e.message || e) + '). Je kunt de velden zelf invullen.');
  }
}

// ─── Tekst uit de factuur ────────────────────────────────────────────────────

function laadScript(src) {
  return new Promise((ok, fout) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = ok; s.onerror = () => fout(new Error('bibliotheek niet te laden (internet?)'));
    document.head.appendChild(s);
  });
}

async function leesPdf(f, voortgang) {
  if (!window.pdfjsLib) await laadScript(PDFJS);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFWORKER;
  const pdf = await window.pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
  let tekst = '';
  for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
    const pagina = await pdf.getPage(p);
    const inhoud = await pagina.getTextContent();
    const regels = new Map();
    for (const it of inhoud.items) {
      const y = Math.round(it.transform[5] / 3);
      regels.set(y, (regels.get(y) || []).concat({ x: it.transform[4], t: it.str }));
    }
    tekst += [...regels.entries()].sort((a, b) => b[0] - a[0])
      .map(([, d]) => d.sort((a, b) => a.x - b.x).map(x => x.t).join(' ')).join('\n') + '\n';
  }
  if (tekst.replace(/\s/g, '').length >= 40) return tekst;
  // Gescande pdf: eerste pagina als beeld lezen
  voortgang('pagina wordt als afbeelding gelezen');
  const pagina = await pdf.getPage(1);
  const vp = pagina.getViewport({ scale: 2 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await pagina.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const T = await laadTesseract();
  const res = await T.recognize(c, 'nld+eng');
  return res?.data?.text || '';
}

async function leesTekst(f, voortgang) {
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return leesPdf(f, voortgang);
  return leesFoto(f, voortgang);
}

// ─── Velden invullen ─────────────────────────────────────────────────────────

const MND = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12 };
/** Engelse notatie: "September 07, 2026" of "Sep 7 2026". */
function engelseDatums(t) {
  const uit = [];
  for (const m of String(t).matchAll(/(?<![a-z])([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/g)) {
    const mnd = MND[m[1].toLowerCase()], d = Number(m[2]);
    if (mnd && d >= 1 && d <= 31) uit.push(`${m[3]}-${String(mnd).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return uit;
}
const datumsIn = regel => [...new Set([...leesBon(regel).datums, ...engelseDatums(regel)])];

/** Zuivere uitleesfunctie: geeft voorgestelde waarden uit de ruwe factuurtekst. */
export function leesFactuur(tekst, relaties = []) {
  const regels = String(tekst || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const uit = { datum: '', vervaldatum: '', bedrag: null, bedragen: [], nummer: '', relatie: null, bovenaan: '' };
  const lb = leesBon(tekst);
  uit.bedragen = lb.bedragen.slice(0, 4);
  if (lb.bedragen[0] && lb.bedragen[0].prio >= 3) uit.bedrag = lb.bedragen[0].bedrag;
  for (const r of regels) {
    if (!uit.vervaldatum && /(vervaldatum|uiterlijk|due date|betalen voor|te voldoen voor)/i.test(r)) uit.vervaldatum = datumsIn(r)[0] || '';
    if (!uit.datum && /(factuurdatum|invoice date|date of issue|datum factuur|^datum\b)/i.test(r) && !/(vervaldatum|due date)/i.test(r)) uit.datum = datumsIn(r)[0] || '';
  }
  if (!uit.datum) uit.datum = [...new Set([...lb.datums, ...engelseDatums(tekst)])].sort().find(d => d !== uit.vervaldatum) || '';
  const m = String(tekst).match(/(?:factuur\s*(?:nummer|nr\.?|no\.?)|factuurnr\.?|invoice\s*(?:number|no\.?|nr\.?|#)|ordernummer)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-\/._]{2,24})/i);
  if (m && /\d/.test(m[1])) uit.nummer = m[1].replace(/[._-]+$/, '');
  const laag = String(tekst).toLowerCase();
  let beste = null;
  for (const r of relaties) {
    for (const n of [r.naam, ...(r.aliassen || [])]) {
      const w = String(n || '').trim().toLowerCase();
      if (w.length >= 3 && laag.includes(w) && (!beste || w.length > beste.len)) beste = { r, len: w.length };
    }
  }
  if (beste) uit.relatie = beste.r;
  uit.bovenaan = regels.find(r => /[a-zA-Z]{3,}/.test(r) && r.length <= 60) || '';
  return uit;
}

function zet(id, w) { const e = el(id); if (e) e.value = w; }

function vulIn(tekst) {
  const u = leesFactuur(tekst, state.RELATIES || []);
  const ingevuld = [];
  if (u.datum) { zet('fact-d', u.datum); ingevuld.push('datum'); }
  if (u.vervaldatum) { zet('fact-verval', u.vervaldatum); window.factVervaldatumHandmatig?.(); ingevuld.push('vervaldatum'); }
  else window.syncFactuurVervaldatum?.();
  if (u.bedrag != null && !el('fact-bedrag').value.trim()) { zet('fact-bedrag', String(u.bedrag).replace('.', ',')); ingevuld.push('bedrag'); }
  if (u.nummer && !el('fact-nr').value.trim()) { zet('fact-nr', u.nummer); ingevuld.push('factuurnummer'); }
  if (u.relatie && !el('fact-relatie').value.trim()) { zet('fact-relatie', u.relatie.naam); zet('fact-relatie-id', u.relatie.id); ingevuld.push('relatie'); }

  let hint = ingevuld.length ? `✅ Ingevuld uit de factuur: ${ingevuld.join(', ')}. <b>Controleer alles</b> voordat je opslaat.` : 'Er kon niets zeker worden ingevuld; vul de velden zelf in.';
  const extra = [];
  if (u.bedrag == null && u.bedragen.length) {
    extra.push('Bedrag? ' + u.bedragen.map(b => `<a href="#" data-fb="${b.bedrag}">${fmt(b.bedrag)}</a>`).join(' · '));
  }
  if (!u.relatie && u.bovenaan && !el('fact-relatie').value.trim()) extra.push(`Relatie? <a href="#" data-fr="${esc(u.bovenaan)}">${esc(u.bovenaan)}</a>`);
  zetHint(hint + (extra.length ? '<br>' + extra.join(' &nbsp;|&nbsp; ') : ''));
  const h = el('fact-lees-hint');
  h.querySelectorAll('[data-fb]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); zet('fact-bedrag', a.dataset.fb.replace('.', ',')); }));
  h.querySelectorAll('[data-fr]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); zet('fact-relatie', a.dataset.fr); el('fact-relatie').dispatchEvent(new Event('input')); }));
}

// ─── Meerdere facturen achter elkaar ─────────────────────────────────────────
// Je kiest in één keer meerdere bestanden; ze komen één voor één in het venster (voorbeeld + velden),
// jij controleert en kiest "Opslaan en volgende" of "Overslaan".

export const rij = { bestanden: [], i: 0, start: false };
export function leegRij() { rij.bestanden = []; rij.i = 0; }

export function zetRijUi() {
  const n = rij.bestanden.length;
  const titel = el('fact-modal-title');
  if (n && titel) titel.textContent = `Factuur ${rij.i + 1} van ${n}`;
  const opslaan = el('fact-save-btn');
  if (opslaan) opslaan.textContent = n && rij.i < n - 1 ? 'Opslaan en volgende' : 'Opslaan';
  const skip = el('fact-skip-btn');
  if (skip) skip.style.display = n ? '' : 'none';
}

export function kiesMeerdereFacturen() {
  const i = document.createElement('input');
  i.type = 'file'; i.multiple = true; i.accept = 'image/*,application/pdf';
  i.onchange = () => {
    const lijst = [...i.files];
    if (!lijst.length) return;
    rij.bestanden = lijst; rij.i = 0;
    toonVolgende();
  };
  i.click();
}

function toonVolgende() {
  const f = rij.bestanden[rij.i];
  if (!f) { leegRij(); return; }
  rij.start = true;
  window.openFactuurModal();
  zetRijUi();
  zetBestand(f);
}

/** Na opslaan of overslaan: de volgende uit de rij openen. */
export function volgendeInRij() {
  if (!rij.bestanden.length) return;
  rij.i++;
  if (rij.i >= rij.bestanden.length) { const n = rij.bestanden.length; leegRij(); alert(`Klaar: alle ${n} bestanden zijn doorgenomen.`); return; }
  setTimeout(toonVolgende, 150);
}

export function overslaanFactuur() {
  window.sluitFactuurModal(true);
  volgendeInRij();
}
