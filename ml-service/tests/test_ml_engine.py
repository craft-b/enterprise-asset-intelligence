# ml-service/tests/test_ml_engine.py
# Core tests for the ML inference engine (MultiHorizonPredictor).
# Requires trained model artifacts in ml-service/registry/.
# Run from project root: python -m pytest ml-service/tests/test_ml_engine.py -v

import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api.schemas.prediction import SnapshotInput
from engine.predictor_multihorizon import MultiHorizonPredictor, risk_trend, worst_horizon

HORIZONS = [10, 30, 60]


# ─────────────────────────────────────────────────────────────────────────────
# FIXTURES
# ─────────────────────────────────────────────────────────────────────────────

def _has_trained_model() -> bool:
    reg = Path(__file__).parent.parent / "registry"
    return bool(list(reg.glob("rf_30d_*.pkl")))


@pytest.fixture(scope="module")
def predictor():
    """Load predictor once — mirrors production startup. Skips when no model is
    present (OPS-2: pickles are build artifacts, untracked from git — a fresh
    clone trains one via the seed pipeline)."""
    if not _has_trained_model():
        pytest.skip("no trained model in ml-service/registry/ — run training first")
    return MultiHorizonPredictor()


@pytest.fixture
def low_risk_snapshot():
    return {
        "equipment_id": 1,
        "asset_age_years": 1.5,
        "category": "Excavator",
        "total_hours_lifetime": 800.0,
        "hours_used_30d": 80.0,
        "hours_used_90d": 240.0,
        "rental_days_30d": 10,
        "rental_days_90d": 30,
        "avg_rental_duration": 3.0,
        "maintenance_events_90d": 1,
        "maintenance_cost_180d": 300.0,
        "avg_downtime_per_event": 1.0,
        "days_since_last_maintenance": 20.0,
        "mean_time_between_failures": 500.0,
        "vendor_reliability_score": 0.95,
        "jobsite_risk_score": 0.30,
        "usage_intensity": 6.0,
        "usage_trend": 0.9,
        "utilization_vs_expected": 0.75,
        "wear_rate": 0.01,
        "aging_factor": 0.10,
        "maint_overdue": 0,
        "cost_per_event": 300.0,
        "maint_burden": 0.5,
        "mechanical_wear_score": 1.5,
        "abuse_score": 0.8,
        "neglect_score": 0.5,
    }


@pytest.fixture
def high_risk_snapshot():
    return {
        "equipment_id": 2,
        "asset_age_years": 9.0,
        "category": "Excavator",
        "total_hours_lifetime": 5800.0,
        "hours_used_30d": 240.0,
        "hours_used_90d": 720.0,
        "rental_days_30d": 28,
        "rental_days_90d": 85,
        "avg_rental_duration": 3.0,
        "maintenance_events_90d": 0,     # neglected: nothing serviced in 90 days
        "maintenance_cost_180d": 0.0,
        "avg_downtime_per_event": 3.0,
        "days_since_last_maintenance": 210.0,
        "mean_time_between_failures": 150.0,
        "vendor_reliability_score": 0.60,
        "jobsite_risk_score": 0.85,
        "usage_intensity": 11.5,
        "usage_trend": 1.8,
        "utilization_vs_expected": 1.4,
        "wear_rate": 0.09,
        "aging_factor": 0.60,
        "maint_overdue": 1,
        "cost_per_event": 0.0,
        "maint_burden": 0.0,
        "mechanical_wear_score": 8.5,
        "abuse_score": 7.2,
        "neglect_score": 8.8,
        "warning_count": 15,
        "error_code_count": 3,
    }


# ─────────────────────────────────────────────────────────────────────────────
# LOADING
# ─────────────────────────────────────────────────────────────────────────────

class TestLoading:
    def test_predictor_loads(self, predictor):
        assert predictor is not None

    def test_all_horizons_loaded(self, predictor):
        for h in HORIZONS:
            assert h in predictor.models, f"Missing model for {h}d horizon"

    def test_version_set(self, predictor):
        assert predictor.version is not None
        assert predictor.version.startswith("v")

    def test_feature_names_loaded(self, predictor):
        assert len(predictor.feature_names) > 0

    def test_label_encoder_loaded(self, predictor):
        assert predictor.label_encoder is not None

    def test_feature_importance_all_horizons(self, predictor):
        for h in HORIZONS:
            assert h in predictor.feature_importance
            assert len(predictor.feature_importance[h]) > 0

    def test_clip_thresholds_loaded(self, predictor):
        # May be None on first run without explicit save, but should not crash
        # If loaded, must be a dict
        if predictor.clip_thresholds is not None:
            assert isinstance(predictor.clip_thresholds, dict)
            assert len(predictor.clip_thresholds) > 0


# ─────────────────────────────────────────────────────────────────────────────
# INFERENCE — single snapshot
# ─────────────────────────────────────────────────────────────────────────────

class TestInference:
    def test_returns_dict(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        assert isinstance(result, dict)

    def test_all_horizons_present(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        for h in HORIZONS:
            assert f"{h}d" in preds, f"Missing {h}d key in predictions"

    def test_probabilities_in_range(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        for h in HORIZONS:
            prob = preds[f"{h}d"]["failure_probability"]
            assert 0.0 <= prob <= 1.0, f"{h}d probability {prob} out of [0,1]"

    def test_risk_levels_valid(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        for h in HORIZONS:
            assert preds[f"{h}d"]["risk_level"] in {"LOW", "MEDIUM", "HIGH"}

    def test_risk_scores_in_range(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        for h in HORIZONS:
            score = preds[f"{h}d"]["risk_score"]
            assert 0 <= score <= 100, f"{h}d risk_score {score} out of [0,100]"

    def test_top_risk_drivers_present(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        for h in HORIZONS:
            drivers = preds[f"{h}d"]["top_risk_drivers"]
            # drivers is a dict mapping feature description → contribution score
            assert isinstance(drivers, dict)
            assert len(drivers) > 0

    def test_equipment_id_preserved(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        assert result.get("equipment_id") == low_risk_snapshot["equipment_id"]

    def test_trend_field_present(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        assert "risk_trend" in result
        assert result["risk_trend"] in {"INCREASING", "STABLE"}


class TestTrendAndWorstHorizon:
    """Cumulative windows always widen, so neither may lean on raw probability."""

    @staticmethod
    def _preds(*rows):
        return {
            f"{h}d": {"risk_level": level, "failure_probability": p}
            for h, (level, p) in zip(HORIZONS, rows)
        }

    def test_low_everywhere_is_stable_despite_a_wide_gap(self):
        preds = self._preds(("LOW", 0.04), ("LOW", 0.10), ("LOW", 0.24))
        assert risk_trend(preds) == "STABLE"

    def test_a_worse_band_at_60_days_is_increasing(self):
        preds = self._preds(("LOW", 0.09), ("MEDIUM", 0.30), ("MEDIUM", 0.50))
        assert risk_trend(preds) == "INCREASING"

    def test_the_worst_band_beats_the_highest_probability(self):
        preds = self._preds(("HIGH", 0.21), ("MEDIUM", 0.40), ("MEDIUM", 0.60))
        assert worst_horizon(preds) == "10d"

    def test_within_one_band_the_highest_probability_wins(self):
        preds = self._preds(("LOW", 0.04), ("LOW", 0.10), ("LOW", 0.24))
        assert worst_horizon(preds) == "60d"


# ─────────────────────────────────────────────────────────────────────────────
# MONOTONICITY
# ─────────────────────────────────────────────────────────────────────────────

class TestMonotonicity:
    """
    P(fail≤10d) ≤ P(fail≤30d) ≤ P(fail≤60d) must hold after enforcement.
    Violations before enforcement are expected (independent models) —
    the predictor must correct them.
    """

    def test_monotonicity_low_risk(self, predictor, low_risk_snapshot):
        result = predictor.predict_multi_horizon(low_risk_snapshot)
        preds = result["predictions"]
        p10 = preds["10d"]["failure_probability"]
        p30 = preds["30d"]["failure_probability"]
        p60 = preds["60d"]["failure_probability"]
        assert p10 <= p30 + 1e-9, f"Monotonicity violated: p10={p10:.4f} > p30={p30:.4f}"
        assert p30 <= p60 + 1e-9, f"Monotonicity violated: p30={p30:.4f} > p60={p60:.4f}"

    def test_monotonicity_high_risk(self, predictor, high_risk_snapshot):
        result = predictor.predict_multi_horizon(high_risk_snapshot)
        preds = result["predictions"]
        p10 = preds["10d"]["failure_probability"]
        p30 = preds["30d"]["failure_probability"]
        p60 = preds["60d"]["failure_probability"]
        assert p10 <= p30 + 1e-9
        assert p30 <= p60 + 1e-9


# ─────────────────────────────────────────────────────────────────────────────
# RISK ORDERING
# ─────────────────────────────────────────────────────────────────────────────

class TestRiskOrdering:
    """High-risk equipment should score higher than low-risk at every horizon."""

    def test_high_scores_higher_than_low_at_30d(
        self, predictor, low_risk_snapshot, high_risk_snapshot
    ):
        low  = predictor.predict_multi_horizon(low_risk_snapshot)["predictions"]
        high = predictor.predict_multi_horizon(high_risk_snapshot)["predictions"]
        assert high["30d"]["failure_probability"] > low["30d"]["failure_probability"], (
            f"High-risk 30d ({high['30d']['failure_probability']:.3f}) should exceed "
            f"low-risk 30d ({low['30d']['failure_probability']:.3f})"
        )

    def test_low_risk_is_not_high_at_10d(self, predictor, low_risk_snapshot):
        preds = predictor.predict_multi_horizon(low_risk_snapshot)["predictions"]
        assert preds["10d"]["risk_level"] != "HIGH", (
            f"Well-maintained 1.5y equipment should not be 10d HIGH. "
            f"Got {preds['10d']['risk_level']} ({preds['10d']['failure_probability']:.3f})"
        )

    def test_high_risk_is_not_low_at_30d(self, predictor, high_risk_snapshot):
        preds = predictor.predict_multi_horizon(high_risk_snapshot)["predictions"]
        assert preds["30d"]["risk_level"] != "LOW", (
            f"Neglected 9y equipment should not be 30d LOW. "
            f"Got {preds['30d']['risk_level']} ({preds['30d']['failure_probability']:.3f})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# BATCH INFERENCE
# ─────────────────────────────────────────────────────────────────────────────

class TestBatchInference:
    def test_batch_returns_list(self, predictor, low_risk_snapshot, high_risk_snapshot):
        results = predictor.predict_multi_horizon_batch(
            [low_risk_snapshot, high_risk_snapshot]
        )
        assert isinstance(results, list)
        assert len(results) == 2

    def test_batch_preserves_equipment_ids(self, predictor, low_risk_snapshot, high_risk_snapshot):
        results = predictor.predict_multi_horizon_batch(
            [low_risk_snapshot, high_risk_snapshot]
        )
        ids = [r.get("equipment_id") for r in results]
        assert low_risk_snapshot["equipment_id"] in ids
        assert high_risk_snapshot["equipment_id"] in ids

    def test_batch_all_have_horizons(self, predictor, low_risk_snapshot, high_risk_snapshot):
        results = predictor.predict_multi_horizon_batch(
            [low_risk_snapshot, high_risk_snapshot]
        )
        for r in results:
            preds = r["predictions"]
            for h in HORIZONS:
                assert f"{h}d" in preds


# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA VALIDATION
# ─────────────────────────────────────────────────────────────────────────────

class TestSchema:
    def test_valid_snapshot_passes(self, low_risk_snapshot):
        snap = SnapshotInput(**low_risk_snapshot)
        assert snap.equipment_id == low_risk_snapshot["equipment_id"]

    def test_usage_intensity_capped(self):
        with pytest.raises(Exception):
            SnapshotInput(
                equipment_id=1, asset_age_years=1.0, category="Excavator",
                total_hours_lifetime=100.0, hours_used_30d=10.0, hours_used_90d=30.0,
                rental_days_30d=5, rental_days_90d=15, avg_rental_duration=3.0,
                maintenance_events_90d=0, maintenance_cost_180d=0.0,
                usage_intensity=25.0,  # invalid
                usage_trend=1.0, utilization_vs_expected=1.0, wear_rate=0.01,
                aging_factor=0.1, maint_overdue=0, cost_per_event=0.0,
                maint_burden=0.0, mechanical_wear_score=1.0, abuse_score=1.0,
                neglect_score=1.0,
            )

    def test_optional_sensor_fields_default_none(self, low_risk_snapshot):
        snap = SnapshotInput(**low_risk_snapshot)
        assert snap.avg_vibration is None
        assert snap.error_code_count is None


# ─────────────────────────────────────────────────────────────────────────────
# PROJECTION ENGINE (ML-8)
# The forward projection must age only raw fields and let the predictor derive
# the rest. Its acceptance property: a day-0 projection equals a live prediction.
# ─────────────────────────────────────────────────────────────────────────────

class TestProjector:
    def test_day0_equals_live_prediction(self, predictor, low_risk_snapshot):
        from engine.projector import project
        live = predictor.predict_multi_horizon(low_risk_snapshot)["predictions"]
        curve = project(low_risk_snapshot, predictor)["curve"]
        day0 = curve[0]
        assert day0["day"] == 0
        for h in HORIZONS:
            assert day0[f"{h}d"] == round(live[f"{h}d"]["failure_probability"], 4), (
                f"day-0 projection diverges from live prediction at {h}d — "
                "the projector is feeding the model different inputs than serve."
            )

    def test_curve_ends_at_max_no_overshoot(self, predictor, low_risk_snapshot):
        from engine.projector import project
        curve = project(low_risk_snapshot, predictor)["curve"]
        days = [pt["day"] for pt in curve]
        assert days[0] == 0 and days[-1] == 60, f"curve must span 0..60, got {days}"
        assert all(d <= 60 for d in days), f"projection overshoots past 60: {days}"

    def test_probabilities_stay_in_unit_interval(self, predictor, low_risk_snapshot):
        from engine.projector import project
        for pt in project(low_risk_snapshot, predictor)["curve"]:
            for h in HORIZONS:
                assert 0.0 <= pt[f"{h}d"] <= 1.0
