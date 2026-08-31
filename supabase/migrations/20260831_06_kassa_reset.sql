-- ============================================================================
-- "Schone lijst" — alle transacties wissen, alle saldi op 0.
-- Voor het einde van de testperiode en de start van een nieuw seizoen (nadat
-- alle openstaande rekeningen van het vorige seizoen zijn voldaan).
-- Voer uit in de SQL-editor van het kassa-project (qdhnwhgfozdncgioeied).
-- ============================================================================

-- Kleine sleutel/waarde-tabel voor kassa-metadata (nu: het tijdstip van de
-- laatste reset, zodat elke tablet bij de eerstvolgende sync z'n lokale
-- transactiecache leegmaakt).
create table if not exists public.kassa_meta (
  sleutel       text primary key,
  waarde        text,
  bijgewerkt_op timestamptz not null default now()
);
alter table public.kassa_meta enable row level security;
drop policy if exists kassa_meta_select on public.kassa_meta;
create policy kassa_meta_select on public.kassa_meta for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- kassa_reset_transacties(p_bevestiging, p_ook_voorraad)
--   * p_bevestiging moet exact 'RESET' zijn (bescherming tegen misklikken)
--   * maakt eerst een back-up in schema kassa_backup (undo-pad)
--   * wist consumptie_regels / consumptie_log / betalingen  (+ voorraad_log
--     als p_ook_voorraad = true)
--   * herberekent alle leden.openstaand (worden 0)
--   * zet kassa_meta.laatste_reset zodat de tablets hun lokale cache legen
-- ----------------------------------------------------------------------------
create or replace function public.kassa_reset_transacties(
  p_bevestiging  text,
  p_ook_voorraad boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stamp text := to_char(now() at time zone 'Europe/Amsterdam', 'YYYYMMDD_HH24MI');
  v_bet int; v_log int; v_reg int; v_vrd int := 0;
begin
  if p_bevestiging is distinct from 'RESET' then
    raise exception 'Bevestiging ontbreekt — verwacht exact: RESET';
  end if;

  select count(*) into v_reg from public.consumptie_regels;
  select count(*) into v_log from public.consumptie_log;
  select count(*) into v_bet from public.betalingen;
  if p_ook_voorraad then select count(*) into v_vrd from public.voorraad_log; end if;

  -- Back-up (blijft staan tot je 'm zelf verwijdert).
  execute 'create schema if not exists kassa_backup';
  execute format('create table kassa_backup.betalingen_%s       as select * from public.betalingen',       v_stamp);
  execute format('create table kassa_backup.consumptie_log_%s   as select * from public.consumptie_log',   v_stamp);
  execute format('create table kassa_backup.consumptie_regels_%s as select * from public.consumptie_regels', v_stamp);
  execute format('create table kassa_backup.leden_saldo_%s      as select uid, naam, openstaand from public.leden', v_stamp);
  if p_ook_voorraad then
    execute format('create table kassa_backup.voorraad_log_%s   as select * from public.voorraad_log',     v_stamp);
  end if;

  -- Wissen. TRUNCATE (i.p.v. DELETE) → geen per-rij-trigger, geen timeout op
  -- een groot seizoen; cascade dekt consumptie_regels via de FK.
  truncate table public.consumptie_log, public.consumptie_regels, public.betalingen;
  if p_ook_voorraad then truncate table public.voorraad_log; end if;

  -- Alle saldi herberekenen (0, want geen consumptie/betaling meer).
  perform public.kassa_herbereken_openstaand(uid) from public.leden;

  -- Markeer de reset zodat de tablets hun lokale transactiecache legen.
  insert into public.kassa_meta (sleutel, waarde, bijgewerkt_op)
  values ('laatste_reset', v_stamp, now())
  on conflict (sleutel) do update set waarde = excluded.waarde, bijgewerkt_op = now();

  return jsonb_build_object(
    'backup', 'kassa_backup.*_' || v_stamp,
    'verwijderd', jsonb_build_object(
      'betalingen', v_bet, 'consumpties', v_log, 'regels', v_reg, 'voorraad_log', v_vrd
    )
  );
end;
$$;

revoke execute on function public.kassa_reset_transacties(text, boolean) from public, anon;
grant  execute on function public.kassa_reset_transacties(text, boolean) to authenticated, service_role;

-- Herstel (alleen handmatig, bewust): vervang <suffix> door de back-up-datum.
--   truncate public.consumptie_log, public.consumptie_regels, public.betalingen;
--   insert into public.betalingen        select * from kassa_backup.betalingen_<suffix>;
--   insert into public.consumptie_log    select * from kassa_backup.consumptie_log_<suffix>;
--   insert into public.consumptie_regels select * from kassa_backup.consumptie_regels_<suffix>;
--   perform public.kassa_herbereken_openstaand(uid) from public.leden;
