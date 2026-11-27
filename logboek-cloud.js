// logboek-cloud.js — zet het logboek ook in Supabase (tabel logboek, zie logboek.sql), zodat je
// het op een andere computer ziet en niemand er ongemerkt in kan wijzigen of wissen.
//
// Veiligheid voor je administratie:
//  - Alleen zodra een regel is geschreven wordt hij in een eigen wachtrij gezet; het versturen
//    gebeurt later, op de achtergrond, los van het opslaan van boekingen.
//  - Elke fout wordt ingeslikt. Bestaat de tabel nog niet, dan stopt dit 24 uur (één melding).
//  - Elke regel heeft een client_id; opnieuw versturen kan dus nooit een dubbele regel geven.

import { getClient, heeftClient } from './supabase.js?v=20261127e';
import { zetCloudSink } from './logboek.js?v=20261127e';

const WACHTRIJ = 'xtenate_logboek_wachtrij';
const UIT_TOT = 'xtenate_logboek_cloud_uit_tot';
const MAX_WACHTRIJ = 2000;
const BATCH = 100;
const VERTRAGING_MS = 3000;

let timer = null, bezig = false, gemeld = false;
export const cloudStatus = { aantalWacht: 0, uitTot: 0, laatsteFout: null, laatsteOk: null };

const leesWacht = () => { try { const l = JSON.parse(localStorage.getItem(WACHTRIJ) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
const schrijfWacht = l => { try { localStorage.setItem(WACHTRIJ, JSON.stringify(l.slice(-MAX_WACHTRIJ))); } catch { /* vol of geblokkeerd */ } };
const uitTot = () => { try { return Number(localStorage.getItem(UIT_TOT)) || 0; } catch { return 0; } };

const nieuwId = () => {
  try { if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch { /* terugval */ }
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
};
const apparaat = () => { try { return String(navigator.userAgent || '').slice(0, 120); } catch { return ''; } };

function isOnbekendeTabel(error) {
  const t = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return error?.code === '42P01' || t.includes('does not exist') || t.includes('schema cache');
}

/** Wordt voor elke logregel aangeroepen (zie zetCloudSink). Doet zelf geen netwerkwerk. */
function toevoegen(r) {
  try {
    const l = leesWacht();
    l.push({ client_id: nieuwId(), soort: r.soort, actie: r.actie, tekst: String(r.tekst || '').slice(0, 500), lokaal: r.t, apparaat: apparaat() });
    schrijfWacht(l);
    cloudStatus.aantalWacht = l.length;
    plan();
  } catch { /* nooit storen */ }
}

function plan(ms = VERTRAGING_MS) {
  if (timer || Date.now() < uitTot()) return;
  timer = setTimeout(() => { timer = null; verstuur(); }, ms);
}

/** Verstuurt de wachtrij in blokken. Houdt regels bij een fout bewaard voor later. */
export async function verstuur() {
  if (bezig) return;
  try {
    if (Date.now() < uitTot()) return;
    const eerst = leesWacht();
    if (!eerst.length) return;
    if (!heeftClient()) { plan(30000); return; } // nog niet ingelogd/verbonden
    bezig = true;
    const sb = await getClient();
    for (;;) {
      const blok = leesWacht().slice(0, BATCH);
      if (!blok.length) break;
      const rijen = blok.map(r => ({
        client_id: r.client_id, soort: r.soort, actie: r.actie, tekst: r.tekst,
        na: { lokaal: r.lokaal }, apparaat: r.apparaat
      }));
      const { error } = await sb.from('logboek').upsert(rijen, { onConflict: 'user_id,client_id', ignoreDuplicates: true });
      if (error) {
        cloudStatus.laatsteFout = error.message || String(error.code || 'fout');
        if (isOnbekendeTabel(error)) {
          try { localStorage.setItem(UIT_TOT, String(Date.now() + 24 * 3600 * 1000)); } catch { /* */ }
          if (!gemeld) { gemeld = true; console.info('[logboek] Cloud-logboek staat nog uit: voer logboek.sql eens uit in Supabase.'); }
        } else {
          plan(60000); // later opnieuw (offline, sessie verlopen, ...)
        }
        break;
      }
      const verstuurd = new Set(blok.map(r => r.client_id));
      schrijfWacht(leesWacht().filter(r => !verstuurd.has(r.client_id)));
      cloudStatus.laatsteOk = Date.now(); cloudStatus.laatsteFout = null;
    }
    cloudStatus.aantalWacht = leesWacht().length;
  } catch (e) {
    cloudStatus.laatsteFout = e && e.message || 'fout';
    plan(60000);
  } finally { bezig = false; }
}

/** Haalt de nieuwste regels uit de cloud. Geeft { regels } of { fout, tabelOntbreekt }. */
export async function haalCloudLogboek(maximum = 100) {
  try {
    if (!heeftClient()) return { fout: 'Niet verbonden met de cloud.' };
    const sb = await getClient();
    const { data, error } = await sb.from('logboek').select('id,tijd,soort,actie,tekst,apparaat').order('id', { ascending: false }).limit(maximum);
    if (error) return isOnbekendeTabel(error) ? { tabelOntbreekt: true, fout: 'logboek.sql is nog niet uitgevoerd in Supabase.' } : { fout: error.message };
    return { regels: data || [] };
  } catch (e) { return { fout: e && e.message || 'Onbekende fout' }; }
}

/** Laat de database de hele ketting narekenen. */
export async function controleerCloudLogboek() {
  try {
    const sb = await getClient();
    const { data, error } = await sb.rpc('logboek_controle');
    if (error) return { fout: error.message };
    return data;
  } catch (e) { return { fout: e && e.message || 'Onbekende fout' }; }
}

export function startLogboekCloud() {
  zetCloudSink(toevoegen);
  cloudStatus.aantalWacht = leesWacht().length;
  cloudStatus.uitTot = uitTot();
  if (cloudStatus.aantalWacht) plan(10000);
}

export const _test = { leesWacht, toevoegen };
