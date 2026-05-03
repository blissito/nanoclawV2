---
name: sticker-frames
description: Extract individual PNG frames from any WhatsApp sticker — static .webp, animated .webp, or Lottie .was. Use when the user wants to see, analyze, clone, or recreate a sticker.
allowed-tools: Bash(extract-frames:*),Bash(ffmpeg:*),Bash(ffprobe:*)
---

# Sticker frame extraction

WhatsApp stickers arrive as files in `/workspace/attachments/`:

| Extension | Format | What it is |
|-----------|--------|------------|
| `.webp` | RIFF/WebP | Static image OR animated WebP |
| `.was` | WhatsApp Animated Sticker | Lottie JSON (usually gzip-wrapped) — vector animation |

You cannot view a `.was` file directly — it is vector data, not raster. This skill rasterizes both formats into a numbered sequence of PNG frames you can `Read` with vision.

## Usage

```bash
extract-frames /workspace/attachments/sticker-1777730095530.was
extract-frames /workspace/attachments/sticker-1777730095530.webp /tmp/my-frames
```

- First arg: path to the sticker file.
- Second arg (optional): output directory. Defaults to `/tmp/sticker-frames-<nanos>/`.
- Stdout: newline-separated list of frame PNG paths, in order.
- Exit code: 0 on success, non-zero with stderr message on failure.

Cap is 60 frames by default (covers typical sticker length). For longer animations pass `--max-frames N` after the path.

## What to do with the frames

This skill does **not** auto-send to the user — frames are an *input* for your analysis, not output for the chat.

After extraction, the typical flow is:
1. `Read` each frame PNG (vision).
2. Describe what you see — motion, palette, style, timing.
3. If the user wants to clone or recreate it, recommend a representation (SVG keyframes, Canvas animation, a new Lottie JSON, CSS keyframes) based on what the animation actually does.

If the user just sent a sticker without asking anything specific, ask what they want to do with it before extracting — extraction takes a few seconds.

## Failure modes

- **`unknown format`** — magic bytes don't match WebP, gzip, or raw JSON. The file may be corrupt or a format WhatsApp introduced after this skill was written. Report the magic bytes from stderr to the user.
- **Lottie render hangs** — if `render-lottie.mjs` doesn't finish in ~30s, the JSON may be invalid or use a Lottie feature `lottie-web` doesn't support. Read the JSON header (`head -c 500 /tmp/.../lottie.json`) and report.
- **ffmpeg single-frame output for animated WebP** — some animated WebPs only expose one frame to the demuxer. If you only get `frame_001.png` for what looks animated, that's the source's fault, not the skill's.
