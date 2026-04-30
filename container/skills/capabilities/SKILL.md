---
name: capabilities
description: Show what this NanoClaw agent can do — installed skills, MCP tools, group config. Read-only. Use when the user asks "what can you do", "qué sabes hacer", "what's installed", or runs /capabilities.
---

# /capabilities — Agent Capabilities Report

Generate a clean, read-only summary of what this agent group is wired to do. No state changes — pure introspection.

Run when the user asks any of:
- "qué puedes hacer" / "what can you do"
- "qué tienes instalado" / "what's installed"
- "/capabilities", "/caps", "/help"
- "qué tools tienes" / "what tools do you have"

## How to gather the info

Run these in parallel and compile into the report below.

### 1. Installed container skills

```bash
ls -1 ~/.claude/skills/ 2>/dev/null
```

Each entry is a symlink to `/app/skills/<name>`. The directory name is the skill identifier. Read each `~/.claude/skills/<name>/SKILL.md` first frontmatter line to get its description.

### 2. Group config (container.json)

```bash
cat /workspace/group/container.json 2>/dev/null
```

Pull these fields:
- `groupName` and `assistantName` — your identity in this group
- `mcpServers` keys — extra MCP servers wired beyond the built-in `mcp__nanoclaw__*`
- `packages.apt` and `packages.npm` — extras installed in the image
- `imageTag` — useful only if user is debugging

### 3. Group memory / personality

```bash
test -f /workspace/group/CLAUDE.md && wc -l /workspace/group/CLAUDE.md
ls /workspace/group/conversations/ 2>/dev/null | wc -l
```

Tells you how rich the group's persisted context is.

### 4. Built-in MCP tools

Always available (registered by the agent-runner — no need to verify):
- **Messaging:** `send_message`, `send_file`, `edit_message`, `add_reaction`
- **Group ops:** `update_group_subject`, `update_group_photo`, `share_group_invite_link`, `rename_group`, `leave_group`, `get_invite_link`
- **Interactive:** `ask_user_question`, `send_card`
- **Channels:** `register_channel`, `list_channels`, `list_discovered_groups`, `create_group`, `update_channel_policy`, `migrate_to_separate_agent`
- **Scheduling:** `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`
- **Agents:** `create_agent`, `restart_container`
- **Self-mod (admin):** `install_packages`, `add_mcp_server`
- **Google (if wired):** `gmail_*`, `calendar_*`, `drive_*`, `docs_*`, `sheets_*`, `meet_*`

Don't list every Google sub-tool — say "Google Workspace (gmail, calendar, drive, docs, sheets, meet)" if `google_workspace_status` shows it's connected.

### 5. Channels wired

```
mcp__nanoclaw__list_channels
```

Counts how many platforms/groups this agent is currently wired to.

## Report format

Send via `send_message`. Keep it scannable — no long bullet lists. Group by section.

```
🤖 *<assistantName>* — capabilities

🧠 *Memoria*
• CLAUDE.md: <line count> líneas
• Conversaciones registradas: <N>
• Canales wired: <N>

🛠️ *Skills instaladas* (<count>)
• /<skill> — <one-line description from frontmatter>
…

🔌 *MCP servers extras* (<count>)
• <name> — (no description, just the key)

📨 *Tools nativos*
Messaging, scheduling, group ops, channels, agents, self-mod.
Google Workspace conectado: <sí/no>

📦 *Container*
apt extras: <list or "ninguno">
npm extras: <list or "ninguno">
```

Adapt language to whatever the user is writing in (Spanish if they wrote in Spanish, English if in English).

## Don'ts

- Don't list MCP tools by enumerating ToolSearch — they're already known. Just summarize the categories.
- Don't run `docker` or peek at `/proc` — agents don't have host access; skip system-info v1-style.
- Don't dump file contents (CLAUDE.md, container.json) — summarize.
- Don't mention skills/tools that aren't actually installed — verify with `ls` first.

## See also

- `/welcome` — onboarding flow for a fresh channel
- `/self-customize` — extend yourself with new packages or MCP servers
