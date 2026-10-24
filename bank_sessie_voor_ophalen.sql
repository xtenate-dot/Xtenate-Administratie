-- Geeft de eigenaar (via de Edge Function) toegang tot de sessiegegevens van de EIGEN koppeling,
-- zonder de kolommen zelf leesbaar te maken. Zonder de Enable Banking-sleutel (alleen in de
-- Edge Function) is session_id/account_uid niet bruikbaar.
create or replace function public.bank_sessie_voor_ophalen(p_id uuid)
returns table (session_id text, account_uid text, geldig_tot timestamptz, iban text)
language sql security definer set search_path = public, pg_temp as $$
  select k.session_id, k.account_uid, k.geldig_tot, k.iban
  from public.bank_koppelingen k
  where k.id = p_id and k.user_id = auth.uid();
$$;
revoke all on function public.bank_sessie_voor_ophalen(uuid) from public, anon;
grant execute on function public.bank_sessie_voor_ophalen(uuid) to authenticated;
