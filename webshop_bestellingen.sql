-- Webshopbestellingen (WooCommerce / MijnMagie) die de Edge Function webshop-koppeling ophaalt.
-- Per gebruiker afgeschermd (RLS). Er staan geen persoonsgegevens van klanten in: alleen land, bedragen en artikelen.
create table if not exists public.webshop_bestellingen (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id text not null,
  nummer text,
  status text,                 -- pending, processing, on-hold, completed, cancelled, refunded, failed, ...
  besteld timestamptz,
  betaald timestamptz,
  datum date,
  totaal numeric(12,2) not null default 0,         -- wat de klant betaalde, incl. verzending
  verzendkosten numeric(12,2) not null default 0,  -- verzendkosten die de klant betaalde
  terugbetaald numeric(12,2) not null default 0,
  betaalmethode text,
  land text,
  items jsonb not null default '[]'::jsonb,        -- [{ sku, naam, aantal, prijs, product_id, variatie_id }]
  opgehaald_op timestamptz not null default now(),
  primary key (user_id, order_id)
);
create index if not exists webshop_bestellingen_datum on public.webshop_bestellingen (user_id, datum);
alter table public.webshop_bestellingen enable row level security;
revoke all on public.webshop_bestellingen from public, anon;
grant select, insert, update, delete on public.webshop_bestellingen to authenticated;
drop policy if exists "webshop_bestellingen eigen rijen" on public.webshop_bestellingen;
create policy "webshop_bestellingen eigen rijen" on public.webshop_bestellingen for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Elke nacht de laatste 7 dagen ophalen (nieuwe, betaalde, geannuleerde en terugbetaalde bestellingen).
-- Gebruikt dezelfde geheim-tabel als de bank- en Bol-ronde (bank_cron_geheim). Pas uitvoeren nadat de functie is gedeployd.
select cron.schedule('webshop-nachtronde', '30 3 * * *', $$
  select net.http_post(
    url := 'https://wmnqtukxwzbzmkmxdxrt.supabase.co/functions/v1/webshop-koppeling/dagelijks',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select geheim from public.bank_cron_geheim where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000) $$);
