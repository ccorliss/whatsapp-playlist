#!/usr/bin/env node
/**
 * sync-runner.js
 *
 * Polls the radio API for queued sync requests triggered from the admin UI
 * ("Queue Spotify Sync" button) and runs the appropriate sync script.
 *
 * Currently handles: spotify
 * YouTube and Apple Music sync directly from the Cloudflare Workers API — no Mac runner needed.
 *
 * Usage:
 *   node sync-runner.js          # poll every 60s
 *   node sync-runner.js --once   # check once and exit
 *
 * Requires RADIO_API_URL in .env
 */

'use strict';

require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');

const RADIO_API_URL = (process.env.RADIO_API_URL || '').replace(/\/$/, '');
const POLL_MS = 60 * 1000;

if (!RADIO_API_URL) { console.error('RADIO_API_URL not set'); process.exit(1); }

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function checkQueue() {
  let status;
  try {
    const r = await fetch(`${RADIO_API_URL}/api/radio/sync-status`);
    if (!r.ok) return;
    status = await r.json();
  } catch (e) {
    log('sync-status fetch failed:', e.message);
    return;
  }

  if (status.spotify?.requested) {
    log('Spotify sync requested — running...');
    try {
      execSync(`node ${path.join(__dirname, 'spotify-sync.js')}`, { stdio: 'inherit' });
      await fetch(`${RADIO_API_URL}/api/radio/sync-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotify', message: 'Sync complete' }),
      });
      log('Spotify sync complete, notified API.');
    } catch (e) {
      log('Spotify sync failed:', e.message);
      await fetch(`${RADIO_API_URL}/api/radio/sync-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotify', failed: true, message: e.message }),
      }).catch(() => {});
    }
  }
}

const args = process.argv.slice(2);

if (args.includes('--once')) {
  checkQueue().then(() => process.exit(0));
} else {
  log(`Polling for sync requests every ${POLL_MS / 1000}s...`);
  checkQueue();
  setInterval(checkQueue, POLL_MS);
}
