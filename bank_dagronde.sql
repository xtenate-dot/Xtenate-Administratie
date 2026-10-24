-- Dagelijkse bankronde. Stap A: kolommen, rechten, extensies.
alter table public.bank_koppelingen add column if not exists laatste_fout text;
grant select (laatste_sync, laatste_fout) on public.bank_koppelingen to authenticated;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Stap B (na het zetten van het secret CRON_SECRET bij de Edge Function):
-- elke ochtend om 06:00 UTC (07:00 in de winter, 08:00 in de zomer).
-- Vervang <GEHEIM> door dezelfde waarde als CRON_SECRET.
-- select cron.schedule('bank-dagronde', '0 6 * * *', $$
--   select net.http_post(
--     url := 'https://wmnqtukxwzbzmkmxdxrt.supabase.co/functions/v1/bank-koppeling/dagelijks',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<GEHEIM>'),
--     body := '{}'::jsonb) $$);
