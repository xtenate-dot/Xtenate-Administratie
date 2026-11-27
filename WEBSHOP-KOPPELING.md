# Webshop-koppeling (MijnMagie / WooCommerce)

Nieuwe pagina **Webshop** onder "Handel en voorraad". Werkt zoals de Bol-pagina: eerst laten zien, pas na jouw bevestiging iets veranderen.

## Wat het doet

- **Bestellingen ophalen** uit de webshop en bewaren in `webshop_bestellingen`. Zonder persoonsgegevens van klanten: alleen land, bedragen en artikelen. Elke nacht om 03:30 automatisch de laatste 7 dagen.
- **Verkopen verwerken in je voorraad**: koppel een artikel aan een webshop-SKU (bijv. `MM-1002`), dan zie je nieuwe webshopverkopen en verwerk je ze met één knop (logboek, bron `webshop`).
- **Voorraad naar de webshop sturen**: zet de voorraad in de webshop gelijk aan je eigen voorraad, alleen voor gekoppelde artikelen. Bol-aanbod dat je pas na een bestelling inkoopt (zoals je Belgische account met voorraad 50) koppel je niet, dus dat komt nooit in de webshop.
- Bestellingen die meetellen als verkoop: *Betaald, te versturen* (processing), *Verzonden* (completed) en *In de wacht* (on-hold). Geannuleerd, mislukt en terugbetaald tellen niet.
- De omzet op deze pagina is ter controle. Aangifte en KOR blijven rekenen met je geboekte Mollie-uitbetalingen.

## Eenmalig instellen

1. **WooCommerce-sleutel**: in WordPress → WooCommerce → Instellingen → Geavanceerd → REST API → *Sleutel toevoegen*. Omschrijving "Xtenate administratie", gebruiker de beheerder, rechten **Lezen/Schrijven**. Kopieer de Consumer key (`ck_…`) en Consumer secret (`cs_…`).
2. **Secrets in Supabase** (Project Settings → Edge Functions → Secrets):
   - `WEBSHOP_URL` = `https://mijnmagie.nl`
   - `WEBSHOP_KEY` = de consumer key
   - `WEBSHOP_SECRET` = de consumer secret
3. **Tabel en nachtronde**: voer `webshop_bestellingen.sql` uit in de SQL Editor (eerst het `create table`-deel; het `cron.schedule`-deel pas na stap 4).
4. **Functie deployen**: `supabase functions deploy webshop-koppeling` (of in het dashboard een nieuwe functie `webshop-koppeling` aanmaken met de inhoud van `supabase/functions/webshop-koppeling/index.ts`). Zet "Verify JWT" **uit**, net als bij bank- en bol-koppeling: de nachtronde van pg_cron stuurt geen gebruikers-JWT mee, en de functie controleert zelf de gebruiker (auth.getUser) of het cron-geheim.
5. Open de pagina Webshop: bovenaan moet "Verbonden met de webshop." staan.

## Bekende beperkingen

- Voorraad sturen werkt voor gewone producten. Varianten (zoals kleuren van de Funko-houder) worden op bestelling geprint en hebben geen voorraadbeheer, dus die koppel je niet.
- De voorraad op Bol wordt (nog) niet automatisch aangepast; de Bol-koppeling blijft alleen lezen. Dat kan een volgende stap zijn.
- Gedeeltelijke terugbetalingen staan als bedrag bij de bestelling, maar verlagen het aantal verkochte stuks niet.
