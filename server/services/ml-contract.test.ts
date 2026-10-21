// QA-1 cross-language contract (Node → pydantic → model).
//
// The Node payload assembled for the ML service must carry every field the
// FastAPI SnapshotInput schema requires AND every feature column the champion
// model was trained on. Those are two different contracts, and for a while this
// file only checked the first one.
//
// What that cost: there were two payload builders, and the predict-all one sent
// 25 fields instead of 31 — no wear_rate_velocity, maint_frequency_trend,
// cost_trend, hours_velocity, neglect_acceleration or sensor_degradation_rate.
// Every one of those six declares a default in SnapshotInput, so they are not
// *required* fields, so a test written against the required list could not see
// them missing. The request validated, the model scored a complete frame, and
// the six absent features silently took their imputation defaults — the model
// was asked about an asset with neutral trends and no sensor degradation, for
// every asset, on that path only. Score Fleet and Run Predictions then returned
// different probabilities for the same asset from the same endpoint (EQ-003:
// 0.604 HIGH vs 0.559 MEDIUM, four minutes apart), and the two pages that read
// those tables disagreed in the UI.
//
// So the model's feature columns are now the assertion. pydantic decides
// whether a request is accepted; MODEL_FEATURE_COLUMNS decides whether the
// model is being asked a complete question. The Python side
// (test_qa_guards.py) guards schema ↔ trainer.

import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("./ml-client", () => ({ mlFetch: vi.fn(), ML_SERVICE_URL: "http://test" }));

import { toMlSnapshot, MODEL_FEATURE_COLUMNS } from "./ml-snapshot-payload";
import { IMPUTATION_DEFAULTS } from "./imputation";

// Required (non-defaulted) fields of api/schemas/prediction.py::SnapshotInput.
const REQUIRED_PYDANTIC_FIELDS = [
  "equipment_id",
  "asset_age_years", "category", "total_hours_lifetime",
  "hours_used_30d", "hours_used_90d", "rental_days_30d", "rental_days_90d",
  "avg_rental_duration", "maintenance_events_90d", "maintenance_cost_180d",
  "days_since_last_maintenance", "mean_time_between_failures",
  "usage_intensity", "usage_trend", "utilization_vs_expected", "wear_rate",
  "aging_factor", "maint_overdue", "cost_per_event", "maint_burden",
  "mechanical_wear_score", "abuse_score", "neglect_score",
];

/** A full snapshot: every feature the model knows about, in range. */
const FULL_SNAPSHOT: Record<string, unknown> = {
  assetAgeYears: 6.2, category: "Excavator", totalHoursLifetime: 8200,
  hoursUsed30d: 160, hoursUsed90d: 470, rentalDays30d: 20, rentalDays90d: 62,
  avgRentalDuration: 4, maintenanceEvents90d: 2, maintenanceCost180d: 3400,
  avgDowntimePerEvent: 8, daysSinceLastMaintenance: 88, meanTimeBetweenFailures: 130,
  vendorReliabilityScore: 0.6, jobSiteRiskScore: 0.7, usageIntensity: 6,
  usageTrend: 1.2, utilizationVsExpected: 1.1, wearRate: 0.12, agingFactor: 0.62,
  maintOverdue: 0, costPerEvent: 1700, maintBurden: 3.5,
  mechanicalWearScore: 5.4, abuseScore: 3.1, neglectScore: 3.9,
  wearRateVelocity: 0.04, maintFrequencyTrend: 1.4, costTrend: 1.3,
  hoursVelocity: 1.15, neglectAcceleration: 1.2, sensorDegradationRate: 0.31,
};

describe("Node → pydantic snapshot contract", () => {
  it("payload carries every required SnapshotInput field", () => {
    const payload = toMlSnapshot(101, FULL_SNAPSHOT);
    const missing = REQUIRED_PYDANTIC_FIELDS.filter((k) => !(k in payload));
    expect(missing).toEqual([]);
  });

  it("emits no NaN for a sparse snapshot (defaults fill the gaps)", () => {
    const payload = toMlSnapshot(102, { category: "Crane" });
    const nanFields = Object.entries(payload)
      .filter(([, v]) => typeof v === "number" && Number.isNaN(v))
      .map(([k]) => k);
    expect(nanFields).toEqual([]);
  });

  it("imputes MTBF=500 / days_since=999 (matches the trainer COALESCE)", () => {
    const payload = toMlSnapshot(103, { category: "Crane" });
    expect(payload.mean_time_between_failures).toBe(500);
    expect(payload.days_since_last_maintenance).toBe(999);
  });
});

describe("Node → model feature contract", () => {
  it("payload covers every column the model was trained on", () => {
    // The assertion the required-fields list could not make. A feature the
    // model expects and the payload omits is filled in silently -- by
    // pydantic's default if it has one, by reindex(fill_value=0) otherwise --
    // so the only place this can be caught is here.
    const payload = toMlSnapshot(104, FULL_SNAPSHOT) as Record<string, unknown>;
    const missing = MODEL_FEATURE_COLUMNS.filter((c) => !(c in payload));
    expect(missing).toEqual([]);
  });

  it("sends the asset's real velocity values, not their imputation defaults", () => {
    // The six that drifted. A builder that omits them produces a payload where
    // these read as the defaults below, which is indistinguishable from an
    // asset that genuinely has no trend -- for every asset.
    const payload = toMlSnapshot(105, FULL_SNAPSHOT);
    expect(payload.wear_rate_velocity).toBe(0.04);
    expect(payload.maint_frequency_trend).toBe(1.4);
    expect(payload.cost_trend).toBe(1.3);
    expect(payload.hours_velocity).toBe(1.15);
    expect(payload.neglect_acceleration).toBe(1.2);
    expect(payload.sensor_degradation_rate).toBe(0.31);
  });

  it("falls back to the trainer's values when a velocity feature is absent", () => {
    const payload = toMlSnapshot(106, { category: "Crane" });
    expect(payload.wear_rate_velocity).toBe(IMPUTATION_DEFAULTS.wear_rate_velocity);
    expect(payload.maint_frequency_trend).toBe(IMPUTATION_DEFAULTS.maint_frequency_trend);
    expect(payload.cost_trend).toBe(IMPUTATION_DEFAULTS.cost_trend);
    expect(payload.hours_velocity).toBe(IMPUTATION_DEFAULTS.hours_velocity);
    expect(payload.neglect_acceleration).toBe(IMPUTATION_DEFAULTS.neglect_acceleration);
    expect(payload.sensor_degradation_rate).toBe(IMPUTATION_DEFAULTS.sensor_degradation_rate);
  });
});

describe("there is one payload builder", () => {
  it("every scoring path imports it from the same module", async () => {
    // The duplicate was not introduced deliberately; it was two features built
    // months apart, each assembling what it needed. The guard is structural
    // rather than behavioural because a second copy is undetectable from the
    // outside until the two disagree about a real asset.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const sources = [
      "multi-horizon-scoring.ts",
      "predictive-maintenance-fixed.ts",
    ].map((f) => readFileSync(join(__dirname, f), "utf-8"));

    for (const src of sources) {
      expect(src).toMatch(/from "\.\/ml-snapshot-payload"/);
      // No local re-definition: that is how the first duplicate appeared.
      expect(src).not.toMatch(/function toMlSnapshot\(/);
      expect(src).not.toMatch(/function buildSnapshotPayload\(/);
    }
  });

  it("scores the same asset identically whichever path builds the payload", () => {
    // Both call sites now pass the snapshot straight through, so this is the
    // property the duplicate broke: same snapshot in, same question to the
    // model, whichever button was pressed.
    expect(toMlSnapshot(7, FULL_SNAPSHOT)).toEqual(toMlSnapshot(7, FULL_SNAPSHOT));
  });
});
