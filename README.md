# whatsapp-playlist

WhatsApp group music player. Watches a WhatsApp group for shared songs, builds a weighted playlist, and plays it in the browser.

## How it works

```
WhatsApp group
     │
     ├── watcher (Node.js, runs on Mac or VPS)
     │       detects music URLs (YouTube, Spotify, Apple Music)
     │       POSTs to /api/radio/import-urls
     │
     └── admin UI
             paste a WhatsApp chat export
             same /api/radio/import-urls endpoint
                     │
                     ▼
             Cloudflare D1 (SQLite at edge)
             song.link enrichment → YouTube + Spotify + Apple Music IDs
                     │
                     ▼
             Cloudflare Pages (static player)
             weighted random queue, reactions, play history
```

**Single database: Cloudflare D1.** The watcher and the admin import UI both talk to the same API. No local SQLite.

---

## Deployment

### 1. Cloudflare (free tier)

```bash
cd app
npm install -g wrangler
wrangler login
wrangler pages deploy public  # first deploy
```

On first deploy, create the D1 database and KV namespace:

```bash
wrangler d1 create guts-radio
wrangler kv:namespace create RADIO_SECRETS
```

Copy the IDs into `app/wrangler.toml`, then redeploy.

**Environment variables** (set in Cloudflare dashboard → Pages → Settings → Variables):

| Variable | Description |
|---|---|
| `YOUTUBE_PLAYLIST_ID` | YouTube playlist to sync to |
| `SPOTIFY_PLAYLIST_ID` | Spotify playlist to sync to |
| `SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `APPLE_MUSICKIT_KEY_ID` | MusicKit key ID |

Secrets (KV or dashboard secrets — not plain env):
- `SPOTIFY_CLIENT_SECRET`
- `APPLE_MUSICKIT_PRIVATE_KEY`

### 2. Watcher (Mac or VPS)

```bash
cd watcher
npm install
cp .env.example .env
# Edit .env: set RADIO_API_URL to your Cloudflare Pages URL
```

**First-time WhatsApp login:**

```bash
node login.js    # scan QR code once
```

Session is saved to `.wwebjs_auth/` (gitignored). You only do this once.

**Select which groups to watch:**

```bash
node select-groups.js   # interactive picker
```

Groups tagged `music` in `groups.json` will have music URLs forwarded to the radio.

**Run the watcher:**

```bash
node watcher.js
```

Or use the included launchd plist (`launchd/com.whatsapp-playlist.watcher.plist`) to run it as a macOS service.

For Linux/VPS, use the systemd unit or a process manager like PM2:

```bash
pm2 start watcher.js --name whatsapp-playlist
```

---

## Config reference

### `watcher/groups.json`

Each group entry:

```json
{
  "id": "120363427268795660@g.us",
  "name": "Music Fellowship",
  "watch": true,
  "tag": "music"
}
```

- `watch: true` — store all messages as JSONL
- `tag: "music"` — also forward music URLs to the radio API

### `watcher/.env`

```
RADIO_API_URL=https://your-deployment.pages.dev
```

---

## Manual import

If you don't want to run the watcher, you can import a WhatsApp chat export manually:

1. In WhatsApp: open the group → ⋮ → More → Export chat → Without media
2. Open `https://your-deployment.pages.dev/admin`
3. Paste the export text → Import

Same enrichment pipeline runs either way.

---

## Admin UI

`/admin` — import exports, trigger Spotify/Apple Music syncs, manage tracks.

---

## Structure

```
app/       Cloudflare Pages app (static player + Workers API + D1 schema)
watcher/   Node.js WhatsApp watcher (Mac/VPS)
```
