// GUTS Radio API — Cloudflare Pages Function
// Handles all /api/radio/* routes using D1 database.
// No Node.js dependencies — pure Workers runtime.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function dateClause(filter, col = 't.shared_at') {
  switch (filter) {
    case 'today':  return `AND date(${col},'-7 hours') = date('now','-7 hours')`;
    case 'week':   return `AND ${col} >= datetime('now', '-7 days')`;
    case 'month':  return `AND ${col} >= datetime('now', '-30 days')`;
    default:       return '';
  }
}

// Build a reaction map for multiple tracks in one query
async function reactionCountsBatch(db, trackIds) {
  if (!trackIds.length) return {};
  const placeholders = trackIds.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT track_id, type, COUNT(*) AS n FROM reactions WHERE track_id IN (${placeholders}) GROUP BY track_id, type`
  ).bind(...trackIds).all();
  const map = {};
  for (const id of trackIds) map[id] = { heart: 0, fire: 0, hundred: 0, down: 0, prayer: 0 };
  for (const r of (rows.results || [])) {
    if (map[r.track_id]) map[r.track_id][r.type] = r.n;
  }
  return map;
}

async function reactionCounts(db, trackId) {
  const m = await reactionCountsBatch(db, [trackId]);
  return m[trackId] || { heart: 0, fire: 0, hundred: 0, down: 0 };
}

function trackToJson(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    thumbnail_url: t.thumbnail_url,
    youtube_id: t.youtube_id,
    youtube_url: t.youtube_id ? `https://www.youtube.com/watch?v=${t.youtube_id}` : null,
    spotify_url: t.spotify_url,
    apple_url: t.apple_url,
    song_link_url: t.song_link_url,
    shared_by: t.shared_by,
    shared_at: t.shared_at,
    added_at: t.added_at,
    weight: Math.round((t.weight ?? 1) * 100) / 100,
    play_count: t.total_play_count ?? 0,
    original_url: t.original_url,
    commentary: t.commentary || null,
    emojis: t.emojis || null,
    apple_music_id: t.apple_music_id || null,
  };
}

async function attachReactions(db, track) {
  const j = trackToJson(track);
  j.reactions = await reactionCounts(db, track.id);
  return j;
}

// Batch-attach reactions for a list of tracks in 2 queries total
async function attachReactionsBatch(db, tracks) {
  const ids = tracks.map(t => t.id);
  const reactionMap = await reactionCountsBatch(db, ids);
  return tracks.map(t => { const j = trackToJson(t); j.reactions = reactionMap[t.id] || { heart:0, fire:0, hundred:0, down:0 }; return j; });
}

// Weighted random queue
async function weightedQueue(db, n) {
  const rows = await db.prepare(
    `SELECT * FROM tracks WHERE enabled=1 ORDER BY weight * (1.0 / (-log(abs(random()) / 9223372036854775808.0))) DESC LIMIT ?`
  ).bind(n * 2).all();
  const tracks = [];
  for (const r of (rows.results || []).slice(0, n)) {
    tracks.push(await attachReactions(db, r));
  }
  return tracks;
}

// Apply reaction delta
const REACTION_DELTA = { heart: 0.3, fire: 0.4, hundred: 0.5, down: -0.5 };

async function applyReaction(db, trackId, type, source, reactor) {
  const delta = REACTION_DELTA[type];
  if (delta === undefined) throw new Error('invalid type');
  await db.prepare(
    `INSERT INTO reactions (track_id, type, source, reactor) VALUES (?, ?, ?, ?)`
  ).bind(trackId, type, source, reactor || null).run();
  await db.prepare(
    `UPDATE tracks SET weight = MIN(5.0, MAX(0.1, weight + ?)) WHERE id = ?`
  ).bind(delta, trackId).run();
  const t = await db.prepare('SELECT weight FROM tracks WHERE id = ?').bind(trackId).first();
  return t?.weight ?? 1;
}

async function recordPlay(db, trackId) {
  await db.prepare(
    `INSERT INTO plays (track_id, source) VALUES (?, 'web')`
  ).bind(trackId).run();
  await db.prepare(
    `UPDATE tracks SET total_play_count = total_play_count + 1, last_played_at = datetime('now') WHERE id = ?`
  ).bind(trackId).run();
  const t = await db.prepare('SELECT weight FROM tracks WHERE id = ?').bind(trackId).first();
  return t?.weight ?? 1;
}

// Odesli / song.link resolver (fetch-based, no Node.js https)
async function resolveUrl(url) {
  try {
    const r = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url)}&userCountry=US`,
      { headers: { 'User-Agent': 'GUTS-Radio/1.0' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const entity = data.entitiesByUniqueId
      ? Object.values(data.entitiesByUniqueId)[0]
      : null;
    const ytPlatform = data.linksByPlatform?.youtube || data.linksByPlatform?.youtubeMusic;
    let ytId = null;
    if (ytPlatform?.url) {
      const m = ytPlatform.url.match(/[?&v=]([A-Za-z0-9_-]{11})/);
      ytId = m ? m[1] : null;
    }
    return {
      ok: true,
      title: entity?.title || null,
      artist: entity?.artistName || null,
      thumbnail_url: entity?.thumbnailUrl || null,
      youtube_id: ytId,
      spotify_url: data.linksByPlatform?.spotify?.url || null,
      apple_url: data.linksByPlatform?.appleMusic?.url || null,
      song_link_url: data.pageUrl || null,
    };
  } catch (_) {
    return null;
  }
}

function extractYouTubeId(url) {
  if (!url) return null;
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) return null;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /music\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function isMusicUrl(url) {
  const MUSIC_HOSTS = ['open.spotify.com','spotify.link','music.youtube.com','youtube.com',
    'www.youtube.com','youtu.be','music.apple.com','tidal.com','soundcloud.com','song.link'];
  try {
    const h = new URL(url).hostname.toLowerCase();
    return MUSIC_HOSTS.some(d => h === d || h.endsWith('.'+d));
  } catch (_) { return false; }
}

// WhatsApp export parser
function parseExport(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;
  const BRACKETED = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\]\s+([^:]+):\s*(.*)/i;
  const DASHED    = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}\s*[AP]M)\s+-\s+([^:]+):\s*(.*)/i;
  for (const line of lines) {
    const m = BRACKETED.exec(line) || DASHED.exec(line);
    if (m) {
      if (current) messages.push(current);
      const [, date, time, author, body] = m;
      let ts = null;
      try { ts = new Date(`${date} ${time}`).toISOString(); } catch(_) {}
      let cleanedAuthor = author.trim()
        .replace(/^[\u00a0\u202f\u200b~\s]+/, '').trim()
        .replace(/\s*[-\u2013]\s*[A-Z][a-zA-Z\s,.]+$/, '').trim()
        .replace(/\s+\d+\/\d+.*$/, '').trim()
        .replace(/\s*\([^)]+\)/, '').trim();
      // WhatsApp dot-truncated names: "Jeannine. Mi" → "Jeannine M."
      cleanedAuthor = cleanedAuthor.replace(/^([A-Z][a-z]+)\.\s+([A-Za-z]{1,3})$/, (_, f, a) => f + ' ' + a[0].toUpperCase() + '.');
      current = { author: cleanedAuthor, timestampISO: ts, body };
    } else if (current) {
      current.body += '\n' + line;
    }
  }
  if (current) messages.push(current);
  return messages;
}


function cleanCommentary(body, shareUrl) {
  if (!body) return null;
  // Strip all URLs
  let text = body.replace(/https?:\/\/[^\s<>"]+/gi, '');
  // Strip <attached: ...> and <This message was edited>
  text = text.replace(/<[^>]+>/g, '');
  // Strip the bare shared URL text if present
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length < 3) return null;
  return text.slice(0, 300);
}



// Resolve Apple Music URLs (?i= track IDs or album IDs) via iTunes lookup
async function resolveAppleMusicUrl(url) {
  try {
    // Extract ?i= (specific track) or album ID from Apple Music URL
    const trackMatch = url.match(/[?&]i=(\d+)/);
    const albumMatch = url.match(/\/album\/[^\/]+\/(\d+)/);
    const id = trackMatch?.[1] || albumMatch?.[1];
    if (!id) return null;
    const r = await fetch(`https://itunes.apple.com/lookup?id=${id}`, { headers: { 'User-Agent': 'GUTS-Radio/1.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.results?.[0];
    if (!item) return null;
    return {
      title: item.trackName || item.collectionName,
      artist: item.artistName,
      apple_music_id: String(item.trackId || item.collectionId || id),
      spotify_url: null,
      youtube_id: null,
      song_link_url: null,
      thumbnail_url: item.artworkUrl100?.replace('100x100', '300x300') || null,
    };
  } catch(_) { return null; }
}


// Spotify client credentials token (server-to-server, no user auth needed)
let _spotifyToken = null, _spotifyExpiry = 0;
async function getSpotifyToken(env) {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  // client_secret: prefer env var (fast), fall back to KV (secure)
  const clientSecret = env.SPOTIFY_CLIENT_SECRET || await env.RADIO_SECRETS.get('spotify_client_secret');
  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${clientSecret}`);
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  _spotifyToken = d.access_token;
  _spotifyExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return _spotifyToken;
}

async function searchSpotifyUrl(title, artist, env) {
  try {
    const token = await getSpotifyToken(env);
    const q = encodeURIComponent([artist, title].filter(Boolean).join(' ').trim());
    const r = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const d = await r.json();
    return d.tracks?.items?.[0]?.external_urls?.spotify || null;
  } catch(_) { return null; }
}

async function resolveAppleMusicId(title, artist) {
  try {
    const q = encodeURIComponent([artist, title].filter(Boolean).join(' ').trim());
    const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=1&entity=song`, { headers: { 'User-Agent': 'GUTS-Radio/1.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    return d.results?.[0]?.trackId ? String(d.results[0].trackId) : null;
  } catch(_) { return null; }
}

async function ingestUrl(db, { author, timestampISO, url, body }, env) {
  const msgKey = `IMPORT::${url}`;
  const existing = await db.prepare('SELECT track_id FROM share_messages WHERE message_id = ?').bind(msgKey).first();
  if (existing) return { skipped: true, trackId: existing.track_id };

  const ytId = extractYouTubeId(url);
  const spId = url.match(/spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1] || null;
  const amUrlId = url.match(/[?&]i=(\d+)/)?.[1] || url.match(/\/album\/[^\/]+(\d+)/)?.[1] || null;

  let title = null, artist = null, thumb = null, spotifyUrl = null, appleUrl = null, songLink = null, appleId = null;

  // YouTube: oEmbed for title, then Spotify search for real artist + spotify URL
  let ytChannelArtist = null; // YouTube channel name — last resort only
  if (ytId) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${ytId}`);
      if (r.ok) { const d = await r.json(); title = d.title; ytChannelArtist = d.author_name || null; }
    } catch(_) {}
    thumb = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
    songLink = `https://song.link/y/${ytId}`;
  }

  // Spotify oEmbed for title on Spotify URLs
  if (spId) {
    spotifyUrl = url.includes('spotify.com') ? url : null;
    songLink = songLink || `https://song.link/s/${spId}`;
    if (!title) {
      try {
        const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${spId}`);
        if (r.ok) { const d = await r.json(); title = d.title; if (d.thumbnail_url && !thumb) thumb = d.thumbnail_url; }
      } catch(_) {}
    }
  }

  // Apple Music: iTunes lookup for title/artist
  if (amUrlId) {
    appleUrl = url;
    try {
      const r = await fetch(`https://itunes.apple.com/lookup?id=${amUrlId}`);
      if (r.ok) { const d = await r.json(); const it = d.results?.[0]; if (it) { title = title || it.trackName || it.collectionName; artist = it.artistName; appleId = String(it.trackId || it.collectionId || amUrlId); if (it.artworkUrl100 && !thumb) thumb = it.artworkUrl100.replace('100x100','300x300'); } }
    } catch(_) {}
    songLink = songLink || (appleId ? `https://song.link/s/${appleId}` : null);
  }

  // Spotify client credentials: get real artist + spotify URL for YouTube tracks
  if (title && env.SPOTIFY_CLIENT_ID) {
    try {
      const tok = await getSpotifyToken(env);
      // Parse "Artist - Song Title" pattern from YouTube titles for better Spotify matching
      let searchArtist = null, searchSong = title;
      const dashMatch = title.match(/^([^-–]+?)\s*[-–]\s+(.+)$/);
      if (dashMatch) { searchArtist = dashMatch[1].trim(); searchSong = dashMatch[2].trim(); }
      const q = encodeURIComponent([searchArtist, searchSong].filter(Boolean).join(' '));
      const r = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=3`, { headers: { 'Authorization': 'Bearer ' + tok } });
      if (r.ok) {
        const d = await r.json();
        const items = d.tracks?.items || [];
        // Find best match: prefer items where artist matches extracted artist
        let item = items[0];
        if (searchArtist && items.length > 1) {
          const artistLower = searchArtist.toLowerCase();
          const better = items.find(i => i.artists?.[0]?.name?.toLowerCase().includes(artistLower) || artistLower.includes(i.artists?.[0]?.name?.toLowerCase() || ''));
          if (better) item = better;
        }
        if (item) {
          if (item.artists?.[0]?.name) artist = item.artists[0].name;
          if (!spotifyUrl) { spotifyUrl = item.external_urls?.spotify; const m = spotifyUrl?.match(/track\/([A-Za-z0-9]+)/); if (m) songLink = songLink || `https://song.link/s/${m[1]}`; }
          if (!thumb && item.album?.images?.[1]?.url) thumb = item.album.images[1].url;
          // Update title to clean song name if we extracted artist from title
          if (searchArtist && item.name) title = item.name;
        }
      }
    } catch(_) {}
  }

  // iTunes for Apple Music ID
  if (title && !appleId) {
    try {
      const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));
      const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=1&entity=song`);
      if (r.ok) { const d = await r.json(); const it = d.results?.[0]; if (it) { appleId = String(it.trackId); appleUrl = appleUrl || `https://music.apple.com/us/song/${it.trackId}`; } }
    } catch(_) {}
  }

  // Use YouTube channel as last resort artist
  if (!artist && ytChannelArtist) artist = ytChannelArtist;

  // Clean title
  if (title) title = title.replace(/\s*[\(\[][^\)\]]*\b(?:official|lyric[s]?|video|4k|hd|hq|remaster(?:ed)?|live|acoustic|remix|explicit|clean|extended|version)\b[^\)\]]*[\)\]]/gi, '').replace(/\s*[-–]\s*(?:official\s+)?(?:lyric[s]?\s+)?(?:music\s+)?video/gi, '').replace(/\s*[-–]\s*(?:20\d{2}\s+)?remaster(?:ed)?/gi, '').replace(/\s+/g, ' ').trim();

  const entityId = `URL::${url}`;
  const existing2 = await db.prepare('SELECT id FROM tracks WHERE entity_id = ? OR original_url = ?').bind(entityId, url).first();
  if (!existing2) {
    const r = await db.prepare(`INSERT INTO tracks (entity_id,original_url,title,artist,thumbnail_url,youtube_id,spotify_url,apple_url,song_link_url,apple_music_id,shared_by,shared_at,commentary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(entityId, url, title, artist, thumb, ytId, spotifyUrl, appleUrl, songLink, appleId, author||null, timestampISO||null, cleanCommentary(body,url)||null).run();
    const trackId = r.meta?.last_row_id;
    await db.prepare('INSERT OR IGNORE INTO share_messages (message_id,track_id,url) VALUES (?,?,?)').bind(msgKey, trackId, url).run();
    return { skipped: false, trackId };
  } else {
    await db.prepare('INSERT OR IGNORE INTO share_messages (message_id,track_id,url) VALUES (?,?,?)').bind(msgKey, existing2.id, url).run();
    return { skipped: false, trackId: existing2.id };
  }
}


// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 database not bound' }, 500);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/radio/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // GET /queue
  if (path === '/queue' && method === 'GET') {
    const n = Math.min(parseInt(url.searchParams.get('n') || '12'), 50);
    const rows = await db.prepare(
      `SELECT * FROM tracks WHERE enabled=1 ORDER BY weight * (1.0 / (-log(abs(random()) / 9223372036854775808.0))) DESC LIMIT ?`
    ).bind(n * 2).all();
    const tracks = await attachReactionsBatch(db, (rows.results || []).slice(0, n));
    return json({ tracks, count: tracks.length });
  }

  // GET /all
  if (path === '/all' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all';
    const sort = url.searchParams.get('sort') === 'date' ? 't.shared_at DESC, t.id DESC' : 't.weight DESC, t.id DESC';
    const limit = parseInt(url.searchParams.get('limit') || '0');
    const dc = dateClause(filter);
    const limitClause = limit > 0 ? `LIMIT ${limit}` : '';
    // Single query: tracks + reactions aggregated via LEFT JOIN (no N+1, no parameter limits)
    const rows = await db.prepare(`
      SELECT t.*,
        SUM(CASE WHEN r.type='heart'   THEN 1 ELSE 0 END) AS react_heart,
        SUM(CASE WHEN r.type='fire'    THEN 1 ELSE 0 END) AS react_fire,
        SUM(CASE WHEN r.type='hundred' THEN 1 ELSE 0 END) AS react_hundred,
        SUM(CASE WHEN r.type='down'    THEN 1 ELSE 0 END) AS react_down,
        SUM(CASE WHEN r.type='prayer'  THEN 1 ELSE 0 END) AS react_prayer
      FROM tracks t
      LEFT JOIN reactions r ON r.track_id = t.id
      WHERE t.enabled=1 ${dc}
      GROUP BY COALESCE(t.entity_id, CAST(t.id AS TEXT))
      ORDER BY ${sort} ${limitClause}
    `).all();
    const tracks = (rows.results || []).map(t => {
      const j = trackToJson(t);
      j.reactions = { heart: t.react_heart||0, fire: t.react_fire||0, hundred: t.react_hundred||0, down: t.react_down||0, prayer: t.react_prayer||0 };
      return j;
    });
    return json({ tracks, filter, total: tracks.length });
  }

  // GET /stats (includes counts for filter badges)
  if (path === '/stats' && method === 'GET') {
    const [tracks, plays, reactions, sharers, month, week, today] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE enabled=1').first(),
      db.prepare('SELECT COUNT(*) AS n FROM plays').first(),
      db.prepare('SELECT COUNT(*) AS n FROM reactions').first(),
      db.prepare('SELECT COUNT(DISTINCT shared_by) AS n FROM tracks WHERE shared_by IS NOT NULL').first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND shared_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND shared_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND date(shared_at,'-7 hours')=date('now','-7 hours')").first(),
    ]);
    return json({
      tracks: tracks?.n, plays: plays?.n, reactions: reactions?.n, sharers: sharers?.n,
      counts: { all: tracks?.n, month: month?.n, week: week?.n, today: today?.n },
    });
  }

  // GET /counts (kept for backward compat)
  if (path === '/counts' && method === 'GET') {
    const [all, month, week, today] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1").first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND shared_at >= datetime('now','-30 days')").first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND shared_at >= datetime('now','-7 days')").first(),
      db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE enabled=1 AND date(shared_at,'-7 hours')=date('now','-7 hours')").first(),
    ]);
    return json({ all: all?.n, month: month?.n, week: week?.n, today: today?.n });
  }

  // GET /playlist-ids
  if (path === '/playlist-ids' && method === 'GET') {
    const ytId = env.YOUTUBE_PLAYLIST_ID || null;
    const spId = env.SPOTIFY_PLAYLIST_ID || null;
    return json({
      youtube: ytId ? { id: ytId, url: `https://www.youtube.com/playlist?list=${ytId}` } : null,
      spotify: spId ? { id: spId, url: `https://open.spotify.com/playlist/${spId}` } : null,
    });
  }

  // GET /track/:id
  const trackMatch = path.match(/^\/track\/(\d+)$/);
  if (trackMatch && method === 'GET') {
    const t = await db.prepare('SELECT * FROM tracks WHERE id = ?').bind(parseInt(trackMatch[1])).first();
    if (!t) return json({ error: 'not found' }, 404);
    return json(await attachReactions(db, t));
  }

  // POST /react
  if (path === '/react' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const trackId = parseInt(body.track_id);
    const type = body.type;
    if (!trackId || !(type in REACTION_DELTA)) return json({ error: 'track_id and valid type required' }, 400);
    const newWeight = await applyReaction(db, trackId, type, 'web', null);
    return json({ ok: true, weight: newWeight, reactions: await reactionCounts(db, trackId) });
  }

  // POST /play
  if (path === '/play' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const trackId = parseInt(body.track_id);
    if (!trackId) return json({ error: 'track_id required' }, 400);
    const weight = await recordPlay(db, trackId);
    return json({ ok: true, weight });
  }

  // GET /export.m3u
  if (path === '/export.m3u' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all';
    const dc = dateClause(filter);
    const rows = await db.prepare(
      `SELECT title, artist, youtube_id, spotify_url, song_link_url FROM tracks t WHERE t.enabled=1 ${dc} ORDER BY COALESCE(t.shared_at,t.added_at) DESC`
    ).all();
    const lines = ['#EXTM3U'];
    for (const t of (rows.results || [])) {
      const trackUrl = t.youtube_id ? `https://www.youtube.com/watch?v=${t.youtube_id}` : t.spotify_url || t.song_link_url;
      if (!trackUrl) continue;
      lines.push(`#EXTINF:0,${t.title || 'Untitled'}${t.artist ? ' - ' + t.artist : ''}`);
      lines.push(trackUrl);
    }
    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'audio/x-mpegurl', 'Content-Disposition': `attachment; filename="guts-radio-${filter}.m3u"`, ...CORS },
    });
  }

  // GET /export.csv
  if (path === '/export.csv' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all';
    const dc = dateClause(filter);
    const rows = await db.prepare(
      `SELECT title, artist, shared_by, shared_at, youtube_id, spotify_url, apple_url, apple_music_id, song_link_url FROM tracks t WHERE t.enabled=1 ${dc} ORDER BY COALESCE(t.shared_at,t.added_at) DESC`
    ).all();
    const esc = s => s ? `"${String(s).replace(/"/g,'""')}"` : '';
    const header = 'Title,Artist,Shared By,Date,YouTube,Spotify,Apple Music,song.link';
    const csvRows = (rows.results || []).map(t => [
      esc(t.title), esc(t.artist), esc(t.shared_by),
      esc(t.shared_at ? t.shared_at.slice(0,10) : ''),
      t.youtube_id ? `https://www.youtube.com/watch?v=${t.youtube_id}` : '',
      esc(t.spotify_url), esc(t.apple_url || (t.apple_music_id ? `https://music.apple.com/us/song/${t.apple_music_id}` : null)), esc(t.song_link_url),
    ].join(','));
    return new Response([header, ...csvRows].join('\n'), {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="guts-radio-${filter}.csv"`, ...CORS },
    });
  }

  // POST /import
  if (path === '/import' && method === 'POST') {
    const text = await request.text();
    if (!text || text.length < 10) return json({ error: 'Empty export text' }, 400);
    const messages = parseExport(text);
    let added = 0, skipped = 0;
    for (const msg of messages) {
      const urls = (msg.body?.match(/https?:\/\/[^\s<>"]+/gi) || [])
        .map(u => u.replace(/[)\].,!?]+$/, ''))
        .filter(u => isMusicUrl(u));
      for (const u of urls) {
        const r = await ingestUrl(db, { author: msg.author, timestampISO: msg.timestampISO, url: u, body: msg.body });
        if (r.skipped) skipped++; else added++;
      }
    }
    return json({ ok: true, added, skipped });
  }


  // GET /api/radio/spotify-connect — redirect to Spotify OAuth
  // redirect_uri must match what's registered in Spotify developer dashboard: /admin
  if (path === '/spotify-connect' && method === 'GET') {
    const clientId = env.SPOTIFY_CLIENT_ID;
    const redirect = url.origin + '/admin';
    const scope = 'playlist-modify-public playlist-modify-private playlist-read-private';
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&show_dialog=true`;
    return Response.redirect(authUrl, 302);
  }

  // GET /api/radio/spotify-callback — exchange code for tokens (called by admin page JS)
  if (path === '/spotify-callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error || !code) return json({ error: error || 'no code' }, 400);
    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = await env.RADIO_SECRETS.get('spotify_client_secret');
    const redirect = url.origin + '/admin';
    const creds = btoa(`${clientId}:${clientSecret}`);
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, redirect_uri: redirect, grant_type: 'authorization_code' }).toString(),
    });
    const tokens = await r.json();
    if (!tokens.refresh_token) return json({ error: 'No refresh token: ' + JSON.stringify(tokens) }, 500);
    await env.RADIO_SECRETS.put('spotify_refresh_token', tokens.refresh_token);
    await env.RADIO_SECRETS.put('spotify_access_token', tokens.access_token);
    await env.RADIO_SECRETS.put('spotify_token_expiry', String(Date.now() + (tokens.expires_in - 60) * 1000));
    return json({ ok: true });
  }

  // GET /api/radio/spotify-status
  if (path === '/spotify-status' && method === 'GET') {
    const token = await env.RADIO_SECRETS.get('spotify_refresh_token');
    const playlist_id = await env.RADIO_SECRETS.get('spotify_playlist_id');
    return json({ connected: !!token, playlist_id: playlist_id || null });
  }

  // POST /api/radio/spotify-sync — sync shared playlist
  if (path === '/spotify-sync' && method === 'POST') {
    try {
    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = await env.RADIO_SECRETS.get('spotify_client_secret');
    const refreshToken = await env.RADIO_SECRETS.get('spotify_refresh_token');
    if (!refreshToken) return json({ error: 'Not connected. Authorize Spotify first.' }, 400);
    const creds = btoa(`${clientId}:${clientSecret}`);
    const tr = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    const tdText = await tr.text();
    let tdata; try { tdata = JSON.parse(tdText); } catch(e) { return json({ error: 'Token refresh response: ' + tdText.slice(0,200) }, 500); }
    if (!tdata.access_token) return json({ error: 'Token refresh failed: ' + JSON.stringify(tdata) }, 500);
    // Log scopes for debugging
    const scopes = tdata.scope || 'no scope in response';
    const accessToken = tdata.access_token;
    // Get user ID
    const meR = await fetch('https://api.spotify.com/v1/me', { headers: { 'Authorization': 'Bearer ' + accessToken } });
    const meText = await meR.text();
    let me; try { me = JSON.parse(meText); } catch(e) { return json({ error: '/v1/me response: ' + meText.slice(0,200) }, 500); }
    // Find or create playlist
    const PLAYLIST_NAME = 'Music Fellowship';
    let playlistId = await env.RADIO_SECRETS.get('spotify_playlist_id');
    if (!playlistId) {
      // Search existing playlists
      const plR = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', { headers: { 'Authorization': 'Bearer ' + accessToken } });
      const plData = await plR.json();
      const found = (plData.items || []).find(p => p.name === PLAYLIST_NAME);
      if (found) {
        playlistId = found.id;
      } else {
        const cR = await fetch('https://api.spotify.com/v1/me/playlists', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: PLAYLIST_NAME, public: true, description: 'Songs shared in the Music Fellowship WhatsApp group.' }),
        });
        const cpText = await cR.text();
        let cp; try { cp = JSON.parse(cpText); } catch(e) { return json({ error: 'Playlist create failed: ' + cpText.slice(0,200) }, 500); }
        if (!cp.id) return json({ error: 'No playlist ID returned: ' + JSON.stringify(cp).slice(0,200) }, 500);
        playlistId = cp.id;
      }
      if (!playlistId) return json({ error: 'Could not get or create playlist. me.id=' + me.id }, 500);
      await env.RADIO_SECRETS.put('spotify_playlist_id', playlistId);
    }
    // Get tracks with Spotify URLs
    const rows = await db.prepare("SELECT spotify_url FROM tracks WHERE enabled=1 AND spotify_url LIKE '%/track/%'").all();
    const uris = (rows.results || []).map(r => { const m = r.spotify_url.match(/track\/([A-Za-z0-9]+)/); return m ? 'spotify:track:' + m[1] : null; }).filter(Boolean);
    // Verify we own the playlist
    const plCheckR = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=owner`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    const plCheck = await plCheckR.json();
    if (plCheck.owner?.id !== me.id) return json({ error: `Playlist owner ${plCheck.owner?.id} != token user ${me.id}. Re-auth needed.` }, 403);
    // Clear playlist first, then add all tracks
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [] }),
    });
    // Remove all existing tracks
    const existR = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(uri))&limit=100`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    const existData = await existR.json();
    const existUris = (existData.items || []).map(i => ({ uri: i.track?.uri })).filter(i => i.uri);
    if (existUris.length > 0) {
      await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: existUris }),
      });
    }
    let added = 0;
    const errors = [];
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      // Always POST (PUT full-replace requires ownership rights that may be restricted)
      const addR = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: batch }),
      });
      const addText = await addR.text();
      if (!addR.ok) { errors.push(`POST batch ${i}: HTTP ${addR.status} ${addText.slice(0,100)} (token_scopes: ${scopes})`); }
      else { added += batch.length; }
    }
    if (errors.length) return json({ ok: false, errors, playlistId, added }, 207);
    await env.RADIO_SECRETS.put('spotify_playlist_id', playlistId);
      return json({ ok: true, playlistId, added, url: `https://open.spotify.com/playlist/${playlistId}` });
    } catch(err) {
      return json({ error: 'Spotify sync failed: ' + err.message, stack: err.stack?.slice(0,300) }, 500);
    }
  }


  // POST /api/radio/resolve-spotify — resolve Spotify URLs for YouTube-only tracks
  if (path === '/resolve-spotify' && method === 'POST') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const rows = await db.prepare(
      "SELECT id, youtube_id, title, artist FROM tracks WHERE enabled=1 AND (spotify_url IS NULL OR spotify_url='') AND youtube_id IS NOT NULL AND youtube_id != '' LIMIT ?"
    ).bind(limit).all();
    const tracks = rows.results || [];
    if (!tracks.length) return json({ ok: true, message: 'All tracks already resolved', fixed: 0 });

    let fixed = 0, failed = 0;
    const results = [];

    for (const t of tracks) {
      try {
        const ytUrl = 'https://www.youtube.com/watch?v=' + t.youtube_id;
        const r = await fetch('https://api.song.link/v1-alpha.1/links?url=' + encodeURIComponent(ytUrl) + '&userCountry=US', {
          headers: { 'User-Agent': 'GUTS-Radio/1.0' }
        });
        if (!r.ok) { failed++; continue; }
        const data = await r.json();
        const sp = data.linksByPlatform?.spotify;
        const songLink = data.pageUrl || null;
        if (sp?.url) {
          await db.prepare("UPDATE tracks SET spotify_url=?, song_link_url=COALESCE(song_link_url,?) WHERE id=?")
            .bind(sp.url, songLink, t.id).run();
          results.push(t.title);
          fixed++;
        } else {
          failed++;
        }
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      } catch(e) {
        failed++;
      }
    }
    return json({ ok: true, fixed, failed, remaining: tracks.length - fixed, examples: results.slice(0,5) });
  }


  // GET /api/radio/apple-token — generate MusicKit developer JWT
  if (path === '/apple-token' && method === 'GET') {
    try {
      const teamId  = env.APPLE_TEAM_ID;
      const keyId   = env.APPLE_MUSICKIT_KEY_ID;
      const privKey = await env.RADIO_SECRETS.get('apple_musickit_private_key');
      if (!teamId || !keyId || !privKey) return json({ error: 'Apple MusicKit not configured' }, 503);

      // Build JWT header + payload
      const now = Math.floor(Date.now() / 1000);
      const header  = { alg: 'ES256', kid: keyId };
      const payload = { iss: teamId, iat: now, exp: now + 15777000 }; // ~6 months

      const b64 = s => btoa(unescape(encodeURIComponent(JSON.stringify(s))))
        .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

      const unsigned = b64(header) + '.' + b64(payload);

      // Import the private key (PKCS8 PEM)
      const pemBody = privKey.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
      const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', keyData.buffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
      );
      const sigBuf = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        new TextEncoder().encode(unsigned)
      );
      const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
        .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

      return json({ token: unsigned + '.' + sig });
    } catch(e) {
      return json({ error: 'Token generation failed: ' + e.message }, 500);
    }
  }


  // POST /api/radio/apple-ids — save Apple Music catalog IDs discovered by client
  if (path === '/apple-ids' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const updates = body.updates || []; // [{id, apple_music_id}]
    if (!updates.length) return json({ ok: true, saved: 0 });
    let saved = 0;
    const stmt = db.prepare('UPDATE tracks SET apple_music_id=? WHERE id=?');
    for (const u of updates) {
      if (u.id && u.apple_music_id) {
        await stmt.bind(String(u.apple_music_id), Number(u.id)).run();
        saved++;
      }
    }
    return json({ ok: true, saved });
  }


  // POST /api/radio/wipe — clear all data (admin only)
  if (path === '/wipe' && method === 'POST') {
    await db.prepare('DELETE FROM reactions').run();
    await db.prepare('DELETE FROM plays').run();
    await db.prepare('DELETE FROM share_messages').run();
    const r = await db.prepare('DELETE FROM tracks').run();
    return json({ ok: true, deleted: r.meta?.changes || 0 });
  }


  // POST /api/radio/import-urls — batch URL import (client-parsed)
  if (path === '/import-urls' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const urls = body.urls || [];
    if (!urls.length) return json({ ok: true, added: 0, skipped: 0, errors: 0 });
    let added = 0, skipped = 0, errors = 0;
    for (const item of urls) {
      try {
        const r = await ingestUrl(db, { url: item.url, author: item.author, timestampISO: item.timestampISO || null, body: '' }, env);
        if (r.skipped) skipped++; else added++;
      } catch(_) { errors++; }
    }
    return json({ ok: true, added, skipped, errors });
  }


  // POST /api/radio/enrich — retry resolution for tracks missing fields
  if (path === '/enrich' && method === 'POST') {
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const rows = await db.prepare(`
      SELECT id, original_url, title, artist, youtube_id, spotify_url, apple_music_id
      FROM tracks WHERE enabled=1 AND (
        title IS NULL OR
        artist IS NULL OR 
        (youtube_id IS NULL AND title IS NOT NULL AND original_url NOT LIKE '%apple.com%/album/%') OR
        (spotify_url IS NULL AND original_url NOT LIKE '%apple.com%') OR
        apple_music_id IS NULL
      ) LIMIT ?
    `).bind(limit).all();
    
    const tracks = rows.results || [];
    if (!tracks.length) return json({ ok: true, enriched: 0, remaining: 0 });
    
    let enriched = 0, errors = [];
    for (const t of tracks) {
      try {
        const info = await (async () => {
          const ytId = t.youtube_id || extractYouTubeId(t.original_url);
          const spId = t.original_url.match(/spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1];
          let title = t.title, artist = t.artist, spotifyUrl = t.spotify_url, appleId = t.apple_music_id, thumb = null;

          if (ytId && !title) {
            try { const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${ytId}`); if (r.ok) { const d = await r.json(); title = d.title; } } catch(_) {}
          }
          if (spId && !title) {
            try { const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${spId}`); if (r.ok) { const d = await r.json(); title = d.title; if (d.thumbnail_url) thumb = d.thumbnail_url; } } catch(_) {}
            if (!spotifyUrl) spotifyUrl = t.original_url;
          }
          if (title && (!artist || !spotifyUrl) && env.SPOTIFY_CLIENT_ID) {
            try {
              const tok = await getSpotifyToken(env);
              const dashMatch = title.match(/^([^-–]+?)\s*[-–]\s+(.+)$/);
              const sa = dashMatch?.[1]?.trim(), ss = dashMatch?.[2]?.trim() || title;
              const q = encodeURIComponent([sa, ss].filter(Boolean).join(' '));
              const r = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=3`, { headers: { 'Authorization': 'Bearer ' + tok } });
              if (r.ok) {
                const items = (await r.json()).tracks?.items || [];
                let item = items[0];
                if (sa && items.length > 1) { const al = sa.toLowerCase(); const b = items.find(i => i.artists?.[0]?.name?.toLowerCase().includes(al) || al.includes(i.artists?.[0]?.name?.toLowerCase()||'')); if (b) item = b; }
                if (item) {
                  if (item.artists?.[0]?.name) artist = item.artists[0].name;
                  if (!spotifyUrl) { spotifyUrl = item.external_urls?.spotify; }
                  if (!thumb && item.album?.images?.[1]?.url) thumb = item.album.images[1].url;
                  if (sa && item.name) title = item.name;
                }
              }
            } catch(_) {}
          }
          // YouTube search if still no YouTube ID
          let foundYtId = ytId;
          if (title && !t.youtube_id && env.YOUTUBE_API_KEY) {
            try {
              const q = encodeURIComponent([artist,title].filter(Boolean).join(' '));
              const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${q}&key=${env.YOUTUBE_API_KEY}`);
              if (r.ok) { const d = await r.json(); const vid = d.items?.[0]?.id?.videoId; if (vid) foundYtId = vid; }
            } catch(_) {}
          }

          if (title && !appleId) {
            try {
              // Try with clean title (strip "Artist - " prefix if present) + artist for better matching
              const dashMatch2 = title.match(/^([^-–]+?)\s*[-–]\s+(.+)$/);
              const cleanSong = dashMatch2?.[2]?.trim() || title;
              const cleanArtist = dashMatch2?.[1]?.trim() || artist;
              const q = encodeURIComponent([cleanArtist, cleanSong].filter(Boolean).join(' '));
              const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=1&entity=song`);
              if (r.ok) { const d = await r.json(); const it = d.results?.[0]; if (it) { appleId = String(it.trackId); if (!artist) artist = it.artistName; } }
            } catch(_) {}
          }
          const sl = spotifyUrl ? ('https://song.link/s/' + (spotifyUrl.match(/track\/([A-Za-z0-9]+)/)?.[1] || '')) : (ytId ? 'https://song.link/y/' + ytId : null);
          if (foundYtId && !thumb) thumb = `https://img.youtube.com/vi/${foundYtId}/mqdefault.jpg`;
          return { title, artist, spotifyUrl, appleId, sl, thumb, ytId: foundYtId };
        })();
        
        // Only count as enriched if we actually found new data
        const hadNewData = (info.title && !t.title) || (info.artist && !t.artist) || 
          (info.spotifyUrl && !t.spotify_url) || (info.appleId && !t.apple_music_id) || (info.ytId && !t.youtube_id && info.ytId !== t.youtube_id);
        if (hadNewData) {
          await db.prepare(`UPDATE tracks SET title=COALESCE(?,title), artist=COALESCE(?,artist), spotify_url=COALESCE(?,spotify_url), apple_music_id=COALESCE(?,apple_music_id), song_link_url=COALESCE(?,song_link_url), youtube_id=COALESCE(?,youtube_id), thumbnail_url=COALESCE(thumbnail_url,?) WHERE id=?`)
            .bind(info.title||null, info.artist||null, info.spotifyUrl||null, info.appleId||null, info.sl||null, info.ytId||null, info.thumb||null, t.id).run();
          enriched++;
        }
      } catch(err) { errors = (errors||[]).concat(String(err.message||err)); }
    }

    const remaining = await db.prepare(`SELECT COUNT(*) as n FROM tracks WHERE enabled=1 AND (title IS NULL OR artist IS NULL OR (spotify_url IS NULL AND original_url NOT LIKE '%apple.com%') OR apple_music_id IS NULL)`).first();
    return json({ ok: true, enriched, remaining: remaining?.n || 0, errors: errors.slice(0,5) });
  }


  // GET /api/radio/enrich-debug — test one track
  if (path === '/enrich-debug' && method === 'GET') {
    const row = await db.prepare("SELECT id, original_url, title, artist, youtube_id, spotify_url, apple_music_id FROM tracks WHERE enabled=1 AND youtube_id IS NULL AND title IS NOT NULL LIMIT 1").first();
    if (!row) return json({ error: 'no tracks need YouTube' });
    const ytKey = env.YOUTUBE_API_KEY;
    const q = encodeURIComponent([row.artist, row.title].filter(Boolean).join(' '));
    const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${q}&key=${ytKey}`;
    let ytResult = null;
    try {
      const r = await fetch(ytUrl);
      ytResult = await r.json();
    } catch(e) { ytResult = { error: e.message }; }
    return json({ track: row, ytKey: ytKey ? ytKey.slice(0,10)+'...' : 'MISSING', query: q, ytItems: ytResult?.items?.length, firstId: ytResult?.items?.[0]?.id?.videoId, ytError: ytResult?.error });
  }

  // ── Playlist sync endpoints ─────────────────────────────────────────────────

  // POST /request-sync — queue Spotify or Apple sync for Mac mini
  if (path === '/request-sync' && method === 'POST') {
    const { type } = await request.json().catch(() => ({}));
    if (!['spotify','apple'].includes(type)) return json({ ok: false, error: 'Invalid type' }, 400);
    await env.RADIO_SECRETS.put(`sync_${type}_requested`, new Date().toISOString());
    await env.RADIO_SECRETS.delete(`sync_${type}_status`);
    return json({ ok: true, queued: type });
  }

  // POST /sync-complete — Mac mini reports sync done
  if (path === '/sync-complete' && method === 'POST') {
    const { type, added, failed, message } = await request.json().catch(() => ({}));
    if (type) {
      await env.RADIO_SECRETS.delete(`sync_${type}_requested`);
      await env.RADIO_SECRETS.put(`sync_${type}_status`, JSON.stringify({ done: true, added, failed, message, at: new Date().toISOString() }));
    }
    return json({ ok: true });
  }

  // GET /sync-status — check sync queue state
  if (path === '/sync-status' && method === 'GET') {
    const types = ['spotify', 'apple', 'youtube'];
    const status = {};
    for (const t of types) {
      const pending = await env.RADIO_SECRETS.get(`sync_${t}_requested`);
      const last = await env.RADIO_SECRETS.get(`sync_${t}_status`);
      status[t] = { pending: !!pending, requestedAt: pending || null, last: last ? JSON.parse(last) : null };
    }
    return json(status);
  }

  // POST /youtube-sync — sync YouTube playlist directly from CF using stored OAuth
  if (path === '/youtube-sync' && method === 'POST') {
    try {
      const clientId     = await env.RADIO_SECRETS.get('youtube_client_id');
      const clientSecret = await env.RADIO_SECRETS.get('youtube_client_secret');
      const refreshToken = await env.RADIO_SECRETS.get('youtube_refresh_token');
      const playlistId   = env.YOUTUBE_PLAYLIST_ID;
      if (!clientId || !clientSecret || !refreshToken) return json({ ok: false, error: 'YouTube credentials not configured' }, 500);

      // Get access token
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      });
      const tokenData = await tokenResp.json();
      if (!tokenData.access_token) return json({ ok: false, error: 'Token refresh failed: ' + (tokenData.error || 'unknown') }, 500);
      const token = tokenData.access_token;

      const ytHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

      // Get all tracks from DB with youtube_id sorted by shared_at DESC (newest first)
      const rows = await db.prepare('SELECT youtube_id, shared_at FROM tracks WHERE enabled=1 AND youtube_id IS NOT NULL ORDER BY COALESCE(shared_at, added_at) DESC').all();
      const desiredIds = (rows.results || []).map(r => r.youtube_id);

      // Get current playlist items
      const currentMap = new Map(); // videoId -> playlistItemId
      let pageToken = '';
      do {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: ytHeaders });
        const data = await r.json();
        if (data.error) { return json({ ok: false, error: data.error.message }); }
        for (const item of (data.items || [])) {
          currentMap.set(item.snippet.resourceId.videoId, item.id);
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);

      // Add missing videos at position 0 (newest first)
      let added = 0, skipped = 0;
      for (let i = desiredIds.length - 1; i >= 0; i--) {
        const ytId = desiredIds[i];
        if (currentMap.has(ytId)) { skipped++; continue; }
        const addResp = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
          method: 'POST', headers: ytHeaders,
          body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: ytId }, position: 0 } }),
        });
        const addData = await addResp.json();
        if (addData.error) {
          if (addData.error.errors?.[0]?.reason === 'quotaExceeded') {
            return json({ ok: false, error: 'YouTube quota exceeded. Try again tomorrow.', added, skipped });
          }
          continue; // skip this video
        }
        added++;
        await new Promise(r => setTimeout(r, 200));
      }

      await env.RADIO_SECRETS.put('sync_youtube_status', JSON.stringify({ done: true, added, skipped, at: new Date().toISOString() }));
      return json({ ok: true, added, skipped, total: desiredIds.length });
    } catch(e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /store-apple-token — store Music User Token for server-side Apple sync
  if (path === '/store-apple-token' && method === 'POST') {
    const { token } = await request.json().catch(() => ({}));
    if (!token) return json({ ok: false, error: 'No token' }, 400);
    await env.RADIO_SECRETS.put('apple_music_user_token', token);
    return json({ ok: true });
  }

  // POST /apple-sync — server-side Apple Music sync using stored tokens
  if (path === '/apple-sync' && method === 'POST') {
    try {
      const userToken = await env.RADIO_SECRETS.get('apple_music_user_token');
      if (!userToken) return json({ ok: false, error: 'No Apple Music user token. Click Sync Apple Music in admin first to authorize.' }, 401);

      const privKey = await env.RADIO_SECRETS.get('apple_musickit_private_key');
      const keyId = 'CN395VFX55';
      const teamId = 'X2B5SZQGDS';
      if (!privKey) return json({ ok: false, error: 'Apple MusicKit key not configured' }, 500);

      // Generate developer token (JWT)
      const header = btoa(JSON.stringify({ alg: 'ES256', kid: keyId })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
      const now = Math.floor(Date.now()/1000);
      const payload = btoa(JSON.stringify({ iss: teamId, iat: now, exp: now + 3600 })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
      const sigInput = `${header}.${payload}`;

      // Import private key and sign
      const pemBody = privKey.replace(/-----.*?-----/g,'').replace(/\s/g,'');
      const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, new TextEncoder().encode(sigInput));
      const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
      const devToken = `${sigInput}.${sigB64}`;

      const amHeaders = { 'Authorization': `Bearer ${devToken}`, 'Music-User-Token': userToken, 'Content-Type': 'application/json' };

      // Find or create Music Fellowship playlist
      const PLAYLIST_NAME = 'Music Fellowship';
      let playlistId = null;
      let offset = 0;
      while (!playlistId) {
        const r = await fetch(`https://api.music.apple.com/v1/me/library/playlists?limit=25&offset=${offset}`, { headers: amHeaders });
        if (!r.ok) { const e = await r.json(); return json({ ok: false, error: 'Apple Music API error: ' + (e.errors?.[0]?.detail || r.status) }); }
        const data = await r.json();
        const match = (data.data || []).find(p => p.attributes?.name === PLAYLIST_NAME);
        if (match) { playlistId = match.id; break; }
        if (!data.next || (data.data||[]).length < 25) break;
        offset += 25;
      }

      // Get all Apple Music IDs from DB sorted newest first
      const rows = await db.prepare('SELECT apple_music_id FROM tracks WHERE enabled=1 AND apple_music_id IS NOT NULL ORDER BY COALESCE(shared_at, added_at) DESC').all();
      const catalogIds = (rows.results || []).map(r => r.apple_music_id);

      if (!playlistId) {
        // Create playlist
        const cr = await fetch('https://api.music.apple.com/v1/me/library/playlists', {
          method: 'POST', headers: amHeaders,
          body: JSON.stringify({ attributes: { name: PLAYLIST_NAME, description: 'Songs shared in the Music Fellowship WhatsApp group.' }, relationships: { tracks: { data: catalogIds.slice(0,100).map(id => ({ id, type: 'songs' })) } } })
        });
        const cd = await cr.json();
        playlistId = cd.data?.[0]?.id;
        if (!playlistId) return json({ ok: false, error: 'Failed to create playlist: ' + JSON.stringify(cd).slice(0,200) });
      }

      // Add all tracks in batches of 100
      let added = 0;
      for (let i = 0; i < catalogIds.length; i += 100) {
        const batch = catalogIds.slice(i, i + 100);
        const ar = await fetch(`https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks`, {
          method: 'POST', headers: amHeaders,
          body: JSON.stringify({ data: batch.map(id => ({ id, type: 'songs' })) })
        });
        if (!ar.ok && ar.status !== 204) { const e = await ar.json(); return json({ ok: false, error: 'Add failed: ' + (e.errors?.[0]?.detail || ar.status), added }); }
        added += batch.length;
      }

      await env.RADIO_SECRETS.put('sync_apple_status', JSON.stringify({ done: true, added, at: new Date().toISOString() }));
      return json({ ok: true, added, playlistId });
    } catch(e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /wp-auth — validate aaguts.com WordPress credentials
  if (path === '/wp-auth' && method === 'POST') {
    try {
      const { username, password } = await request.json();
      if (!username || !password) return json({ ok: false, error: 'Missing credentials' }, 400);

      const body = new URLSearchParams({
        log: username,
        pwd: password,
        'wp-submit': 'Log In',
        redirect_to: 'https://aaguts.com/wp-admin/',
        testcookie: '1',
      }).toString();

      const resp = await fetch('https://aaguts.com/wp-login.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': 'wordpress_test_cookie=WP+Cookie+check',
          'User-Agent': 'Mozilla/5.0',
        },
        body,
        redirect: 'manual',
      });

      const location = resp.headers.get('location') || '';
      const setCookie = resp.headers.get('set-cookie') || '';
      // Success: redirects to wp-admin AND sets the logged_in cookie
      const ok = (resp.status === 302 && location.includes('wp-admin') && !location.includes('wp-login')) ||
                 setCookie.includes('wordpress_logged_in_');

      return json({ ok });
    } catch(e) {
      return json({ ok: false, error: 'Auth check failed' }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
