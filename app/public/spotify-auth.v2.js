// Spotify PKCE auth + playlist export for GUTS Radio (Option B).
// Runs entirely in the browser — no server involvement.
// Users authenticate with their own Spotify account and export the current
// filtered playlist directly into their library.
//
// Usage: call SpotifyAuth.exportPlaylist(filter, tracks)

const SpotifyAuth = (() => {
  // !! Set this to your Spotify App Client ID !!
  const CLIENT_ID = window.SPOTIFY_CLIENT_ID || '';
  const REDIRECT_URI = window.location.origin + window.location.pathname;
  const SCOPES = 'playlist-modify-public playlist-modify-private playlist-read-private';
  const LS_TOKEN_KEY  = 'guts_spotify_token';
  const LS_VERIFIER_KEY = 'guts_spotify_verifier';
  const LS_STATE_KEY  = 'guts_spotify_state';

  // ── PKCE helpers ────────────────────────────────────────────────────────────
  function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(n => chars[n % chars.length]).join('');
  }

  async function sha256(plain) {
    const enc = new TextEncoder().encode(plain);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── Token management ────────────────────────────────────────────────────────
  function loadToken() {
    try { return JSON.parse(localStorage.getItem(LS_TOKEN_KEY) || 'null'); } catch(_) { return null; }
  }

  function saveToken(t) {
    localStorage.setItem(LS_TOKEN_KEY, JSON.stringify(t));
  }

  function clearToken() {
    localStorage.removeItem(LS_TOKEN_KEY);
    localStorage.removeItem(LS_VERIFIER_KEY);
    localStorage.removeItem(LS_STATE_KEY);
  }

  function isTokenValid(t) {
    return t && t.access_token && Date.now() < (t.expiry || 0);
  }

  async function exchangeCode(code, verifier) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(data));
    saveToken({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry: Date.now() + (data.expires_in - 60) * 1000,
    });
    return data.access_token;
  }

  async function refreshToken(token) {
    if (!token.refresh_token) { clearToken(); throw new Error('No refresh token, re-auth needed'); }
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: CLIENT_ID,
      }),
    });
    const data = await r.json();
    if (!data.access_token) { clearToken(); throw new Error('Refresh failed, re-auth needed'); }
    const updated = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      expiry: Date.now() + (data.expires_in - 60) * 1000,
    };
    saveToken(updated);
    return updated.access_token;
  }

  async function getAccessToken() {
    const token = loadToken();
    if (isTokenValid(token)) return token.access_token;
    if (token?.refresh_token) return refreshToken(token);
    return null; // need to start auth flow
  }

  // ── Auth flow ────────────────────────────────────────────────────────────────
  async function startAuth() {
    if (!CLIENT_ID) throw new Error('SPOTIFY_CLIENT_ID not configured.');
    const verifier = randomString(64);
    const state    = randomString(16);
    const challenge = await sha256(verifier);
    localStorage.setItem(LS_VERIFIER_KEY, verifier);
    localStorage.setItem(LS_STATE_KEY, state);
    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES,
    });
    window.location.href = url;
  }

  // Call on page load to handle redirect callback
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code  = params.get('code');
    const state = params.get('state');
    if (!code) return false;
    const savedState    = localStorage.getItem(LS_STATE_KEY);
    const savedVerifier = localStorage.getItem(LS_VERIFIER_KEY);
    if (state !== savedState) { clearToken(); throw new Error('State mismatch — possible CSRF'); }
    await exchangeCode(code, savedVerifier);
    // Clean up URL
    const clean = window.location.pathname + (window.location.hash || '');
    window.history.replaceState({}, '', clean);
    return true;
  }

  // ── Spotify API ──────────────────────────────────────────────────────────────
  async function spotifyFetch(method, path, body, token) {
    const r = await fetch('https://api.spotify.com' + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {};
    return r.json();
  }

  async function getMe(token) {
    return spotifyFetch('GET', '/v1/me', null, token);
  }

  async function findOrCreatePlaylist(userId, name, token) {
    let offset = 0;
    while (true) {
      const r = await spotifyFetch('GET', `/v1/users/${userId}/playlists?limit=50&offset=${offset}`, null, token);
      const found = (r.items || []).find(p => p.name === name);
      if (found) return found.id;
      if (!r.next) break;
      offset += 50;
    }
    const r = await spotifyFetch('POST', `/v1/users/${userId}/playlists`, {
      name,
      public: true,
      description: 'Songs shared in the Music Fellowship WhatsApp group, exported from GUTS Radio.',
    }, token);
    return r.id;
  }

  async function getCurrentTrackUris(playlistId, token) {
    const uris = new Set();
    let offset = 0;
    while (true) {
      const r = await spotifyFetch('GET',
        `/v1/playlists/${playlistId}/tracks?fields=next,items(track(uri))&limit=100&offset=${offset}`,
        null, token);
      for (const item of (r.items || [])) {
        if (item.track?.uri) uris.add(item.track.uri);
      }
      if (!r.next) break;
      offset += 100;
    }
    return uris;
  }

  // ── Main export function ─────────────────────────────────────────────────────
  // tracks: array of track objects from state.playOrder (already filtered)
  // filter: 'all' | 'month' | 'week' | 'today'
  async function exportPlaylist(filter, tracks, { onStatus } = {}) {
    if (!CLIENT_ID) throw new Error('Spotify Client ID not configured.');

    const status = msg => { if (onStatus) onStatus(msg); console.log('[spotify-export]', msg); };

    let token = await getAccessToken();
    if (!token) {
      status('Redirecting to Spotify login...');
      await startAuth();
      return; // page will redirect
    }

    status('Connected to Spotify. Preparing playlist...');

    const me = await getMe(token);
    if (!me.id) throw new Error('Could not get Spotify user ID');

    const filterLabel = filter === 'all' ? 'All Time' : filter === 'month' ? 'This Month'
      : filter === 'week' ? 'This Week' : 'Today';
    const playlistName = `GUTS Radio — ${filterLabel}`;

    const playlistId = await findOrCreatePlaylist(me.id, playlistName, token);
    status(`Syncing "${playlistName}"...`);

    // Build desired URIs from tracks that have spotify_url
    const desiredUris = [];
    for (const t of tracks) {
      const m = (t.spotify_url || '').match(/track\/([A-Za-z0-9]+)/);
      if (m) desiredUris.push(`spotify:track:${m[1]}`);
    }

    if (desiredUris.length === 0) {
      status('No Spotify tracks in current selection.');
      return { playlistId, added: 0 };
    }

    const currentUris = await getCurrentTrackUris(playlistId, token);
    const toAdd = desiredUris.filter(u => !currentUris.has(u));

    // Replace playlist contents
    let added = 0;
    for (let i = 0; i < toAdd.length; i += 100) {
      const batch = toAdd.slice(i, i + 100);
      if (i === 0 && currentUris.size > 0) {
        // Replace all on first batch
        await spotifyFetch('PUT', `/v1/playlists/${playlistId}/tracks`, { uris: batch }, token);
      } else {
        await spotifyFetch('POST', `/v1/playlists/${playlistId}/tracks`, { uris: batch }, token);
      }
      added += batch.length;
    }

    const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
    status(`Done! ${added} tracks exported.`);
    return { playlistId, playlistUrl, added };
  }

  function isConnected() {
    return isTokenValid(loadToken());
  }

  function disconnect() {
    clearToken();
  }

  return { exportPlaylist, handleCallback, startAuth, isConnected, disconnect };
})();
