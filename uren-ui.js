// uren-ui.js — pagina Uren: snel uren invoeren (of met een timer) en zien hoe je
// ervoor staat ten opzichte van het urencriterium van 1.225 uur per jaar.
// Het is alleen een logboek: het raakt boekingen en belasting niet.

import { state } from './storage.js?v=20261025d';
import { esc, ddmm } from './helpers.js?v=20261025d';
import { lopendJaar, vandaagIso } from './jaren.js?v=20261025d';
import {
  CATEGORIEEN, URENCRITERIUM, leesUren, voegUurToe, werkUurBij, vindUur, verwijderUur,
  urenVanJaar, urenOverzicht, criteriumStand, timerStart, timerStand, timerWis
} from './uren.js?v=20261025d';

const el = id => document.getElementById(id);
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const nl = (n, d = 1) => Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: d });
let bewerkId = null;
let tikker = null;

export const urenJaar = () => (/^\d{4}$/.test(String(state.huidigJaar)) ? String(state.huidigJaar) : lopendJaar());

export function renderUren() {
  const doel = el('uren-inhoud');
  if (!doel) return;
  const jaar = urenJaar();
  const lijst = urenVanJaar(jaar);
  const st = criteriumStand(jaar);
  const { perMaand, perCategorie } = urenOverzicht(jaar);
  const bewerk = bewerkId ? vindUur(bewerkId) : null;
  const timer = timerStand();

  const balk = Math.min(100, st.pct * 100);
  const prog = st.prognose != null
    ? `Op dit tempo kom je uit op <b>${nl(st.prognose, 0)}</b> uur dit jaar (${st.prognose >= st.doel ? 'boven' : 'onder'} de ${nl(st.doel, 0)}).`
    : '';
  const nodig = st.lopend && !st.gehaald && st.perWeekNodig != null
    ? ` Om ${nl(st.doel, 0)} te halen heb je nog <b>${nl(st.perWeekNodig)}</b> uur per week nodig.` : '';

  const maxM = Math.max(1, ...perMaand);
  const maanden = perMaand.map((u, i) => `
    <div style="flex:1;text-align:center;font-size:11px">
      <div style="height:60px;display:flex;align-items:flex-end;justify-content:center">
        <div style="width:70%;height:${Math.round(u / maxM * 100)}%;min-height:${u > 0 ? 2 : 0}px;background:var(--accent,#2563eb);border-radius:3px 3px 0 0"></div>
      </div>
      <div class="muted">${MAANDEN[i]}</div><div>${u ? nl(u) : '·'}</div>
    </div>`).join('');

  const cats = Object.entries(perCategorie).sort((a, b) => b[1] - a[1]).map(([c, u]) =>
    `<tr><td>${esc(c)}</td><td style="text-align:right">${nl(u)} u</td><td style="text-align:right">${nl(u / (st.totaal || 1) * 100, 0)}%</td></tr>`).join('');

  const rijen = lijst.map(u => `
    <tr>
      <td>${esc(ddmm(u.datum))}</td>
      <td style="text-align:right">${nl(u.uren, 2)}</td>
      <td>${esc(u.categorie)}</td>
      <td>${esc(u.omschrijving || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button type="button" class="btn-details" onclick="urenBewerk('${esc(u.id)}')">Bewerk</button>
        <button type="button" class="btn-details" onclick="urenVerwijder('${esc(u.id)}')">Verwijder</button>
      </td>
    </tr>`).join('');

  const timerHtml = timer
    ? `<button class="btn btn-primary" onclick="urenTimerStop()">Stop timer <span id="uren-timer-tijd"></span></button>`
    : `<button class="btn" onclick="urenTimerStart()">Start timer</button>`;

  doel.innerHTML = `
    <div class="card" style="padding:var(--spacing-3);margin-bottom:var(--spacing-3)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <div><span style="font-size:24px;font-weight:600">${nl(st.totaal)}</span> <span class="muted">van ${nl(st.doel, 0)} uur in ${jaar}</span></div>
        <div class="muted">${nl(st.pct * 100, 0)}%${st.gehaald ? ' · urencriterium gehaald' : ''}</div>
      </div>
      <div style="height:10px;background:var(--border,#e5e7eb);border-radius:5px;margin:8px 0;overflow:hidden">
        <div style="height:100%;width:${balk}%;background:${st.gehaald ? '#16a34a' : 'var(--accent,#2563eb)'}"></div>
      </div>
      <div class="muted" style="font-size:12px">
        ${st.perWeekTot != null ? `Gemiddeld ${nl(st.perWeekTot)} uur per week tot nu toe. ` : ''}${prog}${nodig}
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">
        Je claimt de zelfstandigenaftrek nu niet, dus dit is voor je eigen overzicht. Mocht je het urencriterium later wél nodig hebben, dan heb je het logboek al.
      </div>
    </div>

    <div class="card" style="padding:var(--spacing-3);margin-bottom:var(--spacing-3)">
      <div style="font-weight:600;margin-bottom:8px">${bewerk ? 'Uren bewerken' : 'Uren toevoegen'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <label style="font-size:12px">Datum<br><input type="date" id="uren-datum" value="${esc(bewerk ? bewerk.datum : vandaagIso())}"></label>
        <label style="font-size:12px">Uren<br><input type="text" id="uren-aantal" inputmode="decimal" placeholder="1,5 of 1:30" size="9" value="${bewerk ? esc(String(bewerk.uren).replace('.', ',')) : ''}"></label>
        <label style="font-size:12px">Soort<br><select id="uren-cat">${CATEGORIEEN.map(c => `<option${bewerk && bewerk.categorie === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label style="font-size:12px;flex:1;min-width:140px">Omschrijving (optioneel)<br><input type="text" id="uren-omschr" style="width:100%" value="${bewerk ? esc(bewerk.omschrijving) : ''}"></label>
        <button class="btn btn-primary" onclick="urenOpslaan()">${bewerk ? 'Opslaan' : 'Toevoegen'}</button>
        ${bewerk ? `<button class="btn" onclick="urenAnnuleer()">Annuleer</button>` : timerHtml}
      </div>
      <div id="uren-fout" style="color:var(--danger,#b91c1c);font-size:12px;margin-top:6px"></div>
    </div>

    <div class="card" style="padding:var(--spacing-3);margin-bottom:var(--spacing-3)">
      <div style="font-weight:600;margin-bottom:8px">Per maand</div>
      <div style="display:flex;gap:2px">${maanden}</div>
    </div>

    ${cats ? `<div class="card" style="padding:0;margin-bottom:var(--spacing-3)"><table class="tbl-compact"><thead><tr><th>Soort</th><th style="text-align:right">Uren</th><th style="text-align:right">Aandeel</th></tr></thead><tbody>${cats}</tbody></table></div>` : ''}

    ${lijst.length
      ? `<div class="table-wrap"><table class="tbl-compact" id="tbl-uren"><thead><tr><th>Datum</th><th style="text-align:right">Uren</th><th>Soort</th><th>Omschrijving</th><th></th></tr></thead><tbody>${rijen}</tbody></table></div>`
      : `<div class="leeg">Nog geen uren in ${jaar}.</div>`}`;

  tikTimer();
}

function tikTimer() {
  clearInterval(tikker);
  const t = timerStand();
  const toon = () => {
    const s = el('uren-timer-tijd');
    if (!s) { clearInterval(tikker); return; }
    const sec = Math.floor((Date.now() - t.start) / 1000);
    s.textContent = `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;
  };
  if (t) { toon(); tikker = setInterval(toon, 15000); }
}

export function urenOpslaan() {
  const fout = el('uren-fout');
  const datum = el('uren-datum').value;
  const uren = leesUren(el('uren-aantal').value);
  if (!datum) { fout.textContent = 'Vul een datum in.'; return; }
  if (uren == null) { fout.textContent = 'Vul de uren in, bijvoorbeeld 1,5 of 1:30 (maximaal 24 per regel).'; return; }
  const g = { datum, uren, categorie: el('uren-cat').value, omschrijving: el('uren-omschr').value };
  if (bewerkId) werkUurBij(bewerkId, g); else voegUurToe(g);
  bewerkId = null;
  // toon het jaar van de nieuwe regel
  const j = datum.slice(0, 4);
  if (/^\d{4}$/.test(j) && j !== urenJaar()) state.huidigJaar = j;
  renderUren();
}

export function urenBewerk(id) { bewerkId = id; renderUren(); el('uren-aantal')?.focus(); }
export function urenAnnuleer() { bewerkId = null; renderUren(); }

export function urenVerwijder(id) {
  const u = vindUur(id);
  if (!u) return;
  if (!confirm(`Uren van ${ddmm(u.datum)} (${u.uren} u, ${u.categorie}) verwijderen?`)) return;
  verwijderUur(id);
  if (bewerkId === id) bewerkId = null;
  renderUren();
}

export function urenTimerStart() {
  timerStart(el('uren-cat')?.value || 'Overig');
  renderUren();
}

/** Stopt de timer en zet de tijd, afgerond op kwartieren (minimaal 0,25), in het formulier. */
export function urenTimerStop() {
  const t = timerStand();
  if (!t) return;
  const uren = Math.max(0.25, Math.round((Date.now() - t.start) / 3600000 * 4) / 4);
  timerWis();
  renderUren();
  el('uren-aantal').value = String(uren).replace('.', ',');
  if (CATEGORIEEN.includes(t.categorie)) el('uren-cat').value = t.categorie;
  el('uren-omschr')?.focus();
}

Object.assign(window, { urenOpslaan, urenBewerk, urenAnnuleer, urenVerwijder, urenTimerStart, urenTimerStop });
