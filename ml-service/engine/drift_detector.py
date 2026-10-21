# ml-service/engine/drift_detector.py
#
# Three-layer drift monitoring:
#
#   1. DATA DRIFT      — PSI on input feature distributions (covariate shift).
#                        Detects when the live fleet looks different from the
#                        training population, which degrades model relevance.
#
#   2. PREDICTION DRIFT — PSI on output score distributions per horizon.
#                        Detects when the model's confidence profile shifts
#                        (e.g., suddenly predicting more HIGH-risk) regardless
#                        of whether inputs changed — can indicate concept drift
#                        or a distribution mismatch that slipped past feature PSI.
#
#   3. BIAS DRIFT      — Per-category HIGH-risk rate vs. training baseline.
#                        Detects systematic over/under-prediction for specific
#                        equipment categories (Crane, Excavator, Generator…),
#                        which would be invisible in aggregate metrics.
#
# PSI interpretation (shared across all three layers):
#   < 0.10  STABLE  — no action needed
#   < 0.20  WARNING — monitor; consider scheduled retrain
#   ≥ 0.20  ALERT   — significant shift; investigate and likely retrain
#
# Bias drift threshold:
#   |current_HIGH% - reference_HIGH%| > 0.15 for any category → ALERT

import json
import re
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional

REGISTRY = Path(__file__).parent.parent / "registry"

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE DRIFT — monitored input features
# ─────────────────────────────────────────────────────────────────────────────
# Selection criteria:
#   (a) non-degenerate distribution in seeded training data (p25 ≠ p75)
#   (b) no severe zero-inflation
#   (c) high model importance or known sensitivity to operational change
#
# Excluded:
#   asset_age_years         — negative values in sim (computed vs. future date)
#   days_since_last_maintenance — 100% zero on initialization
#   total_hours_lifetime    — 72% zero in early training data
#   jobsite_risk_score      — constant 0.30 default
#   wear_rate_velocity      — 72% zero in early training data
MONITORED_FEATURES = [
    "mean_time_between_failures",   # reliability signal — shifts as fleet ages
    "vendor_reliability_score",     # external dependency — shifts if vendor mix changes
    "mechanical_wear_score",        # composite 0-10 — rises with cumulative wear
    "neglect_score",                # composite 0-10 — rises with maintenance neglect
    "hours_used_90d",               # usage intensity proxy — shifts with rental activity
]

# ─────────────────────────────────────────────────────────────────────────────
# PREDICTION DRIFT — monitored output horizons
# ─────────────────────────────────────────────────────────────────────────────
HORIZONS = [10, 30, 60]

# ─────────────────────────────────────────────────────────────────────────────
# BIAS DRIFT — per-category threshold
# ─────────────────────────────────────────────────────────────────────────────
# Flag if a category's HIGH% deviates more than this from its training baseline.
BIAS_ALERT_THRESHOLD = 0.15

PSI_WARNING_THRESHOLD = 0.10
PSI_ALERT_THRESHOLD   = 0.20
N_BINS         = 5

# Smallest batch worth PSI-scoring AGAINST a reference. A handful of rows
# produces a PSI number that moves on noise, so an undersized batch is skipped
# rather than reported.
MIN_BATCH_SIZE = 20

# Smallest set worth building a reference FROM.
#
# These were the same constant, and that was the bug. A batch is a sample of
# traffic, so 20 is a floor on statistical weight. A reference built from a
# scoring run is not a sample of anything -- it is every asset in the fleet,
# the whole population. Requiring 20 rows from a 10-asset fleet is requiring
# two runs' worth of duplicate rows, which is unsatisfiable on a clean
# database: the prediction and bias references were skipped silently on every
# compute, for every model version, and the three committed reference files all
# carry "predictions": {} and "bias": {} to prove it.
#
# So the gate is now coverage, not row count: a reference needs a prediction
# for essentially the whole fleet, with a small absolute floor so a two-asset
# toy database still cannot produce one.
MIN_REFERENCE_ASSETS   = 5
MIN_FLEET_COVERAGE     = 0.9
# Feature references come from the snapshot history, which is large even in the
# demo (240 rows), so MIN_BATCH_SIZE remains the right floor there.
MIN_REFERENCE_SAMPLES  = MIN_BATCH_SIZE


# ─────────────────────────────────────────────────────────────────────────────
# CORE MATH
# ─────────────────────────────────────────────────────────────────────────────

def compute_psi(reference: np.ndarray, current: np.ndarray, n_bins: int = N_BINS) -> float:
    """
    PSI between reference (training) and current (inference) distributions.
    Bins are defined by reference quantiles for robustness with skewed features.
    """
    smooth = 1.0 / min(len(reference), len(current))

    breaks = np.nanquantile(reference, np.linspace(0, 1, n_bins + 1))
    breaks[0]  -= smooth
    breaks[-1] += smooth
    breaks = np.unique(breaks)
    if len(breaks) < 3:
        return 0.0

    ref_counts, _ = np.histogram(reference, bins=breaks)
    cur_counts, _ = np.histogram(current,   bins=breaks)

    ref_pct = ref_counts / max(len(reference), 1)
    cur_pct = cur_counts / max(len(current),   1)

    ref_pct = np.where(ref_pct == 0, smooth, ref_pct)
    cur_pct = np.where(cur_pct == 0, smooth, cur_pct)

    psi = float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))
    return round(max(psi, 0.0), 6)


def _psi_status(psi: float) -> str:
    if psi >= PSI_ALERT_THRESHOLD:
        return "ALERT"
    if psi >= PSI_WARNING_THRESHOLD:
        return "WARNING"
    return "STABLE"


# ─────────────────────────────────────────────────────────────────────────────
# DRIFT DETECTOR
# ─────────────────────────────────────────────────────────────────────────────

class DriftDetector:
    """
    Three-layer drift detector: feature PSI, prediction score PSI, bias by category.
    Loads reference distributions at startup and checks post-batch-prediction.
    All results persisted to MySQL for trend analysis.
    """

    def __init__(self):
        self.reference: dict[str, np.ndarray] = {}
        self.pred_reference: dict[int, dict]  = {}   # horizon → {scores, high_pct, medium_pct, low_pct}
        self.bias_reference: dict[str, dict]  = {}   # category → {high_pct, mean_score}
        self.ref_model_version: Optional[str] = None
        self._load_reference()
        self._ensure_tables()

    # ── Startup ──────────────────────────────────────────────────────────────

    def _load_reference(self):
        """
        Load the reference in force: newest database row, else a shipped file.

        The database comes first because it is the only store that survives a
        restart on a host with no persistent disk, and because it is where
        compute-reference writes. Previously the only source was the registry
        directory, and the glob there matched the committed per-version files
        but not the one compute-reference writes -- so a freshly computed
        reference was never the one loaded afterwards.
        """
        data, source = self._load_reference_from_db()
        if data is None:
            data, source = self._load_reference_from_file()

        if data is None:
            print("[DRIFT] No reference found — drift detection inactive. "
                  "Call POST /drift/compute-reference to bootstrap.")
            return

        # Feature reference
        for feat, values in data.get("features", {}).items():
            arr = np.array(values, dtype=float)
            if len(arr) >= MIN_REFERENCE_SAMPLES:
                self.reference[feat] = arr

        # Prediction score reference.
        #
        # Floored at MIN_REFERENCE_ASSETS, not MIN_BATCH_SIZE: a reference
        # covering a 10-asset fleet has 10 scores, and rejecting it here would
        # discard on load exactly what the compute step just built.
        for h_str, pref in data.get("predictions", {}).items():
            h = int(h_str)
            scores = pref.get("scores", [])
            if len(scores) >= MIN_REFERENCE_ASSETS:
                self.pred_reference[h] = {
                    "scores":     np.array(scores, dtype=float),
                    "high_pct":   pref.get("high_pct", 0.0),
                    "medium_pct": pref.get("medium_pct", 0.0),
                    "low_pct":    pref.get("low_pct",  1.0),
                }

        # Bias reference
        self.bias_reference = data.get("bias", {})

        self.ref_model_version = data.get("model_version")
        print(f"[DRIFT] Reference loaded from {source} — "
              f"{len(self.reference)} feature refs, "
              f"{len(self.pred_reference)} prediction refs, "
              f"{len(self.bias_reference)} category bias refs, "
              f"model={self.ref_model_version}")

    def _load_reference_from_db(self) -> tuple[Optional[dict], str]:
        """Newest drift_reference row, or (None, "") if there is none to read."""
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                row = conn.execute(sqla_text(
                    "SELECT payload, computed_at FROM drift_reference "
                    "ORDER BY computed_at DESC, id DESC LIMIT 1"
                )).fetchone()
            engine.dispose()
            if row is None:
                return None, ""
            return json.loads(row[0]), f"database (computed {row[1]})"
        except Exception as e:
            # A missing table or an unreachable database must not stop the
            # service from starting; the shipped file still gives feature drift.
            print(f"[DRIFT] Could not read reference from database ({e}) — trying registry")
            return None, ""

    def _load_reference_from_file(self) -> tuple[Optional[dict], str]:
        """
        Highest-versioned shipped reference, else the plain one.

        Selected by parsed version rather than mtime. Every file in a Docker
        image carries the build timestamp, so ordering by mtime made the choice
        between v1.15 and v1.17 arbitrary.
        """
        def _version_key(p: Path):
            m = re.search(r"_v(\d+)\.(\d+)\.json$", p.name)
            return (int(m.group(1)), int(m.group(2))) if m else (-1, -1)

        versioned = sorted(REGISTRY.glob("drift_reference_v*.json"), key=_version_key, reverse=True)
        plain     = REGISTRY / "drift_reference.json"
        target    = versioned[0] if versioned else (plain if plain.exists() else None)
        if target is None:
            return None, ""
        try:
            with open(target) as f:
                return json.load(f), f"file {target.name}"
        except (OSError, ValueError) as e:
            print(f"[DRIFT] Reference file {target.name} unreadable: {e}")
            return None, ""

    def _ensure_tables(self):
        # ARCH-1: DDL is owned exclusively by Drizzle migrations
        # (shared/schema.ts → migrations/). The drift tables — drift_metrics,
        # prediction_drift_metrics, bias_drift_metrics, drift_reference — are
        # created by `drizzle-kit migrate`. This service is DML-only: it
        # verifies the tables exist and warns if the migration hasn't been run,
        # but never creates schema.
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            required = ["drift_metrics", "prediction_drift_metrics",
                        "bias_drift_metrics", "drift_reference"]
            with engine.connect() as conn:
                missing = []
                for table in required:
                    try:
                        conn.execute(sqla_text(f"SELECT 1 FROM {table} LIMIT 1"))
                    except Exception:
                        missing.append(table)
            engine.dispose()
            if missing:
                print(f"[DRIFT] Missing tables: {', '.join(missing)} — "
                      f"run `drizzle-kit migrate` (Drizzle owns DDL, ARCH-1)")
            else:
                print("[DRIFT] All drift tables present")
        except Exception as e:
            print(f"[DRIFT] Table check warning: {e}")

    # ── Public API — Feature Drift ────────────────────────────────────────────

    def check(self, snapshots: list, model_version: str = "unknown",
              persist: bool = True) -> dict:
        """
        Feature drift: PSI on input feature distributions.
        Returns summary dict — safe to include in batch prediction response.

        `persist=False` runs the comparison without recording it. Used by the
        self-check after a reference is computed, which compares the reference
        sample against the reference built from it and can therefore only ever
        return PSI 0. Recording that produced four rows of PSI 0.000000 /
        STABLE as the newest readings in drift_metrics -- and because
        get_latest() takes the newest row per feature, they hid the genuine
        readings behind them (a batch of 50 with PSI up to 0.4376) and left the
        dashboard asserting a stability it had not measured.
        """
        if not self.reference:
            return {"status": "inactive", "reason": "no reference distribution loaded"}
        if len(snapshots) < MIN_BATCH_SIZE:
            return {"status": "skipped",
                    "reason": f"batch too small ({len(snapshots)} < {MIN_BATCH_SIZE})"}

        df  = pd.DataFrame(snapshots)
        results: dict[str, dict] = {}
        alerts: list[str] = []

        for feat in MONITORED_FEATURES:
            if feat not in self.reference or feat not in df.columns:
                continue

            ref_arr = self.reference[feat]
            cur_arr = pd.to_numeric(df[feat], errors="coerce").dropna().values
            if len(cur_arr) < 5:
                continue

            psi    = compute_psi(ref_arr, cur_arr)
            status = _psi_status(psi)

            if status == "ALERT":
                alerts.append(feat)

            results[feat] = {
                "psi":      psi,
                "status":   status,
                "ref_mean": round(float(np.mean(ref_arr)), 4),
                "cur_mean": round(float(np.mean(cur_arr)), 4),
                "ref_std":  round(float(np.std(ref_arr)),  4),
                "cur_std":  round(float(np.std(cur_arr)),  4),
            }

        overall = (
            "ALERT"   if alerts else
            "WARNING" if any(v["status"] == "WARNING" for v in results.values()) else
            "STABLE"
        )

        if alerts:
            print(f"[DRIFT] Feature ALERT — shift in: {alerts}")
        else:
            print(f"[DRIFT] Feature {overall} (batch_size={len(snapshots)})")

        if persist:
            self._persist_feature(results, len(snapshots), model_version)

        return {
            "status":        overall,
            "batch_size":    len(snapshots),
            "model_version": model_version,
            "alerts":        alerts,
            "features":      results,
        }

    # ── Public API — Prediction Drift ─────────────────────────────────────────

    def check_prediction_drift(self, results: list, model_version: str = "unknown") -> dict:
        """
        Prediction drift: PSI on output score distributions per horizon.
        Also tracks HIGH/MEDIUM/LOW label ratio shift.
        `results` is the list returned by predict_multi_horizon_batch.
        """
        if not self.pred_reference:
            return {"status": "inactive", "reason": "no prediction reference loaded"}
        if len(results) < MIN_BATCH_SIZE:
            return {"status": "skipped",
                    "reason": f"batch too small ({len(results)} < {MIN_BATCH_SIZE})"}

        horizon_results: dict[int, dict] = {}
        alerts: list[int] = []

        for h in HORIZONS:
            if h not in self.pred_reference:
                continue

            h_key = f"{h}d"
            cur_scores = np.array([
                r["predictions"][h_key]["failure_probability"]
                for r in results
                if h_key in r.get("predictions", {})
            ], dtype=float)

            if len(cur_scores) < 5:
                continue

            cur_labels = [
                r["predictions"][h_key]["risk_level"]
                for r in results
                if h_key in r.get("predictions", {})
            ]

            n = len(cur_labels)
            cur_high_pct   = sum(1 for lbl in cur_labels if lbl == "HIGH")   / n
            cur_medium_pct = sum(1 for lbl in cur_labels if lbl == "MEDIUM") / n
            cur_low_pct    = sum(1 for lbl in cur_labels if lbl == "LOW")    / n

            ref      = self.pred_reference[h]
            ref_arr  = ref["scores"]
            psi      = compute_psi(ref_arr, cur_scores)
            status   = _psi_status(psi)

            if status == "ALERT":
                alerts.append(h)

            horizon_results[h] = {
                "score_psi":      psi,
                "score_status":   status,
                "high_pct":       round(cur_high_pct,   4),
                "medium_pct":     round(cur_medium_pct, 4),
                "low_pct":        round(cur_low_pct,    4),
                "ref_high_pct":   round(ref.get("high_pct",   0.0), 4),
                "ref_medium_pct": round(ref.get("medium_pct", 0.0), 4),
                "ref_low_pct":    round(ref.get("low_pct",    1.0), 4),
            }

        overall = (
            "ALERT"   if alerts else
            "WARNING" if any(v["score_status"] == "WARNING" for v in horizon_results.values()) else
            "STABLE"  if horizon_results else
            "NO_DATA"
        )

        if alerts:
            print(f"[DRIFT] Prediction ALERT — score shift in horizons: {alerts}d")
        else:
            print(f"[DRIFT] Prediction {overall}")

        self._persist_prediction(horizon_results, len(results), model_version)

        return {
            "status":        overall,
            "batch_size":    len(results),
            "model_version": model_version,
            "alerts":        [f"{h}d" for h in alerts],
            "horizons":      horizon_results,
        }

    # ── Public API — Bias Drift ───────────────────────────────────────────────

    def check_bias_drift(self, results: list, snapshots: list, model_version: str = "unknown") -> dict:
        """
        Bias drift: per-category HIGH-risk rate vs training baseline.
        Uses 30d horizon as the canonical horizon for bias assessment.
        """
        if len(results) < MIN_BATCH_SIZE:
            return {"status": "skipped",
                    "reason": f"batch too small ({len(results)} < {MIN_BATCH_SIZE})"}

        # Build category → 30d scores/labels mapping
        cat_data: dict[str, list] = {}
        for r, s in zip(results, snapshots):
            cat = s.get("category", "Unknown")
            pred_30d = r.get("predictions", {}).get("30d", {})
            if not pred_30d:
                continue
            if cat not in cat_data:
                cat_data[cat] = []
            cat_data[cat].append({
                "prob":  pred_30d.get("failure_probability", 0.0),
                "label": pred_30d.get("risk_level", "LOW"),
            })

        category_results: dict[str, dict] = {}
        alerts: list[str] = []

        for cat, items in cat_data.items():
            if len(items) < 3:      # too few to be meaningful
                continue

            n         = len(items)
            high_pct  = sum(1 for i in items if i["label"] == "HIGH") / n
            mean_score = float(np.mean([i["prob"] for i in items]))

            ref_high_pct = self.bias_reference.get(cat, {}).get("high_pct", None)
            if ref_high_pct is None:
                # No reference for this category — use overall HIGH% as fallback
                all_high = sum(1 for r in results
                               if r.get("predictions", {}).get("30d", {}).get("risk_level") == "HIGH")
                ref_high_pct = all_high / max(len(results), 1)

            deviation  = abs(high_pct - ref_high_pct)
            is_alert   = deviation > BIAS_ALERT_THRESHOLD

            if is_alert:
                alerts.append(cat)

            category_results[cat] = {
                "n":             n,
                "mean_score":    round(mean_score, 4),
                "high_pct":      round(high_pct,     4),
                "ref_high_pct":  round(ref_high_pct, 4),
                "deviation":     round(deviation,    4),
                "alert":         is_alert,
            }

        overall = "ALERT" if alerts else "STABLE"

        if alerts:
            print(f"[DRIFT] Bias ALERT — category shift in: {alerts}")
        else:
            print(f"[DRIFT] Bias {overall} ({len(category_results)} categories)")

        self._persist_bias(category_results, len(results), model_version)

        return {
            "status":     overall,
            "batch_size": len(results),
            "alerts":     alerts,
            "categories": category_results,
        }

    # ── Public API — Getters ──────────────────────────────────────────────────

    def get_latest(self) -> list[dict]:
        """Most recent PSI row per monitored feature (data drift)."""
        if not MONITORED_FEATURES:
            return []
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            placeholders = ", ".join(f":f{i}" for i in range(len(MONITORED_FEATURES)))
            params = {f"f{i}": f for i, f in enumerate(MONITORED_FEATURES)}
            with engine.connect() as conn:
                rows = conn.execute(sqla_text(f"""
                    SELECT d1.*
                    FROM drift_metrics d1
                    INNER JOIN (
                        SELECT feature, MAX(id) AS latest_id
                        FROM drift_metrics
                        WHERE feature IN ({placeholders})
                        GROUP BY feature
                    ) d2 ON d1.id = d2.latest_id
                    ORDER BY d1.psi DESC
                """), params).fetchall()
            engine.dispose()
            return [dict(r._mapping) for r in rows]
        except Exception as e:
            print(f"[DRIFT] get_latest error: {e}")
            return []

    def get_latest_prediction_drift(self) -> list[dict]:
        """Most recent prediction drift row per horizon."""
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                rows = conn.execute(sqla_text("""
                    SELECT p1.*
                    FROM prediction_drift_metrics p1
                    INNER JOIN (
                        SELECT horizon, MAX(id) AS latest_id
                        FROM prediction_drift_metrics
                        GROUP BY horizon
                    ) p2 ON p1.id = p2.latest_id
                    ORDER BY p1.horizon
                """)).fetchall()
            engine.dispose()
            return [dict(r._mapping) for r in rows]
        except Exception as e:
            print(f"[DRIFT] get_latest_prediction_drift error: {e}")
            return []

    def get_latest_bias_drift(self) -> list[dict]:
        """Most recent bias drift row per category."""
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                rows = conn.execute(sqla_text("""
                    SELECT b1.*
                    FROM bias_drift_metrics b1
                    INNER JOIN (
                        SELECT category, horizon, MAX(id) AS latest_id
                        FROM bias_drift_metrics
                        WHERE horizon = 30
                        GROUP BY category, horizon
                    ) b2 ON b1.id = b2.latest_id
                    ORDER BY b1.deviation DESC
                """)).fetchall()
            engine.dispose()
            return [dict(r._mapping) for r in rows]
        except Exception as e:
            print(f"[DRIFT] get_latest_bias_drift error: {e}")
            return []

    # ── Reference Bootstrap ───────────────────────────────────────────────────

    def compute_reference_from_db(self, model_version: str = "bootstrap") -> dict:
        """
        Build all three reference distributions from current DB state.
        - Feature reference from asset_feature_snapshots
        - Prediction score + label distribution from asset_risk_predictions
        - Bias reference from asset_risk_predictions joined with equipment
        Stores the result in the drift_reference table (store of record) and
        drops a copy in registry/ for local inspection. Safe to call repeatedly;
        each call appends a row, and the newest row is the one in force.
        """
        try:
            engine = self._get_engine()

            # ── Feature reference ─────────────────────────────────────────────
            feat_cols = ", ".join(MONITORED_FEATURES)
            df_feat = pd.read_sql(
                f"SELECT {feat_cols} FROM asset_feature_snapshots ORDER BY snapshot_ts",
                engine
            )

            # ── Prediction reference from asset_risk_predictions ──────────────
            #
            # One row per asset: its most recent prediction. The unfiltered
            # query counted every scoring run ever stored, so an asset scored
            # twice weighed twice as much as one scored once, and a reference
            # computed today would have mixed the current model's output with
            # output from a superseded payload builder. "Most recent per asset"
            # is also exactly what the dashboards read, so the reference now
            # describes the same distribution the UI shows.
            df_pred = pd.read_sql(
                """SELECT arp.failure_probability, arp.risk_band,
                          arp.equipment_id, e.category
                   FROM asset_risk_predictions arp
                   JOIN equipment e ON e.id = arp.equipment_id
                   WHERE arp.id = (
                       SELECT i.id FROM asset_risk_predictions i
                       WHERE i.equipment_id = arp.equipment_id
                       ORDER BY i.predicted_at DESC, i.id DESC
                       LIMIT 1
                   )
                   ORDER BY arp.equipment_id""",
                engine
            )

            # Fleet size, to judge coverage rather than raw row count.
            fleet_size = int(pd.read_sql(
                "SELECT COUNT(*) AS n FROM equipment", engine)["n"].iloc[0])

            engine.dispose()
        except Exception as e:
            return {"success": False, "error": str(e)}

        # Feature reference
        feat_sample = df_feat.sample(min(5000, len(df_feat)), random_state=42)
        features = {}
        for feat in MONITORED_FEATURES:
            if feat in feat_sample.columns:
                vals = pd.to_numeric(feat_sample[feat], errors="coerce").dropna().tolist()
                if len(vals) >= MIN_BATCH_SIZE:
                    features[feat] = [round(v, 6) for v in vals]
                    self.reference[feat] = np.array(features[feat])

        # Prediction reference (use failure_probability as proxy for all horizons
        # since DB only stores one prediction per equipment — treat as 30d canonical)
        #
        # Gated on fleet coverage: enough assets in absolute terms, and nearly
        # all of the fleet represented. A row-count gate of 20 could never be
        # met by a 10-asset fleet and silently produced no reference at all.
        n_assets = int(df_pred["equipment_id"].nunique()) if len(df_pred) else 0
        coverage = (n_assets / fleet_size) if fleet_size else 0.0
        pred_ref_ok = n_assets >= MIN_REFERENCE_ASSETS and coverage >= MIN_FLEET_COVERAGE
        if not pred_ref_ok:
            print(f"[DRIFT] Prediction/bias reference skipped — {n_assets} of "
                  f"{fleet_size} assets scored (need >={MIN_REFERENCE_ASSETS} "
                  f"and >={MIN_FLEET_COVERAGE:.0%} coverage). "
                  f"Score the fleet, then compute the reference again.")

        pred_ref: dict[str, dict] = {}
        if pred_ref_ok:
            scores = pd.to_numeric(df_pred["failure_probability"], errors="coerce").dropna().tolist()
            n      = len(scores)
            labels = df_pred["risk_band"].tolist()
            pred_ref_entry = {
                "scores":     [round(s, 6) for s in scores],
                "high_pct":   round(sum(1 for lbl in labels if lbl == "HIGH")   / n, 4),
                "medium_pct": round(sum(1 for lbl in labels if lbl == "MEDIUM") / n, 4),
                "low_pct":    round(sum(1 for lbl in labels if lbl == "LOW")    / n, 4),
            }
            # Use same distribution as proxy for all horizons
            for h in HORIZONS:
                pred_ref[str(h)] = pred_ref_entry
                self.pred_reference[h] = {
                    "scores":     np.array(pred_ref_entry["scores"], dtype=float),
                    "high_pct":   pred_ref_entry["high_pct"],
                    "medium_pct": pred_ref_entry["medium_pct"],
                    "low_pct":    pred_ref_entry["low_pct"],
                }

        # Bias reference — per-category HIGH%
        bias_ref: dict[str, dict] = {}
        if "category" in df_pred.columns and pred_ref_ok:
            df_pred["is_high"] = df_pred["risk_band"] == "HIGH"
            df_pred["prob_num"] = pd.to_numeric(df_pred["failure_probability"], errors="coerce")
            for cat, grp in df_pred.groupby("category"):
                if len(grp) < 3:
                    continue
                bias_ref[cat] = {
                    "high_pct":   round(float(grp["is_high"].mean()), 4),
                    "mean_score": round(float(grp["prob_num"].mean()), 4),
                    "n":          len(grp),
                }
            self.bias_reference = bias_ref

        ref_data = {
            "model_version": model_version,
            "n_samples":     len(feat_sample),
            "n_assets":      n_assets,
            "features":      features,
            "predictions":   pred_ref,
            "bias":          bias_ref,
            "saved_at":      pd.Timestamp.now().isoformat(),
        }

        # The database is the store of record: this host has no persistent disk,
        # so anything written to registry/ at runtime is gone at the next cold
        # start -- and the loader's glob never matched this filename anyway.
        persisted = self._persist_reference(ref_data, n_assets)

        # Still written locally, for reading by hand during development. Not
        # load-bearing: nothing reads it back when a database row exists.
        try:
            with open(REGISTRY / "drift_reference.json", "w") as f:
                json.dump(ref_data, f, indent=2)
        except OSError as e:
            # A read-only or full filesystem must not fail the compute; the
            # reference that matters is already in the database.
            print(f"[DRIFT] Local reference copy not written ({e}) — database row stands")

        self.ref_model_version = model_version
        print(f"[DRIFT] Reference computed — {len(features)} feature refs, "
              f"{len(pred_ref)} pred refs, {len(bias_ref)} category bias refs, "
              f"n={len(feat_sample)}, assets={n_assets}, "
              f"stored={'db' if persisted else 'file only'}")

        # Post-reset self-check: proves the comparison path runs. It compares
        # the reference sample against the reference derived from it, so PSI 0
        # is arithmetic, not a measurement -- hence persist=False.
        try:
            check_result = self.check(feat_sample.to_dict("records"), model_version,
                                      persist=False)
            print(f"[DRIFT] Reference self-check (not recorded): {check_result.get('status')}")
        except Exception as e:
            print(f"[DRIFT] Post-reset check warning (non-fatal): {e}")

        return {
            "success":    True,
            "n_samples":  len(feat_sample),
            "n_assets":   n_assets,
            "features":   list(features.keys()),
            "pred_horizons": list(pred_ref.keys()),
            "bias_categories": list(bias_ref.keys()),
            "persisted":  persisted,
            # Said plainly in the response, because a caller that gets
            # success=True with no prediction horizons deserves to know that
            # half the monitoring is still unarmed and why.
            "prediction_reference_built": bool(pred_ref),
            "coverage": round(coverage, 4),
        }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _get_engine(self):
        from dotenv import load_dotenv
        from sqlalchemy import create_engine
        from engine.db_url import sqlalchemy_url
        env_path = Path(__file__).parent.parent.parent / ".env"
        load_dotenv(dotenv_path=env_path)
        # DATABASE_URL when set, else the DB_* vars; TLS handled there.
        return create_engine(sqlalchemy_url(), pool_pre_ping=True)

    def _persist_reference(self, ref_data: dict, n_assets: int) -> bool:
        """
        Store the computed reference in MySQL. Returns whether it landed.

        Append-only, like the three metrics tables: the newest row is the
        reference in force, and the ones before it are the record of what the
        baseline used to be when an older drift reading was taken.
        """
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                conn.execute(sqla_text("""
                    INSERT INTO drift_reference
                        (model_version, feature_count, horizon_count,
                         bias_category_count, n_samples, n_assets, payload)
                    VALUES
                        (:mv, :fc, :hc, :bc, :ns, :na, :payload)
                """), {
                    "mv":      ref_data["model_version"],
                    "fc":      len(ref_data.get("features", {})),
                    "hc":      len(ref_data.get("predictions", {})),
                    "bc":      len(ref_data.get("bias", {})),
                    "ns":      ref_data.get("n_samples", 0),
                    "na":      n_assets,
                    "payload": json.dumps(ref_data),
                })
                conn.commit()
            engine.dispose()
            return True
        except Exception as e:
            print(f"[DRIFT] Reference persist FAILED: {e}")
            return False

    def _persist_feature(self, results: dict, batch_size: int, model_version: str):
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                for feat, r in results.items():
                    conn.execute(sqla_text("""
                        INSERT INTO drift_metrics
                            (model_version, batch_size, feature, psi, status,
                             ref_mean, cur_mean, ref_std, cur_std)
                        VALUES
                            (:mv, :bs, :feat, :psi, :status, :rm, :cm, :rs, :cs)
                    """), {
                        "mv":     model_version,
                        "bs":     batch_size,
                        "feat":   feat,
                        "psi":    r["psi"],
                        "status": r["status"],
                        "rm":     r["ref_mean"],
                        "cm":     r["cur_mean"],
                        "rs":     r["ref_std"],
                        "cs":     r["cur_std"],
                    })
                conn.commit()
            engine.dispose()
        except Exception as e:
            print(f"[DRIFT] Feature persist warning: {e}")

    def _persist_prediction(self, horizon_results: dict, batch_size: int, model_version: str):
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                for h, r in horizon_results.items():
                    conn.execute(sqla_text("""
                        INSERT INTO prediction_drift_metrics
                            (model_version, batch_size, horizon, score_psi, score_status,
                             high_pct, medium_pct, low_pct,
                             ref_high_pct, ref_medium_pct, ref_low_pct)
                        VALUES
                            (:mv, :bs, :h, :psi, :status,
                             :hp, :mp, :lp, :rhp, :rmp, :rlp)
                    """), {
                        "mv":     model_version,
                        "bs":     batch_size,
                        "h":      h,
                        "psi":    r["score_psi"],
                        "status": r["score_status"],
                        "hp":     r["high_pct"],
                        "mp":     r["medium_pct"],
                        "lp":     r["low_pct"],
                        "rhp":    r["ref_high_pct"],
                        "rmp":    r["ref_medium_pct"],
                        "rlp":    r["ref_low_pct"],
                    })
                conn.commit()
            engine.dispose()
        except Exception as e:
            print(f"[DRIFT] Prediction persist warning: {e}")

    def _persist_bias(self, category_results: dict, batch_size: int, model_version: str):
        try:
            from sqlalchemy import text as sqla_text
            engine = self._get_engine()
            with engine.connect() as conn:
                for cat, r in category_results.items():
                    conn.execute(sqla_text("""
                        INSERT INTO bias_drift_metrics
                            (model_version, batch_size, category, horizon,
                             mean_score, high_pct, ref_high_pct, deviation, alert)
                        VALUES
                            (:mv, :bs, :cat, 30,
                             :ms, :hp, :rhp, :dev, :alert)
                    """), {
                        "mv":    model_version,
                        "bs":    batch_size,
                        "cat":   cat,
                        "ms":    r["mean_score"],
                        "hp":    r["high_pct"],
                        "rhp":   r["ref_high_pct"],
                        "dev":   r["deviation"],
                        "alert": 1 if r["alert"] else 0,
                    })
                conn.commit()
            engine.dispose()
        except Exception as e:
            print(f"[DRIFT] Bias persist warning: {e}")
