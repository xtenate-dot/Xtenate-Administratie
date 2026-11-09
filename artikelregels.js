// artikelregels.js — inkoop- en verkoopregels per artikel: kostprijs, opbrengst en winst.
//
// Uitgangspunt: een logboek. Elke inkoop is een regel (datum, aantal, bedrag), elke verkoop of retour ook.
// Je telt dus niet met één prijs per artikel, maar de app rekent de gemiddelde kostprijs uit alle inkopen
// en zet daar de opbrengst per kanaal (Bol.com, Marktplaats, overig) naast.
// De voorraadtelling zelf (aantal stuks) wordt hier NIET door aangepast; de regels geven alleen prijzen.

import { state, saveArtikelRegels } from './storage.js?v=20261109f';
import { esc, fmt } from './helpers.js?v=20261109f';
import { lopendJaar, vandaagIso } from './jaren.js?v=20261109f';
import { leesBestellingen } from './bol.js?v=20261109f';

export const KANALEN = ['Bol.com', 'Marktplaats', 'Overig'];
const el = id => document.getElementById(id);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const getal = v => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

// ─── Gegevens ──────────────────────────────────────────────────────────────

function nieuwId(voorvoegsel) { return voorvoegsel + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const regels = () => state.ARTIKELREGELS || (state.ARTIKELREGELS = { inkopen: [], verkopen: [] });

export const inkopenVan = id => regels().inkopen.filter(r => String(r.artikelId) === String(id));
export const verkopenVan = id => regels().verkopen.filter(r => String(r.artikelId) === String(id));

/**
 * Gewogen gemiddelde inkoopprijs per stuk uit de inkoopregels MET bedrag (optioneel tot en met een datum).
 * null als er nog geen bruikbare regel is.
 */
export function gemKostprijs(artikelId, totDatum = null) {
  let n = 0, bedrag = 0;
  for (const r of inkopenVan(artikelId)) {
    if (totDatum && r.datum && r.datum > totDatum) continue;
    const a = Number(r.aantal), b = Number(r.bedrag);
    if (a > 0 && Number.isFinite(b) && b > 0) { n += a; bedrag += b; }
  }
  return n > 0 ? bedrag / n : null;
}

/** Cijfers van één artikel voor een jaar. */
export function rendementVan(c, jaar) {
  const ink = inkopenVan(c.id);
  const ver = verkopenVan(c.id).filter(r => String(r.datum || '').startsWith(String(jaar)));
  const kost = gemKostprijs(c.id, jaar + '-12-31');
  const stuks = ver.reduce((s, r) => s + (Number(r.aantal) || 0), 0);
  const opbrengst = ver.reduce((s, r) => s + (Number(r.bedrag) || 0), 0);
  const kosten = ver.reduce((s, r) => s + (Number(r.kosten) || 0), 0);
  const perKanaal = {};
  for (const k of KANALEN) perKanaal[k] = 0;
  for (const r of ver) perKanaal[KANALEN.includes(r.kanaal) ? r.kanaal : 'Overig'] += Number(r.bedrag) || 0;
  const kostprijsVerkocht = kost != null ? stuks * kost : null;
  const winst = kostprijsVerkocht != null && stuks > 0 ? opbrengst - kosten - kostprijsVerkocht : null;
  const j = c.jaren?.[jaar];
  const voorraadVerkocht = j ? (Number(j.verkocht) || 0) - (Number(j.retour) || 0) : null;
  return {
    inkoopRegels: ink.length, verkoopRegels: ver.length, kost, stuks, opbrengst, kosten, perKanaal,
    kostprijsVerkocht, winst, marge: winst != null && opbrengst ? winst / opbrengst : null,
    gemVerkoop: stuks ? opbrengst / stuks : null,
    voorraadWaarde: kost != null ? Math.max(0, Number(c.voorraad) || 0) * kost : null,
    afwijking: j && ver.length ? stuks - voorraadVerkocht : null,
    ontbreekt: ink.some(r => !(Number(r.bedrag) > 0)) || ver.some(r => !Number.isFinite(Number(r.bedrag)))
  };
}

// ─── Pagina ────────────────────────────────────────────────────────────────

let jaarKeuze = null, zoek = '', alleenMetRegels = false;

export function zetRendementJaar(j) { jaarKeuze = j; renderRendement(); }
export function zetRendementZoek(t) { zoek = String(t || '').toLowerCase(); renderRendement(true); }
export function zetRendementFilter(b) { alleenMetRegels = !!b; renderRendement(); }

function jarenLijst() {
  const s = new Set([lopendJaar()]);
  for (const r of regels().verkopen) if (r.datum) s.add(String(r.datum).slice(0, 4));
  for (const c of state.COVERS) for (const y of Object.keys(c.jaren || {})) s.add(y);
  return [...s].sort().reverse();
}

export function renderRendement(behoudFocus = false) {
  const doel = el('rendement-inhoud');
  if (!doel) return;
  const jaar = jaarKeuze || String(lopendJaar());
  const rij = state.COVERS.map(c => ({ c, r: rendementVan(c, jaar) }))
    .filter(({ c, r }) => (!alleenMetRegels || r.inkoopRegels || r.verkoopRegels) &&
      (!zoek || String(c.artikel).toLowerCase().includes(zoek)))
    .sort((a, b) => (b.r.verkoopRegels + b.r.inkoopRegels) - (a.r.verkoopRegels + a.r.inkoopRegels) ||
      String(a.c.artikel).localeCompare(String(b.c.artikel), 'nl'));
  const alle = state.COVERS.map(c => rendementVan(c, jaar));
  const som = f => alle.reduce((s, r) => s + (f(r) || 0), 0);
  const kpiOpbrengst = som(r => r.opbrengst), kpiWinst = som(r => r.winst), kpiWaarde = som(r => r.voorraadWaarde);
  const zonderPrijs = state.COVERS.filter(c => (Number(c.voorraad) || 0) > 0 && gemKostprijs(c.id) == null).length;
  const aantalRegels = regels().inkopen.length + regels().verkopen.length;

  const rijen = rij.map(({ c, r }) => {
    const warn = [];
    if (r.afwijking) warn.push(`Verkocht volgens regels ${r.stuks}, volgens voorraad ${r.stuks - r.afwijking}`);
    if (r.ontbreekt) warn.push('Een regel mist nog een bedrag');
    return `<tr>
      <td><strong>${esc(c.artikel)}</strong>${warn.length ? ` <span class="badge badge-amber" title="${esc(warn.join('. '))}">!</span>` : ''}
        <div class="muted" style="font-size:11px">${r.inkoopRegels} inkoop${r.inkoopRegels === 1 ? '' : 'en'} · ${r.verkoopRegels} verkoop${r.verkoopRegels === 1 ? '' : 'en'} in ${esc(jaar)}</div></td>
      <td style="text-align:right">${Number(c.voorraad) || 0}</td>
      <td style="text-align:right">${r.kost != null ? fmt(r.kost) : '<span class="muted">—</span>'}</td>
      <td style="text-align:right">${r.voorraadWaarde != null ? fmt(r.voorraadWaarde) : '<span class="muted">—</span>'}</td>
      <td style="text-align:right">${r.stuks || '<span class="muted">—</span>'}</td>
      <td style="text-align:right">${r.stuks ? fmt(r.opbrengst) : '<span class="muted">—</span>'}
        ${r.stuks ? `<div class="muted" style="font-size:11px">${KANALEN.filter(k => r.perKanaal[k]).map(k => `${k.replace('.com', '')} ${fmt(r.perKanaal[k])}`).join(' · ')}</div>` : ''}</td>
      <td style="text-align:right">${r.gemVerkoop != null ? fmt(r.gemVerkoop) : '<span class="muted">—</span>'}</td>
      <td style="text-align:right">${r.winst != null ? `<strong style="color:var(${r.winst >= 0 ? '--green-text,#0a7d33' : '--red-text,#c0392b'})">${fmt(r.winst)}</strong>${r.marge != null ? `<div class="muted" style="font-size:11px">${Math.round(r.marge * 100)}%</div>` : ''}` : '<span class="muted">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button type="button" class="btn-details" onclick="openArtikelRegels('${esc(String(c.id))}')">Regels</button></td></tr>`;
  }).join('');

  const actief = document.activeElement?.id;
  doel.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Opbrengst ${esc(jaar)}</div><div class="kpi-val">${fmt(kpiOpbrengst)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Winst ${esc(jaar)}</div><div class="kpi-val">${fmt(kpiWinst)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Voorraadwaarde (kostprijs)</div><div class="kpi-val">${fmt(kpiWaarde)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Artikelen op voorraad zonder kostprijs</div><div class="kpi-val">${zonderPrijs}</div></div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <select id="rend-jaar" onchange="zetRendementJaar(this.value)" aria-label="Jaar">${jarenLijst().map(y => `<option ${y === jaar ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select>
      <input type="search" id="rend-zoek" placeholder="Zoek artikel…" value="${esc(zoek)}" oninput="zetRendementZoek(this.value)" style="min-width:200px">
      <label style="font-size:13px"><input type="checkbox" ${alleenMetRegels ? 'checked' : ''} onchange="zetRendementFilter(this.checked)"> alleen met regels</label>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-sm btn-primary" onclick="openInkoopLijst()">Inkoop verwerken${onverwerkteInkoop(jaar) ? ` (${onverwerkteInkoop(jaar)} open)` : ''}</button>
      <button type="button" class="btn btn-sm" onclick="haalBolVerkopen()">Bol-verkopen ophalen</button>
      <button type="button" class="btn btn-sm" onclick="exporteerRendement()">Excel-uitdraai</button>
    </div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Voorraad</th><th style="text-align:right">Gem. kostprijs p/s</th>
        <th style="text-align:right">Voorraadwaarde</th><th style="text-align:right">Verkocht ${esc(jaar)}</th><th style="text-align:right">Opbrengst</th>
        <th style="text-align:right">Gem. verkoopprijs</th><th style="text-align:right">Winst</th><th></th></tr></thead>
      <tbody>${rijen || '<tr><td colspan="9" class="muted" style="padding:16px">Geen artikelen gevonden.</td></tr>'}</tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-top:10px">${aantalRegels ? '' : 'Je hebt nog geen regels. Open een artikel met "Regels" en voeg per inkoop of verkoop een regel toe; of haal je Bol-verkopen op. '}
      De gemiddelde kostprijs is het gewogen gemiddelde van alle inkoopregels met een bedrag. Winst = opbrengst − kosten van de verkoop − (stuks × gemiddelde kostprijs).
      Het aantal stuks op voorraad blijft zoals je het op de voorraadpagina bijhoudt.</p>`;
  if (behoudFocus && actief === 'rend-zoek') {
    const i = el('rend-zoek'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
}

// ─── Venster ───────────────────────────────────────────────────────────────

let sluitHuidige = null;
function toonVenster(inhoudHtml, breed = false) {
  sluitHuidige?.();
  const laag = document.createElement('div');
  laag.className = 'pm-laag'; laag.id = 'ar-venster';
  laag.innerHTML = `<div class="pm-venster" role="dialog" aria-modal="true" style="${breed ? 'max-width:900px' : 'max-width:560px'}">${inhoudHtml}</div>`;
  document.body.appendChild(laag);
  const sluit = () => { document.removeEventListener('keydown', opToets, true); laag.remove(); if (sluitHuidige === sluit) sluitHuidige = null; };
  function opToets(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); } }
  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });
  laag.querySelectorAll('[data-ar-sluit]').forEach(k => k.addEventListener('click', sluit));
  sluitHuidige = sluit;
  return { laag, sluit };
}
export const sluitArtikelVenster = () => sluitHuidige?.();

const artikelVan = id => state.COVERS.find(c => String(c.id) === String(id));

/** Overzicht van alle regels van één artikel met knoppen om toe te voegen, te wijzigen of te verwijderen. */
export function openArtikelRegels(artikelId) {
  const c = artikelVan(artikelId);
  if (!c) return;
  const ink = [...inkopenVan(c.id)].sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')));
  const ver = [...verkopenVan(c.id)].sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')));
  const kost = gemKostprijs(c.id);
  const tr = (r, soort) => `<tr>
    <td>${esc(r.datum || '—')}</td>
    <td style="text-align:right">${esc(r.aantal)}</td>
    <td style="text-align:right">${Number.isFinite(Number(r.bedrag)) && r.bedrag !== '' && r.bedrag != null ? fmt(r.bedrag) : '<span class="muted">mist</span>'}</td>
    <td style="text-align:right">${Number(r.aantal) && Number.isFinite(Number(r.bedrag)) && r.bedrag !== '' && r.bedrag != null ? fmt(r.bedrag / r.aantal) : '—'}</td>
    ${soort === 'verkoop' ? `<td>${esc(r.kanaal || '—')}</td><td style="text-align:right">${r.kosten ? fmt(r.kosten) : '—'}</td>` : ''}
    <td class="muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.omschr || '')}">${esc(r.omschr || '')}${r.txId ? ' 🔗' : ''}</td>
    <td style="text-align:right;white-space:nowrap">
      <button type="button" class="pm-mini" onclick="openRegelFormulier('${soort}','${esc(String(c.id))}','${esc(r.id)}')">Bewerk</button>
      <button type="button" class="pm-mini pm-mini-rood" onclick="verwijderRegel('${soort}','${esc(r.id)}','${esc(String(c.id))}')">Verwijder</button></td></tr>`;
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">${esc(c.artikel)}</h3>
      <div class="pm-sub">Voorraad ${Number(c.voorraad) || 0} · gem. kostprijs ${kost != null ? fmt(kost) : 'nog onbekend'}</div></div>
      <button type="button" class="pm-kruis" data-ar-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h4 style="margin:0">Inkopen</h4>
        <button type="button" class="btn btn-sm" onclick="openRegelFormulier('inkoop','${esc(String(c.id))}')">+ Inkoop</button></div>
      ${ink.length ? `<table class="pm-tabel"><thead><tr><th>Datum</th><th style="text-align:right">Aantal</th><th style="text-align:right">Totaal</th><th style="text-align:right">Per stuk</th><th>Opmerking</th><th></th></tr></thead><tbody>${ink.map(r => tr(r, 'inkoop')).join('')}</tbody></table>` : '<p class="muted" style="font-size:13px">Nog geen inkopen.</p>'}
      <div style="display:flex;justify-content:space-between;align-items:center;margin:18px 0 6px"><h4 style="margin:0">Verkopen en retouren</h4>
        <button type="button" class="btn btn-sm" onclick="openRegelFormulier('verkoop','${esc(String(c.id))}')">+ Verkoop</button></div>
      ${ver.length ? `<table class="pm-tabel"><thead><tr><th>Datum</th><th style="text-align:right">Aantal</th><th style="text-align:right">Ontvangen</th><th style="text-align:right">Per stuk</th><th>Kanaal</th><th style="text-align:right">Kosten</th><th>Opmerking</th><th></th></tr></thead><tbody>${ver.map(r => tr(r, 'verkoop')).join('')}</tbody></table>` : '<p class="muted" style="font-size:13px">Nog geen verkopen.</p>'}
    </div>`, true);
}

/** Formulier om een inkoop- of verkoopregel toe te voegen of te wijzigen. */
export function openRegelFormulier(soort, artikelId, regelId = null) {
  const c = artikelVan(artikelId);
  if (!c) return;
  const lijst = soort === 'inkoop' ? regels().inkopen : regels().verkopen;
  const r = regelId ? lijst.find(x => x.id === regelId) : null;
  const verkoop = soort === 'verkoop';
  const veld = (id, label, val, extra = '') => `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" ${extra} value="${esc(val ?? '')}"></div>`;
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">${verkoop ? 'Verkoop' : 'Inkoop'} ${r ? 'wijzigen' : 'toevoegen'}</h3><div class="pm-sub">${esc(c.artikel)}</div></div>
      <button type="button" class="pm-kruis" data-ar-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud"><div class="form-grid">
      ${veld('ar-datum', 'Datum', r?.datum || vandaagIso(), 'type="date"')}
      ${veld('ar-aantal', verkoop ? 'Aantal (retour = negatief)' : 'Aantal', r?.aantal ?? '', 'type="text" inputmode="numeric"')}
      ${veld('ar-bedrag', verkoop ? 'Totaal ontvangen (€)' : 'Totaal betaald (€, incl. btw)', r?.bedrag != null && r.bedrag !== '' ? String(r.bedrag).replace('.', ',') : '', 'type="text" inputmode="decimal" placeholder="0,00" oninput="zoekRegelBank()"')}
      ${verkoop ? `<div class="form-group"><label for="ar-kanaal">Kanaal</label><select id="ar-kanaal">${KANALEN.map(k => `<option ${r?.kanaal === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
        ${veld('ar-kosten', 'Kosten verkoop (€, optioneel: commissie, verzending)', r?.kosten ? String(r.kosten).replace('.', ',') : '', 'type="text" inputmode="decimal" placeholder="0,00"')}` : ''}
      <div class="form-group full"><label for="ar-omschr">Opmerking (bijv. leverancier, bestelnummer)</label><input id="ar-omschr" value="${esc(r?.omschr || '')}"></div>
      <div class="form-group full"><label>Gekoppelde bankboeking (optioneel)</label>
        <input type="hidden" id="ar-tx" value="${esc(r?.txId || '')}">
        <div id="ar-bank" class="muted" style="font-size:12.5px">${r?.txId ? 'Gekoppeld aan een bankboeking.' : 'Vul een bedrag in; boekingen met hetzelfde bedrag verschijnen hier.'}</div></div>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Een regel zonder bedrag telt wel voor het aantal, maar niet voor de kostprijs.</p></div>
    <div class="pm-voet"><button type="button" class="btn" data-ar-sluit>Annuleren</button>
      <button type="button" class="btn btn-primary" onclick="bewaarRegel('${soort}','${esc(String(c.id))}','${esc(regelId || '')}')">Opslaan</button></div>`);
  window.__arSoort = soort;
  setTimeout(() => (el('ar-aantal') || {}).focus?.(), 30);
  if (r?.bedrag) zoekRegelBank();
}

/** Toont bankboekingen met hetzelfde bedrag om aan de regel te koppelen. */
export function zoekRegelBank() {
  const doel = el('ar-bank');
  if (!doel) return;
  const b = Math.abs(getal(el('ar-bedrag')?.value));
  const huidig = el('ar-tx')?.value || '';
  if (!(b > 0)) return;
  const soort = window.__arSoort === 'verkoop' ? 'inkomst' : 'uitgave';
  const kandidaten = [...state.HIST_TX, ...state.TX]
    .filter(t => t.type === soort && Math.abs(Number(t.bedrag) - b) < 0.005)
    .sort((x, y) => String(y.datum).localeCompare(String(x.datum))).slice(0, 6);
  if (!kandidaten.length) { doel.innerHTML = 'Geen bankboeking met precies dit bedrag gevonden.'; return; }
  doel.innerHTML = kandidaten.map(t => `<label style="display:block"><input type="radio" name="ar-txkeuze" ${String(t.id) === huidig ? 'checked' : ''} onchange="document.getElementById('ar-tx').value='${esc(String(t.id))}'"> ${esc(t.datum)} · ${esc(t.naam || '—')} · ${fmt(t.bedrag)}</label>`).join('') +
    `<label style="display:block"><input type="radio" name="ar-txkeuze" ${huidig ? '' : 'checked'} onchange="document.getElementById('ar-tx').value=''"> geen koppeling</label>`;
}

export function bewaarRegel(soort, artikelId, regelId) {
  const aantal = getal(el('ar-aantal')?.value);
  const datum = el('ar-datum')?.value;
  const bedragTekst = String(el('ar-bedrag')?.value || '').trim();
  const bedrag = bedragTekst === '' ? null : getal(bedragTekst);
  if (!datum) { alert('Vul een datum in.'); return; }
  if (!Number.isFinite(aantal) || aantal === 0 || !Number.isInteger(aantal)) { alert('Vul een aantal in (een heel getal, niet 0).'); return; }
  if (soort === 'inkoop' && aantal < 0) { alert('Een inkoop moet een positief aantal hebben.'); return; }
  if (bedragTekst !== '' && !Number.isFinite(bedrag)) { alert('Het bedrag is geen geldig getal.'); return; }
  const nieuw = {
    id: regelId || nieuwId(soort === 'inkoop' ? 'i' : 'v'), artikelId, datum, aantal,
    bedrag: bedrag == null ? null : r2(bedrag),
    omschr: String(el('ar-omschr')?.value || '').trim(),
    txId: el('ar-tx')?.value || ''
  };
  if (soort === 'verkoop') {
    nieuw.kanaal = el('ar-kanaal')?.value || 'Overig';
    const k = getal(el('ar-kosten')?.value);
    nieuw.kosten = Number.isFinite(k) ? r2(k) : 0;
    if (aantal < 0 && bedrag != null && bedrag > 0) nieuw.bedrag = -Math.abs(nieuw.bedrag);   // retour: bedrag ook negatief
  }
  const lijst = soort === 'inkoop' ? regels().inkopen : regels().verkopen;
  const i = lijst.findIndex(x => x.id === nieuw.id);
  if (i >= 0) lijst[i] = { ...lijst[i], ...nieuw }; else lijst.push(nieuw);
  saveArtikelRegels();
  openArtikelRegels(artikelId);
  renderRendement();
}

export function verwijderRegel(soort, regelId, artikelId) {
  if (!confirm('Deze regel verwijderen?')) return;
  const sleutel = soort === 'inkoop' ? 'inkopen' : 'verkopen';
  regels()[sleutel] = regels()[sleutel].filter(r => r.id !== regelId);
  saveArtikelRegels();
  openArtikelRegels(artikelId);
  renderRendement();
}

// ─── Bol-verkopen ophalen ──────────────────────────────────────────────────

const eansVan = c => (Array.isArray(c.ean) ? c.ean : c.ean ? [c.ean] : []).map(String);

/** Zet Bol-bestellingen om in verkoopregels voor artikelen waaraan een EAN is gekoppeld. Geeft geen dubbelen. */
export function bolRegelsUit(bestellingen, covers, bestaand) {
  const perEan = new Map();
  for (const c of covers) for (const e of eansVan(c)) perEan.set(e, c);
  const heeft = new Set(bestaand.map(r => r.bolId).filter(Boolean));
  const nieuw = [], onbekend = new Set();
  for (const o of bestellingen || []) {
    for (const it of o.items || []) {
      const n = Math.max(0, (Number(it.aantal) || 0) - (Number(it.geannuleerd) || 0));
      if (!n) continue;
      const bolId = `${o.account || ''}:${o.order_id}:${it.id || it.ean}`;
      if (heeft.has(bolId)) continue;
      const c = perEan.get(String(it.ean || '').trim());
      if (!c) { if (it.ean) onbekend.add(`${it.titel || it.ean}`); continue; }
      if (!(Number(it.prijs) > 0)) continue;
      nieuw.push({
        id: nieuwId('v'), bolId, artikelId: c.id, datum: String(o.datum || o.besteld || '').slice(0, 10), aantal: n,
        bedrag: r2(Number(it.prijs) * n), kanaal: 'Bol.com', kosten: r2((Number(it.commissie) || 0)),
        omschr: `Bol bestelling ${o.order_id}`, txId: ''
      });
    }
  }
  return { nieuw: nieuw.filter(r => r.datum), onbekend: [...onbekend] };
}

export async function haalBolVerkopen() {
  let bestellingen;
  try { bestellingen = await leesBestellingen(); } catch (e) { alert('Bol-bestellingen ophalen is mislukt: ' + e.message); return; }
  const { nieuw, onbekend } = bolRegelsUit(bestellingen, state.COVERS, regels().verkopen);
  const naam = id => artikelVan(id)?.artikel || id;
  const perArtikel = new Map();
  for (const r of nieuw) { const p = perArtikel.get(r.artikelId) || { n: 0, b: 0 }; p.n += r.aantal; p.b += r.bedrag; perArtikel.set(r.artikelId, p); }
  const totaal = nieuw.reduce((s, r) => s + r.bedrag, 0);
  const { laag, sluit } = toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">Bol-verkopen ophalen</h3>
      <div class="pm-sub">Alleen artikelen met een gekoppelde EAN (zie Bol.com › Verkocht per artikel)</div></div>
      <button type="button" class="pm-kruis" data-ar-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud">
      ${nieuw.length ? `<p>${nieuw.length} nieuwe verkoopregels, samen ${fmt(totaal)} ontvangen (prijs per stuk zoals Bol die geeft, inclusief btw; commissie als kosten).</p>
      <table class="pm-tabel"><thead><tr><th>Artikel</th><th style="text-align:right">Stuks</th><th style="text-align:right">Bedrag</th></tr></thead><tbody>
      ${[...perArtikel].map(([id, p]) => `<tr><td>${esc(naam(id))}</td><td style="text-align:right">${p.n}</td><td style="text-align:right">${fmt(p.b)}</td></tr>`).join('')}</tbody></table>
      <p class="muted" style="font-size:12px;margin-top:10px">Heb je Bol-verkopen al met de hand ingevoerd, dan komen die dubbel te staan. Controleer dat eerst. Er wordt hier niets aan de voorraadtelling veranderd.</p>`
      : '<p>Geen nieuwe Bol-verkopen om toe te voegen.</p>'}
      ${onbekend.length ? `<p class="muted" style="font-size:12px">${onbekend.length} Bol-artikel${onbekend.length === 1 ? '' : 'en'} zonder gekoppeld artikel (overgeslagen): ${esc(onbekend.slice(0, 5).join(', '))}${onbekend.length > 5 ? '…' : ''}</p>` : ''}
    </div>
    <div class="pm-voet"><button type="button" class="btn" data-ar-sluit>Sluiten</button>
      ${nieuw.length ? '<button type="button" class="btn btn-primary" id="ar-bol-ok">Toevoegen</button>' : ''}</div>`, true);
  laag.querySelector('#ar-bol-ok')?.addEventListener('click', () => {
    regels().verkopen.push(...nieuw);
    saveArtikelRegels();
    sluit();
    renderRendement();
  });
}

// ─── Excel-uitdraai ────────────────────────────────────────────────────────

export function exporteerRendement() {
  if (typeof XLSX === 'undefined') { alert('De Excel-bibliotheek is niet geladen. Probeer het zo nog eens.'); return; }
  const jaar = jaarKeuze || String(lopendJaar());
  const naam = id => artikelVan(id)?.artikel || String(id);
  const kop = ['Artikel', 'Categorie', 'Voorraad', 'Gem. kostprijs p/s', 'Voorraadwaarde', 'Verkocht ' + jaar, 'Opbrengst', ...KANALEN.map(k => 'waarvan ' + k), 'Gem. verkoopprijs', 'Kosten verkoop', 'Kostprijs verkocht', 'Winst', 'Marge'];
  const a = [kop];
  for (const c of state.COVERS) {
    const r = rendementVan(c, jaar);
    if (!r.inkoopRegels && !r.verkoopRegels && !(Number(c.voorraad) > 0)) continue;
    a.push([c.artikel, c.categorie || '', Number(c.voorraad) || 0, r.kost != null ? r2(r.kost) : '', r.voorraadWaarde != null ? r2(r.voorraadWaarde) : '',
      r.stuks, r2(r.opbrengst), ...KANALEN.map(k => r2(r.perKanaal[k])), r.gemVerkoop != null ? r2(r.gemVerkoop) : '', r2(r.kosten),
      r.kostprijsVerkocht != null ? r2(r.kostprijsVerkocht) : '', r.winst != null ? r2(r.winst) : '', r.marge != null ? Math.round(r.marge * 1000) / 1000 : '']);
  }
  const ink = [['Datum', 'Artikel', 'Aantal', 'Totaalbedrag', 'Per stuk', 'Opmerking']]
    .concat([...regels().inkopen].sort((x, y) => String(x.datum).localeCompare(String(y.datum))).map(r => [r.datum, naam(r.artikelId), r.aantal, r.bedrag ?? '', r.bedrag != null && r.aantal ? r2(r.bedrag / r.aantal) : '', r.omschr || '']));
  const ver = [['Datum', 'Artikel', 'Aantal', 'Ontvangen', 'Per stuk', 'Kanaal', 'Kosten', 'Opmerking']]
    .concat([...regels().verkopen].sort((x, y) => String(x.datum).localeCompare(String(y.datum))).map(r => [r.datum, naam(r.artikelId), r.aantal, r.bedrag ?? '', r.bedrag != null && r.aantal ? r2(r.bedrag / r.aantal) : '', r.kanaal || '', r.kosten || 0, r.omschr || '']));
  const wb = XLSX.utils.book_new();
  const blad = (rijen, breed) => { const ws = XLSX.utils.aoa_to_sheet(rijen); ws['!cols'] = breed.map(w => ({ wch: w })); return ws; };
  XLSX.utils.book_append_sheet(wb, blad(a, [30, 16, 9, 12, 12, 10, 11, 11, 11, 11, 12, 11, 12, 11, 8]), 'Rendement ' + jaar);
  XLSX.utils.book_append_sheet(wb, blad(ink, [12, 30, 8, 13, 10, 40]), 'Inkopen');
  XLSX.utils.book_append_sheet(wb, blad(ver, [12, 30, 8, 12, 10, 12, 10, 40]), 'Verkopen');
  XLSX.writeFile(wb, `Voorraad-rendement-${jaar}.xlsx`);
}


// ─── Inkoop verwerken vanuit een bankbetaling ──────────────────────────────
// Je kiest bij een betaling welke artikelen erin zaten en hoeveel. Uit het bedrag volgt de prijs per
// stuk; die gaat mee in de gemiddelde kostprijs. Bij verkoop telt de aangifte dan automatisch die kostprijs.

const INKOOP_GB = '7000';
const inkoopBetaling = t => String(t.gb) === INKOOP_GB && t.type === 'uitgave';
export const inkoopBetalingen = () => [...state.HIST_TX, ...state.TX].filter(inkoopBetaling)
  .sort((a, b) => String(b.datum).localeCompare(String(a.datum)));
const regelsVanTx = txId => regels().inkopen.filter(r => String(r.txId) === String(txId));

/** Aantal inkoopbetalingen van het gegeven jaar waar nog geen artikelen aan gekoppeld zijn. */
export function onverwerkteInkoop(jaar = String(lopendJaar())) {
  return inkoopBetalingen().filter(t => String(t.datum).startsWith(String(jaar)) && !regelsVanTx(t.id).length).length;
}

let ivTx = null, ivRijen = [];
const ivOpties = sel => [...state.COVERS].sort((a, b) => String(a.artikel).localeCompare(String(b.artikel), 'nl'))
  .map(c => `<option value="${esc(String(c.id))}"${String(c.id) === String(sel) ? ' selected' : ''}>${esc(c.artikel)}</option>`).join('');

function ivRijenHtml() {
  return ivRijen.map((r, i) => `<tr>
    <td><select id="iv-a-${i}" onchange="ivKies(${i})" style="max-width:240px"><option value="">— kies artikel —</option>${ivOpties(r.artikelId)}</select>
      <div class="muted" id="iv-h-${i}" style="font-size:11px"></div></td>
    <td><input id="iv-n-${i}" value="${esc(r.aantal ?? '')}" inputmode="numeric" oninput="ivRekenen()" style="width:64px;text-align:right" aria-label="Aantal"></td>
    <td><input id="iv-p-${i}" value="${esc(r.prijs ?? '')}" inputmode="decimal" placeholder="automatisch" oninput="ivRekenen()" style="width:96px;text-align:right" aria-label="Prijs per stuk"></td>
    <td style="text-align:right" id="iv-b-${i}">—</td><td style="text-align:right" id="iv-s-${i}">—</td>
    <td>${ivRijen.length > 1 ? `<button type="button" class="pm-mini pm-mini-rood" onclick="ivVerwijderRij(${i})" aria-label="Regel weg">×</button>` : ''}</td></tr>`).join('');
}

function ivLees() {
  ivRijen = ivRijen.map((_, i) => ({ artikelId: el(`iv-a-${i}`)?.value || '', aantal: el(`iv-n-${i}`)?.value ?? '', prijs: el(`iv-p-${i}`)?.value ?? '' }));
}

/** Rekent de verdeling door: vaste prijzen eerst, het restbedrag gelijk per stuk over de rest. */
function ivBereken() {
  const totaal = Number(ivTx.bedrag) || 0;
  const rijen = ivRijen.map(r => ({ ...r, n: getal(r.aantal), p: String(r.prijs).trim() === '' ? null : getal(r.prijs) }));
  const geldig = r => r.artikelId && Number.isInteger(r.n) && r.n > 0;
  const vast = rijen.filter(r => geldig(r) && r.p != null && Number.isFinite(r.p) && r.p > 0);
  const rest = rijen.filter(r => geldig(r) && !vast.includes(r));
  const vastBedrag = vast.reduce((s, r) => s + r.p * r.n, 0);
  const restStuks = rest.reduce((s, r) => s + r.n, 0);
  const restBedrag = totaal - vastBedrag;
  vast.forEach(r => { r.bedrag = r2(r.p * r.n); });
  let verdeeld = 0;
  rest.forEach((r, k) => {
    r.bedrag = k === rest.length - 1 ? r2(restBedrag - verdeeld) : r2(restBedrag * r.n / Math.max(1, restStuks));
    verdeeld += r.bedrag;
  });
  const som = r2(rijen.reduce((s, r) => s + (geldig(r) ? (r.bedrag || 0) : 0), 0));
  return { rijen, geldig, som, verschil: r2(totaal - som), restNegatief: rest.length > 0 && restBedrag < -0.005, heeftRest: rest.length > 0 };
}

/** Stuks die dit jaar volgens de voorraad zijn ingekocht en nog aan geen enkele betaling hangen. */
function ivNogTeVerdelen(artikelId) {
  const c = artikelVan(artikelId);
  if (!c) return null;
  const jaar = String(ivTx.datum).slice(0, 4);
  const ingekocht = Number(c.jaren?.[jaar]?.inkoop);
  if (!Number.isFinite(ingekocht)) return null;
  const verwerkt = regels().inkopen
    .filter(r => String(r.artikelId) === String(artikelId) && String(r.datum).startsWith(jaar) && String(r.txId) !== String(ivTx.id))
    .reduce((s, r) => s + (Number(r.aantal) || 0), 0);
  return { ingekocht, open: Math.max(0, ingekocht - verwerkt) };
}

/** Artikel gekozen: het aantal wordt alvast ingevuld met wat er volgens je voorraad nog te verdelen is. */
export function ivKies(i) {
  const a = el(`iv-a-${i}`)?.value, n = el(`iv-n-${i}`);
  const t = a ? ivNogTeVerdelen(a) : null;
  if (n && t && String(n.value).trim() === '' && t.open > 0) n.value = String(t.open);
  ivRekenen();
}

export function ivRekenen() {
  ivLees();
  ivRijen.forEach((r, i) => {
    const t = r.artikelId ? ivNogTeVerdelen(r.artikelId) : null;
    const h = el(`iv-h-${i}`);
    if (h) h.textContent = t ? `voorraad: ${t.ingekocht} ingekocht dit jaar, nog te verdelen ${t.open}` : '';
  });
  const b = ivBereken();
  b.rijen.forEach((r, i) => {
    const ok = b.geldig(r) && Number.isFinite(r.bedrag);
    if (el(`iv-b-${i}`)) el(`iv-b-${i}`).textContent = ok ? fmt(r.bedrag) : '—';
    if (el(`iv-s-${i}`)) el(`iv-s-${i}`).textContent = ok ? fmt(r.bedrag / r.n) : '—';
  });
  const doel = el('iv-samen');
  if (doel) {
    const stuks = b.rijen.filter(b.geldig).reduce((s, r) => s + r.n, 0);
    doel.innerHTML = `${stuks} stuks · verdeeld ${fmt(b.som)} van ${fmt(ivTx.bedrag)}` +
      (b.restNegatief ? ` <span style="color:var(--red-text,#c0392b)">· de vaste prijzen zijn samen hoger dan de betaling</span>`
        : Math.abs(b.verschil) > 0.005 ? ` <span style="color:var(--amber-text,#b7791f)">· ${fmt(Math.abs(b.verschil))} ${b.verschil > 0 ? 'niet verdeeld' : 'te veel'}</span>` : ' <span style="color:var(--green-text,#0a7d33)">· klopt</span>');
  }
}

export function ivRijToevoegen() { ivLees(); ivRijen.push({ artikelId: '', aantal: '', prijs: '' }); const t = el('iv-rijen'); if (t) t.innerHTML = ivRijenHtml(); ivRekenen(); }
export function ivVerwijderRij(i) { ivLees(); ivRijen.splice(i, 1); const t = el('iv-rijen'); if (t) t.innerHTML = ivRijenHtml(); ivRekenen(); }

/** Venster om bij één bankbetaling artikelen en aantallen in te vullen. */
export function openInkoopVerwerken(txId) {
  const t = [...state.HIST_TX, ...state.TX].find(x => String(x.id) === String(txId));
  if (!t) return;
  ivTx = t;
  const bestaand = regelsVanTx(t.id);
  ivRijen = bestaand.length
    ? bestaand.map(r => ({ artikelId: String(r.artikelId), aantal: String(r.aantal), prijs: '' }))
    : [{ artikelId: '', aantal: '', prijs: '' }];
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">Inkoop verwerken</h3>
      <div class="pm-sub">${esc(t.datum)} · ${esc(t.naam || '—')} · <b>${fmt(t.bedrag)}</b>${t.omschr ? ' · ' + esc(String(t.omschr).slice(0, 50)) : ''}</div></div>
      <button type="button" class="pm-kruis" data-ar-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud">
      <p class="muted" style="font-size:13px;margin:0 0 10px">Welke artikelen zaten in deze betaling en hoeveel stuks? Laat de prijs leeg: dan wordt het bedrag gelijk over de stuks verdeeld. Weet je de prijs van een artikel wel, vul die dan in; de rest wordt verdeeld over wat overblijft.</p>
      <table class="pm-tabel"><thead><tr><th>Artikel</th><th style="text-align:right">Aantal</th><th style="text-align:right">Prijs p/s</th><th style="text-align:right">Bedrag</th><th style="text-align:right">Per stuk</th><th></th></tr></thead>
        <tbody id="iv-rijen">${ivRijenHtml()}</tbody></table>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
        <button type="button" class="btn btn-sm" onclick="ivRijToevoegen()">+ Artikel</button>
        <div id="iv-samen" style="font-size:13px"></div></div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Dit past je voorraadaantallen niet aan; die houd je zelf bij. Het bepaalt alleen wat een stuk gekost heeft, en dus wat bij verkoop als kosten telt.</p>
    </div>
    <div class="pm-voet"><button type="button" class="btn" data-ar-sluit>Annuleren</button>
      ${bestaand.length ? '<button type="button" class="btn" style="margin-right:auto" onclick="ivVerwijderAlles()">Koppeling weghalen</button>' : ''}
      <button type="button" class="btn btn-primary" onclick="ivBewaar()">Opslaan</button></div>`, true);
  ivRekenen();
}

function naInkoopWijziging() {
  saveArtikelRegels();
  sluitHuidige?.();
  renderRendement();
  window.hertekenHuidigePagina?.();
}

export function ivVerwijderAlles() {
  if (!ivTx || !confirm('De artikelen bij deze betaling weghalen?')) return;
  regels().inkopen = regels().inkopen.filter(r => String(r.txId) !== String(ivTx.id));
  naInkoopWijziging();
}

export function ivBewaar() {
  if (!ivTx) return;
  ivLees();
  const b = ivBereken();
  const goed = b.rijen.filter(b.geldig);
  if (!goed.length) { alert('Kies minstens één artikel met een aantal (een heel getal boven 0).'); return; }
  if (b.rijen.some(r => (r.artikelId || String(r.aantal).trim() !== '') && !b.geldig(r))) { alert('Een regel is niet compleet: kies een artikel en vul een heel aantal in, of haal de regel weg.'); return; }
  if (b.restNegatief) { alert('De vaste prijzen zijn samen hoger dan het bedrag van de betaling. Pas een prijs of aantal aan.'); return; }
  if (!b.heeftRest && Math.abs(b.verschil) > 0.005 && !confirm(`De regels komen samen op ${fmt(b.som)}, de betaling is ${fmt(ivTx.bedrag)}. Toch opslaan?`)) return;
  regels().inkopen = regels().inkopen.filter(r => String(r.txId) !== String(ivTx.id));
  for (const r of goed) {
    regels().inkopen.push({ id: nieuwId('i'), artikelId: r.artikelId, datum: ivTx.datum, aantal: r.n, bedrag: r2(r.bedrag),
      omschr: String(ivTx.naam || '').slice(0, 60), txId: String(ivTx.id) });
  }
  naInkoopWijziging();
}

/** Overzicht van de inkoopbetalingen van een jaar: wat is al verwerkt en wat nog niet. */
let ilJaar = null, ilAlleenOpen = true;
export function zetInkoopLijst(jaar, open) { if (jaar != null) ilJaar = jaar; if (open != null) ilAlleenOpen = !!open; openInkoopLijst(); }
export function openInkoopLijst() {
  const jaar = ilJaar || String(state.huidigJaar || lopendJaar());
  const alle = inkoopBetalingen();
  const jaren = [...new Set([...alle.map(t => String(t.datum).slice(0, 4)), jaar])].sort().reverse();
  const van = alle.filter(t => String(t.datum).startsWith(jaar));
  const open = van.filter(t => !regelsVanTx(t.id).length);
  const toon = ilAlleenOpen ? open : van;
  const naam = id => artikelVan(id)?.artikel || id;
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">Inkoop verwerken</h3>
      <div class="pm-sub">${open.length} van ${van.length} betalingen in ${esc(jaar)} nog zonder artikelen · ${fmt(open.reduce((s, t) => s + (Number(t.bedrag) || 0), 0))}</div></div>
      <button type="button" class="pm-kruis" data-ar-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
        <select onchange="zetInkoopLijst(this.value)" aria-label="Jaar">${jaren.map(y => `<option${y === jaar ? ' selected' : ''}>${esc(y)}</option>`).join('')}</select>
        <label style="font-size:13px"><input type="checkbox" ${ilAlleenOpen ? 'checked' : ''} onchange="zetInkoopLijst(null,this.checked)"> alleen nog te verwerken</label></div>
      <table class="pm-tabel"><thead><tr><th>Datum</th><th>Leverancier</th><th style="text-align:right">Bedrag</th><th>Artikelen</th><th></th></tr></thead><tbody>
      ${toon.map(t => { const rg = regelsVanTx(t.id); return `<tr><td>${esc(String(t.datum).slice(8, 10) + '-' + String(t.datum).slice(5, 7))}</td>
        <td>${esc(t.naam || '—')}<div class="muted" style="font-size:11px">${esc(String(t.omschr || '').slice(0, 40))}</div></td>
        <td style="text-align:right">${fmt(t.bedrag)}</td>
        <td style="font-size:12px">${rg.length ? esc(rg.map(r => `${r.aantal}× ${naam(r.artikelId)}`).join(', ')) : '<span class="muted">nog niet verwerkt</span>'}</td>
        <td style="text-align:right"><button type="button" class="btn-details" onclick="openInkoopVerwerken('${esc(String(t.id))}')">${rg.length ? 'Wijzig' : 'Verwerk'}</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted" style="padding:14px">Alles is verwerkt.</td></tr>'}
      </tbody></table></div>`, true);
}
