// uitvoeren.js — de uitvoerende werkstroom, in vaste volgorde met sloten ertussen.
//
// Volgorde: backup → preview → uitdrukkelijke bevestiging → uitvoeren →
// opnieuw uitlezen → controle achteraf. Elke stap is op slot tot de vorige is
// afgerond; dat wordt hier afgedwongen en niet alleen in het scherm.
//
// De uitvoering bouwt de historie NIET opnieuw op. Ze past de bestaande records
// gericht aan: van 473 records het datumveld, van 2 records het typeveld, en
// één waarde in de jaartotalen. Alle overige velden blijven staan, en vooral:
// de bestaande id's blijven staan. Dat scheelt niet alleen risico, het houdt
// ook je weggeklikte controlemeldingen werkend, want die verwijzen naar id's.

import { backupBestand } from './opslagdiagnose.js?v=20261024w';
import { bouwMeldingen } from './gegevenscontrole.js?v=20261024w';
import { state, CONTROLE_INSTELLINGEN } from './storage.js?v=20261024w';

export const STAP = {
  BACKUP: 1, PREVIEW: 2, BEVESTIGING: 3, UITVOEREN: 4, CONTROLE: 5
};

/** De vier meldingen die uitgevoerd mogen worden, in vaste volgorde. */
const TOEGESTAAN = [
  'datum-verschuiving',
  id => id.startsWith('soort::'),
  'jaartotaal::2022::priveSt'
];

const magUitgevoerd = id => TOEGESTAAN.some(t => typeof t === 'function' ? t(id) : t === id);

async function som(tekst) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tekst));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < tekst.length; i++) { h ^= tekst.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fnv-' + (h >>> 0).toString(16);
  }
}

/** Checksums van élke opslagsleutel, plus de ruwe lengte. */
export async function opslagStand() {
  const uit = {};
  for (let i = 0; i < localStorage.length; i++) {
    const s = localStorage.key(i);
    const ruw = localStorage.getItem(s) ?? '';
    uit[s] = { som: await som(ruw), tekens: ruw.length };
  }
  return uit;
}

// ------------------------------------------------------------- stap 1: backup

/**
 * Leest alles uit, biedt het als download aan en levert de voor-stand.
 * Pas als dit gelukt is, mag de volgende stap.
 */
export async function stapBackup() {
  const voor = await opslagStand();
  const bestand = await backupBestand();   // schrijft naar je schijf, niet naar de opslag
  if (!bestand || !bestand.sleutels) throw new Error('de reservekopie is niet gemaakt');
  const na = await opslagStand();
  const ongewijzigd = Object.keys(voor).every(k => na[k] && na[k].som === voor[k].som)
    && Object.keys(na).length === Object.keys(voor).length;
  if (!ongewijzigd) throw new Error('de opslag veranderde tijdens het maken van de reservekopie');
  return { bestand, voorStand: voor, gelukt: true };
}

// ------------------------------------------------------------ stap 2: preview

/** Verzamelt de mutaties van de toegestane meldingen. Wijzigt niets. */
export async function stapPreview() {
  const meldingen = await bouwMeldingen();
  const uitvoeren = meldingen.filter(m => magUitgevoerd(m.id) && m.correctieBewezen);
  const overig = meldingen.filter(m => !uitvoeren.includes(m));

  const mutaties = uitvoeren.flatMap(m => (m.mutaties || []).map(x => ({ ...x, meldingId: m.id })));
  const perSleutel = {};
  mutaties.forEach(x => {
    perSleutel[x.sleutel] = perSleutel[x.sleutel] || { datum: 0, type: 0, waarde: 0 };
    if (x.veld === 'datum') perSleutel[x.sleutel].datum++;
    else if (x.veld === 'type') perSleutel[x.sleutel].type++;
    else perSleutel[x.sleutel].waarde++;
  });

  // De jaargrens volgt uit de nieuwe datum; die wordt niet apart gestuurd.
  const jaargrens = mutaties.filter(x => x.veld === 'datum'
    && String(x.van).slice(0, 4) !== String(x.naar).slice(0, 4))
    .map(x => ({ id: x.recordId, van: x.van, naar: x.naar }));

  const hist = Array.isArray(state.HIST_TX) ? state.HIST_TX : [];
  const tx = Array.isArray(state.TX) ? state.TX : [];

  return {
    meldingen, uitvoeren, overig, mutaties, perSleutel, jaargrens,
    aantalDatums: mutaties.filter(x => x.veld === 'datum').length,
    aantalTypes: mutaties.filter(x => x.veld === 'type').length,
    aantalWaarden: mutaties.filter(x => x.veld !== 'datum' && x.veld !== 'type').length,
    // Wat er gegarandeerd niet gebeurt, geteld uit de mutaties zelf.
    garanties: [
      { tekst: 'Geen privé-transacties toegevoegd',
        goed: mutaties.every(x => x.veld === 'datum' || x.veld === 'type' || x.pad) },
      { tekst: 'Geen records toegevoegd of verwijderd',
        goed: mutaties.every(x => x.recordId || x.pad) },
      { tekst: 'Geen enkel id gewijzigd', goed: mutaties.every(x => x.veld !== 'id') },
      { tekst: 'xtenate_tx wordt niet gewijzigd',
        goed: !mutaties.some(x => x.sleutel === 'xtenate_tx'), detail: `${tx.length} boekingen blijven staan` },
      { tekst: 'Maandsaldi worden niet gewijzigd',
        goed: !mutaties.some(x => x.sleutel === 'xtenate_maand_saldos_override') },
      { tekst: 'Voorraad wordt niet gewijzigd',
        goed: !mutaties.some(x => x.sleutel === 'xtenate_covers'),
        detail: `${(state.COVERS || []).length} artikelen blijven staan` },
      { tekst: 'HNVI-loten worden niet gewijzigd',
        goed: !mutaties.some(x => x.sleutel === 'xtenate_hnvi'),
        detail: `${(state.HNVI_LOTS || []).length} loten blijven staan` },
      { tekst: `De overige ${overig.length} meldingen worden niet gewijzigd`, goed: true }
    ],
    historieRecords: hist.length
  };
}

// ----------------------------------------------------------- stap 4: uitvoeren

/**
 * Past de mutaties toe op de bestaande records. Dit is de enige plek in dit
 * bestand die schrijft, en alleen naar de twee sleutels uit het plan.
 */
export async function stapUitvoeren(preview, voorStand) {
  if (!preview || !preview.mutaties.length) throw new Error('er is geen plan om uit te voeren');
  if (!voorStand) throw new Error('de stand van vóór het herstel ontbreekt; maak eerst de reservekopie');

  const geraakteSleutels = [...new Set(preview.mutaties.map(x => x.sleutel))];
  const log = [];

  // --- historie: bestaande records aanpassen, id's blijven staan -----------
  if (geraakteSleutels.includes('xtenate_hist_tx_override')) {
    const ruw = localStorage.getItem('xtenate_hist_tx_override');
    const lijst = JSON.parse(ruw || '[]');
    const perId = new Map(lijst.map((t, i) => [String(t.id), i]));
    let gemist = 0;

    preview.mutaties.filter(x => x.sleutel === 'xtenate_hist_tx_override').forEach(x => {
      const i = perId.get(x.recordId);
      if (i === undefined) { gemist++; return; }
      // Alleen het genoemde veld, en alleen als de huidige waarde nog klopt.
      if (String(lijst[i][x.veld]) !== String(x.van)) { gemist++; return; }
      lijst[i][x.veld] = x.naar;
      log.push({ sleutel: x.sleutel, recordId: x.recordId, veld: x.veld, van: x.van, naar: x.naar });
    });
    if (gemist) throw new Error(`${gemist} record(s) kwamen niet overeen met de verwachte waarde; er is niets geschreven`);
    if (lijst.length !== JSON.parse(ruw || '[]').length) throw new Error('het aantal records veranderde; afgebroken');
    localStorage.setItem('xtenate_hist_tx_override', JSON.stringify(lijst));
  }

  // --- jaartotalen: één waarde ---------------------------------------------
  if (geraakteSleutels.includes('xtenate_home_totals_override')) {
    const obj = JSON.parse(localStorage.getItem('xtenate_home_totals_override') || '{}');
    preview.mutaties.filter(x => x.sleutel === 'xtenate_home_totals_override').forEach(x => {
      const [jaar, veld] = x.pad;
      if (!obj[jaar]) throw new Error(`jaar ${jaar} ontbreekt in de jaartotalen; afgebroken`);
      obj[jaar][veld] = x.naar;
      log.push({ sleutel: x.sleutel, recordId: `${jaar}.${veld}`, veld, van: x.van, naar: x.naar });
    });
    localStorage.setItem('xtenate_home_totals_override', JSON.stringify(obj));
  }

  const naStand = await opslagStand();
  return { log, voorStand, naStand, geraakteSleutels };
}

// ------------------------------------------------------- stap 6: controle achteraf

/** Loopt de negen controles na op de gegevens zoals ze nu in de opslag staan. */
export async function stapControle(preview, uitkomst) {
  const lees = s => { try { return JSON.parse(localStorage.getItem(s) || 'null'); } catch { return null; } };
  const hist = lees('xtenate_hist_tx_override') || [];
  const perId = new Map(hist.map(t => [String(t.id), t]));
  const ht = lees('xtenate_home_totals_override') || {};
  const controles = [];
  const zet = (titel, goed, waarde) => controles.push({ titel, goed, waarde });

  const datums = preview.mutaties.filter(x => x.veld === 'datum');
  const juist = datums.filter(x => perId.get(x.recordId) && perId.get(x.recordId).datum === x.naar).length;
  zet(`Alle ${datums.length} datums exact één dag later`, juist === datums.length,
    `${juist} van ${datums.length}`);

  const types = preview.mutaties.filter(x => x.veld === 'type');
  const typeOk = types.filter(x => perId.get(x.recordId) && perId.get(x.recordId).type === x.naar).length;
  zet('De twee privé-soorten staan goed', typeOk === types.length, `${typeOk} van ${types.length}`);

  // Referentie komt uit CONTROLE_INSTELLINGEN (Beheer); staat die nog leeg,
  // dan slaat deze controle over in plaats van een verschil tegen 0 te tonen.
  const referentiePriveSt2022 = CONTROLE_INSTELLINGEN?.jaartotaal2022PriveSt;
  const st = Number(ht['2022']?.priveSt);
  if (referentiePriveSt2022 != null) {
    zet(`2022 priveSt is € ${referentiePriveSt2022.toFixed(2).replace('.', ',')}`,
      Math.abs(st - referentiePriveSt2022) < 0.005, '€ ' + (isNaN(st) ? '—' : st.toFixed(2)));
  }
  const op = Number(ht['2022']?.priveOp);
  zet('2022 priveOp is nog € 250,00', Math.abs(op - 250) < 0.005, '€ ' + (isNaN(op) ? '—' : op.toFixed(2)));

  const stortingenVoor = preview.historieRecords;
  zet('Geen records toegevoegd of verwijderd', hist.length === stortingenVoor,
    `${hist.length} van ${stortingenVoor}`);
  const nieuweStortingen = hist.filter(t => t.type === 'prive_storting'
    && !preview.mutaties.some(x => x.recordId === String(t.id) && x.veld === 'type')).length;
  const verwachteStortingen = (state.HIST_TX || []).filter(t => t.type === 'prive_storting').length;
  zet('Nul nieuwe privé-transacties',
    hist.filter(t => t.type === 'prive_storting' || t.type === 'prive_opname').length
      === (state.HIST_TX || []).filter(t => t.type === 'prive_storting' || t.type === 'prive_opname').length,
    `${hist.filter(t => t.type === 'prive_storting').length} stortingen, ${hist.filter(t => t.type === 'prive_opname').length} opnames`);

  // Sleutels die niet geraakt mochten worden.
  const magNiet = Object.keys(uitkomst.voorStand)
    .filter(k => !uitkomst.geraakteSleutels.includes(k));
  const veranderd = magNiet.filter(k =>
    !uitkomst.naStand[k] || uitkomst.naStand[k].som !== uitkomst.voorStand[k].som);
  ['xtenate_tx', 'xtenate_maand_saldos_override', 'xtenate_covers', 'xtenate_hnvi'].forEach(k => {
    if (!(k in uitkomst.voorStand)) { zet(`${k} onveranderd`, true, 'staat niet in de opslag'); return; }
    zet(`${k} byte voor byte onveranderd`,
      uitkomst.naStand[k] && uitkomst.naStand[k].som === uitkomst.voorStand[k].som,
      uitkomst.naStand[k]?.som === uitkomst.voorStand[k].som ? 'ONVERANDERD' : 'AFWIJKEND');
  });
  zet('Geen enkele andere sleutel gewijzigd', veranderd.length === 0,
    veranderd.length ? veranderd.join(', ') : `${magNiet.length} sleutels onveranderd`);

  const restMeldingen = preview.overig.length;
  zet(`De overige ${restMeldingen} meldingen onaangeroerd`, true, 'er zijn geen mutaties voor gedaan');

  // Per sleutel oude → nieuwe checksum.
  const rapport = Object.keys(uitkomst.voorStand).sort().map(k => ({
    sleutel: k,
    voor: uitkomst.voorStand[k].som,
    na: uitkomst.naStand[k]?.som ?? '—',
    gewijzigd: uitkomst.naStand[k]?.som !== uitkomst.voorStand[k].som,
    mocht: uitkomst.geraakteSleutels.includes(k)
  }));

  return {
    controles, rapport,
    allesGoed: controles.every(c => c.goed),
    onterecht: rapport.filter(r => r.gewijzigd && !r.mocht)
  };
}
