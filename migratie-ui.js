// migratie-ui.js — het migratiescherm met de fasen en de uitkomsten.
//
// De fasen lopen van links naar rechts: Voorbereiden, Dry-run, Migreren,
// Controleren, Geslaagd. Een fase gaat pas open als de vorige is afgerond.
// Migreren is in deze versie nog niet gebouwd en blijft dus op slot.

import { maakVolledigeReservekopie, beschikbareJaren } from './export.js?v=20261024m';
import { alsTekst, diagnose, diagnoseAlsTekst, dryRun } from './migratie.js?v=20261024m';
import { herstelPreview } from './herstel.js?v=20261024m';

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const geld = n => '€ ' + Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const FASEN = ['Voorbereiden', 'Dry-run', 'Herstellen', 'Migreren', 'Controleren', 'Geslaagd'];
let fase = 0;
let reservekopieGemaakt = false;
let dryRunGoed = false;
let bezig = false;
let laatsteUitkomst = null;
let laatstePreview = null;

function renderFasen() {
  el('mig-fasen').innerHTML = FASEN.map((naam, i) => `
    <div class="mig-fase ${i < fase ? 'klaar' : i === fase ? 'bezig' : 'wacht'}">
      <span class="mig-bol">${i < fase ? '✓' : i + 1}</span>
      <span>${naam}</span>
    </div>`).join('<span class="mig-pijl">→</span>');
}

// ------------------------------------------------------- 1. voorbereiden

function renderVoorbereiden() {
  const jaren = beschikbareJaren().slice().sort();
  el('mig-inhoud').innerHTML = `
    <div class="alert alert-info">
      Voordat er iets verandert maak je een reservekopie in Excel. Dat is je terugweg, en die staat buiten de app en buiten Supabase.
    </div>
    <p class="ctrl-uitleg">Je krijgt ${jaren.length} bestanden, één per boekjaar: ${jaren.join(', ')}. Elk bestand is los terug te importeren. Je browser vraagt mogelijk of hij meerdere bestanden mag opslaan; sta dat toe.</p>
    <div id="mig-backup-status"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="mig-backup-knop" onclick="maakReservekopie()">Reservekopie downloaden</button>
      <button class="btn" id="mig-naar-dryrun" onclick="naarDryRun()" ${reservekopieGemaakt ? '' : 'disabled'}>Verder naar de dry-run</button>
    </div>`;
}

export async function maakReservekopie() {
  if (bezig) return;
  bezig = true;
  const knop = el('mig-backup-knop');
  knop.disabled = true;
  try {
    await maakVolledigeReservekopie((jaar, klaar, totaal) => {
      el('mig-backup-status').innerHTML =
        `<div class="alert alert-info">Bezig: ${klaar} van ${totaal} bestanden — zojuist Administratie_${jaar}.xlsx</div>`;
    });
    reservekopieGemaakt = true;
    el('mig-backup-status').innerHTML =
      `<div class="alert alert-ok">Alle bestanden gedownload. Controleer je downloadmap voordat je verdergaat.</div>`;
    el('mig-naar-dryrun').disabled = false;
  } catch (e) {
    el('mig-backup-status').innerHTML =
      `<div class="alert alert-error">De reservekopie kon niet worden gemaakt: ${esc(e.message)}</div>`;
  } finally {
    bezig = false;
    knop.disabled = false;
    knop.textContent = 'Opnieuw downloaden';
  }
}

export function naarDryRun() {
  fase = 1;
  renderFasen();
  renderDryRunStart();
}

// ------------------------------------------------------------ 2. dry-run

function renderDryRunStart() {
  el('mig-inhoud').innerHTML = `
    <div class="alert alert-info">
      De proefmigratie leest je administratie en de stand in Supabase, en laat zien wat er zou gebeuren. <strong>Er wordt niets weggeschreven.</strong>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="terugNaarVoorbereiden()">Terug</button>
      <button class="btn btn-primary" onclick="startDryRun()">Proefmigratie starten</button>
    </div>`;
}

export function terugNaarVoorbereiden() { fase = 0; renderFasen(); renderVoorbereiden(); }

export async function startDryRun() {
  if (bezig) return;
  bezig = true;
  el('mig-inhoud').innerHTML = '<p class="ctrl-uitleg">Bezig met vergelijken…</p>';
  try {
    const uitkomst = await dryRun();
    dryRunGoed = !uitkomst.heeftFouten && !uitkomst.fout;
    laatsteUitkomst = uitkomst;
    renderDryRunUitkomst(uitkomst);
  } catch (e) {
    el('mig-inhoud').innerHTML =
      `<div class="alert alert-error">De proefmigratie kon niet worden uitgevoerd: ${esc(e.message)}</div>
       <div class="modal-actions"><button class="btn" onclick="terugNaarVoorbereiden()">Terug</button></div>`;
  } finally {
    bezig = false;
  }
}

function renderDryRunUitkomst({ plan, totalen, waarschuwingen, regels, inDatabase, fout, heeftFouten }) {
  const tabelRij = r => `
    <tr>
      <td style="padding-left:16px">${esc(r.tabel)}</td>
      <td style="text-align:right;font-weight:600">${r.toevoegen}</td>
      <td style="text-align:right" class="muted">${inDatabase?.[r.tabel] ?? '—'}</td>
      <td class="muted" style="padding-right:16px;font-size:11px">${esc(r.toelichting)}</td>
    </tr>`;

  const jaarRij = j => `
    <tr>
      <td style="padding-left:16px">${j.jaar}</td>
      <td style="text-align:right">${j.aantal}</td>
      <td style="text-align:right" class="pos">${geld(j.excelOmzet ?? j.omzet)}</td>
      <td style="text-align:right" class="neg">${geld(j.excelKosten ?? j.kosten)}</td>
      <td style="text-align:right" class="muted">${geld(j.excelPriveOp ?? j.priveOp)}</td>
      <td style="text-align:right" class="muted">${geld(j.excelPriveSt ?? j.priveSt)}</td>
      <td style="text-align:right;padding-right:16px">${geld(j.ib)}</td>
    </tr>`;

  const waarschuwingBlok = w => `
    <div class="ctrl-regel ctrl-${w.ernst === 'fout' ? 'fout' : 'waarschuwing'}">
      <div class="ctrl-kop" style="cursor:default">
        <span class="ctrl-icoon">${w.ernst === 'fout' ? '✕' : '!'}</span>
        <span class="ctrl-titel">${esc(w.titel)} — ${w.aantal}
          <span class="ctrl-item-sub" style="display:block">${esc(w.uitleg)}</span>
          ${w.voorbeelden.length ? `<span class="ctrl-item-sub" style="display:block">Bijvoorbeeld: ${esc(w.voorbeelden.join(' · '))}</span>` : ''}
        </span>
      </div>
    </div>`;

  el('mig-inhoud').innerHTML = `
    ${fout ? `<div class="alert alert-error">De stand in Supabase kon niet worden opgehaald: ${esc(fout)}</div>` : ''}
    ${heeftFouten
      ? `<div class="alert alert-error">Er zijn punten die de migratie zouden laten mislukken. Los die eerst op.</div>`
      : `<div class="alert alert-ok">Het plan is compleet en er zijn geen blokkerende punten gevonden.</div>`}

    <div class="section-head"><div class="eyebrow">Wat er zou worden overgezet</div></div>
    <div class="card card-flush">
      <div class="table-wrap"><table class="tbl-compact">
        <thead><tr>
          <th style="padding-left:16px">Onderdeel</th>
          <th style="text-align:right;width:80px">Erbij</th>
          <th style="text-align:right;width:70px">Nu in DB</th>
          <th style="padding-right:16px">Toelichting</th>
        </tr></thead>
        <tbody>${regels.map(tabelRij).join('')}</tbody>
      </table></div>
    </div>

    <div class="section-head"><div class="eyebrow">Financiële totalen per jaar</div></div>
    <div class="card card-flush">
      <div class="table-wrap"><table class="tbl-compact">
        <thead><tr>
          <th style="padding-left:16px">Jaar</th>
          <th style="text-align:right">Boekingen</th>
          <th style="text-align:right">Omzet</th>
          <th style="text-align:right">Kosten</th>
          <th style="text-align:right">Privé op</th>
          <th style="text-align:right">Privé st</th>
          <th style="text-align:right;padding-right:16px">Geschatte IB</th>
        </tr></thead>
        <tbody>${totalen.perJaar.map(jaarRij).join('')}</tbody>
      </table></div>
    </div>

    <div class="section-head"><div class="eyebrow">Voorraad en saldo</div></div>
    <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Banksaldo</div><div class="kpi-val">${geld(totalen.banksaldo)}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Voorraadwaarde artikelen</div><div class="kpi-val">${geld(totalen.voorraadwaardeArtikelen)}</div><div class="kpi-sub">${totalen.artikelenZonderKostprijs} zonder kostprijs</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Stuks op voorraad</div><div class="kpi-val">${totalen.voorraadStuks}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">HNVI in voorraad</div><div class="kpi-val">${geld(totalen.hnviVoorraadwaarde)}</div><div class="kpi-sub">${totalen.hnviInVoorraad} loten</div></div>
    </div>

    ${waarschuwingen.length ? `
      <div class="section-head"><div class="eyebrow">Aandachtspunten</div></div>
      <div class="card card-flush">${waarschuwingen.map(waarschuwingBlok).join('')}</div>` : ''}

    <div class="alert alert-info" style="margin-top:var(--spacing-4)">
      Er is niets weggeschreven. De volgende fase, de daadwerkelijke migratie, is nog niet gebouwd — die komt pas als je akkoord geeft op deze cijfers.
    </div>

    <div class="modal-actions">
      <button class="btn" onclick="terugNaarVoorbereiden()">Terug</button>
      <button class="btn" onclick="startDryRun()">Opnieuw uitvoeren</button>
      <button class="btn" id="mig-kopieer" onclick="kopieerDryRun()">Resultaten kopiëren</button>
      <button class="btn" onclick="toonDiagnose()">Diagnose opslag</button>
      <button class="btn" onclick="naarHerstel()">Herstel bekijken</button>
      <button class="btn btn-primary" disabled title="Wordt gebouwd nadat je de cijfers hebt goedgekeurd">Migreren</button>
    </div>
    <textarea id="mig-tekst" readonly style="width:100%;height:150px;margin-top:var(--spacing-3);display:none;
      font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
      border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)"></textarea>`;
}

/** Toont wat er ruw in de opslag van deze browser staat. */
export async function toonDiagnose() {
  const tekst = diagnoseAlsTekst(diagnose());
  const vak = el('mig-tekst');
  vak.value = tekst;
  vak.style.display = '';
  vak.style.height = '320px';
  vak.select();
  try { await navigator.clipboard.writeText(tekst); } catch { /* dan selecteert de gebruiker zelf */ }
}

/** Zet de uitkomst op het klembord, met een tekstvak als terugval. */
export async function kopieerDryRun() {
  if (!laatsteUitkomst) return;
  const tekst = alsTekst(laatsteUitkomst);
  const vak = el('mig-tekst');
  const knop = el('mig-kopieer');
  vak.value = tekst;
  try {
    await navigator.clipboard.writeText(tekst);
    knop.textContent = 'Gekopieerd';
    setTimeout(() => { knop.textContent = 'Resultaten kopiëren'; }, 2500);
  } catch {
    // Kopiëren mag niet altijd zomaar; dan tonen we de tekst om zelf te selecteren.
    vak.style.display = '';
    vak.select();
    knop.textContent = 'Selecteer en kopieer hieronder';
  }
}

// ---------------------------------------------------------- 3. herstellen
//
// Alleen een voorbeeldweergave. Er is geen knop die iets wegschrijft, en de
// module erachter bevat geen enkele schrijfactie.

const bedrag = n => Number(n || 0).toFixed(2);

export function naarHerstel() {
  fase = 2;
  renderFasen();
  renderHerstelPreview();
}

function renderHerstelPreview() {
  const p = herstelPreview();
  laatstePreview = p;

  const jaarRij = j => `
    <tr>
      <td style="padding-left:16px">${j.jaar}</td>
      <td style="text-align:right" class="muted">${j.nu}</td>
      <td style="text-align:right" class="muted">${j.inCode}</td>
      <td style="text-align:right">${j.gekoppeld}</td>
      <td style="text-align:right" class="${j.verschoven ? 'neg' : 'muted'}">${
        j.verschoven ? `${j.verschoven} (${j.verschuiving >= 0 ? '+' : ''}${j.verschuiving} dag)` : '—'}</td>
      <td style="text-align:right">${j.eigen}</td>
      <td style="text-align:right" class="muted">${j.ontbrekend}</td>
      <td style="text-align:right;font-weight:600;padding-right:16px">${j.na}</td>
    </tr>`;

  const controleRij = c => `
    <div class="ctrl-item">
      <span class="ctrl-item-main" style="cursor:default">
        <span class="ctrl-item-label">${c.goed === null ? '·' : c.goed ? '✓' : '✕'} ${esc(c.titel)}</span>
      </span>
      <span class="${c.goed === false ? 'neg' : 'muted'}" style="font-size:11.5px;padding-right:12px">${esc(c.waarde)}</span>
    </div>`;

  const jtRij = t => `
    <tr>
      <td style="padding-left:16px">${t.jaar}</td>
      <td style="text-align:right;font-weight:600">${t.nu ? bedrag(t.nu.priveOp) : '—'}</td>
      <td style="text-align:right;font-weight:600">${t.nu ? bedrag(t.nu.priveSt) : '—'}</td>
      <td style="text-align:right" class="muted">${bedrag(t.berekend.priveOp)}</td>
      <td style="text-align:right;padding-right:16px" class="${
        t.afwijking && Math.abs(t.afwijking.priveSt) > 0.01 ? 'neg' : 'muted'}">${bedrag(t.berekend.priveSt)}</td>
    </tr>`;

  const v22 = p.jaren.find(j => j.jaar === '2022') || {};
  const mislukt = p.controles.filter(c => c.goed === false).length;

  el('mig-inhoud').innerHTML = `
    <div class="alert ${mislukt ? 'alert-error' : 'alert-info'}">
      Dit is een voorbeeldweergave. <strong>Er is niets gewijzigd en er kán hier niets worden gewijzigd</strong> —
      de uitvoerende stap is nog niet gebouwd. ${mislukt
        ? `<br><strong>Let op: ${mislukt} controle(s) niet gehaald.</strong> Stuur dit door voordat er iets gebeurt.`
        : ''}
    </div>

    <div class="section-head"><div class="eyebrow">Jouw controlelijst</div></div>
    <div class="card card-flush">${p.controles.map(controleRij).join('')}</div>

    <div class="section-head"><div class="eyebrow">Boekingen per jaar</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr>
        <th style="padding-left:16px">Jaar</th>
        <th style="text-align:right">Nu</th>
        <th style="text-align:right">In code</th>
        <th style="text-align:right">Gekoppeld</th>
        <th style="text-align:right">Datum gecorrigeerd</th>
        <th style="text-align:right">Alleen bij jou</th>
        <th style="text-align:right">Uit code erbij</th>
        <th style="text-align:right;padding-right:16px">Na herstel</th>
      </tr></thead>
      <tbody>${p.jaren.map(jaarRij).join('')}
        <tr style="border-top:1px solid var(--border-strong)">
          <td style="padding-left:16px;font-weight:600">Historie</td>
          <td style="text-align:right" class="muted">${p.jaren.reduce((s, j) => s + j.nu, 0)}</td>
          <td style="text-align:right" class="muted">${p.jaren.reduce((s, j) => s + j.inCode, 0)}</td>
          <td colspan="4"></td>
          <td style="text-align:right;font-weight:600;padding-right:16px">${p.historieNa}</td>
        </tr>
      </tbody>
    </table></div></div>
    <p class="ctrl-uitleg">De gekoppelde boekingen krijgen de datum uit de code, want die is juist —
      bevestigd tegen je bankafschrift. De regels die alleen bij jou staan krijgen dezelfde correctie mee,
      omdat ze uit dezelfde import komen en dus dezelfde fout dragen.</p>

    <div class="section-head"><div class="eyebrow">De 13 regels die alleen bij jou staan</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th style="padding-left:16px">Stond op</th><th>Wordt</th>
        <th style="text-align:right">Bedrag</th><th>Soort</th><th style="padding-right:16px">Naam</th></tr></thead>
      <tbody>${(v22.eigenVoorbeelden || []).map(t => `<tr>
        <td style="padding-left:16px" class="muted">${esc(t.datumWas || t.datum)}</td>
        <td class="pos">${esc(t.datum)}</td>
        <td style="text-align:right">${bedrag(t.bedrag)}</td>
        <td class="muted">${esc(t.type)}</td>
        <td class="muted" style="font-size:11px;padding-right:16px">${esc(String(t.naam || '').slice(0, 46))}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>

    <div class="section-head"><div class="eyebrow">Identieke boekingen die echt meerdere keren bestaan</div></div>
    <div class="card card-flush">${p.jaren.flatMap(j => j.dubbelen.map(d => `
      <div class="ctrl-item">
        <span class="ctrl-item-main" style="cursor:default">
          <span class="ctrl-item-label">${d.aantal}× ${esc(beschrijfRegel(d.voorbeeld))}</span>
          <span class="ctrl-item-sub">${j.jaar} · blijft na herstel ${d.na}×</span>
        </span>
        <span class="${d.na === d.aantal ? 'pos' : 'neg'}" style="padding-right:12px">${
          d.na === d.aantal ? 'behouden' : 'LET OP'}</span>
      </div>`)).join('') || '<p class="ctrl-uitleg" style="margin:0">geen</p>'}</div>

    <div class="section-head"><div class="eyebrow">Het lopende jaar blijft ongemoeid</div></div>
    <div class="card"><p class="ctrl-uitleg" style="margin:0">
      <strong>${p.huidigJaar.aantal} boekingen</strong> in <code>xtenate_tx</code> worden niet aangeraakt.
      Verdeling: ${Object.entries(p.huidigJaar.perJaar).sort().map(([j, n]) => `${j}: ${n}`).join(' · ')}.
      ${p.huidigJaar.buitenHuidigJaar.length ? `<br>Daarvan ${p.huidigJaar.buitenHuidigJaar.length} met een datum buiten 2026:
        ${esc(p.huidigJaar.buitenHuidigJaar.map(t => `${t.datum} ${t.naam} ${bedrag(t.bedrag)}`).join(' · '))}.
        Die blijft staan waar hij staat; verplaatsen naar de historie is een aparte keuze.` : ''}
      ${p.huidigJaar.identiek.length ? `<br>${p.huidigJaar.identiek.length} groepen identieke regels
        (${p.huidigJaar.identiekExtra} boven de eerste) — dat zijn echte boekingen en die blijven allemaal staan.` : ''}
    </p></div>

    <div class="section-head"><div class="eyebrow">Privébedragen per jaar</div></div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact">
      <thead><tr><th style="padding-left:16px">Jaar</th>
        <th style="text-align:right">Opname uit Excel</th><th style="text-align:right">Storting uit Excel</th>
        <th style="text-align:right">Opname uit boekingen</th>
        <th style="text-align:right;padding-right:16px">Storting uit boekingen</th></tr></thead>
      <tbody>${p.jaartotalen.map(jtRij).join('')}</tbody>
    </table></div></div>
    <p class="ctrl-uitleg">De jaartotalen komen uit je Excel en zijn in de app leidend. De laatste twee kolommen
      tellen de boekingen zelf op, zodat een verschil zichtbaar blijft in plaats van verstopt.</p>

    <div class="section-head"><div class="eyebrow">Overig</div></div>
    <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Maandsaldi</div>
        <div class="kpi-val">${p.maandsaldi.nu} → ${p.maandsaldi.na}</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Voorraadartikelen</div>
        <div class="kpi-val">${p.onaangeroerd.voorraadartikelen}</div><div class="kpi-sub">blijft</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">HNVI-loten</div>
        <div class="kpi-val">${p.onaangeroerd.hnviLoten}</div><div class="kpi-sub">blijft</div></div>
      <div class="kpi kpi--secondary"><div class="kpi-lbl">Totaal boekingen</div>
        <div class="kpi-val">${p.totaalNu} → ${p.totaalNa}</div></div>
    </div>

    <div class="modal-actions">
      <button class="btn" onclick="startDryRun()">Terug naar de dry-run</button>
      <button class="btn" id="mig-kopieer" onclick="kopieerHerstelPreview()">Preview kopiëren</button>
      <button class="btn btn-primary" disabled
        title="Wordt pas gebouwd nadat je deze preview hebt goedgekeurd">Herstel uitvoeren</button>
    </div>
    <textarea id="mig-tekst" readonly style="width:100%;height:200px;margin-top:var(--spacing-3);display:none;
      font-family:ui-monospace,monospace;font-size:11px;padding:10px;border:1px solid var(--border-strong);
      border-radius:var(--radius-sm);background:var(--bg-subtle-layer);color:var(--text-primary)"></textarea>`;
}

const beschrijfRegel = t =>
  `${t.datum} · ${t.naam || t.omschr || '(geen naam)'} · ${bedrag(t.bedrag)}`;

/** De preview als platte tekst, om terug te sturen. */
export function herstelPreviewAlsTekst(p) {
  const r = [];
  const q = (...a) => r.push(a.join(' '));
  q('HERSTELPREVIEW XTENATE —', new Date().toLocaleString('nl-NL'), '— er is niets gewijzigd');
  q('');
  q('CONTROLELIJST');
  p.controles.forEach(c => q('  ', c.goed === null ? '·' : c.goed ? '✓' : '✕', c.titel, '—', c.waarde));
  q('');
  q('PER JAAR  jaar | nu | code | gekoppeld | gecorrigeerd | alleen bij jou | uit code erbij | na');
  p.jaren.forEach(j => q('  ', [j.jaar, j.nu, j.inCode, j.gekoppeld,
    `${j.verschoven}(${j.verschuiving >= 0 ? '+' : ''}${j.verschuiving})`, j.eigen, j.ontbrekend, j.na].join(' | ')));
  q('   historie na herstel:', p.historieNa, '| xtenate_tx:', p.huidigJaar.aantal,
    '| totaal:', p.totaalNu, '->', p.totaalNa);
  q('');
  q('ALLEEN BIJ JOU (met datumcorrectie)');
  p.jaren.forEach(j => j.eigenVoorbeelden.forEach(t =>
    q('  ', j.jaar, '|', (t.datumWas || t.datum), '->', t.datum, '|', bedrag(t.bedrag), '|', t.type, '|', t.naam)));
  q('');
  q('IDENTIEKE ECHTE BOEKINGEN');
  p.jaren.forEach(j => j.dubbelen.forEach(d =>
    q('  ', j.jaar, '|', d.aantal + 'x ->', d.na + 'x', '|', beschrijfRegel(d.voorbeeld))));
  q('');
  q('PRIVEBEDRAGEN  jaar | opname uit Excel | storting uit Excel | opname uit boekingen | storting uit boekingen');
  p.jaartotalen.forEach(t => q('  ', [t.jaar, t.nu ? bedrag(t.nu.priveOp) : '-', t.nu ? bedrag(t.nu.priveSt) : '-',
    bedrag(t.berekend.priveOp), bedrag(t.berekend.priveSt)].join(' | ')));
  return r.join('\n');
}

export async function kopieerHerstelPreview() {
  if (!laatstePreview) return;
  const tekst = herstelPreviewAlsTekst(laatstePreview);
  const vak = el('mig-tekst');
  const knop = el('mig-kopieer');
  vak.value = tekst;
  try {
    await navigator.clipboard.writeText(tekst);
    knop.textContent = 'Gekopieerd';
    setTimeout(() => { knop.textContent = 'Preview kopiëren'; }, 2500);
  } catch {
    vak.style.display = '';
    vak.select();
    knop.textContent = 'Selecteer en kopieer hieronder';
  }
}

// -------------------------------------------------------------------- modal

export function openMigratieModal() {
  fase = 0;
  renderFasen();
  renderVoorbereiden();
  el('modal-migratie').classList.add('open');
}

export function sluitMigratieModal() {
  if (bezig) return;
  el('modal-migratie').classList.remove('open');
}
