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
# One variable for the download path: the shell and the Python child must
# agree on it, and hardcoding /tmp in both silently diverges wherever the
# two resolve it differently.
BUNDLE_TMP="${TMPDIR:-/tmp}/eai-models.tar.gz"

have_models() {
    # A glob that matches nothing exits non-zero, hence find rather than ls.
    [ -n "$(find "$REGISTRY" -maxdepth 1 -name 'rf_*.pkl' -print -quit 2>/dev/null)" ]
}

fetch_bundle() {
    mkdir -p "$REGISTRY"

    # python rather than curl: the slim base image has no curl, and this avoids
    # another apt layer. A real User-Agent is sent because some CDNs treat the
    # default Python-urllib string as a bot.
    MODEL_BUNDLE_URL="$MODEL_BUNDLE_URL" \
    FETCH_TIMEOUT="$FETCH_TIMEOUT" \
    FETCH_RETRIES="$FETCH_RETRIES" \
    BUNDLE_TMP="$BUNDLE_TMP" \
    python - <<'PY'
import os, sys, time, urllib.request, urllib.error

url      = os.environ["MODEL_BUNDLE_URL"]
timeout  = float(os.environ["FETCH_TIMEOUT"])
attempts = int(os.environ["FETCH_RETRIES"])
dest     = os.environ["BUNDLE_TMP"]

if not url.lower().startswith("https://"):
    print(f"[ENTRYPOINT] refusing non-HTTPS MODEL_BUNDLE_URL: {url}", flush=True)
    sys.exit(2)

request = urllib.request.Request(url, headers={
    "User-Agent": "eai-ml-service/1.0 (+https://github.com/craft-b/enterprise-asset-intelligence)",
    "Accept": "application/octet-stream",
})

for attempt in range(1, attempts + 1):
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, \
             open(dest, "wb") as out:
            while chunk := response.read(1 << 16):
                out.write(chunk)
        size = os.path.getsize(dest)
        print(f"[ENTRYPOINT] downloaded {size} bytes in {time.time()-started:.1f}s", flush=True)
        sys.exit(0)
    except Exception as exc:
        detail = getattr(exc, "code", None) or type(exc).__name__
        print(f"[ENTRYPOINT] attempt {attempt}/{attempts} failed after "
              f"{time.time()-started:.1f}s: {detail}", flush=True)
        if attempt < attempts:
            time.sleep(2 * attempt)   # brief backoff; the port scan is waiting

sys.exit(1)
PY
}

if have_models; then
    echo "[ENTRYPOINT] registry already has model artifacts — no download"
elif [ -z "$MODEL_BUNDLE_URL" ]; then
    echo "[ENTRYPOINT] registry is empty and MODEL_BUNDLE_URL is unset."
    echo "[ENTRYPOINT] Starting without a predictor — POST /train to create one."
else
    echo "[ENTRYPOINT] registry is empty — fetching model bundle"

    # Deliberately outside `set -e`: a failed fetch must not kill the container.
    if fetch_bundle; then
        ok=1
    else
        ok=0
    fi

    if [ "$ok" = "1" ] && [ -n "$MODEL_BUNDLE_SHA256" ]; then
        # The archive holds pickles, and unpickling executes code. Pin the digest
        # so a swapped release asset cannot turn a restart into code execution.
        if echo "${MODEL_BUNDLE_SHA256}  ${BUNDLE_TMP}" | sha256sum -c - >/dev/null 2>&1; then
            echo "[ENTRYPOINT] checksum verified"
        else
            echo "[ENTRYPOINT] checksum MISMATCH — refusing to extract"
            rm -f "$BUNDLE_TMP"
            ok=0
        fi
    elif [ "$ok" = "1" ]; then
        echo "[ENTRYPOINT] WARNING: MODEL_BUNDLE_SHA256 unset — extracting an"
        echo "[ENTRYPOINT] unverified archive of pickles. Set it."
    fi

    if [ "$ok" = "1" ]; then
        tar -xzf "$BUNDLE_TMP" -C "$REGISTRY"
        rm -f "$BUNDLE_TMP"
        echo "[ENTRYPOINT] extracted $(find "$REGISTRY" -maxdepth 1 -name 'rf_*.pkl' | wc -l) model files"
    else
        echo "[ENTRYPOINT] ---------------------------------------------------"
        echo "[ENTRYPOINT] Could not obtain the model bundle. Starting anyway."
        echo "[ENTRYPOINT] /health will report model_loaded=false and predictions"
        echo "[ENTRYPOINT] will fail until a model is present. Restart this"
        echo "[ENTRYPOINT] service to retry the download."
        echo "[ENTRYPOINT] ---------------------------------------------------"
    fi
fi

exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
