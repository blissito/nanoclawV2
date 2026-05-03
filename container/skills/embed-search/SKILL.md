---
name: embed-search
description: Semantic search over your workspace text files using local multilingual embeddings (fastembed + e5-small). Free, local.
allowed-tools: Bash(embed-search:*)
---

# Semantic Search (free, local, multilingual)

Search your workspace by *meaning*, not just keywords. Indexes `.md` / `.txt` files under any directory using `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384-d, ~220MB, ~50 languages including Spanish & English) running on onnxruntime CPU.

The index is cached on disk and incremental — only changed files re-embed on subsequent runs.

| Mode | Command |
|------|---------|
| Top 5 hits | `embed-search "qué dijo del rebrand" /workspace/group/conversations/` |
| Top 10 hits | `embed-search --top 10 "factura febrero" /workspace/group/notes/` |
| JSON output | `embed-search --json "deepseek pricing" /workspace/group/` |
| Force re-index | `embed-search --rebuild "..." /workspace/group/` |

## When to use

- You need to remember something the user mentioned days/weeks ago — search `conversations/` instead of dumping the whole transcript into context.
- The user references "ese cliente que dijo X" — find the relevant past message before answering.
- Triaging dozens of notes / docs by topic.
- Pulling related context across multiple files for a decision.

## How it works (briefly)

1. Walks the directory recursively for `.md` / `.txt`.
2. Splits each file into ~600-char overlapping chunks.
3. Embeds with paraphrase-multilingual-MiniLM (no prefix needed).
4. Stores vectors in `<dir>/.embed-index.json` (incremental — re-runs only embed changed/new files based on mtime+size).
5. At query time, embeds the query, cosine-ranks all chunks, returns top-N.

## Output

Plain mode is one entry per hit:

```
[0.847] conversations/2026-04-25.md
    El user pidió que migremos a OpenCode con DeepSeek porque...

[0.812] notes/deepseek-cost-analysis.md
    DeepSeek expone OpenAI-compatible endpoint en api.deepseek.com/v1...
```

`--json` returns `[{file, score, preview}, ...]` for scripted follow-ups.

## Tips

- **Always search before assuming the user is asking something brand-new** — check `conversations/` first if the topic feels familiar.
- **First run on a big directory takes a while** (one-time embedding of every chunk). Subsequent runs are fast — only changed files re-embed.
- **The index file** (`.embed-index.json`) lives alongside the indexed files. Delete it manually or use `--rebuild` to force a clean re-index (e.g. if you changed many files at once and want a clean state).
- **Multilingual**: queries in Spanish find English content and vice versa — the embedding space is shared.

## Limits

- `.md` and `.txt` only by default. PDFs / docx need `pdftotext` / `libreoffice` first.
- Chunks are 600 chars — a single very long fact spread across paragraphs may not all match. Re-rank or read the full file after the search points you to it.
- Score is cosine similarity (0-1). >0.85 is very strong, 0.7-0.85 is relevant, <0.6 is probably noise.
