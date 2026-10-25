// tarieven.js — de belastingtarieven per jaar, op één plek.
//
// De schatting van de inkomstenbelasting gebruikte vaste getallen die niet bij
// een bepaald jaar hoorden. Hier staan ze per jaar, met de bron erbij. Elk jaar
// kun je ze zelf aanpassen (de Belastingdienst wijzigt ze jaarlijks); wat je
// aanpast staat alleen in deze browser en gaat vóór de standaardwaarde.
//
// Het is een indicatie voor de winst uit onderneming alleen: heffingskortingen
// (algemene heffingskorting, arbeidskorting) en je andere inkomsten zitten er
// niet in.

import { lopendJaar } from './jaren.js?v=20261024w';

const KEY = 'xtenate_tarieven';
const ZA_KEY = 'xtenate_zelfstandigenaftrek';

/**
 * Standaardwaarden. Schijven: `tot` is de bovengrens van die schijf (null = geen grens).
 * Tarieven zijn inclusief premies volksverzekeringen, voor wie de AOW-leeftijd nog niet heeft.
 * Bronnen: KVK-pagina's Belastingtarieven 2024, 2025 en 2026; 2027 is het wetsvoorstel
 * (Belastingplan 2027) en dus nog niet definitief.
 */
export const STANDAARD = {
  '2024': { schijven: [{ tot: 75518, tarief: 0.3697 }, { tot: null, tarief: 0.495 }], mkb: 0.1331, zelfstandigenaftrek: 3750 },
  '2025': { schijven: [{ tot: 38441, tarief: 0.3582 }, { tot: 76817, tarief: 0.3748 }, { tot: null, tarief: 0.495 }], mkb: 0.127, zelfstandigenaftrek: 2470 },
  '2026': { schijven: [{ tot: 38883, tarief: 0.3575 }, { tot: 78426, tarief: 0.3756 }, { tot: null, tarief: 0.495 }], mkb: 0.127, zelfstandigenaftrek: 1200 },
  '2027': { schijven: [{ tot: 39247, tarief: 0.3623 }, { tot: 78426, tarief: 0.3816 }, { tot: null, tarief: 0.495 }], mkb: 0.127, zelfstandigenaftrek: 900, voorlopig: true }
};

const kopie = o => JSON.parse(JSON.stringify(o));

function overrides() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

/**
 * De tarieven voor een jaar. Is er voor dat jaar niets ingevuld, dan gelden die van het
 * dichtstbijzijnde bekende jaar, en staat `vanJaar` daar anders dan `jaar`, zodat het
 * scherm kan zeggen dat je ze moet nalopen.
 */
export function tarievenVoor(jaar) {
  const j = /^\d{4}$/.test(String(jaar)) ? String(jaar) : lopendJaar();
  const ov = overrides();
  const bekend = [...new Set([...Object.keys(STANDAARD), ...Object.keys(ov)])].sort();
  let gebruikt = bekend.includes(j) ? j : null;
  if (!gebruikt) {
    const eerder = bekend.filter(b => b < j);
    gebruikt = eerder.length ? eerder[eerder.length - 1] : bekend[0];
  }
  const basis = kopie(STANDAARD[gebruikt] || STANDAARD[bekend[bekend.length - 1]]);
  const eigen = ov[gebruikt];
  const t = eigen ? { ...basis, ...eigen } : basis;
  return { ...t, jaar: j, vanJaar: gebruikt, aangepast: !!eigen, standaard: !!STANDAARD[gebruikt] };
}

/** Bewaart eigen waarden voor een jaar. */
export function bewaarTarieven(jaar, t) {
  const ov = overrides();
  ov[String(jaar)] = {
    schijven: t.schijven.map(s => ({ tot: s.tot == null || s.tot === '' ? null : Number(s.tot), tarief: Number(s.tarief) })),
    mkb: Number(t.mkb), zelfstandigenaftrek: Number(t.zelfstandigenaftrek) || 0
  };
  localStorage.setItem(KEY, JSON.stringify(ov));
}

export function herstelStandaardTarieven(jaar) {
  const ov = overrides();
  delete ov[String(jaar)];
  localStorage.setItem(KEY, JSON.stringify(ov));
}

/** Pas je de zelfstandigenaftrek toe? Alleen als je aan het urencriterium (1.225 uur) voldoet. */
export const zelfstandigenaftrekAan = () => localStorage.getItem(ZA_KEY) === 'ja';
export const zetZelfstandigenaftrek = aan => localStorage.setItem(ZA_KEY, aan ? 'ja' : 'nee');

/**
 * De schatting in stappen. `metMkb` en `metAftrek` zeggen of de MKB-winstvrijstelling en de
 * zelfstandigenaftrek meetellen (die laatste ook alleen als je dat hebt ingesteld).
 * De zelfstandigenaftrek kan de winst tot nul verlagen, niet eronder. De MKB-winstvrijstelling
 * wordt berekend over de winst na die aftrek.
 */
export function ibDetail(winst, jaar, { metMkb = true, metAftrek = zelfstandigenaftrekAan() } = {}) {
  const t = tarievenVoor(jaar);
  const w = Number(winst) || 0;
  if (!(w > 0)) return { ...t, winst: w, aftrek: 0, mkb: 0, belastbaar: 0, ib: 0, perSchijf: [] };
  const aftrek = metAftrek && metMkb ? Math.min(t.zelfstandigenaftrek, w) : 0;
  const mkb = metMkb ? (w - aftrek) * t.mkb : 0;
  const belastbaar = Math.max(0, w - aftrek - mkb);

  let rest = belastbaar, van = 0, ib = 0;
  const perSchijf = [];
  for (const s of t.schijven) {
    if (rest <= 0) break;
    const breedte = s.tot == null ? rest : Math.max(0, Math.min(rest, s.tot - van));
    ib += breedte * s.tarief;
    perSchijf.push({ van, tot: s.tot, tarief: s.tarief, bedrag: breedte });
    rest -= breedte;
    van = s.tot == null ? van + breedte : s.tot;
  }
  return { ...t, winst: w, aftrek, mkb, belastbaar, ib, perSchijf };
}

export const pct = v => (v * 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 }) + '%';
