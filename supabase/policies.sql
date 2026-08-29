-- ============================================================================
-- Kassa-app — RLS-policies (Supabase-project qdhnwhgfozdncgioeied)
-- ============================================================================
-- Live-stand op 2026-08-29, na de code-review-hardening.
--
-- Rolmodel (bewust grofmazig, zie BEVEILIGING.md → K1b voor de openstaande
-- architectuurvraag):
--
--   anon           → GEEN policy op geen enkele tabel = geen toegang.
--                    De publieke anon-key (in db.js) kan dus niets lezen of
--                    schrijven. Alle anonieme functionaliteit loopt via Edge
--                    Functions met de service-role (controleer-pin, stel-pin,
--                    activeer-apparaat, haal-gastnaam, haal-boekingen,
--                    stuur-bon, stuur-overzicht).
--
--   authenticated  → GELDTABELLEN (consumptie_log, consumptie_regels,
--                    betalingen, voorraad_log) zijn LEES-ALLEEN. Schrijven kan
--                    alleen via de SECURITY DEFINER-RPC's kassa_boek_consumptie
--                    / kassa_reken_af / kassa_vul_voorraad_aan (zie
--                    migrations/20260829_04). `leden.openstaand` is via een
--                    trigger read-only. leden/producten/plekken/bandjes-
--                    rij-CRUD blijft toegestaan (beheerscherm achter pincode —
--                    Fase 4 sluit dat verder af).
--                    Zo'n sessie ontstaat ALLEEN via de Edge Function
--                    `activeer-apparaat` (device-activatiesleutel); intrekken =
--                    Supabase-sessie revoken (zie BEVEILIGING.md → K13).
--
--   service_role   → bypasst RLS. Gebruikt door de reserveringsapp
--                    (KASSA_SUPABASE_KEY) en door alle Edge Functions.
--
-- printer_instellingen is volledig dichtgezet (RLS aan, 0 policies) — de app
-- gebruikt de tabel niet meer. Zie migrations/20260829_01.
-- ============================================================================

alter table public.leden                  enable row level security;
alter table public.producten              enable row level security;
alter table public.consumptie_log         enable row level security;
alter table public.consumptie_regels      enable row level security;
alter table public.betalingen             enable row level security;
alter table public.plekken                enable row level security;
alter table public.bandjes                enable row level security;
alter table public.voorraad_log           enable row level security;
alter table public.categorie_instellingen enable row level security;
alter table public.printer_instellingen   enable row level security;

-- Rij-CRUD voor de tablet op de stamdata (Fase 4 sluit dit verder af).
do $$
declare
  t text;
  tabellen text[] := array[
    'leden','producten','plekken','bandjes','categorie_instellingen'
  ];
begin
  foreach t in array tabellen loop
    execute format('drop policy if exists auth_only on public.%I', t);
    execute format(
      'create policy auth_only on public.%I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;

-- Geldtabellen: LEES-ALLEEN voor de tablet. Schrijven via de RPC's
-- (migrations/20260829_04_kassa_schrijflaag.sql).
do $$
declare
  t text;
  tabellen text[] := array['consumptie_log','consumptie_regels','betalingen','voorraad_log'];
begin
  foreach t in array tabellen loop
    execute format('drop policy if exists auth_only  on public.%I', t);
    execute format('drop policy if exists auth_select on public.%I', t);
    execute format('create policy auth_select on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- printer_instellingen: bewust GEEN policy.
