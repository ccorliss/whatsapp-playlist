// GUTS Radio player - sticky now-playing, play/pause toggle,
// localStorage persistence, drag/drop, shuffle, filter badge counts.

const LS_KEY = 'guts_radio_v2'; // bumped to clear stale state

const state = {
  playOrder: [],
  currentIndex: -1,
  current: null,
  player: null,
  ytReady: false,
  ytPlayerState: -1,   // YT player state code
  catalogFilter: 'all',
  shuffle: false,
};

let dragSrcId = null;
let searchQuery = '';
let sortCol = 'date';
let sortDir = 'desc';
let authorFilter = null;
let hiddenTracks = new Set();
let mutedTracks  = new Set(); // personal mute: skip during playback, stay visible

function loadHidden() {
  try { hiddenTracks = new Set(JSON.parse(localStorage.getItem('guts_hidden') || '[]')); } catch(_) { hiddenTracks = new Set(); }
  try { mutedTracks  = new Set(JSON.parse(localStorage.getItem('guts_muted')  || '[]')); } catch(_) { mutedTracks  = new Set(); }
}
function saveHidden() {
  try { localStorage.setItem('guts_hidden', JSON.stringify([...hiddenTracks])); } catch(_) {}
}
function saveMuted() {
  try { localStorage.setItem('guts_muted', JSON.stringify([...mutedTracks])); } catch(_) {}
}
function toggleMute(id) {
  if (mutedTracks.has(id)) mutedTracks.delete(id);
  else mutedTracks.add(id);
  saveMuted();
  syncMuteButton();
  renderCatalog();
}
function syncMuteButton() {
  const btn = document.getElementById('btn-mute');
  if (!btn || !state.current) return;
  const muted = mutedTracks.has(state.current.id);
  btn.textContent = muted ? '🔇' : '🔇';
  btn.style.opacity = muted ? '1' : '0.5';
  btn.title = muted ? 'Unmute' : 'Mute for me only';
  btn.classList.toggle('muted-active', muted);
}
function toggleHide(id) {
  if (hiddenTracks.has(id)) hiddenTracks.delete(id);
  else hiddenTracks.add(id);
  saveHidden();
  renderCatalog();
}

// ── localStorage ──────────────────────────────────────────────
function saveLS() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      filter: state.catalogFilter,
      trackId: state.current ? state.current.id : null,
      shuffle: state.shuffle,
      order: state.shuffle ? state.playOrder.map(t => t.id) : null,
    }));
  } catch(_) {}
}

function loadLS() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch(_) { return {}; }
}

document.getElementById('reset-btn').addEventListener('click', () => {
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem('guts_hidden');
  localStorage.removeItem('guts_muted');
  location.reload();
});

document.getElementById('btn-mute')?.addEventListener('click', () => {
  if (state.current) toggleMute(state.current.id);
});

// ── Helpers ───────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error('API ' + path + ': ' + r.status);
  return r.json();
}
const $ = sel => document.querySelector(sel);

// Abbreviate last name: "Justin Faulkner" → "Justin F.", "Mark M." stays "Mark M."
function abbrevName(name) {
  if (!name) return '';
  name = name.trim();
  // Strip emoji decorations at start/end
  const clean = name.replace(/^[\s\u2000-\u3300\uD800-\uDFFF]+|[\s\u2000-\u3300\uD800-\uDFFF]+$/gu, '').trim() || name;
  // Remove date-like suffixes (e.g. "Kristen R 4/21/20" → "Kristen R")
  const parts = clean.split(/\s+/).filter(p => !/^\d/.test(p));
  if (parts.length < 2) return parts[0] || clean;
  const first = parts[0];
  const last = parts[parts.length - 1];
  // Already a single-letter initial (with or without dot) - keep it
  if (/^[A-Za-z]\.?$/.test(last)) return first + '\u00a0' + last[0].toUpperCase() + '.';
  // Full last name - abbreviate
  return first + '\u00a0' + last[0].toUpperCase() + '.';
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relTime(iso) {
  if (!iso) return '';
  const dt = (Date.now() - new Date(iso.endsWith('Z') ? iso : iso + 'Z')) / 1000;
  if (Number.isNaN(dt)) return '';
  if (dt < 60) return 'just now';
  if (dt < 3600) return Math.round(dt/60) + 'm ago';
  if (dt < 86400) return Math.round(dt/3600) + 'h ago';
  return Math.round(dt/86400) + 'd ago';
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const diff = Math.floor((Date.now() - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch(_) { return ''; }
}

// ── Play / Pause toggle ───────────────────────────────────────
function syncPlayBtn() {
  const playing = state.ytPlayerState === 1;
  const btn = $('#btn-play');
  if (btn) btn.textContent = playing ? '⏸ Pause' : '▶ Play';
  const miniPlay = document.getElementById('mini-play');
  if (miniPlay) miniPlay.textContent = playing ? '⏸' : '▶';
}

function syncMiniPlayer(t) {
  const mp = document.getElementById('mini-player');
  if (!mp) return;
  if (!t) { mp.classList.remove('visible'); return; }
  mp.classList.add('visible');
  const thumb = document.getElementById('mini-thumb');
  if (thumb) { thumb.src = t.thumbnail_url || ''; }
  const title = document.getElementById('mini-title');
  if (title) title.textContent = t.title || 'Untitled';
  const artist = document.getElementById('mini-artist');
  if (artist) artist.textContent = t.artist || '';
}

// ── Stats + filter badge counts ───────────────────────────────
async function refreshStats() {
  try {
    const s = await api('/api/radio/stats');
    $('#stats').textContent = `${s.tracks} tracks · ${s.sharers} sharers · ${s.plays} plays`;
    const c = s.counts || s;
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n || ''; };
    set('badge-all',   c.all   || '');
    set('badge-month', c.month || '');
    set('badge-week',  c.week  || '');
    set('badge-today', c.today || '');
  } catch(_) {}
}

// ── Now Playing ───────────────────────────────────────────────
function renderNowPlaying(t) {
  $('#title').textContent  = t ? (t.title  || 'Untitled') : '-';
  $('#artist').textContent = t ? (t.artist || '')         : '';
  $('#shared-by').textContent = t && t.shared_by
    ? `Shared by ${abbrevName(t.shared_by)}${t.shared_at ? ' · ' + relTime(t.shared_at) : ''}`
    : '';

  for (const k of ['heart','fire','hundred','down']) {
    const el = document.querySelector(`[data-count="${k}"]`);
    if (el) el.textContent = (t && t.reactions && t.reactions[k]) || 0;
  }

  // Commentary
  const cm = $('#commentary');
  if (cm && t) {
    const parts = [];
    if (t.emojis) parts.push(`<span class="emojis">${esc(t.emojis)}</span>`);
    if (t.commentary) parts.push(`"${esc(t.commentary)}"`);
    cm.innerHTML = parts.join(' ');
    cm.style.display = parts.length ? '' : 'none';
  }

  // Song link pills
  const setPill = (id, url) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (url) { el.href = url; el.style.display = ''; } else el.style.display = 'none';
  };
  if (t) {
    setPill('link-songlink', t.song_link_url);
    setPill('link-youtube',  t.youtube_id ? `https://www.youtube.com/watch?v=${t.youtube_id}` : null);
    setPill('link-spotify',  t.spotify_url);
    setPill('link-apple',    t.apple_url);
  }
}

// ── Catalog ───────────────────────────────────────────────────
async function loadCatalog(filter, { applyShuffleOrder = null } = {}) {
  filter = filter || state.catalogFilter;
  state.catalogFilter = filter;
  try {
    const { tracks } = await api(`/api/radio/all?sort=date&filter=${encodeURIComponent(filter)}`);
    sortByDate(tracks); // always load date-sorted; caller manages shuffle
    state.playOrder = tracks;

    if (applyShuffleOrder && applyShuffleOrder.length) {
      // Restore a saved shuffle order exactly
      const idMap = new Map(state.playOrder.map(t => [t.id, t]));
      const restored = applyShuffleOrder.map(id => idMap.get(id)).filter(Boolean);
      const restoredSet = new Set(applyShuffleOrder);
      const newTracks = state.playOrder.filter(t => !restoredSet.has(t.id));
      state.playOrder = [...restored, ...newTracks];
    }

    if (!applyShuffleOrder) applySort(state.playOrder);
    if (state.current) {
      state.currentIndex = state.playOrder.findIndex(t => t.id === state.current.id);
    }
    updateSortHeaders();
    renderCatalog();
    saveLS();
  } catch(e) { console.warn('catalog load failed', e); }
}

function sortByDate(arr) {
  arr.sort((a, b) => new Date(b.shared_at || b.added_at || 0) - new Date(a.shared_at || a.added_at || 0));
}

function applySort(arr) {
  const dir = sortDir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let va, vb;
    if (sortCol === 'date') {
      va = new Date(a.shared_at || a.added_at || 0).getTime();
      vb = new Date(b.shared_at || b.added_at || 0).getTime();
    } else if (sortCol === 'title') {
      va = (a.title || '').toLowerCase();
      vb = (b.title || '').toLowerCase();
      return va < vb ? -dir : va > vb ? dir : 0;
    } else if (sortCol === 'author') {
      va = (a.shared_by || '').toLowerCase();
      vb = (b.shared_by || '').toLowerCase();
      return va < vb ? -dir : va > vb ? dir : 0;
    }
    return (va - vb) * dir;
  });
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = '';
    if (th.dataset.sort === sortCol) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function renderCatalog() {
  if (chatMode && _allChatMsgs.length) setTimeout(renderInlineChat, 50);
  const tbody = document.querySelector('#catalog-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = searchQuery.toLowerCase();
  const visible = state.playOrder.filter(t => {
    if (hiddenTracks.has(t.id)) return false;
    if (authorFilter && t.shared_by !== authorFilter) return false;
    if (!q) return true;
    return (t.title      || '').toLowerCase().includes(q) ||
           (t.artist     || '').toLowerCase().includes(q) ||
           (t.shared_by  || '').toLowerCase().includes(q) ||
           abbrevName(t.shared_by).toLowerCase().includes(q) ||
           (t.commentary || '').toLowerCase().includes(q);
  });

  for (let i = 0; i < visible.length; i++) {
    const t = visible[i];
    const globalIdx = state.playOrder.indexOf(t);
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (state.current && t.id === state.current.id) tr.classList.add('now-playing-row');
    if (mutedTracks.has(t.id)) tr.classList.add('muted-row');

    // Reactions
    const rb = [];
    if (t.reactions?.heart)   rb.push('❤️' + t.reactions.heart);
    if (t.reactions?.fire)    rb.push('🔥' + t.reactions.fire);
    if (t.reactions?.hundred) rb.push('💯' + t.reactions.hundred);
    if (t.reactions?.prayer)  rb.push('🙏' + t.reactions.prayer);
    const reactionHtml = rb.length
      ? `<span class="react-pills">${rb.join(' ')}</span>`
      : `<span class="react-mini">
          <button class="react-sm" data-tid="${t.id}" data-rtype="heart">❤️</button>
          <button class="react-sm" data-tid="${t.id}" data-rtype="fire">🔥</button>
          <button class="react-sm" data-tid="${t.id}" data-rtype="hundred">💯</button>
          <button class="react-sm" data-tid="${t.id}" data-rtype="prayer">🙏</button>
        </span>`;

    // Per-track links
    const rowLinks = [];
    if (t.song_link_url) rowLinks.push(`<a class="row-link" href="${esc(t.song_link_url)}" target="_blank" rel="noopener" title="song.link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity:.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></a>`);
    if (t.youtube_id)   rowLinks.push(`<a class="row-link" href="https://www.youtube.com/watch?v=${esc(t.youtube_id)}" target="_blank" rel="noopener" title="YouTube"><svg width="14" height="14" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>`);
    if (t.spotify_url)  rowLinks.push(`<a class="row-link" href="${esc(t.spotify_url)}" target="_blank" rel="noopener" title="Spotify"><svg width="14" height="14" viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg></a>`);
    if (t.apple_url || t.apple_music_id) rowLinks.push(`<a class="row-link" href="${esc(t.apple_url || ('https://music.apple.com/us/song/' + t.apple_music_id))}" target="_blank" rel="noopener" title="Apple Music"><svg width="14" height="14" viewBox="0 0 24 24" fill="#FC3C44"><path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.064-2.31-2.19-3.09a5.33 5.33 0 00-1.72-.77c-.63-.15-1.26-.19-1.9-.19H6.026c-.55 0-1.1.04-1.64.13C3.14.19 2.19.78 1.38 1.67.65 2.49.17 3.49.04 4.61A11.17 11.17 0 000 6.01v11.96c0 .51.04 1.01.12 1.51.2 1.24.78 2.26 1.69 3.08.82.74 1.81 1.18 2.91 1.35.55.09 1.1.11 1.66.11h11.29c.6 0 1.2-.04 1.79-.15 1.07-.19 2.01-.65 2.79-1.38.87-.81 1.42-1.82 1.6-3 .1-.59.14-1.19.14-1.79V6.12zm-6.97 9.26c0 .14-.01.28-.04.42a1.8 1.8 0 01-.87 1.25c-.27.16-.57.24-.88.24-.66 0-1.28-.37-1.64-.93l-.02-.03-3.43-5.93v6.57c0 .12-.01.25-.03.37a1.79 1.79 0 01-1.77 1.48 1.79 1.79 0 01-1.78-1.78V8.62c0-.12.01-.25.03-.37A1.79 1.79 0 018.38 6.77c.66 0 1.28.37 1.64.93l.02.03 3.43 5.93V7.09c0-.12.01-.25.03-.37A1.79 1.79 0 0115.27 5.3c.99 0 1.79.8 1.79 1.79v8.27z"/></svg></a>`);

    const thumbHtml = t.thumbnail_url
      ? `<img class="track-thumb" src="${esc(t.thumbnail_url)}" alt="" loading="lazy" />`
      : `<div class="track-thumb-placeholder">♫</div>`;

    tr.innerHTML = `
      <td class="drag-col">
        <span class="drag-handle">&#x2630;</span>
        <button class="hide-btn" data-id="${t.id}" title="Hide">&times;</button>
      </td>
      <td>
        <div class="track-cell">
          ${thumbHtml}
          <div class="track-info">
            <div class="track-title-main">${esc(t.title || '(untitled)')}${t.emojis ? ' ' + t.emojis : ''}</div>
            <div class="track-artist-sub">${esc(t.artist || '')}</div>
            ${t.commentary && state.current && t.id === state.current.id ? `<div class="commentary-pill">"${esc(t.commentary.slice(0,80))}${t.commentary.length>80?'\u2026':''}"</div>` : ''}
          </div>
        </div>
      </td>
      <td class="links-col">${rowLinks.join('')}</td>
      <td class="sharer-col author-cell" data-author="${esc(t.shared_by || '')}" title="Filter by ${esc(abbrevName(t.shared_by) || 'unknown')}" style="cursor:pointer">${esc(abbrevName(t.shared_by) || '-')}${authorFilter === t.shared_by ? ' <span class="author-active">×</span>' : ''}</td>
      <td class="date-col">${fmtDate(t.shared_at || t.added_at)}</td>
      <td class="react-col">${reactionHtml}</td>
    `;

    // Hide button
    tr.querySelector('.hide-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleHide(t.id);
    });

    // Click to play
    tr.addEventListener('click', e => {
      if (e.target.closest('.react-sm') || e.target.closest('.row-link') || e.target.closest('.drag-handle') || e.target.closest('.hide-btn')) return;
      state.currentIndex = globalIdx;
      playTrack(t);
    });

    // Drag/drop
    tr.draggable = true;
    tr.addEventListener('dragstart', e => { dragSrcId = String(t.id); tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tr.addEventListener('dragend',   () => { tr.classList.remove('dragging'); tbody.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
    tr.addEventListener('dragover',  e => {
      e.preventDefault();
      if (String(t.id) === dragSrcId) return;
      tbody.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      tr.classList.add('drag-over');
    });
    tr.addEventListener('dragleave', e => { if (!tr.contains(e.relatedTarget)) tr.classList.remove('drag-over'); });
    tr.addEventListener('drop', e => {
      e.preventDefault(); tr.classList.remove('drag-over');
      if (!dragSrcId || String(t.id) === dragSrcId) return;
      const si = state.playOrder.findIndex(x => String(x.id) === dragSrcId);
      const di = state.playOrder.findIndex(x => String(x.id) === String(t.id));
      if (si === -1 || di === -1) return;
      const [m] = state.playOrder.splice(si, 1);
      state.playOrder.splice(di, 0, m);
      if (state.current) state.currentIndex = state.playOrder.findIndex(x => x.id === state.current.id);
      dragSrcId = null;
      renderCatalog();
    });

    tbody.appendChild(tr);
  }

  const total = state.playOrder.length;
  $('#catalog-count').textContent = q ? `(${visible.length} of ${total})` : `(${total})`;
}

// ── Shuffle ───────────────────────────────────────────────────
document.getElementById('shuffle-btn').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  document.getElementById('shuffle-btn').classList.toggle('active', state.shuffle);
  if (state.shuffle) shuffleArr(state.playOrder);
  else sortByDate(state.playOrder);
  if (state.current) state.currentIndex = state.playOrder.findIndex(t => t.id === state.current.id);
  renderCatalog();
  saveLS();
});

// ── Author filter ──────────────────────────────────────────────
document.getElementById('catalog-table').addEventListener('click', e => {
  const cell = e.target.closest('.author-cell');
  if (!cell) return;
  const author = cell.dataset.author;
  if (!author) return;
  authorFilter = authorFilter === author ? null : author;
  renderCatalog();
});

// ── Column sort ──────────────────────────────────────────────
(function setupColumnSort() {
  const thead = document.querySelector('#catalog-table thead');
  if (!thead) return;
  thead.addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const col = th.dataset.sort;
    if (sortCol === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortCol = col;
      sortDir = col === 'date' ? 'desc' : 'asc';
    }
    // Disable shuffle when manually sorting
    if (state.shuffle) {
      state.shuffle = false;
      document.getElementById('shuffle-btn').classList.remove('active');
    }
    applySort(state.playOrder);
    if (state.current) state.currentIndex = state.playOrder.findIndex(t => t.id === state.current.id);
    updateSortHeaders();
    renderCatalog();
    saveLS();
  });
})();

// ── Live search ──────────────────────────────────────────────
(function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    searchQuery = input.value.trim();
    renderCatalog();
  });
})();

// ── Filter bar ────────────────────────────────────────────────
document.getElementById('filter-bar').addEventListener('click', async e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Keep export links in sync with current filter
  const f = btn.dataset.filter;
  const m3u = document.getElementById('export-m3u');
  const csv = document.getElementById('export-csv');
  if (m3u) m3u.href = `/api/radio/export.m3u?filter=${f}`;
  if (csv) csv.href = `/api/radio/export.csv?filter=${f}`;
  await loadCatalog(f);
});

// ── Inline reactions ──────────────────────────────────────────
document.getElementById('catalog-table').addEventListener('click', async e => {
  const btn = e.target.closest('.react-sm');
  if (!btn) return;
  e.stopPropagation();
  const tid = parseInt(btn.dataset.tid, 10);
  const rtype = btn.dataset.rtype;
  if (!tid || !rtype) return;
  btn.disabled = true;
  try {
    await api('/api/radio/react', { method: 'POST', body: JSON.stringify({ track_id: tid, type: rtype }) });
    await loadCatalog();
  } catch(err) { btn.disabled = false; }
});

// ── Advance ───────────────────────────────────────────────────
function advance() {
  if (!state.playOrder.length) return;
  let next = state.currentIndex >= state.playOrder.length - 1 ? 0 : state.currentIndex + 1;
  // Skip muted tracks (max one full loop to avoid infinite)
  const start = next;
  while (mutedTracks.has(state.playOrder[next]?.id)) {
    next = next >= state.playOrder.length - 1 ? 0 : next + 1;
    if (next === start) break; // all muted - play anyway
  }
  state.currentIndex = next;
  playTrack(state.playOrder[next]);
}

// ── React ─────────────────────────────────────────────────────
async function react(type) {
  if (!state.current) return;
  try {
    const r = await api('/api/radio/react', { method: 'POST', body: JSON.stringify({ track_id: state.current.id, type }) });
    if (r?.reactions) { state.current.reactions = r.reactions; renderNowPlaying(state.current); }
    const idx = state.playOrder.findIndex(t => t.id === state.current.id);
    if (idx !== -1 && r?.reactions) state.playOrder[idx].reactions = r.reactions;
    renderCatalog();
  } catch(e) {}
}

document.querySelectorAll('[data-react]').forEach(btn => btn.addEventListener('click', () => react(btn.dataset.react)));

// ── Player sources ────────────────────────────────────────────
function getSpotifyId(t) {
  const m = (t.spotify_url || t.original_url || '').match(/spotify\.com\/track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function buildSources(t) {
  const spId = getSpotifyId(t);
  const ytId = t.youtube_id;
  const q    = encodeURIComponent(`${t.artist||''} ${t.title||''}`.trim());
  const srcs = [];
  if (ytId) srcs.push({ type:'youtube', ytId });
  if (spId) srcs.push({ type:'spotify', spId });
  if (q)    srcs.push({ type:'yt-search', q });
  srcs.push({ type:'none' });
  return srcs;
}

let _fbTimer = null;
function clearFB() { if (_fbTimer) { clearTimeout(_fbTimer); _fbTimer = null; } }

function setPlayerMode(mode) {
  const p    = $('#player');
  const hint = $('#player-hint');
  const wrap = document.getElementById('np-player-wrap');
  if (!p) return;
  p.className = 'player-' + mode;
  // Show/hide the entire player section
  if (wrap) wrap.style.display = (mode === 'empty') ? 'none' : '';
  if (hint) hint.style.display = (mode === 'empty') ? 'none' : '';
  // Spotify embed has its own controls - hide our play/pause
  const playBtn = $('#btn-play');
  if (playBtn) playBtn.style.display = (mode === 'spotify') ? 'none' : '';
}

function renderSourceTabs(track) {
  const tabs = document.getElementById('source-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  const sources = [];
  if (track.youtube_id)    sources.push({ id: 'youtube', label: '▶ YouTube' });
  if (getSpotifyId(track)) sources.push({ id: 'spotify', label: '🎵 Spotify' });
  if (!sources.length) return;
  // "Player" label
  const lbl = document.createElement('span');
  lbl.className = 'links-label';
  lbl.textContent = 'Player';
  tabs.appendChild(lbl);
  for (const src of sources) {
    const btn = document.createElement('button');
    btn.className = 'source-tab' + (state.activeSource === src.id ? ' active' : '');
    const icon = src.id === 'youtube' ? `<svg width="13" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>` : `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`;
    btn.innerHTML = icon + ' ' + (src.id === 'youtube' ? 'YouTube' : 'Spotify');
    btn.dataset.src = src.id;
    btn.addEventListener('click', () => loadSource(state.current, src.id));
    tabs.appendChild(btn);
  }
}

function loadSource(track, sourceId) {
  state.activeSource = sourceId;
  document.querySelectorAll('.source-tab').forEach(b => b.classList.toggle('active', b.dataset.src === sourceId));

  if (state.player?.destroy) { try { state.player.destroy(); } catch(_){} state.player = null; }

  if (sourceId === 'youtube' && track.youtube_id) {
    setPlayerMode('yt');
    $('#player').innerHTML = '<div id="player-iframe"></div>';
    state.player = new YT.Player('player-iframe', {
      videoId: track.youtube_id,
      playerVars: { autoplay:1, rel:0, modestbranding:1, playsinline:1 },
      events: {
        onReady: e => { try { e.target.playVideo(); } catch(_){} },
        onStateChange: e => { state.ytPlayerState = e.data; syncPlayBtn(); if (e.data === YT.PlayerState.ENDED) advance(); },
        onError: e => {
          console.warn('YT embed error', e.data, 'for', track.title);
          // 101/150 = embed disabled; try Spotify then YT search before giving up
          const spId = getSpotifyId(track);
          if (spId) { loadSource(track, 'spotify'); }
          else {
            // YT search fallback on same track - don't skip to next
            const q = encodeURIComponent(`${track.artist||''} ${track.title||''}`.trim());
            setPlayerMode('search');
            $('#player').innerHTML = '';
            const ifr = document.createElement('iframe');
            ifr.src = `https://www.youtube.com/embed?listType=search&list=${q}&autoplay=1`;
            ifr.allow = 'autoplay; encrypted-media; picture-in-picture';
            ifr.frameBorder = '0'; ifr.style.cssText = 'width:100%;height:100%;display:block';
            $('#player').appendChild(ifr);
            setHint('YouTube search (original unavailable)');
          }
        },
      },
    });
    setHint('YouTube');
    return;
  }

  if (sourceId === 'spotify') {
    const spId = getSpotifyId(track);
    if (!spId) { advance(); return; }
    setPlayerMode('spotify');
    $('#player').innerHTML = '';
    const ifr = document.createElement('iframe');
    ifr.src = `https://open.spotify.com/embed/track/${spId}?utm_source=guts-radio&autoplay=1`;
    ifr.width = '100%'; ifr.height = '152'; ifr.frameBorder = '0';
    ifr.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    $('#player').appendChild(ifr);
    state.ytPlayerState = 1;
    setHint('Spotify - use embed controls');
    return;
  }

  // YT search fallback
  const q = encodeURIComponent(`${track.artist||''} ${track.title||''}`.trim());
  setPlayerMode('search');
  $('#player').innerHTML = '';
  const ifr = document.createElement('iframe');
  ifr.src = `https://www.youtube.com/embed?listType=search&list=${q}&autoplay=1`;
  ifr.allow = 'autoplay; encrypted-media; picture-in-picture';
  ifr.frameBorder = '0'; ifr.style.cssText = 'width:100%;height:100%;display:block';
  $('#player').appendChild(ifr);
  state.ytPlayerState = 1; syncPlayBtn();
  setHint('YouTube search');
}

function setHint(text) {
  const h = $('#player-hint');
  if (h) { h.textContent = text; h.style.display = ''; }
}

function trySource(track, sources, idx) {
  clearFB();
  if (idx >= sources.length) { advance(); return; }
  const src = sources[idx];
  if (src.type === 'none') { setPlayerMode('empty'); state.ytPlayerState = -1; syncPlayBtn(); return; }
  if (src.type === 'youtube')   { loadSource(track, 'youtube'); return; }
  if (src.type === 'spotify')   { loadSource(track, 'spotify'); return; }
  if (src.type === 'yt-search') { loadSource(track, 'yt-search'); return; }
  advance();
}

async function playTrack(t) {
  state.current = t;
  const idx = state.playOrder.findIndex(x => x.id === t.id);
  if (idx !== -1) state.currentIndex = idx;

  renderNowPlaying(t);
  renderSourceTabs(t);
  syncMuteButton();
  syncMiniPlayer(t);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  clearFB();
  // Auto-pick best source: YouTube first, then Spotify
  state.activeSource = t.youtube_id ? 'youtube' : (getSpotifyId(t) ? 'spotify' : 'yt-search');
  trySource(t, buildSources(t), 0);
  renderCatalog();
  saveLS();

  try {
    const r = await api('/api/radio/play', { method:'POST', body: JSON.stringify({ track_id: t.id }) });
    if (r?.weight != null) t.weight = r.weight;
  } catch(_) {}
}

// ── YT API ready ──────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => { state.ytReady = true; };

// ── Controls ──────────────────────────────────────────────────
$('#btn-play').addEventListener('click', () => {
  // Toggle play/pause if YT player active
  if (state.player && typeof state.player.getPlayerState === 'function') {
    const s = state.player.getPlayerState();
    if (s === 1) { state.player.pauseVideo(); state.ytPlayerState = 2; syncPlayBtn(); return; }
    if (s === 2) { state.player.playVideo();  state.ytPlayerState = 1; syncPlayBtn(); return; }
  }
  const t = state.current || (state.playOrder.length ? state.playOrder[0] : null);
  if (t) playTrack(t);
});

$('#btn-skip').addEventListener('click', () => advance());

// ── Playlist exports ─────────────────────────────────────────────
// Load shared playlist IDs (YouTube + Spotify Option A)
async function loadSharedPlaylistIds() {
  try {
    const r = await api('/api/radio/playlist-ids');
    const ytBtn = document.getElementById('pl-youtube');
    const spBtn = document.getElementById('pl-spotify-shared');
    if (r.youtube && ytBtn) { ytBtn.href = r.youtube.url; ytBtn.style.display = ''; }
    if (r.spotify && spBtn) { spBtn.href = r.spotify.url; spBtn.style.display = ''; }
  } catch(_) {}
}

// Spotify PKCE export button (Option B)
(function setupSpotifyExport() {
  const btn = document.getElementById('pl-spotify-export');
  const statusEl = document.getElementById('pl-export-status');
  if (!btn) return;

  // Handle OAuth callback on page load
  if (typeof SpotifyAuth !== 'undefined') {
    SpotifyAuth.handleCallback().then(wasCallback => {
      if (wasCallback) {
        if (statusEl) statusEl.textContent = '✓ Connected to Spotify';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
    }).catch(e => console.warn('Spotify callback error:', e));

    // Update button label if already connected
    if (SpotifyAuth.isConnected()) btn.textContent = '🎵 Export to Spotify';
  }

  btn.addEventListener('click', async () => {
    if (typeof SpotifyAuth === 'undefined') {
      if (statusEl) statusEl.textContent = 'Spotify not configured.';
      return;
    }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Connecting...';
    try {
      const result = await SpotifyAuth.exportPlaylist(
        state.catalogFilter,
        state.playOrder,
        { onStatus: msg => { if (statusEl) statusEl.textContent = msg; } }
      );
      if (result?.playlistUrl) {
        btn.textContent = '🎵 Open Playlist';
        btn.onclick = () => window.open(result.playlistUrl, '_blank');
        if (statusEl) statusEl.innerHTML = `✓ <a href="${result.playlistUrl}" target="_blank" rel="noopener">Open in Spotify</a>`;
      }
    } catch(e) {
      if (statusEl) statusEl.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
})();

// ── Apple Music export ─────────────────────────────────────
(function setupAppleMusic() {
  const btn = document.getElementById('pl-apple-export');
  const statusEl = document.getElementById('pl-export-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (typeof AppleMusic === 'undefined') {
      if (statusEl) statusEl.textContent = 'Apple Music not available.';
      return;
    }
    // Show modal
    const modal = document.getElementById('export-modal');
    const modalStatus = document.getElementById('modal-status');
    const modalBar = document.getElementById('modal-bar');
    const modalTitle = document.getElementById('modal-title');
    if (modal) modal.style.display = 'flex';
    btn.disabled = true;
    try {
      const result = await AppleMusic.exportToAppleMusic(
        state.playOrder,
        {
          onStatus: msg => {
            if (modalStatus) modalStatus.textContent = msg;
            if (statusEl) statusEl.textContent = msg;
          },
          onProgress: (n, total) => {
            if (modalBar) modalBar.style.width = Math.round(n/total*100) + '%';
            if (modalStatus) modalStatus.textContent = `Searching catalog\u2026 ${n}/${total}`;
          }
        }
      );
      if (modalBar) modalBar.style.width = '100%';
      const title = document.getElementById('modal-title');
      const actions = document.getElementById('modal-actions');
      const verb = result.isNew ? 'Added' : 'Updated';
      if (title) title.textContent = `Playlist ${verb}!`;
      if (modalStatus) modalStatus.innerHTML = `"Music Fellowship" has been ${result.isNew ? 'added to' : 'updated in'} your Apple Music library with ${result.added} songs.<br><br><span style="color:#8e8e93;font-size:0.75rem">Open Apple Music → Library → Playlists</span>`;
      // Use music:// deep link to open the app directly; fall back to https on non-Apple devices
      const appleAppUrl = result.playlistId ? `music://library/playlist/${result.playlistId}` : 'music://';
      const appleWebUrl = result.playlistId ? `https://music.apple.com/library/playlist/${result.playlistId}` : 'https://music.apple.com';
      if (actions) actions.innerHTML = `
        <a href="${appleAppUrl}" 
           style="display:inline-block;background:linear-gradient(135deg,#fc3c44,#fc6d4b);color:#fff;border:none;border-radius:8px;padding:9px 20px;font-weight:600;font-size:0.85rem;text-decoration:none;margin-bottom:8px"
           onclick="setTimeout(()=>window.open('${appleWebUrl}','_blank'),800)">Open in Apple Music</a><br>
        <button onclick="document.getElementById('export-modal').style.display='none'" 
          style="background:none;border:none;color:#636366;cursor:pointer;font-size:0.78rem">Dismiss</button>`;
      if (statusEl) statusEl.textContent = `✓ ${result.added} songs in Apple Music`;
    } catch(e) {
      if (modalStatus) modalStatus.textContent = '✗ ' + e.message;
      if (statusEl) statusEl.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });
})();

// ── Import ────────────────────────────────────────────────────
(function setupImport() {
  const fileInput = document.getElementById('import-file');
  const btn       = document.getElementById('import-btn');
  const status    = document.getElementById('import-status');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file) { status.textContent = 'Pick a .txt file first.'; return; }
    status.textContent = 'Uploading...'; btn.disabled = true;
    try {
      const text = await file.text();
      const r = await fetch('/api/radio/import', { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:text });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      status.textContent = data.added === 0
        ? `✓ All ${data.skipped} tracks already in the catalog.`
        : `✓ Added ${data.added} new track${data.added!==1?'s':''} (${data.skipped} already existed).`;
      if (data.added > 0) { await refreshStats(); await loadCatalog(); }
    } catch(e) { status.textContent = '✗ ' + e.message; }
    finally { btn.disabled = false; fileInput.value = ''; }
  });
})();

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  const saved = loadLS();

  // Restore filter
  const savedFilter = saved.filter || 'all';
  state.catalogFilter = savedFilter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === savedFilter);
  });

  // Restore shuffle
  if (saved.shuffle) {
    state.shuffle = true;
    document.getElementById('shuffle-btn').classList.add('active');
  }

  loadHidden();
  await refreshStats();
  // Pass saved shuffle order into loadCatalog so it's applied in one step
  await loadCatalog(savedFilter, { applyShuffleOrder: saved.shuffle && saved.order ? saved.order : null });

  // Restore current track (highlight only, no autoplay)
  if (saved.trackId && state.playOrder.length) {
    const idx = state.playOrder.findIndex(t => t.id === saved.trackId);
    if (idx !== -1) {
      state.current      = state.playOrder[idx];
      state.currentIndex = idx;
      renderNowPlaying(state.current);
      renderCatalog();
      $('#player-hint').textContent = '▶ Press Play';
    }
  }

  if (!state.current && state.playOrder.length) {
    state.current      = state.playOrder[0];
    state.currentIndex = 0;
    renderNowPlaying(state.playOrder[0]);
    renderCatalog();
    setPlayerMode('empty'); // no black box until user hits Play
  }

  loadSharedPlaylistIds();
  setInterval(refreshStats, 60_000);
})();

// ── Mini player controls ──────────────────────────────────────
document.getElementById('mini-play')?.addEventListener('click', () => {
  document.getElementById('btn-play')?.click();
});
document.getElementById('mini-skip')?.addEventListener('click', () => advance());
document.getElementById('mini-info')?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── Chat console ──────────────────────────────────────────────
const _nameColors = ['cn0','cn1','cn2','cn3','cn4','cn5','cn6','cn7'];
const _nameMap = {};
let _nameIdx = 0;
function nameColor(n) {
  if (!_nameMap[n]) _nameMap[n] = _nameColors[_nameIdx++ % _nameColors.length];
  return _nameMap[n];
}
function msgTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
}
function firstName(full) {
  if (!full) return null;
  if (/@lid@|@c\.us|\d{15,}/.test(full)) return null;
  return full.replace(/^[~\s]+/,'').split(/\s+/)[0];
}
function stripNoise(body) {
  return (body||'').replace(/<This message was (edited|deleted)>/gi,'').replace(/\u200e/g,'').trim();
}
function allUrls(body) {
  return !body || body.trim().split(/\s+/).every(w => /^https?:\/\//.test(w));
}

function buildBubble(m) {
  const name = firstName(m.author);
  if (!name) return null;
  const body = stripNoise(m.body);
  if (allUrls(body) && !m.track_title) return null;

  const el = document.createElement('div');
  el.className = 'cmsg';
  el.dataset.trackId = m.track_id || '';
  el.dataset.ts = m.timestamp_ms || '';

  const color = nameColor(m.author);
  const ts = msgTime(m.timestamp_ms);

  let bodyHtml;
  if (m.track_title) {
    const comment = body && !allUrls(body) ? `<div style="margin-bottom:4px">${esc(body)}</div>` : '';
    const thumb = m.thumbnail_url
      ? `<img src="${esc(m.thumbnail_url)}" loading="lazy"/>`
      : `<div style="width:32px;height:32px;border-radius:4px;background:rgba(255,255,255,.08);flex-shrink:0"></div>`;
    bodyHtml = comment + `<div class="ctrack" data-play-id="${m.track_id}" style="cursor:pointer">` +
      thumb +
      `<div class="ctrack-info">` +
      `<span class="ctrack-title">${esc(m.track_title)}</span>` +
      (m.track_artist ? `<span class="ctrack-artist">${esc(m.track_artist)}</span>` : '') +
      `</div></div>`;
  } else {
    bodyHtml = `<div>${esc(body)}</div>`;
  }

  el.innerHTML =
    `<div class="cname ${color}">${esc(name)}</div>` +
    `<div class="cbubble">${bodyHtml}</div>` +
    `<div class="cts">${ts}</div>`;
  return el;
}

let _chatBefore = null, _chatLoading = false;

async function loadChat(prepend) {
  if (_chatLoading) return;
  _chatLoading = true;
  const feed = document.getElementById('chat-feed');
  if (!feed) { _chatLoading = false; return; }
  try {
    const url = '/api/radio/chat?limit=500' + (_chatBefore ? '&before=' + _chatBefore : '');
    const d = await fetch(url).then(r => r.json());
    const msgs = (d.messages || []).reverse(); // oldest first
    if (!msgs.length && !prepend) {
      feed.innerHTML = '<div style="font-size:11px;opacity:.25;padding:8px">No messages loaded yet.</div>';
    }
    const oldH = feed.scrollHeight;
    msgs.forEach(m => {
      const el = buildBubble(m);
      if (!el) return;
      if (prepend) feed.insertBefore(el, feed.firstChild);
      else feed.appendChild(el);
    });
    if (msgs.length === 500) {
      _chatBefore = d.messages.length ? d.messages[d.messages.length - 1].timestamp_ms : null;
      const btn = document.getElementById('chat-load-more');
      if (btn) btn.style.display = '';
    } else {
      const btn = document.getElementById('chat-load-more');
      if (btn) btn.style.display = 'none';
    }
    if (!prepend) feed.scrollTop = feed.scrollHeight;
    else feed.scrollTop = feed.scrollHeight - oldH;
  } catch(e) { console.warn('chat', e); }
  _chatLoading = false;
}

function chatJumpToTrack(id) {
  if (!id) return;
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  feed.querySelectorAll('.cmsg.highlighted').forEach(e => e.classList.remove('highlighted'));
  const el = feed.querySelector(`.cmsg[data-track-id="${id}"]`);
  if (el) {
    el.classList.add('highlighted');
    // Scroll only within the feed container — never let this scroll the window
    const elTop = el.offsetTop - feed.offsetTop;
    feed.scrollTo({ top: elTop - feed.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
    setTimeout(() => el.classList.remove('highlighted'), 3500);
  }
}

// ── Chat toggle ──────────────────────────────────────────────
let chatMode = localStorage.getItem('chatMode') === '1';
let _allChatMsgs = [];

function setChatMode(on) {
  chatMode = on;
  localStorage.setItem('chatMode', on ? '1' : '0');
  const btn = document.getElementById('chat-toggle-btn');
  const panel = document.getElementById('chat-console');
  if (btn) btn.classList.toggle('active', on);
  if (panel) panel.style.display = on ? '' : 'none';
  if (on && !_allChatMsgs.length) loadChat();
}

function renderInlineChat() {
  // Remove existing inline rows
  document.querySelectorAll('.chat-inline-row').forEach(e => e.remove());
  if (!chatMode || !_allChatMsgs.length) return;

  // Get track rows sorted by their shared_at data attribute
  const tbody = document.querySelector('#catalog-table tbody, .catalog tbody, table tbody');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
  if (!rows.length) return;

  // Build map of track_id → DOM row
  const rowMap = {};
  rows.forEach(r => { rowMap[parseInt(r.dataset.id)] = r; });

  // Group messages by track_id
  const byTrack = {};
  _allChatMsgs.forEach(m => {
    if (!m.track_id) return;
    if (!byTrack[m.track_id]) byTrack[m.track_id] = [];
    byTrack[m.track_id].push(m);
  });

  // Inject messages after each track row — show all linked messages
  Object.keys(byTrack).forEach(tid => {
    const row = rowMap[parseInt(tid)];
    if (!row) return;
    const msgs = byTrack[tid].filter(m => firstName(m.author)); // skip @lid IDs
    msgs.forEach(m => {
      const el = document.createElement('tr');
      el.className = 'chat-inline-row';
      const name = firstName(m.author);
      const color = nameColor(m.author);
      const rawBody = stripNoise(m.body);
      const hasText = rawBody && !allUrls(rawBody);
      const bodyPart = hasText ? esc(rawBody.slice(0, 100)) : '<span style="opacity:.35">shared this</span>';
      const ts = m.timestamp_ms ? new Date(m.timestamp_ms).toLocaleDateString([], {month:'short',day:'numeric'}) : '';
      el.innerHTML = `<td colspan="99" style="padding:0"><div style="display:flex;align-items:baseline;gap:6px;padding:3px 12px;font-size:11px;opacity:.6;border-left:2px solid rgba(255,255,255,.06)"><span style="font-weight:700;flex-shrink:0" class="${color}">${esc(name)}</span><span style="flex:1;word-break:break-word">${bodyPart}</span><span style="opacity:.4;font-size:10px;flex-shrink:0">${ts}</span></div></td>`;
      row.after(el);
    });
  });
}

document.getElementById('chat-toggle-btn')?.addEventListener('click', function() {
  setChatMode(!chatMode);
});

// Init
if (chatMode) {
  const btn = document.getElementById('chat-toggle-btn');
  if (btn) btn.classList.add('active');
}

loadChat();

// Click on chat track card → play that track
document.getElementById('chat-feed')?.addEventListener('click', function(e) {
  const card = e.target.closest('.ctrack[data-play-id]');
  if (!card) return;
  const id = parseInt(card.dataset.playId);
  if (!id) return;
  const track = state.playOrder.find(t => t.id === id) || (state.current?.id === id ? state.current : null);
  if (track) { playTrack(track); return; }
  // Not in current queue — fetch it
  fetch('/api/radio/track/' + id).then(r => r.json()).then(d => { if (d.id) playTrack(d); }).catch(() => {});
});

// Hook track selection → jump chat
(function() {
  const orig = playTrack;
  playTrack = async function(t) {
    await orig(t);
    if (t?.id) setTimeout(() => chatJumpToTrack(t.id), 300);
  };
})();

