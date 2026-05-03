---
name: easybits
description: Reference & priority guide for the EasyBits MCP server (`mcp__easybits__*`). When to use EasyBits vs native skills, and which EasyBits tools exist.
allowed-tools: mcp__easybits__*
---

# EasyBits — when to use it

EasyBits is a cloud platform exposing **65+ tools** via MCP across files, image/video/voice generation, documents (designs), websites, forms, brand kits, characters, a built-in DB, and research. Auth is pre-wired — just call the tools.

**Default toolsets**: `core,design,websites,forms`. Set `EASYBITS_TOOLSETS` in the host `.env` to override per install (e.g. `core,design,webhooks` if you need event hooks).

## Decision table — EasyBits vs native skill

Most people land here because they need to make an image, voice note, or website. **The native skill is usually the right answer.** EasyBits wins when the user is *already* working inside their EasyBits workspace (brand kit, document, website) and the asset needs to live there.

| Task | Default to | Use EasyBits when |
|------|------------|-------------------|
| Generate an image | `generate-preview` (gpt-image-1) | The user wants the image inside an EasyBits document or applied with a brand kit → `image_generate` |
| Vector logo | `generate-logo` (Recraft) | Never — EasyBits has no native vector logo tool |
| Vectorize a raster | `vectorize-image` (Recraft, $0.01) | The user wants the *whole brand* (logo + colors + fonts) extracted from a website → `extract_brand_kit_from_url` |
| Voice note (TTS) | `text-to-speech` (ElevenLabs MX) | The audio needs to be stored in EasyBits or used inside a video they're building there → `voice_tts_create` |
| Talking head video | `avatar_video_create` (EasyBits) | Always — no native equivalent |
| GIF / animation | `generate-gif` (ffmpeg local, free) | Never |
| Background removal | `remove-bg` (u2net local, free) | Never |
| OCR | `ocr` (PaddleOCR local, free) | Never |
| Web scraping | `mcp__brightdata__*` | Quick one-off where BrightData feels like overkill → `research_search`/`research_scrape` |
| PDF text extraction | `pdftotext` (poppler, in PATH) | Never (see warning below) |
| File storage / sharing | EasyBits | Always — there is no native equivalent |

## Categories of EasyBits tools

| Category | Sample tools | Notes |
|----------|--------------|-------|
| Files | `list_files`, `get_file`, `upload_file`, `search_files` | Cloud storage with signed URLs |
| Sharing | `create_share_link`, `revoke_share_link` | Per-link expiry, send-anywhere URLs |
| Image edit | `optimize_image`, `transform_image` | WebP/AVIF, resize, rotate, grayscale |
| Image gen | `image_generate` | Brand-kit-aware variant of stock image gen |
| Video | `video_create`, `avatar_video_create`, `list_videos` | Talking heads, scripted videos |
| Voice | `voice_tts_create` | EasyBits TTS pipeline |
| Documents (design) | `create_document`, `add_page`, `set_page_html`, `apply_brand_kit`, `enhance_document_prompt`, `regenerate_document_page`, `fill_template`, `clone_document`, `deploy_document`, `change_document_format`, `pdf_to_images`, `get_document_pdf` | The big workhorse — multi-page designs that ship to web/PDF |
| Brand kits | `list_brand_kits`, `create_brand_kit`, `extract_brand_kit_from_url` | Logos + colors + fonts |
| Characters | `character_remember`, `character_list`, `character_delete` | Persistent identity memory the user can reference by name across sessions |
| Websites | `create_website`, `upload_website_file`, `deploy_website_file`, `inject_html` | Static-site hosting |
| Forms | `create_form`, `list_forms`, `list_form_submissions` | Form builder + submissions inbox |
| DB | `db_list`, `db_create`, `db_query` | Small built-in store, scoped to the EasyBits account |
| Research | `research_search`, `research_scrape` | Lighter than BrightData |
| Account | `get_usage_stats` | Storage used, plan info |

Run any tool — there's no `--list` meta-tool client-side; the agent just sees the live set in its allowlisted MCP tools.

## ⚠️ `get_document_pdf` OOM gotcha

This tool returns the **full PDF binary in the MCP response**. Documents larger than ~30MB or 50+ pages have **killed the container twice in production** (SIGKILL exit 137, 36s elapsed, last log entry was this tool call).

**Rules:**
- For "show me the PDF" → upload via `upload_file` and share the link, don't `get_document_pdf`
- For "extract text from a doc" → use `pdf_to_images` page-by-page, then OCR each image
- For small docs (<5 pages) where the user explicitly wants the binary → fine, but warn them this can hang
- If the call hangs more than ~20s, something is loading too much memory; cancel and switch strategy

## Auth & gotchas

- Auth is via `EASYBITS_API_KEY` in the host `.env`, passed through to the container as a real env var. Calls go **direct from container to `easybits.cloud`**, NOT through the OneCLI proxy. Per-agent secret assignment in OneCLI is decorative for this server (the env var wins).
- The MCP server is a thin stdio→HTTP proxy. The actual tool list and execution happen server-side at `easybits.cloud/api/mcp?tools=<toolsets>`.
- Tool names sometimes drift between EasyBits server versions. If a tool name in this guide ever returns "tool not found", just `tools/list` is the source of truth — try the closest name.
