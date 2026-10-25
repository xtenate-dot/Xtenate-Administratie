// bankinbox.js — de inbox met bankregels die de dagelijkse ochtendronde heeft opgehaald.
//
// De Edge Function zet elke ochtend nieuwe, definitief geboekte bankregels in de
// tabel bank_inbox (status "nieuw"). Hier lees je ze, en zet je ze om / negeer je ze.
// Er wordt niets automatisch geboekt: de regels gaan eerst door het voorstel.

import { getClient } from './supabase.js?v=20261024z';

const KOLOMMEN = 'id, entry_reference, datum, bedrag, richting, naam, omschr';

/** Aantal regels in de inbox dat nog bekeken moet worden; null als dat niet lukt. */
export async function telInbox() {
  try {
    const sb = await getClient();
    const { count, error } = await sb.from('bank_inbox').select('id', { count: 'exact', head: true }).eq('status', 'nieuw');
    return error ? null : (count || 0);
  } catch { return null; }
}

/** Alle nieuwe inboxregels (oudste eerst). */
export async function haalInboxOp() {
  const sb = await getClient();
  const { data, error } = await sb.from('bank_inbox').select(KOLOMMEN).eq('status', 'nieuw').order('datum').limit(1000);
  if (error) throw new Error('inbox lezen mislukt');
  return data || [];
}

/** Zet de status van inboxregels (omgezet of genegeerd). Geeft true als alles gelukt is. */
export async function zetInboxStatus(ids, status) {
  if (!ids.length) return true;
  try {
    const sb = await getClient();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await sb.from('bank_inbox').update({ status }).in('id', ids.slice(i, i + 100));
      if (error) return false;
    }
    return true;
  } catch { return false; }
}
