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
--   authenticated  → volledige lees/schrijf/verwijder op de bedrijfstabellen.
--                    Zo'n sessie ontstaat ALLEEN via de Edge Function
--                    `activeer-apparaat` (device-activatiesleutel). Eén
--                    geactiveerde tablet = volledige DB-toegang; intrekken =
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

do $$
declare
  t text;
  tabellen text[] := array[
    'leden','producten','consumptie_log','consumptie_regels','betalingen',
    'plekken','bandjes','voorraad_log','categorie_instellingen'
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

-- printer_instellingen: bewust GEEN policy.
