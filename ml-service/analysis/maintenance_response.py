"""Does logging a service move the score?

Scores one unit as it stands -- overdue for service -- and again as it would
read the day after an inspection, a minor service and a major service, with
the maintenance features recomputed the way feature-engineering-enhanced.ts
computes them. A maintenance model that answers the same number to all four
is not a maintenance model; the v1.17 champion did exactly that.

Usage:
    python -m analysis.maintenance_response [version ...]
"""

from __future__ import annotations

import contextlib
import io
import sys

from engine.predictor_multihorizon import MultiHorizonPredictor

INTERVAL_DAYS = 120  # maintenance_config for Generator

# EQ-055 on the demo fleet: a five-year-old generator worked hard, last
# serviced five months ago.
BASE = {
    "equipment_id": 55,
    "category": "Generator",
    "asset_age_years": 5.0,
    "total_hours_lifetime": 5900.0,
    "hours_used_30d": 0.0,
    "hours_used_90d": 0.0,
    "rental_days_30d": 0,
    "rental_days_90d": 0,
    "avg_rental_duration": 0,
    "maintenance_events_90d": 0,
    "maintenance_cost_180d": 0.0,
    "avg_downtime_per_event": 0,
    "days_since_last_maintenance": 150.0,
    "mean_time_between_failures": 500.0,
    "vendor_reliability_score": 0.95,
    "jobsite_risk_score": 0.5,
    "usage_intensity": 0,
    "usage_trend": 1.0,
    "utilization_vs_expected": 0,
    "wear_rate": 5900.0 / (5.0 * 8760),
    "aging_factor": 0.5,
    "wear_rate_velocity": 0.0,
    "maint_frequency_trend": 1.0,
    "cost_trend": 1.0,
    "hours_velocity": 1.0,
    "sensor_degradation_rate": 0.0,
    "warning_count": 0,
    "error_code_count": 0,
}


def _maintenance_features(days_since: float, events_90d: int, cost_180d: float) -> dict:
    overdue = 1 if days_since > INTERVAL_DAYS else 0
    neglect = min(min(days_since / 120, 1) * 7 + (3 if overdue else 0), 10)
    return {
        "days_since_last_maintenance": days_since,
        "maint_overdue": overdue,
        "neglect_score": neglect,
        "neglect_acceleration": min(days_since / INTERVAL_DAYS, 3.0),
        "maintenance_events_90d": events_90d,
        "maintenance_cost_180d": cost_180d,
        "cost_per_event": cost_180d / events_90d if events_90d else 0.0,
        "maint_burden": cost_180d / max(BASE["total_hours_lifetime"], 100),
        "mechanical_wear_score": min(BASE["total_hours_lifetime"] / 5000, 1) * 5
                                 + min(BASE["asset_age_years"] / 8, 1) * 5,
    }


SCENARIOS = {
    "as is: 150 days since service": _maintenance_features(150, 0, 0.0),
    # An inspection is not a service: the features do not change.
    "after an inspection": _maintenance_features(150, 0, 0.0),
    "after a minor service": _maintenance_features(1, 1, 320.0),
    "after a major service": _maintenance_features(1, 1, 1500.0),
}


def run(version: str | None) -> None:
    with contextlib.redirect_stdout(io.StringIO()):
        predictor = MultiHorizonPredictor(pin_version=version)
    print(f"\nmodel {predictor.version}")
    print(f"  {'scenario':34s}{'10d':>8}{'30d':>8}{'60d':>8}")
    for name, feats in SCENARIOS.items():
        with contextlib.redirect_stdout(io.StringIO()):
            r = predictor.predict_multi_horizon({**BASE, **feats})["predictions"]
        print(f"  {name:34s}" + "".join(f"{r[h]['failure_probability'] * 100:7.1f}%" for h in ("10d", "30d", "60d")))


if __name__ == "__main__":
    for v in sys.argv[1:] or [None]:
        run(v)
