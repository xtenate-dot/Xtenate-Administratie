-- Bol.com-facturen met specificatie (tot 2 jaar terug via de Retailer API), ruw bewaard.
-- Hiermee haal je de historie van vóór de ~3 maanden bestellingen binnen. Per gebruiker afgeschermd (RLS).
create table if not exists public.bol_facturen (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account text not null default '1',
  invoice_id text not null,
  uitgegeven date,
  type text,
  kop jsonb not null default '{}'::jsonb,
  specificatie jsonb not null default '[]'::jsonb,
  opgehaald_op timestamptz not null default now(),
  primary key (user_id, account, invoice_id)
);
create index if not exists bol_facturen_datum on public.bol_facturen (user_id, uitgegeven);
alter table public.bol_facturen enable row level security;
revoke all on public.bol_facturen from public, anon;
grant select, insert, update, delete on public.bol_facturen to authenticated;
drop policy if exists "bol_facturen eigen rijen" on public.bol_facturen;
create policy "bol_facturen eigen rijen" on public.bol_facturen for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
