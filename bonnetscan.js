// bonnetscan.js — bonnetje fotograferen en automatisch koppelen aan de juiste bankboeking.
//
// Werking (alles in je eigen browser, gratis, er gaat niets naar een externe dienst met jouw gegevens):
//   1. Je maakt een foto (of kiest een foto/pdf).
//   2. De tekst wordt in de browser gelezen met Tesseract.js (OCR). De eerste keer laadt dat eenmalig ~10 MB.
//   3. Uit de tekst halen we bedragen, een datum en de winkelnaam.
//   4. We zoeken boekingen (uitgaven zonder bijlage) met hetzelfde bedrag, een datum in de buurt en een
//      passende naam, en tonen de beste voorstellen. Jij kiest er één: de foto wordt dan als bijlage bewaard.
// Je kunt het bedrag en de datum altijd zelf corrigeren als de tekst niet goed is gelezen.

import { state } from './storage.js?v=20261025d';
import { esc, fmt, ddmm, isUitgave } from './helpers.js?v=20261025d';
import { heeftBonnetje, voegBonnetjeToe, bonnetjesBeschikbaar } from './bonnetjes.js?v=20261025d';
import { haalInboxOp } from './bankinbox.js?v=20261025d';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAANDEN = { jan: 1, feb: 2, mrt: 3, maa: 3, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
const r2 = n => Math.round(n * 100) / 100;

// ─── Tekst uitlezen (zuivere functies, los te testen) ────────────────────────

const pad = n => String(n).padStart(2, '0');
function isoDatum(d, m, j) {
  d = Number(d); m = Number(m); j = Number(j);
  if (j < 100) j += 2000;
  if (!(j >= 2015 && j <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${j}-${pad(m)}-${pad(d)}`;
}

/** Haalt uit de ruwe tekst van een bon: mogelijke bedragen (met voorrang voor "totaal"), datums en woorden uit de winkelnaam. */
export function leesBon(tekst) {
  const regels = String(tekst || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const bedragen = new Map();   // bedrag -> prioriteit (hoger = waarschijnlijker het totaal)
  const BEDRAG = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d{1,5})[.,](\d{2})(?!\d)/g;
  for (const regel of regels) {
    const sleutel = /(totaal|total|te betalen|totaalbedrag|betaald|pin|amount due|te voldoen)/i.test(regel) ? 3 : /(subtotaal|btw|korting|retour|wisselgeld|contant)/i.test(regel) ? 0 : 1;
    for (const m of regel.matchAll(BEDRAG)) {
      const b = r2(Number(m[1].replace(/\./g, '')) + Number(m[2]) / 100);
      if (b <= 0 || b > 50000) continue;
      bedragen.set(b, Math.max(bedragen.get(b) || 0, sleutel));
    }
  }
  const datums = new Set();
  const tekstAlles = regels.join(' ');
  for (const m of tekstAlles.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g)) { const d = isoDatum(m[1], m[2], m[3]); if (d) datums.add(d); }
  for (const m of tekstAlles.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) { const d = isoDatum(m[3], m[2], m[1]); if (d) datums.add(d); }
  for (const m of tekstAlles.matchAll(/(?<!\d)(\d{1,2})\s+([a-zA-Z]{3})[a-z]*\.?\s+(\d{4})/g)) {
    const mnd = MAANDEN[m[2].toLowerCase()]; if (mnd) { const d = isoDatum(m[1], mnd, m[3]); if (d) datums.add(d); }
  }
  const woorden = [...new Set(regels.slice(0, 2).join(' ').toLowerCase().split(/[^a-z0-9à-ÿ]+/).filter(w => w.length >= 4 && !/^\d+$/.test(w)))].slice(0, 12);
  return {
    bedragen: [...bedragen.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([bedrag, prio]) => ({ bedrag, prio })),
    datums: [...datums].sort(),
    woorden
  };
}

const dagenTussen = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);

/**
 * Zoekt boekingen die bij de bon passen. `bedragen`: lijst met { bedrag, prio }; `datum`: ISO of ''; `woorden`: uit de winkelnaam.
 * Alleen uitgaven zonder bijlage. Een bankboeking staat meestal 0 tot ~10 dagen na de bondatum.
 */
export function zoekBoekingen(boekingen, bedragen, datum, woorden, heeftAl = () => false) {
  // Staat er een duidelijk totaal op de bon, gebruik dan alleen dat; losse artikelprijzen geven te veel toevalstreffers.
  const hoogste = Math.max(0, ...bedragen.map(b => b.prio));
  const perBedrag = new Map(bedragen.filter(b => b.prio >= (hoogste >= 3 ? 3 : 1)).map(b => [r2(b.bedrag), b.prio]));
  const uit = [];
  for (const t of boekingen) {
    if (!isUitgave(t) || heeftAl(t.id)) continue;
    const prio = perBedrag.get(r2(Number(t.bedrag) || 0));
    if (prio === undefined) continue;
    let score = 10 + prio * 3;
    const redenen = ['bedrag klopt'];
    if (datum) {
      const verschil = dagenTussen(t.datum, datum);   // positief = boeking ná de bon
      if (verschil >= -1 && verschil <= 10) { score += 12 - Math.abs(verschil); redenen.push(verschil === 0 ? 'zelfde dag' : `${Math.abs(verschil)} dag${Math.abs(verschil) === 1 ? '' : 'en'} ${verschil > 0 ? 'later' : 'eerder'}`); }
      else score -= 8;
    }
    const naamTekst = `${t.naam || ''} ${t.omschr || ''}`.toLowerCase();
    const treffer = (woorden || []).filter(w => naamTekst.includes(w));
    if (treffer.length) { score += 8 + treffer.length; redenen.push(`naam: ${treffer.slice(0, 2).join(', ')}`); }
    uit.push({ t, score, redenen });
  }
  return uit.sort((a, b) => b.score - a.score || (b.t.datum > a.t.datum ? 1 : -1)).slice(0, 6);
}

// ─── OCR in de browser ───────────────────────────────────────────────────────

let tesseractBelofte = null;
export function laadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractBelofte) tesseractBelofte = new Promise((ok, fout) => {
    const s = document.createElement('script');
    s.src = TESSERACT; s.async = true;
    s.onload = () => window.Tesseract ? ok(window.Tesseract) : fout(new Error('OCR-bibliotheek niet beschikbaar'));
    s.onerror = () => { tesseractBelofte = null; fout(new Error('De OCR-bibliotheek kon niet worden geladen (internet?)')); };
    document.head.appendChild(s);
  });
  return tesseractBelofte;
}

export async function leesFoto(bestand, voortgang) {
  const T = await laadTesseract();
  const res = await T.recognize(bestand, 'nld+eng', { logger: m => { if (m && m.status && typeof m.progress === 'number') voortgang(`${m.status} ${Math.round(m.progress * 100)}%`); } });
  return res?.data?.text || '';
}

// ─── Het venster ─────────────────────────────────────────────────────────────

let bestand = null, toestand = null;   // toestand: { tekst, bedragen, datum, woorden, handmatig, boodschap, bezig }
let inboxRegels = [];

function laag() {
  let l = document.getElementById('bonscan-laag');
  if (!l) { l = document.createElement('div'); l.id = 'bonscan-laag'; l.className = 'pm-laag'; l.style.display = 'none'; l.onclick = e => { if (e.target === l) sluitBonScan(); }; document.body.appendChild(l); }
  return l;
}

export function openBonScan() {
  bestand = null; toestand = { tekst: '', bedragen: [], datum: '', woorden: [], handmatig: '', boodschap: '', bezig: '' };
  inboxRegels = [];
  laag().style.display = 'flex';
  teken();
  haalInboxOp().then(r => { inboxRegels = r || []; if (toestand?.bedragen?.length) teken(); }).catch(() => {});
}
export function sluitBonScan() { const l = document.getElementById('bonscan-laag'); if (l) l.style.display = 'none'; bestand = null; toestand = null; }

function alleBoekingen() { return [...(state.TX || []), ...(state.HIST_TX || [])]; }

function voorstellen() {
  if (!toestand) return [];
  const man = Number(String(toestand.handmatig).replace(',', '.'));
  const bedragen = man > 0 ? [{ bedrag: r2(man), prio: 3 }] : toestand.bedragen;
  return zoekBoekingen(alleBoekingen(), bedragen, toestand.datum, toestand.woorden, heeftBonnetje);
}

function teken() {
  const l = laag();
  if (!toestand) return;
  const heeftBestand = !!bestand;
  const gelezen = toestand.bedragen.length || toestand.datum || toestand.tekst;
  const lijst = heeftBestand && gelezen ? voorstellen() : [];
  const man = Number(String(toestand.handmatig).replace(',', '.')) > 0;
  const inboxHits = (heeftBestand && gelezen) ? inboxRegels.filter(r => (man ? [Number(String(toestand.handmatig).replace(',', '.'))] : toestand.bedragen.filter(b => b.prio >= (toestand.bedragen.some(x => x.prio >= 3) ? 3 : 1)).map(b => b.bedrag)).some(b => r2(Math.abs(Number(r.bedrag) || 0)) === r2(b))).slice(0, 3) : [];
  l.innerHTML = `<div class="pm-venster" role="dialog" aria-label="Bonnetje scannen" style="max-width:640px">
    <div class="pm-kop"><div><h3>📷 Bonnetje scannen</h3><p class="pm-sub">Maak een foto; de app zoekt de bijbehorende bankboeking en bewaart de foto als bijlage.</p></div>
      <button class="pm-kruis" onclick="sluitBonScan()" aria-label="Sluiten">×</button></div>
    <div class="pm-inhoud" style="padding:16px 20px">
      <input type="file" id="bonscan-bestand" accept="image/*,application/pdf" capture="environment" style="display:none" onchange="kiesBonScanBestand(event)">
      <input type="file" id="bonscan-bestand2" accept="image/*,application/pdf" style="display:none" onchange="kiesBonScanBestand(event)">
      ${!bonnetjesBeschikbaar ? `<p style="color:var(--semantic-danger-bright)">Bijlagen zijn in deze browser niet beschikbaar (privévenster?). Probeer een gewoon venster.</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-primary" onclick="document.getElementById('bonscan-bestand').click()"${toestand.bezig ? ' disabled' : ''}>📷 Foto maken</button>
        <button class="btn" onclick="document.getElementById('bonscan-bestand2').click()"${toestand.bezig ? ' disabled' : ''}>Bestand kiezen</button>
      </div>
      ${toestand.bezig ? `<p class="muted">${esc(toestand.bezig)}<br><span style="font-size:12px">De eerste keer kan dit een minuut duren (taaldata wordt eenmalig geladen).</span></p>` : ''}
      ${toestand.boodschap ? `<p style="font-size:13px">${esc(toestand.boodschap)}</p>` : ''}
      ${heeftBestand && !toestand.bezig ? `
        <div class="card" style="padding:10px 12px;margin-bottom:12px;font-size:13px">
          <div><b>Gelezen van de bon:</b> ${toestand.bedragen.length ? 'bedrag ' + toestand.bedragen.slice(0, 3).map(b => fmt(b.bedrag)).join(' / ') : 'geen bedrag herkend'}${toestand.datum ? ' · datum ' + esc(ddmm(toestand.datum)) + '-' + toestand.datum.slice(0, 4) : ' · geen datum herkend'}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
            <label class="muted" style="font-size:12px">Klopt dat niet? Typ het bedrag:</label>
            <input type="text" inputmode="decimal" value="${esc(toestand.handmatig)}" placeholder="bijv. 24,95" style="width:100px" oninput="zetBonScanBedrag(this.value)">
            <label class="muted" style="font-size:12px">datum:</label>
            <input type="date" value="${esc(toestand.datum)}" onchange="zetBonScanDatum(this.value)">
          </div></div>
        <div style="font-weight:600;margin-bottom:6px">Passende boekingen</div>
        ${lijst.length ? lijst.map((v, i) => `<label class="card" style="display:flex;gap:10px;align-items:flex-start;padding:8px 12px;margin-bottom:6px;cursor:pointer">
            <input type="radio" name="bonscan-keuze" value="${esc(v.t.id)}"${i === 0 ? ' checked' : ''} style="margin-top:3px">
            <span style="flex:1"><b>${esc(ddmm(v.t.datum))}</b> · ${esc(v.t.naam || v.t.omschr || '')} · <b>${fmt(v.t.bedrag)}</b>
              <span class="muted" style="display:block;font-size:12px">${esc(v.redenen.join(' · '))}${v.t.omschr && v.t.omschr !== v.t.naam ? ' · ' + esc(String(v.t.omschr).slice(0, 50)) : ''}</span></span></label>`).join('')
          : `<p class="muted" style="font-size:13px">Geen boeking gevonden met dit bedrag${man ? '' : ' (zonder bijlage)'}.${inboxHits.length ? '' : ' Is de bankregel al geboekt? Zo niet: boek hem eerst via Bank verwerken en probeer het opnieuw.'}</p>`}
        ${inboxHits.length && !lijst.length ? `<p style="font-size:13px;margin-top:8px">📥 Er staat wel een passende regel in je bank-inbox die nog niet is geboekt: ${inboxHits.map(r => `${esc(ddmm(r.datum))} ${esc(String(r.naam || '').slice(0, 25))} ${fmt(Math.abs(r.bedrag))}`).join('; ')}. Boek die eerst, dan kun je de bon eraan koppelen.</p>` : ''}` : ''}
    </div>
    <div class="pm-voet"><span class="pm-hint">De foto wordt verkleind en veilig in je eigen opslag bewaard (zeven jaar bewaarplicht).</span>
      <div class="pm-knoppen"><button class="btn" onclick="sluitBonScan()">Sluiten</button>
      <button class="btn btn-primary" onclick="bewaarBonScan()"${lijst.length && !toestand.bezig ? '' : ' disabled'}>Koppel aan gekozen boeking</button></div></div></div>`;
}

export async function kiesBonScanBestand(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f || !toestand) return;
  bestand = f; toestand = { tekst: '', bedragen: [], datum: '', woorden: [], handmatig: '', boodschap: '', bezig: 'Bon wordt gelezen…' };
  teken();
  try {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      toestand.boodschap = 'Van een pdf kan ik de tekst niet lezen. Typ het bedrag hieronder om de boeking te vinden.';
    } else {
      const tekst = await leesFoto(f, t => { if (toestand) { toestand.bezig = `Bon wordt gelezen… ${t}`; teken(); } });
      const g = leesBon(tekst);
      toestand.tekst = tekst; toestand.bedragen = g.bedragen; toestand.datum = g.datums[g.datums.length - 1] || ''; toestand.woorden = g.woorden;
      if (!g.bedragen.length) toestand.boodschap = 'Ik kon geen bedrag lezen. Typ het bedrag hieronder om de boeking te vinden.';
    }
  } catch (e) {
    toestand.boodschap = `${e.message || 'Lezen mislukt'}. Typ het bedrag hieronder om toch te koppelen.`;
  }
  toestand.bezig = '';
  teken();
}

export function zetBonScanBedrag(w) { if (toestand) { toestand.handmatig = w; teken(); const i = document.querySelector('#bonscan-laag input[inputmode=decimal]'); if (i) { i.focus(); i.setSelectionRange(w.length, w.length); } } }
export function zetBonScanDatum(w) { if (toestand) { toestand.datum = w; teken(); } }

export async function bewaarBonScan() {
  const gekozen = document.querySelector('#bonscan-laag input[name=bonscan-keuze]:checked');
  if (!gekozen || !bestand || !toestand) return;
  toestand.bezig = 'Bewaren…'; teken();
  try {
    await voegBonnetjeToe(gekozen.value, bestand);
    const t = alleBoekingen().find(x => String(x.id) === String(gekozen.value));
    const naam = t ? `${ddmm(t.datum)} ${t.naam || ''} ${fmt(t.bedrag)}` : 'de boeking';
    bestand = null; toestand = { tekst: '', bedragen: [], datum: '', woorden: [], handmatig: '', boodschap: `✅ Gekoppeld aan ${naam}. Je kunt nog een bon scannen.`, bezig: '' };
  } catch (e) {
    toestand.bezig = ''; toestand.boodschap = `❌ ${e.message || 'Bewaren mislukt'}`;
  }
  teken();
}

Object.assign(window, { openBonScan, sluitBonScan, kiesBonScanBestand, zetBonScanBedrag, zetBonScanDatum, bewaarBonScan });
