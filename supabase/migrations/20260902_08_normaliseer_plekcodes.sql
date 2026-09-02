-- Ketentest-bevinding F16: plekcodes in de kassa-DB staan in wisselende
-- notaties ("GV 1" met spatie, "GV1" zonder, "hv3" klein). De reserveringen-DB
-- gebruikt consequent hoofdletters zonder spaties ("GV1", "HV3", "B1"). De
-- kantine-saldo-koppeling matcht op plekcode, dus een formatverschil verbreekt
-- de koppeling tussen een boeking en het kassabandje.
--
-- Eén canonieke notatie afdwingen: upper(), spaties eruit. De tombstone-waarde
-- "~vertrokken-<plek>" (leden.plek van een vertrokken lid) blijft ongemoeid.
--
-- Toegepast op DB qdhnwhgfozdncgioeied op 2026-09-03 (via Supabase MCP
-- apply_migration, naam "normaliseer_plekcodes" in de migratielog).
-- Bij toepassing was alleen "GV 1" nog niet-canoniek (in leden + plekken).
--
-- LET OP — de not-exists-guards hierboven laten een dubbele rij staan als de
-- canonieke code al als aparte rij bestaat. Dat was het geval voor "GV 1":
-- naast "GV 1" bestond al "GV1" (plek + placeholder-gastaccount PLEK-GV1).
-- De "GV 1"-rijen (plek + account PLEK-GV 1) waren lege placeholders (naam "—",
-- saldo 0, geen bandje/consumptie/betaling) en zijn daarom handmatig verwijderd:
--   delete from public.leden   where uid = 'PLEK-GV 1';
--   delete from public.plekken where plek_code = 'GV 1';
-- Na afloop: GV-plekken = GV1..GV6, geen spaties/kleine letters meer.
-- Controle achteraf uitgevoerd: kassa_boek_consumptie + kassa_reken_af werken,
-- leden.openstaand wordt via de triggers nog correct bijgewerkt.
--
-- Controle vooraf: select plek from public.leden where plek <> upper(regexp_replace(plek,'\s+','','g')) and plek !~ '^~';

-- helper: canonieke schrijfwijze
create or replace function public.__norm_plek(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g'))
$$;

-- leden.plek — alleen echte plekcodes, niet de "~vertrokken-"-tombstones
update public.leden l
   set plek = public.__norm_plek(l.plek)
 where l.plek !~ '^~'
   and l.plek <> public.__norm_plek(l.plek)
   and not exists (
     select 1 from public.leden x
      where x.plek = public.__norm_plek(l.plek) and x.uid <> l.uid
   );

-- plekken.plek_code (primary key) — sla over als de genormaliseerde code al bestaat
update public.plekken p
   set plek_code = public.__norm_plek(p.plek_code)
 where p.plek_code <> public.__norm_plek(p.plek_code)
   and not exists (
     select 1 from public.plekken x where x.plek_code = public.__norm_plek(p.plek_code)
   );

-- bandjes.koppeling_id voor plek-koppelingen
update public.bandjes b
   set koppeling_id = public.__norm_plek(b.koppeling_id)
 where b.koppeling_type = 'plek'
   and b.koppeling_id <> public.__norm_plek(b.koppeling_id);

-- historische labels op geldrijen meenormaliseren (puur cosmetisch, matcht niet)
update public.betalingen set plek = public.__norm_plek(plek)
 where plek is not null and plek !~ '^~' and plek <> public.__norm_plek(plek);

drop function public.__norm_plek(text);

-- Controle achteraf: select distinct plek from public.leden order by 1;
--   → alleen "GV1", "HV3", "B1", "51" … (geen spaties, geen kleine letters)
