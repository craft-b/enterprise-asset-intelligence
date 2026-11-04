"""What is the best AUC anyone could score on this simulated data?

The fleet simulator draws breakdowns from a closed-form daily hazard: a base
set by age and lifetime hours, multiplied by a condition term that wear
raises and service lowers (server/services/failure-hazard.ts). Labels are
Bernoulli draws from that probability, which caps AUC well below 1.0 even for
an oracle that knows the probability exactly. This script estimates that cap.
If the trained model scores at it, the metric is saturated: it verifies the
pipeline wires up correctly and cannot distinguish model quality.

The model never sees `condition` directly -- only days since the last service,
service counts and spend -- so the oracle here has strictly more information
than the model can, and the ceiling is an upper bound.

The constants are mirrored from failure-hazard.ts; tests/test_hazard_parity.py
fails if the two drift apart.

Usage:
    python -m analysis.bayes_ceiling
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score

HORIZONS = (10, 30, 60)
N_ASSETS = 200_000
SEED = 7

# ── Mirrored from server/services/failure-hazard.ts ──────────────────────────
CONDITION_FLOOR = 0.35
CONDITION_CEILING = 2.2
CONDITION_WEAR_PER_DAY = 0.009
MAX_DAILY_FAILURE_PROB = 0.05
STRESS_MULTIPLIER = 1.5
BASE_RATE = 0.0012
AGE_GROWTH = 0.16
HOURS_SCALE = 10000


def base_daily_hazard(age_years: np.ndarray, total_hours: np.ndarray) -> np.ndarray:
    return BASE_RATE * np.exp(AGE_GROWTH * np.maximum(0.0, age_years)) * (
        1 + np.maximum(0.0, total_hours) / HOURS_SCALE
    )


def horizon_probability(age, hours, condition, duty, horizon: int) -> np.ndarray:
    """P(at least one breakdown in `horizon` days), condition degrading daily."""
    survive = np.ones_like(age)
    c = condition.copy()
    base = base_daily_hazard(age, hours)
    for _ in range(horizon):
        # Stress days are 8% of working days; use the expected multiplier.
        p = np.minimum(base * c * (1 + 0.08 * duty * (STRESS_MULTIPLIER - 1)), MAX_DAILY_FAILURE_PROB)
        survive *= 1 - p
        c = np.minimum(c + CONDITION_WEAR_PER_DAY * duty, CONDITION_CEILING)
    return 1 - survive


def main() -> int:
    rng = np.random.default_rng(SEED)
    age = rng.uniform(0.5, 15.0, N_ASSETS)
    duty = rng.choice([1.0, 0.6, 0.3], N_ASSETS, p=[0.7, 0.15, 0.15])
    hours = age * 8760 * rng.uniform(0.03, 0.11, N_ASSETS) * (0.4 + 0.6 * duty)
    condition = rng.uniform(CONDITION_FLOOR, CONDITION_CEILING, N_ASSETS)

    print("Bayes-optimal AUC — an oracle that knows each unit's true condition\n")
    print(f"{'horizon':>8}{'base rate':>12}{'ceiling':>10}")
    for h in HORIZONS:
        p = horizon_probability(age, hours, condition, duty, h)
        y = rng.random(N_ASSETS) < p
        print(f"{h:>7}d{y.mean():>11.1%}{roc_auc_score(y, p):>10.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
