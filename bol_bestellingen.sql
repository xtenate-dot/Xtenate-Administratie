-- Bol.com-bestellingen die de Edge Function bol-koppeling ophaalt. Per gebruiker afgeschermd (RLS).
-- De Bol-API geeft maar ongeveer 3 maanden terug; hier bouw je dus je eigen historie op.
create table if not exists public.bol_bestellingen (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id text not null,
  besteld timestamptz,
  datum date,
  items jsonb not null default '[]'::jsonb,
  opgehaald_op timestamptz not null default now(),
  primary key (user_id, order_id)
);
create index if not exists bol_bestellingen_datum on public.bol_bestellingen (user_id, datum);
alter table public.bol_bestellingen enable row level security;
revoke all on public.bol_bestellingen from public, anon;
grant select, insert, update, delete on public.bol_bestellingen to authenticated;
drop policy if exists "bol_bestellingen eigen rijen" on public.bol_bestellingen;
create policy "bol_bestellingen eigen rijen" on public.bol_bestellingen for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
