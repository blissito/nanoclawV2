# Install Inventory: droplet-2e602aa0

Snapshot commit: 96f523f1
Base: 4116251 (qwibitai/main)
Captured: 2026-04-30T05:12Z

## Summary

- 80 files changed total
- 5 belong on channels branch (extract → blissito/channels)
- 11 belong on providers branch (extract → blissito/providers)
- 22 container skills (already installable via /add-* skills, mostly already in main)
- 6 truly server-only / install-snapshot deltas (config + setup tweaks)
- 36 already-on-main duplicates (merge from main to dedupe)

## Files by Category

### CHANNEL → blissito/channels
- src/channels/whatsapp.ts — native Baileys v6/7 WhatsApp adapter (lives on `channels` branch upstream)
- src/channels/whatsapp.test.ts — test for the WhatsApp adapter
- src/channels/index.ts — adds `import './whatsapp.js'` self-registration line (delta vs main)
- setup/whatsapp-auth.ts — WhatsApp pairing/QR step for setup driver (forked from channels-branch version)
- setup/groups.ts — WhatsApp group metadata sync step (Baileys groupFetchAllParticipating)

### PROVIDER → blissito/providers
- src/providers/codex.ts — host container-config for codex provider
- src/providers/opencode.ts — host container-config for opencode provider
- src/providers/index.ts — adds `import './codex.js'` + `import './opencode.js'` registration (delta vs main)
- container/agent-runner/src/providers/codex.ts — in-container codex provider impl
- container/agent-runner/src/providers/codex-app-server.ts — Codex AppServer JSONL bridge
- container/agent-runner/src/providers/codex.factory.test.ts
- container/agent-runner/src/providers/opencode.ts — in-container opencode provider impl
- container/agent-runner/src/providers/opencode.factory.test.ts
- container/agent-runner/src/providers/mcp-to-opencode.ts — MCP → OpenCode tool bridge
- container/agent-runner/src/providers/mcp-to-opencode.test.ts
- container/agent-runner/src/providers/index.ts — adds `import './codex.js'` + `import './opencode.js'` (delta vs main)

### CONTAINER-SKILL (already covered by skill installer)
Already in main — no action needed (will dedupe via merge):
- container/skills/capabilities/SKILL.md
- container/skills/gif-gen/SKILL.md
- container/skills/gif-gen/generate-gif
- container/skills/image-gen/SKILL.md (differs vs main — extra image-gen variants below)
- container/skills/image-gen/generate-preview
- container/skills/mercadopago/SKILL.md
- container/skills/mercadopago/mercadopago
- container/skills/video-from-html/SKILL.md
- container/skills/video-from-html/make-video
- container/skills/video-from-html/templates/bar-chart.html
- container/skills/video-from-html/templates/metric-card.html
- container/skills/video-from-html/templates/quote-card.html
- container/skills/voice/SKILL.md
- container/skills/voice/clone-voice

Snapshot has extra image-gen variants NOT on main (candidate for an expanded `/add-image-gen` skill on the skill branch, or upstream PR):
- container/skills/image-gen/describe-image — OpenAI gpt-4o-mini vision wrapper
- container/skills/image-gen/edit-image — fal.ai bg-remove/upscale/inpaint/restyle
- container/skills/image-gen/face-swap — fal.ai face swap
- container/skills/image-gen/generate-flux — FLUX.2 pro photoreal
- container/skills/image-gen/generate-image — FLUX.2/Kontext default
- container/skills/image-gen/generate-lora — FLUX LoRA inference
- container/skills/image-gen/train-lora — FLUX LoRA training
- container/skills/voice/auto-send.ts — differs (auto-deliver helper)
- container/skills/voice/text-to-speech — differs (likely voice-set update)

### CONTAINER-CORE → keep on install branch (or extract upstream PRs)
All identical to main — will dedupe on merge:
- container/agent-runner/src/formatter.ts
- container/agent-runner/src/index.ts
- container/agent-runner/src/poll-loop.ts
- container/agent-runner/src/providers/claude.ts
- container/agent-runner/src/providers/types.ts
- container/agent-runner/src/usage-reporter.ts
- container/agent-runner/src/mcp-tools/agents.ts
- container/agent-runner/src/mcp-tools/channels.ts
- container/agent-runner/src/mcp-tools/channels.instructions.md
- container/agent-runner/src/mcp-tools/core.ts
- container/agent-runner/src/mcp-tools/google.ts
- container/agent-runner/src/mcp-tools/google.instructions.md
- container/agent-runner/src/mcp-tools/index.ts
- container/agent-runner/src/mcp-tools/server.ts

### HOST-CORE → keep on install branch
All identical to main — dedupe on merge:
- src/admin-server.ts
- src/channels/adapter.ts
- src/claude-md-compose.ts
- src/container-runner.ts
- src/db/discovered-channels.ts
- src/db/migrations/014-discovered-channels.ts
- src/db/migrations/index.ts
- src/delivery.ts
- src/host-sweep.ts
- src/index.ts
- src/router.ts
- src/status-tracker.ts

### HOST-MODULE → keep on install branch
All identical to main — dedupe on merge:
- src/modules/index.ts
- src/modules/approvals/onecli-approvals.ts
- src/modules/channels/index.ts
- src/modules/channels/apply.ts
- src/modules/self-mod/index.ts
- src/modules/self-mod/apply.ts
- src/modules/self-mod/request.ts

### CONFIG
Diverges from main — install-specific or carries channel/provider deps:
- package.json — adds @whiskeysockets/baileys 7.0.0-rc.9, @types/qrcode, jimp, pino, qrcode (CHANNEL deps for whatsapp; should land via `/add-whatsapp` skill on consumer installs, not trunk)
- pnpm-lock.yaml — corresponding lock changes
- container/agent-runner/package.json — adds @opencode-ai/sdk 1.4.17 (PROVIDER dep; lands via `/add-opencode`)
- container/agent-runner/bun.lock — corresponding lock changes
- container/Dockerfile — same as main (no delta)
- container/CLAUDE.md — differs vs main: extra image-gen tool descriptions (describe-image, generate-image, generate-flux, edit-image, face-swap, generate-lora, train-lora) + a "document delivery preference" section preferring send_file over public URLs. Local-customization material — keep on install branch or fold into `/add-image-gen` SKILL.md.

### DELETED-NOISE
Files removed from upstream that shouldn't have been in trunk:
- groups/global/CLAUDE.md — per-install group folder, never belonged in trunk
- groups/main/CLAUDE.md — same

### ALREADY-IN-MAIN (dedupe via merge)
Already-merged commits visible in `git log 4116251..main` that the snapshot duplicates. Plain `git merge main` (or rebase onto main) will collapse all 36 of these without conflict since the file contents are byte-identical:

Host: src/admin-server.ts, src/channels/adapter.ts, src/claude-md-compose.ts, src/container-runner.ts, src/db/discovered-channels.ts, src/db/migrations/014-discovered-channels.ts, src/db/migrations/index.ts, src/delivery.ts, src/host-sweep.ts, src/index.ts, src/router.ts, src/status-tracker.ts, src/modules/index.ts, src/modules/approvals/onecli-approvals.ts, src/modules/channels/{index,apply}.ts, src/modules/self-mod/{index,apply,request}.ts (19)

Container: container/Dockerfile, container/agent-runner/src/formatter.ts, .../index.ts, .../poll-loop.ts, .../usage-reporter.ts, .../providers/{claude,types}.ts, .../mcp-tools/{agents,channels,channels.instructions.md,core,google,google.instructions.md,index,server}.ts (15)

Skills: container/skills/{capabilities/SKILL.md, gif-gen/SKILL.md, gif-gen/generate-gif, image-gen/generate-preview, mercadopago/SKILL.md, mercadopago/mercadopago, video-from-html/* (5 files), voice/SKILL.md, voice/clone-voice} — these will collapse on merge; only describe-image/edit-image/face-swap/generate-flux/generate-image/generate-lora/train-lora and the differing voice files remain as net new.

Note: commits already on `main` covering these include 0d3458cd (port v1 skills), ab5238d9 (v1 parity tooling), fcaac2a9 (whatsapp media), 9e2dd751 (host reaction lifecycle), 5f5b0a07 + 016269ad (google), 28346030 + 86661098 + 50354bd4 (channels MCP tools), 36248373 (token usage), 5eb6460e + 7c0c77fd + 3b8683c5 (admin server), e7b86346 + cd19dbbe + 7563683b + 9f45adcc + 1aa14a65 + fadb71a8 (host-sweep / anti-hang), 7c94bb19 (capabilities), 216465d1 (restart_container), c8d14dec (video-from-html). The install branch is essentially "main + WhatsApp + opencode/codex providers + extra image-gen variants + a customized container/CLAUDE.md."

## Recommended Next Steps

1. Merge `main` into `install-droplet-2e602aa0` first (or rebase). The 36 ALREADY-IN-MAIN files are byte-identical and will fold cleanly, shrinking the diff to roughly the 20 truly novel files.
2. After the merge, the residual diff is exactly the install-snapshot's customizations split into three buckets:
   - CHANNEL bucket → cherry-pick `src/channels/whatsapp.{ts,test.ts}`, the `index.ts` import line, `setup/{whatsapp-auth,groups}.ts`, and the WhatsApp-related `package.json` deps onto `blissito/channels` (or confirm they already match the channels branch's WhatsApp adapter and discard the snapshot copy).
   - PROVIDER bucket → cherry-pick the 8 codex/opencode files + 2 index registrations + `@opencode-ai/sdk` dep onto `blissito/providers`.
   - Install-only residue → 7 image-gen scripts (consider an upstream `/add-image-gen` expansion on the skill branch), `container/CLAUDE.md` doc tweaks, `voice/auto-send.ts` + `voice/text-to-speech` deltas, and the deleted `groups/{global,main}/CLAUDE.md`.
3. After steps 1-2, the install branch should be empty of diff vs main+channels+providers — at which point the droplet can rebuild from a clean `main` + `/add-whatsapp` + `/add-opencode` (+ optional `/add-codex`) instead of carrying a custom branch. That is the migration target.
