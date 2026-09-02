-- Ketentest-bevinding F18: twee vrijwel gelijktijdige kassa_reken_af-aanroepen
-- met verschillende p_betaling_id voor hetzelfde lid berekenen allebei
-- som(consumptie) − som(betalingen) vóór een van beide een betalingsrij
-- schrijft → beide boeken het volledige openstaande bedrag, het lid betaalt
-- dubbel (openstaand wordt via greatest(0, …) alsnog 0, dus het verschil
-- verdwijnt uit beeld).
--
-- Fix: een rij-lock op de leden-rij (SELECT … FOR UPDATE) aan het begin. De
-- tweede aanroep blokkeert tot de eerste commit, herberekent daarna v_bedrag
-- (ziet nu de eerste betaling) en krijgt 0 → geeft betaling_id = null terug
-- zonder een tweede rij te schrijven.
--
-- Verder identiek aan de definitie in migratie 04. CREATE OR REPLACE behoudt
-- de bestaande EXECUTE-rechten (anon ingetrokken in migratie 05).
--
-- Nog toe te passen op DB qdhnwhgfozdncgioeied.

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

  -- Rij-lock: serialiseert gelijktijdige afrekeningen van hetzelfde account,
  -- zodat het bedrag hieronder nooit tweemaal het volle saldo oplevert (F18).
  select naam, plek into v_naam, v_plek from public.leden where uid = p_lid_uid for update;
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
