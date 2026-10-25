// factuurmaker.js — een factuur opstellen: klant, regels (artikel uit de
// voorraad of een eigen regel), KOR of BTW, en een voorbeeld dat je kunt
// afdrukken of als PDF bewaren. Het voorbeeld verandert mee terwijl je typt.
//
// Het bewaren als factuur zet alleen een openstaande post in Facturen
// (zie facturen.js). De voorraad en de boekingen worden NIET aangepast: de
// verkoop komt via de bank binnen, zoals altijd.

import { state, BEDRIJFSGEGEVENS, bewaarFactuurmakerInstellingen } from './storage.js?v=20261024u';
import { esc, fmt } from './helpers.js?v=20261024u';
import { modelNaarPdf } from './pdf.js?v=20261024u';
import { voegFactuurToe, werkFactuurBij, vindFactuur, plusDagen, vandaagISO, standaardTermijn, factuurnummerInGebruik } from './facturen.js?v=20261024u';

const KEY = 'xtenate_factuurmaker';
const el = id => document.getElementById(id);

const STANDAARD = {
  instellingen: {
    iban: '', email: '', telefoon: '', accent: '#1f4e79', logo: '', logoRechts: false,
    titel: 'Factuur', btw: 'kor', toonAantal: true, toonStukprijs: true, toonKvk: true,
    voettekst: ''
  },
  concept: null
};

function lees() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    if (o && typeof o === 'object') {
      return { instellingen: { ...STANDAARD.instellingen, ...(o.instellingen || {}) }, concept: o.concept || null };
    }
  } catch { /* onleesbaar: gewoon opnieuw beginnen */ }
  return { instellingen: { ...STANDAARD.instellingen }, concept: null };
}

let opslag = lees();
let laatsteInCloud = JSON.stringify(opslag.instellingen);
let cloudOvergenomen = false;
function bewaar() {
  try { localStorage.setItem(KEY, JSON.stringify(opslag)); } catch { /* vol of geweigerd: voorbeeld blijft werken */ }
  // Alleen de indeling gaat naar de cloud (niet het concept, dat verandert bij elke toetsaanslag).
  const j = JSON.stringify(opslag.instellingen);
  if (cloudOvergenomen && j !== laatsteInCloud) { laatsteInCloud = j; bewaarFactuurmakerInstellingen(opslag.instellingen); }
}

/** Eenmaal per sessie: de indeling uit de cloud overnemen, of de lokale indeling er eenmalig naartoe zetten. */
function neemCloudOver() {
  if (cloudOvergenomen || !state.dataKlaar) return;
  cloudOvergenomen = true;
  if (state.FACTUURMAKER) {
    opslag.instellingen = { ...STANDAARD.instellingen, ...state.FACTUURMAKER };
    laatsteInCloud = JSON.stringify(opslag.instellingen);
    try { localStorage.setItem(KEY, JSON.stringify(opslag)); } catch { /* niet erg */ }
  } else if (JSON.stringify(opslag.instellingen) !== JSON.stringify(STANDAARD.instellingen)) {
    laatsteInCloud = JSON.stringify(opslag.instellingen);
    bewaarFactuurmakerInstellingen(opslag.instellingen);
  }
}

const jaarVan = d => String(d || vandaagISO()).slice(0, 4);

/** Eerstvolgend factuurnummer: hoogste "JJJJ-NNN" van dit jaar + 1. */
function volgendNummer(datum) {
  const jaar = jaarVan(datum);
  let max = 0;
  for (const f of state.FACTUREN || []) {
    const m = String(f.factuurnummer || '').match(new RegExp(`^${jaar}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${jaar}-${String(max + 1).padStart(3, '0')}`;
}

function nieuwConcept() {
  const datum = vandaagISO();
  return {
    klantNaam: '', klantAdres: '', klantPlaats: '', klantRef: '', klantEmail: '',
    nummer: volgendNummer(datum), datum, termijn: standaardTermijn('debiteur'),
    regels: [{ soort: 'vrij', omschr: '', aantal: 1, prijs: 0 }],
    notitie: '', opgeslagenId: null
  };
}
function concept() {
  if (!opslag.concept) { opslag.concept = nieuwConcept(); bewaar(); }
  return opslag.concept;
}

const num = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const nlDatum = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : (iso || '');

export function totalen(c = concept(), btw = opslag.instellingen.btw) {
  const sub = c.regels.reduce((s, r) => s + num(r.aantal) * num(r.prijs), 0);
  const btwBedrag = btw === 'btw21' ? Math.round(sub * 21) / 100 : 0;
  return { sub: Math.round(sub * 100) / 100, btw: btwBedrag, totaal: Math.round((sub + btwBedrag) * 100) / 100 };
}

// ─── Het voorbeeld (een complete HTML-pagina, ook gebruikt om af te drukken) ─

export function factuurHtml(c = concept(), i = opslag.instellingen) {
  const b = BEDRIJFSGEGEVENS || {};
  const t = totalen(c, i.btw);
  const verval = plusDagen(c.datum, num(c.termijn));
  const kleur = /^#[0-9a-fA-F]{6}$/.test(i.accent) ? i.accent : '#1f4e79';
  const eur = n => fmt(n);

  const afzender = [b.naam, b.adres, b.postcodePlaats,
    i.email, i.telefoon,
    i.toonKvk && b.kvkNummer ? `KVK ${b.kvkNummer}` : '',
    i.btw !== 'kor' && b.btwNummer ? `BTW ${b.btwNummer}` : ''].filter(x => x && String(x).trim());
  const klant = [c.klantNaam, c.klantAdres, c.klantPlaats].filter(x => x && String(x).trim());

  const kolommen = `<th>Omschrijving</th>${i.toonAantal ? '<th class="r">Aantal</th>' : ''}${i.toonStukprijs ? '<th class="r">Prijs</th>' : ''}<th class="r">Bedrag</th>`;
  const rijen = c.regels.filter(r => String(r.omschr).trim() || num(r.prijs)).map(r => `<tr>
      <td>${esc(r.omschr)}</td>
      ${i.toonAantal ? `<td class="r">${esc(String(num(r.aantal)).replace('.', ','))}</td>` : ''}
      ${i.toonStukprijs ? `<td class="r">${eur(num(r.prijs))}</td>` : ''}
      <td class="r">${eur(num(r.aantal) * num(r.prijs))}</td></tr>`).join('');
  const leeg = (i.toonAantal ? 1 : 0) + (i.toonStukprijs ? 1 : 0) + 1;

  const logo = i.logo ? `<img src="${esc(i.logo)}" alt="" style="max-height:70px;max-width:220px">` : '';
  const kop = `<div class="id"><div class="titel">${esc(i.titel || 'Factuur')}</div></div>`;
  const koprij = i.logoRechts ? `${kop}<div>${logo}</div>` : `<div>${logo}</div>${kop}`;

  const kor = i.btw === 'kor'
    ? '<p class="klein">Vrijgesteld van omzetbelasting op grond van de kleineondernemersregeling (KOR).</p>' : '';
  const betaal = `<p>Wij verzoeken je het bedrag van <b>${eur(t.totaal)}</b> vóór <b>${nlDatum(verval)}</b> over te maken${i.iban ? ` op <b>${esc(i.iban)}</b>` : ''}${b.naam ? ` t.n.v. ${esc(b.naam)}` : ''}, onder vermelding van <b>${esc(c.nummer)}</b>.</p>`;

  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${esc(i.titel || 'Factuur')} ${esc(c.nummer)}</title>
<style>
@page{size:A4;margin:16mm}
*{box-sizing:border-box}
body{font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;margin:0;padding:24px;background:#fff}
.kop{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:28px}
.titel{font-size:28px;font-weight:700;color:${kleur}}
.id{text-align:right}
.twee{display:flex;justify-content:space-between;gap:30px;margin-bottom:24px}
.twee div{flex:1}
.lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#777;margin-bottom:3px}
table{width:100%;border-collapse:collapse;margin:8px 0 14px}
th{background:${kleur};color:#fff;text-align:left;padding:7px 8px;font-weight:600}
td{padding:7px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}
.r{text-align:right;white-space:nowrap}
.tot{margin-left:auto;width:260px}
.tot div{display:flex;justify-content:space-between;padding:3px 0}
.tot .eind{border-top:2px solid ${kleur};margin-top:4px;padding-top:6px;font-weight:700;font-size:15px}
.klein{font-size:11.5px;color:#555}
.voet{margin-top:26px;padding-top:10px;border-top:1px solid #ddd;font-size:11px;color:#666}
</style></head><body>
<div class="kop">${koprij}</div>
<div class="twee">
  <div><div class="lbl">Van</div>${afzender.map(x => esc(x)).join('<br>') || '<span style="color:#aaa">(vul je bedrijfsgegevens in bij Beheer)</span>'}</div>
  <div><div class="lbl">Aan</div>${klant.map(x => esc(x)).join('<br>') || '<span style="color:#aaa">(klant)</span>'}${c.klantRef ? `<br><span class="klein">Uw referentie: ${esc(c.klantRef)}</span>` : ''}</div>
  <div style="text-align:right"><div class="lbl">Factuurgegevens</div>Nummer: <b>${esc(c.nummer)}</b><br>Datum: ${nlDatum(c.datum)}<br>Vervaldatum: ${nlDatum(verval)}</div>
</div>
<table><thead><tr>${kolommen}</tr></thead><tbody>${rijen || `<tr><td colspan="${leeg + 1}" style="color:#aaa">Nog geen regels</td></tr>`}</tbody></table>
<div class="tot">
  ${i.btw === 'btw21' ? `<div><span>Subtotaal</span><span>${eur(t.sub)}</span></div><div><span>BTW 21%</span><span>${eur(t.btw)}</span></div>` : ''}
  <div class="eind"><span>Totaal</span><span>${eur(t.totaal)}</span></div>
</div>
${kor}
${c.notitie ? `<p>${esc(c.notitie).replace(/\n/g, '<br>')}</p>` : ''}
${betaal}
${i.voettekst ? `<div class="voet">${esc(i.voettekst).replace(/\n/g, '<br>')}</div>` : ''}
</body></html>`;
}

// ─── PDF en mail ───────────────────────────────────────────────────────────

const pdfBedrag = n => '\u20AC ' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Het factuurmodel voor pdf.js: kop, van/aan, tabel met regels, totaal, betaalinfo. */
export function factuurPdfModel(c = concept(), i = opslag.instellingen) {
  const b = BEDRIJFSGEGEVENS || {};
  const t = totalen(c, i.btw);
  const verval = plusDagen(c.datum, num(c.termijn));
  const rijen = c.regels.filter(r => String(r.omschr).trim() || num(r.prijs)).map(r => ({
    cellen: [r.omschr, String(num(r.aantal)).replace('.', ','), pdfBedrag(num(r.prijs)), pdfBedrag(num(r.aantal) * num(r.prijs))]
  }));
  const kolommen = [
    { kop: 'Omschrijving', breedte: 233 },
    { kop: 'Aantal', breedte: 55, rechts: true },
    { kop: 'Prijs', breedte: 85, rechts: true },
    { kop: 'Bedrag', breedte: 100, rechts: true }
  ];
  const regels = (lijst) => lijst.filter(x => x && String(x).trim()).map(tekst => ({ type: 'tekst', tekst: String(tekst) }));
  return {
    titel: `${i.titel || 'Factuur'} ${c.nummer}`,
    ondertitel: `Datum ${nlDatum(c.datum)} - vervaldatum ${nlDatum(verval)}`,
    blokken: [
      { type: 'kop', tekst: 'Van' },
      ...regels([b.naam, b.adres, b.postcodePlaats, i.email, i.telefoon,
        i.toonKvk && b.kvkNummer ? `KVK ${b.kvkNummer}` : '', i.btw !== 'kor' && b.btwNummer ? `BTW ${b.btwNummer}` : '']),
      { type: 'kop', tekst: 'Aan' },
      ...regels([c.klantNaam, c.klantAdres, c.klantPlaats, c.klantRef ? `Uw referentie: ${c.klantRef}` : '']),
      { type: 'tabel', kop: 'Regels', kolommen, rijen },
      ...(i.btw === 'btw21' ? [
        { type: 'regel', label: 'Subtotaal', bedrag: t.sub },
        { type: 'regel', label: 'BTW 21%', bedrag: t.btw }] : []),
      { type: 'regel', label: 'Totaal', bedrag: t.totaal, totaal: true },
      ...(i.btw === 'kor' ? regels(['Vrijgesteld van omzetbelasting op grond van de kleineondernemersregeling (KOR).']) : []),
      ...regels([c.notitie]),
      ...regels([`Wij verzoeken je het bedrag van ${pdfBedrag(t.totaal)} voor ${nlDatum(verval)} over te maken${i.iban ? ` op ${i.iban}` : ''}${b.naam ? ` t.n.v. ${b.naam}` : ''}, onder vermelding van ${c.nummer}.`]),
      ...(i.voettekst ? [{ type: 'voet', tekst: i.voettekst }] : [])
    ]
  };
}

/** Zet het opgeslagen logo om naar jpeg-bytes (pdf.js kan alleen jpeg), op wit. */
export function logoAlsJpeg(dataUrl, plaats) {
  return new Promise(ok => {
    if (!dataUrl) { ok(null); return; }
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      cx.drawImage(img, 0, 0);
      cv.toBlob(async b => {
        if (!b) { ok(null); return; }
        ok({ jpeg: new Uint8Array(await b.arrayBuffer()), pxBreed: cv.width, pxHoog: cv.height, plaats });
      }, 'image/jpeg', 0.9);
    };
    img.onerror = () => ok(null);
    img.src = dataUrl;
  });
}

/** Bouwt de mailtekst. Los van de knop, zodat hij te testen is. */
export function mailTekst(c = concept(), i = opslag.instellingen) {
  const b = BEDRIJFSGEGEVENS || {};
  const t = totalen(c, i.btw);
  const verval = plusDagen(c.datum, num(c.termijn));
  const onderwerp = `${i.titel || 'Factuur'} ${c.nummer}${b.naam ? ` van ${b.naam}` : ''}`;
  const tekst = [
    c.klantNaam ? `Beste ${c.klantNaam},` : 'Beste klant,',
    '',
    `Hierbij ontvang je ${String(i.titel || 'factuur').toLowerCase()} ${c.nummer} (${pdfBedrag(t.totaal)}). In de bijlage vind je de pdf.`,
    `Wil je het bedrag voor ${nlDatum(verval)} overmaken${i.iban ? ` op ${i.iban}` : ''}, onder vermelding van ${c.nummer}?`,
    '',
    'Alvast bedankt en met vriendelijke groet,',
    b.naam || ''
  ].join('\n');
  return { onderwerp, tekst };
}

let wachtPreview = null;
function tekenPreview() {
  clearTimeout(wachtPreview);
  wachtPreview = setTimeout(() => {
    const f = el('fm-preview');
    if (f) f.srcdoc = factuurHtml();
    const t = totalen();
    const k = el('fm-totaal');
    if (k) k.textContent = fmt(t.totaal);
    waarschuwVoorraad();
  }, 120);
}

function waarschuwVoorraad() {
  const w = el('fm-waarschuwing');
  if (!w) return;
  const tekorten = concept().regels
    .filter(r => r.soort === 'artikel' && r.voorraad != null && num(r.aantal) > num(r.voorraad))
    .map(r => `${r.omschr}: ${num(r.aantal)} gevraagd, ${num(r.voorraad)} op voorraad`);
  w.innerHTML = tekorten.length ? `⚠️ ${tekorten.map(esc).join(' · ')}` : '';
  w.style.display = tekorten.length ? '' : 'none';
}

// ─── De pagina ──────────────────────────────────────────────────────────────

function artikelOpties() {
  const lijst = (state.COVERS || []).slice().sort((a, b) => String(a.artikel).localeCompare(String(b.artikel), 'nl'));
  return `<option value="">Artikel uit voorraad…</option>` +
    lijst.map(a => `<option value="${esc(a.id)}">${esc(a.artikel)} (${num(a.voorraad)} op voorraad)</option>`).join('');
}

function regelsHtml() {
  const c = concept();
  return c.regels.map((r, n) => `<div class="fm-regel" style="display:grid;grid-template-columns:1fr 70px 90px 28px;gap:6px;margin-bottom:6px;align-items:center">
    <input type="text" value="${esc(r.omschr)}" placeholder="Omschrijving" oninput="fmRegel(${n},'omschr',this.value)" aria-label="Omschrijving regel ${n + 1}">
    <input type="text" inputmode="decimal" value="${esc(String(r.aantal).replace('.', ','))}" oninput="fmRegel(${n},'aantal',this.value)" aria-label="Aantal regel ${n + 1}">
    <input type="text" inputmode="decimal" value="${esc(num(r.prijs).toFixed(2).replace('.', ','))}" onchange="fmRegel(${n},'prijs',this.value)" oninput="fmRegel(${n},'prijs',this.value,true)" aria-label="Prijs regel ${n + 1}">
    <button class="btn btn-sm" onclick="fmVerwijderRegel(${n})" title="Regel verwijderen" aria-label="Regel ${n + 1} verwijderen">×</button>
  </div>`).join('');
}

export function renderFactuurmaker() {
  neemCloudOver();
  const host = el('factuurmaker-inhoud');
  if (!host) return;
  const c = concept();
  const i = opslag.instellingen;
  const relaties = (state.RELATIES || []).map(r => `<option value="${esc(r.naam)}"></option>`).join('');
  const gekozen = c.opgeslagenId && vindFactuur(c.opgeslagenId);

  host.innerHTML = `
  <div style="display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:16px;align-items:start" class="fm-grid">
   <div>
    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:8px">Klant</div>
      <div class="form-group"><label>Naam</label><input type="text" list="fm-relaties" value="${esc(c.klantNaam)}" oninput="fmVeld('klantNaam',this.value)" onchange="fmKiesKlant(this.value)"><datalist id="fm-relaties">${relaties}</datalist></div>
      <div class="form-group"><label>Adres</label><input type="text" value="${esc(c.klantAdres)}" oninput="fmVeld('klantAdres',this.value)"></div>
      <div class="form-group"><label>Postcode en plaats</label><input type="text" value="${esc(c.klantPlaats)}" oninput="fmVeld('klantPlaats',this.value)"></div>
      <div class="form-group"><label>E-mail klant (voor Mailen)</label><input type="email" value="${esc(c.klantEmail || '')}" oninput="fmVeld('klantEmail',this.value)"></div>
      <div class="form-group"><label>Uw referentie (optioneel)</label><input type="text" value="${esc(c.klantRef)}" oninput="fmVeld('klantRef',this.value)"></div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:8px">Factuur</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 90px;gap:8px">
        <div class="form-group"><label>Nummer</label><input type="text" value="${esc(c.nummer)}" oninput="fmVeld('nummer',this.value)"></div>
        <div class="form-group"><label>Datum</label><input type="date" value="${esc(c.datum)}" onchange="fmVeld('datum',this.value)"></div>
        <div class="form-group"><label>Termijn (dgn)</label><input type="text" inputmode="numeric" value="${esc(c.termijn)}" oninput="fmVeld('termijn',this.value)"></div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:8px">Regels</div>
      <div class="muted" style="display:grid;grid-template-columns:1fr 70px 90px 28px;gap:6px;font-size:11px;margin-bottom:4px"><span>Omschrijving</span><span>Aantal</span><span>Prijs</span><span></span></div>
      <div id="fm-regels">${regelsHtml()}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <select onchange="fmKiesArtikel(this.value);this.value=''" aria-label="Artikel uit voorraad toevoegen" style="flex:1;min-width:160px">${artikelOpties()}</select>
        <button class="btn btn-sm" onclick="fmVoegRegel()">+ Eigen regel</button>
      </div>
      <div id="fm-waarschuwing" class="muted" style="display:none;margin-top:8px;font-size:12px;color:var(--warn,#b45309)"></div>
      <div class="form-group" style="margin-top:10px"><label>Opmerking onderaan (optioneel)</label><textarea rows="2" oninput="fmVeld('notitie',this.value)">${esc(c.notitie)}</textarea></div>
    </div>

    <details class="card" style="padding:14px;margin-bottom:12px">
      <summary style="font-weight:600;cursor:pointer">Indeling en gegevens</summary>
      <div style="margin-top:10px">
        <div class="form-group"><label>Titel</label><input type="text" value="${esc(i.titel)}" oninput="fmInst('titel',this.value)"></div>
        <div class="form-group"><label>BTW</label>
          <select onchange="fmInst('btw',this.value)">
            <option value="kor" ${i.btw === 'kor' ? 'selected' : ''}>Geen BTW (KOR)</option>
            <option value="btw21" ${i.btw === 'btw21' ? 'selected' : ''}>21% BTW erbij (prijzen excl. BTW)</option>
          </select></div>
        <div class="form-group"><label>IBAN</label><input type="text" value="${esc(i.iban)}" oninput="fmInst('iban',this.value)"></div>
        <div class="form-group"><label>E-mail</label><input type="text" value="${esc(i.email)}" oninput="fmInst('email',this.value)"></div>
        <div class="form-group"><label>Telefoon</label><input type="text" value="${esc(i.telefoon)}" oninput="fmInst('telefoon',this.value)"></div>
        <div class="form-group"><label>Kleur</label><input type="color" value="${esc(i.accent)}" oninput="fmInst('accent',this.value)"></div>
        <div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">
          <label><input type="checkbox" ${i.toonAantal ? 'checked' : ''} onchange="fmInst('toonAantal',this.checked)"> Kolom Aantal tonen</label>
          <label><input type="checkbox" ${i.toonStukprijs ? 'checked' : ''} onchange="fmInst('toonStukprijs',this.checked)"> Kolom Prijs tonen</label>
          <label><input type="checkbox" ${i.toonKvk ? 'checked' : ''} onchange="fmInst('toonKvk',this.checked)"> KVK-nummer tonen</label>
          <label><input type="checkbox" ${i.logoRechts ? 'checked' : ''} onchange="fmInst('logoRechts',this.checked)"> Logo rechts, titel links</label>
        </div>
        <div class="form-group"><label>Logo (optioneel)</label>
          <input type="file" accept="image/*" onchange="fmLogo(event)">
          ${i.logo ? `<button class="btn btn-sm" style="margin-top:6px" onclick="fmWisLogo()">Logo verwijderen</button>` : ''}</div>
        <div class="form-group"><label>Voettekst</label><textarea rows="2" oninput="fmInst('voettekst',this.value)">${esc(i.voettekst)}</textarea></div>
        <p class="muted" style="font-size:12px">Naam, adres, KVK en BTW-nummer komen uit je bedrijfsgegevens (Beheer). Deze instellingen blijven in deze browser staan.</p>
      </div>
    </details>
   </div>

   <div style="position:sticky;top:8px">
    <div class="card" style="padding:10px;margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <b>Totaal <span id="fm-totaal">${fmt(totalen().totaal)}</span></b>
      <span style="flex:1"></span>
      <button class="btn" onclick="fmNieuw()">Nieuwe factuur</button>
      <button class="btn" onclick="fmOpslaan()">${gekozen ? 'Bijwerken in Facturen' : 'Bewaren in Facturen'}</button>
      <button class="btn" onclick="fmMail()">Mailen</button>
      <button class="btn btn-primary" onclick="fmPrint()">Afdrukken / PDF</button>
    </div>
    <iframe id="fm-preview" title="Voorbeeld factuur" style="width:100%;height:760px;border:1px solid var(--border,#ddd);background:#fff;border-radius:6px" srcdoc=""></iframe>
   </div>
  </div>
  <style>@media (max-width:900px){.fm-grid{grid-template-columns:1fr !important}}</style>`;
  const f = el('fm-preview');
  if (f) f.srcdoc = factuurHtml();
  waarschuwVoorraad();
}

// ─── Handlers (aan window gehangen onderaan) ───────────────────────────────

function fmVeld(naam, waarde) {
  const c = concept();
  c[naam] = naam === 'termijn' ? num(waarde) : waarde;
  if (naam === 'datum') {
    // alleen automatisch meeschuiven als het nummer nog het voorgestelde is
    if (c.nummer === volgendNummer(c.datum) || !c.nummer) c.nummer = volgendNummer(waarde);
  }
  bewaar();
  if (naam === 'datum') renderFactuurmaker(); else tekenPreview();
}

function fmKiesKlant(naam) {
  const r = (state.RELATIES || []).find(x => String(x.naam).toLowerCase() === String(naam).trim().toLowerCase());
  if (!r) return;
  const c = concept();
  c.klantNaam = r.naam;
  if (r.adres) c.klantAdres = r.adres;
  if (r.postcodePlaats) c.klantPlaats = r.postcodePlaats;
  bewaar();
  renderFactuurmaker();
}

function fmRegel(n, veld, waarde, zonderRender) {
  const r = concept().regels[n];
  if (!r) return;
  r[veld] = (veld === 'aantal' || veld === 'prijs') ? num(waarde) : waarde;
  bewaar();
  tekenPreview();
}

function fmVoegRegel() {
  concept().regels.push({ soort: 'vrij', omschr: '', aantal: 1, prijs: 0 });
  bewaar();
  renderFactuurmaker();
}

function fmVerwijderRegel(n) {
  const c = concept();
  c.regels.splice(n, 1);
  if (!c.regels.length) c.regels.push({ soort: 'vrij', omschr: '', aantal: 1, prijs: 0 });
  bewaar();
  renderFactuurmaker();
}

function fmKiesArtikel(id) {
  if (!id) return;
  const a = (state.COVERS || []).find(x => String(x.id) === String(id));
  if (!a) return;
  const c = concept();
  const prijs = num(a.prijs ?? a.verkoop);
  const nieuw = { soort: 'artikel', artikelId: a.id, omschr: a.artikel, aantal: 1, prijs, voorraad: num(a.voorraad) };
  // een lege eerste regel vervangen in plaats van eronder te zetten
  const leeg = c.regels.length === 1 && !String(c.regels[0].omschr).trim() && !num(c.regels[0].prijs);
  if (leeg) c.regels[0] = nieuw; else c.regels.push(nieuw);
  bewaar();
  renderFactuurmaker();
}

function fmInst(naam, waarde) {
  opslag.instellingen[naam] = waarde;
  bewaar();
  if (naam === 'btw') renderFactuurmaker(); else tekenPreview();
}

function fmLogo(ev) {
  const bestand = ev.target.files && ev.target.files[0];
  if (!bestand) return;
  const lezer = new FileReader();
  lezer.onload = () => {
    const img = new Image();
    img.onload = () => {
      const schaal = Math.min(1, 400 / img.width, 200 / img.height);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * schaal));
      cv.height = Math.max(1, Math.round(img.height * schaal));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      opslag.instellingen.logo = cv.toDataURL('image/png');
      bewaar();
      renderFactuurmaker();
    };
    img.src = lezer.result;
  };
  lezer.readAsDataURL(bestand);
}

function fmWisLogo() {
  opslag.instellingen.logo = '';
  bewaar();
  renderFactuurmaker();
}

function fmNieuw() {
  const c = concept();
  if (!c.opgeslagenId && (c.klantNaam || c.regels.some(r => String(r.omschr).trim()))
      && !confirm('Deze factuur is nog niet bewaard in Facturen. Toch een nieuwe beginnen?')) return;
  opslag.concept = nieuwConcept();
  bewaar();
  renderFactuurmaker();
}

async function fmMail() {
  const c = concept();
  const t = totalen();
  if (!c.klantNaam.trim() || t.totaal <= 0) { alert('Vul eerst de klant en minstens één regel met een bedrag in.'); return; }
  const { onderwerp, tekst } = mailTekst();
  const bestandsnaam = `factuur-${c.nummer}.pdf`;
  const model = factuurPdfModel();
  const logo = await logoAlsJpeg(opslag.instellingen.logo, opslag.instellingen.logoRechts ? 'rechts' : 'links');
  if (logo) model.logo = logo;
  const bytes = modelNaarPdf(model);
  const bestand = new File([bytes], bestandsnaam, { type: 'application/pdf' });
  // Waar de browser het toelaat (telefoon, Mac, Windows) kan de pdf als bijlage
  // meegegeven worden aan je mailprogramma.
  try {
    if (navigator.canShare && navigator.canShare({ files: [bestand] })) {
      await navigator.share({ files: [bestand], title: onderwerp, text: tekst });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // gebruiker annuleerde
  }
  // Anders: pdf downloaden en een kant-en-klare mail openen. De bijlage moet
  // dan zelf worden toegevoegd; een webpagina kan dat niet voor je doen.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = bestandsnaam;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const aan = (c.klantEmail || '').trim();
  location.href = `mailto:${encodeURIComponent(aan)}?subject=${encodeURIComponent(onderwerp)}&body=${encodeURIComponent(tekst + '\n\n(Voeg de gedownloade pdf ' + bestandsnaam + ' toe als bijlage.)')}`;
}

function fmPrint() {
  const f = el('fm-preview');
  if (!f) return;
  f.srcdoc = factuurHtml();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { alert('Afdrukken lukt niet vanuit dit venster.'); } }, 250);
}

function fmOpslaan() {
  const c = concept();
  const t = totalen();
  if (!c.klantNaam.trim()) { alert('Vul eerst de naam van de klant in.'); return; }
  if (!c.nummer.trim()) { alert('Vul eerst een factuurnummer in.'); return; }
  if (t.totaal <= 0) { alert('Het totaal moet hoger zijn dan nul.'); return; }
  const regels = c.regels.filter(r => String(r.omschr).trim() || num(r.prijs));
  const omschrijving = regels.map(r => `${num(r.aantal)}× ${r.omschr}`).join('; ').slice(0, 300);
  const gegevens = {
    soort: 'debiteur', relatie: c.klantNaam, factuurnummer: c.nummer, datum: c.datum,
    vervaldatum: plusDagen(c.datum, num(c.termijn)), bedrag: t.totaal, omschrijving, regels
  };
  const bestaand = c.opgeslagenId && vindFactuur(c.opgeslagenId);
  if (!bestaand && factuurnummerInGebruik('debiteur', c.klantNaam, c.nummer)) {
    alert(`Factuurnummer ${c.nummer} bestaat al voor ${c.klantNaam}. Kies een ander nummer.`);
    return;
  }
  if (bestaand) werkFactuurBij(c.opgeslagenId, gegevens);
  else c.opgeslagenId = voegFactuurToe(gegevens).id;
  bewaar();
  renderFactuurmaker();
  alert(bestaand ? 'Factuur bijgewerkt in Facturen.' : 'Factuur bewaard in Facturen als openstaande post.');
}

Object.assign(window, {
  renderFactuurmaker, fmVeld, fmKiesKlant, fmRegel, fmVoegRegel, fmVerwijderRegel,
  fmKiesArtikel, fmInst, fmLogo, fmWisLogo, fmNieuw, fmPrint, fmOpslaan, fmMail
});
