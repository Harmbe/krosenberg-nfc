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
  if (typeof toonSetupScherm === 'function') toonSetupScherm(diagnose);
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
const PRIMAIRE_SLEUTEL = { leden: 'uid', plekken: 'plek_code', bandjes: 'bandje_uid' };

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

// Schrijft één consumptie in twee stappen (log-rij + regels). Gebruikt door
// zowel de directe (online) registratie als de latere wachtrij-verwerking,
// zodat beide paden identiek gedrag hebben en fouten niet meer stilzwijgend
// verdwijnen. upsert (i.p.v. insert) op de log-rij en delete-dan-insert op de
// regels maken een herhaalde poging na een eerdere gedeeltelijke mislukking
// veilig: geen dubbele log-rij, geen dubbele regels.
async function schrijfConsumptieOnline(entry) {
  try {
    const { error: logFout } = await supa.from('consumptie_log').upsert({
      id: entry.id,
      lid_uid: entry.lid_uid,
      naam: entry.naam,
      omschrijving: entry.omschrijving,
      totaal: entry.totaal,
      geregistreerd_op: entry.geregistreerd_op,
    });
    if (logFout) { console.warn('[consumptie] log-rij opslaan mislukt:', logFout); return false; }

    const regels = (entry.items || []).map(([naam, v]) => ({
      log_id: entry.id,
      product_naam: naam,
      prijs: v.prijs,
      aantal: v.aantal,
    }));
    if (regels.length) {
      await supa.from('consumptie_regels').delete().eq('log_id', entry.id);
      const { error: regelsFout } = await supa.from('consumptie_regels').insert(regels);
      if (regelsFout) { console.warn('[consumptie] regels opslaan mislukt:', regelsFout); return false; }
    }
    return true;
  } catch (e) {
    console.warn('[consumptie] onverwachte fout bij opslaan:', e);
    return false;
  }
}

// ── Sync-wachtrij verwerken ────────────────────────────────────────────────────
async function syncWachtrij() {
  const wachtrij = await db.sync_queue.where('gesyncroniseerd').equals(0).toArray();
  for (const item of wachtrij) {
    const pogingen = item.pogingen || 0;
    if (pogingen >= 5) {
      // Na 5 mislukte pogingen overslaan zodat de badge niet blijft hangen
      await db.sync_queue.update(item.id, { gesyncroniseerd: 2 }); // 2 = permanent mislukt
      console.warn('[sync] Item permanent overgeslagen na 5 pogingen:', item);
      continue;
    }
    let data = JSON.parse(item.data);
    // Strip velden die niet in het Supabase-schema horen (voorkomt 400-fouten)
    if (item.tabel === 'producten') {
      const toegestaan = ['id','naam','prijs','emoji','categorie','omschr','voorraad','laag_waarschuwing','inkoopeenheid','eenheden_per_inkoop','actief','aangemaakt_op','bijgewerkt_op','volgorde'];
      data = Object.fromEntries(Object.entries(data).filter(([k]) => toegestaan.includes(k)));
    }
    // heeft_pincode is een generated column (GENERATED ALWAYS AS ... STORED) —
    // Postgres weigert elke upsert die daar een waarde voor meestuurt. Het
    // lokaal gecachete ledenobject bevat dit veld wél (opgehaald om de
    // pincode-status te tonen), dus moet het er hier altijd uit vóór een
    // upsert, anders faalt élke saldo-update op leden structureel.
    if (item.tabel === 'leden') {
      const { heeft_pincode, pincode, pincode_hash, ...schoon } = data;
      data = schoon;
    }
    let ok = false;
    let fout = null;
    try {
      if (item.tabel === 'consumptie_log' && item.actie === 'upsert') {
        ok = await schrijfConsumptieOnline(data);
        fout = ok ? null : new Error('Consumptie wegschrijven mislukt (zie eerdere console-waarschuwing)');
      } else if (item.actie === 'upsert') {
        const { error } = await supa.from(item.tabel).upsert(data);
        ok = !error; fout = error;
      } else if (item.actie === 'delete') {
        const sleutel = PRIMAIRE_SLEUTEL[item.tabel] || 'id';
        const { error } = await supa.from(item.tabel).delete().eq(sleutel, data[sleutel]);
        ok = !error; fout = error;
      }
    } catch (e) { ok = false; fout = e; }

    if (ok) {
      await db.sync_queue.update(item.id, { gesyncroniseerd: 1 });
    } else {
      console.warn(`[sync] Poging ${pogingen + 1} mislukt voor ${item.tabel}/${item.actie}:`, fout, data);
      await db.sync_queue.update(item.id, { pogingen: pogingen + 1 });
    }
  }
  updateSyncBadge();
}

async function updateSyncBadge() {
  const wachtend = await db.sync_queue.where('gesyncroniseerd').equals(0).count();
  const el = document.getElementById('sync-wachtrij');
  if (el) el.textContent = wachtend > 0 ? `⏳ ${wachtend} wachtend` : '';
  const detail = document.getElementById('sync-wachtrij-detail');
  if (detail) detail.textContent = wachtend > 0 ? `⏳ ${wachtend} item${wachtend === 1 ? '' : 's'} wachtend` : '✅ Alles gesynchroniseerd';
}

// ── Initieel laden: Supabase → IndexedDB ──────────────────────────────────────
async function laadVanSupabase() {
  // Geen isOnline-gate meer — altijd proberen, de catch hieronder vangt een
  // echte netwerkfout al op (zie toelichting bij schrijf()).
  try {
    const [{ data: leden }, { data: producten }, { data: log }, { data: betalingen }, { data: plekken }, { data: bandjes }, { data: voorraadLog }, { data: categorieInstellingen }, { data: printerInstellingen }] =
      await Promise.all([
        supa.from('leden').select(LEDEN_KOLOMMEN),
        supa.from('producten').select('*'),
        supa.from('consumptie_log').select('*, consumptie_regels(*)'),
        supa.from('betalingen').select('*'),
        supa.from('plekken').select('*'),
        supa.from('bandjes').select('*'),
        supa.from('voorraad_log').select('*'),
        supa.from('categorie_instellingen').select('*'),
        supa.from('printer_instellingen').select('*'),
      ]);

    if (leden)     await db.leden.bulkPut(leden);
    if (producten) await db.producten.bulkPut(producten);
    if (log)       await db.log.bulkPut(log.map(r => ({
      ...r,
      items: (r.consumptie_regels || []).map(x => [x.product_naam, { prijs: x.prijs, aantal: x.aantal }]),
    })));
    if (betalingen) await db.betalingen.bulkPut(betalingen);
    if (plekken)    await db.plekken.bulkPut(plekken);
    if (bandjes)    await db.bandjes.bulkPut(bandjes);
    if (voorraadLog) await db.voorraad_log.bulkPut(voorraadLog);
    if (categorieInstellingen) await db.categorie_instellingen.bulkPut(categorieInstellingen);
    if (printerInstellingen) await db.printer_instellingen.bulkPut(printerInstellingen);
  } catch (e) { console.warn('Supabase laden mislukt, gebruik lokale data', e); }
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

  // Eén gedeelde rij (id 'globaal') zodat printer-URL en -sleutel maar op één
  // tablet ingevuld hoeven te worden en daarna overal beschikbaar zijn —
  // zelfde opzet als categorie_instellingen hierboven.
  async getPrinterInstellingen() { return db.printer_instellingen.get('globaal'); },
  async upsertPrinterInstelling(instelling) {
    await schrijf('printer_instellingen', 'upsert', { id: 'globaal', ...instelling, bijgewerkt_op: new Date().toISOString() });
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

  async voegLogToe(entry) {
    entry.id = crypto.randomUUID();
    entry.geregistreerd_op = new Date().toISOString();
    await db.log.put(entry);
    // Altijd proberen, ongeacht isOnline — zie toelichting bij schrijf().
    const gelukt = await schrijfConsumptieOnline(entry);
    if (!gelukt) {
      await db.sync_queue.add({ tabel: 'consumptie_log', actie: 'upsert', data: JSON.stringify(entry), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },

  async voegBetalingToe(betaling) {
    betaling.id = crypto.randomUUID();
    betaling.betaald_op = new Date().toISOString();
    await schrijf('betalingen', 'upsert', betaling);
  },

  async voegVoorraadLogToe(entry) {
    entry.id = crypto.randomUUID();
    entry.aangemaakt_op = new Date().toISOString();
    await schrijf('voorraad_log', 'upsert', entry);
  },
};
