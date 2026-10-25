-- Bol: elke nacht de laatste 7 dagen bestellingen ophalen (nieuwe, verzonden, geannuleerde).
-- Gebruikt dezelfde geheim-tabel als de bank-dagronde (bank_cron_geheim).
select cron.schedule('bol-nachtronde', '15 3 * * *', $$
  select net.http_post(
    url := 'https://wmnqtukxwzbzmkmxdxrt.supabase.co/functions/v1/bol-koppeling/dagelijks',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select geheim from public.bank_cron_geheim where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000) $$);
