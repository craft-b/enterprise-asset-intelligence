// server/services/multi-horizon-scoring.test.ts
//
// This logic sat inline in a route handler, so the only way to run it was to
// press a button, and the seed could not. The consequence was quiet: a freshly
// seeded system had an empty equipment_failure_predictions table, which backs
// the Fleet Command Center, the asset and equipment detail views and the
// feedback-loop analytics. The demo's main page said "No predictions yet"
// while the other prediction table sat populated behind a page that does not
// read it.
//
// What is tested here is the payload. Every field is clamped on the way to the
// model, and a clamp that stops working sends an out-of-range feature to a
// model trained without them -- which produces a number rather than an error,
// so nothing anywhere would say so.

import { describe, it, expect } from "vitest";
import { toMlSnapshot } from "./multi-horizon-scoring";
import { IMPUTATION_DEFAULTS } from "./imputation";

/** A snapshot with every field in range, to vary one at a time. */
const sane = {
  assetAgeYears: 5, category: "Excavator", totalHoursLifetime: 4000,
  hoursUsed30d: 150, hoursUsed90d: 450, rentalDays30d: 12.4, rentalDays90d: 40.6,
  avgRentalDuration: 7, maintenanceEvents90d: 2, maintenanceCost180d: 1200,
  avgDowntimePerEvent: 4, daysSinceLastMaintenance: 30, meanTimeBetweenFailures: 45,
  vendorReliabilityScore: 0.8, jobSiteRiskScore: 0.3, usageIntensity: 6,
  usageTrend: 1.2, utilizationVsExpected: 1.0, wearRate: 0.09, agingFactor: 0.5,
  maintOverdue: 0, costPerEvent: 600, maintBurden: 0.4, mechanicalWearScore: 5,
  abuseScore: 2, neglectScore: 3, wearRateVelocity: 0.01, maintFrequencyTrend: 1,
  costTrend: 1, hoursVelocity: 1, neglectAcceleration: 1, sensorDegradationRate: 0,
};

const build = (over: Record<string, unknown> = {}) =>
  toMlSnapshot(42, { ...sane, ...over });

describe("toMlSnapshot", () => {
  it("passes an in-range snapshot through unchanged", () => {
    const p = build();
    expect(p.equipment_id).toBe(42);
    expect(p.wear_rate).toBe(0.09);
    expect(p.mechanical_wear_score).toBe(5);
    expect(p.category).toBe("Excavator");
  });

  it("caps usage_intensity at 12", () => {
    expect(build({ usageIntensity: 40 }).usage_intensity).toBe(12);
    expect(build({ usageIntensity: 3 }).usage_intensity).toBe(3);
  });

  it("holds usage_trend between 0.5 and 3", () => {
    expect(build({ usageTrend: 9 }).usage_trend).toBe(3);
    expect(build({ usageTrend: 0.01 }).usage_trend).toBe(0.5);
  });

  it("caps aging_factor at 1", () => {
    expect(build({ agingFactor: 2.4 }).aging_factor).toBe(1);
  });

  it("caps the 0-10 scores at 10", () => {
    expect(build({ mechanicalWearScore: 99 }).mechanical_wear_score).toBe(10);
    expect(build({ abuseScore: 99 }).abuse_score).toBe(10);
    expect(build({ neglectScore: 99 }).neglect_score).toBe(10);
  });

  it("floors neglect_score at 0 as well", () => {
    // The only score clamped on both sides; a negative would be nonsense the
    // model has never seen.
    expect(build({ neglectScore: -5 }).neglect_score).toBe(0);
  });

  it("never sends negative days since maintenance", () => {
    expect(build({ daysSinceLastMaintenance: -3 }).days_since_last_maintenance).toBe(0);
  });

  it("imputes the two fields that are legitimately unknown", () => {
    // A machine with no recorded maintenance has no days-since and no MTBF.
    // Sending null would be a different claim from sending the fleet default.
    const p = build({ daysSinceLastMaintenance: null, meanTimeBetweenFailures: null });
    expect(p.days_since_last_maintenance).toBe(IMPUTATION_DEFAULTS.days_since_last_maintenance);
    expect(p.mean_time_between_failures).toBe(IMPUTATION_DEFAULTS.mean_time_between_failures);
  });

  it("rounds rental day counts, which the model expects as integers", () => {
    expect(build({ rentalDays30d: 12.4, rentalDays90d: 40.6 }).rental_days_30d).toBe(12);
    expect(build({ rentalDays90d: 40.6 }).rental_days_90d).toBe(41);
  });

  it("defaults the trend features rather than sending undefined", () => {
    const p = build({
      wearRateVelocity: undefined, maintFrequencyTrend: undefined,
      costTrend: undefined, hoursVelocity: undefined,
      neglectAcceleration: undefined, sensorDegradationRate: undefined,
    });
    expect(p.wear_rate_velocity).toBe(0);
    expect(p.maint_frequency_trend).toBe(1.0);
    expect(p.cost_trend).toBe(1.0);
    expect(p.hours_velocity).toBe(1.0);
    expect(p.neglect_acceleration).toBe(1.0);
    expect(p.sensor_degradation_rate).toBe(0);
    expect(Object.values(p).every(v => v !== undefined)).toBe(true);
  });

  it("sends every field the model is trained on", () => {
    // A dropped field arrives as a missing column rather than an error.
    const p = build();
    for (const key of [
      "equipment_id", "asset_age_years", "category", "total_hours_lifetime",
      "hours_used_30d", "hours_used_90d", "rental_days_30d", "rental_days_90d",
      "avg_rental_duration", "maintenance_events_90d", "maintenance_cost_180d",
      "avg_downtime_per_event", "days_since_last_maintenance",
      "mean_time_between_failures", "vendor_reliability_score", "jobsite_risk_score",
      "usage_intensity", "usage_trend", "utilization_vs_expected", "wear_rate",
      "aging_factor", "maint_overdue", "cost_per_event", "maint_burden",
      "mechanical_wear_score", "abuse_score", "neglect_score", "wear_rate_velocity",
      "maint_frequency_trend", "cost_trend", "hours_velocity",
      "neglect_acceleration", "sensor_degradation_rate",
    ]) {
      expect(p, `missing ${key}`).toHaveProperty(key);
    }
  });
});

describe("the route no longer carries a second copy", () => {
  it("delegates instead of rebuilding the payload inline", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const routes = readFileSync(join(__dirname, "..", "routes.ts"), "utf-8");

    expect(routes).toMatch(/scoreFleetMultiHorizon/);
    // The tell of the old inline version: it built the payload itself.
    expect(routes).not.toMatch(/neglect_score:\s*Math\.min/);
    expect(routes).not.toMatch(/snapshotsToScore/);
  });
});

describe("one definition of the ML payload", () => {
  // It was built in three places with the same clamps copied out by hand: the
  // batch route, the rescore inside POST /api/maintenance, and the nightly
  // drift cron. Three copies of a bound is three chances for one to be edited
  // and the others not, and the symptom would be a feature quietly out of the
  // range the model was trained on -- which produces a number, not an error.
  const read = async (rel: string) => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    return readFileSync(join(__dirname, rel), "utf-8");
  };

  it("is not rebuilt in the routes", async () => {
    const routes = await read("../routes.ts");
    expect(routes).toMatch(/toMlSnapshot/);
    expect(routes).not.toMatch(/neglect_score:\s*Math\.min/);
    expect(routes).not.toMatch(/usage_intensity:\s*Math\.min/);
  });

  it("is not rebuilt in the cron", async () => {
    const index = await read("../index.ts");
    expect(index).toMatch(/toMlSnapshot/);
    expect(index).not.toMatch(/neglect_score:\s*Math\.min/);
    expect(index).not.toMatch(/mechanical_wear_score:\s*Math\.min/);
  });
});
