// partijen.js — gedeelde logica voor de pagina's Debiteuren en Crediteuren.
//
// Twee dingen waar je hier op moet letten:
//
// 1. Beide pagina's staan tegelijk in de DOM. Alles werkt daarom op een
//    meegegeven container en nooit op document.querySelectorAll: anders pakt
//    de ene pagina de knoppen van de andere over.
//
// 2. Alle eigen klassenamen beginnen met 'pm-'. De app gebruikt zelf al
//    .modal-overlay en .modal voor zijn vijftien bestaande vensters. Die staan
//    op display:none en gaan alleen open via .open. Een eigen regel voor
//    .modal-overlay zou dat overschrijven en elk venster tegelijk tonen.

import { state, saveTxData, saveHistTxData } from './storage.js?v=20261024r';
import { fmt } from './helpers.js?v=20261024r';
import {
  saveToSupabase,
  deleteFromSupabase,
  addToPendingQueue
} from './supabase-client-v2.js?v=20261024r';
import { facturenBijBoeking, ontkoppelAlleFacturenVanBoeking } from './facturen.js?v=20261024r';
import { txVanJaar, lopendJaar } from './jaren.js?v=20261024r';

export const veilig = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Historische boekingen hebben een id als 'h2025_12', lopende een getal. */
const isHistorisch = b => String(b?.id ?? '').startsWith('h');

/** Alle boekingen van één jaar, uit het lopende jaar én de historie. */
export function boekingenVoorJaar(jaar) {
  return txVanJaar(jaar);
}

const partijNaamVan = b => (b.naam || '').trim() || '(geen naam)';

// ------------------------------------------------------------------ lijst

/**
 * Tekent de partijenlijst en hangt de Details-knoppen op.
 *
 * @param {object}   o
 * @param {string}   o.lijstId    id van de container
 * @param {string}   o.totaalId   id van het totaalveld
 * @param {string}   o.soort      'inkomst' of 'uitgave'
 * @param {string}   o.leegTekst  tekst als er niets is
 * @param {Function} o.herteken   opnieuw tekenen na een wijziging
 */
export function tekenPartijen(o) {
  const lijst = document.getElementById(o.lijstId);
  const totaalVeld = document.getElementById(o.totaalId);
  if (!lijst || !totaalVeld) return;

  const jaar = state.huidigJaar || lopendJaar();
  const boekingen = boekingenVoorJaar(jaar).filter(t => t.type === o.soort);

  if (boekingen.length === 0) {
    const periode = jaar === 'all' ? 'de administratie' : jaar;
    lijst.innerHTML = `<div class="leeg">${o.leegTekst} in ${veilig(periode)}</div>`;
    totaalVeld.textContent = fmt(0);
    return;
  }

  // Per partij samenvoegen: één regel per naam, niet per betaling.
  const groepen = new Map();
  for (const b of boekingen) {
    const naam = partijNaamVan(b);
    const g = groepen.get(naam) || { totaal: 0, aantal: 0 };
    g.totaal += Number(b.bedrag) || 0;
    g.aantal += 1;
    groepen.set(naam, g);
  }

  const gesorteerd = [...groepen.entries()].sort((a, b) => b[1].totaal - a[1].totaal);
  const teken = o.soort === 'inkomst' ? 'pos' : 'neg';
  const plus = o.soort === 'inkomst' ? '+&nbsp;' : '';

  lijst.innerHTML = gesorteerd.map(([naam, g], i) => `
    <div class="partij-rij">
      <span class="partij-naam" title="${veilig(naam)}">${veilig(naam)}</span>
      <span class="partij-aantal">${g.aantal}&times;</span>
      <span class="partij-bedrag ${teken}">${plus}${fmt(g.totaal)}</span>
      <button type="button" class="btn-details" data-rij="${i}">Details</button>
    </div>`).join('');

  // Alleen binnen deze lijst zoeken, niet in het hele document.
  lijst.querySelectorAll('.btn-details').forEach(knop => {
    knop.addEventListener('click', () => {
      const naam = gesorteerd[Number(knop.dataset.rij)][0];
      openPartijVenster(naam, boekingen.filter(b => partijNaamVan(b) === naam), o);
    });
  });

  totaalVeld.textContent = fmt(gesorteerd.reduce((s, [, g]) => s + g.totaal, 0));
}

// ------------------------------------------------------------------ venster

let sluitHuidige = null;

/** Zet een venster neer dat met Esc, de knop of een klik ernaast dichtgaat. */
function toonVenster(id, inhoudHtml) {
  sluitHuidige?.();

  const laag = document.createElement('div');
  laag.className = 'pm-laag';
  laag.id = id;
  laag.innerHTML = `<div class="pm-venster" role="dialog" aria-modal="true">${inhoudHtml}</div>`;
  document.body.appendChild(laag);

  const sluit = () => {
    document.removeEventListener('keydown', opToets, true);
    laag.remove();
    if (sluitHuidige === sluit) sluitHuidige = null;
  };

  // In de capture-fase: de app heeft zelf een Escape-handler die alle vensters
  // met .open sluit, en die mag hier niet doorheen fietsen.
  function opToets(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); sluit(); }
  }

  document.addEventListener('keydown', opToets, true);
  laag.addEventListener('mousedown', e => { if (e.target === laag) sluit(); });
  laag.querySelectorAll('[data-pm-sluit]').forEach(k => k.addEventListener('click', sluit));

  sluitHuidige = sluit;
  return { laag, sluit };
}

function openPartijVenster(naam, boekingen, o) {
  const opDatum = [...boekingen].sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  const totaal = opDatum.reduce((s, b) => s + (Number(b.bedrag) || 0), 0);

  const rijen = opDatum.map((b, i) => `
    <tr>
      <td class="pm-datum">${veilig(b.datum || '—')}</td>
      <td class="pm-bedrag">${fmt(b.bedrag)}</td>
      <td class="pm-gb">${veilig(b.gb || '—')}</td>
      <td class="pm-omschr" title="${veilig(b.omschr || '')}">${veilig(b.omschr || '—')}</td>
      <td class="pm-acties">
        <button type="button" class="pm-mini" data-bewerk="${i}">Bewerk</button>
        <button type="button" class="pm-mini pm-mini-rood" data-verwijder="${i}">Verwijder</button>
      </td>
    </tr>`).join('');

  const { laag } = toonVenster('pm-partij', `
    <header class="pm-kop">
      <div>
        <h3>${veilig(naam)}</h3>
        <p class="pm-sub">${opDatum.length} boeking${opDatum.length === 1 ? '' : 'en'} &middot; ${fmt(totaal)}</p>
      </div>
      <button type="button" class="pm-kruis" data-pm-sluit aria-label="Sluiten">&times;</button>
    </header>
    <div class="pm-inhoud">
      <table class="pm-tabel">
        <thead>
          <tr>
            <th class="pm-datum">Datum</th>
            <th class="pm-bedrag">Bedrag</th>
            <th class="pm-gb">Grootboek</th>
            <th class="pm-omschr">Omschrijving</th>
            <th class="pm-acties">Acties</th>
          </tr>
        </thead>
        <tbody>${rijen}</tbody>
      </table>
    </div>
    <footer class="pm-voet">
      <span class="pm-hint">Esc sluit dit venster</span>
      <button type="button" class="btn" data-pm-sluit>Sluiten</button>
    </footer>`);

  laag.querySelectorAll('[data-bewerk]').forEach(k => k.addEventListener('click',
    () => openBewerkVenster(opDatum[Number(k.dataset.bewerk)], o)));

  laag.querySelectorAll('[data-verwijder]').forEach(k => k.addEventListener('click',
    () => verwijderBoeking(opDatum[Number(k.dataset.verwijder)], o)));
}

function openBewerkVenster(boeking, o) {
  const { laag, sluit } = toonVenster('pm-bewerk', `
    <header class="pm-kop">
      <h3>Boeking bewerken</h3>
      <button type="button" class="pm-kruis" data-pm-sluit aria-label="Sluiten">&times;</button>
    </header>
    <div class="pm-inhoud">
      <div class="pm-velden">
        <label>Datum<input type="date" id="pm-datum" value="${veilig(boeking.datum || '')}"></label>
        <label>Bedrag (&euro;)<input type="number" step="0.01" id="pm-bedrag" value="${Number(boeking.bedrag) || 0}"></label>
        <label>Grootboek<input type="text" id="pm-gb" value="${veilig(boeking.gb || '')}"></label>
        <label>Rekening<input type="text" id="pm-rek" value="${veilig(boeking.rek || '')}"></label>
        <label class="pm-breed">Naam / partij<input type="text" id="pm-naam" value="${veilig(boeking.naam || '')}"></label>
        <label class="pm-breed">Omschrijving<input type="text" id="pm-omschr" value="${veilig(boeking.omschr || '')}"></label>
      </div>
    </div>
    <footer class="pm-voet">
      <span class="pm-hint">Esc annuleert</span>
      <div class="pm-knoppen">
        <button type="button" class="btn" data-pm-sluit>Annuleren</button>
        <button type="button" class="btn btn-primary" id="pm-opslaan">Opslaan</button>
      </div>
    </footer>`);

  const waarde = id => laag.querySelector('#' + id)?.value ?? '';

  laag.querySelector('#pm-opslaan').addEventListener('click', async () => {
    const gewijzigd = {
      ...boeking,
      datum: waarde('pm-datum') || boeking.datum,
      bedrag: Number(waarde('pm-bedrag')) || 0,
      naam: waarde('pm-naam'),
      omschr: waarde('pm-omschr'),
      gb: waarde('pm-gb'),
      rek: waarde('pm-rek')
    };

    // Op id zoeken, niet op de index uit de gefilterde schermlijst: die index
    // hoort bij het scherm en niet bij state.TX, dus daarmee zou je een heel
    // andere boeking overschrijven.
    const hist = isHistorisch(boeking);
    const bron = hist ? state.HIST_TX : state.TX;
    const pos = (bron || []).findIndex(t => String(t.id) === String(boeking.id));
    if (pos === -1) { alert('Boeking niet meer gevonden.'); sluit(); return; }

    bron[pos] = gewijzigd;
    hist ? saveHistTxData() : saveTxData();

    try {
      const ok = await saveToSupabase(gewijzigd, hist);
      if (!ok) addToPendingQueue(gewijzigd, 'update', hist);
    } catch (err) {
      console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
      addToPendingQueue(gewijzigd, 'update', hist);
    }

    sluit();
    o.herteken();
  });

  laag.querySelector('#pm-datum')?.focus();
}

async function verwijderBoeking(boeking, o) {
  const regel = `${boeking.datum} — ${fmt(boeking.bedrag)} — ${boeking.naam || '(geen naam)'}`;

  // Een boeking waar een factuur naar verwijst blijft anders "betaald" tonen
  // terwijl de onderliggende betaling niet meer bestaat — dus eerst
  // waarschuwen, en bij doorzetten de koppeling netjes losmaken.
  const gekoppeld = facturenBijBoeking(boeking.id);
  const koppelTekst = gekoppeld.length
    ? `\n\nLet op: gekoppeld aan ${gekoppeld.length > 1 ? 'de facturen' : 'de factuur'} ` +
      gekoppeld.map(f => `${f.factuurnummer || f.id} (${fmt(f.bedrag)})`).join(', ') +
      `. Bij verwijderen wordt die koppeling losgemaakt en komt ${gekoppeld.length > 1 ? 'ze' : 'die'} weer op "openstaand" te staan.`
    : '';

  if (!confirm(`Deze boeking verwijderen?\n\n${regel}${koppelTekst}`)) return;

  ontkoppelAlleFacturenVanBoeking(boeking.id);

  const hist = isHistorisch(boeking);
  if (hist) {
    state.HIST_TX = (state.HIST_TX || []).filter(t => String(t.id) !== String(boeking.id));
    saveHistTxData();
  } else {
    state.TX = (state.TX || []).filter(t => String(t.id) !== String(boeking.id));
    saveTxData();
  }

  try {
    const ok = await deleteFromSupabase(boeking.id, 'boeking');
    if (!ok) addToPendingQueue(boeking, 'delete', hist, 'boeking');
  } catch (err) {
    console.warn('Supabase niet bereikbaar, in wachtrij gezet:', err);
    addToPendingQueue(boeking, 'delete', hist, 'boeking');
  }

  sluitHuidige?.();
  o.herteken();
}
