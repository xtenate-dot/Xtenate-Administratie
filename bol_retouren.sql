-- Bol.com-retouren (uit de Retailer API, onderdeel "returns"). Per gebruiker afgeschermd (RLS).
-- Eén rij per retourregel (rma_id). Geen namen of adressen, alleen bestelnummer, EAN, aantallen en uitkomst.
create table if not exists public.bol_retouren (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account text not null default '1',
  rma_id text not null,
  return_id text,
  order_id text,
  ean text,
  aantal integer not null default 0,
  geaccepteerd integer not null default 0,
  afgewezen integer not null default 0,
  geregistreerd timestamptz,
  datum date,
  reden text,
  afgehandeld boolean not null default false,
  resultaten jsonb not null default '[]'::jsonb,
  methode text,
  opgehaald_op timestamptz not null default now(),
  primary key (user_id, account, rma_id)
);
create index if not exists bol_retouren_datum on public.bol_retouren (user_id, datum);
alter table public.bol_retouren enable row level security;
revoke all on public.bol_retouren from public, anon;
grant select, insert, update, delete on public.bol_retouren to authenticated;
drop policy if exists "bol_retouren eigen rijen" on public.bol_retouren;
create policy "bol_retouren eigen rijen" on public.bol_retouren for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
