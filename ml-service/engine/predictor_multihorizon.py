# ml-service/engine/predictor_multihorizon.py
# Multi-horizon inference engine — loads 10d, 30d, 60d models at startup.
# Serves predictions with risk level and failure probability per horizon.
# Transforms mirror prepare_features() in train_model_multihorizon.py exactly.

import json
import pandas as pd
import joblib
from pathlib import Path
from typing import Optional

from engine.feature_transform import transform_features
from engine.genai_advisor import RECENT_SERVICE_DAYS

try:
    import shap
    SHAP_AVAILABLE = True
except ImportError:
    SHAP_AVAILABLE = False

REGISTRY = Path(__file__).parent.parent / "registry"
HORIZONS = [10, 30, 60]

# Uniform thresholds across all horizons.
# Monotonic enforcement (p10 ≤ p30 ≤ p60) guarantees risk levels are also
# non-decreasing — no separate per-horizon compensation needed.
RISK_THRESHOLDS = {
    # Mirrors shared/risk-bands.ts, which explains the values;
    # tests/test_risk_band_parity.py keeps the two in step.
    10: {"HIGH": 0.20, "MEDIUM": 0.10},
    30: {"HIGH": 0.45, "MEDIUM": 0.25},
    60: {"HIGH": 0.70, "MEDIUM": 0.45},
}

# Confidence labels are derived from each loaded model's own holdout ROC-AUC
# (see _confidence_label / _load_artifacts) — never hardcoded, so they can't
# go stale when a new version is trained.
def _confidence_label(roc_auc: Optional[float]) -> str:
    if roc_auc is None:
        return "unknown"
    if roc_auc >= 0.90:
        return f"high (holdout ROC-AUC {roc_auc:.2f})"
    if roc_auc >= 0.80:
        return f"moderate (holdout ROC-AUC {roc_auc:.2f})"
    return f"low (holdout ROC-AUC {roc_auc:.2f})"


_RISK_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}


def risk_trend(predictions: dict) -> str:
    """
    INCREASING when the unit sits in a worse band at 60 days than at 10.

    This compared p60 - p10 against 0.10, but the probabilities are cumulative:
    the 60-day window holds the 10-day one, so the gap is wide on any unit. All
    60 demo units came back INCREASING, including ones LOW at every horizon.
    The bands already allow for window length, so comparing them asks whether
    the risk is getting worse rather than whether the window got longer.

    DECREASING stays unused: a longer window cannot lower the risk.
    """
    near = _RISK_RANK[predictions["10d"]["risk_level"]]
    far = _RISK_RANK[predictions["60d"]["risk_level"]]
    return "INCREASING" if far > near else "STABLE"


def worst_horizon(predictions: dict) -> str:
    """
    The horizon in the worst band, then the highest probability among those.

    Probability alone always picks 60d, which hides a unit that is HIGH at 10
    days but only MEDIUM at 60 under the per-horizon cutoffs.
    """
    return max(
        predictions,
        key=lambda k: (_RISK_RANK[predictions[k]["risk_level"]], predictions[k]["failure_probability"]),
    )


class MultiHorizonPredictor:
    """
    Loads all three horizon models at startup.
    Serves predictions with risk levels for 10d, 30d, 60d windows.

    Supports loading a specific model version for champion-challenger routing.
    When pin_version is None, loads the latest available version (legacy behavior).
    """

    def __init__(self, pin_version: Optional[str] = None):
        self._pin_version = pin_version
        self._load_artifacts()

    def _load_artifacts(self):
        import re

        self.models = {}
        self.versions = {}
        self.shap_explainers = {}

        def _version_key(p):
            m = re.search(r'v(\d+)\.(\d+)', p.stem)
            return (int(m.group(1)), int(m.group(2))) if m else (0, 0)

        for h in HORIZONS:
            if self._pin_version:
                model_path = REGISTRY / f"rf_{h}d_{self._pin_version}.pkl"
                if not model_path.exists():
                    raise FileNotFoundError(
                        f"Pinned version {self._pin_version} not found: {model_path}"
                    )
                model_files = [model_path]
            else:
                model_files = sorted(REGISTRY.glob(f"rf_{h}d_*.pkl"), key=_version_key, reverse=True)
            if not model_files:
                raise FileNotFoundError(f"No {h}d model found in {REGISTRY}. Run train_model_multihorizon.py first.")
            model_data = joblib.load(model_files[0])
            self.models[h] = model_data["model"]
            self.versions[h] = model_data["version"]
            print(f"[MH-PREDICTOR] Loaded {h}d model {model_data['version']} ({len(model_data['feature_names'])} features)")

            # SHAP TreeExplainer — operates on the base RF inside the calibrated wrapper.
            # We use calibrated_classifiers_[0].estimator (first CV fold's estimator) as a
            # representative tree for attribution. SHAP values are in log-odds space from
            # the uncalibrated RF; the sign and ranking are reliable, the magnitude is not
            # a calibrated probability — communicate this in interviews.
            if SHAP_AVAILABLE:
                try:
                    base_rf = self.models[h].calibrated_classifiers_[0].estimator
                    self.shap_explainers[h] = shap.TreeExplainer(base_rf)
                    print(f"[MH-PREDICTOR] SHAP TreeExplainer ready for {h}d")
                except Exception as e:
                    print(f"[MH-PREDICTOR] SHAP init failed for {h}d: {e}")

        # Use 30d model's feature names as canonical (all horizons share same features)
        # The 30d model that was actually loaded above -- a pinned version
        # included. This re-globbed for the latest file, so a predictor pinned
        # to an older champion reported the newest version's name.
        path_30 = (REGISTRY / f"rf_30d_{self._pin_version}.pkl" if self._pin_version
                   else sorted(REGISTRY.glob("rf_30d_*.pkl"), key=_version_key, reverse=True)[0])
        model_data_30 = joblib.load(path_30)
        self.feature_names: list = model_data_30["feature_names"]
        self.version: str = model_data_30["version"]

        # ── ML-7: resolve EVERY preprocessing artifact by the loaded model's
        # version, not latest-by-glob. Otherwise a pinned champion silently
        # serves the challenger's encoder / clip thresholds after any retrain,
        # defeating the champion/challenger guarantee. Unversioned files are a
        # legacy fallback only.
        resolved_version = self._pin_version or self.versions.get(30) or self.version

        def _versioned_json(versioned_name: str, glob_pattern: str):
            vp = REGISTRY / versioned_name
            if vp.exists():
                with open(vp) as f:
                    return json.load(f), vp.name
            files = sorted(REGISTRY.glob(glob_pattern), key=_version_key, reverse=True)
            if files:
                with open(files[0]) as f:
                    return json.load(f), files[0].name
            return None, None

        # Label encoder — pinned, then unversioned legacy fallback
        encoder_path = REGISTRY / f"label_encoder_category_{resolved_version}.pkl"
        if not encoder_path.exists():
            encoder_path = REGISTRY / "label_encoder_category.pkl"
        if not encoder_path.exists():
            raise FileNotFoundError(
                f"Label encoder not found for {resolved_version} (and no legacy fallback)"
            )
        self.label_encoder = joblib.load(encoder_path)

        # Feature columns
        fc, fc_name = _versioned_json(f"feature_cols_{resolved_version}.json", "feature_cols_*.json")
        self.expected_features: list = fc["feature_cols"] if fc else self.feature_names

        # Clip thresholds
        clip, clip_name = _versioned_json(f"clip_thresholds_{resolved_version}.json", "clip_thresholds_*.json")
        if clip:
            self.clip_thresholds: Optional[dict] = clip["clip_thresholds"]
            print(f"[MH-PREDICTOR] Clip thresholds loaded from {clip_name} ({len(self.clip_thresholds)} cols)")
        else:
            self.clip_thresholds = None
            print("[MH-PREDICTOR] WARNING: No clip thresholds — skipping outlier clipping")

        print(f"[MH-PREDICTOR] Preprocessing artifacts pinned to {resolved_version} "
              f"(encoder={encoder_path.name}, feature_cols={fc_name})")

        # Feature importance per horizon — pinned, then latest-by-glob fallback
        self.feature_importance = {}
        for h in HORIZONS:
            fi, _ = _versioned_json(
                f"feature_importance_{h}d_{resolved_version}.json",
                f"feature_importance_{h}d_*.json",
            )
            self.feature_importance[h] = fi or {}

        # Per-horizon metadata → hyperparameters + honest confidence labels.
        # Prefer the metadata file matching the loaded model's version; fall
        # back to latest-by-glob only for legacy registries missing it.
        self.metadata: dict = {}
        self.confidence: dict = {}
        for h in HORIZONS:
            meta = {}
            versioned = REGISTRY / f"metadata_{h}d_{self.versions[h]}.json"
            if versioned.exists():
                with open(versioned) as f:
                    meta = json.load(f)
            else:
                meta_files = sorted(REGISTRY.glob(f"metadata_{h}d_*.json"), key=_version_key, reverse=True)
                if meta_files:
                    with open(meta_files[0]) as f:
                        meta = json.load(f)
            self.metadata[h] = meta
            self.confidence[h] = _confidence_label(meta.get("roc_auc"))

        self.hyperparameters: dict = self.metadata.get(30, {}).get("hyperparameters", {})

        print(f"[MH-PREDICTOR] Ready — horizons: {HORIZONS}d, version: {self.version}")
    
    

    # ─────────────────────────────────────────────────────────────────────
    # PUBLIC API
    # ─────────────────────────────────────────────────────────────────────

    def predict_multi_horizon(self, snapshot: dict) -> dict:
        """
        Run inference across all three horizon models for a single snapshot.
        Returns predictions dict with 10d, 30d, 60d results.
        """
        df = pd.DataFrame([snapshot])
        df = self._apply_transforms(df)
        df = df.reindex(columns=self.expected_features, fill_value=0)
        df = df.apply(pd.to_numeric, errors="coerce").fillna(0)

        # ── Step 1: raw probabilities from each independent model ────────────────
        raw = {}
        for h in HORIZONS:
            proba = self.models[h].predict_proba(df)[0]
            raw[h] = float(proba[1])

        # Pre-compute SHAP attributions for all horizons (done once on aligned df)
        shap_by_horizon = {h: self._get_shap_attribution(df, h) for h in HORIZONS}

        # ── Step 2: enforce isotonic monotonicity ─────────────────────────────
        # Labels are cumulative: will_fail_Xd = "fails within X days".
        # Therefore P(fail≤10d) ≤ P(fail≤30d) ≤ P(fail≤60d) is a mathematical
        # identity — the 30d window strictly contains the 10d window.
        # Independent calibrated classifiers violate this; fix it here.
        p10 = raw[10]
        p30 = max(raw[30], p10)   # 30d ⊇ 10d
        p60 = max(raw[60], p30)   # 60d ⊇ 30d
        enforced = {10: p10, 30: p30, 60: p60}

        if raw[30] < p10 or raw[60] < p30:
            print(
                f"[MH] EQ-{snapshot['equipment_id']} monotonicity enforced: "
                f"raw=({raw[10]:.3f},{raw[30]:.3f},{raw[60]:.3f}) -> "
                f"({p10:.3f},{p30:.3f},{p60:.3f})"
            )

        # ── Step 3: build predictions dict from enforced probabilities ────────
        predictions = {}
        for h in HORIZONS:
            failure_prob = enforced[h]
            thresholds = RISK_THRESHOLDS[h]
            if failure_prob >= thresholds["HIGH"]:
                risk_level = "HIGH"
            elif failure_prob >= thresholds["MEDIUM"]:
                risk_level = "MEDIUM"
            else:
                risk_level = "LOW"

            predictions[f"{h}d"] = {
                "failure_probability": round(failure_prob, 4),
                "risk_level":          risk_level,
                "risk_score":          round(failure_prob * 100),
                "model_confidence":    self.confidence.get(h, "unknown"),
                "top_risk_drivers":    self._get_risk_drivers(snapshot, failure_prob, h),
                # Per-prediction SHAP attribution: feature → contribution to failure probability.
                # Positive = pushes toward failure; negative = protective.
                # Ranked by |SHAP value|, top 5 features shown.
                "shap_attribution":    shap_by_horizon[h],
            }

            print(f"[MH] EQ-{snapshot['equipment_id']} {h}d: P={failure_prob:.3f} -> {risk_level}")

        # ── Step 4: trend and recommendation
        trend = risk_trend(predictions)

        worst_key = worst_horizon(predictions)
        recommendation = self._generate_recommendation(
            snapshot,
            predictions[worst_key]["risk_level"],
            worst_key
        )

        return {
            "equipment_id":  snapshot["equipment_id"],
            "model_version": self.version,
            "risk_trend":    trend,
            "predictions":   predictions,
            "recommendation": recommendation,
        }

    def predict_multi_horizon_batch(self, snapshots: list) -> list:
        """Run multi-horizon inference on multiple snapshots efficiently."""
        return [self.predict_multi_horizon(s) for s in snapshots]

    # ─────────────────────────────────────────────────────────────────────
    # PRIVATE — TRANSFORMS
    # ML-6: delegates to the ONE shared transform used by training, so the
    # ordered pipeline (usage cap → encode → log → clip) is identical here and
    # in prepare_features(). No second implementation to drift out of sync.
    # ─────────────────────────────────────────────────────────────────────

    def _apply_transforms(self, df: pd.DataFrame) -> pd.DataFrame:
        transformed, _ = transform_features(
            df,
            label_encoder=self.label_encoder,
            clip_thresholds=self.clip_thresholds,
            fit=False,
            drop_non_features=True,
        )
        return transformed

    # ─────────────────────────────────────────────────────────────────────
    # PRIVATE — SHAP ATTRIBUTION
    # Per-prediction feature contributions using TreeExplainer on base RF.
    # Values are in log-odds space (uncalibrated) — sign and rank are
    # reliable; magnitude should not be compared to failure_probability.
    # ─────────────────────────────────────────────────────────────────────

    def _get_shap_attribution(self, df_aligned: pd.DataFrame, horizon: int) -> dict:
        if not SHAP_AVAILABLE or horizon not in self.shap_explainers:
            return {}
        try:
            explainer = self.shap_explainers[horizon]
            explanation = explainer(df_aligned)

            # shap >= 0.40 returns an Explanation object: shape (n_samples, n_features, n_classes)
            # We want class-1 (failure) SHAP values for the single sample.
            if hasattr(explanation, "values"):
                vals = explanation.values
                if vals.ndim == 3:
                    shap_vals = vals[0, :, 1]      # (n_features,), class=failure
                else:
                    shap_vals = vals[0]            # fallback for 2-D output
            else:
                # Older shap API: returns list of arrays per class
                raw = explainer.shap_values(df_aligned)
                shap_vals = raw[1][0] if isinstance(raw, list) else raw[0]

            feature_names = df_aligned.columns.tolist()
            top5 = sorted(
                zip(feature_names, shap_vals),
                key=lambda x: abs(x[1]),
                reverse=True
            )[:5]
            return {feat: round(float(val), 4) for feat, val in top5}
        except Exception as e:
            print(f"[SHAP] Attribution failed for {horizon}d: {e}")
            return {}

    # ─────────────────────────────────────────────────────────────────────
    # PRIVATE — RISK DRIVERS
    # Uses horizon-specific feature importance
    # ─────────────────────────────────────────────────────────────────────

    def _get_risk_drivers(self, snapshot: dict, prob: float, horizon: int) -> dict:
        drivers = {}
        fi = self.feature_importance.get(horizon, {})

        days_since = snapshot.get("days_since_last_maintenance") or 0
        maint_overdue = snapshot.get("maint_overdue", 0)
        if maint_overdue or days_since > 60:
            drivers[f"⚠️ Maintenance overdue ({int(days_since)}d since last service)"] = fi.get("days_since_last_maintenance", 0.15)
        elif days_since > 30:
            drivers[f"Approaching maintenance threshold ({int(days_since)}d since last service)"] = fi.get("days_since_last_maintenance", 0.10)

        neglect = snapshot.get("neglect_score", 0)
        if neglect >= 2.5:
            drivers[f"High neglect score: {neglect:.1f}/10"] = fi.get("neglect_score", 0.20)
        elif neglect >= 1.5:
            drivers[f"Moderate neglect: {neglect:.1f}/10"] = fi.get("neglect_score", 0.12)

        wear = snapshot.get("mechanical_wear_score", 0)
        if wear >= 4:
            drivers[f"High mechanical wear: {wear:.1f}/10"] = fi.get("mechanical_wear_score", 0.18)
        elif wear >= 2:
            drivers[f"Moderate mechanical wear: {wear:.1f}/10"] = fi.get("mechanical_wear_score", 0.10)

        wear_rate = snapshot.get("wear_rate", 0)
        if wear_rate > 0.05:
            drivers[f"Elevated wear rate: {wear_rate:.3f}"] = fi.get("wear_rate", 0.09)

        age = snapshot.get("asset_age_years", 0)
        if age > 4:
            drivers[f"Asset age: {age:.1f} years (end of useful life approaching)"] = fi.get("asset_age_years", 0.16)
        elif age > 2.5:
            drivers[f"Asset age: {age:.1f} years"] = fi.get("asset_age_years", 0.10)

        hours = snapshot.get("total_hours_lifetime", 0)
        if hours > 3000:
            drivers[f"High lifetime hours: {int(hours):,} hrs"] = fi.get("total_hours_lifetime", 0.13)
        elif hours > 1500:
            drivers[f"Elevated lifetime hours: {int(hours):,} hrs"] = fi.get("total_hours_lifetime", 0.08)

        abuse = snapshot.get("abuse_score", 0)
        if abuse >= 3:
            drivers[f"High operational stress: {abuse:.1f}/10"] = fi.get("abuse_score", 0.12)

        if not drivers:
            drivers["Well maintained — within normal operating parameters"] = 0.02

        return dict(sorted(drivers.items(), key=lambda x: x[1], reverse=True)[:5])

    # ─────────────────────────────────────────────────────────────────────
    # PRIVATE — RECOMMENDATION
    # ─────────────────────────────────────────────────────────────────────

    def _generate_recommendation(self, snapshot: dict, worst_risk: str, horizon: str) -> str:
        age   = snapshot.get("asset_age_years", 0)
        hours = snapshot.get("total_hours_lifetime", 0)
        days  = snapshot.get("days_since_last_maintenance", 0) or 0

        # The same rule as the advisor, for batch runs and LLM fallbacks.
        if (worst_risk != "HIGH" and snapshot.get("last_service_type")
                and days <= RECENT_SERVICE_DAYS):
            return (
                "Recently serviced, so no further maintenance is needed yet. "
                "Monitor for wear escalation and keep to the regular schedule."
            )

        if worst_risk == "HIGH":
            return (
                f"Equipment shows HIGH failure probability within {horizon}. "
                f"Schedule immediate inspection — {int(days)} days since last service, "
                f"{age:.1f} year old unit with {int(hours):,} lifetime hours. "
                f"Prioritize before next rental assignment."
            )
        elif worst_risk == "MEDIUM":
            return (
                f"Equipment shows MEDIUM failure risk within {horizon}. "
                f"Schedule preventive maintenance within 2 weeks. "
                f"Monitor for wear escalation before next rental."
            )
        else:
            return (
                "Equipment is within normal operating parameters across all prediction horizons. "
                "Continue standard maintenance schedule."
            )
