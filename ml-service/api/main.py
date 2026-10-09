# ml-service/api/main.py
# FastAPI ML service — the Python "brain" of the system.
# Runs on port 8000, called by the Node.js server via HTTP.
# Auto-generated Swagger UI available at http://localhost:8000/docs

import os
import sys
import hmac
import subprocess
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from api.schemas.prediction import (
    SnapshotInput,
    BatchInput,
    HealthResponse,
)

from engine.genai_advisor import is_available, LLM_PROVIDER, generate_recommendation
from engine.predictor_multihorizon import MultiHorizonPredictor
from engine.projector import project as project_trajectory
from engine.drift_detector import DriftDetector
from engine.model_registry import (
    get_state as registry_get_state,
    register_new_version,
    promote_challenger,
    get_metrics_for_version,
)

# ─────────────────────────────────────────────────────────────────────────────
# STARTUP / SHUTDOWN
# ─────────────────────────────────────────────────────────────────────────────

mh_predictor: MultiHorizonPredictor = None   # champion
challenger_predictor: MultiHorizonPredictor = None  # challenger (shadow)
drift_detector: DriftDetector = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global mh_predictor, challenger_predictor, drift_detector
    print("[STARTUP] Loading ML artifacts...")

    # Bootstrap registry then load champion and challenger predictors
    try:
        state = registry_get_state()
        champion_v    = state.get("champion")
        challenger_v  = state.get("challenger")

        if champion_v:
            mh_predictor = MultiHorizonPredictor(pin_version=champion_v)
            print(f"[STARTUP] Champion: {champion_v}")
        else:
            # Fallback: load latest available version (handles pre-registry installs)
            mh_predictor = MultiHorizonPredictor()
            # Register it as champion so registry stays in sync
            if mh_predictor:
                register_new_version(mh_predictor.version)
                print(f"[STARTUP] Auto-registered {mh_predictor.version} as champion")

        if challenger_v:
            try:
                challenger_predictor = MultiHorizonPredictor(pin_version=challenger_v)
                print(f"[STARTUP] Challenger: {challenger_v} (shadow mode)")
            except Exception as ce:
                print(f"[STARTUP] Challenger load failed ({ce}) — shadow disabled")
    except Exception as e:
        print(f"[STARTUP] No trained models found ({e}). Service will start without predictor — train via /train endpoint.")

    try:
        drift_detector = DriftDetector()
    except Exception as e:
        print(f"[STARTUP] Drift detector init warning: {e}")
    yield
    print("[SHUTDOWN] ML service stopping")


# ─────────────────────────────────────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# API DOCS GATE
#
# Swagger UI, ReDoc and the OpenAPI schema are off unless ENABLE_API_DOCS is
# truthy. They have to sit outside the service-token check to be usable at all
# (Swagger fetches its own openapi.json from the browser, with no token), so
# leaving them on would publish the full API surface of a service whose other
# endpoints are deliberately gated -- every path, parameter and schema,
# including /train and /models/promote.
#
# Default is OFF rather than "off when ENVIRONMENT=production": a gate that
# depends on remembering an unrelated variable fails open on exactly the
# deploy that forgets it. Local development opts in instead -- .env.example
# and docker-compose.yml both set it.
# ─────────────────────────────────────────────────────────────────────────────

def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


DOCS_ENABLED = _truthy(os.getenv("ENABLE_API_DOCS"))

if not DOCS_ENABLED:
    print("[DOCS] API docs disabled (set ENABLE_API_DOCS=true to serve /docs, /redoc, /openapi.json)")


app = FastAPI(
    title="Enterprise Asset Intelligence — ML Service",
    description=(
        "Predictive maintenance API for construction equipment rental. "
        "Serves multi-horizon failure probability predictions from calibrated "
        "Random Forest models (10d, 30d, 60d), with forward trajectory projection "
        "and LLM-generated maintenance recommendations via Groq."
    ),
    version="2.0.0",
    lifespan=lifespan,
    # None removes the route entirely -- a disabled doc path 404s rather than
    # existing unauthenticated. openapi_url must go too, or the schema stays
    # readable even with the UIs off.
    docs_url="/docs" if DOCS_ENABLED else None,
    redoc_url="/redoc" if DOCS_ENABLED else None,
    openapi_url="/openapi.json" if DOCS_ENABLED else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        os.getenv("CLIENT_URL", "http://localhost:5173"),
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# SEC-1: service-to-service auth
# The ML plane is private (no host port in compose). Every request must carry the
# shared X-Service-Token; admin verbs are audit-logged with the caller's identity
# (X-Actor, forwarded from the Node session). Health/docs are exempt so the
# compose healthcheck and Swagger UI work without the token.
# ─────────────────────────────────────────────────────────────────────────────

ML_SERVICE_TOKEN = os.getenv("ML_SERVICE_TOKEN", "").strip()
# /health must stay exempt: platform health checks cannot send the token.
# The doc paths are exempt only while they exist at all.
_AUTH_EXEMPT = {"/health"}
if DOCS_ENABLED:
    _AUTH_EXEMPT |= {"/docs", "/redoc", "/openapi.json"}
_ADMIN_PATHS = {"/train", "/models/promote", "/drift/compute-reference"}

if not ML_SERVICE_TOKEN:
    print("[AUTH] ⚠️  ML_SERVICE_TOKEN not set — ML service is UNAUTHENTICATED. "
          "Set it (and the matching Node env var) before any non-local deployment.")


@app.middleware("http")
async def service_auth(request: Request, call_next):
    path = request.url.path
    if path not in _AUTH_EXEMPT and ML_SERVICE_TOKEN:
        provided = request.headers.get("X-Service-Token", "")
        # Timing-safe comparison — never leak token length/prefix via early exit.
        if not hmac.compare_digest(provided, ML_SERVICE_TOKEN):
            return JSONResponse(status_code=401, content={"detail": "Invalid or missing service token"})

    if path in _ADMIN_PATHS:
        actor = request.headers.get("X-Actor", "unknown")
        print(f"[AUDIT] actor={actor} action={request.method} {path}")

    return await call_next(request)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["System"])
async def health():
    """Service health check."""
    return HealthResponse(
        status="healthy",
        model_version=mh_predictor.version if mh_predictor else "not loaded",
        model_loaded=mh_predictor is not None,
        llm_provider=LLM_PROVIDER,
        llm_available=is_available(),
    )


@app.post("/predict/multi-horizon", tags=["Inference"])
async def predict_multi_horizon(snapshot: SnapshotInput):
    """
    Multi-horizon failure prediction for a single equipment snapshot.
    Returns separate calibrated risk assessments for 10d, 30d, and 60d windows.
    """
    if not mh_predictor:
        raise HTTPException(status_code=503, detail="Multi-horizon model not loaded")
    try:
        snapshot_dict = snapshot.model_dump()
        result = mh_predictor.predict_multi_horizon(snapshot_dict)

        # LLM-1: augment the deterministic template with an LLM recommendation
        # ONLY on this single-asset path and ONLY when explicitly enabled
        # (never in batch). Falls back silently to the template on any failure.
        # Grounded in the worst horizon's structured facts.
        if is_available():
            worst_key = max(result["predictions"], key=lambda k: result["predictions"][k]["failure_probability"])
            worst = result["predictions"][worst_key]
            llm_text = generate_recommendation(
                snapshot_dict,
                {"risk_level": worst["risk_level"],
                 "failure_probability": worst["failure_probability"],
                 "top_risk_drivers": worst.get("top_risk_drivers", {})},
                horizon_days=int(worst_key.rstrip("d")),
            )
            if llm_text:
                result["recommendation"] = llm_text
                result["recommendation_source"] = "llm"
            else:
                result["recommendation_source"] = "template"
        else:
            result["recommendation_source"] = "template"
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Multi-horizon prediction failed: {str(e)}")


@app.post("/predict/multi-horizon/batch", tags=["Inference"])
async def predict_multi_horizon_batch(batch: BatchInput):
    """
    Batch multi-horizon predictions for multiple equipment items.
    Runs all three drift checks post-prediction (non-blocking):
      - Feature drift (PSI on input distributions)
      - Prediction drift (PSI on output score distributions per horizon)
      - Bias drift (per-category HIGH-risk rate vs baseline)
    """
    if not mh_predictor:
        raise HTTPException(status_code=503, detail="Multi-horizon model not loaded")
    if len(batch.snapshots) > 500:
        raise HTTPException(status_code=400, detail="Batch size limit is 500 snapshots")
    try:
        snapshots = [s.model_dump() for s in batch.snapshots]
        results   = mh_predictor.predict_multi_horizon_batch(snapshots)

        feature_drift    = None
        prediction_drift = None
        bias_drift       = None

        if drift_detector:
            try:
                feature_drift    = drift_detector.check(snapshots, mh_predictor.version)
            except Exception as de:
                print(f"[DRIFT] feature check error (non-fatal): {de}")
            try:
                prediction_drift = drift_detector.check_prediction_drift(results, mh_predictor.version)
            except Exception as de:
                print(f"[DRIFT] prediction check error (non-fatal): {de}")
            try:
                bias_drift       = drift_detector.check_bias_drift(results, snapshots, mh_predictor.version)
            except Exception as de:
                print(f"[DRIFT] bias check error (non-fatal): {de}")

        # ── Shadow scoring: run challenger in parallel, log score delta ─────
        # Results are NOT written to DB — purely for comparison metrics.
        shadow_summary = None
        if challenger_predictor:
            try:
                challenger_results = challenger_predictor.predict_multi_horizon_batch(snapshots)
                # Compare 30d risk scores as a representative horizon
                champ_scores = [r["30d"]["risk_score"] for r in results if "30d" in r]
                chal_scores  = [r["30d"]["risk_score"] for r in challenger_results if "30d" in r]
                if champ_scores and chal_scores:
                    import numpy as _np
                    deltas = [c - ch for c, ch in zip(chal_scores, champ_scores)]
                    shadow_summary = {
                        "challenger_version": challenger_predictor.version,
                        "n_scored":           len(deltas),
                        "mean_score_delta_30d": round(float(_np.mean(deltas)), 3),
                        "pct_higher_risk":    round(sum(d > 5 for d in deltas) / len(deltas) * 100, 1),
                        "pct_lower_risk":     round(sum(d < -5 for d in deltas) / len(deltas) * 100, 1),
                        "note": "Challenger scores are not persisted — shadow mode only",
                    }
                    print(f"[SHADOW] Challenger {challenger_predictor.version}: "
                          f"mean Δ30d={shadow_summary['mean_score_delta_30d']:+.1f}")
            except Exception as se:
                print(f"[SHADOW] Challenger scoring failed (non-fatal): {se}")

        return {
            "predictions":      results,
            "total":            len(results),
            "drift":            feature_drift,
            "prediction_drift": prediction_drift,
            "bias_drift":       bias_drift,
            "shadow":           shadow_summary,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch prediction failed: {str(e)}")


@app.post("/predict/project", tags=["Inference"])
async def project_failure_trajectory(snapshot: SnapshotInput):
    """
    Forward projection — ages features analytically and returns a 60-day
    failure probability curve plus threshold crossing estimates.

    Assumes no maintenance occurs during the projection window (conservative).

    Returns:
    - curve: list of {day, 10d, 30d, 60d} probability points at 7-day intervals
    - threshold_crossings: first day each horizon crosses HIGH threshold (null if never)
    - days_until_high: earliest crossing across all horizons
    """
    if not mh_predictor:
        raise HTTPException(status_code=503, detail="Multi-horizon model not loaded")
    try:
        snapshot_dict = snapshot.model_dump()
        result = project_trajectory(snapshot_dict, mh_predictor)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Projection failed: {str(e)}")


@app.get("/models/feature-importance", tags=["Model"])
async def feature_importance():
    """Returns feature importance and hyperparameters for the 30d model (canonical horizon)."""
    if not mh_predictor:
        raise HTTPException(status_code=503, detail="Multi-horizon model not loaded")
    return {
        "horizon": 30,
        "feature_importance": mh_predictor.feature_importance.get(30, {}),
        "hyperparameters": mh_predictor.hyperparameters,
    }


@app.get("/models/multi-horizon/info", tags=["Model"])
async def multi_horizon_model_info():
    """Returns loaded model versions and performance metrics per horizon."""
    if not mh_predictor:
        raise HTTPException(status_code=503, detail="Multi-horizon model not loaded")
    from engine.predictor_multihorizon import RISK_THRESHOLDS
    return {
        "versions":   mh_predictor.versions,
        "horizons":   [10, 30, 60],
        # Derived from each loaded model's own metadata — never hardcoded
        "confidence": {f"{h}d": mh_predictor.confidence.get(h, "unknown") for h in [10, 30, 60]},
        "thresholds": {f"{h}d": RISK_THRESHOLDS[h] for h in [10, 30, 60]},
        "monotonicity": "enforced — p(fail≤10d) ≤ p(fail≤30d) ≤ p(fail≤60d)",
    }


# ─────────────────────────────────────────────────────────────────────────────
# DRIFT DETECTION
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/drift/latest", tags=["Drift"])
async def drift_latest():
    """
    Returns the most recent PSI result per monitored feature.
    Use this to build a drift monitoring dashboard or alert feed.
    """
    if not drift_detector:
        raise HTTPException(status_code=503, detail="Drift detector not initialized")
    rows = drift_detector.get_latest()
    overall = (
        "ALERT"   if any(r["status"] == "ALERT"   for r in rows) else
        "WARNING" if any(r["status"] == "WARNING" for r in rows) else
        "STABLE"  if rows else
        "NO_DATA"
    )
    return {"overall": overall, "features": rows}


@app.post("/drift/compute-reference", tags=["Drift"])
async def drift_compute_reference():
    """
    Bootstrap all three drift reference distributions from current DB state:
      - Feature distribution from asset_feature_snapshots
      - Prediction score distribution from asset_risk_predictions
      - Per-category bias baseline from asset_risk_predictions + equipment
    Safe to call multiple times — overwrites drift_reference.json in registry/.
    """
    if not drift_detector:
        raise HTTPException(status_code=503, detail="Drift detector not initialized")
    result = drift_detector.compute_reference_from_db()
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "Unknown error"))
    return result


@app.get("/drift/prediction", tags=["Drift"])
async def drift_prediction_latest():
    """
    Latest prediction drift metrics per horizon (10d, 30d, 60d).
    PSI on output score distributions — detects shifts in model confidence
    profile that may indicate concept drift or population mismatch.
    """
    if not drift_detector:
        raise HTTPException(status_code=503, detail="Drift detector not initialized")
    rows = drift_detector.get_latest_prediction_drift()
    overall = (
        "ALERT"   if any(r["score_status"] == "ALERT"   for r in rows) else
        "WARNING" if any(r["score_status"] == "WARNING" for r in rows) else
        "STABLE"  if rows else
        "NO_DATA"
    )
    return {"overall": overall, "horizons": rows}


@app.get("/drift/bias", tags=["Drift"])
async def drift_bias_latest():
    """
    Latest bias drift metrics per equipment category (30d horizon).
    Detects systematic over/under-prediction for specific asset types
    that would be invisible in aggregate metrics.
    """
    if not drift_detector:
        raise HTTPException(status_code=503, detail="Drift detector not initialized")
    rows = drift_detector.get_latest_bias_drift()
    overall = (
        "ALERT"  if any(r["alert"] for r in rows) else
        "STABLE" if rows else
        "NO_DATA"
    )
    return {"overall": overall, "categories": rows}


@app.get("/drift/summary", tags=["Drift"])
async def drift_summary():
    """
    Consolidated drift summary across all three layers:
      - data_drift:       feature PSI (covariate shift)
      - prediction_drift: output score PSI (confidence profile shift)
      - bias_drift:       per-category HIGH% deviation
    Use this as the single source of truth for drift dashboard cards.
    """
    if not drift_detector:
        raise HTTPException(status_code=503, detail="Drift detector not initialized")

    feat_rows = drift_detector.get_latest()
    pred_rows = drift_detector.get_latest_prediction_drift()
    bias_rows = drift_detector.get_latest_bias_drift()

    def _overall(statuses: list[str]) -> str:
        if "ALERT" in statuses:
            return "ALERT"
        if "WARNING" in statuses:
            return "WARNING"
        if statuses:
            return "STABLE"
        return "NO_DATA"

    feat_status = _overall([r["status"]       for r in feat_rows])
    pred_status = _overall([r["score_status"] for r in pred_rows])
    bias_status = "ALERT" if any(r["alert"] for r in bias_rows) else ("STABLE" if bias_rows else "NO_DATA")

    all_statuses = [feat_status, pred_status, bias_status]
    overall = _overall([s for s in all_statuses if s != "NO_DATA"])

    return {
        "overall": overall,
        "data_drift": {
            "status":   feat_status,
            "features": feat_rows,
        },
        "prediction_drift": {
            "status":   pred_status,
            "horizons": pred_rows,
        },
        "bias_drift": {
            "status":     bias_status,
            "categories": bias_rows,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# DATA QUALITY
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/data-quality/report", tags=["Data Quality"])
async def data_quality_report():
    """
    Run data quality checks against the current labeled training dataset in DB.
    Returns a structured report with per-check status (PASS / WARN / FAIL) and
    an overall training readiness verdict.

    Useful for:
    - Pre-flight check before triggering a retrain
    - Dashboard status card showing data health at a glance
    - Diagnosing why a training run failed

    Does NOT trigger training — read-only DB query.
    """
    try:
        import sys
        from pathlib import Path as _Path
        _ml_root = str(_Path(__file__).parent.parent)
        if _ml_root not in sys.path:
            sys.path.insert(0, _ml_root)

        from training.train_model_multihorizon import load_training_data
        from engine.data_quality import run as dq_run

        df = load_training_data()
        report = dq_run(df)
        return report
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Data quality check failed: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# CHAMPION-CHALLENGER
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/models/registry", tags=["Champion-Challenger"])
async def models_registry():
    """
    Returns current champion/challenger state and the full promotion history.
    Champion = production model whose predictions are written to the DB.
    Challenger = shadow model running on every batch for comparison only.
    """
    state = registry_get_state()
    return {
        "champion":   state.get("champion"),
        "challenger": state.get("challenger"),
        "retired":    state.get("retired", []),
        "history":    state.get("history", [])[-10:],  # last 10 events
        "champion_loaded":    mh_predictor is not None,
        "challenger_loaded":  challenger_predictor is not None,
    }


@app.get("/models/champion-challenger/compare", tags=["Champion-Challenger"])
async def champion_challenger_compare():
    """
    Side-by-side metric comparison between champion and challenger.
    Uses stored metadata from training (holdout ROC-AUC, recall, PR-AUC per horizon).
    Returns null challenger metrics when no challenger is registered.
    """
    state = registry_get_state()
    champion_v   = state.get("champion")
    challenger_v = state.get("challenger")

    champion_metrics   = get_metrics_for_version(champion_v)   if champion_v   else {}
    challenger_metrics = get_metrics_for_version(challenger_v) if challenger_v else {}

    def _summary(metrics: dict) -> dict:
        """Flatten per-horizon metadata into a compact comparison shape."""
        summary = {}
        for horizon_key, m in metrics.items():
            h = horizon_key  # e.g. "30d"
            pc = m.get("per_class", {})
            summary[h] = {
                "roc_auc":       m.get("roc_auc"),
                "pr_auc":        m.get("pr_auc"),
                "recall_fail":   pc.get("failure", {}).get("recall"),
                "precision_fail": pc.get("failure", {}).get("precision"),
                "f1_fail":       pc.get("failure", {}).get("f1"),
                "samples_test":  m.get("samples_test"),
                "positive_rate": m.get("positive_rate"),
                "trained_at":    m.get("trained_at"),
            }
        return summary

    return {
        "champion": {
            "version": champion_v,
            "metrics": _summary(champion_metrics),
        },
        "challenger": {
            "version": challenger_v,
            "metrics": _summary(challenger_metrics),
        } if challenger_v else None,
        "shadow_mode": challenger_predictor is not None,
        "note": (
            "Challenger runs on every batch in shadow mode — "
            "its predictions are logged but not persisted to DB. "
            "Promote via POST /models/promote when you're satisfied with performance."
        ),
    }


@app.post("/models/promote", tags=["Champion-Challenger"])
async def promote_challenger_endpoint():
    """
    Promote the current challenger to champion.
    - Old champion is retired (artifacts preserved in registry/).
    - Challenger predictor becomes the new production predictor.
    - Next batch will serve predictions from the promoted model.

    Returns 409 if no challenger is registered.
    """
    global mh_predictor, challenger_predictor

    if not challenger_predictor:
        raise HTTPException(
            status_code=409,
            detail="No challenger loaded. Train a new model first."
        )
    try:
        result = promote_challenger()

        # Swap in-memory predictors
        mh_predictor        = challenger_predictor
        challenger_predictor = None

        print(f"[PROMOTE] {result['promoted']} is now champion — live immediately")
        return {
            "success":      True,
            "new_champion": result["new_champion"],
            "retired":      result["retired"],
            "message":      f"Model {result['new_champion']} is now serving production traffic.",
        }
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING
# ─────────────────────────────────────────────────────────────────────────────

_training_status: dict = {"running": False, "log": [], "last_result": None}


@app.post("/train", tags=["Training"])
async def trigger_training(background_tasks: BackgroundTasks):
    """
    Triggers a full model retrain using train_model_multihorizon.py.
    Runs in a thread executor (required on Windows).
    Poll GET /train/status for progress and results.
    """
    if _training_status["running"]:
        raise HTTPException(status_code=409, detail="Training already in progress")

    async def run_training():
        global _training_status, mh_predictor, challenger_predictor

        _training_status["running"] = True
        _training_status["log"] = ["[JOB] Starting training pipeline..."]
        _training_status["last_result"] = None

        script_path = (
            Path(__file__).parent.parent / "training" / "train_model_multihorizon.py"
        )

        # Prefer venv Python so all ml dependencies are available
        venv_python = (
            Path(__file__).parent.parent.parent / "venv" / "Scripts" / "python.exe"
        )
        python_exe = str(venv_python) if venv_python.exists() else sys.executable

        _training_status["log"].append(f"[JOB] Python  : {python_exe}")
        _training_status["log"].append(f"[JOB] Script  : {script_path}")
        _training_status["log"].append(f"[JOB] Exists  : {script_path.exists()}")

        def run_sync():
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            return subprocess.run(
                [python_exe, str(script_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=str(script_path.parent.parent),
            )

        try:
            loop = asyncio.get_event_loop()
            with ThreadPoolExecutor(max_workers=1) as pool:
                result = await loop.run_in_executor(pool, run_sync)

            for line in result.stdout.splitlines():
                _training_status["log"].append(line)
            for line in result.stderr.splitlines():
                _training_status["log"].append(f"[ERR] {line}")

            if len(_training_status["log"]) > 300:
                _training_status["log"] = _training_status["log"][-300:]

            success = result.returncode == 0

            if success:
                try:
                    # Load the newly trained version as challenger (not champion).
                    # It runs in shadow mode until explicitly promoted.
                    # If no champion exists yet (first train), it becomes champion.
                    new_predictor = MultiHorizonPredictor()  # loads latest
                    new_version   = new_predictor.version
                    reg_result    = register_new_version(new_version)

                    if reg_result["role"] == "champion":
                        # First ever model — becomes champion directly
                        mh_predictor = new_predictor
                        _training_status["log"].append(
                            f"[JOB] First model — {new_version} is now champion"
                        )
                    else:
                        # Challenger: load into shadow slot, champion unchanged
                        challenger_predictor = new_predictor
                        _training_status["log"].append(
                            f"[JOB] {new_version} registered as challenger (shadow mode). "
                            f"Champion remains {mh_predictor.version if mh_predictor else 'none'}. "
                            f"Promote via POST /models/promote when ready."
                        )
                except Exception as reload_err:
                    _training_status["log"].append(
                        f"[JOB] Warning: model reload failed: {reload_err}"
                    )

            _training_status["last_result"] = {
                "success": success,
                "return_code": result.returncode,
                "version": mh_predictor.version if success and mh_predictor else None,
            }
            _training_status["log"].append(
                f"[JOB] {'Complete' if success else 'FAILED'} "
                f"— exit code {result.returncode}"
            )

        except Exception as e:
            import traceback as tb_mod
            _training_status["log"].append(f"[JOB] FATAL: {str(e)}")
            _training_status["log"].append(f"[JOB] TRACEBACK: {tb_mod.format_exc()}")
            _training_status["last_result"] = {"success": False, "error": str(e)}

        finally:
            _training_status["running"] = False

    background_tasks.add_task(run_training)
    return {"message": "Training job started", "poll": "/train/status"}


@app.get("/train/status", tags=["Training"])
async def training_status():
    """Poll for training progress. Returns log lines and running state."""
    return {
        "running":     _training_status["running"],
        "log":         _training_status["log"],
        "last_result": _training_status["last_result"],
    }
