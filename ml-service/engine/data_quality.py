# ml-service/engine/data_quality.py
# Pre-training data quality gate.
#
# ── Why this exists ───────────────────────────────────────────────────────────
# A training pipeline that only validates row count can silently produce
# degraded models when:
#   - A schema migration adds a new column and backfill is incomplete
#     (high null rate on a key feature → model learns noise instead of signal)
#   - A bug in the feature engineering pipeline produces impossible values
#     (e.g. wear_rate < 0, usage_intensity > 12)
#   - Class imbalance worsens beyond what class weighting can rescue
#     (< 5 positives in 60d window → model predicts all-negative)
#   - The temporal distribution collapses (all snapshots from a single week
#     → TimeSeriesSplit has no temporal spread → CV metrics are meaningless)
#   - The reference distribution diverges so far from training data that
#     drift metrics will immediately fire on first batch (training on a
#     different population than inference)
#
# This module runs all checks before training begins and returns a structured
# report. Checks are classified as:
#   PASS    — within acceptable bounds
#   WARN    — degraded but training can proceed; flag for review
#   FAIL    — training should be blocked to prevent a bad model
#
# The gate is intentionally NOT a hard crash — callers decide whether to
# abort. The training script treats FAIL as an abort, but the API endpoint
# can return the report to a human reviewer.
# ─────────────────────────────────────────────────────────────────────────────

import numpy as np
import pandas as pd
from datetime import datetime, timezone

# ── Thresholds ────────────────────────────────────────────────────────────────
MIN_ROWS           = 500    # FAIL below this
WARN_ROWS          = 1000   # WARN below this
MAX_NULL_RATE      = 0.20   # FAIL if any key feature > 20% null
WARN_NULL_RATE     = 0.05   # WARN if any key feature > 5% null
MIN_POSITIVES      = 10     # FAIL if any horizon has < 10 positives
WARN_POSITIVES     = 30     # WARN if any horizon has < 30 positives
MAX_IMBALANCE      = 0.02   # FAIL if positive rate < 2%
WARN_IMBALANCE     = 0.05   # WARN if positive rate < 5%
MIN_DATE_SPAN_DAYS = 60     # FAIL if temporal span < 60 days (CV meaningless)
WARN_DATE_SPAN_DAYS= 180    # WARN if < 180 days
MAX_OUTLIER_RATE   = 0.10   # WARN if > 10% of rows have extreme outliers

# Features that must never be all-zero (would indicate a broken pipeline)
REQUIRED_NONZERO = [
    "asset_age_years",
    "total_hours_lifetime",
    "vendor_reliability_score",
    "mechanical_wear_score",
    "neglect_score",
]

# Numeric bounds — (min, max) outside which a value is physically impossible
BOUNDS = {
    "asset_age_years":       (0,    100),
    "usage_intensity":       (0,    12),   # hours/day, capped in schema
    "vendor_reliability_score": (0, 1),
    "jobsite_risk_score":    (0,    1),
    "wear_rate":             (0,    None),
    "aging_factor":          (0,    1),
    "maint_overdue":         (0,    1),
}

HORIZONS = [10, 30, 60]


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def run(df: pd.DataFrame) -> dict:
    """
    Run all data quality checks against a labeled training DataFrame.
    Returns a report dict with per-check results and an overall status.

    Expected columns: all FEATURE_COLS from train_model_multihorizon.py
    plus will_fail_10d, will_fail_30d, will_fail_60d, snapshot_ts.
    """
    checks = []

    checks += _check_row_count(df)
    checks += _check_label_completeness(df)
    checks += _check_class_balance(df)
    checks += _check_null_rates(df)
    checks += _check_bounds(df)
    checks += _check_required_nonzero(df)
    checks += _check_temporal_spread(df)
    checks += _check_duplicate_snapshots(df)

    # Overall status: worst of all checks
    statuses = [c["status"] for c in checks]
    if "FAIL" in statuses:
        overall = "FAIL"
    elif "WARN" in statuses:
        overall = "WARN"
    else:
        overall = "PASS"

    fail_count = sum(1 for s in statuses if s == "FAIL")
    warn_count = sum(1 for s in statuses if s == "WARN")

    return {
        "overall":     overall,
        "fail_count":  fail_count,
        "warn_count":  warn_count,
        "pass_count":  len(checks) - fail_count - warn_count,
        "total_rows":  len(df),
        "checked_at":  datetime.now(timezone.utc).isoformat(),
        "checks":      checks,
        "can_train":   overall != "FAIL",
        "summary":     _build_summary(overall, fail_count, warn_count, len(checks)),
    }


# ─────────────────────────────────────────────────────────────────────────────
# INDIVIDUAL CHECKS
# ─────────────────────────────────────────────────────────────────────────────

def _check_row_count(df: pd.DataFrame) -> list[dict]:
    n = len(df)
    if n < MIN_ROWS:
        return [_check("row_count", "FAIL",
            f"{n:,} labeled rows — minimum {MIN_ROWS:,} required for stable training",
            {"rows": n, "minimum": MIN_ROWS})]
    if n < WARN_ROWS:
        return [_check("row_count", "WARN",
            f"{n:,} labeled rows — recommend ≥{WARN_ROWS:,} for reliable CV metrics",
            {"rows": n, "recommended": WARN_ROWS})]
    return [_check("row_count", "PASS", f"{n:,} labeled rows", {"rows": n})]


def _check_label_completeness(df: pd.DataFrame) -> list[dict]:
    results = []
    for h in HORIZONS:
        col = f"will_fail_{h}d"
        if col not in df.columns:
            results.append(_check(f"label_{h}d", "FAIL",
                f"Column {col} is missing entirely", {}))
            continue
        null_count = df[col].isna().sum()
        total = len(df)
        null_rate = null_count / total if total else 0
        if null_rate > 0:
            results.append(_check(f"label_{h}d", "FAIL",
                f"{null_count:,}/{total:,} rows have null {col} — labelSnapshots() may not have run",
                {"null_count": int(null_count), "null_rate": round(null_rate, 4)}))
        else:
            results.append(_check(f"label_{h}d", "PASS",
                f"All {total:,} rows labeled for {h}d window",
                {"total": total}))
    return results


def _check_class_balance(df: pd.DataFrame) -> list[dict]:
    results = []
    for h in HORIZONS:
        col = f"will_fail_{h}d"
        if col not in df.columns:
            continue
        y = df[col].dropna()
        n_pos = int(y.sum())
        n_total = len(y)
        rate = n_pos / n_total if n_total else 0

        if n_pos < MIN_POSITIVES:
            results.append(_check(f"class_balance_{h}d", "FAIL",
                f"{h}d: only {n_pos} positive examples — training requires ≥{MIN_POSITIVES}. "
                f"Run seedFailureEvents or advance simulation cursor.",
                {"n_pos": n_pos, "n_total": n_total, "pos_rate": round(rate, 4)}))
        elif rate < MAX_IMBALANCE:
            results.append(_check(f"class_balance_{h}d", "FAIL",
                f"{h}d: positive rate {rate*100:.2f}% below {MAX_IMBALANCE*100:.0f}% floor — "
                f"model will predict all-negative",
                {"n_pos": n_pos, "n_total": n_total, "pos_rate": round(rate, 4)}))
        elif n_pos < WARN_POSITIVES or rate < WARN_IMBALANCE:
            results.append(_check(f"class_balance_{h}d", "WARN",
                f"{h}d: {n_pos} positives ({rate*100:.1f}%) — low, so estimates will be noisy",
                {"n_pos": n_pos, "n_total": n_total, "pos_rate": round(rate, 4)}))
        else:
            results.append(_check(f"class_balance_{h}d", "PASS",
                f"{h}d: {n_pos} positives ({rate*100:.1f}%)",
                {"n_pos": n_pos, "n_total": n_total, "pos_rate": round(rate, 4)}))
    return results


def _check_null_rates(df: pd.DataFrame) -> list[dict]:
    """Check null rates for numeric feature columns (excluding label/ts cols)."""
    label_cols = {"will_fail_10d", "will_fail_30d", "will_fail_60d", "snapshot_ts", "category"}
    feature_cols = [c for c in df.columns if c not in label_cols]
    numeric_cols = df[feature_cols].select_dtypes(include=[np.number]).columns.tolist()

    worst_col   = None
    worst_rate  = 0.0
    high_null   = []

    for col in numeric_cols:
        null_rate = df[col].isna().sum() / len(df)
        if null_rate > worst_rate:
            worst_rate = null_rate
            worst_col  = col
        if null_rate > WARN_NULL_RATE:
            high_null.append({"col": col, "null_rate": round(null_rate, 4)})

    high_null.sort(key=lambda x: -x["null_rate"])

    if worst_rate > MAX_NULL_RATE:
        return [_check("null_rates", "FAIL",
            f"Feature '{worst_col}' has {worst_rate*100:.1f}% nulls (>{MAX_NULL_RATE*100:.0f}% threshold). "
            f"{len(high_null)} features exceed warning threshold.",
            {"worst_col": worst_col, "worst_rate": round(worst_rate, 4), "high_null_features": high_null[:5]})]
    if high_null:
        return [_check("null_rates", "WARN",
            f"{len(high_null)} features have >{WARN_NULL_RATE*100:.0f}% nulls "
            f"(will be filled with 0 during training)",
            {"high_null_features": high_null[:5]})]
    return [_check("null_rates", "PASS",
        f"All {len(numeric_cols)} numeric features within null threshold",
        {"checked": len(numeric_cols)})]


def _check_bounds(df: pd.DataFrame) -> list[dict]:
    """Detect physically impossible values."""
    violations = []
    for col, (lo, hi) in BOUNDS.items():
        if col not in df.columns:
            continue
        series = pd.to_numeric(df[col], errors="coerce").dropna()
        if lo is not None:
            n_below = int((series < lo).sum())
            if n_below > 0:
                violations.append({"col": col, "issue": f"{n_below} rows below {lo}", "count": n_below})
        if hi is not None:
            n_above = int((series > hi).sum())
            if n_above > 0:
                violations.append({"col": col, "issue": f"{n_above} rows above {hi}", "count": n_above})

    if not violations:
        return [_check("bounds", "PASS",
            f"All {len(BOUNDS)} bounded features within physical limits", {})]

    total_violations = sum(v["count"] for v in violations)
    rate = total_violations / len(df)
    status = "FAIL" if rate > MAX_OUTLIER_RATE else "WARN"
    return [_check("bounds", status,
        f"{len(violations)} bound violation(s) across {total_violations} rows "
        f"({rate*100:.1f}% of dataset) — check feature engineering pipeline",
        {"violations": violations[:5]})]


def _check_required_nonzero(df: pd.DataFrame) -> list[dict]:
    """Columns that should never be uniformly zero (broken pipeline signal)."""
    all_zero = []
    for col in REQUIRED_NONZERO:
        if col not in df.columns:
            continue
        series = pd.to_numeric(df[col], errors="coerce").fillna(0)
        if (series == 0).all():
            all_zero.append(col)

    if all_zero:
        return [_check("required_nonzero", "FAIL",
            f"Columns are all-zero — feature pipeline may be broken: {all_zero}",
            {"all_zero_cols": all_zero})]
    return [_check("required_nonzero", "PASS",
        f"All {len(REQUIRED_NONZERO)} required-nonzero features have signal", {})]


def _check_temporal_spread(df: pd.DataFrame) -> list[dict]:
    """Ensure snapshots span enough time for TimeSeriesSplit to be meaningful."""
    if "snapshot_ts" not in df.columns:
        return [_check("temporal_spread", "WARN",
            "No snapshot_ts column — cannot verify temporal spread", {})]

    ts = pd.to_datetime(df["snapshot_ts"], errors="coerce").dropna()
    if len(ts) == 0:
        return [_check("temporal_spread", "WARN", "snapshot_ts column has no parseable dates", {})]

    span_days = (ts.max() - ts.min()).days
    n_distinct_weeks = ts.dt.to_period("W").nunique()

    if span_days < MIN_DATE_SPAN_DAYS:
        return [_check("temporal_spread", "FAIL",
            f"Snapshots span only {span_days} days — minimum {MIN_DATE_SPAN_DAYS} required. "
            f"TimeSeriesSplit CV will have no meaningful temporal structure.",
            {"span_days": span_days, "distinct_weeks": int(n_distinct_weeks),
             "earliest": str(ts.min().date()), "latest": str(ts.max().date())})]
    if span_days < WARN_DATE_SPAN_DAYS:
        return [_check("temporal_spread", "WARN",
            f"Snapshots span {span_days} days ({n_distinct_weeks} weeks) — "
            f"recommend ≥{WARN_DATE_SPAN_DAYS} days for robust CV",
            {"span_days": span_days, "distinct_weeks": int(n_distinct_weeks)})]
    return [_check("temporal_spread", "PASS",
        f"Snapshots span {span_days} days across {n_distinct_weeks} weeks",
        {"span_days": span_days, "distinct_weeks": int(n_distinct_weeks),
         "earliest": str(ts.min().date()), "latest": str(ts.max().date())})]


def _check_duplicate_snapshots(df: pd.DataFrame) -> list[dict]:
    """Flag equipment IDs with suspiciously many snapshots on the same date."""
    if "snapshot_ts" not in df.columns:
        return []

    # A duplicate is the same asset twice on one date. Every asset is
    # snapshotted on the same simulated day, so counting dates alone flagged
    # 98% of a sixty-unit fleet as duplicates when none were. load_training_data
    # selects equipment_id; date-only remains the fallback without it.
    dates = pd.to_datetime(df["snapshot_ts"], errors="coerce").dt.date
    if "equipment_id" in df.columns:
        keys = pd.DataFrame({"equipment_id": df["equipment_id"], "date": dates})
        dup_count = int(keys.duplicated().sum())
        what = "repeat an asset's snapshot date"
    else:
        dup_count = int(dates.duplicated().sum())
        what = "share a snapshot date with another row"
    total = len(df)
    dup_rate = dup_count / total if total else 0

    if dup_rate > 0.30:
        return [_check("duplicate_snapshots", "WARN",
            f"{dup_count:,} rows ({dup_rate*100:.1f}%) {what} — "
            f"may indicate a seeding loop ran multiple times",
            {"duplicate_rows": dup_count, "dup_rate": round(dup_rate, 4)})]
    return [_check("duplicate_snapshots", "PASS",
        f"Snapshot date distribution looks normal ({dup_rate*100:.1f}% duplicate rows)",
        {"duplicate_rows": dup_count})]


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _check(name: str, status: str, message: str, detail: dict) -> dict:
    return {"check": name, "status": status, "message": message, "detail": detail}


def _build_summary(overall: str, fails: int, warns: int, total: int) -> str:
    if overall == "PASS":
        return f"All {total} checks passed — data is ready for training."
    if overall == "WARN":
        return (
            f"{warns} warning(s) across {total} checks — training can proceed "
            f"but review flagged issues before promoting to production."
        )
    return (
        f"{fails} failure(s) across {total} checks — training blocked. "
        f"Fix the FAIL items before retraining."
    )
