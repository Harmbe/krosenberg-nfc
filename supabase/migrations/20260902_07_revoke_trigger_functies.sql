-- Security-linter 0028/0029 + ketentest-bevinding F12.
--
-- De trigger-functies public.kassa__tg_openstaand() en
-- public.kassa__leden_openstaand_afgeleid() zijn SECURITY DEFINER en hebben —
-- via de Supabase-default op nieuwe functies in het public-schema — EXECUTE
-- voor public/anon/authenticated. Daardoor zijn ze aanroepbaar als gewone RPC
-- via /rest/v1/rpc/...  De impact is beperkt (ze falen zonder trigger-context:
-- geen tg_op / NEW / OLD), maar het is onnodige aanvalsoppervlakte.
--
-- Trigger-functies worden door de trigger zelf als tabel-owner uitgevoerd, niet
-- via het EXECUTE-recht van de aanroeper — het intrekken raakt de triggers dus
-- niet.
--
-- Toegepast op productie qdhnwhgfozdncgioeied op 2026-09-02 (via Supabase MCP
-- apply_migration, naam "revoke_trigger_functies" in de migratielog).
-- Controle: select proname, proacl from pg_proc
--           where proname in ('kassa__tg_openstaand','kassa__leden_openstaand_afgeleid');
--   vóór: {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
--   ná:   {postgres=X/postgres, service_role=X/postgres} — geen PUBLIC/anon/authenticated meer.
-- Linter 0028/0029 voor deze twee functies verdwenen; consumptie boeken +
-- afrekenen werkt de leden.openstaand nog correct bij (triggers draaien als owner).

revoke execute on function public.kassa__tg_openstaand()             from public, anon, authenticated;
revoke execute on function public.kassa__leden_openstaand_afgeleid() from public, anon, authenticated;
