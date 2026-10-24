/**
 * supabase-client-v2.js
 * 
 * Supabase layer with:
 * - Pending queue management (reliable sync)
 * - Save/delete with retry logic
 * - Fallback to localStorage
 * - RLS-aware loading
 * - No data loss on offline/failures
 * 
 * Fase 3A Implementation
 */

import { getClient, heeftClient, leesbareFout } from './supabase.js?v=20261023z';

// ===== NOODREM =====
export function syncIsAangezet() {
  try {
    return localStorage.getItem('xtenate_sync_aan') === 'ja';
  } catch {
    return false;
  }
}

// ===== PENDING QUEUE STATE =====
export const pendingQueue = {};
const QUEUE_STORAGE_KEY = 'xtenate_pending_queue_v2';

// Onthoudt, per legacy_id, de laatste foutmelding van een mislukte
// save/delete-poging — puur informatief voor de wachtrijweergave in Beheer.
// Bewust géén wijziging van wat de save/delete-functies zelf teruggeven
// (nog steeds gewoon true/false): tien andere plekken in de app controleren
// dat resultaat rechtstreeks (bijv. `if (await saveCoverToSupabase(...))`),
// en die moeten onveranderd blijven werken.
const laatsteFoutPerId = {};

export function savePendingQueue() {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(pendingQueue));
    console.log(`📝 Saved pending queue (${Object.keys(pendingQueue).length} items)`);
  } catch (err) {
    console.error('Failed to save pending queue:', err);
  }
}

export function loadPendingQueue() {
  try {
    const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!saved) return;
    
    const loaded = JSON.parse(saved);
    Object.assign(pendingQueue, loaded);
    
    const count = Object.keys(pendingQueue).length;
    if (count > 0) {
      console.log(`⏳ Restored ${count} pending items from localStorage`);
    }
  } catch (err) {
    console.error('Failed to load pending queue:', err);
  }
}

export function clearPendingQueueItem(key) {
  delete pendingQueue[key];
  savePendingQueue();
}

export function addToPendingQueue(boeking, operation, isHistoric = false, soortHint = null) {
  // De sleutel bevat geen tijdstip meer. Bewerk je hetzelfde artikel drie keer
  // achter elkaar, dan stonden er eerst drie regels in de wachtrij die alle
  // drie verstuurd werden — de eerste twee met verouderde gegevens. Nu
  // vervangt een nieuwe bewerking de vorige, zodat alleen de laatste stand
  // wordt verstuurd.
  const key = `${operation}_${boeking.id}`;

  // Voorraadartikelen en HNVI-loten hebben heel andere velden dan een boeking.
  // Die mogen niet worden teruggeknipt tot boekingsvelden, anders staat er
  // straks een lege regel in de wachtrij en is de wijziging alsnog kwijt.
  const isBoeking = operation !== 'hnvi' && operation !== 'cover';

  let data = null;
  if (operation !== 'delete') {
    data = isBoeking
      ? {
          id: boeking.id,
          datum: boeking.datum,
          bedrag: boeking.bedrag,
          naam: boeking.naam,
          omschr: boeking.omschr,
          type: boeking.type,
          rek: boeking.rek,
          gb: boeking.gb,
          bron: boeking.bron,
          btw_percentage: boeking.btw_percentage,
          btw_bedrag: boeking.btw_bedrag,
          relatieId: boeking.relatieId ?? null
        }
      : { ...boeking };
  }

  // Verwijderen maakt eerdere wijzigingen op hetzelfde ding zinloos. Die halen
  // we weg, anders zou een oude 'update' het net verwijderde item opnieuw
  // aanmaken.
  if (operation === 'delete') {
    for (const k of Object.keys(pendingQueue)) {
      if (pendingQueue[k].id === boeking.id && pendingQueue[k].operation !== 'delete') {
        delete pendingQueue[k];
      }
    }
  }

  pendingQueue[key] = {
    id: boeking.id,
    operation: operation,
    // 'delete' zegt op zichzelf niet uit welke tabel — die operatie wordt
    // voor boekingen, voorraad én HNVI gebruikt. Vroeger viel dat terug op
    // 'auto', dat tabellen op volgorde probeert en de eerste zonder
    // foutmelding als "gelukt" beschouwde — ook als die tabel gewoon niets
    // te verwijderen had. Voor boekingen betekende dat: nooit bij de tabel
    // `boekingen` aankomen. Een aanroeper die weet om welk soort record het
    // gaat, geeft dat nu expliciet mee via soortHint; alleen aanroepers die
    // dat niet doen vallen nog terug op 'auto' (nu zelf ook gerepareerd, zie
    // deleteFromSupabase).
    soort: soortHint || (operation === 'hnvi' ? 'hnvi' : operation === 'cover' ? 'cover' : 'auto'),
    isHistoric: isHistoric,
    status: 'pending',
    timestamp: Date.now(),
    attempts: 0,
    maxAttempts: 5,
    data
  };
  
  savePendingQueue();
  console.log(`➕ Added to pending queue: ${operation} ${boeking.id}`);
  
  return key;
}

/**
 * Hoeveel staat er open en hoeveel is er blijven steken? De autosync gebruikt
 * dit om te melden dat er iets niet aankomt, in plaats van stil te blijven
 * proberen.
 */
export function wachtrijStatus() {
  const alles = Object.values(pendingQueue);
  return {
    open: alles.filter(p => p.attempts < (p.maxAttempts || 5)).length,
    vastgelopen: alles.filter(p => p.attempts >= (p.maxAttempts || 5)).length,
    totaal: alles.length
  };
}

/** Zet vastgelopen items terug op nul pogingen, zodat de knop echt opnieuw probeert. */
export function herstartVastgelopen() {
  let aantal = 0;
  for (const p of Object.values(pendingQueue)) {
    if (p.attempts >= (p.maxAttempts || 5)) { p.attempts = 0; p.status = 'pending'; aantal++; }
  }
  if (aantal) savePendingQueue();
  return aantal;
}

// ===== LOAD FROM SUPABASE =====

/**
 * Laad alle HNVI-loten van Supabase
 */
export async function loadHnviFromSupabase() {
  if (!heeftClient()) return [];
  
  try {
    const sb = await getClient();
    
    const { data, error } = await sb
      .from('hnvi_loten')
      .select('*')
      .is('deleted_at', null)
      .order('datum');
    
    if (error) {
      console.warn('⚠️  HNVI load failed:', error.message);
      return [];
    }
    
    if (!data || data.length === 0) return [];
    
    return data.map(lot => ({
      id: parseInt(lot.legacy_id) || lot.legacy_id,
      _key: String(lot.legacy_id),
      datum: lot.datum,
      omschr: lot.omschrijving,
      inkoop: lot.inkoop,
      verkoop: lot.verkoop,
      status: lot.status,
      noot: lot.notitie,
      factuur: lot.factuur || '',
      verkoopDatum: lot.verkoopdatum || ''
    }));
  } catch (err) {
    console.warn('Error in loadHnviFromSupabase:', err);
    return [];
  }
}

/**
 * Laad alle Covers (voorraadartikelen) van Supabase
 */
export async function loadCoversFromSupabase() {
  if (!heeftClient()) return [];
  
  try {
    const sb = await getClient();
    
    const { data, error } = await sb
      .from('voorraadartikelen')
      .select('*')
      .is('deleted_at', null)
      .order('artikel');
    
    if (error) {
      console.warn('⚠️  Covers load failed:', error.message);
      return [];
    }
    
    if (!data || data.length === 0) return [];
    
    const huidigJaar = String(new Date().getFullYear());

    return data.map(c => {
      // jaren kan null/leeg zijn uit Supabase (vooral oude records)
      let jaren = {};
      if (c.jaren && typeof c.jaren === 'object') {
        jaren = c.jaren;
      } else if (typeof c.jaren === 'string') {
        try { jaren = JSON.parse(c.jaren); } catch (e) { jaren = {}; }
      }

      // Als jaren leeg is maar we hebben wel ingekochte stuks, probeer ze te reconstrueren
      if (!Object.keys(jaren).length && (c.ingekocht || c.verkocht)) {
        jaren[huidigJaar] = {
          inkoop: c.ingekocht || 0,
          verkocht: c.verkocht || 0,
          eind: c.voorraad || 0
        };
      }

      // Belangrijk: een lege prijs blijft leeg. Zou hier 0 staan, dan telt het
      // artikel mee als "prijs bekend, waarde nul" en klopt de voorraadwaarde niet.
      const ip = c.inkoopprijs == null ? null : Number(c.inkoopprijs);
      const vp = c.verkoopprijs == null ? null : Number(c.verkoopprijs);

      return {
        id: parseInt(c.legacy_id) || c.legacy_id,
        artikel: c.artikel,
        categorie: c.categorie || 'overig',
        inkoop: c.ingekocht || 0,
        inkoopprijs: ip,
        voorraad: c.voorraad || 0,
        prijs: vp,
        omzet2026: c.verkocht || 0,
        zoekterm: c.zoekterm || '',
        minVoorraad: c.min_voorraad,
        handelsvoorraad: c.handelsvoorraad !== false,
        prijsFactor: Number(c.prijsfactor) > 0 ? Number(c.prijsfactor) : 1,
        inkoopGb: c.inkooprekening || '7000',
        jaren
      };
    });
  } catch (err) {
    console.warn('Error in loadCoversFromSupabase:', err);
    return [];
  }
}

// ─── RELATIES (fase 4a van de facturenmodule) ──────────────────────────────
// Een eigen tabel, anders dan grootboek/rekeningen/groepen: die zijn platte
// naam-opzoeklijsten waar niets naar verwijst, een relatie wordt straks
// vanuit een factuur aangewezen via een echte id. RLS filtert al op
// user_id = auth.uid(), dus hier geen losse .eq('user_id', ...) nodig.

/** Zet één relatie-rij uit Supabase (snake_case) om naar het vormpje dat de
 *  rest van de app gebruikt (camelCase, zelfde stijl als BEDRIJFSGEGEVENS). */
function relatieUitRij(r) {
  return {
    id: r.id, naam: r.naam, aliassen: r.aliassen || [],
    adres: r.adres || null,
    postcodePlaats: r.postcode_plaats || null,
    kvkNummer: r.kvk_nummer || null,
    btwNummer: r.btw_nummer || null
  };
}

export async function loadRelatiesFromSupabase() {
  if (!heeftClient()) return [];
  try {
    const sb = await getClient();
    const { data, error } = await sb
      .from('relaties')
      .select('id, naam, aliassen, adres, postcode_plaats, kvk_nummer, btw_nummer')
      .is('deleted_at', null)
      .order('naam');
    if (error) {
      console.warn('⚠️  Relaties laden mislukt:', error.message);
      return [];
    }
    return (data || []).map(relatieUitRij);
  } catch (err) {
    console.warn('Error in loadRelatiesFromSupabase:', err);
    return [];
  }
}

export async function maakRelatieInSupabase(naam) {
  if (!heeftClient()) return null;
  try {
    const sb = await getClient();
    const { data: sessieData } = await sb.auth.getSession();
    const userId = sessieData?.session?.user?.id;
    if (!userId) return null;
    const { data, error } = await sb.from('relaties')
      .insert([{ user_id: userId, naam }])
      .select('id, naam, aliassen, adres, postcode_plaats, kvk_nummer, btw_nummer')
      .single();
    if (error) {
      console.warn('⚠️  Relatie aanmaken mislukt:', error.message);
      return null;
    }
    return relatieUitRij(data);
  } catch (err) {
    console.warn('Error in maakRelatieInSupabase:', err);
    return null;
  }
}

export async function werkRelatieBijInSupabase(id, wijzigingen) {
  if (!heeftClient()) return false;
  try {
    const sb = await getClient();
    const { error } = await sb.from('relaties').update(wijzigingen).eq('id', id);
    if (error) {
      console.warn('⚠️  Relatie bijwerken mislukt:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error in werkRelatieBijInSupabase:', err);
    return false;
  }
}

/** Zacht verwijderen (deleted_at), net als de andere tabellen — nooit een
 *  echte DELETE, zodat een boeking/factuur die nog naar dit id verwijst niet
 *  ineens op een spookrecord uitkomt. */
export async function verwijderRelatieInSupabase(id) {
  if (!heeftClient()) return false;
  try {
    const sb = await getClient();
    const { error } = await sb.from('relaties').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      console.warn('⚠️  Relatie verwijderen mislukt:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error in verwijderRelatieInSupabase:', err);
    return false;
  }
}

// ─── BANKKOPPELINGEN (fase 4b-1) ────────────────────────────────────────────
// session_id/account_uid/geldig_tot staan bewust niet in de select hieronder
// — de frontend heeft ze nooit nodig, dus vraagt ze ook niet op. De echte
// bescherming zit in de database zelf: de rol authenticated heeft op die drie
// kolommen geen insert/update-recht meer (kolomrechten, fase 4b-1-migratie),
// dus deze module zou er sowieso nooit naar kunnen schrijven, ook niet per
// programmeerfout.

function bankKoppelingUitRij(r) {
  return {
    id: r.id, aspspNaam: r.aspsp_naam, iban: r.iban, rek: r.rek,
    geldigTot: r.geldig_tot, status: r.status
  };
}

export async function loadBankKoppelingenFromSupabase() {
  if (!heeftClient()) return [];
  try {
    const sb = await getClient();
    const { data, error } = await sb
      .from('bank_koppelingen')
      .select('id, aspsp_naam, iban, rek, geldig_tot, status')
      .order('aspsp_naam');
    if (error) {
      console.warn('⚠️  Bankkoppelingen laden mislukt:', error.message);
      return [];
    }
    return (data || []).map(bankKoppelingUitRij);
  } catch (err) {
    console.warn('Error in loadBankKoppelingenFromSupabase:', err);
    return [];
  }
}

/** Het enige veld dat de frontend van een bankkoppeling mag bewerken — de
 *  database weigert dit ook voor elk ander veld (zie hierboven). */
export async function werkBankKoppelingRekBijInSupabase(id, rek) {
  if (!heeftClient()) return false;
  try {
    const sb = await getClient();
    const { error } = await sb.from('bank_koppelingen').update({ rek }).eq('id', id);
    if (error) {
      console.warn('⚠️  Bankkoppeling-rekening bijwerken mislukt:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error in werkBankKoppelingRekBijInSupabase:', err);
    return false;
  }
}

export async function loadBoekingenFromSupabase() {
  if (!heeftClient()) {
    console.log('⚠️  Supabase client not initialized');
    return null;
  }
  
  try {
    const sb = await getClient();
    
    // Supabase geeft per aanvraag maximaal 1000 rijen. Zonder te pagineren
    // zouden boekingen boven die grens stilletjes ontbreken (de nieuwste, want
    // we sorteren op datum). Daarom halen we ze in blokken op.
    const BLOK = 1000;
    const data = [];
    let error = null;
    for (let van = 0; ; van += BLOK) {
      const res = await sb
        .from('boekingen')
        .select('*')
        .is('deleted_at', null)
        .order('datum', { ascending: true })
        .order('legacy_id', { ascending: true })
        .range(van, van + BLOK - 1);
      if (res.error) { error = res.error; break; }
      data.push(...(res.data || []));
      if (!res.data || res.data.length < BLOK) break;
    }
    
    if (error) {
      console.warn('❌ Supabase load failed:', error.message);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log('ℹ️  No boekingen found in Supabase (empty or first time)');
      return { TX: [], HIST_TX: [] };
    }
    
    const TX = [];
    const HIST_TX = [];
    
    for (const b of data) {
      const record = {
        id: b.archief_jaar === null ? parseInt(b.legacy_id) : b.legacy_id,
        datum: b.datum,
        bedrag: b.bedrag,
        naam: b.naam,
        omschr: b.omschr,
        type: b.type,
        rek: b.rek,
        gb: b.gb
      };
      // Alleen de waarde die er lokaal toe doet meenemen; alle andere
      // waarden ('excel', 'migratie', 'sync') betekenen lokaal simpelweg
      // "niet handmatig", dus daar zetten we lokaal niets voor.
      if (b.bron === 'handmatig') record.bron = 'handmatig';
      // Zelfde redenering: alleen zetten als er echt BTW bij hoort. Anders
      // zou elke boeking (ook alle boekingen van vóór deze fase) lokaal
      // ineens btw_percentage: 0 krijgen — een veld dat er eerder nooit was.
      if (b.btw_percentage) {
        record.btw_percentage = b.btw_percentage;
        record.btw_bedrag = Number(b.btw_bedrag) || 0;
      }
      // Fase 4b-1: gekoppelde relatie meenemen als die er is. Zelfde
      // redenering als bron/btw hierboven — alleen zetten als aanwezig, want
      // de meeste boekingen hebben (nog) geen relatie_id.
      if (b.relatie_id) record.relatieId = b.relatie_id;

      if (b.archief_jaar === null) {
        TX.push(record);
      } else {
        HIST_TX.push(record);
      }
    }
    
    console.log(`✅ Loaded from Supabase: ${TX.length} TX + ${HIST_TX.length} HIST_TX`);
    return { TX, HIST_TX };
    
  } catch (err) {
    console.error('❌ Supabase load error:', err);
    return null;
  }
}

// ===== SAVE TO SUPABASE =====

export async function saveToSupabase(boeking, isHistoric) {
  if (!heeftClient()) {
    console.log('⚠️  Supabase not ready, skipping save');
    return false;
  }
  
  try {
    const sb = await getClient();
    
    // Haal user ID uit Supabase sessie
    const session = await sb.auth.getSession();
    const userId = session?.data?.session?.user?.id;
    
    if (!userId) {
      console.warn('⚠️  No user ID available (not logged in?)');
      return false;
    }
    
    const record = {
      user_id: userId,
      legacy_id: String(boeking.id),
      legacy_source: isHistoric ? 'hist_tx' : 'tx',
      datum: boeking.datum,
      bedrag: parseFloat(boeking.bedrag),
      naam: boeking.naam || null,
      omschr: boeking.omschr || null,
      type: boeking.type,
      rek: boeking.rek,
      gb: boeking.gb,
      archief_jaar: isHistoric ? parseInt(boeking.datum.substring(0, 4)) : null,
      btw_bedrag: boeking.btw_bedrag || 0,
      btw_percentage: boeking.btw_percentage || 0,
      bron: boeking.bron === 'handmatig' ? 'handmatig' : 'excel',
      // Fase 4b-1: relatie_id meesturen als de boeking er een heeft, anders
      // expliciet null. Zonder dit zou elke gewone bewerking van deze boeking
      // (via partijen.js) een eerder gekoppelde relatie stilletjes wissen —
      // deze functie doet delete+insert, dus wat hier niet in staat, gaat weg.
      relatie_id: boeking.relatieId || null,
      updated_at: new Date().toISOString()
    };

    // Delete old version (MET user_id, dus RLS laat het toe)
    await sb
      .from('boekingen')
      .delete()
      .eq('legacy_id', String(boeking.id))
      .eq('user_id', userId);
    
    // Insert fresh
    const { error } = await sb.from('boekingen').insert([record]);
    
    if (error) {
      console.error(`❌ Supabase save failed (${boeking.id}):`, error);
      laatsteFoutPerId[boeking.id] = error.message;
      return false;
    }

    console.log(`✅ Synced to Supabase: ${boeking.id}`);
    delete laatsteFoutPerId[boeking.id];
    return true;
  } catch (err) {
    console.error('Error in saveToSupabase:', err);
    laatsteFoutPerId[boeking.id] = err.message;
    return false;
  }
}

// ===== OVERIGE APPGEGEVENS (groepen, facturen, tellers) =====

// Onthoudt, per app_data-sleutel, de laatste foutmelding van een mislukte
// save-poging — zelfde soort registratie als laatsteFoutPerId hierboven,
// maar dan voor instellingen/lijstjes (grootboek, facturen, KM_INSTELLINGEN,
// enz.) in plaats van boekingen. Puur informatief voor de
// synchronisatiestatus in Beheer; verandert niets aan wat saveAppData() zelf
// teruggeeft.
export const laatsteAppDataFout = {};

/**
 * Groepen, facturen en tellers zijn kleine lijstjes zonder eigen tabel. Ze
 * gaan als één JSON-waarde per sleutel naar de tabel app_data. Zo hoeft er
 * geen apart schema per soort te bestaan en kunnen er later gegevens bij
 * zonder opnieuw een tabel aan te maken.
 */
export async function saveAppData(sleutel, waarde) {
  if (!heeftClient()) return false;
  try {
    const sb = await getClient();
    const session = await sb.auth.getSession();
    const userId = session?.data?.session?.user?.id;
    if (!userId) return false;

    const { error } = await sb.from('app_data').upsert({
      user_id: userId,
      sleutel,
      waarde,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,sleutel' });

    if (error) {
      if (isOnbekendeTabelFout(error)) {
        if (!appDataGemeld) {
          console.warn('⚠️  Tabel app_data bestaat nog niet. Groepen en facturen blijven lokaal.');
          appDataGemeld = true;
        }
        laatsteAppDataFout[sleutel] = 'Tabel app_data bestaat nog niet.';
        return false;
      }
      console.error(`❌ app_data (${sleutel}):`, error.message);
      laatsteAppDataFout[sleutel] = error.message;
      return false;
    }
    delete laatsteAppDataFout[sleutel];
    return true;
  } catch (err) {
    console.warn(`app_data (${sleutel}) mislukt:`, err.message);
    laatsteAppDataFout[sleutel] = err.message;
    return false;
  }
}

let appDataGemeld = false;

function isOnbekendeTabelFout(error) {
  const t = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return error?.code === '42P01' || t.includes('does not exist') || t.includes('schema cache');
}

/** Haalt alle losse appgegevens op als { sleutel: waarde }. */
export async function loadAppData() {
  if (!heeftClient()) return null;
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('app_data').select('sleutel, waarde');
    if (error) {
      if (isOnbekendeTabelFout(error)) {
        if (!appDataGemeld) {
          console.warn('⚠️  Tabel app_data bestaat nog niet.');
          appDataGemeld = true;
        }
        return null;
      }
      console.error('❌ app_data laden:', error.message);
      return null;
    }
    const uit = {};
    for (const rij of data || []) uit[rij.sleutel] = rij.waarde;
    return uit;
  } catch (err) {
    console.warn('app_data laden mislukt:', err.message);
    return null;
  }
}

// ===== ALLES IN EEN KEER NAAR SUPABASE =====

/** Bouwt het databaserecord voor een boeking. */
function boekingRecord(boeking, isHistoric, userId) {
  return {
    user_id: userId,
    legacy_id: String(boeking.id),
    legacy_source: isHistoric ? 'hist_tx' : 'tx',
    datum: boeking.datum,
    bedrag: parseFloat(boeking.bedrag),
    naam: boeking.naam || null,
    omschr: boeking.omschr || null,
    type: boeking.type,
    rek: boeking.rek,
    gb: boeking.gb,
    archief_jaar: isHistoric ? parseInt(String(boeking.datum).substring(0, 4)) : null,
    btw_bedrag: boeking.btw_bedrag || 0,
    btw_percentage: boeking.btw_percentage || 0,
    bron: boeking.bron === 'handmatig' ? 'handmatig' : 'excel',
    // Fase 4b-1: zie de identieke toevoeging in saveToSupabase() hierboven —
    // een volledige hersync mag een eerder gekoppelde relatie niet wissen.
    relatie_id: boeking.relatieId || null,
    updated_at: new Date().toISOString()
  };
}

/**
 * Verwijdert de opgegeven jaren uit Supabase, als voorbereiding op het lokaal
 * wissen van diezelfde jaren. Wordt aangeroepen door `doWis()` in modals.js,
 * v\u00f3\u00f3rdat er ook maar iets lokaal wordt aangeraakt.
 *
 * Volgorde is bewust vast: eerst boekingen, dan pas voorraadartikelen. Stopt
 * de eerste stap met een fout, dan is er nergens iets veranderd \u2014 noch lokaal,
 * noch in de cloud. Stopt de tweede stap met een fout, dan zijn de boekingen
 * al weg maar de voorraadartikelen nog niet; dat wordt teruggegeven zodat de
 * aanroeper dat expliciet kan melden in plaats van door te gaan alsof alles
 * gelukt is. In beide gevallen blijft de lokale staat op dit punt nog
 * volledig ongewijzigd \u2014 dat wissen gebeurt pas na een `ok: true` hiervandaan.
 *
 * Scope, per stap:
 *   boekingen          altijd .eq('user_id', userId)
 *                      + .is('archief_jaar', null)      als '2026' in jaren zit
 *                      + .in('archief_jaar', overigen)  voor de andere jaren
 *   voorraadartikelen  alleen als '2026' in jaren zit \u2014 deze tabel heeft geen
 *                      jaarveld, dus "2026 wissen" wist hier het hele artikel
 *                      inclusief zijn geschiedenis over alle jaren, niet alleen
 *                      dit boekjaar. Dat moet de aanroeper aan de gebruiker
 *                      melden v\u00f3\u00f3r de bevestiging, niet hierna.
 *   hnvi_loten         nooit. Deze functie kent geen enkel pad daarheen.
 *
 * @param {string[]} jaren  bijv. ['2026', '2025']
 * @returns {{
 *   ok: boolean,
 *   fout: string|null,
 *   stap: 'boekingen'|'voorraad'|null,
 *   boekingenVerwijderd: number,
 *   voorraadVerwijderd: number|null
 * }}
 */
/**
 * Niet-destructieve preview van wat `wisJarenInSupabase()` zou verwijderen.
 * Gebruikt exact dezelfde selectiecriteria \u2014 dezelfde tabellen, dezelfde
 * user_id-scope, dezelfde archief_jaar-filters \u2014 maar telt in plaats van
 * te verwijderen: elke aanroep is `.select(..., { count: 'exact', head: true })`,
 * nooit `.delete()`. Er wordt hier niets aangeraakt, ook niet gelezen als
 * volledige rij \u2014 `head: true` haalt geen data op, alleen het aantal.
 *
 * Bedoeld als controlestap v\u00f3\u00f3r een echte wis-actie: klopt de sessie, de
 * tabellen, de kolomnamen en de aantallen, dan is de kans klein dat de
 * daadwerkelijke DELETE nog een verrassing oplevert die hier niet al zichtbaar
 * was. Dat is een aanwijzing, geen garantie \u2014 RLS-policies kunnen SELECT en
 * DELETE verschillend toestaan.
 *
 * Historische jaren worden \u00e9\u00e9n voor \u00e9\u00e9n geteld (niet met \u00e9\u00e9n gecombineerde
 * .in()), zodat een onverwacht laag of hoog aantal in \u00e9\u00e9n specifiek jaar
 * opvalt in plaats van te verdwijnen in een totaal.
 *
 * @param {string[]} jaren
 * @returns {{
 *   ok: boolean,
 *   fout: string|null,
 *   jaren: string[],
 *   huidig: { boekingen: number }|null,
 *   historisch: Record<string, number>,
 *   voorraad: number|null,
 *   hnviMeegenomen: false
 * }}
 */
/**
 * GEDEELDE, NIET-DESTRUCTIEVE SELECTIE-OPBOUW voor het wissen van jaren.
 *
 * Dit blok bepaalt \u00e9\u00e9nmalig wat "2026" en "een historisch jaar" betekenen
 * voor boekingen en voorraadartikelen, en past die criteria toe op een
 * Supabase-querybuilder. `previewWisJaren()` (alleen tellen) en
 * `wisJarenInSupabase()` (echt verwijderen) roepen deze twee functies allebei
 * aan \u2014 ze bouwen zelf geen WHERE-voorwaarde meer op. Daardoor kunnen de twee
 * niet meer uit elkaar lopen: wijzig je hier een filter, dan verandert hij
 * voor preview \u00e9n DELETE tegelijk, in plaats van dat iemand de ene plek
 * aanpast en de andere vergeet.
 *
 * Deze functies roepen zelf nooit `.delete()` of `.select()` aan \u2014 dat blijft
 * de verantwoordelijkheid van de aanroeper, die daarmee bepaalt of het om een
 * telling of een verwijdering gaat. `filterBoekingen()`/`filterVoorraad()`
 * passen uitsluitend `.eq()`/`.is()`/`.in()` toe.
 */

/**
 * Wat "2026" en "de historische jaren" betekenen voor een gegeven selectie.
 * De enige plek die deze vertaalslag maakt.
 */
function bepaalWisSelectie(jaren) {
  const lijst = Array.isArray(jaren) ? jaren : [];
  return {
    wisHuidig: lijst.includes('2026'),
    historischeJaren: lijst
      .filter(j => j !== '2026')
      .map(j => parseInt(j, 10))
      .filter(Number.isFinite)
  };
}

/**
 * Past user_id- en archief_jaar-filters toe op een querybuilder voor de
 * tabel 'boekingen'. `criterium` is precies \u00e9\u00e9n van:
 *   { archiefJaar: null }        \u2014 2026 (huidig): archief_jaar IS NULL
 *   { archiefJaar: 2025 }        \u2014 \u00e9\u00e9n historisch jaar exact
 *   { archiefJaarIn: [2025, 2024] } \u2014 meerdere historische jaren in \u00e9\u00e9n keer
 * Geen enkel ander pad naar archief_jaar bestaat in deze functie \u2014 dat is
 * bewust, zodat "wat telt als 2026" en "wat telt als historisch" niet per
 * aanroeper opnieuw kunnen worden verzonnen.
 */
function filterBoekingen(builder, userId, criterium) {
  let q = builder.eq('user_id', userId);
  if (Object.prototype.hasOwnProperty.call(criterium, 'archiefJaar')) {
    q = criterium.archiefJaar === null
      ? q.is('archief_jaar', null)
      : q.eq('archief_jaar', criterium.archiefJaar);
  } else if (Object.prototype.hasOwnProperty.call(criterium, 'archiefJaarIn')) {
    q = q.in('archief_jaar', criterium.archiefJaarIn);
  }
  return q;
}

/**
 * Past het user_id-filter toe voor 'voorraadartikelen'. Deze tabel heeft geen
 * jaarveld \u2014 vandaar dat hier, in tegenstelling tot `filterBoekingen()`, geen
 * archief_jaar-criterium bestaat. Wordt door de aanroeper alleen ingezet als
 * 2026 is geselecteerd; deze functie bepaalt dat zelf niet, om \u00e9\u00e9n plek te
 * houden (`bepaalWisSelectie`) die vaststelt wanneer 2026 is gekozen.
 */
function filterVoorraad(builder, userId) {
  return builder.eq('user_id', userId);
}

export async function previewWisJaren(jaren) {
  const leeg = {
    ok: false, fout: null, jaren: Array.isArray(jaren) ? jaren : [],
    huidig: null, historisch: {}, voorraad: null, hnviMeegenomen: false
  };

  if (!Array.isArray(jaren) || jaren.length === 0) {
    return { ...leeg, fout: 'Geen jaar opgegeven.' };
  }
  if (!heeftClient()) {
    return { ...leeg, fout: 'Geen verbinding met Supabase.' };
  }

  const sb = await getClient();
  const session = await sb.auth.getSession();
  const userId = session?.data?.session?.user?.id;
  if (!userId) {
    return { ...leeg, fout: 'Niet ingelogd bij Supabase.' };
  }

  // Zelfde vertaalslag als de DELETE gebruikt, uit dezelfde functie.
  const { wisHuidig, historischeJaren } = bepaalWisSelectie(jaren);

  let huidig = null;
  let historisch = {};
  let voorraad = null;

  try {
    if (wisHuidig) {
      const basis = sb.from('boekingen').select('id', { count: 'exact', head: true });
      const { count, error } = await filterBoekingen(basis, userId, { archiefJaar: null });
      if (error) return { ...leeg, fout: `boekingen (2026): ${error.message}` };
      huidig = { boekingen: count ?? 0 };
    }

    // Per jaar apart geteld voor de uitsplitsing, elk via dezelfde
    // filterBoekingen() die de DELETE ook gebruikt (daar in \u00e9\u00e9n gecombineerde
    // .in()-aanroep in plaats van een lus, maar met identieke criteria \u2014 de
    // som van deze losse tellingen is exact wat die ene gecombineerde query
    // raakt).
    for (const jaartal of historischeJaren) {
      const basis = sb.from('boekingen').select('id', { count: 'exact', head: true });
      const { count, error } = await filterBoekingen(basis, userId, { archiefJaar: jaartal });
      if (error) return { ...leeg, fout: `boekingen (${jaartal}): ${error.message}`, huidig, historisch };
      historisch[String(jaartal)] = count ?? 0;
    }

    if (wisHuidig) {
      const basis = sb.from('voorraadartikelen').select('id', { count: 'exact', head: true });
      const { count, error } = await filterVoorraad(basis, userId);
      if (error) return { ...leeg, fout: `voorraadartikelen: ${error.message}`, huidig, historisch };
      voorraad = count ?? 0;
    }
  } catch (err) {
    return { ...leeg, fout: err.message, huidig, historisch, voorraad };
  }

  // hnvi_loten komt in deze functie nergens voor \u2014 geen query, geen telling.
  // hnviMeegenomen staat daarom altijd op false; dat is de bevestiging zelf,
  // niet een uitkomst die nog zou kunnen omslaan.
  return { ok: true, fout: null, jaren, huidig, historisch, voorraad, hnviMeegenomen: false };
}

export async function wisJarenInSupabase(jaren) {
  const leeg = { ok: false, fout: null, stap: null, boekingenVerwijderd: 0, voorraadVerwijderd: null };

  if (!Array.isArray(jaren) || jaren.length === 0) {
    return { ...leeg, fout: 'Geen jaar opgegeven.' };
  }
  if (!heeftClient()) {
    return { ...leeg, fout: 'Geen verbinding met Supabase. Er is niets gewist.' };
  }

  const sb = await getClient();
  const session = await sb.auth.getSession();
  const userId = session?.data?.session?.user?.id;
  if (!userId) {
    return { ...leeg, fout: 'Niet ingelogd bij Supabase. Er is niets gewist.' };
  }

  // Zelfde vertaalslag als de preview gebruikt, uit dezelfde functie.
  const { wisHuidig, historischeJaren } = bepaalWisSelectie(jaren);

  // \u2500\u2500 Stap 1: boekingen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let boekingenVerwijderd = 0;
  try {
    if (wisHuidig) {
      const basis = sb.from('boekingen').delete();
      const { data, error } = await filterBoekingen(basis, userId, { archiefJaar: null }).select('id');
      if (error) return { ...leeg, fout: error.message, stap: 'boekingen' };
      boekingenVerwijderd += data ? data.length : 0;
    }
    if (historischeJaren.length) {
      const basis = sb.from('boekingen').delete();
      const { data, error } = await filterBoekingen(basis, userId, { archiefJaarIn: historischeJaren }).select('id');
      if (error) return { ...leeg, fout: error.message, stap: 'boekingen', boekingenVerwijderd };
      boekingenVerwijderd += data ? data.length : 0;
    }
  } catch (err) {
    return { ...leeg, fout: err.message, stap: 'boekingen', boekingenVerwijderd };
  }

  // \u2500\u2500 Stap 2: voorraadartikelen, alleen als 2026 is gewist \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let voorraadVerwijderd = null;
  if (wisHuidig) {
    try {
      const basis = sb.from('voorraadartikelen').delete();
      const { data, error } = await filterVoorraad(basis, userId).select('id');
      if (error) {
        // Boekingen zijn op dit punt al \u00e9cht weg in Supabase. Dat melden we
        // expliciet mee, zodat de aanroeper dit niet als "niets gebeurd" kan
        // interpreteren en de gebruiker een duidelijke vervolgstap krijgt.
        return { ...leeg, fout: error.message, stap: 'voorraad', boekingenVerwijderd, voorraadVerwijderd: 0 };
      }
      voorraadVerwijderd = data ? data.length : 0;
    } catch (err) {
      return { ...leeg, fout: err.message, stap: 'voorraad', boekingenVerwijderd, voorraadVerwijderd: 0 };
    }
  }

  return { ok: true, fout: null, stap: null, boekingenVerwijderd, voorraadVerwijderd };
}

/** Bouwt het databaserecord voor een HNVI-lot. */
function hnviRecord(lot, userId) {
  return {
    user_id: userId,
    legacy_id: String(lot.id),
    datum: lot.datum || null,
    omschrijving: lot.omschr || '',
    inkoop: parseFloat(lot.inkoop) || 0,
    verkoop: lot.verkoop != null ? parseFloat(lot.verkoop) : null,
    status: lot.status || 'voorraad',
    notitie: lot.noot || '',
    updated_at: new Date().toISOString()
  };
}

/** Bouwt het databaserecord voor een voorraadartikel. */
function coverRecord(cover, userId) {
  let ingekocht = 0, verkocht = 0;
  for (const j of Object.values(cover.jaren || {})) {
    ingekocht += (j.inkoop || 0);
    verkocht += (j.verkocht || 0);
  }
  const record = {
    user_id: userId,
    legacy_id: String(cover.id),
    artikel: cover.artikel,
    productgroep_id: null,
    voorraad: cover.voorraad || 0,
    inkoopprijs: cover.inkoopprijs ? parseFloat(cover.inkoopprijs) : null,
    verkoopprijs: cover.prijs ? parseFloat(cover.prijs) : null,
    min_voorraad: cover.minVoorraad || null,
    ingekocht,
    verkocht,
    zoekterm: cover.zoekterm || '',
    updated_at: new Date().toISOString(),
    inkooprekening: String(cover.inkoopGb || '7000'),
    categorie: String(cover.categorie || 'overig'),
    handelsvoorraad: cover.handelsvoorraad !== false,
    jaren: cover.jaren && Object.keys(cover.jaren).length ? cover.jaren : null,
    prijsfactor: Number(cover.prijsFactor) > 0 ? Number(cover.prijsFactor) : 1
  };
  if (coverKolommenOntbreken) OPTIONELE_COVER_KOLOMMEN.forEach(k => delete record[k]);
  return record;
}

/**
 * Stuurt een lijst records in blokken naar een tabel. Per blok wordt eerst de
 * oude versie weggehaald en daarna de nieuwe weggeschreven, zodat een tweede
 * keer versturen geen dubbele regels oplevert.
 */
async function stuurInBlokken(sb, tabel, records, userId, onVoortgang, label) {
  const BLOK = 100;
  let ok = 0, mislukt = 0;

  for (let i = 0; i < records.length; i += BLOK) {
    const blok = records.slice(i, i + BLOK);
    const ids = blok.map(r => r.legacy_id);
    try {
      await sb.from(tabel).delete().eq('user_id', userId).in('legacy_id', ids);
      let { error } = await sb.from(tabel).insert(blok);

      // Ontbreken de nieuwe kolommen nog, dan één keer opnieuw zonder.
      if (error && tabel === 'voorraadartikelen' && !coverKolommenOntbreken && isOnbekendeKolomFout(error)) {
        console.warn('⚠️  Nieuwe kolommen ontbreken; verstuur zonder groep, rekening, jaren en prijsfactor.');
        coverKolommenOntbreken = true;
        blok.forEach(r => OPTIONELE_COVER_KOLOMMEN.forEach(k => delete r[k]));
        ({ error } = await sb.from(tabel).insert(blok));
      }

      if (error) { mislukt += blok.length; console.error(`❌ ${label} blok ${i}:`, error.message); }
      else ok += blok.length;
    } catch (err) {
      mislukt += blok.length;
      console.error(`❌ ${label} blok ${i}:`, err.message);
    }
    onVoortgang?.(label, Math.min(i + BLOK, records.length), records.length);
  }
  return { ok, mislukt };
}

/**
 * Zet alles wat in deze browser staat in één keer in Supabase: boekingen,
 * voorraadartikelen en HNVI-loten. Bedoeld om een nieuw apparaat in te richten
 * of om na een import alles gelijk te trekken.
 */
/**
 * Vervangt de volledige voorraad van de ingelogde gebruiker atomisch, via de
 * database-functie `vervang_voorraad`. Dit vervangt voor voorraad specifiek
 * het oude `stuurInBlokken()`-pad: die deed per blok van 100 een aparte
 * delete-op-legacy_id plus insert, en ging bij een mislukt blok gewoon door
 * met de volgende — waardoor de cloudvoorraad na een fout een onvoorspelbare
 * mix van oud, nieuw en ontbrekend kon worden. `vervang_voorraad` draait als
 * één databasetransactie: bij een fout, waar dan ook, blijft de oude voorraad
 * volledig intact, bevestigd met echte tests tegen de aangemaakte functie.
 *
 * De teruggegeven vorm is bewust gelijk aan wat `stuurInBlokken()` altijd al
 * opleverde — `{ ok, mislukt }`, hier aangevuld met `verwijderd` en `fout` —
 * zodat `startVoorraadSync()` ongewijzigd kan blijven: die leest alleen
 * `r.ok` en `r.mislukt`.
 *
 * user_id wordt hier NIET meegegeven aan de database-functie; die bepaalt
 * dat zelf via auth.uid(). `coverRecord(c, null)` levert verder exact dezelfde
 * velden als voorheen; het overbodige user_id-veld in die payload wordt door
 * de kolomlijst van `vervang_voorraad` domweg genegeerd.
 */
export async function vervangVoorraadInSupabase(covers) {
  const leeg = { ok: 0, mislukt: 0, verwijderd: 0, fout: null };

  if (!heeftClient()) return { ...leeg, mislukt: covers.length, fout: 'Geen verbinding met Supabase.' };

  const sb = await getClient();
  const session = await sb.auth.getSession();
  if (!session?.data?.session?.user?.id) {
    return { ...leeg, mislukt: covers.length, fout: 'Niet ingelogd bij Supabase.' };
  }

  try {
    const payload = covers.map(c => coverRecord(c, null));
    const { data, error } = await sb.rpc('vervang_voorraad', { p_artikelen: payload });

    if (error) {
      console.error('❌ vervang_voorraad mislukt:', error.message);
      return { ...leeg, mislukt: covers.length, fout: leesbareFout(error) };
    }

    const rij = Array.isArray(data) ? data[0] : data;
    console.log(`☁️  Voorraad vervangen: ${rij.verwijderd} oude rijen weg, ${rij.ingevoegd} nieuwe geplaatst.`);
    return { ok: rij.ingevoegd, mislukt: 0, verwijderd: rij.verwijderd, fout: null };
  } catch (err) {
    console.error('❌ vervang_voorraad mislukt:', err.message);
    return { ...leeg, mislukt: covers.length, fout: leesbareFout(err) };
  }
}

export async function syncAllesNaarSupabase(data, keuze, onVoortgang) {
  if (!heeftClient()) return { fout: 'Geen verbinding met Supabase.' };

  const sb = await getClient();
  const session = await sb.auth.getSession();
  const userId = session?.data?.session?.user?.id;
  if (!userId) return { fout: 'Niet ingelogd bij Supabase.' };

  const uitkomst = {};

  if (keuze.boekingen) {
    const records = [
      ...(data.HIST_TX || []).map(b => boekingRecord(b, true, userId)),
      ...(data.TX || []).map(b => boekingRecord(b, false, userId))
    ].filter(r => r.datum && Number.isFinite(r.bedrag));
    uitkomst.boekingen = await stuurInBlokken(sb, 'boekingen', records, userId, onVoortgang, 'Boekingen');
  }

  if (keuze.voorraad) {
    // Was: stuurInBlokken(sb, 'voorraadartikelen', ...) — per blok van 100,
    // ging door na een mislukt blok. Nu: één atomische databasetransactie
    // via vervang_voorraad(), die bij een fout de oude voorraad ongewijzigd
    // laat in plaats van een gedeeltelijk vervangen set achter te laten.
    uitkomst.voorraad = await vervangVoorraadInSupabase(data.COVERS || []);
  }

  if (keuze.hnvi) {
    const records = (data.HNVI_LOTS || []).map(l => hnviRecord(l, userId));
    uitkomst.hnvi = await stuurInBlokken(sb, 'hnvi_loten', records, userId, onVoortgang, 'HNVI-loten');
  }

  return uitkomst;
}

/**
 * Vervangt in Supabase de boekingen van één of meer jaren door een nieuwe set.
 *
 * Nodig omdat een Excel-import de boekingen van dat jaar volledig herschrijft.
 * `stuurInBlokken` verwijdert alleen regels met dezelfde legacy_id en laat
 * regels die in de nieuwe set niet meer voorkomen dus staan; na een refresh
 * kwamen die weer terug. Hier wordt eerst het hele jaar weggehaald en daarna
 * de nieuwe set ingevoegd, zodat wat je in de app ziet ook is wat er staat.
 *
 * Huidig jaar (isHistoric=false) staat in de database met archief_jaar NULL;
 * afgesloten jaren hebben daar het jaartal staan. Dat onderscheid bepaalt hoe
 * de oude regels worden gezocht.
 *
 * @param {Array}  boekingen  de nieuwe set voor die jaren
 * @param {Object} opties     { isHistoric, jaren: ['2026'] }
 * @returns {Object} { ok, mislukt, verwijderd, fout? }
 */
export async function vervangBoekingenInSupabase(boekingen, { isHistoric = false, jaren = [] } = {}) {
  const leeg = { ok: 0, mislukt: 0, verwijderd: 0, fout: null };

  if (!heeftClient()) return { ...leeg, fout: 'Geen verbinding met Supabase.' };

  const sb = await getClient();
  const session = await sb.auth.getSession();
  const userId = session?.data?.session?.user?.id;
  if (!userId) return { ...leeg, fout: 'Niet ingelogd bij Supabase.' };

  // 1. Oude regels van deze jaren weghalen.
  //    Bewust een harde delete, net als `stuurInBlokken` bij de bulk-sync.
  //    De soft delete (`deleted_at` zetten) is er voor het wissen van één
  //    boeking door de gebruiker. Hier wordt een heel jaar vervangen door een
  //    nieuwe set die dezelfde legacy_id-reeks hergebruikt; blijven de oude
  //    rijen dan staan, dan botst het invoegen op de uniciteit van
  //    (user_id, legacy_id) en komt er niets binnen.
  let verwijderd = 0;
  try {
    let q = sb.from('boekingen').delete().eq('user_id', userId);
    if (isHistoric) {
      const jaartallen = jaren.map(j => parseInt(j, 10)).filter(Number.isFinite);
      if (!jaartallen.length) return { ...leeg, fout: 'Geen geldig jaartal opgegeven.' };
      q = q.in('archief_jaar', jaartallen);
    } else {
      q = q.is('archief_jaar', null);
    }
    const { data, error } = await q.select('id');
    if (error) return { ...leeg, fout: error.message };
    verwijderd = data ? data.length : 0;
  } catch (err) {
    return { ...leeg, fout: err.message };
  }

  // 2. Nieuwe set invoegen, in blokken. Stopt bij het eerste mislukte blok in
  //    plaats van door te gaan: eerder werd een mislukking alleen opgeteld in
  //    `mislukt`, zonder dat de aanroeper daar iets van te zien kreeg (het
  //    resultaat had dan geen `fout`-veld, en werd dus als geslaagd
  //    behandeld). Zeker weten welke boekingen er nog ontbreken vraagt om
  //    precies te stoppen waar het misging, in plaats van blindelings verder
  //    te schrijven met een deels lege of deels dubbele uitkomst.
  //
  //    Op dit punt is de DELETE al onomkeerbaar uitgevoerd: `verwijderd` blijft
  //    daarom altijd in het resultaat staan, ook bij een mislukte insert, zodat
  //    de aanroeper weet dat de oude data al weg is en er niet zomaar van kan
  //    uitgaan dat de vorige set nog intact is.
  const records = boekingen
    .map(b => boekingRecord(b, isHistoric, userId))
    .filter(r => r.datum && Number.isFinite(r.bedrag));

  const BLOK = 100;
  let ok = 0;
  for (let i = 0; i < records.length; i += BLOK) {
    const blok = records.slice(i, i + BLOK);
    try {
      const { error } = await sb.from('boekingen').insert(blok);
      if (error) {
        console.error(`\u274c Import blok ${i}:`, error.message);
        return {
          ok, mislukt: blok.length, verwijderd,
          fout: `Blok ${Math.floor(i / BLOK) + 1}: ${error.message} ` +
                `(${ok} van ${records.length} boekingen wel geplaatst, de rest niet meer geprobeerd)`
        };
      }
      ok += blok.length;
    } catch (err) {
      console.error(`\u274c Import blok ${i}:`, err.message);
      return {
        ok, mislukt: blok.length, verwijderd,
        fout: `Blok ${Math.floor(i / BLOK) + 1}: ${err.message} ` +
              `(${ok} van ${records.length} boekingen wel geplaatst, de rest niet meer geprobeerd)`
      };
    }
  }

  console.log(`\u2601\ufe0f  Supabase bijgewerkt: ${verwijderd} oude regels weg, ${ok} nieuwe geplaatst.`);
  return { ok, mislukt: 0, verwijderd, fout: null };
}

/**
 * Sla HNVI lot op naar Supabase
 * hnvi_loten tabel: id=UUID, legacy_id=app-id, datum/omschrijving/inkoop/verkoop/status/notitie
 */
const OPTIONELE_HNVI_KOLOMMEN = ['factuur', 'verkoopdatum'];
let hnviKolommenOntbreken = false;

export async function saveHnviToSupabase(lot) {
  if (!heeftClient()) {
    console.log('⚠️  Supabase not ready, skipping HNVI save');
    return false;
  }
  
  try {
    const sb = await getClient();
    
    const session = await sb.auth.getSession();
    const userId = session?.data?.session?.user?.id;
    
    if (!userId) {
      console.warn('⚠️  No user ID available for HNVI save');
      return false;
    }
    
    const record = {
      user_id: userId,
      legacy_id: String(lot.id),  // App ID als text in legacy_id
      datum: lot.datum,
      omschrijving: lot.omschr || '',  // NOT NULL - use empty string not null
      inkoop: lot.inkoop ? parseFloat(lot.inkoop) : 0,
      verkoop: lot.verkoop ? parseFloat(lot.verkoop) : null,
      status: lot.status || 'voorraad',
      notitie: lot.noot || '',  // NOT NULL - use empty string not null
      updated_at: new Date().toISOString(),
      // Nieuw sinds de veiling-opzet: factuurnummer en verkoopdatum.
      factuur: lot.factuur || '',
      verkoopdatum: lot.verkoopDatum || null
    };

    if (hnviKolommenOntbreken) {
      OPTIONELE_HNVI_KOLOMMEN.forEach(k => delete record[k]);
    }
    
    // Upsert (delete old, insert new)
    await sb
      .from('hnvi_loten')
      .delete()
      .eq('legacy_id', String(lot.id))
      .eq('user_id', userId);
    
    let { error } = await sb.from('hnvi_loten').insert([record]);

    // Bestaan de nieuwe kolommen nog niet, dan slaan we het lot alsnog op
    // zonder die velden in plaats van de hele synchronisatie te laten klappen.
    if (error && !hnviKolommenOntbreken && isOnbekendeKolomFout(error)) {
      console.warn('⚠️  Kolommen factuur/verkoopdatum ontbreken in hnvi_loten; ALTER TABLE nog niet uitgevoerd?');
      hnviKolommenOntbreken = true;
      OPTIONELE_HNVI_KOLOMMEN.forEach(k => delete record[k]);
      ({ error } = await sb.from('hnvi_loten').insert([record]));
    }
    
    if (error) {
      console.error(`❌ HNVI save failed (${lot.id}):`, error);
      laatsteFoutPerId[lot.id] = error.message;
      return false;
    }

    console.log(`✅ HNVI synced to Supabase: ${lot.id}`);
    delete laatsteFoutPerId[lot.id];
    return true;
  } catch (err) {
    console.error('Error in saveHnviToSupabase:', err);
    laatsteFoutPerId[lot.id] = err.message;
    return false;
  }
}

/**
 * Sla Cover (artikel voorraad) op naar Supabase
 * voorraadartikelen tabel: id=UUID, legacy_id=app-id, 
 * productgroep_id=UUID (knoppelink naar groepen, niet in de app beschikbaar)
 */
// Kolommen die pas bestaan na de ALTER TABLE. Ontbreken ze, dan slaan we het
// artikel alsnog op zonder die velden in plaats van de sync te laten klappen.
const OPTIONELE_COVER_KOLOMMEN = ['inkooprekening', 'categorie', 'handelsvoorraad', 'jaren', 'prijsfactor'];
let coverKolommenOntbreken = false;

function isOnbekendeKolomFout(error) {
  const tekst = `${error?.message || ''} ${error?.hint || ''} ${error?.details || ''}`.toLowerCase();
  return error?.code === 'PGRST204' || tekst.includes('could not find') || tekst.includes('column');
}

export async function saveCoverToSupabase(cover) {
  if (!heeftClient()) {
    console.log('⚠️  Supabase not ready, skipping Cover save');
    return false;
  }
  
  try {
    const sb = await getClient();
    
    const session = await sb.auth.getSession();
    const userId = session?.data?.session?.user?.id;
    
    if (!userId) {
      console.warn('⚠️  No user ID available for Cover save');
      return false;
    }
    
    // Bereken ingekocht en verkocht van jaren-data
    let totalIngekocht = 0;
    let totalVerkocht = 0;
    if (cover.jaren) {
      Object.values(cover.jaren).forEach(jaar => {
        totalIngekocht += (jaar.inkoop || 0);
        totalVerkocht += (jaar.verkocht || 0);
      });
    }
    
    const record = {
      user_id: userId,
      legacy_id: String(cover.id),
      artikel: cover.artikel,
      productgroep_id: null,
      voorraad: cover.voorraad || 0,
      inkoopprijs: cover.inkoopprijs ? parseFloat(cover.inkoopprijs) : null,
      verkoopprijs: cover.prijs ? parseFloat(cover.prijs) : null,
      min_voorraad: cover.minVoorraad || null,
      ingekocht: totalIngekocht,
      verkocht: totalVerkocht,
      zoekterm: cover.zoekterm || '',
      updated_at: new Date().toISOString(),
      inkooprekening: String(cover.inkoopGb || '7000'),
      categorie: String(cover.categorie || 'overig'),
      handelsvoorraad: cover.handelsvoorraad !== false,
      jaren: cover.jaren && Object.keys(cover.jaren).length > 0 ? cover.jaren : null,
      prijsfactor: Number(cover.prijsFactor) > 0 ? Number(cover.prijsFactor) : 1
    };
    
    if (coverKolommenOntbreken) {
      OPTIONELE_COVER_KOLOMMEN.forEach(k => delete record[k]);
    }
    
    // Upsert
    await sb
      .from('voorraadartikelen')
      .delete()
      .eq('legacy_id', String(cover.id))
      .eq('user_id', userId);
    
    let { error } = await sb.from('voorraadartikelen').insert([record]);
    if (!error && record.jaren) { console.log(`✅ jaren opgeslagen: ${cover.artikel}`); }
    
    // Ontbreekt een van de nieuwe kolommen, dan één keer opnieuw zonder.
    if (error && !coverKolommenOntbreken && isOnbekendeKolomFout(error)) {
      console.warn('⚠️  Nieuwe kolommen ontbreken in voorraadartikelen; ALTER TABLE nog niet uitgevoerd?');
      console.warn('    Groep, inkooprekening en jaartallen worden nu niet bewaard.');
      coverKolommenOntbreken = true;
      OPTIONELE_COVER_KOLOMMEN.forEach(k => delete record[k]);
      ({ error } = await sb.from('voorraadartikelen').insert([record]));
    }
    
    if (error) {
      console.error(`❌ Cover save failed (${cover.id}):`, error);
      laatsteFoutPerId[cover.id] = error.message;
      return false;
    }

    console.log(`✅ Cover synced to Supabase: ${cover.id}`);
    delete laatsteFoutPerId[cover.id];
    return true;
  } catch (err) {
    console.error('Error in saveCoverToSupabase:', err);
    laatsteFoutPerId[cover.id] = err.message;
    return false;
  }
}

// ===== DELETE FROM SUPABASE (SOFT DELETE) =====

/**
 * Delete from appropriate table. 
 * For now: tries to delete from covers first (most common), then HNVI, then boekingen.
 * This is a workaround; in production you'd want to know which table upfront.
 */
export async function deleteFromSupabase(id, type = 'auto') {
  console.log(`🗑️  deleteFromSupabase called: id=${id}, type=${type}`);
  
  if (!heeftClient()) {
    console.warn('⚠️  heeftClient() = false, cannot delete');
    return false;
  }
  
  try {
    const sb = await getClient();
    
    // Haal user ID
    const session = await sb.auth.getSession();
    const userId = session?.data?.session?.user?.id;
    
    if (!userId) {
      console.warn('⚠️  No user ID for delete - session not found');
      return false;
    }
    
    console.log(`✓ User ID found: ${userId.substring(0, 8)}...`);
    
    // Determine which table based on type hint or try all
    let tables = [];
    if (type === 'cover' || type === 'auto') tables.push('voorraadartikelen');
    if (type === 'hnvi' || type === 'auto') tables.push('hnvi_loten');
    if (type === 'boeking' || type === 'auto') tables.push('boekingen');
    
    console.log(`🔄 Trying to delete from tables: ${tables.join(', ')}`);
    
    let lastError = null;
    for (const table of tables) {
      try {
        if (table === 'boekingen') {
          // Soft delete for boekingen
          //
          // BELANGRIJK: .select('id') erbij, en pas geslaagd verklaren als er
          // ook echt een rij is geraakt. Een DELETE/UPDATE die niets vindt
          // geeft in Postgres GEEN foutmelding — zonder deze telling zou de
          // 'auto'-val hieronder de eerste tabel (voorraadartikelen) altijd
          // als "gelukt" beschouwen, ook als er nul rijen bij hoorden, en
          // nooit meer bij `boekingen` uitkomen. Dat was precies de fout:
          // een boeking-verwijdering werd lokaal wel doorgevoerd en als
          // gelukt gemeld, maar de rij in Supabase bleef gewoon bestaan —
          // zichtbaar pas bij de volgende keer laden, wanneer hij terugkwam.
          const { data, error } = await sb
            .from(table)
            .update({ deleted_at: new Date().toISOString() })
            .eq('legacy_id', String(id))
            .eq('user_id', userId)
            .select('id');
          if (!error && data && data.length > 0) {
            console.log(`✅ Deleted from ${table}: ${id}`);
            delete laatsteFoutPerId[id];
            // Refresh UI na verwijdering van ander apparaat
            setTimeout(() => window.hertekenHuidigePagina?.(), 300);
            return true;
          }
          if (error) console.warn(`⚠️  ${table} delete error:`, error?.message || error);
          lastError = error;
        } else {
          // Hard delete for voorraadartikelen and hnvi_loten (use legacy_id)
          // Zelfde correctie: alleen geslaagd als er echt een rij weg is.
          const { data, error } = await sb
            .from(table)
            .delete()
            .eq('legacy_id', String(id))
            .eq('user_id', userId)
            .select('id');
          if (!error && data && data.length > 0) {
            console.log(`✅ Deleted from ${table}: ${id}`);
            delete laatsteFoutPerId[id];
            // Refresh UI na verwijdering van ander apparaat
            setTimeout(() => window.hertekenHuidigePagina?.(), 300);
            return true;
          }
          if (error) console.warn(`⚠️  ${table} delete error:`, error?.message || error);
          lastError = error;
        }
      } catch (err) {
        console.error(`❌ Exception deleting from ${table}:`, err);
        lastError = err;
        // Continue to next table
      }
    }
    
    console.error(`❌ Delete failed for ${id}:`, lastError);
    laatsteFoutPerId[id] = lastError?.message || String(lastError || 'onbekende fout');
    return false;

  } catch (err) {
    console.error(`❌ Supabase delete error (${id}):`, err);
    laatsteFoutPerId[id] = err.message;
    return false;
  }
}

// ===== SYNC PENDING QUEUE =====

export async function syncPendingQueue() {
  if (!heeftClient()) {
    console.log('⚠️  Supabase not available, skipping sync');
    return;
  }
  
  // Verwijderen gaat voor. Staat er zowel een 'create' als een 'delete' voor
  // hetzelfde ding, dan moet het verwijderen als laatste gebeuren — anders
  // maakt de create het meteen weer aan. Sorteren op operatie regelt dat.
  const keys = Object.keys(pendingQueue)
    .sort((a, b) => (pendingQueue[a].operation === 'delete' ? 1 : 0) - (pendingQueue[b].operation === 'delete' ? 1 : 0));
  if (keys.length === 0) return;
  
  console.log(`🔄 Syncing ${keys.length} pending items to Supabase...`);
  
  let synced = 0;
  let failed = 0;
  
  for (const key of keys) {
    const pending = pendingQueue[key];
    
    if (pending.attempts >= pending.maxAttempts) {
      console.warn(`⚠️  ${key}: Max attempts reached, pausing`);
      failed++;
      continue;
    }
    
    pending.attempts++;
    
    try {
      let success = false;
      
      if (pending.operation === 'delete') {
        success = await deleteFromSupabase(pending.id, pending.soort || 'auto');
      } else if (pending.operation === 'hnvi') {
        success = await saveHnviToSupabase(pending.data);
      } else if (pending.operation === 'cover') {
        success = await saveCoverToSupabase(pending.data);
      } else {
        success = await saveToSupabase(pending.data, pending.isHistoric);
      }
      
      if (success) {
        clearPendingQueueItem(key);
        synced++;
      } else {
        pending.status = 'pending';
        pending.laatsteFout = laatsteFoutPerId[pending.id] || 'onbekende fout';
        failed++;
      }
    } catch (err) {
      console.warn(`❌ Failed to sync ${key}:`, err);
      pending.status = 'pending';
      pending.laatsteFout = err.message || String(err);
      failed++;
    }
  }
  
  savePendingQueue();
  
  const status = wachtrijStatus();
  if (synced > 0) {
    console.log(`✅ ${synced} verstuurd, ${status.open} nog open`);
  }
  if (status.vastgelopen > 0) {
    console.warn(`⚠️  ${status.vastgelopen} wijziging(en) komen niet aan na ${5} pogingen. ` +
                 `Ze blijven lokaal bewaard; gebruik de synchronisatieknop om opnieuw te proberen.`);
  }
  return { synced, failed, ...status };
}

// ===== HELPERS =====

export function isSupabaseReady() {
  if (!syncIsAangezet()) return false;
  return heeftClient();
}

export function getPendingItems() {
  return Object.values(pendingQueue);
}
