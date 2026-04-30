---
name: add-gif-gen
description: Add the gif-gen container skill (crop, convert, slideshow, sprite sheet). Free — uses ffmpeg locally inside the container. No API keys.
---

# Add GIF Generation (free modes)

Installs the `gif-gen` container skill (one Bash script, four modes — all `ffmpeg`/`ffprobe` local). No OneCLI secret. No cost.

This is the free subset of the v1 gif-gen pack. The `--animate` mode (fal.ai Kling, $0.42 per call) is intentionally not ported.

## Phase 1: Pre-flight

### Already applied?

```bash
test -f container/skills/gif-gen/generate-gif && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 4 (Verify).

## Phase 2: Install the container skill

```bash
rsync -a .claude/skills/add-gif-gen/container-skills/ container/skills/
chmod +x container/skills/gif-gen/generate-gif
head -5 container/skills/gif-gen/SKILL.md
```

## Phase 3: Ensure ffmpeg in the container image

The script needs `ffmpeg` and `ffprobe` (same package). Two paths:

### 3.1 Per-group via `install_packages` (recommended)

If the agent group already has `ffmpeg` (e.g. you installed `/add-voice` first, which also needs it), skip. Otherwise, ask the agent to install it:

> Send the agent: *"add ffmpeg to your container packages"*. The agent calls `mcp__nanoclaw__install_packages({apt: ["ffmpeg"]})`. Approve in the host UI. The container rebuilds automatically.

### 3.2 Global Dockerfile (alternative)

If you want `ffmpeg` baked into the base image for every group:

```bash
grep -q 'ffmpeg' container/Dockerfile && echo "PRESENT in Dockerfile" || \
  echo "Edit container/Dockerfile apt-get install line to add 'ffmpeg', then run ./container/build.sh"
```

After rebuilding, all groups get `ffmpeg` without per-group install.

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

Send to any agent (with `ffmpeg` available):

> *"toma esta imagen y conviértela a gif"* (with an image attached) → expect `Bash(generate-gif --convert ...)`.

Or for a slideshow with multiple images:

> *"haz un gif con estas tres imágenes"* → expect `Bash(generate-gif img1 img2 img3)`.

## Troubleshooting

**`generate-gif: command not found`**: skill not synced to the agent group. Re-run Phase 4.

**`ffmpeg: command not found`**: `ffmpeg` is not in the agent's container. Run `/add-voice` (which installs it) or follow Phase 3 above.

**Output GIF is too small**: edit `scale=480:-1` in the script to a larger value (e.g. `scale=720:-1`). Bigger GIFs = bigger files = slower delivery.

**Sprite-sheet output is mis-aligned**: `image_width / cols` or `image_height / rows` produces a fractional frame size. Re-check the grid by looking at the source image with vision.
