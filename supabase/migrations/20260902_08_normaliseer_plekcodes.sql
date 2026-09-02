-- Ketentest-bevinding F16: plekcodes in de kassa-DB staan in wisselende
-- notaties ("GV 1" met spatie, "GV1" zonder, "hv3" klein). De reserveringen-DB
-- gebruikt consequent hoofdletters zonder spaties ("GV1", "HV3", "B1"). De
-- kantine-saldo-koppeling matcht op plekcode, dus een formatverschil verbreekt
-- de koppeling tussen een boeking en het kassabandje.
--
-- Eén canonieke notatie afdwingen: upper(), spaties eruit. De tombstone-waarde
-- "~vertrokken-<plek>" (leden.plek van een vertrokken lid) blijft ongemoeid.
--
-- Nog toe te passen op DB qdhnwhgfozdncgioeied.
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
