// ── Supabase + IndexedDB sync engine ──────────────────────────────────────────

const SUPABASE_URL = 'https://qdhnwhgfozdncgioeied.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaG53aGdmb3pkbmNnaW9laWVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NDY5NTIsImV4cCI6MjA5ODMyMjk1Mn0.IdUbivJZQIrrCDHjxEqunEu046TMFasbaUfZwZrRPfA';

// Velden die we ophalen voor leden — pincode en pincode_hash worden bewust
// weggelaten: de pincodecheck loopt via de controleer-pin Edge Function.
const LEDEN_KOLOMMEN = 'uid,naam,plek,openstaand,beheerder,aangemaakt_op,bijgewerkt_op,heeft_pincode';

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
  alert('initSessie diagnose: ' + diagnose);
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

  // 3. Direct proberen te syncen
  if (isOnline) await syncWachtrij();
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
  if (!isOnline) return;
  try {
    const [{ data: leden }, { data: producten }, { data: log }, { data: betalingen }, { data: plekken }, { data: bandjes }, { data: voorraadLog }] =
      await Promise.all([
        supa.from('leden').select(LEDEN_KOLOMMEN),
        supa.from('producten').select('*'),
        supa.from('consumptie_log').select('*, consumptie_regels(*)'),
        supa.from('betalingen').select('*'),
        supa.from('plekken').select('*'),
        supa.from('bandjes').select('*'),
        supa.from('voorraad_log').select('*'),
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
  } catch (e) { console.warn('Supabase laden mislukt, gebruik lokale data', e); }
}

// ── Data-toegang (altijd via IndexedDB) ───────────────────────────────────────
const DB = {
  async getLeden()     { return db.leden.toArray(); },
  async getPlekken()   { return db.plekken.toArray(); },
  async getBandjes()   { return db.bandjes.toArray(); },
  async getProducten() { return db.producten.toArray(); },

  async upsertPlek(plek) {
    await db.plekken.put(plek);
    if (isOnline) {
      try {
        const { error } = await supa.from('plekken').upsert(plek);
        if (error) throw error;
      }
      catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'upsert', data: JSON.stringify(plek), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'plekken', actie: 'upsert', data: JSON.stringify(plek), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async verwijderPlek(plek_code) {
    await db.plekken.delete(plek_code);
    if (isOnline) {
      try {
        const { error } = await supa.from('plekken').delete().eq('plek_code', plek_code);
        if (error) throw error;
      }
      catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'delete', data: JSON.stringify({ plek_code }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'plekken', actie: 'delete', data: JSON.stringify({ plek_code }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async upsertBandje(bandje) {
    await db.bandjes.put(bandje);
    if (isOnline) {
      try {
        const { error } = await supa.from('bandjes').upsert(bandje);
        if (error) throw error;
      }
      catch { await db.sync_queue.add({ tabel: 'bandjes', actie: 'upsert', data: JSON.stringify(bandje), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'bandjes', actie: 'upsert', data: JSON.stringify(bandje), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async verwijderBandje(bandje_uid) {
    await db.bandjes.delete(bandje_uid);
    if (isOnline) {
      try {
        const { error } = await supa.from('bandjes').delete().eq('bandje_uid', bandje_uid);
        if (error) throw error;
      }
      catch { await db.sync_queue.add({ tabel: 'bandjes', actie: 'delete', data: JSON.stringify({ bandje_uid }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'bandjes', actie: 'delete', data: JSON.stringify({ bandje_uid }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async getBandjesVoor(koppeling_id) {
    return db.bandjes.where('koppeling_id').equals(koppeling_id).toArray();
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
    const gelukt = isOnline && await schrijfConsumptieOnline(entry);
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
