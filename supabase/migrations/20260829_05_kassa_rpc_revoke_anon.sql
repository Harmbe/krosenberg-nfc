-- Vervolg op 20260829_04. Bij het toepassen bleek dat Supabase `anon`
-- standaard EXECUTE geeft op nieuwe functies in het `public`-schema — het
-- `revoke ... from public` in migratie 04 haalde die expliciete anon-grant
-- NIET weg. De drie kassa-RPC's zijn SECURITY DEFINER (bypassen RLS): met een
-- anon-grant kon iedereen met de publieke anon-key `kassa_reken_af` aanroepen
-- en zo een openstaande tab op nul zetten zonder betaling.
--
-- Toegepast op productie qdhnwhgfozdncgioeied op 2026-08-29.
-- Controle: select proname, proacl from pg_proc where proname like 'kassa\_%';
--   → alleen {authenticated, service_role} (RPC's) resp. {service_role} (helper).

revoke execute on function public.kassa_boek_consumptie(uuid, text, jsonb, timestamptz) from anon;
revoke execute on function public.kassa_reken_af(uuid, text, text, timestamptz)         from anon;
revoke execute on function public.kassa_vul_voorraad_aan(uuid, uuid, int, text)          from anon;
revoke execute on function public.kassa_herbereken_openstaand(text) from public, anon, authenticated;
