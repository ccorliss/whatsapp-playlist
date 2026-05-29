#!/usr/bin/env node
/**
 * backfill-chat.js
 *
 * Reads existing JSONL message files and pushes them to /api/radio/ingest-messages
 * so historical conversation context shows up in D1.
 *
 * Only processes groups tagged "music" in groups.json.
 *
 * Usage:
 *   node backfill-chat.js              # backfill all music group messages
 *   node backfill-chat.js --dry-run    # count without sending
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const RADIO_API_URL = (process.env.RADIO_API_URL || '').replace(/\/$/, '');
const MSG_ROOT      = path.join(__dirname, 'messages');
const GROUPS_FILE   = path.join(__dirname, 'groups.json');
const DRY_RUN       = process.argv.includes('--dry-run');
const BATCH_SIZE    = 50;

if (!RADIO_API_URL) { console.error('RADIO_API_URL not set'); process.exit(1); }

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

function loadMusicGroups() {
  try {
    const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return groups.filter(g => g.watch && g.tag === 'music').map(g => g.id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  } catch (_) { return []; }
}

async function postBatch(messages) {
  if (DRY_RUN) return;
  const payload = JSON.stringify({ messages });
  const url = new URL('/api/radio/ingest-messages', RADIO_API_URL);
  const r = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const musicGroupIds = loadMusicGroups();
  if (!musicGroupIds.length) { log('No music groups found in groups.json'); return; }
  log(`Music groups: ${musicGroupIds.join(', ')}`);

  let total = 0, sent = 0, batch = [];

  for (const groupId of musicGroupIds) {
    const dir = path.join(MSG_ROOT, groupId);
    if (!fs.existsSync(dir)) { log(`No messages dir for ${groupId}`); continue; }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    log(`${groupId}: ${files.length} day files`);

    for (const file of files) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          if (!m.body && !m.hasMedia) continue;
          batch.push({
            message_id:   m.id,
            author:       m.authorName || m.author || null,
            body:         m.body || '',
            timestamp_ms: m.timestamp,
            reply_to_id:  m.replyTo || null,
            group_id:     m.groupId,
          });
          total++;
          if (batch.length >= BATCH_SIZE) {
            if (!DRY_RUN) {
              const result = await postBatch(batch);
              sent += result?.stored || 0;
            }
            batch = [];
            process.stdout.write('.');
          }
        } catch (_) {}
      }
    }
  }

  // Final batch
  if (batch.length) {
    if (!DRY_RUN) {
      const result = await postBatch(batch);
      sent += result?.stored || 0;
    }
  }

  console.log('');
  if (DRY_RUN) {
    log(`DRY RUN — would send ${total} messages`);
  } else {
    log(`Done. Total: ${total} | Stored in D1: ${sent}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
