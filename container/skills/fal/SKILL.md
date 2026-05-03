---
name: fal
description: Generate vector logos (SVG) and convert raster images to SVG via Recraft on fal.ai. Use for logo / brand mark / icon requests, or when the user sends a PNG/JPG and wants the editable SVG version.
allowed-tools: Bash(generate-logo:*),Bash(vectorize-image:*)
---

# fal.ai — Recraft V4 (vector logos + raster→SVG)

Two scripts in PATH:

| Script | Modelo | Costo | Uso |
|--------|--------|-------|-----|
| `generate-logo "<prompt>" [--pro]` | `fal-ai/recraft/v4/text-to-vector` | $0.08 (`--pro` $0.30) | Logo / icono / brand mark desde texto |
| `vectorize-image <path>` | `fal-ai/recraft/vectorize` | $0.01 | Raster (PNG/JPG) → SVG limpio |

Output siempre `.svg` en `/workspace/agent/`. Stdout = path del archivo. Exit ≠ 0 con stderr en error.

## Cuándo usar `generate-logo` vs `generate-preview`

- **Logo, marca, icono, brand asset** → `generate-logo`. SVG nativo, paths editables, escala perfecto.
- **Foto, ilustración general, mockup, render** → `generate-preview` (gpt-image-1, raster). Para todo lo demás.

`generate-preview` es **malo** para logos: pixela al escalar, alucina texto, no produce SVG. No lo uses para nada que diga "logo" / "isotipo" / "icono" / "marca".

## Cuándo usar `vectorize-image`

Cliente manda una imagen y dice una de estas:
- "vectorízalo"
- "pásalo a SVG"
- "necesito el editable de este logo"
- "limpia este logo viejo"
- "que escale sin pixelarse"

Acepta PNG, JPG, WebP. Hasta ~2 MB funciona inline (data URI). Si el archivo es enorme, pide al cliente una versión más chica.

## Ejemplos

```bash
# Logo simple
generate-logo "minimalist logo for a coffee shop named Vento, monoline, sans-serif"

# Pro quality (más caro, más tiempo)
generate-logo "geometric emblem for a chess club, deep blue and gold, art deco" --pro

# Vectorizar lo que mandó el cliente
vectorize-image /workspace/attachments/logo-cliente.png
```

Output ejemplo: `/workspace/agent/logo-1777730095530.svg`

## NO auto-envía

Estos scripts NO mandan el archivo al chat por sí solos. Después de obtener el path, **llama `mcp__nanoclaw__send_file({ path })`** para entregarlo.

```
1. generate-logo "..." → /workspace/agent/logo-XXX.svg
2. mcp__nanoclaw__send_file({ path: "/workspace/agent/logo-XXX.svg" })
3. (opcional) un comentario corto al usuario sobre lo que generaste
```

## Errores comunes

- `ERROR: FAL_KEY not set` — el container no tiene la key inyectada. Tema de host (.env del droplet), no del agente. Reportar al usuario.
- `ERROR: no SVG URL in response: ...` — fal devolvió shape inesperado. Pegar el response al usuario para diagnóstico.
- HTTP 4xx desde curl — usually quota / billing en https://fal.ai/dashboard, o prompt rechazado por moderation.
