-- Dagelijkse bankronde. Stap A: kolommen, rechten, extensies, geheim.
alter table public.bank_koppelingen add column if not exists laatste_fout text;
grant select (laatste_sync, laatste_fout) on public.bank_koppelingen to authenticated;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Geheim dat in de database zelf wordt aangemaakt; alleen de service-rol (Edge Function) en pg_cron kunnen erbij.
create table if not exists public.bank_cron_geheim (
  id int primary key default 1 check (id = 1),
  geheim text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.bank_cron_geheim enable row level security;
revoke all on public.bank_cron_geheim from public, anon, authenticated;
insert into public.bank_cron_geheim (id) values (1) on conflict do nothing;

-- Stap B: elke ochtend om 06:00 UTC (07:00 in de winter, 08:00 in de zomer).
select cron.schedule('bank-dagronde', '0 6 * * *', $$
  select net.http_post(
    url := 'https://wmnqtukxwzbzmkmxdxrt.supabase.co/functions/v1/bank-koppeling/dagelijks',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select geheim from public.bank_cron_geheim where id = 1)),
    body := '{}'::jsonb) $$);
