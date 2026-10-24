// uren.js — urenregistratie voor het urencriterium.
//
// Alle uren die je aan je onderneming besteedt tellen mee: inkopen, administratie,
// foto's maken, inpakken en verzenden, klantcontact. Het criterium is minimaal
// 1.225 uur per jaar (en meer dan de helft van je werktijd). Deze pagina houdt
// alleen de uren bij; ze raken de boekingen en de belastingberekening niet.

import { state, saveUren } from './storage.js?v=20261024b';
import { vandaagIso } from './jaren.js?v=20261024b';

export const URENCRITERIUM = 1225;

export const CATEGORIEEN = [
  'Inkoop en sourcing',
  'Verkoop en klantcontact',
  'Inpakken en verzenden',
  'Foto’s, advertenties en voorraad',
  'Administratie en boekhouding',
  'Veilingen en loten (HNVI)',
  'Overig'
];

/** "1,5", "1.5" en "1:30" worden allemaal 1,5. Geeft null bij ongeldige invoer. */
export function leesUren(tekst) {
  const t = String(tekst ?? '').trim().replace(',', '.');
  if (!t) return null;
  const m = t.match(/^(\d+):([0-5]?\d)$/);
  const u = m ? Number(m[1]) + Number(m[2]) / 60 : Number(t);
  return Number.isFinite(u) && u > 0 && u <= 24 ? Math.round(u * 100) / 100 : null;
}

export function maakUur(g = {}) {
  const datum = g.datum || vandaagIso();
  return {
    id: g.id || `u${datum.slice(0, 4)}_${String(state.nxtUur).padStart(4, '0')}`,
    datum,
    uren: Math.round((Number(g.uren) || 0) * 100) / 100,
    categorie: CATEGORIEEN.includes(g.categorie) ? g.categorie : 'Overig',
    omschrijving: String(g.omschrijving || '').trim(),
    aangemaakt: g.aangemaakt || new Date().toISOString()
  };
}

export function voegUurToe(g) {
  const u = maakUur(g);
  state.UREN.push(u);
  state.nxtUur++;
  saveUren();
  return u;
}

export const vindUur = id => state.UREN.find(u => String(u.id) === String(id)) || null;

export function werkUurBij(id, g) {
  const u = vindUur(id);
  if (!u) return null;
  Object.assign(u, maakUur({ ...u, ...g, id: u.id, aangemaakt: u.aangemaakt }));
  saveUren();
  return u;
}

export function verwijderUur(id) {
  const voor = state.UREN.length;
  state.UREN = state.UREN.filter(u => String(u.id) !== String(id));
  const weg = state.UREN.length < voor;
  if (weg) saveUren();
  return weg;
}

/** Uren van een jaar ('all' voor alles), nieuwste eerst. */
export function urenVanJaar(jaar) {
  return state.UREN
    .filter(u => !jaar || jaar === 'all' || String(u.datum).startsWith(String(jaar)))
    .sort((a, b) => String(b.datum).localeCompare(String(a.datum)) || String(b.id).localeCompare(String(a.id)));
}

export const totaalUren = jaar => Math.round(urenVanJaar(jaar).reduce((s, u) => s + (Number(u.uren) || 0), 0) * 100) / 100;

/** Uren per maand (1..12) en per categorie voor een jaar. */
export function urenOverzicht(jaar) {
  const perMaand = Array(12).fill(0);
  const perCategorie = {};
  for (const u of urenVanJaar(jaar)) {
    const m = Number(String(u.datum).slice(5, 7)) - 1;
    if (m >= 0 && m < 12) perMaand[m] += Number(u.uren) || 0;
    perCategorie[u.categorie] = (perCategorie[u.categorie] || 0) + (Number(u.uren) || 0);
  }
  return { perMaand, perCategorie };
}

/** Stand ten opzichte van het urencriterium, met een verwachting voor het lopende jaar. */
export function criteriumStand(jaar) {
  const totaal = totaalUren(jaar);
  const nu = new Date(vandaagIso() + 'T12:00:00');
  const j = Number(jaar);
  const lopend = nu.getFullYear() === j;
  const dagInJaar = lopend ? Math.floor((nu - new Date(j, 0, 0)) / 86400000) : 365;
  const dagenInJaar = (j % 4 === 0 && (j % 100 !== 0 || j % 400 === 0)) ? 366 : 365;
  const prognose = lopend && dagInJaar >= 30 ? totaal / dagInJaar * dagenInJaar : null;
  const dagenOver = lopend ? dagenInJaar - dagInJaar : 0;
  const nogNodig = Math.max(0, URENCRITERIUM - totaal);
  return {
    totaal, doel: URENCRITERIUM, pct: totaal / URENCRITERIUM, nogNodig, prognose, lopend,
    perWeekNodig: lopend && dagenOver > 0 ? nogNodig / (dagenOver / 7) : null,
    perWeekTot: lopend && dagInJaar > 0 ? totaal / (dagInJaar / 7) : null,
    gehaald: totaal >= URENCRITERIUM
  };
}

// ─── Timer (alleen in deze browser) ─────────────────────────────────────────
const TIMER_KEY = 'xtenate_uren_timer';
export function timerStart(categorie = 'Overig') {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify({ start: Date.now(), categorie })); } catch { /* geen opslag */ }
}
export function timerStand() {
  try {
    const o = JSON.parse(localStorage.getItem(TIMER_KEY));
    return o && o.start ? o : null;
  } catch { return null; }
}
export function timerWis() { try { localStorage.removeItem(TIMER_KEY); } catch { /* niets */ } }
