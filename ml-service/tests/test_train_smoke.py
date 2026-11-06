# ml-service/tests/test_train_smoke.py
# Training pipeline smoke test — runs entirely in-memory, no DB required.
# Validates that the training pipeline produces models with non-zero recall
# across all three horizons on synthetic data.
#
# Run locally:
#   cd ml-service
#   python -m pytest tests/test_train_smoke.py -v
#
# Called by CI on every push / PR to main.

import sys
import json
import numpy as np
import pandas as pd
import pytest
from pathlib import Path

# Ensure ml-service root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from training.train_model_multihorizon import (
    FEATURE_COLS,
    HORIZONS,
    prepare_features,
    train_horizon_model,
    save_horizon_model,
    RANDOM_SEED,
)


# ─────────────────────────────────────────────────────────────────────────────
# SYNTHETIC DATA GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def make_synthetic_df(n_samples: int = 600, seed: int = RANDOM_SEED) -> pd.DataFrame:
    """
    Generate a minimal synthetic dataset that exercises the full training
    pipeline without a database connection.

    Design choices:
    - Two clearly separable populations (low-risk vs high-risk) so the model
      can learn a signal with limited samples.
    - 15% positive rate for 10d, 25% for 30d, 40% for 60d — matches the
      rough distribution in a seeded demo dataset.
    - Temporal ordering via snapshot_ts so TimeSeriesSplit works correctly.
    """
    rng = np.random.default_rng(seed)
    n_high = int(n_samples * 0.35)
    n_low  = n_samples - n_high

    def asset_row(high: bool) -> dict:
        if high:
            return dict(
                asset_age_years          = rng.uniform(6, 15),
                total_hours_lifetime     = rng.uniform(4000, 12000),
                hours_used_30d           = rng.uniform(150, 300),
                hours_used_90d           = rng.uniform(400, 900),
                rental_days_30d          = int(rng.uniform(18, 30)),
                rental_days_90d          = int(rng.uniform(60, 90)),
                avg_rental_duration      = rng.uniform(2, 8),
                maintenance_events_90d   = int(rng.uniform(3, 8)),
                maintenance_cost_180d    = rng.uniform(2000, 8000),
                days_since_last_maintenance = rng.uniform(120, 400),
                mean_time_between_failures  = rng.uniform(30, 150),
                vendor_reliability_score    = rng.uniform(0.40, 0.70),
                jobsite_risk_score          = rng.uniform(0.60, 0.95),
                usage_intensity             = rng.uniform(8, 12),
                usage_trend                 = rng.uniform(1.2, 2.0),
                utilization_vs_expected     = rng.uniform(1.1, 1.6),
                wear_rate                   = rng.uniform(0.05, 0.15),
                aging_factor                = rng.uniform(0.5, 0.9),
                maint_overdue               = int(rng.choice([0, 1], p=[0.3, 0.7])),
                cost_per_event              = rng.uniform(500, 2000),
                maint_burden                = rng.uniform(4, 10),
                mechanical_wear_score       = rng.uniform(6, 10),
                abuse_score                 = rng.uniform(5, 10),
                neglect_score               = rng.uniform(6, 10),
                wear_rate_velocity          = rng.uniform(0.01, 0.05),
                maint_frequency_trend       = rng.uniform(1.2, 2.0),
                cost_trend                  = rng.uniform(1.2, 2.0),
                hours_velocity              = rng.uniform(1.2, 2.0),
                neglect_acceleration        = rng.uniform(1.2, 2.0),
                sensor_degradation_rate     = rng.uniform(0.05, 0.20),
                category                    = rng.choice(["Excavator", "Crane", "Bulldozer"]),
            )
        else:
            return dict(
                asset_age_years          = rng.uniform(0.5, 4),
                total_hours_lifetime     = rng.uniform(100, 2000),
                hours_used_30d           = rng.uniform(20, 100),
                hours_used_90d           = rng.uniform(60, 300),
                rental_days_30d          = int(rng.uniform(2, 15)),
                rental_days_90d          = int(rng.uniform(6, 45)),
                avg_rental_duration      = rng.uniform(2, 5),
                maintenance_events_90d   = int(rng.uniform(0, 2)),
                maintenance_cost_180d    = rng.uniform(0, 800),
                days_since_last_maintenance = rng.uniform(5, 60),
                mean_time_between_failures  = rng.uniform(300, 700),
                vendor_reliability_score    = rng.uniform(0.80, 1.0),
                jobsite_risk_score          = rng.uniform(0.10, 0.40),
                usage_intensity             = rng.uniform(1, 6),
                usage_trend                 = rng.uniform(0.7, 1.1),
                utilization_vs_expected     = rng.uniform(0.5, 0.9),
                wear_rate                   = rng.uniform(0.001, 0.02),
                aging_factor                = rng.uniform(0.05, 0.20),
                maint_overdue               = 0,
                cost_per_event              = rng.uniform(0, 400),
                maint_burden                = rng.uniform(0, 1.5),
                mechanical_wear_score       = rng.uniform(1, 3),
                abuse_score                 = rng.uniform(0, 2),
                neglect_score               = rng.uniform(0, 2),
                wear_rate_velocity          = rng.uniform(0, 0.005),
                maint_frequency_trend       = rng.uniform(0.8, 1.1),
                cost_trend                  = rng.uniform(0.8, 1.1),
                hours_velocity              = rng.uniform(0.8, 1.1),
                neglect_acceleration        = rng.uniform(0.8, 1.1),
                sensor_degradation_rate     = rng.uniform(0, 0.02),
                category                    = rng.choice(["Excavator", "Crane", "Bulldozer"]),
            )

    rows = [asset_row(True) for _ in range(n_high)] + \
           [asset_row(False) for _ in range(n_low)]
    rng.shuffle(rows)

    df = pd.DataFrame(rows)

    # Temporal index — required for TimeSeriesSplit
    base = pd.Timestamp("2024-01-01")
    df["snapshot_ts"] = [base + pd.Timedelta(days=i) for i in range(len(df))]

    # Asset identity — required for the by-asset grouped evaluation (ML-3)
    df["equipment_id"] = (np.arange(len(df)) % 30) + 1

    # Labels — correlated with high-risk features but not perfectly separable
    combined_score = (
        df["mechanical_wear_score"] / 10
        + df["neglect_score"] / 10
        + (1 - df["vendor_reliability_score"])
        + df["aging_factor"]
    ) / 4  # 0–1

    noise = rng.uniform(-0.15, 0.15, size=len(df))
    p10 = (combined_score + noise).clip(0, 1)
    p30 = (combined_score * 1.5 + noise).clip(0, 1)
    p60 = (combined_score * 2.0 + noise).clip(0, 1)

    df["will_fail_10d"] = (p10 > 0.70).astype(int)
    df["will_fail_30d"] = (p30 > 0.60).astype(int)
    df["will_fail_60d"] = (p60 > 0.50).astype(int)

    # Monotonicity: if fail_10d → fail_30d → fail_60d
    df["will_fail_30d"] = np.maximum(df["will_fail_10d"], df["will_fail_30d"])
    df["will_fail_60d"] = np.maximum(df["will_fail_30d"], df["will_fail_60d"])

    return df


# ─────────────────────────────────────────────────────────────────────────────
# FIXTURES
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def synthetic_df():
    return make_synthetic_df(n_samples=600)


@pytest.fixture(scope="module")
def prepared(synthetic_df, tmp_path_factory):
    """Run prepare_features once and reuse across tests."""
    tmp = tmp_path_factory.mktemp("registry")
    # Monkeypatch MODEL_DIR so artifacts go to tmp dir
    import training.train_model_multihorizon as tm
    original = tm.MODEL_DIR
    tm.MODEL_DIR = tmp
    tm.MODEL_DIR.mkdir(parents=True, exist_ok=True)

    X, labels, feature_names, clip_thresholds = prepare_features(synthetic_df, "v0.test")

    tm.MODEL_DIR = original
    return X, labels, feature_names, clip_thresholds


@pytest.fixture(scope="module")
def trained_models(prepared, tmp_path_factory):
    """Train all three horizon models once and reuse across tests."""
    X, labels, feature_names, clip_thresholds = prepared
    tmp = tmp_path_factory.mktemp("registry2")

    import training.train_model_multihorizon as tm
    original = tm.MODEL_DIR
    tm.MODEL_DIR = tmp
    tm.MODEL_DIR.mkdir(parents=True, exist_ok=True)

    # No failure-event history in the synthetic setup — lead-time metrics
    # legitimately come back None (never fabricated).
    empty_failures = pd.DataFrame({
        "equipment_id": pd.Series(dtype=int),
        "maintenance_date": pd.Series(dtype="datetime64[ns]"),
    })

    results = {}
    for h in HORIZONS:
        y = labels[f"will_fail_{h}d"]
        model, metrics = train_horizon_model(
            X, y, h,
            snapshot_ts=labels["snapshot_ts"],
            equipment_ids=labels["equipment_id"],
            failures_df=empty_failures,
        )
        save_horizon_model(model, feature_names, metrics, "v0.test", h)
        results[h] = {"model": model, "metrics": metrics}

    tm.MODEL_DIR = original
    return results, tmp


# ─────────────────────────────────────────────────────────────────────────────
# SYNTHETIC DATA TESTS
# ─────────────────────────────────────────────────────────────────────────────

class TestSyntheticData:
    def test_shape(self, synthetic_df):
        assert len(synthetic_df) >= 600
        assert "will_fail_10d" in synthetic_df.columns

    def test_all_horizons_have_positives(self, synthetic_df):
        for h in HORIZONS:
            col = f"will_fail_{h}d"
            n_pos = synthetic_df[col].sum()
            assert n_pos >= 10, f"{col}: only {n_pos} positives — not enough for training"

    def test_monotonicity(self, synthetic_df):
        # 10d failures must also be 30d failures, etc.
        assert (synthetic_df["will_fail_10d"] <= synthetic_df["will_fail_30d"]).all()
        assert (synthetic_df["will_fail_30d"] <= synthetic_df["will_fail_60d"]).all()

    def test_feature_cols_present(self, synthetic_df):
        missing = [c for c in FEATURE_COLS if c not in synthetic_df.columns]
        assert not missing, f"Missing feature columns: {missing}"


# ─────────────────────────────────────────────────────────────────────────────
# FEATURE ENGINEERING TESTS
# ─────────────────────────────────────────────────────────────────────────────

class TestFeatureEngineering:
    def test_no_nulls_after_prepare(self, prepared):
        X, _, _, _ = prepared
        assert X.isnull().sum().sum() == 0, "NaNs survived prepare_features()"

    def test_category_encoded(self, prepared):
        X, _, _, _ = prepared
        assert "category" not in X.columns, "Raw 'category' column should be dropped after encoding"
        assert "category_encoded" in X.columns

    def test_log_transforms_applied(self, prepared):
        X, _, _, _ = prepared
        assert "log_total_hours_lifetime" in X.columns
        assert "total_hours_lifetime" not in X.columns, "Raw hours column should be replaced by log version"

    def test_feature_count_reasonable(self, prepared):
        X, _, feature_names, _ = prepared
        assert 25 <= len(feature_names) <= 60, f"Unexpected feature count: {len(feature_names)}"

    def test_clip_thresholds_populated(self, prepared):
        _, _, _, clip_thresholds = prepared
        assert len(clip_thresholds) > 0


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING PIPELINE TESTS  (the core CI gate)
# ─────────────────────────────────────────────────────────────────────────────

class TestTrainingPipeline:
    def test_all_horizons_train(self, trained_models):
        results, _ = trained_models
        assert set(results.keys()) == {10, 30, 60}

    @pytest.mark.parametrize("horizon", HORIZONS)
    def test_recall_nonzero(self, trained_models, horizon):
        """
        Recall > 0 for the positive class means the model correctly
        identifies at least some true failures. Zero recall = the model
        predicts 'no failure' for everything — useless for maintenance.
        """
        results, _ = trained_models
        recall_positive = results[horizon]["metrics"]["recall"][1]  # index 1 = positive class
        assert recall_positive > 0.0, (
            f"{horizon}d model: recall for failures is 0.0. "
            "Check that class weighting is applied and there are enough positive samples."
        )

    @pytest.mark.parametrize("horizon", HORIZONS)
    def test_roc_auc_above_random(self, trained_models, horizon):
        """ROC-AUC above 0.5 means the model beats random chance."""
        results, _ = trained_models
        roc_auc = results[horizon]["metrics"]["roc_auc"]
        assert roc_auc > 0.5, (
            f"{horizon}d ROC-AUC={roc_auc:.3f} — model is no better than random. "
            "Check feature engineering and label quality."
        )

    @pytest.mark.parametrize("horizon", HORIZONS)
    def test_precision_nonzero(self, trained_models, horizon):
        """Precision > 0 for the positive class (at least some predictions are correct)."""
        results, _ = trained_models
        precision_positive = results[horizon]["metrics"]["precision"][1]
        assert precision_positive > 0.0, (
            f"{horizon}d model: precision for failures is 0.0."
        )

    def test_metrics_keys_present(self, trained_models):
        results, _ = trained_models
        required_keys = [
            "horizon_days", "accuracy", "roc_auc", "pr_auc",
            "precision", "recall", "f1", "confusion_matrix",
            "feature_importance", "samples_train", "samples_test",
            # ML-3: operator metrics + split-integrity additions
            "operator_temporal", "by_asset", "embargo_days", "embargoed_rows",
        ]
        for h in HORIZONS:
            for key in required_keys:
                assert key in results[h]["metrics"], f"{h}d metrics missing key: {key}"

    def test_feature_importance_populated(self, trained_models):
        results, _ = trained_models
        for h in HORIZONS:
            fi = results[h]["metrics"]["feature_importance"]
            assert len(fi) > 0, f"{h}d feature importance is empty"
            # Top feature importance should be non-trivial
            top_imp = max(fi.values())
            assert top_imp > 0.01, f"{h}d top feature importance suspiciously low: {top_imp}"


# ─────────────────────────────────────────────────────────────────────────────
# ARTIFACT TESTS
# ─────────────────────────────────────────────────────────────────────────────

class TestArtifacts:
    def test_model_pkls_saved(self, trained_models):
        _, tmp = trained_models
        for h in HORIZONS:
            path = tmp / f"rf_{h}d_v0.test.pkl"
            assert path.exists(), f"Model artifact not saved: {path}"

    def test_feature_importance_json_saved(self, trained_models):
        _, tmp = trained_models
        for h in HORIZONS:
            path = tmp / f"feature_importance_{h}d_v0.test.json"
            assert path.exists(), f"Feature importance JSON not saved: {path}"

    def test_feature_importance_json_valid(self, trained_models):
        _, tmp = trained_models
        for h in HORIZONS:
            path = tmp / f"feature_importance_{h}d_v0.test.json"
            data = json.loads(path.read_text())
            assert len(data) > 0
            assert all(isinstance(v, float) for v in data.values())

    def test_label_encoder_used(self, prepared):
        # Encoder correctness is verified by test_category_encoded in
        # TestFeatureEngineering — this confirms the artifact was produced.
        X, _, _, _ = prepared
        assert "category_encoded" in X.columns
