// bol-facturen.js — leest de ruw bewaarde Bol-facturen (tabel bol_facturen) en rekent ze om naar omzet,
// commissie, overige kosten en uitbetaling per maand. Alleen lezen en tonen: raakt boekingen en voorraad niet.
//
// De specificatie is een UBL-achtige JSON: per regel item.Name.value (TURNOVER, COMMISSION, ...),
// lineExtensionAmount.value (excl. btw; negatief = Bol betaalt jou) en AdditionalItemProperty (o.a. Bestelnummer, EAN).
// Op factuurniveau: payableAmount (negatief = Bol betaalt jou uit).

import { getClient } from './supabase.js?v=20261110k';

const r2 = n => Math.round(n * 100) / 100;
const tekst = x => (x && typeof x === 'object' && !Array.isArray(x) ? tekst(x.value ?? x.Value ?? x.amount ?? x.name ?? '') : Array.isArray(x) ? tekst(x[0]) : x == null ? '' : String(x));
const getal = x => { const n = Number(tekst(x)); return Number.isFinite(n) ? n : 0; };

/** Bol geeft datums als milliseconden sinds 1970 (of als tekst); geeft 'jjjj-mm-dd' in Nederlandse tijd. */
export function bolDatum(x) {
  if (x == null || x === '') return '';
  const n = typeof x === 'number' ? x : /^\d{9,}$/.test(String(x)) ? Number(x) : NaN;
  if (Number.isFinite(n)) return new Date(n).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  return String(x).slice(0, 10);
}

function eigenschap(regel, patroon) {
  const lijst = regel?.item?.AdditionalItemProperty || [];
  for (const p of lijst) if (patroon.test(tekst(p?.Name))) return tekst(p?.Value);
  return '';
}

/** Zet één rij uit bol_facturen om naar { id, account, type, van, tot, maand, regels, totaal, ... }. */
export function verwerkFactuur(rij) {
  const kop = rij.kop || {};
  const regels = [];
  for (const pagina of rij.specificatie || []) {
    for (const r of (pagina?.invoiceSpecification || [])) {
      regels.push({
        soort: tekst(r?.item?.Name) || '?',
        bedrag: getal(r?.lineExtensionAmount),   // excl. btw, negatief = in jouw voordeel
        btw: getal(r?.taxTotal?.TaxAmount),
        aantal: getal(r?.invoicedQuantity),
        bestelnr: eigenschap(r, /bestel/i),
        ean: eigenschap(r, /^ean$/i),
        titel: eigenschap(r, /titel/i),
        omschrijving: tekst(r?.item?.Description)
      });
    }
  }
  const van = bolDatum(kop?.invoicePeriod?.startDate), tot = bolDatum(kop?.invoicePeriod?.endDate), uitgegeven = bolDatum(kop?.issueDate);
  const jouw = r => -r.bedrag;   // positief = ontvangen, negatief = kosten
  let omzet = 0, commissie = 0, overig = 0;
  for (const r of regels) {
    if (/TURNOVER/i.test(r.soort)) omzet += jouw(r);
    else if (/COMMISSION/i.test(r.soort)) commissie += -jouw(r);   // commissie als positief kostenbedrag
    else overig += -jouw(r);
  }
  const somRegels = r2(regels.reduce((s, r) => s + r.bedrag, 0));
  const totaalExcl = getal(kop?.legalMonetaryTotal?.taxExclusiveAmount ?? kop?.taxExclusiveAmount);
  return {
    id: rij.invoice_id, account: rij.account || '1', type: rij.type || kop.invoiceType || '',
    van, tot, uitgegeven, maand: (tot || uitgegeven || van).slice(0, 7),
    regels, omzet: r2(omzet), commissie: r2(commissie), overig: r2(overig), netto: r2(omzet - commissie - overig),
    uitbetaling: r2(-getal(kop?.legalMonetaryTotal?.payableAmount ?? kop?.payableAmount)),         // incl. btw; positief = Bol betaalt jou
    klopt: Math.abs(somRegels - totaalExcl) < 0.05, somRegels, totaalExcl
  };
}

/** Alle bewaarde facturen, omgerekend. Geeft null als de tabel er niet is. */
export async function leesBolFacturen() {
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('bol_facturen').select('account, invoice_id, type, kop, specificatie').limit(2000);
    if (error) return null;
    return (data || []).map(verwerkFactuur);
  } catch { return null; }
}

/** Aantal facturen in de database (los van wat er geladen is), of null. */
export async function aantalBolFacturen() {
  try {
    const sb = await getClient();
    const { count, error } = await sb.from('bol_facturen').select('invoice_id', { count: 'exact', head: true });
    return error ? null : count;
  } catch { return null; }
}

/** Per maand opgeteld (nieuwste eerst), eventueel voor één account. */
export function perMaand(facturen, account = 'alle') {
  const m = new Map();
  for (const f of facturen || []) {
    if (account !== 'alle' && f.account !== account) continue;
    const a = m.get(f.maand) || { maand: f.maand, facturen: 0, omzet: 0, commissie: 0, overig: 0, netto: 0, uitbetaling: 0, onjuist: 0 };
    a.facturen++; a.omzet += f.omzet; a.commissie += f.commissie; a.overig += f.overig; a.netto += f.netto; a.uitbetaling += f.uitbetaling;
    if (!f.klopt) a.onjuist++;
    m.set(f.maand, a);
  }
  return [...m.values()].map(a => ({ ...a, omzet: r2(a.omzet), commissie: r2(a.commissie), overig: r2(a.overig), netto: r2(a.netto), uitbetaling: r2(a.uitbetaling) }))
    .sort((x, y) => y.maand.localeCompare(x.maand));
}
