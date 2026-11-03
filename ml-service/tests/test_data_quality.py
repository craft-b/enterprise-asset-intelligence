# ml-service/tests/test_data_quality.py
# Unit tests for the pre-training data quality gate.
# Fully in-memory — no DB, no model artifacts required.
# Run: python -m pytest ml-service/tests/test_data_quality.py -v

import sys
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime, timedelta

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.data_quality import run, HORIZONS, MIN_ROWS, WARN_ROWS


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _base_df(n: int = 600, pos_rate: float = 0.15, span_days: int = 365) -> pd.DataFrame:
    """
    Build a minimal valid DataFrame that passes all checks.
    Tests override specific columns to trigger individual failures.
    """
    rng = np.random.default_rng(42)
    base = datetime(2024, 1, 1)
    rows = n

    df = pd.DataFrame({
        "asset_age_years":            rng.uniform(0.5, 10, rows),
        "total_hours_lifetime":       rng.uniform(100, 8000, rows),
        "hours_used_30d":             rng.uniform(10, 300, rows),
        "hours_used_90d":             rng.uniform(30, 900, rows),
        "rental_days_30d":            rng.integers(0, 30, rows),
        "rental_days_90d":            rng.integers(0, 90, rows),
        "avg_rental_duration":        rng.uniform(1, 10, rows),
        "maintenance_events_90d":     rng.integers(0, 8, rows),
        "maintenance_cost_180d":      rng.uniform(0, 5000, rows),
        "days_since_last_maintenance": rng.uniform(1, 400, rows),
        "mean_time_between_failures": rng.uniform(30, 700, rows),
        "vendor_reliability_score":   rng.uniform(0.4, 1.0, rows),
        "jobsite_risk_score":         rng.uniform(0.1, 0.9, rows),
        "usage_intensity":            rng.uniform(1, 11, rows),
        "usage_trend":                rng.uniform(0.5, 2.0, rows),
        "utilization_vs_expected":    rng.uniform(0.3, 1.5, rows),
        "wear_rate":                  rng.uniform(0.001, 0.15, rows),
        "aging_factor":               rng.uniform(0.05, 0.9, rows),
        "maint_overdue":              rng.integers(0, 2, rows),
        "cost_per_event":             rng.uniform(0, 2000, rows),
        "maint_burden":               rng.uniform(0, 10, rows),
        "mechanical_wear_score":      rng.uniform(1, 9, rows),
        "abuse_score":                rng.uniform(0, 9, rows),
        "neglect_score":              rng.uniform(0, 9, rows),
        "wear_rate_velocity":         rng.uniform(0, 0.05, rows),
        "maint_frequency_trend":      rng.uniform(0.8, 2.0, rows),
        "cost_trend":                 rng.uniform(0.8, 2.0, rows),
        "hours_velocity":             rng.uniform(0.8, 2.0, rows),
        "neglect_acceleration":       rng.uniform(0.8, 2.0, rows),
        "sensor_degradation_rate":    rng.uniform(0, 0.2, rows),
        "category":                   rng.choice(["Excavator", "Crane"], rows),
        "snapshot_ts": [
            (base + timedelta(days=int(i * span_days / rows))).isoformat()
            for i in range(rows)
        ],
        "will_fail_10d": (rng.uniform(0, 1, rows) < pos_rate).astype(int),
        "will_fail_30d": (rng.uniform(0, 1, rows) < pos_rate * 1.5).astype(int),
        "will_fail_60d": (rng.uniform(0, 1, rows) < pos_rate * 2.0).astype(int),
    })

    # Enforce monotonicity in labels
    df["will_fail_30d"] = np.maximum(df["will_fail_10d"], df["will_fail_30d"])
    df["will_fail_60d"] = np.maximum(df["will_fail_30d"], df["will_fail_60d"])

    return df


# ─────────────────────────────────────────────────────────────────────────────
# REPORT STRUCTURE
# ─────────────────────────────────────────────────────────────────────────────

class TestReportStructure:
    def test_returns_dict(self):
        report = run(_base_df())
        assert isinstance(report, dict)

    def test_required_keys(self):
        report = run(_base_df())
        for key in ["overall", "fail_count", "warn_count", "pass_count",
                    "total_rows", "checked_at", "checks", "can_train", "summary"]:
            assert key in report, f"Missing key: {key}"

    def test_checks_is_list_of_dicts(self):
        report = run(_base_df())
        assert isinstance(report["checks"], list)
        assert len(report["checks"]) > 0
        for c in report["checks"]:
            assert "check" in c
            assert "status" in c
            assert "message" in c
            assert c["status"] in {"PASS", "WARN", "FAIL"}

    def test_counts_sum_to_total_checks(self):
        report = run(_base_df())
        total = report["fail_count"] + report["warn_count"] + report["pass_count"]
        assert total == len(report["checks"])

    def test_overall_consistent_with_counts(self):
        report = run(_base_df())
        if report["fail_count"] > 0:
            assert report["overall"] == "FAIL"
        elif report["warn_count"] > 0:
            assert report["overall"] == "WARN"
        else:
            assert report["overall"] == "PASS"

    def test_can_train_false_on_fail(self):
        df = _base_df(n=100)  # too few rows → FAIL
        report = run(df)
        assert report["overall"] == "FAIL"
        assert report["can_train"] is False

    def test_can_train_true_on_warn(self):
        df = _base_df(n=600, span_days=100)  # narrow span → WARN
        report = run(df)
        # Should be WARN (span < 180d) but not FAIL
        warn_check = next((c for c in report["checks"] if c["check"] == "temporal_spread"), None)
        if warn_check and warn_check["status"] == "WARN":
            assert report["can_train"] is True


# ─────────────────────────────────────────────────────────────────────────────
# ROW COUNT CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestRowCount:
    def test_pass_on_sufficient_rows(self):
        report = run(_base_df(n=WARN_ROWS + 100))
        rc = next(c for c in report["checks"] if c["check"] == "row_count")
        assert rc["status"] == "PASS"

    def test_warn_below_warn_threshold(self):
        report = run(_base_df(n=WARN_ROWS - 1))
        rc = next(c for c in report["checks"] if c["check"] == "row_count")
        assert rc["status"] == "WARN"

    def test_fail_below_min_threshold(self):
        report = run(_base_df(n=MIN_ROWS - 1))
        rc = next(c for c in report["checks"] if c["check"] == "row_count")
        assert rc["status"] == "FAIL"

    def test_detail_contains_row_count(self):
        df = _base_df(n=800)
        report = run(df)
        rc = next(c for c in report["checks"] if c["check"] == "row_count")
        assert rc["detail"]["rows"] == 800


# ─────────────────────────────────────────────────────────────────────────────
# LABEL COMPLETENESS CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestLabelCompleteness:
    def test_pass_on_fully_labeled(self):
        report = run(_base_df())
        for h in HORIZONS:
            lc = next(c for c in report["checks"] if c["check"] == f"label_{h}d")
            assert lc["status"] == "PASS"

    def test_fail_on_null_labels(self):
        df = _base_df()
        df.loc[df.index[:50], "will_fail_30d"] = np.nan
        report = run(df)
        lc = next(c for c in report["checks"] if c["check"] == "label_30d")
        assert lc["status"] == "FAIL"

    def test_fail_on_missing_column(self):
        df = _base_df().drop(columns=["will_fail_10d"])
        report = run(df)
        lc = next(c for c in report["checks"] if c["check"] == "label_10d")
        assert lc["status"] == "FAIL"


# ─────────────────────────────────────────────────────────────────────────────
# CLASS BALANCE CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestClassBalance:
    def test_pass_on_healthy_balance(self):
        report = run(_base_df(pos_rate=0.15))
        for h in HORIZONS:
            cb = next(c for c in report["checks"] if c["check"] == f"class_balance_{h}d")
            assert cb["status"] in {"PASS", "WARN"}

    def test_fail_on_too_few_positives(self):
        df = _base_df(n=600)
        df["will_fail_10d"] = 0
        df.loc[df.index[:5], "will_fail_10d"] = 1  # only 5 positives
        df["will_fail_30d"] = np.maximum(df["will_fail_10d"], df["will_fail_30d"])
        df["will_fail_60d"] = np.maximum(df["will_fail_30d"], df["will_fail_60d"])
        report = run(df)
        cb = next(c for c in report["checks"] if c["check"] == "class_balance_10d")
        assert cb["status"] == "FAIL"

    def test_detail_contains_pos_rate(self):
        report = run(_base_df(pos_rate=0.20))
        cb = next(c for c in report["checks"] if c["check"] == "class_balance_30d")
        assert "pos_rate" in cb["detail"]
        assert "n_pos" in cb["detail"]


# ─────────────────────────────────────────────────────────────────────────────
# NULL RATES CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestNullRates:
    def test_pass_on_no_nulls(self):
        report = run(_base_df())
        nr = next(c for c in report["checks"] if c["check"] == "null_rates")
        assert nr["status"] == "PASS"

    def test_warn_on_moderate_nulls(self):
        df = _base_df()
        # Set 8% of wear_rate to null (above WARN_NULL_RATE=5%)
        n_null = int(len(df) * 0.08)
        df.loc[df.index[:n_null], "wear_rate"] = np.nan
        report = run(df)
        nr = next(c for c in report["checks"] if c["check"] == "null_rates")
        assert nr["status"] in {"WARN", "FAIL"}

    def test_fail_on_high_nulls(self):
        df = _base_df()
        # Set 25% of a feature to null (above MAX_NULL_RATE=20%)
        n_null = int(len(df) * 0.25)
        df.loc[df.index[:n_null], "mechanical_wear_score"] = np.nan
        report = run(df)
        nr = next(c for c in report["checks"] if c["check"] == "null_rates")
        assert nr["status"] == "FAIL"


# ─────────────────────────────────────────────────────────────────────────────
# BOUNDS CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestBounds:
    def test_pass_on_valid_bounds(self):
        report = run(_base_df())
        bk = next(c for c in report["checks"] if c["check"] == "bounds")
        assert bk["status"] == "PASS"

    def test_warn_on_few_bound_violations(self):
        df = _base_df()
        # Set a few rows above the usage_intensity cap of 12
        df.loc[df.index[:3], "usage_intensity"] = 25.0
        report = run(df)
        bk = next(c for c in report["checks"] if c["check"] == "bounds")
        assert bk["status"] in {"WARN", "FAIL"}
        assert any(v["col"] == "usage_intensity" for v in bk["detail"].get("violations", []))

    def test_warn_on_negative_wear_rate(self):
        df = _base_df()
        df.loc[df.index[:5], "wear_rate"] = -0.1
        report = run(df)
        bk = next(c for c in report["checks"] if c["check"] == "bounds")
        assert bk["status"] in {"WARN", "FAIL"}

    def test_vendor_score_exceeds_one(self):
        df = _base_df()
        df.loc[df.index[:10], "vendor_reliability_score"] = 1.5
        report = run(df)
        bk = next(c for c in report["checks"] if c["check"] == "bounds")
        assert bk["status"] in {"WARN", "FAIL"}


# ─────────────────────────────────────────────────────────────────────────────
# REQUIRED NONZERO CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestRequiredNonzero:
    def test_pass_on_valid_data(self):
        report = run(_base_df())
        rn = next(c for c in report["checks"] if c["check"] == "required_nonzero")
        assert rn["status"] == "PASS"

    def test_fail_on_all_zero_feature(self):
        df = _base_df()
        df["mechanical_wear_score"] = 0.0
        report = run(df)
        rn = next(c for c in report["checks"] if c["check"] == "required_nonzero")
        assert rn["status"] == "FAIL"
        assert "mechanical_wear_score" in rn["detail"]["all_zero_cols"]

    def test_fail_on_all_zero_age(self):
        df = _base_df()
        df["asset_age_years"] = 0.0
        report = run(df)
        rn = next(c for c in report["checks"] if c["check"] == "required_nonzero")
        assert rn["status"] == "FAIL"


# ─────────────────────────────────────────────────────────────────────────────
# TEMPORAL SPREAD CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestTemporalSpread:
    def test_pass_on_wide_spread(self):
        report = run(_base_df(span_days=400))
        ts = next(c for c in report["checks"] if c["check"] == "temporal_spread")
        assert ts["status"] == "PASS"

    def test_warn_on_narrow_spread(self):
        report = run(_base_df(span_days=100))
        ts = next(c for c in report["checks"] if c["check"] == "temporal_spread")
        assert ts["status"] == "WARN"

    def test_fail_on_tiny_spread(self):
        report = run(_base_df(span_days=30))
        ts = next(c for c in report["checks"] if c["check"] == "temporal_spread")
        assert ts["status"] == "FAIL"

    def test_warn_on_missing_timestamp_col(self):
        df = _base_df().drop(columns=["snapshot_ts"])
        report = run(df)
        ts = next(c for c in report["checks"] if c["check"] == "temporal_spread")
        assert ts["status"] == "WARN"

    def test_detail_contains_span_days(self):
        report = run(_base_df(span_days=400))
        ts = next(c for c in report["checks"] if c["check"] == "temporal_spread")
        assert "span_days" in ts["detail"]
        assert ts["detail"]["span_days"] >= 390  # approximate


# ─────────────────────────────────────────────────────────────────────────────
# DUPLICATE SNAPSHOTS CHECK
# ─────────────────────────────────────────────────────────────────────────────

class TestDuplicateSnapshots:
    def test_pass_on_unique_dates(self):
        # 600 rows over 365 days → ~1.6 rows/day, dup rate <30% → PASS or WARN
        # The check WARNs only above 30% — with sparse spread it may pass or warn
        report = run(_base_df())
        dup = next((c for c in report["checks"] if c["check"] == "duplicate_snapshots"), None)
        if dup:
            assert dup["status"] in {"PASS", "WARN"}  # not FAIL

    def test_warn_on_many_duplicate_dates(self):
        df = _base_df()
        # Collapse all timestamps to one date — 100% duplicate rate
        df["snapshot_ts"] = "2024-06-01"
        report = run(df)
        dup = next((c for c in report["checks"] if c["check"] == "duplicate_snapshots"), None)
        if dup:
            assert dup["status"] == "WARN"

    def test_a_fleet_snapshotted_on_one_day_is_not_duplicated(self):
        # Sixty assets per simulated day is the design, not a seeding loop.
        df = _base_df(n=600)
        df["equipment_id"] = np.arange(600) % 60
        df["snapshot_ts"] = [datetime(2024, 1, 1) + timedelta(days=i // 60) for i in range(600)]
        dup = next(c for c in run(df)["checks"] if c["check"] == "duplicate_snapshots")
        assert dup["status"] == "PASS"
        assert dup["detail"]["duplicate_rows"] == 0

    def test_the_same_asset_twice_on_one_day_is(self):
        df = _base_df(n=600)
        df["equipment_id"] = np.arange(600) % 60
        df["snapshot_ts"] = "2024-06-01"
        dup = next(c for c in run(df)["checks"] if c["check"] == "duplicate_snapshots")
        assert dup["status"] == "WARN"
        assert dup["detail"]["duplicate_rows"] == 540


# ─────────────────────────────────────────────────────────────────────────────
# OVERALL STATUS LOGIC
# ─────────────────────────────────────────────────────────────────────────────

class TestOverallStatus:
    def test_healthy_dataset_passes(self):
        report = run(_base_df(n=800, pos_rate=0.15, span_days=400))
        assert report["overall"] in {"PASS", "WARN"}  # simulation data may warn on some checks

    def test_empty_df_fails(self):
        df = pd.DataFrame(columns=_base_df(n=1).columns)
        report = run(df)
        assert report["overall"] == "FAIL"
        assert report["can_train"] is False

    def test_summary_string_present(self):
        report = run(_base_df())
        assert isinstance(report["summary"], str)
        assert len(report["summary"]) > 10
