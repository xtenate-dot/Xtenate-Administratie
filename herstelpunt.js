// herstelpunt.js — een automatische momentopname vóór elke import of wis-actie,
// met een knop om terug te zetten. De momentopname staat in deze browser; de
// cloud wordt bij terugzetten weer gelijkgetrokken met die opname.

import {
  state, load, save, saveTxData, saveHistTxData, saveCoversData, saveHnviData
} from './storage.js?v=20261024v';
import {
  vervangBoekingenInSupabase, vervangVoorraadInSupabase, saveHnviToSupabase, deleteFromSupabase
} from './supabase-client-v2.js?v=20261024v';

const SLEUTEL = 'xtenate_herstelpunten';
const MAX = 3;

const kopie = x => JSON.parse(JSON.stringify(x || []));

export function lijstHerstelpunten() {
  const l = load(SLEUTEL, []);
  return Array.isArray(l) ? l : [];
}

/** Bewaart nu de toestand van boekingen, historie, HNVI en voorraad. Geeft true als het gelukt is. */
export function maakHerstelpunt(reden) {
  const punt = {
    tijd: new Date().toISOString(), reden,
    TX: kopie(state.TX), HIST_TX: kopie(state.HIST_TX),
    HNVI_LOTS: kopie(state.HNVI_LOTS), COVERS: kopie(state.COVERS)
  };
  let lijst = [punt, ...lijstHerstelpunten()].slice(0, MAX);
  // Past het niet in de opslag, dan eerst de oudste laten vallen.
  while (lijst.length) {
    try { localStorage.setItem(SLEUTEL, JSON.stringify(lijst)); return true; }
    catch (e) { lijst = lijst.slice(0, -1); }
  }
  console.warn('Herstelpunt kon niet worden bewaard (opslag vol).');
  return false;
}

const datumTijd = iso => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });

/** Zet een herstelpunt terug, lokaal én in de cloud. */
export async function zetHerstelpuntTerug(index) {
  const punt = lijstHerstelpunten()[index];
  if (!punt) return;
  const aantal = `${punt.TX.length + punt.HIST_TX.length} boekingen, ${punt.HNVI_LOTS.length} HNVI-loten en ${punt.COVERS.length} artikelen`;
  if (!window.confirm(`Alles terugzetten naar ${datumTijd(punt.tijd)} (${punt.reden})?\n\nDaarmee staan er ${aantal}. Wat je sindsdien hebt gewijzigd, gaat verloren. Er wordt eerst een nieuw herstelpunt van de huidige toestand gemaakt.`)) return;

  maakHerstelpunt('vóór terugzetten');
  const oudeLoten = (state.HNVI_LOTS || []).map(l => String(l._key || l.id));

  state.TX = kopie(punt.TX); state.HIST_TX = kopie(punt.HIST_TX);
  state.HNVI_LOTS = kopie(punt.HNVI_LOTS); state.COVERS = kopie(punt.COVERS);
  saveTxData(); saveHistTxData(); saveCoversData(); saveHnviData();

  const fouten = [];
  const r1 = await vervangBoekingenInSupabase(state.TX, { isHistoric: false });
  if (r1.fout) fouten.push('boekingen huidig jaar: ' + r1.fout);
  const jaren = [...new Set(state.HIST_TX.map(t => String(t.datum).slice(0, 4)))];
  for (const j of jaren) {
    const r = await vervangBoekingenInSupabase(state.HIST_TX.filter(t => String(t.datum).startsWith(j)), { isHistoric: true, jaren: [j] });
    if (r.fout) fouten.push(`boekingen ${j}: ${r.fout}`);
  }
  const r2 = await vervangVoorraadInSupabase(state.COVERS);
  if (r2.fout) fouten.push('voorraad: ' + r2.fout);
  const nieuwe = new Set(state.HNVI_LOTS.map(l => String(l._key || l.id)));
  for (const k of oudeLoten) if (!nieuwe.has(k)) await deleteFromSupabase(k, 'hnvi').catch(() => fouten.push('lot ' + k));
  for (const l of state.HNVI_LOTS) { if (!(await saveHnviToSupabase(l))) fouten.push('lot ' + (l._key || l.id)); }

  window.hertekenHuidigePagina?.();
  window.alert(fouten.length
    ? 'Lokaal is alles teruggezet, maar niet alles kwam in de cloud:\n' + fouten.join('\n')
    : 'Teruggezet, ook in de cloud.');
}

/** Blok voor de Beheer-pagina. */
export function herstelpuntenBlok() {
  const l = lijstHerstelpunten();
  const rijen = l.length
    ? l.map((p, i) => `<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border)">
        <div><div style="font-weight:600">${datumTijd(p.tijd)}</div>
        <div class="muted" style="font-size:12px">${p.reden} · ${p.TX.length + p.HIST_TX.length} boekingen · ${p.HNVI_LOTS.length} loten · ${p.COVERS.length} artikelen</div></div>
        <button class="btn btn-sm" onclick="zetHerstelpuntTerug(${i})">Terugzetten</button></div>`).join('')
    : '<div class="muted" style="font-size:13px">Nog geen herstelpunten. Er wordt er automatisch een gemaakt vóór elke import en elke wis-actie.</div>';
  return `<div class="card" style="margin-top:var(--spacing-4)"><div style="font-weight:600;margin-bottom:4px">Herstelpunten</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Automatisch bewaard in deze browser. Laatste ${MAX}.</div>${rijen}</div>`;
}
