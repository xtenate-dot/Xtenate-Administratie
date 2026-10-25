// bankimport.js — Revolut-afschrift (CSV) inlezen en als voorstel tonen.
//
// Er wordt niets geboekt voordat je op "Importeer" klikt. Boekingen die al in
// de administratie staan (zelfde datum, bedrag en richting) worden herkend en
// niet nog eens voorgesteld. Grootboek en soort worden afgeleid uit eerdere
// boekingen met dezelfde naam; wat onbekend is kies je zelf.

import { state, saveTxData, jaarIsVergrendeld } from './storage.js?v=20261024w';
import { isTxJaar, jaarVan, EERSTE_TX_JAAR, vandaagIso } from './jaren.js?v=20261024w';
import { esc, fmt } from './helpers.js?v=20261024w';
import { addToPendingQueue } from './supabase-client-v2.js?v=20261024w';
import { maakHerstelpunt } from './herstelpunt.js?v=20261024w';
import { telInbox, haalInboxOp, zetInboxStatus } from './bankinbox.js?v=20261024w';

const REK = '1010';          // zo staat Revolut nu in je administratie
const el = id => document.getElementById(id);
let voorstel = null;         // { bestand, rijen, ontbreekt, overgeslagen }
let melding = '';
let inboxAantal = null;     // aantal nieuwe regels in de inbox (null = onbekend)
let inboxGelezen = 0;       // tijdstip van de laatste telling
let inboxKaart = new Map(); // voorstelsleutel -> id van de inboxregel (alleen als het voorstel uit de inbox komt)
let inBehandeling = [];   // bankregels die de bank nog niet definitief heeft geboekt (alleen tonen, niet boeken)

// ----------------------------------------------------------------- inlezen

/** Eenvoudige CSV-lezer met aanhalingstekens en komma's in velden. */
export function leesCsv(tekst) {
  const rijen = []; let rij = [], veld = '', inQ = false;
  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];
    if (inQ) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i++; } else inQ = false; }
      else veld += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { rij.push(veld); veld = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && tekst[i + 1] === '\n') i++;
      rij.push(veld); veld = '';
      if (rij.length > 1 || rij[0] !== '') rijen.push(rij);
      rij = [];
    } else veld += c;
  }
  if (veld !== '' || rij.length) { rij.push(veld); rijen.push(rij); }
  return rijen;
}

const tel = x => { const n = Number(String(x).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

/** Zet Revolut-regels om naar neutrale rijen. Gooit een fout als het geen Revolut-bestand lijkt. */
export function leesRevolut(tekst) {
  const r = leesCsv(tekst.replace(/^﻿/, ''));
  if (!r.length) throw new Error('Het bestand is leeg.');
  const kop = r[0].map(x => x.trim());
  const nodig = ['Date started (UTC)', 'Type', 'State', 'Description', 'Total amount'];
  const ontbreekt = nodig.filter(n => !kop.includes(n));
  if (ontbreekt.length) throw new Error('Dit lijkt geen Revolut-afschrift (CSV). Ontbrekende kolommen: ' + ontbreekt.join(', '));
  const k = n => kop.indexOf(n);
  const rijen = [], overgeslagen = [];
  for (const v of r.slice(1)) {
    if (v.length < kop.length - 3) continue;
    const g = n => (v[k(n)] || '').trim();
    const o = {
      id: g('ID'), datum: g('Date started (UTC)').slice(0, 10), soort: g('Type'), status: g('State'),
      omschrijving: g('Description'), referentie: g('Reference'),
      totaal: tel(g('Total amount')), saldo: tel(g('Balance')), begunstigde: g('Beneficiary name')
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.datum) || !Number.isFinite(o.totaal)) { overgeslagen.push({ ...o, reden: 'onleesbaar' }); continue; }
    if (o.status !== 'COMPLETED') { overgeslagen.push({ ...o, reden: 'niet afgerond (' + o.status + ')' }); continue; }
    rijen.push(o);
  }
  return { rijen, overgeslagen };
}

// ------------------------------------------------------------ voorstel maken

const sleutel = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const richtingPlus = t => t.type === 'inkomst' || t.type === 'prive_storting';
const eigen = t => `${t.datum}|${Math.round(t.bedrag * 100)}|${richtingPlus(t) ? '+' : '-'}`;

/** Alle eerdere boekingen op deze rekening met een naam, oud naar nieuw. */
function geleerd() {
  const alle = [...state.HIST_TX, ...state.TX].filter(t => t.rek === REK && t.naam && t.gb);
  alle.sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  return alle.map(t => ({ sleutel: sleutel(t.naam), eerste: sleutel(String(t.naam).split(/[\s*]/)[0]), naam: t.naam, gb: String(t.gb), type: t.type, plus: richtingPlus(t) }));
}

/**
 * Zoekt een eerdere boeking met dezelfde naam. Alleen boekingen in dezelfde
 * richting (bij of af) tellen mee, en de beste overeenkomst wint: eerst
 * dezelfde naam, dan een naam die erin zit, dan hetzelfde eerste woord. Bij
 * gelijke overeenkomst de nieuwste.
 */
function zoekGeleerd(lijst, naam, plus) {
  const s = sleutel(naam);
  if (!s) return null;
  const eerste = sleutel(String(naam).split(/[\s*]/)[0]);
  const passend = lijst.filter(x => x.plus === plus);
  const trap = [
    x => x.sleutel === s,
    x => x.sleutel.length >= 5 && s.length >= 5 && (x.sleutel.includes(s) || s.includes(x.sleutel)),
    x => eerste.length >= 5 && x.eerste === eerste
  ];
  for (const ok of trap) {
    const raak = passend.filter(ok);
    if (raak.length) return raak[raak.length - 1];
  }
  return null;
}

/** Naam van de tegenpartij uit een Revolut-regel. */
function tegenpartij(o) {
  const d = o.omschrijving;
  if (/^To /i.test(d)) return d.replace(/^To /i, '');
  if (/^Money added from /i.test(d)) return d.replace(/^Money added from /i, '');
  if (/^From /i.test(d)) return d.replace(/^From /i, '');
  return d;
}

const VASTE_REGELS = [
  { test: o => o.soort === 'FEE', naam: 'Revolutkosten', gb: '4350', type: 'uitgave' },
  { test: o => /→ Xtenate spaar/i.test(o.omschrijving), naam: 'Spaarrekening', gb: '1015', type: 'uitgave' },
  { test: o => /donders/i.test(o.omschrijving) && o.totaal > 0, naam: 'Prive storting', gb: '600', type: 'prive_storting' },
  { test: o => /^From Cas D/i.test(o.omschrijving), naam: 'Prive storting', gb: '600', type: 'prive_storting' },
  { test: o => /bolcom/i.test(o.omschrijving) && o.totaal > 0, naam: 'Bol.com', gb: '8010', type: 'inkomst' },
  { test: o => /online payment stichting/i.test(o.omschrijving) && o.totaal > 0, naam: 'Online Payment Stichting', gb: '8000', type: 'inkomst' },
  { test: o => /derdengelden hnvi/i.test(o.omschrijving) && o.totaal < 0, naam: 'HNVI', gb: '7010', type: 'uitgave' },
  { test: o => /aliexpress|alipay/i.test(o.omschrijving) && o.totaal < 0, naam: 'Aliexpress', gb: '7000', type: 'uitgave' }
];

export function maakVoorstel(uit, bestaand = [...state.TX, ...state.HIST_TX], bestandsnaam = '') {
  const kaart = geleerd();
  const eerder = new Map();
  for (const t of bestaand.filter(t => t.rek === REK)) {
    const s = eigen(t); eerder.set(s, (eerder.get(s) || []).concat(t));
  }
  const rijen = [];
  for (const o of uit.rijen) {
    const vast = VASTE_REGELS.find(r => r.test(o));
    const naamBron = tegenpartij(o);
    const leer = vast ? null : zoekGeleerd(kaart, naamBron, o.totaal > 0);
    const naam = vast ? vast.naam : (leer ? leer.naam : naamBron);
    let gb = vast ? vast.gb : (leer ? leer.gb : '');
    let type = vast ? vast.type : (leer ? leer.type : (o.totaal > 0 ? 'inkomst' : 'uitgave'));
    const rij = {
      sleutel: o.id, datum: o.datum, bedrag: Math.round(Math.abs(o.totaal) * 100) / 100,
      naam, omschr: o.referentie.slice(0, 80), type, gb, rek: REK,
      herkomst: vast ? 'vaste regel' : leer ? 'eerder zo geboekt' : 'onbekend', staatAl: false, kies: true
    };
    const s = eigen(rij);
    const lijst = eerder.get(s);
    if (lijst && lijst.length) { lijst.pop(); rij.staatAl = true; rij.kies = false; }
    rijen.push(rij);
  }
  // Wat in de app staat maar niet in het bestand, binnen dezelfde periode
  const data = uit.rijen.map(r => r.datum).sort();
  const van = uit.van || data[0], tot = uit.tot || data[data.length - 1];
  const ontbreekt = van ? [...eerder.values()].flat().filter(t => t.datum >= van && t.datum <= tot) : [];
  return { bestand: bestandsnaam, rijen, ontbreekt, overgeslagen: uit.overgeslagen, van, tot };
}

// ----------------------------------------------------------------------- UI

/** Zet transacties die de bank-koppeling heeft opgehaald om in hetzelfde voorstel als een CSV-afschrift. */
export function laadVoorstelUitBank(transacties, label = 'Bank (automatisch)', wachtend = [], bereik = {}) {
  inBehandeling = wachtend;
  inboxKaart = new Map();
  const rijen = transacties.map(t => {
    const naam = String(t.naam || '').trim();
    const tekst = naam || String(t.omschr || '').trim() || 'Onbekend';
    const fee = /fee|kosten|abonnement.*revolut|revolut.*abonnement/i.test(tekst) && /revolut/i.test(tekst);
    return {
      id: 'api:' + t.id, datum: t.datum, soort: fee ? 'FEE' : 'CARD_PAYMENT', status: 'COMPLETED',
      omschrijving: (t.totaal < 0 ? 'To ' : 'From ') + tekst, referentie: String(t.omschr || ''),
      totaal: Number(t.totaal), saldo: NaN, begunstigde: naam
    };
  }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.datum) && Number.isFinite(r.totaal));
  voorstel = maakVoorstel({ rijen, overgeslagen: [], van: bereik.van, tot: bereik.tot }, undefined, label);
  melding = bereik.opmerking || '';
  renderBankimport();
  const d0 = document.getElementById('bank-verwerken'); if (d0) d0.open = true;
}


/** Telt de inbox (hooguit eens per minuut) en tekent opnieuw als het aantal veranderd is. */
export async function ververseInbox(forceer = false) {
  if (!(state.BANK_KOPPELINGEN || []).length) return;
  if (!forceer && Date.now() - inboxGelezen < 60000) return;
  inboxGelezen = Date.now();
  const n = await telInbox();
  if (n !== inboxAantal) { inboxAantal = n; renderBankimport(); }
}

/** Zet de regels uit de inbox in het voorstel; boeken gebeurt pas bij "Importeer". */
export async function laadInboxVoorstel() {
  try {
    const rijen = await haalInboxOp();
    if (!rijen.length) { melding = 'De inbox is leeg.'; inboxAantal = 0; renderBankimport(); return; }
    const t = rijen.map(r => ({
      id: r.entry_reference, datum: r.datum, naam: r.naam, omschr: r.omschr,
      totaal: (r.richting === 'uitgave' ? -1 : 1) * Number(r.bedrag)
    }));
    laadVoorstelUitBank(t, 'Inbox (ochtendronde)', [], { opmerking: `Inbox: ${rijen.length} regels die de ochtendronde heeft opgehaald.` });
    inboxKaart = new Map(rijen.map(r => ['api:' + r.entry_reference, r.id]));
  } catch {
    melding = 'De inbox kon niet gelezen worden. Probeer het later opnieuw.';
    renderBankimport();
  }
}

// ------------------------------------------------------------ periodekeuze

const PERIODES = [
  ['recent', 'Laatste 45 dagen'], ['week', 'Deze week'], ['vorigeWeek', 'Vorige week'],
  ['maand', 'Deze maand'], ['vorigeMaand', 'Vorige maand'], ['kwartaal', 'Dit kwartaal'],
  ['vorigKwartaal', 'Vorig kwartaal'], ['jaar', 'Dit jaar'], ['vorigJaar', 'Vorig jaar'], ['eigen', 'Eigen periode…']
];
let periodeSoort = 'recent', eigenVan = '', eigenTot = '';

const isoDatum = d => d.toISOString().slice(0, 10);
const dag = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDatum(d); };

/** Begin- en einddatum (inclusief) van de gekozen periode; einde nooit na vandaag. */
export function periodeBereik(soort = periodeSoort) {
  const nu = vandaagIso();
  const j = Number(nu.slice(0, 4)), m = Number(nu.slice(5, 7));
  const maandStart = (jj, mm) => `${jj}-${String(mm).padStart(2, '0')}-01`;
  const maandEinde = (jj, mm) => isoDatum(new Date(Date.UTC(jj, mm, 0, 12)));
  let van = null, tot = null;
  if (soort === 'week' || soort === 'vorigeWeek') {
    const wd = (new Date(nu + 'T12:00:00Z').getUTCDay() + 6) % 7;      // maandag = 0
    van = dag(nu, -wd - (soort === 'vorigeWeek' ? 7 : 0)); tot = dag(van, 6);
  } else if (soort === 'maand') { van = maandStart(j, m); tot = maandEinde(j, m); }
  else if (soort === 'vorigeMaand') { const pj = m === 1 ? j - 1 : j, pm = m === 1 ? 12 : m - 1; van = maandStart(pj, pm); tot = maandEinde(pj, pm); }
  else if (soort === 'kwartaal' || soort === 'vorigKwartaal') {
    let q = Math.floor((m - 1) / 3), jj = j;
    if (soort === 'vorigKwartaal') { q -= 1; if (q < 0) { q = 3; jj -= 1; } }
    van = maandStart(jj, q * 3 + 1); tot = maandEinde(jj, q * 3 + 3);
  } else if (soort === 'jaar') { van = `${j}-01-01`; tot = `${j}-12-31`; }
  else if (soort === 'vorigJaar') { van = `${j - 1}-01-01`; tot = `${j - 1}-12-31`; }
  else if (soort === 'eigen') { van = eigenVan || null; tot = eigenTot || null; }
  if (tot && tot > nu) tot = nu;
  return { soort, van, tot };
}

export function zetPeriode(soort) { periodeSoort = soort; renderBankimport(); }
export function zetEigenPeriode(veld, waarde) { if (veld === 'van') eigenVan = waarde; else eigenTot = waarde; }

/** Klapt het blok "Bank verwerken" op de Bank-pagina open en scrolt ernaartoe. */
export function openBankVerwerken() {
  const d = document.getElementById('bank-verwerken');
  if (!d) return;
  d.open = true;
  renderBankimport();
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.openBankVerwerken = openBankVerwerken;
window.zetPeriode = zetPeriode;
window.laadInboxVoorstel = laadInboxVoorstel;
window.zetEigenPeriode = zetEigenPeriode;

export function kiesRevolutBestand() {
  const veld = el('bankimport-bestand');
  if (veld) { veld.value = ''; veld.click(); }
}

export async function leesRevolutBestand(event) {
  const f = event.target.files && event.target.files[0];
  if (!f) return;
  try {
    const uit = leesRevolut(await f.text());
    inboxKaart = new Map();
    voorstel = maakVoorstel(uit, undefined, f.name);
    melding = '';
  } catch (e) { voorstel = null; melding = '❌ ' + e.message; }
  renderBankimport();
}

export function zetBankimportKeuze(i, veld, waarde) {
  const r = voorstel && voorstel.rijen[i];
  if (!r) return;
  if (veld === 'kies') r.kies = !!waarde;
  if (veld === 'gb') {
    r.gb = waarde;
    if (waarde === '600') r.type = 'prive_storting';
    else if (waarde === '601') r.type = 'prive_opname';
    else if (r.type === 'prive_storting' || r.type === 'prive_opname') r.type = r.type === 'prive_storting' ? 'inkomst' : 'uitgave';
  }
  if (veld === 'type') r.type = waarde;
  renderBankimport();
}

/** Haalt een regel helemaal uit het voorstel (bijvoorbeeld een dubbele of een storno). */
export function verwijderBankimportRegel(i) {
  if (!voorstel || !voorstel.rijen[i]) return;
  const weg = voorstel.rijen.splice(i, 1)[0];
  const inboxId = weg && inboxKaart.get(weg.sleutel);
  if (inboxId) { zetInboxStatus([inboxId], 'genegeerd').then(() => { inboxAantal = null; inboxGelezen = 0; }); }
  renderBankimport();
}

export function importeerRevolut() {
  if (!voorstel) return;
  const teDoen = voorstel.rijen.filter(r => r.kies && !r.staatAl);
  const zonderGb = teDoen.filter(r => !r.gb);
  if (zonderGb.length) { melding = `❌ ${zonderGb.length} regels hebben nog geen grootboekrekening. Kies er een of haal het vinkje weg.`; renderBankimport(); return; }
  const buitenJaar = teDoen.filter(r => !isTxJaar(jaarVan(r.datum)));
  if (buitenJaar.length) { melding = `❌ ${buitenJaar.length} regels zijn van vóór ${EERSTE_TX_JAAR}. Oudere jaren importeer je via de Excel-import.`; renderBankimport(); return; }
  if (!teDoen.length) {
    const al = voorstel.rijen.filter(r => r.staatAl && inboxKaart.has(r.sleutel)).map(r => inboxKaart.get(r.sleutel));
    if (al.length) { zetInboxStatus(al, 'omgezet').then(() => { inboxAantal = null; inboxGelezen = 0; ververseInbox(true); }); }
    melding = 'Er is niets nieuws om te importeren.' + (al.length ? ` ${al.length} regels uit de inbox stonden al in de administratie en zijn afgehandeld.` : '');
    renderBankimport(); return;
  }
  const jarenTekst = [...new Set(teDoen.map(r => jaarVan(r.datum)))].sort().join(' en ');
  const vergrendeld = [...new Set(teDoen.map(r => jaarVan(r.datum)))].filter(j => jaarIsVergrendeld(j));
  if (vergrendeld.length && !window.confirm(`🔒 ${vergrendeld.join(' en ')} is vergrendeld (aangifte ingediend). Deze import verandert de cijfers van dat jaar. Toch doorgaan?`)) return;
  if (!window.confirm(`${teDoen.length} boekingen toevoegen aan ${jarenTekst}?`)) return;

  maakHerstelpunt('vóór Revolut-import');
  for (const r of teDoen) {
    const tx = { id: state.nxtTx++, datum: r.datum, bedrag: r.bedrag, naam: r.naam, omschr: r.omschr, type: r.type, rek: r.rek, gb: r.gb, bron: 'handmatig' };
    state.TX.push(tx);
    addToPendingQueue(tx, 'create', false);
  }
  saveTxData();
  // Regels uit de inbox die nu geboekt zijn (of er al stonden) tellen niet meer mee.
  const klaar = voorstel.rijen.filter(r => inboxKaart.has(r.sleutel) && (r.staatAl || r.kies)).map(r => inboxKaart.get(r.sleutel));
  if (klaar.length) zetInboxStatus(klaar, 'omgezet').then(() => { inboxAantal = null; inboxGelezen = 0; ververseInbox(true); });
  inboxKaart = new Map();
  melding = `✅ ${teDoen.length} boekingen toegevoegd.`;
  voorstel = null;
  renderBankimport();
  window.hertekenHuidigePagina?.();
}

const SOORTEN = [['inkomst', 'Inkomst'], ['uitgave', 'Uitgave'], ['prive_storting', 'Privé-storting'], ['prive_opname', 'Privé-opname']];

export function renderBankimport() {
  const doel = el('bankimport-inhoud');
  if (!doel) return;
  setTimeout(() => ververseInbox(), 0);
  const knop = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:var(--spacing-4)">
    <button class="btn btn-primary" onclick="kiesRevolutBestand()">Revolut-afschrift kiezen (CSV)</button>
    ${(state.BANK_KOPPELINGEN || []).length ? `
      <select onchange="zetPeriode(this.value)" aria-label="Periode" style="font-size:13px">${PERIODES.map(([w, l]) => `<option value="${w}"${w === periodeSoort ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${periodeSoort === 'eigen' ? `<input type="date" value="${esc(eigenVan)}" onchange="zetEigenPeriode('van',this.value)" aria-label="Van"> <span class="muted">t/m</span> <input type="date" value="${esc(eigenTot)}" onchange="zetEigenPeriode('tot',this.value)" aria-label="Tot">` : ''}
      <button class="btn" onclick="haalBankTransactiesOp()">Ophalen bij de bank</button>
      ${inboxAantal ? `<button class="btn btn-primary" onclick="laadInboxVoorstel()" title="Regels die de ochtendronde automatisch heeft opgehaald">📥 Inbox (${inboxAantal} nieuw)</button>` : ''}` : ''}
    <span class="muted" style="font-size:12px">In Revolut: Rekeningen → Afschrift → CSV, voor de periode die je wilt.</span>
    ${melding ? `<span style="font-size:13px">${esc(melding)}</span>` : ''}</div>`;
  if (!voorstel) {
    doel.innerHTML = knop + `<div class="card"><p>Kies een afschrift. Je ziet eerst een voorstel; er wordt niets geboekt tot je op Importeer klikt.
      Boekingen die er al staan worden herkend en overgeslagen.</p></div>`;
    return;
  }
  const gb = state.GROOTBOEK || [];
  const optGb = sel => `<option value="">— kies —</option>` + gb.map(g => `<option value="${esc(g.nummer)}"${String(g.nummer) === String(sel) ? ' selected' : ''}>${esc(g.nummer)} ${esc(g.naam)}</option>`).join('');
  const optType = sel => SOORTEN.map(([w, l]) => `<option value="${w}"${w === sel ? ' selected' : ''}>${l}</option>`).join('');

  const nieuw = voorstel.rijen.filter(r => !r.staatAl);
  const kies = nieuw.filter(r => r.kies);
  const rijen = voorstel.rijen.map((r, i) => r.staatAl
    ? `<tr style="opacity:.55"><td></td><td>${esc(r.datum.slice(8, 10) + '-' + r.datum.slice(5, 7))}</td><td>${esc(r.naam)}</td>
        <td style="text-align:right">${fmt(r.bedrag)}</td><td colspan="2" class="muted">staat al in de administratie</td><td></td></tr>`
    : `<tr><td><input type="checkbox" ${r.kies ? 'checked' : ''} onchange="zetBankimportKeuze(${i},'kies',this.checked)"></td>
        <td>${esc(r.datum.slice(8, 10) + '-' + r.datum.slice(5, 7))}</td>
        <td>${esc(r.naam)}<div class="muted" style="font-size:11px">${esc(r.herkomst)}</div></td>
        <td style="text-align:right">${fmt(r.bedrag)}</td>
        <td><select onchange="zetBankimportKeuze(${i},'gb',this.value)" style="font-size:12px;max-width:190px"${!r.gb ? ' class="input-fout"' : ''}>${optGb(r.gb)}</select></td>
        <td><select onchange="zetBankimportKeuze(${i},'type',this.value)" style="font-size:12px">${optType(r.type)}</select></td>
        <td><button class="btn btn-sm btn-ghost" title="Deze regel uit het voorstel halen" onclick="verwijderBankimportRegel(${i})">Verwijder</button></td></tr>`).join('');

  const wacht = inBehandeling.length
    ? `<div style="background:var(--amber-soft,rgba(245,158,11,.12));border:1px solid var(--amber-line,rgba(251,191,36,.45));border-left:4px solid var(--warning,#F59E0B);border-radius:8px;padding:12px 14px;margin-bottom:var(--spacing-4)">
       <div style="font-weight:600;color:var(--warning,#B45309);margin-bottom:6px">⏳ Nog in behandeling bij de bank (${inBehandeling.length})</div>
       <div class="table-wrap"><table class="tbl-compact"><tbody>${inBehandeling.map(t =>
         `<tr style="opacity:.7"><td>${esc(t.datum)}</td><td>${esc(t.naam || t.omschr || '')}</td><td style="text-align:right">${fmt(Math.abs(t.totaal))}</td><td>${t.totaal < 0 ? 'af' : 'bij'}</td></tr>`).join('')}</tbody></table></div>
       <p class="muted" style="font-size:12px;margin-top:6px">Deze zijn nog niet definitief; bedrag of datum kan nog wijzigen. Haal later opnieuw op, dan staan ze in het voorstel.</p></div>`
    : '';
  const ontbreekt = voorstel.ontbreekt.length
    ? `<div class="section-head"><div class="section-titel">Staat in de administratie, niet in het bestand (${voorstel.ontbreekt.length})</div></div>
       <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact"><tbody>${voorstel.ontbreekt.map(t =>
         `<tr><td>${esc(t.datum)}</td><td>${esc(t.naam || '')}</td><td style="text-align:right">${fmt(t.bedrag)}</td><td>${esc(t.type)}</td><td>${esc(t.gb)}</td></tr>`).join('')}</tbody></table></div></div>
       <p class="muted" style="font-size:12px;margin-top:6px">Controleer deze: ze kunnen een verkeerd bedrag of een verkeerde datum hebben, of er is iets dubbel geboekt.</p>`
    : '';
  const overg = voorstel.overgeslagen.length
    ? `<p class="muted" style="font-size:12px">${voorstel.overgeslagen.length} regels overgeslagen (niet afgerond of onleesbaar).</p>` : '';

  doel.innerHTML = knop + wacht + `
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Regels in bestand</div><div class="kpi-val">${voorstel.rijen.length}</div><div class="kpi-sub">${esc(voorstel.van)} t/m ${esc(voorstel.tot)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Staat al</div><div class="kpi-val">${voorstel.rijen.length - nieuw.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Nieuw</div><div class="kpi-val">${nieuw.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Nog zonder rekening</div><div class="kpi-val">${kies.filter(r => !r.gb).length}</div></div>
    </div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th></th><th>Datum</th><th>Naam</th><th style="text-align:right">Bedrag</th><th>Grootboek</th><th>Soort</th><th></th></tr></thead>
      <tbody>${rijen}</tbody></table></div></div>
    <div style="margin:var(--spacing-4) 0"><button class="btn btn-primary" onclick="importeerRevolut()">Importeer ${kies.length} geselecteerde boekingen</button></div>
    ${overg}${ontbreekt}`;
}
