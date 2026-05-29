# watcher — WhatsApp Watcher

Node.js process that monitors a WhatsApp group and forwards shared music URLs to the radio API.

Runs on a Mac or any Linux VPS. Built on [whatsapp-web.js](https://wwebjs.dev).

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: set RADIO_API_URL to your Cloudflare Pages URL
```

## First-time login

```bash
node login.js
```

Scan the QR code from WhatsApp → Linked Devices. Session is saved to `.wwebjs_auth/` (gitignored). You only do this once.

## Configure groups

```bash
node list-groups.js    # list all groups you're in
node select-groups.js  # interactive picker to mark groups as watched
```

Or edit `groups.json` directly. Groups tagged `"music"` will have music URLs forwarded to the radio.

## Run

```bash
node watcher.js
```

On Mac, use the included launchd plist to run it as a background service:

```bash
# Edit the plist to fill in your path and RADIO_API_URL, then:
cp launchd/com.whatsapp-playlist.watcher.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.whatsapp-playlist.watcher.plist
```

On Linux/VPS, use PM2:

```bash
RADIO_API_URL=https://your-deployment.pages.dev pm2 start watcher.js --name whatsapp-playlist
```

## How it works

- Stores all messages from watched groups as JSONL in `messages/<group-id>/YYYY-MM-DD.jsonl`
- For groups tagged `music`: extracts YouTube, Spotify, and Apple Music URLs and POSTs them to `/api/radio/import-urls`
- Read-only — sending messages from this process is disabled at the code level

## groups.json

```json
[
  {
    "id": "120363427268795660@g.us",
    "name": "Music Fellowship",
    "watch": true,
    "tag": "music"
  }
]
```

Get group IDs by running `node list-groups.js` after login.
