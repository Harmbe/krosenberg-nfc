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
    const data = JSON.parse(item.data);
    let ok = false;
    try {
      if (item.actie === 'upsert') {
        const { error } = await supa.from(item.tabel).upsert(data);
        ok = !error;
      } else if (item.actie === 'delete') {
        const sleutel = item.tabel === 'leden' ? 'uid' : 'id';
        const { error } = await supa.from(item.tabel).delete().eq(sleutel, data[sleutel]);
        ok = !error;
      }
    } catch { ok = false; }

    if (ok) await db.sync_queue.update(item.id, { gesyncroniseerd: 1 });
  }
  updateSyncBadge();
}

async function updateSyncBadge() {
  const wachtend = await db.sync_queue.where('gesyncroniseerd').equals(0).count();
  const el = document.getElementById('sync-wachtrij');
  if (!el) return;
  el.textContent = wachtend > 0 ? `⏳ ${wachtend} wachtend` : '';
}

// ── Initieel laden: Supabase → IndexedDB ──────────────────────────────────────
async function laadVanSupabase() {
  if (!isOnline) return;
  try {
    const [{ data: leden }, { data: producten }, { data: log }, { data: betalingen }] =
      await Promise.all([
        supa.from('leden').select('*'),
        supa.from('producten').select('*'),
        supa.from('consumptie_log').select('*, consumptie_regels(*)'),
        supa.from('betalingen').select('*'),
      ]);

    if (leden)     await db.leden.bulkPut(leden);
    if (producten) await db.producten.bulkPut(producten);
    if (log)       await db.log.bulkPut(log.map(r => ({
      ...r,
      items: (r.consumptie_regels || []).map(x => [x.product_naam, { prijs: x.prijs, aantal: x.aantal }]),
    })));
    if (betalingen) await db.betalingen.bulkPut(betalingen);
  } catch (e) { console.warn('Supabase laden mislukt, gebruik lokale data', e); }
}

// ── Data-toegang (altijd via IndexedDB) ───────────────────────────────────────
const DB = {
  async getLeden()     { return db.leden.toArray(); },
  async getProducten() { return db.producten.toArray(); },
  async getLog()       { return db.log.orderBy('geregistreerd_op').reverse().toArray(); },
  async getBetalingen(){ return db.betalingen.orderBy('betaald_op').reverse().toArray(); },

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
      } catch { /* wachtrij pakt het op */ }
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
