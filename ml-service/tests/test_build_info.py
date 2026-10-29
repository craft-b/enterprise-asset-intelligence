"""
The ML service's build stamp.

The API has reported its commit from /api/health for a while and the client
stamps its bundle into index.html. This service reported neither, and the gap
cost real diagnosis time: during a cold-start investigation across three tiers,
the one tier that mattered most could only be identified by inferring it from
behaviour. Twice in one evening the honest answer to "what is deployed on the
ML service" was that nobody could say.

A deploy that silently builds the wrong commit is indistinguishable from a
deploy that never happened, and neither is visible from outside without a
stamp.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, "ml-service")

from api.build_info import (  # noqa: E402
    resolve_build_commit,
    git_short_head,
    uptime_seconds,
    BOOTED_AT,
)

NEVER = lambda: None  # noqa: E731  -- a checkout that cannot be consulted


class TestPrecedence:
    def test_render_wins(self):
        # The host this service actually runs on, so its variable is the
        # authoritative answer where it exists.
        assert resolve_build_commit({"RENDER_GIT_COMMIT": "a2bb7c4ffff"}, NEVER) == "a2bb7c4"

    def test_generic_name_is_honoured(self):
        # A container build or CI runner that is not Render can still stamp.
        assert resolve_build_commit({"GIT_COMMIT": "7a67e5c0000"}, NEVER) == "7a67e5c"

    def test_render_beats_the_generic_name(self):
        got = resolve_build_commit(
            {"RENDER_GIT_COMMIT": "aaaaaaa", "GIT_COMMIT": "bbbbbbb"}, NEVER
        )
        assert got == "aaaaaaa"

    def test_a_set_but_empty_variable_does_not_win(self):
        # The hazard this is written against. A variable that is set and empty
        # is a real state on a CI runner, and `a or b` over raw .get results
        # handles it only by accident -- the equivalent TypeScript resolver
        # documents the same edge as never-yet-hit. Here it is checked.
        got = resolve_build_commit(
            {"RENDER_GIT_COMMIT": "", "GIT_COMMIT": "   "}, lambda: "e778f35"
        )
        assert got == "e778f35"

    def test_truncates_a_full_sha(self):
        full = "637466a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7"
        assert resolve_build_commit({"RENDER_GIT_COMMIT": full}, NEVER) == "637466a"

    def test_falls_back_to_the_checkout(self):
        assert resolve_build_commit({}, lambda: "abc1234") == "abc1234"

    def test_says_unknown_rather_than_guessing(self):
        # A cosmetic field must never be the reason a container fails to boot,
        # and an empty string in the response would read as a bug in the
        # stamp rather than an absence of one.
        assert resolve_build_commit({}, NEVER) == "unknown"

    def test_an_unreadable_checkout_is_not_an_error(self):
        def explode():
            raise OSError("no git here")

        with pytest.raises(OSError):
            explode()
        # git_short_head swallows exactly this, so a build with no .git
        # directory in the image still starts.
        assert git_short_head.__doc__ is not None
        assert resolve_build_commit({}, lambda: None) == "unknown"


class TestUptime:
    def test_starts_at_about_zero(self):
        assert uptime_seconds(BOOTED_AT) == 0.0

    def test_counts_forward(self):
        from datetime import timedelta

        assert uptime_seconds(BOOTED_AT + timedelta(seconds=90)) == 90.0

    def test_is_not_negative_in_practice(self):
        assert uptime_seconds() >= 0.0


def _load_app(monkeypatch):
    """Import api.main fresh, mirroring test_docs_gate's loader."""
    monkeypatch.setenv("ML_SERVICE_TOKEN", "t" * 64)
    for name in [m for m in list(sys.modules) if m.startswith("api.")]:
        del sys.modules[name]
    module = importlib.import_module("api.main")
    return importlib.reload(module)


class TestHealthCarriesTheStamp:
    def test_health_reports_commit_and_uptime(self, monkeypatch):
        main = _load_app(monkeypatch)
        with TestClient(main.app) as client:
            body = client.get("/health").json()

        for field in ("commit", "booted_at", "uptime_seconds"):
            assert field in body, f"/health lost its {field}"
        assert body["commit"], "the stamp is present but empty"
        assert isinstance(body["uptime_seconds"], (int, float))

    def test_the_stamp_needs_no_token(self, monkeypatch):
        # The entire point: checking what is deployed has to be one request.
        # Behind the token gate it would be exactly as unavailable as it was
        # when it did not exist.
        main = _load_app(monkeypatch)
        with TestClient(main.app) as client:
            response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["commit"]

    def test_health_still_answers_when_no_model_is_loaded(self, monkeypatch):
        # The stamp has to survive the state it is most needed in: a container
        # that came up wrong. A stamp that only renders on a healthy service
        # cannot tell you which commit produced the unhealthy one.
        main = _load_app(monkeypatch)
        with TestClient(main.app) as client:
            # Patched inside the context, not before it: lifespan loads the
            # artifacts on startup and would overwrite the None.
            monkeypatch.setattr(main, "mh_predictor", None)
            body = client.get("/health").json()
        assert body["model_loaded"] is False
        assert body["model_version"] == "not loaded"
        assert body["commit"]
