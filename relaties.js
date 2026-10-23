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

import { state, saveFacturen } from './storage.js?v=20261023m';
import {
  loadRelatiesFromSupabase, maakRelatieInSupabase,
  werkRelatieBijInSupabase, verwijderRelatieInSupabase
} from './supabase-client-v2.js?v=20261023m';

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
      (r.aliassen || []).some(a => a.toLowerCase().includes(term)))
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
