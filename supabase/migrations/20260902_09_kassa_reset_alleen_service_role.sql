-- Ketentest-bevinding F10: kassa_reset_transacties() had EXECUTE voor
-- `authenticated`. Elke geactiveerde tablet (of een gelekte device-sleutel)
-- kon daarmee via /rest/v1/rpc/kassa_reset_transacties alle omzet wissen en
-- alle saldi op 0 zetten — de beheerder-PIN zat alleen in de UI.
--
-- EXECUTE nu alleen voor service_role. De "schone lijst" loopt voortaan via
-- /api/kassa/reset in de reserveringen-app (achter beheer-auth), die de RPC
-- met de service-role-sleutel aanroept. Geen enkele tablet kan de functie nog
-- rechtstreeks aanroepen.
--
-- Nog toe te passen op DB qdhnwhgfozdncgioeied.
-- Controle: select proacl from pg_proc where proname = 'kassa_reset_transacties';
--   → geen `authenticated=X`, wel `service_role=X`.

revoke execute on function public.kassa_reset_transacties(text, boolean) from authenticated;
