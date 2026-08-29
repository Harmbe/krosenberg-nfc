-- ============================================================================
-- Kassa-app — databaseschema (Supabase-project qdhnwhgfozdncgioeied)
-- ============================================================================
-- Gereconstrueerd uit de live-database op 2026-08-29 (K1 uit de code-review:
-- schema hoort in versiebeheer). Bijwerken bij elke schemawijziging — of
-- vervangen door `supabase db dump` zodra de Supabase-CLI aan dit project
-- gekoppeld is.
--
-- RLS-policies staan in policies.sql. Losse wijzigingen sinds deze dump staan
-- als genummerde bestanden in migrations/.
-- ============================================================================

-- ── leden ──────────────────────────────────────────────────────────────────
-- Eén doorlopende kantinerekening per plek (niet per gast). `type`:
-- gast | lid | intern. `pincode_hash` = bcrypt (Edge Function stel-pin).
-- `heeft_pincode` is generated — nooit zelf meesturen bij een upsert.
create table if not exists public.leden (
  uid                   text primary key,
  naam                  text not null,
  plek                  text not null,
  openstaand            numeric(10,2) not null default 0,
  beheerder             boolean not null default false,
  aangemaakt_op         timestamptz not null default now(),
  bijgewerkt_op         timestamptz not null default now(),
  type                  text default 'lid',
  email                 text,
  pincode_hash          text,
  heeft_pincode         boolean generated always as (pincode_hash is not null) stored,
  reserveringen_lid_id  text
);
create index if not exists idx_leden_reserveringen_lid_id
  on public.leden (reserveringen_lid_id);

-- ── producten ──────────────────────────────────────────────────────────────
create table if not exists public.producten (
  id                   uuid primary key default gen_random_uuid(),
  naam                 text not null,
  prijs                numeric(10,2) not null,
  emoji                text not null default '🛒',
  categorie            text not null default 'drank',
  omschr               text,
  voorraad             integer,
  laag_waarschuwing    integer,
  actief               boolean not null default true,
  aangemaakt_op        timestamptz not null default now(),
  bijgewerkt_op        timestamptz not null default now(),
  volgorde             integer default 0,
  inkoopeenheid        text,
  eenheden_per_inkoop  integer
);

-- ── consumptie_log + consumptie_regels ─────────────────────────────────────
create table if not exists public.consumptie_log (
  id                uuid primary key default gen_random_uuid(),
  lid_uid           text not null references public.leden(uid),
  omschrijving      text not null,
  totaal            numeric(10,2) not null,
  geregistreerd_op  timestamptz not null default now(),
  naam              text
);

create table if not exists public.consumptie_regels (
  id            uuid primary key default gen_random_uuid(),
  log_id        uuid not null references public.consumptie_log(id) on delete cascade,
  product_naam  text not null,
  prijs         numeric(10,2) not null,
  aantal        integer not null
);

-- ── betalingen ─────────────────────────────────────────────────────────────
create table if not exists public.betalingen (
  id          uuid primary key default gen_random_uuid(),
  lid_uid     text not null references public.leden(uid),
  naam        text not null,
  plek        text not null,
  bedrag      numeric(10,2) not null,
  wijze       text not null default 'contant',
  betaald_op  timestamptz not null default now()
);

-- ── plekken + bandjes ──────────────────────────────────────────────────────
create table if not exists public.plekken (
  plek_code   text primary key,
  bandje_uid  text unique
);

create table if not exists public.bandjes (
  bandje_uid     text primary key,
  koppeling_type text not null check (koppeling_type in ('plek','lid')),
  koppeling_id   text not null,
  aangemaakt_op  timestamptz default now()
);

-- ── voorraad_log ───────────────────────────────────────────────────────────
create table if not exists public.voorraad_log (
  id               uuid primary key,
  product_id       uuid,
  product_naam     text,
  aantal           integer not null,
  nieuwe_voorraad  integer not null,
  door             text,
  aangemaakt_op    timestamptz not null default now(),
  inkoop_aantal    integer,
  inkoop_eenheid   text
);

-- ── categorie_instellingen ─────────────────────────────────────────────────
-- Bon-instellingen per artikelcategorie (welke velden op de keukenbon).
create table if not exists public.categorie_instellingen (
  categorie     text primary key,
  print_actief  boolean not null default false,
  toon_naam     boolean not null default true,
  toon_plek     boolean not null default true,
  toon_tijd     boolean not null default true,
  toon_prijs    boolean not null default true
);

-- ── printer_instellingen ───────────────────────────────────────────────────
-- LET OP: sinds de code-review (2026-08-29) schrijft de kassa-app deze tabel
-- NIET meer naar Supabase — printer-URL/-sleutel blijven lokaal per tablet
-- (localStorage). De tabel is via RLS volledig dichtgezet (zie policies.sql /
-- migrations/20260829_01). Alleen behouden voor historie.
create table if not exists public.printer_instellingen (
  id               text primary key,
  printer_url      text,
  printer_sleutel  text,
  bijgewerkt_op    timestamptz default now()
);

-- ── trigger: bijgewerkt_op automatisch bijhouden ───────────────────────────
create or replace function public.update_bijgewerkt_op()
  returns trigger
  language plpgsql
  set search_path = pg_catalog   -- vaste search_path (Supabase security-linter 0011)
as $$
begin new.bijgewerkt_op = now(); return new; end;
$$;

drop trigger if exists leden_bijgewerkt on public.leden;
create trigger leden_bijgewerkt before update on public.leden
  for each row execute function public.update_bijgewerkt_op();

drop trigger if exists producten_bijgewerkt on public.producten;
create trigger producten_bijgewerkt before update on public.producten
  for each row execute function public.update_bijgewerkt_op();
