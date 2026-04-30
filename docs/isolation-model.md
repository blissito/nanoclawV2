# Channel Isolation Model

NanoClaw decouples messaging channels from agent groups. When you connect a channel (Discord, Telegram, Slack, GitHub, etc.), you decide how it relates to your existing agents. There are three isolation levels.

## The Three Levels

### 1. Shared Session

Multiple channels feed into the same conversation. The agent sees all messages from all channels in one thread.

**What's shared:** Everything — workspace, memory, CLAUDE.md, and the conversation itself. A GitHub PR comment and a Slack message appear side by side in the agent's context.

**Example:** A Slack channel paired with GitHub webhooks. The agent receives PR review requests via GitHub and discusses them in Slack — all in one session. When someone comments on a PR, the agent can reference the earlier Slack discussion about that feature.

**When to use:** When one channel feeds context into another. Webhook/notification channels (GitHub, Linear) paired with a chat channel (Slack, Discord) are the classic case.

**Technical:** Both messaging groups are wired to the same agent group with `session_mode: 'agent-shared'`. Session resolution looks up by agent group ID only, ignoring the messaging group — so all channels converge on one session.

---

### 2. Same Agent, Separate Sessions

Multiple channels share the same agent (same workspace, memory, personality) but have independent conversations.

**What's shared:** Workspace, memory, CLAUDE.md, and all persistent state. If you tell the agent something in one session, it can save that to memory and recall it in another. The agent's personality, knowledge, and tools are identical across sessions.

**What's separate:** The conversation thread. Messages from one channel don't appear in the other channel's session. Each channel has its own context window and conversation history.

**Example:** You have three Telegram chats with your agent — one for a side project, one for personal tasks, one for work. All three share the same agent workspace. If you ask it to remember your API key naming convention in the project chat, it may recall that convention in the work chat too. But the conversations themselves are independent.

**When to use:** When you're the primary (or sole) participant across channels and you want a unified agent identity. This is the most common setup for personal use across multiple platforms or multiple groups within one platform.

**Technical:** Multiple messaging groups are wired to the same agent group with `session_mode: 'shared'` (or `'per-thread'`). Each messaging group gets its own session, but they all run in the same agent group folder.

---

### 3. Separate Agent Groups

Each channel gets its own agent with its own workspace, memory, and personality. Nothing is shared.

**What's shared:** Nothing. The agents don't know about each other. Different CLAUDE.md, different memory, different workspace, different conversation history.

**Example:** You have a Telegram group with a friend and a Discord server for a team project. The friend shouldn't know what you discuss with your team, and vice versa. Each gets its own agent with its own memory and personality.

**When to use:** When different people are involved, or when the information in one channel should never leak to another. This is the right choice whenever there's a privacy or confidentiality boundary between channels.

**Technical:** Each channel is wired to a different agent group, each with its own folder under `groups/`. Separate containers, separate session databases, separate everything.

---

## How to Decide

**Default: separate agent groups (level 3).** New channels get their own agent — own folder, own memory, own container — unless the user explicitly asks to share. This is the only safe default: shared memory between channels cross-pollinates, and an agent serving multiple chats can send notifications to the wrong one. Tighten the isolation when you have a real reason; don't loosen it by default.

The deciding question: **Has the user explicitly asked for this channel to share state with another?**

- **No** (default) → Separate agent groups (level 3)
- **Yes, and the channels should see each other's messages** → Shared session (level 1)
- **Yes, but the conversations should be independent** → Same agent, separate sessions (level 2)

### Rules of Thumb

| Scenario | Recommended Level |
|----------|------------------|
| Default for any new channel | Separate agent groups |
| Webhook channel + chat channel (GitHub + Slack) for the *same* project | Shared session |
| Multiple platforms where the user wants one unified assistant identity | Same agent, separate sessions |
| Channel with friend A and channel with friend B | Separate agent groups |
| Personal channel and work channel | Separate agent groups |
| Team channel with different access levels | Separate agent groups |

### When in Doubt

Pick separate agent groups. Information will cross-pollinate through agent memory and notifications if you share state without intent — and untangling it later requires a manual migration (`migrate_to_separate_agent`).

The host enforces this: if the caller passes nothing for `isolation`, both `register_channel` and `create_group` default to `separate-agent` and auto-derive the folder from the channel name.

## Entity Model

```
agent_groups (workspace, memory, CLAUDE.md, personality)
    ↕ many-to-many
messaging_groups (a specific channel/chat/group on a platform)
    via
messaging_group_agents (session_mode, trigger_rules, priority)
```

- **Shared session:** multiple messaging_groups → same agent_group, `session_mode = 'agent-shared'`
- **Same agent, separate sessions:** multiple messaging_groups → same agent_group, `session_mode = 'shared'`
- **Separate agents:** each messaging_group → different agent_group
