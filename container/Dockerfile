# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.116
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
        ffmpeg \
        yt-dlp \
        python3 \
        python3-pip \
        poppler-utils \
        imagemagick \
        libreoffice-calc \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- GitHub CLI (gh) ---------------------------------------------------------
# Adds the official packages.github.com repo, then installs gh.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ---- Deno --------------------------------------------------------------------
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# ---- Python extras (openpyxl, pandas) ----------------------------------------
# yt-dlp is already installed via apt above.
RUN pip3 install --break-system-packages --no-cache-dir openpyxl pandas

# ---- Background removal (rembg + u2net family) -------------------------------
# CPU-only onnxruntime. Pre-download the default `u2net` model to ~/.u2net so
# the first call inside an agent container doesn't block on a 170MB download.
# Other models (u2net_human_seg, u2net_cloth_seg, isnet-*, etc.) lazy-download
# on first use and cache to the same dir — that dir is baked into the image.
RUN pip3 install --break-system-packages --no-cache-dir \
        rembg \
        onnxruntime \
    && mkdir -p /home/node/.u2net \
    && U2NET_HOME=/home/node/.u2net python3 -c "from rembg import new_session; new_session('u2net')" \
    && chown -R node:node /home/node/.u2net
ENV U2NET_HOME=/home/node/.u2net

# ---- ML CPU toolchain (OCR + embeddings) -------------------------------------
# Both run on the same onnxruntime installed above. We deliberately avoid
# PyTorch / paddlepaddle / transformers (~2GB combined) and use ONNX-only
# packages — adds ~200MB to the image.
#
#   - rapidocr-onnxruntime: PaddleOCR det+rec models exported to ONNX,
#     bundled inside the wheel (no separate download). Pulls opencv-python
#     (~190MB full, with X11/GTK/Qt) as a transitive dep — we then uninstall
#     it and install opencv-python-headless instead. cv2 is a shared
#     namespace so rapidocr still works; we just save the GUI bindings we
#     don't use in a headless container.
#   - fastembed: minimal embeddings runtime; pre-fetch the multilingual MiniLM
#     model (~220MB, 384-d, ~50 langs incl. Spanish) at build so the first
#     agent call doesn't block on a download. (e5-small isn't supported in
#     fastembed 0.8 — only e5-large at 2.24GB; MiniLM is the lighter pick.)
RUN pip3 install --break-system-packages --no-cache-dir \
        rapidocr-onnxruntime \
        fastembed \
    && pip3 uninstall --break-system-packages -y opencv-python \
    && pip3 install --break-system-packages --no-cache-dir opencv-python-headless \
    && mkdir -p /home/node/.fastembed \
    && python3 -c "from fastembed import TextEmbedding; TextEmbedding(model_name='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', cache_dir='/home/node/.fastembed')" \
    && python3 -c "import cv2; print('cv2 still importable from headless:', cv2.__version__)" \
    && chown -R node:node /home/node/.fastembed

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# ---- v1 parity: extra global Node CLIs ---------------------------------------
# Pinned versions (>3 days old per pnpm minimumReleaseAge policy).
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        panel-mcp@0.1.2 \
        smatch-mcp@1.7.2 \
        smatch-mcp-public@1.0.2 \
        pptxgenjs@4.0.1 \
        puppeteer-core@24.42.0

# Make pnpm-global puppeteer-core importable from skill scripts. ESM ignores
# NODE_PATH, so we symlink the package into /app/node_modules (bun's tree from
# the agent-runner install). Node's ESM resolver walks up from
# /app/skills/<skill>/<script> and finds it there. Robust against pnpm
# changing its versioned global path because we resolve it via `pnpm root -g`.
RUN ln -sf "$(pnpm root -g)/puppeteer-core" /app/node_modules/puppeteer-core

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
