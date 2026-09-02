// ── Sync-/openstaand-tests voor db.js ────────────────────────────────────────
//
//   npm install   (eenmalig — trekt dexie + fake-indexeddb binnen)
//   npm test
//
// Laadt de ECHTE db.js in een DOM-loze Node-context met fake-indexeddb en een
// nagebouwde Supabase-client, en controleert de sync-wachtrij, het
// openstaand-model, sessieherstel en de "schone lijst". De testgevallen zelf
// staan in test-sync.cases.js. Dekt NIET de DOM-rendering in index.html.

require('fake-indexeddb/auto');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const Dexie = require('dexie');

const DB_JS = path.join(__dirname, '..', 'db.js');

// ── Browser-globals die db.js verwacht ──────────────────────────────────────
globalThis.Dexie = Dexie.default || Dexie;
globalThis.crypto = globalThis.crypto || require('crypto').webcrypto;
globalThis.navigator = { onLine: true };
globalThis.addEventListener = () => {};
globalThis.window = globalThis;
globalThis.setInterval = () => 0; // geen achtergrondtimers tijdens de test

const _ls = new Map();
globalThis.localStorage = {
  getItem: k => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: k => _ls.delete(k),
  clear: () => _ls.clear(),
};
globalThis.__ls = _ls;

// minimale DOM: elk gevraagd element bestaat, zodat updateSyncBadge z'n tekst
// ergens kwijt kan en de test die kan uitlezen.
const _els = {};
globalThis.document = {
  getElementById(id) {
    if (!(id in _els)) _els[id] = { textContent: '', style: {}, _id: id };
    return _els[id];
  },
};
globalThis.__els = _els;

globalThis._setupOproepen = [];
globalThis.toonSetupScherm = msg => { globalThis._setupOproepen.push(msg); };

// ── Gedeelde, muteerbare state voor de nagebouwde Supabase-client ────────────
const state = {};
function resetState() {
  for (const k of Object.keys(state)) delete state[k];
  state.tables = {};
  state.rpcCalls = [];
  state.tableWrites = [];
  state.session = { access_token: 'geldig', refresh_token: 'r' };
  state.enforceAuth = true;
  state.rpc = {};
  globalThis._setupOproepen.length = 0;
  _ls.clear();
  for (const k of Object.keys(_els)) delete _els[k];
}

function maakFakeSupabase() {
  const auth = {
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { return { data: { session: state.session || null }, error: null }; },
    async setSession(tokens) {
      state.setSessionCalls = (state.setSessionCalls || 0) + 1;
      if (state.acceptSetSession === false || !tokens || !tokens.access_token) {
        return { data: { session: null }, error: { message: 'bad refresh token' } };
      }
      state.session = { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
      return { data: { session: state.session }, error: null };
    },
    async refreshSession() {
      state.refreshCalls = (state.refreshCalls || 0) + 1;
      if (state.acceptRefresh) {
        state.session = { access_token: 'ververst', refresh_token: 'r' };
        return { data: { session: state.session }, error: null };
      }
      return { data: { session: null }, error: { message: 'Auth session missing' } };
    },
  };

  async function rpc(name, args) {
    state.rpcCalls.push({ name, args: JSON.parse(JSON.stringify(args)) });
    if (state.enforceAuth && !state.session) {
      return { data: null, error: { code: '42501', message: `permission denied for function ${name}` } };
    }
    const impl = (state.rpc || {})[name];
    if (!impl) return { data: null, error: { message: `geen rpc-impl: ${name}` } };
    try { return { data: await impl(args, state), error: null }; }
    catch (e) { return { data: null, error: e.__pg || { message: String(e.message || e) } }; }
  }

  function from(table) {
    const rows = () => (state.tables[table] = state.tables[table] || []);
    const filters = [];
    const q = {
      select() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      gt(k, v) { filters.push(r => String(r[k]) > String(v)); return q; },
      order() { return q; },
      maybeSingle() {
        return Promise.resolve({ data: rows().filter(x => filters.every(f => f(x)))[0] || null, error: null });
      },
      async upsert(data) {
        if (state.enforceAuth && !state.session) return { error: { code: '42501', message: 'permission denied' } };
        if (state.tableError && state.tableError[table]) return { error: state.tableError[table] };
        const arr = Array.isArray(data) ? data : [data];
        state.tableWrites.push({ table, op: 'upsert', data: JSON.parse(JSON.stringify(data)) });
        for (const d of arr) {
          const key = ({ leden: 'uid', producten: 'id', plekken: 'plek_code', bandjes: 'bandje_uid' })[table] || 'id';
          const i = rows().findIndex(x => x[key] === d[key]);
          if (i >= 0) rows()[i] = { ...rows()[i], ...d }; else rows().push({ ...d });
        }
        return { error: null };
      },
      delete() {
        return {
          async eq(k, v) {
            if (state.enforceAuth && !state.session) return { error: { code: '42501', message: 'permission denied' } };
            state.tableWrites.push({ table, op: 'delete', k, v });
            state.tables[table] = rows().filter(x => x[k] !== v);
            return { error: null };
          },
        };
      },
      then(res, rej) {
        return Promise.resolve({ data: rows().filter(x => filters.every(f => f(x))), error: null }).then(res, rej);
      },
    };
    return q;
  }

  return { auth, rpc, from };
}

globalThis.supabase = { createClient: () => maakFakeSupabase() };

// ── db.js één keer laden; de symbolen die de tests nodig hebben naar global ──
{
  const src = fs.readFileSync(DB_JS, 'utf8');
  const wrapped =
    '(function(){\n' + src +
    '\n;Object.assign(globalThis, { DB, db, supa, berekenOpenstaandModel, _isAuthFout, ' +
    '_wachtOpStamdata, _herstelSessie, syncWachtrij, _syncWachtrijEenmaal, laadVanSupabase, ' +
    'updateSyncBadge, _rpcOfWachtrij, _isGeldSyncItem, _herstelGeparkeerdeItems, ' +
    'verzamelMislukteSync, herprobeerMislukteSync, verwijderMislukteSyncItem });\n})();';
  vm.runInThisContext(wrapped, { filename: DB_JS });
}

async function leegDb() {
  await Promise.all(globalThis.db.tables.map(t => t.clear()));
}

// ── mini test-runner ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fouten = [];
function ok(cond, naam) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', naam); }
  else { fail++; fouten.push(naam); console.log('  \x1b[31m✗ ' + naam + '\x1b[0m'); }
}
function eq(a, b, naam) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  ok(A === B, A === B ? naam : `${naam}  (kreeg ${A}, verwacht ${B})`);
}

(async () => {
  await require('./test-sync.cases.js')({ state, resetState, leegDb, ok, eq });
  console.log(`\n${pass} geslaagd, ${fail} mislukt`);
  if (fail) { console.log('MISLUKT:\n  ' + fouten.join('\n  ')); process.exit(1); }
  process.exit(0);
})();
