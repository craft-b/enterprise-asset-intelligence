"""
ml-service/engine/db_url.py

One place that decides how the Python side reaches MySQL.

Two services talk to the same database with two drivers: Node reads
DATABASE_URL (mysql2), Python read the individual DB_* vars (SQLAlchemy +
pymysql). Keeping both in sync was left to the operator, and the README had to
warn about it. Worse, the DB_* path had no way to ask for TLS, so it could not
reach a managed host like TiDB Cloud or PlanetScale that requires it.

So DATABASE_URL wins when it is set -- one DSN for both services -- and the
DB_* vars remain as a fallback for a local server. The two drivers spell TLS
differently and neither understands the other's spelling, so that is
translated here rather than at each call site:

    mysql2:   ?ssl={"minVersion":"TLSv1.2","rejectUnauthorized":true}
    pymysql:  ?ssl_verify_cert=true&ssl_verify_identity=true

Passing mysql2's `ssl` parameter through to pymysql would raise
TypeError: unexpected keyword argument 'ssl'.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

#: SQLAlchemy driver this service uses.
_DRIVER = "mysql+pymysql"

#: Fallback TLS request used only when no CA bundle can be found. Verifies the
#: certificate chain but NOT the hostname -- see the note below.
_TLS_PARAMS = {"ssl_verify_cert": "true", "ssl_verify_identity": "true"}

#: Where Debian/Alpine/RedHat keep the system CA bundle.
#:
#: Pointing at a CA is what makes hostname checking work, and -- measured
#: against pymysql 1.1 -- `ssl_ca` ALONE is strictly stronger than the obvious
#: full set:
#:
#:   ssl_ca only                -> verify_mode=CERT_REQUIRED, check_hostname=True
#:   ssl_ca + ssl_verify_*      -> verify_mode=CERT_REQUIRED, check_hostname=False
#:   ssl_verify_* only          -> verify_mode=CERT_REQUIRED, check_hostname=False
#:
#: The reason is that SQLAlchemy folds ssl_ca into an `ssl` dict, and pymysql
#: then REBUILDS that dict from its own ssl_* arguments whenever any of them is
#: set -- dropping the CA on the way, which leaves hasnoca true and hostname
#: checking off. So the verify flags are emitted only when there is no CA to
#: point at; with a CA they would silently weaken the connection.
_CA_BUNDLE_CANDIDATES = (
    "/etc/ssl/certs/ca-certificates.crt",      # Debian, Ubuntu, Alpine
    "/etc/pki/tls/certs/ca-bundle.crt",        # RHEL, Fedora
    "/etc/ssl/ca-bundle.pem",                  # SUSE
    "/etc/ssl/cert.pem",                       # Alpine, macOS
)


def _ca_bundle(env) -> str | None:
    """Path to a CA bundle for hostname verification, or None if none is found."""
    explicit = (env.get("DB_SSL_CA") or "").strip()
    if explicit:
        return explicit
    for path in _CA_BUNDLE_CANDIDATES:
        if os.path.isfile(path):
            return path
    return None

#: mysql2-flavoured TLS keys that must not reach pymysql.
_FOREIGN_TLS_KEYS = {"ssl", "sslaccept", "ssl_mode"}


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on", "require", "required"}


def sqlalchemy_url(env: dict | None = None) -> str:
    """
    Build the SQLAlchemy URL for this service.

    Prefers DATABASE_URL, falling back to DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/
    DB_NAME. TLS is requested when the source DSN asked for it in either
    driver's spelling, or when DB_SSL is truthy.
    """
    env = os.environ if env is None else env

    raw = (env.get("DATABASE_URL") or "").strip()
    if raw:
        return _from_dsn(raw, force_tls=_truthy(env.get("DB_SSL")), env=env)

    user = env.get("DB_USER", "root")
    password = env.get("DB_PASSWORD", "")
    host = env.get("DB_HOST", "localhost")
    port = env.get("DB_PORT", "3306")
    name = env.get("DB_NAME", "asset_inventory")

    dsn = f"{_DRIVER}://{user}:{password}@{host}:{port}/{name}"
    return _from_dsn(dsn, force_tls=_truthy(env.get("DB_SSL")), env=env)


def _from_dsn(dsn: str, force_tls: bool = False, env: dict | None = None) -> str:
    """Normalise any accepted DSN spelling into a pymysql SQLAlchemy URL."""
    parts = urlsplit(dsn)

    # netloc is left exactly as given so a percent-encoded password is never
    # decoded and re-encoded (which is where credentials get corrupted).
    scheme = parts.scheme or "mysql"
    if scheme in ("mysql", "mysql2"):
        scheme = _DRIVER

    params = parse_qsl(parts.query, keep_blank_values=True)

    wants_tls = force_tls
    kept: list[tuple[str, str]] = []
    for key, value in params:
        lowered = key.lower()
        if lowered in _FOREIGN_TLS_KEYS:
            # Presence of mysql2's ssl parameter is itself the request for TLS.
            # `ssl_mode=DISABLED` is the one spelling that means the opposite.
            if not (lowered == "ssl_mode" and value.upper() in {"DISABLED", "OFF"}):
                wants_tls = True
            continue
        if lowered in _TLS_PARAMS:
            wants_tls = wants_tls or _truthy(value)
            continue
        kept.append((key, value))

    if wants_tls:
        has_ca = any(k.lower() == "ssl_ca" for k, _ in kept)
        if not has_ca:
            ca = _ca_bundle(os.environ if env is None else env)
            if ca:
                kept.append(("ssl_ca", ca))
                has_ca = True
        # Only without a CA -- alongside one they turn hostname checking off.
        if not has_ca:
            kept.extend(_TLS_PARAMS.items())

    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))
