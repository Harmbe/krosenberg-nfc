-- ============================================================================
-- Kassa hardenen vóór livegang — server-autoritatieve schrijflaag
-- Supabase-project qdhnwhgfozdncgioeied. Voer uit in de SQL-editor.
-- ============================================================================
-- Adresseert uit de code-review:
--   K3  — contant/afrekenen was client-autoritatief (client bepaalde bedrag).
--   K5  — leden.openstaand werd met een hele-rij-upsert overschreven.
--   K1b — elke geactiveerde tablet had volledig schrijf/verwijder op alle
--         geld­tabellen (betalingen, consumptie_log, voorraad_log).
--   Codex 1/2 — idempotente, atomaire boeking (geen dubbele rijen bij retry).
--
-- Model: LOOPSALDO. openstaand = max(0, som(consumptie) - som(betalingen)).
-- Een trigger houdt het bij, ongeacht welke weg de rij binnenkomt (RPC vanaf
-- de tablet, of directe service-role-write vanuit de reserveringsapp).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. openstaand als afgeleide waarde (trigger)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.kassa_herbereken_openstaand(p_lid_uid text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bedrag numeric(10,2);
begin
  select greatest(0, round(
      coalesce((select sum(totaal)  from public.consumptie_log where lid_uid = p_lid_uid), 0)
    - coalesce((select sum(bedrag)  from public.betalingen    where lid_uid = p_lid_uid), 0)
  , 2))
  into v_bedrag;

  -- Transactie-lokale vlag zodat de kassa__leden_openstaand_afgeleid-trigger
  -- deze (legitieme) wijziging doorlaat.
  perform set_config('kassa.recompute', 'on', true);
  update public.leden
     set openstaand = v_bedrag
   where uid = p_lid_uid
     and openstaand is distinct from v_bedrag;

  return coalesce(v_bedrag, 0);
end;
$$;

-- openstaand is een afgeleide waarde. Niemand mag het rechtstreeks zetten —
-- alleen kassa_herbereken_openstaand() (herkenbaar aan de GUC hierboven).
-- Zo kan een gecompromitteerde tablet geen saldo op nul zetten, ook al houdt
-- die (voor het beheerscherm, Fase 4) nog schrijfrecht op de leden-rij.
create or replace function public.kassa__leden_openstaand_afgeleid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.openstaand := 0;  -- nieuw account start op 0; de trigger op
    return new;           -- consumptie_log/betalingen vult het daarna.
  end if;
  if new.openstaand is distinct from old.openstaand
     and coalesce(current_setting('kassa.recompute', true), '') <> 'on' then
    new.openstaand := old.openstaand;
  end if;
  return new;
end;
$$;

drop trigger if exists leden_openstaand_afgeleid on public.leden;
create trigger leden_openstaand_afgeleid
  before insert or update on public.leden
  for each row execute function public.kassa__leden_openstaand_afgeleid();

create or replace function public.kassa__tg_openstaand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'DELETE') then
    perform public.kassa_herbereken_openstaand(old.lid_uid);
    return old;
  end if;
  perform public.kassa_herbereken_openstaand(new.lid_uid);
  if (tg_op = 'UPDATE' and new.lid_uid is distinct from old.lid_uid) then
    perform public.kassa_herbereken_openstaand(old.lid_uid);
  end if;
  return new;
end;
$$;

drop trigger if exists consumptie_log_openstaand on public.consumptie_log;
create trigger consumptie_log_openstaand
  after insert or update or delete on public.consumptie_log
  for each row execute function public.kassa__tg_openstaand();

drop trigger if exists betalingen_openstaand on public.betalingen;
create trigger betalingen_openstaand
  after insert or update or delete on public.betalingen
  for each row execute function public.kassa__tg_openstaand();

-- Eenmalige herberekening van de bestaande stand.
select public.kassa_herbereken_openstaand(uid) from public.leden;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Schrijf-RPC's voor de tablet (SECURITY DEFINER, idempotent op een
--    client-aangeleverd id zodat een retry na een verbroken verbinding nooit
--    dubbel boekt).
-- ─────────────────────────────────────────────────────────────────────────────

-- Boekt één bestelling. p_items = [{"product_id":"<uuid>","aantal":<int>}, ...].
-- Prijs en naam komen uit producten — nooit van de client. Voorraad wordt
-- atomair afgeboekt.
create or replace function public.kassa_boek_consumptie(
  p_log_id  uuid,
  p_lid_uid text,
  p_items   jsonb,
  p_op      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_naam    text;
  v_lid     text;
  v_totaal  numeric(10,2) := 0;
  v_omschr  text := '';
  v_n       int := 0;
  v_item    jsonb;
  v_pid     uuid;
  v_aantal  int;
  v_pnaam   text;
  v_pprijs  numeric(10,2);
  v_pvrd    int;
begin
  -- Idempotent: bestaat deze bestelling al, geef 'm terug zonder iets te doen.
  if exists (select 1 from public.consumptie_log where id = p_log_id) then
    select lid_uid, totaal, omschrijving into v_lid, v_totaal, v_omschr
      from public.consumptie_log where id = p_log_id;
    return jsonb_build_object('log_id', p_log_id, 'totaal', v_totaal, 'omschrijving', v_omschr,
                              'openstaand', public.kassa_herbereken_openstaand(v_lid), 'nieuw', false);
  end if;

  select naam into v_naam from public.leden where uid = p_lid_uid;
  if v_naam is null then
    raise exception 'Onbekend kassa-account: %', p_lid_uid using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Geen artikelen opgegeven';
  end if;

  insert into public.consumptie_log (id, lid_uid, naam, omschrijving, totaal, geregistreerd_op)
  values (p_log_id, p_lid_uid, v_naam, '', 0, coalesce(p_op, now()));

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_pid    := (v_item->>'product_id')::uuid;
    v_aantal := (v_item->>'aantal')::int;
    if v_aantal is null or v_aantal <= 0 then
      raise exception 'Ongeldig aantal voor product %', v_pid;
    end if;

    select naam, prijs, voorraad into v_pnaam, v_pprijs, v_pvrd
      from public.producten where id = v_pid;
    if v_pnaam is null then
      raise exception 'Onbekend product: %', v_pid using errcode = 'P0002';
    end if;

    if v_pvrd is not null then
      update public.producten set voorraad = greatest(0, voorraad - v_aantal) where id = v_pid;
    end if;

    insert into public.consumptie_regels (log_id, product_naam, prijs, aantal)
    values (p_log_id, v_pnaam, v_pprijs, v_aantal);

    v_totaal := v_totaal + round(v_pprijs * v_aantal, 2);
    v_omschr := v_omschr || case when v_omschr = '' then '' else ', ' end || v_aantal || '× ' || v_pnaam;
    v_n := v_n + 1;
  end loop;

  update public.consumptie_log set omschrijving = v_omschr, totaal = v_totaal where id = p_log_id;

  return jsonb_build_object('log_id', p_log_id, 'totaal', v_totaal, 'omschrijving', v_omschr,
                            'openstaand', public.kassa_herbereken_openstaand(p_lid_uid), 'nieuw', true);
end;
$$;

-- Rekent de openstaande tab van één account af: berekent het bedrag zelf
-- (loopsaldo), schrijft een betalingen-rij. p_wijze: contant|qr|pin|intern.
create or replace function public.kassa_reken_af(
  p_betaling_id uuid,
  p_lid_uid     text,
  p_wijze       text default 'contant',
  p_op          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_naam   text;
  v_lid    text;
  v_plek   text;
  v_bedrag numeric(10,2);
begin
  -- Idempotent op p_betaling_id.
  if exists (select 1 from public.betalingen where id = p_betaling_id) then
    select lid_uid, bedrag into v_lid, v_bedrag from public.betalingen where id = p_betaling_id;
    return jsonb_build_object('betaling_id', p_betaling_id, 'bedrag', v_bedrag,
                              'openstaand', public.kassa_herbereken_openstaand(v_lid), 'nieuw', false);
  end if;

  if p_wijze not in ('contant','qr','pin','intern','contributie','verrekend') then
    raise exception 'Ongeldige betaalwijze: %', p_wijze;
  end if;

  select naam, plek into v_naam, v_plek from public.leden where uid = p_lid_uid;
  if v_naam is null then
    raise exception 'Onbekend kassa-account: %', p_lid_uid using errcode = 'P0002';
  end if;

  v_bedrag := greatest(0, round(
      coalesce((select sum(totaal) from public.consumptie_log where lid_uid = p_lid_uid), 0)
    - coalesce((select sum(bedrag) from public.betalingen    where lid_uid = p_lid_uid), 0)
  , 2));

  if v_bedrag <= 0 then
    return jsonb_build_object('betaling_id', null, 'bedrag', 0, 'openstaand', 0, 'nieuw', false);
  end if;

  insert into public.betalingen (id, lid_uid, naam, plek, bedrag, wijze, betaald_op)
  values (p_betaling_id, p_lid_uid, v_naam, v_plek, v_bedrag, p_wijze, coalesce(p_op, now()));

  return jsonb_build_object('betaling_id', p_betaling_id, 'bedrag', v_bedrag,
                            'openstaand', public.kassa_herbereken_openstaand(p_lid_uid), 'nieuw', true);
end;
$$;

-- Voorraad aanvullen (beheer → "voorraad aanvullen"). Idempotent op p_log_id.
create or replace function public.kassa_vul_voorraad_aan(
  p_log_id     uuid,
  p_product_id uuid,
  p_aantal     int,
  p_door       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_naam  text;
  v_nieuw int;
begin
  select product_naam, nieuwe_voorraad into v_naam, v_nieuw
    from public.voorraad_log where id = p_log_id;
  if found then
    return jsonb_build_object('product_id', p_product_id, 'nieuwe_voorraad', v_nieuw, 'nieuw', false);
  end if;

  if p_aantal is null or p_aantal = 0 then
    raise exception 'Ongeldig aantal';
  end if;

  update public.producten
     set voorraad = greatest(0, coalesce(voorraad, 0) + p_aantal)
   where id = p_product_id
  returning naam, voorraad into v_naam, v_nieuw;
  if v_naam is null then
    raise exception 'Onbekend product: %', p_product_id using errcode = 'P0002';
  end if;

  insert into public.voorraad_log (id, product_id, product_naam, aantal, nieuwe_voorraad, door, aangemaakt_op)
  values (p_log_id, p_product_id, v_naam, p_aantal, v_nieuw, p_door, now());

  return jsonb_build_object('product_id', p_product_id, 'nieuwe_voorraad', v_nieuw, 'nieuw', true);
end;
$$;

-- Alleen de tablet-rol (authenticated) en de server (service_role) mogen deze
-- aanroepen — niet anon/publiek.
revoke execute on function public.kassa_boek_consumptie(uuid, text, jsonb, timestamptz) from public;
revoke execute on function public.kassa_reken_af(uuid, text, text, timestamptz)         from public;
revoke execute on function public.kassa_vul_voorraad_aan(uuid, uuid, int, text)          from public;
grant  execute on function public.kassa_boek_consumptie(uuid, text, jsonb, timestamptz)  to authenticated, service_role;
grant  execute on function public.kassa_reken_af(uuid, text, text, timestamptz)          to authenticated, service_role;
grant  execute on function public.kassa_vul_voorraad_aan(uuid, uuid, int, text)          to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS: de geldtabellen worden lees-alleen voor een tablet. Schrijven kan
--    alleen nog via de RPC's hierboven (SECURITY DEFINER → bypasst RLS).
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['consumptie_log','consumptie_regels','betalingen','voorraad_log']
  loop
    execute format('drop policy if exists auth_only     on public.%I', t);
    execute format('drop policy if exists auth_select    on public.%I', t);
    execute format('create policy auth_select on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- leden/producten: rij-CRUD blijft voor `authenticated` (beheerscherm achter
-- pincode — Fase 4). `leden.openstaand` is via de trigger hierboven
-- read-only gemaakt; `producten.voorraad` wordt server-autoritatief bijgehouden
-- door de RPC's (de kassa-app stopt met client-side afboeken — zie branch B).

-- Controle:
--   select proname from pg_proc where proname like 'kassa\_%';
--   select relname, relrowsecurity from pg_class where relname in
--     ('consumptie_log','betalingen','voorraad_log');
--   select * from pg_policies where tablename in ('consumptie_log','betalingen');
