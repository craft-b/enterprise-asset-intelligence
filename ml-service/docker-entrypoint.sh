#!/bin/sh
# ml-service/docker-entrypoint.sh
#
# Model artifacts are not in git (OPS-2: ~280MB of pickles were removed), and
# hosts without a persistent disk give the container an empty registry on every
# cold start. Training on boot is not an option -- the trainer needs far more
# memory than a small instance has, and it needs a seeded database.
#
# So when the registry has no model, fetch the champion bundle published as a
# release asset. Set MODEL_BUNDLE_URL to that asset's URL.
#
#   MODEL_BUNDLE_URL     https URL of a .tar.gz of registry files (flat, no dir)
#   MODEL_BUNDLE_SHA256  expected sha256 of that archive -- strongly recommended
#
# If the registry already has models (a mounted disk, or artifacts baked into
# the image) nothing is downloaded. If MODEL_BUNDLE_URL is unset the service
# still starts; it just has no predictor until /train runs.
set -e

REGISTRY="${REGISTRY_DIR:-/app/ml-service/registry}"

have_models() {
    # `ls` in a glob that matches nothing exits non-zero, hence the guard.
    [ -n "$(find "$REGISTRY" -maxdepth 1 -name 'rf_*.pkl' -print -quit 2>/dev/null)" ]
}

if have_models; then
    echo "[ENTRYPOINT] registry already has model artifacts — no download"
elif [ -z "$MODEL_BUNDLE_URL" ]; then
    echo "[ENTRYPOINT] registry is empty and MODEL_BUNDLE_URL is unset."
    echo "[ENTRYPOINT] Starting without a predictor — POST /train to create one."
else
    echo "[ENTRYPOINT] registry is empty — fetching model bundle"
    mkdir -p "$REGISTRY"

    # python rather than curl: the slim base image has no curl and this avoids
    # another apt layer.
    python - "$MODEL_BUNDLE_URL" <<'PY'
import sys, urllib.request
url = sys.argv[1]
if not url.lower().startswith("https://"):
    raise SystemExit(f"[ENTRYPOINT] refusing non-HTTPS MODEL_BUNDLE_URL: {url}")
urllib.request.urlretrieve(url, "/tmp/models.tar.gz")
PY

    # The archive holds pickles, and unpickling executes code. Pin the digest so
    # a swapped release asset cannot turn a restart into code execution.
    if [ -n "$MODEL_BUNDLE_SHA256" ]; then
        echo "${MODEL_BUNDLE_SHA256}  /tmp/models.tar.gz" | sha256sum -c - \
            || { echo "[ENTRYPOINT] checksum MISMATCH — refusing to extract"; exit 1; }
        echo "[ENTRYPOINT] checksum verified"
    else
        echo "[ENTRYPOINT] WARNING: MODEL_BUNDLE_SHA256 unset — extracting an"
        echo "[ENTRYPOINT] unverified archive of pickles. Set it."
    fi

    tar -xzf /tmp/models.tar.gz -C "$REGISTRY"
    rm -f /tmp/models.tar.gz
    echo "[ENTRYPOINT] extracted $(find "$REGISTRY" -maxdepth 1 -name 'rf_*.pkl' | wc -l) model files"
fi

exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
