---
name: add-easybits
description: Add the EasyBits MCP server (@easybits.cloud/mcp) so the container agent can manage cloud file storage, images, webhooks, websites, and AI tasks. ~30 tools.
---

# Add EasyBits

Wires `@easybits.cloud/mcp` (stdio) into every NanoClaw container. The MCP server reads `EASYBITS_API_KEY` from env and sends `Authorization: Bearer ...` to `easybits.cloud`. With OneCLI, the env value is `placeholder` and the proxy rewrites the header at the host pattern.

**Principle:** Do the work. Only ask the user when something genuinely needs human input.

## Phase 1: Pre-flight

### Already applied?

```bash
grep -q "easybits:" container/agent-runner/src/index.ts && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 3.

### Prereqs

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo ONECLI_MISSING
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry. Stop.

## Phase 2: Wire the MCP server

### 2.1 Register `easybits` in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` block and add `easybits` next to `nanoclaw`:

```ts
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    easybits: {
      command: 'npx',
      args: ['-y', '@easybits.cloud/mcp'],
      env: { EASYBITS_API_KEY: 'placeholder' },
    },
  };
```

The literal string `placeholder` is required: the MCP server gates on truthy env; OneCLI rewrites the outbound `Authorization` header at the proxy.

### 2.2 Allow the tool glob

Edit `container/agent-runner/src/providers/claude.ts`. Find `'mcp__nanoclaw__*',` in `TOOL_ALLOWLIST` and add the easybits glob after it:

```ts
  'mcp__nanoclaw__*',
  'mcp__easybits__*',
];
```

### 2.3 Validate

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run build
```

Both must be clean.

## Phase 3: Configure credentials

### 3.1 Create the OneCLI secret

Try to extract the key from the v1 install (`/Users/bliss/nanoclaw/.env`); fall back to asking the user.

```bash
KEY=$(grep '^EASYBITS_API_KEY=' /Users/bliss/nanoclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$KEY" ]; then
  echo "Paste your EasyBits API key (https://easybits.cloud → settings → API):"
  read -s KEY
fi

if onecli secrets list 2>/dev/null | grep -qi "easybits"; then
  echo "EasyBits secret already in OneCLI — skipping create."
else
  onecli secrets create \
    --name "EasyBits API Key" \
    --type generic \
    --value "$KEY" \
    --host-pattern "easybits.cloud" \
    --header-name "Authorization" \
    --value-format "Bearer {value}"
fi
```

The host pattern `easybits.cloud` covers `www.easybits.cloud` (suffix-match). The MCP server calls `https://www.easybits.cloud/api/mcp`.

### 3.2 Assign the secret to all agents

```bash
EASYBITS_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "easybits" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
for agent in $(onecli agents list 2>/dev/null | grep '"id"' | sed 's/.*"id": "//;s/".*//'); do
  CURRENT=$(onecli agents secrets --id "$agent" 2>/dev/null | grep '"' | grep -v hint | grep -v data | sed 's/.*"//;s/".*//' | tr '\n' ',' | sed 's/,$//')
  onecli agents set-secrets --id "$agent" --secret-ids "${CURRENT:+$CURRENT,}$EASYBITS_SECRET_ID"
done
```

## Phase 4: Restart

The `npx -y` first-spawn downloads `@easybits.cloud/mcp` (~12kB, <5s). After that the npm cache inside the container caches it.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null \
  || systemctl --user restart nanoclaw 2>/dev/null \
  || ssh root@137.184.179.108 'systemctl restart nanoclaw-v2-2e602aa0.service'
```

If running on the production server (root@137.184.179.108), the patch flow per `CLAUDE.local.md` applies — `scp` the edited files, `chown nanoclaw:nanoclaw`, `pnpm run build`, `systemctl restart`.

## Phase 5: Verify

Send a message to any agent: *"list my files in easybits"*. Expect a `mcp__easybits__list_files` (or similar) tool call returning real file metadata.

Logs to watch:

```bash
tail -f logs/nanoclaw.log | grep -i easybits
```

Look for `Additional MCP server: easybits (npx)` on container start.

## Troubleshooting

**Agent doesn't see the tools.** `mcp__easybits__*` not in allowlist (`claude.ts:58`) or container wasn't restarted after the edit.

**`401 Unauthorized` from EasyBits.** Either the OneCLI secret wasn't assigned to the agent, or the agent is still in `selective` secret mode. Run `onecli agents secrets --id <agent>` to confirm assignment, and `onecli agents set-secret-mode --id <agent> --mode all` if you want the secret auto-injected on every host pattern match (see `CLAUDE.md` "Gotcha: auto-created agents start in selective secret mode").

**`No API key found`** at MCP server startup. The `env: { EASYBITS_API_KEY: 'placeholder' }` line was dropped from `index.ts`. The literal string is required — the server checks truthy, not validity.

**`npx -y` is slow on first call.** Expected — ~5s the first time per container. Subsequent calls hit the npm cache. To eliminate, add `@easybits.cloud/mcp` to the `pnpm install -g` line in `container/Dockerfile` (pin a version >3 days old per `minimumReleaseAge`) and rebuild. Optional.
