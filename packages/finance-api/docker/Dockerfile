# ---- build stage: install + compile native deps (better-sqlite3) ----
FROM node:20-slim AS build
WORKDIR /app

# Install build tools for native deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# Copy workspace root files (build context = repo root)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/finance-api/package.json ./packages/finance-api/package.json
COPY packages/paths/package.json ./packages/paths/package.json

# Install dependencies
RUN pnpm install --prod --frozen-lockfile --filter @pi-stef/finance-api

# Copy source
COPY packages/finance-api/src ./packages/finance-api/src
COPY packages/finance-api/bin ./packages/finance-api/bin
COPY packages/paths/src ./packages/paths/src

# ---- runtime stage: slim, no build tooling ----
FROM node:20-slim AS runtime
WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app /app

# Set environment
ENV SF_FINANCE_HOST=0.0.0.0
ENV SF_FINANCE_PORT=7780
EXPOSE 7780

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7780/v1/health || exit 1

# Run with tsx for TypeScript support
CMD ["npx", "tsx", "packages/finance-api/bin/finance-api.ts"]
