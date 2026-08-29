-- Supabase security-linter 0011 (function_search_path_mutable):
-- public.update_bijgewerkt_op had geen vaste search_path. De functie doet
-- alleen `new.bijgewerkt_op = now()` en heeft geen schema-resolutie nodig,
-- dus een lege/pg_catalog search_path is veilig en sluit search-path-
-- manipulatie uit.
--
-- Toegepast op productie qdhnwhgfozdncgioeied op 2026-08-29.

alter function public.update_bijgewerkt_op() set search_path = pg_catalog;
