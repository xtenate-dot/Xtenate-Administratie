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

## BELANGRIJK: jaarwisseling 2027 (gevonden 23-10-2026, nog niet gedaan)
De app kent `state.TX` als "het huidige jaar = 2026" en `state.HIST_TX` als eerdere jaren. Op minstens ~40 plekken staat `'2026'` hard in de code (bank.js, belasting.js, controle.js, dashboard.js, export.js, grootboek.js, partijen.js, voorraad.js, modals.js (import: is2026 -> xtenate_tx), jaarafsluiting.js, bankimport.js, kor.js e.a.) plus BEGINSALDO_2026 (beginsaldo huidige jaar = 183,15). Op 1-1-2027 komen nieuwe boekingen in `TX` terecht en worden als 2026 getoond/geteld. Plan: (1) centrale `txVanJaar(jaar)` = alle TX+HIST_TX met datum-voorvoegsel; (2) HUIDIG_JAAR uit de datum van vandaag; (3) beginsaldo per jaar afleiden (eindsaldo vorig jaar); (4) import per jaar generiek; (5) jaar 2026 vergrendelen en testen met nagebootste 2027-boekingen. Doen vóór december, met herstelpunt en backup.

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
