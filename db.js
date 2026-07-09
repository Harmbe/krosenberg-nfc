// ── Supabase + IndexedDB sync engine ──────────────────────────────────────────

const SUPABASE_URL = 'https://qdhnwhgfozdncgioeied.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaG53aGdmb3pkbmNnaW9laWVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NDY5NTIsImV4cCI6MjA5ODMyMjk1Mn0.IdUbivJZQIrrCDHjxEqunEu046TMFasbaUfZwZrRPfA';

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

// ── Supabase client ────────────────────────────────────────────────────────────
const supa = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
      const toegestaan = ['id','naam','prijs','emoji','categorie','omschr','voorraad','laag_waarschuwing','actief','aangemaakt_op','bijgewerkt_op','volgorde'];
      data = Object.fromEntries(Object.entries(data).filter(([k]) => toegestaan.includes(k)));
    }
    let ok = false;
    let fout = null;
    try {
      if (item.actie === 'upsert') {
        const { error } = await supa.from(item.tabel).upsert(data);
        ok = !error; fout = error;
      } else if (item.actie === 'delete') {
        const sleutel = item.tabel === 'leden' ? 'uid' : 'id';
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
    const [{ data: leden }, { data: producten }, { data: log }, { data: betalingen }, { data: plekken }, { data: bandjes }] =
      await Promise.all([
        supa.from('leden').select('*'),
        supa.from('producten').select('*'),
        supa.from('consumptie_log').select('*, consumptie_regels(*)'),
        supa.from('betalingen').select('*'),
        supa.from('plekken').select('*'),
        supa.from('bandjes').select('*'),
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
      try { await supa.from('plekken').upsert(plek); }
      catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'upsert', data: JSON.stringify(plek), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'plekken', actie: 'upsert', data: JSON.stringify(plek), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async verwijderPlek(plek_code) {
    await db.plekken.delete(plek_code);
    if (isOnline) {
      try { await supa.from('plekken').delete().eq('plek_code', plek_code); }
      catch { await db.sync_queue.add({ tabel: 'plekken', actie: 'delete', data: JSON.stringify({ plek_code }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'plekken', actie: 'delete', data: JSON.stringify({ plek_code }), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async upsertBandje(bandje) {
    await db.bandjes.put(bandje);
    if (isOnline) {
      try { await supa.from('bandjes').upsert(bandje); }
      catch { await db.sync_queue.add({ tabel: 'bandjes', actie: 'upsert', data: JSON.stringify(bandje), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 }); }
    } else {
      await db.sync_queue.add({ tabel: 'bandjes', actie: 'upsert', data: JSON.stringify(bandje), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },
  async verwijderBandje(bandje_uid) {
    await db.bandjes.delete(bandje_uid);
    if (isOnline) {
      try { await supa.from('bandjes').delete().eq('bandje_uid', bandje_uid); }
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
    // Log naar Supabase in twee stappen
    if (isOnline) {
      try {
        const { data: logRij } = await supa.from('consumptie_log').insert({
          id: entry.id,
          lid_uid: entry.lid_uid,
          naam: entry.naam,
          omschrijving: entry.omschrijving,
          totaal: entry.totaal,
          geregistreerd_op: entry.geregistreerd_op,
        }).select().single();
        if (logRij) {
          const regels = entry.items.map(([naam, v]) => ({
            log_id: entry.id,
            product_naam: naam,
            prijs: v.prijs,
            aantal: v.aantal,
          }));
          await supa.from('consumptie_regels').insert(regels);
        }
      } catch {
        await db.sync_queue.add({ tabel: 'consumptie_log', actie: 'upsert', data: JSON.stringify(entry), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
      }
    } else {
      await db.sync_queue.add({ tabel: 'consumptie_log', actie: 'upsert', data: JSON.stringify(entry), aangemaakt_op: new Date().toISOString(), gesyncroniseerd: 0 });
    }
  },

  async voegBetalingToe(betaling) {
    betaling.id = crypto.randomUUID();
    betaling.betaald_op = new Date().toISOString();
    await schrijf('betalingen', 'upsert', betaling);
  },
};
