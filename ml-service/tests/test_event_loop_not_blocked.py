"""
Endpoints that do blocking work must not be declared `async def`.

FastAPI runs a non-async path operation in a threadpool and an async one
directly on the event loop. Every endpoint in api/main.py was `async def`,
and every one of them except the training trigger does blocking work and
awaits nothing -- so each held the loop for its whole duration.

The batch scorer is the expensive one: scoring is a sequential Python loop
and each asset costs three SHAP TreeExplainer calls, one per horizon, so a
thirty-asset group is ninety of them plus three drift checks. While that ran,
this process could serve nothing else -- including /health.

That is what took the service down whenever a forecast was requested. The
host polls /health to decide whether the container is alive; a batch that
blocks the loop past that timeout looks dead, so the container is restarted
out from under the request. The caller sees a 502, concludes the service is
suspended, waits, retries, and the cycle repeats. The service was never
suspended. It was killed for working.

The regression is invisible from outside: adding `async` back changes no
response, no status code and no test result. It only shows up as the service
dying under load, which reads as a hosting problem. So it is asserted here,
against the source.
"""

import ast
from pathlib import Path

import pytest

MAIN = Path(__file__).resolve().parent.parent / "api" / "main.py"

# The three that are legitimately async.
#
#   service_auth      middleware; awaits call_next
#   trigger_training  awaits run_in_executor -- it always handed its work off
#   health            trivial, reads globals. Stays on the loop deliberately,
#                     so it can answer while every worker thread is busy,
#                     which is the whole point of freeing the loop.
ALLOWED_ASYNC = {"service_auth", "trigger_training", "health", "lifespan"}


def _module() -> ast.Module:
    return ast.parse(MAIN.read_text(encoding="utf-8"))


def _is_path_operation(node: ast.AST) -> bool:
    """True for a function carrying an @app.get/@app.post decorator."""
    for dec in getattr(node, "decorator_list", []):
        func = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id == "app" and func.attr in {"get", "post", "put", "delete", "patch"}:
                return True
    return False


def _path_operations():
    return [n for n in _module().body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and _is_path_operation(n)]


def test_there_are_path_operations_to_check():
    # Guards the finder itself: a decorator shape it does not recognise would
    # make every assertion below pass over an empty list.
    assert len(_path_operations()) >= 15


@pytest.mark.parametrize(
    "node", _path_operations(), ids=lambda n: n.name
)
def test_blocking_endpoints_are_not_async(node):
    if node.name in ALLOWED_ASYNC:
        return
    assert not isinstance(node, ast.AsyncFunctionDef), (
        f"{node.name} is `async def`, so FastAPI runs it on the event loop "
        f"and it blocks every other request -- including /health -- for as "
        f"long as it takes. Declare it `def` and FastAPI will run it in a "
        f"threadpool instead."
    )


@pytest.mark.parametrize(
    "node", _path_operations(), ids=lambda n: n.name
)
def test_async_endpoints_actually_await_something(node):
    """The converse: `async def` has to earn itself."""
    if not isinstance(node, ast.AsyncFunctionDef):
        return
    awaits = [n for n in ast.walk(node) if isinstance(n, (ast.Await, ast.AsyncFor, ast.AsyncWith))]
    if node.name == "health":
        # The documented exception: trivial, and deliberately on the loop.
        assert not awaits
        return
    assert awaits, (
        f"{node.name} is `async def` but awaits nothing, so it gains no "
        f"concurrency and gives up the threadpool it would otherwise get."
    )


def test_the_batch_scorer_is_the_one_that_matters():
    # Named explicitly rather than left to the sweep: this is the endpoint
    # whose blocking took the service down, and a rename should not quietly
    # drop it from the check.
    ops = {n.name: n for n in _path_operations()}
    assert "predict_multi_horizon_batch" in ops
    assert not isinstance(ops["predict_multi_horizon_batch"], ast.AsyncFunctionDef)


def test_health_stays_cheap():
    """
    /health decides whether the host keeps the container alive.

    It must not grow a model call, a database read or anything else that can
    block, because it is the one endpoint that has to answer while everything
    else is busy.
    """
    ops = {n.name: n for n in _path_operations()}

    # Checked as calls, not as substrings: `mh_predictor` contains "predict"
    # and reading an attribute off it is exactly what this endpoint should do.
    # What must not appear is the work itself.
    blocking = {
        "predict", "predict_proba", "predict_multi_horizon",
        "predict_multi_horizon_batch", "execute", "cursor", "read_sql",
        "connect", "check", "train",
    }
    # The body only. ast.walk over the FunctionDef includes its decorator
    # list, so @app.get("/health") registers as a call to `get`.
    called = set()
    for stmt in ops["health"].body:
      for node in ast.walk(stmt):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute):
                called.add(f.attr)
            elif isinstance(f, ast.Name):
                called.add(f.id)

    offenders = called & blocking
    assert not offenders, (
        f"/health now calls {sorted(offenders)}. It is the liveness probe; "
        f"anything that can block here gets the container restarted."
    )
