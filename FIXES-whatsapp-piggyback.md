# WhatsApp piggyback self-chat — fix report

**Context:** first-agent install per `/init-first-agent` docs for WhatsApp (piggyback mode, `ASSISTANT_HAS_OWN_NUMBER` unset). Expected flow: user DMs themselves ("Note to self"); bot listens and replies. Result before fixes: silent drop — bot never responded.

Three independent bugs had to be addressed. Two are code regressions in `origin/channels` branch, one is a setup-time format mismatch in `scripts/init-first-agent.ts` / the `/init-first-agent` skill.

---

## 1. `fromMe` filter kills self-chat (regression)

**File:** `src/channels/whatsapp.ts` (channels branch)
**Introduced by:** commit `c02ac06` — *"feat(v2): add formatting, approvals, and echo filter to WhatsApp adapter"*, 2026-04-14

### Root cause

The original design used a text prefix (`${ASSISTANT_NAME}:`) that the outbound path stamps on every bot reply, and the inbound path checks that prefix to break loops in piggyback mode. That design works for self-chat because legit user messages never carry the prefix.

`c02ac06` replaced the prefix-based `isBotMessage` check with a blanket `if (fromMe) continue`. In piggyback, **every** message sent from any linked device (including the phone the human types on) carries `fromMe: true` — so the filter drops all user input. `isBotMessage` at the line below became dead code.

### Diff (restores pre-regression design)

```diff
 const fromMe = msg.key.fromMe || false;
-// Filter bot's own messages to prevent echo loops.
-// fromMe is always true for messages sent from this linked device,
-// regardless of ASSISTANT_HAS_OWN_NUMBER mode.
-if (fromMe) continue;
-
-const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`);
+// Loop-break: detect bot's own outbound echo.
+// Dedicated number: any fromMe is the bot itself.
+// Piggyback: all linked-device messages arrive fromMe=true (including
+// legit self-chat), so use the ASSISTANT_NAME prefix that the send
+// path stamps on bot output (see the prefixed branch below).
+const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
+  ? fromMe
+  : content.startsWith(`${ASSISTANT_NAME}:`);
+if (isBotMessage) continue;
```

### How to verify

Before: no log output on inbound self-chat message; container idle.
After: `Message routed` logged, container spawned.

---

## 2. Sender LID not translated to phone JID

**File:** `src/channels/whatsapp.ts` (channels branch)

### Root cause

Modern WhatsApp delivers `msg.key.participant` as a **LID** (e.g. `200141281751165@lid`) instead of the phone JID — even in 1:1 DMs and self-chat. The adapter already has a `translateJid(jid)` helper (line ~203) that uses `sock.signalRepository.lidMapping.getPNForLID` to resolve LID → `<phone>@s.whatsapp.net`. It calls `translateJid` on `chatJid` (line ~496) and on group participants (line ~243), **but not on the sender** used to build `userId` downstream. Result: router gets `userId = whatsapp:<lid>@lid`, which never matches the owner row (stored in phone-JID form).

### Diff

```diff
-const sender = msg.key.participant || msg.key.remoteJid || '';
+// Resolve sender LID → phone JID so userId matches user_roles rows
+// (which are keyed by canonical phone JID). The chatJid above is
+// already translated; the sender needs the same treatment.
+const rawSender = msg.key.participant || msg.key.remoteJid || '';
+const sender = await translateJid(rawSender);
 const senderName = msg.pushName || sender.split('@')[0];
```

### How to verify

Before: `MESSAGE DROPPED — unknown sender` with `userId="whatsapp:<digits>@lid"`.
After: same log line (if the DB row mismatch #3 below isn't fixed) with `userId="whatsapp:<phone>@s.whatsapp.net"` — LID resolved.

---

## 3. `init-first-agent` registers owner in short form; adapter sends JID form

**File:** `scripts/init-first-agent.ts`, and the `/init-first-agent` + `/add-whatsapp` skills.

### Root cause

Format mismatch in what goes into `users` / `user_roles` vs. what the adapter emits:

| Source | Format stored/emitted |
|---|---|
| `/init-first-agent` skill step 2 prompt | "Your user id on this channel" — user enters plain number `5217712412825` |
| `scripts/init-first-agent.ts:namespacedUserId()` | `whatsapp:5217712412825` (no normalization) |
| `messaging_groups.platform_id` auto-registered by router | `5217712412825@s.whatsapp.net` (JID form, canonical) |
| Adapter on inbound | `sender = "5217712412825@s.whatsapp.net"` → router builds `userId = "whatsapp:5217712412825@s.whatsapp.net"` |

Owner row never matches because it was stored without the `@s.whatsapp.net` suffix.

The `/add-whatsapp` skill already documents the canonical JID form (`<phone>@s.whatsapp.net`), but `/init-first-agent` does not normalize to that form for WhatsApp.

### Why the first welcome message "worked" and misled us

`init-first-agent.ts` step 5 delivers the welcome by writing it directly into the session via the host CLI socket, using the `--user-id` from the command line (short form). That path bypasses the adapter's sender construction entirely, so the one-off welcome routed fine with `userId="whatsapp:5217712412825"`. Real inbound messages via Baileys have never worked on this install.

### Fix applied (data-only, per-install)

```js
// data/v2.db
UPDATE users      SET id      = 'whatsapp:<phone>@s.whatsapp.net'
                  WHERE id    = 'whatsapp:<phone>';
UPDATE user_roles SET user_id = 'whatsapp:<phone>@s.whatsapp.net'
                  WHERE user_id = 'whatsapp:<phone>';
```

### Upstream fix (suggested)

Two options, pick one:

- **(a)** In `scripts/init-first-agent.ts`, detect `channel === 'whatsapp'` and append `@s.whatsapp.net` to handle if missing. Narrow, but doesn't help other adapters that may have similar issues (Signal, iMessage, Matrix — any native adapter with per-channel JID conventions).
- **(b)** In the adapter, strip `@s.whatsapp.net` before passing `sender` to the router (normalize to bare phone). Downstream format becomes `whatsapp:<phone>`. Cleaner long-term but changes the identity key across all existing WhatsApp installs — breaking change.

(a) is the safer, backwards-compatible fix.

---

## Verification end-to-end

After all three fixes, the pipeline from WhatsApp self-chat to agent reply is:

```
user types in self-chat
  → Baileys messages.upsert (fromMe=true, participant=<lid>)
  → translateJid resolves LID → <phone>@s.whatsapp.net
  → isBotMessage=false (no ASSISTANT_NAME prefix on user text)
  → router builds userId = whatsapp:<phone>@s.whatsapp.net
  → canAccessAgentGroup returns { allowed: true, reason: 'owner' }
  → session created, container spawned
  → agent replies, bot stamps "ASSISTANT_NAME: " prefix
  → prefix triggers isBotMessage=true on echo — loop broken
```

## Remaining known gap

The CLAUDE.md compose in `src/claude-md-compose.ts` does not emit an `@./CLAUDE.local.md` include in the generated `CLAUDE.md`. Claude Code auto-loads `CLAUDE.local.md` as a sibling, so in practice the personality file gets picked up — but only because of that convention, not because the composed file references it. Worth documenting in `claude-md-compose.ts` or adding the explicit include for clarity.
