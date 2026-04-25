# Google Workspace Integration (Gmail, Calendar, Drive)

End-to-end OAuth + tool integration that lets a NanoClaw agent send emails, read inbox, list/create calendar events, and search Drive — acting as a *specific user* in the conversation (`From: that-user@dominio`, events in *that user's* calendar). Multiple users in the same group each connect their own Google account independently.

Spans three components: the **ghosty-studio** web app (handles OAuth dance, stores refresh token, mints fresh access tokens on demand), the **nanoclaw host** (passes credentials into containers), and the **agent container** (calls Google REST APIs through MCP tools).

## End-user UX

1. *User in WhatsApp:* "manda un correo a juan@acme.com con el resumen"
2. *Agent:* (sees no Google connection for this `agent_group_id`) → `google_workspace_status` returns a magic link
3. *Agent → user:* "Para mandar correos necesito conectar tu Workspace. Click aquí: https://ghosty.studio/oauth/google/start?state=…"
4. *Container:* exits cleanly at end-of-turn (restart sentinel)
5. *User:* clicks link → "Configuración avanzada" → continuar → consent (Gmail/Drive/Calendar) → "Allow" → ✅ green page
6. *User:* "ya"  ← any message
7. *Fresh container spawns,* agent uses `gmail_send` → email sent from the user's own account
8. *Agent:* "📤 enviado desde tu-email@dominio"

**Total user friction: 1 magic-link click + 1 follow-up message, once per agent_group**.

## Architecture

```
┌─────────────────────┐   OAuth dance    ┌────────────────┐
│  WhatsApp / chat    │◄─── magic link ──┤ agent container│
└─────────┬───────────┘                  └────────┬───────┘
          │ user clicks link                      │
          ▼                                       │ 1. on startup, fetch
┌─────────────────────┐                           │    access_token
│ ghosty.studio (Fly) │◄──────────────────────────┘ 2. on tool call,
│  React Router v7    │                              call googleapis.com
│  Prisma + SQLite    │   apiToken (Bearer)
│                     │◄─────── nanoclaw host ────► HTTPS NO_PROXY for *mcp.googleapis.com
│  /oauth/google/*    │       (DigitalOcean)        ├── gmail.googleapis.com
│  /api/oauth/google/*│                             ├── calendar.googleapis.com
└─────────────────────┘                             └── drive.googleapis.com
```

### Why the split?

- **ghosty-studio** is the OAuth client registered with Google (Client ID + Secret in Fly secrets). It's the only place the refresh_token lives. It handles re-issuing access tokens (1h TTL) on demand. SQLite-persistent.
- **nanoclaw host** owns the agent containers. It passes one Bearer token per droplet (`NANOCLAW_ADMIN_TOKEN`) into each container as env var. That token authenticates the container's API calls back to ghosty-studio.
- **Agent container** never sees the refresh_token. It calls ghosty-studio's `/api/oauth/google/access-token` to get a short-lived access_token whenever a Google tool runs.

This separation means: stealing a container's env reveals a deployment-scoped admin token (lets you fetch access tokens for that deployment's agent_groups) but **not** the long-lived refresh_token.

## Files

### ghosty-studio (`/Users/bliss/ghosty-studio/`)

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | `GoogleCredential` model (FK Deployment, unique `[deploymentId, agentGroupId]`). Stores refresh_token + cached access_token + expiry + scopes + connectedEmail. |
| `prisma/migrations/20260425164055_add_google_credential/migration.sql` | The CREATE TABLE migration. |
| `app/lib/oauth-state.server.ts` | HMAC-SHA256 signed state tokens for CSRF + scoping the OAuth flow. 10-min TTL. |
| `app/lib/google-oauth.server.ts` | `buildAuthorizationUrl`, `exchangeCodeForTokens`, `refreshAccessToken`, `fetchUserEmail`, `upsertGoogleCredential`, `getValidAccessToken` (with refresh-on-expiry + invalid_grant cleanup). Default scopes: `gmail.modify`, `drive`, `calendar`, `userinfo.*`. |
| `app/lib/api-auth.server.ts` | `authenticateDeployment(request)` → looks up Deployment by Bearer apiToken. Throws `ApiAuthError` (401) if missing/invalid. |
| `app/routes/oauth.google.start.tsx` | Verifies state, redirects to Google consent screen with `prompt=consent` + `access_type=offline`. |
| `app/routes/oauth.google.callback.tsx` | Verifies state, exchanges code → tokens, fetches the email via userinfo, upserts credential, renders ✓ page. |
| `app/routes/api.oauth.google.link.tsx` | `POST` — auth via deployment apiToken, signs state, returns magic link JSON. |
| `app/routes/api.oauth.google.access-token.tsx` | `GET` — auth via deployment apiToken, returns `{access_token, expires_at, connected_email}` or 404 `{error: "needs_oauth"}`. Refreshes server-side if expired. |
| `scripts/generate-oauth-link.ts` | Manual helper to mint a magic link for testing without going through the agent. |

**Fly secrets:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT`, `OAUTH_STATE_SECRET`.

### nanoclaw v2 (`/Users/bliss/nanoclawv2/`)

| File | Purpose |
|------|---------|
| `src/container-runner.ts` | Adds `NANOCLAW_ADMIN_TOKEN` + `GHOSTY_STUDIO_API_BASE` to the env passthrough; tags containers with `--label nanoclaw-agent-group-id=<id>`; sets `NO_PROXY=gmailmcp.googleapis.com,drivemcp.googleapis.com,calendarmcp.googleapis.com` so the OneCLI MITM doesn't break SSL on Google's MCP endpoints (used when preview is unlocked). |
| `container/agent-runner/src/providers/types.ts` | `McpServerConfig` widened to discriminated union of `McpStdioServerConfig` + `McpHttpServerConfig`. |
| `container/agent-runner/src/providers/claude.ts` | Adds `mcp__gmail__*`, `mcp__drive__*`, `mcp__calendar__*` to `TOOL_ALLOWLIST` (for when Google preview MCPs are wired). |
| `container/agent-runner/src/index.ts` | `wireGoogleWorkspaceMcps()` helper for native HTTP MCP wiring. Currently **commented out** at the call site — Google's MCP servers are gated behind their Developer Preview Program. Uncomment when enrolled. |
| `container/agent-runner/src/poll-loop.ts` | Reads `/workspace/.restart-requested` sentinel after each result event and in the follow-up poll; `process.exit(0)` if present. Lets a tool ask the container to die at end of turn. |
| `container/agent-runner/src/mcp-tools/google.ts` | Six MCP tools: `google_workspace_status` (onboarding + magic link + sentinel drop), `calendar_list_events`, `calendar_create_event`, `gmail_send`, `gmail_search`, `drive_search`. All authenticated via the access_token endpoint. |
| `container/agent-runner/src/mcp-tools/google.instructions.md` | Auto-loaded into every agent's composed CLAUDE.md so the model knows when/how to use each tool. |
| `container/agent-runner/src/mcp-tools/index.ts` | Imports `./google.js` so tools self-register. |

**Host `.env` requires:** `NANOCLAW_ADMIN_TOKEN=<random hex>`. The matching `Deployment` row must exist in ghosty-studio's prod DB with the same apiToken + the droplet's host IP.

## Data flow

### Onboarding (no credential yet)

```
WhatsApp user                        Container                 ghosty-studio                Google
─────────────                        ─────────                 ─────────────                ──────
"crea evento mañana 9am"  ─►
                                     google_workspace_status
                                        GET /api/oauth/google/access-token
                                          + Bearer NANOCLAW_ADMIN_TOKEN ─►
                                                                       (no GoogleCredential)
                                                                  ◄── 404 needs_oauth
                                        POST /api/oauth/google/link
                                          + body {agent_group_id, initiating_user_id} ─►
                                                                  ◄── 200 {link: "https://ghosty.studio/oauth/google/start?state=…"}
                                     drops /workspace/.restart-requested
                                     responds via send_message:
"Conecta aquí: <link>"    ◄──        the magic link verbatim
                                     turn ends → poll-loop sees sentinel → process.exit(0)
                                     container dies (--rm)

(user clicks the link in the browser)
                                                                                   GET /oauth/google/start?state=… ─►
                                                                                                                   ◄── 302 to accounts.google.com
                                                                                                                       (user signs in, "Allow")
                                                                                                                ──► GET /oauth/google/callback?code=…&state=…
                                                                                                                       exchanges code, upserts GoogleCredential
                                                                                                                       renders ✓ page

"ya"                       ─►
                                     fresh container spawns
                                     google_workspace_status
                                        GET /api/oauth/google/access-token ─►
                                                                  ◄── 200 {access_token, connected_email}
                                     calendar_create_event
                                        POST calendar/v3/events
                                          + Bearer access_token ─────────────────────────────────►
                                                                                                  ◄── 201 {id, htmlLink, …}
"📤 evento creado"        ◄──
```

### Subsequent calls (credential exists, container alive)

`google_workspace_status` returns `{connected: true, email}` immediately. Each tool call independently fetches a fresh access_token from `/api/oauth/google/access-token` — ghosty-studio caches the token until it's <60s from expiry, then refreshes server-side via `oauth2.googleapis.com/token`. The container itself never sees the refresh_token.

## Container suicide pattern (`/workspace/.restart-requested`)

`google_workspace_status` writes this sentinel file when it returns `connected: false`. The poll loop checks for it (a) right after dispatching each result text, (b) in the follow-up poll before pushing new messages into the active SDK query. If present, it `process.exit(0)`s; the next inbound message wakes a fresh container.

This solves the "container started without Google credentials → user authorizes mid-session → tools won't be available until container respawns" race. By exiting at end-of-turn, the *next* message (the user's "ya") spawns a clean container that reads the new credential at startup.

The pattern is general-purpose and reusable — any tool that knows the container's startup state has gone stale can drop the sentinel.

## Why REST APIs instead of Google's official MCP servers

Google publishes native MCP servers at `gmailmcp.googleapis.com`, `drivemcp.googleapis.com`, `calendarmcp.googleapis.com`. The SDK supports remote HTTP MCP via `{type: 'http', url, headers}`. We wired this in `wireGoogleWorkspaceMcps()` and it *almost* works — but `tools/call` returns *"The caller does not have permission"* even with a valid token full of scopes.

The cause is **Google Workspace Developer Preview Program** gating: those endpoints are in preview and require enrollment before they accept requests from your OAuth client. Apply at https://developers.google.com/workspace/preview.

Until enrollment lands, we hit the regular REST APIs (`/calendar/v3/…`, `/gmail/v1/…`, `/drive/v3/…`) which work without preview. The OAuth flow, refresh logic, sentinel pattern, and tool definitions all stay the same. To switch to native MCPs once approved: uncomment one line at `container/agent-runner/src/index.ts:~110` and the agent will use `mcp__gmail__*` / `mcp__calendar__*` / `mcp__drive__*` instead.

The REST tools we ship today: `gmail_send`, `gmail_search`, `calendar_list_events`, `calendar_create_event`, `drive_search`. Adding more (delete event, read message body, create doc with content, update event) is ~30 LOC each — see `mcp-tools/google.ts` patterns.

## Porting to v1 (`/Users/bliss/nanoclaw/`)

The ghosty-studio side is identical for v1 — same OAuth client, same endpoints, same DB. **No changes needed there**.

The container/host side differs because v1's MCP architecture is different:

| Concern | v2 (this repo) | v1 (`nanoclaw`) |
|---------|----------------|-----------------|
| MCP tool registration | `container/agent-runner/src/mcp-tools/<name>.ts` self-registers via `registerTools([...])` | `container/agent-runner/src/mcp-tools.ts` is a single monolithic file with a tools array |
| Container env passthrough | `src/container-runner.ts` `readEnvFile([...])` | Different mechanism — check v1's container-runner |
| Agent group identifier | `agent_group_id` (opaque string in central DB) | `jid` (WhatsApp group/chat JID) |
| Container suicide | `/workspace/.restart-requested` sentinel + poll-loop check | v1 doesn't have a long-running poll loop in the same shape; needs research |
| Tool allowlist | `TOOL_ALLOWLIST` in `providers/claude.ts` | v1's allowlist is in a different location |

**To port:**

1. **Don't change ghosty-studio.** When inserting the v1 host's Deployment into ghosty-studio's prod DB, use the same shape we used for v2: name + apiUrl + apiToken + host. The matching `NANOCLAW_ADMIN_TOKEN` lives in the v1 host's `.env`. The `agent_group_id` field in `GoogleCredential` will hold v1's JID instead of v2's `ag-…` id — same opaque-string contract, just different identifier shape.
2. **Copy the 6 MCP tools** from `container/agent-runner/src/mcp-tools/google.ts` into v1's MCP tool registration mechanism. The internals (REST API calls, access_token fetch, MIME builder for Gmail) are runtime-agnostic — they should drop in with no logic changes, just the registration shim.
3. **Copy the `google.instructions.md`** to v1's equivalent of mcp-tools instructions.
4. **Add to v1's host:** `NANOCLAW_ADMIN_TOKEN` + `GHOSTY_STUDIO_API_BASE` to whatever env-passthrough mechanism v1 uses; if v1 uses the OneCLI HTTPS proxy, add `NO_PROXY=gmail.googleapis.com,calendar.googleapis.com,www.googleapis.com,drive.googleapis.com` (note: REST API hosts, not the *mcp.* hosts which are only relevant for the native-MCP path).
5. **Container suicide:** if v1 has a long-running container per session, replicate the sentinel pattern. If v1 spawns a fresh container per turn, this isn't needed at all.
6. **Tool allowlist:** add `mcp__nanoclaw__google_workspace_status`, `mcp__nanoclaw__calendar_*`, `mcp__nanoclaw__gmail_*`, `mcp__nanoclaw__drive_*` to whatever filter v1 has on tool exposure.

The OAuth flow itself doesn't need to be re-implemented — it lives entirely in ghosty-studio. v1 just calls the two API endpoints (`/api/oauth/google/link` and `/api/oauth/google/access-token`) like v2 does.

## Testing

Manual verification path:

```bash
# 1. mint a magic link via the helper script (run on ghosty-studio Fly)
fly ssh console -a ghosty-studio -C 'cd /app && npx tsx scripts/generate-oauth-link.ts \
  --deployment <deploymentId> \
  --agent-group <agent_group_id_or_jid> \
  --user whatsapp:test@s.whatsapp.net'

# 2. open the printed URL in browser, authorize, see ✓ page

# 3. verify the credential landed
fly ssh console -a ghosty-studio -C 'node -e "new(require(\"@prisma/client\").PrismaClient)().googleCredential.findMany({select:{deploymentId:true,agentGroupId:true,connectedEmail:true,scopes:true}}).then(r=>console.log(JSON.stringify(r,null,2)))"'

# 4. fetch a fresh access token via the API (curl)
TOKEN=$(ssh root@<host> 'cat /<path>/.env' | grep NANOCLAW_ADMIN_TOKEN | cut -d= -f2)
curl -s "https://ghosty.studio/api/oauth/google/access-token?agent_group_id=<id>" \
  -H "Authorization: Bearer $TOKEN"

# 5. introspect the token's actual scopes from Google
ACCESS=<paste access_token from above>
curl -s "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=$ACCESS"

# 6. exercise via Google REST directly (skip the MCP layer to isolate)
curl -s "https://www.googleapis.com/calendar/v3/users/me/calendarList" -H "Authorization: Bearer $ACCESS"
```

If step 5 shows the right scopes and step 6 returns real data, the OAuth + ghosty-studio side is healthy. If `gmail_send` / `calendar_create_event` then still fail in the agent, the issue is in the container's tool wiring (env vars, allowlist, NO_PROXY).

## Per-user model

Credentials are scoped by `(deploymentId, agentGroupId, userId)`. The `userId` is the canonical user id from the channel adapter (e.g. `whatsapp:5215...@s.whatsapp.net`), populated from the inbound message's `from_user_id` field.

Every Google MCP tool requires an `as_user_id` argument. The agent passes the `from_user_id` of the message that triggered the request, and the tool fetches that user's credentials only. If the user hasn't authorized yet, the tool returns a magic link scoped to them (signed state encodes `userId`) and arms the container restart sentinel — the user clicks, authorizes, and their next message wakes a fresh container with their tools available.

You **cannot** fall back from one user's account to another's. Each person who wants Google capabilities has to do their own one-click OAuth. Multiple users coexist cleanly — Pedro's `gmail_send` runs as `pedro@acme.com`, Marina's runs as `marina@acme.com`, both in the same group, no conflict.

## Known limitations

- **Read-only on Drive bodies / Gmail bodies:** `gmail_search` returns headers + snippet only; no full message body fetch yet. `drive_search` returns metadata only; no read-content tool. Easy to add (~30 LOC each).
- **1h access token TTL:** Each tool call fetches a fresh token, which is fine for short turns. For pathological multi-hour single-turn use cases, the cached token might expire mid-call → 401 → next call refreshes. The user sees one transient failure.
- **Unverified app warning:** Google shows the "this app isn't verified" warning before consent because we haven't gone through Brand Verification. Workaround: "Configuración avanzada → Continuar". To remove, apply for verification (free, 2-6 weeks for sensitive scopes; CASA assessment + ~$4-15k/yr for restricted scopes like `gmail.modify`).
- **100-user lifetime cap:** Until verified, OAuth is capped at 100 unique consenting users *for the lifetime of the project*. Counter doesn't reset. Plan verification before reaching that.
