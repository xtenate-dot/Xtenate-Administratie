-- Bol.com-bestellingen die de Edge Function bol-koppeling ophaalt. Per gebruiker afgeschermd (RLS).
-- De Bol-API geeft maar ongeveer 3 maanden terug; hier bouw je dus je eigen historie op.
-- Meerdere Bol-accounts: kolom "account" ('1', '2', ...), gelijk aan het nummer van de secrets in Supabase.
create table if not exists public.bol_bestellingen (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account text not null default '1',
  order_id text not null,
  besteld timestamptz,
  datum date,
  items jsonb not null default '[]'::jsonb,
  opgehaald_op timestamptz not null default now(),
  primary key (user_id, account, order_id)
);
-- Voor wie de eerste versie (zonder account) al heeft aangemaakt:
alter table public.bol_bestellingen add column if not exists account text not null default '1';
do $$ begin
  if exists (select 1 from information_schema.table_constraints where table_schema='public' and table_name='bol_bestellingen' and constraint_name='bol_bestellingen_pkey')
     and not exists (select 1 from information_schema.key_column_usage where table_schema='public' and table_name='bol_bestellingen' and constraint_name='bol_bestellingen_pkey' and column_name='account') then
    alter table public.bol_bestellingen drop constraint bol_bestellingen_pkey;
    alter table public.bol_bestellingen add primary key (user_id, account, order_id);
  end if;
end $$;
create index if not exists bol_bestellingen_datum on public.bol_bestellingen (user_id, datum);
alter table public.bol_bestellingen enable row level security;
revoke all on public.bol_bestellingen from public, anon;
grant select, insert, update, delete on public.bol_bestellingen to authenticated;
drop policy if exists "bol_bestellingen eigen rijen" on public.bol_bestellingen;
create policy "bol_bestellingen eigen rijen" on public.bol_bestellingen for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
