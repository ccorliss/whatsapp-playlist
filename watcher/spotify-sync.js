#!/usr/bin/env node
/**
 * spotify-sync.js
 *
 * Syncs playlist tracks to Spotify via Playwright browser automation.
 * Fetches tracks from the Cloudflare API (no local database needed).
 *
 * First run — authenticate (headed browser, handles Apple 2FA interactively):
 *   node spotify-sync.js --auth
 *
 * Sync new tracks (headless):
 *   node spotify-sync.js [--dry-run]
 *
 * Config — set in .env or environment:
 *   RADIO_API_URL     your Cloudflare Pages URL  (required)
 *   SPOTIFY_APPLE_ID  Apple ID email for Spotify login  (required)
 *   SPOTIFY_APPLE_PW  Apple ID password  (required)
 *   SPOTIFY_PLAYLIST  Spotify playlist name to sync into  (default: "Music Fellowship")
 */

'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const RADIO_API_URL    = (process.env.RADIO_API_URL || '').replace(/\/$/, '');
const APPLE_ID         = process.env.SPOTIFY_APPLE_ID || '';
const APPLE_PW         = process.env.SPOTIFY_APPLE_PW || '';
const PLAYLIST_NAME    = process.env.SPOTIFY_PLAYLIST || 'Music Fellowship';
const SESSION_FILE     = path.join(__dirname, '.spotify-session.json');
const SYNCED_FILE      = path.join(__dirname, '.spotify-synced.json');

if (!RADIO_API_URL) { console.error('RADIO_API_URL not set'); process.exit(1); }
if (!APPLE_ID || !APPLE_PW) { console.error('SPOTIFY_APPLE_ID / SPOTIFY_APPLE_PW not set'); process.exit(1); }

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function loadSynced() {
  try { return new Set(JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}

function saveSynced(set) {
  fs.writeFileSync(SYNCED_FILE, JSON.stringify([...set], null, 2));
}

async function fetchTracks() {
  const r = await fetch(`${RADIO_API_URL}/api/radio/all`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  const data = await r.json();
  const tracks = data.tracks || data;
  return tracks
    .filter(t => t.spotify_url && t.spotify_url.includes('spotify.com/track/'))
    .map(t => {
      const m = t.spotify_url.match(/track\/([A-Za-z0-9]+)/);
      return m ? { ...t, trackId: m[1] } : null;
    })
    .filter(Boolean);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function makeContext(browser, withSession = false) {
  const opts = { viewport: { width: 1280, height: 800 }, userAgent: UA, locale: 'en-US' };
  if (withSession && fs.existsSync(SESSION_FILE)) opts.storageState = SESSION_FILE;
  return browser.newContext(opts);
}

async function login(page, context) {
  log('Logging in to Spotify via Apple ID...');
  await page.goto('https://accounts.spotify.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const appleBtn = page.locator('button:has-text("Continue with Apple"), [data-testid="apple-login-button"]').first();
  await appleBtn.waitFor({ timeout: 10000 });
  await appleBtn.click();

  await page.waitForURL(/appleid\.apple\.com/, { timeout: 15000 });
  await page.waitForTimeout(1500);

  await page.locator('#account_name_text_field, input[type="email"]').first().fill(APPLE_ID);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.locator('#password_text_field, input[type="password"]').first().fill(APPLE_PW);
  await page.keyboard.press('Enter');

  log('Credentials submitted. Complete any 2FA in the browser window...');
  await page.waitForURL(/open\.spotify\.com/, { timeout: 180000 });
  await page.waitForTimeout(2000);
  log('Logged in.');
  await context.storageState({ path: SESSION_FILE });
  log('Session saved.');
}

async function ensureLoggedIn(page, context) {
  await page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const needsLogin = await page.locator('[data-testid="topbar-login-button"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (needsLogin) {
    log('Session expired — re-authenticating...');
    await login(page, context);
  } else {
    log('Session valid.');
  }
}

async function addTrackToPlaylist(page, track) {
  await page.goto(`https://open.spotify.com/track/${track.trackId}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const moreSelectors = [
    `button[aria-label*="More options for ${track.title}"]`,
    `button[aria-label*="More options"]`,
    '[data-testid="more-button"]',
    'button[aria-haspopup="menu"]',
  ];
  let clicked = false;
  for (const sel of moreSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); clicked = true; break; }
    } catch (_) {}
  }
  if (!clicked) throw new Error('Could not find "More options" button');
  await page.waitForTimeout(800);

  await page.locator('[role="menuitem"]').filter({ hasText: /add to playlist/i }).first().click();
  await page.waitForTimeout(600);
  await page.locator('[role="menuitem"], [role="option"]').filter({ hasText: PLAYLIST_NAME }).first().click();
  await page.waitForTimeout(1000);
}

async function runAuth() {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await makeContext(browser, false);
  const page = await context.newPage();
  await login(page, context);
  await browser.close();
  log('Auth complete. Run without --auth to sync.');
}

async function runSync(dryRun = false) {
  const tracks = await fetchTracks();
  const synced = loadSynced();
  const toAdd  = tracks.filter(t => !synced.has(t.trackId));

  log(`Tracks with Spotify URL: ${tracks.length} | Already synced: ${synced.size} | To add: ${toAdd.length}`);
  if (!toAdd.length) { log('Nothing to sync.'); return; }

  if (dryRun) {
    toAdd.forEach(t => log(`  would add: ${t.artist || '?'} — ${t.title || t.trackId}`));
    return;
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await makeContext(browser, true);
  const page    = await context.newPage();

  await ensureLoggedIn(page, context);

  let ok = 0, fail = 0;
  for (const track of toAdd) {
    try {
      await addTrackToPlaylist(page, track);
      synced.add(track.trackId);
      saveSynced(synced);
      ok++;
      log(`✓ ${track.artist || '?'} — ${track.title || track.trackId}`);
    } catch (e) {
      fail++;
      log(`✗ ${track.artist || '?'} — ${track.title || track.trackId}: ${e.message}`);
    }
    await page.waitForTimeout(2000 + Math.floor(Math.random() * 1000));
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();
  log(`Done. Added: ${ok} | Failed: ${fail}`);
  if (fail > 0) process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--auth')) runAuth().catch(e => { log('AUTH ERROR:', e.message); process.exit(1); });
else runSync(args.includes('--dry-run')).catch(e => { log('SYNC ERROR:', e.message); process.exit(1); });
