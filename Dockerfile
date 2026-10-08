# Dockerfile — Node.js API gateway (Railway entry point)
# Multi-stage: builds both Vite client and esbuild server bundle,
# then runs the compiled server which also serves the React SPA in production.

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install all deps (dev deps needed for build tooling)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy full source
COPY . .

# Build: runs vite (client → dist/public/) + esbuild (server → dist/index.cjs)
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Copy production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# ml-service/registry is needed by routes.ts to read feature importance files
COPY --from=builder /app/ml-service/registry ./ml-service/registry

# Migrations are applied at start by the entrypoint, so the migration files,
# the drizzle config and the schema it points at must all be in the runtime
# image -- not just the build stage.
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/tsconfig.json ./

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
