-- K1a — printer_instellingen was wereld-schrijfbaar.
--
-- De policy stond op rol `public` (incl. anon) met FOR ALL USING(true)
-- WITH CHECK(true). Iedereen met de publieke anon-key kon de printer-URL en
-- printer-sleutel uitlezen én overschrijven — bonnen omleiden naar een eigen
-- server, de kassalade-trigger stelen, of printen platleggen.
--
-- De kassa-app schrijft deze tabel sinds de bijbehorende code-wijziging
-- helemaal niet meer naar Supabase (printerinstellingen blijven lokaal per
-- tablet). Deze tabel hoeft dus voor niemand meer toegankelijk te zijn via
-- de anon- of tablet-rol. We draaien 'm helemaal dicht; laat de tabel zelf
-- staan voor historie.
--
-- Uitvoeren in de Supabase SQL-editor van project qdhnwhgfozdncgioeied.

alter table public.printer_instellingen enable row level security;

-- Alle bestaande policies op deze tabel weghalen (naam-agnostisch).
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'printer_instellingen'
  loop
    execute format('drop policy %I on public.printer_instellingen', pol.policyname);
  end loop;
end $$;

-- Geen enkele nieuwe policy → met RLS aan betekent dat: anon en authenticated
-- kunnen niets. Alleen de service-role (RLS-bypass) komt er nog bij, wat
-- prima is voor eventueel toekomstig serverbeheer.

-- Controle:
--   select * from pg_policies where tablename = 'printer_instellingen';   -- 0 rijen
--   select relrowsecurity from pg_class where relname = 'printer_instellingen';  -- t
