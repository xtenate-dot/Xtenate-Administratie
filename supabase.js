// supabase.js — één plek waar de verbinding met Supabase vandaan komt.
//
// De client wordt pas opgebouwd wanneer hij nodig is, en daarna hergebruikt.
// Alle foutafhandeling rond het verbinden zit hier, zodat de rest van de app
// alleen met een werkende client of met een duidelijke melding te maken heeft.

import { SESSIE_SLEUTEL, SUPABASE_LIB, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, configProbleem, isGeconfigureerd } from './config.js?v=20261024k';

let client = null;
let bezig = null;

/** Fout met een leesbare melding erbij, zodat schermen die kunnen tonen. */
export class VerbindingsFout extends Error {
  constructor(melding, oorzaak) {
    super(melding);
    this.name = 'VerbindingsFout';
    this.oorzaak = oorzaak;
  }
}

/**
 * Haalt de bibliotheek op. Eerst wordt gekeken of hij al op de pagina staat
 * (bijvoorbeeld omdat je hem zelf meelevert); anders wordt hij van de CDN
 * geladen. Zonder internet lukt dat laatste niet, en dat moet een nette
 * melding geven in plaats van een lege pagina.
 */
async function haalBibliotheek() {
  if (window.supabase?.createClient) return window.supabase.createClient;
  try {
    const module = await import(/* @vite-ignore */ SUPABASE_LIB);
    return module.createClient;
  } catch (e) {
    throw new VerbindingsFout(
      'De Supabase-bibliotheek kon niet worden geladen. Controleer je internetverbinding en probeer het opnieuw.', e);
  }
}

/** Levert de gedeelde client op. Meerdere aanroepen tegelijk geven dezelfde. */
export function getClient() {
  if (client) return Promise.resolve(client);
  if (bezig) return bezig;

  bezig = (async () => {
    if (!isGeconfigureerd()) {
      throw new VerbindingsFout(configProbleem().tekst);
    }
    const createClient = await haalBibliotheek();
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,      // sessie overleeft het sluiten van de app
        autoRefreshToken: true,
        detectSessionInUrl: false, // we gebruiken geen magic links
        storageKey: SESSIE_SLEUTEL
      }
    });
    return client;
  })();

  bezig.catch(() => { bezig = null; }); // een mislukte poging mag opnieuw
  return bezig;
}

/** Is er al een client opgebouwd, zonder er een te maken? */
export function heeftClient() { return client !== null; }

/**
 * Controleert of het project echt bereikbaar is. Een geldige URL en sleutel
 * zeggen op zichzelf nog niets.
 */
export async function testVerbinding() {
  const sb = await getClient();
  const { error } = await sb.auth.getSession();
  // De melding van Supabase eerst door de vertaling halen; anders komt er
  // "Failed to fetch" op het scherm te staan.
  if (error) throw new VerbindingsFout(leesbareFout(error), error);
  return true;
}

/**
 * Zet een foutmelding van Supabase om in gewoon Nederlands. De originele tekst
 * blijft beschikbaar in de console voor als er iets onverwachts langskomt.
 */
export function leesbareFout(fout) {
  if (!fout) return 'Er ging iets mis.';
  if (fout instanceof VerbindingsFout) return fout.message;

  const tekst = String(fout.message || fout).toLowerCase();
  if (tekst.includes('invalid login credentials')) return 'E-mailadres of wachtwoord klopt niet.';
  if (tekst.includes('email not confirmed')) return 'Dit e-mailadres is nog niet bevestigd. Kijk in je mail, of zet e-mailbevestiging uit in Supabase.';
  if (tekst.includes('user not found')) return 'Er bestaat geen account met dit e-mailadres.';
  if (tekst.includes('too many requests') || tekst.includes('rate limit')) return 'Te veel pogingen achter elkaar. Wacht even en probeer het opnieuw.';
  if (tekst.includes('password should be')) return 'Het wachtwoord voldoet niet aan de eisen van je project.';
  if (tekst.includes('failed to fetch') || tekst.includes('networkerror') || tekst.includes('load failed')) {
    return 'Geen verbinding met Supabase. Controleer je internetverbinding.';
  }
  if (tekst.includes('invalid api key') || tekst.includes('no api key')) {
    return 'De publishable key in config.js wordt niet geaccepteerd. Controleer of je de sleutel uit het vak Publishable key hebt gekopieerd.';
  }
  console.warn('Onbekende fout van Supabase:', fout);
  return fout.message || 'Er ging iets mis bij het verbinden met Supabase.';
}
