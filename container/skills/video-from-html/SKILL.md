---
name: video-from-html
description: Render an HTML scene to MP4/GIF/WebP via headless Chromium + ffmpeg. The HTML drives its own animation by exposing `window._tick(t)`; the skill captures N frames, encodes, and outputs a single file. Free, local, no API keys.
allowed-tools: Bash(make-video:*),Bash(ffmpeg:*),Bash(ffprobe:*)
---

# Video from HTML

Convert an animated HTML scene into a video file. Useful for: data reports, social posts, pitch clips, product demos, onboarding videos — anywhere "datos + HTML → MP4" beats designing in After Effects.

## Contract

The HTML you write **must** define a global `window._tick(t)` function where `t ∈ [0, 1]` represents progress through the animation. The skill calls `_tick(t)` once per frame, then screenshots.

```html
<script>
  window._tick = function(t) {
    // t goes 0 → 1 over the captured frames.
    // Move DOM, update text, drive CSS variables, advance Chart.js, etc.
    document.querySelector('.bar').style.width = (t * 100) + '%';
  };
</script>
```

If you set up your animation purely with CSS `@keyframes` (auto-playing), still define an empty `_tick` — the skill will still capture but timing depends on the CSS clock, which can drift. Driving via `_tick` is more deterministic.

## Usage

```bash
# Default: 120 frames @ 30fps = 4s, 1280x720, MP4
make-video --html scene.html --output out.mp4

# Long onboarding video, 30s @ 30fps
make-video --html onboarding.html --output onboarding.mp4 --frames 900

# Vertical 9:16 for Instagram / TikTok
make-video --html story.html --output story.mp4 --width 1080 --height 1920

# Animated GIF (smaller for chat)
make-video --html metric.html --output metric.gif --frames 60 --fps 24

# WhatsApp sticker (animated WebP, square, ≤512px, ≤500KB)
make-video --html sticker.html --output sticker.webp --width 512 --height 512 --frames 60 --fps 15
```

### Flags

| Flag | Default | Notes |
|------|---------|-------|
| `--html <path>` | (required) | Local file path or `file://` / `http://` URL. |
| `--output <path>` | (required) | Output extension picks the encoder: `.mp4`, `.gif`, `.webp`. |
| `--frames <N>` | `120` | Total frames captured. |
| `--fps <N>` | `30` | Output framerate. Duration = `frames / fps`. |
| `--width <N>` | `1280` | Viewport width. |
| `--height <N>` | `720` | Viewport height. |
| `--t-end <N>` | `1.0` | Max value of `t` passed to `_tick`. Use `1.4` to hold the final state for ~30% of the run. |
| `--crf <N>` | `20` | x264 quality (lower = better, 18-23 is the useful range). MP4 only. |
| `--keep-frames` | off | Don't delete the temp `frame_*.png` directory. Useful for debugging. |

## Tips

- **Fonts**: load via `@font-face` or use system fonts. Chromium has a basic latin set; CJK fonts are not in the base image (see `INSTALL_CJK_FONTS=true` in `.env` if needed).
- **Charts**: `chart.umd.min.js` is available in the workspace if Ghosty already had it. Otherwise `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` works at render time (loaded with `networkidle0`).
- **Timing**: at 30fps a 10s video is 300 frames and takes ~30-60s wall time inside the container.
- **WhatsApp size limits**: video ≤16MB, sticker ≤500KB, animated WebP loop ≤6s. Pre-check with `ffprobe`.

## When NOT to use this skill

- Static images → use `generate-preview` (image-gen) or `generate-gif --convert`.
- Single screenshot → use `agent-browser` + `screenshot`.
- Slideshow of pre-rendered images → use `generate-gif img1 img2 img3`.
- Live narration → render here, then `text-to-speech` separately, then `ffmpeg -i video.mp4 -i voice.ogg -c copy -c:a aac out.mp4`.

## Templates

`templates/` ships with starter scenes you can copy and modify:

- `metric-card.html` — single big number + label, slides in, holds.
- `bar-chart.html` — animated horizontal bars with labels.
- `quote-card.html` — text reveal with author, good for social posts.

Copy → edit → render. Don't rewrite the capture script per scene.
