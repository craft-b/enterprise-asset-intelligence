# ml-service/tests/test_risk_band_parity.py
#
# The ML service labels risk with RISK_THRESHOLDS; the API re-bands stored
# probabilities with shared/risk-bands.ts. Two copies of the cutoffs that
# disagreed would show one unit as HIGH in one panel and MEDIUM in the next.

import re
from pathlib import Path

from engine.predictor_multihorizon import RISK_THRESHOLDS

TS = (Path(__file__).resolve().parents[2] / "shared" / "risk-bands.ts").read_text()


def test_cutoffs_match_the_shared_definition():
    found = {
        int(h): {"MEDIUM": float(med), "HIGH": float(high)}
        for h, med, high in re.findall(r"(\d+): \{ MEDIUM: ([0-9.]+), HIGH: ([0-9.]+) \}", TS)
    }
    assert found == RISK_THRESHOLDS
