// periode.js — de pagina Per periode: omzet, kosten en resultaat per maand,
// kwartaal of jaar. Alleen kijken; er wordt niets aangepast.
//
// Dezelfde regels als de rest van de app: omzet is wat op de omzetrekeningen
// binnenkomt min wat daarvan is terugbetaald, kosten zijn de echte
// bedrijfskosten (geen balansposten, geen HNVI- of voorraadinkoop).
// HNVI-inkoop staat apart, omdat die pas bij verkoop een kostenpost is.

import { state } from './storage.js?v=20261024k';
import { esc, fmt, isInkomst, isOmzet, isUitgave, MND_KORT } from './helpers.js?v=20261024k';
import { isKostenpost, inkoopOverzicht } from './belasting.js?v=20261024k';
import { kmTarief } from './km.js?v=20261024k';

const el = id => document.getElementById(id);
let stand = 'maand';          // 'maand' | 'kwartaal' | 'jaar'
let gekozenJaar = null;
let weergave = 'samenvatting';   // 'samenvatting' | 'grootboek'

const alleBoekingen = () => [...(state.HIST_TX || []), ...(state.TX || [])];
const bedrag = t => Number(t.bedrag) || 0;

function sleutelVan(datum, soort) {
  const j = datum.slice(0, 4), m = Number(datum.slice(5, 7));
  if (soort === 'jaar') return j;
  if (soort === 'kwartaal') return `${j}-K${Math.ceil(m / 3)}`;
  return datum.slice(0, 7);
}

function labelVan(sleutel, soort) {
  if (soort === 'jaar') return sleutel;
  if (soort === 'kwartaal') return `${sleutel.slice(5)} ${sleutel.slice(0, 4)}`;
  return `${MND_KORT[Number(sleutel.slice(5, 7)) - 1]} ${sleutel.slice(0, 4)}`;
}

/**
 * Kilometervergoeding per periode: de kilometers uit de ritten maal het
 * ingestelde tarief. Ritten zijn geen bankboeking, dus ze moeten er hier apart
 * bij, anders ontbreken ze in de maandcijfers terwijl ze in de aangifte wel
 * meetellen. Geeft per periodesleutel { km, bedrag }. Alleen voor de jaren
 * waarvoor boekingen zijn meegegeven.
 */
export function kmPerPeriode(boekingen, soort) {
  const tarief = kmTarief();
  const jaren = new Set(boekingen.map(t => String(t.datum || '').slice(0, 4)).filter(Boolean));
  const uit = new Map();
  for (const r of state.RITTEN || []) {
    const d = String(r.datum || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !jaren.has(d.slice(0, 4))) continue;
    const k = sleutelVan(d, soort);
    const e = uit.get(k) || { km: 0, bedrag: 0 };
    e.km += Number(r.km) || 0;
    e.bedrag += (Number(r.km) || 0) * (tarief || 0);
    uit.set(k, e);
  }
  return uit;
}

/** Groepeert de boekingen en rekent per periode de kerncijfers uit. */
export function perPeriode(boekingen, soort) {
  const groepen = new Map();
  for (const t of boekingen) {
    if (!t.datum) continue;
    const k = sleutelVan(t.datum, soort);
    if (!groepen.has(k)) groepen.set(k, { sleutel: k, omzet: 0, kosten: 0, hnviInkoop: 0, priveSt: 0, priveOp: 0, aantal: 0 });
    const g = groepen.get(k);
    g.aantal++;
    if (isInkomst(t) && isOmzet(t.gb)) g.omzet += bedrag(t);
    else if (isUitgave(t) && isOmzet(t.gb)) g.omzet -= bedrag(t);   // terugbetaling
    if (isKostenpost(t)) g.kosten += bedrag(t);
    if (isUitgave(t) && String(t.gb) === '7010') g.hnviInkoop += bedrag(t);
    if (t.type === 'prive_storting') g.priveSt += bedrag(t);
    if (t.type === 'prive_opname') g.priveOp += bedrag(t);
  }
  for (const [k, e] of kmPerPeriode(boekingen, soort)) {
    if (!groepen.has(k)) groepen.set(k, { sleutel: k, omzet: 0, kosten: 0, hnviInkoop: 0, priveSt: 0, priveOp: 0, aantal: 0 });
    const g = groepen.get(k);
    g.kosten += e.bedrag; g.km = e.km; g.kmBedrag = e.bedrag;
  }
  return [...groepen.values()]
    .map(g => ({ ...g, resultaat: g.omzet - g.kosten - g.hnviInkoop }))
    .sort((a, b) => a.sleutel < b.sleutel ? -1 : 1);
}

export function kiesPeriodeSoort(s) {
  if (!['maand', 'kwartaal', 'jaar'].includes(s)) return;
  stand = s;
  renderPeriode();
}

export function kiesPeriodeWeergave(w) {
  if (!['samenvatting', 'grootboek'].includes(w)) return;
  weergave = w;
  renderPeriode();
}

export function kiesPeriodeJaar(j) {
  gekozenJaar = j;
  renderPeriode();
}



// ---------------------------------------------------------------- grootboekmatrix
// Dezelfde opzet als het tabblad "Per Periode" in de Excel: alle rekeningen
// onder elkaar, de periodes ernaast, met rubriektotalen. Tekens zoals in de
// Excel: kosten en uitgaven positief, omzet en inkomsten negatief, privé
// gestort positief en privé opgenomen negatief. Een negatief resultaat is winst.

function matrixBedrag(t) {
  const b = bedrag(t);
  if (t.type === 'uitgave' || t.type === 'prive_storting') return b;
  if (t.type === 'inkomst' || t.type === 'prive_opname') return -b;
  return 0;
}

function kolomSleutels(soort, jaar, boekingen) {
  if (soort === 'maand') return Array.from({ length: 12 }, (_, i) => `${jaar}-${String(i + 1).padStart(2, '0')}`);
  if (soort === 'kwartaal') return [1, 2, 3, 4].map(k => `${jaar}-K${k}`);
  return [...new Set(boekingen.map(t => (t.datum || '').slice(0, 4)).filter(Boolean))].sort();
}

/** Bouwt de matrix: rijen per rekening, per rubriek een totaal. */
export function grootboekMatrix(boekingen, soort, jaar) {
  const sleutels = kolomSleutels(soort, jaar, boekingen);
  const n = sleutels.length;
  const per = new Map();   // nummer -> waarden[]
  for (const t of boekingen) {
    if (!t.datum) continue;
    const i = sleutels.indexOf(sleutelVan(t.datum, soort));
    if (i < 0) continue;
    const nr = String(t.gb ?? '').trim() || '—';
    if (!per.has(nr)) per.set(nr, Array(n).fill(0));
    per.get(nr)[i] += matrixBedrag(t);
  }
  const namen = new Map((state.GROOTBOEK || []).map(g => [String(g.nummer), g.naam]));
  const alle = new Set([...namen.keys(), ...per.keys()]);
  const nummers = [...alle].filter(x => x !== '9999' || per.has('9999')).sort((a, b) => (Number(a) || 1e9) - (Number(b) || 1e9));
  const nul = () => Array(n).fill(0);
  const tel = (a, b) => a.map((v, i) => v + b[i]);
  const rij = nr => {
    const w = per.get(nr) || nul();
    return { nummer: nr, naam: namen.get(nr) || (per.has(nr) ? 'Onbekende rekening' : ''), waarden: w, totaal: w.reduce((s, v) => s + v, 0) };
  };
  const rubriek = (titel, test) => {
    const rijen = nummers.filter(test).map(rij);
    const w = rijen.reduce((s, r) => tel(s, r.waarden), nul());
    return { titel, rijen, waarden: w, totaal: w.reduce((s, v) => s + v, 0) };
  };
  const num = x => Number(x);
  const prive = rubriek('Totaal rubriek 0 (privé)', x => num(x) < 1000);
  const balans = rubriek('Totaal rubriek 1 en 2', x => num(x) >= 1000 && num(x) < 3000);
  const kosten4 = rubriek('Totaal rubriek 4', x => num(x) >= 4000 && num(x) < 5000);
  // Kilometervergoeding hoort bij Reiskosten (4640) en wordt op dezelfde regel meegeteld.
  const kmKaart = kmPerPeriode(boekingen, soort);
  if (kmKaart.size && kmTarief()) {
    const w = sleutels.map(k => (kmKaart.get(k) || { bedrag: 0 }).bedrag);
    if (w.some(x => x)) {
      let rij = kosten4.rijen.find(x => x.nummer === '4640');
      if (!rij) {
        rij = { nummer: '4640', naam: namen.get('4640') || 'Reiskosten', waarden: nul(), totaal: 0 };
        kosten4.rijen.push(rij);
        kosten4.rijen.sort((x, y) => Number(x.nummer) - Number(y.nummer));
      }
      rij.waarden = tel(rij.waarden, w);
      rij.totaal = rij.waarden.reduce((s, v) => s + v, 0);
      kosten4.waarden = tel(kosten4.waarden, w);
      kosten4.totaal = kosten4.waarden.reduce((s, v) => s + v, 0);
    }
  }
  const inkoop = rubriek('Totaal inkopen', x => num(x) >= 7000 && num(x) < 8000);
  const omzet = rubriek('Brutowinst (omzet)', x => num(x) >= 8000 && num(x) < 9000);
  const overig = rubriek('Overig', x => !(num(x) < 3000) ? !(num(x) >= 4000 && num(x) < 5000) && !(num(x) >= 7000 && num(x) < 9000) : !Number.isFinite(num(x)));
  const totaalBalans = tel(prive.waarden, balans.waarden);
  const kosten = tel(kosten4.waarden, inkoop.waarden);
  const resultaat = tel(omzet.waarden, kosten);
  const som = a => a.reduce((s, v) => s + v, 0);
  return {
    sleutels, n,
    rubrieken: [prive, balans, kosten4, inkoop, omzet, ...(overig.rijen.length ? [overig] : [])],
    samen: [
      { titel: 'Totaal balans', waarden: totaalBalans, totaal: som(totaalBalans), na: balans },
      { titel: 'Kosten (rubriek 4 + inkopen)', waarden: kosten, totaal: som(kosten) },
      { titel: 'Resultaat (min = winst)', waarden: resultaat, totaal: som(resultaat), vet: true }
    ]
  };
}

const matrixLabel = (k, soort) => soort === 'jaar' ? k : soort === 'kwartaal' ? k.slice(5) : MND_KORT[Number(k.slice(5, 7)) - 1];
const getal = n => Math.abs(n) < 0.005 ? '' : n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function matrixHtml(m, soort) {
  const kop = `<tr><th>Nr</th><th>Rekening</th>${m.sleutels.map(k => `<th style="text-align:right">${esc(matrixLabel(k, soort))}</th>`).join('')}<th style="text-align:right">Totaal</th></tr>`;
  const cellen = (w, t) => w.map(v => `<td style="text-align:right">${getal(v)}</td>`).join('') + `<td style="text-align:right"><strong>${getal(t)}</strong></td>`;
  const totaalRij = (titel, w, t, vet) => `<tr style="font-weight:600;background:var(--accent-softer)"><td></td><td>${esc(titel)}</td>${cellen(w, t)}</tr>`;
  let body = '';
  for (const r of m.rubrieken) {
    body += r.rijen.map(x => `<tr><td>${esc(x.nummer)}</td><td>${esc(x.naam)}</td>${cellen(x.waarden, x.totaal)}</tr>`).join('');
    body += totaalRij(r.titel, r.waarden, r.totaal);
    if (r.titel.startsWith('Totaal rubriek 1')) body += totaalRij(m.samen[0].titel, m.samen[0].waarden, m.samen[0].totaal);
  }
  body += totaalRij(m.samen[1].titel, m.samen[1].waarden, m.samen[1].totaal);
  body += totaalRij(m.samen[2].titel, m.samen[2].waarden, m.samen[2].totaal);
  return `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact" style="font-size:12px">
    <thead>${kop}</thead><tbody>${body}</tbody></table></div></div>
    <p class="muted" style="font-size:12px;margin-top:var(--spacing-2)">
      Zoals in je Excel: omzet en inkomsten zijn negatief, kosten positief. Een negatief resultaat betekent winst. HNVI- en AliExpress-inkoop staan hier voor het volle bankbedrag; wat fiscaal meetelt staat op Belasting.</p>`;
}

function inkoopSectie(jaar) {
  let o;
  try { o = inkoopOverzicht(jaar); } catch (e) { console.error('Inkoopoverzicht mislukt:', e); return ''; }
  if (!o.rijen.length) return '';
  const rijen = o.rijen.map(r => `<tr>
      <td>${esc(r.rekening)} ${esc(r.naam)}</td>
      <td style="text-align:right">${fmt(r.ingekocht)}</td>
      <td style="text-align:right">${fmt(r.aftrekbaar)}</td>
      <td style="text-align:right">${fmt(r.voorraad)}</td>
      <td style="text-align:right;color:${Math.abs(r.teVerdelen) > 0.005 ? 'var(--semantic-warning-bright)' : ''}">${fmt(r.teVerdelen)}</td>
      <td class="muted" style="font-size:12px">${esc(r.opmerking)}</td></tr>`).join('');
  const t = o.totaal;
  return `<div class="section-head"><div class="section-titel">Inkoop ${esc(jaar)}: wel en niet mee te rekenen</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Inkooprekening</th><th style="text-align:right">Ingekocht (bank)</th>
        <th style="text-align:right">Telt dit jaar mee</th><th style="text-align:right">Voorraad (telt niet)</th>
        <th style="text-align:right">Nog te verdelen</th><th>Toelichting</th></tr></thead>
      <tbody>${rijen}</tbody>
      <tfoot><tr style="font-weight:600"><td>Totaal</td><td style="text-align:right">${fmt(t.ingekocht)}</td>
        <td style="text-align:right">${fmt(t.aftrekbaar)}</td><td style="text-align:right">${fmt(t.voorraad)}</td>
        <td style="text-align:right">${fmt(t.teVerdelen)}</td><td></td></tr></tfoot></table></div></div>
    <p class="muted" style="font-size:12px;margin-top:var(--spacing-2)">
      "Nog te verdelen" is inkoop uit de bank die nog niet aan verkochte of nog aanwezige artikelen is gekoppeld. Die telt nu nergens mee als kosten.</p>`;
}

/** Het hele boek als Excel-bestand: alle perioden, alle boekingen, inkoop en HNVI. */
export function downloadPeriodeExcel() {
  const X = window.XLSX;
  if (!X) { alert('De Excel-bibliotheek is niet geladen. Ververs de pagina en probeer opnieuw.'); return; }
  const alles = alleBoekingen();
  const kop = ['Periode', 'Omzet', 'Kosten', 'HNVI-inkoop (bank)', 'Resultaat (kas)', 'Privé gestort', 'Privé opgenomen', 'Boekingen'];
  const blad = soort => [kop, ...perPeriode(alles, soort).map(r => [labelVan(r.sleutel, soort), r.omzet, r.kosten, r.hnviInkoop, r.resultaat, r.priveSt, r.priveOp, r.aantal])];
  const wb = X.utils.book_new();
  const voeg = (naam, rijen, breedtes) => {
    const ws = X.utils.aoa_to_sheet(rijen);
    if (breedtes) ws['!cols'] = breedtes.map(w => ({ wch: w }));
    X.utils.book_append_sheet(wb, ws, naam);
  };
  voeg('Per maand', blad('maand'), [14, 12, 12, 18, 16, 14, 16, 10]);
  voeg('Per kwartaal', blad('kwartaal'), [14, 12, 12, 18, 16, 14, 16, 10]);
  voeg('Per jaar', blad('jaar'), [10, 12, 12, 18, 16, 14, 16, 10]);

  const jaren = [...new Set(alles.map(t => (t.datum || '').slice(0, 4)).filter(Boolean))].sort();
  const inkoop = [['Jaar', 'Rekening', 'Naam', 'Ingekocht (bank)', 'Telt dit jaar mee', 'Voorraad (telt niet)', 'Nog te verdelen', 'Toelichting']];
  for (const j of jaren) {
    try { inkoopOverzicht(j).rijen.forEach(r => inkoop.push([j, r.rekening, r.naam, r.ingekocht, r.aftrekbaar, r.voorraad, r.teVerdelen, r.opmerking])); }
    catch (e) { console.error('Inkoop voor Excel mislukt', j, e); }
  }
  voeg('Inkoop per jaar', inkoop, [8, 10, 24, 16, 16, 18, 14, 60]);

  const matrixBlad = (soort, jaar) => {
    const m = grootboekMatrix(jaar ? alles.filter(t => (t.datum || '').startsWith(jaar)) : alles, soort, jaar);
    const rijen = [['Nr', 'Rekening', ...m.sleutels.map(k => matrixLabel(k, soort)), 'Totaal']];
    for (const r of m.rubrieken) {
      r.rijen.forEach(x => rijen.push([x.nummer, x.naam, ...x.waarden, x.totaal]));
      rijen.push(['', r.titel, ...r.waarden, r.totaal]);
      if (r.titel.startsWith('Totaal rubriek 1')) rijen.push(['', m.samen[0].titel, ...m.samen[0].waarden, m.samen[0].totaal]);
    }
    rijen.push(['', m.samen[1].titel, ...m.samen[1].waarden, m.samen[1].totaal]);
    rijen.push(['', m.samen[2].titel, ...m.samen[2].waarden, m.samen[2].totaal]);
    return rijen;
  };
  for (const j of [...jaren].reverse()) voeg(`Grootboek ${j}`, matrixBlad('maand', j), [8, 30, ...Array(13).fill(11)]);

  const gb = Object.fromEntries((state.GROOTBOEK || []).map(g => [String(g.nummer), g.naam]));
  const boek = [['Datum', 'Rekening', 'Soort', 'Bedrag', 'Naam', 'Omschrijving', 'Grootboek', 'Grootboeknaam']];
  [...alles].sort((a, b) => (a.datum < b.datum ? -1 : 1)).forEach(t =>
    boek.push([t.datum, t.rek, t.type, bedrag(t), t.naam || '', t.omschr || '', String(t.gb ?? ''), gb[String(t.gb)] || '']));
  voeg('Boekingen', boek, [12, 10, 16, 12, 30, 40, 11, 26]);

  const loten = [['Datum inkoop', 'Omschrijving', 'Factuur', 'Inkoop', 'Verkoopdatum', 'Verkoop', 'Winst', 'Status']];
  (state.HNVI_LOTS || []).forEach(l => loten.push([l.datum || '', l.omschr || '', l.factuur || '', Number(l.inkoop) || 0, l.verkoopDatum || '',
    l.verkoop == null ? '' : Number(l.verkoop), l.status === 'verkocht' ? (Number(l.verkoop) || 0) - (Number(l.inkoop) || 0) : '', l.status || '']));
  voeg('HNVI loten', loten, [12, 44, 10, 11, 13, 11, 11, 11]);

  const v = state.VEILING && state.VEILING.voorraad;
  if (v) {
    const vr = [['Artikel', 'Groep', 'Ingekocht', 'Eerder verkocht', 'Verkocht via log', 'Voorraad']];
    v.artikelen.filter(a => a.soort === 'artikel').forEach(a => vr.push([a.artikel, a.groep, a.ingekocht, a.eerder, a.log, a.ingekocht - a.eerder - a.log]));
    voeg('Artikelvoorraad', vr, [22, 20, 11, 15, 16, 10]);
  }
  X.writeFile(wb, `Xtenate-administratie-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

const kleur = n => n > 0.005 ? 'var(--semantic-success-bright)' : n < -0.005 ? 'var(--semantic-danger-bright)' : '';

export function renderPeriode() {
  const doel = el('periode-inhoud');
  if (!doel) return;

  const alles = alleBoekingen();
  const jaren = [...new Set(alles.map(t => (t.datum || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (!gekozenJaar || !jaren.includes(gekozenJaar)) gekozenJaar = jaren.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : jaren[0];

  const zichtbaar = stand === 'jaar' ? alles : alles.filter(t => (t.datum || '').startsWith(gekozenJaar));
  const rijen = perPeriode(zichtbaar, stand);

  const tot = rijen.reduce((s, r) => ({
    omzet: s.omzet + r.omzet, kosten: s.kosten + r.kosten, hnviInkoop: s.hnviInkoop + r.hnviInkoop,
    resultaat: s.resultaat + r.resultaat, priveSt: s.priveSt + r.priveSt, priveOp: s.priveOp + r.priveOp, aantal: s.aantal + r.aantal
  }), { omzet: 0, kosten: 0, hnviInkoop: 0, resultaat: 0, priveSt: 0, priveOp: 0, aantal: 0 });

  const knop = (id, naam) => `<div class="vtab${stand === id ? ' active' : ''}" onclick="kiesPeriodeSoort('${id}')" role="tab" tabindex="0" aria-selected="${stand === id}">${naam}</div>`;
  const jaarKeuze = stand === 'jaar' && weergave !== 'grootboek' ? '' : `<select onchange="kiesPeriodeJaar(this.value)" aria-label="Jaar">${jaren.map(j => `<option value="${j}"${j === gekozenJaar ? ' selected' : ''}>${j}</option>`).join('')}</select>`;

  const weergaveKnop = (id, naam) => `<div class="vtab${weergave === id ? ' active' : ''}" onclick="kiesPeriodeWeergave('${id}')" role="tab" tabindex="0" aria-selected="${weergave === id}">${naam}</div>`;
  const kpi = (l, w, k = '') => `<div class="kpi kpi--secondary"><div class="kpi-lbl">${esc(l)}</div><div class="kpi-val"${k ? ` style="color:${k}"` : ''}>${w}</div></div>`;

  const lijst = rijen.map(r => `<tr>
      <td>${esc(labelVan(r.sleutel, stand))}</td>
      <td style="text-align:right">${fmt(r.omzet)}</td>
      <td style="text-align:right">${fmt(r.kosten)}</td>
      <td style="text-align:right">${fmt(r.hnviInkoop)}</td>
      <td style="text-align:right;color:${kleur(r.resultaat)}"><strong>${fmt(r.resultaat)}</strong></td>
      <td style="text-align:right">${fmt(r.priveSt)}</td>
      <td style="text-align:right">${fmt(r.priveOp)}</td>
      <td style="text-align:right">${r.km ? r.km.toLocaleString('nl-NL') + ' km' : '—'}</td>
      <td style="text-align:right">${r.aantal}</td>
    </tr>`).join('');

  const samenvatting = `
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      ${kpi('Omzet', fmt(tot.omzet))}
      ${kpi('Kosten', fmt(tot.kosten))}
      ${kpi('HNVI-inkoop (bank)', fmt(tot.hnviInkoop))}
      ${kpi('Resultaat (kas)', fmt(tot.resultaat), kleur(tot.resultaat))}
    </div>
    ${rijen.length ? `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Periode</th><th style="text-align:right">Omzet</th><th style="text-align:right">Kosten</th>
        <th style="text-align:right">HNVI-inkoop</th><th style="text-align:right">Resultaat</th>
        <th style="text-align:right">Privé gestort</th><th style="text-align:right">Privé opgenomen</th>
        <th style="text-align:right">Kilometers</th><th style="text-align:right">Boekingen</th></tr></thead>
      <tbody>${lijst}</tbody>
      <tfoot><tr style="font-weight:600"><td>Totaal</td><td style="text-align:right">${fmt(tot.omzet)}</td>
        <td style="text-align:right">${fmt(tot.kosten)}</td><td style="text-align:right">${fmt(tot.hnviInkoop)}</td>
        <td style="text-align:right;color:${kleur(tot.resultaat)}">${fmt(tot.resultaat)}</td>
        <td style="text-align:right">${fmt(tot.priveSt)}</td><td style="text-align:right">${fmt(tot.priveOp)}</td>
        <td style="text-align:right">${rijen.reduce((s, r) => s + (r.km || 0), 0).toLocaleString('nl-NL')} km</td><td style="text-align:right">${tot.aantal}</td></tr></tfoot></table></div></div>`
      : '<div class="card"><p>Geen boekingen gevonden.</p></div>'}
    <p class="muted" style="font-size:12px;margin-top:var(--spacing-2)">
      Resultaat (kas) = omzet min kosten min HNVI-inkoop zoals die in de bank staat. De kosten bevatten de kilometervergoeding (kilometers × tarief uit de pagina Kilometers). Het fiscale resultaat staat op de pagina Belasting:
      daar telt HNVI-inkoop pas mee zodra het lot is verkocht.</p>
    ${stand === 'jaar' ? '' : inkoopSectie(gekozenJaar)}`;

  // Het grootboek toont altijd de maanden (of kwartalen) van één jaar, ook als
  // de samenvatting op "Per jaar" staat.
  const gbSoort = stand === 'jaar' ? 'maand' : stand;
  const inhoud = weergave === 'grootboek'
    ? matrixHtml(grootboekMatrix(alles.filter(t => (t.datum || '').startsWith(gekozenJaar)), gbSoort, gekozenJaar), gbSoort)
    : samenvatting;

  doel.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--spacing-3);flex-wrap:wrap;margin-bottom:var(--spacing-4)">
      <div class="vtabs" role="tablist">${knop('maand', 'Per maand')}${knop('kwartaal', 'Per kwartaal')}${knop('jaar', 'Per jaar')}</div>
      <div class="vtabs" role="tablist">${weergaveKnop('samenvatting', 'Samenvatting')}${weergaveKnop('grootboek', 'Alle grootboekrekeningen')}</div>
      ${jaarKeuze}
      <button class="btn btn-primary" style="margin-left:auto" onclick="downloadPeriodeExcel()">Download alles als Excel</button>
    </div>
    ${inhoud}`;
}
