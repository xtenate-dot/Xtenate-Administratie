// terugkerend.js — vaste posten die elke maand terugkomen (abonnementen, huur, vaste inkomsten),
// automatisch herkend uit je eigen boekingen. Niets hoeft ingevoerd te worden: de app kijkt welke
// namen minstens 3 van de laatste 6 maanden voorkomen met een vergelijkbaar bedrag, en meldt wanneer er
// deze maand nog niets van is binnengekomen.

import { state } from './storage.js?v=20261025f';
import { esc, fmt } from './helpers.js?v=20261025f';
import { vandaagIso } from './jaren.js?v=20261025f';

const SLEUTEL = 'xtenate_terugkerend_verborgen';
const el = id => document.getElementById(id);
let toonVerborgen = false;

function leesVerborgen() { try { return JSON.parse(localStorage.getItem(SLEUTEL) || '[]'); } catch { return []; } }
function bewaarVerborgen(l) { try { localStorage.setItem(SLEUTEL, JSON.stringify(l)); } catch {} }

const mediaan = l => { const s = [...l].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const maandVan = d => String(d).slice(0, 7);
const maandMin = (m, n) => { const [j, mm] = m.split('-').map(Number); const t = j * 12 + (mm - 1) - n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const sleutelVan = b => (b.type === 'inkomst' ? 'i:' : 'u:') + String(b.naam || '').toLowerCase().replace(/[0-9]+/g, '').replace(/[^a-zà-ÿ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Zuivere functie (los te testen): vindt terugkerende posten in een lijst boekingen. */
export function vindTerugkerend(boekingen, vandaag = vandaagIso()) {
  const nu = maandVan(vandaag), dagVandaag = Number(vandaag.slice(8, 10));
  const start = maandMin(nu, 5);   // de laatste 6 maanden, inclusief deze
  const groepen = new Map();
  for (const b of boekingen) {
    if (b.type !== 'uitgave' && b.type !== 'inkomst') continue;
    if (!b.naam || !String(b.naam).trim() || !b.datum) continue;
    const m = maandVan(b.datum);
    if (m < start || m > nu) continue;
    const k = sleutelVan(b);
    if (k.length < 3) continue;
    const g = groepen.get(k) || { sleutel: k, naam: String(b.naam).trim(), type: b.type, perMaand: new Map(), dagen: [], laatste: '' };
    const p = g.perMaand.get(m) || { som: 0, aantal: 0 };
    p.som += Number(b.bedrag) || 0; p.aantal++;
    g.perMaand.set(m, p);
    g.dagen.push(Number(String(b.datum).slice(8, 10)));
    if (b.datum > g.laatste) g.laatste = b.datum;
    groepen.set(k, g);
  }
  const uit = [];
  for (const g of groepen.values()) {
    if (g.perMaand.size < 3) continue;
    // Een naam die meerdere keren per maand voorkomt (bijv. een webshop) is geen vaste post.
    const meerdere = [...g.perMaand.values()].filter(p => p.aantal > 1).length;
    if (meerdere > g.perMaand.size / 2) continue;
    const bedragen = [...g.perMaand.values()].map(p => p.som);
    const med = mediaan(bedragen);
    if (!(med > 0)) continue;
    const gelijk = bedragen.filter(x => Math.abs(x - med) <= Math.max(1, med * 0.2)).length;
    if (gelijk < 3) continue;
    const maanden = [...g.perMaand.keys()].sort();
    const laatsteMaand = maanden[maanden.length - 1];
    const dag = Math.round(mediaan(g.dagen));
    let status;
    if (g.perMaand.has(nu)) status = 'binnen';
    else if (laatsteMaand < maandMin(nu, 1)) status = 'gestopt';
    else status = dagVandaag >= dag + 3 ? 'telaat' : 'verwacht';
    uit.push({ sleutel: g.sleutel, naam: g.naam, type: g.type, bedrag: Math.round(med * 100) / 100, dag, laatste: g.laatste, maanden: maanden.length, status });
  }
  const volgorde = { telaat: 0, verwacht: 1, binnen: 2, gestopt: 3 };
  return uit.sort((a, b) => volgorde[a.status] - volgorde[b.status] || b.bedrag - a.bedrag);
}

export function verbergTerugkerend(sleutel) {
  const l = leesVerborgen(); if (!l.includes(sleutel)) l.push(sleutel);
  bewaarVerborgen(l); renderTerugkerend();
}
export function herstelTerugkerend(sleutel) { bewaarVerborgen(leesVerborgen().filter(x => x !== sleutel)); renderTerugkerend(); }
export function zetToonVerborgenTerugkerend(w) { toonVerborgen = !!w; renderTerugkerend(); }

const BADGE = { telaat: ['badge-red', 'Nog niet binnen'], verwacht: ['badge-amber', 'Wordt verwacht'], binnen: ['badge-green', 'Deze maand binnen'], gestopt: ['badge-gray', 'Gestopt?'] };

export function renderTerugkerend() {
  const doel = el('terugkerend-inhoud');
  if (!doel) return;
  const verborgen = leesVerborgen();
  const alle = vindTerugkerend([...(state.HIST_TX || []), ...(state.TX || [])]);
  const lijst = alle.filter(r => toonVerborgen || !verborgen.includes(r.sleutel));
  const actief = alle.filter(r => r.status !== 'gestopt' && !verborgen.includes(r.sleutel));
  const kosten = actief.filter(r => r.type === 'uitgave').reduce((s, r) => s + r.bedrag, 0);
  const inkomsten = actief.filter(r => r.type === 'inkomst').reduce((s, r) => s + r.bedrag, 0);
  const nogTeGaan = actief.filter(r => r.type === 'uitgave' && (r.status === 'verwacht' || r.status === 'telaat')).reduce((s, r) => s + r.bedrag, 0);
  const rijen = lijst.map(r => {
    const [kl, tekst] = BADGE[r.status];
    const weg = verborgen.includes(r.sleutel);
    return `<tr${weg ? ' style="opacity:.5"' : ''}>
      <td>${esc(r.naam)}</td>
      <td>${r.type === 'inkomst' ? 'Inkomst' : 'Uitgave'}</td>
      <td style="text-align:right">${fmt(r.bedrag)}</td>
      <td>rond de ${r.dag}e</td>
      <td class="muted">${esc(r.laatste)}</td>
      <td><span class="badge ${kl}">${tekst}</span></td>
      <td style="text-align:right">${weg
        ? `<button class="btn-details" onclick="herstelTerugkerend('${esc(r.sleutel)}')">Terugzetten</button>`
        : `<button class="btn-details" title="Geen vaste post; niet meer tonen" onclick="verbergTerugkerend('${esc(r.sleutel)}')">Verberg</button>`}</td></tr>`;
  }).join('');
  doel.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Vaste kosten per maand</div><div class="kpi-val">${fmt(kosten)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Vaste inkomsten per maand</div><div class="kpi-val">${fmt(inkomsten)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Kosten nog te verwachten deze maand</div><div class="kpi-val">${fmt(nogTeGaan)}</div></div>
    </div>
    ${lijst.length ? `<div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Naam</th><th>Soort</th><th style="text-align:right">Gemiddeld bedrag</th><th>Meestal</th><th>Laatste boeking</th><th>Deze maand</th><th></th></tr></thead>
      <tbody>${rijen}</tbody></table></div></div>` : '<div class="card"><p>Nog geen terugkerende posten gevonden. Daarvoor moet dezelfde naam in minstens 3 van de laatste 6 maanden voorkomen met een vergelijkbaar bedrag.</p></div>'}
    <p class="muted" style="font-size:12px;margin-top:10px">Automatisch herkend uit je boekingen: dezelfde naam, in minstens 3 van de laatste 6 maanden, met een bedrag dat hooguit 20% afwijkt. Er wordt niets geboekt.
      ${verborgen.length ? `<label style="margin-left:8px"><input type="checkbox" ${toonVerborgen ? 'checked' : ''} onchange="zetToonVerborgenTerugkerend(this.checked)"> ${verborgen.length} verborgen tonen</label>` : ''}</p>`;
}
