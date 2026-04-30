---
name: add-mercadopago
description: Add the MercadoPago payment-link container skill so agents can create checkout URLs in MXN. Uses OneCLI for auth — no env vars in the container.
---

# Add MercadoPago

Installs the `mercadopago` container skill and registers `MP_ACCESS_TOKEN` in OneCLI as an `Authorization: Bearer` rewrite for `api.mercadopago.com`. The container script always sends `Bearer placeholder`; the proxy substitutes the real token.

**Principle:** Do the work. Only ask the user when something genuinely needs human input.

## Phase 1: Pre-flight

### Already applied?

```bash
test -d container/skills/mercadopago && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 3.

### Prereqs

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo ONECLI_MISSING
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry. Stop.

## Phase 2: Install the container skill

```bash
rsync -a .claude/skills/add-mercadopago/container-skills/ container/skills/
chmod +x container/skills/mercadopago/mercadopago
head -5 container/skills/mercadopago/SKILL.md
```

The skill is interpreted (Bash + curl) — no rebuild needed.

## Phase 3: Configure credentials

### 3.1 Create the OneCLI secret

```bash
KEY=$(grep '^MP_ACCESS_TOKEN=' /Users/bliss/nanoclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$KEY" ]; then
  echo "Paste your MercadoPago access token (from https://www.mercadopago.com/developers → credentials):"
  read -s KEY
fi

if onecli secrets list 2>/dev/null | grep -qi "mercadopago"; then
  echo "MercadoPago secret already in OneCLI — skipping create."
else
  onecli secrets create \
    --name "MercadoPago Access Token" \
    --type generic \
    --value "$KEY" \
    --host-pattern "api.mercadopago.com" \
    --header-name "Authorization" \
    --value-format "Bearer {value}"
fi
```

The other v1 vars (`MP_CLIENT_ID`, `MP_PUBLIC_KEY`, `MP_WEBHOOK_SECRET`) are **not used** by this skill — only the access token. The script uses Checkout Pro REST, not OAuth.

### 3.2 Assign to all agents

```bash
MP_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "mercadopago" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
for agent in $(onecli agents list 2>/dev/null | grep '"id"' | sed 's/.*"id": "//;s/".*//'); do
  CURRENT=$(onecli agents secrets --id "$agent" 2>/dev/null | grep '"' | grep -v hint | grep -v data | sed 's/.*"//;s/".*//' | tr '\n' ',' | sed 's/,$//')
  onecli agents set-secrets --id "$agent" --secret-ids "${CURRENT:+$CURRENT,}$MP_SECRET_ID"
done
```

## Phase 4: Sync skills to existing groups

Container skills are copied at group creation and not auto-synced. Sync to running groups:

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills" ]; then
    rsync -a container/skills/ "$session_dir/.claude-shared/skills/"
    echo "Synced skills to: $session_dir"
  fi
done
```

## Phase 5: Restart running containers

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

Containers respawn on next message wake and pick up the new skill.

## Phase 6: Verify

Send to any agent: *"hazme un link de cobro de 50 pesos para una prueba"*. Expect a `Bash(mercadopago create-link 50 "una prueba")` call returning a URL like `https://www.mercadopago.com.mx/checkout/v1/redirect?...`.

```bash
tail -f logs/nanoclaw.log | grep -i mercadopago
```

## Troubleshooting

**Script says `unauthorized` from MercadoPago.** OneCLI secret not assigned, or agent in `selective` mode. Run `onecli agents secrets --id <agent>` to confirm; `onecli agents set-secret-mode --id <agent> --mode all` if needed.

**`invalid_collector_id`.** The token belongs to a different MercadoPago account than the one expected to receive payments. Use a token from the receiving account.

**Empty `init_point` in the response.** The API call returned an error JSON with no `init_point`. The script prints the raw response — read it for the actual error (often `currency_id` mismatch or missing payer data).

**Other currencies.** Edit `currency_id` in `container/skills/mercadopago/mercadopago` line 33. MercadoPago supports ARS, BRL, CLP, COP, MXN, PEN, UYU.
