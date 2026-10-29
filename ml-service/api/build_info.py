"""
Which commit built this container, and how long it has been up.

The API has reported RENDER_GIT_COMMIT from /api/health for a while, and the
client stamps its bundle into index.html. The ML service reported neither, and
the gap cost real diagnosis time twice in one evening: a cold-start defect was
being investigated across three tiers, and for the one tier that mattered most
the only way to tell what was deployed was to infer it from behaviour. Twice
the honest answer to "what is running on the ML service" was that nobody could
say.

A deploy that silently builds the wrong commit is the same failure as a deploy
that never happened, and neither is visible from outside without a stamp. So
/health carries one, unauthenticated, for the same reason the client's lives in
the <head>: checking has to be one request.

    curl -s https://<host>/health

Field names are snake_case to match the rest of this response (model_version,
model_loaded) rather than the API's camelCase. Matching the local convention
beats matching the other service's, and the names are otherwise identical, so
the two planes still answer in the same vocabulary.

Everything here is resolved once, at import. /health is the endpoint the host
uses to decide whether to keep the container alive, so it must not grow a
subprocess call -- see test_health_stays_cheap.
"""

import os
import subprocess
from datetime import datetime, timezone


def git_short_head():
    """`git rev-parse` against the checkout, or None when there isn't one."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        return out.stdout.strip() or None
    except Exception:
        # No git, no .git directory in the image, or a checkout the build user
        # cannot read. A cosmetic field must never fail a start-up.
        return None


def resolve_build_commit(env, git_short=git_short_head):
    """
    Resolve the stamp from the build environment, falling back to the checkout.

    Pure apart from the injected `git_short`, so the precedence is testable
    without a build.

    First non-empty rather than `a or b or c` over `.get` results: a variable
    that is *set but empty* is a real state on a CI runner, and the equivalent
    code on the TypeScript side documents that an empty VERCEL_GIT_COMMIT_SHA
    would otherwise win and stamp nothing. Same hazard here, so the same
    remedy -- and this one is checked by a test rather than left as a comment
    about an edge that has never been hit.
    """
    for name in ("RENDER_GIT_COMMIT", "GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA"):
        value = (env.get(name) or "").strip()
        if value:
            return value[:7]

    local = (git_short() or "").strip()[:7]
    return local or "unknown"


BUILD_COMMIT = resolve_build_commit(os.environ)

BOOTED_AT = datetime.now(timezone.utc)


def uptime_seconds(now=None):
    """Seconds since this process started, to one decimal place."""
    current = now or datetime.now(timezone.utc)
    return round((current - BOOTED_AT).total_seconds(), 1)
