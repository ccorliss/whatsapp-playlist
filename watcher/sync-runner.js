#!/usr/bin/env node
/**
 * sync-runner.js
 *
 * Automatically syncs new tracks to Spotify whenever the watcher picks them up.
 * Polls the radio API for tracks that haven't been synced yet and runs spotify-sync.js.
 *
 * No manual trigger needed — runs alongside the watcher as a background process.
 *
 * Usage:
 *   node sync-runner.js          # poll every 5 minutes
 *   node sync-runner.js --once   # check once and exit
 *
 * Requires RADIO_API_URL in .env
 */

'use strict';

require('dotenv').config();
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const RADIO_API_URL = (process.env.RADIO_API_URL || '').replace(/\/$/, '');
const POLL_MS       = 5 * 60 * 1000; // 5 minutes
const SYNCED_FILE   = path.join(__dirname, '.spotify-synced.json');

if (!RADIO_API_URL) { console.error('RADIO_API_URL not set'); process.exit(1); }

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function loadSynced() {
  try { return new Set(JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}

async function hasNewTracks() {
  try {
    const r = await fetch(`${RADIO_API_URL}/api/radio/all`);
    if (!r.ok) return false;
    const data = await r.json();
    const tracks = data.tracks || data;
    const synced = loadSynced();
    return tracks.some(t => {
      if (!t.spotify_url || !t.spotify_url.includes('spotify.com/track/')) return false;
      const m = t.spotify_url.match(/track\/([A-Za-z0-9]+)/);
      return m && !synced.has(m[1]);
    });
  } catch (e) {
    log('API check failed:', e.message);
    return false;
  }
}

async function callCfSync(type) {
  try {
    const r = await fetch(`${RADIO_API_URL}/api/radio/${type}-sync`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    log(`${type} CF sync: HTTP ${r.status}`, d.ok ? `added=${d.added||0}` : (d.error||''));
    return d;
  } catch (e) {
    log(`${type} CF sync failed:`, e.message);
  }
}

async function check() {
  if (!await hasNewTracks()) return;
  log('New unsynced tracks found — running all syncs...');

  // Spotify: Playwright adds new tracks, then CF API does full reorder (newest first)
  try {
    execSync(`node ${path.join(__dirname, 'spotify-sync.js')}`, { stdio: 'inherit' });
    const synced = loadSynced();
    log(`Spotify Playwright sync complete. Total synced: ${synced.size}`);
    // Full CF reorder to keep playlist newest-first
    const sd = await callCfSync('spotify');
    if (sd?.ok) {
      await fetch(`${RADIO_API_URL}/api/radio/sync-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotify', added: synced.size, at: new Date().toISOString() }),
      }).catch(() => {});
    }
  } catch (e) {
    log('Spotify sync failed:', e.message);
  }

  // YouTube: call CF sync endpoint (uses stored OAuth)
  await callCfSync('youtube');

  // Apple Music: call CF sync endpoint (uses stored user token)
  const ad = await callCfSync('apple');
  if (ad?.ok) {
    await fetch(`${RADIO_API_URL}/api/radio/sync-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'apple', added: ad.added, at: new Date().toISOString() }),
    }).catch(() => {});
  }
}

const args = process.argv.slice(2);

if (args.includes('--once')) {
  check().then(() => process.exit(0));
} else {
  log(`Watching for new Spotify tracks (polling every ${POLL_MS / 1000 / 60} min)...`);
  check();
  setInterval(check, POLL_MS);
}
