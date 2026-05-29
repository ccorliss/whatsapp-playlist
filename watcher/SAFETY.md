# SAFETY.md — WhatsApp Watcher Hard Locks

This system has access to Curtis's personal WhatsApp account, including 20+ sensitive AA recovery groups. **Nothing in this system is allowed to post to those groups.** Period.

## Locks in place

### 1. Watcher (`watcher.js`) is hard read-only
- No `sendMessage`, `sendText`, or `reply` calls anywhere in the code.
- After `client.initialize()`, the `sendMessage`, `sendText`, and `reply` methods are monkey-patched to throw `SAFETY: ... disabled in watcher` if anything ever tries to call them.
- This means even a future bug, regression, or sub-agent mistake cannot accidentally post to a group through the watcher.

### 2. Digest (`digest.js`) destination whitelist
- `ALLOWED_DESTINATIONS = Set(['+18057227915'])` — Curtis's self-chat only.
- `safetyCheck()` runs before every `deliver()` call and:
  - Refuses if the panic switch file `KILL_SEND` exists in this directory.
  - Refuses if the destination is not in the whitelist.
  - Refuses any destination containing `@g.us` (group id format) or `-` (group ids look like `1234-5678@g.us`).

### 3. Panic switch
If anything looks wrong, kill all outbound traffic instantly:

```bash
touch /Users/doorliss/.openclaw/workspace/whatsapp-watcher/KILL_SEND
```

While that file exists, `digest.js` will refuse to send anything. Remove the file to re-enable:

```bash
rm /Users/doorliss/.openclaw/workspace/whatsapp-watcher/KILL_SEND
```

### 4. Group capture is passive
- The watcher listens to `message` and `message_create` events and writes them to local JSONL files.
- No reply, no reaction, no read receipt manipulation, no presence updates.
- No status updates, no profile changes.

## What this system CAN do
- ✅ Read messages from selected groups
- ✅ Save messages to local files in `messages/`
- ✅ Save audio attachments to `messages/<gid>/media/` and `aa_speakers/inbox/`
- ✅ Send a daily digest **to Curtis's self-chat only** (+18057227915)

## What this system CANNOT do (and how it's enforced)
- ❌ Post to any WhatsApp group → enforced by destination whitelist + group-id pattern check + monkey-patched send methods on watcher
- ❌ Reply to a group message → no reply code path exists
- ❌ React to a group message → no reaction code path exists
- ❌ Send to any number other than Curtis's → enforced by `ALLOWED_DESTINATIONS` set
- ❌ Forward error messages, stack traces, or auth tokens to any group → no path to group exists at all

## If you (an AI agent or developer) modify this code

**DO NOT remove or weaken any of the safety guards in this file.** If you need to add legitimate outbound capability, discuss with Curtis first and document the new lock here. The cost of an accidental post into a recovery group is enormous — privacy, dignity, trust. The cost of a slow feature is zero.

## Verification commands

```bash
# Confirm no send paths exist outside safety guards
grep -rn "sendMessage\|sendText\|client\.send\|chat\.send\|msg\.reply" \
  --include="*.js" . | grep -v node_modules | grep -v SAFETY

# Confirm both scripts parse
node --check watcher.js && node --check digest.js
```

Last reviewed: 2026-05-05 by Curtis (asked for hardening before scanning QR).
