// belasting.js — Belasting-pagina (indicatieve IB-berekening).

import { splitsLoten } from './hnvilot.js?v=20261024z';
import { tarievenVoor, ibDetail, pct, zelfstandigenaftrekAan, zetZelfstandigenaftrek, bewaarTarieven, herstelStandaardTarieven } from './tarieven.js?v=20261024z';
import { lopendJaar, txVanJaar } from './jaren.js?v=20261024z';
import { charts, dc, kleurVoorGb } from './charts.js?v=20261024z';
import { ddmm, fmt, gbCode, isInkomst, isKostenBoeking, isOmzet, isPriveBetaaldeKost, isUitgave } from './helpers.js?v=20261024z';
import { downloadModelPdf } from './pdf.js?v=20261024z';
import { state, grootboekNamen } from './storage.js?v=20261024z';
import { kmAftrek, kmTarief, totaalKmVanJaar } from './km.js?v=20261024z';
import { totaalAfschrijvingVanJaar } from './activa.js?v=20261024z';


/** Sleutel waaronder de handmatige posten van één jaar staan opgeslagen. */
const kostenSleutel = jaar => `xtenate_aangifte_extra_${jaar}`;

/** Handmatige aftrekposten van een jaar; bij een lege of stukke opslag een lege lijst. */
export function handmatigeKosten(jaar) {
  try {
    const ruw = JSON.parse(localStorage.getItem(kostenSleutel(jaar)) || '[]');
    return Array.isArray(ruw) ? ruw.slice(0, 5) : [];
  } catch {
    return [];
  }
}

// Grootboeknummers waarop handelsvoorraad wordt ingekocht: spullen die je
// doorverkoopt. Die mag je niet als kosten nemen op het moment van inkopen,
// maar pas als ze verkocht zijn — dat rekent de app uit via de Voorraad-tab
// (COGS). Zouden we de bankmutatie óók meetellen, dan telt dezelfde inkoop
// dubbel en wordt de aftrek te hoog.
//
// 7010 staat er niet bij: dat is HNVI en heeft zijn eigen afhandeling.
// Verzendartikelen (7100) en transport (7900) zijn géén handelsvoorraad maar
// directe kosten, dus die blijven gewoon aftrekbaar in het jaar zelf.
/**
 * Welke inkooprekeningen handelsvoorraad dragen. Dat leiden we af uit de
 * artikelen zelf: elk artikel wijst zijn eigen rekening aan. Een rekening die
 * alleen directe kosten draagt — filament bijvoorbeeld — blijft zo gewoon
 * meteen aftrekbaar, en er hoeft nergens een vaste lijst onderhouden te worden.
 *
 * 7010 staat er nooit bij: HNVI heeft zijn eigen afhandeling.
 */
/**
 * Een uitgave op een omzetrekening is een terugbetaling aan een klant. Die
 * hoort van de omzet af, niet bij de kosten. Op de winst maakt dat niets uit,
 * maar het omzetbedrag dat je aan de belastingdienst doorgeeft moet netto zijn.
 */
export function nettoOmzet(belTX) {
  const bij = belTX.filter(t => isInkomst(t) && isOmzet(t.gb)).reduce((s, t) => s + (Number(t.bedrag) || 0), 0);
  const af  = belTX.filter(t => isUitgave(t) && isOmzet(t.gb)).reduce((s, t) => s + (Number(t.bedrag) || 0), 0);
  return { bij, af, netto: bij - af };
}

/**
 * De HNVI-loten die bij een jaar horen.
 *
 * Verkochte loten tellen in het jaar van verkoop (de inkoop is dan kosten, de
 * opbrengst omzet). Heeft een lot nog geen verkoopdatum, dan geldt het jaar
 * van inkoop, zoals het altijd werkte. Loten op voorraad horen bij elk jaar
 * vanaf hun inkoop: ze liggen er nog, maar tellen pas bij verkoop als kosten.
 */
export function hnviLotenVanJaar(jaar) {
  const alle = splitsLoten(state.HNVI_LOTS || []);
  if (jaar === 'all') return alle;
  const jr = x => String(x || '').slice(0, 4);
  return alle.filter(l => l.status === 'verkocht'
    ? jr(l.verkoopDatum || l.datum) === jaar
    : (l.datum && jr(l.datum) <= jaar));
}

/**
 * HNVI-verkopen die nog niet in de bankomzet zitten.
 *
 * Een verkocht lot bracht geld op, en dat staat meestal al als inkomst op een
 * omzetrekening in de bank. Telden we de verkoopprijs van het lot er dan nog
 * eens bij op, dan stond dezelfde verkoop twee keer in de omzet. Daarom
 * koppelen we elk verkocht lot aan één bankinkomst met exact hetzelfde bedrag;
 * alleen wat nergens in de bank te vinden is, komt er als omzet bij.
 */
export function hnviOmzetBuitenBank(hnviJaar, belTX) {
  const vrij = belTX.filter(t => isInkomst(t) && isOmzet(t.gb)).map(t => ({ b: Number(t.bedrag) || 0, datum: t.datum }));
  // Loten waarvan de opbrengst al in de bank staat (bijv. in meerdere betalingen) tellen niet nog eens mee.
  const lijst = hnviJaar.filter(i => i.status === 'verkocht' && Number(i.verkoop) > 0 && !i.opbrengstInBank);
  const gekoppeld = new Set();
  let alInBank = 0, aantalAlInBank = 0, bedrag = 0;
  const koppel = (lot, plek) => { vrij.splice(plek, 1); gekoppeld.add(lot); alInBank += Number(lot.verkoop); aantalAlInBank++; };
  const dagen = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

  // Eerst alleen exact dezelfde bedragen, zodat een zekere koppeling nooit
  // wordt weggekaapt door een ruime.
  for (const lot of lijst) {
    const plek = vrij.findIndex(x => Math.abs(x.b - Number(lot.verkoop)) < 0.005);
    if (plek >= 0) koppel(lot, plek);
  }
  // Daarna een bijna gelijk bedrag, voor als de bank iets heeft ingehouden.
  // Dat telt alleen als het verschil klein is (ten hoogste € 1 én 5%) en het
  // geld kort na de verkoop binnenkwam (van 3 dagen ervoor tot 30 dagen erna).
  // Zonder die datumgrens koppel je een verkoop aan een toevallig bedrag
  // van een heel andere maand.
  for (const lot of lijst.filter(l => !gekoppeld.has(l))) {
    const prijs = Number(lot.verkoop);
    const verkocht = lot.verkoopDatum || lot.datum;
    if (!verkocht) continue;
    let beste = -1, kleinste = Infinity;
    vrij.forEach((x, k) => {
      const v = Math.abs(x.b - prijs);
      const d = x.datum ? dagen(x.datum, verkocht) : NaN;
      if (v <= 1 && v <= prijs * 0.05 && d >= -3 && d <= 30 && v < kleinste) { kleinste = v; beste = k; }
    });
    if (beste >= 0) koppel(lot, beste);
  }
  const buitenBank = lijst.filter(l => !gekoppeld.has(l));
  bedrag = buitenBank.reduce((s, l) => s + Number(l.verkoop), 0);
  return { bedrag, alInBank, aantalAlInBank, buitenBank };
}

const SOORT_SLEUTEL = 'xtenate_inkomenssoort';

/**
 * Twee manieren waarop dit inkomen in de aangifte kan staan.
 *
 * 'onderneming' — winst uit onderneming. Hierbij geldt de MKB-winstvrijstelling
 *   (percentage per jaar, zie tarieven.js), die je belastbare winst verlaagt.
 * 'overig' — resultaat uit overig werk. Deze vrijstelling geldt dan niet, dus
 *   je betaalt over de hele winst.
 *
 * Welke van de twee op jou van toepassing is hangt af van je situatie, niet van
 * een instelling in dit programma. De keuze staat hier zodat de schatting klopt
 * met de rubriek waarin je de aangifte invult.
 */
export function inkomenssoort() {
  return localStorage.getItem(SOORT_SLEUTEL) === 'overig' ? 'overig' : 'onderneming';
}

export function zetInkomenssoort(soort) {
  localStorage.setItem(SOORT_SLEUTEL, soort === 'overig' ? 'overig' : 'onderneming');
}

/** Het vrijstellingspercentage dat bij de gekozen rubriek hoort. */
export function mkbTarief(jaar) {
  return inkomenssoort() === 'overig' ? 0 : tarievenVoor(jaar ?? gekozenJaar()).mkb;
}

/** Geschatte inkomstenbelasting over een winst, in de eerste twee schijven. */
export function ibOver(winst, jaar) {
  return ibDetail(winst, jaar ?? gekozenJaar(), { metMkb: inkomenssoort() !== 'overig' }).ib;
}

const PCT_SLEUTEL = 'xtenate_aftrek_pct';

/**
 * Aftrekpercentage per boeking.
 *
 * Sommige aankopen zijn maar deels zakelijk: een laptop die je ook privé
 * gebruikt trek je bijvoorbeeld voor 60% af. Dat verschilt per aankoop, dus
 * leggen we het per boeking vast in plaats van per rekening.
 */
export function aftrekPercentages() {
  try {
    const rauw = JSON.parse(localStorage.getItem(PCT_SLEUTEL) || '{}');
    return rauw && typeof rauw === 'object' ? rauw : {};
  } catch { return {}; }
}

export function bewaarPercentages(kaart) {
  localStorage.setItem(PCT_SLEUTEL, JSON.stringify(kaart || {}));
}

/** Het percentage voor één boeking; zonder instelling is alles aftrekbaar. */
export function percentageVan(t, kaart = aftrekPercentages()) {
  const p = Number(kaart[String(t?.id)]);
  return Number.isFinite(p) && p >= 0 && p <= 100 ? p : 100;
}

/** Het bedrag dat na toepassing van het percentage aftrekbaar is. */
export function aftrekbaarBedrag(t, kaart = aftrekPercentages()) {
  return (Number(t?.bedrag) || 0) * percentageVan(t, kaart) / 100;
}

/** Telt deze uitgave mee als bedrijfskosten? *//** Telt deze uitgave mee als bedrijfskosten? */
export function isKostenpost(t) {
  if (!isKostenBoeking(t)) return false;
  const gb = String(t.gb);
  // Alleen de winst-en-verliesrekeningen tellen mee. Alles onder 4000 is
  // balans: bank, kruisposten, privé, schulden. Daar gaat geld heen en weer
  // zonder dat het je resultaat raakt, dus als kostenpost hoort het nergens.
  if (!(Number(gb) >= 4000)) return false;
  if (isOmzet(gb)) return false;              // terugbetaling, gaat van de omzet af
  if (gb === '7010') return false;            // HNVI, loopt via loten
  if (voorraadRekeningen().includes(gb)) return false; // voorraad, loopt via inkoopwaarde
  return true;
}

/**
 * Welke inkooprekening artikel-voorraad draagt: 7000 (AliExpress en Alibaba, ook voor
 * de artikelen van Bol.com en Helmetcoverstore). MijnMagie (7020) doet niet mee: dat is
 * een directe kostenpost.
 * HNVI (7010) gaat volledig via loten. Verzendartikelen (7100) zijn directe kosten.
 */
export function voorraadRekeningen() {
  return ['7000'];
}

export function isHandelsvoorraad(art) {
  if (art?.handelsvoorraad === false) return false;
  const gb = gbCode(art?.inkoopGb) || '7000';
  return gb === '7000';
}

export function inkoopRekeningVan(art) {
  return gbCode(art?.inkoopGb) || '7000';
}

/**
 * De wegingsfactor van een artikel binnen zijn inkooprekening. Standaard 1,
 * wat betekent: dit artikel kost evenveel als het gemiddelde. Zet je hem op
 * 0,5 dan is dit artikel half zo duur als de rest, en worden de overige
 * artikelen automatisch duurder zodat het totaalbedrag van de bank klopt.
 */
export function factorVan(art) {
  const f = Number(art?.prijsFactor);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/** Een zelf ingevulde inkoopprijs zet de bankverdeling voor dit artikel opzij. */
export function heeftHandmatigePrijs(art) {
  return Number(art?.inkoopprijs) > 0;
}

/**
 * Leidt per inkooprekening af wat één stuk gekost heeft.
 *
 * De bank weet het totaalbedrag, de voorraadadministratie weet het aantal
 * stuks. Samen geven ze de gemiddelde inkoopprijs: totaal besteed gedeeld
 * door totaal ingekocht. Dat is de methode van de gemiddelde inkoopprijs, en
 * die mag je voor de aangifte gebruiken zolang je hem elk jaar aanhoudt.
 *
 * Niet elk artikel op dezelfde rekening kost evenveel. Daarom telt elk artikel
 * mee met zijn eigen factor: we delen het bankbedrag niet door het aantal
 * stuks, maar door de gewogen som van de stuks. Een artikel met factor 0,5
 * krijgt dan de halve prijs en de rest schuift met precies dat verschil
 * omhoog, zodat de som over alle artikelen het bankbedrag blijft.
 *
 * Artikelen met een zelf ingevulde prijs doen niet mee in de verdeling. Hun
 * kosten lopen buiten deze rekening om, bijvoorbeeld filament dat je zelf
 * verwerkt.
 *
 * We rekenen over alle jaren samen. Per jaar zou nauwkeuriger lijken, maar
 * dan krijg je rare uitkomsten in een jaar waarin je niets inkocht en wel
 * verkocht — en juist dat gebeurt hier vaak.
 */
export function inkoopprijzenUitBank(alleTX, covers) {
  // gewogen[gb][jaar] = som van (factor x stuks), bedrag[gb][jaar] uit de bank.
  const gewogen = {}, bedrag = {}, ruweStuks = {};

  for (const art of covers || []) {
    if (!isHandelsvoorraad(art)) continue;
    if (heeftHandmatigePrijs(art)) continue;   // eigen prijs: buiten de verdeling
    const gb = inkoopRekeningVan(art);
    const f = factorVan(art);
    gewogen[gb] = gewogen[gb] || {};
    ruweStuks[gb] = ruweStuks[gb] || {};
    for (const [jr, v] of Object.entries(art.jaren || {})) {
      const st = Number(v?.inkoop) || 0;
      gewogen[gb][jr] = (gewogen[gb][jr] || 0) + f * st;
      ruweStuks[gb][jr] = (ruweStuks[gb][jr] || 0) + st;
    }
  }

  for (const t of alleTX || []) {
    if (!isKostenBoeking(t)) continue;
    const gb = gbCode(t.gb);
    if (!gewogen[gb]) continue;
    const jr = String(t.datum || '').slice(0, 4);
    bedrag[gb] = bedrag[gb] || {};
    bedrag[gb][jr] = (bedrag[gb][jr] || 0) + (Number(t.bedrag) || 0);
  }

  const uit = {};
  for (const gb of Object.keys(gewogen)) {
    const jaren = {};
    let totGewogen = 0, totBedrag = 0, totStuks = 0;
    for (const jr of new Set([...Object.keys(gewogen[gb] || {}), ...Object.keys(bedrag[gb] || {})])) {
      const gw = gewogen[gb][jr] || 0;
      const bd = (bedrag[gb] || {})[jr] || 0;
      // Basisprijs: wat een artikel met factor 1 kost.
      if (gw > 0 && bd > 0) jaren[jr] = bd / gw;
      totGewogen += gw; totBedrag += bd;
      totStuks += (ruweStuks[gb] || {})[jr] || 0;
    }
    uit[gb] = {
      jaren,
      gemiddeld: totGewogen > 0 && totBedrag > 0 ? totBedrag / totGewogen : null,
      totaalBedrag: totBedrag,
      totaalStuks: totStuks
    };
  }
  return uit;
}

/**
 * Wat één stuk van dit artikel kostte. Een handmatig ingevulde inkoopprijs
 * gaat voor; anders komt de prijs uit de bank.
 */
export function prijsPerStuk(art, prijzenUitBank, jaar) {
  const handmatig = Number(art?.inkoopprijs);
  if (handmatig > 0) {
    // Soms staat het totaalbedrag van de bestelling in dit veld in plaats van
    // de stuksprijs. Boven de duizend euro met een bekend aantal gaan we ervan
    // uit dat het om het totaal gaat.
    const aantal = Number(art.inkoop) || 0;
    return handmatig > 1000 && aantal > 0 ? handmatig / aantal : handmatig;
  }
  if (!isHandelsvoorraad(art)) return 0;
  const p = prijzenUitBank?.[inkoopRekeningVan(art)];
  if (!p) return 0;
  // Basisprijs van het jaar zelf; kocht je dat jaar niets in, dan het gemiddelde.
  const basis = (jaar && jaar !== 'all' ? p.jaren?.[jaar] : null) ?? p.gemiddeld ?? 0;
  return basis * factorVan(art);
}

/**
 * Controleert of de belastinggegevens consistent zijn. Dit rolt door de
 * berekening heen en meldt waarschuwingen waar de gebruiker moet kijken.
 */
export function controlereBelasting() {
  const jaar = gekozenJaar();
  const belTX = jaar === 'all'
    ? [...state.HIST_TX, ...state.TX]
    : txVanJaar(jaar);
  
  const problemen = [];
  
  // Checklist
  for (const t of belTX) {
    if (!t.id || !t.datum || !Number.isFinite(t.bedrag)) {
      problemen.push(`Boeking ${t.id || '?'} mist veld: datum=${t.datum} bedrag=${t.bedrag}`);
    }
  }
  
  // Percentages
  const pct = aftrekPercentages();
  for (const id of Object.keys(pct)) {
    if (!Number.isFinite(pct[id]) || pct[id] < 0 || pct[id] > 100) {
      problemen.push(`Percentage boeking ${id} is ongeldig: ${pct[id]}`);
    }
  }
  
  // HNVI
  for (const lot of state.HNVI_LOTS || []) {
    if (!lot.datum || !Number.isFinite(lot.inkoop)) {
      problemen.push(`HNVI-lot ${lot.id || '?'} mist datum of inkoop`);
    }
  }
  
  // Voorraad
  for (const art of state.COVERS || []) {
    if (!Number.isFinite(art.voorraad) || !Number.isFinite(art.inkoopprijs)) {
      problemen.push(`Artikel ${art.artikel} mist voorraad (${art.voorraad}) of inkoopprijs (${art.inkoopprijs})`);
    }
    if (art.jaren) {
      for (const [j, gegevens] of Object.entries(art.jaren)) {
        if (!Number.isFinite(gegevens?.verkocht) || !Number.isFinite(gegevens?.eind)) {
          problemen.push(`Artikel ${art.artikel} jaar ${j}: verkocht=${gegevens?.verkocht} eind=${gegevens?.eind}`);
        }
      }
    }
  }
  
  return problemen;
}

export function openControleDialog() {
  const problemen = controlereBelasting();
  const titel = problemen.length ? '⚠️ Controleopmerkingen' : '✓ Alles OK';
  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true" style="max-width:560px">
      <header class="pm-kop">
        <div>
          <h3>${titel}</h3>
          <p class="pm-sub">${problemen.length || 'Alle gegevens zijn volledig en consistent'}</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud" style="padding:16px 20px">
        ${problemen.length
          ? `<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6">
              ${problemen.map(p => `<li style="margin:6px 0">${escHtml(p)}</li>`).join('')}
             </ul>`
          : `<p style="font-size:13px;color:var(--text-secondary)">Alle datavelden zijn ingevuld en logisch consistent.</p>`}
      </div>
      <footer class="pm-voet">
        <button type="button" class="btn" data-sluit>Sluiten</button>
      </footer>
    </div>`;
  
  const sluit = koppelVenster(laag);
}

export function renderBelasting() {
  const GBNM = grootboekNamen();
  const jaar = state.huidigJaar || lopendJaar();
  const belTX = jaar === 'all' ? [...state.HIST_TX, ...state.TX] : txVanJaar(jaar);

  // Update card title
  const ct = document.getElementById('bel-card-title');
  if (ct) ct.textContent = `Berekening box 1 — indicatie ${jaar === 'all' ? 'alle jaren' : jaar}`;

  const omzetSplit = nettoOmzet(belTX);
  const omzetBank = omzetSplit.netto;

  // HNVI inkoop: filter op jaar van het lot (via datum)
  const hnviJaar = hnviLotenVanJaar(jaar);
  
  // HNVI-verkoopwaarde telt als opbrengst (verkochte loten)
  const hnviSplit = hnviOmzetBuitenBank(hnviJaar, belTX);
  const hnviOmzet = hnviSplit.bedrag;
  const omzetTotal = omzetBank + hnviOmzet;

  // Kosten die meteen aftrekbaar zijn. Handelsvoorraad hoort hier niet bij:
  // die telt via de COGS-regel hieronder, anders staat dezelfde inkoop er twee
  // keer in. 7010 (HNVI) heeft zijn eigen regel.
  const alleTX = [...state.HIST_TX, ...state.TX];
  const vrdRek = voorraadRekeningen(state.COVERS);
  const isVoorraadInkoop = t => t.gb === '7010' || vrdRek.includes(String(t.gb));
  const pctKaart = aftrekPercentages();
  const kostenOverig = belTX.filter(isKostenpost).reduce((s,t)=>s+aftrekbaarBedrag(t,pctKaart),0);

  // Wat er dit jaar op die voorraadrekeningen is uitgegeven. Niet als kosten
  // geteld, maar wel getoond zodat je ziet waar het gebleven is.
  const voorraadInkoopBank = belTX
    .filter(t => isKostenBoeking(t) && vrdRek.includes(String(t.gb)))
    .reduce((s,t)=>s+t.bedrag,0);
  const hnviVerkocht = hnviJaar.filter(i => i.status === 'verkocht').reduce((s,i)=>s+(Number(i.inkoop)||0),0);
  const hnviVoorraad = hnviJaar.filter(i => i.status === 'voorraad').reduce((s,i)=>s+(Number(i.inkoop)||0),0);
  const hnviVoorraadAantal = hnviJaar.filter(i => i.status === 'voorraad').length;
  // Totale 7010 in bank (fallback als geen loten voor dit jaar)
  const hnviTotaalBank = belTX.filter(t => isUitgave(t) && t.gb === '7010').reduce((s,t)=>s+(Number(t.bedrag)||0),0);
  const hnviAftrekbaar = hnviJaar.length > 0 ? hnviVerkocht : hnviTotaalBank;
  // Voorraad van dit jaar = nog niet aftrekbaar
  const hnviNietAftrekbaar = hnviVoorraad;

  // Voorraadartikelen tellen pas als kosten in het jaar dat ze verkocht zijn.
  // Twee manieren om in te voeren:
  // 1) Inkoopprijs = prijs per stuk (€4,20), Ingekocht = aantal (100)
  //    → COGS = €4,20 × aantal_verkocht
  // 2) Inkoopprijs = totale prijs (€1250), Ingekocht = aantal (100)
  //    → COGS = €1250 × (aantal_verkocht / 100)
  // We controleren: als inkoopprijs groter is dan verwacht per-stuk bedrag,
  // nemen we aan dat het een totaal is.
  // Prijs per stuk komt uit de bank: bedrag op de inkooprekening gedeeld door
  // het aantal ingekochte stuks. Een handmatige inkoopprijs gaat daar voor.
  const prijzenUitBank = inkoopprijzenUitBank(alleTX, state.COVERS);

  const handelsartikelen = (state.COVERS || []).filter(isHandelsvoorraad);

  // Inkoopwaarde van wat er dit jaar verkocht is. Dat is de kostenpost, niet
  // het bedrag dat je bij de inkoop hebt overgemaakt.
  const voorraadCogs = handelsartikelen.reduce((som, art) => {
    const prijs = prijsPerStuk(art, prijzenUitBank, jaar);
    if (!(prijs > 0)) return som;
    const stuks = jaar === 'all'
      ? Object.values(art.jaren || {}).reduce((n, j) => n + (Number(j?.verkocht) || 0), 0)
      : Number(art.jaren?.[jaar]?.verkocht) || 0;
    return som + prijs * stuks;
  }, 0);

  // Waarde van wat er aan het eind van het jaar nog ligt (balanspost, geen kosten).
  const voorraadEind = handelsartikelen.reduce((som, art) => {
    const prijs = prijsPerStuk(art, prijzenUitBank, jaar);
    if (!(prijs > 0)) return som;
    const stuks = jaar === 'all' || jaar === lopendJaar()
      ? Number(art.voorraad) || 0
      : Number(art.jaren?.[jaar]?.eind ?? 0);
    return som + prijs * stuks;
  }, 0);

  // Handmatige posten (huur, rente, verzekering) uit de kostenmodal.
  const handmatig = handmatigeKosten(jaar);
  const handmatigTotaal = handmatig.reduce((s, k) => s + (Number(k.bedrag) || 0), 0);

  // Kilometervergoeding: telt alléén mee als er een tarief is ingesteld.
  // kmAftrek() geeft dan null terug, dus zonder tarief blijft dit exact 0 en
  // verandert er niets aan de rest van deze berekening.
  const kmBedrag = kmAftrek(jaar) || 0;

  // Afschrijving op geregistreerde bedrijfsmiddelen. Zonder enig activum
  // geeft totaalAfschrijvingVanJaar() gewoon 0 (een lege optelsom), dus
  // verandert er dan niets aan de rest van deze berekening.
  const activaBedrag = totaalAfschrijvingVanJaar(jaar);

  const kostenAftrekbaar = kostenOverig + hnviAftrekbaar + voorraadCogs + handmatigTotaal + kmBedrag + activaBedrag;
  const winst = omzetTotal - kostenAftrekbaar;

  // Jaarprojectie op basis van huidige maanden
  const maandenMet = [...new Set(belTX.filter(t=>isInkomst(t)&&isOmzet(t.gb)).map(t=>t.datum.slice(0,7)))].length || 1;
  const omzetPerMaand = omzetTotal / maandenMet;
  const kostenPerMaand = kostenAftrekbaar / maandenMet;
  const omzetJaar = Math.round(omzetPerMaand * 12);
  const kostenJaar = Math.round(kostenPerMaand * 12);
  const winstJaar = omzetJaar - kostenJaar;

  // IB berekening (huidig)
  const metMkb = inkomenssoort() !== 'overig';
  const tarief = tarievenVoor(jaar);
  const calcIB = (w) => {
    if (w <= 0) return w * tarief.schijven[0].tarief; // negatief = mogelijke teruggave
    return ibDetail(w, jaar, { metMkb }).ib;
  };
  const ibd = ibDetail(winst, jaar, { metMkb });
  const ib = calcIB(winst);
  const ibJaar = calcIB(winstJaar);
  const mkb = winst > 0 ? Math.round(ibd.mkb) : 0;
  const belastbaar = winst > 0 ? ibd.belastbaar : 0;

  document.getElementById('bel-metrics').innerHTML = `
    <div class="metric"><div class="lbl">Bruto omzet</div><div class="val">${fmt(omzetTotal)}</div></div>
    <div class="metric"><div class="lbl">Aftrekbare kosten</div><div class="val neg">${fmt(kostenAftrekbaar)}</div></div>
    <div class="metric"><div class="lbl">Winst / verlies</div><div class="val ${winst>=0?'pos':'neg'}">${fmt(winst)}</div></div>
    <div class="metric"><div class="lbl">${ib<=0?'Geschatte teruggave':'Geschatte IB'}</div><div class="val ${ib<=0?'pos':'neg'}">${ib<=0?'+':''}${fmt(Math.abs(Math.round(ib)))}</div></div>
    <div class="metric"><div class="lbl">HNVI voorraad (niet aftrekbaar)</div><div class="val" style="color:var(--text-secondary)">${fmt(hnviNietAftrekbaar)}</div><div class="sub">${hnviVoorraadAantal} loten nog in voorraad</div></div>
    <div class="metric"><div class="lbl">Voorraad eind ${jaar === 'all' ? 'nu' : jaar}</div><div class="val" style="color:var(--text-secondary)">${fmt(voorraadEind)}</div><div class="sub">bezitting, geen kostenpost</div></div>
    <div class="metric"><div class="lbl">Projectie heel jaar</div><div class="val ${winstJaar>=0?'pos':'neg'}">${fmt(winstJaar)}</div><div class="sub">op basis van ${maandenMet} mnd</div></div>`;

  // ---------------------------------------------------------- aandachtspunten
  // Punten die de berekening stil kunnen vertekenen. Elk punt zegt wat er aan
  // de hand is en wat je moet doen; anders weet je wel dat er iets mis is maar
  // niet waar je moet zijn.
  // HNVI-controle: bank 7010 vs ingevoerde loten
  const bank7010 = (alleTX || [])
    .filter(t => t.type === 'uitgave' && String(t.gb) === '7010')
    .reduce((som, t) => som + (Number(t.bedrag) || 0), 0);
  const hnviLoten = (state.HNVI_LOTS || [])
    .reduce((som, lot) => som + (Number(lot.inkoop) || 0), 0);
  const hnviMissing = Math.max(0, bank7010 - hnviLoten);

  const punten = [];

  // Een artikel telt pas mee als er een prijs per stuk uit te rekenen valt.
  // Dat lukt niet als de rekening geen bankmutaties heeft, of als er nergens
  // een ingekocht aantal staat om het bedrag over te verdelen.
  // Terugbetalingen en eigen overboekingen benoemen, want die zag je eerder
  // als kosten terug en dat vertekende de winst.
  const priveKosten = belTX.filter(isPriveBetaaldeKost);
  if (priveKosten.length) {
    const bedr = priveKosten.reduce((s, t) => s + (Number(t.bedrag) || 0), 0);
    punten.push({
      soort: 'gunstig',
      tekst: `${priveKosten.length} zakelijke kosten (samen ${fmt(bedr)}) zijn privé betaald, bijvoorbeeld met de creditkaart. Ze staan als privé-storting in de bank en tellen mee als kosten of inkoop.`
    });
  }
  if (hnviSplit.aantalAlInBank > 0) {
    punten.push({
      soort: 'gunstig',
      tekst: `${hnviSplit.aantalAlInBank} verkochte HNVI-loten (samen ${fmt(hnviSplit.alInBank)}) staan al als inkomst in de bank. Die zijn niet nog eens als omzet bijgeteld.`
    });
  }
  if (omzetSplit.af > 0) {
    punten.push({
      soort: 'gunstig',
      tekst: `${fmt(omzetSplit.af)} aan uitgaven staat op een omzetrekening — terugbetalingen aan klanten. Die is van de omzet afgetrokken (bruto ${fmt(omzetSplit.bij)}, netto ${fmt(omzetSplit.netto)}) en telt niet als kostenpost.`
    });
  }
  const balans = belTX.filter(t => isUitgave(t) && !(Number(t.gb) >= 4000))
    .reduce((som, t) => som + (Number(t.bedrag) || 0), 0);
  if (balans > 0) {
    punten.push({
      soort: 'gunstig',
      tekst: `${fmt(balans)} staat op balansrekeningen onder 4000 — kruisposten, privé en overboekingen tussen je eigen rekeningen. Die zijn buiten de kosten gehouden: ze veranderen wel je banksaldo, maar niet je resultaat.`
    });
  }

  // HNVI-controle
  if (hnviMissing > 0.01) {
    punten.unshift({
      soort: 'waarschuwing',
      tekst: `HNVI-inkoop niet volledig ingevoerd: ${fmt(bank7010)} op GB 7010, maar ${fmt(hnviLoten)} in loten. Nog in te voeren: ${fmt(hnviMissing)}.`
    });
  } else if (bank7010 > 0) {
    punten.unshift({
      soort: 'gunstig',
      tekst: `HNVI-controle OK: ${fmt(bank7010)} op GB 7010 = ${fmt(hnviLoten)} in loten ingevoerd.`
    });
  }

  const zonderPrijs = handelsartikelen.filter(a => !(prijsPerStuk(a, prijzenUitBank, jaar) > 0));
  if (zonderPrijs.length) {
    const namen = zonderPrijs.slice(0, 3).map(a => a.artikel).filter(Boolean).join(', ');
    punten.push({
      soort: 'let-op',
      tekst: `Voor ${zonderPrijs.length} ${zonderPrijs.length === 1 ? 'artikel is' : 'artikelen is'} geen inkoopprijs te bepalen${namen ? ` (${escHtml(namen)}${zonderPrijs.length > 3 ? ', …' : ''})` : ''}. Die tellen niet mee als inkoopkosten. Vul bij Voorraad het aantal ingekochte stuks in, of zet de inkoopprijs met de hand.`
    });
  }

  // Toon de afgeleide prijs, zodat je kunt nagaan of die klopt met wat je
  // werkelijk betaalde. En waarschuw als hij per jaar sterk verschilt: dan
  // staan er waarschijnlijk heel verschillende artikelen op één rekening.
  for (const [gb, p] of Object.entries(prijzenUitBank)) {
    const dit = jaar !== 'all' ? p.jaren?.[jaar] : null;
    const gebruikt = dit ?? p.gemiddeld;
    if (!(gebruikt > 0)) continue;

    punten.push({
      soort: 'gunstig',
      tekst: `Inkoopprijs op ${gb} berekend uit de bank: ${fmt(gebruikt)} per stuk${dit ? ` (bedrag ${jaar} gedeeld door de stuks van ${jaar})` : ' (gemiddelde over alle jaren, want dit jaar staat er geen inkoop op deze rekening)'}.`
    });

    const reeks = Object.values(p.jaren || {});
    if (reeks.length > 1 && Math.max(...reeks) > Math.min(...reeks) * 2.5) {
      const perJaar = Object.entries(p.jaren).sort()
        .map(([j, v]) => `${j} ${fmt(v)}`).join(', ');
      punten.push({
        soort: 'waarschuwing',
        tekst: `De berekende prijs op ${gb} loopt sterk uiteen: ${perJaar}. Op deze rekening staan blijkbaar heel verschillende artikelen door elkaar, en dan zegt één gemiddelde weinig. Vul bij de dure artikelen zelf een inkoopprijs in, of geef ze een eigen inkooprekening.`
      });
    }
  }

  // Artikelen met een prijs, maar zonder verkoopaantal voor dit jaar: dan blijft
  // de inkoop onzichtbaar in de aangifte terwijl er misschien wél verkocht is.
  if (jaar !== 'all') {
    const nietVastgelegd = (state.COVERS || []).filter(a =>
      Number(a.inkoopprijs) > 0 && a.jaren?.[jaar]?.verkocht == null);
    if (nietVastgelegd.length) {
      punten.push({
        soort: 'let-op',
        tekst: `Bij ${nietVastgelegd.length} ${nietVastgelegd.length === 1 ? 'artikel is' : 'artikelen is'} niet vastgelegd hoeveel er in ${jaar} verkocht is. Zolang dat leeg blijft rekent ${jaar} met nul verkochte stuks. Vul dit in bij Voorraad, veld "Verkocht in ${jaar}".`
      });
    }
  }

  if (hnviNietAftrekbaar > 0) {
    punten.push({
      soort: 'let-op',
      tekst: `${fmt(hnviNietAftrekbaar)} aan HNVI-inkoop zit nog in voorraad en is daarom niet aftrekbaar. Zodra je die loten op verkocht zet, verschuift dit vanzelf.`
    });
  }

  if (!state.HNVI_LOTS.length && hnviTotaalBank > 0) {
    punten.push({
      soort: 'waarschuwing',
      tekst: `Er staat ${fmt(hnviTotaalBank)} aan HNVI-inkoop (7010) in de bank, maar er zijn geen loten vastgelegd. Nu wordt dat volledige bedrag als aftrekbaar gerekend, wat te gunstig is als een deel nog in voorraad ligt. Voeg de loten toe in de HNVI-tab.`
    });
  }

  if (voorraadInkoopBank > 0 && voorraadCogs === 0) {
    punten.push({
      soort: 'waarschuwing',
      tekst: `Er is dit jaar ${fmt(voorraadInkoopBank)} ingekocht op ${vrdRek.join(' en ')}, maar er staat geen enkel verkocht artikel met een inkoopprijs tegenover. Die inkoop telt nu nergens als kosten, waardoor je winst te hoog uitkomt. Vul bij Voorraad de inkoopprijs en het aantal verkochte stuks in.`
    });
  }

  if (ib < 0) {
    punten.push({
      soort: 'gunstig',
      tekst: `Bij verlies kun je dit verrekenen met ander inkomen, bijvoorbeeld loon. Geschatte teruggave ${fmt(Math.abs(Math.round(ib)))}. Leg dit voor aan je adviseur voordat je erop rekent.`
    });
  }

  const kleuren = {
    'waarschuwing': ['var(--semantic-danger-soft)', 'var(--semantic-danger-bright)', '!'],
    'let-op': ['var(--semantic-warning-soft)', 'var(--semantic-warning-bright)', '!'],
    'gunstig': ['var(--semantic-success-soft)', 'var(--semantic-success-bright)', 'i']
  };

  document.getElementById('bel-info').innerHTML = punten.length ? `
    <div class="card" style="margin-bottom:1rem">
      <div class="card-title">Aandachtspunten</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${punten.map(p => {
          const [bg, fc, teken] = kleuren[p.soort] || kleuren['let-op'];
          return `<div style="display:flex;gap:9px;align-items:flex-start;font-size:12px;line-height:1.5">
            <span style="flex:0 0 17px;height:17px;margin-top:1px;border-radius:50%;background:${bg};color:${fc};font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">${teken}</span>
            <span style="color:var(--text-primary)">${p.tekst}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;gap:9px;align-items:center;font-size:12px;color:var(--text-secondary)">
        <span style="flex:0 0 17px;height:17px;border-radius:50%;background:var(--semantic-success-soft);color:var(--semantic-success-bright);font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">✓</span>
        <span>Geen aandachtspunten. Inkoopprijzen en verkoopaantallen zijn voor dit jaar ingevuld.</span>
      </div>
    </div>`;

  document.getElementById('bel-calc').innerHTML = `
    <div class="ib-row"><span>Bruto omzet</span><span>${fmt(omzetTotal)}</span></div>
    <div class="ib-row"><span>Overige kosten & inkoop</span><span class="neg">– ${fmt(kostenOverig)}</span></div>
    <div class="ib-row"><span>HNVI inkoop (verkochte loten)</span><span class="neg">– ${fmt(hnviAftrekbaar)}</span></div>
    <div class="ib-row"><span>Voorraad (inkoopprijs verkochte artikelen)</span><span class="neg">– ${fmt(voorraadCogs)}</span></div>
    ${handmatig.map(k => `<div class="ib-row"><span>${escHtml(k.label) || 'Overige post'}</span><span class="neg">– ${fmt(Number(k.bedrag) || 0)}</span></div>`).join('')}
    ${kmBedrag > 0 ? `<div class="ib-row"><span>Kilometervergoeding (${totaalKmVanJaar(jaar).toLocaleString('nl-NL')} km × ${fmt(kmTarief())})</span><span class="neg">– ${fmt(kmBedrag)}</span></div>` : ''}
    ${activaBedrag > 0 ? `<div class="ib-row"><span>Afschrijving bedrijfsmiddelen</span><span class="neg">– ${fmt(activaBedrag)}</span></div>` : ''}
    <div class="ib-row" style="color:var(--text-secondary);font-size:11px"><span>HNVI inkoop (voorraad, niet aftrekbaar)</span><span>${fmt(hnviNietAftrekbaar)}</span></div>
    <div class="ib-row" style="color:var(--text-secondary);font-size:11px"><span>Voorraad nog op de plank (bezitting)</span><span>${fmt(voorraadEind)}</span></div>
    ${voorraadInkoopBank > 0 ? `<div class="ib-row" style="color:var(--text-secondary);font-size:11px"><span>Inkoop voorraad dit jaar (${vrdRek.join(', ')}) — geen kostenpost</span><span>${fmt(voorraadInkoopBank)}</span></div>` : ''}
    <div class="ib-row"><span style="font-weight:600">Winst / verlies</span><span style="font-weight:600" class="${winst>=0?'pos':'neg'}">${fmt(winst)}</span></div>
    ${winst > 0 ? `
    ${ibd.aftrek > 0 ? `<div class="ib-row"><span>Zelfstandigenaftrek ${escHtml(jaar)}</span><span class="neg">– ${fmt(ibd.aftrek)}</span></div>` : ''}
    ${metMkb ? `<div class="ib-row"><span>MKB-winstvrijstelling (${pct(tarief.mkb)})</span><span class="neg">– ${fmt(mkb)}</span></div>` : `<div class="ib-row" style="color:var(--text-secondary);font-size:11px"><span>Geen MKB-winstvrijstelling (resultaat uit overig werk)</span><span>${fmt(0)}</span></div>`}
    <div class="ib-row"><span>Belastbaar inkomen</span><span>${fmt(Math.round(belastbaar))}</span></div>
    ${ibd.perSchijf.map((s, n) => `<div class="ib-row" style="color:var(--text-secondary);font-size:11px"><span>Schijf ${n + 1} (${pct(s.tarief)}) over ${fmt(Math.round(s.bedrag))}</span><span>${fmt(Math.round(s.bedrag * s.tarief))}</span></div>`).join('')}
    ${tarief.vanJaar !== tarief.jaar || tarief.voorlopig ? `<div class="ib-row" style="color:var(--semantic-warning-bright, #b45309);font-size:11px"><span>${tarief.vanJaar !== tarief.jaar ? `Voor ${escHtml(tarief.jaar)} zijn geen tarieven ingevuld; die van ${escHtml(tarief.vanJaar)} gelden.` : `De tarieven van ${escHtml(tarief.jaar)} zijn een voorstel, nog niet definitief.`} Controleer via “Tarieven”.</span><span></span></div>` : ''}
    <div class="ib-total"><span>Geschatte inkomstenbelasting</span><span class="neg">${fmt(Math.round(ib))}</span></div>` : `
    <div class="ib-total"><span>${ib < 0 ? 'Geschatte teruggave (bij ander inkomen)' : 'Geen belasting verschuldigd'}</span><span class="${ib<0?'pos':''}">${ib<0?'+ '+fmt(Math.abs(Math.round(ib))):'€\u202f0,00'}</span></div>`}

    <div style="margin-top:.9rem;padding:12px 14px;border-radius:var(--radius-sm);background:${winst > 0 ? 'var(--semantic-danger-soft)' : 'var(--semantic-success-soft)'}">
      <div style="font-weight:600;font-size:13px;margin-bottom:3px">${winst > 0
        ? `Je moet hierover ongeveer ${fmt(Math.round(ib))} betalen`
        : `Dit jaar is er verlies — geen belasting over deze inkomsten`}</div>
      <div style="font-size:11px;color:var(--text-secondary);line-height:1.5">${winst > 0
        ? `Dit is de belasting over deze onderneming alleen. Heb je daarnaast loon waarop al belasting is ingehouden, dan verrekent de Belastingdienst dat; wat je uiteindelijk betaalt of terugkrijgt hangt dus ook van je andere inkomsten af.`
        : `Een verlies mag je verrekenen met ander inkomen in hetzelfde jaar. Dat kan een teruggave van ongeveer ${fmt(Math.abs(Math.round(ib)))} opleveren, maar alleen als je genoeg ander belast inkomen hebt.`}</div>
    </div>

    <div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border-default);font-size:11px;color:var(--text-secondary)">
      <strong>Projectie heel jaar</strong> (op basis van ${maandenMet} maanden): omzet ${fmt(omzetJaar)} · kosten ${fmt(kostenJaar)} · winst ${fmt(winstJaar)} · geschatte IB ${ibJaar<0?'teruggave '+fmt(Math.abs(Math.round(ibJaar))):fmt(Math.round(ibJaar))}
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border-default)">
      <button type="button" class="btn btn-sm" onclick="openInkomenssoort()">Rubriek: ${inkomenssoort() === 'overig' ? 'overig werk' : 'onderneming'}</button>
      <button type="button" class="btn btn-sm" onclick="openTarieven()">Tarieven ${escHtml(String(jaar))}</button>
      <button type="button" class="btn btn-sm" onclick="openPercentages()">Aftrekpercentages</button>
      <button type="button" class="btn btn-sm" onclick="openExtraKosten()">Aftrekposten aanvullen${handmatig.length ? ` (${handmatig.length})` : ''}</button>
      <button type="button" class="btn btn-sm" onclick="kopieerAangifte()">Kopieer aangifte</button>
      <button type="button" class="btn btn-sm" onclick="downloadAangifte()">Download als tekst</button>
      <button type="button" class="btn btn-sm" onclick="downloadAangiftePdf()">Download als pdf</button>
      <button type="button" class="btn btn-sm" onclick="openControleDialog()">Controle</button>
    </div>`;

  const omzData = [
    belTX.filter(t=>isInkomst(t)&&t.gb==='8000').reduce((s,t)=>s+t.bedrag,0),
    belTX.filter(t=>isInkomst(t)&&t.gb==='8010').reduce((s,t)=>s+t.bedrag,0),
    belTX.filter(t=>isInkomst(t)&&t.gb==='8020').reduce((s,t)=>s+t.bedrag,0),
  ];
  const omzLabels = ['Xtenate (8000)','Bol.com covers (8010)','Helmetstore (8020)'];
  // Vaste kleur per kanaal, niet op volgorde: Xtenate blijft cyaan, Bol.com
  // roze en Helmetstore limoen, ook als de bedragen van plaats wisselen.
  const colors = ['8000', '8010', '8020'].map(kleurVoorGb);
  dc('c-bel');
  charts['c-bel'] = new Chart(document.getElementById('c-bel'), {type:'doughnut',data:{labels:omzLabels,datasets:[{data:omzData,backgroundColor:colors,borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{display:false}}}});
  document.getElementById('bel-legend').innerHTML = omzLabels.map((n,i)=>`<span style="display:flex;align-items:center;gap:5px"><span style="width:9px;height:9px;border-radius:2px;background:${colors[i]}"></span>${n} ${fmt(omzData[i])}</span>`).join('');

  // Kosten per grootboek, in twee schijven: de 4000-reeks zijn bedrijfskosten,
  // de 7000-reeks is inkoop. Die twee door elkaar in één schijf zou verwarren,
  // want inkoop is pas een kostenpost zodra het verkocht is.
  const perGb = {};
  for (const t of belTX) {
    if (!isUitgave(t)) continue;
    const gb = gbCode(t.gb);
    if (!(Number(gb) >= 4000) || isOmzet(gb)) continue;  // balans en terugbetalingen tellen niet mee
    perGb[gb] = (perGb[gb] || 0) + (Number(t.bedrag) || 0);
  }

  /** Tekent één schijf; verbergt de kaart als er niets te tonen valt. */
  const schijf = (canvasId, legendaId, rekeningen) => {
    const rijen = rekeningen
      .map(gb => ({ gb, bedrag: perGb[gb] || 0 }))
      .filter(r => r.bedrag > 0)
      .sort((a, b) => b.bedrag - a.bedrag);

    // De rijen zijn gesorteerd op bedrag; de kleur mag daar niet van afhangen,
    // anders verspringt een kostenpost van kleur zodra hij stijgt of daalt.
    dc(canvasId);
    const vak = document.getElementById(canvasId);
    const legenda = document.getElementById(legendaId);
    if (!vak || !legenda) return;

    if (!rijen.length) {
      legenda.innerHTML = '<span>Geen boekingen in dit jaar.</span>';
      return;
    }

    charts[canvasId] = new Chart(vak, {
      type: 'doughnut',
      data: {
        labels: rijen.map(r => `${GBNM[r.gb] || r.gb} (${r.gb})`),
        datasets: [{ data: rijen.map(r => r.bedrag), backgroundColor: rijen.map(r => kleurVoorGb(r.gb)), borderWidth: 0 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false } } }
    });

    legenda.innerHTML = rijen.map(r =>
      `<span style="display:flex;align-items:center;gap:5px"><span style="width:9px;height:9px;border-radius:2px;background:${kleurVoorGb(r.gb)}"></span>${GBNM[r.gb] || r.gb} (${r.gb}) ${fmt(r.bedrag)}</span>`
    ).join('');
  };

  const alleGb = Object.keys(perGb);
  schijf('c-bel-kosten', 'bel-legend-kosten', alleGb.filter(gb => gb < '7000'));
  schijf('c-bel-inkoop', 'bel-legend-inkoop', alleGb.filter(gb => gb >= '7000'));

  const subkop = (tekst) => `<tr><td colspan="4" style="padding:10px 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-secondary)">${tekst}</td></tr>`;
  const rij = (gb, bedrag, richting, label, kleur) => {
    const bg = kleur==='pos'?'var(--semantic-success-soft)':kleur==='neg'?'var(--semantic-danger-soft)':'var(--semantic-gray-soft)';
    const fc = kleur==='pos'?'var(--semantic-success-bright)':kleur==='neg'?'var(--semantic-danger-bright)':'var(--text-secondary)';
    return `<tr>
      <td style="color:var(--text-secondary);font-size:11px">${gb}</td>
      <td>${GBNM[gb]||gb}</td>
      <td><span style="font-size:10px;padding:2px 7px;border-radius:20px;background:${bg};color:${fc}">${label}</span></td>
      <td style="text-align:right" class="${kleur==='pos'?'pos':kleur==='neg'?'neg':''}">${richting==='plus'?'+ ':'– '}${fmt(Math.abs(bedrag))}</td>
    </tr>`;
  };

  const omzetGbs2 = [...new Set(belTX.filter(isInkomst).map(t=>t.gb))].filter(isOmzet).sort();
  const omzetRows = omzetGbs2.map(gb => {
    const tot = belTX.filter(t=>isInkomst(t)&&t.gb===gb).reduce((s,t)=>s+t.bedrag,0);
    return rij(gb, tot, 'plus', 'altijd baten', 'pos');
  }).join('');

  const r4Gbs = [...new Set(belTX.filter(isKostenBoeking).map(t=>t.gb))].filter(g=>g.startsWith('4')).sort();
  const r4Rows = r4Gbs.map(gb => {
    const tot = belTX.filter(t=>isKostenBoeking(t)&&t.gb===gb).reduce((s,t)=>s+t.bedrag,0);
    return rij(gb, tot, 'min', 'altijd aftrekbaar', 'neg');
  }).join('');

  const r7AltijdGbs = [...new Set(belTX.filter(isKostenBoeking).map(t=>t.gb))].filter(g=>['7000','7020','7100','7900'].includes(g)).sort();
  // Inkoopposten zijn alleen aftrekbaar voor zover de spullen verkocht zijn.
  // Of dat klopt hangt af van wat er in de Voorraad-tab staat, dus daar kijken
  // we naar in plaats van "altijd aftrekbaar" te beweren.
  const heeftVoorraadAdmin = (state.COVERS || []).some(a => Number(a.inkoopprijs) > 0);
  const r7AltijdRows = r7AltijdGbs.map(gb => {
    const tot = belTX.filter(t=>isKostenBoeking(t)&&t.gb===gb).reduce((s,t)=>s+t.bedrag,0);
    return heeftVoorraadAdmin
      ? rij(gb, tot, 'min', 'zie voorraad-COGS', '')
      : rij(gb, tot, 'min', 'alleen als verkocht', '');
  }).join('');

  const aftrekbaarheidsNota = `<div style="margin-top:1rem;padding-top:.75rem;font-size:11px;color:var(--text-secondary);border-top:1px solid var(--border-default);line-height:1.55">
    <strong>Over de inkooprekeningen (7000–7900).</strong> Deze bedragen zijn niet vanzelf aftrekbaar. Aftrekbaar is alleen de inkoopprijs van wat je dat jaar daadwerkelijk verkocht hebt; wat nog op de plank ligt is een bezitting.
    ${heeftVoorraadAdmin
      ? `Voor de artikelen die je in Voorraad hebt staan rekent de app dat zelf uit — dat is de regel “Voorraad (inkoopprijs verkochte artikelen)” hierboven. De bedragen in deze tabel zijn de kale bankmutaties en tellen dus niet nog een keer mee.`
      : `Je hebt nog geen artikelen met een inkoopprijs in de Voorraad-tab, dus die berekening kan de app niet maken. Zolang dat zo is worden deze bedragen volledig als kosten meegenomen, wat te gunstig uitpakt als je nog voorraad hebt liggen.`}
    Een inkoop die je hebt weggegeven of niet verkocht hoort er helemaal niet in: zet die als artikel in Voorraad met nul verkocht.
  </div>`;

  const hnviBankTot = belTX.filter(t=>isUitgave(t)&&t.gb==='7010').reduce((s,t)=>s+t.bedrag,0);
  const hnviVktTot2 = hnviJaar.filter(i=>i.status==='verkocht').reduce((s,i)=>s+i.inkoop,0);
  const hnviVrdTot2 = hnviJaar.filter(i=>i.status==='voorraad').reduce((s,i)=>s+i.inkoop,0);
  const heeftLoten = state.HNVI_LOTS.length > 0;
  const r7010Rows = heeftLoten
    ? rij('7010', hnviVktTot2, 'min', 'aftrekbaar — verkocht', 'neg') +
      (hnviVrdTot2 > 0 ? rij('7010', hnviVrdTot2, 'min', 'niet aftrekbaar — voorraad', '') : '')
    : rij('7010', hnviBankTot, 'min', 'voeg loten toe in HNVI-tab', '');

  document.getElementById("bel-kosten").innerHTML =
    subkop('Baten') + omzetRows +
    subkop('Rubriek 4 — altijd aftrekbaar') + r4Rows +
    subkop('Inkoop — aftrekbaar voor zover verkocht') + r7AltijdRows +
    subkop('Inkoop HNVI (7010) — gekoppeld aan HNVI-tab') + r7010Rows;
  
  // Voetnoot over aftrekbaarheid van inkoopposten
  const notaDiv = document.getElementById('bel-nota');
  if (notaDiv) notaDiv.innerHTML = aftrekbaarheidsNota;
}

// ---------------------------------------------------------------- aangifte

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Het jaar dat nu in de jaarkiezer staat. */
const gekozenJaar = () => state.huidigJaar || lopendJaar();

/**
 * Dezelfde cijfers als de kaart, maar als platte tekst in de volgorde van het
 * aangifteformulier: winst uit onderneming, box 1. Bedragen zonder euroteken en
 * met een komma, zoals de invulvelden ze verwachten.
 */
/**
 * Waar elke grootboekrekening terechtkomt op het aangifteformulier.
 *
 * De belastingdienst vraagt niet om je grootboek, maar om een handvol
 * verzamelposten. Deze tabel legt vast welke rekening bij welk veld hoort,
 * zodat je bij het invullen niet hoeft te gokken.
 *
 * 7000, 7010 en 7020 staan er bewust niet in: die gaan via de inkoopwaarde
 * van de omzet, niet als losse kostenpost.
 */
export const AANGIFTE_VELD = {
  '4235': 'Kleine aanschaf inventaris',
  '4290': 'Overige kosten',
  '4350': 'Overige kosten',
  '4410': 'Telefoon / internet',
  '4640': 'Reiskosten',
  '4760': 'Overige kosten',
  '4810': 'Verkoopkosten',
  '4815': 'Verkoopkosten',
  '4895': 'Verkoopkosten',
  '7100': 'Verkoopkosten',
  '7900': 'Verkoopkosten'
};

/** Volgorde waarin de velden op het formulier staan. */
const VELD_VOLGORDE = [
  'Telefoon / internet', 'Reiskosten', 'Kleine aanschaf inventaris', 'Afschrijvingen',
  'Inkoop', 'Verkoopkosten', 'Overige kosten'
];

/**
 * Telt de bankboekingen op per veld van het aangifteformulier.
 * Geeft per veld het bedrag plus de rekeningen waar het uit is opgebouwd,
 * zodat je een bedrag altijd terug kunt zoeken in je grootboek.
 */
export function aangifteVelden(belTX, { cogs = 0, hnviInkoop = 0, handmatig = [], kmBedrag = 0, activaBedrag = 0 } = {}) {
  const GBNM = grootboekNamen();
  const velden = {};
  const voegToe = (veld, bedrag, bron) => {
    velden[veld] = velden[veld] || { bedrag: 0, bronnen: [] };
    velden[veld].bedrag += bedrag;
    if (bron) velden[veld].bronnen.push(bron);
  };

  // Kosten uit de bank, gegroepeerd per grootboekrekening.
  const perGb = {};
  const kaart = aftrekPercentages();
  for (const t of belTX || []) {
    if (!isKostenpost(t)) continue;
    const gb = String(t.gb);
    perGb[gb] = (perGb[gb] || 0) + aftrekbaarBedrag(t, kaart);
  }
  for (const [gb, bedrag] of Object.entries(perGb)) {
    if (!(bedrag > 0)) continue;
    voegToe(AANGIFTE_VELD[gb] || 'Overige kosten', bedrag, `${gb} ${GBNM[gb] || ''}`.trim());
  }

  // Inkoop is de inkoopwaarde van wat verkocht is, niet wat je betaalde.
  if (cogs > 0) voegToe('Inkoop', cogs, 'voorraad — verkochte artikelen');
  if (hnviInkoop > 0) voegToe('Inkoop', hnviInkoop, 'HNVI — verkochte loten');

  for (const k of handmatig || []) {
    const bedrag = Number(k.bedrag) || 0;
    if (bedrag > 0) voegToe('Overige kosten', bedrag, `handmatig: ${k.label}`);
  }

  // Kilometervergoeding landt in de al bestaande Reiskosten-rubriek (4640),
  // niet bij de generieke Overige kosten — dat veld bestaat al precies
  // hiervoor.
  if (kmBedrag > 0) voegToe('Reiskosten', kmBedrag, 'kilometervergoeding');

  // Afschrijving op bedrijfsmiddelen krijgt een eigen rubriek, apart van
  // "Kleine aanschaf inventaris" (spullen die je in één keer aftrekt) en
  // "Overige kosten" — het aangifteformulier kent deze rubriek ook apart.
  if (activaBedrag > 0) voegToe('Afschrijvingen', activaBedrag, 'activaregister');

  return VELD_VOLGORDE
    .filter(v => velden[v]?.bedrag > 0)
    .map(v => ({ veld: v, bedrag: velden[v].bedrag, bronnen: velden[v].bronnen }));
}


/**
 * Inkoop van een jaar in één overzicht: wat is er ingekocht, hoeveel daarvan
 * telt dit jaar als kosten (omdat het verkocht is), hoeveel ligt nog als
 * voorraad (telt nog niet), en wat is nog niet aan artikelen toegewezen.
 *
 * Voorraadrekeningen (AliExpress, MijnMagie): kosten = prijs per stuk x
 * verkochte stuks, met de prijs per stuk als gemiddelde uit de bank. Zijn er
 * nog geen artikelen met aantallen ingevoerd, dan blijft alles "nog te
 * verdelen" en telt die inkoop dus nog nergens mee.
 */
export function inkoopOverzicht(jaar = gekozenJaar()) {
  const alleTX = [...state.HIST_TX, ...state.TX];
  const belTX = jaar === 'all' ? alleTX
    : txVanJaar(jaar);
  const namen = grootboekNamen();
  const bank = gb => belTX.filter(t => isKostenBoeking(t) && gbCode(t.gb) === gb).reduce((s, t) => s + (Number(t.bedrag) || 0), 0);
  const rijen = [];

  // Voorraadrekeningen via de artikelen
  const prijzen = inkoopprijzenUitBank(alleTX, state.COVERS);
  const artikelen = (state.COVERS || []).filter(isHandelsvoorraad);
  for (const gb of voorraadRekeningen()) {
    const eigen = artikelen.filter(a => inkoopRekeningVan(a) === gb);
    let kosten = 0, voorraad = 0, stuksVerkocht = 0, stuksVoorraad = 0;
    for (const art of eigen) {
      const prijs = prijsPerStuk(art, prijzen, jaar);
      if (!(prijs > 0)) continue;
      const verkocht = jaar === 'all'
        ? Object.values(art.jaren || {}).reduce((n, j) => n + (Number(j?.verkocht) || 0), 0)
        : Number(art.jaren?.[jaar]?.verkocht) || 0;
      const over = jaar === 'all' || jaar === lopendJaar() ? Number(art.voorraad) || 0 : Number(art.jaren?.[jaar]?.eind ?? 0);
      kosten += prijs * verkocht; voorraad += prijs * over;
      stuksVerkocht += verkocht; stuksVoorraad += over;
    }
    const ingekocht = bank(gb);
    if (!ingekocht && !kosten && !voorraad) continue;
    rijen.push({
      rekening: gb, naam: namen[gb] || gb, soort: 'voorraad', ingekocht, aftrekbaar: kosten, voorraad,
      teVerdelen: ingekocht - kosten - voorraad,
      opmerking: eigen.length ? `${stuksVerkocht} stuks verkocht, ${stuksVoorraad} op voorraad` : 'geen artikelen met aantallen ingevoerd: deze inkoop telt nog nergens mee'
    });
  }

  // HNVI via de loten
  const lotenJaar = hnviLotenVanJaar(jaar);
  const hnviBank = bank('7010');
  if (hnviBank || lotenJaar.length) {
    const verkocht = lotenJaar.filter(i => i.status === 'verkocht').reduce((s, i) => s + (Number(i.inkoop) || 0), 0);
    const op = lotenJaar.filter(i => i.status === 'voorraad').reduce((s, i) => s + (Number(i.inkoop) || 0), 0);
    rijen.push({
      rekening: '7010', naam: namen['7010'] || 'Inkoop HNVI', soort: 'hnvi', ingekocht: hnviBank, aftrekbaar: verkocht, voorraad: op,
      teVerdelen: hnviBank - verkocht - op,
      opmerking: `${lotenJaar.filter(i => i.status === 'verkocht').length} loten verkocht, ${lotenJaar.filter(i => i.status === 'voorraad').length} op voorraad (verkocht telt in het jaar van verkoop; zonder verkoopdatum het jaar van inkoop)`
    });
  }

  // Overige inkoop is direct aftrekbaar
  for (const gb of ['7020', '7100', '7900']) {
    const ingekocht = bank(gb);
    if (!ingekocht) continue;
    rijen.push({ rekening: gb, naam: namen[gb] || gb, soort: 'direct', ingekocht, aftrekbaar: ingekocht, voorraad: 0, teVerdelen: 0, opmerking: 'direct aftrekbaar' });
  }

  const totaal = rijen.reduce((s, r) => ({
    ingekocht: s.ingekocht + r.ingekocht, aftrekbaar: s.aftrekbaar + r.aftrekbaar,
    voorraad: s.voorraad + r.voorraad, teVerdelen: s.teVerdelen + r.teVerdelen
  }), { ingekocht: 0, aftrekbaar: 0, voorraad: 0, teVerdelen: 0 });
  return { jaar, rijen, totaal };
}

export function aangifteModel(jaar = gekozenJaar()) {
  const belTX = jaar === 'all'
    ? [...state.HIST_TX, ...state.TX]
    : txVanJaar(jaar);

  // Omzet uit bank (gb 8000, 8010, 8020)
  const omzetBank = nettoOmzet(belTX).netto;
  
  // Directe kosten. Handelsvoorraad en HNVI vallen hierbuiten: die tellen via
  // de inkoopwaarde van de omzet, anders staat dezelfde inkoop er dubbel in.
  const vrdRek = voorraadRekeningen(state.COVERS);
  const prijzenUitBank = inkoopprijzenUitBank([...state.HIST_TX, ...state.TX], state.COVERS);
  const kostenOverig = belTX.filter(isKostenpost).reduce((s, t) => s + aftrekbaarBedrag(t), 0);

  const hnviJaar = hnviLotenVanJaar(jaar);
  const hnviBank = belTX.filter(t => isUitgave(t) && t.gb === '7010').reduce((s, t) => s + (Number(t.bedrag) || 0), 0);
  const hnviInkoop = hnviJaar.length
    ? hnviJaar.filter(i => i.status === 'verkocht').reduce((s, i) => s + (Number(i.inkoop) || 0), 0)
    : hnviBank;
  
  // Omzet uit verkochte HNVI-loten
  const hnviOmzet = hnviOmzetBuitenBank(hnviJaar, belTX).bedrag;
  const omzet = omzetBank + hnviOmzet;

  // Voorraad-COGS: artikelen die dit jaar verkocht zijn
  const handelsartikelen = (state.COVERS || []).filter(isHandelsvoorraad);

  const cogs = handelsartikelen.reduce((som, art) => {
    const prijs = prijsPerStuk(art, prijzenUitBank, jaar);
    if (!(prijs > 0)) return som;
    const stuks = jaar === 'all'
      ? Object.values(art.jaren || {}).reduce((n, j) => n + (Number(j?.verkocht) || 0), 0)
      : Number(art.jaren?.[jaar]?.verkocht) || 0;
    return som + prijs * stuks;
  }, 0);

  const eind = handelsartikelen.reduce((som, art) => {
    const prijs = prijsPerStuk(art, prijzenUitBank, jaar);
    if (!(prijs > 0)) return som;
    const stuks = jaar === 'all' || jaar === lopendJaar()
      ? Number(art.voorraad) || 0
      : Number(art.jaren?.[jaar]?.eind ?? 0);
    return som + prijs * stuks;
  }, 0);

  const handmatig = handmatigeKosten(jaar);
  // Kilometervergoeding: telt alléén mee als er een tarief is ingesteld.
  const kmBedrag = kmAftrek(jaar) || 0;
  // Afschrijving op bedrijfsmiddelen: zonder enig activum is dit gewoon 0.
  const activaBedrag = totaalAfschrijvingVanJaar(jaar);
  const inkoopwaarde = cogs + hnviInkoop;
  const overigeKosten = kostenOverig + handmatig.reduce((s, k) => s + (Number(k.bedrag) || 0), 0) + kmBedrag + activaBedrag;
  const winst = omzet - inkoopwaarde - overigeKosten;
  const ibd = ibDetail(winst, jaar, { metMkb: inkomenssoort() !== 'overig' });
  const mkb = ibd.mkb;
  const belastbaar = ibd.belastbaar;

  const velden = aangifteVelden(belTX, { cogs, hnviInkoop, handmatig, kmBedrag, activaBedrag });
  const omzetSplit = nettoOmzet(belTX);

  // Het document als blokken, niet als kant-en-klare tekst. Zo kunnen het
  // tekstbestand en de pdf dezelfde cijfers tonen zonder dat er twee keer
  // opmaak in de code staat.
  return {
    jaar,
    resultaat: { omzet, winst },
    titel: 'Aangifte inkomstenbelasting — winst uit onderneming',
    ondertitel: `Boekjaar ${jaar === 'all' ? 'alle jaren' : jaar}`,
    blokken: [
      { type: 'kop', tekst: 'Opbrengsten' },
      { type: 'regel', label: 'Netto-omzet', bedrag: omzet },

      { type: 'kop', tekst: 'Inkoopwaarde van de omzet' },
      { type: 'regel', label: 'Verkochte voorraad', bedrag: cogs },
      { type: 'regel', label: 'Verkochte HNVI-loten', bedrag: hnviInkoop },
      { type: 'regel', label: 'Totaal inkoopwaarde', bedrag: inkoopwaarde, totaal: true },

      { type: 'kop', tekst: 'Overige bedrijfskosten' },
      { type: 'regel', label: 'Kosten uit de administratie', bedrag: kostenOverig },
      ...handmatig.map(k => ({ type: 'regel', label: k.label || 'Overige post', bedrag: Number(k.bedrag) || 0 })),
      ...(kmBedrag > 0 ? [{ type: 'regel', label: `Kilometervergoeding (${totaalKmVanJaar(jaar)} km × € ${bedragTekst(kmTarief())})`, bedrag: kmBedrag }] : []),
      ...(activaBedrag > 0 ? [{ type: 'regel', label: 'Afschrijving bedrijfsmiddelen', bedrag: activaBedrag }] : []),
      { type: 'regel', label: 'Totaal overige kosten', bedrag: overigeKosten, totaal: true },

      { type: 'kop', tekst: 'Resultaat' },
      { type: 'regel', label: 'Winst uit onderneming', bedrag: winst },
      ...(ibd.aftrek > 0 ? [{ type: 'regel', label: 'Zelfstandigenaftrek', bedrag: ibd.aftrek, aftrek: true }] : []),
      ...(mkbTarief(jaar) > 0
        ? [{ type: 'regel', label: `MKB-winstvrijstelling (${pct(mkbTarief(jaar))})`, bedrag: mkb, aftrek: true }]
        : []),
      { type: 'regel', label: 'Belastbare winst', bedrag: belastbaar, totaal: true },
      { type: 'regel', label: winst > 0 ? 'Geschatte inkomstenbelasting hierover' : 'Geen belasting (verlies)', bedrag: Math.max(0, ibd.ib) },
      { type: 'tekst', tekst: winst > 0
        ? `Dit is de belasting over deze inkomsten alleen. Wat je uiteindelijk betaalt of terugkrijgt hangt ook af van je andere inkomsten en wat daarop al is ingehouden.`
        : `Bij verlies betaal je hierover niets. Verrekening met ander inkomen kan een teruggave opleveren.` },

      { type: 'kop', tekst: 'In te vullen op het aangifteformulier' },
      { type: 'regel', label: 'Omzet', bedrag: omzet },
      ...velden.map(v => ({ type: 'regel', label: v.veld, bedrag: v.bedrag })),

      { type: 'kop', tekst: 'Waar komen die bedragen vandaan' },
      {
        type: 'toelichting',
        label: 'Omzet',
        bedrag: omzet,
        tekst: omzetSplit.af > 0
          ? `Ontvangen op de omzetrekeningen ${bedragTekst(omzetSplit.bij)}, minus ${bedragTekst(omzetSplit.af)} aan terugbetalingen aan klanten${hnviOmzet > 0 ? `, plus ${bedragTekst(hnviOmzet)} uit verkochte HNVI-loten` : ''}.`
          : `Ontvangen op de omzetrekeningen${hnviOmzet > 0 ? `, plus ${bedragTekst(hnviOmzet)} uit verkochte HNVI-loten` : ''}.`
      },
      ...velden.map(v => ({
        type: 'toelichting', label: v.veld, bedrag: v.bedrag,
        tekst: v.bronnen.join(' · ')
      })),

      { type: 'kop', tekst: 'Balans per 31 december' },
      { type: 'regel', label: 'Voorraad (inkoopwaarde)', bedrag: eind },

      { type: 'voet', tekst: `Opgesteld met de Xtenate-administratie op ${new Date().toLocaleDateString('nl-NL')}. Indicatie op basis van je eigen invoer; laat de aangifte controleren.` }
    ]
  };
}

/** Bedrag zonder euroteken, met Nederlandse punten en komma. */
function bedragTekst(n) {
  return (Math.round(n * 100) / 100).toLocaleString('nl-NL', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

/**
 * Het aangiftemodel als platte tekst, voor kopiëren naar het klembord en voor
 * het tekstbestand. Bedragen worden rechts uitgelijnd met puntjes ertussen.
 */
export function aangifteTekst(jaar = gekozenJaar()) {
  const doc = aangifteModel(jaar);
  const BREED = 62;
  const regels = [doc.titel.toUpperCase(), doc.ondertitel];

  for (const b of doc.blokken) {
    if (b.type === 'kop') {
      regels.push('', b.tekst.toUpperCase());
    } else if (b.type === 'regel') {
      const bed = (b.aftrek ? '- € ' : '€ ') + bedragTekst(b.bedrag);
      // De streep hoort boven het totaal: hij sluit de regels erboven af.
      if (b.totaal) regels.push(' '.repeat(Math.max(0, BREED - bed.length)) + '-'.repeat(bed.length));
      const label = b.label + ' ';
      regels.push(label.padEnd(BREED - bed.length, '.') + bed);
    } else if (b.type === 'toelichting') {
      regels.push(`  ${b.label} (€ ${bedragTekst(b.bedrag)})`, `    ${b.tekst}`);
    } else if (b.type === 'tekst') {
      regels.push('', b.tekst);
    } else if (b.type === 'voet') {
      regels.push('', b.tekst);
    }
  }
  return regels.join('\n');
}

export function kopieerAangifte() {
  const tekst = aangifteTekst();
  navigator.clipboard?.writeText(tekst)
    .then(() => toonAangifte(tekst, 'Gekopieerd naar het klembord.'))
    .catch(() => toonAangifte(tekst, 'Kopiëren lukte niet — selecteer de tekst hieronder.'));
}

export function downloadAangifte() {
  const jaar = gekozenJaar();
  const blob = new Blob([aangifteTekst(jaar)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aangifte-${jaar}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadAangiftePdf() {
  const jaar = gekozenJaar();
  downloadModelPdf(aangifteModel(jaar), `aangifte-${jaar}.pdf`);
}

/** Klein venster met de tekst, zodat je meteen ziet wat er gekopieerd is. */
function toonAangifte(tekst, melding) {
  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true">
      <header class="pm-kop">
        <div>
          <h3>Aangiftegegevens ${gekozenJaar()}</h3>
          <p class="pm-sub">${escHtml(melding)}</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud">
        <pre style="margin:0;padding:16px 20px;font-size:12px;line-height:1.55;white-space:pre-wrap;font-variant-numeric:tabular-nums">${escHtml(tekst)}</pre>
      </div>
      <footer class="pm-voet">
        <span class="pm-hint">Esc sluit dit venster</span>
        <button type="button" class="btn" data-sluit>Sluiten</button>
      </footer>
    </div>`;
  koppelVenster(laag);
}

// ------------------------------------------------------ aftrekposten aanvullen

export function openExtraKosten() {
  const jaar = gekozenJaar();
  const posten = handmatigeKosten(jaar);
  const rijen = (posten.length ? posten : [{ label: '', bedrag: '' }]).map((k, i) => rijHtml(k, i)).join('');

  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true" style="max-width:520px">
      <header class="pm-kop">
        <div>
          <h3>Aftrekposten aanvullen — ${jaar}</h3>
          <p class="pm-sub">Kosten die niet uit je bankboekingen komen, zoals huur of verzekering. Maximaal vijf.</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud">
        <div style="padding:16px 20px 0">
          <div style="display:grid;grid-template-columns:minmax(0,1fr) 120px 34px;gap:8px;margin-bottom:8px;font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">
            <span>Omschrijving</span><span style="text-align:right">Bedrag</span><span></span>
          </div>
        </div>
        <div id="xk-rijen" style="padding:0 20px 16px">${rijen}</div>
        <p style="padding:0 20px 16px;margin:0;font-size:12px;color:var(--text-secondary)">
          Met de rode knop haal je een post weg. Verwijderen is pas definitief als je op Opslaan klikt.
        </p>
      </div>
      <footer class="pm-voet">
        <button type="button" class="btn btn-sm" id="xk-erbij">Regel erbij</button>
        <div class="pm-knoppen">
          <button type="button" class="btn" data-sluit>Annuleren</button>
          <button type="button" class="btn btn-primary" id="xk-bewaar">Opslaan</button>
        </div>
      </footer>
    </div>`;

  const sluit = koppelVenster(laag);
  const rijenVak = laag.querySelector('#xk-rijen');

  rijenVak.addEventListener('click', ev => {
    const knop = ev.target.closest('.xk-weg');
    if (knop) knop.closest('.xk-rij')?.remove();
  });

  laag.querySelector('#xk-erbij').addEventListener('click', () => {
    const n = rijenVak.querySelectorAll('.xk-rij').length;
    if (n >= 5) return;
    rijenVak.insertAdjacentHTML('beforeend', rijHtml({ label: '', bedrag: '' }, n));
  });

  laag.querySelector('#xk-bewaar').addEventListener('click', () => {
    const posten = [...rijenVak.querySelectorAll('.xk-rij')].map(rij => ({
      label: rij.querySelector('.xk-label').value.trim(),
      bedrag: Number(rij.querySelector('.xk-bedrag').value) || 0
    })).filter(k => k.label && k.bedrag > 0);
    localStorage.setItem(kostenSleutel(jaar), JSON.stringify(posten.slice(0, 5)));
    sluit();
    renderBelasting();
  });
}

function rijHtml(k, i) {
  return `
    <div class="xk-rij" style="display:grid;grid-template-columns:minmax(0,1fr) 120px 34px;gap:8px;margin-bottom:10px">
      <input class="xk-label" type="text" placeholder="Omschrijving" value="${escHtml(k.label || '')}"
             style="padding:8px 10px;font:inherit;font-size:13px;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-sm)">
      <input class="xk-bedrag" type="number" step="0.01" min="0" placeholder="0,00" value="${k.bedrag ?? ''}"
             style="padding:8px 10px;font:inherit;font-size:13px;text-align:right;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-sm)">
      <button type="button" class="xk-weg" aria-label="Deze aftrekpost verwijderen"
              title="Deze aftrekpost verwijderen"
              style="border:1px solid var(--value-negative);background:transparent;border-radius:var(--radius-sm);cursor:pointer;color:var(--value-negative);font-size:16px;line-height:1">&times;</button>
    </div>`;
}

/**
 * Hangt een venster in de pagina en regelt sluiten via Esc, de knoppen en een
 * klik ernaast. Esc gaat in de capture-fase, zodat de algemene Escape-handler
 * van de app er niet doorheen loopt.
 */
/**
 * Venster om te kiezen in welke rubriek dit inkomen valt. Dat bepaalt of de
 * MKB-winstvrijstelling meetelt, en dat scheelt direct in de belasting.
 */
export function openInkomenssoort() {
  const nu = inkomenssoort();
  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true" style="max-width:560px">
      <header class="pm-kop">
        <div>
          <h3>In welke rubriek vul je dit in?</h3>
          <p class="pm-sub">Dit bepaalt of de MKB-winstvrijstelling van ${pct(tarievenVoor(gekozenJaar()).mkb)} meetelt.</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud" style="padding:16px 20px">
        <label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--border-default);border-radius:var(--radius-sm);margin-bottom:10px;cursor:pointer">
          <input type="radio" name="soort" value="onderneming"${nu === 'onderneming' ? ' checked' : ''} style="margin-top:3px">
          <span>
            <strong style="display:block;font-size:13px">Winst uit onderneming</strong>
            <span style="font-size:12px;color:var(--text-secondary);line-height:1.5">De Belastingdienst ziet je als ondernemer voor de inkomstenbelasting. De MKB-winstvrijstelling van ${pct(tarievenVoor(gekozenJaar()).mkb)} geldt: je betaalt over ${pct(1 - tarievenVoor(gekozenJaar()).mkb)} van de winst.</span>
          </span>
        </label>
        <label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--border-default);border-radius:var(--radius-sm);cursor:pointer">
          <input type="radio" name="soort" value="overig"${nu === 'overig' ? ' checked' : ''} style="margin-top:3px">
          <span>
            <strong style="display:block;font-size:13px">Resultaat uit overig werk</strong>
            <span style="font-size:12px;color:var(--text-secondary);line-height:1.5">Je verdient er iets bij, maar bent geen ondernemer voor de inkomstenbelasting. De MKB-winstvrijstelling geldt dan niet: je betaalt over de hele winst.</span>
          </span>
        </label>
        <p style="margin:14px 0 0;font-size:12px;color:var(--text-secondary);line-height:1.6">
          Welke van de twee klopt hangt af van je situatie, niet van deze instelling. De Belastingdienst kijkt onder meer naar hoeveel klanten je hebt, of je zelf je prijzen bepaalt, hoeveel je investeert en of je ondernemersrisico loopt. Twijfel je, gebruik dan de OndernemersCheck van de Belastingdienst of vraag het na bij een adviseur.
        </p>
      </div>
      <footer class="pm-voet">
        <div class="pm-knoppen">
          <button type="button" class="btn" data-sluit>Annuleren</button>
          <button type="button" class="btn btn-primary" id="soort-bewaar">Opslaan</button>
        </div>
      </footer>
    </div>`;

  const sluit = koppelVenster(laag);
  laag.querySelector('#soort-bewaar').addEventListener('click', () => {
    zetInkomenssoort(laag.querySelector('input[name="soort"]:checked')?.value);
    sluit();
    renderBelasting();
  });
}

/**
 * Venster met de belastingtarieven van het gekozen jaar. De standaardwaarden komen van de
 * KVK; wat je hier aanpast staat alleen in deze browser en gaat vóór de standaard.
 */
export function openTarieven() {
  const jaar = /^\d{4}$/.test(String(gekozenJaar())) ? String(gekozenJaar()) : lopendJaar();
  const t = tarievenVoor(jaar);
  const num = v => parseFloat(String(v).replace(',', '.'));
  const p2 = v => String(Math.round(v * 10000) / 100).replace('.', ',');
  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true" style="max-width:600px">
      <header class="pm-kop">
        <div>
          <h3>Tarieven ${escHtml(jaar)}</h3>
          <p class="pm-sub">${t.vanJaar !== jaar
            ? `Voor ${escHtml(jaar)} zijn nog geen tarieven ingevuld: dit zijn de waarden van ${escHtml(t.vanJaar)}. Pas ze aan en sla op.`
            : t.voorlopig ? 'Dit is een voorstel (Belastingplan), nog niet definitief. Controleer ze zodra ze vaststaan.' : 'Standaardwaarden volgens de KVK. Pas aan als de Belastingdienst iets anders opgeeft.'}</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud" style="padding:16px 20px">
        <table class="tbl-compact" style="width:100%"><thead><tr><th>Schijf</th><th>Tot (€)</th><th>Tarief (%)</th></tr></thead><tbody>
          ${t.schijven.map((s, n) => `<tr><td>${n + 1}</td>
            <td>${s.tot == null ? '<span class="muted">geen grens</span>' : `<input type="text" inputmode="numeric" data-tot="${n}" value="${s.tot}" style="width:110px">`}</td>
            <td><input type="text" inputmode="decimal" data-tarief="${n}" value="${p2(s.tarief)}" style="width:80px"></td></tr>`).join('')}
        </tbody></table>
        <div class="form-group" style="margin-top:12px"><label>MKB-winstvrijstelling (%)</label><input type="text" inputmode="decimal" id="tar-mkb" value="${p2(t.mkb)}" style="width:100px"></div>
        <div class="form-group"><label>Zelfstandigenaftrek (€)</label><input type="text" inputmode="numeric" id="tar-za" value="${t.zelfstandigenaftrek}" style="width:100px"></div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;cursor:pointer">
          <input type="checkbox" id="tar-za-aan" ${zelfstandigenaftrekAan() ? 'checked' : ''} style="margin-top:3px">
          <span style="font-size:12px;line-height:1.5">Zelfstandigenaftrek toepassen. Alleen aanvinken als je aan het urencriterium voldoet (minimaal 1.225 uur per jaar aan je onderneming). Dit geldt voor alle jaren. Vraag bij twijfel je boekhouder of de Belastingdienst.</span>
        </label>
        <p style="margin:12px 0 0;font-size:12px;color:var(--text-secondary);line-height:1.6">Dit blijft een schatting over de winst uit onderneming. Heffingskortingen en je andere inkomsten zitten er niet in.</p>
      </div>
      <footer class="pm-voet">
        <div class="pm-knoppen">
          ${t.aangepast ? '<button type="button" class="btn" id="tar-herstel">Standaard herstellen</button>' : ''}
          <button type="button" class="btn" data-sluit>Annuleren</button>
          <button type="button" class="btn btn-primary" id="tar-bewaar">Opslaan</button>
        </div>
      </footer>
    </div>`;
  const sluit = koppelVenster(laag);
  laag.querySelector('#tar-bewaar').addEventListener('click', () => {
    const schijven = t.schijven.map((s, n) => ({
      tot: s.tot == null ? null : num(laag.querySelector(`[data-tot="${n}"]`).value),
      tarief: num(laag.querySelector(`[data-tarief="${n}"]`).value) / 100
    }));
    const mkb = num(laag.querySelector('#tar-mkb').value) / 100;
    const za = num(laag.querySelector('#tar-za').value);
    const ok = schijven.every((s, n) => Number.isFinite(s.tarief) && s.tarief > 0 && s.tarief < 1 && (s.tot == null || (Number.isFinite(s.tot) && s.tot > 0 && (n === 0 || s.tot > schijven[n - 1].tot))))
      && Number.isFinite(mkb) && mkb >= 0 && mkb < 1 && Number.isFinite(za) && za >= 0;
    if (!ok) { window.alert('Controleer de invoer: tarieven in procenten, schijfgrenzen oplopend, en geen negatieve bedragen.'); return; }
    bewaarTarieven(jaar, { schijven, mkb, zelfstandigenaftrek: za });
    zetZelfstandigenaftrek(laag.querySelector('#tar-za-aan').checked);
    sluit();
    renderBelasting();
    window.hertekenHuidigePagina?.();
  });
  laag.querySelector('#tar-herstel')?.addEventListener('click', () => {
    herstelStandaardTarieven(jaar);
    sluit();
    renderBelasting();
  });
}

/**
 * Venster waarin je per boeking het aftrekpercentage zet.
 *
 * Je kiest eerst een grootboekrekening en ziet dan alle uitgaven van dat jaar
 * met datum, omschrijving en bedrag. Per regel vul je in hoeveel procent
 * zakelijk is; onderaan zie je meteen wat dat aan aftrek oplevert.
 */
export function openPercentages(startGb = '4235') {
  const GBNM = grootboekNamen();
  const jaar = gekozenJaar();
  const belTX = jaar === 'all'
    ? [...state.HIST_TX, ...state.TX]
    : txVanJaar(jaar);

  const kosten = belTX.filter(isKostenpost);
  const rekeningen = [...new Set(kosten.map(t => String(t.gb)))].sort();
  const gb = rekeningen.includes(startGb) ? startGb : (rekeningen[0] || startGb);

  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.innerHTML = `
    <div class="pm-venster" role="dialog" aria-modal="true" style="max-width:760px">
      <header class="pm-kop">
        <div>
          <h3>Aftrekpercentage per boeking — ${jaar}</h3>
          <p class="pm-sub">Deels zakelijke aankopen trek je maar deels af. Zet per boeking hoeveel procent zakelijk is; 100% is de standaard.</p>
        </div>
        <button type="button" class="pm-kruis" data-sluit aria-label="Sluiten">&times;</button>
      </header>
      <div class="pm-inhoud">
        <div style="padding:14px 20px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <label for="pc-gb" style="font-size:12px;color:var(--text-secondary)">Grootboekrekening</label>
          <select id="pc-gb" style="padding:7px 10px;font:inherit;font-size:13px;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-sm)">
            ${rekeningen.map(r => `<option value="${r}"${r === gb ? ' selected' : ''}>${r} — ${escHtml(GBNM[r] || 'onbekend')}</option>`).join('')}
          </select>
          <input id="pc-zoek" type="search" placeholder="Zoek op omschrijving of naam"
                 style="flex:1;min-width:170px;padding:7px 10px;font:inherit;font-size:13px;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-sm)">
        </div>
        <div id="pc-lijst" style="padding:12px 20px 16px"></div>
      </div>
      <footer class="pm-voet">
        <div id="pc-totaal" style="font-size:12px;color:var(--text-secondary)"></div>
        <div class="pm-knoppen">
          <button type="button" class="btn" data-sluit>Annuleren</button>
          <button type="button" class="btn btn-primary" id="pc-bewaar">Opslaan</button>
        </div>
      </footer>
    </div>`;

  const sluit = koppelVenster(laag);
  const kaart = { ...aftrekPercentages() };
  const kiezer = laag.querySelector('#pc-gb');
  const zoek = laag.querySelector('#pc-zoek');
  const lijst = laag.querySelector('#pc-lijst');
  const totaalVak = laag.querySelector('#pc-totaal');

  const teken = () => {
    const term = zoek.value.trim().toLowerCase();
    const rijen = kosten
      .filter(t => String(t.gb) === kiezer.value)
      .filter(t => !term || `${t.naam || ''} ${t.omschr || ''}`.toLowerCase().includes(term))
      .sort((a, b) => a.datum.localeCompare(b.datum));

    if (!rijen.length) {
      lijst.innerHTML = '<p style="margin:8px 0;font-size:13px;color:var(--text-secondary)">Geen boekingen op deze rekening in dit jaar.</p>';
      totaalVak.textContent = '';
      return;
    }

    lijst.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:6px 8px 6px 0;width:78px">Datum</th>
          <th style="padding:6px 8px 6px 0">Omschrijving</th>
          <th style="padding:6px 8px;text-align:right;width:92px">Bedrag</th>
          <th style="padding:6px 8px;text-align:right;width:74px">Zakelijk</th>
          <th style="padding:6px 0 6px 8px;text-align:right;width:92px">Aftrekbaar</th>
        </tr></thead>
        <tbody>${rijen.map(t => `
          <tr data-id="${escHtml(String(t.id))}" style="border-top:1px solid var(--border-default)">
            <td style="padding:7px 8px 7px 0;color:var(--text-secondary)">${ddmm(t.datum)}</td>
            <td style="padding:7px 8px 7px 0">${escHtml(t.naam || t.omschr || '—')}</td>
            <td style="padding:7px 8px;text-align:right">${fmt(t.bedrag)}</td>
            <td style="padding:7px 8px;text-align:right">
              <input class="pc-pct" type="number" min="0" max="100" step="1" value="${percentageVan(t, kaart)}"
                     style="width:62px;padding:5px 6px;font:inherit;font-size:13px;text-align:right;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-sm)">
            </td>
            <td class="pc-uit" style="padding:7px 0 7px 8px;text-align:right;color:var(--text-secondary)">${fmt(aftrekbaarBedrag(t, kaart))}</td>
          </tr>`).join('')}</tbody>
      </table>`;

    const werkBij = () => {
      let bruto = 0, netto = 0;
      for (const rij of lijst.querySelectorAll('tr[data-id]')) {
        const t = rijen.find(x => String(x.id) === rij.dataset.id);
        if (!t) continue;
        const veld = rij.querySelector('.pc-pct');
        let pct = Number(veld.value);
        if (!Number.isFinite(pct) || pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        kaart[String(t.id)] = pct;
        bruto += Number(t.bedrag) || 0;
        const deel = (Number(t.bedrag) || 0) * pct / 100;
        netto += deel;
        rij.querySelector('.pc-uit').textContent = fmt(deel);
      }
      totaalVak.textContent = `Totaal op deze rekening ${fmt(bruto)} · aftrekbaar ${fmt(netto)}`;
    };

    lijst.addEventListener('input', e => { if (e.target.classList.contains('pc-pct')) werkBij(); });
    werkBij();
  };

  kiezer.addEventListener('change', teken);
  zoek.addEventListener('input', teken);
  teken();

  laag.querySelector('#pc-bewaar').addEventListener('click', () => {
    // Alleen afwijkende percentages bewaren: 100% is de standaard en hoeft
    // niet opgeslagen, anders groeit de opslag met elke boeking mee.
    const schoon = {};
    for (const [id, pct] of Object.entries(kaart)) {
      if (Number(pct) !== 100) schoon[id] = Number(pct);
    }
    bewaarPercentages(schoon);
    sluit();
    renderBelasting();
  });
}

function koppelVenster(laag) {
  document.body.appendChild(laag);
  const sluit = () => { document.removeEventListener('keydown', opToets, true); laag.remove(); };
  function opToets(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); }
  }
  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });
  laag.querySelectorAll('[data-sluit]').forEach(k => k.addEventListener('click', sluit));
  return sluit;
}
