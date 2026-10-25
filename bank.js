// bank.js — Bank: alle mutaties per rekening, inclusief transactie-modal.

import {
  bedragUit, ddmm, esc, fmt, isInkomst, isUitgave, leegVlak, maandLabel, MND_KORT, rekBadge,
  typeBadge, vulMaandSelect, weergaveNaam
} from './helpers.js?v=20261024u';
import {
  MAAND_SALDOS, saveHistTxData, saveTxData, state, isBtwPlichtig,
  grootboekNamen, rekeningNamen, grootboekOptgroepen, rekeningenLijst
, jaarIsVergrendeld} from './storage.js?v=20261024u';
import { maakSorteerbaar } from './tables.js?v=20261024u';
import { EERSTE_TX_JAAR, isTxJaar, lopendJaar, txVanJaar, banksaldoTot, jaarVan } from './jaren.js?v=20261024u';
import { heeftBonnetje, startModalBonnetjes, sluitModalBonnetjes, bewaarWachtende } from './bonnetjes.js?v=20261024u';
import { facturenBijBoeking, ontkoppelAlleFacturenVanBoeking } from './facturen.js?v=20261024u';

// Fase 3A: Supabase pending queue
import {
  addToPendingQueue,
  syncPendingQueue,
  pendingQueue,
  isSupabaseReady
} from './supabase-client-v2.js?v=20261024u';

const el = id => document.getElementById(id);

function bronVoorJaar(jaar) {
  return txVanJaar(jaar);
}

/** Laatste dag van een maand ("2027-02" -> "2027-02-28"). */
function maandEinde(maand) {
  const d = new Date(maand + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** Saldo uit het afschrift (Excel), anders berekend uit de boekingen vanaf 2026. */
function saldoEindeMaand(maand) {
  const bekend = MAAND_SALDOS[maand]?.eind;
  if (bekend != null) return bekend;
  return maand >= EERSTE_TX_JAAR ? banksaldoTot(maandEinde(maand)) : null;
}

/** Laatst bekende eindsaldo van de bankrekening binnen een jaar. */
function eindsaldoVanJaar(jaar) {
  const laatste = Object.keys(MAAND_SALDOS).filter(m => m.startsWith(jaar)).sort().pop();
  if (laatste) return MAAND_SALDOS[laatste].eind;
  return isTxJaar(jaar) ? banksaldoTot(`${jaar}-12-31`) : null;
}

function vorigeMaand(maand) {
  const d = new Date(maand + '-01');
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Vult een <select> met optgroepen uit state.GROOTBOEK, net als de vaste
 *  lijst die er hiervoor stond. `huidigeWaarde` blijft geselecteerd; staat
 *  het nummer er niet (meer) bij — bv. een oude boeking buiten het huidige
 *  schema — dan komt het er tijdelijk bij, zodat bewerken het niet
 *  stilzwijgend verandert. */
function vulGrootboekSelect(select, huidigeWaarde) {
  select.innerHTML = grootboekOptgroepen().map(g => `
    <optgroup label="${esc(g.naam)}">
      ${g.rekeningen.map(r => `<option value="${esc(r.nummer)}">${esc(r.nummer)} ${esc(r.naam)}</option>`).join('')}
    </optgroup>`).join('');
  if (huidigeWaarde && ![...select.options].some(o => o.value === huidigeWaarde)) {
    const optie = document.createElement('option');
    optie.value = huidigeWaarde;
    optie.textContent = `${huidigeWaarde} (niet in schema)`;
    select.appendChild(optie);
  }
  if (huidigeWaarde) select.value = huidigeWaarde;
}

/** Zelfde idee, voor de bankrekeningen. */
function vulRekeningSelect(select, huidigeWaarde) {
  select.innerHTML = rekeningenLijst()
    .map(r => `<option value="${esc(r.nummer)}">${esc(r.nummer)} ${esc(r.naam)}</option>`).join('');
  select.value = rekeningenLijst().some(r => r.nummer === huidigeWaarde) ? huidigeWaarde : '1010';
}

/** Het rekeningfilter boven de tabel — dezelfde bron, huidige keuze blijft staan. */
function vulRekeningFilter() {
  const select = el('f-rek');
  if (!select) return;
  const huidig = select.value;
  select.innerHTML = '<option value="">Alle rekeningen</option>' +
    rekeningenLijst().map(r => `<option value="${esc(r.nummer)}">${esc(r.naam)}</option>`).join('');
  if ([...select.options].some(o => o.value === huidig)) select.value = huidig;
}

// Per jaar één keer: begin op de laatste maand met boekingen, zodat je niet
// door het hele jaar hoeft te scrollen. 'Totaal' toont het overzicht per maand.
const bankBegonnen = new Set();
let toonAlleBoekingen = false;

export function kiesBankMaand(m) {
  const sel = el('f-maand');
  if (sel) sel.value = m;
  toonAlleBoekingen = false;
  renderBank();
}

export function toonAlleBankBoekingen() { toonAlleBoekingen = true; renderBank(); }

/** Tabbladen per maand en, bij 'Totaal', een overzicht met één regel per maand. */
function tekenMaandNavigatie(bron, maand) {
  const tabs = el('bank-maandtabs');
  const ov = el('bank-maandoverzicht');
  const kaart = el('bank-lijstkaart');
  if (!tabs || !ov) return;
  const perMaand = new Map();
  for (const t of bron) {
    const m = t.datum.slice(0, 7);
    if (!perMaand.has(m)) perMaand.set(m, { n: 0, ink: 0, uit: 0, prive: 0 });
    const g = perMaand.get(m); g.n++;
    if (isInkomst(t)) g.ink += t.bedrag;
    else if (isUitgave(t)) g.uit += t.bedrag;
    else if (t.type === 'prive_storting') g.prive += t.bedrag;
    else if (t.type === 'prive_opname') g.prive -= t.bedrag;
  }
  const maanden = [...perMaand.keys()].sort();
  const kort = m => `${MND_KORT[Number(m.slice(5, 7)) - 1]}${maanden.some(x => x.slice(0, 4) !== m.slice(0, 4)) ? ' ' + m.slice(2, 4) : ''}`;
  tabs.innerHTML = `<button class="vtab${maand === '' ? ' active' : ''}" type="button" onclick="kiesBankMaand('')">Totaal</button>` +
    maanden.map(m => `<button class="vtab${m === maand ? ' active' : ''}" type="button" onclick="kiesBankMaand('${m}')" title="${perMaand.get(m).n} boekingen">${kort(m)}</button>`).join('');

  if (maand === '') {
    const tot = { n: 0, ink: 0, uit: 0, prive: 0 };
    maanden.forEach(m => { const g = perMaand.get(m); tot.n += g.n; tot.ink += g.ink; tot.uit += g.uit; tot.prive += g.prive; });
    const rij = (label, g, klik, vet = false) => `<tr${klik ? ` class="row-click" onclick="kiesBankMaand('${klik}')" style="cursor:pointer"` : ' style="font-weight:600;background:var(--accent-softer)"'}>
      <td style="padding-left:16px${vet ? ';font-weight:600' : ''}">${label}</td><td style="text-align:right">${g.n}</td>
      <td style="text-align:right" class="pos">${fmt(g.ink)}</td><td style="text-align:right" class="neg">${fmt(g.uit)}</td>
      <td style="text-align:right" class="${g.ink - g.uit >= 0 ? 'pos' : 'neg'}">${fmt(g.ink - g.uit)}</td>
      <td style="text-align:right;padding-right:16px">${fmt(g.prive)}</td></tr>`;
    ov.innerHTML = `<div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th style="padding-left:16px">Maand</th><th style="text-align:right">Boekingen</th><th style="text-align:right">Inkomsten</th>
        <th style="text-align:right">Uitgaven</th><th style="text-align:right">Resultaat</th><th style="text-align:right;padding-right:16px">Privé (netto)</th></tr></thead>
      <tbody>${maanden.map(m => rij(maandLabel(m), perMaand.get(m), m)).join('')}${rij('Totaal', tot, '')}</tbody></table></div></div>
      ${toonAlleBoekingen ? '' : `<div style="margin-bottom:var(--spacing-4)"><button class="btn" onclick="toonAlleBankBoekingen()">Alle ${tot.n} boekingen tonen</button>
      <span class="muted" style="font-size:12px;margin-left:8px">Of klik op een maand.</span></div>`}`;
    if (kaart) kaart.style.display = toonAlleBoekingen ? '' : 'none';
  } else {
    ov.innerHTML = '';
    if (kaart) kaart.style.display = '';
  }
}

export function renderBank() {
  const jaar = state.huidigJaar || lopendJaar();
  const bron = bronVoorJaar(jaar);
  vulMaandSelect(el('f-maand'), bron);
  if (!bankBegonnen.has(jaar) && el('f-maand').value === '') {
    bankBegonnen.add(jaar);
    const laatste = [...new Set(bron.map(t => t.datum.slice(0, 7)))].sort().pop();
    if (laatste && jaar !== 'all') el('f-maand').value = laatste;
  }
  vulRekeningFilter();

  const maand = el('f-maand').value;
  const rek = el('f-rek').value;
  const typeF = el('f-type').value;

  tekenMaandNavigatie(bron, maand);

  const lijst = bron.filter(t => {
    if (maand && !t.datum.startsWith(maand)) return false;
    if (rek && t.rek !== rek) return false;
    if (typeF === 'prive' && !t.type.startsWith('prive')) return false;
    if (typeF === 'inkomst' && t.type !== 'inkomst') return false;
    if (typeF === 'uitgave' && t.type !== 'uitgave') return false;
    return true;
  }).sort((a, b) => b.datum.localeCompare(a.datum));

  const inkomsten = lijst.filter(isInkomst).reduce((s, t) => s + t.bedrag, 0);
  const uitgaven = lijst.filter(isUitgave).reduce((s, t) => s + t.bedrag, 0);
  const resultaat = inkomsten - uitgaven;
  const priveOp = lijst.filter(t => t.type === 'prive_opname').reduce((s, t) => s + t.bedrag, 0);
  const priveSt = lijst.filter(t => t.type === 'prive_storting').reduce((s, t) => s + t.bedrag, 0);

  // Bekende eindsaldi van de bankrekening. Bij "alle jaren" is er geen
  // afgebakende periode, dus dan blijven deze twee kaarten leeg.
  let saldo = null, vorigSaldo = null, saldoLabel, vorigLabel;
  if (maand) {
    saldo = saldoEindeMaand(maand);
    vorigSaldo = saldoEindeMaand(vorigeMaand(maand));
    saldoLabel = `Saldo eind ${maandLabel(maand)}`;
    vorigLabel = 'Saldo vorige maand';
  } else if (jaar !== 'all') {
    saldo = eindsaldoVanJaar(jaar);
    vorigSaldo = eindsaldoVanJaar(String(Number(jaar) - 1));
    saldoLabel = `Saldo eind ${jaar}`;
    vorigLabel = `Saldo eind ${Number(jaar) - 1}`;
  } else {
    saldoLabel = 'Saldo';
    vorigLabel = 'Saldo vorige periode';
  }

  const saldoKaart = (label, bedrag, sub) => `
    <div class="metric">
      <div class="lbl">${esc(label)}</div>
      <div class="val ${bedrag == null ? 'muted' : bedrag >= 0 ? 'pos' : 'neg'}">${bedrag == null ? '—' : fmt(bedrag)}</div>
      <div class="sub">${esc(sub)}</div>
    </div>`;

  // Fase 3A: Show pending queue badge if items waiting for sync
  const pendingCount = Object.keys(pendingQueue).length;
  const metrics = el('bank-metrics');
  if (pendingCount > 0 && metrics && metrics.parentNode) {
    let badge = el('pending-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pending-badge';
      badge.className = 'alert alert-warn';
      metrics.parentNode.insertBefore(badge, metrics);
    }
    badge.textContent = `⏳ ${pendingCount} wijziging(en) wachten op synchronisatie`;
  } else {
    const badge = el('pending-badge');
    if (badge) badge.remove();
  }

  el('bank-metrics').innerHTML = `
    <div class="metric"><div class="lbl">Privé gestort</div><div class="val pos">${fmt(priveSt)}</div><div class="sub">${lijst.filter(t => t.type === 'prive_storting').length} keer</div></div>
    <div class="metric"><div class="lbl">Privé opgenomen</div><div class="val neg">${fmt(priveOp)}</div><div class="sub">${lijst.filter(t => t.type === 'prive_opname').length} keer</div></div>
    <div class="metric"><div class="lbl">Inkomsten periode</div><div class="val pos">${fmt(inkomsten)}</div><div class="sub">${lijst.filter(t => t.type === 'inkomst').length} transacties</div></div>
    <div class="metric"><div class="lbl">Uitgaven periode</div><div class="val neg">${fmt(uitgaven)}</div><div class="sub">${lijst.filter(t => t.type === 'uitgave').length} transacties</div></div>
    <div class="metric"><div class="lbl">Winst / verlies</div><div class="val ${resultaat >= 0 ? 'pos' : 'neg'}">${resultaat >= 0 ? '+' : ''}${fmt(resultaat)}</div><div class="sub">zakelijk netto</div></div>
    ${saldoKaart(saldoLabel, saldo, 'eindbalans rekening')}
    ${saldoKaart(vorigLabel, vorigSaldo, 'vorige periode')}`;

  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();
  el('bank-body').innerHTML = lijst.length
    ? lijst.map(t => `<tr class="row-click" data-id="${esc(t.id)}">
        <td class="muted" style="padding-left:16px" data-v="${t.datum}">${ddmm(t.datum)}</td>
        <td class="td-trunc">${esc(weergaveNaam(t))}${heeftBonnetje(t.id) ? ' <span title="Heeft een bijlage" aria-label="Heeft een bijlage">📎</span>' : ''}${t.omschr && t.omschr !== t.naam
          ? ` <span style="color:var(--text-muted);font-size:10px">· ${esc(t.omschr)}</span>` : ''}</td>
        <td data-v="${esc(t.gb)}"><span class="gbnr">${esc(t.gb)}</span> ${esc(GBNM[t.gb] || '')}</td>
        <td data-v="${esc(t.rek)}">${rekBadge(t.rek, REKNM[t.rek])}</td>
        <td style="text-align:right;padding-right:16px" data-v="${t.bedrag}">${typeBadge(t.type, t.bedrag)}</td>
      </tr>`).join('')
    : `<tr data-geen-sort="1"><td colspan="5">${leegVlak(
        bron.length ? 'Geen transacties binnen deze filters' : 'Nog geen transacties in dit jaar',
        bron.length ? 'Kies een andere maand, rekening of soort mutatie.' : 'Importeer je Excel-bestand of voeg handmatig een transactie toe.',
        '<button class="btn" onclick="openTxModal()">Transactie toevoegen</button>')}</td></tr>`;

  maakSorteerbaar(el('tbl-bank'));
}

// -------------------------------------------------------------------- modal

/** Zoekt een boeking in het lopende jaar én in de historische jaren. */
function vindTx(id) {
  const inTX = state.TX.find(t => String(t.id) === String(id));
  if (inTX) return { tx: inTX, historisch: false };
  const inHist = state.HIST_TX.find(t => String(t.id) === String(id));
  return inHist ? { tx: inHist, historisch: true } : null;
}

/**
 * Opent een bestaande boeking om te bewerken. Wordt aangeroepen vanuit het
 * detailpaneel en vanaf de controlepagina, zodat je een gevonden fout meteen
 * kunt herstellen zonder hem eerst te moeten opzoeken.
 */
export function bewerkBoeking(id) {
  const gevonden = vindTx(id);
  if (!gevonden) return;
  const { tx, historisch } = gevonden;

  state.editTxId = tx.id;
  el('tx-modal-title').textContent = historisch ? `Boeking bewerken (${tx.datum.slice(0, 4)})` : 'Boeking bewerken';
  el('tx-save-btn').textContent = 'Opslaan';
  el('tx-delete-btn').style.display = 'block'; // Toon delete-knop in edit mode
  el('tx-d').value = tx.datum || '';
  el('tx-b').value = tx.bedrag != null ? String(tx.bedrag).replace('.', ',') : '';
  el('tx-n').value = tx.naam || '';
  el('tx-o').value = tx.omschr || '';
  el('tx-t').value = tx.type || 'uitgave';
  vulRekeningSelect(el('tx-rek'), tx.rek);
  vulGrootboekSelect(el('tx-gb'), tx.gb);
  el('tx-btw-pct').value = tx.btw_percentage != null ? String(tx.btw_percentage) : '21';
  el('tx-fout').textContent = '';
  el('modal-tx').classList.add('open');
  startModalBonnetjes();
  syncTxBtw();
  el('tx-b').focus();
}

export function openTxModal() {
  state.editTxId = null;
  el('tx-modal-title').textContent = 'Transactie toevoegen';
  el('tx-save-btn').textContent = 'Opslaan';
  el('tx-delete-btn').style.display = 'none'; // Verberg delete-knop in add mode
  el('tx-d').value = new Date().toISOString().split('T')[0];
  el('tx-b').value = '';
  el('tx-n').value = '';
  el('tx-o').value = '';
  vulRekeningSelect(el('tx-rek'), '1010');
  vulGrootboekSelect(el('tx-gb'), '');
  el('tx-btw-pct').value = '21';
  el('tx-fout').textContent = '';
  el('modal-tx').classList.add('open');
  startModalBonnetjes();
  syncTxBtw();
  el('tx-d').focus();
}

export function closeTx() { el('modal-tx').classList.remove('open'); sluitModalBonnetjes(); }

/**
 * Fase 2 van BTW-plichtig maken: het BTW-blok in het boeking-formulier
 * toont/verbergt zich en herberekent zichzelf, puur op basis van wat er op
 * dit moment in #tx-d en #tx-b staat — nooit op basis van iets dat ooit werd
 * opgeslagen. Dat is bewust: zo werkt het ook goed als je tijdens het
 * bewerken de datum over de omslagdatum heen schuift, in beide richtingen.
 * Het bedrag in #tx-b blijft, zoals nu al overal in de app, het volledige
 * (inclusief) bedrag — het BTW-bedrag wordt eruit herekend, niet erbij opgeteld.
 *
 * Alleen bij isInkomst()/isUitgave() — nooit bij een privé-soort, ook niet
 * op een BTW-plichtige datum. Een privé-opname/storting is geen zakelijke
 * omzet of inkoop en draagt nooit BTW.
 */
export function syncTxBtw() {
  const blok = el('tx-btw-blok');
  if (!blok) return;
  const soort = { type: el('tx-t').value };
  const magBtw = (isInkomst(soort) || isUitgave(soort)) && isBtwPlichtig(el('tx-d').value);
  if (!magBtw) {
    blok.style.display = 'none';
    return;
  }
  blok.style.display = '';
  const bedrag = bedragUit('tx-b', 0);
  const pct = Number(el('tx-btw-pct').value) || 0;
  const btw = pct > 0 ? bedrag * pct / (100 + pct) : 0;
  el('tx-btw-bedrag').textContent = fmt(btw);
}

/**
 * Verwijdert een bestaande boeking na bevestiging.
 * Alleen beschikbaar wanneer je een boeking aan het bewerken bent (state.editTxId is ingesteld).
 */
export function deleteTx() {
  if (state.editTxId == null) {
    console.warn('Geen boeking geselecteerd voor verwijdering');
    return;
  }

  const gevonden = vindTx(state.editTxId);
  if (!gevonden) {
    el('tx-fout').textContent = 'Boeking niet gevonden. Vernieuw de pagina.';
    return;
  }

  const { tx, historisch } = gevonden;
  const berichtDatum = tx.datum ? ` (${tx.datum})` : '';
  const berichtBedrag = tx.bedrag ? ` – €${tx.bedrag}` : '';

  // Een boeking waar een factuur naar verwijst blijft anders "betaald" tonen
  // terwijl de onderliggende betaling niet meer bestaat — dus eerst
  // waarschuwen, en bij doorzetten de koppeling netjes losmaken.
  const gekoppeld = facturenBijBoeking(tx.id);
  const koppelWaarschuwing = gekoppeld.length
    ? `\n\n⚠️ Gekoppeld aan ${gekoppeld.length > 1 ? gekoppeld.length + ' facturen' : 'de factuur'}: ` +
      gekoppeld.map(f => `${f.factuurnummer || f.id} (${f.relatie || '(geen relatie)'}, ${fmt(f.bedrag)})`).join(', ') +
      `.\nBij verwijderen wordt die koppeling losgemaakt en komt ${gekoppeld.length > 1 ? 'ze' : 'die'} weer op "openstaand" te staan.`
    : '';

  if (jaarIsVergrendeld(tx.datum) && !window.confirm(
    `🔒 Het jaar ${String(tx.datum).slice(0, 4)} is vergrendeld (aangifte ingediend).\n\nDeze boeking verwijderen verandert de cijfers van dat jaar. Toch doorgaan?`)) {
    return;
  }

  // Vraag duidelijke bevestiging
  const bevestiging = window.confirm(
    `⚠️ BOEKING VERWIJDEREN\n\n` +
    `${tx.naam}${berichtBedrag}${berichtDatum}${koppelWaarschuwing}\n\n` +
    `Deze actie kan niet ongedaan gemaakt worden.\n` +
    `Weet je zeker dat je deze boeking wilt verwijderen?`
  );

  if (!bevestiging) {
    return; // Gebruiker heeft geannuleerd
  }

  ontkoppelAlleFacturenVanBoeking(tx.id);

  // Verwijder uit TX of HIST_TX (hard delete lokaal)
  if (historisch) {
    state.HIST_TX = state.HIST_TX.filter(t => String(t.id) !== String(state.editTxId));
    saveHistTxData();
  } else {
    state.TX = state.TX.filter(t => String(t.id) !== String(state.editTxId));
    saveTxData();
  }

  // Fase 3A: Add to pending queue for Supabase soft delete
  addToPendingQueue({ id: state.editTxId }, 'delete', historisch, 'boeking');
  
  // Fase 3A: Try Supabase sync (async, non-blocking)
  if (isSupabaseReady()) {
    syncPendingQueue().catch(err => {
      console.warn('Supabase delete sync failed (will retry):', err);
    });
  }

  // Reset modal state
  state.editTxId = null;
  closeTx();

  // Herlaad de tabel zodat totalen direct kloppen
  renderBank();
}

// Voorkomt dat type (privé storting/opname) en grootboek (600/601) uit elkaar
// kunnen lopen — dat was de oorzaak van een foutieve privé-boeking in de data
// (2023: gb=601 "opname" maar type "storting").
export function syncTxGrootboek() {
  const type = el('tx-t').value;
  if (type === 'prive_storting') el('tx-gb').value = '600';
  else if (type === 'prive_opname') el('tx-gb').value = '601';
  // Wisselt de soort van/naar privé, dan moet het BTW-blok meteen mee —
  // niet pas nadat ook de datum nog een keer wordt aangeraakt.
  syncTxBtw();
}

export function saveTx() {
  const datum = el('tx-d').value;
  const bedrag = bedragUit('tx-b', NaN);
  const fout = el('tx-fout');

  // Een boeking zonder geldige datum of met een bedrag van nul of minder maakt
  // alle latere totalen onbetrouwbaar, dus die weigeren we hier.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) { fout.textContent = 'Vul een geldige datum in.'; el('tx-d').focus(); return; }
  if (isNaN(bedrag) || bedrag <= 0) { fout.textContent = 'Vul een bedrag groter dan nul in. Of het bij- of afgaat bepaal je met de soort.'; el('tx-b').focus(); return; }
  fout.textContent = '';

  // Ingediende jaren: pas na een extra bevestiging wijzigen (oude of nieuwe datum).
  const oud = state.editTxId != null ? vindTx(state.editTxId) : null;
  if ((jaarIsVergrendeld(datum) || (oud && jaarIsVergrendeld(oud.tx.datum))) &&
      !window.confirm('🔒 Dit jaar is vergrendeld (aangifte ingediend).\n\nDeze wijziging verandert de cijfers van dat jaar. Toch opslaan?')) {
    return;
  }

  let type = el('tx-t').value;
  let gb = el('tx-gb').value;
  // Laatste vangnet: gb en type mogen nooit tegenstrijdig zijn bij privé.
  if (type === 'prive_storting') gb = '600';
  else if (type === 'prive_opname') gb = '601';
  else if (gb === '600') type = 'prive_storting';
  else if (gb === '601') type = 'prive_opname';

  const tx = {
    id: state.editTxId || state.nxtTx++,
    datum,
    bedrag: Math.round(bedrag * 100) / 100,
    naam: el('tx-n').value.trim(),
    omschr: el('tx-o').value.trim(),
    type,
    rek: el('tx-rek').value,
    gb
  };

  // BTW-plicht fase 2: alleen toevoegen als DEZE datum, op dit moment, onder
  // de BTW-plicht valt — nooit op basis van wat ooit werd ingevuld of van wat
  // het blok toonde vóórdat de datum nog werd gewijzigd. Zo blijft een
  // boeking vóór de omslagdatum byte voor byte hetzelfde object als altijd,
  // en volgt een boeking die tijdens het bewerken over de grens heen
  // verschuift altijd de datum die nu in het formulier staat. En alleen bij
  // isInkomst()/isUitgave() — nooit bij een privé-soort, ook niet als de
  // datum op zichzelf wél onder de BTW-plicht valt.
  if ((isInkomst(tx) || isUitgave(tx)) && isBtwPlichtig(datum)) {
    const btwPct = Number(el('tx-btw-pct').value) || 0;
    tx.btw_percentage = btwPct;
    tx.btw_bedrag = btwPct > 0 ? Math.round((tx.bedrag * btwPct / (100 + btwPct)) * 100) / 100 : 0;
  }

  let isHistoric = false;

  if (state.editTxId != null) {
    // Een historische boeking hoort in HIST_TX te blijven staan, anders zou hij
    // naar 2026 verhuizen en uit de jaaroverzichten van dat jaar verdwijnen.
    const bestaand = vindTx(state.editTxId);
    isHistoric = bestaand && bestaand.historisch;

    // Een handmatig aangemaakte boeking blijft ook na bewerken handmatig,
    // anders verliest hij zijn bescherming tegen een latere Excel-import.
    if (bestaand && bestaand.tx.bron === 'handmatig') tx.bron = 'handmatig';

    if (isHistoric) {
      state.HIST_TX = state.HIST_TX.map(t => (String(t.id) === String(state.editTxId) ? tx : t));
      saveHistTxData();
    } else {
      state.TX = state.TX.map(t => (String(t.id) === String(state.editTxId) ? tx : t));
      saveTxData();
    }
    
    // Fase 3A: Add to pending queue for Supabase sync
    addToPendingQueue(tx, 'update', isHistoric);
    
  } else {
    // Een gloednieuwe boeking is per definitie handmatig aangemaakt. Dat
    // label beschermt hem later tegen een Excel-import die dit jaar vervangt.
    tx.bron = 'handmatig';
    state.TX.push(tx);
    saveTxData();

    // Fase 3A: Add to pending queue for Supabase sync
    addToPendingQueue(tx, 'create', false);
  }
  
  bewaarWachtende(tx.id);   // bonnetjes die bij een nieuwe boeking zijn gekozen
  closeTx();
  
  // Fase 3A: Try Supabase sync (async, non-blocking)
  if (isSupabaseReady()) {
    syncPendingQueue().catch(err => {
      console.warn('Supabase sync failed (will retry):', err);
    });
  }

  // Een nieuwe boeking valt in het lopende jaar; sta je in een ander jaar te
  // kijken, dan zou hij anders ongemerkt buiten beeld vallen. Dit stond vast
  // op 2026 en zou vanaf 1 januari verkeerd gaan.
  const nieuwJaar = jaarVan(tx.datum);
  if (state.editTxId == null && state.huidigJaar !== nieuwJaar && state.huidigJaar !== 'all'
      && el('jaar-selector') && [...el('jaar-selector').options].some(o => o.value === nieuwJaar)) {
    state.huidigJaar = nieuwJaar;
    el('jaar-selector').value = nieuwJaar;
    el('f-maand').value = '';
  }
  state.editTxId = null;
  renderBank();
}
