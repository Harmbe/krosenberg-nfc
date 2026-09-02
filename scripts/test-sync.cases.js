// Testgevallen voor de sync-/openstaand-logica in db.js.
// Uitgevoerd door scripts/test-sync.js (dat de harness + fake Supabase levert).
module.exports = async function ({ state, resetState, leegDb, ok, eq }) {
  const g = globalThis;
  const iso = (min = 0) => new Date(Date.UTC(2026, 8, 2, 12, min, 0)).toISOString();
  async function verse() { resetState(); await leegDb(); }

  // ── berekenOpenstaandModel — één model, gelijk aan de server ───────────────
  console.log('\nberekenOpenstaandModel');
  {
    const C = (id, t, tot) => ({ id, geregistreerd_op: t, totaal: tot });

    let m = g.berekenOpenstaandModel([C('a', iso(0), 5), C('b', iso(5), 4)], []);
    eq(m.openstaand, 9, 'niets betaald → volledige som open');
    eq([...m.status.values()], ['open', 'open'], '  beide regels open');

    m = g.berekenOpenstaandModel([C('a', iso(0), 5)], [{ bedrag: 8 }]);
    eq(m.openstaand, 0, 'overbetaald → 0 (nooit negatief)');

    m = g.berekenOpenstaandModel([C('a', iso(0), 5), C('b', iso(5), 4)], [{ bedrag: 7 }]);
    eq(m.openstaand, 2, 'deelbetaling → restschuld 2');
    eq(m.status.get('a'), 'voldaan', '  oudste regel voldaan');
    eq(m.status.get('b'), 'deels', '  deels-gedekte regel = deels');

    // De #1-bug: bestelling met tijdstempel vóór een volledige afrekening, laat
    // gesynct. "Sinds laatste betaling" zou 'm verbergen; dit model niet.
    m = g.berekenOpenstaandModel(
      [C('a', iso(0), 5), C('b', iso(5), 4), C('c', iso(2), 4)], [{ bedrag: 9 }]);
    eq(m.openstaand, 4, 'laat-gesyncte oude bestelling telt gewoon mee (loopsaldo)');

    const m2 = g.berekenOpenstaandModel(
      [C('c', iso(2), 4), C('b', iso(5), 4), C('a', iso(0), 5)], [{ bedrag: 9 }]);
    eq(m2.openstaand, m.openstaand, 'zelfde uitkomst ongeacht invoervolgorde');
  }

  // ── _isAuthFout ───────────────────────────────────────────────────────────
  console.log('\n_isAuthFout');
  {
    ok(g._isAuthFout({ code: '42501' }), '42501 → auth-fout');
    ok(g._isAuthFout({ message: 'permission denied for function kassa_reken_af' }), 'permission denied → auth-fout');
    ok(g._isAuthFout({ message: 'JWT expired' }), 'JWT expired → auth-fout');
    ok(!g._isAuthFout({ message: 'TypeError: Failed to fetch' }), 'netwerkfout → géén auth-fout');
    ok(!g._isAuthFout(null), 'null → géén auth-fout');
  }

  // ── rekenAf: p_op meegestuurd + lokaal identiek (#1) ──────────────────────
  console.log('\nrekenAf — tijdstip (#1)');
  {
    await verse();
    state.rpc.kassa_reken_af = a => ({ betaling_id: a.p_betaling_id, bedrag: 12, openstaand: 0, nieuw: true });
    await g.DB.rekenAf({ lid_uid: 'U', naam: 'Naam', plek: 'P1', wijze: 'contant', schatting: 12 });
    const call = state.rpcCalls.find(c => c.name === 'kassa_reken_af');
    ok(!!call.args.p_op, 'p_op wordt meegestuurd naar de RPC');
    const rij = (await g.db.betalingen.toArray())[0];
    eq(rij.betaald_op, call.args.p_op, 'lokale betaald_op == meegestuurde p_op');
    eq(rij.bedrag, 12, 'lokaal bedrag = serverbedrag');
  }

  // ── rekenAf: geen spookbetaling bij "niets verschuldigd" (#6) ─────────────
  console.log('\nrekenAf — spookbetaling (#6)');
  {
    await verse();
    state.rpc.kassa_reken_af = () => ({ betaling_id: null, bedrag: 0, openstaand: 0, nieuw: false });
    const res = await g.DB.rekenAf({ lid_uid: 'U', naam: 'N', plek: 'P', wijze: 'contant', schatting: 0 });
    eq(await g.db.betalingen.count(), 0, 'server boekte niets → geen lokale betalingsrij');
    eq(res.bedrag, 0, 'resultaat teruggegeven');
  }

  // ── rekenAf offline → wachtrij, daarna sync corrigeert/ruimt op (#6) ──────
  console.log('\nrekenAf offline → sync-reconcile (#6)');
  {
    await verse();
    state.rpc.kassa_reken_af = () => { throw new Error('Failed to fetch'); };
    await g.DB.rekenAf({ lid_uid: 'U', naam: 'N', plek: 'P', wijze: 'contant', schatting: 10 });
    let rij = (await g.db.betalingen.toArray())[0];
    eq(rij.bedrag, 10, 'offline: voorlopige rij met de schatting');
    const qItem = (await g.db.sync_queue.toArray())[0];
    ok(JSON.parse(qItem.args).p_op, 'wachtrij-item draagt p_op mee (blijft echte tijd na late sync)');

    state.rpc.kassa_reken_af = a => ({ betaling_id: a.p_betaling_id, bedrag: 6, openstaand: 0, nieuw: true });
    await g._syncWachtrijEenmaal();
    rij = (await g.db.betalingen.toArray())[0];
    eq(rij.bedrag, 6, 'na sync: lokaal bedrag bijgewerkt naar serverbedrag');
    eq((await g.db.sync_queue.where('gesyncroniseerd').equals(1).count()), 1, 'wachtrij-item afgevinkt');
  }
  {
    await verse();
    state.rpc.kassa_reken_af = () => { throw new Error('Failed to fetch'); };
    await g.DB.rekenAf({ lid_uid: 'U', naam: 'N', plek: 'P', wijze: 'contant', schatting: 10 });
    state.rpc.kassa_reken_af = () => ({ betaling_id: null, bedrag: 0, openstaand: 0 });
    await g._syncWachtrijEenmaal();
    eq(await g.db.betalingen.count(), 0, 'server boekte bij sync niets → voorlopige rij verwijderd');
  }

  // ── _wachtOpStamdata (#4) ────────────────────────────────────────────────
  console.log('\n_wachtOpStamdata (#4)');
  {
    await verse();
    await g.db.sync_queue.add({ tabel: 'leden', actie: 'upsert', data: JSON.stringify({ uid: 'NIEUW' }), aangemaakt_op: iso(0), gesyncroniseerd: 0 });
    ok(await g._wachtOpStamdata({ args: JSON.stringify({ p_lid_uid: 'NIEUW', p_items: [] }) }), 'consumptie voor nog-niet-gesynct lid → wachten');
    ok(!(await g._wachtOpStamdata({ args: JSON.stringify({ p_lid_uid: 'BESTAAT_AL', p_items: [] }) })), 'consumptie voor bekend lid → niet wachten');

    await g.db.sync_queue.add({ tabel: 'producten', actie: 'upsert', data: JSON.stringify({ id: 'ART1' }), aangemaakt_op: iso(0), gesyncroniseerd: 0 });
    ok(await g._wachtOpStamdata({ args: JSON.stringify({ p_items: [{ product_id: 'ART1', aantal: 1 }] }) }), 'consumptie met nog-niet-gesynct artikel → wachten');
  }

  // ── #4 end-to-end: nieuw lid + eerste bestelling, lid faalt 1x transient ──
  console.log('\n#4 — bestelling wacht op ledensync i.p.v. pogingen op te stoken');
  {
    await verse();
    await g.db.sync_queue.add({ tabel: 'leden', actie: 'upsert', data: JSON.stringify({ uid: 'NIEUW', naam: 'X', plek: 'P' }), aangemaakt_op: iso(0), gesyncroniseerd: 0 });
    await g.db.sync_queue.add({ rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'L1', p_lid_uid: 'NIEUW', p_items: [] }), aangemaakt_op: iso(1), gesyncroniseerd: 0 });

    state.tableError = { leden: { message: 'tijdelijke fout' } };
    state.rpc.kassa_boek_consumptie = () => { const e = new Error('Onbekend kassa-account'); e.__pg = { code: 'P0002', message: 'Onbekend kassa-account' }; throw e; };
    await g._syncWachtrijEenmaal();

    const items = await g.db.sync_queue.toArray();
    eq(items.find(i => i.tabel === 'leden').pogingen, 1, 'ledensync-poging wél geteld (echte transient fout)');
    ok(!items.find(i => i.rpc).pogingen, 'consumptie-poging NIET geteld — wacht op de ledensync');

    delete state.tableError;
    state.rpc.kassa_boek_consumptie = () => ({ log_id: 'L1', totaal: 0, openstaand: 0, nieuw: true });
    await g.syncWachtrij();
    eq(await g.db.sync_queue.where('gesyncroniseerd').equals(0).count(), 0, 'na de ledensync gaat de bestelling alsnog door');
  }

  // ── #5: weggevallen sessie ──────────────────────────────────────────────
  console.log('\n#5 — weggevallen sessie');
  {
    await verse();
    state.session = null;
    state.acceptRefresh = false;
    state.acceptSetSession = false; // backup-token in localStorage werkt ook niet meer
    await g.db.sync_queue.add({ rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'L1', p_lid_uid: 'U', p_items: [] }), aangemaakt_op: iso(0), gesyncroniseerd: 0 });
    state.rpc.kassa_boek_consumptie = () => ({ ok: true });

    await g._syncWachtrijEenmaal();
    const item = (await g.db.sync_queue.toArray())[0];
    ok(!item.pogingen, 'auth-fout stookt de pogingen-teller niet op');
    eq(item.gesyncroniseerd, 0, 'item blijft in de wachtrij (niet permanent mislukt)');
    ok(g._setupOproepen.length >= 1, 'setup-scherm getoond zodat beheer opnieuw activeert');
  }
  {
    await verse();
    state.session = null;
    state.acceptRefresh = true;
    await g.db.sync_queue.add({ rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'L1', p_lid_uid: 'U', p_items: [] }), aangemaakt_op: iso(0), gesyncroniseerd: 0 });
    state.rpc.kassa_boek_consumptie = () => ({ ok: true, openstaand: 0 });

    await g.syncWachtrij();
    ok(!!state.session, 'sessie hersteld tijdens de sync');
    eq(await g.db.sync_queue.where('gesyncroniseerd').equals(0).count(), 0, 'wachtrij daarna leeggewerkt in dezelfde run');
  }
  {
    await verse();
    state.session = null;
    state.acceptSetSession = true;
    g.__ls.set('kr_kassa_tokens', JSON.stringify({ access_token: 'backup', refresh_token: 'b' }));
    const hersteld = await g._herstelSessie('test');
    ok(hersteld && !!state.session, '_herstelSessie gebruikt de backup-tokens uit localStorage');
  }

  // ── #3: "schone lijst" ruimt ook de wachtrij van dit toestel ────────────
  console.log('\n#3 — reset wist ook onverzonden geldtransacties');
  {
    await verse();
    state.tables.kassa_meta = [{ sleutel: 'laatste_reset', waarde: '20260902_1200' }];
    await g.db.log.put({ id: 'L1', lid_uid: 'U', totaal: 5, geregistreerd_op: iso(0) });
    await g.db.betalingen.put({ id: 'B1', lid_uid: 'U', bedrag: 5, betaald_op: iso(0) });
    await g.db.sync_queue.bulkAdd([
      { rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'L1', p_lid_uid: 'U' }), aangemaakt_op: iso(0), gesyncroniseerd: 0 },
      { rpc: 'kassa_reken_af', args: JSON.stringify({ p_betaling_id: 'B1', p_lid_uid: 'U' }), aangemaakt_op: iso(1), gesyncroniseerd: 0 },
      { tabel: 'leden', actie: 'upsert', data: JSON.stringify({ uid: 'U', naam: 'n' }), aangemaakt_op: iso(2), gesyncroniseerd: 0 },
    ]);

    await g.laadVanSupabase();

    eq(await g.db.log.count(), 0, 'lokale consumptie-cache geleegd');
    eq(await g.db.betalingen.count(), 0, 'lokale betalingen-cache geleegd');
    const rest = await g.db.sync_queue.toArray();
    eq(rest.length, 1, 'alleen het niet-geld-item blijft over');
    eq(rest[0].tabel, 'leden', '  → de stamdata-wijziging blijft in de wachtrij');
    eq(g.__ls.get('kr_laatste_reset'), '20260902_1200', 'reset-stempel onthouden');

    await g.db.sync_queue.add({ rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'L2', p_lid_uid: 'U' }), aangemaakt_op: iso(9), gesyncroniseerd: 0 });
    await g.laadVanSupabase();
    ok(await g.db.sync_queue.where('gesyncroniseerd').equals(0).count() >= 1, 'zonder nieuwe reset blijft de wachtrij intact');
  }

  // ── Verbetering 2: badge onderscheidt geld vs. stamdata ──────────────────
  console.log('\nverbetering 2 — badge-tekst geld vs. stamdata');
  {
    await verse();
    await g.db.sync_queue.bulkAdd([
      { rpc: 'kassa_reken_af', args: '{}', aangemaakt_op: iso(0), gesyncroniseerd: 2, auto_herprobeerd: 1 },
      { tabel: 'leden', actie: 'upsert', data: JSON.stringify({ uid: 'U', naam: 'Jan' }), aangemaakt_op: iso(1), gesyncroniseerd: 2, auto_herprobeerd: 1 },
    ]);
    await g.updateSyncBadge();
    const tekst = g.__els['sync-wachtrij'].textContent;
    ok(/betaling.*NIET verstuurd — waarschuw beheer/.test(tekst), 'geld-item → "waarschuw beheer"');
    ok(/wijziging/.test(tekst), 'stamdata-item → apart als "wijziging niet doorgekomen"');
    eq(g.__els['sync-wachtrij'].style.fontWeight, '700', 'vetgedrukt omdat er geld bij zit');
  }
  {
    await verse();
    await g.db.sync_queue.add({ tabel: 'producten', actie: 'delete', data: JSON.stringify({ id: 'A' }), aangemaakt_op: iso(0), gesyncroniseerd: 2, auto_herprobeerd: 1 });
    await g.updateSyncBadge();
    const tekst = g.__els['sync-wachtrij'].textContent;
    ok(!/waarschuw beheer/.test(tekst) && /wijziging/.test(tekst), 'alleen stamdata → geen "waarschuw beheer"');
    eq(g.__els['sync-wachtrij'].style.fontWeight, '400', 'niet vetgedrukt zonder geld');
  }

  // ── Verbetering 3: geparkeerde items herstellen zodra de sessie terug is ──
  console.log('\nverbetering 3 — auto-herstel van geparkeerde items (#4/#5)');
  {
    await verse();
    // twee geparkeerde items; één zal alsnog lukken, één blijft kapot
    await g.db.sync_queue.bulkAdd([
      { rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'OK', p_lid_uid: 'U', p_items: [] }), aangemaakt_op: iso(0), gesyncroniseerd: 2 },
      { rpc: 'kassa_boek_consumptie', args: JSON.stringify({ p_log_id: 'KAPOT', p_lid_uid: 'U', p_items: [] }), aangemaakt_op: iso(1), gesyncroniseerd: 2 },
    ]);
    state.rpc.kassa_boek_consumptie = a => {
      if (a.p_log_id === 'KAPOT') { const e = new Error('kapot'); e.__pg = { message: 'kolom bestaat niet' }; throw e; }
      return { log_id: a.p_log_id, openstaand: 0 };
    };

    // pass 1 zet beide terug in de wachtrij; daarna raakt 'KAPOT' z'n 5 pogingen op
    for (let i = 0; i < 6; i++) await g.syncWachtrij();

    let items = await g.db.sync_queue.toArray();
    eq(items.find(i => i.args.includes('OK')).gesyncroniseerd, 1, 'geparkeerd item dat weer kan → alsnog gesynct');
    const kapot = items.find(i => i.args.includes('KAPOT'));
    eq(kapot.gesyncroniseerd, 2, 'écht kapot item → opnieuw geparkeerd');
    eq(kapot.auto_herprobeerd, 1, '  gemarkeerd zodat het niet elke ronde 5 pogingen verstookt');

    // volgende syncrondes: het kapotte item wordt NIET nog eens teruggezet
    const rpcVoor = state.rpcCalls.length;
    await g.syncWachtrij();
    await g.syncWachtrij();
    eq(state.rpcCalls.length, rpcVoor, 'al-eens-auto-herprobeerd item wordt niet opnieuw geprobeerd');
  }
  {
    // zonder geldige sessie worden geparkeerde items niet teruggezet
    await verse();
    state.session = null;
    await g.db.sync_queue.add({ rpc: 'kassa_reken_af', args: '{}', aangemaakt_op: iso(0), gesyncroniseerd: 2 });
    await g._herstelGeparkeerdeItems();
    eq((await g.db.sync_queue.toArray())[0].gesyncroniseerd, 2, 'geen sessie → geparkeerd item blijft geparkeerd');
  }

  // ── Verbetering 1: data voor het beheerscherm-blok ──────────────────────
  console.log('\nverbetering 1 — verzamelMislukteSync / verwijderMislukteSyncItem');
  {
    await verse();
    await g.db.sync_queue.bulkAdd([
      { rpc: 'kassa_reken_af', args: JSON.stringify({ p_lid_uid: 'U1', naam: 'Jan', bedrag: 7.5 }), aangemaakt_op: iso(0), gesyncroniseerd: 2, laatste_fout: 'permission denied', auto_herprobeerd: 1 },
      { tabel: 'leden', actie: 'upsert', data: JSON.stringify({ uid: 'U2', naam: 'Lisa' }), aangemaakt_op: iso(1), gesyncroniseerd: 2, laatste_fout: 'kolom x', auto_herprobeerd: 1 },
      { rpc: 'kassa_boek_consumptie', args: '{}', aangemaakt_op: iso(2), gesyncroniseerd: 0 }, // niet mislukt → niet in de lijst
    ]);
    const lijst = await g.verzamelMislukteSync();
    eq(lijst.length, 2, 'alleen de opgegeven items');
    eq(lijst[0].omschrijving, 'Afrekening', 'leesbare omschrijving van een RPC-item');
    eq(lijst[0].is_geld, true, 'afrekening is een geld-item');
    eq(lijst[0].naam, 'Jan', 'naam uit de args');
    eq(lijst[1].omschrijving, 'Lid wijzigen', 'leesbare omschrijving van een tabel-item');
    eq(lijst[1].is_geld, false, 'ledenwijziging is geen geld-item');

    await g.verwijderMislukteSyncItem(lijst[1].id);
    eq((await g.verzamelMislukteSync()).length, 1, 'verwijderen haalt het item weg');

    await g.verwijderMislukteSyncItem(lijst[0].id);
    eq((await g.verzamelMislukteSync()).length, 0, 'geld-item ook weg');
    eq(await g.db.sync_queue.count(), 1, 'het nog-wachtende item (gesyncroniseerd:0) blijft ongemoeid');

    // herprobeerMislukteSync wist auto_herprobeerd zodat auto-herstel ze weer mag pakken
    await verse();
    await g.db.sync_queue.add({ rpc: 'kassa_reken_af', args: '{}', aangemaakt_op: iso(0), gesyncroniseerd: 2, auto_herprobeerd: 1 });
    state.rpc.kassa_reken_af = () => { throw new Error('nog steeds stuk'); };
    await g.herprobeerMislukteSync();
    const na = (await g.db.sync_queue.toArray())[0];
    ok(na.gesyncroniseerd === 0 || na.gesyncroniseerd === 2, 'item opnieuw geprobeerd');
    eq(na.auto_herprobeerd, na.gesyncroniseerd === 2 ? 1 : 0, 'auto_herprobeerd gereset bij handmatige herpoging');
  }

  // ── F42: niet-geactiveerd apparaat genereert geen schrijf-syncs ───────────
  console.log('\nF42 — niet-geactiveerd apparaat');
  {
    await verse();
    g.__ls.delete('kr_kassa_tokens'); // nooit geactiveerd
    await g.schrijf('leden', 'upsert', { uid: 'U9', naam: 'Test', plek: 'GV1' });
    eq(await g.db.sync_queue.count(), 0, 'geen wachtrij-item zonder activatie');
    eq((await g.db.leden.toArray()).length, 1, 'lokale IndexedDB-schrijf gebeurt wél (UI blijft werken)');

    // ná activatie mag het weer
    g.__ls.set('kr_kassa_tokens', JSON.stringify({ access_token: 'x', refresh_token: 'y' }));
    await g.schrijf('leden', 'upsert', { uid: 'U10', naam: 'Test2', plek: 'GV2' });
    ok(await g.db.sync_queue.count() >= 1, 'na activatie wél in de wachtrij');
  }
};
