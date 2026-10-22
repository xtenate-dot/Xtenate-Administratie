-- Uitvoeren in Supabase (SQL editor). Voegt de kolommen toe die de app al probeert te gebruiken.
alter table hnvi_loten add column if not exists factuur text;
alter table hnvi_loten add column if not exists verkoopdatum date;
