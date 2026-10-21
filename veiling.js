// veiling.js — de twee veilingtabbladen uit het Excel-bestand, in de app.
//
// "Veiling inkopenVerkopen": één regel per factuurregel (een partij van de
// veiling), met inkoop, verkoop, winst en hoe lang het lag.
// "Veiling Voorraad": diezelfde partijen uitgesplitst naar het eigen artikel,
// bijvoorbeeld de spellen in een lot van vier, met per artikel wat er is
// ingekocht, verkocht en nog ligt.
//
// Dit bestand bevat alleen inlezen en rekenen. Het raakt geen scherm, geen
// opslag en geen andere gegevens van de app aan, zodat het los te testen is.
// De Excel blijft de bron: een nieuwe import vervangt wat hier stond.

/** Naam van het tabblad, zonder op hoofdletters of spaties te letten. */
const kern = t => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const tekst = v => (v === null || v === undefined) ? '' : String(v).trim();

const getal = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // "€ 1.234,50" of "-€ 73,53": punten als duizendtal, komma als decimaal.
  const s = String(v).replace(/[€\s ]/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Excel-datum (serienummer, Date of "dd-mm-jjjj") naar "jjjj-mm-dd". */
export function naarISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10);
  return null;
}

/** Het aantal dagen tussen twee ISO-datums. */
export function dagenTussen(vanISO, totISO) {
  if (!vanISO || !totISO) return null;
  const a = Date.UTC(+vanISO.slice(0, 4), +vanISO.slice(5, 7) - 1, +vanISO.slice(8, 10));
  const b = Date.UTC(+totISO.slice(0, 4), +totISO.slice(5, 7) - 1, +totISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

const STATUS = {
  verkocht: 'verkocht',
  opvoorraad: 'voorraad',
  voorraad: 'voorraad',
  deelsverkocht: 'deels'
};

/** Zoekt in de rijen de kopregel die al deze kolomnamen bevat. */
function zoekKop(rijen, namen) {
  for (let r = 0; r < Math.min(rijen.length, 40); r++) {
    const k = (rijen[r] || []).map(kern);
    if (namen.every(n => k.includes(kern(n)))) return r;
  }
  return -1;
}

/** Kolomnummers per kopnaam; bij dubbele namen telt de eerste. */
function kolommen(kopRij) {
  const uit = {};
  (kopRij || []).forEach((h, i) => { const k = kern(h); if (k && !(k in uit)) uit[k] = i; });
  return uit;
}

/** Lees het tabblad "Veiling inkopenVerkopen". */
export function leesInkopen(rijen) {
  const kop = zoekKop(rijen, ['Omschrijving', 'Inkoopdatum', 'Inkoop']);
  if (kop < 0) throw new Error('Geen kopregel gevonden (Omschrijving, Inkoopdatum, Inkoop).');
  const c = kolommen(rijen[kop]);
  const col = naam => c[kern(naam)];

  // Het btw-tarief staat los bovenin: een cel "Btw-tarief" met het getal ernaast.
  let btw = null;
  for (const r of rijen.slice(0, kop)) {
    (r || []).forEach((v, i) => { if (kern(v) === 'btwtarief') btw = getal(r[i + 1]); });
  }

  const lijst = [];
  for (let r = kop + 1; r < rijen.length; r++) {
    const rij = rijen[r] || [];
    const omschr = tekst(rij[col('Omschrijving')]);
    if (!omschr) continue;
    const inkoop = getal(rij[col('Inkoop')]);
    if (inkoop === null) continue;   // geen bedrag: geen echte regel
    lijst.push({
      omschr,
      factuur: tekst(rij[col('Factuurnr.')]),
      datum: naarISO(rij[col('Inkoopdatum')]),
      hamer: getal(rij[col('Hamerprijs')]),
      opgeld: getal(rij[col('Opgeld')]),
      inkoop,
      aantal: getal(rij[col('Aantal')]) || 1,
      verkoopDatum: naarISO(rij[col('Verkoopdatum')]),
      verkoop: getal(rij[col('Verkoopprijs')]),
      status: STATUS[kern(rij[col('Status')])] || (getal(rij[col('Verkoopprijs')]) !== null ? 'verkocht' : 'voorraad')
    });
  }
  return { btw, lijst };
}

/** Lees het tabblad "Veiling Voorraad": het voorraadblok links en de eerdere verkopen rechts. */
export function leesVoorraad(rijen) {
  const kop = zoekKop(rijen, ['Artikel', 'Groep', 'Ingekocht', 'Voorraad']);
  if (kop < 0) throw new Error('Geen kopregel gevonden (Artikel, Groep, Ingekocht, Voorraad).');
  const k = (rijen[kop] || []).map(kern);
  const a1 = k.indexOf('artikel');
  const a2 = k.indexOf('artikel', a1 + 1);   // het tweede blok, rechts
  const links = {
    artikel: a1, groep: k.indexOf('groep'), ingekocht: k.indexOf('ingekocht'),
    eerder: k.indexOf('eerderverkocht'), log: k.indexOf('verkochtvialog'),
    voorraad: k.indexOf('voorraad')
  };

  const artikelen = [];
  const verkopen = [];
  let verkopenTotaal = null;

  for (let r = kop + 1; r < rijen.length; r++) {
    const rij = rijen[r] || [];

    const naam = tekst(rij[links.artikel]);
    if (naam) {
      const lk = kern(naam);
      if (lk.startsWith('subtotaal') || lk === 'totaal' || lk.startsWith('totaal')) {
        artikelen.push({ soort: lk.startsWith('subtotaal') ? 'sub' : 'totaal', artikel: naam });
      } else if (tekst(rij[links.groep]) || getal(rij[links.ingekocht]) !== null) {
        artikelen.push({
          soort: 'artikel',
          artikel: naam,
          groep: tekst(rij[links.groep]),
          ingekocht: getal(rij[links.ingekocht]) || 0,
          eerder: getal(rij[links.eerder]) || 0,
          log: getal(rij[links.log]) || 0
        });
      }
    }

    if (a2 > 0) {
      const spel = tekst(rij[a2]);
      if (spel) {
        const aantal = getal(rij[a2 + 1]);
        const prijs = getal(rij[a2 + 2]);
        const opbrengst = getal(rij[a2 + 3]);
        const overig = getal(rij[a2 + 4]);
        if (kern(spel) === 'totaal') verkopenTotaal = { aantal, opbrengst, overig };
        else verkopen.push({ artikel: spel, aantal, prijs, opbrengst, overig });
      }
    }
  }
  return { artikelen, verkopen, verkopenTotaal };
}

/**
 * Leest het hele werkboek (SheetJS) en geeft de twee tabbladen terug.
 * Ontbreekt een tabblad, dan zit dat in `ontbreekt` en blijft de rest werken.
 */
export function leesVeilingWerkboek(XLSX, werkboek) {
  const vind = deel => werkboek.SheetNames.find(n => kern(n).includes(kern(deel)));
  const naarRijen = naam => XLSX.utils.sheet_to_json(werkboek.Sheets[naam], { header: 1, defval: null, raw: true });

  const uit = { inkopen: null, voorraad: null, ontbreekt: [] };
  const tabInkoop = vind('Veiling inkopenVerkopen');
  const tabVoorraad = vind('Veiling Voorraad');

  if (tabInkoop) uit.inkopen = leesInkopen(naarRijen(tabInkoop)); else uit.ontbreekt.push('Veiling inkopenVerkopen');
  if (tabVoorraad) uit.voorraad = leesVoorraad(naarRijen(tabVoorraad)); else uit.ontbreekt.push('Veiling Voorraad');
  return uit;
}

// ------------------------------------------------------------ berekeningen

/** Per regel: prijs per stuk, winst, rendement en hoeveel dagen het lag of lag. */
export function verrijkInkoop(regel, vandaagISO) {
  const heeftVerkoop = regel.verkoop !== null && regel.verkoop !== undefined;
  const winst = heeftVerkoop ? regel.verkoop - regel.inkoop : null;
  return {
    ...regel,
    prijsPerStuk: regel.aantal > 0 ? regel.inkoop / regel.aantal : null,
    winst,
    rendement: winst !== null && regel.inkoop > 0 ? winst / regel.inkoop : null,
    dagen: dagenTussen(regel.datum, regel.verkoopDatum || vandaagISO)
  };
}

/** De kengetallen bovenaan het tabblad, zoals in de Excel. */
export function inkoopTotalen(lijst) {
  const verkocht = lijst.filter(r => r.status === 'verkocht' && r.verkoop != null);
  const deels = lijst.filter(r => r.status === 'deels');
  const voorraad = lijst.filter(r => r.status === 'voorraad');

  const totaalIngekocht = lijst.reduce((s, r) => s + r.inkoop, 0);
  const omzet = verkocht.reduce((s, r) => s + r.verkoop, 0);
  const inkoopVerkocht = verkocht.reduce((s, r) => s + r.inkoop, 0);
  const winst = omzet - inkoopVerkocht;
  const inkoopwaardeVoorraad = totaalIngekocht - inkoopVerkocht;

  return {
    partijen: lijst.length,
    verkocht: verkocht.length,
    deels: deels.length,
    opVoorraad: voorraad.length,
    totaalIngekocht,
    omzet,
    winst,
    rendement: inkoopVerkocht > 0 ? winst / inkoopVerkocht : null,
    inkoopwaardeVoorraad,
    saldo: omzet - totaalIngekocht
  };
}

/** Voorraad = ingekocht − eerder verkocht − verkocht via het logboek. */
export function voorraadVan(a) {
  return (a.ingekocht || 0) - (a.eerder || 0) - (a.log || 0);
}

/**
 * Het voorraadblok met tussentotalen per groep. De subtotalen en het totaal
 * worden hier opnieuw opgeteld uit de artikelen zelf, zodat ze nooit afwijken
 * van wat erboven staat.
 */
export function voorraadRegels(artikelen) {
  const uit = [];
  let groep = [];
  const som = lijst => lijst.reduce((s, a) => ({
    ingekocht: s.ingekocht + a.ingekocht, eerder: s.eerder + a.eerder,
    log: s.log + a.log, voorraad: s.voorraad + a.voorraad
  }), { ingekocht: 0, eerder: 0, log: 0, voorraad: 0 });
  const alle = [];

  for (const a of artikelen) {
    if (a.soort === 'artikel') {
      const rij = { ...a, voorraad: voorraadVan(a) };
      rij.status = rij.voorraad <= 0 ? 'uitverkocht' : 'op voorraad';
      uit.push(rij); groep.push(rij); alle.push(rij);
    } else if (a.soort === 'sub') {
      uit.push({ soort: 'sub', artikel: a.artikel, ...som(groep) });
      groep = [];
    }
  }
  uit.push({ soort: 'totaal', artikel: 'Totaal alle artikelen', ...som(alle) });
  return uit;
}
