# Checkpoint — WhatsApp self-chat + channel management tools

**Date:** 2026-04-24
**Install:** `root@137.184.179.108:/opt/nanoclaw-v2` (hostname `nanoclaw-v2-test`)

## What we got working end-to-end

1. **WhatsApp piggyback self-chat responds to the owner.** First bug: the `fromMe` filter was dropping every user message (regression `c02ac06` in origin/channels). Second: the sender JID came as a `@lid` that wasn't matched against `user_roles`. Third: init-first-agent had registered the owner without the `@s.whatsapp.net` suffix, mismatching the adapter's canonical form. All three resolved. See `FIXES-whatsapp-piggyback.md` for the full forensics.

2. **The agent can now wire WhatsApp groups to itself from inside the DM**, including resolving a group by name (not just raw JID). Zero terminal required for the owner.

3. **CLAUDE.local.md is now loaded into the agent context.** The Agent SDK's `settingSources: ['project', 'user']` does not include `local`, so the file was being ignored. Fixed the compose template to emit an explicit `@./CLAUDE.local.md` import.

4. **Per-agent personality rules were made enforceable**: Spanish-only output (including status narration), execute tools instead of roleplaying them, verify state before asserting, retry after rejections from prior turns. These live in `groups/dm-with-bliss/CLAUDE.local.md` on the server.

5. **Approval card strings translated to Spanish** (install_packages, add_mcp_server, OneCLI credentials, "Responde con:" in the WhatsApp card template). No i18n framework — direct string replacement since this install is single-user-ES.

## New MCP tools (container side)

All in `container/agent-runner/src/mcp-tools/channels.ts`. All fire-and-forget — result arrives as a system chat message in the agent's next turn.

| Tool | Description | Privilege |
|------|-------------|-----------|
| `register_channel` | Wire an existing chat/group/DM to an agent group. Supports all three isolation levels (`shared-session`, `separate-session`, `separate-agent`). | owner / global_admin / admin_of_group on the target agent group |
| `list_channels` | Enumerate currently wired channels + their agent group, engage mode, session mode, unknown-sender policy. | none (read-only) |
| `list_discovered_groups` | Enumerate chats/groups the adapter has seen (but that aren't necessarily wired) — e.g. every WhatsApp group the piggyback number belongs to. Supports `name_contains` filter. Flags `[WIRED]` rows already connected. | none (read-only) |
| `create_group` | Create a brand-new WhatsApp group via Baileys + auto-wire to an agent group. Returns invite link. v1 parity for `create_group`. | owner / admin (same gate as register_channel) |
| `get_invite_link` | Fetch / regenerate a WhatsApp group invite link. Bot must be group admin. | none (anyone in the conversation can ask) |
| `leave_group` | Bot leaves a WhatsApp group AND removes the corresponding NanoClaw wiring + messaging_group row. Best-effort DB cleanup; if WA leave succeeds but DB cleanup fails, agent is told honestly. | owner / admin |
| `rename_group` | Rename a WhatsApp group's subject. Updates both WhatsApp and `messaging_groups.name`. Bot must be group admin. | owner / admin |

Intended workflow when the user says *"agrega el grupo Familia"*:
1. `list_discovered_groups({ name_contains: "Familia" })` → get platform_id
2. `register_channel({ platform_id, isolation: "separate-session", ... })` → wire
3. Report to user.

## New host module (host side)

`src/modules/channels/`

- `apply.ts` — delivery action handlers:
  - `applyRegisterChannel` — validates caller's privilege (resolves the user from the last *non-agent* message in `messages_in`, not from system notifications), creates `messaging_groups` if missing, creates `messaging_group_agents` wiring. Sanitizes `engage_pattern` to strip `/flags` suffix.
  - `applyListChannels` — reads central DB, notifies agent with formatted list.
  - `applyListDiscoveredGroups` — reads `discovered_channels`, flags wired rows.
- `index.ts` — registers the three delivery actions via `registerDeliveryAction()`.

Wired into `src/modules/index.ts`.

## New DB surface

Migration `014-discovered-channels`:

```sql
CREATE TABLE discovered_channels (
  channel_type   TEXT NOT NULL,
  platform_id    TEXT NOT NULL,
  name           TEXT,
  is_group       INTEGER NOT NULL DEFAULT 0,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
```

Populated by `src/index.ts:onMetadata()` — every `Channel metadata discovered` log line now also upserts a row. Helper: `src/db/discovered-channels.ts`.

## File manifest

| File | Change |
|------|--------|
| `src/claude-md-compose.ts` | Add `@./CLAUDE.local.md` to composed imports (was silently missing) |
| `src/index.ts` | Call `upsertDiscoveredChannel` from `onMetadata` |
| `src/db/migrations/index.ts` | Register migration 014 |
| `src/db/migrations/014-discovered-channels.ts` | **new** — schema |
| `src/db/discovered-channels.ts` | **new** — upsert + list helpers |
| `src/modules/index.ts` | Import `./channels/index.js` |
| `src/modules/channels/index.ts` | **new** — register delivery actions |
| `src/modules/channels/apply.ts` | **new** — handlers |
| `src/modules/self-mod/request.ts` | Translate approval titles/questions to ES |
| `src/modules/approvals/onecli-approvals.ts` | Translate `onecliTitle` to ES |
| `src/channels/whatsapp.ts` (origin/channels) | (1) restore original `isBotMessage` loop-break over the `fromMe` filter (regression fix), (2) call `translateJid(sender)` for LID→phone, (3) "Reply with:" → "Responde con:" |
| `container/agent-runner/src/mcp-tools/channels.ts` | **new** — MCP tools |
| `container/agent-runner/src/mcp-tools/channels.instructions.md` | **new** — agent-facing docs |
| `container/agent-runner/src/mcp-tools/index.ts` | Import `./channels.js` |

## What the bot can and can't do right now

**Can (WhatsApp-only UX, zero terminal):**
- List channels wired to itself.
- List chats/groups it could potentially wire (via Baileys discovery).
- Wire a new group to itself or to any existing agent group (with isolation choice).
- Create a new internal agent (`create_agent`, pre-existing v2 tool). Orphan until wired.
- Install apt/npm packages (with admin approval card).
- Add MCP server to its runtime (with admin approval card).
- Schedule tasks, ask clarifying questions, delegate to other agents.

**Can't yet:**
- **Create a new WhatsApp group** (v1's `create_group`). Requires porting: host HTTP endpoint → `Baileys.sock.groupCreate` → MCP tool that auto-registers the created group. ~40-50 LOC.
- `leave_group`, `list_archived_groups`, `restore_group`, `update_group_name`, `update_profile_picture` (v1 lifecycle tools). None are critical.
- `send_email` / `get_email_stats` (v1 email tools — lived in a dedicated MCP server).
- Custom MCP servers (`kommo`, `easybits`, `smatch`) from v1 `container/mcp-servers/`. None ported.
- Auto-escalation when adapter sees a new group ("hey, someone added me to a group, want to wire it?"). The router's `channelRequestGate` exists but depends on `isMention`, which WhatsApp piggyback can't produce. Separate design problem.

## Gotchas encountered (document so we don't repeat)

1. **Agent SDK settingSources** don't include `local` → `CLAUDE.local.md` is not auto-loaded inside containers despite Claude Code CLI convention. Must be explicitly imported from the composed CLAUDE.md.
2. **`getLastInboundUserId` caveats**: a naïve "most recent inbound" query in the session DB will pick up the host's own `notifyAgent` writes (sender=system, channel_type=agent). Always filter by `channel_type != 'agent'` and `sender != 'system'` when resolving the *calling user* from session state.
3. **Regex engage patterns**: the router compiles via `new RegExp(source)` with no flags argument. LLM-written patterns like `\bghosty\b/i` do not do what they look like — the `/i` ends up as literal characters. `apply.ts` now sanitizes `/source/flags` → `source`.
4. **JID format matters for owner matching.** `user_roles.user_id` for native WhatsApp is `whatsapp:<phone>@s.whatsapp.net`, not `whatsapp:<phone>`. `init-first-agent` is still slightly wrong here — it stores the short form. Worked around at setup; upstream needs a skill-level fix to normalize.
5. **WhatsApp piggyback has no @-mention to self.** Combined with `router.ts:166 if (!isMention) return;`, plain messages inside an unwired group are silent-dropped — no log, no auto-register flow. Registration has to happen from the DM via `register_channel`, not from inside the group.
6. **LLM memory is sticky.** After a rejected tool call, the LLM will confidently report the old rejection on follow-ups instead of re-trying. The fix is in CLAUDE.local.md ("Verificación antes de afirmar" + "Reintentos — no asumas que el error viejo sigue vigente"), plus `docker rm` on the container when rules change significantly.

## Next candidates (by estimated leverage)

1. **Port `create_group`** — unblocks "hola, crea un grupo para el Investigador" which was the user's original frustration.
2. **Fix `init-first-agent` to normalize WhatsApp user_id to JID form** — avoid the owner mismatch trap for future installs.
3. **Relax the `isMention` guard** in `router.ts` so known owners writing in unwired groups can trigger `channelRequestGate` — enables "user writes in group, bot DMs owner to approve registration" UX.
4. **Port email MCP server** (`send_email`, `get_email_stats`) if the user uses email delegation.
5. Custom MCPs from v1 (`kommo`, `smatch`, `easybits`) — user-specific, port on demand.
