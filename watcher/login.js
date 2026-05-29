#!/usr/bin/env node
// Phase 1: print QR until Curtis scans, then exit cleanly.
// Run once. Session is persisted in .wwebjs_auth/.

const qrcode = require('qrcode-terminal');
const { buildClient } = require('./lib/client');

const client = buildClient({ headless: true });

let scanned = false;

client.on('qr', (qr) => {
  console.log('\nScan this QR with WhatsApp on your phone:');
  console.log('(WhatsApp → Settings → Linked Devices → Link a Device)\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  scanned = true;
  console.log('\n✅ Authenticated. Saving session...');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  console.log('✅ Client ready. You can now run: npm run list');
  // Give LocalAuth a moment to flush session files.
  setTimeout(async () => {
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  }, 2000);
});

client.on('disconnected', (reason) => {
  if (!scanned) {
    console.error('Disconnected before scan:', reason);
    process.exit(1);
  }
});

console.log('Initializing WhatsApp Web client (this can take ~30s on first run)...');
client.initialize();
