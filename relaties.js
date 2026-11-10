// relaties.js — relaties als eigen entiteit (fase 4a van de facturenmodule).
//
// Puur additief: een factuur kan een relatieId hebben náást het bestaande,
// vrij getypte relatie-tekstveld — nooit in plaats daarvan. Een bestaande
// factuur zonder relatieId blijft precies werken zoals hij nu werkt.
//
// boekingen.relatie_id wordt hier bewust niet gebruikt: de 620 bestaande
// boekingen worden door deze fase niet aangeraakt. Dat koppelen is, zoals
// het onderzoek al aangaf, een aparte, latere stap (fase 4b) — automatisch
// samenvoegen op basis van relatieSleutel() bleek op de echte data lang
// niet betrouwbaar genoeg (114 rauwe schrijfwijzen → maar 108 sleutels).

import { state, saveFacturen, bewaarRelatieExtra } from './storage.js?v=20261110j';
import { getClient } from './supabase.js?v=20261110j';
import {
  loadRelatiesFromSupabase, maakRelatieInSupabase,
  werkRelatieBijInSupabase, verwijderRelatieInSupabase
} from './supabase-client-v2.js?v=20261110j';

export function vindRelatie(id) {
  return state.RELATIES.find(r => r.id === id) || null;
}

/** Op naam én alias, hoofdletterongevoelig. Ongesorteerd op relevantie —
 *  gewoon in de volgorde van state.RELATIES (op naam), max. 10 resultaten. */
export function zoekRelaties(q) {
  const term = String(q || '').trim().toLowerCase();
  if (!term) return [];
  return state.RELATIES
    .filter(r => r.naam.toLowerCase().includes(term) ||
      (r.aliassen || []).some(a => a.toLowerCase().includes(term)) ||
      String((state.RELATIE_EXTRA[r.id] || {}).zoeksleutel || '').toLowerCase().includes(term) ||
      String((state.RELATIE_EXTRA[r.id] || {}).bedrijfsnaam || '').toLowerCase().includes(term))
    .slice(0, 10);
}

/** Herlaadt de lijst rechtstreeks uit Supabase (niet de offline-cache) —
 *  voor het beheerscherm, waar je de actuele stand wilt zien. */
export async function herlaadRelaties() {
  const rijen = await loadRelatiesFromSupabase();
  if (rijen && rijen.length >= 0) state.RELATIES = rijen;
  return state.RELATIES;
}

export async function maakRelatie(naam) {
  const schoon = String(naam || '').trim();
  if (!schoon) return null;
  const record = await maakRelatieInSupabase(schoon);
  if (record) {
    state.RELATIES.push(record);
    state.RELATIES.sort((a, b) => a.naam.localeCompare(b.naam));
  }
  return record;
}

export async function hernoemRelatie(id, naam) {
  const schoon = String(naam || '').trim();
  if (!schoon) return false;
  const ok = await werkRelatieBijInSupabase(id, { naam: schoon });
  if (ok) {
    const r = vindRelatie(id);
    if (r) r.naam = schoon;
  }
  return ok;
}

/**
 * Fase 6, deel 1 (facturenmodule): adres/KVK/BTW-nummer van een relatie,
 * voor op de factuur-pdf naast de bestaande bedrijfsgegevens (fase 5).
 * Alles optioneel — een leeg veld wordt null, nooit een lege string, zodat
 * "niet ingevuld" overal op dezelfde manier wordt herkend.
 */
export async function bewaarRelatieAdres(id, gegevens = {}) {
  const naar = v => { const s = String(v || '').trim(); return s || null; };
  const veranderd = {
    adres: naar(gegevens.adres),
    postcodePlaats: naar(gegevens.postcodePlaats),
    kvkNummer: naar(gegevens.kvkNummer),
    btwNummer: naar(gegevens.btwNummer)
  };
  const ok = await werkRelatieBijInSupabase(id, {
    adres: veranderd.adres,
    postcode_plaats: veranderd.postcodePlaats,
    kvk_nummer: veranderd.kvkNummer,
    btw_nummer: veranderd.btwNummer
  });
  if (ok) {
    const r = vindRelatie(id);
    if (r) Object.assign(r, veranderd);
  }
  return ok;
}

/**
 * Voegt de relatie `opTeHevenId` samen in `behoudenId`: de naam van
 * `behoudenId` blijft, de naam en aliassen van `opTeHevenId` worden
 * aliassen van `behoudenId` (dubbelen eruit), zodat de oude schrijfwijzen
 * herkenbaar blijven staan. Elke factuur die nog naar de opgeheven relatie
 * verwijst, wordt omgezet naar de behouden relatie — het vrije
 * relatie-tekstveld van die facturen blijft ongewijzigd, dat is de
 * historische registratie van wat er destijds is getypt.
 */
export async function voegRelatiesSamen(behoudenId, opTeHevenId) {
  if (!behoudenId || !opTeHevenId || behoudenId === opTeHevenId) return false;
  const behouden = vindRelatie(behoudenId);
  const opTeHeven = vindRelatie(opTeHevenId);
  if (!behouden || !opTeHeven) return false;

  const nieuweAliassen = [...new Set([...(behouden.aliassen || []), opTeHeven.naam, ...(opTeHeven.aliassen || [])])]
    .filter(a => a.toLowerCase() !== behouden.naam.toLowerCase());

  const ok = await werkRelatieBijInSupabase(behoudenId, { aliassen: nieuweAliassen });
  if (!ok) return false;
  behouden.aliassen = nieuweAliassen;

  let factuurGeraakt = false;
  state.FACTUREN.forEach(f => {
    if (f.relatieId === opTeHevenId) { f.relatieId = behoudenId; factuurGeraakt = true; }
  });
  if (factuurGeraakt) saveFacturen();

  const verwijderd = await verwijderRelatieInSupabase(opTeHevenId);
  if (verwijderd) state.RELATIES = state.RELATIES.filter(r => r.id !== opTeHevenId);
  return verwijderd;
}

/** Het nummer van een relatie voor een soort ('debiteur' vanaf 10000, 'crediteur' vanaf 20000), of null als er nog geen is. */
export function relatieNummer(relatie, soort) {
  if (!relatie) return null;
  return (soort === 'crediteur' ? relatie.crediteurnr : relatie.debiteurnr) || null;
}

/** Zorgt dat de relatie een nummer heeft voor deze soort (de database deelt het volgende vrije nummer uit). Geeft het nummer of null. */
export async function zorgRelatienummer(relatieId, soort) {
  const r = vindRelatie(relatieId);
  if (!r) return null;
  const bestaand = relatieNummer(r, soort);
  if (bestaand) return bestaand;
  try {
    const sb = await getClient();
    const { data, error } = await sb.rpc('geef_relatienummer', { p_relatie: relatieId, p_soort: soort });
    if (error || !data) return null;
    if (soort === 'crediteur') r.crediteurnr = data; else r.debiteurnr = data;
    return data;
  } catch { return null; }
}


// ─── Relatiegegevens (zoeksleutel, bedrijfsnaam, btw-plichtig, contact, notitie) ───

const nm = t => String(t || '').trim().toLowerCase();

/** De extra velden van een relatie (zoeksleutel, bedrijfsnaam, btwPlichtig, email, telefoon, iban, termijn, notitie). */
export function relatieExtra(id) {
  return (id && state.RELATIE_EXTRA[id]) || {};
}

/** Relatie op exacte naam, alias of bedrijfsnaam (hoofdletterongevoelig), of null. */
export function vindRelatieOpNaam(naam) {
  const n = nm(naam);
  if (!n) return null;
  return state.RELATIES.find(r => nm(r.naam) === n || (r.aliassen || []).some(a => nm(a) === n)
    || nm(relatieExtra(r.id).bedrijfsnaam) === n) || null;
}

/** Zoekt de relatie bij een naam; bestaat die nog niet, dan wordt hij aangemaakt. */
export async function zorgRelatieVoorNaam(naam) {
  return vindRelatieOpNaam(naam) || await maakRelatie(naam);
}

/** Bewaart alle gegevens van een relatie: adres/KVK/BTW in de relaties-tabel, de rest in app_data. */
export async function bewaarRelatieGegevens(id, g = {}) {
  const ok = await bewaarRelatieAdres(id, g);
  if (!ok) return false;
  const t = v => String(v == null ? '' : v).trim();
  bewaarRelatieExtra(id, {
    zoeksleutel: t(g.zoeksleutel), bedrijfsnaam: t(g.bedrijfsnaam), btwPlichtig: t(g.btwPlichtig),
    email: t(g.email), telefoon: t(g.telefoon), iban: t(g.iban), termijn: t(g.termijn), notitie: t(g.notitie)
  });
  return true;
}

/** Voegt een andere schrijfwijze toe als alias van een relatie (voor partijen zonder eigen relatie). */
export async function voegNaamToeAlsAlias(relatieId, naam) {
  const r = vindRelatie(relatieId), n = String(naam || '').trim();
  if (!r || !n) return false;
  if (n.toLowerCase() === r.naam.toLowerCase() || (r.aliassen || []).some(a => a.toLowerCase() === n.toLowerCase())) return true;
  const aliassen = [...(r.aliassen || []), n];
  const ok = await werkRelatieBijInSupabase(relatieId, { aliassen });
  if (ok) r.aliassen = aliassen;
  return ok;
}
