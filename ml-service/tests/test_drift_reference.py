"""
Tests for how the drift reference is chosen, floored and stored.

Three bugs lived here at once, and all three were silent -- the endpoint
returned success every time.

1. compute-reference wrote registry/drift_reference.json. The loader globbed
   `drift_reference_*.json`, which requires the underscore and so matched only
   the committed per-version files. A freshly computed reference was therefore
   never the one loaded afterwards.

2. Among those per-version files the loader picked by mtime. Every file in a
   Docker image carries the build timestamp, so the choice between v1.15 and
   v1.17 was arbitrary.

3. One constant, MIN_BATCH_SIZE = 20, gated both "big enough batch to score"
   and "big enough set to build a reference from". A scoring run over a
   10-asset fleet produces 10 rows, so the prediction and bias references were
   skipped on every compute, for every model version. All three committed
   reference files carry "predictions": {} and "bias": {}, which is that bug's
   fossil record.
"""

import json

import pytest

from engine import drift_detector as dd
from engine.drift_detector import DriftDetector


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Point the detector at an empty registry and cut off the database."""
    monkeypatch.setattr(dd, "REGISTRY", tmp_path)
    # The database path is exercised separately; these tests are about the
    # file fallback, and a real connection attempt would make them slow and
    # dependent on a local server.
    monkeypatch.setattr(DriftDetector, "_load_reference_from_db",
                        lambda self: (None, ""))
    monkeypatch.setattr(DriftDetector, "_ensure_tables", lambda self: None)
    return tmp_path


def write_ref(path, model_version, features=None, predictions=None, bias=None):
    path.write_text(json.dumps({
        "model_version": model_version,
        "n_samples":     len(next(iter(features.values()))) if features else 0,
        "features":      features or {},
        "predictions":   predictions or {},
        "bias":          bias or {},
    }))


def feature_block(n):
    """A feature reference with n values, above the sample floor."""
    return {"mechanical_wear_score": [float(i % 10) for i in range(n)]}


class TestVersionSelection:
    def test_picks_highest_version_not_newest_file(self, registry):
        # v1.15 written last, so it has the newest mtime. Version wins.
        write_ref(registry / "drift_reference_v1.17.json", "v1.17", feature_block(50))
        write_ref(registry / "drift_reference_v1.15.json", "v1.15", feature_block(50))

        d = DriftDetector()
        assert d.ref_model_version == "v1.17"

    def test_compares_versions_numerically(self, registry):
        # Lexically "v1.9" > "v1.17"; numerically it is not.
        write_ref(registry / "drift_reference_v1.9.json",  "v1.9",  feature_block(50))
        write_ref(registry / "drift_reference_v1.17.json", "v1.17", feature_block(50))

        d = DriftDetector()
        assert d.ref_model_version == "v1.17"

    def test_falls_back_to_the_unversioned_file(self, registry):
        # The name compute-reference writes. With no versioned file present it
        # must be read -- previously it was reachable only in that case, which
        # never happened because the per-version files ship in the image.
        write_ref(registry / "drift_reference.json", "bootstrap", feature_block(50))

        d = DriftDetector()
        assert d.ref_model_version == "bootstrap"

    def test_no_reference_at_all_is_not_an_error(self, registry):
        d = DriftDetector()
        assert d.reference == {}
        assert d.pred_reference == {}
        assert d.ref_model_version is None


class TestLoadFloors:
    def test_a_fleet_sized_prediction_reference_survives_loading(self, registry):
        # 10 scores: one per asset in the demo fleet. Flooring this at
        # MIN_BATCH_SIZE discarded on load precisely what compute built.
        scores = [0.2375, 0.3589, 0.4218, 0.4245, 0.5642,
                  0.5862, 0.6044, 0.6565, 0.6725, 0.6807]
        assert len(scores) < dd.MIN_BATCH_SIZE, "premise: below the batch floor"

        write_ref(
            registry / "drift_reference_v1.17.json", "v1.17",
            features=feature_block(50),
            predictions={str(h): {"scores": scores, "high_pct": 0.4,
                                  "medium_pct": 0.5, "low_pct": 0.1}
                         for h in (10, 30, 60)},
            bias={"Excavator": {"high_pct": 0.5, "mean_score": 0.6, "n": 4}},
        )

        d = DriftDetector()
        assert sorted(d.pred_reference) == [10, 30, 60]
        assert len(d.pred_reference[30]["scores"]) == 10
        assert d.bias_reference["Excavator"]["n"] == 4

    def test_a_too_small_prediction_reference_is_still_rejected(self, registry):
        # The floor is lower, not absent: three assets is not a fleet.
        write_ref(
            registry / "drift_reference_v1.17.json", "v1.17",
            features=feature_block(50),
            predictions={"30": {"scores": [0.3, 0.4, 0.5], "high_pct": 0.0,
                                "medium_pct": 1.0, "low_pct": 0.0}},
        )

        d = DriftDetector()
        assert d.pred_reference == {}

    def test_feature_references_keep_the_sample_floor(self, registry):
        write_ref(registry / "drift_reference_v1.17.json", "v1.17",
                  features={"mechanical_wear_score": [1.0, 2.0, 3.0]})

        d = DriftDetector()
        assert d.reference == {}


class TestGateConstants:
    def test_building_a_reference_and_scoring_a_batch_are_separate_floors(self):
        # These were one constant. Collapsing them back would restore a state
        # where a 10-asset fleet can never have a prediction reference, so the
        # distinction is asserted rather than left to a comment.
        assert dd.MIN_REFERENCE_ASSETS < dd.MIN_BATCH_SIZE

    def test_coverage_is_a_fraction_of_the_fleet(self):
        assert 0 < dd.MIN_FLEET_COVERAGE <= 1.0

    def test_a_ten_asset_fleet_fully_scored_clears_the_gate(self):
        # The demo's exact shape, which the old row-count gate failed.
        n_assets, fleet_size = 10, 10
        assert n_assets >= dd.MIN_REFERENCE_ASSETS
        assert (n_assets / fleet_size) >= dd.MIN_FLEET_COVERAGE

    def test_a_partly_scored_fleet_does_not(self):
        n_assets, fleet_size = 6, 10
        assert (n_assets / fleet_size) < dd.MIN_FLEET_COVERAGE
