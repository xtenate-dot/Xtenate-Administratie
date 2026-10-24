// opslagdiagnose.js — tijdelijke diagnose. Leest de opslag uit en vergelijkt
// die met de historie in de code. Er wordt NIETS geschreven.
//
// Bewust geen enkele aanroep van setItem, removeItem, clear, save(), of van
// een van de save*Data-functies uit storage.js. Ook `state` wordt niet
// aangepast: de gegevens worden rechtstreeks uit localStorage gelezen, zodat
// je ziet wat er écht staat en niet wat de app er in het geheugen van gemaakt
// heeft. Deze module mag na het onderzoek weer weg.

import { HIST_TX_DEFAULT, HOME_TOTALS_DEFAULT, MAAND_SALDOS_DEFAULT, state }
  from './storage.js?v=20261023y';

const JAREN = ['2022', '2023', '2024', '2025', '2026'];

/** Rauw uit de opslag, zonder tussenkomst van de app. */
function leesRuw(sleutel) {
  const ruw = localStorage.getItem(sleutel);
  if (ruw === null) return { aanwezig: false, tekens: 0, lijst: [], fout: null };
  try {
    const d = JSON.parse(ruw);
    return { aanwezig: true, tekens: ruw.length, lijst: Array.isArray(d) ? d : [], fout: Array.isArray(d) ? null : 'geen lijst' };
  } catch (e) {
    return { aanwezig: true, tekens: ruw.length, lijst: [], fout: 'onleesbaar: ' + e.message };
  }
}

const jaarVan = t => String(t && t.datum || '').slice(0, 4);
const geldigeDatum = t => /^\d{4}-\d{2}-\d{2}$/.test(String(t && t.datum || ''));

/** Het volledige kenmerk: hierop matcht de herstelactie. */
const kenmerk = t => [
  t.datum, Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek), String(t.type),
  String(t.naam || '').trim().toLowerCase(),
  String(t.omschr || '').trim().toLowerCase()
].join('|');

/** Hetzelfde kenmerk zonder de datum: hiermee vinden we verschoven boekingen. */
const kenmerkZonderDatum = t => [
  Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek), String(t.type),
  String(t.naam || '').trim().toLowerCase(),
  String(t.omschr || '').trim().toLowerCase()
].join('|');

/** Grof kenmerk: alleen datum, bedrag en soort. Vangt afwijkingen in de rest. */
const kenmerkGrof = t => [t.datum, Number(t.bedrag).toFixed(2), String(t.type)].join('|');

const dagenTussen = (a, b) =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

const regel = t => [
  t.datum || '(geen datum)',
  Number(t.bedrag).toFixed(2).padStart(9),
  'gb ' + t.gb, 'rek ' + t.rek, t.type,
  JSON.stringify(String(t.naam ?? '')),
  JSON.stringify(String(t.omschr ?? '')),
  'id=' + t.id
].join(' | ');

/** Welke velden verschillen tussen twee boekingen? */
function verschillendeVelden(a, b) {
  const velden = ['datum', 'bedrag', 'gb', 'rek', 'type', 'naam', 'omschr'];
  return velden.filter(v => {
    if (v === 'bedrag') return Number(a.bedrag).toFixed(2) !== Number(b.bedrag).toFixed(2);
    if (v === 'naam' || v === 'omschr') {
      return String(a[v] || '').trim().toLowerCase() !== String(b[v] || '').trim().toLowerCase();
    }
    return String(a[v] ?? '') !== String(b[v] ?? '');
  });
}

/**
 * Vergelijkt één jaar in drie ronden, van streng naar soepel, zodat elke
 * boeking in precies één categorie terechtkomt.
 */
function vergelijkJaar(jaar, vanMij, vanCode) {
  const exact = [];
  const verschoven = [];   // zelfde boeking, alleen de datum wijkt af
  const afwijkend = [];    // zelfde datum en bedrag, een ander veld wijkt af
  const mijnOver = [];
  const codeOver = [];

  const groepeer = (lijst, sleutelVan) => {
    const m = new Map();
    lijst.forEach(t => {
      const k = sleutelVan(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    });
    return m;
  };
  const opDatum = (a, b) => String(a.datum).localeCompare(String(b.datum));

  // Ronde 1 — alles gelijk behalve mogelijk de datum.
  //
  // Binnen zo'n groep worden beide kanten op datum gesorteerd en van voor naar
  // achter naast elkaar gelegd. Dat is nodig omdat dezelfde boeking vaak in
  // reeksen voorkomt: vijftien keer PostNL van 6,75 in één jaar. Zou ik per
  // boeking de dichtstbijzijnde partner zoeken, dan pakt de een de partner van
  // de ander en ontstaan er verschuivingen van drie of vier dagen die er niet
  // zijn. Op volgorde koppelen houdt de reeks intact.
  const DREMPEL_DAGEN = 31;
  const mijnGroepen = groepeer(vanMij, kenmerkZonderDatum);
  const codeGroepen = groepeer(vanCode, kenmerkZonderDatum);

  new Set([...mijnGroepen.keys(), ...codeGroepen.keys()]).forEach(k => {
    const a = (mijnGroepen.get(k) || []).slice().sort(opDatum);
    const b = (codeGroepen.get(k) || []).slice().sort(opDatum);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (!geldigeDatum(a[i])) { mijnOver.push(a[i]); i++; continue; }
      const dagen = dagenTussen(a[i].datum, b[j].datum);
      if (Math.abs(dagen) <= DREMPEL_DAGEN) {
        if (dagen === 0) exact.push({ mijn: a[i], code: b[j] });
        else verschoven.push({ mijn: a[i], code: b[j], dagen });
        i++; j++;
      } else if (dagen < 0) {
        mijnOver.push(a[i]); i++;      // deze van mij heeft geen tegenhanger
      } else {
        codeOver.push(b[j]); j++;      // deze uit de code ontbreekt bij mij
      }
    }
    while (i < a.length) mijnOver.push(a[i++]);
    while (j < b.length) codeOver.push(b[j++]);
  });

  // Ronde 2 — zelfde datum, bedrag en soort, maar een ander veld wijkt af.
  const codeRest = groepeer(codeOver, kenmerkGrof);
  for (let i = mijnOver.length - 1; i >= 0; i--) {
    const bak = codeRest.get(kenmerkGrof(mijnOver[i]));
    if (!bak || !bak.length) continue;
    const partner = bak.pop();
    afwijkend.push({ mijn: mijnOver[i], code: partner, velden: verschillendeVelden(mijnOver[i], partner) });
    codeOver.splice(codeOver.indexOf(partner), 1);
    mijnOver.splice(i, 1);
  }

  const sorteer = l => l.slice().sort((x, y) => opDatum(x.mijn || x, y.mijn || y));

  // Echte dubbelen binnen mijn eigen gegevens: volledig identieke regels.
  const telling = new Map();
  vanMij.forEach(t => telling.set(kenmerk(t), (telling.get(kenmerk(t)) || 0) + 1));
  const dubbelen = [...telling.entries()].filter(([, n]) => n > 1)
    .map(([k, n]) => ({ aantal: n, kenmerk: k, voorbeeld: vanMij.find(t => kenmerk(t) === k) }));

  return {
    jaar,
    aantalMijn: vanMij.length,
    aantalCode: vanCode.length,
    exact: sorteer(exact),
    verschoven: sorteer(verschoven),
    afwijkend: sorteer(afwijkend),
    alleenBijMij: mijnOver.slice().sort(opDatum),
    alleenInCode: codeOver.slice().sort(opDatum),
    dubbelen
  };
}

/**
 * De volledige diagnose. Leest, rekent, en geeft alles terug. Schrijft niets.
 */
export function opslagDiagnose() {
  const tx = leesRuw('xtenate_tx');
  const hist = leesRuw('xtenate_hist_tx_override');
  const alleVanMij = [...hist.lijst, ...tx.lijst];

  const perJaar = lijst => {
    const u = {};
    lijst.forEach(t => { const j = jaarVan(t) || 'GEEN DATUM'; u[j] = (u[j] || 0) + 1; });
    return u;
  };

  // Datamodel: welk type heeft elk veld, in elke bak?
  const vingerafdruk = lijst => {
    const velden = {};
    lijst.forEach(t => Object.entries(t || {}).forEach(([k, v]) => {
      const soort = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      velden[k] = velden[k] || {};
      velden[k][soort] = (velden[k][soort] || 0) + 1;
    }));
    return velden;
  };

  // Per jaar vergelijken. 2026 staat niet in de codehistorie; die kant is leeg.
  const jaren = JAREN.map(jaar => vergelijkJaar(
    jaar,
    alleVanMij.filter(t => jaarVan(t) === jaar),
    HIST_TX_DEFAULT.filter(t => jaarVan(t) === jaar)
  ));

  // Boekingen zonder bruikbare datum.
  const zonderDatum = alleVanMij.filter(t => !geldigeDatum(t));

  // Dubbele nummers. De dry-run kijkt naar t.id, niet naar de inhoud, dus een
  // botsing kan ook twee totaal verschillende boekingen betreffen.
  const perId = new Map();
  alleVanMij.forEach(t => {
    const k = String(t && t.id);
    if (!perId.has(k)) perId.set(k, []);
    perId.get(k).push(t);
  });
  const idBotsingen = [...perId.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([id, v]) => ({
      id,
      aantal: v.length,
      zelfdeInhoud: new Set(v.map(kenmerk)).size === 1,
      regels: v
    }))
    .sort((a, b) => b.aantal - a.aantal || String(a.id).localeCompare(String(b.id)));

  return {
    moment: new Date().toLocaleString('nl-NL'),
    tijdzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcAfwijkingUren: -new Date().getTimezoneOffset() / 60,
    bakken: {
      xtenate_tx: { ...tx, lijst: undefined, aantal: tx.lijst.length, perJaar: perJaar(tx.lijst), velden: vingerafdruk(tx.lijst) },
      xtenate_hist_tx_override: { ...hist, lijst: undefined, aantal: hist.lijst.length, perJaar: perJaar(hist.lijst), velden: vingerafdruk(hist.lijst) },
      HIST_TX_DEFAULT: { aantal: HIST_TX_DEFAULT.length, perJaar: perJaar(HIST_TX_DEFAULT), velden: vingerafdruk(HIST_TX_DEFAULT) }
    },
    jaren,
    zonderDatum,
    idBotsingen,
    tweeentwintigVolledig: alleVanMij.filter(t => jaarVan(t) === '2022')
      .slice().sort((a, b) => String(a.datum).localeCompare(String(b.datum)))
  };
}

/** Alles als platte tekst, om hier terug te plakken. */
export function opslagDiagnoseAlsTekst(d) {
  const r = [];
  const p = (...a) => r.push(a.join(' '));

  p('DIAGNOSE OPSLAG XTENATE — ALLEEN LEZEN —', d.moment);
  p('tijdzone:', d.tijdzone, '| UTC-afwijking:', d.utcAfwijkingUren, 'uur');
  p('Er is niets geschreven, hersteld of gemigreerd.');
  p('');

  p('=== 1. DE DRIE BRONNEN ===');
  Object.entries(d.bakken).forEach(([naam, b]) => {
    p(naam + ':', b.aantal, 'boekingen'
      + (b.aanwezig === false ? '  (sleutel bestaat niet)' : '')
      + (b.fout ? '  LET OP: ' + b.fout : '')
      + (b.tekens ? '  (' + b.tekens + ' tekens)' : ''));
    p('   per jaar:', JSON.stringify(b.perJaar));
    p('   velden  :', Object.entries(b.velden).sort()
      .map(([k, s]) => k + '=' + Object.entries(s).map(([a, n]) => a + '×' + n).join('/')).join('  '));
  });
  p('');

  p('=== 2. VERGELIJKING PER JAAR ===');
  p('jaar | bij mij | in code | exact gelijk | zelfde boeking, datum verschoven | zelfde datum, ander veld | alleen bij mij | alleen in code');
  d.jaren.forEach(j => p(
    [j.jaar, j.aantalMijn, j.aantalCode, j.exact.length, j.verschoven.length,
     j.afwijkend.length, j.alleenBijMij.length, j.alleenInCode.length]
      .map((v, i) => String(v).padStart(i === 0 ? 4 : 8)).join(' |')));
  p('');

  p('=== 3. DATUMVERSCHUIVINGEN ===');
  d.jaren.forEach(j => {
    if (!j.verschoven.length) return;
    const perDelta = {};
    j.verschoven.forEach(v => { perDelta[v.dagen] = (perDelta[v.dagen] || 0) + 1; });
    p(j.jaar + ':', Object.entries(perDelta).sort((a, b) => a[0] - b[0])
      .map(([dagen, n]) => `${n}× ${dagen > 0 ? '+' : ''}${dagen} dag`).join(', '));
    j.verschoven.slice(0, 15).forEach(v =>
      p('   bij mij', v.mijn.datum, '<-> code', v.code.datum,
        `(${v.dagen > 0 ? '+' : ''}${v.dagen})`, '|', Number(v.mijn.bedrag).toFixed(2),
        '|', JSON.stringify(String(v.mijn.naam || '').slice(0, 40))));
    if (j.verschoven.length > 15) p('   … en nog', j.verschoven.length - 15);
  });
  p('');

  p('=== 4. ZELFDE DATUM MAAR EEN ANDER VELD ===');
  let afw = 0;
  d.jaren.forEach(j => j.afwijkend.forEach(a => {
    afw++;
    p(j.jaar, '| verschilt op:', a.velden.join(', '));
    p('   bij mij :', regel(a.mijn));
    p('   in code :', regel(a.code));
  }));
  if (!afw) p('geen');
  p('');

  p('=== 5. ALLEEN BIJ MIJ (echt nieuw) ===');
  d.jaren.forEach(j => {
    if (!j.alleenBijMij.length) return;
    p(j.jaar + ':', j.alleenBijMij.length);
    j.alleenBijMij.forEach(t => p('   ' + regel(t)));
  });
  p('');

  p('=== 6. ALLEEN IN DE CODE (ontbreekt bij mij) ===');
  d.jaren.forEach(j => {
    if (!j.alleenInCode.length) return;
    p(j.jaar + ':', j.alleenInCode.length);
    j.alleenInCode.slice(0, 40).forEach(t => p('   ' + regel(t)));
    if (j.alleenInCode.length > 40) p('   … en nog', j.alleenInCode.length - 40);
  });
  p('');

  p('=== 7. ECHTE DUBBELE BOEKINGEN (identiek, in mijn eigen opslag) ===');
  let dub = 0;
  d.jaren.forEach(j => j.dubbelen.forEach(x => { dub++; p(j.jaar, '|', x.aantal + '×', '|', regel(x.voorbeeld)); }));
  if (!dub) p('geen');
  p('(dit kunnen legitieme dubbele boekingen zijn: twee pakketten op één dag)');
  p('');

  p('=== 8. BOEKINGEN ZONDER GELDIGE DATUM:', d.zonderDatum.length, '===');
  d.zonderDatum.forEach(t => p('   ' + JSON.stringify(t)));
  p('');

  p('=== 9. DUBBELE NUMMERS (id):', d.idBotsingen.length, 'nummers,',
    d.idBotsingen.reduce((s, x) => s + x.aantal - 1, 0), 'regels te veel ===');
  p('(de dry-run vergelijkt alleen t.id, niet de inhoud)');
  d.idBotsingen.forEach(x => {
    p('   id', x.id, '—', x.aantal + '×', '—',
      x.zelfdeInhoud ? 'ZELFDE INHOUD (echte dubbele boeking)' : 'VERSCHILLENDE INHOUD (alleen nummerbotsing)');
    x.regels.forEach(t => p('      ' + regel(t)));
  });
  p('');

  p('=== 10. ALLE', d.tweeentwintigVolledig.length, 'BOEKINGEN VAN 2022 IN MIJN OPSLAG ===');
  d.tweeentwintigVolledig.forEach(t => p('   ' + regel(t)));

  return r.join('\n');
}

// ---------------------------------------------------------------- snapshot
//
// Bevriest de opslag op papier: elke sleutel met omvang, aantal records,
// datumbereik en een checksum, zodat later aantoonbaar is of er iets is
// veranderd. Ook dit leest alleen.

/** SHA-256 over de rauwe tekst, zodat elke wijziging zichtbaar wordt. */
async function checksum(tekst) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tekst));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {
    // Zonder https is crypto.subtle niet beschikbaar; dan een eenvoudige
    // controlewaarde, die voor vergelijken tussen twee momenten volstaat.
    let h = 2166136261;
    for (let i = 0; i < tekst.length; i++) { h ^= tekst.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fnv-' + (h >>> 0).toString(16);
  }
}

const datumsVan = lijst => lijst
  .map(t => String(t && (t.datum ?? t.date) || ''))
  .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

export async function opslagSnapshot() {
  const sleutels = [];
  for (let i = 0; i < localStorage.length; i++) sleutels.push(localStorage.key(i));
  sleutels.sort();

  const regels = [];
  for (const sleutel of sleutels) {
    const ruw = localStorage.getItem(sleutel) ?? '';
    const r = {
      sleutel,
      tekens: ruw.length,
      bytes: new Blob([ruw]).size,
      som: await checksum(ruw),
      vorm: 'tekst',
      records: null,
      eerste: null,
      laatste: null,
      perJaar: null,
      opmerking: ''
    };
    try {
      const d = JSON.parse(ruw);
      if (Array.isArray(d)) {
        r.vorm = 'lijst';
        r.records = d.length;
        const dt = datumsVan(d);
        if (dt.length) {
          r.eerste = dt[0]; r.laatste = dt[dt.length - 1];
          const pj = {};
          dt.forEach(x => { pj[x.slice(0, 4)] = (pj[x.slice(0, 4)] || 0) + 1; });
          r.perJaar = pj;
          if (dt.length < d.length) r.opmerking = `${d.length - dt.length} zonder geldige datum`;
        }
      } else if (d && typeof d === 'object') {
        r.vorm = 'object';
        r.records = Object.keys(d).length;
        const k = Object.keys(d).sort();
        if (k.length) { r.eerste = k[0]; r.laatste = k[k.length - 1]; }
      } else {
        r.vorm = typeof d;
        r.opmerking = String(ruw).slice(0, 40);
      }
    } catch {
      r.opmerking = 'geen geldige JSON';
    }
    regels.push(r);
  }

  // Voorraad en HNVI apart uitschrijven: die zijn bij de import vervangen en
  // we moeten kunnen nagaan wát er staat, niet alleen hoeveel.
  const lees = s => { try { const d = JSON.parse(localStorage.getItem(s) || 'null'); return Array.isArray(d) ? d : []; } catch { return []; } };
  const covers = lees('xtenate_covers').map(c => ({
    id: c.id, artikel: c.artikel, groep: c.groep ?? '', voorraad: c.voorraad,
    inkoopprijs: c.inkoopprijs ?? null, prijs: c.prijs ?? null
  }));
  const loten = lees('xtenate_hnvi').map(l => ({
    id: l.id, datum: l.datum, omschr: l.omschr, inkoop: l.inkoop, verkoop: l.verkoop, status: l.status
  }));

  // Sleutels die op een reservekopie lijken: die kunnen de oude stand bevatten.
  const kopieSleutels = sleutels.filter(s => /backup|kopie|reserve|snapshot|_bak/i.test(s));

  return {
    moment: new Date().toISOString(),
    momentLokaal: new Date().toLocaleString('nl-NL'),
    tijdzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    aantalSleutels: sleutels.length,
    totaalBytes: regels.reduce((s, r) => s + r.bytes, 0),
    regels,
    covers,
    loten,
    kopieSleutels
  };
}

export function opslagSnapshotAlsTekst(s) {
  const r = [];
  const p = (...a) => r.push(a.join(' '));
  p('SNAPSHOT OPSLAG XTENATE — ALLEEN LEZEN —', s.momentLokaal, '|', s.tijdzone);
  p('Er is niets geschreven. Deze momentopname dient als bevriezing.');
  p('');
  p(`${s.aantalSleutels} sleutels, samen ${s.totaalBytes} bytes`);
  p('');
  p('sleutel'.padEnd(34) + 'vorm'.padEnd(8) + 'records'.padStart(8) + 'bytes'.padStart(9)
    + '  eerste'.padEnd(14) + 'laatste'.padEnd(13) + 'checksum');
  s.regels.forEach(x => p(
    String(x.sleutel).padEnd(34) + String(x.vorm).padEnd(8)
    + String(x.records ?? '-').padStart(8) + String(x.bytes).padStart(9)
    + '  ' + String(x.eerste ?? '-').padEnd(12) + String(x.laatste ?? '-').padEnd(13)
    + x.som + (x.opmerking ? '  ← ' + x.opmerking : '')));
  p('');
  s.regels.filter(x => x.perJaar).forEach(x => p(x.sleutel, 'per jaar:', JSON.stringify(x.perJaar)));
  p('');
  p('=== RESERVEKOPIE-ACHTIGE SLEUTELS ===');
  p(s.kopieSleutels.length ? '  ' + s.kopieSleutels.join(', ') : '  geen gevonden');
  p('');
  p(`=== VOORRAADARTIKELEN (${s.covers.length}) ===`);
  s.covers.forEach(c => p(`   id=${c.id} | ${String(c.artikel).slice(0, 40).padEnd(40)} | groep ${c.groep} | voorraad ${c.voorraad} | inkoopprijs ${c.inkoopprijs ?? '-'}`));
  p('');
  p(`=== HNVI-LOTEN (${s.loten.length}) ===`);
  s.loten.forEach(l => p(`   id=${l.id} | ${l.datum || '(geen datum)'} | ${String(l.omschr).slice(0, 34).padEnd(34)} | inkoop ${l.inkoop} | verkoop ${l.verkoop ?? '-'} | ${l.status}`));
  return r.join('\n');
}

// -------------------------------------------------- de twee overrides voluit
//
// Checksums uit de snapshot van 12-8-2026 14:48. Ze staan hier zodat de app
// zelf kan aantonen dat er sindsdien niets aan die vier sleutels is veranderd,
// in plaats van dat je twee uitdraaien naast elkaar moet leggen.
const VORIGE_SNAPSHOT = {
  xtenate_tx: '13c524dc6c5d7c6f2c1cc00f560bfdca',
  xtenate_hist_tx_override: '24ffa564b17b1924f2ae5423a64582c9',
  xtenate_covers: 'e5891f96e6b2734dca30b9a2a7d95e4c',
  xtenate_hnvi: 'ea1cb0b02385968d823e3f780bcef348'
};

const HT_VELDEN = ['omzet', 'kosten', 'omzXt', 'omzBol', 'omzHC', 'priveOp', 'priveSt', 'hnviInv'];
const gelijk = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;

/** Leest de twee overrides voluit en legt ze naast de standaard uit de code. */
export async function overrideDetail() {
  const lees = async sleutel => {
    const ruw = localStorage.getItem(sleutel);
    return {
      sleutel,
      aanwezig: ruw !== null,
      ruw: ruw ?? '',
      tekens: (ruw ?? '').length,
      som: ruw === null ? '—' : await checksum(ruw),
      waarde: (() => { try { return ruw === null ? null : JSON.parse(ruw); } catch { return 'ONLEESBAAR'; } })()
    };
  };

  const ht = await lees('xtenate_home_totals_override');
  const ms = await lees('xtenate_maand_saldos_override');

  // Jaartotalen: per jaar en per veld naast de code-standaard.
  const htRegels = [];
  const jaren = [...new Set([
    ...Object.keys(ht.waarde && typeof ht.waarde === 'object' ? ht.waarde : {}),
    ...Object.keys(HOME_TOTALS_DEFAULT)
  ])].sort();
  jaren.forEach(jaar => {
    const mijn = (ht.waarde || {})[jaar] || null;
    const std = HOME_TOTALS_DEFAULT[jaar] || null;
    htRegels.push({
      jaar, mijn, std,
      afwijkend: HT_VELDEN.filter(v => !gelijk(mijn?.[v], std?.[v])),
      alleenBijMij: !!mijn && !std,
      alleenInCode: !mijn && !!std
    });
  });

  // Maandsaldi: per maand begin en eind naast de code-standaard.
  const msRegels = [];
  const maanden = [...new Set([
    ...Object.keys(ms.waarde && typeof ms.waarde === 'object' ? ms.waarde : {}),
    ...Object.keys(MAAND_SALDOS_DEFAULT)
  ])].sort();
  maanden.forEach(maand => {
    const mijn = (ms.waarde || {})[maand] || null;
    const std = MAAND_SALDOS_DEFAULT[maand] || null;
    msRegels.push({
      maand, mijn, std,
      afwijkend: ['begin', 'eind'].filter(v => !gelijk(mijn?.[v], std?.[v])),
      alleenBijMij: !!mijn && !std,
      alleenInCode: !mijn && !!std
    });
  });

  // Ontbrekende maanden binnen de reeks die in jouw opslag staat. Bewust niet
  // over de samenvoeging met de code, want dan vult de standaard de gaten op
  // en zie je juist niet wat er in je eigen opslag mist.
  const eigenMaanden = Object.keys(ms.waarde && typeof ms.waarde === 'object' ? ms.waarde : {}).sort();
  const gaten = [];
  if (eigenMaanden.length) {
    const [j0, m0] = eigenMaanden[0].split('-').map(Number);
    const [j1, m1] = eigenMaanden[eigenMaanden.length - 1].split('-').map(Number);
    for (let j = j0, m = m0; j < j1 || (j === j1 && m <= m1); m === 12 ? (m = 1, j++) : m++) {
      const sleutel = `${j}-${String(m).padStart(2, '0')}`;
      if (!eigenMaanden.includes(sleutel)) gaten.push(sleutel);
    }
  }

  // Controle op de vier sleutels uit de vorige snapshot.
  const controle = [];
  for (const [sleutel, verwacht] of Object.entries(VORIGE_SNAPSHOT)) {
    const ruw = localStorage.getItem(sleutel);
    const nu = ruw === null ? '—' : await checksum(ruw);
    controle.push({ sleutel, verwacht, nu, gelijk: nu === verwacht });
  }

  return { ht, ms, htRegels, msRegels, gaten, controle };
}

export function overrideDetailAlsTekst(d) {
  const r = [];
  const p = (...a) => r.push(a.join(' '));
  const g = n => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

  p('OVERRIDES VOLUIT — ALLEEN LEZEN —', new Date().toLocaleString('nl-NL'));
  p('Er is niets geschreven, gecorrigeerd of overschreven.');
  p('');

  p('=== CONTROLE TEGEN DE VORIGE SNAPSHOT (12-8-2026 14:48) ===');
  d.controle.forEach(c => p('  ', (c.gelijk ? 'GELIJK  ' : 'AFWIJKEND'), c.sleutel.padEnd(28),
    'verwacht', c.verwacht, '| nu', c.nu));
  p('  ', d.controle.every(c => c.gelijk)
    ? 'Alle vier de sleutels zijn onveranderd.'
    : 'LET OP: er is iets veranderd sinds de vorige snapshot.');
  p('');

  p('=== xtenate_home_totals_override ===');
  p('  aanwezig:', d.ht.aanwezig, '| tekens:', d.ht.tekens, '| checksum:', d.ht.som);
  p('  RUWE WAARDE:');
  p('  ' + d.ht.ruw);
  p('');
  p('  jaar | veld     | in mijn opslag | in de code   | gelijk');
  d.htRegels.forEach(x => {
    if (x.alleenInCode) { p(`  ${x.jaar} | (staat niet in mijn opslag, wel in de code)`); return; }
    if (!x.mijn) return;
    HT_VELDEN.forEach(v => {
      const zelfde = !x.afwijkend.includes(v);
      p(`  ${x.jaar} | ${v.padEnd(8)} | ${g(x.mijn?.[v]).padStart(14)} | ${g(x.std?.[v]).padStart(12)} | ${zelfde ? 'ja' : 'NEE'}`);
    });
  });
  p('');

  p('=== xtenate_maand_saldos_override ===');
  p('  aanwezig:', d.ms.aanwezig, '| tekens:', d.ms.tekens, '| checksum:', d.ms.som);
  p('  RUWE WAARDE:');
  p('  ' + d.ms.ruw);
  p('');
  p('  maand   | begin (mij) | eind (mij) | begin (code) | eind (code) | gelijk');
  d.msRegels.forEach(x => p(
    `  ${x.maand} | ${g(x.mijn?.begin).padStart(11)} | ${g(x.mijn?.eind).padStart(10)} | ` +
    `${g(x.std?.begin).padStart(12)} | ${g(x.std?.eind).padStart(11)} | ` +
    (x.alleenBijMij ? 'alleen bij mij' : x.alleenInCode ? 'alleen in code' : x.afwijkend.length ? 'NEE: ' + x.afwijkend.join(',') : 'ja')));
  p('');
  p('  ontbrekende maanden binnen de reeks:', d.gaten.length ? d.gaten.join(', ') : 'geen');
  return r.join('\n');
}

// ------------------------------------------ genegeerde meldingen en backup

/** Leest xtenate_controle_negeer voluit en toont waar elke melding naar wijst. */
export async function negeerDetail() {
  const ruw = localStorage.getItem('xtenate_controle_negeer');
  const uit = { aanwezig: ruw !== null, ruw: ruw ?? '', som: ruw === null ? '—' : await checksum(ruw),
                meldingen: [], controles: [], fout: null };
  if (ruw === null) return uit;
  let d;
  try { d = JSON.parse(ruw); } catch (e) { uit.fout = e.message; return uit; }

  // De sleutel van een melding is `${controleId}::${itemSleutel}` en itemSleutel
  // is bij de meeste controles het boekingsnummer. Dat nummer verandert bij een
  // herstel, dus we tonen het apart zodat je kunt zien wat er stukgaat.
  Object.entries(d.meldingen || {}).forEach(([sleutel, m]) => {
    uit.meldingen.push({
      sleutel,
      controleId: m.controleId ?? sleutel.split('::')[0],
      itemSleutel: m.itemSleutel ?? sleutel.split('::').slice(1).join('::'),
      label: m.label ?? '', controleTitel: m.controleTitel ?? '',
      reden: m.reden ?? '', vinger: m.vinger ?? '', wanneer: m.wanneer ?? ''
    });
  });
  Object.entries(d.controles || {}).forEach(([id, c]) => {
    uit.controles.push({ controleId: id, controleTitel: c.controleTitel ?? '', wanneer: c.wanneer ?? '' });
  });
  return uit;
}

/**
 * Bouwt een volledige reservekopie van localStorage als bestand en biedt die
 * aan als download. Er wordt niets naar localStorage geschreven — alleen
 * gelezen en weggeschreven naar je schijf.
 */
export async function backupBestand() {
  const inhoud = {};
  const sleutels = [];
  for (let i = 0; i < localStorage.length; i++) sleutels.push(localStorage.key(i));
  sleutels.sort();
  for (const s of sleutels) inhoud[s] = localStorage.getItem(s);

  const per = {};
  for (const s of sleutels) {
    const ruw = inhoud[s] ?? '';
    let records = null, vorm = 'tekst';
    try {
      const d = JSON.parse(ruw);
      if (Array.isArray(d)) { vorm = 'lijst'; records = d.length; }
      else if (d && typeof d === 'object') { vorm = 'object'; records = Object.keys(d).length; }
      else vorm = typeof d;
    } catch { vorm = 'tekst (geen JSON)'; }
    per[s] = { vorm, records, tekens: ruw.length, bytes: new Blob([ruw]).size, som: await checksum(ruw) };
  }

  const pakket = {
    soort: 'xtenate-volledige-reservekopie',
    versie: 1,
    gemaakt: new Date().toISOString(),
    tijdzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    aantalSleutels: sleutels.length,
    perSleutel: per,
    inhoud
  };
  const tekst = JSON.stringify(pakket, null, 2);
  const naam = 'xtenate-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';

  const blob = new Blob([tekst], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = naam;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return { naam, sleutels: sleutels.length, tekens: tekst.length, som: await checksum(tekst), per };
}

// ------------------------------------------- negeerlijst met D1-gevolgen
//
// Voor elke weggeklikte melding: waar wijst hij naar, raakt D1 die boeking,
// welk nummer krijgt hij daarna, en is meemigreren zinvol. Leest alleen.

const zonderDatum = t => [
  Number(t.bedrag).toFixed(2), String(t.gb), String(t.rek),
  String(t.naam || '').trim().toLowerCase(), String(t.omschr || '').trim().toLowerCase()
].join('|');

const dagErbij = datum => {
  const d = new Date(datum + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export async function negeerAnalyse() {
  const ruw = localStorage.getItem('xtenate_controle_negeer');
  const uit = {
    moment: new Date().toISOString(), momentLokaal: new Date().toLocaleString('nl-NL'),
    aanwezig: ruw !== null, ruw: ruw ?? '', som: ruw === null ? '—' : await checksum(ruw),
    regels: [], fout: null
  };
  if (ruw === null) return uit;
  let d;
  try { d = JSON.parse(ruw); } catch (e) { uit.fout = e.message; return uit; }

  const hist = Array.isArray(state.HIST_TX) ? state.HIST_TX : [];
  const tx = Array.isArray(state.TX) ? state.TX : [];
  const covers = Array.isArray(state.COVERS) ? state.COVERS : [];
  const loten = Array.isArray(state.HNVI_LOTS) ? state.HNVI_LOTS : [];

  // Code-boekingen gegroepeerd op inhoud zonder datum, om de tegenhanger te vinden.
  const codeGroep = new Map();
  HIST_TX_DEFAULT.forEach(t => {
    const k = t.datum + '#' + zonderDatum(t);
    if (!codeGroep.has(k)) codeGroep.set(k, []);
    codeGroep.get(k).push(t);
  });

  Object.entries(d.controles || {}).forEach(([id, c]) => uit.regels.push({
    soort: 'controle', sleutel: id, huidigId: id, itemSleutel: '', vinger: '',
    entiteit: 'geen — hele controle uitgezet', wijstNaar: 'hele controle uitgezet',
    geraaktDoorD1: false, d1: 'NEE', nieuwId: '',
    oordeel: 'JA', toelichting: 'verwijst niet naar een boeking',
    controleTitel: c.controleTitel ?? '', reden: 'nooit', wanneer: c.wanneer ?? '', label: ''
  }));

  Object.entries(d.meldingen || {}).forEach(([sleutel, m]) => {
    const item = String(m.itemSleutel ?? sleutel.split('::').slice(1).join('::'));
    const vinger = String(m.vinger ?? '');
    const r = {
      soort: 'melding', sleutel, huidigId: item, itemSleutel: item, vinger,
      controleId: m.controleId ?? sleutel.split('::')[0],
      controleTitel: m.controleTitel ?? '', label: m.label ?? '',
      reden: m.reden ?? '', wanneer: m.wanneer ?? '',
      entiteit: '', wijstNaar: '', geraaktDoorD1: false, d1: 'NEE',
      nieuwId: '', oordeel: '', toelichting: ''
    };

    const inHist = hist.find(t => String(t.id) === item);
    const inTx = tx.find(t => String(t.id) === item);
    const cover = covers.find(c => String(c.id) === item);
    const lot = loten.find(l => String(l.id) === item || String(l._key) === item);

    if (inHist) {
      r.entiteit = 'historische boeking';
      r.wijstNaar = `${inHist.datum} · ${Number(inHist.bedrag).toFixed(2)} · ${inHist.naam || '(geen naam)'}`;
      r.geraaktDoorD1 = true; r.d1 = 'JA';
      const kandidaten = codeGroep.get(dagErbij(inHist.datum) + '#' + zonderDatum(inHist)) || [];
      if (kandidaten.length === 1) {
        r.nieuwId = String(kandidaten[0].id);
        if (vinger && vinger.includes(inHist.datum)) {
          r.oordeel = 'NEE';
          r.toelichting = 'de vingerafdruk bevat de oude datum; de melding komt hoe dan ook terug';
        } else {
          r.oordeel = 'JA';
          r.toelichting = 'precies één tegenhanger in de codehistorie';
        }
      } else if (kandidaten.length > 1) {
        // Niet gokken: meerdere identieke boekingen, dus niet te bepalen welke bedoeld was.
        r.nieuwId = '';
        r.oordeel = 'ONBESLIST';
        r.toelichting = `${kandidaten.length} identieke boekingen (${kandidaten.map(t => t.id).join(', ')}); niet te bepalen welke bedoeld was`;
      } else {
        r.nieuwId = '';
        r.oordeel = 'ONBESLIST';
        r.toelichting = 'geen tegenhanger in de codehistorie gevonden';
      }
    } else if (inTx) {
      r.entiteit = 'boeking lopend jaar';
      r.wijstNaar = `${inTx.datum} · ${Number(inTx.bedrag).toFixed(2)} · ${inTx.naam || ''}`;
      r.oordeel = 'JA'; r.toelichting = 'xtenate_tx wordt niet aangeraakt';
    } else if (cover) {
      r.entiteit = 'voorraadartikel';
      r.wijstNaar = String(cover.artikel || '');
      r.oordeel = 'JA'; r.toelichting = 'de voorraad wordt niet aangeraakt';
    } else if (lot) {
      r.entiteit = 'HNVI-lot';
      r.wijstNaar = String(lot.omschr || '');
      r.oordeel = 'JA'; r.toelichting = 'de loten worden niet aangeraakt';
    } else {
      r.entiteit = 'onbekend';
      r.wijstNaar = 'niet gevonden';
      r.oordeel = 'N.V.T.'; r.toelichting = 'verwijst al nergens meer naar';
    }
    uit.regels.push(r);
  });

  uit.aantalMeldingen = uit.regels.filter(r => r.soort === 'melding').length;
  uit.aantalControles = uit.regels.filter(r => r.soort === 'controle').length;
  uit.aantalTotaal = uit.regels.length;
  uit.geraakt = uit.regels.filter(r => r.geraaktDoorD1).length;
  uit.perOordeel = uit.regels.reduce((a, r) => { a[r.oordeel] = (a[r.oordeel] || 0) + 1; return a; }, {});
  return uit;
}

const csvVeld = v => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Zet de negeerlijst als JSON en CSV op je schijf. Schrijft niets terug. */
export async function downloadNegeerlijst() {
  const a = await negeerAnalyse();
  const stempel = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');

  // Exact dezelfde gegevensverzameling als de JSON, alleen plat gemaakt.
  const kolommen = ['soort', 'sleutel', 'huidigId', 'controleId', 'controleTitel', 'label',
    'reden', 'wanneer', 'vinger', 'entiteit', 'wijstNaar', 'd1', 'nieuwId', 'oordeel', 'toelichting'];
  const csv = [kolommen.join(';'),
    ...a.regels.map(r => kolommen.map(k => csvVeld(r[k])).join(';'))].join('\n');

  const zet = (tekst, naam, type) => {
    const url = URL.createObjectURL(new Blob([tekst], { type }));
    const el = document.createElement('a');
    el.href = url; el.download = naam;
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  zet(JSON.stringify(a, null, 2), `xtenate-negeerlijst-${stempel}.json`, 'application/json');
  setTimeout(() => zet(csv, `xtenate-negeerlijst-${stempel}.csv`, 'text/csv'), 400);

  return { analyse: a, csvRegels: a.regels.length, som: await checksum(csv) };
}
