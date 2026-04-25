---
name: add-brightdata
description: Add the Bright Data MCP server (@brightdata/mcp) so the container agent can scrape, extract, and browse the live web without getting blocked. 5,000 free requests/month.
---

# Add Bright Data

Wires `@brightdata/mcp` (stdio) into every NanoClaw container. The MCP server reads `API_TOKEN` from env and sends `Authorization: Bearer ...` to `api.brightdata.com`. With OneCLI, the env value is `placeholder` and the proxy rewrites the header at the host pattern.

**Principle:** Do the work. Only ask the user when something genuinely needs human input.

## Phase 1: Pre-flight

### Already applied?

```bash
grep -q "brightdata:" container/agent-runner/src/index.ts && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 3.

### Prereqs

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo ONECLI_MISSING
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry. Stop.

## Phase 2: Wire the MCP server

### 2.1 Register `brightdata` in the agent-runner

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` block and add `brightdata` next to the existing entries:

```ts
    brightdata: {
      command: 'npx',
      args: ['-y', '@brightdata/mcp'],
      env: { API_TOKEN: 'placeholder' },
    },
```

The MCP server **throws** at startup if `API_TOKEN` is unset (`server.js`: `throw new Error('Cannot run MCP server without API_TOKEN env')`). The check is truthy-only — `placeholder` passes — and OneCLI rewrites the outbound `Authorization` header.

Optional env knobs the MCP server reads (leave defaults unless asked): `WEB_UNLOCKER_ZONE` (default `mcp_unlocker`), `BROWSER_ZONE` (default `mcp_browser`), `PRO_MODE`, `RATE_LIMIT`, `GROUPS`, `TOOLS`.

### 2.2 Allow the tool glob

Edit `container/agent-runner/src/providers/claude.ts`. Add the brightdata glob to `TOOL_ALLOWLIST`:

```ts
  'mcp__nanoclaw__*',
  'mcp__easybits__*',
  'mcp__brightdata__*',
];
```

### 2.3 Validate

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

## Phase 3: Configure credentials

### 3.1 Create the OneCLI secret

```bash
KEY=$(grep '^BRIGHTDATA_API_TOKEN=' /Users/bliss/nanoclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$KEY" ]; then
  echo "Paste your Bright Data API token (https://brightdata.com → account → API):"
  read -s KEY
fi

if onecli secrets list 2>/dev/null | grep -qi "brightdata"; then
  echo "BrightData secret already in OneCLI — skipping create."
else
  onecli secrets create \
    --name "BrightData API Token" \
    --type generic \
    --value "$KEY" \
    --host-pattern "brightdata.com" \
    --header-name "Authorization" \
    --value-format "Bearer {value}"
fi
```

The host pattern `brightdata.com` covers `api.brightdata.com` and other `*.brightdata.com` endpoints the MCP touches.

### 3.2 Assign the secret to all agents

```bash
BD_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "brightdata" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
for agent in $(onecli agents list 2>/dev/null | grep '"id"' | sed 's/.*"id": "//;s/".*//'); do
  CURRENT=$(onecli agents secrets --id "$agent" 2>/dev/null | grep '"' | grep -v hint | grep -v data | sed 's/.*"//;s/".*//' | tr '\n' ',' | sed 's/,$//')
  onecli agents set-secrets --id "$agent" --secret-ids "${CURRENT:+$CURRENT,}$BD_SECRET_ID"
done
```

## Phase 4: Restart

`@brightdata/mcp` is heavier than easybits (~115kB unpacked, deps include `playwright`). First `npx -y` may take 10-20s while npm pulls deps. Subsequent calls hit the cache.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null \
  || systemctl --user restart nanoclaw 2>/dev/null \
  || ssh root@137.184.179.108 'systemctl restart nanoclaw-v2-2e602aa0.service'
```

If running on the production server, follow the `CLAUDE.local.md` patch flow (`scp` → `chown nanoclaw:nanoclaw` → `pnpm run build` → `systemctl restart`).

## Phase 5: Verify

Send to any agent: *"scrape https://example.com via brightdata"*. Expect a `mcp__brightdata__*` tool call (e.g. `scrape_as_markdown`, `search_engine`, `extract`).

Logs:

```bash
tail -f logs/nanoclaw.log | grep -i brightdata
```

Look for `Additional MCP server: brightdata (npx)` on container start.

## Troubleshooting

**`Cannot run MCP server without API_TOKEN env`** at startup. The `env: { API_TOKEN: 'placeholder' }` line was dropped from `index.ts`. Required.

**`401 Unauthorized` from BrightData.** OneCLI secret not assigned to the agent. Check `onecli agents secrets --id <agent>`. If the agent is in `selective` mode (default for auto-created agents), set `--mode all` or assign the secret explicitly.

**`zone not found` errors.** BrightData zones must exist in your account. Set `WEB_UNLOCKER_ZONE` and/or `BROWSER_ZONE` in the `env` block of `index.ts` to match zones you've created in the BrightData dashboard. Defaults are `mcp_unlocker` and `mcp_browser`.

**Slow first call.** Expected — `playwright` is a heavy install. Pin in `Dockerfile` global pnpm install line if you want zero cold-start (pin a version >3 days old per `minimumReleaseAge`).

**Free tier exhausted.** 5,000 requests/month free — after that, requests fail with quota errors. Upgrade at brightdata.com.
