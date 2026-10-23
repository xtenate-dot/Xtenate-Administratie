// hnvi.js — HNVI/Xtenate voorraadbeheer, inclusief AI-factuurimport.

import { bedragUit, ddmm, esc, fmt, leegVlak } from './helpers.js?v=20261023t';
import { maakSorteerbaar } from './tables.js?v=20261023t';
import { openApiKeyModal } from './modals.js?v=20261023t';
import { saveHnviData, state } from './storage.js?v=20261023t';

/** Globaal boekjaar vertaald naar het hnvi-filter: 'all' betekent hier ''. */
const hnviJaar = () => (state.huidigJaar === 'all' ? '' : (state.huidigJaar || ''));
import { splitsLoten, lotAantal, lotVerkochtStuks } from './hnvilot.js?v=20261023t';
import { saveHnviToSupabase, deleteFromSupabase, addToPendingQueue } from './supabase-client-v2.js?v=20261023t';
import { downloadModelPdf } from './pdf.js?v=20261023t';

/** De loten zoals ze nu op het scherm staan: status- en jaarfilter meegenomen. */
function zichtbareLoten() {
  const st = document.getElementById('f-hnvi-status')?.value || '';
  const jaar = hnviJaar();
  return state.HNVI_LOTS
    .filter(i => {
      if (st && i.status !== st) return false;
      if (jaar && !String(i.datum || '').startsWith(jaar)) return false;
      return true;
    })
    .sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
}

/** Lotenlijst als pdf, met dezelfde filters als het scherm. */
export function exporteerHnviPdf() {
  const st = document.getElementById('f-hnvi-status')?.value || '';
  const jaar = hnviJaar();
  const loten = zichtbareLoten();

  const kolommen = [
    { kop: 'Ingekocht',  breedte: 56 },
    { kop: 'Omschrijving', breedte: 132 },
    { kop: 'Factuur',    breedte: 52 },
    { kop: 'Inkoop',     breedte: 50, rechts: true },
    { kop: 'Verkocht',   breedte: 56 },
    { kop: 'Verkoop',    breedte: 50, rechts: true },
    { kop: 'Resultaat',  breedte: 55, rechts: true },
    { kop: 'Status',     breedte: 32 }
  ];

  let totInkoop = 0, totVerkoop = 0, aantalVerkocht = 0;
  const rijen = loten.map(l => {
    const inkoop = Number(l.inkoop) || 0;
    const verkoop = Number(l.verkoop) || 0;
    totInkoop += inkoop;
    const heeftVerkoop = l.verkoop != null && verkoop > 0;
    if (heeftVerkoop) { totVerkoop += verkoop; aantalVerkocht++; }
    const resultaat = heeftVerkoop ? verkoop - inkoop : null;
    return [
      l.datum ? ddmm(l.datum) : '\u2014',
      l.omschr || '',
      l.factuur || '',
      fmt(inkoop),
      l.verkoopDatum ? ddmm(l.verkoopDatum) : '',
      heeftVerkoop ? fmt(verkoop) : '\u2014',
      resultaat == null ? '\u2014' : (resultaat >= 0 ? '+' : '\u2013') + fmt(Math.abs(resultaat)),
      l.status === 'verkocht' ? 'verk.' : 'vrd.'
    ];
  });

  const resultaat = totVerkoop - loten
    .filter(l => l.verkoop != null && Number(l.verkoop) > 0)
    .reduce((s, l) => s + (Number(l.inkoop) || 0), 0);

  rijen.push({
    vet: true, streep: true,
    cellen: ['Totaal', `${loten.length} loten`, '', fmt(totInkoop), '', fmt(totVerkoop),
             (resultaat >= 0 ? '+' : '\u2013') + fmt(Math.abs(resultaat)), '']
  });

  const inVoorraad = loten.filter(l => l.status !== 'verkocht');
  const waardeVoorraad = inVoorraad.reduce((s, l) => s + (Number(l.inkoop) || 0), 0);

  const d = new Date();
  const vandaag = `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
  const filters = [jaar ? `boekjaar ${jaar}` : 'alle jaren',
                   st ? (st === 'verkocht' ? 'alleen verkocht' : 'alleen op voorraad') : 'alle statussen'];

  downloadModelPdf({
    titel: 'Veiling: inkopen en verkopen',
    ondertitel: `${filters.join(' \u00b7 ')} \u00b7 opgemaakt op ${vandaag}`,
    blokken: [
      { type: 'tabel', kolommen, rijen },
      { type: 'kop', tekst: 'Samenvatting' },
      { type: 'regel', label: `Inkoopwaarde nog op voorraad (${inVoorraad.length} loten)`, bedrag: waardeVoorraad },
      { type: 'regel', label: `Opbrengst verkochte loten (${aantalVerkocht} loten)`, bedrag: totVerkoop },
      { type: 'regel', label: 'Resultaat op verkochte loten', bedrag: resultaat, totaal: true },
      { type: 'voet', tekst: 'Het resultaat is de opbrengst min de inkoopprijs van alleen de loten die verkocht zijn. Loten die nog op voorraad liggen tellen daar niet in mee; die staan als voorraadwaarde op de balans.' }
    ]
  }, jaar ? `Veiling_${jaar}.pdf` : 'Veiling_alle_jaren.pdf');
}

export function renderHNVI() {
  const st = document.getElementById('f-hnvi-status').value;
  const jaar = hnviJaar();
  const list = state.HNVI_LOTS.filter(i => {
    if (st && i.status !== st) return false;
    if (jaar && !i.datum.startsWith(jaar)) return false;
    return true;
  }).sort((a,b)=>b.datum.localeCompare(a.datum));

  const delen = splitsLoten(state.HNVI_LOTS);   // gedeeltelijk verkochte loten in verkocht- en voorraaddeel
  const vrd = delen.filter(i=>i.status==='voorraad');

  // Gefilterd op jaar voor inkoop/verkoop totalen
  const gefilterdOpJaar = jaar ? delen.filter(i=>i.datum.startsWith(jaar)) : delen;
  const totInkoop = gefilterdOpJaar.reduce((s,i)=>s+(Number(i.inkoop)||0),0);
  const vktJaar = gefilterdOpJaar.filter(i=>i.status==='verkocht');
  const totVerkoop = vktJaar.reduce((s,i)=>s+(Number(i.verkoop)||0),0);
  const winst = vktJaar.reduce((s,i)=>s+((Number(i.verkoop)||0)-(Number(i.inkoop)||0)),0);

  // Gemiddelde marge over alle verkochte loten (gefilterd)
  // Alleen loten met een echte inkoopprijs tellen mee; delen door nul (of door
  // een vervangende 1) leverde marges van duizenden procenten op.
  const metInkoop = vktJaar.filter(i => Number(i.inkoop) > 0);
  const avg = metInkoop.length
    ? Math.round(metInkoop.reduce((s,i)=>s+((Number(i.verkoop)||0)-Number(i.inkoop))/Number(i.inkoop)*100,0)/metInkoop.length)
    : null;
  const periodeLabel = jaar ? jaar : 'alle jaren';
  document.getElementById('hnvi-metrics').innerHTML = `
    <div class="metric"><div class="lbl">In voorraad</div><div class="val">${vrd.length} loten</div></div>
    <div class="metric"><div class="lbl">Totaal inkoop</div><div class="val neg">${fmt(totInkoop)}</div><div class="sub">${periodeLabel}</div></div>
    <div class="metric"><div class="lbl">Totaal verkoop</div><div class="val pos">${fmt(totVerkoop)}</div><div class="sub">${vktJaar.length} loten · ${periodeLabel}</div></div>
    <div class="metric"><div class="lbl">Winst / verlies</div><div class="val ${winst>=0?'pos':'neg'}">${winst>=0?'+':''}${fmt(winst)}</div></div>
    <div class="metric"><div class="lbl">Gem. marge</div><div class="val ${avg==null?'muted':avg>=0?'pos':'neg'}">${avg==null?'—':avg+'%'}</div><div class="sub">${metInkoop.length} loten met inkoopprijs</div></div>`;

  // Reset checkboxes
  const deleteBtn = document.getElementById('hnvi-delete-btn');
  if (deleteBtn) deleteBtn.style.display = 'none';
  const checkAll = document.getElementById('hnvi-check-all');
  if (checkAll) { checkAll.checked = false; checkAll.indeterminate = false; }

  document.getElementById('hnvi-body').innerHTML = list.length ? list.map(i => {
    // Bij een lot van meerdere stuks waarvan een deel verkocht is, zet je de opbrengst
    // tegenover de inkoop van alleen het verkochte deel.
    const kost = lotAantal(i) > 1 && lotVerkochtStuks(i) > 0
      ? (Number(i.inkoop) || 0) * lotVerkochtStuks(i) / lotAantal(i)
      : (Number(i.inkoop) || 0);
    const w = i.verkoop!=null ? i.verkoop-kost : null;
    const pct = w!=null&&kost ? Math.round(w/kost*100) : null;
    return `<tr>
      <td style="padding-left:16px"><input type="checkbox" class="hnvi-check" data-key="${esc(i._key||i.id)}" onchange="updateHNVIDeleteBtn()"></td>
      <td class="muted" data-v="${esc(i.datum)}">${ddmm(i.datum)}</td>
      <td class="td-trunc">${esc(i.omschr)}${(() => {
        // Factuurnummer en notitie staan klein onder de naam. Het factuurnummer
        // komt uit het veilingblad en helpt een lot terugvinden op de factuur.
        const regels = [];
        if (lotAantal(i) > 1) regels.push(`${lotAantal(i)} stuks · ${lotVerkochtStuks(i)} verkocht`);
        if (i.opbrengstInBank) regels.push('opbrengst staat al in de bank');
        if (i.factuur) regels.push(`factuur ${esc(i.factuur)}`);
        if (i.noot) regels.push(esc(i.noot));
        return regels.length
          ? `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${regels.join(' \u00b7 ')}</div>`
          : '';
      })()}</td>
      <td style="text-align:right" data-v="${Number(i.inkoop)||0}">${fmt(i.inkoop)}${lotAantal(i) > 1 && lotVerkochtStuks(i) > 0 && lotVerkochtStuks(i) < lotAantal(i) ? `<div style="font-size:10px;color:var(--text-secondary)">verkocht deel ${fmt(kost)}</div>` : ''}</td>
      <td style="text-align:right" data-v="${Number(i.verkoop)||0}">${
        i.verkoop!=null&&i.verkoop>0
          ? `${fmt(i.verkoop)}${i.verkoopDatum?`<div style="font-size:10px;color:var(--text-secondary)">${ddmm(i.verkoopDatum)}</div>`:''}`
          : '—'}</td>
      <td style="text-align:right" data-v="${w||0}">${w!=null&&i.verkoop>0?`<span class="${w>=0?'pos':'neg'}">${w>=0?'+':''}${fmt(w)}</span><div style="font-size:10px;color:var(--text-secondary)">${pct}%</div>`:'—'}</td>
      <td data-v="${esc(i.status)}">${i.status==='verkocht'?(lotVerkochtStuks(i) < lotAantal(i) ? '<span class="badge badge-purple">deels verkocht</span>' : '<span class="badge badge-purple">verkocht</span>'):'<span class="badge badge-gray">op voorraad</span>'}</td>
      <td style="white-space:nowrap">
        <span class="sell-link" onclick="openHNVISell('${esc(i.id)}')">${i.status==='voorraad'?'Verkoop':'Wijzig'}</span>
        ${i.status==='verkocht'?`<span class="sell-link" style="color:var(--text-secondary)" onclick="wisHNVIVerkoop('${esc(i.id)}')">Wis</span>`:''}
        <span class="sell-link" style="color:var(--semantic-danger-bright)" onclick="verwijderHNVIItem('${esc(i._key||i.id)}')">Verwijder</span>
      </td>
    </tr>`;
  }).join('') : `<tr data-geen-sort="1"><td colspan="8">${leegVlak(
      state.HNVI_LOTS.length ? 'Geen loten binnen deze filters' : 'Nog geen loten toegevoegd',
      state.HNVI_LOTS.length ? 'Kies een ander jaar of een andere status.' : 'Voeg een lot toe of lees een HNVI-factuur in.',
      '<button class="btn" onclick="openHNVIModal()">Lot toevoegen</button>')}</td></tr>`;

  maakSorteerbaar(document.getElementById('tbl-hnvi'));
}

export function berekenHNVIInkoop() {
  const bod = bedragUit('hn-bod');
  if (bod > 0) {
    const inkoop = Math.round(bod * 1.17 * 1.21 * 100) / 100;
    document.getElementById('hn-ik').value = inkoop.toFixed(2);
  } else {
    document.getElementById('hn-ik').value = '';
  }
}

export function openHNVIModal() {
  state.hnviSellId = null;
  document.getElementById('hnvi-modal-title').textContent = 'Lot toevoegen';
  document.getElementById('hn-save-btn').textContent = 'Opslaan';
  document.getElementById('hn-d').value = state.hnviLaatsteDatum;
  document.getElementById('hn-bod').value = '';
  document.getElementById('hn-ik').value = '';
  document.getElementById('hn-o').value = '';
  document.getElementById('hn-noot').value = '';
  document.getElementById('hn-vk').value = '';
  document.getElementById('hn-vd').value = '';
  document.getElementById('hn-aantal').value = '1';
  document.getElementById('hn-vaantal').value = '';
  document.getElementById('hn-inbank').checked = false;
  document.getElementById('modal-hnvi').classList.add('open');
}

export function openHNVISell(id) {
  state.hnviSellId = id;
  const i = state.HNVI_LOTS.find(x=>String(x.id)===String(id));
  document.getElementById('hnvi-modal-title').textContent = i.status==='verkocht' ? 'Verkoop wijzigen' : 'Verkoop registreren';
  document.getElementById('hn-save-btn').textContent = 'Opslaan';
  document.getElementById('hn-d').value = i.datum;
  document.getElementById('hn-bod').value = '';
  document.getElementById('hn-ik').value = i.inkoop;
  document.getElementById('hn-o').value = i.omschr;
  document.getElementById('hn-noot').value = i.noot || '';
  document.getElementById('hn-vk').value = i.verkoop || '';
  document.getElementById('hn-vd').value = i.verkoopDatum || '';
  document.getElementById('hn-aantal').value = String(lotAantal(i));
  document.getElementById('hn-vaantal').value = i.status === 'verkocht' ? String(lotVerkochtStuks(i)) : '';
  document.getElementById('hn-inbank').checked = !!i.opbrengstInBank;
  document.getElementById('modal-hnvi').classList.add('open');
}

export function closeHNVIModal() { document.getElementById('modal-hnvi').classList.remove('open'); }

export async function saveHNVI() {
  let gewijzigdLot = null;
  
  const vk = bedragUit('hn-vk');
  const vd = document.getElementById('hn-vd').value || null;
  // Aantal stuks en hoeveel daarvan verkocht zijn. Alles verkocht (of leeg
  // gelaten) is de gewone situatie en wordt niet apart bewaard.
  const aantal = Math.max(1, Math.floor(Number(document.getElementById('hn-aantal').value) || 1));
  const vRuw = document.getElementById('hn-vaantal').value;
  let vAantal = vRuw === '' ? null : Math.max(0, Math.min(aantal, Math.floor(Number(vRuw) || 0)));
  if (vk > 0 && vAantal === 0) vAantal = null;
  const deels = vk > 0 && vAantal != null && vAantal < aantal;
  const extra = {
    aantal: aantal > 1 ? aantal : null,
    verkochtAantal: deels ? vAantal : null,
    opbrengstInBank: vk > 0 && document.getElementById('hn-inbank').checked ? true : null
  };
  if (state.hnviSellId) {
    const noot = document.getElementById('hn-noot').value;
    const bestaand = state.HNVI_LOTS.find(i => String(i.id)===String(state.hnviSellId)) || {};
    // Bestaande velden (factuur, _key, ...) blijven staan; alleen wat in het scherm staat verandert.
    gewijzigdLot = {
      ...bestaand,
      id: state.hnviSellId,
      datum: document.getElementById('hn-d').value,
      omschr: document.getElementById('hn-o').value,
      inkoop: bedragUit('hn-ik'),
      verkoop: vk > 0 ? vk : null,
      verkoopDatum: vk > 0 ? vd : null,
      status: vk > 0 ? 'verkocht' : 'voorraad',
      noot,
      ...extra
    };
    state.HNVI_LOTS = state.HNVI_LOTS.map(i => String(i.id)===String(state.hnviSellId) ? gewijzigdLot : i);
  } else {
    const newId = state.nxtHnvi++;
    state.hnviLaatsteDatum = document.getElementById('hn-d').value;
    gewijzigdLot = {
      id: newId,
      _key: String(newId),
      datum: state.hnviLaatsteDatum,
      omschr: document.getElementById('hn-o').value,
      inkoop: bedragUit('hn-ik'),
      verkoop: vk > 0 ? vk : null,
      verkoopDatum: vk > 0 ? vd : null,
      status: vk > 0 ? 'verkocht' : 'voorraad',
      noot: document.getElementById('hn-noot').value,
      ...extra
    };
    state.HNVI_LOTS.push(gewijzigdLot);
  }
  
  saveHnviData();
  
  // Naar Supabase sturen (of wachtrij als offline)
  try {
    const ok = await saveHnviToSupabase(gewijzigdLot);
    if (!ok) addToPendingQueue(gewijzigdLot, 'hnvi', false);
  } catch (err) {
    console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
    addToPendingQueue(gewijzigdLot, 'hnvi', false);
  }
  
  closeHNVIModal();
  renderHNVI();
}

export async function wisHNVIVerkoop(id) {
  if (!window.confirm('Verkoopbedrag verwijderen en lot terug op voorraad zetten?')) return;
  const gewijzigd = state.HNVI_LOTS.find(i => String(i.id)===String(id));
  if (!gewijzigd) return;
  
  const bijgewerkt = {...gewijzigd, verkoop:null, verkoopDatum:null, status:'voorraad', verkochtAantal:null, opbrengstInBank:null};
  state.HNVI_LOTS = state.HNVI_LOTS.map(i => String(i.id)===String(id) ? bijgewerkt : i);
  saveHnviData();
  
  try {
    const ok = await saveHnviToSupabase(bijgewerkt);
    if (!ok) addToPendingQueue(bijgewerkt, 'hnvi', false);
  } catch (err) {
    console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
    addToPendingQueue(bijgewerkt, 'hnvi', false);
  }
  
  renderHNVI();
}

export async function verwijderHNVIItem(key) {
  console.log(`🗑️  verwijderHNVIItem called: key=${key}`);
  
  if (!window.confirm('Dit lot verwijderen?')) {
    console.log('Verwijdering geannuleerd');
    return;
  }
  
  const teVerwijderen = state.HNVI_LOTS.find(i => String(i._key||i.id) === String(key));
  console.log(`Found lot to delete:`, teVerwijderen);
  
  if (!teVerwijderen) {
    console.warn('Lot niet gevonden!');
    return;
  }
  
  state.HNVI_LOTS = state.HNVI_LOTS.filter(i => String(i._key||i.id) !== String(key));
  saveHnviData();
  console.log(`Removed from state, calling deleteFromSupabase...`);
  
  try {
    const ok = await deleteFromSupabase(teVerwijderen.id, 'hnvi');
    console.log(`deleteFromSupabase returned:`, ok);
    if (!ok) {
      console.log(`Delete failed, adding to pending queue`);
      addToPendingQueue(teVerwijderen, 'delete', false, 'hnvi');
    }
  } catch (err) {
    console.error('Exception in verwijderHNVIItem:', err);
    addToPendingQueue(teVerwijderen, 'delete', false, 'hnvi');
  }
  
  renderHNVI();
}

export function toggleAllHNVI(cb) {
  document.querySelectorAll('.hnvi-check').forEach(c => c.checked = cb.checked);
  updateHNVIDeleteBtn();
}

export function updateHNVIDeleteBtn() {
  const aantal = document.querySelectorAll('.hnvi-check:checked').length;
  const btn = document.getElementById('hnvi-delete-btn');
  if (btn) {
    btn.style.display = aantal > 0 ? '' : 'none';
    btn.textContent = `🗑 Verwijder (${aantal})`;
  }
  const allCb = document.getElementById('hnvi-check-all');
  if (allCb) {
    const all = document.querySelectorAll('.hnvi-check');
    allCb.indeterminate = aantal > 0 && aantal < all.length;
    allCb.checked = aantal === all.length && all.length > 0;
  }
}

export async function verwijderGeselecteerdeHNVI() {
  console.log('🗑️  verwijderGeselecteerdeHNVI called');
  
  const checked = [...document.querySelectorAll('.hnvi-check:checked')];
  if (checked.length === 0) {
    console.log('Geen items geselecteerd');
    return;
  }
  
  if (!window.confirm(`Weet je zeker dat je ${checked.length} item(s) wilt verwijderen?`)) {
    console.log('Verwijdering geannuleerd');
    return;
  }
  
  const teVerwijderen = new Set(checked.map(c => c.dataset.key));
  const lotsToDel = state.HNVI_LOTS.filter(i => teVerwijderen.has(String(i._key||i.id)));
  
  console.log(`Verwijdert ${lotsToDel.length} loten:`, lotsToDel.map(l => l.id));
  
  // Verwijder uit state
  state.HNVI_LOTS = state.HNVI_LOTS.filter(i => !teVerwijderen.has(String(i._key||i.id)));
  saveHnviData();
  
  // Stuur ELKE deletion naar Supabase
  for (const lot of lotsToDel) {
    try {
      console.log(`Deleting lot ${lot.id} from Supabase...`);
      const ok = await deleteFromSupabase(lot.id, 'hnvi');
      if (!ok) {
        console.warn(`Delete van lot ${lot.id} faalde, in wachtrij`);
        addToPendingQueue(lot, 'delete', false, 'hnvi');
      }
    } catch (err) {
      console.error(`Exception deleting lot ${lot.id}:`, err);
      addToPendingQueue(lot, 'delete', false, 'hnvi');
    }
  }
  
  renderHNVI();
}

export async function importHNVIFactuur(input) {
  const files = [...input.files];
  if (!files.length) return;
  input.value = '';

  state.hnviImportItems = [];
  document.getElementById('hnvi-factuur-status').textContent = `0 / ${files.length} facturen uitgelezen...`;
  document.getElementById('hnvi-factuur-preview').innerHTML = '';
  document.getElementById('hnvi-factuur-btn').style.display = 'none';
  document.getElementById('modal-hnvi-factuur').classList.add('open');

  const prompt = `Dit is een HNVI veilingfactuur. Lees alle gekochte items uit en bereken de inkoopprijs per item inclusief veilinggeld en BTW naar rato.

Bereken zo:
- Totaal biedingen = som van alle biedprijzen
- Extra kosten = veilinggeld + BTW over veilinggeld + BTW over biedingen (alles wat bovenop de biedingen komt)
- Per item: inkoopprijs incl = biedprijs + (biedprijs / totaal biedingen) * extra kosten
- Rond af op 2 decimalen

Geef een JSON array terug, ALLEEN JSON, geen uitleg:
[{"omschrijving":"C087 MacBook Air 15 inch M3","datum":"2026-05-27","inkoop":672.46},...]

Factuurnummer en datum staan bovenaan. Gebruik de factuurdatum als datum (formaat YYYY-MM-DD).
Als er meerdere identieke items zijn (bijv 4x iPhone SE) maak dan voor elk een aparte regel.`;

  const fmt2 = n => '€ ' + Number(n).toLocaleString('nl-NL', {minimumFractionDigits:2, maximumFractionDigits:2});

  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    document.getElementById('hnvi-factuur-status').textContent = `${f + 1} / ${files.length} — ${file.name} uitgelezen...`;
    try {
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });

      const apiKey = localStorage.getItem('xtenate_apikey');
      if (!apiKey) {
        document.getElementById('hnvi-factuur-status').textContent = 'Geen API sleutel ingesteld. Klik op "API sleutel" in het menu.';
        openApiKeyModal();
        return;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{role:'user', content:[
            {type:'document', source:{type:'base64', media_type:'application/pdf', data:base64}},
            {type:'text', text:prompt}
          ]}]
        })
      });

      const data = await response.json();
      const text = data.content.map(c => c.text || '').join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const items = JSON.parse(clean);
      state.hnviImportItems.push(...items);

    } catch(err) {
      document.getElementById('hnvi-factuur-status').textContent = `Fout bij ${file.name}: ${err.message}`;
    }
  }

  // Sorteer op datum
  state.hnviImportItems.sort((a,b) => a.datum.localeCompare(b.datum));

  document.getElementById('hnvi-factuur-status').textContent = `${state.hnviImportItems.length} items gevonden uit ${files.length} facturen — controleer en importeer:`;
  document.getElementById('hnvi-factuur-preview').innerHTML = `
    <table style="width:100%;font-size:12.5px;border-collapse:collapse">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-default);color:var(--text-secondary);font-weight:500">Omschrijving</th>
        <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-default);color:var(--text-secondary);font-weight:500">Datum</th>
        <th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border-default);color:var(--text-secondary);font-weight:500">Inkoop incl.</th>
      </tr></thead>
      <tbody>${state.hnviImportItems.map(i => `<tr>
        <td style="padding:7px 8px;border-bottom:1px solid var(--border-default)">${i.omschrijving}</td>
        <td style="padding:7px 8px;border-bottom:1px solid var(--border-default);color:var(--text-secondary)">${i.datum.slice(8,10)}-${i.datum.slice(5,7)}</td>
        <td style="padding:7px 8px;border-bottom:1px solid var(--border-default);text-align:right;font-weight:500">${fmt2(i.inkoop)}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="2" style="padding:8px 8px 0;font-weight:600">Totaal ${files.length} facturen</td>
        <td style="padding:8px 8px 0;text-align:right;font-weight:600">${fmt2(state.hnviImportItems.reduce((s,i)=>s+(Number(i.inkoop)||0),0))}</td>
      </tr></tfoot>
    </table>`;
  document.getElementById('hnvi-factuur-btn').style.display = '';
}

export function bevestigHNVIImport() {
  state.hnviImportItems.forEach(item => {
    const impId = state.nxtHnvi++;
    state.HNVI_LOTS.push({
      id: impId,
      _key: String(impId),
      datum: item.datum,
      omschr: item.omschrijving,
      inkoop: item.inkoop,
      verkoop: null,
      status: 'voorraad'
    });
  });
  saveHnviData();
  document.getElementById('modal-hnvi-factuur').classList.remove('open');
  renderHNVI();
  state.hnviImportItems = [];
}
