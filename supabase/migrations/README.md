# Supabase — schema & RLS van het kassa-project (`qdhnwhgfozdncgioeied`)

**Bevinding K1 uit de code-review:** de RLS-policies en het schema van dit
Supabase-project stonden nergens in versiebeheer. Het hele saldo- en
betaalmodel van de kassa-app leunt op die policies (`db.js` zet de publieke
anon-key in de client en doet daarna `supa.from('leden'|'betalingen'|…).upsert`).
Zonder de policies in git is niet te controleren of dat veilig is.

## Eenmalig: huidige staat exporteren en committen

Met de Supabase CLI (aanbevolen):

```bash
supabase login
supabase link --project-ref qdhnwhgfozdncgioeied
supabase db dump --schema public          > supabase/schema.sql
supabase db dump --schema public --data-only --table 'auth.*' > /dev/null  # niet nodig
```

Of puur de policies, via `psql` op de connection string uit het dashboard
(Project Settings → Database → Connection string, "URI"):

```bash
psql "$SUPABASE_DB_URL" -Atc "
  select '-- ' || schemaname||'.'||tablename||E'\n'||
         'CREATE POLICY '||quote_ident(policyname)||' ON '||schemaname||'.'||tablename||
         ' AS '||(case when permissive='PERMISSIVE' then 'PERMISSIVE' else 'RESTRICTIVE' end)||
         ' FOR '||cmd||' TO '||array_to_string(roles,', ')||
         coalesce(' USING ('||qual||')','')||
         coalesce(' WITH CHECK ('||with_check||')','')||';'
  from pg_policies where schemaname='public' order by tablename, policyname;
" > supabase/rls-policies.sql
```

Commit `supabase/schema.sql` en `supabase/rls-policies.sql`. Herhaal na elke
policy-wijziging (ook de twee migraties hiernaast).

## Daarna: verifieer het dreigingsmodel (K1b)

- `anon` heeft nu geen policy op de bedrijfstabellen → kan niets lezen/schrijven. Goed.
- `authenticated` heeft overal `FOR ALL USING(true) WITH CHECK(true)` → één
  geactiveerde tablet = volledig lezen/schrijven/verwijderen op álle PII en
  betaalhistorie. Dit is de grote openstaande post: schrijfacties horen achter
  Edge Functions met server-side autorisatie, of per-rij/per-plek gescoped.
  Plan dit samen met de samenvoeging met de Next-app (`KASSA_INTEGRATIE.md`).
