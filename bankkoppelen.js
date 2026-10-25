// bankkoppelen.js — een bankrekening koppelen via Enable Banking.
//
// Stap 1 (knop in Beheer): vraagt de Edge Function bank-koppeling om een
//   autorisatie-link, onthoudt de `state` en stuurt je naar Revolut.
// Stap 2 (na terugkeer): de bank stuurt je terug met ?code=...&state=...
//   in de adresbalk. We controleren dat de state klopt, maken de adresbalk
//   direct weer schoon (de code wordt nooit getoond of gelogd) en wisselen
//   de code via dezelfde Edge Function in.
// De functie zelf bewaart de sessie in de database; de app ziet die nooit.

import { getClient } from './supabase.js?v=20261024p';
import { state } from './storage.js?v=20261024p';
import { laadVoorstelUitBank, periodeBereik } from './bankimport.js?v=20261024p';
import { loadBankKoppelingenFromSupabase } from './supabase-client-v2.js?v=20261024p';

const STATE_KEY = 'xtenate_bank_state';
const el = id => document.getElementById(id);

function zetMelding(tekst) {
  const m = el('beheer-bank-koppeling-melding');
  if (m) m.textContent = tekst;
}

async function ververs() {
  state.BANK_KOPPELINGEN = await loadBankKoppelingenFromSupabase();
  if (typeof window.gaNaar === 'function') window.gaNaar('beheer');
}

/** Knop "Bankrekening koppelen". */
export async function startBankKoppeling() {
  zetMelding('Bezig met voorbereiden…');
  try {
    const sb = await getClient();
    const { data, error } = await sb.functions.invoke('bank-koppeling', { body: { aspsp_naam: 'Revolut', country: 'NL' } });
    if (error || !data?.ok || !data.redirect_url || !data.state) {
      zetMelding(`Koppelen starten mislukt${data?.fout ? ': ' + data.fout : '.'}`);
      return;
    }
    try { sessionStorage.setItem(STATE_KEY, data.state); } catch { /* geen opslag */ }
    window.location.href = data.redirect_url;
  } catch {
    zetMelding('Koppelen starten mislukt. Probeer het later opnieuw.');
  }
}

/** Aanroepen bij het opstarten (na inloggen): vangt de terugkeer van de bank op. */
export async function verwerkBankTerugkeer() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  const st = p.get('state');
  if (!code || !st) return;

  // Meteen schoonmaken, wat er ook verder gebeurt.
  history.replaceState(null, '', location.pathname + '#beheer');

  let bewaard = null;
  try { bewaard = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* niets */ }
  if (!bewaard || bewaard !== st) {
    window.alert('De terugkeer van de bank hoort niet bij een koppeling die je in deze browser hebt gestart. Er is niets gekoppeld.');
    return;
  }

  try {
    const sb = await getClient();
    const { data, error } = await sb.functions.invoke('bank-koppeling/sessies', { body: { code, state: st } });
    if (error || !data?.ok) {
      window.alert(`Koppelen is niet gelukt${data?.fout ? ': ' + data.fout : '.'}`);
      return;
    }
    await ververs();
    window.alert('De bankrekening is gekoppeld. Kies in Beheer bij welke eigen rekening hij hoort.');
  } catch {
    window.alert('Koppelen is niet gelukt. Probeer het later opnieuw.');
  }
}

/** Knop "Ophalen bij de bank" (op de pagina Bank importeren): haalt de laatste ~45 dagen op en toont ze als voorstel. */
export async function haalBankTransactiesOp() {
  const koppelingen = state.BANK_KOPPELINGEN || [];
  if (!koppelingen.length) { window.alert('Er is nog geen bankrekening gekoppeld. Doe dat in Beheer.'); return; }
  const bereik = periodeBereik();
  if (bereik.soort === 'eigen' && (!bereik.van || !bereik.tot || bereik.van > bereik.tot)) {
    window.alert('Kies bij "Eigen periode" een geldige begin- en einddatum.'); return;
  }
  const grens = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
  if (bereik.tot && bereik.tot < grens) {
    window.alert('Deze periode ligt buiten wat de bank teruggeeft (ongeveer de laatste 90 dagen). Controleer oudere periodes met een CSV-afschrift of de Excel-import.'); return;
  }
  const body = bereik.van ? { van: bereik.van, tot: bereik.tot } : { dagen: 45 };
  let afgekapt = false, vanTekst = bereik.van;
  try {
    const sb = await getClient();
    const alle = new Map();
    for (const k of koppelingen) {
      const { data, error } = await sb.functions.invoke('bank-koppeling/ophalen', { body: { koppeling_id: k.id, ...body } });
      let fout = data?.fout;
      if (error && !fout) { try { fout = (await error.context.json())?.fout; } catch { /* geen detail */ } }
      if (error || !data?.ok) { window.alert(`Ophalen is niet gelukt${fout ? ': ' + fout : '.'}`); return; }
      if (data.buitenBereik) { window.alert('Deze periode ligt buiten wat de bank teruggeeft (ongeveer de laatste 90 dagen). Controleer oudere periodes met een CSV-afschrift of de Excel-import.'); return; }
      if (data.afgekapt) { afgekapt = true; vanTekst = data.vanaf; }
      for (const t of data.transacties || []) alle.set(t.id, t);
    }
    const lijst = [...alle.values()];
    const wachtend = lijst.filter(t => t.status && t.status !== 'BOOK');
    const opmerking = afgekapt
      ? `Let op: de bank geeft maar ongeveer 90 dagen terug, dus je ziet vanaf ${vanTekst}. Oudere regels kun je alleen controleren met een CSV-afschrift of de Excel-import.` : '';
    laadVoorstelUitBank(lijst.filter(t => !t.status || t.status === 'BOOK'), undefined, wachtend,
      { van: bereik.van ? vanTekst : undefined, tot: bereik.tot || undefined, opmerking });
  } catch {
    window.alert('Ophalen is niet gelukt. Probeer het later opnieuw.');
  }
}

window.startBankKoppeling = startBankKoppeling;
window.haalBankTransactiesOp = haalBankTransactiesOp;
