// auth.js — inloggen, uitloggen en het afschermen van de app.
//
// Let op wat dit wel en niet is. Het inlogscherm houdt de administratie uit
// beeld tot je bent ingelogd. Zolang de gegevens nog in deze browser staan,
// is dat een deur en geen kluis: wie de opslag van de browser openmaakt, komt
// er nog steeds bij. Echte afscherming ontstaat pas wanneer de gegevens in
// Supabase staan en Row Level Security ze bewaakt.

import { getClient, leesbareFout, testVerbinding } from './supabase.js?v=20261024b';
import { configProbleem, isGeconfigureerd } from './config.js?v=20261024b';
import { loadDataHybrid, state } from './storage.js?v=20261024b';

const el = id => document.getElementById(id);

let sessie = null;
let startApp = null;
let appGestart = false;

export function huidigeSessie() { return sessie; }
export function huidigeGebruiker() { return sessie?.user || null; }

// ------------------------------------------------------------------ schermen

function toonScherm(welke) {
  document.body.classList.toggle('niet-ingelogd', welke !== 'app');
  el('auth-scherm').style.display = welke === 'app' ? 'none' : 'flex';
  el('auth-inloggen').style.display = welke === 'inloggen' ? '' : 'none';
  el('auth-registreren').style.display = welke === 'registreren' ? '' : 'none';
  el('auth-bevestig-email').style.display = welke === 'bevestig-email' ? '' : 'none';
  el('auth-probleem').style.display = welke === 'probleem' ? '' : 'none';
  el('auth-bezig').style.display = welke === 'bezig' ? '' : 'none';
}

function toonFout(melding) {
  const vak = el('auth-fout');
  vak.textContent = melding || '';
  vak.style.display = melding ? '' : 'none';
}

function toonRegFout(melding) {
  const vak = el('reg-fout');
  vak.textContent = melding || '';
  vak.style.display = melding ? '' : 'none';
}

function toonProbleem(titel, melding, hersteltekst) {
  el('auth-probleem-titel').textContent = titel;
  el('auth-probleem-tekst').textContent = melding;
  el('auth-probleem-herstel').innerHTML = hersteltekst || '';
  toonScherm('probleem');
}

function bezig(aan, knoptekst) {
  const knop = el('auth-knop');
  knop.disabled = aan;
  knop.textContent = aan ? (knoptekst || 'Bezig…') : 'Inloggen';
}

function bezigRegistreren(aan) {
  const knop = el('reg-knop');
  knop.disabled = aan;
  knop.textContent = aan ? 'Bezig…' : 'Account aanmaken';
}

// ------------------------------------------------------------------ acties

export async function login(event) {
  if (event?.preventDefault) event.preventDefault();
  const email = el('auth-email').value.trim();
  const wachtwoord = el('auth-wachtwoord').value;

  if (!email || !wachtwoord) {
    toonFout('Vul je e-mailadres en wachtwoord in.');
    (email ? el('auth-wachtwoord') : el('auth-email')).focus();
    return;
  }

  toonFout('');
  bezig(true, 'Inloggen…');
  try {
    const sb = await getClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password: wachtwoord });
    if (error) throw error;
    sessie = data.session;
    el('auth-wachtwoord').value = '';
    naarApp();
  } catch (e) {
    toonFout(leesbareFout(e));
    el('auth-wachtwoord').select();
  } finally {
    bezig(false);
  }
}

export function toonRegistreren() {
  toonRegFout('');
  toonScherm('registreren');
  el('reg-email').focus();
}

export function toonInloggen() {
  toonFout('');
  toonScherm('inloggen');
  el('auth-email').focus();
}

/**
 * Registreert een nieuw account. Zet daarbij een vlag in localStorage
 * (xtenate_net_geregistreerd) — die staat NOOIT aan voor een bestaand
 * account, want alleen deze functie zet hem. Op de eerstvolgende geslaagde
 * login (hieronder, in naarApp() via verwerkNetGeregistreerd()) triggert die
 * vlag precies één aanroep van de zet_stamgegevens_klaar()-RPC, die
 * grootboek/rekeningen/groepen met een generieke starterset in app_data
 * klaarzet. Dat gebeurt bewust niet hier meteen: zonder e-mailbevestiging is
 * er nog geen geldige sessie (auth.uid()) om de RPC — die een
 * eigenaarscontrole heeft — mee aan te roepen.
 */
export async function signUp(event) {
  if (event?.preventDefault) event.preventDefault();
  const email = el('reg-email').value.trim();
  const wachtwoord = el('reg-wachtwoord').value;
  const herhaal = el('reg-wachtwoord-herhaal').value;

  if (!email || !wachtwoord) {
    toonRegFout('Vul je e-mailadres en wachtwoord in.');
    (email ? el('reg-wachtwoord') : el('reg-email')).focus();
    return;
  }
  if (wachtwoord.length < 6) {
    toonRegFout('Het wachtwoord moet minimaal 6 tekens lang zijn.');
    el('reg-wachtwoord').focus();
    return;
  }
  if (wachtwoord !== herhaal) {
    toonRegFout('De wachtwoorden komen niet overeen.');
    el('reg-wachtwoord-herhaal').select();
    return;
  }

  toonRegFout('');
  bezigRegistreren(true);
  try {
    const sb = await getClient();
    const { data, error } = await sb.auth.signUp({ email, password: wachtwoord });
    if (error) throw error;

    localStorage.setItem('xtenate_net_geregistreerd', '1');
    el('reg-wachtwoord').value = '';
    el('reg-wachtwoord-herhaal').value = '';

    if (data.session) {
      // Geen e-mailbevestiging nodig (of het project staat dat niet aan):
      // meteen een geldige sessie, dus meteen door naar de app.
      sessie = data.session;
      naarApp();
    } else {
      // Bevestiging vereist: nog geen sessie. De vlag blijft staan tot de
      // eerste geslaagde login, ná het klikken op de bevestigingslink.
      toonScherm('bevestig-email');
    }
  } catch (e) {
    toonRegFout(leesbareFout(e));
  } finally {
    bezigRegistreren(false);
  }
}

export async function uitloggen() {
  if (!window.confirm('Uitloggen? Je gegevens blijven gewoon staan.')) return;
  try {
    const sb = await getClient();
    await sb.auth.signOut();
  } catch (e) {
    console.warn('Uitloggen bij Supabase mislukte, sessie lokaal opgeruimd:', e);
  }
  
  // Fase 3A: Bij logout localStorage voor deze user wissen zodat volgende user
  // niet dezelfde data ziet. Settings (thema, etc.) blijven.
  // Noodrem verwijderen = weer aan (volgende user moet na inlog opnieuw sync aanzetten)
  try {
    localStorage.removeItem('xtenate_tx');
    localStorage.removeItem('xtenate_hist_tx_override');
    localStorage.removeItem('xtenate_pending_queue_v2');
    localStorage.removeItem('xtenate_sync_aan');  // Noodrem weer aan voor volgende user
    console.log('✅ User data cleared from localStorage');
  } catch (e) {
    console.warn('Could not clear localStorage:', e);
  }
  
  sessie = null;
  appGestart = false;  // Reset app state voor volgende user
  toonAccount();
  el('auth-email').value = '';
  el('auth-wachtwoord').value = '';
  toonFout('');
  toonScherm('inloggen');
}

/** Opnieuw proberen na een verbindingsprobleem. */
export function opnieuwVerbinden() { start(startApp); }

// ------------------------------------------------------------------ opstart

function toonAccount() {
  const gebruiker = huidigeGebruiker();
  const vak = el('account-blok');
  if (!vak) return;
  vak.style.display = gebruiker ? '' : 'none';
  if (gebruiker) el('account-email').textContent = gebruiker.email || 'ingelogd';
}

/**
 * Precies één keer, direct ná de eerste geslaagde login na signUp(): de RPC
 * aanroepen die grootboek/rekeningen/groepen met een generieke starterset
 * klaarzet in app_data. De vlag staat alleen ooit aan voor een account dat
 * via signUp() is aangemaakt — nooit voor een bestaand account — dus dit
 * kan de eigen administratie nooit raken.
 *
 * De vlag wordt pas verwijderd ná een bevestigde, geslaagde RPC-aanroep: bij
 * een netwerkfout blijft hij staan en wordt het gewoon bij de volgende login
 * opnieuw geprobeerd. zet_stamgegevens_klaar() zelf is idempotent (ON
 * CONFLICT DO NOTHING), dus dubbel aanroepen is onschadelijk.
 */
async function verwerkNetGeregistreerd() {
  if (localStorage.getItem('xtenate_net_geregistreerd') !== '1') return;
  const gebruiker = huidigeGebruiker();
  if (!gebruiker) return;
  try {
    const sb = await getClient();
    const { error } = await sb.rpc('zet_stamgegevens_klaar', { p_user: gebruiker.id });
    if (error) throw error;
    localStorage.removeItem('xtenate_net_geregistreerd');
  } catch (err) {
    console.warn('zet_stamgegevens_klaar mislukte, wordt bij de volgende keer opnieuw geprobeerd:', err);
  }
}

function naarApp() {
  toonAccount();
  toonScherm('app');

  // Fase 3A: Noodrem automatisch uitzetten bij login (sync staat aan)
  localStorage.setItem('xtenate_sync_aan', 'ja');

  // De app zelf wordt maar één keer opgestart; opnieuw inloggen tekent alleen
  // de huidige pagina opnieuw.
  if (!appGestart) {
    appGestart = true;
    // Fase 3: eerst eventuele nieuwe-registratie-stamgegevens klaarzetten,
    // dan pas laden — anders mist de eerste keer laden precies de rijen die
    // net zijn aangemaakt.
    verwerkNetGeregistreerd()
      .catch(() => {})
      .then(() => loadDataHybrid())
      .then(() => startApp?.())
      .catch(err => {
        console.error('loadDataHybrid failed:', err);
        state.dataKlaar = true;   // mislukt laden: toch tonen wat er lokaal is, met de fout in de console
        startApp?.();  // Even try to continue
      });
  }
  else window.hertekenHuidigePagina?.();
}

/**
 * Bepaalt bij het openen van de app of er al een geldige sessie is.
 * `bijInloggen` wordt aangeroepen zodra dat het geval is.
 */
export async function start(bijInloggen) {
  startApp = bijInloggen || startApp;
  toonScherm('bezig');

  if (!isGeconfigureerd()) {
    const probleem = configProbleem();
    toonProbleem(probleem.titel, probleem.tekst, probleem.herstel);
    return;
  }

  try {
    await testVerbinding();
  } catch (e) {
    toonProbleem('Geen verbinding met Supabase', leesbareFout(e),
      'Controleer je internetverbinding en de gegevens in <code>config.js</code>.');
    return;
  }

  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  sessie = data.session || null;

  // Supabase houdt de sessie zelf bij: verlopen, vernieuwd, of uitgelogd op
  // een ander tabblad. Daar luisteren we naar in plaats van het zelf te regelen.
  sb.auth.onAuthStateChange((gebeurtenis, nieuweSessie) => {
    sessie = nieuweSessie;
    if (!nieuweSessie && gebeurtenis !== 'INITIAL_SESSION') {
      toonAccount();
      toonScherm('inloggen');
    }
  });

  if (sessie) naarApp();
  else { toonScherm('inloggen'); el('auth-email').focus(); }
}
