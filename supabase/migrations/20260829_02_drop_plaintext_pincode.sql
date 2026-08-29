-- K17 — legacy plaintext pincode-kolom op `leden`.
--
-- `leden` heeft naast `pincode_hash` nog een oude `pincode`-kolom; een paar
-- rijen bevatten een plaintext-ogende waarde. Die is leesbaar voor elke
-- geactiveerde tablet (authenticated heeft SELECT op leden).
--
-- De kassa-client raakt deze kolom niet meer aan:
--   * db.js `LEDEN_KOLOMMEN` haalt 'm niet op;
--   * syncWachtrij() en upsertLid() strippen `pincode`/`pincode_hash` vóór elke upsert;
--   * de pincode-check loopt via de Edge Function `controleer-pin`, instellen via `stel-pin`.
--
-- VOORWAARDE VOOR UITVOEREN: controleer eerst in de Supabase-dashboard
-- (Edge Functions → controleer-pin en stel-pin) dat die functies UITSLUITEND
-- `pincode_hash` gebruiken en nergens de kolom `pincode` lezen of schrijven.
-- Zodra dat bevestigd is:

-- 1. Waardes wissen (voor het geval de drop wordt uitgesteld).
update public.leden set pincode = null where pincode is not null;

-- 2. Kolom verwijderen.
alter table public.leden drop column if exists pincode;

-- Controle:
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='leden' and column_name='pincode';  -- 0 rijen
