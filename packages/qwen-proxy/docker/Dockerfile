# ---- build stage: install + compile native deps (better-sqlite3) ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install build tools for native deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# Copy workspace root files (build context = repo root)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/qwen-proxy/package.json ./packages/qwen-proxy/package.json
COPY packages/paths/package.json ./packages/paths/package.json

# Install dependencies
RUN pnpm install --prod --frozen-lockfile --filter @pi-stef/qwen-proxy

# Copy source
COPY packages/qwen-proxy/src ./packages/qwen-proxy/src
COPY packages/qwen-proxy/bin ./packages/qwen-proxy/bin
COPY packages/paths/src ./packages/paths/src

# ---- runtime stage: slim, non-root, /data chowned (D16) ----
FROM node:22-bookworm-slim AS runtime
ARG OCI_VERSION=dev
WORKDIR /app

# OCI labels for traceability (populated by buildx from metadata-action in CI)
LABEL org.opencontainers.image.title="@pi-stef/qwen-proxy" \
      org.opencontainers.image.source="https://github.com/sfiorini/pi-stef" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${OCI_VERSION}"

# Install Chromium + fonts for Baxia token generation + curl for healthcheck.
# --no-sandbox is required under Docker's default seccomp profile (no user-namespace
# sandbox); mitigated by: non-root uid 1000, localhost-only CDP, ephemeral browser
# dir, single trusted URL (chat.qwen.ai), and short-lived Chrome processes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji curl && \
    rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app /app

# Non-root runtime (D16): node:22-slim already ships a `node` user at uid/gid 1000,
# so reuse it — creating a new group/user would collide (GID 1000 already exists).
RUN mkdir -p /data /home/node/.cache && chown 1000:1000 /data /home/node/.cache

# Set environment
ENV HOME=/home/node
ENV XDG_CACHE_HOME=/home/node/.cache
ENV SF_QWEN_CHROME_PATH=/usr/bin/chromium
ENV SF_QWEN_USE_CHROME_BAXIA=true
ENV SF_QWEN_BAXIA_PRE_WARM=true
ENV SF_QWEN_HOST=0.0.0.0
ENV SF_QWEN_PORT=7790
ENV SF_QWEN_DB=/data/qwen-proxy.db

EXPOSE 7790
USER 1000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7790/v1/health || exit 1

# Run from the package directory so Node resolves the tsx binary that pnpm
# installs there (filtered installs don't create a workspace-root .bin/tsx).
WORKDIR /app/packages/qwen-proxy
CMD ["./node_modules/.bin/tsx", "bin/qwen-proxy.ts"]
