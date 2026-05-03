## Companion and collaborator agents (`create_agent`)

`mcp__nanoclaw__create_agent({ name, instructions })` spins up a new long-lived agent and wires it as a destination — bidirectional, so you can send it tasks and it can message you back.

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string seeds the agent's `CLAUDE.local.md` — its starting role and personality.
- The agent's `name` becomes a destination on both sides: you address it via `send_message({ to: "<name>", ... })`, and its replies arrive as inbound messages with `from="<name>"`.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use the SDK `Agent` tool instead. It's stateless, spins up and completes in one shot, and leaves no persistent footprint.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate NanoClaw base behavior — the shared base is already loaded on the agent's end.

### Listing your sub-agents

When the user asks "what sub-agents do you have?" / "qué sub-agentes tienes?", **only enumerate destinations from your own destination map** (the names you can `send_message(to=...)` to). Do NOT list every `agent_group` in the system or every channel-wired agent — those are peers, not children, and they are not your sub-agents.

A sub-agent specifically means: an `agent_group` *you created* via `create_agent`, which appears as a destination on your side. If your destination list has only the user (e.g. `bliss`, `parent`) and no agents you spawned, the correct answer is "I have no sub-agents." Do not invent or infer them from channel wirings.