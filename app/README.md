# app — Cloudflare Pages + Workers

Static player frontend + API backend, all running free on Cloudflare.

## Stack

- **Frontend**: Static HTML/CSS/JS in `public/`
- **API**: Cloudflare Pages Functions in `functions/api/radio/`
- **Database**: Cloudflare D1 (SQLite at edge) — single source of truth
- **Secrets**: Cloudflare KV (`RADIO_SECRETS` binding)

## Deploy

```bash
npm install -g wrangler
wrangler login

# First time: create D1 database and KV namespace
wrangler d1 create guts-radio
wrangler kv:namespace create RADIO_SECRETS

# Copy the IDs into wrangler.toml, then deploy
wrangler pages deploy public
```

## Config

See `wrangler.toml` for variable names. Fill in your own values.

Secrets go in KV (not in wrangler.toml):
- `SPOTIFY_CLIENT_SECRET`
- `APPLE_MUSICKIT_PRIVATE_KEY`

Set them via dashboard or:
```bash
wrangler kv:key put --binding RADIO_SECRETS SPOTIFY_CLIENT_SECRET "your-secret"
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/radio/queue` | Weighted-random track queue |
| `GET` | `/api/radio/all` | Full catalog |
| `GET` | `/api/radio/track/:id` | Single track |
| `POST` | `/api/radio/react` | `{track_id, type}` — heart/fire/hundred/down |
| `POST` | `/api/radio/play` | `{track_id}` — record a play |
| `POST` | `/api/radio/import` | Paste WhatsApp export text |
| `POST` | `/api/radio/import-urls` | `{items: [{url, author, timestampISO}]}` — batch ingest |
| `POST` | `/api/radio/spotify-sync` | Sync to Spotify playlist |
| `POST` | `/api/radio/apple-sync` | Sync to Apple Music playlist |

## Admin UI

`/admin` — import chat exports, trigger syncs, manage tracks.
