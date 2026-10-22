// controle.js — Controle: loopt de administratie na op gaten en tegenstrijdigheden.
//
// Elke controle levert hetzelfde soort uitkomst op, zodat de pagina ze allemaal
// gelijk kan tonen en de samenvatting simpelweg kan tellen:
//   { sectie, titel, ok, uitleg, items: [{ label, sub, ga }] }
// `ga` bepaalt waar je heen springt als je op een regel klikt:
//   'tx:<id>'  -> detailpaneel van die boeking
//   'gb:<nr>'  -> die grootboekrekening
//   'pagina:<naam>' -> die pagina

import { BEGINSALDO_2026, esc, fmt, isPriveBetaaldeKost, teltBij, weergaveNaam } from './helpers.js?v=20261023d';
import { MAAND_SALDOS, state, grootboekNamen, rekeningNamen } from './storage.js?v=20261023d';
import { DREMPEL, vindDuplicaten } from './duplicaten.js?v=20261023d';
import {
  REDEN_LABEL, aantalVerborgen, herstelAlles, herstelControle, herstelMelding,
  isControleUit, isVerborgen, verbergMelding, verborgenOverzicht, zetControleUit
} from './negeren.js?v=20261023d';

const el = id => document.getElementById(id);
const HOOFDREKENING = '1010';

function txLabel(t) {
  return `${t.datum} · ${weergaveNaam(t) || '(geen naam)'} · ${fmt(t.bedrag)}`;
}

/**
 * Bouwt één controle-uitkomst.
 * `titelOk` is wat er staat als alles klopt; `titelFout` benoemt het probleem
 * mét aantal, zodat de tekst nooit tegenspreekt wat het icoon toont.
 * `ernst` is 'fout' (rood kruis) als de administratie er aantoonbaar niet klopt,
 * en 'waarschuwing' (oranje) als het ook een geldige situatie kán zijn.
 */
function check(id, sectie, titelOk, titelFout, ernst, items, uitleg, geenProbleemTekst) {
  // Meldingen die je hebt weggeklikt tellen niet mee, tenzij de onderliggende
  // gegevens sindsdien zijn veranderd.
  const zichtbaar = isControleUit(id)
    ? []
    : items.filter(i => !isVerborgen(id, i.sleutel, i.vinger));
  const verborgen = items.length - zichtbaar.length;
  const ok = zichtbaar.length === 0;
  return {
    id,
    sectie,
    ok,
    uit: isControleUit(id),
    ernst: ok ? 'ok' : ernst,
    ernstAlsFout: ernst,
    titel: ok ? titelOk : titelFout(zichtbaar.length),
    titelOk,
    items: zichtbaar,
    verborgen,
    uitleg,
    geenProbleemTekst
  };
}

const enkelvoud = (n, een, meer) => `${n} ${n === 1 ? een : meer}`;

/**
 * Vult sleutel en vingerafdruk aan op een melding. De sleutel wijst het item
 * aan, de vinger legt vast hoe het er op dat moment uitzag — zo komt een
 * weggeklikte melding terug zodra de gegevens wijzigen.
 */
function meld(sleutel, velden) {
  return { sleutel: String(sleutel), vinger: `${velden.label}|${velden.sub}`, ...velden };
}

// ------------------------------------------------------------- de controles

function bepaalBron() {
  const jaar = state.huidigJaar || 'all';
  if (jaar === 'all') return { tx: [...state.HIST_TX, ...state.TX], jaar };
  if (jaar === '2026') return { tx: state.TX, jaar };
  return { tx: state.HIST_TX.filter(t => t.datum.startsWith(jaar)), jaar };
}

function controlesBoekingen(tx) {
  const GBNM = grootboekNamen();
  const REKNM = rekeningNamen();
  const uit = [];

  uit.push(check('tx-datum', 'Boekingen',
    'Alle boekingen hebben een datum',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} zonder geldige datum`, 'fout',
    tx.filter(t => !/^\d{4}-\d{2}-\d{2}$/.test(t.datum || ''))
      .map(t => meld(t.id, { label: `${weergaveNaam(t) || '(geen naam)'} · ${fmt(t.bedrag)}`, sub: `datum: ${t.datum || 'leeg'}`, ga: `tx:${t.id}` })),
    'Zonder geldige datum valt een boeking buiten elk jaar- en maandoverzicht.'));

  const vandaag = new Date().toISOString().slice(0, 10);
  uit.push(check('tx-toekomst', 'Boekingen',
    'Geen boekingen met een datum in de toekomst',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} met een datum in de toekomst`, 'fout',
    tx.filter(t => t.datum > vandaag).map(t => meld(t.id, { label: txLabel(t), sub: 'ligt na vandaag', ga: `tx:${t.id}` })),
    'Een datum in de toekomst wijst meestal op een typefout in het jaartal.'));

  uit.push(check('tx-bedrag', 'Boekingen',
    'Geen lege of negatieve bedragen',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} met een leeg of negatief bedrag`, 'fout',
    tx.filter(t => !(Number(t.bedrag) > 0))
      .map(t => meld(t.id, { label: `${t.datum} · ${weergaveNaam(t) || '(geen naam)'}`, sub: `bedrag: ${fmt(t.bedrag || 0)}`, ga: `tx:${t.id}` })),
    'Of een bedrag bij- of afgaat volgt uit de soort mutatie, dus het bedrag zelf hoort altijd groter dan nul te zijn.'));

  uit.push(check('tx-geen-gb', 'Boekingen',
    'Alle boekingen hebben een grootboekrekening',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} zonder grootboekrekening`, 'fout',
    tx.filter(t => !t.gb).map(t => meld(t.id, { label: txLabel(t), sub: 'geen grootboekrekening', ga: `tx:${t.id}` })),
    'Zonder grootboekrekening telt een boeking nergens in mee — niet in de omzet, niet in de kosten.'));

  const onbekend = {};
  tx.filter(t => t.gb && !GBNM[t.gb]).forEach(t => { (onbekend[t.gb] ||= []).push(t); });
  uit.push(check('tx-onbekend-gb', 'Boekingen',
    'Alle gebruikte grootboekrekeningen staan in het schema',
    n => `${enkelvoud(n, 'grootboeknummer', 'grootboeknummers')} niet in het schema`, 'waarschuwing',
    Object.entries(onbekend).map(([gb, lijst]) => meld(gb, {
      label: `Rekening ${gb}`,
      sub: `${enkelvoud(lijst.length, 'boeking', 'boekingen')} · samen ${fmt(lijst.reduce((s, t) => s + t.bedrag, 0))}`,
      ga: `gb:${gb}`
    })),
    'Deze nummers komen in je boekingen voor maar hebben geen naam in de app. Ze verschijnen overal als "Onbekende rekening".'));

  uit.push(check('tx-rekening', 'Boekingen',
    'Alle boekingen staan op een bekende rekening',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} op een onbekende rekening`, 'fout',
    tx.filter(t => !t.rek || !REKNM[t.rek])
      .map(t => meld(t.id, { label: txLabel(t), sub: `rekening: ${t.rek || 'leeg'}`, ga: `tx:${t.id}` })),
    'Een onbekende rekening laat de mutatie uit de saldo-overzichten vallen.'));

  const duplicaten = vindDuplicaten(tx);
  uit.push(check('tx-dubbel', 'Boekingen',
    'Geen dubbele boekingen',
    n => `${enkelvoud(n, 'mogelijk dubbele boeking', 'mogelijk dubbele boekingen')} gevonden`, 'waarschuwing',
    duplicaten.map(d => meld(d.duplicaat.id, {
      label: `${txLabel(d.duplicaat)} — ${d.score}% overeenkomst`,
      sub: `${d.redenen.join(' · ')}. Eerdere boeking: ${d.origineel.datum}.`,
      ga: `tx:${d.duplicaat.id}`
    })),
    `Er wordt gewogen op bedrag, rekening, richting, omschrijving en het aantal dagen ertussen; alleen paren boven de ${DREMPEL}% komen hier terecht. Vaste leveranciers en terugkerende tarieven worden overgeslagen, want twee pakketten van € 5,95 op één dag is normaal.`));

  const ids = new Map();
  const dubbeleIds = [];
  tx.forEach(t => { if (ids.has(String(t.id))) dubbeleIds.push(t); else ids.set(String(t.id), t); });
  uit.push(check('tx-dubbel-id', 'Boekingen',
    'Elk boekingsnummer is uniek',
    n => `${enkelvoud(n, 'boeking', 'boekingen')} met een dubbel boekingsnummer`, 'fout',
    dubbeleIds.map(t => meld(t.id, { label: txLabel(t), sub: `nummer ${t.id} komt meer dan één keer voor`, ga: `tx:${t.id}` })),
    'Twee boekingen met hetzelfde nummer kunnen elkaar bij bewerken overschrijven.'));

  return uit;
}

function controlesPrive(tx) {
  const uit = [];

  uit.push(check('tx-omzet-richting', 'Privé',
    'Privé-opnames correct geboekt',
    n => `${enkelvoud(n, 'privé-opname', 'privé-opnames')} verkeerd geboekt`, 'fout',
    tx.filter(t => (t.type === 'prive_opname') !== (t.gb === '601'))
      .map(t => meld(t.id, { label: txLabel(t), sub: `soort "${t.type}" bij grootboek ${t.gb}`, ga: `tx:${t.id}` })),
    'Soort en grootboekrekening moeten samen kloppen: een opname is type prive_opname én rekening 601.'));

  uit.push(check('tx-kosten-richting', 'Privé',
    'Privé-stortingen correct geboekt',
    n => `${enkelvoud(n, 'privé-storting', 'privé-stortingen')} verkeerd geboekt`, 'fout',
    tx.filter(t => (t.type === 'prive_storting') !== (t.gb === '600') && !isPriveBetaaldeKost(t))
      .map(t => meld(t.id, { label: txLabel(t), sub: `soort "${t.type}" bij grootboek ${t.gb}`, ga: `tx:${t.id}` })),
    'Loopt dit uiteen, dan telt een storting mee als opname of andersom, en klopt je privé-saldo niet. Zakelijke kosten die je privé hebt betaald (privé-storting op een kosten- of inkooprekening) zijn bewust toegestaan en tellen als kosten.'));

  return uit;
}

function controlesRichting(tx) {
  const GBNM = grootboekNamen();
  const uit = [];

  uit.push(check('prive-opname', 'Boekingen',
    'Omzet staat als inkomst geboekt',
    n => `${enkelvoud(n, 'omzetboeking', 'omzetboekingen')} geboekt als uitgave`, 'waarschuwing',
    tx.filter(t => String(t.gb).startsWith('8') && t.type === 'uitgave')
      .map(t => meld(t.id, { label: txLabel(t), sub: `${GBNM[t.gb] || t.gb} maar geboekt als uitgave`, ga: `tx:${t.id}` })),
    'Een omzetrekening met een uitgave erop is meestal een terugbetaling of een verkeerd gekozen soort. Klopt het wel, boek het dan op een aparte rekening.'));

  uit.push(check('prive-storting', 'Boekingen',
    'Kosten en inkoop staan als uitgave geboekt',
    n => `${enkelvoud(n, 'kostenboeking', 'kostenboekingen')} geboekt als inkomst`, 'waarschuwing',
    tx.filter(t => (String(t.gb).startsWith('7') || String(t.gb).startsWith('4')) && t.type === 'inkomst')
      .map(t => meld(t.id, { label: txLabel(t), sub: `${GBNM[t.gb] || t.gb} maar geboekt als inkomst`, ga: `tx:${t.id}` })),
    'Een kostenrekening met een inkomst erop is meestal een creditnota of retour. Dat mag, maar het drukt wel je kosten.'));

  return uit;
}

function controlesAansluiting(tx, jaar) {
  const uit = [];

  // Overboekingen tussen eigen rekeningen horen per saldo op nul uit te komen.
  const kruis = tx.filter(t => t.gb === '2000' || t.gb === '1090');
  const kruisSaldo = kruis.reduce((s, t) => s + (teltBij(t) ? t.bedrag : -t.bedrag), 0);
  uit.push(check('kruisposten', 'Aansluiting',
    'Overboekingen tussen eigen rekeningen vallen tegen elkaar weg',
    () => `Overboekingen laten een verschil van ${fmt(Math.abs(kruisSaldo))}`, 'fout',
    kruis.length && Math.abs(kruisSaldo) > 0.01
      ? [meld('kruis', { label: `Verschil ${fmt(kruisSaldo)}`, sub: `over ${enkelvoud(kruis.length, 'overboeking', 'overboekingen')}`, ga: 'gb:2000' })]
      : [],
    'Geld dat je van je ene naar je andere rekening schuift, hoort twee keer in de administratie te staan: eraf én erop. Blijft er een verschil over, dan mist er een kant.'));

  // Berekend saldo naast het saldo dat de bank opgeeft
  const eindHuidig = BEGINSALDO_2026 + state.TX
    .filter(t => t.rek === HOOFDREKENING)
    .reduce((s, t) => s + (teltBij(t) ? t.bedrag : -t.bedrag), 0);
  const maandenMetSaldo = Object.keys(MAAND_SALDOS).sort();
  const laatste = maandenMetSaldo[maandenMetSaldo.length - 1];
  const items = [];
  if (jaar !== 'all' && jaar !== '2026' && laatste && laatste.startsWith(jaar)) {
    const eersteMaand = maandenMetSaldo.find(m => m.startsWith(jaar));
    const begin = eersteMaand ? MAAND_SALDOS[eersteMaand].begin : null;
    if (begin != null) {
      const mutaties = tx.filter(t => t.rek === HOOFDREKENING)
        .reduce((s, t) => s + (teltBij(t) ? t.bedrag : -t.bedrag), 0);
      const verschil = (begin + mutaties) - MAAND_SALDOS[laatste].eind;
      if (Math.abs(verschil) > 0.01) {
        items.push(meld(jaar, {
          label: `Verschil ${fmt(verschil)} over ${jaar}`,
          sub: `berekend ${fmt(begin + mutaties)} tegenover ${fmt(MAAND_SALDOS[laatste].eind)} volgens het afschrift`,
          ga: 'pagina:bank'
        }));
      }
    }
  }
  uit.push(check('banksaldo', 'Aansluiting',
    'Banksaldo sluit aan op de afschriften',
    () => 'Banksaldo sluit niet aan op de afschriften', 'fout',
    items,
    'Het saldo dat volgt uit je boekingen wordt vergeleken met het saldo op je afschrift. Loopt dat uiteen, dan mist er een mutatie of staat er een dubbel.',
    jaar === 'all' || jaar === '2026'
      ? `Berekend saldo van je bankrekening: ${fmt(eindHuidig)}. Kies een afgesloten jaar om te vergelijken met het afschrift.`
      : null));

  return uit;
}

function controlesVoorraad() {
  const uit = [];
  const artikelen = state.COVERS;

  uit.push(check('vrd-negatief', 'Voorraad',
    'Geen negatieve voorraad',
    n => `${enkelvoud(n, 'product', 'producten')} met negatieve voorraad`, 'fout',
    artikelen.filter(c => Number(c.voorraad) < 0)
      .map(c => meld(c.id, { label: c.artikel, sub: `voorraad ${c.voorraad}`, ga: `artikel:${c.id}` })),
    'Een negatieve voorraad betekent dat er meer verkocht is dan ingekocht, of dat een mutatie ontbreekt.'));

  uit.push(check('vrd-kostprijs', 'Voorraad',
    'Alle artikelen hebben een kostprijs',
    n => `${enkelvoud(n, 'artikel', 'artikelen')} zonder kostprijs`, 'waarschuwing',
    artikelen.filter(c => c.inkoopprijs == null || c.inkoopprijs === '')
      .map(c => meld(c.id, { label: c.artikel, sub: 'geen inkoopprijs ingevuld', ga: `artikel:${c.id}` })),
    'Zonder inkoopprijs kan de voorraadwaarde niet worden berekend, en die heb je nodig voor je balans en je aangifte.'));

  uit.push(check('vrd-groep', 'Voorraad',
    'Alle artikelen zitten in een productgroep',
    n => `${enkelvoud(n, 'artikel', 'artikelen')} zonder geldige productgroep`, 'fout',
    artikelen.filter(c => !c.categorie || !state.GROEPEN.some(g => g.id === c.categorie))
      .map(c => meld(c.id, { label: c.artikel, sub: `groep: ${c.categorie || 'leeg'}`, ga: `artikel:${c.id}` })),
    'Artikelen zonder geldige groep vallen buiten elk tabblad behalve Overzicht.'));

  const namen = new Map();
  const dubbel = [];
  artikelen.forEach(c => {
    const sleutel = String(c.artikel || '').trim().toLowerCase();
    if (!sleutel) return;
    if (namen.has(sleutel)) dubbel.push(c); else namen.set(sleutel, c);
  });
  uit.push(check('vrd-dubbele-naam', 'Voorraad',
    'Geen dubbele artikelnamen',
    n => `${enkelvoud(n, 'artikel', 'artikelen')} met een dubbele naam`, 'waarschuwing',
    dubbel.map(c => meld(c.id, { label: c.artikel, sub: 'komt meer dan één keer voor', ga: `artikel:${c.id}` })),
    'Twee regels met dezelfde naam splitsen je voorraad en zorgen dat een import de verkeerde regel bijwerkt.'));

  uit.push(check('vrd-telling', 'Voorraad',
    'Ingekocht min verkocht komt uit op de voorraad',
    n => `${enkelvoud(n, 'artikel', 'artikelen')} waarbij ingekocht min verkocht niet klopt`, 'waarschuwing',
    artikelen.filter(c => {
      const ink = Number(c.inkoop) || 0, vk = Number(c.verkoop) || 0;
      return (ink > 0 || vk > 0) && ink - vk !== Number(c.voorraad);
    }).map(c => meld(c.id, {
      label: c.artikel,
      sub: `${c.inkoop || 0} ingekocht − ${c.verkoop || 0} verkocht = ${(Number(c.inkoop) || 0) - (Number(c.verkoop) || 0)}, maar voorraad staat op ${c.voorraad}`,
      ga: `artikel:${c.id}`
    })),
    'Klopt dit niet, dan is er iets verkocht of ingekocht zonder dat de voorraad is bijgewerkt. Een correctie na een telling is een geldige reden voor een verschil.'));

  return uit;
}

function controlesHnvi() {
  const uit = [];
  const loten = state.HNVI_LOTS;
  const naam = l => l.omschr || 'Lot zonder omschrijving';

  uit.push(check('hnvi-inkoop', 'HNVI',
    'Alle loten hebben een inkoopbedrag',
    n => `${enkelvoud(n, 'lot', 'loten')} zonder inkoopbedrag`, 'waarschuwing',
    loten.filter(l => !(Number(l.inkoop) > 0))
      .map(l => meld(l.id, { label: naam(l), sub: `inkoop: ${fmt(l.inkoop || 0)}`, ga: `lot:${l.id}` })),
    'Zonder inkoopbedrag telt een lot niet mee in de voorraadwaarde en kan de marge niet worden berekend.'));

  uit.push(check('hnvi-verkoopbedrag', 'HNVI',
    'Verkochte loten hebben een verkoopbedrag',
    n => `${enkelvoud(n, 'verkocht lot', 'verkochte loten')} zonder verkoopbedrag`, 'fout',
    loten.filter(l => l.status === 'verkocht' && !(Number(l.verkoop) > 0))
      .map(l => meld(l.id, { label: naam(l), sub: 'staat op verkocht maar zonder bedrag', ga: `lot:${l.id}` })),
    'Een verkocht lot zonder bedrag verlaagt je omzet en vertekent de marge.'));

  uit.push(check('hnvi-voorraad-verkoop', 'HNVI',
    'Loten in voorraad hebben nog geen verkoopbedrag',
    n => `${enkelvoud(n, 'lot', 'loten')} in voorraad met een verkoopbedrag`, 'waarschuwing',
    loten.filter(l => l.status !== 'verkocht' && Number(l.verkoop) > 0)
      .map(l => meld(l.id, { label: naam(l), sub: `staat op voorraad maar heeft ${fmt(l.verkoop)} verkoop`, ga: `lot:${l.id}` })),
    'Waarschijnlijk is het lot wel verkocht maar niet als verkocht gemarkeerd.'));

  uit.push(check('hnvi-datum', 'HNVI',
    'Alle loten hebben een datum',
    n => `${enkelvoud(n, 'lot', 'loten')} zonder geldige datum`, 'fout',
    loten.filter(l => !/^\d{4}-\d{2}-\d{2}$/.test(l.datum || ''))
      .map(l => meld(l.id, { label: naam(l), sub: `datum: ${l.datum || 'leeg'}`, ga: `lot:${l.id}` })),
    'Zonder datum valt een lot buiten de jaaroverzichten.'));

  return uit;
}

/** Voert alle controles uit voor de gekozen periode. */
export function draaiControles() {
  const { tx, jaar } = bepaalBron();
  return [
    ...controlesBoekingen(tx),
    ...controlesRichting(tx),
    ...controlesPrive(tx),
    ...controlesAansluiting(tx, jaar),
    ...controlesVoorraad(),
    ...controlesHnvi()
  ];
}

// -------------------------------------------------------------------- render

const ICOON = {
  ok: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  waarschuwing: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  fout: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>'
};

const BADGE = { waarschuwing: 'badge-amber', fout: 'badge-red' };

function renderRegel(c, index) {
  const aantal = c.items.length;
  return `
    <div class="ctrl-regel ctrl-${c.ernst}">
      <button class="ctrl-kop" ${aantal ? `onclick="klapControleUit(${index})" aria-expanded="false" aria-controls="ctrl-detail-${index}"` : 'disabled'}>
        <span class="ctrl-icoon">${ICOON[c.ernst]}</span>
        <span class="ctrl-titel">${esc(c.titel)}</span>
        ${aantal
          ? `<span class="badge ${BADGE[c.ernst]}">${c.ernst === 'fout' ? 'fout' : 'let op'}</span>
             <span class="ctrl-pijl" aria-hidden="true">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
             </span>`
          : `<span class="ctrl-goed">in orde</span>`}
      </button>
      <div class="ctrl-detail" id="ctrl-detail-${index}" hidden>
        <p class="ctrl-uitleg">${esc(c.uitleg)}</p>
        ${aantal ? `<div class="ctrl-controle-acties">
          <button class="btn btn-sm btn-ghost" onclick="zetControleUitVanaf(${index})">Deze controle niet meer tonen</button>
          ${c.verborgen ? `<span class="muted" style="font-size:11px">${enkelvoud(c.verborgen, 'melding', 'meldingen')} verborgen</span>` : ''}
        </div>` : ''}
        ${aantal
          ? `<div class="ctrl-items" id="ctrl-items-${index}">${c.items.slice(0, 15).map(i => regelItem(i, index)).join('')}</div>
             ${aantal > 15
               ? `<button class="btn btn-sm" style="margin-top:8px" onclick="toonAlleControleRegels(${index})" id="ctrl-meer-${index}">Toon alle ${aantal} regels</button>`
               : ''}`
          : ''}
      </div>
    </div>`;
}

function regelItem(i, index) {
  const herstelbaar = /^(tx|artikel|lot):/.test(i.ga);
  return `<div class="ctrl-item">
      <button class="ctrl-item-main" data-ga="${esc(i.ga)}">
        <span class="ctrl-item-label">${esc(i.label)}</span>
        <span class="ctrl-item-sub">${esc(i.sub)}</span>
        <span class="ctrl-item-ga">${herstelbaar ? 'Openen om te herstellen →' : 'Bekijken →'}</span>
      </button>
      <div class="ctrl-item-acties">
        <button class="btn btn-sm btn-ghost" onclick="verbergControleMelding(${index}, '${esc(i.sleutel)}', 'opgelost')" title="Ik heb dit opgelost">Opgelost</button>
        <button class="btn btn-sm btn-ghost" onclick="verbergControleMelding(${index}, '${esc(i.sleutel)}', 'negeren')" title="Verbergen zolang de gegevens niet wijzigen">Negeren</button>
      </div>
    </div>`;
}

/** Klapt de resterende regels van een controle uit. */
export function toonAlleControleRegels(index) {
  const c = laatsteResultaten[index];
  if (!c) return;
  document.getElementById(`ctrl-items-${index}`).innerHTML = c.items.map(i => regelItem(i, index)).join('');
  document.getElementById(`ctrl-meer-${index}`)?.remove();
}

let laatsteResultaten = [];

export function klapControleUit(index) {
  const detail = el(`ctrl-detail-${index}`);
  if (!detail) return;
  const open = !detail.hidden;
  detail.hidden = open;
  detail.previousElementSibling.setAttribute('aria-expanded', String(!open));
  detail.parentElement.classList.toggle('is-open', !open);
}

/** Verbergt één melding en tekent de pagina opnieuw. */
export function verbergControleMelding(index, sleutel, reden) {
  const c = laatsteResultaten[index];
  if (!c) return;
  const item = c.items.find(i => i.sleutel === sleutel);
  if (!item) return;
  verbergMelding(c.id, sleutel, {
    vinger: item.vinger, label: item.label, controleTitel: c.titelOk, reden
  });
  renderControle();
}

/** Zet een hele controle uit, ook voor toekomstige gevallen. */
export function zetControleUitVanaf(index) {
  const c = laatsteResultaten[index];
  if (!c) return;
  if (!window.confirm(`"${c.titelOk}" niet meer tonen? Ook nieuwe gevallen blijven dan verborgen. Je kunt dit onderaan de pagina terugdraaien.`)) return;
  zetControleUit(c.id, c.titelOk);
  renderControle();
}

export function herstelControleMelding(sleutel) { herstelMelding(sleutel); renderControle(); }
export function herstelControleReeks(id) { herstelControle(id); renderControle(); }
export function herstelAlleMeldingen() {
  if (!window.confirm('Alle verborgen meldingen weer tonen?')) return;
  herstelAlles();
  renderControle();
}

function renderVerborgen() {
  const { meldingen, controles } = verborgenOverzicht();
  const totaal = meldingen.length + controles.length;
  const vak = el('controle-verborgen');
  if (!totaal) {
    vak.innerHTML = `<div class="section-head"><div class="eyebrow">Genegeerde meldingen</div></div>
      <div class="card"><p class="ctrl-uitleg" style="margin:0">Je hebt nog niets weggeklikt. Meldingen die je negeert of als opgelost markeert, verschijnen hier zodat je ze altijd terug kunt halen.</p></div>`;
    return;
  }
  vak.innerHTML = `
    <div class="section-head">
      <div class="eyebrow">Genegeerde meldingen</div>
      <button class="btn btn-sm" onclick="herstelAlleMeldingen()">Alles herstellen</button>
    </div>
    <div class="card card-flush">
      ${controles.map(c => `
        <div class="ctrl-item" style="border-radius:0;border:none;border-bottom:1px solid var(--border-default);background:none">
          <span class="ctrl-item-main" style="cursor:default">
            <span class="ctrl-item-label">${esc(c.controleTitel)}</span>
            <span class="ctrl-item-sub">Hele controle uitgezet op ${esc(c.wanneer)}</span>
          </span>
          <div class="ctrl-item-acties">
            <button class="btn btn-sm" onclick="herstelControleReeks('${esc(c.id)}')">Weer aanzetten</button>
          </div>
        </div>`).join('')}
      ${meldingen.map(m => `
        <div class="ctrl-item" style="border-radius:0;border:none;border-bottom:1px solid var(--border-default);background:none">
          <span class="ctrl-item-main" style="cursor:default">
            <span class="ctrl-item-label">${esc(m.label)}</span>
            <span class="ctrl-item-sub">${esc(REDEN_LABEL[m.reden] || m.reden)} op ${esc(m.wanneer)} · ${esc(m.controleTitel)}</span>
          </span>
          <div class="ctrl-item-acties">
            <button class="btn btn-sm" onclick="herstelControleMelding('${esc(m.sleutel)}')">Weer tonen</button>
          </div>
        </div>`).join('')}
    </div>`;
}

export function renderControle() {
  laatsteResultaten = draaiControles();

  const totaal = laatsteResultaten.length;
  const geslaagd = laatsteResultaten.filter(c => c.ok).length;
  const fouten = laatsteResultaten.filter(c => c.ernst === 'fout');
  const waarschuwingen = laatsteResultaten.filter(c => c.ernst === 'waarschuwing');
  const foutRegels = fouten.reduce((s, c) => s + c.items.length, 0);
  const letOpRegels = waarschuwingen.reduce((s, c) => s + c.items.length, 0);

  el('controle-kpi').innerHTML = `
    <div class="kpi">
      <div class="kpi-lbl">Controles uitgevoerd</div>
      <div class="kpi-val">${totaal}</div>
      <div class="kpi-sub">over boekingen, voorraad en HNVI</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Geslaagd</div>
      <div class="kpi-val pos">${geslaagd}</div>
      <div class="kpi-sub">niets gevonden om na te kijken</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Fouten</div>
      <div class="kpi-val ${fouten.length ? 'neg' : 'pos'}">${fouten.length}</div>
      <div class="kpi-sub">${fouten.length ? `${enkelvoud(foutRegels, 'regel', 'regels')} om te herstellen` : 'niets mis'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">Aandachtspunten</div>
      <div class="kpi-val" style="color:${waarschuwingen.length ? 'var(--semantic-warning-bright)' : 'var(--semantic-success-bright)'}">${waarschuwingen.length}</div>
      <div class="kpi-sub">${waarschuwingen.length ? `${enkelvoud(letOpRegels, 'regel', 'regels')} om te bekijken` : 'niets te bekijken'}${
        aantalVerborgen() ? ` · ${aantalVerborgen()} verborgen` : ''}</div>
    </div>`;

  // Aandachtspunten eerst; binnen elke groep de volgorde van de controles zelf.
  const volgorde = { fout: 0, waarschuwing: 1, ok: 2 };
  const gesorteerd = [...laatsteResultaten].sort((a, b) => volgorde[a.ernst] - volgorde[b.ernst]);
  const secties = [...new Set(gesorteerd.map(c => c.sectie))];

  el('controle-lijst').innerHTML = secties.map(sectie => {
    const inSectie = gesorteerd.filter(c => c.sectie === sectie);
    const open = inSectie.filter(c => !c.ok).length;
    const heeftFout = inSectie.some(c => c.ernst === 'fout');
    return `
      <div class="section-head">
        <div class="eyebrow">${esc(sectie)}</div>
        <div style="font-size:11.5px;color:${heeftFout ? 'var(--semantic-danger-bright)' : open ? 'var(--semantic-warning-bright)' : 'var(--text-secondary)'}">${open ? `${enkelvoud(open, 'punt', 'punten')} open` : 'in orde'}</div>
      </div>
      <div class="card card-flush">
        ${inSectie.map(c => renderRegel(c, laatsteResultaten.indexOf(c))).join('')}
      </div>`;
  }).join('');

  renderVerborgen();

  const notitie = laatsteResultaten.find(c => c.geenProbleemTekst && c.ok);
  el('controle-notitie').innerHTML = notitie
    ? `<div class="alert alert-info">${esc(notitie.geenProbleemTekst)}</div>`
    : '';
}
