# Openstaande wensen en afspraken (bijgewerkt 23-10-2026)

Dit bestand is het geheugen tussen sessies. Werk het bij na elke wijziging.

## Gedaan op 23-10-2026 (nog door de gebruiker te testen)
- HNVI: aantal per lot + verkochte stuks + "opbrengst staat al in de bank" (hnvilot.js, HNVI_EXTRA in app_data).
- Voorraadpagina zonder verkoopwaarde en marge.
- Kilometers (ritten × tarief) in Per periode (samenvatting + grootboekmatrix onder Reiskosten 4640).
- Bankimport: verwijderknop per regel in het voorstel.

## Gedaan op 23-10-2026 (avond)
- Lotsplitsing getest in de live app (Vier Hitster: 4 stuks, 1 verkocht → winst +27). Zes Hitster: aantal nog invullen door de gebruiker.
- Voorraad: kolom Verkoopprijs weg. Testregel 9999 weg. Boekingen 820/822 (Hitster-verkoop) van prive_storting naar inkomst 8000.
- Mailen: knop deelt pdf als bijlage (telefoon/Mac/Windows) of downloadt pdf + opent mailto met tekst; echt automatisch versturen vereist een backend (Supabase Edge Function + mailservice), nog niet gedaan.
- Factuur maken (factuurmaker.js, nav 'Factuur maken'): klant, regels uit voorraad of eigen regel, KOR of 21% BTW, live voorbeeld, afdrukken/PDF, bewaren in Facturen (veld `regels`). Indeling: titel, kleur, logo, kolommen aan/uit. Instellingen staan alleen in de browser (localStorage). Voorraad wordt niet afgeboekt.

- Logo staat nu ook in de pdf van Mailen (pdf.js ondersteunt een jpeg-logo bovenaan pagina 1).
- Bonnetjes bij boekingen (bonnetjes.js): bijlage toevoegen in boekingsvenster, paperclip in banklijst + detailpaneel, back-up/terugzetten in Beheer. Alleen in IndexedDB van de browser (keuze gebruiker); koppeling via boeking-id.

- PAUZE (gebruiker 23-10): cloud-synchronisatie van voorraad (vervang_voorraad.sql in Supabase uitvoeren), factuurinstellingen en bonnetjes (Supabase Storage bucket) -- later oppakken; telefoon/computer delen nu alleen boekingen, loten, facturen, bedrijfsgegevens.

## Jaarwisseling 2027: GEDAAN op 23-10-2026 (v20261023t), getest met nagemaakte 2027-boekingen
- jaren.js is de enige plek voor jaarlogica: `txVanJaar(jaar)` (op datum, uit TX en HIST_TX), `lopendJaar()`, `isTxJaar`, `banksaldoTot`, `berekendMaandSaldo`. TX = alle boekingen vanaf 2026 (in de cloud archief_jaar NULL), HIST_TX = eerdere jaren.
- Omgezet: bank, belasting, controle, dashboard, grootboek, partijen, export, excel-ui, jaarafsluiting, bankimport (alle jaren vanaf 2026, vergrendeld-vraag), Excel-import (vervangt alleen de jaren uit het bestand, ids botsen niet), voorraad (lopendJaar), kor.
- Saldo's: zonder afschrift-saldo (Excel) wordt het saldo berekend uit beginsaldo 1-1-2026 + boekingen (bank, dashboard, export).
- Wissen van 2026 wordt geweigerd zolang er boekingen van latere jaren zijn.
- Jaarafsluiting: controle "eindvoorraad {jaar} vastgelegd" met knop "Leg vast" (zet de huidige voorraad als eindstand van een afgesloten jaar). In januari 2027 doen vóór de voorraad verandert.
- Tarieven per jaar (tarieven.js): 2024-2026 volgens KVK, 2027 voorstel Belastingplan; bewerkbaar via knop "Tarieven {jaar}" op Belasting; zelfstandigenaftrek optioneel (standaard uit). Nog niet gedaan: heffingskortingen; herstel.js/migratie.js/opslagdiagnose zijn diagnosetools met 2026-aannames; voorraad-"Omzet {jaar}" gebruikt nog het veld omzet2026 (legacy naam).
- Draaiboek begin januari 2027: back-up maken; 2026 afsluiten via Jaarafsluiting (eindvoorraad vastleggen, controle doorlopen, aangifte, vergrendelen); daarna boeken in 2027.

## Wensen van de gebruiker (nog te doen)
1. **Bankimport: verwijderen.** Bij het importeren van de bank geen verwijderknop. Gewenst: regels (dubbel, storno) uit het voorstel kunnen halen, én een al geïmporteerde boeking makkelijk kunnen verwijderen. (Een vinkje om een regel over te slaan bestaat al.)
2. **HNVI: deel van een lot verkocht.** Voorbeeld: "Vier Hitster spellen", één verkocht, drie nog niet. Nu telt de hele inkoop mee zodra het lot als verkocht staat, dus ontstaat een schijnverlies. Voorstel: aantal stuks per lot, inkoop per stuk, verkochte stuks; kosten = inkoop per stuk × verkochte stuks. Daarnaast optie om een lot te splitsen. Keuze met de gebruiker bespreken (aantal-veld versus splitsen in Excel).
3. **Facturen maken en versturen.** (EERSTE VERSIE GEBOUWD 23-10; nog te doen: vrije indeling Canva-stijl, voorraad afboeken) Een lege "sheet" die je zelf indeelt (Canva-idee), artikelen uit de voorraad kiezen met aantallen, en eigen regels (bijv. extern werk). Niet urgent. Er bestaat al een facturenonderdeel (facturen.js, facturen-ui.js) — eerst kijken wat daar is.
4. **Kilometers in "Per periode".** De kilometertab werkt, maar de kilometers komen niet in Per periode (en dus niet in de Excel-export). Gewenst: per maand zichtbaar, zodat de Excel-export klopt met de huidige Excel. Onderzoeken wat er gebeurt (km.js, periode.js).
5. **Voorraadpagina.** Verkoopwaarde en marge weglaten. Alleen voorraad (aantal) en inkoopwaarde tonen. Inkoopwaarde uit de bankinkopen halen waar dat past; niet voor elk artikel (gamemuizen komen van de Makro, Funko-popstandaards worden zelf geprint).
6. **Bankkoppeling automatisch.** Als het lukt: dagelijks bijgewerkt zonder upload. Anders blijft de CSV-import. Eerst uitzoeken of Revolut Business bij Enable Banking werkt en wat het kost (info@enablebanking.com).

## Besloten op 23-10-2026
- HNVI: **aantal per lot** (inkoop per stuk, verkochte stuks); het andere bestand (gesplitst) blijft ernaast zichtbaar.
- Kilometers in Per periode en verwijderen bij de bankimport: eerst onderzoeken, dan doen (vanavond/als de gebruiker thuis is).
- Bank importeren en koppelen aan grootboek doet de gebruiker later, eerst moet de rest werken.
- NIEUW: bij een verkocht HNVI-lot een keuze "opbrengst staat al in de bank (meerdere betalingen)", zodat de verkoopprijs niet nog eens als extra omzet telt. Aanleiding: Cartridges (€ 334,70) wordt niet als één bankbedrag teruggevonden, waarschijnlijk omdat het in meerdere Marktplaats-betalingen is binnengekomen. Nog niet geverifieerd in de data.

## Nog te beantwoorden / door de gebruiker te doen
- Voorraad importeren ("Voorraad & Mutaties" via Import op de Voorraadpagina), zodat de AliExpress/Alibaba-inkoop wordt toegerekend.
- Staat Revolut vanaf april op 1009 of op 1010? In de app staat alles in 2026 op 1010 en niets op 1009. Beslissen; dan boekingen verplaatsen en de import op 1009 zetten.
- Twee mogelijk dubbele boekingen (592/594 en 775/776), twaalf mogelijk verkeerd getypte boekingen, vier HNVI-verschillen met de Excel (Iphone 6s, Vier/Zes Hitster, RTM-lot).
- 7 verkochte HNVI-loten niet terug te vinden in de bank (€ 1.044,70) controleren.
- Jaar 2025 vergrendelen op de Jaarafsluiting-pagina (aangifte is ingediend).
- Testversie: heeft een tweede (gratis) Supabase-project nodig. Vraag openstaand.
- "Testregel 9999" uit het grootboek halen (staat in de data, niet in de code).

## Besluiten
- Inkoopkosten tellen alleen mee als het artikel verkocht is, in het jaar van verkoop (HNVI: per lot; AliExpress: via het gemiddelde inkoopbedrag per stuk).
- Bol.com en Helmetcoverstore halen hun voorraad uit AliExpress/Alibaba (7000); MijnMagie (7020) is directe kosten.
- Aangifte 2025 is ingediend zonder de inkoop van de loten die in 2026 zijn verkocht; die tellen dus in 2026.

## Urenregistratie (23-10) — GEDAAN
- Pagina "Uren" (uren.js, uren-ui.js): uren invoeren (1,5 of 1:30), soort, omschrijving, timer (kwartieren, alleen in deze browser), voortgang t.o.v. 1.225 uur, tempo/prognose, per maand en per soort.
- Opslag: localStorage `xtenate_uren` + cloud app_data-sleutel `uren` (zelfde patroon als km). Raakt boekingen/belasting niet.
- Jaarafsluiting toont een inforegel "Uren {jaar}: X van 1.225".

## Facturen-aandachtspunten op het overzicht (23-10) — GEDAAN
- Overzicht toont "X facturen te laat betaald" (debiteuren) en "te betalen facturen" (crediteuren, verlopen of binnenkort), uit factuurSamenvatting().

## Bonnetjes-info in Jaarafsluiting (23-10) — GEDAAN
- Inforegel: hoeveel uitgaven een bonnetje hebben (bewaarplicht 7 jaar). Alleen informatief.

## Bankkoppeling Revolut Business (24-10) — IN UITVOERING
- Enable Banking: productie-app "Xtenate Administratie" (restricted, gratis), Revolut Business gekoppeld door de gebruiker. Supabase-secrets APP_ID/PRIVATE_KEY zijn door de gebruiker vervangen (app-id digest geverifieerd). Edge Function bank-koppeling geüpdatet en uitgerold (NL, Revolut, business, 89 dagen, redirect Xtenate-Administratie).
- Gebouwd: knop "Bankrekening koppelen" in Beheer + opvang van ?code&state (bankkoppelen.js).
- Nog te doen: de koppeling zelf doorlopen (door de gebruiker, in Revolut), dan: transacties ophalen (4b-4, dedup op entry_reference), knop "Nu ophalen", inbox (4c). Functie kiest nu alleen het eerste account uit de sessie.

## Bankkoppeling: ophalen (24-10) — GEDAAN, getest live
- Revolut Business gekoppeld (1 koppeling). Edge Function bank-koppeling heeft acties: (start), /sessies, /ophalen (laatste 45 dagen, BOOK). Verify JWT staat UIT (functie controleert zelf). CORS alleen voor xtenate-dot.github.io.
- Database: SQL-functie bank_sessie_voor_ophalen (security definer, alleen eigen rijen) — zie bank_sessie_voor_ophalen.sql.
- App: Bank importeren > "Ophalen bij de bank" -> zelfde voorstel als CSV (dubbelen herkend, grootboek geleerd van eerdere boekingen). Test 24-10: 73 regels (9 sep-23 okt), 46 staan al, 27 nieuw, 10 zonder rekening.
- Nog te doen: automatische dagelijkse ronde (pg_cron + opslag in bank_inbox), laatste_sync bijhouden, nette weergave van fouten, 90-dagen verlenging.
