// zelftest.js — controleert of de verbinding met Supabase werkt zoals bedoeld.
//
// De test draait tegen je echte database, maar raakt je administratie niet aan.
// Alles wat er wordt aangemaakt heet "Zelftest …", wordt aan het eind weer
// verwijderd, en er wordt geteld of er daarna inderdaad niets is blijven staan.
//
// Wat er wordt gecontroleerd: toevoegen, lezen, wijzigen, verwijderen, de
// koppelingen tussen tabellen, of updated_at meeloopt, of zacht verwijderen
// werkt, en of Row Level Security een regel op naam van iemand anders weigert.

import { VerbindingsFout, getClient, leesbareFout } from './supabase.js?v=20261024b';

const merk = () => 'Zelftest ' + new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Eén uitkomst in de lijst. */
const uitkomst = (naam, gelukt, detail) => ({ naam, gelukt, detail });

/**
 * Voert de test uit en levert een lijst met uitkomsten op.
 * `melden` wordt na elke stap aangeroepen, zodat de lijst live kan meelopen.
 */
export async function draaiZelftest(melden = () => {}) {
  const resultaten = [];
  const voegToe = r => { resultaten.push(r); melden(resultaten); return r; };

  // Alles wat we aanmaken, zodat het opruimen niets kan missen.
  const opruimen = { productgroepen: [], voorraadartikelen: [], voorraadstanden: [], instellingen: [] };
  let sb, gebruiker;

  try {
    // ---------------------------------------------------------- 1. sessie
    try {
      sb = await getClient();
      const { data, error } = await sb.auth.getUser();
      if (error) throw error;
      if (!data?.user) throw new VerbindingsFout('Geen ingelogde gebruiker gevonden. Log opnieuw in.');
      gebruiker = data.user;
      voegToe(uitkomst('Verbinding en sessie', true, `Ingelogd als ${gebruiker.email}`));
    } catch (e) {
      voegToe(uitkomst('Verbinding en sessie', false, leesbareFout(e)));
      return resultaten; // zonder sessie heeft de rest geen zin
    }

    const mijnId = gebruiker.id;

    // ------------------------------------------------- 2. stamgegevens lezen
    try {
      const tellen = async tabel => {
        const { count, error } = await sb.from(tabel)
          .select('id', { count: 'exact', head: true })
          .is('deleted_at', null);
        if (error) throw error;
        return count;
      };
      const gb = await tellen('grootboekrekeningen');
      const bank = await tellen('bankrekeningen');
      const groep = await tellen('productgroepen');
      const goed = gb >= 26 && bank >= 5 && groep >= 5;
      voegToe(uitkomst('Stamgegevens lezen', goed,
        `${gb} grootboekrekeningen, ${bank} bankrekeningen, ${groep} productgroepen` +
        (goed ? '' : ' — verwacht minimaal 26, 5 en 5. Is zet_stamgegevens_klaar gedraaid?')));
    } catch (e) {
      voegToe(uitkomst('Stamgegevens lezen', false, leesbareFout(e)));
    }

    // ------------------------------------------------------- 3. toevoegen
    let groep = null;
    const groepnaam = merk();
    try {
      const { data, error } = await sb.from('productgroepen')
        .insert({ user_id: mijnId, naam: groepnaam, volgorde: 999 })
        .select().single();
      if (error) throw error;
      groep = data;
      opruimen.productgroepen.push(data.id);
      voegToe(uitkomst('Toevoegen', true, `Productgroep aangemaakt, database gaf een id terug`));
    } catch (e) {
      voegToe(uitkomst('Toevoegen', false, leesbareFout(e)));
    }

    // ---------------------------------------------------------- 4. lezen
    if (groep) {
      try {
        const { data, error } = await sb.from('productgroepen')
          .select('id, naam, user_id, created_at, updated_at')
          .eq('id', groep.id).single();
        if (error) throw error;
        const goed = data.naam === groepnaam && data.user_id === mijnId;
        voegToe(uitkomst('Lezen', goed, goed
          ? 'Teruggelezen regel komt overeen, en staat op jouw account'
          : 'Teruggelezen regel wijkt af'));
      } catch (e) {
        voegToe(uitkomst('Lezen', false, leesbareFout(e)));
      }
    }

    // -------------------------------------------------------- 5. wijzigen
    if (groep) {
      try {
        await new Promise(r => setTimeout(r, 1100)); // zodat updated_at zichtbaar verschilt
        const { data, error } = await sb.from('productgroepen')
          .update({ naam: groepnaam + ' (gewijzigd)' })
          .eq('id', groep.id).select().single();
        if (error) throw error;
        const bijgewerkt = new Date(data.updated_at) > new Date(data.created_at);
        voegToe(uitkomst('Wijzigen', data.naam.endsWith('(gewijzigd)'), 'Naam aangepast en teruggelezen'));
        voegToe(uitkomst('updated_at loopt mee', bijgewerkt, bijgewerkt
          ? 'De database heeft het tijdstip zelf bijgewerkt'
          : 'updated_at is niet meegelopen — draait de trigger?'));
      } catch (e) {
        voegToe(uitkomst('Wijzigen', false, leesbareFout(e)));
      }
    }

    // ------------------------------------------------- 6. koppeling tussen tabellen
    let artikel = null;
    if (groep) {
      try {
        const { data, error } = await sb.from('voorraadartikelen')
          .insert({ user_id: mijnId, productgroep_id: groep.id, artikel: merk() + ' artikel', voorraad: 3 })
          .select('id, artikel, productgroep_id').single();
        if (error) throw error;
        artikel = data;
        opruimen.voorraadartikelen.push(data.id);

        const { data: metGroep, error: leesFout } = await sb.from('voorraadartikelen')
          .select('artikel, productgroepen(naam)').eq('id', data.id).single();
        if (leesFout) throw leesFout;
        const gekoppeld = metGroep?.productgroepen?.naam?.startsWith('Zelftest');
        voegToe(uitkomst('Koppeling tussen tabellen', gekoppeld,
          gekoppeld ? 'Artikel gekoppeld aan de groep en samen opgehaald' : 'De koppeling kwam niet terug'));
      } catch (e) {
        voegToe(uitkomst('Koppeling tussen tabellen', false, leesbareFout(e)));
      }
    }

    // ---------------------------------------- 7. verwijderen werkt door in gekoppelde regels
    if (artikel) {
      try {
        const { data, error } = await sb.from('voorraadstanden')
          .insert({ user_id: mijnId, artikel_id: artikel.id, jaar: 2099, eindvoorraad: 3, verkocht: 0 })
          .select('id').single();
        if (error) throw error;
        opruimen.voorraadstanden.push(data.id);

        const { error: wegFout } = await sb.from('voorraadartikelen').delete().eq('id', artikel.id);
        if (wegFout) throw wegFout;
        opruimen.voorraadartikelen = opruimen.voorraadartikelen.filter(i => i !== artikel.id);

        const { count, error: telFout } = await sb.from('voorraadstanden')
          .select('id', { count: 'exact', head: true }).eq('id', data.id);
        if (telFout) throw telFout;
        const meeVerwijderd = count === 0;
        if (meeVerwijderd) opruimen.voorraadstanden = opruimen.voorraadstanden.filter(i => i !== data.id);
        voegToe(uitkomst('Verwijderen werkt door', meeVerwijderd, meeVerwijderd
          ? 'Bij het verwijderen van het artikel ging de jaarstand mee'
          : 'De jaarstand bleef achter na het verwijderen van het artikel'));
        artikel = null;
      } catch (e) {
        voegToe(uitkomst('Verwijderen werkt door', false, leesbareFout(e)));
      }
    }

    // ------------------------------------------------- 8. zacht verwijderen
    if (groep) {
      try {
        const { error } = await sb.from('productgroepen')
          .update({ deleted_at: new Date().toISOString() }).eq('id', groep.id);
        if (error) throw error;

        const { count: zonderFilter } = await sb.from('productgroepen')
          .select('id', { count: 'exact', head: true }).eq('id', groep.id);
        const { count: actief } = await sb.from('productgroepen')
          .select('id', { count: 'exact', head: true }).eq('id', groep.id).is('deleted_at', null);

        const goed = zonderFilter === 1 && actief === 0;
        voegToe(uitkomst('Zacht verwijderen', goed, goed
          ? 'De regel bestaat nog, maar telt niet meer mee als actief'
          : `Onverwacht: ${zonderFilter} totaal, ${actief} actief`));
      } catch (e) {
        voegToe(uitkomst('Zacht verwijderen', false, leesbareFout(e)));
      }
    }

    // ------------------------------------------------- 9. instellingen bewaren
    try {
      const sleutel = 'zelftest';
      const { error } = await sb.from('instellingen')
        .upsert({ user_id: mijnId, sleutel, waarde: { moment: new Date().toISOString() } },
                { onConflict: 'user_id,sleutel' });
      if (error) throw error;
      opruimen.instellingen.push(sleutel);

      const { data, error: leesFout } = await sb.from('instellingen')
        .select('waarde').eq('sleutel', sleutel).single();
      if (leesFout) throw leesFout;
      voegToe(uitkomst('Instellingen bewaren', !!data?.waarde?.moment,
        'Een instelling opgeslagen en teruggelezen als JSON'));
    } catch (e) {
      voegToe(uitkomst('Instellingen bewaren', false, leesbareFout(e)));
    }

    // ------------------------------------------------- 10. beveiliging
    try {
      const vreemdId = '00000000-0000-0000-0000-000000000000';
      const { data, error } = await sb.from('productgroepen')
        .insert({ user_id: vreemdId, naam: merk() + ' beveiliging', volgorde: 998 })
        .select('id');
      if (!error && data?.length) {
        opruimen.productgroepen.push(data[0].id);
        voegToe(uitkomst('Beveiliging', false,
          'LET OP: een regel op naam van een ander account werd geaccepteerd. Controleer de policies.'));
      } else {
        voegToe(uitkomst('Beveiliging', true,
          'Een regel op naam van een ander account wordt geweigerd door Row Level Security'));
      }
    } catch (e) {
      voegToe(uitkomst('Beveiliging', true, 'Een regel op naam van een ander account wordt geweigerd'));
    }

  } finally {
    // ----------------------------------------------------- 11. opruimen
    let fouten = 0, aantal = 0;
    const wis = async (tabel, ids) => {
      for (const id of ids) {
        aantal++;
        const { error } = await sb.from(tabel).delete().eq('id', id);
        if (error) fouten++;
      }
    };
    try {
      await wis('voorraadstanden', opruimen.voorraadstanden);
      await wis('voorraadartikelen', opruimen.voorraadartikelen);
      await wis('productgroepen', opruimen.productgroepen);
      for (const sleutel of opruimen.instellingen) {
        aantal++;
        const { error } = await sb.from('instellingen').delete().eq('sleutel', sleutel);
        if (error) fouten++;
      }

      // Controleren dat er echt niets is blijven staan.
      const { count } = await sb.from('productgroepen')
        .select('id', { count: 'exact', head: true }).like('naam', 'Zelftest %');
      const schoon = fouten === 0 && (count === 0 || count === null);
      resultaten.push(uitkomst('Opruimen', schoon, schoon
        ? `${aantal} testregels verwijderd, er is niets blijven staan`
        : `${fouten} van ${aantal} testregels konden niet worden verwijderd`));
    } catch (e) {
      resultaten.push(uitkomst('Opruimen', false, leesbareFout(e)));
    }
    melden(resultaten);
  }

  return resultaten;
}
