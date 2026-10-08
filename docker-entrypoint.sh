#!/bin/sh
# docker-entrypoint.sh -- Node API gateway
#
# Applies pending Drizzle migrations, then starts the server.
#
# Migrations run here because the schema has exactly one owner (ARCH-1) and
# because small hosting tiers give no shell access to run them by hand. Drizzle
# tracks applied migrations in its journal table, so this is idempotent: on a
# cold start with nothing pending it is a no-op round trip.
#
# A failed migration must not be papered over -- the server would then run
# against a schema it does not match. `set -e` plus the explicit check below
# means the container exits non-zero and the host surfaces a failed deploy.
#
#   RUN_MIGRATIONS=false   skip the migrate step (already applied out of band)
set -e

if [ "$RUN_MIGRATIONS" = "false" ]; then
    echo "[ENTRYPOINT] RUN_MIGRATIONS=false — skipping migrations"
else
    echo "[ENTRYPOINT] applying database migrations..."
    if npm run --silent db:migrate; then
        echo "[ENTRYPOINT] migrations up to date"
    else
        echo "[ENTRYPOINT] migrations FAILED — refusing to start the server."
        echo "[ENTRYPOINT] Check DATABASE_URL is reachable and the credentials"
        echo "[ENTRYPOINT] can create tables, then redeploy."
        exit 1
    fi
fi

exec node dist/index.cjs
