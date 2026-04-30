---
name: add-voice
description: Add the voice container skill — TTS with 8 Mexican Spanish voices (ElevenLabs), voice cloning, OpenAI TTS fallback, and YouTube audio extraction (yt-dlp + cookies). Auth via OneCLI.
---

# Add Voice (ElevenLabs + OpenAI fallback)

Installs the `voice` container skill (`text-to-speech`, `clone-voice`), registers `ELEVENLABS_API_KEY` in OneCLI for `api.elevenlabs.io`, and reuses the OpenAI secret (creating it if `/add-image-gen` wasn't run first). Adds `ffmpeg` and `yt-dlp` to the agent group's package list.

## Phase 1: Pre-flight

### Already applied?

```bash
test -f container/skills/voice/text-to-speech && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 4 (Configure credentials).

### Prereqs

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo ONECLI_MISSING
```

If `ONECLI_MISSING`, run `/init-onecli` first. Stop.

## Phase 2: Install the container skill

```bash
rsync -a .claude/skills/add-voice/container-skills/ container/skills/
chmod +x container/skills/voice/text-to-speech container/skills/voice/clone-voice
head -5 container/skills/voice/SKILL.md
```

## Phase 3: Add packages to the agent group

The voice scripts need `ffmpeg` and `yt-dlp`. These go in `packages.apt` per-group (NOT the global Dockerfile — per-group is reversible).

Tell the agent (in any group that should have voice):

> *"add ffmpeg and yt-dlp to your container packages so I can install voice tools"*

The agent calls `mcp__nanoclaw__install_packages({apt: ["ffmpeg", "yt-dlp"]})`. You approve in the host UI. The image rebuilds, the container restarts.

If `/add-gif-gen` already added `ffmpeg`, only `yt-dlp` is new.

## Phase 4: Configure credentials

### 4.1 ElevenLabs secret

```bash
KEY=$(grep '^ELEVENLABS_API_KEY=' /Users/bliss/nanoclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$KEY" ]; then
  echo "Paste your ElevenLabs API key (https://elevenlabs.io → profile → API key):"
  read -s KEY
fi

if onecli secrets list 2>/dev/null | grep -qi "elevenlabs"; then
  echo "ElevenLabs secret already in OneCLI — skipping create."
else
  onecli secrets create \
    --name "ElevenLabs API Key" \
    --type generic \
    --value "$KEY" \
    --host-pattern "api.elevenlabs.io" \
    --header-name "xi-api-key" \
    --value-format "{value}"
fi
ELEVEN_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "elevenlabs" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
```

### 4.2 OpenAI secret (reuse or create — for TTS fallback)

```bash
if onecli secrets list 2>/dev/null | grep -qi "openai"; then
  echo "OpenAI secret already in OneCLI — reusing it."
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
fi
OPENAI_SECRET_ID=$(onecli secrets list 2>/dev/null | grep -B2 -i "openai" | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
```

### 4.3 Assign both secrets to all agents

```bash
for agent in $(onecli agents list 2>/dev/null | grep '"id"' | sed 's/.*"id": "//;s/".*//'); do
  CURRENT=$(onecli agents secrets --id "$agent" 2>/dev/null | grep '"' | grep -v hint | grep -v data | sed 's/.*"//;s/".*//' | tr '\n' ',' | sed 's/,$//')
  TARGET="$CURRENT"
  echo "$TARGET" | grep -q "$ELEVEN_SECRET_ID" || TARGET="${TARGET:+$TARGET,}$ELEVEN_SECRET_ID"
  echo "$TARGET" | grep -q "$OPENAI_SECRET_ID" || TARGET="${TARGET:+$TARGET,}$OPENAI_SECRET_ID"
  onecli agents set-secrets --id "$agent" --secret-ids "$TARGET"
done
```

## Phase 5: (Optional) YouTube cookies mount

Voice cloning from YouTube needs `/workspace/youtube-cookies.txt` mounted RO inside the container. YouTube blocks anonymous requests now.

If the user wants this, instruct them:

1. Export YouTube cookies from their browser to a file on the host (e.g. `~/.nanoclaw/youtube-cookies.txt`). Browser extensions like "Get cookies.txt LOCALLY" do this in one click.
2. Add to `groups/<folder>/container.json`:
   ```json
   "additionalMounts": [
     {
       "hostPath": "/Users/<user>/.nanoclaw/youtube-cookies.txt",
       "containerPath": "/workspace/youtube-cookies.txt",
       "readonly": true
     }
   ]
   ```
3. The host validates against `src/modules/mount-security/index.ts` — if the path is rejected, add it to the mount allowlist via `/manage-mounts`.

If the user doesn't need YouTube cloning, skip this phase.

## Phase 6: Sync skills to existing groups

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills" ]; then
    rsync -a container/skills/ "$session_dir/.claude-shared/skills/"
    echo "Synced skills to: $session_dir"
  fi
done
```

## Phase 7: Restart running containers

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

## Phase 8: Verify

Send to any agent: *"respóndeme en voz con la voz de jc: hola, qué tal"*. Expect:
1. `Bash(text-to-speech "hola, qué tal" jc)` returning `/workspace/agent/tts-XXX.ogg`
2. `mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/agent/tts-XXX.ogg" })`

Logs:

```bash
tail -f logs/nanoclaw.log | grep -iE "elevenlabs|tts"
```

## Troubleshooting

**`401 Unauthorized` from ElevenLabs.** Secret not assigned to the agent or agent in `selective` mode. Run `onecli agents secrets --id <agent>`.

**ElevenLabs fails, OpenAI fallback also fails.** OpenAI secret not assigned. The script falls back gracefully but only if both secrets are wired.

**Output is too quiet / robotic.** The voice settings (`stability`, `similarity_boost`, `style`) in `text-to-speech` line 47-50 are tuned for Mexican Spanish. Adjust if you want a different style.

**`yt-dlp: command not found`.** Phase 3 didn't run, or `install_packages` was rejected/not approved. Re-run from the agent.

**YouTube `Sign in to confirm you're not a bot`.** Cookies stale or missing. Re-export from your browser.
