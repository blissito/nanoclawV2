---
name: image-gen
description: Generate images with OpenAI gpt-image-1 (low or high quality). Auth via OneCLI proxy.
allowed-tools: Bash(generate-preview:*)
---

# Image Generation (OpenAI)

Generate images using OpenAI's `gpt-image-1` model. Auth is handled by OneCLI — the script always passes `Authorization: Bearer placeholder` and the proxy rewrites it for `api.openai.com`.

| Mode | Cost | When to use |
|------|------|-------------|
| `generate-preview "prompt"` | $0.011 | Drafts, iterations, quick previews |
| `generate-preview --hd "prompt"` | $0.04 | Final image, comparable to ChatGPT image quality |

## Examples

```bash
# Cheap draft
generate-preview "a logo for a taco shop, minimalist, vector"

# High quality final
generate-preview --hd "a corgi astronaut floating in space, photorealistic, dramatic lighting"
```

## Output & delivery

The script saves to `/workspace/agent/` and prints the path. Send the result via the nanoclaw send_message tool with `image_path`:

```
mcp__nanoclaw__send_message({ text: "Here you go!", image_path: "/workspace/agent/preview-XXX.png" })
```

## Prompt rules

- **Short prompts (<20 words)**: Expand into a detailed, vivid prompt — add style, lighting, composition, colors, detail keywords. Preserve user intent.
- **Long prompts (≥20 words)**: Use the user's text exactly as-is. Do NOT "improve" it.
- **Editing photos**: This script does NOT support input images. It generates from text only. For editing existing photos, a different tool is needed (not in this skill).

## Important

- Do NOT call the OpenAI API directly — always use this script. The auth header is intentionally `placeholder` and only works through the proxy.
- 1024x1024 is the only size supported by this script. Edit `size` in the script if you need other ratios.

## Troubleshooting

- **`OpenAI API: Incorrect API key`**: OneCLI secret not configured or not assigned to this agent. Tell the user to re-run `/add-image-gen` on the host.
- **`OpenAI API: Rate limit`**: Wait and retry. gpt-image-1 has stricter rate limits than text models.
- **`OpenAI API: content_policy_violation`**: Prompt was rejected. Rephrase to avoid people-likeness, violence, or copyrighted characters.
