-- Logboek van belangrijke wijzigingen, veilig bewaard in de cloud.
--
-- Eigenschappen:
--  * Alleen toevoegen: de app (en elke ingelogde gebruiker) kan regels lezen en toevoegen, niet wijzigen of wissen.
--  * Ook rechtstreeks in de database kan een regel niet ongemerkt worden aangepast: een trigger weigert wijzigen,
--    wissen en leegmaken, en elke regel bevat een hash van de vorige regel (een ketting). Wie toch iets verandert
--    (bijvoorbeeld door de trigger uit te zetten), breekt de ketting; de functie logboek_controle() toont dat.
--  * Tijdstip, gebruiker en hash worden door de database gezet, niet door de app, zodat ze niet te vervalsen zijn.
--  * Per gebruiker afgeschermd (RLS), zoals de andere tabellen.
--
-- Uitvoeren: plak dit bestand één keer in de Supabase SQL-editor. Het is veilig om het opnieuw uit te voeren.
-- De app blijft werken zonder deze tabel; het logboek staat dan alleen in de browser.

create table if not exists public.logboek (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  client_id text not null,                          -- door de app gemaakt; voorkomt dubbele regels bij opnieuw proberen
  tijd timestamptz not null default clock_timestamp(),
  soort text not null,                              -- boeking, hnvi, cover, instelling, herstelpunt, ...
  actie text not null check (actie in ('create', 'update', 'delete')),
  tekst text not null,                              -- korte omschrijving, bijvoorbeeld "Albert Heijn · €12,40 · 2026-11-02"
  na jsonb,                                         -- de opgeslagen gegevens (bij verwijderen leeg)
  apparaat text,                                    -- welke browser/computer
  vorige_hash text,
  hash text not null,
  unique (user_id, client_id)
);
create index if not exists logboek_user_id on public.logboek (user_id, id desc);

alter table public.logboek enable row level security;
revoke all on public.logboek from public, anon, authenticated;
grant select, insert on public.logboek to authenticated;
drop policy if exists "logboek lezen eigen" on public.logboek;
drop policy if exists "logboek toevoegen eigen" on public.logboek;
create policy "logboek lezen eigen" on public.logboek for select to authenticated using (user_id = auth.uid());
create policy "logboek toevoegen eigen" on public.logboek for insert to authenticated with check (user_id = auth.uid());

-- De hash van een regel: de vorige hash plus de inhoud van deze regel.
create or replace function public.logboek_hash(p_vorige text, p_tijd timestamptz, p_soort text, p_actie text, p_tekst text, p_na jsonb, p_user uuid)
returns text language sql immutable as $$
  select encode(sha256(convert_to(
    coalesce(p_vorige, '') || '|' || p_user::text || '|' ||
    to_char(p_tijd at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    p_soort || '|' || p_actie || '|' || p_tekst || '|' || coalesce(p_na::text, ''), 'UTF8')), 'hex');
$$;

-- Bij toevoegen: gebruiker en tijd door de database laten bepalen en de ketting bijwerken.
create or replace function public.logboek_voor_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_vorige text;
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  new.tijd := clock_timestamp();
  -- Eén regel tegelijk per gebruiker, zodat twee apparaten de ketting niet kruisen.
  perform pg_advisory_xact_lock(hashtextextended('logboek:' || new.user_id::text, 0));
  select hash into v_vorige from public.logboek where user_id = new.user_id order by id desc limit 1;
  new.vorige_hash := v_vorige;
  new.hash := public.logboek_hash(v_vorige, new.tijd, new.soort, new.actie, new.tekst, new.na, new.user_id);
  return new;
end $$;
drop trigger if exists logboek_voor_insert on public.logboek;
create trigger logboek_voor_insert before insert on public.logboek for each row execute function public.logboek_voor_insert();

-- Wijzigen, wissen en leegmaken is niet toegestaan, voor niemand.
create or replace function public.logboek_niet_wijzigen() returns trigger language plpgsql as $$
begin
  raise exception 'Het logboek kan niet worden gewijzigd of gewist.' using errcode = '42501';
end $$;
drop trigger if exists logboek_niet_wijzigen on public.logboek;
create trigger logboek_niet_wijzigen before update or delete on public.logboek for each row execute function public.logboek_niet_wijzigen();
drop trigger if exists logboek_niet_leegmaken on public.logboek;
create trigger logboek_niet_leegmaken before truncate on public.logboek for each statement execute function public.logboek_niet_wijzigen();

-- Controle van de ketting voor de ingelogde gebruiker: { aantal, ok, eerste_fout_id }.
create or replace function public.logboek_controle() returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare r record; v_vorige text := null; v_aantal int := 0;
begin
  for r in select * from public.logboek where user_id = auth.uid() order by id loop
    v_aantal := v_aantal + 1;
    if r.vorige_hash is distinct from v_vorige
       or r.hash <> public.logboek_hash(r.vorige_hash, r.tijd, r.soort, r.actie, r.tekst, r.na, r.user_id) then
      return jsonb_build_object('aantal', v_aantal, 'ok', false, 'eerste_fout_id', r.id);
    end if;
    v_vorige := r.hash;
  end loop;
  return jsonb_build_object('aantal', v_aantal, 'ok', true, 'eerste_fout_id', null);
end $$;
revoke all on function public.logboek_controle() from public, anon;
grant execute on function public.logboek_controle() to authenticated;
