// hnvilot.js — een HNVI-lot kan uit meerdere stuks bestaan, waarvan een deel is
// verkocht. De inkoop staat als totaal op het lot; per verkocht stuk telt dus
// maar een evenredig deel mee als kosten.
//
// Voorbeeld: "Vier Hitster spellen" voor € 36, aantal 4, één verkocht:
// kosten € 9 (verkocht deel), € 27 blijft voorraad.
//
// Een lot zonder aantal is één stuk, en zonder aantal verkocht geldt de
// status: 'verkocht' is dan alles verkocht, 'voorraad' niets.

export const lotAantal = l => Math.max(1, Math.floor(Number(l && l.aantal) || 1));

/** Aantal verkochte stuks, begrensd tussen 0 en het aantal van het lot. */
export function lotVerkochtStuks(l) {
  const a = lotAantal(l);
  if (l && l.verkochtAantal != null && l.verkochtAantal !== '' && Number.isFinite(Number(l.verkochtAantal))) {
    return Math.min(a, Math.max(0, Math.floor(Number(l.verkochtAantal))));
  }
  return l && l.status === 'verkocht' ? a : 0;
}

const rond = n => Math.round(n * 100) / 100;

/**
 * Knipt gedeeltelijk verkochte loten in een verkocht en een voorraaddeel,
 * zodat alle berekeningen met 'verkocht' en 'voorraad' gewoon blijven werken.
 * Een lot dat helemaal verkocht of helemaal niet verkocht is, blijft zoals het is.
 */
export function splitsLoten(loten) {
  const uit = [];
  for (const l of loten || []) {
    const a = lotAantal(l), v = lotVerkochtStuks(l);
    if (v <= 0) { uit.push(l.status === 'verkocht' ? { ...l, status: 'voorraad' } : l); continue; }
    if (v >= a) { uit.push(l.status === 'verkocht' ? l : { ...l, status: 'verkocht' }); continue; }
    const inkoop = Number(l.inkoop) || 0;
    const verkochtDeel = rond(inkoop * v / a);
    uit.push({ ...l, id: `${l.id}#verkocht`, aantal: v, inkoop: verkochtDeel, status: 'verkocht' });
    uit.push({ ...l, id: `${l.id}#voorraad`, aantal: a - v, inkoop: rond(inkoop - verkochtDeel), status: 'voorraad', verkoop: null, verkoopDatum: '' });
  }
  return uit;
}
