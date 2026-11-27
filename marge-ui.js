// marge-ui.js — de pagina Marge: wat houd je per verkoop over, per artikel en kanaal.
//
// Los van de voorraad en de boekhouding. Alles wat je hier invult staat apart
// opgeslagen (app_data "marge"), zodat een wijziging van een inkoopprijs
// nergens anders cijfers verandert.

import { esc, fmt } from './helpers.js?v=20261127c';
import {
  KANALEN, GEEN_VERZENDING, leesMarge, alleUitkomsten, samenvatting, productiekosten,
  zetKosten, zetKostenRij, voegKostenRijToe, verwijderKostenRij,
  zetProduct, voegProductToe, verwijderProduct, zetRegel, voegRegelToe, verwijderRegel, nr
} from './marge.js?v=20261127c';

const el = id => document.getElementById(id);
const pct = x => (x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + '%';
const getal = v => v === null || v === undefined || v === '' ? '' : String(v).replace('.', ',');

const OORDEEL_BADGE = { Verlies: 'badge-red', Krap: 'badge-amber', Redelijk: 'badge-blue', Goed: 'badge-green' };
const OORDEEL_TINT = { Verlies: 'verlies', Krap: 'krap', Redelijk: 'redelijk', Goed: 'goed' };

const badge = o => o === '—' ? '<span class="muted">—</span>' : `<span class="badge ${OORDEEL_BADGE[o] || 'badge-gray'}">${esc(o)}</span>`;
const regelNaam = (p, r) => esc(p.naam) + (r.variant ? ` <span class="muted">· ${esc(r.variant)}</span>` : '');

function margeBalk(u) {
  if (!(u.prijs > 0)) return '<span class="muted">—</span>';
  const breed = Math.max(0, Math.min(100, u.marge / 0.5 * 100));
  return `<div class="mg-balk" title="Marge ${pct(u.marge)} van de verkoopprijs">
    <div class="mg-balk-spoor"><div class="mg-balk-vul mg-${OORDEEL_TINT[u.oordeel] || 'krap'}" style="width:${breed}%"></div></div>
    <span class="mg-balk-pct">${pct(u.marge)}</span></div>`;
}

// ---------- Bovenste blokken ----------

function kpiHtml(uit) {
  const s = samenvatting(uit);
  if (!s) return '<div class="leeg">Vul bij een artikel een verkoopprijs in om de marge te zien.</div>';
  const naam = x => `${esc(x.product.naam)}${x.regel.variant ? ' · ' + esc(x.regel.variant) : ''} · ${esc(KANALEN[x.regel.kanaal]?.kort || '')}`;
  const aandacht = s.verlies + s.krap;
  return `<div class="kpi-grid">
    <div class="kpi kpi--primair"><div class="kpi-lbl">Gemiddelde marge</div><div class="kpi-val">${pct(s.gemiddeld)}</div>
      <div class="kpi-sub">over ${s.aantal} combinaties van artikel en kanaal</div></div>
    <div class="kpi"><div class="kpi-lbl">Hoogste winst per verkoop</div><div class="kpi-val">${fmt(s.hoogsteWinst.u.winst)}</div>
      <div class="kpi-sub">${naam(s.hoogsteWinst)}</div></div>
    <div class="kpi"><div class="kpi-lbl">Laagste marge</div><div class="kpi-val">${pct(s.laagste.u.marge)}</div>
      <div class="kpi-sub">${naam(s.laagste)}</div></div>
    <div class="kpi"><div class="kpi-lbl">Aandacht nodig</div><div class="kpi-val">${aandacht}</div>
      <div class="kpi-sub">${s.verlies ? s.verlies + ' met verlies, ' : ''}${s.krap} onder 20% marge</div></div>
  </div>`;
}

function uitleg(u) {
  const delen = [
    ['Inkoop of productie', u.inkoop], ['Kanaalkosten', u.kanaalKosten], ['Verzending', u.verzend],
    ['Verpakking', u.verpakking], ["Extra's", u.extras], ['Rit naar PostNL', u.rit], ['Retourreservering', u.retour]
  ].filter(([, b]) => Math.abs(b) > 0.0000001);
  return delen.map(([n, b]) => `<span class="mg-deel"><span class="muted">${n}</span> <b>${fmt(b)}</b></span>`).join('')
    + (u.waarschuwing ? `<div class="mg-let-op">Let op: ${esc(u.waarschuwing)}</div>` : '');
}

function overzichtHtml(alle) {
  const uit = alle.filter(x => x.u.prijs > 0);   // een regel zonder verkoopprijs doet nog niet mee
  if (!uit.length) return '<div class="leeg">Nog geen verkoopprijzen. Vul hieronder bij een artikel een verkoopprijs in.</div>';
  const rijen = uit.map(({ product, regel, u }) => `
    <tr class="row-click mg-rij" onclick="margeKlap('${esc(regel.id)}')" title="Klik voor de opbouw van de kosten">
      <td data-label="Artikel">${regelNaam(product, regel)}${u.waarschuwing ? ' <span class="mg-waarschuw" title="' + esc(u.waarschuwing) + '">!</span>' : ''}</td>
      <td data-label="Kanaal">${esc(KANALEN[regel.kanaal]?.naam || regel.kanaal)}</td>
      <td style="text-align:right" data-label="Verkoopprijs">${fmt(u.prijs)}</td>
      <td style="text-align:right" data-label="Totale kosten">${fmt(u.totaal)}</td>
      <td style="text-align:right;font-weight:600" data-label="Winst">${fmt(u.winst)}</td>
      <td style="text-align:right" data-label="Per stuk">${nr(product.stuks) > 1 ? fmt(u.winstPerStuk) : '<span class="muted">—</span>'}</td>
      <td data-label="Marge">${margeBalk(u)}</td>
      <td data-label="Oordeel">${badge(u.oordeel)}</td>
    </tr>
    <tr class="mg-uitleg" id="mg-uitleg-${esc(regel.id)}" hidden><td colspan="8"><div class="mg-delen">${uitleg(u)}</div></td></tr>`).join('');
  return `<div class="table-wrap"><table class="tbl-compact" id="tbl-marge"><thead><tr>
      <th>Artikel</th><th>Kanaal</th><th style="text-align:right">Verkoopprijs</th><th style="text-align:right">Totale kosten</th>
      <th style="text-align:right">Winst</th><th style="text-align:right">Per stuk</th><th>Marge</th><th>Oordeel</th>
    </tr></thead><tbody>${rijen}</tbody></table></div>`;
}

// ---------- Invoervelden ----------

/** Eén invoerveld. soort: txt | num | opt (leeg = niet ingevuld) */
function veld({ a, p = '', r = '', k = '', soort = 'num', waarde, breed = 80, placeholder = '', her = false, ariaLabel = '' }) {
  return `<input type="text" class="mg-inp" ${soort !== 'txt' ? 'inputmode="decimal"' : ''} style="width:${breed}px"
    value="${esc(soort === 'txt' ? waarde : getal(waarde))}" placeholder="${esc(placeholder)}"
    data-a="${a}" data-p="${esc(p)}" data-r="${esc(r)}" data-k="${esc(k)}" data-s="${soort}"${her ? ' data-her="1"' : ''}
    aria-label="${esc(ariaLabel)}" onchange="margeVeld(this)">`;
}
function keuze({ a, p = '', r = '', k = '', opties, waarde, breed = 170, ariaLabel = '' }) {
  const lijst = opties.map(o => (typeof o === 'string' ? { w: o, t: o } : o));
  if (!lijst.some(o => o.w === waarde)) lijst.unshift({ w: waarde, t: `${waarde || '(leeg)'} (bestaat niet meer)` });
  return `<select class="mg-inp" style="width:${breed}px" data-a="${a}" data-p="${esc(p)}" data-r="${esc(r)}" data-k="${esc(k)}" data-s="txt" data-her="1"
    aria-label="${esc(ariaLabel)}" onchange="margeVeld(this)">${lijst.map(o => `<option value="${esc(o.w)}"${o.w === waarde ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
}

function regelRij(kosten, p, r) {
  const kanaalSoort = KANALEN[r.kanaal]?.soort;
  return `<tr>
    <td>${veld({ a: 'regel', p: p.id, r: r.id, k: 'variant', soort: 'txt', waarde: r.variant, breed: 120, placeholder: 'Variant (optioneel)', ariaLabel: 'Variant' })}</td>
    <td>${keuze({ a: 'regel', p: p.id, r: r.id, k: 'kanaal', opties: Object.entries(KANALEN).map(([w, k]) => ({ w, t: k.naam })), waarde: r.kanaal, breed: 170, ariaLabel: 'Kanaal' })}</td>
    <td>${keuze({ a: 'regel', p: p.id, r: r.id, k: 'verzending', opties: [{ w: 'zelf', t: 'Zelf versturen' }, { w: 'leverancier', t: 'Direct van leverancier' }], waarde: r.verzending, breed: 160, ariaLabel: 'Verzending' })}</td>
    <td>${veld({ a: 'regel', p: p.id, r: r.id, k: 'prijs', waarde: r.prijs, breed: 74, ariaLabel: 'Verkoopprijs' })}</td>
    <td>${veld({ a: 'regel', p: p.id, r: r.id, k: 'inkoop', soort: 'opt', waarde: r.inkoop, breed: 74, placeholder: nr(p.gram) || nr(p.uur) ? 'productie' : '0', ariaLabel: 'Inkoop of productiekosten' })}</td>
    <td>${veld({ a: 'regel', p: p.id, r: r.id, k: 'kosten', waarde: r.kosten, breed: 74, ariaLabel: kanaalSoort === 'bol' ? 'Commissie excl. btw' : 'Kanaalkosten' })}</td>
    <td style="text-align:right;font-weight:600" id="mg-w-${esc(r.id)}"></td>
    <td id="mg-m-${esc(r.id)}"></td>
    <td style="text-align:right"><button type="button" class="btn-details" onclick="margeVerwijderRegel('${esc(p.id)}','${esc(r.id)}')" title="Verwijder deze regel">&times;</button></td>
  </tr>`;
}

function productHtml(kosten, p) {
  const prod = productiekosten(kosten, p);
  return `<div class="card mg-product" id="mg-p-${esc(p.id)}">
    <div class="mg-product-kop">
      ${veld({ a: 'prod', p: p.id, k: 'naam', soort: 'txt', waarde: p.naam, breed: 260, ariaLabel: 'Naam artikel', her: true })}
      <button type="button" class="btn-details" onclick="margeVerwijderProduct('${esc(p.id)}')">Verwijder artikel</button>
    </div>
    <div class="mg-velden">
      <label>Stuks per verkoop ${veld({ a: 'prod', p: p.id, k: 'stuks', waarde: p.stuks, breed: 64, ariaLabel: 'Stuks per verkoop' })}</label>
      <label>Verpakking ${keuze({ a: 'prod', p: p.id, k: 'verpakking', opties: kosten.verpakking.map(v => v.naam), waarde: p.verpakking, breed: 230, ariaLabel: 'Verpakking' })}</label>
      <label>Verzendmethode ${keuze({ a: 'prod', p: p.id, k: 'methode', opties: kosten.verzending.map(v => v.naam), waarde: p.methode, breed: 200, ariaLabel: 'Verzendmethode' })}</label>
      <label>Extra's meesturen ${keuze({ a: 'prod', p: p.id, k: 'extras', opties: [{ w: 'ja', t: 'Ja' }, { w: 'nee', t: 'Nee' }], waarde: p.extras ? 'ja' : 'nee', breed: 80, ariaLabel: "Extra's meesturen" })}</label>
      <label>Pakketten per rit ${veld({ a: 'prod', p: p.id, k: 'perRit', waarde: p.perRit, breed: 64, ariaLabel: 'Pakketten per rit naar PostNL' })}</label>
    </div>
    <div class="mg-velden">
      <span class="muted mg-printkop">3D-print, per stuk:</span>
      <label>Filament (gram) ${veld({ a: 'prod', p: p.id, k: 'gram', waarde: p.gram || '', breed: 70, ariaLabel: 'Filament in gram per stuk' })}</label>
      <label>Printtijd (uur) ${veld({ a: 'prod', p: p.id, k: 'uur', waarde: p.uur || '', breed: 70, ariaLabel: 'Printtijd in uur per stuk' })}</label>
      <span class="muted" id="mg-prod-${esc(p.id)}">${prod > 0 ? `Productiekosten ${fmt(prod)} per verkoop (voor regels zonder eigen inkoop)` : 'Leeg laten als je het niet zelf print'}</span>
    </div>
    <div class="table-wrap"><table class="tbl-compact mg-regels"><thead><tr>
      <th>Variant</th><th>Kanaal</th><th>Verzending</th><th>Verkoopprijs</th><th>Inkoop / productie</th>
      <th title="Bol: de commissie zoals op de factuur, excl. btw (de btw rekent de app erbij). Website: je vaste kosten per verkoop.">Commissie excl. btw / kosten</th>
      <th style="text-align:right">Winst</th><th>Marge</th><th></th>
    </tr></thead><tbody>${p.regels.map(r => regelRij(kosten, p, r)).join('')}</tbody></table></div>
    <button type="button" class="btn btn-sm" onclick="margeVoegRegelToe('${esc(p.id)}')">Regel toevoegen</button>
  </div>`;
}

function kostenTabel(titel, lijst, kosten, opties = {}) {
  const rijen = kosten[lijst].map(v => `<tr>
      <td>${veld({ a: 'kostrij', p: lijst, r: v.id, k: 'naam', soort: 'txt', waarde: v.naam, breed: 250, her: true, ariaLabel: 'Omschrijving' })}</td>
      <td>${veld({ a: 'kostrij', p: lijst, r: v.id, k: 'bedrag', waarde: v.bedrag, breed: 80, ariaLabel: 'Inkoopbedrag' })}</td>
      <td>${veld({ a: 'kostrij', p: lijst, r: v.id, k: 'verzend', waarde: v.verzend, breed: 80, ariaLabel: 'Verzendkosten inkoop' })}</td>
      <td>${veld({ a: 'kostrij', p: lijst, r: v.id, k: 'aantal', waarde: v.aantal, breed: 64, ariaLabel: 'Aantal per bestelling' })}</td>
      <td style="text-align:right" id="mg-pps-${esc(v.id)}">${fmt(nr(v.aantal) > 0 ? (nr(v.bedrag) + nr(v.verzend)) / nr(v.aantal) : 0)}</td>
      <td style="text-align:right"><button type="button" class="btn-details" onclick="margeVerwijderKosten('${lijst}','${esc(v.id)}')" title="Verwijderen">&times;</button></td>
    </tr>`).join('');
  return `<div class="mg-blok"><div class="mg-blok-titel">${titel}</div>
    <div class="table-wrap"><table class="tbl-compact"><thead><tr><th>Omschrijving</th><th>Inkoopbedrag</th><th>Verzendkosten inkoop</th><th>Aantal</th><th style="text-align:right">Per stuk</th><th></th></tr></thead>
    <tbody>${rijen}</tbody></table></div>
    <button type="button" class="btn btn-sm" onclick="margeVoegKostenToe('${lijst}')">${opties.knop || 'Toevoegen'}</button></div>`;
}

function tarievenTabel(kosten) {
  const rijen = kosten.verzending.map(z => {
    const vast = z.naam === GEEN_VERZENDING;
    return `<tr>
      <td>${vast ? esc(z.naam) : veld({ a: 'kostrij', p: 'verzending', r: z.id, k: 'naam', soort: 'txt', waarde: z.naam, breed: 220, her: true, ariaLabel: 'Verzendmethode' })}</td>
      ${['nl', 'be', 'web'].map(k => `<td>${vast ? fmt(0) : veld({ a: 'kostrij', p: 'verzending', r: z.id, k, waarde: z[k], breed: 80, ariaLabel: 'Tarief ' + KANALEN[k].naam })}</td>`).join('')}
      <td style="text-align:right">${vast ? '' : `<button type="button" class="btn-details" onclick="margeVerwijderKosten('verzending','${esc(z.id)}')" title="Verwijderen">&times;</button>`}</td>
    </tr>`;
  }).join('');
  return `<div class="mg-blok"><div class="mg-blok-titel">Verzendtarieven naar de klant</div>
    <div class="table-wrap"><table class="tbl-compact"><thead><tr><th>Verzendmethode</th>${['nl', 'be', 'web'].map(k => `<th>${esc(KANALEN[k].naam)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rijen}</tbody></table></div>
    <button type="button" class="btn btn-sm" onclick="margeVoegKostenToe('verzending')">Verzendmethode toevoegen</button></div>`;
}

function losseKosten(kosten) {
  const rit = kosten.rit, print = kosten.print;
  const f = (pad, w, lbl, breed = 80) => `<label>${lbl} ${veld({ a: 'kost', p: pad, waarde: w, breed, ariaLabel: lbl })}</label>`;
  return `<div class="mg-blok"><div class="mg-blok-titel">Rit, retouren en 3D-print</div>
    <div class="mg-velden">
      ${f('rit.km', rit.km, 'Afstand naar PostNL, heen en terug (km)')}
      ${f('rit.perKm', rit.perKm, 'Kosten per km (€)')}
      <span class="muted" id="mg-rit">= ${fmt(nr(rit.km) * nr(rit.perKm))} per rit</span>
    </div>
    <div class="mg-velden">
      ${f('retourPct', kosten.retourPct, 'Retourpercentage (%)')}
      <span class="muted">Per verkoop wordt dit percentage van de heen- en terugverzending gereserveerd. Voor hoezen is meer dan 3% verstandig (verkeerd model besteld).</span>
    </div>
    <div class="mg-velden">
      ${f('print.rolPrijs', print.rolPrijs, 'Filament per rol (€)')}
      ${f('print.rolGram', print.rolGram, 'Gram per rol')}
      ${f('print.afschrijving', print.afschrijving, 'Afschrijving printer per uur (€)')}
      ${f('print.stroom', print.stroom, 'Stroom per uur (€)')}
      ${f('print.onderhoud', print.onderhoud, 'Onderhoud per uur (€)')}
      ${f('print.faal', print.faal, 'Mislukte prints per uur (€)')}
    </div></div>`;
}

// ---------- Pagina ----------

export function renderMarge() {
  const doel = el('marge-inhoud');
  if (!doel) return;
  const data = leesMarge();
  const uit = alleUitkomsten(data);
  doel.innerHTML = `
    <div id="marge-kpi">${kpiHtml(uit)}</div>

    <div class="card card-flush mg-overzicht">
      <div class="card-title">Wat verdien je waar?</div>
      <div id="marge-overzicht">${overzichtHtml(uit)}</div>
      <div class="mg-voet muted">
        Losse verkoop, zonder staffelkorting. Klik op een regel voor de opbouw van de kosten.
        Oordeel: onder 20% marge is krap, 20 tot 30% redelijk, vanaf 30% goed. Btw is niet verwerkt behalve de 21% over de Bol-commissie.
        Dit staat los van je voorraad en boekhouding: er wordt niets geboekt.
      </div>
    </div>

    <div class="mg-sectiekop"><h3>Artikelen en prijzen</h3>
      <button type="button" class="btn btn-primary" onclick="margeVoegProductToe()">Artikel toevoegen</button></div>
    ${data.producten.map(p => productHtml(data.kosten, p)).join('') || '<div class="leeg">Nog geen artikelen.</div>'}

    <div class="mg-sectiekop"><h3>Vaste kosten</h3></div>
    <div class="card mg-kosten">
      <p class="muted" style="margin:0 0 var(--spacing-3)">Wijzig je hier een prijs, dan rekenen alle artikelen meteen mee.</p>
      ${kostenTabel('Verpakking', 'verpakking', data.kosten, { knop: 'Verpakking toevoegen' })}
      ${kostenTabel("Extra's die je meestuurt (per pakket)", 'extras', data.kosten, { knop: "Extra toevoegen" })}
      ${tarievenTabel(data.kosten)}
      ${losseKosten(data.kosten)}
    </div>`;
  werkUitkomstenBij(uit);
}

/** Ververst alleen de berekende cijfers, zodat de invoervelden hun focus houden. */
function werkUitkomstenBij(uit = alleUitkomsten(leesMarge())) {
  const data = leesMarge();
  const open = new Set([...document.querySelectorAll('.mg-uitleg:not([hidden])')].map(x => x.id));
  if (el('marge-kpi')) el('marge-kpi').innerHTML = kpiHtml(uit);
  if (el('marge-overzicht')) el('marge-overzicht').innerHTML = overzichtHtml(uit);
  open.forEach(id => { const r = el(id); if (r) r.hidden = false; });
  for (const { regel, u } of uit) {
    const w = el('mg-w-' + regel.id), m = el('mg-m-' + regel.id);
    if (w) w.textContent = fmt(u.winst);
    if (m) m.innerHTML = margeBalk(u);
  }
  for (const p of data.producten) {
    const t = el('mg-prod-' + p.id), prod = productiekosten(data.kosten, p);
    if (t) t.textContent = prod > 0 ? `Productiekosten ${fmt(prod)} per verkoop (voor regels zonder eigen inkoop)` : 'Leeg laten als je het niet zelf print';
  }
  for (const lijst of ['verpakking', 'extras']) for (const v of data.kosten[lijst]) {
    const c = el('mg-pps-' + v.id);
    if (c) c.textContent = fmt(nr(v.aantal) > 0 ? (nr(v.bedrag) + nr(v.verzend)) / nr(v.aantal) : 0);
  }
  if (el('mg-rit')) el('mg-rit').textContent = `= ${fmt(nr(data.kosten.rit.km) * nr(data.kosten.rit.perKm))} per rit`;
}

function metScrollBehoud(fn) {
  const y = window.scrollY;
  fn();
  window.scrollTo({ top: y });
}

// ---------- Acties vanuit de pagina ----------

function leesWaarde(inv) {
  const s = inv.dataset.s;
  if (s === 'txt') return inv.value.trim();
  const ruw = inv.value.trim().replace(',', '.');
  if (s === 'opt' && ruw === '') return null;
  const n = parseFloat(ruw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function margeVeld(inv) {
  const { a, p, r, k, her } = inv.dataset;
  const w = leesWaarde(inv);
  if (a === 'kost') zetKosten(p, w);
  else if (a === 'kostrij') zetKostenRij(p, r, k, w);
  else if (a === 'prod') zetProduct(p, k, k === 'extras' ? w === 'ja' : w);
  else if (a === 'regel') zetRegel(p, r, k, w);
  if (her) metScrollBehoud(renderMarge);
  else werkUitkomstenBij();
  // Toon de opgeschoonde waarde (bijvoorbeeld "12.5" wordt "12,5", een ongeldige invoer wordt 0).
  if (!her && (inv.dataset.s === 'num' || inv.dataset.s === 'opt')) inv.value = getal(w);
}

export function margeKlap(regelId) {
  const rij = el('mg-uitleg-' + regelId);
  if (rij) rij.hidden = !rij.hidden;
}
export function margeVoegProductToe() { metScrollBehoud(() => { voegProductToe(); renderMarge(); }); }
export function margeVerwijderProduct(id) {
  const p = leesMarge().producten.find(x => x.id === id);
  if (!p || !confirm(`Artikel "${p.naam}" met al zijn regels verwijderen uit deze berekening? Je voorraad en boekhouding blijven ongemoeid.`)) return;
  metScrollBehoud(() => { verwijderProduct(id); renderMarge(); });
}
export function margeVoegRegelToe(productId) { metScrollBehoud(() => { voegRegelToe(productId); renderMarge(); }); }
export function margeVerwijderRegel(productId, regelId) { metScrollBehoud(() => { verwijderRegel(productId, regelId); renderMarge(); }); }
export function margeVoegKostenToe(lijst) { metScrollBehoud(() => { voegKostenRijToe(lijst); renderMarge(); }); }
export function margeVerwijderKosten(lijst, id) {
  const rij = leesMarge().kosten[lijst].find(x => x.id === id);
  if (!rij || !confirm(`"${rij.naam}" verwijderen uit de vaste kosten? Artikelen die ernaar verwijzen rekenen dan met €0 voor dit onderdeel.`)) return;
  metScrollBehoud(() => { verwijderKostenRij(lijst, id); renderMarge(); });
}
