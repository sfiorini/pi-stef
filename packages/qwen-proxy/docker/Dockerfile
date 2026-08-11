# ---- build stage: install + compile native deps (better-sqlite3) ----
FROM node:22-slim AS build
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
FROM node:22-slim AS runtime
ARG OCI_VERSION=dev
WORKDIR /app

# OCI labels for traceability (populated by buildx from metadata-action in CI)
LABEL org.opencontainers.image.title="@pi-stef/qwen-proxy" \
      org.opencontainers.image.source="https://github.com/sfiorini/pi-stef" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${OCI_VERSION}"

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app /app

# Non-root runtime (D16): node:22-slim already ships a `node` user at uid/gid 1000,
# so reuse it — creating a new group/user would collide (GID 1000 already exists).
RUN mkdir -p /data && chown 1000:1000 /data

# Set environment
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
