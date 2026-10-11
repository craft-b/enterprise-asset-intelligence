"""
Tests for engine.db_url -- how the Python side reaches MySQL.

These matter because the failure they guard against is silent until deploy:
pymysql does not understand mysql2's `ssl` parameter, and a managed host that
requires TLS rejects a connection that does not ask for it. Both show up only
against the real host, so the string handling is pinned here.
"""

import pytest

from engine.db_url import sqlalchemy_url

TIDB_HOST = "gateway01.us-east-1.prod.aws.tidbcloud.com"


@pytest.fixture
def no_ca_anywhere(monkeypatch):
    """
    Force the last-resort path: no host bundle and no certifi.

    Clearing DB_SSL_CA alone is no longer enough -- certifi is the backstop, so
    a CA is normally always found. Only with both gone do the verify flags
    appear, and these tests are about that branch.
    """
    monkeypatch.setattr("engine.db_url._CA_BUNDLE_CANDIDATES", ())
    monkeypatch.setitem(__import__("sys").modules, "certifi", None)
    return monkeypatch


class TestDatabaseUrlPreferred:
    def test_database_url_wins_over_db_vars(self):
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@dsn-host:3306/from_url",
            "DB_HOST": "ignored-host",
            "DB_NAME": "ignored_db",
        })
        assert "dsn-host" in url
        assert "from_url" in url
        assert "ignored" not in url

    def test_scheme_is_rewritten_for_sqlalchemy(self):
        # Node's DSN says mysql://; SQLAlchemy needs the driver named.
        url = sqlalchemy_url({"DATABASE_URL": "mysql://u:p@h:3306/d"})
        assert url.startswith("mysql+pymysql://")

    def test_already_qualified_scheme_is_left_alone(self):
        url = sqlalchemy_url({"DATABASE_URL": "mysql+pymysql://u:p@h:3306/d"})
        assert url.startswith("mysql+pymysql://")
        assert "mysql+pymysql+pymysql" not in url

    def test_falls_back_to_db_vars(self):
        url = sqlalchemy_url({
            "DB_USER": "svc", "DB_PASSWORD": "pw",
            "DB_HOST": "db.internal", "DB_PORT": "3307", "DB_NAME": "eai",
        })
        assert url == "mysql+pymysql://svc:pw@db.internal:3307/eai"

    def test_blank_database_url_is_not_used(self):
        url = sqlalchemy_url({"DATABASE_URL": "   ", "DB_HOST": "fallback"})
        assert "fallback" in url


class TestTlsTranslation:
    def test_mysql2_ssl_json_becomes_pymysql_flags(self, no_ca_anywhere):
        # The exact spelling mysql2 needs for TiDB, as the Node service uses it.
        url = sqlalchemy_url({
            "DATABASE_URL": f'mysql://u:p@{TIDB_HOST}:4000/eai'
                            '?ssl={"minVersion":"TLSv1.2","rejectUnauthorized":true}',
            "DB_SSL_CA": "",  # force the no-CA fallback
        })
        assert "ssl_verify_cert=true" in url
        assert "ssl_verify_identity=true" in url

    def test_mysql2_ssl_parameter_never_reaches_pymysql(self):
        # Passing it through raises TypeError: unexpected keyword argument 'ssl'
        url = sqlalchemy_url({
            "DATABASE_URL": 'mysql://u:p@h:4000/d?ssl={"rejectUnauthorized":true}'
        })
        assert "ssl=" not in url
        assert "rejectUnauthorized" not in url
        assert "minVersion" not in url

    def test_db_ssl_env_var_enables_tls_on_the_db_vars_path(self, no_ca_anywhere):
        url = sqlalchemy_url({
            "DB_HOST": TIDB_HOST, "DB_PORT": "4000",
            "DB_USER": "u", "DB_PASSWORD": "p", "DB_NAME": "eai",
            "DB_SSL": "true", "DB_SSL_CA": "",
        })
        assert "ssl_verify_cert=true" in url

    @pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", "require"])
    def test_db_ssl_accepts_common_spellings(self, value, no_ca_anywhere):
        url = sqlalchemy_url({"DB_HOST": "h", "DB_SSL": value, "DB_SSL_CA": ""})
        assert "ssl_verify_cert=true" in url

    @pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
    def test_db_ssl_off_means_no_tls(self, value):
        url = sqlalchemy_url({"DB_HOST": "h", "DB_SSL": value, "DB_SSL_CA": ""})
        assert "ssl_verify" not in url
        assert "ssl_ca" not in url

    def test_no_tls_requested_means_no_tls_params(self):
        url = sqlalchemy_url({"DATABASE_URL": "mysql://u:p@localhost:3306/d"})
        assert "ssl" not in url

    def test_explicit_ssl_mode_disabled_is_respected(self):
        url = sqlalchemy_url({"DATABASE_URL": "mysql://u:p@h:3306/d?ssl_mode=DISABLED"})
        assert "ssl_verify" not in url

    def test_tls_params_are_not_duplicated(self, no_ca_anywhere):
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@h:4000/d?ssl_verify_cert=true",
            "DB_SSL": "true", "DB_SSL_CA": "",
        })
        assert url.count("ssl_verify_cert") == 1


class TestCredentialSafety:
    def test_percent_encoded_password_is_preserved_exactly(self):
        # Re-encoding here is how credentials silently break. '%40' is '@'.
        url = sqlalchemy_url({"DATABASE_URL": "mysql://user:p%40ss%2Fword@h:3306/d"})
        assert "p%40ss%2Fword" in url
        assert "p@ss" not in url

    def test_unrelated_query_parameters_survive(self):
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@h:3306/d?charset=utf8mb4&connect_timeout=10"
        })
        assert "charset=utf8mb4" in url
        assert "connect_timeout=10" in url


class TestCaBundle:
    """
    ssl_verify_identity only takes effect when pymysql is also given a CA, so
    the bundle path has to be emitted alongside it.
    """

    def test_explicit_ca_is_used(self, tmp_path):
        from urllib.parse import parse_qs, urlsplit

        ca = tmp_path / "ca.pem"
        ca.write_text("x")
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@h:4000/d?ssl_mode=REQUIRED",
            "DB_SSL_CA": str(ca),
        })
        params = parse_qs(urlsplit(url).query)
        assert params["ssl_ca"] == [str(ca)]
        # Deliberately absent: next to a CA they disable hostname checking.
        assert "ssl_verify_cert" not in params
        assert "ssl_verify_identity" not in params

    def test_ca_from_dsn_is_not_duplicated(self):
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@h:4000/d?ssl_ca=%2Fcustom%2Fca.pem",
            "DB_SSL": "true",
        })
        assert url.count("ssl_ca") == 1
        assert "custom" in url

    def test_no_ca_emitted_when_tls_not_requested(self):
        url = sqlalchemy_url({"DB_HOST": "localhost"})
        assert "ssl_ca" not in url

    def test_tls_still_requested_when_nothing_can_supply_a_ca(self, no_ca_anywhere):
        # Chain verification stays on even with no CA to point at. Weaker than
        # the certifi path (no hostname check) but better than plaintext.
        url = sqlalchemy_url({
            "DATABASE_URL": "mysql://u:p@h:4000/d?ssl_mode=REQUIRED",
            "DB_SSL_CA": "",
        })
        assert "ssl_verify_cert=true" in url
        assert "ssl_ca" not in url


class TestRealTlsContext:
    """
    End-to-end through the real stack -- URL, SQLAlchemy dialect, pymysql --
    down to the SSLContext, without connecting to anything.

    This is the test that matters. The unit tests above only check which query
    parameters are emitted; whether those parameters produce a *verified*
    connection depends on how SQLAlchemy folds them and how pymysql rebuilds
    them, which is where the surprise lives.
    """

    @staticmethod
    def _context_for(url):
        from sqlalchemy import create_engine
        import pymysql

        engine = create_engine(url)
        _, kwargs = engine.dialect.create_connect_args(engine.url)
        conn = pymysql.connections.Connection(defer_connect=True, **dict(kwargs))
        return conn

    def test_tls_is_fully_verified_when_a_ca_is_available(self, tmp_path):
        import ssl as ssl_mod
        import certifi

        url = sqlalchemy_url({
            "DATABASE_URL": f'mysql://u:p@{TIDB_HOST}:4000/eai'
                            '?ssl={"minVersion":"TLSv1.2","rejectUnauthorized":true}',
            "DB_SSL_CA": certifi.where(),
        })
        conn = self._context_for(url)

        assert conn.ssl is True
        assert conn.ctx.verify_mode == ssl_mod.CERT_REQUIRED
        # The whole point: a cert valid for some other host must not pass.
        assert conn.ctx.check_hostname is True

    def test_no_tls_context_for_a_plain_local_dsn(self):
        url = sqlalchemy_url({"DATABASE_URL": "mysql://root:@localhost:3306/asset_inventory"})
        conn = self._context_for(url)
        assert not conn.ssl

    def test_fallback_without_a_ca_still_verifies_the_chain(self, monkeypatch):
        import ssl as ssl_mod

        monkeypatch.setattr("engine.db_url._CA_BUNDLE_CANDIDATES", ())
        url = sqlalchemy_url({
            "DATABASE_URL": f"mysql://u:p@{TIDB_HOST}:4000/eai?ssl_mode=REQUIRED",
            "DB_SSL_CA": "",
        })
        conn = self._context_for(url)

        assert conn.ssl is True
        assert conn.ctx.verify_mode == ssl_mod.CERT_REQUIRED


class TestCaFallbackOrder:
    """
    The fallback matters: with no CA at all, pymysql builds a context from
    Python's default trust store, which was measured offering an EXPIRED chain
    for TiDB Cloud while Node connected to the same host fine. certifi is the
    backstop, so "no bundle" must not mean "no CA".
    """

    def test_explicit_ca_beats_everything(self, tmp_path):
        ca = tmp_path / "ca.pem"
        ca.write_text("x")
        url = sqlalchemy_url({"DB_HOST": "h", "DB_SSL": "true", "DB_SSL_CA": str(ca)})
        assert str(ca).replace("\\", "%5C") in url.replace("\\", "%5C") or "ssl_ca" in url

    def test_falls_back_to_certifi_when_the_host_has_no_bundle(self, monkeypatch):
        import certifi
        from urllib.parse import parse_qs, urlsplit

        # Simulate a host with no Unix CA bundle path — e.g. Windows.
        monkeypatch.setattr("engine.db_url._CA_BUNDLE_CANDIDATES", ())

        url = sqlalchemy_url({"DB_HOST": "h", "DB_SSL": "true"})
        params = parse_qs(urlsplit(url).query)

        assert params["ssl_ca"] == [certifi.where()]
        # With a CA present the verify flags must stay off; together they
        # disable hostname checking.
        assert "ssl_verify_cert" not in params

    def test_a_ca_is_always_produced_when_tls_is_wanted(self, monkeypatch):
        from urllib.parse import parse_qs, urlsplit

        monkeypatch.setattr("engine.db_url._CA_BUNDLE_CANDIDATES", ())
        url = sqlalchemy_url({"DATABASE_URL": 'mysql://u:p@h:4000/d?ssl={"rejectUnauthorized":true}'})
        params = parse_qs(urlsplit(url).query)

        assert "ssl_ca" in params, "TLS requested but no CA pinned — the failing case"

    def test_no_ca_when_tls_is_not_wanted(self, monkeypatch):
        monkeypatch.setattr("engine.db_url._CA_BUNDLE_CANDIDATES", ())
        url = sqlalchemy_url({"DATABASE_URL": "mysql://u:p@localhost:3306/d"})
        assert "ssl_ca" not in url
