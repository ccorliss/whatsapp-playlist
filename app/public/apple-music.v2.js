// Apple Music export for Music Fellowship
// Uses MusicKit JS for auth, then direct Apple Music API for playlist creation.

const AppleMusic = (() => {
  let _instance = null;

  async function getDeveloperToken() {
    const r = await fetch('/api/radio/apple-token');
    if (!r.ok) throw new Error('Could not get Apple Music developer token');
    return (await r.json()).token;
  }

  async function getInstance() {
    if (_instance) return _instance;
    if (!window.MusicKit) throw new Error('MusicKit not loaded');
    const devToken = await getDeveloperToken();
    _instance = await MusicKit.configure({
      developerToken: devToken,
      app: { name: 'Music Fellowship', build: '1.0' },
    });
    return _instance;
  }

  async function authorize() {
    const instance = await getInstance();
    if (!instance.isAuthorized) await instance.authorize();
    return instance.isAuthorized;
  }

  // Direct Apple Music API call with user token
  async function amApi(method, path, body) {
    const instance = await getInstance();
    const headers = {
      'Authorization': `Bearer ${instance.developerToken}`,
      'Music-User-Token': instance.musicUserToken,
      'Content-Type': 'application/json',
    };
    const r = await fetch(`https://api.music.apple.com${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(_) { parsed = text; }
    if (!r.ok) {
      const msg = parsed?.errors?.[0]?.detail || parsed?.errors?.[0]?.title || r.statusText || 'Unknown error';
      throw new Error(`Apple Music API ${r.status}: ${msg}`);
    }
    return parsed;
  }

  // Search Apple Music catalog
  async function findCatalogId(title, artist) {
    const instance = await getInstance();
    const q = [artist, title].filter(Boolean).join(' ').trim();
    try {
      const r = await instance.api.music(`/v1/catalog/us/search?term=${encodeURIComponent(q)}&types=songs&limit=1`);
      return r?.data?.results?.songs?.data?.[0]?.id || null;
    } catch(_) { return null; }
  }

  // Create "Music Fellowship" playlist with catalog IDs
  async function createPlaylist(name, catalogIds) {
    // Create playlist
    const result = await amApi('POST', '/v1/me/library/playlists', {
      attributes: {
        name,
        description: 'Songs shared in the Music Fellowship WhatsApp group.',
      },
      relationships: {
        tracks: {
          data: catalogIds.slice(0, 100).map(id => ({ id, type: 'songs' })),
        },
      },
    });

    const playlistId = result?.data?.[0]?.id;
    if (!playlistId) throw new Error('Playlist created but no ID returned: ' + JSON.stringify(result).slice(0, 200));

    // Add remaining tracks in batches of 100
    for (let i = 100; i < catalogIds.length; i += 100) {
      const batch = catalogIds.slice(i, i + 100);
      await amApi('POST', `/v1/me/library/playlists/${playlistId}/tracks`, {
        data: batch.map(id => ({ id, type: 'songs' })),
      });
    }

    return playlistId;
  }

  const PLAYLIST_NAME = 'Music Fellowship';

  // Find ALL "Music Fellowship" playlists in user's library
  async function findExistingPlaylist() {
    const matches = [];
    let offset = 0;
    while (true) {
      const r = await amApi('GET', `/v1/me/library/playlists?limit=25&offset=${offset}`);
      const items = r?.data || [];
      items.forEach(p => { if (p.attributes?.name === PLAYLIST_NAME) matches.push(p); });
      if (!r?.next || items.length < 25) break;
      offset += 25;
    }
    return matches; // return all matches so caller can handle duplicates
  }

  // Add tracks to an existing playlist (Apple Music deduplicates)
  async function addTracksToPlaylist(playlistId, catalogIds, onStatus) {
    let added = 0;
    for (let i = 0; i < catalogIds.length; i += 100) {
      const batch = catalogIds.slice(i, i + 100);
      await amApi('POST', `/v1/me/library/playlists/${playlistId}/tracks`, {
        data: batch.map(id => ({ id, type: 'songs' })),
      });
      added += batch.length;
      if (onStatus) onStatus(`Adding tracks... ${added}/${catalogIds.length}`);
    }
    return added;
  }

  // Main export - idempotent: creates playlist on first run, adds new tracks on subsequent runs
  async function exportToAppleMusic(tracks, { onStatus, onProgress } = {}) {
    const status = msg => { if (onStatus) onStatus(msg); };

    if (!window.MusicKit) {
      status('Loading MusicKit...');
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    status('Connecting to Apple Music...');
    const authed = await authorize();
    if (!authed) throw new Error('Authorization cancelled');

    // Split: pre-stored IDs vs needs search
    const catalogIds = [];
    const needsSearch = tracks.filter(t => !t.apple_music_id && t.title);
    for (const t of tracks) {
      if (t.apple_music_id) catalogIds.push(t.apple_music_id);
    }

    // Search for missing IDs
    if (needsSearch.length > 0) {
      status(`Finding songs... (${catalogIds.length} ready, searching ${needsSearch.length} more)`);
      const writebacks = [];
      let i = 0;
      for (const t of needsSearch) {
        const id = await findCatalogId(t.title, t.artist);
        if (id) {
          catalogIds.push(id);
          writebacks.push({ id: t.id, apple_music_id: id });
        }
        i++;
        if (onProgress) onProgress(i, needsSearch.length, catalogIds.length);
        await new Promise(r => setTimeout(r, 120));
      }
      // Write back to DB for next time
      if (writebacks.length) {
        fetch('/api/radio/apple-ids', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: writebacks }),
        }).catch(() => {});
      }
    }

    if (!catalogIds.length) {
      status('No songs found in Apple Music catalog.');
      return { added: 0, found: 0, playlistId: null };
    }

    // Look up existing playlist by name in user's library
    status('Checking for existing "Music Fellowship" playlist…');
    const matches = await findExistingPlaylist();

    if (matches.length > 1) {
      // Duplicates exist — warn and use the first one (most likely the oldest/correct one)
      status(`Found ${matches.length} playlists named "Music Fellowship" — using most recent`);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (matches.length === 0) {
      status(`Creating new "Music Fellowship" playlist with ${catalogIds.length} songs…`);
      const playlistId = await createPlaylist(PLAYLIST_NAME, catalogIds);
      return { added: catalogIds.length, found: catalogIds.length, playlistId, isNew: true };
    }

    // Use the most recently created match
    const playlistId = matches[matches.length - 1].id;
    status(`Found playlist (${playlistId}) — adding ${catalogIds.length} songs…`);
    const added = await addTracksToPlaylist(playlistId, catalogIds, status);
    return { added, found: catalogIds.length, playlistId, isNew: false };
  }

  function isAuthorized() {
    return !!(_instance?.isAuthorized);
  }

  return { exportToAppleMusic, isAuthorized };
})();
