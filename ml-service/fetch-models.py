#!/usr/bin/env python3
"""
ml-service/fetch-models.py

Download the champion model bundle into the registry, verify it, extract it.

Used twice, which is the point:

  * at image BUILD time, so the artifacts ship inside the image and a cold
    start has a model instantly with no network call;
  * at CONTAINER START, as a fallback, for the case where the build could not
    reach the host (the entrypoint skips it when the registry already has
    models, so the baked-in copy normally wins).

Failure is never fatal here. The caller decides: the Dockerfile warns and
carries on so a transient CDN error does not break the build, and the
entrypoint starts the service anyway so the operator gets a reachable service
reporting model_loaded=false rather than a crash loop.

Why the retries exist at all: GitHub serves release assets through a CDN that
intermittently 502s requests from shared cloud egress IPs. The same URL that
fetches in under two seconds from a laptop failed repeatedly from a Render
container, which is what sent the model artifacts into the image in the first
place.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tarfile
import tempfile
import time
import urllib.request

USER_AGENT = (
    "eai-ml-service/1.0 "
    "(+https://github.com/craft-b/enterprise-asset-intelligence)"
)


def log(message: str) -> None:
    print(f"[FETCH-MODELS] {message}", flush=True)


def download(url: str, dest: str, timeout: float, attempts: int) -> bool:
    if not url.lower().startswith("https://"):
        log(f"refusing non-HTTPS URL: {url}")
        return False

    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"}
    )

    for attempt in range(1, attempts + 1):
        started = time.time()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response, \
                    open(dest, "wb") as out:
                while chunk := response.read(1 << 16):
                    out.write(chunk)
            log(f"downloaded {os.path.getsize(dest)} bytes in {time.time()-started:.1f}s")
            return True
        except Exception as exc:  # noqa: BLE001 - every failure is "try again"
            detail = getattr(exc, "code", None) or type(exc).__name__
            log(f"attempt {attempt}/{attempts} failed after "
                f"{time.time()-started:.1f}s: {detail}")
            if attempt < attempts:
                time.sleep(2 * attempt)
    return False


def digest_of(path: str) -> str:
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            sha.update(chunk)
    return sha.hexdigest()


def safe_extract(archive: str, target: str) -> int:
    """
    Extract a flat archive, refusing any member that would escape the target.

    The bundle is built flat on purpose. A member named ../../etc/something, or
    an absolute path, or a symlink, would otherwise write outside the registry
    -- and this archive is fetched over the network, so it is exactly the input
    that should not be trusted to be well-formed.
    """
    extracted = 0
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not (member.isfile() or member.isdir()):
                log(f"skipping non-regular member: {member.name}")
                continue
            if member.name.startswith("/") or ".." in member.name.replace("\\", "/").split("/"):
                log(f"REFUSING path-traversing member: {member.name}")
                return -1
            # filter="data" is tarfile's own hardening: it strips absolute
            # paths, rejects traversal, and drops links and device nodes. The
            # explicit checks above stay because they name the offending member
            # in the log; this catches whatever they did not think of.
            try:
                tar.extract(member, target, filter="data")
            except TypeError:
                # Python < 3.11.4 has no filter argument.
                tar.extract(member, target)
            extracted += member.isfile()
    return extracted


def main() -> int:
    url = (os.environ.get("MODEL_BUNDLE_URL") or "").strip()
    expected = (os.environ.get("MODEL_BUNDLE_SHA256") or "").strip().lower()
    registry = os.environ.get("REGISTRY_DIR") or "/app/ml-service/registry"
    timeout = float(os.environ.get("MODEL_FETCH_TIMEOUT") or 30)
    attempts = int(os.environ.get("MODEL_FETCH_RETRIES") or 3)

    if not url:
        log("MODEL_BUNDLE_URL is unset - nothing to fetch")
        return 1

    os.makedirs(registry, exist_ok=True)
    handle, archive = tempfile.mkstemp(suffix=".tar.gz")
    os.close(handle)

    try:
        if not download(url, archive, timeout, attempts):
            return 1

        if expected:
            actual = digest_of(archive)
            if actual != expected:
                log("checksum MISMATCH - refusing to extract")
                log(f"  expected {expected}")
                log(f"  actual   {actual}")
                return 1
            log("checksum verified")
        else:
            log("WARNING: MODEL_BUNDLE_SHA256 unset - extracting an unverified")
            log("WARNING: archive of pickles, which execute code when loaded")

        count = safe_extract(archive, registry)
        if count < 0:
            return 1

        models = len([f for f in os.listdir(registry)
                      if f.startswith("rf_") and f.endswith(".pkl")])
        log(f"extracted {count} files; registry now holds {models} models")
        return 0 if models else 1
    finally:
        try:
            os.unlink(archive)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
