// bol.js — Bol.com-bestellingen: ophalen via de Edge Function bol-koppeling, lezen uit de
// tabel bol_bestellingen en uitrekenen (stuks, omzet, commissie). Alleen lezen en tonen:
// dit raakt je boekingen en je voorraad niet.

import { getClient } from './supabase.js?v=20261024s';
import { state } from './storage.js?v=20261024s';
import { vandaagIso } from './jaren.js?v=20261024s';

const dag = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = n => Math.round(n * 100) / 100;

/** Alle opgeslagen bestellingen (nieuwste eerst). */
export async function leesBestellingen() {
  const sb = await getClient();
  const alle = [];
  for (let van = 0; van < 20000; van += 1000) {
    const { data, error } = await sb.from('bol_bestellingen')
      .select('account, order_id, besteld, datum, items, opgehaald_op').order('datum', { ascending: false }).range(van, van + 999);
    if (error) throw new Error('lezen mislukt');
    alle.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return alle;
}

/** Alle opgeslagen retouren. Geeft null als de tabel nog niet bestaat (dan werkt de pagina gewoon zonder retouren). */
export async function leesRetouren() {
  try {
    const sb = await getClient();
    const alle = [];
    for (let van = 0; van < 20000; van += 1000) {
      const { data, error } = await sb.from('bol_retouren')
        .select('account, rma_id, order_id, ean, aantal, geaccepteerd, afgewezen, datum, reden, afgehandeld, resultaten')
        .order('datum', { ascending: false }).range(van, van + 999);
      if (error) return null;
      alle.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return alle;
  } catch { return null; }
}

/**
 * Rekent retouren door met de prijs en commissie van de bijbehorende bestelling (alle bestellingen, ook buiten de gekozen periode).
 * Terugbetaald = geaccepteerde stuks × verkoopprijs. Commissie die Bol terugboekt: naar verhouding (aanname, controleer met je afrekening).
 * Retouren van een bestelling die niet in de opgeslagen bestellingen staat, tellen mee in het aantal maar niet in het bedrag.
 */
export function retourSamenvatting(retouren, alleBestellingen) {
  const regel = new Map();
  for (const b of alleBestellingen || []) for (const i of b.items || []) regel.set(`${b.account || '1'}|${b.order_id}|${i.ean}`, i);
  let stuks = 0, bedrag = 0, commissie = 0, inBehandeling = 0, afgewezen = 0, onbekend = 0;
  const rijen = [];
  for (const r of retouren || []) {
    const i = regel.get(`${r.account || '1'}|${r.order_id}|${r.ean}`);
    const n = Number(r.geaccepteerd) || 0;
    const per = i ? (Number(i.prijs) || 0) : 0;
    const cper = i ? (Number(i.commissie) || 0) / Math.max(1, Number(i.aantal) || 1) : 0;
    stuks += n; bedrag += n * per; commissie += n * cper;
    if (n && !i) onbekend += n;
    if (!r.afgehandeld) inBehandeling += Number(r.aantal) || 0;
    afgewezen += Number(r.afgewezen) || 0;
    rijen.push({ ...r, titel: i?.titel || '', terug: r2(n * per) });
  }
  return { aantal: (retouren || []).length, stuks, bedrag: r2(bedrag), commissie: r2(commissie), inBehandeling, afgewezen, onbekend, rijen };
}

/**
 * Haalt een periode op bij Bol, in stukken van 31 dagen (de functie accepteert niet meer per keer).
 * `voortgang(tekst)` krijgt tussentijdse meldingen. Geeft { opgeslagen, onvolledig } of gooit een Error met een leesbare tekst.
 */
export async function haalBijBol(van, tot, voortgang = () => {}, account = 'alle') {
  const sb = await getClient();
  let opgeslagen = 0, onvolledig = false;
  let start = van;
  while (start <= tot) {
    const eind = dag(start, 30) < tot ? dag(start, 30) : tot;
    voortgang(`Ophalen ${start} t/m ${eind}…`);
    const { data, error } = await sb.functions.invoke('bol-koppeling', { body: { van: start, tot: eind, account } });
    let fout = data && data.fout, geenSleutels = data && data.geenSleutels;
    if (error && !fout) { try { const j = await error.context.json(); fout = j?.fout; geenSleutels = j?.geenSleutels; } catch { /* geen detail */ } }
    if (error || !data?.ok) {
      const e = new Error(fout || 'Ophalen bij Bol is niet gelukt.');
      e.geenSleutels = !!geenSleutels;
      throw e;
    }
    opgeslagen += data.opgeslagen || 0;
    if (data.onvolledig) onvolledig = true;
    start = dag(eind, 1);
  }
  return { opgeslagen, onvolledig };
}

/** Welke Bol-accounts zijn ingesteld? [{ nummer, naam }], of null als dat niet lukt (bijvoorbeeld nog geen sleutels). */
export async function leesBolAccounts() {
  try {
    const sb = await getClient();
    const { data, error } = await sb.functions.invoke('bol-koppeling', { body: { actie: 'info' } });
    return !error && data?.ok ? data.accounts : null;
  } catch { return null; }
}

/** Effectief aantal van een regel: besteld min geannuleerd. */
const effectief = i => Math.max(0, (Number(i.aantal) || 0) - (Number(i.geannuleerd) || 0));

/** Rekent een lijst bestellingen door. Een volledig geannuleerde regel telt niet mee (ook niet voor commissie). */
export function samenvatting(bestellingen) {
  let stuks = 0, omzet = 0, commissie = 0, orders = 0, geannuleerd = 0;
  const perArtikel = new Map();
  for (const b of bestellingen) {
    let telt = false;
    for (const i of b.items || []) {
      const n = effectief(i);
      if (!n) { geannuleerd += 1; continue; }
      telt = true;
      const bedrag = n * (Number(i.prijs) || 0);
      // Commissie loopt mee naar verhouding als maar een deel is geannuleerd.
      const comm = (Number(i.commissie) || 0) * (n / Math.max(1, Number(i.aantal) || n));
      stuks += n; omzet += bedrag; commissie += comm;
      const sleutel = i.ean || i.titel || '?';
      const a = perArtikel.get(sleutel) || { ean: i.ean || '', titel: i.titel || sleutel, stuks: 0, omzet: 0, commissie: 0 };
      a.stuks += n; a.omzet += bedrag; a.commissie += comm;
      perArtikel.set(sleutel, a);
    }
    if (telt) orders++;
  }
  return {
    orders, stuks, omzet: r2(omzet), commissie: r2(commissie), netto: r2(omzet - commissie), geannuleerdeRegels: geannuleerd,
    perArtikel: [...perArtikel.values()].map(a => ({ ...a, omzet: r2(a.omzet), commissie: r2(a.commissie) })).sort((x, y) => y.omzet - x.omzet)
  };
}

/** Uitbetalingen van Bol op je bankrekening in een periode: inkomstboekingen op 8010 of met "bol" in de naam. */
export function bolUitbetalingen(van, tot) {
  const regels = [...(state.TX || []), ...(state.HIST_TX || [])].filter(t =>
    t.type === 'inkomst' && t.datum >= van && t.datum <= tot &&
    (String(t.gb) === '8010' || /bol\.?com|bolcom/i.test(`${t.naam || ''} ${t.omschr || ''}`)));
  return { aantal: regels.length, totaal: r2(regels.reduce((s, t) => s + (Number(t.bedrag) || 0), 0)), regels };
}

export const standaardPeriodes = () => {
  const nu = vandaagIso();
  return {
    laatste7: [dag(nu, -7), nu],
    laatste31: [dag(nu, -31), nu],
    laatste90: [dag(nu, -89), nu]
  };
};
