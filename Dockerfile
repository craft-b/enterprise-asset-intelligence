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

# ml-service/registry is deliberately NOT copied.
#
# It used to be, "needed by routes.ts to read feature importance files". That
# stopped being true: feature importance comes over HTTP from the ML service,
# and the last filesystem read of this directory -- the modelStatus probe --
# was removed in 4342e72 because it could only ever fail here. The API and the
# ML service are separate images; this path has only ever existed in the other.
#
# Verified before removing: the compiled bundle contains no reference to
# ml-service/registry or any ml-service path, and the only fs call in server/
# is static.ts checking dist/. See scripts/dockerfile-parity.test.ts.
#
# Not free to carry. From a git clone it is ~1.7MB of superseded JSON, since
# registry/*.pkl is gitignored -- but .dockerignore does not exclude those, so
# a build from a working tree that has trained locally copies every pickle in
# it: 431MB measured, none of it read.

# Two families of registry JSON, and nothing else from that directory.
#
# This reverses part of the note above, deliberately. Feature importance and
# hyperparameters are properties of a pinned model version -- they do not
# change between requests -- and fetching them over HTTP made a static fact
# depend on another service being awake. On 2026-10-29 the host began
# answering this API's requests to that service with a Cloudflare challenge,
# and two panels on the model page went blank over values committed in this
# repository. services/model-card.ts now reads them here when the service
# cannot be reached.
#
# Scoped to these two globs rather than the directory, which keeps the cost
# the note above warns about from coming back: no *.pkl can match, so a build
# from a working tree that has trained locally cannot drag 431MB of pickles
# into the image. These are a few dozen KB of JSON.
COPY --from=builder /app/ml-service/registry/metadata_30d_*.json      /app/ml-service/registry/feature_importance_30d_*.json      ./ml-service/registry/

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
