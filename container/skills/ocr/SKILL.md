---
name: ocr
description: Extract text from images locally with PaddleOCR weights via onnxruntime. Free, multi-language, batch.
allowed-tools: Bash(ocr:*)
---

# OCR (free, local, multi-language)

Wraps `rapidocr-onnxruntime` — the PaddleOCR detection + recognition models exported to ONNX. Runs on CPU, no API. Works on Spanish, English, Chinese, Japanese, Korean and more out of the box.

| Mode | Command |
|------|---------|
| Plain text | `ocr screenshot.png` |
| With boxes + scores | `ocr --json receipt.jpg` |
| Filter low-confidence | `ocr --min-confidence 0.7 ticket.png` |
| Batch | `ocr --batch /workspace/agent/screenshots/` |

## When to use vs Claude vision

- **Use `ocr`**: many images at once, need exact strings (URLs, codes, prices), need bounding-box coords, processing screenshots in bulk, or building a searchable text index.
- **Use Claude vision (just look at the image)**: single image where you also need to *understand* the content, not just transcribe it.

`ocr` is ~100× faster than vision for batch transcription and gives you exact characters (vision sometimes "smooths" weird strings).

## Output

Plain mode prints one detection per line, top-to-bottom roughly. `--json` gives full structure:

```json
{
  "screenshot.png": [
    { "text": "Total $1,250.00", "confidence": 0.97, "box": [[10,20],[200,20],[200,45],[10,45]] }
  ]
}
```

## Tips

- For a WhatsApp screenshot full of chat bubbles, `ocr` returns each bubble as a detection — order is approximate, may need re-sorting by box `y` if you care about chronology.
- Pre-crop with `generate-gif --crop WxH+X+Y` if you only want one region.
- Confidence below 0.5 is usually noise (logos, low-contrast UI chrome).

## Limits

- Handwriting: weak. Printed text only.
- Heavily rotated text (>30°): misses some.
- Tiny text (<8px tall in source): unreliable — upscale first with `upscale` if available.
