// dagboeken.js — dagboeken: elke rekening is een dagboek.
//
// Een dagboek is hier een rekening (Bank, creditcard, PayPal, Memoriaal, of een eigen dagboek). Zo hoort alles wat uit de
// bank komt vanzelf in het dagboek Bank (de hoofdrekening), en tellen boekingen in andere dagboeken niet mee in het
// banksaldo. Vanuit dit scherm kun je boekingen in bulk wijzigen (grootboek, dagboek), op een vraagpost zetten en
// memoriaalboekingen maken. Alles gebruikt dezelfde opslag als het bewerken van een boeking op de Bank-pagina.

import {
  state, saveHistTxData, saveTxData, saveRekeningen, saveGrootboek, jaarIsVergrendeld,
  grootboekNamen, grootboekOptgroepen, rekeningenLijst
} from './storage.js?v=20261109m';
import { addToPendingQueue, syncPendingQueue, isSupabaseReady } from './supabase-client-v2.js?v=20261109m';
import { esc, fmt, isInkomst, maandLabel } from './helpers.js?v=20261109m';
import { lopendJaar, txVanJaar, banksaldoTot, vandaagIso } from './jaren.js?v=20261109m';
import { telInbox } from './bankinbox.js?v=20261109m';

const el = id => document.getElementById(id);
export const VRAAGPOST_GB = '9999';
export const MEMORIAAL_NR = '1900';
const SOORTEN = { bank: 'Bank', creditcard: 'Creditcard', memoriaal: 'Memoriaal', overig: 'Overig' };

let gekozen = null;            // nummer van het dagboek, of 'vraagposten'
let jaarKeuze = null, zoek = '';
let periode = 'jaar', vanDatum = '', totDatum = '';   // 'jaar' | 'q1'..'q4' | 'm01'..'m12' | 'eigen'
const MAANDEN = ['Januari','Februari','Maart','April','Mei','Juni','Juli','Augustus','September','Oktober','November','December'];
const aangevinkt = new Set();

// ─── Dagboeken (rekeningen) ────────────────────────────────────────────────

/** Zorgt dat het dagboek Memoriaal bestaat en dat elke rekening een soort heeft. Schrijft alleen als er iets verandert. */
export function zorgVoorDagboeken() {
  let wijzig = false;
  for (const r of state.REKENINGEN) {
    if (!r.soort) { r.soort = r.isHoofdrekening ? 'bank' : (/credit/i.test(r.naam) ? 'creditcard' : 'overig'); wijzig = true; }
  }
  if (!state.REKENINGEN.some(r => r.soort === 'memoriaal')) {
    let nr = MEMORIAAL_NR; while (state.REKENINGEN.some(r => r.nummer === nr)) nr = String(Number(nr) + 1);
    state.REKENINGEN.push({ nummer: nr, naam: 'Memoriaal', isHoofdrekening: false, soort: 'memoriaal' });
    wijzig = true;
  }
  if (wijzig) saveRekeningen();
}

const alleBoekingen = () => [...state.HIST_TX, ...state.TX];
const dagboekVan = nr => state.REKENINGEN.find(r => String(r.nummer) === String(nr));
const gbBekend = gb => state.GROOTBOEK.some(g => String(g.nummer) === String(gb));
export const isVraagpost = t => !t.gb || String(t.gb) === VRAAGPOST_GB || !gbBekend(t.gb);

function vindTx(id) {
  const a = state.TX.find(t => String(t.id) === String(id));
  if (a) return { tx: a, historisch: false };
  const b = state.HIST_TX.find(t => String(t.id) === String(id));
  return b ? { tx: b, historisch: true } : null;
}

/**
 * Wijzigt grootboek en/of dagboek van meerdere boekingen. Geeft {aantal, overgeslagen} terug.
 * Privé-boekingen houden hun gb en soort bij elkaar (600 = storting, 601 = opname), net als in het bewerkscherm.
 */
export function wijzigBoekingen(ids, { gb, rek } = {}) {
  let aantal = 0, overgeslagen = 0;
  let histGewijzigd = false, txGewijzigd = false;
  for (const id of ids) {
    const f = vindTx(id);
    if (!f) { overgeslagen++; continue; }
    const nieuw = { ...f.tx };
    if (gb != null) {
      if (nieuw.type === 'prive_storting' || nieuw.type === 'prive_opname') { overgeslagen++; continue; }   // privé: via Bewerk
      if (gb === '600' || gb === '601') { overgeslagen++; continue; }
      nieuw.gb = String(gb);
    }
    if (rek != null) nieuw.rek = String(rek);
    if (nieuw.gb === f.tx.gb && nieuw.rek === f.tx.rek) continue;
    if (f.historisch) { state.HIST_TX = state.HIST_TX.map(t => (String(t.id) === String(id) ? nieuw : t)); histGewijzigd = true; }
    else { state.TX = state.TX.map(t => (String(t.id) === String(id) ? nieuw : t)); txGewijzigd = true; }
    addToPendingQueue(nieuw, 'update', f.historisch);
    aantal++;
  }
  if (histGewijzigd) saveHistTxData();
  if (txGewijzigd) saveTxData();
  if (aantal && isSupabaseReady()) syncPendingQueue().catch(err => console.warn('Sync later opnieuw:', err));
  return { aantal, overgeslagen };
}

// ─── Pagina ────────────────────────────────────────────────────────────────

export function kiesDagboek(nr) { gekozen = nr; aangevinkt.clear(); renderDagboeken(); }
export function zetDagboekJaar(j) { jaarKeuze = j; aangevinkt.clear(); renderDagboeken(); }
export function zetDagboekPeriode(p) { periode = p; aangevinkt.clear(); renderDagboeken(); }
export function zetDagboekVanTot(van, tot) { vanDatum = van || ''; totDatum = tot || ''; aangevinkt.clear(); renderDagboeken(); }

/** Begin- en einddatum (ISO, inclusief) van de gekozen periode, of null als er geen beperking is. */
function periodeGrenzen(jaar) {
  if (periode === 'eigen') return { van: vanDatum || '0000-00-00', tot: totDatum || '9999-99-99' };
  if (jaar === 'all' || periode === 'jaar') return null;
  const laatste = (j, m) => new Date(Number(j), m, 0).getDate();
  if (/^q[1-4]$/.test(periode)) {
    const q = Number(periode[1]), m1 = (q - 1) * 3 + 1, m2 = q * 3;
    return { van: `${jaar}-${String(m1).padStart(2, '0')}-01`, tot: `${jaar}-${String(m2).padStart(2, '0')}-${laatste(jaar, m2)}` };
  }
  if (/^m\d\d$/.test(periode)) {
    const m = Number(periode.slice(1));
    return { van: `${jaar}-${String(m).padStart(2, '0')}-01`, tot: `${jaar}-${String(m).padStart(2, '0')}-${laatste(jaar, m)}` };
  }
  return null;
}
const inPeriode = (t, g) => !g || (String(t.datum) >= g.van && String(t.datum) <= g.tot);
function periodeTekst(jaar) {
  if (periode === 'eigen') return `${vanDatum || 'begin'} t/m ${totDatum || 'nu'}`;
  if (jaar === 'all' || periode === 'jaar') return jaar === 'all' ? 'alle jaren' : jaar;
  if (periode[0] === 'q') return `${periode.toUpperCase()} ${jaar}`;
  return `${MAANDEN[Number(periode.slice(1)) - 1]} ${jaar}`;
}
export function zetDagboekZoek(t) { zoek = String(t || '').toLowerCase(); renderDagboeken(true); }
export function vinkDagboekRij(id, aan) { if (aan) aangevinkt.add(String(id)); else aangevinkt.delete(String(id)); renderDagboeken(true, true); }
export function vinkDagboekAlles(aan) {
  aangevinkt.clear();
  if (aan) lijstRijen().forEach(t => aangevinkt.add(String(t.id)));
  renderDagboeken(true);
}

function lijstRijen() {
  const jaar = jaarKeuze || String(lopendJaar());
  const g = periodeGrenzen(jaar);
  let l = (periode === 'eigen' ? txVanJaar('all') : txVanJaar(jaar)).filter(t => inPeriode(t, g));
  if (gekozen === 'vraagposten') l = l.filter(isVraagpost);
  else l = l.filter(t => String(t.rek) === String(gekozen));
  if (zoek) l = l.filter(t => `${t.naam || ''} ${t.omschr || ''} ${t.gb} ${t.bedrag}`.toLowerCase().includes(zoek));
  return l.sort((a, b) => String(b.datum).localeCompare(String(a.datum)) || String(b.id).localeCompare(String(a.id)));
}

export function renderDagboeken(behoudFocus = false, behoudScroll = false) {
  const doel = el('dagboeken-inhoud');
  if (!doel) return;
  zorgVoorDagboeken();
  if (!gekozen || (gekozen !== 'vraagposten' && !dagboekVan(gekozen))) gekozen = (state.REKENINGEN.find(r => r.isHoofdrekening) || state.REKENINGEN[0]).nummer;
  const jaar = jaarKeuze || String(lopendJaar());
  const grenzen = periodeGrenzen(jaar);
  const alle = (periode === 'eigen' ? txVanJaar('all') : txVanJaar(jaar)).filter(t => inPeriode(t, grenzen));
  const GB = grootboekNamen();
  const vraag = alle.filter(isVraagpost).length;
  const scrollY = window.scrollY;

  const chips = rekeningenLijst().map(r => {
    const n = alle.filter(t => String(t.rek) === String(r.nummer)).length;
    return `<button type="button" class="dagboek-chip ${String(r.nummer) === String(gekozen) ? 'actief' : ''}" onclick="kiesDagboek('${esc(r.nummer)}')">
      <strong>${esc(r.naam)}</strong><span class="muted">${SOORTEN[r.soort] || 'Overig'} · ${n}</span></button>`;
  }).join('') + `<button type="button" class="dagboek-chip ${gekozen === 'vraagposten' ? 'actief' : ''}" onclick="kiesDagboek('vraagposten')">
      <strong>Vraagposten</strong><span class="muted">${vraag ? `<span style="color:var(--semantic-warning-bright,#b7791f)">${vraag} uit te zoeken</span>` : 'niets uit te zoeken'}</span></button>`;

  const rijen = lijstRijen();
  const dagboek = gekozen === 'vraagposten' ? null : dagboekVan(gekozen);
  const gebruikteJaren = [...new Set([lopendJaar(), ...alleBoekingen().map(t => String(t.datum).slice(0, 4))])].sort().reverse();
  const geselecteerd = rijen.filter(t => aangevinkt.has(String(t.id)));
  const somSel = geselecteerd.reduce((s, t) => s + (isInkomst(t) || t.type === 'prive_storting' ? Number(t.bedrag) : -Number(t.bedrag)), 0);
  const optGb = grootboekOptgroepen ? gbOpties() : '';
  const opties = rekeningenLijst().map(r => `<option value="${esc(r.nummer)}">${esc(r.naam)}</option>`).join('');

  const plus = t => isInkomst(t) || t.type === 'prive_storting';
  const bedragHtml = t => `<span class="dg-bedrag ${plus(t) ? 'dg-plus' : 'dg-min'}">${plus(t) ? '+' : '−'}&thinsp;${fmt(t.bedrag)}</span>`;
  const bij = rijen.filter(plus).reduce((a, t) => a + Number(t.bedrag), 0);
  const af = rijen.filter(t => !plus(t)).reduce((a, t) => a + Number(t.bedrag), 0);
  const kolommen = gekozen === 'vraagposten' ? 7 : 6;
  let tbody = '', laatsteMaand = '';
  const perMaand = new Map();
  for (const t of rijen.slice(0, 600)) {
    const m = String(t.datum).slice(0, 7), p = perMaand.get(m) || { bij: 0, af: 0 };
    if (plus(t)) p.bij += Number(t.bedrag); else p.af += Number(t.bedrag);
    perMaand.set(m, p);
  }
  for (const t of rijen.slice(0, 600)) {
    const m = String(t.datum).slice(0, 7);
    if (m !== laatsteMaand) {
      laatsteMaand = m; const p = perMaand.get(m);
      tbody += `<tr class="dg-maand"><td colspan="${kolommen}"><strong>${esc(maandLabel(m))}</strong>
        <span class="dg-mtot"><span class="dg-plus">bij ${fmt(p.bij)}</span> <span class="dg-min">af ${fmt(p.af)}</span> <span>netto <strong>${fmt(p.bij - p.af)}</strong></span></span></td></tr>`;
    }
    tbody += `<tr>
    <td><input type="checkbox" ${aangevinkt.has(String(t.id)) ? 'checked' : ''} onchange="vinkDagboekRij('${esc(String(t.id))}',this.checked)" aria-label="Selecteer"></td>
    <td class="dg-datum">${esc(String(t.datum).slice(8, 10) + '-' + String(t.datum).slice(5, 7))}</td>
    <td><div class="dg-naam">${esc(t.naam || '—')}</div><div class="dg-omschr" title="${esc(t.omschr || '')}">${esc(t.omschr || '')}</div></td>
    <td>${isVraagpost(t) ? `<span class="badge badge-amber">vraagpost</span> ` : ''}${esc(GB[t.gb] || t.gb || '—')} <span class="muted">${esc(t.gb || '')}</span></td>
    ${gekozen === 'vraagposten' ? `<td class="muted">${esc(dagboekVan(t.rek)?.naam || t.rek || '—')}</td>` : ''}
    <td class="dg-bedragcel">${bedragHtml(t)}</td>
    <td style="text-align:right;white-space:nowrap">${String(t.gb) === '7000' && t.type === 'uitgave'
      ? `<button type="button" class="btn-details" title="Artikelen en aantallen bij deze inkoop invullen" onclick="openInkoopVerwerken('${esc(String(t.id))}')">${(state.ARTIKELREGELS?.inkopen || []).some(r => String(r.txId) === String(t.id)) ? 'Inkoop \u2713' : 'Inkoop'}</button> ` : ''}<button type="button" class="btn-details" onclick="bewerkBoeking('${esc(String(t.id))}')">Bewerk</button></td></tr>`;
  }

  const actief = document.activeElement?.id;
  doel.innerHTML = `
    <style>
      .dagboek-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
      .dagboek-chip{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 14px;border:1px solid var(--border-default);border-radius:var(--radius-md,8px);background:var(--bg-card);color:var(--text-primary);cursor:pointer;font:inherit;text-align:left}
      .dagboek-chip.actief{border-color:var(--accent,#6d4aff);box-shadow:0 0 0 1px var(--accent,#6d4aff)}
      .dagboek-chip .muted{font-size:12.5px}
      .dg-bedrag{font-variant-numeric:tabular-nums;font-weight:600;font-size:15px;white-space:nowrap}
      .dg-plus{color:var(--semantic-success-bright,#1f9d55)} .dg-min{color:var(--semantic-error-bright,#d64545)}
      .dg-bedragcel{text-align:right;width:150px}
      .dg-datum{width:64px;color:var(--text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
      .dg-naam{font-weight:500} .dg-omschr{font-size:12.5px;color:var(--text-secondary);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dg-maand td{background:var(--bg-elevated,rgba(127,127,127,.10));padding:8px 12px;font-size:14px}
      .dg-mtot{float:right;display:inline-flex;gap:16px;font-variant-numeric:tabular-nums}
      .dg-samenvatting{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}
      .dg-samenvatting>div{padding:10px 16px;border:1px solid var(--border-default);border-radius:var(--radius-md,8px);background:var(--bg-card);min-width:150px}
      .dg-samenvatting .lbl{font-size:12.5px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.03em}
      .dg-samenvatting .val{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
      #dagboeken-inhoud .tbl-compact td{padding-top:9px;padding-bottom:9px}
      .dagboek-bulk{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:10px 14px;margin-bottom:10px;border:1px solid var(--accent,#6d4aff);border-radius:var(--radius-md,8px);background:var(--bg-card)}
    </style>
    <div class="dagboek-chips">${chips}<button type="button" class="dagboek-chip" onclick="openNieuwDagboek()"><strong>+ Nieuw dagboek</strong><span class="muted">eigen dagboek maken</span></button></div>
    ${gekozen === 'vraagposten' ? `<p class="muted" style="font-size:14px;margin:0 0 10px">Boekingen zonder (bestaand) grootboek, of op ${VRAAGPOST_GB} "Nog uit te zoeken". Vink ze aan en geef ze in één keer een grootboek.</p>`
      : `<p class="muted" style="font-size:14px;margin:0 0 10px">${dagboek ? esc(uitleg(dagboek, jaar)) : ''}</p>`}
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <select id="dagboek-jaar" onchange="zetDagboekJaar(this.value)" aria-label="Jaar">${gebruikteJaren.map(y => `<option ${y === jaar ? 'selected' : ''}>${esc(y)}</option>`).join('')}<option value="all" ${jaar === 'all' ? 'selected' : ''}>Alle jaren</option></select>
      <select id="dagboek-periode" onchange="zetDagboekPeriode(this.value)" aria-label="Periode" ${jaar === 'all' && periode !== 'eigen' ? 'disabled' : ''}>
        <option value="jaar" ${periode === 'jaar' ? 'selected' : ''}>Hele jaar</option>
        <optgroup label="Kwartaal">${[1,2,3,4].map(q => `<option value="q${q}" ${periode === 'q' + q ? 'selected' : ''}>Kwartaal ${q}</option>`).join('')}</optgroup>
        <optgroup label="Maand">${MAANDEN.map((n, i) => { const v = 'm' + String(i + 1).padStart(2, '0'); return `<option value="${v}" ${periode === v ? 'selected' : ''}>${n}</option>`; }).join('')}</optgroup>
        <option value="eigen" ${periode === 'eigen' ? 'selected' : ''}>Eigen periode…</option></select>
      ${periode === 'eigen' ? `<input type="date" id="dagboek-van" value="${esc(vanDatum)}" onchange="zetDagboekVanTot(this.value, document.getElementById('dagboek-tot').value)" aria-label="Van"> t/m
      <input type="date" id="dagboek-tot" value="${esc(totDatum)}" onchange="zetDagboekVanTot(document.getElementById('dagboek-van').value, this.value)" aria-label="Tot">` : ''}
      <input type="search" id="dagboek-zoek" placeholder="Zoek in dit dagboek…" value="${esc(zoek)}" oninput="zetDagboekZoek(this.value)" style="min-width:220px">
      <span class="muted" style="font-size:14px">${rijen.length} boeking${rijen.length === 1 ? '' : 'en'}${rijen.length > 600 ? ' (eerste 600 getoond)' : ''}</span>
      <span style="flex:1"></span>
      ${gekozen !== 'vraagposten' && dagboek?.soort !== 'memoriaal' ? `<button type="button" class="btn btn-sm btn-primary" onclick="nieuweBoekingInDagboek()">+ Boeking in ${esc(dagboek?.naam || 'dagboek')}</button>` : ''}
      <button type="button" class="btn btn-sm" onclick="openMemoriaalBoeking()">+ Memoriaalboeking</button>
    </div>
    <div class="dg-samenvatting">
      <div><div class="lbl">Periode</div><div class="val" style="font-size:16px;padding-top:3px">${esc(periodeTekst(jaar))}</div></div>
      <div><div class="lbl">Bij</div><div class="val dg-plus">${fmt(bij)}</div></div>
      <div><div class="lbl">Af</div><div class="val dg-min">${fmt(af)}</div></div>
      <div><div class="lbl">Netto</div><div class="val">${fmt(bij - af)}</div></div>
    </div>
    ${geselecteerd.length ? `<div class="dagboek-bulk"><strong>${geselecteerd.length} geselecteerd</strong><span class="muted">(${fmt(somSel)})</span>
      <select id="bulk-gb" aria-label="Grootboek">${gbOpties(true)}</select>
      <button type="button" class="btn btn-sm" onclick="bulkGrootboek()">Zet grootboek</button>
      <select id="bulk-rek" aria-label="Dagboek">${opties}</select>
      <button type="button" class="btn btn-sm" onclick="bulkDagboek()">Verplaats naar dagboek</button>
      <button type="button" class="btn btn-sm" onclick="bulkVraagpost()">Zet op vraagpost</button></div>` : ''}
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th style="width:32px"><input type="checkbox" onchange="vinkDagboekAlles(this.checked)" aria-label="Alles selecteren" ${rijen.length && geselecteerd.length === rijen.length ? 'checked' : ''}></th>
        <th style="width:84px">Datum</th><th>Naam en omschrijving</th><th style="width:26%">Grootboek</th>${gekozen === 'vraagposten' ? '<th>Dagboek</th>' : ''}<th style="text-align:right;width:130px">Bedrag</th><th style="width:1%"></th></tr></thead>
      <tbody>${tbody || `<tr><td colspan="7" class="muted" style="padding:16px">Geen boekingen.</td></tr>`}</tbody></table></div></div>
    <div id="dagboek-inbox" class="muted" style="font-size:13px;margin-top:10px"></div>`;
  if (dagboek?.soort === 'bank' || dagboek?.isHoofdrekening) {
    telInbox().then(n => { const h = el('dagboek-inbox'); if (h && n) h.innerHTML = `Er staan ${n} nieuwe bankregels in de <a href="#" onclick="nav('bank');return false">bank-inbox</a>; die komen na verwerking in dit dagboek.`; }).catch(() => {});
  }
  if (behoudFocus && actief === 'dagboek-zoek') { const i = el('dagboek-zoek'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if (behoudScroll) window.scrollTo(0, scrollY);
}

function uitleg(d, jaar) {
  if (d.soort === 'bank' || d.isHoofdrekening) {
    const saldo = (() => { try { return banksaldoTot(jaar === 'all' || jaar === String(lopendJaar()) ? null : `${jaar}-12-31`); } catch { return null; } })();
    return `Hier komt alles uit de bank binnen (import, koppeling en bank-inbox).${saldo != null ? ` Banksaldo: ${fmt(saldo)}.` : ''}`;
  }
  if (d.soort === 'memoriaal') return 'Boekingen die niet via de bank lopen, zoals correcties en omboekingen. Ze tellen mee in het resultaat maar niet in het banksaldo.';
  if (d.soort === 'creditcard') return 'Uitgaven en stortingen via deze kaart. Telt niet mee in het banksaldo.';
  return 'Eigen dagboek. Boekingen hier tellen mee in het resultaat maar niet in het banksaldo.';
}

function gbOpties(metKeuze = false) {
  const groepen = grootboekOptgroepen();
  const html = (Array.isArray(groepen) ? groepen : []).map(g => {
    const naam = g.label || g.naam || g.titel, items = g.items || g.rekeningen || g.lijst || [];
    return `<optgroup label="${esc(naam)}">${items.filter(x => x.nummer !== '600' && x.nummer !== '601').map(x => `<option value="${esc(x.nummer)}">${esc(x.nummer)} ${esc(x.naam)}</option>`).join('')}</optgroup>`;
  }).join('');
  return (metKeuze ? '<option value="">Kies grootboek…</option>' : '') + html;
}

// ─── Bulkacties ────────────────────────────────────────────────────────────

function eerstBevestig(ids) {
  const vergrendeld = ids.map(vindTx).filter(Boolean).filter(f => jaarIsVergrendeld(f.tx.datum)).length;
  return !vergrendeld || window.confirm(`🔒 ${vergrendeld} boeking${vergrendeld === 1 ? '' : 'en'} staan in een vergrendeld jaar (aangifte ingediend). Dit verandert de cijfers van dat jaar. Toch doorgaan?`);
}
function melding(r, wat) {
  let t = `${r.aantal} boeking${r.aantal === 1 ? '' : 'en'} ${wat}.`;
  if (r.overgeslagen) t += `\n${r.overgeslagen} overgeslagen (privé-boekingen wijzig je via Bewerk).`;
  alert(t);
}
export function bulkGrootboek() {
  const gb = el('bulk-gb')?.value;
  if (!gb) { alert('Kies eerst een grootboek.'); return; }
  const ids = [...aangevinkt];
  if (!eerstBevestig(ids)) return;
  const r = wijzigBoekingen(ids, { gb });
  aangevinkt.clear(); renderDagboeken(); melding(r, 'op ' + (grootboekNamen()[gb] || gb) + ' gezet');
}
export function bulkDagboek() {
  const rek = el('bulk-rek')?.value;
  if (!rek) return;
  const ids = [...aangevinkt];
  const naam = dagboekVan(rek)?.naam || rek;
  if (!window.confirm(`${ids.length} boeking${ids.length === 1 ? '' : 'en'} verplaatsen naar dagboek ${naam}?\nBij Bank telt het mee in het banksaldo, bij andere dagboeken niet.`)) return;
  if (!eerstBevestig(ids)) return;
  const r = wijzigBoekingen(ids, { rek });
  aangevinkt.clear(); renderDagboeken(); melding(r, 'verplaatst naar ' + naam);
}
export function bulkVraagpost() {
  const ids = [...aangevinkt];
  if (!eerstBevestig(ids)) return;
  if (!gbBekend(VRAAGPOST_GB)) { state.GROOTBOEK.push({ nummer: VRAAGPOST_GB, naam: 'Nog uit te zoeken (vraagpost)' }); saveGrootboek(); }
  const r = wijzigBoekingen(ids, { gb: VRAAGPOST_GB });
  aangevinkt.clear(); renderDagboeken(); melding(r, 'op vraagpost gezet');
}

// ─── Nieuw dagboek en memoriaalboeking ─────────────────────────────────────

let sluitHuidige = null;
function toonVenster(inhoudHtml) {
  sluitHuidige?.();
  const laag = document.createElement('div');
  laag.className = 'pm-laag'; laag.id = 'dagboek-venster';
  laag.innerHTML = `<div class="pm-venster" role="dialog" aria-modal="true" style="max-width:560px">${inhoudHtml}</div>`;
  document.body.appendChild(laag);
  const sluit = () => { document.removeEventListener('keydown', opToets, true); laag.remove(); if (sluitHuidige === sluit) sluitHuidige = null; };
  function opToets(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); } }
  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });
  laag.querySelectorAll('[data-dg-sluit]').forEach(k => k.addEventListener('click', sluit));
  sluitHuidige = sluit;
}
export const sluitDagboekVenster = () => sluitHuidige?.();

export function openNieuwDagboek() {
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">Nieuw dagboek</h3><div class="pm-sub">Bijvoorbeeld PayPal, Kas of Verkoop contant</div></div>
      <button type="button" class="pm-kruis" data-dg-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud"><div class="form-grid">
      <div class="form-group full"><label for="dg-naam">Naam</label><input id="dg-naam" placeholder="bijv. PayPal"></div>
      <div class="form-group"><label for="dg-soort">Soort</label><select id="dg-soort"><option value="overig">Overig</option><option value="creditcard">Creditcard</option><option value="memoriaal">Memoriaal</option></select></div>
      <div class="form-group"><label for="dg-nr">Nummer (3 of 4 cijfers)</label><input id="dg-nr" inputmode="numeric" value="${volgendNummer()}"></div>
    </div><div id="dg-fout" style="color:var(--semantic-error,#c0392b);font-size:14px;margin-top:6px"></div>
    <p class="muted" style="font-size:13px">Een nieuw dagboek telt niet mee in het banksaldo. Het banksaldo komt alleen uit het dagboek Bank.</p></div>
    <div class="pm-voet"><button type="button" class="btn" data-dg-sluit>Annuleren</button><button type="button" class="btn btn-primary" onclick="bewaarNieuwDagboek()">Aanmaken</button></div>`);
  setTimeout(() => el('dg-naam')?.focus(), 30);
}
function volgendNummer() {
  let n = 1910; while (state.REKENINGEN.some(r => Number(r.nummer) === n)) n++; return String(n);
}
export function bewaarNieuwDagboek() {
  const naam = el('dg-naam').value.trim(), nummer = el('dg-nr').value.trim(), soort = el('dg-soort').value;
  const fout = t => { el('dg-fout').textContent = t; };
  if (!naam) return fout('Vul een naam in.');
  if (!/^\d{3,4}$/.test(nummer)) return fout('Het nummer moet uit 3 of 4 cijfers bestaan.');
  if (state.REKENINGEN.some(r => String(r.nummer) === nummer)) return fout(`Nummer ${nummer} bestaat al.`);
  if (state.REKENINGEN.some(r => r.naam.toLowerCase() === naam.toLowerCase())) return fout('Er is al een dagboek met deze naam.');
  state.REKENINGEN.push({ nummer, naam, isHoofdrekening: false, soort });
  saveRekeningen();
  sluitDagboekVenster();
  gekozen = nummer;
  renderDagboeken();
}

export function openMemoriaalBoeking() {
  zorgVoorDagboeken();
  const dagboeken = rekeningenLijst().filter(r => !r.isHoofdrekening && r.soort !== 'bank');
  const standaard = gekozen && gekozen !== 'vraagposten' && dagboeken.some(d => d.nummer === gekozen) ? gekozen : (dagboeken.find(d => d.soort === 'memoriaal') || dagboeken[0]).nummer;
  toonVenster(`
    <div class="pm-kop"><div><h3 style="margin:0">Memoriaalboeking</h3><div class="pm-sub">Een boeking die niet via de bank loopt</div></div>
      <button type="button" class="pm-kruis" data-dg-sluit aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud"><div class="form-grid">
      <div class="form-group"><label for="mm-datum">Datum</label><input type="date" id="mm-datum" value="${vandaagIso()}"></div>
      <div class="form-group"><label for="mm-bedrag">Bedrag (€)</label><input id="mm-bedrag" inputmode="decimal" placeholder="0,00"></div>
      <div class="form-group full"><label for="mm-voorbeeld">Wat wil je doen?</label>
        <select id="mm-voorbeeld" onchange="mmVoorbeeld(this.value)">
          <option value="">Kies een voorbeeld of vul zelf in…</option>
          <option value="omzet-terug">Omzet terugboeken (bijv. een retour dat al was geboekt)</option>
          <option value="kosten">Kosten boeken zonder bankbetaling</option>
          <option value="opbrengst">Opbrengst boeken zonder bankbetaling</option>
        </select></div>
      <div class="form-group"><label for="mm-type">Soort</label><select id="mm-type"><option value="uitgave">Kosten / min</option><option value="inkomst">Opbrengst / plus</option></select></div>
      <div class="form-group"><label for="mm-gb">Grootboek</label><select id="mm-gb"><option value="">Kies grootboek…</option>${gbOpties()}</select></div>
      <div class="form-group"><label for="mm-rek">Dagboek</label><select id="mm-rek">${dagboeken.map(d => `<option value="${esc(d.nummer)}" ${d.nummer === standaard ? 'selected' : ''}>${esc(d.naam)}</option>`).join('')}</select></div>
      <div class="form-group full"><label for="mm-naam">Naam / omschrijving</label><input id="mm-naam" placeholder="bijv. Camera retour"></div>
    </div><div id="mm-fout" style="color:var(--semantic-error,#c0392b);font-size:14px;margin-top:6px"></div></div>
    <div class="pm-voet"><button type="button" class="btn" data-dg-sluit>Annuleren</button><button type="button" class="btn btn-primary" onclick="bewaarMemoriaal()">Boeken</button></div>`);
}
export function mmVoorbeeld(v) {
  const set = (t, g) => { el('mm-type').value = t; if (g) el('mm-gb').value = g; };
  if (v === 'omzet-terug') { set('uitgave', gbBekend('8000') ? '8000' : ''); if (!el('mm-naam').value) el('mm-naam').value = 'Omzet teruggeboekt'; }
  if (v === 'kosten') set('uitgave', '');
  if (v === 'opbrengst') set('inkomst', gbBekend('8000') ? '8000' : '');
}
export function bewaarMemoriaal() {
  const fout = t => { el('mm-fout').textContent = t; };
  const datum = el('mm-datum').value, gb = el('mm-gb').value, rek = el('mm-rek').value;
  const bedrag = parseFloat(String(el('mm-bedrag').value).replace(/\s/g, '').replace(',', '.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return fout('Vul een geldige datum in.');
  if (!(bedrag > 0)) return fout('Vul een bedrag groter dan nul in. Of het plus of min is bepaal je met de soort.');
  if (!gb) return fout('Kies een grootboek.');
  if (gb === '600' || gb === '601') return fout('Privé-boekingen maak je via de Bank-pagina.');
  if (jaarIsVergrendeld(datum) && !window.confirm('🔒 Dit jaar is vergrendeld (aangifte ingediend). Deze boeking verandert de cijfers van dat jaar. Toch boeken?')) return;
  const tx = {
    id: state.nxtTx++, datum, bedrag: Math.round(bedrag * 100) / 100,
    naam: el('mm-naam').value.trim() || 'Memoriaalboeking', omschr: 'Memoriaalboeking',
    type: el('mm-type').value, rek, gb, bron: 'handmatig'
  };
  state.TX.push(tx);
  saveTxData();
  addToPendingQueue(tx, 'create', false);
  if (isSupabaseReady()) syncPendingQueue().catch(err => console.warn('Sync later opnieuw:', err));
  sluitDagboekVenster();
  gekozen = rek;
  renderDagboeken();
}


/** Nieuwe boeking in het gekozen dagboek, met een datum binnen de gekozen periode. */
export function nieuweBoekingInDagboek() {
  window.openTxModal();
  const rek = el('tx-rek'), d = el('tx-d');
  if (rek && gekozen && gekozen !== 'vraagposten') rek.value = String(gekozen);
  const g = periodeGrenzen(jaarKeuze || String(lopendJaar()));
  if (d && g) {
    const nu = vandaagIso();
    if (nu < g.van || nu > g.tot) d.value = g.tot < '9999' ? g.tot : g.van;
    d.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Na opslaan of wijzigen van een boeking (ook vanuit dit scherm) de lijst bijwerken.
document.addEventListener('tx-opgeslagen', () => {
  if (location.hash === '#dagboeken' && el('dagboeken-inhoud')) renderDagboeken(true, true);
});
