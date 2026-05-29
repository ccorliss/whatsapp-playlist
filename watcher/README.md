# whatsapp-watcher

Watch selected WhatsApp groups for Curtis (GUTS, Back From the Edge, Audio Anonymous, etc.), persist messages, and post a daily 8am PT digest to his WhatsApp self-chat.

Built on [whatsapp-web.js](https://wwebjs.dev/guide/) with `LocalAuth` so the QR scan only happens once.

## Layout

```
whatsapp-watcher/
├── lib/client.js        shared whatsapp-web.js client factory (LocalAuth)
├── login.js             Phase 1 — scan QR, persist session
├── list-groups.js       Phase 1 — write groups.json
├── select-groups.js     Phase 2 — mark watch:true on GUTS/BFTE/Audio Anonymous
├── watcher.js           Phase 2 — long-running listener
├── digest.js            Phase 3 — daily summary → WhatsApp self-chat
├── launchd/             Phase 4 — plists for launchd
├── groups.json          (generated) all groups + watch flag
├── messages/<gid>/      (generated) <YYYY-MM-DD>.jsonl + media/
├── .wwebjs_auth/        (generated, gitignored) persistent session
└── logs/                runtime logs
```

## First-run, in order

```bash
cd /Users/doorliss/.openclaw/workspace/whatsapp-watcher

# 1) Login — prints a QR; scan it from WhatsApp → Linked Devices.
npm run login

# 2) Enumerate every group you're in.
npm run list

# 3) Auto-mark GUTS / BFTE / Audio Anonymous groups as watched.
#    (Edit groups.json by hand to add/remove later.)
npm run select

# 4) Smoke-test the watcher (Ctrl-C to stop).
npm run watch

# 5) Smoke-test a digest with a wider window, dry-run (no WhatsApp send).
node digest.js --hours 168 --dry-run
```

## Daily operation (launchd)

```bash
# Install plists
ln -sf /Users/doorliss/.openclaw/workspace/whatsapp-watcher/launchd/com.curtis.whatsapp-watcher.plist \
       ~/Library/LaunchAgents/com.curtis.whatsapp-watcher.plist
ln -sf /Users/doorliss/.openclaw/workspace/whatsapp-watcher/launchd/com.curtis.whatsapp-digest.plist \
       ~/Library/LaunchAgents/com.curtis.whatsapp-digest.plist

# Load
launchctl load -w ~/Library/LaunchAgents/com.curtis.whatsapp-watcher.plist
launchctl load -w ~/Library/LaunchAgents/com.curtis.whatsapp-digest.plist

# Status / stop
launchctl list | grep curtis.whatsapp
launchctl unload ~/Library/LaunchAgents/com.curtis.whatsapp-watcher.plist
launchctl unload ~/Library/LaunchAgents/com.curtis.whatsapp-digest.plist

# Force-run a digest now (without waiting for 8am)
launchctl start com.curtis.whatsapp-digest
```

The watcher service is `KeepAlive: true` with a 30s `ThrottleInterval`, so a crash won't spin the CPU.

## How the digest decides what matters

For each watched group, `digest.js` reads the last 24h of `messages/<gid>/*.jsonl`, drops obvious noise (single emoji, "amen", "thanks"), and asks `anthropic/claude-haiku-4-5` (via `openclaw capability model run`) to surface, in this order:

1. Direct mentions of Curtis
2. Action items, commitments, meeting changes
3. Resources shared (links, audio, PDFs)
4. Significant personal shares (>200 chars)
5. Newcomers / milestones / birthdays

Anything else is dropped. If a group is genuinely quiet, no message is posted for it.

The digest is delivered through OpenClaw:

```
openclaw agent --channel whatsapp --to +18057227915 --deliver --message "..."
```

## Audio Anonymous

When the watcher sees an `audio/*` attachment in any group tagged `audio-anonymous`, the file is:

1. Saved to `messages/<gid>/media/<filename>` (always)
2. Mirrored to `../aa_speakers/inbox/<filename>` for review

It is **not** auto-uploaded to S3 or auto-named. The existing manifest at `aa_speakers/manifest.json` expects curated metadata (episode, speaker, location, steps, event), which only Curtis can supply. Treat the inbox as a queue for the existing flow.

## Editing what's watched

`groups.json` is hand-editable. Toggle `watch: true|false` per group, or edit the regex set in `select-groups.js` and re-run `npm run select`.

## Notes / limits

- `whatsapp-web.js` drives the real WhatsApp Web — keep it gentle. One client per account, no aggressive polling.
- The session cookie lives in `.wwebjs_auth/`. Don't commit that. Don't sync it. If you log out from your phone, you'll need to re-scan.
- The watcher only writes messages from groups marked `watch: true`. DMs are ignored.
- Curtis's own messages in watched groups are also captured (via `message_create` + `fromMe`) so context isn't lopsided.
