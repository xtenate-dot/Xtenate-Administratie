-- Debiteur- en crediteurnummers voor relaties: debiteuren vanaf 10000, crediteuren vanaf 20000.
-- Een relatie die zowel klant als leverancier is, krijgt beide nummers. Nummers zijn per gebruiker uniek en veranderen nooit.
alter table public.relaties add column if not exists debiteurnr integer;
alter table public.relaties add column if not exists crediteurnr integer;
create unique index if not exists relaties_debiteurnr_uniek on public.relaties (user_id, debiteurnr) where debiteurnr is not null;
create unique index if not exists relaties_crediteurnr_uniek on public.relaties (user_id, crediteurnr) where crediteurnr is not null;

create or replace function public.geef_relatienummer(p_relatie uuid, p_soort text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); n integer;
begin
  if v_uid is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if p_soort not in ('debiteur', 'crediteur') then raise exception 'Onbekende soort'; end if;
  perform pg_advisory_xact_lock(hashtext('relatienummer:' || v_uid::text));
  if not exists (select 1 from public.relaties where id = p_relatie and user_id = v_uid and deleted_at is null) then
    raise exception 'Relatie niet gevonden';
  end if;
  if p_soort = 'debiteur' then
    select debiteurnr into n from public.relaties where id = p_relatie;
    if n is null then
      select greatest(coalesce(max(debiteurnr), 9999), 9999) + 1 into n from public.relaties where user_id = v_uid;
      update public.relaties set debiteurnr = n where id = p_relatie;
    end if;
  else
    select crediteurnr into n from public.relaties where id = p_relatie;
    if n is null then
      select greatest(coalesce(max(crediteurnr), 19999), 19999) + 1 into n from public.relaties where user_id = v_uid;
      update public.relaties set crediteurnr = n where id = p_relatie;
    end if;
  end if;
  return n;
end $$;
revoke all on function public.geef_relatienummer(uuid, text) from public, anon;
grant execute on function public.geef_relatienummer(uuid, text) to authenticated;
