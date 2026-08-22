#!/usr/bin/env node
/**
 * Eenmalig bootstrap-script: genereer een bcrypt-hash van een beheerder-pincode
 * en geef de kant-en-klare SQL-update terug om in de Supabase SQL-editor te plakken.
 *
 * Gebruik:
 *   node scripts/hash-pin.js
 *
 * Vereist: npm install bcryptjs  (eenmalig in deze map)
 */

let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch {
  console.error('Voer eerst uit: npm install bcryptjs');
  process.exit(1);
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Voer de nieuwe beheerder-pincode in: ', async (pin) => {
  pin = pin.trim();
  if (!pin) { console.error('Geen pincode ingevoerd.'); rl.close(); return; }

  const hash = await bcrypt.hash(pin, 12);

  console.log('\n── SQL (plak dit in de Supabase SQL-editor) ─────────────────────────────');
  console.log(`UPDATE leden SET pincode_hash = '${hash}' WHERE uid = '<UID-VAN-BEHEERDER>';`);
  console.log('─────────────────────────────────────────────────────────────────────────');
  console.log('\nVervang <UID-VAN-BEHEERDER> door het uid uit de leden-tabel.');
  console.log('De pincode zelf staat nergens opgeslagen — bewaar hem goed.');
  rl.close();
});
