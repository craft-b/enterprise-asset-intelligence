FROM python:3.12-slim

WORKDIR /app/ml-service

# System deps needed by some ML packages (scipy, numba, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (pinned for reproducibility)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML service source
COPY . .

# ---- Bake the champion model into the image ---------------------------------
# The registry pickles are not in git (OPS-2), and free hosting tiers have no
# persistent disk, so without this every cold start begins with no model.
#
# Fetching at build time rather than only at startup matters twice. Build
# infrastructure reaches the network from different addresses than the running
# service -- GitHub's CDN served repeated 502s to the container's egress IP
# while the same URL fetched fine elsewhere. And an image that already holds
# the artifacts starts instantly, with no download on the critical path of a
# cold start a visitor is waiting through.
#
# This step FAILS THE BUILD when it cannot get the bundle, and that is a
# correction rather than a preference. It first ended in
#     || echo 'not baked in; the entrypoint will retry'
# so a failed fetch still exited 0 -- which Docker caches as a successful
# layer. Every later rebuild then reused the empty layer without retrying, and
# the build looked clean while shipping no model, permanently. A failing build
# is visible, is one click to retry, and never caches. fetch-models.py already
# retries three times with backoff, so a transient CDN error does not reach
# here.
#
# Build with --build-arg SKIP_MODEL_BAKE=1 to opt out (offline builds, or when
# a mounted disk supplies the registry). The entrypoint still fetches at
# startup when the registry is empty.
ARG MODEL_BUNDLE_URL="https://github.com/craft-b/enterprise-asset-intelligence/releases/download/models-v1.17/eai-models-v1.17.tar.gz"
ARG MODEL_BUNDLE_SHA256="2ac9c74f87ce7610229fdb9c31fbd9fef1a9c5439d0337d8615fc09cc3900ed4"
ARG SKIP_MODEL_BAKE=""
RUN if [ -n "$SKIP_MODEL_BAKE" ]; then \
        echo '[BUILD] SKIP_MODEL_BAKE set - entrypoint will fetch at startup'; \
    else \
        MODEL_BUNDLE_URL="$MODEL_BUNDLE_URL" \
        MODEL_BUNDLE_SHA256="$MODEL_BUNDLE_SHA256" \
        REGISTRY_DIR=/app/ml-service/registry \
        python fetch-models.py; \
    fi

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8

EXPOSE 8000

# Fetches the champion artifacts when the registry is empty (no persistent
# disk), then execs uvicorn. See the script for MODEL_BUNDLE_URL.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
