// bankkoppelen.js — een bankrekening koppelen via Enable Banking.
//
// Stap 1 (knop in Beheer): vraagt de Edge Function bank-koppeling om een
//   autorisatie-link, onthoudt de `state` en stuurt je naar Revolut.
// Stap 2 (na terugkeer): de bank stuurt je terug met ?code=...&state=...
//   in de adresbalk. We controleren dat de state klopt, maken de adresbalk
//   direct weer schoon (de code wordt nooit getoond of gelogd) en wisselen
//   de code via dezelfde Edge Function in.
// De functie zelf bewaart de sessie in de database; de app ziet die nooit.

import { getClient } from './supabase.js?v=20261023y';
import { state } from './storage.js?v=20261023y';
import { loadBankKoppelingenFromSupabase } from './supabase-client-v2.js?v=20261023y';

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

window.startBankKoppeling = startBankKoppeling;
