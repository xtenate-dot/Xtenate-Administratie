-- Bonnetjes in de cloud: privé opslag + een tabel met de gegevens per bijlage.
-- Alles is afgeschermd per gebruiker: je ziet en wijzigt alleen je eigen bestanden.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bonnetjes', 'bonnetjes', false, 8388608, array['image/jpeg', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 8388608, allowed_mime_types = array['image/jpeg', 'application/pdf'];

drop policy if exists "bonnetjes lezen eigen map" on storage.objects;
drop policy if exists "bonnetjes toevoegen eigen map" on storage.objects;
drop policy if exists "bonnetjes wijzigen eigen map" on storage.objects;
drop policy if exists "bonnetjes verwijderen eigen map" on storage.objects;
create policy "bonnetjes lezen eigen map" on storage.objects for select to authenticated
  using (bucket_id = 'bonnetjes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bonnetjes toevoegen eigen map" on storage.objects for insert to authenticated
  with check (bucket_id = 'bonnetjes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bonnetjes wijzigen eigen map" on storage.objects for update to authenticated
  using (bucket_id = 'bonnetjes' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'bonnetjes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bonnetjes verwijderen eigen map" on storage.objects for delete to authenticated
  using (bucket_id = 'bonnetjes' and (storage.foldername(name))[1] = auth.uid()::text);

create table if not exists public.bonnetjes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bid text not null,
  tx_id text not null,
  naam text not null,
  type text not null check (type in ('image/jpeg', 'application/pdf')),
  grootte integer not null default 0,
  toegevoegd timestamptz not null default now(),
  primary key (user_id, bid)
);
alter table public.bonnetjes enable row level security;
revoke all on public.bonnetjes from public, anon;
grant select, insert, update, delete on public.bonnetjes to authenticated;
drop policy if exists "bonnetjes eigen rijen" on public.bonnetjes;
create policy "bonnetjes eigen rijen" on public.bonnetjes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
