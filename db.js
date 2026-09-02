// ── Supabase + IndexedDB sync engine ──────────────────────────────────────────

const SUPABASE_URL = 'https://qdhnwhgfozdncgioeied.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaG53aGdmb3pkbmNnaW9laWVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NDY5NTIsImV4cCI6MjA5ODMyMjk1Mn0.IdUbivJZQIrrCDHjxEqunEu046TMFasbaUfZwZrRPfA';

// Velden die we ophalen voor leden — pincode en pincode_hash worden bewust
// weggelaten: de pincodecheck loopt via de controleer-pin Edge Function.
// type en email hoorden hier wél bij te staan: zonder die twee overschreef
// elke volledige sync (laadVanSupabase, bij elke herstart) het lokale
// type-veld met "leeg", waardoor alle type==='gast'-checks in de hele app
// (pincode-plicht, "Mijn pincode"-knop, geen-bandje-flow) stuk gingen zodra
// een apparaat opnieuw was opgestart ná de vorige sync.
const LEDEN_KOLOMMEN = 'uid,naam,plek,openstaand,beheerder,aangemaakt_op,bijgewerkt_op,heeft_pincode,type,email';

// ── IndexedDB via Dexie ────────────────────────────────────────────────────────
const db = new Dexie('KrosenbergNFC');
db.version(1).stores({
  leden:      'uid, plek, naam',
  producten:  'id, naam',
  log:        'id, lid_uid',
  betalingen: 'id, lid_uid',
  sync_queue: '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
});
db.version(2).stores({
  leden:      'uid, plek, naam',
  producten:  'id, naam',
  log:        'id, lid_uid',
  betalingen: 'id, lid_uid',
  sync_queue: '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
  plekken:    'plek_code, bandje_uid',
});
db.version(3).stores({
  leden:      'uid, plek, naam',
  producten:  'id, naam',
  log:        'id, lid_uid',
  betalingen: 'id, lid_uid',
  sync_queue: '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
  plekken:    'plek_code',
  bandjes:    'bandje_uid, koppeling_type, koppeling_id',
});
db.version(4).stores({
  leden:       'uid, plek, naam',
  producten:   'id, naam',
  log:         'id, lid_uid',
  betalingen:  'id, lid_uid',
  sync_queue:  '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
  plekken:     'plek_code',
  bandjes:     'bandje_uid, koppeling_type, koppeling_id',
  voorraad_log: 'id, product_id',
});
db.version(5).stores({
  leden:       'uid, plek, naam',
  producten:   'id, naam',
  log:         'id, lid_uid',
  betalingen:  'id, lid_uid',
  sync_queue:  '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
  plekken:     'plek_code',
  bandjes:     'bandje_uid, koppeling_type, koppeling_id',
  voorraad_log: 'id, product_id',
  categorie_instellingen: 'categorie',
});
db.version(6).stores({
  leden:       'uid, plek, naam',
  producten:   'id, naam',
  log:         'id, lid_uid',
  betalingen:  'id, lid_uid',
  sync_queue:  '++id, tabel, actie, [gesyncroniseerd+aangemaakt_op]',
  plekken:     'plek_code',
  bandjes:     'bandje_uid, koppeling_type, koppeling_id',
  voorraad_log: 'id, product_id',
  categorie_instellingen: 'categorie',
  printer_instellingen: 'id',
});

// ── Supabase client ────────────────────────────────────────────────────────────
const supa = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Apparaat-sessie ────────────────────────────────────────────────────────────
const _SESSIE_SLEUTEL = 'kr_kassa_tokens';

// Houd backup-tokens actueel zodra Supabase de access token automatisch ververst.
supa.auth.onAuthStateChange((event, session) => {
  if (session) {
    localStorage.setItem(_SESSIE_SLEUTEL, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }));
  } else if (event === 'SIGNED_OUT') {
    localStorage.removeItem(_SESSIE_SLEUTEL);
  }
});

async function initSessie() {
  let diagnose = '';
  let { data: { session }, error: getSessionFout } = await supa.auth.getSession();
  diagnose += `getSession(): ${session ? 'sessie gevonden' : 'geen sessie'}${getSessionFout ? ' — fout: ' + getSessionFout.message : ''}. `;

  // Supabase bewaart de sessie zelf, maar als backup ook eigen opslag proberen.
  if (!session) {
    const opgeslagen = localStorage.getItem(_SESSIE_SLEUTEL);
    diagnose += `backup-token: ${opgeslagen ? 'aanwezig' : 'ontbreekt'}. `;
    if (opgeslagen) {
      try {
        const tokens = JSON.parse(opgeslagen);
        const { data, error } = await supa.auth.setSession(tokens);
        if (!error && data.session) {
          session = data.session;
          diagnose += 'setSession() met backup gelukt.';
        } else {
          // Refresh token verlopen — backup wissen, opnieuw activeren vereist.
          diagnose += `setSession() met backup mislukt: ${error ? error.message : 'geen sessie teruggekregen'}.`;
          localStorage.removeItem(_SESSIE_SLEUTEL);
        }
      } catch (e) {
        diagnose += `backup-token onleesbaar: ${e.message}.`;
        localStorage.removeItem(_SESSIE_SLEUTEL);
      }
    }
  }

  if (session) return true;
  console.warn('[initSessie] geen geldige sessie:', diagnose);
  // Diagnose alleen als technische detail meegeven — niet als zichtbare tekst
  // (F31). Het setup-scherm heeft al een vaste uitleg.
  if (typeof toonSetupScherm === 'function') toonSetupScherm(null, diagnose);
  return false;
}

async function activeerApparaat(sleutel) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/activeer-apparaat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify({ sleutel }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || `HTTP ${res.status}`);
  }
  const { access_token, refresh_token } = await res.json();
  localStorage.setItem(_SESSIE_SLEUTEL, JSON.stringify({ access_token, refresh_token }));
  const { error } = await supa.auth.setSession({ access_token, refresh_token });
  if (error) throw new Error(error.message);
}

// Primaire sleutel per tabel — nodig omdat delete()-aanroepen niet zomaar op
// "id" mogen filteren: plekken/bandjes hebben een andere sleutelkolom, en een
// verkeerde kolomnaam laat een delete stilzwijgend niets raken.
const PRIMAIRE_SLEUTEL = { leden: 'uid', plekken: 'plek_code', bandjes: 'bandje_uid', producten: 'id' };

// ── Online status ──────────────────────────────────────────────────────────────
let isOnline = navigator.onLine;
window.addEventListener('online',  () => { isOnline = true;  updateStatusBadge(); syncWachtrij(); });
window.addEventListener('offline', () => { isOnline = false; updateStatusBadge(); });

function updateStatusBadge() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = isOnline ? '🟢 Online' : '🔴 Offline';
  el.style.color  = isOnline ? '#27ae60' : '#e74c3c';
}

// Vangnet naast de online/offline-events hierboven: die vuren niet altijd
// betrouwbaar (bv. na een wifi-herverbinding of korte hapering), waardoor
// isOnline voor onbepaalde tijd op "offline" kon blijven staan terwijl er
// allang weer verbinding was — met als gevolg dat nieuwe transacties
// permanent in de wachtrij bleven i.p.v. direct te worden weggeschreven.
// Elke 15 seconden isOnline verse aftoetsen tegen navigator.onLine corrigeert
// dat vanzelf, zonder te wachten op een pagina-herlaad.
setInterval(() => {
  const echt = navigator.onLine;
  if (echt !== isOnline) {
    isOnline = echt;
    updateStatusBadge();
    if (isOnline) syncWachtrij();
  }
}, 15000);

// ── Hulpfunctie: schrijf naar lokaal + sync-wachtrij + eventueel Supabase ─────
async function schrijf(tabel, actie, data) {
  // 1. Lokaal opslaan
  if (actie === 'upsert') await db[tabel].put(data);
  if (actie === 'delete') await db[tabel].delete(data.id || data.uid);

  // 2. In sync-wachtrij zetten
  await db.sync_queue.add({
    tabel,
    actie,
    data: JSON.stringify(data),
    aangemaakt_op: new Date().toISOString(),
    gesyncroniseerd: 0,
  });

  // 3. Direct proberen te syncen — altijd, ongeacht de isOnline-vlag. Die
  // vlag volgt navigator.onLine, dat op een tablet die net uit slaapstand
  // komt (wifi nog aan het herverbinden) best een paar seconden "offline"
  // kan blijven zeggen terwijl de eerste aankoop van een net wakker
  // geworden gast alweer binnenkomt. Gewoon proberen en op een echte fout
  // reageren is betrouwbaarder dan op die vlag vertrouwen vóór de poging.
  await syncWachtrij();
}

// Alle geldmutaties (consumptie boeken, afrekenen, voorraad aanvullen) lopen
// sinds de hardening via SECURITY DEFINER-RPC's op Supabase — de tablet heeft
// geen directe schrijfrechten meer op consumptie_log/betalingen/voorraad_log
// (zie supabase/migrations/20260829_04). De RPC's zijn idempotent op een
// client-aangeleverde uuid, dus een retry na een verbroken verbinding boekt
// nooit dubbel. Lukt de call nu niet, dan gaat 'ie in dezelfde sync-wachtrij
// als de rest.
async function _rpcOfWachtrij(rpc, args) {
  try {
    const { data, error } = await supa.rpc(rpc, args);
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.warn(`[rpc] ${rpc} nu mislukt — in de wachtrij:`, e?.message || e);
    // Ziet het er naar uit dat de sessie is weggevallen (RPC als 'anon' →
    // permission denied), probeer die dan op de achtergrond te herstellen zodat
    // de wachtrij-verwerking straks wél door de RLS/EXECUTE-check komt.
    if (_isAuthFout(e)) _herstelSessie('rpc-call');
    await db.sync_queue.add({
      rpc, args: JSON.stringify(args),
      aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0,
    });
    await updateSyncBadge();
    return null;
  }
}

// Een auth-/rechtenfout herkennen: Postgres 42501 (permission denied op de
// SECURITY DEFINER-RPC's, of RLS die een write tegenhoudt) of een 401/verlopen
// JWT van PostgREST. Zulke fouten liggen niet aan het wachtrij-item zelf — de
// tablet draait zonder geldige sessie — dus ze mogen de pogingen-teller niet
// opstoken.
function _isAuthFout(fout) {
  if (!fout) return false;
  const code = String(fout.code ?? fout.status ?? '');
  const msg = String(fout.message || '').toLowerCase();
  return code === '42501' || code === '401' || code === 'PGRST301' ||
         msg.includes('permission denied') || msg.includes('jwt') ||
         msg.includes('not authorized') || msg.includes('row-level security') ||
         msg.includes('row level security');
}

// Herstelt de Supabase-sessie als die is weggevallen: access token verlopen +
// autorefresh mislukt, of het refresh-token dat in een andere tab al 'gebruikt'
// is (Supabase roteert die). Zonder geldige sessie draait elke geld-RPC als
// 'anon' → 42501 en belanden alle transacties na 5 pogingen in de permanente
// foutbak. Lukt herstel niet, dan het setup-scherm tonen zodat beheer het
// apparaat opnieuw activeert.
let _sessieHerstelBezig = false;
async function _herstelSessie(aanleiding) {
  if (_sessieHerstelBezig) return false;
  _sessieHerstelBezig = true;
  try {
    let { data: { session } } = await supa.auth.getSession();

    if (!session) {
      const opgeslagen = localStorage.getItem(_SESSIE_SLEUTEL);
      if (opgeslagen) {
        try {
          const { data, error } = await supa.auth.setSession(JSON.parse(opgeslagen));
          if (!error && data.session) session = data.session;
        } catch { /* onleesbaar — hieronder afgehandeld */ }
      }
    }
    if (!session) {
      const { data, error } = await supa.auth.refreshSession();
      if (!error && data.session) session = data.session;
    }

    if (session) {
      console.info('[sessie] hersteld na', aanleiding);
      return true;
    }
    console.warn('[sessie] herstel mislukt na', aanleiding, '— apparaat opnieuw activeren vereist');
    localStorage.removeItem(_SESSIE_SLEUTEL);
    if (typeof toonSetupScherm === 'function') {
      toonSetupScherm('De apparaat-sessie is verlopen. Activeer het apparaat opnieuw met de sleutel — openstaande transacties blijven bewaard en worden daarna vanzelf verstuurd.');
    }
    return false;
  } catch (e) {
    console.warn('[sessie] herstel wierp een fout:', e?.message || e);
    return false;
  } finally {
    _sessieHerstelBezig = false;
  }
}

// Wacht een geld-RPC nog op stamdata die zélf ook nog in de wachtrij staat —
// een nieuw lid of artikel dat vóór de bijbehorende bestelling omhoog moet? Dan
// is een 'mislukt' geen echte fout maar een kwestie van volgorde: die poging
// niet meetellen, anders ligt de bestelling na 5 rondes permanent in de
// foutbak terwijl 'ie ná de stamdata-sync gewoon zou slagen.
async function _wachtOpStamdata(rpcItem) {
  let args;
  try { args = JSON.parse(rpcItem.args); } catch { return false; }
  const open = await db.sync_queue.where('gesyncroniseerd').equals(0).toArray();
  const pendLid = new Set(), pendProduct = new Set();
  for (const it of open) {
    if (it.actie !== 'upsert' || !it.data) continue;
    let d;
    try { d = JSON.parse(it.data); } catch { continue; }
    if (it.tabel === 'leden' && d.uid) pendLid.add(d.uid);
    if (it.tabel === 'producten' && d.id) pendProduct.add(d.id);
  }
  if (args.p_lid_uid && pendLid.has(args.p_lid_uid)) return true;
  if (args.p_product_id && pendProduct.has(args.p_product_id)) return true;
  for (const x of (args.p_items || [])) {
    if (x && pendProduct.has(x.product_id)) return true;
  }
  return false;
}

// ── Sync-wachtrij verwerken ────────────────────────────────────────────────────
// syncWachtrij() wordt vanuit drie plekken aangeroepen (15s-interval, het
// online-event én elke schrijf()). Zonder deze in-flight-guard konden twee
// runs overlappen: allebei lazen ze dezelfde gesyncroniseerd==0-items en
// verstuurden die dubbel — bij consumptie_regels (delete-dan-insert) leidde
// dat tot dubbele of ontbrekende regels, en bij leden-upserts overschreef een
// run met een stale gast.openstaand een net-gesyncte waarde. De guard
// serialiseert alle runs; komt er tijdens een run nieuw werk binnen, dan
// draait er direct erna nog één extra pass (_syncNogmaals).
let _syncBezig = false;
let _syncNogmaals = false;
async function syncWachtrij() {
  if (_syncBezig) { _syncNogmaals = true; return; }
  _syncBezig = true;
  try {
    do {
      _syncNogmaals = false;
      await _syncWachtrijEenmaal();
    } while (_syncNogmaals);
  } finally {
    _syncBezig = false;
  }
}

async function _syncWachtrijEenmaal() {
  // Eenmalig de na 5 pogingen geparkeerde items terugzetten zodra er weer een
  // geldige sessie is — die zijn meestal gestrand door een tijdelijk weggevallen
  // sessie of een volgorde-afhankelijkheid die inmiddels is opgelost. Lukt het
  // daarna nóg niet, dan blijven ze definitief mislukt (auto_herprobeerd = 1).
  await _herstelGeparkeerdeItems();

  const wachtrij = await db.sync_queue.where('gesyncroniseerd').equals(0).toArray();
  for (const item of wachtrij) {
    const pogingen = item.pogingen || 0;
    if (pogingen >= 5) {
      // Na 5 mislukte pogingen overslaan zodat de badge niet blijft hangen
      await db.sync_queue.update(item.id, { gesyncroniseerd: 2 }); // 2 = permanent mislukt
      console.warn('[sync] Item permanent overgeslagen na 5 pogingen:', item);
      continue;
    }
    let ok = false;
    let fout = null;
    let data = null;
    try {
      if (item.rpc) {
        // Geldmutatie via RPC — idempotent op de client-uuid in args, dus een
        // herhaalde poging is veilig.
        const args = JSON.parse(item.args);
        const { data: rpcData, error } = await supa.rpc(item.rpc, args);
        ok = !error; fout = error;
        // Offline afgerekend bedrag was een schatting; nu de server het echte
        // loopsaldo teruggeeft de lokale betalingsrij bijwerken. Bleek er niets
        // verschuldigd (betaling_id == null), dan boekte de server geen rij —
        // de lokale voorlopige rij ook weggooien i.p.v. als spookbetaling laten
        // staan.
        if (ok && item.rpc === 'kassa_reken_af' && rpcData && args.p_betaling_id) {
          if (rpcData.betaling_id == null) {
            await db.betalingen.delete(args.p_betaling_id);
          } else if (rpcData.bedrag != null) {
            await db.betalingen.update(args.p_betaling_id, { bedrag: Number(rpcData.bedrag) });
          }
        }
      } else {
        data = JSON.parse(item.data);
        // Strip velden die niet in het Supabase-schema horen (voorkomt 400-fouten)
        if (item.tabel === 'producten') {
          const toegestaan = ['id','naam','prijs','emoji','categorie','omschr','voorraad','laag_waarschuwing','inkoopeenheid','eenheden_per_inkoop','actief','aangemaakt_op','bijgewerkt_op','volgorde'];
          data = Object.fromEntries(Object.entries(data).filter(([k]) => toegestaan.includes(k)));
        }
        // heeft_pincode is generated (nooit meesturen). openstaand is sinds de
        // hardening een afgeleide, server-beheerde kolom — ook strippen.
        if (item.tabel === 'leden') {
          const { heeft_pincode, pincode, pincode_hash, openstaand, ...schoon } = data;
          data = schoon;
        }
        if (item.actie === 'upsert') {
          const { error } = await supa.from(item.tabel).upsert(data);
          ok = !error; fout = error;
        } else if (item.actie === 'delete') {
          const sleutel = PRIMAIRE_SLEUTEL[item.tabel] || 'id';
          const { error } = await supa.from(item.tabel).delete().eq(sleutel, data[sleutel]);
          ok = !error; fout = error;
        }
      }
    } catch (e) { ok = false; fout = e; }

    if (ok) {
      await db.sync_queue.update(item.id, { gesyncroniseerd: 1 });
    } else if (_isAuthFout(fout)) {
      // Geen geldige sessie → niets in deze wachtrij gaat door de RLS/EXECUTE-
      // check. De poging niet meetellen (het item is in orde) en de rest van de
      // ronde staken; sessie herstellen en, als dat lukt, meteen opnieuw.
      console.warn('[sync] auth-fout — sessie herstellen, poging niet meegeteld:', fout?.message || fout);
      if (await _herstelSessie('sync')) _syncNogmaals = true;
      break;
    } else if (item.rpc && await _wachtOpStamdata(item)) {
      console.info(`[sync] ${item.rpc} wacht op nog niet-gesyncte stamdata (nieuw lid/artikel) — poging niet meegeteld`);
    } else {
      const fouttekst = String((fout && (fout.message || fout.code)) || 'onbekende fout');
      console.warn(`[sync] Poging ${pogingen + 1} mislukt voor ${item.rpc || item.tabel + '/' + item.actie}:`, fout, data || item.args);
      await db.sync_queue.update(item.id, { pogingen: pogingen + 1, laatste_fout: fouttekst });
    }
  }
  updateSyncBadge();
}

// Welke sync-items gaan over geld (betaling/bestelling/voorraadmutatie)? Die
// verdienen bij een permanente mislukking de dringende "waarschuw beheer"; een
// gestrande stamdata-bewerking (lid/artikel/plek/bandje) is minder alarmerend.
function _isGeldSyncItem(it) {
  return it.rpc === 'kassa_boek_consumptie' || it.rpc === 'kassa_reken_af' ||
         it.rpc === 'kassa_vul_voorraad_aan' ||
         it.tabel === 'consumptie_log' || it.tabel === 'betalingen' || it.tabel === 'voorraad_log';
}

// Zet de na 5 pogingen geparkeerde items (gesyncroniseerd = 2) één keer terug
// in de wachtrij zodra er weer een geldige Supabase-sessie is. auto_herprobeerd
// voorkomt dat een écht kapot item elke ronde opnieuw 5 pogingen verstookt.
async function _herstelGeparkeerdeItems() {
  const kandidaten = (await db.sync_queue.where('gesyncroniseerd').equals(2).toArray())
    .filter(it => !it.auto_herprobeerd);
  if (!kandidaten.length) return;
  const { data: { session } } = await supa.auth.getSession();
  if (!session) return; // zonder sessie heeft terugzetten nu geen zin
  for (const it of kandidaten) {
    await db.sync_queue.update(it.id, { gesyncroniseerd: 0, pogingen: 0, auto_herprobeerd: 1 });
  }
  console.info(`[sync] ${kandidaten.length} geparkeerd(e) item(s) automatisch opnieuw geprobeerd (sessie weer geldig)`);
}

async function updateSyncBadge() {
  const wachtend      = await db.sync_queue.where('gesyncroniseerd').equals(0).count();
  // gesyncroniseerd==2 = na 5 pogingen definitief opgegeven. Splits geld
  // (betaling/bestelling/voorraadmutatie — mogelijk omzetverlies, dringend) van
  // een gestrande stamdata-bewerking (lid/artikel/plek/bandje — hinderlijk maar
  // geen geld). Blijft zichtbaar tot beheer het afhandelt (zie het
  // "Niet-gesynchroniseerd"-blok bij Beheer → Synchronisatie).
  const mislukteItems = await db.sync_queue.where('gesyncroniseerd').equals(2).toArray();
  const geldMislukt   = mislukteItems.filter(_isGeldSyncItem).length;
  const overigMislukt = mislukteItems.length - geldMislukt;

  const stukjes = [];
  if (geldMislukt)   stukjes.push(`${geldMislukt} betaling${geldMislukt === 1 ? '' : 'en'}/bestelling${geldMislukt === 1 ? '' : 'en'} NIET verstuurd — waarschuw beheer`);
  if (overigMislukt) stukjes.push(`${overigMislukt} wijziging${overigMislukt === 1 ? '' : 'en'} niet doorgekomen`);

  const el = document.getElementById('sync-wachtrij');
  if (el) {
    el.textContent = stukjes.length
      ? '⚠️ ' + stukjes.join(' · ')
      : (wachtend > 0 ? `⏳ ${wachtend} wachtend` : '');
    el.style.color = geldMislukt ? '#e74c3c' : '#e67e22';
    el.style.fontWeight = geldMislukt ? '700' : '400';
  }

  const detail = document.getElementById('sync-wachtrij-detail');
  if (detail) {
    if (stukjes.length) {
      detail.textContent = '⚠️ ' + stukjes.join(' · ') + ' — zie de lijst hieronder';
      detail.style.color = geldMislukt ? '#e74c3c' : '#e67e22';
      detail.style.fontWeight = geldMislukt ? '700' : '600';
    } else {
      detail.textContent = wachtend > 0 ? `⏳ ${wachtend} item${wachtend === 1 ? '' : 's'} wachtend` : '✅ Alles gesynchroniseerd';
      detail.style.color = '';
      detail.style.fontWeight = '';
    }
  }
}

// Leesbare omschrijving van een sync-item (voor het beheerscherm).
function _omschrijfSyncItem(it) {
  const map = {
    kassa_boek_consumptie: 'Bestelling', kassa_reken_af: 'Afrekening',
    kassa_vul_voorraad_aan: 'Voorraad aanvullen',
    leden: 'Lid', producten: 'Artikel', plekken: 'Plek', bandjes: 'Bandje',
    categorie_instellingen: 'Categorie-instelling', voorraad_log: 'Voorraadmutatie',
    consumptie_log: 'Bestelling', betalingen: 'Afrekening',
  };
  if (it.rpc) return map[it.rpc] || it.rpc;
  const actie = it.actie === 'delete' ? ' verwijderen' : it.actie === 'upsert' ? ' wijzigen' : '';
  return (map[it.tabel] || it.tabel || 'Item') + actie;
}

// Ophalen van de definitief mislukte sync-items voor het beheerscherm.
async function verzamelMislukteSync() {
  const items = await db.sync_queue.where('gesyncroniseerd').equals(2).toArray();
  return items.map(it => {
    let d = {};
    try { d = JSON.parse(it.data || it.args || '{}'); } catch {}
    return {
      id: it.id,
      soort: it.rpc || `${it.tabel}/${it.actie}`,
      omschrijving: _omschrijfSyncItem(it),
      is_geld: _isGeldSyncItem(it),
      aangemaakt_op: it.aangemaakt_op,
      laatste_fout: it.laatste_fout || null,
      lid_uid: d.p_lid_uid || d.lid_uid || d.uid || null,
      naam: d.naam || null,
      bedrag: d.totaal ?? d.bedrag ?? null,
    };
  });
}

// Zet de definitief mislukte items terug in de wachtrij voor een nieuwe poging
// (nadat beheer bv. de verbinding of de sessie heeft hersteld). auto_herprobeerd
// wordt gewist zodat het automatische herstel ze daarna ook weer mag oppakken.
async function herprobeerMislukteSync() {
  const items = await db.sync_queue.where('gesyncroniseerd').equals(2).toArray();
  for (const it of items) {
    await db.sync_queue.update(it.id, { gesyncroniseerd: 0, pogingen: 0, auto_herprobeerd: 0, laatste_fout: null });
  }
  await syncWachtrij();
}

// Eén definitief mislukt item weggooien (beheer heeft het handmatig afgehandeld
// of het is niet meer relevant — bv. een wijziging op een inmiddels verwijderd
// lid). Alleen items die al opgegeven zijn (gesyncroniseerd = 2).
async function verwijderMislukteSyncItem(id) {
  const it = await db.sync_queue.get(id);
  if (it && it.gesyncroniseerd === 2) await db.sync_queue.delete(id);
  await updateSyncBadge();
}

// ── Initieel laden: Supabase → IndexedDB ──────────────────────────────────────
async function laadVanSupabase() {
  // Geen isOnline-gate meer — altijd proberen, de catch hieronder vangt een
  // echte netwerkfout al op (zie toelichting bij schrijf()).
  try {
    // printer_instellingen wordt bewust NIET meer uit Supabase gehaald of naar
    // Supabase geschreven: de printer-URL en -sleutel blijven per tablet lokaal
    // (IndexedDB + localStorage). Reden: de sleutel opent ook de kassalade en
    // was via de publieke anon-key uit te lezen én te overschrijven (bonnen
    // omleiden). Bijkomend voordeel: elke tablet/locatie kan nu een eigen
    // printer hebben.
    const [{ data: leden }, { data: producten }, { data: log }, { data: betalingen }, { data: plekken }, { data: bandjes }, { data: voorraadLog }, { data: categorieInstellingen }, { data: meta }] =
      await Promise.all([
        supa.from('leden').select(LEDEN_KOLOMMEN),
        supa.from('producten').select('*'),
        supa.from('consumptie_log').select('*, consumptie_regels(*)'),
        supa.from('betalingen').select('*'),
        supa.from('plekken').select('*'),
        supa.from('bandjes').select('*'),
        supa.from('voorraad_log').select('*'),
        supa.from('categorie_instellingen').select('*'),
        supa.from('kassa_meta').select('*'),
      ]);

    // "Schone lijst": is er server-side een reset geweest ná wat deze tablet
    // laatst zag, maak dan de lokale transactiecache leeg vóór het herladen —
    // anders blijven oude bestellingen hier zichtbaar (bulkPut voegt alleen toe).
    const resetStamp = (meta || []).find(m => m.sleutel === 'laatste_reset')?.waarde;
    if (resetStamp && resetStamp !== localStorage.getItem('kr_laatste_reset')) {
      await db.log.clear();
      await db.betalingen.clear();
      await db.voorraad_log.clear();
      // Ook nog niet-gesyncte geldtransacties van vóór de reset weggooien —
      // anders stuurt syncWachtrij() ze straks alsnog naar de net geleegde
      // server en herrijst er een bestelling/afrekening (met een saldo weer
      // > 0). syncWachtrij() draait continu, laadVanSupabase() alleen bij het
      // starten, dus zonder dit wint de replay. Pendende stamdata-wijzigingen
      // (lid/artikel/plek/bandje) en voorraadaanvullingen blijven wél staan.
      const teWissen = (await db.sync_queue.toArray())
        .filter(it => it.rpc === 'kassa_boek_consumptie' || it.rpc === 'kassa_reken_af' ||
                      it.tabel === 'consumptie_log' || it.tabel === 'betalingen')
        .map(it => it.id);
      if (teWissen.length) await db.sync_queue.bulkDelete(teWissen);
      localStorage.setItem('kr_laatste_reset', resetStamp);
      console.info('[reset] lokale transactiecache geleegd (server-reset', resetStamp + ',',
                   teWissen.length, 'wachtrij-items verwijderd)');
      if (typeof updateSyncBadge === 'function') await updateSyncBadge();
    }

    if (leden)     { await db.leden.bulkPut(leden);         await reconcileVerwijderingen('leden', leden); }
    if (producten) { await db.producten.bulkPut(producten); await reconcileVerwijderingen('producten', producten); }
    if (log)       await db.log.bulkPut(log.map(r => ({
      ...r,
      items: (r.consumptie_regels || []).map(x => [x.product_naam, { prijs: x.prijs, aantal: x.aantal }]),
    })));
    if (betalingen) await db.betalingen.bulkPut(betalingen);
    if (plekken)    { await db.plekken.bulkPut(plekken);   await reconcileVerwijderingen('plekken', plekken); }
    if (bandjes)    { await db.bandjes.bulkPut(bandjes);   await reconcileVerwijderingen('bandjes', bandjes); }
    if (voorraadLog) await db.voorraad_log.bulkPut(voorraadLog);
    if (categorieInstellingen) await db.categorie_instellingen.bulkPut(categorieInstellingen);
  } catch (e) { console.warn('Supabase laden mislukt, gebruik lokale data', e); }
}

// bulkPut voegt alleen toe/werkt bij — een rij die op een ander toestel is
// verwijderd (bandje ontkoppeld, plek/lid/artikel weg) bleef zo lokaal staan
// en scanbaar; latere transacties daarop faalden dan op een foreign key en
// belandden na 5 pogingen definitief in de foutwachtrij. Hier lokaal wissen
// wat de server niet meer kent — maar alleen:
//   * als de server-fetch écht gelukt is (serverRijen is een array), nooit bij
//     een lege/mislukte respons;
//   * niet bij een sleutel die nog een openstaand sync_queue-item heeft (die
//     rij is lokaal aangemaakt en moet nog omhoog, staat dus terecht nog niet
//     op de server);
//   * niet als de server exact de PostgREST-maxrijen (1000) teruggaf — dan is
//     de lijst mogelijk afgekapt en zou reconciliatie te veel wissen.
async function reconcileVerwijderingen(tabel, serverRijen) {
  if (!Array.isArray(serverRijen) || serverRijen.length >= 1000) return;
  const sleutel = PRIMAIRE_SLEUTEL[tabel] || 'id';
  const serverSleutels = new Set(serverRijen.map(r => r[sleutel]));

  const wachtrij = await db.sync_queue.where('gesyncroniseerd').equals(0).toArray();
  const wachtendeSleutels = new Set(
    wachtrij
      .filter(it => it.tabel === tabel)
      .map(it => { try { return JSON.parse(it.data)[sleutel]; } catch { return null; } })
  );

  const lokaal = await db[tabel].toArray();
  const teVerwijderen = lokaal
    .map(r => r[sleutel])
    .filter(k => k != null && !serverSleutels.has(k) && !wachtendeSleutels.has(k));

  if (teVerwijderen.length) {
    await db[tabel].bulkDelete(teVerwijderen);
    console.info(`[sync] ${teVerwijderen.length} lokale ${tabel}-rij(en) verwijderd — elders van de server verwijderd`);
  }
}

// ── Openstaand: één model, gelijk aan de server ──────────────────────────────
// De server (kassa_herbereken_openstaand, migrations/20260829_04) rekent puur
// met sommen:  openstaand = max(0, som(consumpties) − som(betalingen)).  Geen
// tijdstippen, geen "sinds de laatste betaling". Dat model nemen we in de hele
// kassa-app over, zodat een laat-gesyncte bestelling of een betaling met een
// verschoven tijdstempel het saldo niet meer scheef kan trekken.
//
// Voor de weergave ("welke bestelling is al voldaan?") lopen we de betalingen
// als één pot langs de consumpties van oud naar nieuw: zolang de pot toereikt
// is een regel voldaan, daarna deels/open. De som van de niet-voldane regels
// is per definitie gelijk aan `openstaand` hierboven.
//
//   consumpties : [{ id, totaal, geregistreerd_op }]  (één lid)
//   betalingen  : [{ bedrag }]                          (één lid)
//   → { openstaand:Number, status:Map<log-id,'voldaan'|'deels'|'open'> }
function berekenOpenstaandModel(consumpties, betalingen) {
  let pot = (betalingen || []).reduce((s, b) => s + Number(b.bedrag || 0), 0);
  const rijen = [...(consumpties || [])].sort((a, b) =>
    String(a.geregistreerd_op || '').localeCompare(String(b.geregistreerd_op || '')));
  const status = new Map();
  let open = 0;
  for (const r of rijen) {
    const bedrag = Number(r.totaal || 0);
    if (pot >= bedrag) {
      pot -= bedrag;
      status.set(r.id, 'voldaan');
    } else {
      open += bedrag - pot;
      status.set(r.id, pot > 0 ? 'deels' : 'open');
      pot = 0;
    }
  }
  return { openstaand: Math.max(0, Math.round(open * 100) / 100), status };
}

// ── Data-toegang (altijd via IndexedDB) ───────────────────────────────────────
const DB = {
  async getLeden()     { return db.leden.toArray(); },
  async getPlekken()   { return db.plekken.toArray(); },
  async getBandjes()   { return db.bandjes.toArray(); },
  async getProducten() { return db.producten.toArray(); },

  // Altijd meteen proberen (ongeacht isOnline) en pas bij een echte fout in
  // de wachtrij zetten — zie toelichting bij schrijf().
  async upsertPlek(plek) {
    await db.plekken.put(plek);
    try {
      const { error } = await supa.from('plekken').upsert(plek);
      if (error) throw error;
    }
    catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'upsert', data: JSON.stringify(plek), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
  },
  async verwijderPlek(plek_code) {
    await db.plekken.delete(plek_code);
    try {
      const { error } = await supa.from('plekken').delete().eq('plek_code', plek_code);
      if (error) throw error;
    }
    catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'delete', data: JSON.stringify({ plek_code }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
  },
  async upsertBandje(bandje) {
    await db.bandjes.put(bandje);
    try {
      const { error } = await supa.from('bandjes').upsert(bandje);
      if (error) throw error;
    }
    catch { await db.sync_queue.add({ tabel: 'bandjes', actie: 'upsert', data: JSON.stringify(bandje), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
  },
  async verwijderBandje(bandje_uid) {
    await db.bandjes.delete(bandje_uid);
    try {
      const { error } = await supa.from('bandjes').delete().eq('bandje_uid', bandje_uid);
      if (error) throw error;
    }
    catch { await db.sync_queue.add({ tabel: 'bandjes', actie: 'delete', data: JSON.stringify({ bandje_uid }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
  },
  async getBandjesVoor(koppeling_id) {
    return db.bandjes.where('koppeling_id').equals(koppeling_id).toArray();
  },
  async getCategorieInstellingen() { return db.categorie_instellingen.toArray(); },
  async upsertCategorieInstelling(instelling) { await schrijf('categorie_instellingen', 'upsert', instelling); },

  // Printer-URL en -sleutel blijven LOKAAL per tablet — nooit naar Supabase
  // (de sleutel opent ook de kassalade en was via de anon-key uitleesbaar/
  // overschrijfbaar). Elke tablet één keer instellen via Beheer → Printer.
  async getPrinterInstellingen() { return db.printer_instellingen.get('globaal'); },
  async upsertPrinterInstelling(instelling) {
    await db.printer_instellingen.put({ id: 'globaal', ...instelling, bijgewerkt_op: new Date().toISOString() });
  },

  async getLog()       { return (await db.log.toArray()).sort((a,b) => b.geregistreerd_op?.localeCompare(a.geregistreerd_op)); },
  async getBetalingen(){ return (await db.betalingen.toArray()).sort((a,b) => b.betaald_op?.localeCompare(a.betaald_op)); },
  async getVoorraadLog(){ return (await db.voorraad_log.toArray()).sort((a,b) => b.aangemaakt_op?.localeCompare(a.aangemaakt_op)); },

  async upsertLid(lid) {
    lid.bijgewerkt_op = new Date().toISOString();
    if (!lid.aangemaakt_op) lid.aangemaakt_op = lid.bijgewerkt_op;
    await schrijf('leden', 'upsert', lid);
  },

  async upsertProduct(product) {
    product.bijgewerkt_op = new Date().toISOString();
    if (!product.aangemaakt_op) product.aangemaakt_op = product.bijgewerkt_op;
    if (!product.id) product.id = crypto.randomUUID();
    await schrijf('producten', 'upsert', product);
  },

  async verwijderProduct(id) {
    await schrijf('producten', 'delete', { id });
  },

  // Boekt één bestelling via de RPC. `entry`: { lid_uid, naam, omschrijving,
  // items:[[naam,{prijs,aantal}]], totaal, rpcItems:[{product_id,aantal}] }.
  // Schrijft lokaal een log-rij (voor de weergave) en stuurt de RPC; bij een
  // fout gaat 'ie in de wachtrij. Geeft het RPC-resultaat terug ({openstaand,
  // totaal, ...}) of null bij offline.
  async voegLogToe(entry) {
    entry.id = crypto.randomUUID();
    entry.geregistreerd_op = new Date().toISOString();
    await db.log.put(entry);
    return _rpcOfWachtrij('kassa_boek_consumptie', {
      p_log_id: entry.id,
      p_lid_uid: entry.lid_uid,
      p_items: entry.rpcItems || [],
      p_op: entry.geregistreerd_op,
    });
  },

  // Rekent de openstaande tab van één account af. Het BEDRAG bepaalt de server
  // (loopsaldo) — `betaling` levert alleen { lid_uid, naam, plek, wijze }.
  // Geeft het RPC-resultaat terug ({ bedrag, openstaand }) of null bij offline.
  async rekenAf(betaling) {
    const id = crypto.randomUUID();
    // Tijdstip expliciet vastleggen én meesturen. Gaat de RPC in de wachtrij
    // (offline afgerekend), dan zou de server anders now() nemen op het veel
    // latere syncmoment — waardoor een bestelling die de gast tussen het echte
    // betaalmoment en de sync doet, ten onrechte als "al betaald" telt.
    const op = new Date().toISOString();
    const res = await _rpcOfWachtrij('kassa_reken_af', {
      p_betaling_id: id,
      p_lid_uid: betaling.lid_uid,
      p_wijze: betaling.wijze || 'contant',
      p_op: op,
    });
    // Kwam de RPC nú door en bleek er niets verschuldigd, dan boekte de server
    // geen betalingsrij — lokaal er dan ook geen aanmaken (anders een
    // spookbetaling van €0). Bij een echt bedrag is de serverwaarde leidend;
    // bij res == null (offline, in de wachtrij) de schatting als voorlopige
    // waarde, die _syncWachtrijEenmaal() na de sync bijwerkt of opruimt.
    if (res && (res.betaling_id == null || Number(res.bedrag || 0) <= 0)) {
      return res;
    }
    await db.betalingen.put({
      id, lid_uid: betaling.lid_uid, naam: betaling.naam, plek: betaling.plek,
      bedrag: res?.bedrag ?? betaling.schatting ?? 0,
      wijze: betaling.wijze || 'contant', betaald_op: op,
    });
    return res;
  },

  // Voorraad aanvullen via de RPC. `entry`: { product_id, product_naam, aantal,
  // door, inkoop_aantal?, inkoop_eenheid?, schattingVoorraad? }.
  async vulVoorraad(entry) {
    const id = crypto.randomUUID();
    const res = await _rpcOfWachtrij('kassa_vul_voorraad_aan', {
      p_log_id: id,
      p_product_id: entry.product_id,
      p_aantal: entry.aantal,
      p_door: entry.door || null,
    });
    await db.voorraad_log.put({
      id, product_id: entry.product_id, product_naam: entry.product_naam,
      aantal: entry.aantal, nieuwe_voorraad: res?.nieuwe_voorraad ?? entry.schattingVoorraad ?? 0,
      door: entry.door || null,
      inkoop_aantal: entry.inkoop_aantal ?? null, inkoop_eenheid: entry.inkoop_eenheid ?? null,
      aangemaakt_op: new Date().toISOString(),
    });
    return res;
  },

  // "Schone lijst": wist server-side ALLE bestellingen + betalingen en zet alle
  // saldi op 0 (na de testperiode, of bij seizoensstart nadat alle rekeningen
  // voldaan zijn). Maakt eerst een back-up in schema kassa_backup. De server
  // markeert de reset zodat elke andere tablet bij de eerstvolgende sync ook
  // z'n lokale cache leegt. Geeft {backup, verwijderd:{...}} terug.
  async resetTransacties({ ookVoorraad = false } = {}) {
    const { data, error } = await supa.rpc('kassa_reset_transacties', {
      p_bevestiging: 'RESET',
      p_ook_voorraad: !!ookVoorraad,
    });
    if (error) throw error;
    // Meteen lokaal opruimen op dit toestel (de andere volgen via kassa_meta).
    await db.log.clear();
    await db.betalingen.clear();
    if (ookVoorraad) await db.voorraad_log.clear();
    // Alleen de transactie-wachtrij-items wissen — pendende stamdata-wijzigingen
    // (lid/artikel/plek/bandje) blijven staan.
    const wachtrij = await db.sync_queue.toArray();
    const teWissen = wachtrij.filter(it =>
      it.rpc === 'kassa_boek_consumptie' || it.rpc === 'kassa_reken_af' ||
      it.tabel === 'consumptie_log' || it.tabel === 'betalingen' ||
      (ookVoorraad && (it.rpc === 'kassa_vul_voorraad_aan' || it.tabel === 'voorraad_log'))
    ).map(it => it.id);
    if (teWissen.length) await db.sync_queue.bulkDelete(teWissen);
    return data;
  },
};
