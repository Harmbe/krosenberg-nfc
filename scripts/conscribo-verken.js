#!/usr/bin/env node
/**
 * Verkenningsscript voor de Conscribo REST API.
 *
 * Leest uit hoe DEZE vereniging haar administratie heeft ingericht. Dat is
 * nodig omdat entityTypes en fieldDefinitions per administratie verschillen —
 * je kunt de veldmapping naar de kassa- en reserveringen-app dus niet uit de
 * documentatie afleiden, alleen uit de administratie zelf.
 *
 * STRIKT READ-ONLY: er wordt niets aangemaakt, gewijzigd of verwijderd. Naast
 * GET-requests gebruikt dit script twee POSTs die ondanks de methode alleen
 * lezen: /sessions/ (inloggen) en /relations/filters/ (zoekopdracht — in deze
 * API is zoeken nu eenmaal een POST, want de filters gaan in de body).
 *
 * PRIVACY: het script haalt bewust alleen veld-DEFINITIES en AANTALLEN op,
 * geen ledengegevens. Er komen dus geen namen, adressen of e-mailadressen in
 * het rapport te staan.
 *
 * Gebruik:
 *   CONSCRIBO_ACCOUNT=<accountnaam> CONSCRIBO_USER=<api-gebruiker> \
 *     node scripts/conscribo-verken.js
 *
 * De accountnaam is de naam van de ORGANISATIE (niet van jou), en staat in de
 * URL waarmee je inlogt: https://secure.conscribo.nl/<accountnaam>/...
 *
 * Het wachtwoord wordt gevraagd als CONSCRIBO_PASS niet gezet is, zodat het
 * niet in je shell-geschiedenis belandt.
 */

const readline = require('readline');
const fs = require('fs');

// De accountnaam is alleen het organisatiedeel, maar het ligt voor de hand om
// de hele inlog-URL te plakken. Die pellen we er hier gewoon af.
function normaliseerAccount(waarde) {
  if (!waarde) return waarde;
  const m = waarde.match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
  return (m ? m[1] : waarde).replace(/^\/+|\/+$/g, '').trim();
}

const RAPPORT = process.env.CONSCRIBO_RAPPORT || 'conscribo-verkenning.md';

// Alles is ook via env-vars te zetten (handig om te herhalen), maar wordt
// anders gewoon gevraagd. Een lange env-regel breekt bij plakken makkelijk af
// in de terminal, en dan bereikt de helft het script niet.
let ACCOUNT = normaliseerAccount(process.env.CONSCRIBO_ACCOUNT);
let USER    = process.env.CONSCRIBO_USER;
let BASIS;

// Eén gedeelde readline-interface voor alle vragen. Per vraag een nieuwe
// aanmaken gaat mis: bij het sluiten slokt de ene interface de invoer op die
// voor de volgende bedoeld was, waarna de rest van de vragen overgeslagen
// wordt.
let _rl = null;
function rl() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Onderdruk desgewenst de echo van getypte tekens; readline schrijft het
    // wachtwoord anders leesbaar in de terminal (en daarmee in scrollback).
    const schrijfOrigineel = _rl._writeToOutput.bind(_rl);
    _rl._writeToOutput = s => {
      if (!_rl.gedempt) return schrijfOrigineel(s);
      // Tijdens dempen alleen de prompt zelf doorlaten. Zonder deze
      // uitzondering wist readline bij elke toetsaanslag de hele regel, en
      // verdwijnt de vraag terwijl je aan het typen bent.
      if (s.includes(_rl.dempPrompt)) schrijfOrigineel(_rl.dempPrompt);
    };
  }
  return _rl;
}

function vraag(tekst) {
  return new Promise(resolve => rl().question(tekst, a => resolve(a.trim())));
}

function vraagWachtwoord(tekst) {
  return new Promise(resolve => {
    const i = rl();
    i.dempPrompt = tekst;
    i.gedempt = true;
    i.question(tekst, antwoord => { i.gedempt = false; i.output.write('\n'); resolve(antwoord); });
  });
}

// Vertaal de foutcodes uit de spec naar wat je er concreet aan moet doen —
// bijna alle mislukkingen hier zijn rechtenproblemen, geen bugs.
const UITLEG = {
  'API/NOT_AUTHENTICATED':       'Sessie ongeldig of verlopen (standaard na 30 min inactiviteit).',
  'AUTH/FORBIDDEN':              'De API-gebruiker mist rechten hierop. Laat de beheerder de rechten van deze gebruiker uitbreiden.',
  'RELATIONS/NO_RELATION_ADMIN': 'Deze administratie heeft geen relatie-/ledenadministratie ingericht.',
};

// responseMessages is géén platte lijst maar een object met de sleutels
// error/warning/info, elk met een array van {message, code, hint}. De hint is
// vaak concreter dan wat wij er zelf van kunnen maken, dus die tonen we ook.
function meldingen(body, soort = 'error') {
  const groep = body?.responseMessages?.[soort];
  return Array.isArray(groep) ? groep : [];
}

function meldingenAlsTekst(body) {
  return meldingen(body).map(m => {
    const kop = [m.code, m.message].filter(Boolean).join(' — ');
    const tip = m.hint || UITLEG[m.code];
    return '    ' + kop + (tip ? `\n      ${tip}` : '');
  });
}

// `verzoek` gevuld ⇒ POST met die JSON-body; anders een gewone GET.
async function api(pad, sessie, verzoek = null) {
  const res = await fetch(BASIS + pad, {
    method: verzoek ? 'POST' : 'GET',
    headers: {
      'Accept': 'application/json',
      'X-Conscribo-SessionId': sessie,
      ...(verzoek ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(verzoek ? { body: JSON.stringify(verzoek) } : {}),
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body) {
    const regels = meldingenAlsTekst(body);
    const fout = new Error(
      `${verzoek ? 'POST' : 'GET'} ${pad} → HTTP ${res.status}` + (regels.length ? '\n' + regels.join('\n') : '')
    );
    fout.zacht = true;   // rechtenfouten mogen de verkenning niet afbreken
    throw fout;
  }
  return body;
}

async function main() {
  if (!ACCOUNT) {
    console.log('De accountnaam is die van de ORGANISATIE, niet je eigen gebruikersnaam.');
    console.log('Je vindt hem in je inlog-URL: https://secure.conscribo.nl/<accountnaam>/');
    console.log('De hele URL plakken mag ook.\n');
    ACCOUNT = normaliseerAccount(await vraag('Accountnaam: '));
  }
  if (!ACCOUNT) { console.error('Geen accountnaam ingevoerd.'); _rl && _rl.close(); return; }

  if (!USER) USER = await vraag('Gebruikersnaam: ');
  if (!USER) { console.error('Geen gebruikersnaam ingevoerd.'); _rl && _rl.close(); return; }

  BASIS = `https://api.secure.conscribo.nl/${encodeURIComponent(ACCOUNT)}`;

  const pass = process.env.CONSCRIBO_PASS || await vraagWachtwoord(`Wachtwoord voor "${USER}": `);
  if (!pass) { console.error('Geen wachtwoord ingevoerd.'); _rl && _rl.close(); return; }

  const tweeFa = process.env.CONSCRIBO_2FA || await vraag('2FA-code (leeg laten als je die niet gebruikt): ');

  const regels = [];
  const log = t => { console.log(t); regels.push(t); };

  log(`# Conscribo-verkenning — ${ACCOUNT}`);
  log('');
  log(`Uitgelezen op ${new Date().toISOString().slice(0, 16).replace('T', ' ')} door API-gebruiker \`${USER}\`.`);
  log('Alleen leesacties uitgevoerd; er is niets in de administratie gewijzigd.');
  log('');

  // ── 1. Inloggen ───────────────────────────────────────────────────────────
  const authRes = await fetch(`${BASIS}/sessions/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      userName: USER,
      passPhrase: pass,
      ...(tweeFa ? { twoFaCode: Number(tweeFa) } : {}),
    }),
  });
  const auth = await authRes.json().catch(() => null);
  if (!authRes.ok || !auth?.sessionId) {
    console.error(`\nInloggen mislukt (HTTP ${authRes.status}).`);
    meldingenAlsTekst(auth).forEach(r => console.error(r));
    console.error('\nControleer accountnaam (die van de ORGANISATIE), gebruikersnaam en wachtwoord.');
    console.error('Heeft de gebruiker 2FA? Let op dat zo\'n code snel verloopt.');
    process.exitCode = 1;
    return;
  }
  const sessie = auth.sessionId;
  log(`Ingelogd als **${auth.userDisplayName || USER}**.`);
  log('');

  // ── 2. Welke soorten relaties kent deze administratie? ────────────────────
  let typen = [];
  try {
    const res = await api('/relations/entityTypes/', sessie);
    typen = res.entityTypes || [];
    log('## Relatietypes');
    log('');
    if (!typen.length) {
      log('_Geen relatietypes gevonden._');
    } else {
      log('| typeName | enkelvoud | meervoud |');
      log('|---|---|---|');
      typen.forEach(t => log(`| \`${t.typeName}\` | ${t.langSingular || ''} | ${t.langPlural || ''} |`));
    }
    log('');
  } catch (e) {
    log('## Relatietypes');
    log('');
    log('```\n' + e.message + '\n```');
    log('');
  }

  // ── 3. Welke velden hangen er per type aan? Dit is de kern: hierop moet de
  //       mapping naar leden.uid / gast.email gebouwd worden. ───────────────
  const veldenPerType = {};
  for (const t of typen) {
    log(`### Velden van \`${t.typeName}\``);
    log('');
    try {
      const res = await api(`/relations/fieldDefinitions/${encodeURIComponent(t.typeName)}`, sessie);
      const velden = res.fieldDefinitions || res.fields || [];
      veldenPerType[t.typeName] = velden.map(v => v.fieldName || v.name).filter(Boolean);
      if (!velden.length) {
        log('_Geen velden teruggekregen._');
      } else {
        log('| veld | label | type | verplicht |');
        log('|---|---|---|---|');
        velden.forEach(v => log(
          `| \`${v.fieldName || v.name || ''}\` | ${v.label || ''} | ${v.type || v.fieldType || ''} | ${v.required ? 'ja' : ''} |`
        ));
      }
    } catch (e) {
      log('```\n' + e.message + '\n```');
    }
    log('');
  }

  // ── 3b. Hoeveel relaties zitten er per type? Dit valideert welk type de
  //        échte ledenadministratie is — de veldlabels suggereren dat wel,
  //        maar de aantallen bewijzen het. Er wordt alleen geteld: we vragen
  //        één record met alleen het veld 'code', en lezen resultCount (die
  //        negeert limit/offset).
  async function telType(typeNaam, filters) {
    const res = await api('/relations/filters/', sessie, {
      requestedFields: ['code'],
      entityType: typeNaam,
      limit: 1,
      ...(filters ? { filters } : {}),
    });
    return res.resultCount ?? (res.entities ? res.entities.length : null);
  }

  if (typen.length) {
    log('## Aantallen per relatietype');
    log('');
    log('| type | totaal | lidmaatschap loopt nog |');
    log('|---|---|---|');
    const vandaagIso = new Date().toISOString().slice(0, 10);
    for (const t of typen) {
      let totaal = '—', lopend = '';
      try {
        totaal = await telType(t.typeName);
      } catch (e) {
        totaal = '_fout_';
        console.error(`  tellen van ${t.typeName} mislukt:\n${e.message}`);
      }
      // Alleen zinvol voor types die überhaupt een einddatum kennen.
      if ((veldenPerType[t.typeName] || []).includes('eind_lidmaatschap')) {
        try {
          lopend = await telType(t.typeName, [
            { fieldName: 'eind_lidmaatschap', operator: '>=', value: { start: vandaagIso, stop: null } },
          ]);
        } catch {
          lopend = '_filter niet ondersteund_';
        }
      }
      log(`| \`${t.typeName}\` | ${totaal} | ${lopend} |`);
    }
    log('');
    log('_"Lidmaatschap loopt nog" telt records met een einddatum vanaf vandaag._');
    log('_Leden zonder ingevulde einddatum vallen daar buiten — als deze kolom laag is');
    log('terwijl het totaal klopt, wordt `eind_lidmaatschap` simpelweg niet bijgehouden._');
    log('');
  }

  // ── 3c. Relatiegroepen. Als het relatietype zelf geen lidmaatschapsvelden
  //        heeft, wordt "wie is lid" in de praktijk vaak via groepen geregeld.
  //        Dit is dus de plek waar de ledenselectie vandaan moet komen.
  //        Alleen groepsnamen en aantallen; de leden zelf blijven buiten beeld.
  log('## Relatiegroepen');
  log('');
  try {
    const res = await api('/relations/groups/', sessie);
    const groepen = res.entityGroups || [];
    if (!groepen.length) {
      log('_Geen groepen gevonden._');
    } else {
      log('| id | naam | soort | aantal leden |');
      log('|---|---|---|---|');
      groepen.forEach(g => log(
        `| ${g.id ?? ''} | ${g.name || ''} | ${g.type || ''} | ${Array.isArray(g.members) ? g.members.length : ''} |`
      ));
    }
  } catch (e) {
    log('```\n' + e.message + '\n```');
  }
  log('');

  // ── 4. Grootboekrekeningen — nodig zodra consumpties of reserveringen
  //       doorgeboekt gaan worden. Het grootboek verandert door de tijd heen,
  //       dus `date` is verplicht: je vraagt de stand op één moment op.
  //       Mag falen op AUTH/FORBIDDEN — dat is een apart recht.
  const vandaag = new Date().toISOString().slice(0, 10);
  let rekeningen = [];
  log('## Grootboekrekeningen');
  log('');
  log(`_Stand op ${vandaag}._`);
  log('');
  try {
    const res = await api(`/financial/accounts/?date=${vandaag}`, sessie);
    const rek = res.accounts || [];
    rekeningen = rek;
    if (!rek.length) {
      log('_Geen rekeningen teruggekregen._');
    } else {
      log(`${rek.length} rekeningen gevonden:`);
      log('');
      log('| nr | omschrijving | type |');
      log('|---|---|---|');
      rek.forEach(r => log(`| ${r.accountNr ?? r.number ?? ''} | ${r.accountName ?? r.description ?? ''} | ${r.type ?? ''} |`));
    }
  } catch (e) {
    log('```\n' + e.message + '\n```');
    log('');
    // Niet blind "rechten ontbreken" concluderen: dat stond hier eerst en was
    // misleidend toen de echte oorzaak een ontbrekende parameter bleek.
    if (/AUTH\/FORBIDDEN/.test(e.message)) {
      log('_De API-gebruiker mist financiële rechten. Geen probleem zolang je alleen leden');
      log('wilt synchroniseren — pas nodig bij het doorboeken van omzet._');
    }
  }
  log('');

  // ── 5. Sonde op de financiële kant. De relatieadministratie legt nergens
  //       vast wie lid is (geen lidmaatschapsvelden, geen groepen), dus toetsen
  //       we de hypothese dat lidmaatschap financieel wordt gemodelleerd:
  //       "lid" = wie er jaarlijks contributie geboekt krijgt.
  //
  //       Alleen /financial/transactions/filters/ en /financial/invoices/filters/
  //       — de zoekvarianten. NIET POST /financial/invoices/, want dat MAAKT
  //       een factuur aan.
  //
  //       Er worden bewust geen relatienummers of omschrijvingen gerapporteerd,
  //       alleen aantallen: omschrijvingen kunnen namen bevatten.
  const jaar = new Date().getFullYear();
  const perioden = [
    { naam: String(jaar),     start: `${jaar}-01-01`,     eind: `${jaar}-12-31` },
    { naam: String(jaar - 1), start: `${jaar - 1}-01-01`, eind: `${jaar - 1}-12-31` },
  ];

  // Haal transactieregels op voor één rekening, met een harde bovengrens op
  // het aantal pagina's. Meldt het expliciet als er is afgekapt — een stil
  // afgekapte telling leest als een compleet beeld terwijl het dat niet is.
  const MAX_PAGINAS = 5, PER_PAGINA = 100;
  async function sondeerRekening(rekeningNr, periode) {
    let bekeken = 0, afgekapt = false, totaal = null;
    const relaties = new Set();
    for (let p = 0; p < MAX_PAGINAS; p++) {
      const res = await api('/financial/transactions/filters/', sessie, {
        filters: { accounts: [String(rekeningNr)], dateStart: periode.start, dateEnd: periode.eind, settled: 1 },
        limit: PER_PAGINA,
        offset: p * PER_PAGINA,
      });
      totaal = res.nrTransactions ?? totaal;
      const trans = res.transactions || [];
      bekeken += trans.length;
      trans.forEach(t => (t.transactionRows || t.rows || []).forEach(r => {
        if (String(r.accountNr) === String(rekeningNr) && r.relationNr) relaties.add(String(r.relationNr));
      }));
      if (trans.length < PER_PAGINA) break;
      if (p === MAX_PAGINAS - 1 && bekeken < (totaal ?? 0)) afgekapt = true;
    }
    return { totaal, bekeken, relaties: relaties.size, afgekapt };
  }

  log('## Sonde: is lidmaatschap financieel gemodelleerd?');
  log('');
  log('_De relatieadministratie legt lidmaatschap nergens vast. Deze sonde toetst of');
  log('"lid zijn" volgt uit wie er contributie geboekt krijgt._');
  log('');

  // Kies de relevante opbrengstrekeningen, maar sla de TEST:-varianten over —
  // die vertekenen het beeld en horen bij een parallelle proefopzet.
  const interessant = rekeningen.filter(r => {
    const naam = String(r.accountName ?? r.description ?? '');
    if (/^TEST:/i.test(naam.trim())) return false;
    return /contributie|jaarplaats|kantine|entree|gasten/i.test(naam);
  });

  if (!rekeningen.length) {
    log('_Geen rekeningen beschikbaar — sonde overgeslagen._');
  } else if (!interessant.length) {
    log('_Geen rekeningen gevonden die op contributie/jaarplaatsen/kantine lijken._');
  } else {
    for (const periode of perioden) {
      log(`### ${periode.naam}`);
      log('');
      log('| rekening | omschrijving | transacties | unieke relaties |');
      log('|---|---|---|---|');
      for (const r of interessant) {
        const nr = r.accountNr ?? r.number;
        try {
          const s = await sondeerRekening(nr, periode);
          const telling = s.afgekapt
            ? `${s.relaties}+ (op ${s.bekeken} van ${s.totaal} bekeken)`
            : String(s.relaties);
          log(`| ${nr} | ${r.accountName ?? r.description ?? ''} | ${s.totaal ?? '?'} | ${telling} |`);
        } catch (e) {
          log(`| ${nr} | ${r.accountName ?? r.description ?? ''} | _fout_ | |`);
          console.error(`  sonde op ${nr} (${periode.naam}) mislukt:\n${e.message}`);
        }
      }
      log('');
    }
    log(`_Per rekening zijn maximaal ${MAX_PAGINAS * PER_PAGINA} transacties doorlopen; waar dat`);
    log('niet genoeg was, staat er een "+" bij en is het aantal relaties een ondergrens._');
    log('');
  }

  // Facturen: als contributie per factuur gaat, zegt het aantal ontvangers
  // net zoveel. settled:1 = ook al betaalde facturen meetellen (default 0
  // toont alleen openstaande, en dat geeft een scheef beeld).
  log('### Facturen per jaar');
  log('');
  log('| periode | facturen |');
  log('|---|---|');
  for (const periode of perioden) {
    try {
      const res = await api('/financial/invoices/filters/', sessie, {
        filters: { dateStart: periode.start, dateEnd: periode.eind, settled: 1 },
        limit: 1,
      });
      log(`| ${periode.naam} | ${res.nrInvoices ?? '?'} |`);
    } catch (e) {
      log(`| ${periode.naam} | _fout_ |`);
      console.error(`  facturen ${periode.naam} mislukt:\n${e.message}`);
    }
  }
  log('');

  fs.writeFileSync(RAPPORT, regels.join('\n') + '\n', 'utf8');
  console.log(`\n── Rapport weggeschreven naar ${RAPPORT} ──`);
}

// process.exit() laat de readline-interface openstaan, waardoor het script na
// een foutmelding blijft hangen op een prompt die er niet meer is.
main()
  .catch(e => { console.error('\nOnverwachte fout:', e.message); process.exitCode = 1; })
  .finally(() => { if (_rl) _rl.close(); });
