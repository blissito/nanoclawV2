---
name: remove-bg
description: Remove backgrounds and segment images locally with the u2net family (rembg). Free, no API keys, works in batch.
allowed-tools: Bash(remove-bg:*)
---

# Background Removal & Segmentation (free, local)

Wraps `rembg` + the u2net model family. Runs on CPU inside the container — no GPU, no network calls after the model is cached. First call downloads the model (~170MB for `u2net`); subsequent calls are fast.

| Mode | Command | When |
|------|---------|------|
| **Default** | `remove-bg img.jpg` | Product photos, general subjects |
| **Humans** | `remove-bg --model u2net_human_seg portrait.jpg` | Portraits / people |
| **Clothing** | `remove-bg --model u2net_cloth_seg outfit.jpg` | E-commerce apparel (3-class mask: upper/lower/full) |
| **Anime** | `remove-bg --model isnet-anime char.png` | Illustrations, anime characters |
| **Sharper general** | `remove-bg --model isnet-general-use img.png` | When `u2net` looks soft |
| **Soft edges** | `remove-bg --alpha-matting hair.jpg` | Hair, fur, fuzzy borders |
| **Mask only** | `remove-bg --mask-only img.png` | When you want just the alpha mask |
| **Composite (color)** | `remove-bg --bg-color 255,255,255 img.png` | Replace bg with solid color |
| **Composite (image)** | `remove-bg --bg-image scene.jpg subject.png` | Drop subject onto another scene |
| **Batch** | `remove-bg --batch /path/to/dir` | Many images at once |

## Models

```
u2net                  general — default, balanced quality (170MB)
u2netp                 lightweight u2net (4MB), faster but rougher
u2net_human_seg        humans / portraits
u2net_cloth_seg        clothing — outputs 3-class mask (upper / lower / full)
silueta                u2net alternative, slightly different bias
isnet-general-use      ISNet — sharper general-purpose alternative
isnet-anime            anime / illustrated characters
```

`remove-bg --list-models` prints this list.

## Picking the right model

- **Don't know?** Start with default `u2net`. If edges look bad, try `isnet-general-use`.
- **Person in shot?** `u2net_human_seg` — it ignores background props the general model gets confused by.
- **Clothing on a person/mannequin?** `u2net_cloth_seg`.
- **Anime / cartoons / illustrations?** `isnet-anime`.
- **Need fast batch through hundreds of images?** `u2netp` (smaller, faster, rougher).

## Soft edges (hair, fur, fuzzy stuff)

```bash
remove-bg --alpha-matting --erode-size 15 portrait.jpg
```

Slower but the result around hair / fur edges is much cleaner. Tune `--erode-size`, `--fg-threshold`, `--bg-threshold` if needed.

## Composite onto another background

```bash
# Solid color (white product page)
remove-bg --bg-color 255,255,255 product.jpg

# Image background (subject on a beach)
remove-bg --bg-image /workspace/agent/beach.jpg subject.jpg
```

The composite is saved as JPG (no transparency needed). Without `--bg-color` / `--bg-image`, output is PNG with alpha.

## Batch

```bash
# Whole directory
remove-bg --batch /workspace/agent/products/

# Glob pattern (quote it so the shell doesn't expand)
remove-bg --batch '/workspace/agent/*.jpg'
```

Each path is printed on its own line. Combine with the model and other flags as usual.

## Output & delivery

All results land in `/workspace/agent/` and the path is printed on stdout. Send the file via:

```
mcp__nanoclaw__send_file({ path: "/workspace/agent/nobg-XXX.png" })
```

For a batch, send each one (or zip them first if it's many).

## What u2net does NOT do well

- **Glass / water / very transparent objects** — the model has no concept of transparency.
- **Subject same color as background** — low contrast = bad mask.
- **Multiple entangled subjects** — picks one and bleeds.
- **Pixel-perfect product cutouts at high res** — for catalog-grade work, BiRefNet / SAM are better but need GPU.

If the result is bad, try `isnet-general-use` first, then `--alpha-matting`. If still bad, tell the user this category is a known weakness and offer to try a different photo.
