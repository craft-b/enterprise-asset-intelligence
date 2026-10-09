"""
The API docs gate (ENABLE_API_DOCS).

Swagger UI, ReDoc and the OpenAPI schema must sit outside the service-token
check to work at all -- the browser fetches openapi.json with no token -- so if
they are served at all they are served publicly. On a host where the ML service
has no private networking, that publishes every path, parameter and schema of a
service whose endpoints are otherwise deliberately gated.

main.py reads the flag at import time, so each case re-imports the module under
a patched environment rather than trying to mutate a built app.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient

DOC_PATHS = ["/docs", "/redoc", "/openapi.json"]


def _load_app(monkeypatch, enable_api_docs):
    """Import api.main fresh with ENABLE_API_DOCS set (or removed)."""
    if enable_api_docs is None:
        monkeypatch.delenv("ENABLE_API_DOCS", raising=False)
    else:
        monkeypatch.setenv("ENABLE_API_DOCS", enable_api_docs)

    # A token must be present or the auth middleware short-circuits entirely
    # and every path would answer, which would make these assertions lie.
    monkeypatch.setenv("ML_SERVICE_TOKEN", "t" * 64)

    for name in [m for m in list(sys.modules) if m.startswith("api.")]:
        del sys.modules[name]
    module = importlib.import_module("api.main")
    return importlib.reload(module)


TOKEN = "t" * 64


class TestDocsDisabledByDefault:
    @pytest.mark.parametrize("flag", [None, "", "false", "0", "no", "off"])
    def test_doc_paths_serve_nothing(self, monkeypatch, flag):
        main = _load_app(monkeypatch, flag)
        assert main.DOCS_ENABLED is False

        with TestClient(main.app) as client:
            for path in DOC_PATHS:
                response = client.get(path)
                # The token middleware answers before the router, so this is a
                # 401 rather than a 404. What matters is that no doc content is
                # returned -- see the next test for proof the route is gone.
                assert response.status_code != 200, f"{path} served content"
                assert "swagger" not in response.text.lower()
                assert "openapi" not in response.text.lower()

    @pytest.mark.parametrize("path", DOC_PATHS)
    def test_doc_routes_do_not_exist_even_with_a_valid_token(self, monkeypatch, path):
        # The decisive check. A 401 alone would be satisfied by a route that is
        # merely gated; this shows there is nothing behind the gate, so holding
        # the service token does not get you the API surface either.
        main = _load_app(monkeypatch, None)
        with TestClient(main.app) as client:
            response = client.get(path, headers={"X-Service-Token": TOKEN})
        assert response.status_code == 404, f"{path} -> {response.status_code}"

    def test_doc_paths_are_not_in_the_auth_exempt_set(self, monkeypatch):
        main = _load_app(monkeypatch, None)
        assert main._AUTH_EXEMPT == {"/health"}

    def test_health_still_works_without_a_token(self, monkeypatch):
        # Platform health checks cannot send the token, so this must stay open.
        main = _load_app(monkeypatch, None)
        with TestClient(main.app) as client:
            assert client.get("/health").status_code == 200

    def test_real_endpoints_still_require_the_token(self, monkeypatch):
        main = _load_app(monkeypatch, None)
        with TestClient(main.app) as client:
            assert client.post("/train").status_code == 401


class TestDocsEnabledExplicitly:
    @pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes", "on"])
    def test_doc_paths_are_served(self, monkeypatch, flag):
        main = _load_app(monkeypatch, flag)
        assert main.DOCS_ENABLED is True

        with TestClient(main.app) as client:
            for path in DOC_PATHS:
                assert client.get(path).status_code == 200, path

    def test_openapi_schema_is_reachable_for_swagger(self, monkeypatch):
        # Swagger UI is useless without it, and it carries no token.
        main = _load_app(monkeypatch, "true")
        with TestClient(main.app) as client:
            body = client.get("/openapi.json").json()
        assert "paths" in body
        assert "/train" in body["paths"]

    def test_enabling_docs_does_not_open_real_endpoints(self, monkeypatch):
        main = _load_app(monkeypatch, "true")
        with TestClient(main.app) as client:
            assert client.post("/train").status_code == 401
            assert client.post("/models/promote").status_code == 401
