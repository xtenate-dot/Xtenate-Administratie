// pdf.js — maakt een pdf zonder externe bibliotheek.
//
// De app draait van een eigen map en mag niet afhankelijk zijn van een cdn:
// zonder internet moet een aangifte nog steeds te downloaden zijn. Daarom
// schrijven we het pdf-formaat hier zelf. Veel is er niet voor nodig: tekst in
// een standaardlettertype op A4, plus een enkele streep boven een totaal.

const A4 = { breed: 595.28, hoog: 841.89 };
const MARGE = 56;          // ~2 cm
const REGELHOOGTE = 14;
const CORPS = 10;
const KOP_CORPS = 15;

// De standaardlettertypen van pdf gebruiken WinAnsi. Dat is bijna latin-1, met
// een paar afwijkingen in het bereik 0x80–0x9F. Het euroteken is de
// belangrijkste: dat zit op 0x80 en zou anders een vraagteken worden.
const WINANSI_AFWIJKEND = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F,
  0x202F: 0x20, 0x00A0: 0x20   // smalle en vaste spatie worden gewone spatie
};

/** Tekst naar WinAnsi-bytes; onbekende tekens worden een vraagteken. */
function naarWinAnsi(tekst) {
  const uit = [];
  for (const teken of String(tekst)) {
    const code = teken.codePointAt(0);
    if (code === 0x0A) continue;
    if (WINANSI_AFWIJKEND[code] != null) uit.push(WINANSI_AFWIJKEND[code]);
    else if (code <= 0xFF) uit.push(code);
    else uit.push(0x3F);
  }
  return uit;
}

/** Haakjes en backslash hebben betekenis in een pdf-string. */
function ontsnap(bytes) {
  const uit = [];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) uit.push(0x5C);
    uit.push(b);
  }
  return uit;
}

// Breedtes van Helvetica per duizend eenheden, voor de tekens die in bedragen
// voorkomen. Meer is niet nodig: we meten alleen om bedragen rechts uit te
// lijnen, en voor letters is een schatting nauwkeurig genoeg.
const BREEDTES = {
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556,
  '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  '.': 278, ',': 278, ' ': 278, '-': 333, '\u2013': 556, '\u20AC': 556
};

function breedte(tekst, corps) {
  let som = 0;
  for (const teken of String(tekst)) som += (BREEDTES[teken] ?? 500) / 1000;
  return som * corps;
}

/**
 * Breekt een regel af op woordgrenzen. Breedte schatten we op 0,52 × corps per
 * teken: Helvetica is gemiddeld smaller, dus we houden marge over en er valt
 * niets weg aan de rechterkant.
 */
function breekAf(regel, maxBreedte, corps) {
  const max = Math.max(8, Math.floor(maxBreedte / (corps * 0.52)));
  if (regel.length <= max) return [regel];

  const uit = [];
  let rest = regel;
  while (rest.length > max) {
    let knip = rest.lastIndexOf(' ', max);
    if (knip <= 0) knip = max;
    uit.push(rest.slice(0, knip));
    rest = rest.slice(knip).replace(/^ +/, '');
  }
  if (rest) uit.push(rest);
  return uit;
}

function bedragNl(n) {
  return (Math.round(n * 100) / 100).toLocaleString('nl-NL', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

/**
 * Zet het aangiftemodel om naar een pdf.
 *
 * Koppen vet, bedragen rechts uitgelijnd in één kolom, en boven elk totaal een
 * streep over de bedragkolom. Zo zie je meteen welke regels erboven bij elkaar
 * horen, zoals op een gewone afrekening.
 */
export function modelNaarPdf(doc) {
  const links = MARGE;
  const rechts = A4.breed - MARGE;
  const paginas = [];
  let pagina = { tekst: [], lijnen: [] };
  let y = A4.hoog - MARGE;

  const volgende = () => {
    paginas.push(pagina);
    pagina = { tekst: [], lijnen: [] };
    y = A4.hoog - MARGE;
  };
  const ruimte = n => { if (y - n < MARGE) volgende(); };

  const zetRegel = (label, bedrag, { vet = false, streep = false } = {}) => {
    if (streep) {
      ruimte(REGELHOOGTE + 8);
      pagina.lijnen.push({
        x1: rechts - Math.max(breedte(bedrag, CORPS), 62) - 6,
        x2: rechts,
        y: y - 4
      });
      y -= 8;
    }
    ruimte(REGELHOOGTE);
    y -= REGELHOOGTE;
    pagina.tekst.push({ tekst: label, x: links, y, corps: CORPS, vet });
    pagina.tekst.push({ tekst: bedrag, x: rechts - breedte(bedrag, CORPS), y, corps: CORPS, vet });
  };

  // Optioneel logo (jpeg) boven aan de eerste pagina, op maximaal 150 x 50 punten.
  if (doc.logo && doc.logo.jpeg && doc.logo.pxBreed > 0 && doc.logo.pxHoog > 0) {
    const schaal = Math.min(150 / doc.logo.pxBreed, 50 / doc.logo.pxHoog);
    const w = doc.logo.pxBreed * schaal;
    const h = doc.logo.pxHoog * schaal;
    const rechtsBoven = doc.logo.plaats === 'rechts';
    pagina.afbeelding = { x: rechtsBoven ? rechts - w : links, y: A4.hoog - MARGE - h + 8, w, h };
    if (!rechtsBoven) y -= h + 4;     // links: de rest schuift omlaag
  }

  y -= 22;
  pagina.tekst.push({ tekst: doc.titel, x: links, y, corps: KOP_CORPS, vet: true });
  y -= REGELHOOGTE;
  pagina.tekst.push({ tekst: doc.ondertitel, x: links, y, corps: CORPS, vet: false });

  for (const b of doc.blokken || []) {
    if (b.type === 'kop') {
      ruimte(REGELHOOGTE + 20);
      y -= 20;
      pagina.tekst.push({ tekst: b.tekst, x: links, y, corps: CORPS + 1, vet: true });
      y -= 4;

    } else if (b.type === 'regel') {
      zetRegel(b.label, (b.aftrek ? '\u2013 \u20AC ' : '\u20AC ') + bedragNl(b.bedrag),
               { vet: !!b.totaal, streep: !!b.totaal });

    } else if (b.type === 'toelichting') {
      ruimte(REGELHOOGTE * 2);
      y -= REGELHOOGTE;
      pagina.tekst.push({
        tekst: `${b.label} \u2014 \u20AC ${bedragNl(b.bedrag)}`,
        x: links, y, corps: CORPS, vet: true
      });
      for (const deel of breekAf(b.tekst, A4.breed - MARGE * 2 - 14, CORPS - 1)) {
        ruimte(REGELHOOGTE);
        y -= REGELHOOGTE - 2;
        pagina.tekst.push({ tekst: deel, x: links + 14, y, corps: CORPS - 1, vet: false });
      }
      y -= 4;

    } else if (b.type === 'tabel') {
      // Een tabel met vaste kolombreedtes. De kop wordt op elke nieuwe pagina
      // herhaald, anders staat een lijst die doorloopt zonder kolomnamen.
      const kolommen = b.kolommen || [];
      const posities = [];
      let x = links;
      for (const k of kolommen) { posities.push(x); x += k.breedte; }

      const kortAf = (tekst, maxBreedte, corps) => {
        let t = String(tekst ?? '');
        if (breedte(t, corps) <= maxBreedte) return t;
        while (t.length > 1 && breedte(t + '\u2026', corps) > maxBreedte) t = t.slice(0, -1);
        return t + '\u2026';
      };

      const zetKop = () => {
        ruimte(REGELHOOGTE + 10);
        y -= REGELHOOGTE;
        kolommen.forEach((k, i) => {
          const corps = CORPS - 1;
          const t = kortAf(k.kop, k.breedte - 4, corps);
          const px = k.rechts ? posities[i] + k.breedte - 4 - breedte(t, corps) : posities[i];
          pagina.tekst.push({ tekst: t, x: px, y, corps, vet: true });
        });
        pagina.lijnen.push({ x1: links, x2: Math.min(x, rechts), y: y - 4 });
        y -= 6;
      };

      if (b.kop) {
        ruimte(REGELHOOGTE + 20);
        y -= 20;
        pagina.tekst.push({ tekst: b.kop, x: links, y, corps: CORPS + 1, vet: true });
        y -= 4;
      }
      zetKop();

      for (const rij of b.rijen || []) {
        // Past de rij niet meer, dan naar de volgende pagina met een nieuwe kop.
        if (y - REGELHOOGTE < MARGE) { volgende(); zetKop(); }
        y -= REGELHOOGTE - 1;
        const vet = !!rij.vet;
        const cellen = rij.cellen || rij;
        kolommen.forEach((k, i) => {
          const corps = CORPS - 1;
          const t = kortAf(cellen[i], k.breedte - 4, corps);
          const px = k.rechts ? posities[i] + k.breedte - 4 - breedte(t, corps) : posities[i];
          pagina.tekst.push({ tekst: t, x: px, y, corps, vet });
        });
        if (rij.streep) pagina.lijnen.push({ x1: links, x2: Math.min(x, rechts), y: y - 4 });
      }
      y -= 6;

    } else if (b.type === 'tekst' || b.type === 'voet') {
      ruimte(REGELHOOGTE * 2);
      y -= b.type === 'voet' ? 22 : REGELHOOGTE;
      for (const deel of breekAf(b.tekst, A4.breed - MARGE * 2, CORPS - 1)) {
        ruimte(REGELHOOGTE);
        y -= REGELHOOGTE - 2;
        pagina.tekst.push({ tekst: deel, x: links, y, corps: CORPS - 1, vet: false });
      }
    }
  }

  paginas.push(pagina);
  return bouwPdf(paginas, doc.titel, doc.logo && doc.logo.jpeg ? doc.logo : null);
}

/** Platte tekst als pdf, voor als er geen model is maar wel regels. */
export function tekstNaarPdf(tekst, { titel = 'Document' } = {}) {
  const paginas = [];
  let pagina = { tekst: [], lijnen: [] };
  let y = A4.hoog - MARGE;

  for (const [i, ruw] of String(tekst).split('\n').entries()) {
    if (!ruw.trim()) { y -= REGELHOOGTE * 0.6; continue; }
    const kop = i === 0 || (/[A-ZÀ-Þ]/.test(ruw) && ruw === ruw.toUpperCase() && ruw.trim().length > 2);
    const corps = i === 0 ? KOP_CORPS : CORPS;

    for (const deel of breekAf(ruw, A4.breed - MARGE * 2, corps)) {
      if (y - REGELHOOGTE < MARGE) { paginas.push(pagina); pagina = { tekst: [], lijnen: [] }; y = A4.hoog - MARGE; }
      y -= REGELHOOGTE + (kop && i > 0 ? 8 : 0);
      pagina.tekst.push({ tekst: deel, x: MARGE, y, corps, vet: kop });
    }
  }
  paginas.push(pagina);
  return bouwPdf(paginas, titel);
}

/**
 * Schrijft pagina's weg als pdf-bestand.
 *
 * Elke pagina is { tekst: [{tekst,x,y,corps,vet}], lijnen: [{x1,x2,y}] }.
 * Objectnummering: 1 catalogus, 2 pagina-boom, 3 gewoon lettertype, 4 vet
 * lettertype, daarna per pagina twee objecten (de pagina en zijn inhoud).
 */
function bouwPdf(paginas, titel, logo = null) {
  const objecten = [];
  const paginaIds = paginas.map((_, i) => 5 + i * 2);
  const logoId = 5 + paginas.length * 2;

  objecten[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objecten[2] = `<< /Type /Pages /Kids [${paginaIds.map(id => `${id} 0 R`).join(' ')}] /Count ${paginas.length} >>`;
  objecten[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objecten[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  const stromen = [];
  paginas.forEach((pagina, i) => {
    const id = paginaIds[i];
    objecten[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.breed.toFixed(2)} ${A4.hoog.toFixed(2)}] ` +
                   `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${pagina.afbeelding && logo ? ` /XObject << /Im1 ${logoId} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`;

    const stukken = [];
    const schrijfStuk = t => { for (const c of t) stukken.push(c.charCodeAt(0)); };

    if (pagina.afbeelding && logo) {
      const a = pagina.afbeelding;
      schrijfStuk(`q ${a.w.toFixed(2)} 0 0 ${a.h.toFixed(2)} ${a.x.toFixed(2)} ${a.y.toFixed(2)} cm /Im1 Do Q\n`);
    }
    for (const l of pagina.lijnen || []) {
      schrijfStuk(`0.6 w 0.2 0.2 0.2 RG\n${l.x1.toFixed(2)} ${l.y.toFixed(2)} m ${l.x2.toFixed(2)} ${l.y.toFixed(2)} l S\n`);
    }
    for (const r of pagina.tekst || []) {
      schrijfStuk('BT\n');
      schrijfStuk(`/${r.vet ? 'F2' : 'F1'} ${r.corps} Tf 1 0 0 1 ${r.x.toFixed(2)} ${r.y.toFixed(2)} Tm (`);
      stukken.push(...ontsnap(naarWinAnsi(r.tekst)));
      schrijfStuk(') Tj\nET\n');
    }
    stromen[id + 1] = stukken;
    objecten[id + 1] = null;
  });

  const uit = [];
  const schrijf = t => { for (const c of t) uit.push(c.charCodeAt(0)); };
  const posities = [];

  schrijf('%PDF-1.4\n');
  // Hoge bytes in het commentaar vertellen lezers dat dit een binair bestand is.
  uit.push(0x25, 0xC7, 0xEC, 0x8F, 0xA2, 0x0A);

  const hoogste = 4 + paginas.length * 2 + (logo ? 1 : 0);
  for (let nr = 1; nr <= hoogste; nr++) {
    posities[nr] = uit.length;
    if (logo && nr === logoId) {
      schrijf(`${nr} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${logo.pxBreed} /Height ${logo.pxHoog} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.jpeg.length} >>\nstream\n`);
      for (const byte of logo.jpeg) uit.push(byte);
      schrijf('\nendstream\nendobj\n');
    } else if (stromen[nr]) {
      schrijf(`${nr} 0 obj\n<< /Length ${stromen[nr].length} >>\nstream\n`);
      uit.push(...stromen[nr]);
      schrijf('\nendstream\nendobj\n');
    } else {
      schrijf(`${nr} 0 obj\n${objecten[nr]}\nendobj\n`);
    }
  }

  const xref = uit.length;
  schrijf(`xref\n0 ${hoogste + 1}\n0000000000 65535 f \n`);
  for (let nr = 1; nr <= hoogste; nr++) {
    schrijf(`${String(posities[nr]).padStart(10, '0')} 00000 n \n`);
  }
  schrijf(`trailer\n<< /Size ${hoogste + 1} /Root 1 0 R /Info << /Title (${
    String(titel).replace(/[()\\]/g, '')}) /Producer (Xtenate administratie) >> >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Uint8Array(uit);
}

/** Maakt de pdf van het aangiftemodel en zet de download in gang. */
export function downloadModelPdf(doc, bestandsnaam) {
  bied(modelNaarPdf(doc), bestandsnaam);
}

/** Maakt een pdf van platte tekst en zet de download in gang. */
export function downloadPdf(tekst, bestandsnaam, titel) {
  bied(tekstNaarPdf(tekst, { titel: titel || bestandsnaam }), bestandsnaam);
}

function bied(bytes, bestandsnaam) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = bestandsnaam;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
