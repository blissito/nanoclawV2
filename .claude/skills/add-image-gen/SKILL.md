---
name: add-image-gen
description: Add OpenAI image generation (gpt-image-1) container skill. Single tool generate-preview with --hd flag for HQ output. Uses OneCLI for auth.
---

# Add Image Generation (OpenAI)

Installs the `image-gen` container skill (single script `generate-preview`) and registers `OPENAI_API_KEY` in OneCLI as an `Authorization: Bearer` rewrite for `api.openai.com`.

This is the OpenAI-only subset of the v1 image-gen pack. Other v1 modes (FLUX, edit-image, face-swap, LoRA) are intentionally not ported.

## Phase 1: Pre-flight

### Already applied?

```bash
test -f container/skills/image-gen/generate-preview && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 3.

### Prereqs

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo ONECLI_MISSING
```

If `ONECLI_MISSING`, run `/init-onecli` first. Stop.

## Phase 2: Install the container skill

```bash
rsync -a .claude/skills/add-image-gen/container-skills/ container/skills/
chmod +x container/skills/image-gen/generate-preview
head -5 container/skills/image-gen/SKILL.md
```

## Phase 3: Configure credentials

### 3.1 Create the OneCLI secret (or reuse if it exists)

```bash
if onecli secrets list 2>/dev/null | grep -qi "openai"; then
  echo "OpenAI secret already in OneCLI — reusing it."
  OPENAI_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "openai" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
else
  KEY=$(grep '^OPENAI_API_KEY=' /Users/bliss/nanoclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$KEY" ]; then
    echo "Paste your OpenAI API key (https://platform.openai.com/api-keys):"
    read -s KEY
  fi
  onecli secrets create \
    --name "OpenAI API Key" \
    --type generic \
    --value "$KEY" \
    --host-pattern "api.openai.com" \
    --header-name "Authorization" \
    --value-format "Bearer {value}"
  OPENAI_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "openai" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
fi
```

### 3.2 Assign to all agents

```bash
for agent in $(onecli agents list 2>/dev/null | grep '"id"' | sed 's/.*"id": "//;s/".*//'); do
  CURRENT=$(onecli agents secrets --id "$agent" 2>/dev/null | grep '"' | grep -v hint | grep -v data | sed 's/.*"//;s/".*//' | tr '\n' ',' | sed 's/,$//')
  # Skip if already assigned
  echo "$CURRENT" | grep -q "$OPENAI_SECRET_ID" && continue
  onecli agents set-secrets --id "$agent" --secret-ids "${CURRENT:+$CURRENT,}$OPENAI_SECRET_ID"
done
```

## Phase 4: Sync skills to existing groups

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

## Phase 6: Verify

Send to any agent: *"genera una imagen de un gato astronauta"*. Expect a `Bash(generate-preview ...)` call returning a PNG path; the agent should then send it via `mcp__nanoclaw__send_message` with `image_path`.

## Troubleshooting

**`OpenAI API: Incorrect API key`**: OneCLI secret not assigned. Run `onecli agents secrets --id <agent>` to confirm.

**`content_policy_violation`**: Prompt rejected by OpenAI's safety filters. Rephrase.

**Selective mode blocking the secret**: `onecli agents set-secret-mode --id <agent> --mode all` if you want vault-wide host-pattern matching.

**Image quality is low even without `--hd`**: `gpt-image-1` low quality is intentional — fast and cheap. Use `--hd` for production-quality output.

## Reused by /add-voice

`/add-voice` reuses this OpenAI secret as a TTS fallback when ElevenLabs fails. If you install `/add-voice` after this skill, the OpenAI secret is detected and skipped (no duplicate creation).
