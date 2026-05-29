#!/usr/bin/env node
// Phase 2: persistent watcher.
// - Listens to messages in groups marked watch:true in groups.json
// - Stores one message per JSONL line in messages/<group-id>/<YYYY-MM-DD>.jsonl
// - Deduplicates by message id (loaded per file at startup of each write)
// - Saves audio attachments to messages/<group-id>/media/
// - For Audio Anonymous groups, also drops audio into ../aa_speakers/inbox/
//   so the existing pipeline can pick it up. (Upload to S3 happens in digest.js
//   or a manual review pass — not blindly auto-published.)

const fs = require('fs');
const path = require('path');
const https = require('https');
const { buildClient, ROOT } = require('./lib/client');

// ── Config ────────────────────────────────────────────────────────────────────
// Set RADIO_API_URL in environment or .env to point at your Cloudflare deployment.
// Groups tagged "music" in groups.json will have music URLs forwarded to the radio.
const RADIO_API_URL = (process.env.RADIO_API_URL || 'https://whatsapp-playlist.pages.dev').replace(/\/$/, '');

// URL patterns that indicate a music share
const MUSIC_URL_RE = /https?:\/\/(?:(?:www\.)?youtube\.com\/(?:watch|shorts)|youtu\.be\/|open\.spotify\.com\/|music\.apple\.com\/)[^\s<>"']*/gi;

// Forward music URLs from a message to the radio API
async function forwardMusicUrls(record) {
  const urls = (record.body || '').match(MUSIC_URL_RE);
  if (!urls || !urls.length) return;
  const items = urls.map(url => ({
    url,
    author: record.authorName || record.author || 'unknown',
    timestampISO: record.timestampISO,
  }));
  const payload = JSON.stringify({ items });
  const endpoint = new URL('/api/radio/import-urls', RADIO_API_URL);
  return new Promise(resolve => {
    const req = https.request(
      { hostname: endpoint.hostname, path: endpoint.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          log(`radio: forwarded ${items.length} URL(s) from ${record.authorName || 'unknown'} → HTTP ${res.statusCode}`);
          resolve();
        });
      }
    );
    req.on('error', e => { log('radio: forward error', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

const GROUPS_FILE = path.join(ROOT, 'groups.json');
const MSG_ROOT = path.join(ROOT, 'messages');
const AA_INBOX = path.join(ROOT, '..', 'aa_speakers', 'inbox');
const LOG_FILE = path.join(ROOT, 'logs', 'watcher.log');
const CONTACTS_FILE = path.join(ROOT, 'contacts.json');

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.mkdirSync(MSG_ROOT, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

function loadWatched() {
  if (!fs.existsSync(GROUPS_FILE)) return new Map();
  const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
  const map = new Map();
  for (const g of groups) {
    if (g.watch) map.set(g.id, g);
  }
  return map;
}

let watched = loadWatched();
log(`Loaded ${watched.size} watched groups`);

// In-memory contact lookup, persisted lazily.
let contacts = {};
try { if (fs.existsSync(CONTACTS_FILE)) contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch (_) {}
let contactsDirty = false;

function learnContact(authorId, authorName) {
  if (!authorId || !authorName) return;
  if (contacts[authorId] === authorName) return;
  contacts[authorId] = authorName;
  contactsDirty = true;
}

// Persist contacts every 60s if dirty.
setInterval(() => {
  if (!contactsDirty) return;
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
    contactsDirty = false;
    log(`contacts.json updated (${Object.keys(contacts).length} entries)`);
  } catch (e) { log('contacts save failed', e.message); }
}, 60000).unref?.();

// Re-read groups.json every 5 min so changes pick up without restart.
setInterval(() => {
  watched = loadWatched();
}, 5 * 60 * 1000).unref?.();

function dayPath(groupId, ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const dir = path.join(MSG_ROOT, sanitize(groupId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${y}-${m}-${day}.jsonl`);
}

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function alreadyWritten(file, msgId) {
  if (!fs.existsSync(file)) return false;
  // Cheap check: substring scan. Files stay small (one day of one group).
  try {
    const buf = fs.readFileSync(file, 'utf8');
    return buf.includes(`"id":"${msgId}"`);
  } catch (_) {
    return false;
  }
}

async function saveMedia(msg, groupId) {
  if (!msg.hasMedia) return null;
  let media;
  try {
    media = await msg.downloadMedia();
  } catch (e) {
    log('media download failed', msg.id?._serialized, e.message);
    return null;
  }
  if (!media || !media.data) return null;

  const mediaDir = path.join(MSG_ROOT, sanitize(groupId), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const ext = (media.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
  const baseId = sanitize(msg.id?._serialized || `m-${Date.now()}`);
  const filename = media.filename || `${baseId}.${ext}`;
  const fpath = path.join(mediaDir, filename);
  try {
    fs.writeFileSync(fpath, Buffer.from(media.data, 'base64'));
  } catch (e) {
    log('media write failed', fpath, e.message);
    return null;
  }

  // Mirror audio for AA groups into the AA inbox for review.
  const group = watched.get(groupId);
  const isAudio = (media.mimetype || '').startsWith('audio/');
  if (group && group.tag === 'audio-anonymous' && isAudio) {
    try {
      fs.mkdirSync(AA_INBOX, { recursive: true });
      const aaPath = path.join(AA_INBOX, filename);
      if (!fs.existsSync(aaPath)) fs.copyFileSync(fpath, aaPath);
      log('AA audio mirrored to inbox', aaPath);
    } catch (e) {
      log('AA mirror failed', e.message);
    }
  }

  return { path: fpath, mimetype: media.mimetype, filename };
}

async function handleMessage(msg) {
  try {
    const chat = await msg.getChat();
    if (!chat || !chat.isGroup) return;
    const gid = chat.id._serialized;
    if (!watched.has(gid)) return;

    const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
    const file = dayPath(gid, ts);
    const msgId = msg.id?._serialized || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
    if (alreadyWritten(file, msgId)) return;

    let mediaInfo = null;
    if (msg.hasMedia) mediaInfo = await saveMedia(msg, gid);

    let authorName = null;
    try {
      const contact = await msg.getContact();
      authorName = contact?.pushname || contact?.name || contact?.number || null;
    } catch (_) {}

    const record = {
      id: msgId,
      groupId: gid,
      groupName: chat.name,
      timestamp: ts,
      timestampISO: new Date(ts).toISOString(),
      from: msg.from,
      author: msg.author || null,
      authorName,
      type: msg.type,
      body: msg.body || '',
      hasMedia: !!msg.hasMedia,
      media: mediaInfo
        ? {
            path: path.relative(ROOT, mediaInfo.path),
            mimetype: mediaInfo.mimetype,
            filename: mediaInfo.filename,
          }
        : null,
      mentionedIds: msg.mentionedIds || [],
      isForwarded: !!msg.isForwarded,
      replyTo: msg.hasQuotedMsg ? (msg._data?.quotedStanzaID || null) : null,
    };

    fs.appendFileSync(file, JSON.stringify(record) + '\n');

    // Forward music URLs to radio if this is a music group
    const group = watched.get(gid);
    if (group && group.tag === 'music') {
      forwardMusicUrls(record).catch(e => log('forwardMusicUrls error', e.message));
    }

    // Learn lid -> name mapping from this message.
    if (msg.author) learnContact(msg.author, authorName);
  } catch (e) {
    log('handleMessage error', e.message);
  }
}

const client = buildClient({ headless: true });

// ============================================================================
// SAFETY: forbid any outbound message in this process. Watcher is read-only.
// ============================================================================
const FORBIDDEN_METHODS = ['sendMessage', 'sendText', 'reply'];
const origInit = client.initialize.bind(client);
client.initialize = async function safeInitialize() {
  await origInit();
  // After init, monkey-patch any send methods to throw if ever called.
  for (const m of FORBIDDEN_METHODS) {
    if (typeof client[m] === 'function') {
      client[m] = () => { throw new Error(`SAFETY: ${m} disabled in watcher — read-only mode.`); };
    }
  }
  log('SAFETY: watcher running in read-only mode — outbound disabled.');
};

client.on('qr', () => {
  log('QR requested but no session. Run: npm run login first.');
  process.exit(2);
});

client.on('ready', async () => {
  log('WhatsApp client ready, watching messages.');
});

client.on('authenticated', () => log('authenticated'));
client.on('auth_failure', (m) => { log('auth_failure', m); process.exit(1); });
client.on('disconnected', (r) => { log('disconnected', r); process.exit(1); });

client.on('message', handleMessage);
client.on('message_create', (msg) => {
  // Capture messages Curtis sends himself in watched groups too.
  if (msg.fromMe) handleMessage(msg);
});

process.on('SIGTERM', async () => {
  log('SIGTERM, shutting down');
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  log('SIGINT, shutting down');
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
});

log('Initializing WhatsApp client...');
client.initialize();
