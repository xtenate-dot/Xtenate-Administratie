-- Automatische back-ups in de cloud (eigen Supabase-project, geen extra kosten).
-- Elke nacht een momentopname van boekingen, loten, voorraad, relaties en alle instellingen/lijsten (app_data).
-- Alleen de eigenaar kan zijn eigen back-ups zien en verwijderen; aanmaken gaat uitsluitend via de functies hieronder.

create table if not exists public.cloud_backups (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  gemaakt timestamptz not null default now(),
  reden text not null check (reden in ('nacht', 'handmatig')),
  hash text not null,
  aantallen jsonb not null default '{}'::jsonb,
  inhoud jsonb not null
);
create index if not exists cloud_backups_user_tijd on public.cloud_backups (user_id, gemaakt desc);
alter table public.cloud_backups enable row level security;
revoke all on public.cloud_backups from public, anon, authenticated;
grant select, delete on public.cloud_backups to authenticated;
drop policy if exists "cloud_backups lezen eigen" on public.cloud_backups;
drop policy if exists "cloud_backups verwijderen eigen" on public.cloud_backups;
create policy "cloud_backups lezen eigen" on public.cloud_backups for select to authenticated using (user_id = auth.uid());
create policy "cloud_backups verwijderen eigen" on public.cloud_backups for delete to authenticated using (user_id = auth.uid());

-- Maakt een back-up voor één gebruiker. Niet bereikbaar voor de app zelf (alleen via de twee functies hieronder).
create or replace function public.maak_cloud_backup_voor(p_user uuid, p_reden text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inhoud jsonb; v_hash text; v_id bigint; v_laatste text;
begin
  v_inhoud := jsonb_build_object(
    'gemaakt', now(),
    'boekingen', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.boekingen t where t.user_id = p_user),
    'hnvi_loten', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.hnvi_loten t where t.user_id = p_user),
    'voorraadartikelen', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.voorraadartikelen t where t.user_id = p_user),
    'relaties', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.relaties t where t.user_id = p_user),
    'bonnetjes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.bonnetjes t where t.user_id = p_user),
    'app_data', (select coalesce(jsonb_agg(jsonb_build_object('sleutel', t.sleutel, 'waarde', t.waarde)), '[]'::jsonb) from public.app_data t where t.user_id = p_user)
  );
  -- De hash negeert het tijdstip, zodat een ongewijzigde nacht geen nieuwe kopie oplevert.
  v_hash := md5((v_inhoud - 'gemaakt')::text);
  if p_reden = 'nacht' then
    select hash into v_laatste from public.cloud_backups where user_id = p_user order by gemaakt desc limit 1;
    if v_laatste = v_hash then return null; end if;
  end if;
  insert into public.cloud_backups (user_id, reden, hash, aantallen, inhoud)
  values (p_user, p_reden, v_hash, jsonb_build_object(
    'boekingen', jsonb_array_length(v_inhoud->'boekingen'),
    'hnvi_loten', jsonb_array_length(v_inhoud->'hnvi_loten'),
    'voorraadartikelen', jsonb_array_length(v_inhoud->'voorraadartikelen'),
    'relaties', jsonb_array_length(v_inhoud->'relaties'),
    'bonnetjes', jsonb_array_length(v_inhoud->'bonnetjes'),
    'app_data', jsonb_array_length(v_inhoud->'app_data')), v_inhoud)
  returning id into v_id;
  -- Bewaren: de laatste 30 nachtelijke en de laatste 10 handmatige back-ups.
  delete from public.cloud_backups where user_id = p_user and reden = 'nacht' and id not in
    (select id from public.cloud_backups where user_id = p_user and reden = 'nacht' order by gemaakt desc limit 30);
  delete from public.cloud_backups where user_id = p_user and reden = 'handmatig' and id not in
    (select id from public.cloud_backups where user_id = p_user and reden = 'handmatig' order by gemaakt desc limit 10);
  return v_id;
end $$;
revoke all on function public.maak_cloud_backup_voor(uuid, text) from public, anon, authenticated;

-- Voor de knop "Nu back-up maken": alleen voor jezelf, hooguit één per minuut.
create or replace function public.maak_cloud_backup()
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if exists (select 1 from public.cloud_backups where user_id = auth.uid() and reden = 'handmatig' and gemaakt > now() - interval '1 minute') then
    raise exception 'Even wachten: er is net al een back-up gemaakt' using errcode = 'P0001';
  end if;
  return public.maak_cloud_backup_voor(auth.uid(), 'handmatig');
end $$;
revoke all on function public.maak_cloud_backup() from public, anon;
grant execute on function public.maak_cloud_backup() to authenticated;

-- Voor de planning: alle gebruikers met gegevens.
create or replace function public.maak_nachtelijke_backups()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in select distinct user_id from (select user_id from public.boekingen union select user_id from public.app_data) u loop
    if public.maak_cloud_backup_voor(r.user_id, 'nacht') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function public.maak_nachtelijke_backups() from public, anon, authenticated;

select cron.schedule('cloud-backup', '30 1 * * *', 'select public.maak_nachtelijke_backups()');
