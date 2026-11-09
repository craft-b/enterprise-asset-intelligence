# ml-service/tests/test_operator_thresholds.py
#
# Operator metrics ("recall at HIGH", lead time) must be measured at the HIGH
# cutoff the app actually flags with, which differs per horizon. A single
# 0.60 reported 0% recall at 10 days, where the app flags HIGH at 20%.

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from training.train_model_multihorizon import (  # noqa: E402
    OPERATING_THRESHOLDS, compute_operator_metrics,
)
from engine.predictor_multihorizon import RISK_THRESHOLDS  # noqa: E402

NO_FAILURES = pd.DataFrame({"equipment_id": pd.Series(dtype=int),
                            "maintenance_date": pd.Series(dtype="datetime64[ns]")})


def _metrics(probs, labels, horizon):
    ts = pd.date_range("2026-01-05", periods=len(probs), freq="7D")
    return compute_operator_metrics(np.array(labels), np.array(probs), ts,
                                    np.arange(len(probs)), NO_FAILURES, horizon)


def test_operating_thresholds_are_the_serving_high_cutoffs():
    assert OPERATING_THRESHOLDS == {h: RISK_THRESHOLDS[h]["HIGH"] for h in (10, 30, 60)}


def test_ten_day_recall_counts_failures_above_the_ten_day_cutoff():
    # Both failures sit at 0.25: HIGH for 10 days (>= 0.20), well under 0.60.
    m = _metrics([0.25, 0.25, 0.05, 0.05], [1, 1, 0, 0], 10)
    assert m["operating_threshold"] == 0.20
    assert m["recall_failure_operating"] == 1.0


def test_each_horizon_uses_its_own_cutoff():
    # 0.50 is HIGH at 30 days (>= 0.45) but not at 60 (< 0.70).
    assert _metrics([0.50, 0.05], [1, 0], 30)["recall_failure_operating"] == 1.0
    assert _metrics([0.50, 0.05], [1, 0], 60)["recall_failure_operating"] == 0.0


def test_an_explicit_threshold_still_wins():
    m = _metrics([0.25, 0.05], [1, 0], 10)
    assert compute_operator_metrics(np.array([1, 0]), np.array([0.25, 0.05]),
                                    pd.date_range("2026-01-05", periods=2, freq="7D"),
                                    np.arange(2), NO_FAILURES, 10, threshold=0.5)["recall_failure_operating"] == 0.0
    assert m["recall_failure_operating"] == 1.0
