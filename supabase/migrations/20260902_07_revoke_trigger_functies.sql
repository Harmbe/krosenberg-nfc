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
-- Toepassen op productie qdhnwhgfozdncgioeied.
-- Controle: select proname, proacl from pg_proc
--           where proname in ('kassa__tg_openstaand','kassa__leden_openstaand_afgeleid');
--   → proacl NULL of alleen {owner=X/owner} — geen anon/authenticated.
-- Verifieer daarna dat een consumptie boeken + afrekenen leden.openstaand nog
-- correct bijwerkt (de triggers draaien als owner).

revoke execute on function public.kassa__tg_openstaand()             from public, anon, authenticated;
revoke execute on function public.kassa__leden_openstaand_afgeleid() from public, anon, authenticated;
