# Channel management

## create_group

Create a brand-new chat/group on the platform AND auto-wire it to an agent group, in a single tool call. Today only WhatsApp supports this.

Use when the user says *"crea un grupo nuevo llamado X"*, *"hazme un grupo de WhatsApp para Y"*, *"abre un canal nuevo"*, or equivalent **and** the group does not yet exist on the platform.

**Do NOT use create_group if the group might already exist.** Workflow when in doubt:

1. Call `list_discovered_groups` with `name_contains` set to a candidate substring of the user's name.
2. Wait for the result. If a row matches → use `register_channel` on the existing group, **never** create a duplicate.
3. Only if there is no match (and the user confirmed they want a new one) → call `create_group`.

The handler creates the group via Baileys, captures the invite link, then auto-wires using the same isolation/engage/policy parameters as `register_channel`. The agent will receive a system message with `platform_id`, `inviteLink`, and a wiring summary in the next turn — share the invite link with the user so they (and others) can join.

**Patterns reminder**: `engage_pattern` defaults to `\b<assistant-name>\b`. Never write `\bghosty\b/i` — JS regex doesn't parse trailing flag suffixes; the host strips them defensively but the cleaner form is to write `\b[Gg]hosty\b` for case-insensitive matches.

## get_invite_link

Fetch (or regenerate) a WhatsApp group invite link the user can share. Use when:
- The user asks "¿cuál es el link del grupo X?" or "compárteme el invite de Y".
- After a `create_group`, the user lost the link from the original confirmation.
- The user wants to onboard another person to a group the bot is already in.

Bot must be a group admin (it always is for groups it created via `create_group`; for groups joined by other means, may not be).

## leave_group

Bot leaves a WhatsApp group **and** unwires the corresponding NanoClaw entry. **Always confirm with the user first** — the action is visible to other group members ("Ghosty left") and is hard to reverse (requires re-invite + `register_channel`).

Use when the user explicitly says *"sálete del grupo X"* / *"abandona Y"* / *"desconéctate de Z"*. Show: group name, JID, what wirings will be removed. Wait for an explicit "sí" / "confirma" / "dale" before invoking.

## rename_group

Rename a WhatsApp group's subject. Bot must be group admin. Updates both WhatsApp (visible to all members) and NanoClaw's `messaging_groups.name`. Use when the user says *"cambia el nombre del grupo X a Y"*.

## list_channels

Read-only enumeration of all **wired** chats/groups/DMs and which agent group each is connected to. Fire-and-forget; the list arrives in your next chat message (not in the tool's immediate return value).

Use whenever the user asks "¿en qué grupos estás?", "lista los canales", "dónde estás activo", or equivalent. **Never guess or invent the list** — always call this tool and wait for the result before answering.

Optional `channel_type` filter: e.g. `"whatsapp"` to only list WhatsApp chats.

## list_discovered_groups

Read-only list of chats/groups the channel adapter has **seen** — whether or not they are wired. For WhatsApp this means every group your number belongs to that has synced metadata. For Telegram, every chat that has sent a message. Etc.

**This is the tool to use when the user says "regístrame el grupo 'X'" or "agrégate a 'Y'" and gives you a name but not a platform_id.** Workflow:

1. Call `list_discovered_groups` with `name_contains` if you have a partial name.
2. Wait for the result in the next turn.
3. Pick the matching row's `platform_id`.
4. Call `register_channel` with that `platform_id` and the user's intent.

If the user's name doesn't match any row, tell them so — **do not** invent a JID, and **do not** ask the user to paste one unless they volunteer. Suggest they check the group exists or write a message in it so the adapter syncs.

Items tagged `[WIRED]` in the result are already registered — surface that back to the user instead of registering again.

## register_channel

Wire a chat/group/channel to an agent group. Fire-and-forget from here — the host validates the caller's privilege, applies the wiring, and sends you a confirmation message.

Use when the user asks to "add a group," "register this chat," "make you respond in <group-name>," or equivalent.

### Picking `isolation`

**Default: `separate-agent`.** Cross-channel memory leak (notifications to the wrong chat, info from one client appearing in another) is a real failure mode. Start with full isolation; share state only on explicit user request.

- **`separate-agent`** (default) — brand-new agent with its own workspace, memory, and personality. The host auto-derives `folder` from `name` when omitted (e.g. `"Familia Cash"` → `familia-cash`, with `-2/-3` suffix on collision).
- **`separate-session`** — shares workspace + memory with the calling agent, but has its own conversation thread. Use when the user explicitly says *"que sea el mismo asistente"* / *"comparte memoria con X"*.
- **`shared-session`** — feeds messages into the same conversation as the calling agent. Use only for tightly coupled channels for the same project (e.g. GitHub notifications + Slack chat).

If the user is ambiguous, default to `separate-agent` and mention it briefly so they can override. Don't ask before wiring unless they used the words "mismo asistente" / "comparte" / "junto con".

### Picking `engage_mode` + `engage_pattern`

**Default: `engage_mode="pattern"`, `engage_pattern="."`** — engages on every message. The user wants new groups to be immediately useful; mention-only gating is opt-in.

Groups on WhatsApp in piggyback mode (bot shares your number) **cannot use `mention`** — you cannot @-mention your own number. Always use `pattern` there.

- Default for any new channel: `engage_pattern="."`.
- User explicitly asks for mention-only ("solo cuando me menciones"): `engage_pattern="\\b[Gg]hosty\\b"`.
- On Slack/Discord/Telegram with threads, when mention-gating is desired: `engage_mode="mention"` or `mention-sticky`.

### Picking `unknown_sender_policy`

**Default: `public`** — accepts any sender. The user wants new groups to respond to everyone without per-sender approval friction. Tighten on demand.

- **`public`** (default) — anyone can write. Default for new groups.
- **`request_approval`** — first time someone new writes, DM arrives to the owner asking to allow them. Use when the user explicitly asks for an approval gate ("que solo respondan los que apruebe").
- **`strict`** — only owner/admin/member. Silent drop for everyone else. Use only for closed groups where the user wants total lockdown.

### Privilege

You can only register channels on behalf of an owner or admin of the target agent group. If the caller isn't privileged, the host rejects the request and tells you why — relay the message to the user.

### Example

User: *"Agrégate al grupo de WhatsApp 'Familia' (id 120363...@g.us) y responde cuando alguien diga 'ghosty'."*

Call:

```json
{
  "platform_id": "120363...@g.us",
  "channel_type": "whatsapp",
  "name": "Familia",
  "isolation": "separate-agent",
  "engage_mode": "pattern",
  "engage_pattern": "\\b[Gg]hosty\\b",
  "unknown_sender_policy": "request_approval",
  "is_group": true
}
```
