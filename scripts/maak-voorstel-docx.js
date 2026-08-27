#!/usr/bin/env node
/**
 * Zet voorstel-conscribo.html om naar een Word-document, zodat de
 * penningmeester het kan aanpassen voordat het rondgaat.
 *
 * Geen generieke HTML-naar-Word-conversie: de inhoud is met de hand
 * overgezet naar dezelfde structuur en huisstijl als het bestaande
 * bestuursdocument (zie krosenberg-reserveringen/build_bestuursdocument.js)
 * — groene huisstijl, Arial, kop-/voettekst met paginanummer. Bij een
 * volgende wijziging aan voorstel-conscribo.html moet dit bestand met de
 * hand worden bijgewerkt; het leest de HTML niet in.
 *
 * Gebruik:
 *   npm install docx   (eenmalig)
 *   node scripts/maak-voorstel-docx.js
 *
 * Schrijft: Voorstel-Conscribo-koppeling.docx
 */

const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, Header, Footer, VerticalAlign,
} = require("docx");

const ACCENT = "2E7D32";   // groen, zelfde als het bestaande bestuursdocument
const FLAG   = "9C3A24";   // "te bevestigen" — roodbruin
const WARN   = "7A5410";   // "bewuste keuze" — oker
const FLAG_BG = "F8ECE7";
const WARN_BG = "F7F0DD";
const MUTED_BG = "F1F8F2";

const border = { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

// ── Kleine bouwstenen ────────────────────────────────────────────────────────

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}

// Eén stukje tekst in een run-specificatie: string (platte tekst) of
// {text, bold, italic, code} voor gemengde opmaak binnen één alinea —
// zo blijft <strong>/<em>/<code> uit de HTML behouden bij het overtypen.
function toRun(part) {
  if (typeof part === "string") return new TextRun(part);
  const { text, bold, italic, code } = part;
  if (code) {
    return new TextRun({ text, font: "Consolas", size: 19, shading: { fill: "EFEBDD", type: ShadingType.CLEAR } });
  }
  return new TextRun({ text, bold: !!bold, italics: !!italic });
}
function runs(parts) {
  return parts.map(toRun);
}
function p(parts, opts = {}) {
  return new Paragraph({ spacing: { after: 160 }, children: runs(Array.isArray(parts) ? parts : [parts]), ...opts });
}
function bullet(parts) {
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 }, children: runs(parts) });
}

// Kaderde alinea (roept de CSS-"callout" op): label in kleine kapitalen,
// gevolgd door de tekst, met een gekleurde linkerrand en lichte achtergrond.
function callout(label, parts, kind) {
  const kleur = kind === "gat" ? FLAG : kind === "keuze" ? WARN : "888888";
  const bg = kind === "gat" ? FLAG_BG : kind === "keuze" ? WARN_BG : "F5F5F0";
  const zijrand = { style: BorderStyle.SINGLE, size: 24, color: kleur, space: 8 };
  const gedeeld = { border: { left: zijrand }, shading: { fill: bg, type: ShadingType.CLEAR } };
  return [
    new Paragraph({
      ...gedeeld, spacing: { before: 120, after: 40 },
      children: [new TextRun({ text: label.toUpperCase(), bold: true, size: 17, color: kleur, characterSpacing: 10 })],
    }),
    new Paragraph({ ...gedeeld, spacing: { after: 160 }, children: runs(parts) }),
  ];
}

function headerCell(text, w, align) {
  return new TableCell({
    borders, width: { size: w, type: WidthType.DXA }, margins: cellMargins,
    shading: { fill: ACCENT, type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: align, children: [new TextRun({ text, bold: true, color: "FFFFFF", size: 19 })] })],
  });
}
// Eén cel met gemengde opmaak (bold/code) via dezelfde run-specificatie als p().
function cell(parts, w, fill, align) {
  return new TableCell({
    borders, width: { size: w, type: WidthType.DXA }, margins: cellMargins,
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: align, children: runs(Array.isArray(parts) ? parts : [parts]) })],
  });
}

// Generieke tabel met N kolommen; colWidths in DXA (kolombreedtes tellen op tot 9360).
function tabel(headers, colWidths, rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA }, columnWidths: colWidths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map((r, i) => new TableRow({
        children: r.map((c, j) => cell(c, colWidths[j], i % 2 ? MUTED_BG : undefined)),
      })),
    ],
  });
}

// Journaalpost (T-rekening): Zijde | Rekening | Bedrag, debet/credit in kleur.
function journaal(titel, regels) {
  const W = 9360, c1 = 1400, c2 = 6060, c3 = 1900;
  const rijen = regels.map((r) => new TableRow({
    children: [
      cell({ text: r.zijde, bold: true, }, c1, undefined),
      cell(r.rekening, c2, undefined),
      cell({ text: r.bedrag }, c3, undefined, AlignmentType.RIGHT),
    ],
  }));
  return [
    new Paragraph({
      spacing: { before: 120, after: 0 },
      shading: { fill: "EFEBDD", type: ShadingType.CLEAR },
      children: [new TextRun({ text: titel, bold: true, size: 18, color: "555555" })],
    }),
    new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: [c1, c2, c3], rows: rijen }),
    new Paragraph({ spacing: { after: 160 }, children: [] }),
  ];
}

// Eén stap in de fasering: nummer + titel (met optioneel "klaar"-label) + omschrijving.
function fase(nr, titel, tekst, klaar) {
  return [
    new Paragraph({
      spacing: { before: 160, after: 20 },
      children: [
        new TextRun({ text: `${nr}. `, bold: true, color: ACCENT }),
        new TextRun({ text: titel, bold: true, size: 22 }),
        ...(klaar ? [new TextRun({ text: "  KLAAR", bold: true, size: 16, color: ACCENT })] : []),
      ],
    }),
    p(tekst, { indent: { left: 260 } }),
  ];
}

// ── Document ─────────────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal",
        run: { size: 48, bold: true, color: ACCENT, font: "Arial" },
        paragraph: { spacing: { after: 80 } } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, color: ACCENT, font: "Arial" },
        paragraph: { spacing: { before: 320, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•",
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } },
      children: [new TextRun({ text: "Naturistenvereniging Krösenberg — Van bon naar grootboek", size: 16, color: "777777" })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Pagina ", size: 16, color: "777777" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "777777" })],
    })] }) },
    children: [
      new Paragraph({ style: "Title", children: [new TextRun("Van bon naar grootboek")] }),
      p({ text: "Voorstel · Naturistenvereniging Krösenberg", italic: true }),
      p({ text: "Hoe de omzet uit de kassa-app en de reserveringen-app in Conscribo terechtkomt, zonder dat de penningmeester een bedrag overtypt.", italic: true }, { spacing: { after: 260 } }),

      h1("Wat dit oplost"),
      p("Vandaag ontstaan de inkomsten op twee plekken — achter de bar en op het reserveringsscherm — en belanden ze via een omweg van lijstjes en optelsommen in Conscribo. Elke overzetting is werk, en elk werk is een kans op een typefout."),
      p([
        "Het voorstel: beide apps leveren hun omzet als ", { text: "kant-en-klare dagstaat", bold: true },
        " aan. De penningmeester ziet die in één scherm, controleert, en drukt op boeken. Wil ze het later helemaal automatisch, dan is dat één instelling — maar we beginnen bewust met de hand aan het stuur.",
      ]),

      h1("Drie systemen, drie rollen"),
      p([
        "De verkenning van de Conscribo-administratie leverde één inzicht op dat alles eenvoudiger maakt: Conscribo is bij jullie ", { text: "geen", italic: true },
        " ledenadministratie. De relatiekant is kaal — 53 relaties, geen lidmaatschapsvelden, geen groepen — terwijl het grootboek juist uitgebreid en precies is. Conscribo doet geld. Daarmee valt het lastigste deel van een koppeling gewoon weg.",
      ]),
      tabel(
        ["Rol", "Systeem", "Wat het doet"],
        [1600, 2000, 5760],
        [
          [{ text: "Wie is lid", bold: true }, "Reserveringen-app", "Een ledenlijst — naam en e-mailadres — gekoppeld aan een pleknummer. Wie daarin voorkomt, is lid; wie niet, is gast. Dit is de enige plek waar dat onderscheid vandaan komt."],
          [{ text: "Wie mag kamperen", bold: true }, "NFN", "Elke bezoeker — lid én gast — moet NFN-lid zijn om te mogen kamperen. Dat nummer zegt dus niets over Krösenberg-lidmaatschap en speelt in deze koppeling geen rol."],
          [{ text: "Wat kost het", bold: true }, "Conscribo", "Ontvangt uitsluitend geld: dagstaten op de bestaande grootboekrekeningen. Geen namen, geen ledenbestand."],
        ],
      ),
      p("De reserveringen-app kent hiervoor twee situaties, want niet elk lid heeft een vaste plek: er zijn meer (kandidaat-)leden dan vaste plekken, dus staan leden zonder plek op de wachtlijst, en daarnaast zijn er leden die bewust geen vaste plek willen en alleen contributie betalen, geen jaargeld.", { spacing: { before: 120, after: 160 } }),
      tabel(
        ["Situatie", "Hoe"],
        [3000, 6360],
        [
          [
            "Lid met een vaste plek",
            [
              "Krijgt automatisch een ", { text: "eigen, persoonlijk kassa-account", bold: true },
              " (naam en pleknummer, geen los endpoint nodig) zodra een beheerder in Beheer > Contributie de plek aan dat lid koppelt — bestond al, voor de contributiemodule. Er is dan nog wél een handmatige stap: een kassabeheerder moet zelf nog een NFC-bandje of -kaart aan dat account koppelen, precies zoals bij elk ander lid — daar verandert dit niets aan.",
            ],
          ],
          [
            "Lid zonder vaste plek, verblijft op een verhuurplek",
            [
              "Deelt de gedeelde kassarekening van die verhuurplek met iedereen die er ooit verblijft — er is geen eigen account. ",
              { text: "/api/kassa/ledenboekingen", code: true },
              " geeft aan of de vandaag actieve boeking op die plek ", { text: "via_lid", code: true }, " heeft, zodat de kassa het onderscheid alsnog kan maken.",
            ],
          ],
        ],
      ),
      p([
        { text: "/api/kassa/ledenboekingen", code: true },
        " geeft alleen pleknummers terug — nooit een naam of e-mailadres. Een lid zonder vaste plek identificeert zich bij de kassa altijd via een NFC-bandje of -kaart, nooit door zelf een pleknummer in te typen, dus dit endpoint hangt aan de plek van de boeking, niet aan een persoonlijke login.",
      ], { spacing: { before: 120 } }),

      h1("Eén koppeling, niet twee"),
      p("Beide apps draaien al op dezelfde Supabase-database. De koppeling hoort daar dus ook, en niet twee keer los in elke app. Dat scheelt niet alleen werk: de Conscribo-inloggegevens staan dan op één plek, serverzijdig, en nooit in een browser op een tablet achter de bar."),
      tabel(
        ["Onderdeel", "Waar", "Waarom daar"],
        [2400, 2400, 4560],
        [
          ["Dagstaat samenstellen", "Supabase", "Beide apps schrijven hun omzet daar al naartoe."],
          ["Boeken naar Conscribo", "Supabase edge function", "De inloggegevens blijven serverzijdig; de kassa-tablet raakt Conscribo nooit aan."],
          ["Controleren en akkoord geven", "Beheer van de reserveringen-app", "Daar logt de penningmeester al in, op een computer. De kassa is een kiosk achter de bar."],
        ],
      ),
      p("De kassa blijft dus offline gewoon werken. Of Conscribo bereikbaar is, maakt tijdens het tappen niets uit — er wordt pas geboekt als iemand daar op een rustig moment akkoord voor geeft.", { spacing: { before: 120 } }),

      h1("Het boekingsmodel: de dagstaat"),
      p("Een drukke zaterdag levert honderden losse consumpties op. Die stuk voor stuk naar het grootboek sturen zou de boekhouding onleesbaar maken. In plaats daarvan boeken we per dag één samengevatte transactie per bron — precies zoals een kantine dat met de hand ook zou doen."),

      h2("De kassa"),
      p([
        "De kassa houdt openstaande bedragen per persoon bij. Geld beweegt pas bij het afrekenen, en dát is het moment waarop we boeken. Elk artikel staat er al met een categorie — ",
        { text: "drank, eten, ijs, sauna, wasmachine/droger, overig", italic: true },
        " — juist omdat deze zes apart geboekt moeten kunnen worden. De dagstaat volgt die indeling: één transactie per dag, met per categorie een eigen creditregel in plaats van één totaalbedrag.",
      ]),
      ...journaal("Dagstaat kassa · 27-08-2026 · ref KASSA-2026-08-27", [
        { zijde: "Debet", rekening: [{ text: "10030 ", code: true }, "Kas kantine — contant"], bedrag: "184,50" },
        { zijde: "Debet", rekening: [{ text: "10025* ", code: true }, "Nog te ontvangen via Mollie — QR/iDEAL"], bedrag: "312,75" },
        { zijde: "Credit", rekening: [{ text: "83010 ", code: true }, "Kantine opbrengsten — drank"], bedrag: "301,40" },
        { zijde: "Credit", rekening: [{ text: "83020 ", code: true }, "Culicom opbrengsten — eten"], bedrag: "142,85" },
        { zijde: "Credit", rekening: [{ text: "84060 ", code: true }, "Sauna opbrengsten"], bedrag: "38,00" },
        { zijde: "Credit", rekening: [{ text: "84040 ", code: true }, "Wasmachine"], bedrag: "15,00" },
      ]),
      p([
        "De splitsing contant/QR heeft de kassa al, want die bepaalt ook of de kassalade opengaat. Er is geen aparte pinautomaat: de knop \"QR / iDEAL\" toont nu nog een neptest-QR-code, en wordt in productie een echte Mollie-betaling. * Het rekeningnummer hierboven is indicatief — er bestaat al een ",
        { text: "TEST: te ontvangen via Mollie", code: true }, ", maar nog geen live versie; zie verderop.",
      ]),
      ...callout("Twee dingen te bevestigen", [
        { text: "Sauna → 84060", bold: true }, " en ", { text: "wasmachine/droger → 84040", bold: true },
        " zijn eenduidig: elk heeft precies één rekening met die naam. ", { text: "Drank en eten", bold: true },
        " zijn dat niet — ik neem aan dat die naar 83010 Kantine respectievelijk 83020 Culicom gaan, maar weet niet zeker of dat de bedoelde verdeling is of dat \"Culicom\" iets specifieks aanduidt (bijvoorbeeld een aparte kookactiviteit, los van wat er als \"eten\" over de toonbank gaat). En voor ",
        { text: "ijs", bold: true }, " en ", { text: "overig", bold: true },
        " is er geen voor de hand liggende rekening — die moeten ergens landen, al is het voorlopig op een verzamelrekening.",
      ], "gat"),
      ...callout("Bewuste keuze", [
        "De omzet valt op de dag van betálen, niet op de dag van consumeren. Wie de hele week aftapt en zondag afrekent, telt dus mee op zondag. Dat is voor een kantine heel normaal en scheelt een debiteurenadministratie per gast. De keerzijde: wat op 31 december nog openstaat, is dat jaar nog niet geboekt. De kassa kan daarvoor per jaareinde één totaalbedrag per categorie opleveren, zodat je dat met een memoriaalboeking rechttrekt.",
      ], "keuze"),
      ...callout("Een derde stroom, buiten de kassa om", [
        "Naast afrekenen aan de bar kan de gastendienst bij het uitchecken een openstaand kantinebedrag ook per betaallink versturen. Dat zet de kassarekening van de plek direct op nul; het geld komt daarna via Mollie binnen, en de betaling wordt bijgehouden in de reserveringen-app zelf (op de boeking, niet in de kassa's eigen betalingen-tabel). Deze omzet zit dus niet in de dagstaat van de kassa — die moet er apart bij, uit de reserveringen-app, anders verdwijnt hij stilzwijgend. Landt op dezelfde rekeningen als de kantine-dagstaat (83010/83020), via dezelfde Mollie-tussenrekening die hierna volgt.",
      ], "gat"),

      h2("Reserveringen"),
      p("Hier is het grootboek al verrassend goed voorbereid: er bestaan losse rekeningen per tariefsoort, met de prijs in de naam, en apart voor leden en gasten. Dat is precies de structuur die de reserveringen-app moet vullen."),
      tabel(
        ["Wat", "Gast", "Lid"],
        [4360, 2500, 2500],
        [
          ["Kampeerplek mét elektra", [{ text: "82011", code: true }, " GKE"], [{ text: "82021", code: true }, " LKE"]],
          ["Kampeerplek zonder elektra", [{ text: "82012", code: true }, " GK"], [{ text: "82022", code: true }, " LK"]],
          ["Overnachting volwassene", [{ text: "82013", code: true }, " GV"], [{ text: "82023", code: true }, " LV"]],
          ["Overnachting tiener", [{ text: "82014", code: true }, " GT"], [{ text: "82024", code: true }, " LT"]],
          ["Hond", [{ text: "82015", code: true }, " GH"], [{ text: "82025", code: true }, " LH"]],
          ["Logee of dagbezoek", [{ text: "82016", code: true }, " GLD"], [{ text: "82026", code: true }, " LLD"]],
        ],
      ),
      p("Of het de linker- of de rechterkolom wordt, hangt af van of de plek van de boeking gekoppeld is aan iemand uit de ledenlijst hierboven. Mét elektra of zonder volgt uit de plek zelf — de app weet dat al. Alle reserveringsbetalingen (aanbetaling, restbetaling, volledig) lopen al via een echte, webhook-bevestigde Mollie-betaling — geen demo zoals bij de kassa. Ook dat geld gaat eerst naar de Mollie-tussenrekening, niet rechtstreeks de bank in.", { spacing: { before: 120, after: 160 } }),
      ...callout("Hier moet de app ook worden uitgebreid", [
        "De reserveringen-app rekent nu met één getal aantal_personen en één bedrag_totaal. Om op bovenstaande rekeningen te kunnen boeken, moet een boeking gaan bijhouden hóéveel volwassenen, tieners, honden en logees erbij horen. Zonder die uitsplitsing kan de omzet alleen op één verzamelrekening landen, en verlies je het inzicht dat het huidige rekeningschema juist biedt.",
      ], "gat"),
      ...callout("Vervalt", [
        "Het oorspronkelijke ontwerp van de reserveringen-app bevat velden voor toeristenbelasting (toeristenbelasting_totaal per boeking en een tarief per seizoen). Als vereniging draagt Krösenberg die niet af, dus die velden blijven leeg en er hoeft in het grootboek niets voor te komen. Bij het uitbreiden van het datamodel kunnen ze meteen verdwijnen.",
      ], "plain"),

      h1("Van Mollie naar de bank"),
      p([
        "Mollie betaalt niet per transactie uit. Bedragen worden gebundeld — meestal dagelijks — en pas dagen later als één totaal op de bankrekening gestort, na aftrek van Mollie's eigen transactiekosten. Rechtstreeks naar ",
        { text: "10010 Bankrekening", code: true },
        " boeken zodra een klant \"betaald\" klikt, klopt dus op twee manieren niet: het bedrag is te hoog (kosten zitten er nog in) en het moment is te vroeg (het geld staat er nog niet).",
      ]),
      p("Daarom loopt elke Mollie-betaling via een tussenrekening: op het moment van betalen wordt de omzet erkend (zoals in de dagstaten hierboven), en pas als Mollie daadwerkelijk uitbetaalt, wordt die tussenrekening tegen de bank weggestreept."),
      ...journaal("Mollie-uitbetaling · 28-08-2026 · ref MOLLIE-2026-W35", [
        { zijde: "Debet", rekening: [{ text: "10010 ", code: true }, "Bankrekening"], bedrag: "841,25" },
        { zijde: "Debet", rekening: [{ text: "41030 ", code: true }, "Bankkosten — Mollie-transactiekosten"], bedrag: "8,75" },
        { zijde: "Credit", rekening: [{ text: "10025* ", code: true }, "Nog te ontvangen via Mollie"], bedrag: "850,00" },
      ]),
      p([
        "Dat ", { text: "850,00", code: true },
        " is de som van alle Mollie-betalingen die in die uitbetalingsperiode zijn bevestigd — kantine aan de kassa, kantine per betaallink, én reserveringen door elkaar, want het is aannemelijk dat er straks één Mollie-account voor beide apps wordt gebruikt en Mollie dat niet per bron uitsplitst. De tussenrekening hoort dus na elke uitbetaling weer op nul te staan; staat er iets op, dan is er een bevestigde betaling die nog niet is uitbetaald (normaal, tot de volgende ronde) of klopt er iets niet.",
      ]),
      ...callout("Bestaat al als TEST, nog niet als live rekening", [
        "Het grootboek heeft al 10025 TEST: te ontvangen via Mollie — kennelijk had iemand deze exacte constructie al voorzien. Er bestaat alleen nog geen niet-TEST versie; die moet worden aangemaakt voordat hier iets naartoe geboekt kan worden. Het rekeningnummer 10025* in de voorbeelden hierboven is een gok op basis van het patroon van de andere TEST-rekeningen — het echte nummer bepaal jij.",
      ], "gat"),
      ...callout("Twee soorten Mollie-betaling, verschillend bevestigd", [
        "Reserveringen (en de kantine-betaallink bij uitchecken) zijn al een ", { text: "echte", bold: true },
        " Mollie-betaling, bevestigd via Mollie's eigen webhook — pas als Mollie zelf \"betaald\" meldt, wordt de boeking als betaald gemarkeerd. De kassa's eigen QR-knop werkt nu nog anders: de medewerker achter de bar ziet de gast betalen en klikt zelf op \"Betaling ontvangen\", zonder dat de kassa ooit bij Mollie natrekt of dat bedrag ook echt is binnengekomen. Voor een bar met toezicht is dat waarschijnlijk prima, maar het is wel een lager bevestigingsniveau dan de rest — de moeite waard om je bewust van te zijn, ook al hoeft het geen showstopper te zijn.",
      ], "keuze"),

      h1("Wat de penningmeester ziet"),
      p("Eén scherm in het beheer, met de klaarstaande dagstaten. Niets gaat het grootboek in zonder dat hier iemand op heeft geklikt."),
      tabel(
        ["Regel", "Bedrag", "Status"],
        [5360, 2000, 2000],
        [
          ["Kassa — zaterdag 23 augustus", "€ 497,25", "geboekt"],
          ["Kassa — zondag 24 augustus", "€ 213,80", "Boeken"],
          ["Reserveringen — week 34", "€ 1.284,00", "Boeken"],
          ["Kassa — maandag 25 augustus", "€ 46,10", "dag loopt nog"],
          ["Mollie-uitbetaling — 28 augustus", "€ 841,25", "Boeken"],
        ],
      ),
      p("Eén regel per dag, ook al zit er drank, eten, sauna en wasserette in — doorklikken laat de creditregels per categorie zien, de onderliggende bonnen, en de journaalpost die eruit volgt. Zo is controleren geen kwestie van vertrouwen. Een geboekte regel toont het transactienummer uit Conscribo en is niet nog eens te boeken. De Mollie-uitbetaling staat er apart bij: die verschijnt pas zodra Mollie zelf een bedrag heeft overgemaakt, dus onregelmatiger dan de dagelijkse dagstaten.", { spacing: { before: 120 } }),

      h1("Waarom dit niet dubbel kan boeken"),
      p("Dat is het echte risico van zo'n koppeling: één keer te vaak op boeken drukken, of een edge function die het na een storing nog eens probeert. Dubbele omzet in het grootboek is vervelend werk om terug te draaien. Er zitten daarom drie sloten op."),
      tabel(
        ["Slot", "Werking"],
        [2500, 6860],
        [
          ["Vaste referentie", [ "Elke dagstaat krijgt een voorspelbaar kenmerk, zoals ", { text: "KASSA-2026-08-27", code: true }, ". Dezelfde dag levert altijd hetzelfde kenmerk op." ]],
          ["Vooraf navragen", "Vlak voor het boeken vraagt de koppeling aan Conscribo of dat kenmerk daar al voorkomt. Zo ja: niet boeken."],
          ["Vastleggen achteraf", "Het transactienummer dat Conscribo teruggeeft, wordt bij de dagstaat bewaard. Een dagstaat met nummer is definitief afgehandeld."],
        ],
      ),
      p("Het middelste slot is het belangrijkste: dat werkt ook als onze eigen database iets niet heeft meegekregen, omdat het de vraag stelt aan de administratie zelf.", { spacing: { before: 120 } }),

      h1("Uitrol in stappen"),
      p([
        "In het grootboek staat al een complete parallelle set rekeningen met ", { text: "TEST:", code: true },
        " ervoor — ", { text: "83015", code: true }, " naast ", { text: "83010", code: true }, ", ",
        { text: "10035", code: true }, " naast ", { text: "10030", code: true },
        ", en zo verder. Iemand heeft dit dus al eens voorbereid. Dat is een cadeautje: we kunnen daarop proefdraaien zonder de echte cijfers te raken.",
      ]),
      ...fase(1, "Proefdraaien op de TEST-rekeningen",
        "De kassa-dagstaat, met alle vier de categorieën én de Mollie-tussenrekening, een paar weken naar de TEST-rekeningen boeken en naast de handmatige boeking leggen. Wijkt er iets af, dan kost dat niets. De bestaande TEST: te ontvangen via Mollie is hier meteen bruikbaar. Dit is ook het moment om te horen van wie die rekeningen zijn en of er al een plan achter zat."),
      ...fase(2, "Sauna en wasserette live",
        "Deze twee kunnen als eerste, want de rekeningen zijn eenduidig: 84060 en 84040 hebben elk maar één mogelijke betekenis. Geen aanname nodig, dus geen reden om te wachten — wel moet dan ook de live Mollie-tussenrekening bestaan, want ook deze categorieën komen deels per QR binnen."),
      ...fase(3, "Drank en eten live",
        "Zodra bevestigd is of 83010/83020 inderdaad drank/eten zijn en waar ijs en overig moeten landen, gaat de rest van de kassa-dagstaat ook naar het grootboek."),
      ...fase(4, "Ledenlijst en plekkoppeling",
        "Voor vaste plekken bestond dit al: de kassa krijgt automatisch een eigen account per lid zodra een plek wordt toegewezen. Voor leden zonder vaste plek op een verhuurplek is dat er nu ook, via /api/kassa/ledenboekingen. Dit was de voorwaarde voor de volgende stap: zonder dit kan geen enkele boeking als lid of gast worden herkend.", true),
      ...fase(5, "Reserveringen voorbereiden",
        "De uitsplitsing naar volwassenen, tieners, honden en logees in de app. Pas daarna boeken. Deze stap is groter dan de eerste twee samen."),
      ...fase(6, "Desgewenst automatisch",
        "Loopt het een seizoen goed, dan kan de dagstaat van gisteren 's nachts vanzelf worden geboekt. Het beheerscherm blijft bestaan als controle achteraf. Dit is een keuze, geen eindstation."),

      h1("Wat we van jou nodig hebben"),
      bullet([{ text: "Een aparte API-gebruiker in Conscribo", bold: true }, ", met schrijfrechten op de financiële administratie. Niet een persoonlijk account: die rechten moeten los in te trekken zijn."]),
      bullet([{ text: "Duidelijkheid over de TEST-rekeningen", bold: true }, ": lopend werk of restant van een eerdere poging?"]),
      bullet([{ text: "Bevestiging van de rekeningen voor drank en eten", bold: true }, ": is 83010 Kantine / 83020 Culicom inderdaad die verdeling, en waar horen ijs en overig — bestaande rekening of nieuwe?"]),
      bullet([{ text: "Een live rekening \"Nog te ontvangen via Mollie\"", bold: true }, ": er bestaat al een TEST-versie, maar geen live versie — welk rekeningnummer?"]),
      bullet([{ text: "Waar Mollie's transactiekosten geboekt worden", bold: true }, ": dit voorstel gaat uit van de bestaande 41030 Bankkosten, tenzij je een aparte regel wilt."]),
      bullet([{ text: "Een voorkeur voor het ritme", bold: true }, ": per dag boeken, of per week samengevat? Per dag geeft het fijnste beeld, per week het kortste lijstje."]),
      ...callout("Aanbeveling", [
        "Begin bij stap 1 en beslis pas over volledige automatisering als je een seizoen hebt gezien dat de bedragen kloppen. De winst zit niet in het wegautomatiseren van de laatste klik, maar in het verdwijnen van het overtypen.",
      ], "keuze"),

      new Paragraph({
        spacing: { before: 400 },
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 8 } },
        children: [new TextRun({
          text: "Opgesteld op basis van een read-only verkenning van de Conscribo-administratie en het datamodel van de reserveringen-app en de kassa-app (augustus 2026). Er is in Conscribo niets gewijzigd. Het endpoint /api/kassa/ledenboekingen in de reserveringen-app staat er al — puur leesend, geen bestaande route of tabel aangepast.",
          size: 17, color: "777777", italics: true,
        })],
      }),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const pad = "Voorstel-Conscribo-koppeling.docx";
  fs.writeFileSync(pad, buf);
  console.log(`✓ Geschreven: ${pad}`);
});
