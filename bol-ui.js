// bol-ui.js — pagina Bol.com: bestellingen ophalen, omzet en commissie per periode,
// verkocht per artikel, en een vergelijking met wat Bol op je bankrekening heeft gestort.
// Alleen kijken: er wordt niets geboekt en de voorraad verandert niet.

import { esc, fmt, ddmm } from './helpers.js?v=20261110m';
import { bolArtikelenHtml } from './bolartikelen.js?v=20261110m';
import { lopendJaar } from './jaren.js?v=20261110m';
import { state } from './storage.js?v=20261110m';
import { leesBolFacturen, perMaand, aantalBolFacturen } from './bol-facturen.js?v=20261110m';
import { haalFacturenBijBol, leesFacturenOverzicht, leesBestellingen, leesRetouren, retourSamenvatting, haalBijBol, samenvatting, bolUitbetalingen, standaardPeriodes, leesBolAccounts } from './bol.js?v=20261110m';

const el = id => document.getElementById(id);
const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
let bestellingen = null;      // null = nog niet geladen
let retouren = null;          // null = niet beschikbaar (tabel ontbreekt of nog niet geladen)
let periode = 'maand';        // 'maand' (deze) | 'JJJJ-MM' | 'jaar:JJJJ' | 'alles'
let ophaal = 'laatste31';
let gevolgdJaar = null;       // laatst gezien jaar uit de jaarkeuze bovenin; verandert die, dan volgt deze pagina
let melding = '', bezig = false, laadFout = false;
let accounts = null;          // [{ nummer, naam }] uit Supabase, of null
let accountFilter = 'alle';   // weergave: 'alle' of een accountnummer
let ophaalAccount = 'alle';   // welk account je ophaalt

function bereik() {
  const nu = new Date().toISOString().slice(0, 10);
  if (periode === 'alles') return ['0000-01-01', '9999-12-31', 'Alle bestellingen'];
  if (periode === 'maand') return maandBereik(nu.slice(0, 7));
  if (/^kw:\d{4}-[1-4]$/.test(periode)) {
    const j = periode.slice(3, 7), k = Number(periode.slice(8)), m1 = (k - 1) * 3 + 1, m3 = m1 + 2;
    const l = new Date(Date.UTC(Number(j), m3, 0)).getUTCDate();
    return [`${j}-${String(m1).padStart(2, '0')}-01`, `${j}-${String(m3).padStart(2, '0')}-${l}`, `${k}e kwartaal ${j}`];
  }
  if (/^jaar:\d{4}$/.test(periode)) { const j = periode.slice(5); return [`${j}-01-01`, `${j}-12-31`, `Heel ${j}`]; }
  return maandBereik(periode);
}
function maandBereik(jm) {
  const [j, m] = jm.split('-').map(Number);
  const laatste = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return [`${jm}-01`, `${jm}-${String(laatste).padStart(2, '0')}`, `${MAAND[m - 1]} ${j}`];
}

export async function renderBol() {
  const doel = el('bol-inhoud');
  if (!doel) return;
  // De jaarkeuze bovenin de app bepaalt ook de periode hier: kies je 2025, dan zie je Heel 2025.
  const hj = String(state.huidigJaar || lopendJaar());
  if (gevolgdJaar !== null && gevolgdJaar !== hj) periode = 'jaar:' + hj;
  gevolgdJaar = hj;
  if (bestellingen === null && !laadFout) {
    doel.innerHTML = '<div class="card"><p class="muted">Laden…</p></div>';
    try { bestellingen = await leesBestellingen(); retouren = await leesRetouren(); }
    catch { laadFout = true; }
    leesBolAccounts().then(a => { if (a && JSON.stringify(a) !== JSON.stringify(accounts)) { accounts = a; teken(); } });
  }
  if (laadFout) {
    doel.innerHTML = `<div class="card"><p>De Bol-bestellingen konden niet gelezen worden. Is de tabel <code>bol_bestellingen</code> al aangemaakt in Supabase?</p>
      <p><button class="btn" onclick="laadBolOpnieuw()">Opnieuw proberen</button></p></div>`;
    return;
  }
  teken();
  // Facturen pas laden als de pagina opent (dan ben je ingelogd); opnieuw proberen zolang er nog niets is.
  if (!factuurLijst || !factuurLijst.length) { leesBolFacturen().then(l => { if (l && l.length) { factuurLijst = l; teken(); } }); aantalBolFacturen().then(n => { factuurDb = n; teken(); }); }
}

/** Accounts voor de keuzelijsten: uit Supabase als bekend, anders wat er in de opgeslagen bestellingen voorkomt. */
function accountLijst() {
  if (accounts && accounts.length) return accounts;
  const nrs = [...new Set((bestellingen || []).map(b => b.account || '1'))].sort();
  return nrs.map(n => ({ nummer: n, naam: `Bol-account ${n}` }));
}
const accountNaam = n => (accountLijst().find(a => a.nummer === String(n)) || { naam: `Bol-account ${n}` }).naam;

function maandenInData() {
  const s = new Set((bestellingen || []).map(b => (b.datum || '').slice(0, 7)).filter(Boolean));
  return [...s].sort().reverse();
}

function teken() {
  const doel = el('bol-inhoud');
  if (!doel) return;
  const [van, tot, label] = bereik();
  const accs = accountLijst();
  const meer = accs.length > 1;
  const lijst = (bestellingen || []).filter(b => b.datum && b.datum >= van && b.datum <= tot && (accountFilter === 'alle' || String(b.account || '1') === accountFilter));
  const s = samenvatting(lijst);
  // Retouren tellen mee op de datum waarop ze zijn aangemeld (dan gaat het geld terug naar de klant).
  const retourLijst = (retouren || []).filter(r => r.datum && r.datum >= van && r.datum <= tot && (accountFilter === 'alle' || String(r.account || '1') === accountFilter));
  const rs = retourSamenvatting(retourLijst, bestellingen);
  // Bol geeft maar ~3 maanden terug. Stortingen van vóór de eerste opgehaalde bestelling horen bij bestellingen
  // die we niet hebben; die tellen we dus niet mee in de vergelijking.
  const eersteBestelling = (bestellingen || []).reduce((m, b) => (b.datum && (!m || b.datum < m) ? b.datum : m), '');
  const bankVan = eersteBestelling && eersteBestelling > van ? eersteBestelling : van;
  const bankBeperkt = bankVan > van;
  const bank = bolUitbetalingen(bankVan, tot);
  // Voor de vergelijking tellen alleen retouren vanaf dezelfde startdatum (eerdere horen bij bestellingen die we niet hebben).
  const rsV = retourSamenvatting(retourLijst.filter(r => r.datum >= bankVan), bestellingen);
  const nettoNaRetour = r2(s.netto - rsV.bedrag + rsV.commissie);
  const maanden = maandenInData();
  const bankRegels = bolUitbetalingen('0000-01-01', '9999-12-31').regels;
  const bankJaren = [...new Set(bankRegels.map(t => String(t.datum).slice(0, 4)))];
  const jaren = [...new Set([...maanden.map(m => m.slice(0, 4)), ...bankJaren, String(lopendJaar())])].sort().reverse();
  const kwartalen = [...new Set(maanden.map(m => `kw:${m.slice(0, 4)}-${Math.ceil(Number(m.slice(5)) / 3)}`))];
  const huidig = lopendJaar();
  const opties = [
    ['maand', 'Deze maand'],
    ...maanden.map(m => [m, `${MAAND[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`]),
    ...kwartalen.map(k => [k, `${k.slice(8)}e kwartaal ${k.slice(3, 7)}`]),
    ...jaren.map(j => [`jaar:${j}`, `Heel ${j}`]),
    ['alles', 'Alle jaren samen']
  ].filter(([w], i, a) => a.findIndex(x => x[0] === w) === i);

  const geenData = !bestellingen.length;
  const eerste = (bestellingen || []).reduce((m, b) => (b.datum && (!m || b.datum < m) ? b.datum : m), '');
  const kop = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:var(--spacing-4)">
      <select onchange="zetBolPeriode(this.value)" aria-label="Periode" style="font-size:14px">${opties.map(([w, l]) => `<option value="${esc(w)}"${w === periode ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      ${meer ? `<select onchange="zetBolAccount(this.value)" aria-label="Account" style="font-size:14px"><option value="alle">Alle accounts</option>${accs.map(a => `<option value="${esc(a.nummer)}"${a.nummer === accountFilter ? ' selected' : ''}>${esc(a.naam)}</option>`).join('')}</select>` : ''}
      <span style="flex:1"></span>
      ${meer ? `<select onchange="zetBolOphaalAccount(this.value)" aria-label="Welk account ophalen" style="font-size:14px"><option value="alle">Ophalen: alle accounts</option>${accs.map(a => `<option value="${esc(a.nummer)}"${a.nummer === ophaalAccount ? ' selected' : ''}>Ophalen: ${esc(a.naam)}</option>`).join('')}</select>` : ''}
      <select onchange="zetBolOphalen(this.value)" aria-label="Wat ophalen" style="font-size:14px">
        <option value="laatste7"${ophaal === 'laatste7' ? ' selected' : ''}>Laatste 7 dagen</option>
        <option value="laatste31"${ophaal === 'laatste31' ? ' selected' : ''}>Laatste 31 dagen</option>
        <option value="laatste90"${ophaal === 'laatste90' ? ' selected' : ''}>Laatste 3 maanden</option></select>
      <button class="btn btn-primary" onclick="haalBolBestellingenOp()"${bezig ? ' disabled' : ''}>${bezig ? 'Bezig…' : 'Ophalen bij Bol.com'}</button>
    </div>
    ${melding ? `<div class="card" style="margin-bottom:var(--spacing-4)"><div style="font-size:14px;white-space:pre-line">${esc(melding)}</div></div>` : ''}
    <details class="card" style="padding:14px;margin-bottom:var(--spacing-4)"${factuurMelding ? ' open' : ''}>
      <summary style="font-weight:600;cursor:pointer">Oudere periode ophalen via Bol-facturen (tot 2 jaar terug)</summary>
      <p class="muted" style="font-size:13px;margin:8px 0">Bestellingen geeft Bol maar ongeveer 3 maanden terug, facturen met specificatie wel tot 2 jaar. Hiermee haal je ze binnen en bewaar je ze.${factuurLijst && factuurLijst.length ? ` Geladen op deze pagina: ${factuurLijst.length} facturen${factuurDb != null ? ` (in de database: ${factuurDb})` : ''}, ${esc(factuurBereik())}.` : ''}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label style="font-size:13px">Van <input type="date" id="bol-fac-van" value="${esc(factuurVan)}"></label>
        <label style="font-size:13px">Tot <input type="date" id="bol-fac-tot" value="${esc(factuurTot)}"></label>
        <button class="btn" onclick="haalBolFacturenOp()"${bezig ? ' disabled' : ''}>${bezig ? 'Bezig…' : 'Facturen ophalen'}</button>
      </div>
      ${factuurMelding ? `<div style="font-size:14px;white-space:pre-line;margin-top:10px">${esc(factuurMelding)}</div>` : ''}
    </details>
    ${factuurTabel()}`;

  if (geenData) {
    doel.innerHTML = kop + `<div class="card"><p>Er zijn nog geen Bol-bestellingen opgeslagen. Klik op <b>Ophalen bij Bol.com</b>.</p>
      <p class="muted" style="font-size:13px">Voor het eerst: maak in Bol Partner Platform (Instellingen → API-instellingen) een Client ID en Secret en zet die in Supabase bij Edge Functions → Secrets als <code>BOL_CLIENT_ID</code> en <code>BOL_CLIENT_SECRET</code>.</p></div>`;
    return;
  }

  const verschil = r2(bank.totaal - nettoNaRetour);
  const periodeVoorData = !!eersteBestelling && tot < eersteBestelling;   // gekozen periode ligt helemaal vóór de opgeslagen bestellingen
  const jaarRijen = (() => {
    const alle = [...new Set([...bankJaren, ...(bestellingen || []).map(b => String(b.datum || '').slice(0, 4)).filter(Boolean)])].sort().reverse();
    let tb = 0, tn = 0, ts = 0, tbn = 0;
    const rijen = alle.map(j => {
      const bj = (bestellingen || []).filter(b => String(b.datum || '').startsWith(j) && (accountFilter === 'alle' || String(b.account || '1') === accountFilter));
      const sj = samenvatting(bj);
      const ub = bolUitbetalingen(`${j}-01-01`, `${j}-12-31`);
      const heeft = bj.length > 0;
      const gedeeltelijk = heeft && eersteBestelling > `${j}-01-01`;
      tb += ub.totaal; tbn += ub.aantal; if (heeft) { tn += sj.netto; ts += sj.stuks; }
      const actief = periode === `jaar:${j}`;
      return `<tr${actief ? ' style="font-weight:600"' : ''}><td><a href="#" onclick="zetBolPeriode('jaar:${j}');return false">${j}</a></td>
        <td style="text-align:right">${heeft ? sj.stuks : '—'}</td><td style="text-align:right">${heeft ? fmt(sj.netto) : '—'}${gedeeltelijk ? `<div class="muted" style="font-size:12px">vanaf ${esc(ddmm(eersteBestelling))}</div>` : ''}</td>
        <td style="text-align:right">${ub.aantal}</td><td style="text-align:right">${fmt(ub.totaal)}</td></tr>`;
    }).join('');
    return `${rijen}<tr style="border-top:1px solid var(--border-default)"><td><b>Totaal</b></td><td style="text-align:right"><b>${ts}</b></td><td style="text-align:right"><b>${fmt(r2(tn))}</b></td><td style="text-align:right"><b>${tbn}</b></td><td style="text-align:right"><b>${fmt(r2(tb))}</b></td></tr>`;
  })();
  const jarenKaart = `<div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div style="padding:14px 16px 4px"><div class="section-titel">Per jaar</div></div>
      <div class="table-wrap"><table class="tbl-compact"><thead><tr><th>Jaar</th><th style="text-align:right">Stuks (Bol)</th><th style="text-align:right">Netto volgens Bol</th><th style="text-align:right">Stortingen</th><th style="text-align:right">Door Bol gestort op de bank</th></tr></thead><tbody>${jaarRijen}</tbody></table></div>
      <p class="muted" style="font-size:13px;padding:8px 16px 14px;margin:0">Bol geeft zelf maar ongeveer 3 maanden aan bestellingen terug, daarom staan de bestellingen pas vanaf ${esc(eerste ? ddmm(eerste) + '-' + eerste.slice(0, 4) : '—')}. Wat Bol aan je heeft overgemaakt zie je wel over alle jaren, want dat staat in je bank. Voor oudere jaren zijn dat dus de betrouwbare cijfers.</p></div>`;
  const vergelijk = periodeVoorData ? `<p class="muted" style="font-size:13px;margin-bottom:var(--spacing-4)">Voor ${esc(label)} zijn geen Bol-bestellingen opgeslagen. In het overzicht per jaar hierboven staat wat Bol in die periode aan je heeft overgemaakt: ${fmt(bolUitbetalingen(van, tot).totaal)} in ${bolUitbetalingen(van, tot).aantal} stortingen.</p>` : accountFilter !== 'alle' ? `<p class="muted" style="font-size:13px;margin-bottom:var(--spacing-4)">De vergelijking met de bank staat alleen bij "Alle accounts", omdat de stortingen op de bank niet per Bol-account te scheiden zijn.</p>` : `<div class="card" style="margin-bottom:var(--spacing-4)">
      <div class="section-titel" style="margin-bottom:6px">Vergelijking met je bank (${esc(label)})</div>
      ${bankBeperkt ? `<p class="muted" style="font-size:13px;margin:0 0 6px">Bol geeft bestellingen maar ongeveer 3 maanden terug. Daarom tellen alleen de stortingen vanaf ${esc(ddmm ? ddmm(bankVan) : bankVan)} mee; eerdere stortingen horen bij bestellingen die hier niet in staan.</p>` : ''}
      <table class="tbl-compact" style="max-width:520px"><tbody>
        <tr><td>Verkocht volgens Bol (netto na commissie)</td><td style="text-align:right">${fmt(s.netto)}</td></tr>
        ${retouren ? `<tr><td>Retouren (${rsV.stuks} ${rsV.stuks === 1 ? 'stuk' : 'stuks'} terugbetaald, min teruggekregen commissie)</td><td style="text-align:right">${fmt(-(rsV.bedrag - rsV.commissie))}</td></tr>
        <tr><td>Netto na retouren</td><td style="text-align:right">${fmt(nettoNaRetour)}</td></tr>` : ''}
        <tr><td>Door Bol gestort op de bank (${bank.aantal} ${bank.aantal === 1 ? 'storting' : 'stortingen'})</td><td style="text-align:right">${fmt(bank.totaal)}</td></tr>
        <tr><td><b>Verschil</b></td><td style="text-align:right"><b>${fmt(verschil)}</b></td></tr></tbody></table>
      <p class="muted" style="font-size:13px;margin-top:6px">Een verschil is normaal: Bol betaalt uit na de levering, trekt ook verzendkosten af, en een storting kan in een andere maand vallen dan de verkoop. De eerste weken na het begin van de gegevens liggen de stortingen hoger, omdat ze nog bij oudere bestellingen horen. Over een langere periode horen de twee dicht bij elkaar te liggen.</p></div>`;

  const orders = lijst.map(b => {
    const regels = (b.items || []).filter(i => (i.aantal - (i.geannuleerd || 0)) > 0 || i.geannuleerd);
    const effect = (b.items || []).reduce((t, i) => t + Math.max(0, i.aantal - (i.geannuleerd || 0)) * (i.prijs || 0), 0);
    const comm = (b.items || []).reduce((t, i) => t + (Math.max(0, i.aantal - (i.geannuleerd || 0)) ? (i.commissie || 0) * (Math.max(0, i.aantal - (i.geannuleerd || 0)) / Math.max(1, i.aantal)) : 0), 0);
    const alleGeannuleerd = !regels.some(i => (i.aantal - (i.geannuleerd || 0)) > 0);
    return `<tr${alleGeannuleerd ? ' style="opacity:.5"' : ''}><td>${esc(ddmm(b.datum))}</td><td>${esc(b.order_id)}${meer ? `<div class="muted" style="font-size:12px">${esc(accountNaam(b.account || '1'))}</div>` : ''}</td>
      <td>${(b.items || []).map(i => `${esc(i.titel || i.ean)} <span class="muted">×${i.aantal - (i.geannuleerd || 0)}${i.geannuleerd ? ' (geannuleerd: ' + i.geannuleerd + ')' : ''}</span>`).join('<br>')}</td>
      <td style="text-align:right">${fmt(effect)}</td><td style="text-align:right">${fmt(comm)}</td></tr>`;
  }).join('');

  const artikelen = s.perArtikel.map(a => `<tr><td>${esc(a.titel)}</td><td style="text-align:right">${a.stuks}</td>
      <td style="text-align:right">${fmt(a.omzet)}</td><td style="text-align:right">${fmt(a.commissie)}</td></tr>`).join('');

  doel.innerHTML = kop + `
    <div class="kpi-grid" style="margin-bottom:var(--spacing-4)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Bestellingen</div><div class="kpi-val">${s.orders}</div><div class="kpi-sub">${esc(label)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Stuks verkocht</div><div class="kpi-val">${s.stuks}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Omzet (klantprijs)</div><div class="kpi-val">${fmt(s.omzet)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Commissie van Bol</div><div class="kpi-val">${fmt(s.commissie)}</div><div class="kpi-sub">netto ${fmt(s.netto)}</div></div>
      ${retouren ? `<div class="kpi kpi--secondary"><div class="kpi-lbl">Retouren</div><div class="kpi-val">${rs.stuks}</div><div class="kpi-sub">${fmt(rs.bedrag)} terugbetaald${rs.inBehandeling ? ` · ${rs.inBehandeling} nog in behandeling` : ''}${rs.onbekend ? ` · van ${rs.onbekend} stuks is het bedrag onbekend (bestelling van vóór de opgeslagen periode)` : ''}</div></div>` : ''}
    </div>
    ${retouren === null ? `<p class="muted" style="font-size:13px;margin-bottom:var(--spacing-4)">Retouren staan hier nog niet in: de tabel <code>bol_retouren</code> bestaat nog niet in Supabase.</p>` : ''}
    ${jarenKaart}
    ${vergelijk}
    <div class="section-head"><div class="section-titel">Verkocht per artikel</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Artikel</th><th style="text-align:right">Stuks</th><th style="text-align:right">Omzet</th><th style="text-align:right">Commissie</th></tr></thead>
      <tbody>${artikelen || '<tr><td colspan="4" class="muted">Geen verkopen in deze periode.</td></tr>'}</tbody></table></div></div>
    ${bolArtikelenHtml(bestellingen)}
    ${retouren && retourLijst.length ? `<div class="section-head"><div class="section-titel">Retouren (${retourLijst.length})</div></div>
    <div class="card card-flush" style="margin-bottom:var(--spacing-4)"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Datum</th><th>Bestelnr</th><th>Artikel</th><th style="text-align:right">Stuks</th><th>Uitkomst</th><th style="text-align:right">Terugbetaald</th></tr></thead>
      <tbody>${rs.rijen.map(r => `<tr><td>${esc(ddmm(r.datum))}</td><td>${esc(r.order_id)}${meer ? `<div class="muted" style="font-size:12px">${esc(accountNaam(r.account || '1'))}</div>` : ''}</td>
        <td>${esc(r.titel || r.ean)}${r.reden ? `<div class="muted" style="font-size:12px">${esc(r.reden)}</div>` : ''}</td><td style="text-align:right">${r.aantal}</td>
        <td>${r.afgehandeld ? (r.geaccepteerd ? 'Geaccepteerd' : r.afgewezen ? 'Afgewezen' : 'Afgehandeld') : 'In behandeling'}</td><td style="text-align:right">${fmt(r.terug)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="section-head"><div class="section-titel">Bestellingen (${lijst.length})</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Datum</th><th>Bestelnr</th><th>Artikelen</th><th style="text-align:right">Bedrag</th><th style="text-align:right">Commissie</th></tr></thead>
      <tbody>${orders || '<tr><td colspan="5" class="muted">Geen bestellingen in deze periode.</td></tr>'}</tbody></table></div></div>
    <p class="muted" style="font-size:13px;margin-top:8px">Bol bewaart zelf maar ongeveer 3 maanden aan bestellingen; wat hier staat blijft bewaard. Eerste bestelling in deze lijst: ${esc(eerste ? ddmm(eerste) + '-' + eerste.slice(0, 4) : '—')}. Oudere bestellingen zie je in het Bol Partner Platform.</p>`;
}
const r2 = n => Math.round(n * 100) / 100;

let factuurLijst = null, factuurDb = null;
function factuurBereik() {
  const m = (factuurLijst || []).map(f => f.maand).filter(Boolean).sort();
  return m.length ? `${m[0]} t/m ${m[m.length - 1]}` : '';
}
/** Omzet, commissie en uitbetaling per maand uit de Bol-facturen, naast wat er echt op de bank binnenkwam. */
/** Facturen uit de API plus de uit het partnerplatform ingelezen maandcijfers (die van de API gaan voor). */
function alleFacturen() {
  const api = factuurLijst || [], ids = new Set(api.map(f => String(f.id)));
  const extra = Object.entries(state.BOL_MAAND || {}).filter(([id]) => !ids.has(String(id)))
    .map(([id, m]) => ({ id, account: '1', maand: m.maand, omzet: m.omzet, commissie: m.commissie, overig: m.overig, netto: Math.round((m.omzet - m.commissie - m.overig) * 100) / 100, uitbetaling: m.uitbetaling, klopt: true }));
  return [...api, ...extra];
}
function factuurTabel() {
  const rijen = perMaand(alleFacturen(), accountFilter);
  if (!rijen.length) return '';
  const metBank = rijen.map(r => { const [j, m] = r.maand.split('-'); const d1 = new Date(Date.UTC(Number(j), Number(m), 1)), d2 = new Date(Date.UTC(Number(j), Number(m) + 1, 0));   // Bol betaalt de maandfactuur rond de 4e van de volgende maand
    return { ...r, bank: bolUitbetalingen(d1.toISOString().slice(0, 10), d2.toISOString().slice(0, 10)).totaal }; });
  const t2 = metBank.reduce((t, r) => ({ omzet: t.omzet + r.omzet, commissie: t.commissie + r.commissie, overig: t.overig + r.overig, netto: t.netto + r.netto, uitbetaling: t.uitbetaling + r.uitbetaling, bank: t.bank + r.bank }), { omzet: 0, commissie: 0, overig: 0, netto: 0, uitbetaling: 0, bank: 0 });
  const onjuist = rijen.reduce((n, r) => n + r.onjuist, 0);
  return `<div class="section-head"><div class="section-titel">Per maand volgens Bol-facturen</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th>Maand</th><th style="text-align:right">Facturen</th><th style="text-align:right">Omzet</th><th style="text-align:right">Commissie</th><th style="text-align:right">Overige kosten</th><th style="text-align:right">Netto</th><th style="text-align:right">Uitbetaald (factuur)</th><th style="text-align:right">Op de bank (volgende maand)</th></tr></thead>
      <tbody>${metBank.map(r => `<tr><td>${esc(MAAND[Number(r.maand.slice(5)) - 1] || r.maand)} ${esc(r.maand.slice(0, 4))}</td><td style="text-align:right">${r.facturen}</td><td style="text-align:right">${fmt(r.omzet)}</td><td style="text-align:right">${fmt(r.commissie)}</td><td style="text-align:right">${fmt(r.overig)}</td><td style="text-align:right">${fmt(r.netto)}</td><td style="text-align:right">${fmt(r.uitbetaling)}</td><td style="text-align:right">${fmt(r.bank)}</td></tr>`).join('')}
      <tr style="font-weight:700"><td>Totaal</td><td></td><td style="text-align:right">${fmt(r2(t2.omzet))}</td><td style="text-align:right">${fmt(r2(t2.commissie))}</td><td style="text-align:right">${fmt(r2(t2.overig))}</td><td style="text-align:right">${fmt(r2(t2.netto))}</td><td style="text-align:right">${fmt(r2(t2.uitbetaling))}</td><td style="text-align:right">${fmt(r2(t2.bank))}</td></tr></tbody></table></div></div>
    <p class="muted" style="font-size:13px;margin-top:8px">Bedragen excl. btw, behalve "Uitbetaald" (volgens de factuur, incl. btw). Overige kosten zijn bijvoorbeeld verzendlabels en correcties. De maand is de einddatum van de factuurperiode. ${alleFacturen().length} facturen geladen${factuurDb != null ? ` (in de database: ${factuurDb})` : ''}.${onjuist ? ` ⚠️ Bij ${onjuist} facturen komt de som van de regels niet overeen met het factuurtotaal; die cijfers zijn dan onvolledig.` : ''}</p>`;
}
let factuurMelding = '', factuurOverzicht = null, factuurVan = '2026-01-01', factuurTot = '2026-07-24';
export async function haalBolFacturenOp() {
  if (bezig) return;
  factuurVan = document.getElementById('bol-fac-van')?.value || factuurVan;
  factuurTot = document.getElementById('bol-fac-tot')?.value || factuurTot;
  bezig = true; factuurMelding = ''; teken();
  try {
    const uit = await haalFacturenBijBol(factuurVan, factuurTot, t => { factuurMelding = t; teken(); }, ophaalAccount);
    factuurLijst = await leesBolFacturen();
    factuurDb = await aantalBolFacturen();
    factuurMelding = `✅ Klaar: ${uit.facturen} facturen met ${uit.transacties} transacties bewaard (${factuurVan} t/m ${factuurTot}).`
      + (uit.onvolledig ? '\nNiet alles paste in één keer; klik nog eens op Facturen ophalen.' : '')
      + (uit.voorbeeldKop ? `\n\nVorm van een factuur (voor controle):\n${JSON.stringify(uit.voorbeeldKop)}` : '')
      + (uit.voorbeeldSpec ? `\n\nVorm van een specificatie (voor controle):\n${JSON.stringify(uit.voorbeeldSpec).slice(0, 1800)}` : '');
  } catch (e) {
    factuurMelding = `❌ ${e.message}`;
  } finally {
    bezig = false; teken();
  }
}

export function zetBolPeriode(w) { periode = w; teken(); }
export function zetBolOphalen(w) { ophaal = w; }
export function zetBolAccount(w) { accountFilter = w; teken(); }
export function zetBolOphaalAccount(w) { ophaalAccount = w; }
export function laadBolOpnieuw() { laadFout = false; bestellingen = null; renderBol(); }

export async function haalBolBestellingenOp() {
  if (bezig) return;
  bezig = true; melding = ''; teken();
  try {
    const [van, tot] = standaardPeriodes()[ophaal];
    const uit = await haalBijBol(van, tot, t => { melding = t; teken(); }, ophaalAccount);
    bestellingen = await leesBestellingen();
    retouren = await leesRetouren();
    leesBolAccounts().then(a => { if (a) { accounts = a; teken(); } });
    melding = `✅ Klaar: ${uit.opgeslagen} bestellingen bijgewerkt (${van} t/m ${tot}).` + (uit.onvolledig ? '\nNiet alles paste in één keer; klik nog eens op Ophalen om de rest binnen te halen.' : '');
  } catch (e) {
    melding = e.geenSleutels
      ? 'De Bol-sleutels staan nog niet in Supabase.\n1) Bol Partner Platform → Instellingen → API-instellingen → Client credentials aanmaken.\n2) Supabase → Edge Functions → Secrets: BOL_CLIENT_ID en BOL_CLIENT_SECRET.'
      : `❌ ${e.message}`;
  } finally {
    bezig = false; teken();
  }
}

Object.assign(window, { haalBolFacturenOp, zetBolPeriode, zetBolOphalen, zetBolAccount, zetBolOphaalAccount, laadBolOpnieuw, haalBolBestellingenOp });
