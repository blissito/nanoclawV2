---
name: gif-gen
description: Create animated GIFs locally with ffmpeg — crop regions, convert formats, slideshow, or sprite sheet animation. No API keys, no cost.
allowed-tools: Bash(generate-gif:*),Bash(ffmpeg:*),Bash(ffprobe:*)
---

# GIF Generation (free, local)

| Mode | Command | Cost |
|------|---------|------|
| **Crop** | `generate-gif --crop WxH+X+Y img.png` | Free |
| **Convert** | `generate-gif --convert img.avif` | Free |
| **Sprite sheet** | `generate-gif --sprite 4x3 [--fps N] [--format gif\|webp\|mp4] sprite.png` | Free |
| **Slideshow** | `generate-gif img1.png img2.png img3.png` | Free |

## When to use each mode

- User sends image + "recorta X y hazlo gif" / "solo la parte de..." → **Crop**
- User sends image + "conviértelo a gif" / "hazlo gif" (no animation needed) → **Convert**
- User sends sprite sheet + "anima este sprite" / "hazlo gif/webp/mp4" → **Sprite sheet**
- User sends multiple images + "haz un gif" / "gif con estas" → **Slideshow**

## Crop mode — pixel-perfect

Use vision to locate the region, then convert percentages to pixel coordinates.

```bash
# Read source dimensions first
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 /path/to/img.jpg
# Then crop
generate-gif --crop 768x648+0+216 /path/to/img.jpg
```

**Important:** Always use `ffprobe` to get real dimensions — don't guess from a resized vision thumbnail.

## Sprite sheet mode

Animate a grid of frames into GIF, WebP, or MP4.

```bash
generate-gif --sprite 4x3 spritesheet.png                          # 12 frames, 10fps gif
generate-gif --sprite 8x2 --fps 15 --format webp spritesheet.png   # 16 frames, 15fps webp
generate-gif --sprite 6x1 --fps 24 --format mp4 spritesheet.png    # 6 frames, 24fps mp4
```

`COLSxROWS` reads frames left-to-right, top-to-bottom. Look at the image with vision to count cols and rows, and verify `image_width / cols` and `image_height / rows` give clean frame sizes.

## Slideshow mode

```bash
generate-gif img1.png img2.png img3.png img4.png
```

1 second per frame, palette-optimized.

## Output & delivery

All scripts save to `/workspace/agent/` and print the path. Send via `mcp__nanoclaw__send_message` with `image_path`:

```
mcp__nanoclaw__send_message({ text: "Here's the gif!", image_path: "/workspace/agent/gif-XXX.gif" })
```

## Important

- All modes are **local** (ffmpeg). No API keys, no network, no cost.
- Output is capped at 480px wide for GIF/WebP (palette-optimized). Edit the script if you need larger output.
- For AI-driven animation (image-to-video, image-to-gif via fal.ai Kling), this skill does NOT include it — see the v1 install if you need it.
