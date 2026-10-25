-- Terugzetten van een cloud-back-up (functie herstel_cloud_backup), alles-of-niets in één transactie.
-- Stappen: 1) eerst een veiligheidskopie van de huidige stand (handmatig), 2) boekingen, loten, voorraadartikelen,
-- relaties en app_data van deze gebruiker vervangen door de inhoud van de gekozen back-up, 3) aantallen controleren.
-- Gaat er iets mis, dan wordt alles teruggedraaid. Bonnetjes (bijlagen) worden bewust NIET aangeraakt.
create or replace function public.herstel_cloud_backup(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v jsonb;
  v_veilig bigint;
  n_b int; n_l int; n_v int; n_r int; n_a int;
  g_b int; g_l int; g_v int; g_r int; g_a int;
begin
  if v_uid is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  select inhoud into v from public.cloud_backups where id = p_id and user_id = v_uid;
  if v is null then raise exception 'Back-up niet gevonden'; end if;
  if jsonb_typeof(v->'boekingen') <> 'array' or jsonb_typeof(v->'app_data') <> 'array'
     or jsonb_typeof(v->'hnvi_loten') <> 'array' or jsonb_typeof(v->'voorraadartikelen') <> 'array' or jsonb_typeof(v->'relaties') <> 'array' then
    raise exception 'Deze back-up heeft een onverwachte opbouw';
  end if;
  g_b := jsonb_array_length(v->'boekingen'); g_l := jsonb_array_length(v->'hnvi_loten');
  g_v := jsonb_array_length(v->'voorraadartikelen'); g_r := jsonb_array_length(v->'relaties'); g_a := jsonb_array_length(v->'app_data');
  if g_b = 0 then raise exception 'Deze back-up bevat geen boekingen; terugzetten is geweigerd'; end if;

  -- 1) veiligheidskopie van nu
  v_veilig := public.maak_cloud_backup_voor(v_uid, 'handmatig');

  -- 2) vervangen
  delete from public.boekingen where user_id = v_uid;
  insert into public.boekingen select * from jsonb_populate_recordset(null::public.boekingen,
    (select coalesce(jsonb_agg(e || jsonb_build_object('user_id', v_uid)), '[]'::jsonb) from jsonb_array_elements(v->'boekingen') e));
  delete from public.hnvi_loten where user_id = v_uid;
  insert into public.hnvi_loten select * from jsonb_populate_recordset(null::public.hnvi_loten,
    (select coalesce(jsonb_agg(e || jsonb_build_object('user_id', v_uid)), '[]'::jsonb) from jsonb_array_elements(v->'hnvi_loten') e));
  delete from public.voorraadartikelen where user_id = v_uid;
  insert into public.voorraadartikelen select * from jsonb_populate_recordset(null::public.voorraadartikelen,
    (select coalesce(jsonb_agg(e || jsonb_build_object('user_id', v_uid)), '[]'::jsonb) from jsonb_array_elements(v->'voorraadartikelen') e));
  delete from public.relaties where user_id = v_uid;
  insert into public.relaties select * from jsonb_populate_recordset(null::public.relaties,
    (select coalesce(jsonb_agg(e || jsonb_build_object('user_id', v_uid)), '[]'::jsonb) from jsonb_array_elements(v->'relaties') e));
  delete from public.app_data where user_id = v_uid;
  insert into public.app_data (user_id, sleutel, waarde)
    select v_uid, e->>'sleutel', e->'waarde' from jsonb_array_elements(v->'app_data') e;

  -- 3) controle
  select count(*) into n_b from public.boekingen where user_id = v_uid;
  select count(*) into n_l from public.hnvi_loten where user_id = v_uid;
  select count(*) into n_v from public.voorraadartikelen where user_id = v_uid;
  select count(*) into n_r from public.relaties where user_id = v_uid;
  select count(*) into n_a from public.app_data where user_id = v_uid;
  if (n_b, n_l, n_v, n_r, n_a) is distinct from (g_b, g_l, g_v, g_r, g_a) then
    raise exception 'Aantallen kloppen niet na het terugzetten; alles is teruggedraaid';
  end if;
  return jsonb_build_object('boekingen', n_b, 'hnvi_loten', n_l, 'voorraadartikelen', n_v, 'relaties', n_r, 'app_data', n_a, 'veiligheidskopie', v_veilig);
end $$;
revoke all on function public.herstel_cloud_backup(bigint) from public, anon;
grant execute on function public.herstel_cloud_backup(bigint) to authenticated;
