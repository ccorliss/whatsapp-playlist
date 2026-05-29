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
    try { return JSON.parse(text); } catch(_) { return text; }
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

  // Main export
  async function exportToAppleMusic(tracks, { onStatus, onProgress } = {}) {
    const status = msg => { if (onStatus) onStatus(msg); };

    if (!window.MusicKit) {
      status('Loading MusicKit…');
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    status('Connecting to Apple Music…');
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
      status(`Finding songs… (${catalogIds.length} ready, searching ${needsSearch.length} more)`);
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

    status(`Creating "Music Fellowship" playlist with ${catalogIds.length} songs…`);
    const playlistId = await createPlaylist('Music Fellowship', catalogIds);

    return { added: catalogIds.length, found: catalogIds.length, playlistId };
  }

  function isAuthorized() {
    return !!(_instance?.isAuthorized);
  }

  return { exportToAppleMusic, isAuthorized };
})();
