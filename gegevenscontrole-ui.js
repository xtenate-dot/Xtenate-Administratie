// gegevenscontrole-ui.js — het scherm bij de gegevenscontrole.
//
// Toont per afwijking een melding met drie knoppen. Elke keuze gaat eerst langs
// een bevestigingsstap waarin huidige waarde, nieuwe waarde, reden en aantal
// records staan, met een knop om te annuleren.
//
// Er wordt niets weggeschreven. De keuzes staan in het geheugen van deze sessie
// en verdwijnen bij het verversen van de pagina. De uitvoerende stap bestaat
// nog niet.

import { bouwMeldingen, kiesActie, wisKeuze, keuzeVan, alleKeuzes, keuzeOverzicht, ACTIES,
  exporteerMeldingen, opslagVingerafdrukken, vergelijkVingerafdrukken }
  from './gegevenscontrole.js?v=20261023c';

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let meldingen = [];
let openBevestiging = null;   // { meldingId, actie }
let vingerBijOpening = null;

export async function openGegevenscontrole() {
  el('modal-gegevenscontrole').classList.add('open');
  el('gc-inhoud').innerHTML = '<p class="ctrl-uitleg">Bezig met controleren…</p>';
  try {
    // Vingerafdruk van de hele opslag bij het openen, zodat je later kunt zien
    // dat er tijdens dit scherm niets is weggeschreven.
    vingerBijOpening = await opslagVingerafdrukken();
    meldingen = await bouwMeldingen();
    render();
  } catch (e) {
    el('gc-inhoud').innerHTML =
      `<div class="alert alert-error">De controle liep vast: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  }
}

export function sluitGegevenscontrole() {
  el('modal-gegevenscontrole').classList.remove('open');
}

export function herlaadGegevenscontrole() { openGegevenscontrole(); }

/** Vraagt om bevestiging. Schrijft nog niets. */
export function kiesGc(meldingId, actie) {
  openBevestiging = { meldingId, actie };
  render();
}

export function annuleerGc() {
  openBevestiging = null;
  render();
}

/** Legt de keuze vast in het geheugen. Nog steeds geen opslag. */
export function bevestigGc() {
  if (!openBevestiging) return;
  const m = meldingen.find(x => x.id === openBevestiging.meldingId);
  if (m) kiesActie(m.id, openBevestiging.actie, m);
  openBevestiging = null;
  render();
}

export function maakKeuzeOngedaan(meldingId) {
  wisKeuze(meldingId);
  render();
}

const naam = { corrigeren: 'Corrigeren', verbergen: 'Verbergen', negeren: 'Negeren' };
const kleur = { corrigeren: 'pos', verbergen: '', negeren: 'muted' };

function bevestigingsblok(m, actie) {
  const uitleg = m.gevolgPerActie[actie];

  return `
    <div class="card" style="border:2px solid var(--accent-primary);margin-top:var(--spacing-2)">
      <div class="eyebrow" style="margin-bottom:var(--spacing-2)">Bevestigen — ${esc(naam[actie])}</div>
      <table class="tbl-compact" style="width:100%">
        <tbody>
          <tr><td style="width:150px" class="muted">Huidige waarde</td>
              <td>${esc(m.huidigeWaarde)}</td></tr>
          <tr><td class="muted">Nieuwe waarde</td>
              <td class="${actie === ACTIES.CORRIGEREN ? 'pos' : 'muted'}">${
                actie === ACTIES.CORRIGEREN ? esc(m.nieuweWaarde) : 'ongewijzigd — de gegevens blijven zoals ze zijn'}</td></tr>
          <tr><td class="muted">Reden</td><td>${esc(m.reden)}</td></tr>
          <tr><td class="muted">Aantal records</td>
              <td><strong>${m.aantalRecords}</strong> in <code>${esc(m.sleutel)}</code></td></tr>
          <tr><td class="muted">Wat dit precies doet</td><td>${esc(uitleg)}</td></tr>
          ${actie === ACTIES.NEGEREN ? `<tr><td class="muted">Blijft werken</td>
            <td>de gegevens blijven in elke lijst, elk totaal en elke berekening meedoen, precies als nu</td></tr>` : ''}
          <tr><td class="muted">Vingerafdruk</td>
              <td class="muted" style="font-size:11px"><code>${esc(m.vinger)}</code> — vastgelegd zodat de keuze
              later te herleiden blijft, ook als de gegevens veranderen</td></tr>
        </tbody>
      </table>
      ${m.voorbeelden && m.voorbeelden.length ? `
        <div class="table-wrap" style="margin-top:var(--spacing-3)"><table class="tbl-compact">
          <thead><tr><th>Nummer</th><th>Nu</th><th>Wordt</th><th style="text-align:right">Bedrag</th><th>Naam</th></tr></thead>
          <tbody>${m.voorbeelden.map(v => `<tr>
            <td><code>${esc(v.id)}</code></td><td class="muted">${esc(v.nu)}</td>
            <td class="pos">${esc(v.na)}</td>
            <td style="text-align:right">${Number(v.bedrag).toFixed(2)}</td>
            <td class="muted" style="font-size:11px">${esc(String(v.naam).slice(0, 34))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="ctrl-uitleg">Eerste ${m.voorbeelden.length} van ${m.aantalRecords}.</p>` : ''}
      <div class="modal-actions">
        <button class="btn" onclick="annuleerGc()">Annuleren</button>
        <button class="btn btn-primary" onclick="bevestigGc()">Keuze vastleggen</button>
      </div>
      <p class="ctrl-uitleg" style="margin-bottom:0">
        Vastleggen zet de keuze klaar in deze sessie. Er wordt nog niets naar de opslag geschreven.
      </p>
    </div>`;
}

function meldingBlok(m) {
  const keuze = keuzeVan(m.id);
  const bezig = openBevestiging && openBevestiging.meldingId === m.id;
  return `
    <div class="card" style="margin-bottom:var(--spacing-3)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div style="flex:1">
          <div style="font-weight:600">${esc(m.titel)}</div>
          <div class="muted" style="font-size:11.5px;margin-top:2px">
            <code>${esc(m.sleutel)}</code> · ${m.aantalRecords} record${m.aantalRecords === 1 ? '' : 's'}
            · ${m.categorie === 'bewezen' ? 'bewezen' : 'onbekend'}${m.groep ? ' · groepsactie' : ''}
          </div>
        </div>
        <span class="${m.categorie === 'bewezen' ? 'pos' : 'neg'}" style="font-size:11px;white-space:nowrap">
          ${m.categorie === 'bewezen' ? 'correctie bewezen' : 'niet bewezen'}
        </span>
      </div>
      <p class="ctrl-uitleg" style="margin:var(--spacing-2) 0 0">${esc(m.reden)}</p>
      <table class="tbl-compact" style="width:100%;margin-top:var(--spacing-2)">
        <tbody>
          <tr><td style="width:130px" class="muted">Nu</td><td>${esc(m.huidigeWaarde)}</td></tr>
          <tr><td class="muted">Voorstel</td>
              <td class="${m.acties.includes(ACTIES.CORRIGEREN) ? 'pos' : 'muted'}">${esc(m.nieuweWaarde)}</td></tr>
          ${m.detail ? `<tr><td class="muted">Toelichting</td><td class="muted">${esc(m.detail)}</td></tr>` : ''}
          ${m.nietEenduidig ? `<tr><td class="muted">Let op</td><td class="neg">${m.nietEenduidig} boeking(en) hebben meerdere identieke tegenhangers; de datum is voor alle even zeker, het nieuwe nummer niet</td></tr>` : ''}
        </tbody>
      </table>
      ${keuze ? `
        <div class="alert alert-ok" style="margin-top:var(--spacing-2)">
          Keuze vastgelegd: <strong>${esc(naam[keuze.actie])}</strong>
          <button class="btn btn-ghost btn-sm" style="margin-left:8px"
            onclick="maakKeuzeOngedaan('${esc(m.id)}')">Ongedaan maken</button>
        </div>`
        : bezig ? bevestigingsblok(m, openBevestiging.actie) : `
        <div class="modal-actions" style="justify-content:flex-start">
          ${m.acties.map(a => `<button class="btn btn-sm ${a === ACTIES.CORRIGEREN ? 'btn-primary' : ''}"
            onclick="kiesGc('${esc(m.id)}','${a}')">${esc(naam[a])}</button>`).join('')}
          <span class="muted" style="font-size:11px;align-self:center">
            ${!m.acties.includes(ACTIES.CORRIGEREN) ? 'corrigeren kan niet: de juiste waarde staat niet vast. ' : ''}
            ${!m.acties.includes(ACTIES.VERBERGEN) ? 'verbergen kan niet: er is niet vastgelegd wat verborgen hier zou betekenen.' : ''}
          </span>
        </div>`}
    </div>`;
}

/** Zet de negen meldingen als JSON en CSV op je schijf. Schrijft niets weg. */
export function exporteerGcMeldingen() {
  try {
    const uit = exporteerMeldingen(meldingen);
    el('gc-integriteit').innerHTML =
      `<div class="alert alert-ok">${uit.aantal} meldingen geëxporteerd naar JSON en CSV,
       ${uit.kolommen} kolommen per melding. Er is niets naar de opslag geschreven.</div>`;
  } catch (e) {
    el('gc-integriteit').innerHTML = `<div class="alert alert-error">Export mislukt: ${esc(e.message)}</div>`;
  }
}

/** Vergelijkt de opslag met de stand bij het openen van dit scherm. */
export async function controleerGcSchrijfacties() {
  try {
    const nu = await opslagVingerafdrukken();
    const r = vergelijkVingerafdrukken(vingerBijOpening || {}, nu);
    const afwijkend = r.filter(x => !x.gelijk);
    el('gc-integriteit').innerHTML = `
      <div class="alert ${afwijkend.length ? 'alert-error' : 'alert-ok'}">
        ${afwijkend.length
          ? `<strong>Let op: ${afwijkend.length} sleutel(s) zijn veranderd sinds dit scherm openging.</strong>`
          : `<strong>Nul schrijfacties.</strong> Alle ${r.length} opslagsleutels zijn onveranderd sinds dit scherm openging.`}
      </div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Sleutel</th><th>Bij openen</th><th>Nu</th>
          <th style="padding-right:16px">Uitkomst</th></tr></thead>
        <tbody>${r.map(x => `<tr>
          <td style="padding-left:16px"><code>${esc(x.sleutel)}</code></td>
          <td class="muted" style="font-size:10px">${esc(x.voor)}</td>
          <td class="muted" style="font-size:10px">${esc(x.na)}</td>
          <td class="${x.gelijk ? 'pos' : 'neg'}" style="padding-right:16px">${x.gelijk ? 'gelijk' : 'VERANDERD'}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>`;
  } catch (e) {
    el('gc-integriteit').innerHTML = `<div class="alert alert-error">Controle mislukt: ${esc(e.message)}</div>`;
  }
}

function render() {
  const bewezen = meldingen.filter(m => m.categorie === 'bewezen');
  const onbekend = meldingen.filter(m => m.categorie === 'onbekend');
  const overzicht = keuzeOverzicht(meldingen);

  el('gc-inhoud').innerHTML = `
    <div class="alert alert-info">
      <strong>Er wordt niets gewijzigd.</strong> Keuzes worden alleen in deze sessie onthouden;
      het wegschrijven wordt pas gebouwd nadat je dat goedkeurt. Verwijderen zit hier niet in.
      <br><strong>Verbergen is nu bij geen enkele melding beschikbaar.</strong> Het datamodel kent
      geen zichtbaarheidsvlag op boekingen of voorraadartikelen, dus er staat nergens vast wát er
      dan niet meer zou meetellen. Zolang dat niet is vastgelegd, wordt de knop niet aangeboden.
    </div>
    <div class="modal-actions" style="justify-content:flex-start;margin-bottom:var(--spacing-3)">
      <button class="btn" onclick="exporteerGcMeldingen()">Meldingen exporteren (JSON + CSV)</button>
      <button class="btn" onclick="controleerGcSchrijfacties()">Controleren of er iets is geschreven</button>
    </div>
    <div id="gc-integriteit"></div>

    <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Meldingen</div>
        <div class="kpi-val">${meldingen.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Correctie bewezen</div>
        <div class="kpi-val pos">${bewezen.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Niet bewezen</div>
        <div class="kpi-val ${onbekend.length ? 'neg' : ''}">${onbekend.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Keuze gemaakt</div>
        <div class="kpi-val">${overzicht.length}</div></div>
    </div>

    <div class="section-head"><div class="eyebrow">Bewezen — een correctie is mogelijk</div></div>
    ${bewezen.length ? bewezen.map(meldingBlok).join('')
      : '<div class="card"><p class="ctrl-uitleg" style="margin:0">Geen bewezen afwijkingen gevonden.</p></div>'}

    <div class="section-head"><div class="eyebrow">Niet bewezen — de app verandert hier niets</div></div>
    ${onbekend.length ? onbekend.map(meldingBlok).join('')
      : '<div class="card"><p class="ctrl-uitleg" style="margin:0">Geen openstaande onbekende afwijkingen.</p></div>'}

    ${overzicht.length ? `
      <div class="section-head"><div class="eyebrow">Klaargezette keuzes</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Melding</th><th>Actie</th><th>Sleutel</th>
          <th style="text-align:right">Records</th><th style="padding-right:16px">Gevolg</th></tr></thead>
        <tbody>${overzicht.map(k => `<tr>
          <td style="padding-left:16px">${esc(k.titel)}</td>
          <td class="${kleur[k.actie]}"><strong>${esc(naam[k.actie])}</strong></td>
          <td class="muted"><code>${esc(k.sleutel)}</code></td>
          <td style="text-align:right">${k.aantalRecords}</td>
          <td class="muted" style="font-size:11px;padding-right:16px">${esc(k.gevolg)}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>
      <div class="modal-actions">
        <button class="btn btn-primary" disabled
          title="Wordt pas gebouwd nadat je de gegevenscontrole hebt goedgekeurd">Keuzes uitvoeren</button>
        <span class="muted" style="font-size:11px;align-self:center">
          de uitvoerende stap bestaat nog niet — er kan hier niets worden weggeschreven</span>
      </div>` : ''}`;
}
