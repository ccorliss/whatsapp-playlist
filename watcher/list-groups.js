#!/usr/bin/env node
// Phase 1: enumerate every group Curtis is in, save to groups.json.

const fs = require('fs');
const path = require('path');
const { buildClient, ROOT } = require('./lib/client');

const OUT = path.join(ROOT, 'groups.json');

const client = buildClient({ headless: true });

client.on('qr', () => {
  console.error('Not logged in. Run: npm run login first.');
  process.exit(2);
});

client.on('ready', async () => {
  console.log('Fetching chats...');
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);

  const out = [];
  for (const g of groups) {
    const lastTs =
      g.lastMessage && g.lastMessage.timestamp
        ? g.lastMessage.timestamp * 1000
        : g.timestamp
          ? g.timestamp * 1000
          : null;
    let participantCount = null;
    try {
      participantCount =
        (g.groupMetadata && g.groupMetadata.participants && g.groupMetadata.participants.length) ||
        null;
    } catch (_) {}

    out.push({
      id: g.id._serialized,
      name: g.name || '(unnamed)',
      participantCount,
      lastMessageAt: lastTs ? new Date(lastTs).toISOString() : null,
      unreadCount: g.unreadCount || 0,
      watch: false,
    });
  }

  out.sort((a, b) => {
    const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bt - at;
  });

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} groups → ${OUT}`);
  for (const g of out) {
    console.log(`  - ${g.name}  [${g.participantCount ?? '?'}]  ${g.lastMessageAt ?? ''}`);
  }

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  process.exit(1);
});

console.log('Initializing client...');
client.initialize();
