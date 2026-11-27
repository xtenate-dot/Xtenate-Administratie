// hnvi-veilingen.js — veilingen naast elkaar: resultaat, kosten en rendement per veiling.
//
// Een veiling is hier alle loten met dezelfde inkoopdatum. Het is alleen een weergave:
// de loten en boekingen worden niet aangepast. De inkoopprijs van een lot is het bod
// plus opgeld en btw. Kosten buiten het lot (vervoer, verzending) vul je zelf in per
// veiling; die staan los opgeslagen en tellen alleen hier mee.

import { state, zetVeilingKosten } from './storage.js?v=20261127d';
import { esc, fmt } from './helpers.js?v=20261127d';
import { splitsLoten, lotAantal } from './hnvilot.js?v=20261127d';

const el = id => document.getElementById(id);
const rond = n => Math.round(n * 100) / 100;
const pct = x => x === null ? '—' : (x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + '%';
const datum = iso => iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—';

const dagen = (van, tot) => {
  const a = Date.parse(van + 'T12:00:00Z'), b = Date.parse(tot + 'T12:00:00Z');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
};

/**
 * Groepeert de loten per inkoopdatum en rekent per veiling door.
 * Een gedeeltelijk verkocht lot telt met een evenredig deel van de inkoop als verkocht
 * (zoals splitsLoten dat ook op de HNVI-pagina doet).
 */
export function veilingOverzicht(loten, extraKosten = {}) {
  const groepen = new Map();
  for (const l of loten || []) {
    const d = String(l.datum || '').slice(0, 10);
    if (!d) continue;
    if (!groepen.has(d)) groepen.set(d, []);
    groepen.get(d).push(l);
  }
  const uit = [];
  for (const [d, lijst] of groepen) {
    const delen = splitsLoten(lijst);
    const verkocht = delen.filter(x => x.status === 'verkocht');
    const voorraad = delen.filter(x => x.status !== 'verkocht');
    const inkoopTotaal = rond(delen.reduce((s, x) => s + (Number(x.inkoop) || 0), 0));
    const inkoopVerkocht = rond(verkocht.reduce((s, x) => s + (Number(x.inkoop) || 0), 0));
    const opbrengst = rond(verkocht.reduce((s, x) => s + (Number(x.verkoop) || 0), 0));
    const extra = Number(extraKosten[d]) || 0;
    const winst = rond(opbrengst - inkoopVerkocht);
    const resultaat = rond(winst - extra);
    const dagenLijst = verkocht.map(x => x.verkoopDatum ? dagen(d, String(x.verkoopDatum).slice(0, 10)) : null).filter(x => x !== null && x >= 0);
    const stuks = lijst.reduce((s, x) => s + lotAantal(x), 0);
    const stuksVerkocht = verkocht.reduce((s, x) => s + lotAantal(x), 0);
    uit.push({
      datum: d, loten: lijst.length, stuks, stuksVerkocht,
      facturen: [...new Set(lijst.map(x => x.factuur).filter(Boolean))],
      inkoopTotaal, inkoopVerkocht, opbrengst, winst, extra, resultaat,
      voorraadWaarde: rond(voorraad.reduce((s, x) => s + (Number(x.inkoop) || 0), 0)),
      rendement: inkoopVerkocht > 0 ? winst / inkoopVerkocht : null,
      rendementNetto: inkoopVerkocht > 0 ? resultaat / inkoopVerkocht : null,
      verkochtPct: inkoopTotaal > 0 ? inkoopVerkocht / inkoopTotaal : null,
      gemDagen: dagenLijst.length ? dagenLijst.reduce((s, x) => s + x, 0) / dagenLijst.length : null,
      verliesLoten: verkocht.filter(x => (Number(x.verkoop) || 0) < (Number(x.inkoop) || 0)).length
    });
  }
  return uit.sort((a, b) => b.datum.localeCompare(a.datum));
}

export function veilingTotaal(rijen) {
  const som = v => rond(rijen.reduce((s, r) => s + r[v], 0));
  const t = {
    veilingen: rijen.length, loten: rijen.reduce((s, r) => s + r.loten, 0),
    inkoopTotaal: som('inkoopTotaal'), inkoopVerkocht: som('inkoopVerkocht'), opbrengst: som('opbrengst'),
    winst: som('winst'), extra: som('extra'), resultaat: som('resultaat'), voorraadWaarde: som('voorraadWaarde')
  };
  t.rendement = t.inkoopVerkocht > 0 ? t.winst / t.inkoopVerkocht : null;
  t.rendementNetto = t.inkoopVerkocht > 0 ? t.resultaat / t.inkoopVerkocht : null;
  t.verkochtPct = t.inkoopTotaal > 0 ? t.inkoopVerkocht / t.inkoopTotaal : null;
  return t;
}

const tint = r => r === null ? 'krap' : r < 0 ? 'verlies' : r < 0.1 ? 'krap' : r < 0.3 ? 'redelijk' : 'goed';
const kleur = n => n > 0 ? 'var(--semantic-success-bright)' : n < 0 ? 'var(--semantic-danger-bright)' : 'inherit';
const plus = n => (n > 0 ? '+' : '') + fmt(n);

function balk(r) {
  if (r === null) return '<span class="muted">—</span>';
  const breed = Math.max(0, Math.min(100, Math.abs(r) / 0.6 * 100));
  return `<div class="mg-balk"><div class="mg-balk-spoor"><div class="mg-balk-vul mg-${tint(r)}" style="width:${breed}%"></div></div>
    <span class="mg-balk-pct">${pct(r)}</span></div>`;
}

export function veilingExcelRijen(rijen) {
  const kop = ['Veiling (inkoopdatum)', 'Facturen', 'Loten', 'Stuks', 'Stuks verkocht', 'Inkoop totaal', 'Inkoop verkocht', 'Opbrengst',
    'Winst voor extra kosten', 'Extra kosten', 'Resultaat', 'Rendement', 'Verkocht (% van inkoop)', 'Voorraadwaarde', 'Gem. dagen tot verkoop'];
  const data = rijen.map(r => [r.datum, r.facturen.join(', '), r.loten, r.stuks, r.stuksVerkocht, r.inkoopTotaal, r.inkoopVerkocht, r.opbrengst,
    r.winst, r.extra, r.resultaat, r.rendementNetto === null ? '' : Math.round(r.rendementNetto * 1000) / 1000,
    r.verkochtPct === null ? '' : Math.round(r.verkochtPct * 1000) / 1000, r.voorraadWaarde, r.gemDagen === null ? '' : Math.round(r.gemDagen)]);
  return [kop, ...data];
}

export function renderVeilingVergelijk() {
  const doel = el('hnvi-veilingen');
  if (!doel) return;
  const jaar = state.huidigJaar === 'all' ? '' : (state.huidigJaar || '');
  const loten = state.HNVI_LOTS.filter(l => !jaar || String(l.datum || '').startsWith(jaar));
  const rijen = veilingOverzicht(loten, state.VEILING_KOSTEN || {});
  if (!rijen.length) { doel.innerHTML = ''; return; }
  const t = veilingTotaal(rijen);
  const beste = rijen.filter(r => r.rendementNetto !== null).sort((a, b) => b.rendementNetto - a.rendementNetto)[0];
  const slechtste = rijen.filter(r => r.rendementNetto !== null).sort((a, b) => a.rendementNetto - b.rendementNetto)[0];

  const body = rijen.map(r => `<tr>
    <td data-label="Veiling"><b>${esc(datum(r.datum))}</b>${r.facturen.length ? `<div class="muted" style="font-size:11px">factuur ${esc(r.facturen.join(', '))}</div>` : ''}</td>
    <td style="text-align:right" data-label="Loten">${r.loten}<div class="muted" style="font-size:11px">${r.stuksVerkocht} van ${r.stuks} stuks verkocht</div></td>
    <td style="text-align:right" data-label="Inkoop">${fmt(r.inkoopTotaal)}</td>
    <td style="text-align:right" data-label="Opbrengst">${r.opbrengst > 0 ? fmt(r.opbrengst) : '—'}</td>
    <td style="text-align:right" data-label="Extra kosten"><input type="text" inputmode="decimal" class="mg-inp" style="width:78px;text-align:right"
      value="${r.extra ? String(r.extra).replace('.', ',') : ''}" placeholder="0" aria-label="Extra kosten voor veiling ${esc(datum(r.datum))}"
      onchange="zetVeilingExtraKosten('${esc(r.datum)}', this.value)"></td>
    <td style="text-align:right;font-weight:600;color:${kleur(r.resultaat)}" data-label="Resultaat">${r.inkoopVerkocht > 0 || r.extra ? plus(r.resultaat) : '—'}</td>
    <td data-label="Rendement">${balk(r.rendementNetto)}</td>
    <td style="text-align:right" data-label="Verkocht">${pct(r.verkochtPct)}</td>
    <td style="text-align:right" data-label="Op voorraad">${r.voorraadWaarde > 0 ? fmt(r.voorraadWaarde) : '—'}</td>
    <td style="text-align:right" data-label="Dagen">${r.gemDagen === null ? '—' : Math.round(r.gemDagen)}</td>
  </tr>`).join('');

  doel.innerHTML = `
    <div class="mg-sectiekop"><h3>Veilingen vergeleken</h3>
      <button type="button" class="btn" onclick="exporteerVeilingen()" title="Dit overzicht als Excel-bestand">Excel</button></div>
    <div class="kpi-grid" style="margin-bottom:var(--spacing-3)">
      <div class="kpi"><div class="kpi-lbl">Veilingen</div><div class="kpi-val">${t.veilingen}</div><div class="kpi-sub">${t.loten} loten</div></div>
      <div class="kpi"><div class="kpi-lbl">Resultaat tot nu toe</div><div class="kpi-val" style="color:${kleur(t.resultaat)}">${plus(t.resultaat)}</div><div class="kpi-sub">${t.extra ? 'na ' + fmt(t.extra) + ' extra kosten' : 'verkocht min inkoop'}</div></div>
      <div class="kpi"><div class="kpi-lbl">Rendement</div><div class="kpi-val">${pct(t.rendementNetto)}</div><div class="kpi-sub">resultaat t.o.v. inkoop van het verkochte</div></div>
      <div class="kpi"><div class="kpi-lbl">Nog op voorraad</div><div class="kpi-val">${fmt(t.voorraadWaarde)}</div><div class="kpi-sub">tegen inkoopprijs</div></div>
    </div>
    <div class="card card-flush"><div class="table-wrap"><table class="tbl-compact"><thead><tr>
      <th>Veiling</th><th style="text-align:right">Loten</th><th style="text-align:right">Inkoop</th><th style="text-align:right">Opbrengst</th>
      <th style="text-align:right" title="Bijkomende kosten van deze veiling die niet in de inkoopprijs zitten, zoals vervoer of verzending.">Extra kosten</th>
      <th style="text-align:right">Resultaat</th><th>Rendement</th><th style="text-align:right">Verkocht</th>
      <th style="text-align:right">Op voorraad</th><th style="text-align:right" title="Gemiddeld aantal dagen tussen inkoop en verkoop">Dagen</th>
    </tr></thead><tbody>${body}
      <tr style="font-weight:600;background:var(--accent-softer)"><td>Totaal</td><td style="text-align:right">${t.loten}</td><td style="text-align:right">${fmt(t.inkoopTotaal)}</td>
        <td style="text-align:right">${fmt(t.opbrengst)}</td><td style="text-align:right">${t.extra ? fmt(t.extra) : '—'}</td>
        <td style="text-align:right;color:${kleur(t.resultaat)}">${plus(t.resultaat)}</td><td>${balk(t.rendementNetto)}</td>
        <td style="text-align:right">${pct(t.verkochtPct)}</td><td style="text-align:right">${fmt(t.voorraadWaarde)}</td><td></td></tr>
    </tbody></table></div></div>
    <div class="muted" style="font-size:12.5px;margin:var(--spacing-2) 0 var(--spacing-4);line-height:1.55">
      Een veiling is alle loten met dezelfde inkoopdatum${jaar ? ` (boekjaar ${esc(jaar)})` : ''}. De inkoopprijs is het bod plus opgeld en btw.
      Het resultaat telt alleen wat al verkocht is, min de extra kosten die je zelf invult. Dat is dus een tussenstand zolang er nog voorraad ligt.
      ${beste && slechtste && beste !== slechtste ? `Beste rendement: ${esc(datum(beste.datum))} (${pct(beste.rendementNetto)}), laagste: ${esc(datum(slechtste.datum))} (${pct(slechtste.rendementNetto)}).` : ''}
    </div>`;
}

export function zetVeilingExtraKosten(d, waarde) {
  const n = parseFloat(String(waarde).replace(',', '.'));
  zetVeilingKosten(d, Number.isFinite(n) && n > 0 ? n : 0);
  renderVeilingVergelijk();
}

export function exporteerVeilingen() {
  const jaar = state.huidigJaar === 'all' ? '' : (state.huidigJaar || '');
  const loten = state.HNVI_LOTS.filter(l => !jaar || String(l.datum || '').startsWith(jaar));
  const rijen = veilingOverzicht(loten, state.VEILING_KOSTEN || {});
  if (!rijen.length || !window.XLSX) return;
  const ws = window.XLSX.utils.aoa_to_sheet(veilingExcelRijen(rijen));
  ws['!cols'] = [14, 22, 7, 7, 14, 13, 14, 12, 20, 12, 12, 11, 20, 14, 20].map(wch => ({ wch }));
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Veilingen');
  window.XLSX.writeFile(wb, `Veilingen${jaar ? '-' + jaar : ''}.xlsx`);
}
