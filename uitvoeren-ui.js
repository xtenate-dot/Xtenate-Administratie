// uitvoeren-ui.js — de werkstroom in beeld: backup, preview, bevestiging,
// uitvoeren, controle. Elke stap zit op slot tot de vorige klaar is.
//
// De knop "Uitvoeren" verschijnt pas nadat de reservekopie is gedownload én het
// vinkje is gezet. Het slot zit ook in uitvoeren.js zelf, niet alleen hier.

import { stapBackup, stapPreview, stapUitvoeren, stapControle } from './uitvoeren.js?v=20261023j';

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const geld = n => '€ ' + Number(n || 0).toFixed(2);

let stap = 1;
let backup = null;      // { bestand, voorStand }
let preview = null;
let begrepen = false;
let uitkomst = null;
let controle = null;
let bezig = false;

export function openUitvoeren() {
  stap = 1; backup = null; preview = null; begrepen = false;
  uitkomst = null; controle = null; bezig = false;
  el('modal-uitvoeren').classList.add('open');
  render();
}

export function sluitUitvoeren() {
  if (bezig) return;
  el('modal-uitvoeren').classList.remove('open');
}

export async function doeStapBackup() {
  if (bezig) return;
  bezig = true; render();
  try {
    backup = await stapBackup();
    stap = 2;
    preview = await stapPreview();
  } catch (e) {
    el('uit-inhoud').innerHTML =
      `<div class="alert alert-error">De reservekopie is niet gelukt: ${esc(e.message)}.
       Er is niets gewijzigd en de volgende stap blijft op slot.</div>`;
    bezig = false;
    return;
  }
  bezig = false; render();
}

export function zetBegrepen(aan) { begrepen = !!aan; render(); }

export async function doeStapUitvoeren() {
  if (bezig || !backup || !preview || !begrepen) return;
  bezig = true; stap = 4; render();
  try {
    uitkomst = await stapUitvoeren(preview, backup.voorStand);
    controle = await stapControle(preview, uitkomst);
    stap = 5;
  } catch (e) {
    el('uit-inhoud').innerHTML =
      `<div class="alert alert-error">Het herstel is afgebroken: ${esc(e.message)}</div>
       <p class="ctrl-uitleg">Controleer met de opslagdiagnose wat de stand nu is.
       Je reservekopie staat in je downloadmap.</p>`;
    bezig = false;
    return;
  }
  bezig = false; render();
}

function stappenbalk() {
  const namen = ['Reservekopie', 'Herstelpreview', 'Bevestigen', 'Uitvoeren', 'Controle'];
  return `<div class="mig-fasen">${namen.map((n, i) => `
    <div class="mig-fase ${i + 1 === stap ? 'actief' : ''} ${i + 1 < stap ? 'klaar' : ''}">
      <span>${i + 1}. ${esc(n)}</span></div>`).join('')}</div>`;
}

function render() {
  let inhoud = '';

  // ------------------------------------------------------------- stap 1
  if (stap === 1) {
    inhoud = `
      <div class="alert alert-info">
        Eerst een volledige reservekopie van alle opslagsleutels, met een SHA-256 per sleutel en
        een checksum over het geheel. Pas als die gelukt is, gaat de volgende stap open.
        <strong>Er wordt nog niets gewijzigd.</strong>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="doeStapBackup()" ${bezig ? 'disabled' : ''}>
          ${bezig ? 'Bezig…' : 'Reservekopie maken en downloaden'}</button>
      </div>`;
  }

  // --------------------------------------------------------- stap 2 en 3
  if (stap === 2 || stap === 3) {
    const p = preview;
    const rij = (wat, aantal, sleutel) => `<tr>
      <td style="padding-left:16px">${esc(wat)}</td>
      <td style="text-align:right"><strong>${aantal}</strong></td>
      <td class="muted" style="padding-right:16px"><code>${esc(sleutel)}</code></td></tr>`;

    const jt = p.mutaties.find(x => x.pad);
    inhoud = `
      <div class="alert alert-ok">
        Reservekopie gedownload als <code>${esc(backup.bestand.naam)}</code> —
        ${backup.bestand.sleutels} sleutels, checksum <code>${esc(backup.bestand.som.slice(0, 32))}</code>.
        Bewaar dit bestand voordat je verdergaat.
      </div>

      <div class="section-head"><div class="eyebrow">Wat er wordt gewijzigd</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Wijziging</th><th style="text-align:right">Records</th>
          <th style="padding-right:16px">Sleutel</th></tr></thead>
        <tbody>
          ${rij('Datum één dag later', p.aantalDatums, 'xtenate_hist_tx_override')}
          ${p.mutaties.filter(x => x.veld === 'type').map(x => `<tr>
            <td style="padding-left:16px">Soort ${esc(x.van)} → <span class="pos">${esc(x.naar)}</span>
              <span class="muted">· record ${esc(x.recordId)}</span></td>
            <td style="text-align:right"><strong>1</strong></td>
            <td class="muted" style="padding-right:16px"><code>xtenate_hist_tx_override</code></td></tr>`).join('')}
          ${jt ? `<tr>
            <td style="padding-left:16px">priveSt 2022: ${geld(jt.van)} → <span class="pos">${geld(jt.naar)}</span></td>
            <td style="text-align:right"><strong>1</strong></td>
            <td class="muted" style="padding-right:16px"><code>xtenate_home_totals_override</code></td></tr>` : ''}
        </tbody>
      </table></div></div>
      <p class="ctrl-uitleg">De bestaande records worden gericht aangepast: alleen het genoemde veld,
        en alleen als de huidige waarde nog is wat we hier tonen. De historie wordt niet opnieuw
        opgebouwd en <strong>geen enkel id verandert</strong> — je weggeklikte controlemeldingen
        blijven daardoor werken.</p>

      ${p.jaargrens.length ? `
      <div class="section-head"><div class="eyebrow">Volgt vanzelf uit de nieuwe datum</div></div>
      <div class="card"><p class="ctrl-uitleg" style="margin:0">
        ${p.jaargrens.map(j => `Record <code>${esc(j.id)}</code> gaat van ${esc(j.van)} naar ${esc(j.naar)}
          en komt daarmee van ${esc(j.van.slice(0, 4))} in ${esc(j.naar.slice(0, 4))} terecht.`).join('<br>')}
        <br>Dit wordt niet apart gestuurd; het is het gevolg van de datumcorrectie.
      </p></div>` : ''}

      <div class="section-head"><div class="eyebrow">Wat er gegarandeerd niet gebeurt</div></div>
      <div class="card card-flush">${p.garanties.map(g => `
        <div class="ctrl-item"><span class="ctrl-item-main" style="cursor:default">
          <span class="ctrl-item-label">${g.goed ? '✓' : '✕'} ${esc(g.tekst)}</span>
          ${g.detail ? `<span class="ctrl-item-sub">${esc(g.detail)}</span>` : ''}
        </span></div>`).join('')}</div>

      <div class="section-head"><div class="eyebrow">Bevestigen</div></div>
      <div class="card">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" ${begrepen ? 'checked' : ''}
            onchange="zetBegrepen(this.checked)" style="margin-top:3px">
          <span>Ik begrijp dat deze actie daadwerkelijk gegevens in localStorage gaat wijzigen.</span>
        </label>
        <div class="modal-actions">
          <button class="btn" onclick="sluitUitvoeren()">Annuleren</button>
          <button class="btn btn-primary" onclick="doeStapUitvoeren()" ${begrepen && !bezig ? '' : 'disabled'}>
            ${bezig ? 'Bezig…' : `Uitvoeren — ${p.aantalDatums + p.aantalTypes + p.aantalWaarden} wijzigingen`}</button>
        </div>
        ${!begrepen ? '<p class="ctrl-uitleg" style="margin-bottom:0">De knop gaat pas open als je het vinkje zet.</p>' : ''}
      </div>`;
  }

  // ------------------------------------------------------------- stap 4
  if (stap === 4) {
    inhoud = '<div class="alert alert-info">Bezig met uitvoeren en direct daarna opnieuw uitlezen…</div>';
  }

  // ------------------------------------------------------------- stap 5
  if (stap === 5 && controle) {
    const gewijzigd = controle.rapport.filter(r => r.gewijzigd);
    const onveranderd = controle.rapport.filter(r => !r.gewijzigd);
    inhoud = `
      <div class="alert ${controle.allesGoed && !controle.onterecht.length ? 'alert-ok' : 'alert-error'}">
        ${controle.allesGoed && !controle.onterecht.length
          ? `Herstel uitgevoerd en nagecontroleerd. ${uitkomst.log.length} wijzigingen in
             ${gewijzigd.length} sleutel(s); alle overige sleutels onveranderd.`
          : `<strong>Let op:</strong> niet elke controle is gehaald. Je reservekopie staat in je downloadmap.`}
      </div>

      <div class="section-head"><div class="eyebrow">Controle achteraf</div></div>
      <div class="card card-flush">${controle.controles.map(c => `
        <div class="ctrl-item">
          <span class="ctrl-item-main" style="cursor:default">
            <span class="ctrl-item-label">${c.goed ? '✓' : '✕'} ${esc(c.titel)}</span></span>
          <span class="${c.goed ? 'pos' : 'neg'}" style="font-size:11.5px;padding-right:12px">${esc(c.waarde)}</span>
        </div>`).join('')}</div>

      <div class="section-head"><div class="eyebrow">Checksums per sleutel</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Sleutel</th><th>Oud</th><th>Nieuw</th>
          <th style="padding-right:16px">Uitkomst</th></tr></thead>
        <tbody>
          ${gewijzigd.map(r => `<tr>
            <td style="padding-left:16px"><code>${esc(r.sleutel)}</code></td>
            <td class="muted" style="font-size:10px">${esc(r.voor.slice(0, 24))}</td>
            <td class="muted" style="font-size:10px">${esc(String(r.na).slice(0, 24))}</td>
            <td class="${r.mocht ? 'pos' : 'neg'}" style="padding-right:16px">
              ${r.mocht ? 'gewijzigd zoals afgesproken' : 'ONTERECHT GEWIJZIGD'}</td></tr>`).join('')}
          ${onveranderd.map(r => `<tr>
            <td style="padding-left:16px"><code>${esc(r.sleutel)}</code></td>
            <td class="muted" style="font-size:10px">${esc(r.voor.slice(0, 24))}</td>
            <td class="muted" style="font-size:10px">${esc(String(r.na).slice(0, 24))}</td>
            <td class="muted" style="padding-right:16px">ONVERANDERD</td></tr>`).join('')}
        </tbody>
      </table></div></div>

      <div class="modal-actions">
        <button class="btn" onclick="openOpslagDiagnose()">Naar de opslagdiagnose</button>
        <button class="btn btn-primary" onclick="sluitUitvoeren()">Sluiten</button>
      </div>`;
  }

  el('uit-inhoud').innerHTML = stappenbalk() + inhoud;
}
