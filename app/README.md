# GUTS Radio (`radio-web`)

A quiet, collaborative web radio for the **Music Fellowship** WhatsApp group.

- Auto-collects music URLs (Spotify, YouTube, Apple Music, etc.) shared in the group
- Normalizes them into a single canonical track via [song.link / odesli](https://song.link) (free, no API key)
- Plays them back via embedded YouTube — works on any device with no account
- Tracks reactions (❤️ 🔥 💯 👎) and plays
- **Weighted rotation**: popular tracks come around more often; unpopular ones get less play but never zero (recovery context — every voice gets a turn)

> Sister project: a simpler YouTube-playlist sync lives at `whatsapp-watcher/radio/` and is independent.

---

## Layout

```
radio-web/
├── lib/
│   ├── db.js          # SQLite schema + helpers (better-sqlite3)
│   ├── odesli.js      # song.link / odesli normalizer
│   ├── weights.js     # weighted rotation engine
│   └── api.js         # /radio + /api/radio/* HTTP handlers (mounted into med26 server)
├── public/
│   ├── index.html
│   ├── style.css      # cream + sienna, calm
│   └── player.js      # YouTube IFrame API, queue, reactions
├── sync.js            # WhatsApp JSONL → tracks (read-only)
├── launchd/com.timeclaw.radio-sync.plist
├── radio.db           # SQLite (gitignored if you choose; small enough to commit)
└── README.md
```

## Setup (already done)

1. Deps installed: `npm install`
2. DB schema initialized: `node lib/db.js`
3. First sync ran: `node sync.js` (pulled tracks from `whatsapp-watcher/messages/120363427268795660_g.us/`)
4. Mounted into med26 web server at `/Users/doorliss/.openclaw/workspace/health_data/web/server.js` — serves `/radio` and `/api/radio/*`

## URLs

- **Local**: <http://127.0.0.1:3027/radio>
- **Tailnet**: `http://<mac-mini-tailscale-ip>:3026/radio`
- **Public**: <https://timeclaw.io/radio> *(if med26 web server is exposed at that hostname; otherwise see "DNS / public" below)*

## API

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/radio/queue?n=10` | Weighted-random next-up queue (excludes last 5 played) |
| `GET`  | `/api/radio/recent` | Last 20 plays |
| `GET`  | `/api/radio/all` | Full catalog ordered by weight |
| `GET`  | `/api/radio/track/:id` | One track + reactions |
| `POST` | `/api/radio/react` | Body `{track_id, type}` where type ∈ `heart|fire|hundred|down` |
| `POST` | `/api/radio/play`  | Body `{track_id}` — record a play |
| `GET`  | `/api/radio/stats` | Quick counts |

## Weight rules

| Event | Δ weight |
|---|---|
| ❤️ heart | +0.3 |
| 🔥 fire | +0.4 |
| 💯 hundred | +0.5 |
| 👎 down | −0.5 |
| play | +0.05 (capped at +1.0 per session) |
| daily decay | −0.02 / day |
| floor | 0.1 (never zero) |
| ceiling | 5.0 |

Queue is a weighted-random shuffle (exponential-key trick). Last 5 played are excluded if catalog ≥ 6.

## Periodic sync

Install once:

```bash
cp /Users/doorliss/timeclaw/radio-web/launchd/com.timeclaw.radio-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.timeclaw.radio-sync.plist
```

Runs every 15 minutes; idempotent (tracks `share_messages.message_id`).

## Adding new tracks manually

```bash
cd /Users/doorliss/timeclaw/radio-web && node sync.js
```

## DNS / public access

`timeclaw.io` is fronted by CloudFront → S3 (`med26-video-pipeline`). If you want
`timeclaw.io/radio` to point at this dynamic backend:

- **Easy path**: front it via Cloudflare/Tailscale Funnel → mac-mini:3027
- **Static path**: build a static export and upload `public/` to S3 under `radio/`,
  then point `/api/radio/*` at the dynamic backend (e.g. via a Lambda@Edge rule
  or a separate subdomain). The current build assumes a single backend that
  serves both static and API.

## YouTube Validation (`validate.js`)

The validator checks every track's YouTube ID to ensure it can actually be embedded:

```bash
# Validate all tracks (skips recently validated ones)
node validate.js

# Force re-validate everything
node validate.js --force

# Dry run — see what would change without writing to DB
node validate.js --dry-run

# Test a single track by DB id
node validate-one.js <track_id>

# Test a raw YouTube ID directly
node validate-one.js --yt <youtube_id>
```

### What it checks

- **Deleted/removed**: video ID not found in YouTube Data API
- **Embed disabled**: `status.embeddable = false` (uploader disabled 3rd-party embeds)
- **Private**: video is private
- **Geo-blocked**: `contentDetails.regionRestriction` blocks US viewers
- **oembed**: additional HTTP liveness signal

### What it does with broken videos

1. Searches YouTube for `"<artist> <title> official"` with `videoEmbeddable=true`
2. Batch-checks candidates via the Data API
3. Picks the first working one (most views first, embeddable, public, US-available)
4. Updates `tracks.youtube_id` in the DB
5. If no replacement works → sets `tracks.enabled = 0` (excluded from queue)

### Database columns added

| Column | Type | Purpose |
|---|---|---|
| `last_validated_at` | TEXT | ISO timestamp of last validation run |
| `validation_status` | TEXT | `ok`, `replaced`, `disabled`, or `error` |

### When to re-run

- **Weekly cron** (recommended): tracks validated < 7 days ago are skipped automatically
- **After adding new tracks**: run `node validate.js` to check new IDs
- **After a wave of breakage** (e.g. label pulls videos): run `node validate.js --force`

Suggested cron (add to crontab via `crontab -e`):

```
# Re-validate GUTS Radio YouTube IDs every Sunday at 3am
0 3 * * 0 cd /Users/doorliss/timeclaw/radio-web && node validate.js >> logs/validate.log 2>&1
```

### First-run results (2026-05-06)

- **155 tracks** checked
- **152 OK** — no changes needed
- **1 replaced** — Prince Super Bowl XLI (embed disabled → replaced with working mirror)
- **0 disabled** — no tracks were without any working alternative
- **2 skipped** — recently validated (from test runs)

---

## Notes / follow-ups

- Only 6 tracks in the Music Fellowship group as of 2026-05-05; sync will pick up
  more as members share.
- 3 of 6 tracks have direct YouTube IDs; the other 3 (Spotify-only) fall back to
  a YouTube *search* embed in the player so the user can pick the right match.
- **WhatsApp reactions**: the watcher's current JSONL schema doesn't capture
  `message.reactions`. `sync.js` looks for them defensively but for now they
  arrive via the web UI only. Easy fix: extend `watcher.js` to log reactions —
  left to that subagent's territory.
- Coexists with `whatsapp-watcher/radio/` (different folder, different DB,
  different cron). They don't share state.
