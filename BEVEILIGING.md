# Beveiliging — kassa-app

Naar aanleiding van de code-review van 2026-08-29. Dit bestand beschrijft de
doorgevoerde maatregelen, wat er beheersmatig moet gebeuren, en wat er nog open
staat.

## Doorgevoerd in code (deze commit)

| # | Wat | Bestand |
|---|-----|---------|
| K4 | `syncWachtrij()` heeft een in-flight guard — geen twee overlappende sync-runs meer (voorkwam dubbele/ontbrekende `consumptie_regels` en stale `openstaand`-overschrijvingen) | `db.js` |
| K6 | Definitief mislukte sync-items (na 5 pogingen) worden nu **zichtbaar en blijvend** getoond i.p.v. alleen een `console.warn`; `verzamelMislukteSync()` / `herprobeerMislukteSync()` voor reconciliatie | `db.js` |
| K8 | Printer-URL en -sleutel worden **niet meer via Supabase gesynchroniseerd** — blijven lokaal per tablet (de sleutel opent ook de kassalade en was via de anon-key leesbaar/overschrijfbaar). Elke tablet één keer instellen via Beheer → Printer | `db.js` |
| K9 | XSS-hardening: prijs in de artikelknop via `Number()`; nieuwe `jsStr()` voor waarden in inline `on*`-handlers; bandje-UID- en pleknummer-validatie bij het koppelen; `esc()`/`jsStr()` op de bandje/plek-render | `index.html` |
| K10 | Printserver strip't control-characters uit naam/plek/artikel vóór het printen (ESC/POS-injectie) | `printserver/server.py` |
| K14 | Printserver `MAX_CONTENT_LENGTH = 64 KB` | `printserver/server.py` |
| K15 | `PRIMAIRE_SLEUTEL.producten` expliciet | `db.js` |
| K16 | Hardcoded Supabase-URL vervangen door de `SUPABASE_URL`-constante | `index.html` |
| K1a | SQL-migratie om `printer_instellingen` dicht te zetten | `supabase/migrations/20260829_01_*.sql` |
| K17 | SQL-migratie om de plaintext `pincode`-kolom te droppen | `supabase/migrations/20260829_02_*.sql` |

## Nog handmatig doen (buiten deze repo)

1. **K1 — RLS + schema exporteren en committen.** Zie `supabase/migrations/README.md`.
2. **K1a — migratie draaien** (`20260829_01_...sql`) in de Supabase SQL-editor.
3. **K17 — migratie draaien** (`20260829_02_...sql`) — eerst de Edge Functions
   `controleer-pin` en `stel-pin` controleren op `pincode`-gebruik.
4. **Reserveringsapp:** `KASSA_APP_ORIGIN` env-var op het exacte kassa-domein
   zetten in Vercel (R1), daarna deployen. Zonder die env blijft CORS `*`.
5. **Printserver:** bij een verse install `PRINTSERVER_ALLOWED_ORIGIN` in `.env`
   op het kassa-domein zetten i.p.v. `*`.

## Een tablet intrekken (K13)

`activeer-apparaat` geeft een langlevende Supabase refresh-token die in
`localStorage` (`kr_kassa_tokens`) van de tablet staat. Bij verlies of diefstal
van een tablet, of een vermoeden van misbruik:

1. **Supabase-dashboard → Authentication → Users** → zoek de gebruiker die bij
   dit apparaat hoort (de device-activering maakt/gebruikt een auth-user) →
   **Revoke sessions** (of verwijder de user).
2. Roteer zo nodig de **device-activatiesleutel** die `activeer-apparaat`
   accepteert (in de Edge Function / de bijbehorende secret), zodat een
   gelekte sleutel niet opnieuw gebruikt kan worden.
3. De ingetrokken tablet valt bij de eerstvolgende token-refresh terug op het
   setup-scherm en kan niet meer bij de data.

## Nog open (grotere posten — plannen, met tests)

- **K1b** — `authenticated` heeft `FOR ALL USING(true)` op álle tabellen; de
  hele grens is één gedeeld apparaat-credential + client-JS. Schrijfacties
  horen achter Edge Functions met server-side autorisatie, of per-rij/per-plek
  gescoped. Doe dit samen met de samenvoeging met de Next-app
  (`KASSA_INTEGRATIE.md`).
- **K3** — contant/afrekenen is client-autoritatief (`gastRekentAf()` /
  `afrekenen()` schrijven een door de client berekend bedrag). Alleen QR/Mollie
  is server-autoritatief. Route contant afrekenen via een server-endpoint dat
  het bedrag uit `consumptie_log` herleidt, met de tablet-JWT.
- **K5** — de kassa schrijft `leden.openstaand` met een volledige-rij-upsert
  (last-write-wins), terwijl de reserveringsapp CAS gebruikt. Laat de kassa
  `openstaand` nooit direct schrijven — herleiden uit `consumptie_log −
  betalingen`, of een RPC met CAS.
- **K7** — `verwerkGeslaagdeKassaBetaling`: geld ontvangen maar niet
  bijgeschreven levert alleen een `console.error`. Persistente "handmatige
  reconciliatie"-status + Pushover-melding.
- **K12** — geldbedragen als float, inconsistent afgerond. In centen rekenen,
  of consequent afronden op elke grens (scherm/bon/server).
