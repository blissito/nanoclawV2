---
name: image-gen
description: Generate, edit, and face-swap images using fal.ai FLUX, OpenAI gpt-image-1-mini, and face-swap
allowed-tools: Bash(describe-image:*),Bash(generate-image:*),Bash(generate-flux:*),Bash(generate-preview:*),Bash(face-swap:*),Bash(edit-image:*),Bash(edit-image restyle:*),Bash(edit-image remove-object:*),Bash(train-lora:*),Bash(generate-lora:*)
---

# Image Generation, Editing & Face Swap

## describe-image (vision — see/read images)

DeepSeek-V4-Pro is text-only — it does NOT directly see images. When the user sends a photo and asks about it ("qué hay aquí?", "cuántos perros ves?", "léeme el menú"), use describe-image to get a text description first, then reason about that.

```bash
# Default: full description of what is in the image
describe-image /workspace/attachments/img-1234.jpg

# Specific question
describe-image /workspace/attachments/img-1234.jpg "how many people are in this photo and what are they wearing?"

# OCR-style read
describe-image /workspace/attachments/menu.jpg "transcribe all visible text"
```

- Uses OpenAI gpt-4o-mini vision (~$0.0001-0.0005 per call)
- Returns plain-text description that you then use back to the user
- Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation

You have FIVE image tools. Choose the right one:

| Tool | Model | Cost | When to use |
|------|-------|------|-------------|
| `generate-image` | FLUX.2 [pro] / Kontext | $0.03-0.04 | **Default** — text-to-image, edit/modify photos, combine elements |
| `generate-flux` | FLUX.2 [pro] | $0.03 | Photorealistic, ultra-quality, image-guided style transfer |
| `generate-preview` | gpt-image-1-mini | $0.005 | Quick drafts, previews, iterations before final version |
| `generate-preview --hd` | gpt-image-1 | $0.04 | High-quality OpenAI image generation/editing |
| `face-swap` | fal.ai | — | Preserve a specific person's face identity |
| `edit-image` | fal.ai | $0.00-0.055 | Background removal, upscaling, segment+paint, inpainting, restyle, object removal |
| `train-lora` | fal.ai | ~$2-3 | Train a LoRA on 15-20 images of a character/style (one-time, ~10 min) |
| `generate-lora` | fal.ai | $0.02 | Generate images using a trained LoRA — consistent character every time |

## Decision guide

- "Genera una imagen de..." / "Hazme un logo" → `generate-image` (text-to-image)
- "Cambia el fondo" / "quita esto" / "pon un sombrero" → `generate-image` (editing with Kontext)
- **"Ponle color X de tal zona para abajo/arriba"** / "pinta esta zona de azul" / "ponle tono" / any request to paint/recolor a SPECIFIC ZONE of a photo → **ALWAYS use `edit-image segment-paint`**, NOT generate-image. This tool auto-segments the zone and paints only that area precisely.
- "Foto realista de..." / "flux" / "fotorrealismo" → `generate-flux`
- "Transforma esta imagen al estilo..." → `generate-flux` with reference image
- "Dame un preview rápido" / iterating on concepts / "a ver cómo se ve" → `generate-preview`
- "Hazlo con buena calidad" / "como ChatGPT" / needs high quality text-to-image → `generate-preview --hd`
- "Pon MI CARA en esta foto" / "swap faces" → `face-swap`
- "Quita el fondo" / "hazla sin fondo" / "background remove" → `edit-image bg-remove`
- "Quita esto" / "borra a la persona" / "elimina el objeto" → `edit-image remove-object`
- "Hazla estilo acuarela" / "como anime" / "estilo pintura al óleo" → `edit-image restyle`
- "Mejora la calidad" / "upscale" / "hazla más grande" / "más resolución" → `edit-image upscale`
- User asks for multiple options/variations → use `generate-preview` first, then `generate-image` for the final

## generate-image

```bash
# Text to image (FLUX.2 pro)
generate-image "a cat floating in space, photorealistic"

# Edit with one image (Kontext pro)
generate-image "put this person on a tropical beach" /workspace/attachments/img-1234.jpg

# Edit with source image
generate-image "change the background to a sunset" /workspace/attachments/img-1234.jpg
```

Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation.

## generate-flux

```bash
# Text to image (photorealistic)
generate-flux "an old Mexican grandfather winning an esports tournament, holding a trophy, photorealistic"

# Image-guided generation (uses reference photo for style/composition)
generate-flux "transform this into a cyberpunk scene" /workspace/attachments/img-1234.jpg
```

- Produces ultra-high quality photorealistic images
- Reference image controls style/composition, NOT face identity (use face-swap for that)

## generate-preview

```bash
# Quick cheap preview (mini, $0.005)
generate-preview "a logo for a taco shop, minimalist"

# High-quality with full gpt-image-1 ($0.04)
generate-preview --hd "a car with glossy black paint on the lower bumper"
```

- Without `--hd`: fast and cheap ($0.005) — use for drafts and iterations
- With `--hd`: full gpt-image-1 model ($0.04) — high quality, good for detailed edits and final images
- Text-to-image only (no reference image input)
- Use `--hd` when the user needs quality comparable to ChatGPT's image generation

## face-swap

```bash
# Swap the face from photo 1 onto the person in photo 2
face-swap /workspace/attachments/img-FACE.jpg /workspace/attachments/img-TARGET.jpg
```

- First argument: the photo with the FACE to use (source face)
- Second argument: the photo where the face will be PLACED (target body/scene)

## edit-image

```bash
# Remove background (outputs PNG with transparency)
edit-image bg-remove /workspace/attachments/img-1234.jpg

# Upscale image (default 2x)
edit-image upscale /workspace/attachments/img-1234.jpg

# Upscale 4x
edit-image upscale /workspace/attachments/img-1234.jpg 4

# Segment + paint: auto-mask a zone and paint it a color
edit-image segment-paint /workspace/attachments/img-1234.jpg "lower bumper and panels" "paint metallic blue"

# Inpaint with manual mask file
edit-image inpaint /workspace/attachments/img-1234.jpg /workspace/agent/mask.png "fill with red paint"
```

- `segment-paint` uses SAM 3 + FLUX Pro Fill — $0.055, auto-segments a zone by description and paints it
- `bg-remove` uses BiRefNet — free, outputs transparent PNG
- `upscale` uses Clarity Upscaler — $0.04, enhances resolution and detail
- `inpaint` uses FLUX Pro Fill — $0.05, inpainting with manual mask file
- `restyle` uses FLUX Dev img2img — $0.025, transforms style preserving composition (strength 0-1, default 0.75)
- `remove-object` uses SAM 3 + FLUX Pro Fill — $0.055, auto-segments and removes an object cleanly

### restyle (image-to-image style transfer)

```bash
# Transform style (default strength 0.75)
edit-image restyle /workspace/attachments/img-1234.jpg "watercolor painting style"

# Lower strength = more faithful to original (0.5)
edit-image restyle /workspace/attachments/img-1234.jpg "anime illustration" 0.5

# Higher strength = more creative transformation (0.9)
edit-image restyle /workspace/attachments/img-1234.jpg "cyberpunk neon city" 0.9
```

### remove-object

```bash
# Remove a person/object from a photo (auto-segments + fills background)
edit-image remove-object /workspace/attachments/img-1234.jpg "the person on the left"
edit-image remove-object /workspace/attachments/img-1234.jpg "the trash can"
```

## Output & delivery

All scripts save to `/workspace/agent/` and print the path. Send the result as a native image:

```
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/agent/generated-123.jpg" })
```

## Prompt rules

- **Short descriptions (< 20 words):** Expand into a detailed, vivid prompt — add style, lighting, composition, colors, and detail keywords while preserving the user's intent.
- **Medium/long descriptions (≥ 20 words):** Use the user's description exactly as-is. Do not modify or "improve" it.

## Important

- Do NOT call curl or APIs directly — always use these scripts
- JPEG input is supported (no need to convert to PNG)
- Prefer `generate-image` over `generate-flux` for general requests — they use the same model for text-to-image, but `generate-image` also handles editing
- **CRITICAL: When the user sends a photo and asks to modify it (change color, paint a zone, add something), you MUST use a tool that accepts the photo as input (`generate-image`, `edit-image segment-paint`). NEVER use `generate-preview` for editing — it generates from scratch and ignores the user's photo entirely. `generate-preview` is ONLY for creating new images from text.**
- **When the user asks to paint/recolor a specific zone (defensas, bumper, hood, etc.), use `edit-image segment-paint` — it auto-segments the zone and paints only that area.**

## train-lora (character/style training)

```bash
# Train a LoRA from reference images (need 15-20, minimum 4)
train-lora "ghosty_plush" /workspace/attachments/img-1.jpg /workspace/attachments/img-2.jpg ...

# Glob pattern works too
train-lora "ghosty_plush" /workspace/attachments/ghosty-*.jpg
```

- Takes ~10 min, costs ~$2-3
- Saves LoRA config to `/workspace/agent/lora-<trigger>.json`
- Only needs to run once per character/style

## generate-lora (consistent character generation)

```bash
# Generate using trained LoRA — trigger word MUST appear in prompt
generate-lora "ghosty_plush" "ghosty_plush wearing a santa hat in a snowy Christmas scene"
generate-lora "ghosty_plush" "ghosty_plush as a barista in a cozy coffee shop, photorealistic"
```

- Requires a trained LoRA (run `train-lora` first)
- The trigger word must be in the prompt for the character to appear
- $0.02/image
- For edits on generated images, pipe the output to `generate-image` (Kontext)
