// marge.js — kostprijs en marge per artikel en verkoopkanaal.
//
// Een rekenhulp om ongeveer te zien wat je per verkoop overhoudt. Los van de
// voorraad en de boekhouding: er wordt niets geboekt en niets uit de voorraad
// gelezen, zodat een gewijzigde inkoopprijs hier nooit de cijfers elders raakt.
// De opzet en de formules komen uit het bestand "Winst / kostprijsberekening".

import { state, bewaarMarge } from './storage.js?v=20261127c';

export const KANALEN = {
  nl:  { naam: 'Bol.com Nederland',        kort: 'Bol NL',  soort: 'bol' },
  be:  { naam: 'Bol.com België',           kort: 'Bol BE',  soort: 'bol' },
  web: { naam: 'Eigen website (Shopify)',  kort: 'Website', soort: 'web' }
};
export const BOL_BTW = 1.21;   // de commissie op de Bol-factuur staat excl. btw; jij draagt de btw zelf (KOR)

export const GEEN_VERZENDING = 'Geen (leverancier verstuurt)';

const nr = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const rond = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** De startwaarden, overgenomen uit het Excel-bestand. */
export function standaardMarge() {
  return {
    versie: 1,
    kosten: {
      verpakking: [
        { id: 'v0', naam: 'Geen verpakking',                    bedrag: 0,     verzend: 0,    aantal: 1 },
        { id: 'v1', naam: 'Plastic kleding verzendzak',         bedrag: 22.69, verzend: 0,    aantal: 100 },
        { id: 'v2', naam: 'Plastic kleding verzendzak (klein)', bedrag: 16.78, verzend: 0,    aantal: 100 },
        { id: 'v3', naam: 'Autolockdoos (S)',                   bedrag: 46.89, verzend: 0,    aantal: 50 },
        { id: 'v4', naam: 'Brievenbusdoos (M)',                 bedrag: 21.78, verzend: 8.25, aantal: 100 },
        { id: 'v5', naam: 'Postdoos (XS)',                      bedrag: 34.49, verzend: 8.25, aantal: 50 },
        { id: 'v6', naam: 'Amerikaanse vouwdoos',               bedrag: 21.24, verzend: 0,    aantal: 15 }
      ],
      extras: [
        { id: 'e1', naam: 'Goudenbeertjes', bedrag: 18,    verzend: 0, aantal: 200 },
        { id: 'e2', naam: 'Visitekaartje',  bedrag: 21.93, verzend: 0, aantal: 100 }
      ],
      verzending: [
        { id: 'z0', naam: GEEN_VERZENDING,   nl: 0,    be: 0,    web: 0 },
        { id: 'z1', naam: 'Brievenbuspakket', nl: 4.35, be: 9.5,  web: 0 },
        { id: 'z2', naam: 'Pakket',           nl: 6.35, be: 9.5,  web: 0 },
        { id: 'z3', naam: 'Groot pakket',     nl: 7.45, be: 10.5, web: 0 }
      ],
      rit: { km: 4, perKm: 0.23 },
      retourPct: 3,
      print: { rolPrijs: 8, rolGram: 1000, afschrijving: 0.2, stroom: 0.1, onderhoud: 0.1, faal: 0.05 }
    },
    producten: [
      {
        id: 'p1', naam: 'Hoes', stuks: 1, verpakking: 'Plastic kleding verzendzak (klein)',
        extras: true, perRit: 1, methode: 'Pakket', gram: 0, uur: 0,
        regels: [
          { id: 'r1', kanaal: 'nl',  variant: '', verzending: 'zelf',       prijs: 31.95, inkoop: 12.5, kosten: 4.81 },
          { id: 'r2', kanaal: 'be',  variant: '', verzending: 'zelf',       prijs: 34.95, inkoop: 12.5, kosten: 5.18 },
          { id: 'r3', kanaal: 'web', variant: '', verzending: 'leverancier', prijs: 29.95, inkoop: 15,   kosten: 2 }
        ]
      },
      {
        id: 'p2', naam: 'Funko Pop houder', stuks: 4, verpakking: 'Brievenbusdoos (M)',
        extras: true, perRit: 1, methode: 'Pakket', gram: 44.14, uur: 1.5,
        regels: [
          { id: 'r4', kanaal: 'nl', variant: '', verzending: 'zelf', prijs: 21.95, inkoop: null, kosten: 3.57 },
          { id: 'r5', kanaal: 'be', variant: '', verzending: 'zelf', prijs: 24.95, inkoop: null, kosten: 2.63 }
        ]
      },
      {
        id: 'p3', naam: 'Helm Mascotte', stuks: 1, verpakking: 'Postdoos (XS)',
        extras: true, perRit: 1, methode: 'Pakket', gram: 0, uur: 0,
        regels: [
          { id: 'r6',  kanaal: 'nl',  variant: 'Zonder licht', verzending: 'zelf', prijs: 24.95, inkoop: 7,   kosten: 3.94 },
          { id: 'r7',  kanaal: 'nl',  variant: 'Met licht',    verzending: 'zelf', prijs: 27.95, inkoop: 8.5, kosten: 4.31 },
          { id: 'r8',  kanaal: 'be',  variant: 'Zonder licht', verzending: 'zelf', prijs: 29.95, inkoop: 7,   kosten: 4.56 },
          { id: 'r9',  kanaal: 'be',  variant: 'Met licht',    verzending: 'zelf', prijs: 30.95, inkoop: 8.5, kosten: 4.69 },
          { id: 'r10', kanaal: 'web', variant: 'Zonder licht', verzending: 'zelf', prijs: 19.95, inkoop: 7,   kosten: 2 }
        ]
      }
    ]
  };
}

/** De opgeslagen gegevens, of de startwaarden zolang er niets is bewaard. */
export function leesMarge() {
  return state.MARGE && state.MARGE.kosten ? state.MARGE : standaardMarge();
}

// ---------- Rekenen ----------

const prijsPerStuk = o => nr(o.aantal) > 0 ? (nr(o.bedrag) + nr(o.verzend)) / nr(o.aantal) : 0;

/** Prijs per stuk van een verpakking, op naam. 0 als de verpakking niet (meer) bestaat. */
export function verpakkingPrijs(kosten, naam) {
  const v = kosten.verpakking.find(x => x.naam === naam);
  return v ? prijsPerStuk(v) : 0;
}
export const extrasPerPakket = kosten => kosten.extras.reduce((s, e) => s + prijsPerStuk(e), 0);
export const ritKosten = kosten => nr(kosten.rit.km) * nr(kosten.rit.perKm);
export function printKostenPerGram(kosten) { const p = kosten.print; return nr(p.rolGram) > 0 ? nr(p.rolPrijs) / nr(p.rolGram) : 0; }
export const machineKostenPerUur = kosten => { const p = kosten.print; return nr(p.afschrijving) + nr(p.stroom) + nr(p.onderhoud) + nr(p.faal); };

/** Tarief voor een verzendmethode naar een kanaal; null als de methode niet bestaat. */
export function verzendTarief(kosten, methode, kanaal) {
  const z = kosten.verzending.find(x => x.naam === methode);
  return z ? nr(z[kanaal]) : null;
}

/** Wat het maken van één verkoopeenheid kost (3D-print), als er gram en uren zijn ingevuld. */
export function productiekosten(kosten, p) {
  const stuks = Math.max(1, nr(p.stuks));
  return nr(p.gram) * stuks * printKostenPerGram(kosten) + nr(p.uur) * stuks * machineKostenPerUur(kosten);
}

export function oordeel(winst, marge) {
  if (winst <= 0) return 'Verlies';
  if (marge < 0.2) return 'Krap';
  if (marge < 0.3) return 'Redelijk';
  return 'Goed';
}

/**
 * Rekent één regel (product, kanaal, variant) door. Alle bedragen zijn per
 * verkoopeenheid (= per verkoop), zoals in het Excel-bestand.
 */
export function rekenRegel(kosten, p, r) {
  const zelf = r.verzending !== 'leverancier';
  const prijs = nr(r.prijs);
  const heeftInkoop = r.inkoop !== null && r.inkoop !== undefined && r.inkoop !== '';
  const inkoop = heeftInkoop ? nr(r.inkoop) : productiekosten(kosten, p);
  const inkoopBekend = heeftInkoop || nr(p.gram) > 0 || nr(p.uur) > 0;
  const kanaalKosten = KANALEN[r.kanaal]?.soort === 'bol' ? nr(r.kosten) * BOL_BTW : nr(r.kosten);

  const tarief = verzendTarief(kosten, p.methode, r.kanaal);
  const verzend = zelf ? nr(tarief) : 0;
  const verpakking = zelf ? verpakkingPrijs(kosten, p.verpakking) : 0;
  const extras = zelf && p.extras ? extrasPerPakket(kosten) : 0;
  const rit = zelf && nr(p.perRit) > 0 ? ritKosten(kosten) / nr(p.perRit) : 0;
  const retour = zelf ? nr(kosten.retourPct) / 100 * nr(tarief) * 2 : 0;

  const totaal = inkoop + kanaalKosten + verzend + verpakking + extras + rit + retour;
  const winst = prijs - totaal;
  const marge = prijs > 0 ? winst / prijs : 0;
  const waarschuwing = !inkoopBekend ? 'Geen inkoop- of productiekosten ingevuld: de winst is te hoog.'
    : (zelf && p.methode !== GEEN_VERZENDING && !nr(tarief)) ? 'Er staat geen verzendtarief voor dit kanaal bij Vaste kosten: de winst is te hoog.'
    : '';
  return {
    prijs, inkoop, kanaalKosten, verzend, verpakking, extras, rit, retour, totaal, winst,
    winstPerStuk: winst / Math.max(1, nr(p.stuks)),
    marge, oordeel: prijs > 0 ? oordeel(winst, marge) : '—', waarschuwing
  };
}

/** Alle regels van alle producten, met hun uitkomst. */
export function alleUitkomsten(data = leesMarge()) {
  const uit = [];
  for (const p of data.producten) for (const r of p.regels) uit.push({ product: p, regel: r, u: rekenRegel(data.kosten, p, r) });
  return uit;
}

export function samenvatting(uitkomsten) {
  const met = uitkomsten.filter(x => x.u.prijs > 0);
  if (!met.length) return null;
  const beste = met.reduce((a, b) => b.u.marge > a.u.marge ? b : a);
  const laagste = met.reduce((a, b) => b.u.marge < a.u.marge ? b : a);
  const hoogsteWinst = met.reduce((a, b) => b.u.winst > a.u.winst ? b : a);
  return {
    aantal: met.length,
    gemiddeld: met.reduce((s, x) => s + x.u.marge, 0) / met.length,
    beste, laagste, hoogsteWinst,
    verlies: met.filter(x => x.u.oordeel === 'Verlies').length,
    krap: met.filter(x => x.u.oordeel === 'Krap').length
  };
}

// ---------- Wijzigen ----------

let teller = 0;
const nieuwId = voorvoegsel => `${voorvoegsel}${Date.now().toString(36)}${(teller++).toString(36)}`;

function werkBij(fn) {
  const data = JSON.parse(JSON.stringify(leesMarge()));
  fn(data);
  bewaarMarge(data);
}

export function zetKosten(pad, waarde) {
  werkBij(d => {
    const delen = pad.split('.');
    let o = d.kosten;
    for (const k of delen.slice(0, -1)) o = o[k];
    o[delen.at(-1)] = waarde;
  });
}
export function zetKostenRij(lijst, id, veld, waarde) {
  werkBij(d => {
    const rij = d.kosten[lijst].find(x => x.id === id);
    if (!rij) return;
    // Wijzigt de naam van een verpakking of verzendmethode, dan volgen de producten die er naar verwijzen.
    if (veld === 'naam') {
      const oud = rij.naam;
      if (lijst === 'verpakking') d.producten.forEach(p => { if (p.verpakking === oud) p.verpakking = waarde; });
      if (lijst === 'verzending') d.producten.forEach(p => { if (p.methode === oud) p.methode = waarde; });
    }
    rij[veld] = waarde;
  });
}
export function voegKostenRijToe(lijst) {
  werkBij(d => {
    const basis = { naam: 'Nieuw', bedrag: 0, verzend: 0, aantal: 1 };
    d.kosten[lijst].push(lijst === 'verzending'
      ? { id: nieuwId('z'), naam: 'Nieuw', nl: 0, be: 0, web: 0 }
      : { id: nieuwId(lijst === 'extras' ? 'e' : 'v'), ...basis });
  });
}
export function verwijderKostenRij(lijst, id) {
  werkBij(d => { d.kosten[lijst] = d.kosten[lijst].filter(x => x.id !== id); });
}

export function zetProduct(id, veld, waarde) {
  werkBij(d => { const p = d.producten.find(x => x.id === id); if (p) p[veld] = waarde; });
}
export function voegProductToe() {
  let nieuwe;
  werkBij(d => {
    nieuwe = {
      id: nieuwId('p'), naam: 'Nieuw artikel', stuks: 1,
      verpakking: d.kosten.verpakking[0]?.naam || '', extras: false, perRit: 1,
      methode: d.kosten.verzending[0]?.naam || '', gram: 0, uur: 0,
      regels: [{ id: nieuwId('r'), kanaal: 'nl', variant: '', verzending: 'zelf', prijs: 0, inkoop: null, kosten: 0 }]
    };
    d.producten.push(nieuwe);
  });
  return nieuwe;
}
export function verwijderProduct(id) {
  werkBij(d => { d.producten = d.producten.filter(x => x.id !== id); });
}
export function zetRegel(productId, regelId, veld, waarde) {
  werkBij(d => {
    const r = d.producten.find(x => x.id === productId)?.regels.find(x => x.id === regelId);
    if (r) r[veld] = waarde;
  });
}
export function voegRegelToe(productId) {
  werkBij(d => {
    const p = d.producten.find(x => x.id === productId);
    if (!p) return;
    const laatste = p.regels.at(-1);
    p.regels.push({
      id: nieuwId('r'), kanaal: laatste?.kanaal || 'nl', variant: '', verzending: laatste?.verzending || 'zelf',
      prijs: 0, inkoop: laatste?.inkoop ?? null, kosten: 0
    });
  });
}
export function verwijderRegel(productId, regelId) {
  werkBij(d => {
    const p = d.producten.find(x => x.id === productId);
    if (p) p.regels = p.regels.filter(x => x.id !== regelId);
  });
}
export function herstelStandaardMarge() { bewaarMarge(standaardMarge()); }

export { nr, rond };
