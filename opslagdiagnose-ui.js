// opslagdiagnose-ui.js — het scherm bij de tijdelijke opslagdiagnose.
//
// Toont alleen. Er wordt niets opgeslagen, hersteld of gemigreerd; ook geen
// voorkeur over welk tabblad open stond. Na het onderzoek mag dit bestand weg.

import { opslagDiagnose, opslagDiagnoseAlsTekst, opslagSnapshot, opslagSnapshotAlsTekst,
  overrideDetail, overrideDetailAlsTekst, negeerDetail, backupBestand,
  negeerAnalyse, downloadNegeerlijst }
  from './opslagdiagnose.js?v=20261024a';

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let laatsteTekst = '';

export function openOpslagDiagnose() {
  laatsteTekst = '';
  el('diag-inhoud').innerHTML = `
    <div class="alert alert-info">
      Dit scherm <strong>leest alleen</strong>. Er wordt niets opgeslagen, hersteld of naar Supabase geschreven.
      Het vergelijkt drie bronnen: <code>xtenate_tx</code>, <code>xtenate_hist_tx_override</code> en de historie in de code (<code>HIST_TX_DEFAULT</code>).
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="diag-knop" onclick="voerOpslagDiagnoseUit()">Diagnose opslag uitvoeren</button>
      <button class="btn" id="diag-snap" onclick="maakOpslagSnapshot()">Snapshot maken (bevriezen)</button>
      <button class="btn" id="diag-ovr" onclick="toonOverrides()">Overrides voluit tonen</button>
      <button class="btn" id="diag-neg" onclick="toonNegeerlijst()">Negeerlijst + D1-gevolgen</button>
      <button class="btn btn-primary" id="diag-backup" onclick="downloadBackup()">Volledige backup downloaden</button>
    </div>`;
  el('modal-opslagdiagnose').classList.add('open');
}

export function sluitOpslagDiagnose() {
  el('modal-opslagdiagnose').classList.remove('open');
}

export function voerOpslagDiagnoseUit() {
  const knop = el('diag-knop');
  if (knop) knop.disabled = true;
  try {
    const d = opslagDiagnose();
    laatsteTekst = opslagDiagnoseAlsTekst(d);
    render(d);
  } catch (e) {
    el('diag-inhoud').innerHTML =
      `<div class="alert alert-error">De diagnose liep vast: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  }
}

function render(d) {
  const bronRij = ([naam, b]) => `
    <tr>
      <td style="padding-left:16px"><code>${esc(naam)}</code></td>
      <td style="text-align:right;font-weight:600">${b.aantal}</td>
      <td class="muted" style="padding-right:16px;font-size:11px">
        ${esc(Object.entries(b.perJaar).sort().map(([j, n]) => `${j}: ${n}`).join(' · ') || '—')}
        ${b.aanwezig === false ? ' <span class="neg">(sleutel bestaat niet)</span>' : ''}
        ${b.fout ? ` <span class="neg">(${esc(b.fout)})</span>` : ''}
      </td>
    </tr>`;

  const jaarRij = j => `
    <tr>
      <td style="padding-left:16px">${j.jaar}</td>
      <td style="text-align:right" class="muted">${j.aantalMijn}</td>
      <td style="text-align:right" class="muted">${j.aantalCode}</td>
      <td style="text-align:right;font-weight:600" class="${j.exact.length ? 'pos' : ''}">${j.exact.length}</td>
      <td style="text-align:right;font-weight:600" class="${j.verschoven.length ? 'neg' : ''}">${j.verschoven.length}</td>
      <td style="text-align:right">${j.afwijkend.length}</td>
      <td style="text-align:right">${j.alleenBijMij.length}</td>
      <td style="text-align:right;padding-right:16px">${j.alleenInCode.length}</td>
    </tr>`;

  // Alle datumverschillen samengeteld, want dat is het vermoeden dat we toetsen.
  const perDelta = {};
  d.jaren.forEach(j => j.verschoven.forEach(v => { perDelta[v.dagen] = (perDelta[v.dagen] || 0) + 1; }));
  const deltas = Object.entries(perDelta).sort((a, b) => a[0] - b[0]);

  const voorbeelden = [];
  d.jaren.forEach(j => j.verschoven.slice(0, 4).forEach(v => voorbeelden.push({ jaar: j.jaar, ...v })));

  el('diag-inhoud').innerHTML = `
    <div class="alert alert-ok">
      Klaar. <strong>Er is niets geschreven.</strong> Tijdzone ${esc(d.tijdzone)}, UTC ${d.utcAfwijkingUren >= 0 ? '+' : ''}${d.utcAfwijkingUren} uur.
    </div>

    <div class="section-head"><div class="eyebrow">De drie bronnen</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th style="padding-left:16px">Bron</th><th style="text-align:right">Boekingen</th><th style="padding-right:16px">Per jaar</th></tr></thead>
      <tbody>${Object.entries(d.bakken).map(bronRij).join('')}</tbody>
    </table></div></div>

    <div class="section-head"><div class="eyebrow">Vergelijking per jaar</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr>
        <th style="padding-left:16px">Jaar</th>
        <th style="text-align:right">Bij mij</th>
        <th style="text-align:right">In code</th>
        <th style="text-align:right">Exact gelijk</th>
        <th style="text-align:right">Datum verschoven</th>
        <th style="text-align:right">Ander veld</th>
        <th style="text-align:right">Alleen bij mij</th>
        <th style="text-align:right;padding-right:16px">Alleen in code</th>
      </tr></thead>
      <tbody>${d.jaren.map(jaarRij).join('')}</tbody>
    </table></div></div>
    <p class="ctrl-uitleg">"Datum verschoven" betekent: bedrag, grootboek, rekening, soort, naam én omschrijving zijn gelijk, alleen de datum wijkt af. Dat is dus dezelfde boeking, geen nieuwe.</p>

    <div class="section-head"><div class="eyebrow">Datumverschillen</div></div>
    <div class="card">
      <p class="ctrl-uitleg" style="margin:0">
        ${deltas.length
          ? deltas.map(([dagen, n]) => `<strong>${n}×</strong> ${dagen > 0 ? '+' : ''}${dagen} dag`).join(' · ')
          : 'Geen verschoven boekingen gevonden.'}
      </p>
      ${voorbeelden.length ? `<div class="table-wrap" style="margin-top:var(--spacing-3)"><table class="tbl-compact">
        <thead><tr><th>Jaar</th><th>Bij mij</th><th>In code</th><th style="text-align:right">Verschil</th><th style="text-align:right">Bedrag</th><th>Naam</th></tr></thead>
        <tbody>${voorbeelden.map(v => `<tr>
          <td>${v.jaar}</td><td>${esc(v.mijn.datum)}</td><td>${esc(v.code.datum)}</td>
          <td style="text-align:right" class="neg">${v.dagen > 0 ? '+' : ''}${v.dagen}</td>
          <td style="text-align:right">${Number(v.mijn.bedrag).toFixed(2)}</td>
          <td class="muted" style="font-size:11px">${esc(String(v.mijn.naam || '').slice(0, 44))}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div>

    <div class="section-head"><div class="eyebrow">Losse bevindingen</div></div>
    <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Zonder geldige datum</div>
        <div class="kpi-val ${d.zonderDatum.length ? 'neg' : ''}">${d.zonderDatum.length}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Dubbele nummers</div>
        <div class="kpi-val ${d.idBotsingen.length ? 'neg' : ''}">${d.idBotsingen.length}</div>
        <div class="kpi-sub">${d.idBotsingen.reduce((s, x) => s + x.aantal - 1, 0)} regels te veel</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Echte dubbele boekingen</div>
        <div class="kpi-val">${d.jaren.reduce((s, j) => s + j.dubbelen.length, 0)}</div>
        <div class="kpi-sub">identiek in mijn opslag</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Boekingen 2022</div>
        <div class="kpi-val">${d.tweeentwintigVolledig.length}</div></div>
    </div>

    <p class="ctrl-uitleg">De volledige uitvoer staat hieronder: alle regels van 2022, alle datumverschuivingen, de boekingen zonder datum en elke nummerbotsing met de bijbehorende regels. Kopieer die en plak hem terug in het gesprek.</p>

    <div class="modal-actions">
      <button class="btn" onclick="voerOpslagDiagnoseUit()">Opnieuw uitvoeren</button>
      <button class="btn btn-primary" id="diag-kopieer" onclick="kopieerOpslagDiagnose()">Resultaten kopiëren</button>
    </div>
    <textarea id="diag-tekst" readonly style="width:100%;height:340px;margin-top:var(--spacing-3);
      font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
      border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(laatsteTekst)}</textarea>`;
}

/** Bevriest de opslag op papier. Leest alleen. */
export async function maakOpslagSnapshot() {
  const knop = el('diag-snap');
  if (knop) knop.disabled = true;
  try {
    const s = await opslagSnapshot();
    laatsteTekst = opslagSnapshotAlsTekst(s);
    el('diag-inhoud').innerHTML = `
      <div class="alert alert-ok">
        Snapshot gemaakt. <strong>Er is niets geschreven.</strong>
        ${s.aantalSleutels} sleutels, ${s.totaalBytes} bytes.
        ${s.kopieSleutels.length
          ? `<br><strong>Let op:</strong> er staan sleutels die op een reservekopie lijken: <code>${
              s.kopieSleutels.map(esc).join('</code>, <code>')}</code>. Die kunnen de oude stand bevatten.`
          : '<br>Er zijn geen reservekopie-sleutels gevonden.'}
      </div>
      <div class="section-head"><div class="eyebrow">Alle opslagsleutels</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Sleutel</th><th>Vorm</th>
          <th style="text-align:right">Records</th><th style="text-align:right">Bytes</th>
          <th>Eerste</th><th>Laatste</th><th style="padding-right:16px">Checksum</th></tr></thead>
        <tbody>${s.regels.map(x => `<tr>
          <td style="padding-left:16px"><code>${esc(x.sleutel)}</code></td>
          <td class="muted">${esc(x.vorm)}</td>
          <td style="text-align:right">${x.records ?? '—'}</td>
          <td style="text-align:right" class="muted">${x.bytes}</td>
          <td class="muted">${esc(x.eerste ?? '—')}</td>
          <td class="muted">${esc(x.laatste ?? '—')}</td>
          <td class="muted" style="font-size:10px;padding-right:16px">${esc(x.som)}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>
      <p class="ctrl-uitleg">De checksum verandert zodra ook maar één teken in die sleutel wijzigt.
        Draai deze snapshot later opnieuw om te bewijzen dat er niets is aangeraakt.</p>
      <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Voorraadartikelen</div>
          <div class="kpi-val">${s.covers.length}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">HNVI-loten</div>
          <div class="kpi-val">${s.loten.length}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Sleutels</div>
          <div class="kpi-val">${s.aantalSleutels}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Totale omvang</div>
          <div class="kpi-val">${(s.totaalBytes / 1024).toFixed(1)} kB</div></div>
      </div>
      <p class="ctrl-uitleg">De volledige lijst met voorraadartikelen en HNVI-loten staat in de tekst hieronder.</p>
      <div class="modal-actions">
        <button class="btn" onclick="voerOpslagDiagnoseUit()">Terug naar de diagnose</button>
        <button class="btn btn-primary" id="diag-kopieer" onclick="kopieerOpslagDiagnose()">Resultaten kopiëren</button>
      </div>
      <textarea id="diag-tekst" readonly style="width:100%;height:340px;margin-top:var(--spacing-3);
        font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
        border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(laatsteTekst)}</textarea>`;
  } catch (e) {
    el('diag-inhoud').innerHTML =
      `<div class="alert alert-error">De snapshot liep vast: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  }
}

/** Toont de twee overrides voluit. Leest alleen. */
export async function toonOverrides() {
  const knop = el('diag-ovr');
  if (knop) knop.disabled = true;
  try {
    const d = await overrideDetail();
    laatsteTekst = overrideDetailAlsTekst(d);
    const g = n => (n === null || n === undefined ? '—' : Number(n).toFixed(2));
    const velden = ['omzet', 'kosten', 'omzXt', 'omzBol', 'omzHC', 'priveOp', 'priveSt', 'hnviInv'];
    const allesGelijk = d.controle.every(c => c.gelijk);

    el('diag-inhoud').innerHTML = `
      <div class="alert ${allesGelijk ? 'alert-ok' : 'alert-error'}">
        ${allesGelijk
          ? 'De vier sleutels uit de vorige snapshot zijn <strong>onveranderd</strong>. Er is niets geschreven.'
          : '<strong>Let op:</strong> er is iets veranderd sinds de vorige snapshot.'}
      </div>

      <div class="section-head"><div class="eyebrow">Controle tegen de snapshot van 12-8 14:48</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Sleutel</th><th>Toen</th><th>Nu</th>
          <th style="padding-right:16px">Uitkomst</th></tr></thead>
        <tbody>${d.controle.map(c => `<tr>
          <td style="padding-left:16px"><code>${esc(c.sleutel)}</code></td>
          <td class="muted" style="font-size:10px">${esc(c.verwacht)}</td>
          <td class="muted" style="font-size:10px">${esc(c.nu)}</td>
          <td class="${c.gelijk ? 'pos' : 'neg'}" style="padding-right:16px">${c.gelijk ? 'gelijk' : 'AFWIJKEND'}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>

      <div class="section-head"><div class="eyebrow">xtenate_home_totals_override</div></div>
      <div class="card">
        <p class="ctrl-uitleg" style="margin:0 0 var(--spacing-2)">
          ${d.ht.aanwezig ? `${d.ht.tekens} tekens · checksum <code>${esc(d.ht.som)}</code>` : 'staat niet in de opslag'}</p>
        <textarea readonly style="width:100%;height:90px;font-family:ui-monospace,monospace;font-size:10px;
          padding:8px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);
          background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(d.ht.ruw)}</textarea>
      </div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Jaar</th>${velden.map(v => `<th style="text-align:right">${v}</th>`).join('')}
          <th style="padding-right:16px">Bron</th></tr></thead>
        <tbody>${d.htRegels.filter(x => x.mijn || x.std).map(x => `
          <tr>
            <td style="padding-left:16px">${x.jaar}</td>
            ${velden.map(v => `<td style="text-align:right" class="${x.afwijkend.includes(v) ? 'neg' : ''}">${
              g(x.mijn?.[v])}${x.afwijkend.includes(v) ? `<br><span class="muted" style="font-size:10px">code ${g(x.std?.[v])}</span>` : ''}</td>`).join('')}
            <td class="muted" style="padding-right:16px;font-size:11px">${
              x.alleenBijMij ? 'alleen bij jou' : x.alleenInCode ? 'alleen in code' :
              x.afwijkend.length ? x.afwijkend.length + ' velden anders' : 'gelijk aan code'}</td>
          </tr>`).join('')}</tbody>
      </table></div></div>

      <div class="section-head"><div class="eyebrow">xtenate_maand_saldos_override</div></div>
      <div class="card">
        <p class="ctrl-uitleg" style="margin:0 0 var(--spacing-2)">
          ${d.ms.aanwezig ? `${d.ms.tekens} tekens · checksum <code>${esc(d.ms.som)}</code>` : 'staat niet in de opslag'}
          ${d.gaten.length ? `<br>Ontbrekende maanden binnen de reeks: <span class="neg">${esc(d.gaten.join(', '))}</span>` : '<br>Geen gaten binnen de reeks.'}</p>
        <textarea readonly style="width:100%;height:90px;font-family:ui-monospace,monospace;font-size:10px;
          padding:8px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);
          background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(d.ms.ruw)}</textarea>
      </div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Maand</th>
          <th style="text-align:right">Begin</th><th style="text-align:right">Eind</th>
          <th style="text-align:right">Begin (code)</th><th style="text-align:right">Eind (code)</th>
          <th style="padding-right:16px">Uitkomst</th></tr></thead>
        <tbody>${d.msRegels.map(x => `<tr>
          <td style="padding-left:16px">${esc(x.maand)}</td>
          <td style="text-align:right" class="${x.afwijkend.includes('begin') ? 'neg' : ''}">${g(x.mijn?.begin)}</td>
          <td style="text-align:right" class="${x.afwijkend.includes('eind') ? 'neg' : ''}">${g(x.mijn?.eind)}</td>
          <td style="text-align:right" class="muted">${g(x.std?.begin)}</td>
          <td style="text-align:right" class="muted">${g(x.std?.eind)}</td>
          <td class="muted" style="padding-right:16px;font-size:11px">${
            x.alleenBijMij ? 'alleen bij jou' : x.alleenInCode ? 'alleen in code' :
            x.afwijkend.length ? 'anders' : 'gelijk'}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>

      <div class="modal-actions">
        <button class="btn" onclick="maakOpslagSnapshot()">Terug naar de snapshot</button>
        <button class="btn btn-primary" id="diag-kopieer" onclick="kopieerOpslagDiagnose()">Resultaten kopiëren</button>
      </div>
      <textarea id="diag-tekst" readonly style="width:100%;height:300px;margin-top:var(--spacing-3);
        font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
        border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(laatsteTekst)}</textarea>`;
  } catch (e) {
    el('diag-inhoud').innerHTML =
      `<div class="alert alert-error">Het uitlezen liep vast: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  }
}

/** Toont de negeerlijst met wat D1 ermee doet, en biedt JSON + CSV aan. */
export async function toonNegeerlijst() {
  const knop = el('diag-neg');
  if (knop) knop.disabled = true;
  try {
    const a = await negeerAnalyse();
    const kol = ['soort','sleutel','huidigId','controleId','controleTitel','label','reden','wanneer',
      'vinger','entiteit','wijstNaar','d1','nieuwId','oordeel','toelichting'];
    laatsteTekst = ['NEGEERLIJST + D1-GEVOLGEN — ALLEEN LEZEN — ' + a.momentLokaal,
      'checksum xtenate_controle_negeer: ' + a.som,
      `meldingen: ${a.aantalMeldingen ?? 0} | controles: ${a.aantalControles ?? 0} | totaal: ${a.aantalTotaal ?? 0}`,
      `geraakt door D1: ${a.geraakt ?? 0} | oordeel: ` +
        Object.entries(a.perOordeel || {}).map(([k, v]) => `${k}=${v}`).join(', '),
      '', 'RUWE WAARDE:', a.ruw, '', kol.join(' | '),
      ...a.regels.map(r => kol.map(k =>
        Array.isArray(r[k]) ? r[k].join(' ') : String(r[k] ?? '')).join(' | '))].join('\n');

    const kleur = o => o === 'JA' ? 'pos' : o === 'ONBESLIST' ? 'neg' : o === 'NEE' ? 'neg' : 'muted';

    el('diag-inhoud').innerHTML = `
      <div class="alert alert-info">
        Er is niets geschreven. Niet-eenduidige koppelingen staan op <strong>ONBESLIST</strong>; daar wordt niets geraden.
      </div>

      <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Meldingen</div>
          <div class="kpi-val">${a.aantalMeldingen ?? 0}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Uitgezette controles</div>
          <div class="kpi-val">${a.aantalControles ?? 0}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Totaal records</div>
          <div class="kpi-val">${a.aantalTotaal ?? 0}</div></div>
        <div class="kpi kpi--secondary"><div class="kpi-lbl">Geraakt door D1</div>
          <div class="kpi-val ${a.geraakt ? 'neg' : ''}">${a.geraakt ?? 0}</div>
          <div class="kpi-sub">${Object.entries(a.perOordeel || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div></div>
      </div>

      ${a.regels.length ? `
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr>
          <th style="padding-left:16px">Huidig ID</th><th>Type</th><th>Vingerafdruk</th>
          <th>Gekoppelde entiteit</th><th>Door D1</th><th>Nieuw ID</th>
          <th style="padding-right:16px">Oordeel</th></tr></thead>
        <tbody>${a.regels.map(r => `<tr>
          <td style="padding-left:16px"><code>${esc(r.huidigId)}</code></td>
          <td class="muted">${esc(r.soort)}</td>
          <td class="muted" style="font-size:10px">${esc(String(r.vinger || '—').slice(0, 28))}</td>
          <td class="muted" style="font-size:11px">${esc(r.entiteit)}${
            r.wijstNaar ? '<br><span style="font-size:10px">' + esc(String(r.wijstNaar).slice(0, 44)) + '</span>' : ''}</td>
          <td class="${r.d1 === 'JA' ? 'neg' : 'muted'}">${esc(r.d1)}</td>
          <td>${r.nieuwId ? '<code>' + esc(r.huidigId) + ' → ' + esc(r.nieuwId) + '</code>' : '—'}</td>
          <td style="padding-right:16px"><span class="${kleur(r.oordeel)}" style="font-weight:600">${esc(r.oordeel)}</span>
            <br><span class="muted" style="font-size:10px">${esc(String(r.toelichting).slice(0, 46))}</span></td>
        </tr>`).join('')}</tbody>
      </table></div></div>`
      : '<div class="card"><p class="ctrl-uitleg" style="margin:0">De negeerlijst is leeg. Er is niets dat D1 kan raken.</p></div>'}

      <div class="modal-actions">
        <button class="btn" onclick="maakOpslagSnapshot()">Terug naar de snapshot</button>
        <button class="btn" id="diag-kopieer" onclick="kopieerOpslagDiagnose()">Resultaten kopiëren</button>
        <button class="btn btn-primary" onclick="downloadNegeerBestanden()">Negeerlijst downloaden (JSON + CSV)</button>
      </div>
      <textarea id="diag-tekst" readonly style="width:100%;height:240px;margin-top:var(--spacing-3);
        font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
        border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(laatsteTekst)}</textarea>`;
  } catch (e) {
    el('diag-inhoud').innerHTML = `<div class="alert alert-error">Uitlezen mislukt: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  } finally {
    if (knop) knop.disabled = false;
  }
}

export async function downloadNegeerBestanden() {
  try {
    const uit = await downloadNegeerlijst();
    const b = el('diag-inhoud').querySelector('.alert');
    if (b) b.innerHTML += `<br>Twee bestanden gedownload: JSON en CSV, ${uit.csvRegels} regels. Er is niets geschreven.`;
  } catch (e) {
    const b = el('diag-inhoud').querySelector('.alert');
    if (b) b.innerHTML += `<br><strong>Downloaden mislukt:</strong> ${esc(e.message)}`;
  }
}

/** Zet de volledige opslag als bestand op je schijf. Schrijft niets terug. */
export async function downloadBackup() {
  const knop = el('diag-backup');
  if (knop) { knop.disabled = true; knop.textContent = 'Bezig…'; }
  try {
    const uit = await backupBestand();
    try { localStorage.setItem('xtenate_laatste_backup', new Date().toISOString()); } catch { /* niet erg */ }
    const r = ['VOLLEDIGE RESERVEKOPIE — ' + new Date().toLocaleString('nl-NL'),
      'bestand: ' + uit.naam, 'sleutels: ' + uit.sleutels, 'omvang: ' + uit.tekens + ' tekens',
      'TOTALE CHECKSUM: ' + uit.som, '',
      'sleutel'.padEnd(32) + 'structuur'.padEnd(18) + 'records'.padStart(8) + 'tekens'.padStart(9) + '  SHA-256'];
    Object.entries(uit.per).forEach(([s, x]) =>
      r.push('   ' + s.padEnd(32) + String(x.vorm).padEnd(18) + String(x.records ?? '-').padStart(8)
        + String(x.tekens).padStart(9) + '  ' + x.som));
    laatsteTekst = r.join('\n');

    el('diag-inhoud').innerHTML = `
      <div class="alert alert-ok">
        Reservekopie gedownload als <code>${esc(uit.naam)}</code> —
        <strong>${uit.sleutels} sleutels</strong>, ${(uit.tekens / 1024).toFixed(1)} kB.
        <strong>Er is niets naar de opslag geschreven.</strong>
        <br>Totale checksum van het bestand: <code>${esc(uit.som)}</code>
        <br>Controleer je downloadmap voordat je verdergaat. Dit bestand bevat élke sleutel,
        ook de zeven die buiten de normale reservekopie vallen.
      </div>
      <div class="section-head"><div class="eyebrow">Wat er in het bestand zit</div></div>
      <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
        <thead><tr><th style="padding-left:16px">Sleutel</th><th>Structuur</th>
          <th style="text-align:right">Records</th><th style="text-align:right">Tekens</th>
          <th style="padding-right:16px">SHA-256</th></tr></thead>
        <tbody>${Object.entries(uit.per).map(([s, x]) => `<tr>
          <td style="padding-left:16px"><code>${esc(s)}</code></td>
          <td class="muted">${esc(x.vorm)}</td>
          <td style="text-align:right">${x.records ?? '—'}</td>
          <td style="text-align:right" class="muted">${x.tekens}</td>
          <td class="muted" style="font-size:10px;padding-right:16px">${esc(x.som)}</td>
        </tr>`).join('')}</tbody>
      </table></div></div>
      <div class="modal-actions">
        <button class="btn" onclick="downloadBackup()">Opnieuw downloaden</button>
        <button class="btn btn-primary" id="diag-kopieer" onclick="kopieerOpslagDiagnose()">Overzicht kopiëren</button>
      </div>
      <textarea id="diag-tekst" readonly style="width:100%;height:260px;margin-top:var(--spacing-3);
        font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
        border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)">${esc(laatsteTekst)}</textarea>`;
  } catch (e) {
    el('diag-inhoud').innerHTML = `<div class="alert alert-error">De reservekopie kon niet worden gemaakt: ${esc(e.message)}. Er is niets gewijzigd.</div>`;
  } finally {
    if (knop) { knop.disabled = false; knop.textContent = 'Volledige backup downloaden'; }
  }
}

export async function kopieerOpslagDiagnose() {
  const knop = el('diag-kopieer');
  const vak = el('diag-tekst');
  try {
    await navigator.clipboard.writeText(laatsteTekst);
    knop.textContent = 'Gekopieerd';
    setTimeout(() => { knop.textContent = 'Resultaten kopiëren'; }, 2500);
  } catch {
    // Kopiëren mag niet altijd zomaar; dan selecteren we de tekst zodat je
    // hem met Ctrl+C zelf kunt pakken.
    vak.focus();
    vak.select();
    knop.textContent = 'Druk nu Ctrl+C';
  }
}
