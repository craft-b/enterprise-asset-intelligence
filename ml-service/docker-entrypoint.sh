#!/bin/sh
# ml-service/docker-entrypoint.sh
#
# Model artifacts are not in git (OPS-2: ~280MB of pickles were removed), and
# hosts without a persistent disk give the container an empty registry on every
# cold start. Training on boot is not an option -- the trainer needs far more
# memory than a small instance has, and a seeded database.
#
# So when the registry has no model, fetch the champion bundle published as a
# release asset. Set MODEL_BUNDLE_URL to that asset's URL.
#
#   MODEL_BUNDLE_URL     https URL of a .tar.gz of registry files (flat, no dir)
#   MODEL_BUNDLE_SHA256  expected sha256 of that archive -- strongly recommended
#   MODEL_FETCH_TIMEOUT  seconds per attempt (default 30)
#   MODEL_FETCH_RETRIES  attempts before giving up (default 3)
#
# Three properties this has to hold, all learned the hard way on Render:
#
#   1. BOUNDED. The platform scans for an open port and kills the deploy if
#      nothing listens in time. An unbounded download blocks uvicorn and fails
#      the deploy even when the fetch would eventually have worked.
#   2. RETRIED. GitHub serves release assets through a CDN that intermittently
#      502s requests from shared cloud egress IPs. The same URL that fetches in
#      2s from a laptop can fail from a container.
#   3. NON-FATAL. If the bundle cannot be had, start anyway. A service that
#      reports "no model" over /health is debuggable and can be restarted to
#      retry; a crash loop gives the operator a failed deploy and no endpoint.
set -e

REGISTRY="${REGISTRY_DIR:-/app/ml-service/registry}"
FETCH_TIMEOUT="${MODEL_FETCH_TIMEOUT:-30}"
FETCH_RETRIES="${MODEL_FETCH_RETRIES:-3}"

# A bundle committed in the image beats one fetched over the network, and
# fetch-models.py already prefers MODEL_BUNDLE_FILE -- this just passes it.
#
# Two cases need it. The compose stack mounts the host registry over the baked
# one, so a build-time bake is invisible at runtime and a fresh clone would
# otherwise start with no model at all. And on a host with no persistent disk,
# a registry that ends up empty can now be repaired offline rather than
# depending on GitHub's CDN, which 502s requests from shared cloud egress
# addresses -- the reason the bundle was committed in the first place.
BUNDLE_DIR="${MODEL_BUNDLE_DIR:-/app/ml-service/models}"
if [ -z "$MODEL_BUNDLE_FILE" ]; then
    MODEL_BUNDLE_FILE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.tar.gz' -print -quit 2>/dev/null)"
fi

have_models() {
    # A glob that matches nothing exits non-zero, hence find rather than ls.
    [ -n "$(find "$REGISTRY" -maxdepth 1 -name 'rf_*.pkl' -print -quit 2>/dev/null)" ]
}

# One implementation, used by the Dockerfile too, so build-time and runtime
# behaviour cannot drift apart. See fetch-models.py.
fetch_bundle() {
    REGISTRY_DIR="$REGISTRY"     MODEL_BUNDLE_FILE="$MODEL_BUNDLE_FILE"     MODEL_BUNDLE_URL="$MODEL_BUNDLE_URL"     MODEL_BUNDLE_SHA256="$MODEL_BUNDLE_SHA256"     MODEL_FETCH_TIMEOUT="$FETCH_TIMEOUT"     MODEL_FETCH_RETRIES="$FETCH_RETRIES"     python /app/ml-service/fetch-models.py
}

if have_models; then
    echo "[ENTRYPOINT] registry already has model artifacts — no download"
elif [ -z "$MODEL_BUNDLE_FILE" ] && [ -z "$MODEL_BUNDLE_URL" ]; then
    echo "[ENTRYPOINT] registry is empty, no bundle in $BUNDLE_DIR and"
    echo "[ENTRYPOINT] MODEL_BUNDLE_URL is unset."
    echo "[ENTRYPOINT] Starting without a predictor — POST /train to create one."
else
    if [ -n "$MODEL_BUNDLE_FILE" ]; then
        echo "[ENTRYPOINT] registry is empty — extracting $MODEL_BUNDLE_FILE"
    else
        echo "[ENTRYPOINT] registry is empty — fetching model bundle"
    fi

    # Outside `set -e` on purpose: a failed fetch must not kill the container.
    if fetch_bundle; then
        echo "[ENTRYPOINT] model bundle ready"
    else
        echo "[ENTRYPOINT] ---------------------------------------------------"
        echo "[ENTRYPOINT] Could not obtain the model bundle. Starting anyway."
        echo "[ENTRYPOINT] /health will report model_loaded=false and predictions"
        echo "[ENTRYPOINT] will fail until a model is present. Restart this"
        echo "[ENTRYPOINT] service to retry the download."
        echo "[ENTRYPOINT] ---------------------------------------------------"
    fi
fi

# PORT first: the platform sets it and has final say. ML_SERVICE_PORT is
# what docker-compose.yml declares, and it was previously read by nobody,
# so setting it moved nothing and left no clue why.
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-${ML_SERVICE_PORT:-8000}}"
