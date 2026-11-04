# ml-service/tests/test_hazard_parity.py
#
# analysis/bayes_ceiling.py mirrors the simulator's hazard constants from
# server/services/failure-hazard.ts. Its docstring used to point at a drift
# check that did not exist, and the copy was two hazard models out of date.

import re
from pathlib import Path

from analysis import bayes_ceiling as bc

TS = (Path(__file__).resolve().parents[2] / "server" / "services" / "failure-hazard.ts").read_text()


def _const(name: str) -> float:
    m = re.search(rf"export const {name} = ([0-9.]+);", TS)
    assert m, f"{name} not found in failure-hazard.ts"
    return float(m.group(1))


def test_constants_match_the_simulator():
    for name in ("CONDITION_FLOOR", "CONDITION_CEILING", "CONDITION_WEAR_PER_DAY",
                 "MAX_DAILY_FAILURE_PROB", "STRESS_MULTIPLIER"):
        assert getattr(bc, name) == _const(name), name


def test_base_hazard_matches_the_simulator():
    m = re.search(r"return ([0-9.]+) \* Math\.exp\(([0-9.]+) \* Math\.max\(0, ageYears\)\) "
                  r"\* \(1 \+ Math\.max\(0, totalHours\) / ([0-9]+)\);", TS)
    assert m, "baseDailyHazard's formula changed shape; update bayes_ceiling.py to match"
    assert (bc.BASE_RATE, bc.AGE_GROWTH, bc.HOURS_SCALE) == (float(m[1]), float(m[2]), int(m[3]))
