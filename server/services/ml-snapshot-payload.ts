// server/services/ml-snapshot-payload.ts
//
// One assembly site for the snapshot payload sent to the ML service.
//
// There were two. `toMlSnapshot` (Score Fleet, the nightly cron, single-asset
// scoring) sent all 31 features the champion model was trained on.
// `buildSnapshotPayload` (Run Predictions) sent 25, omitting the six
// velocity/trend features: wear_rate_velocity, maint_frequency_trend,
// cost_trend, hours_velocity, neglect_acceleration, sensor_degradation_rate.
//
// Nothing failed. pydantic's SnapshotInput declares defaults for exactly those
// six, so the request validated and the model scored a complete frame — one in
// which every asset looked like it had neutral trends and no sensor
// degradation. Two code paths, the same endpoint, the same model, different
// answers for the same asset: EQ-003 came back 0.604 (HIGH) from one and 0.559
// (MEDIUM) from the other, four minutes apart, and the Fleet Command Center
// and the Predictive Maintenance page disagreed in the UI.
//
// The contract test that should have caught it checked the payload against
// pydantic's REQUIRED fields. A field with a default is not required, so the
// six that drifted were the six the test could not see. It now checks against
// the model's feature columns instead, which is the contract that matters:
// pydantic decides whether the request is accepted, MODEL_FEATURE_COLUMNS
// decides whether the model is being asked a complete question.

import { IMPUTATION_DEFAULTS } from "./imputation";

/**
 * The feature columns of the champion model, in training order.
 *
 * Mirrors ml-service/models/feature_cols_v*.json — the file the predictor
 * reindexes against. Anything absent from the payload is filled by pydantic's
 * default (for the six that declare one) or by `reindex(fill_value=0)`, both
 * silently, so this list is what a payload has to cover to be complete rather
 * than merely acceptable.
 */
export const MODEL_FEATURE_COLUMNS = [
  "asset_age_years", "total_hours_lifetime", "hours_used_30d", "hours_used_90d",
  "rental_days_30d", "rental_days_90d", "avg_rental_duration",
  "maintenance_events_90d", "maintenance_cost_180d",
  "days_since_last_maintenance", "mean_time_between_failures",
  "vendor_reliability_score", "jobsite_risk_score", "usage_intensity",
  "usage_trend", "utilization_vs_expected", "wear_rate", "aging_factor",
  "maint_overdue", "cost_per_event", "maint_burden", "mechanical_wear_score",
  "abuse_score", "neglect_score", "wear_rate_velocity",
  "maint_frequency_trend", "cost_trend", "hours_velocity",
  "neglect_acceleration", "sensor_degradation_rate", "category",
] as const;

/**
 * Coerce to a finite number, falling back when the value is absent or unusable.
 *
 * The raw-passthrough version of this builder sent `null` for a missing feature
 * and let pydantic reject it, or NaN through to the model. A feature that is
 * genuinely unknown gets its imputation default, which is what the trainer's
 * COALESCE used, so serve-time imputation equals train-time imputation.
 */
function safe(val: unknown, fallback: number): number {
  // null and "" must be checked explicitly: Number(null) and Number("") are
  // both 0, and 0 is finite, so a Number.isFinite() test alone silently turns
  // "unknown" into "zero". For days_since_last_maintenance that is the
  // difference between an asset serviced today and one never serviced at all,
  // and it is the stronger of the two signals.
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Build the ML service payload from a feature snapshot.
 *
 * Every field is coerced and clamped on the way out. A clamp that stops working
 * sends an out-of-range feature to a model trained without them, which produces
 * a number rather than an error — so nothing anywhere would say so.
 */
export function toMlSnapshot(equipmentId: number, snapshot: any) {
  return {
    equipment_id:                equipmentId,
    asset_age_years:             safe(snapshot?.assetAgeYears, 1),
    category:                    String(snapshot?.category ?? "Unknown"),
    total_hours_lifetime:        safe(snapshot?.totalHoursLifetime, 0),
    hours_used_30d:              safe(snapshot?.hoursUsed30d, 0),
    hours_used_90d:              safe(snapshot?.hoursUsed90d, 0),
    rental_days_30d:             Math.round(safe(snapshot?.rentalDays30d, 0)),
    rental_days_90d:             Math.round(safe(snapshot?.rentalDays90d, 0)),
    avg_rental_duration:         safe(snapshot?.avgRentalDuration, 1),
    maintenance_events_90d:      safe(snapshot?.maintenanceEvents90d, 0),
    maintenance_cost_180d:       safe(snapshot?.maintenanceCost180d, 0),
    avg_downtime_per_event:      safe(snapshot?.avgDowntimePerEvent, 0),
    days_since_last_maintenance: Math.max(
      0,
      safe(snapshot?.daysSinceLastMaintenance, IMPUTATION_DEFAULTS.days_since_last_maintenance),
    ),
    mean_time_between_failures:  safe(snapshot?.meanTimeBetweenFailures, IMPUTATION_DEFAULTS.mean_time_between_failures),
    vendor_reliability_score:    safe(snapshot?.vendorReliabilityScore, 0.5),
    jobsite_risk_score:          safe(snapshot?.jobSiteRiskScore, 0.5),
    usage_intensity:             Math.min(safe(snapshot?.usageIntensity, 1), 12),
    usage_trend:                 clamp(safe(snapshot?.usageTrend, 1), 0.5, 3.0),
    utilization_vs_expected:     safe(snapshot?.utilizationVsExpected, 1),
    wear_rate:                   safe(snapshot?.wearRate, 0),
    aging_factor:                Math.min(safe(snapshot?.agingFactor, 0.1), 1.0),
    maint_overdue:               safe(snapshot?.maintOverdue, 0),
    cost_per_event:              safe(snapshot?.costPerEvent, 0),
    maint_burden:                safe(snapshot?.maintBurden, 0),
    mechanical_wear_score:       Math.min(safe(snapshot?.mechanicalWearScore, 1), 10),
    abuse_score:                 Math.min(safe(snapshot?.abuseScore, 1), 10),
    neglect_score:               clamp(safe(snapshot?.neglectScore, 1), 0, 10),

    // The six that one path used to leave out entirely. Their imputation
    // defaults are the trainer's COALESCE values, so an asset with no history
    // is scored the way such an asset was scored in training -- but an asset
    // that HAS these values now has them sent.
    wear_rate_velocity:          safe(snapshot?.wearRateVelocity, IMPUTATION_DEFAULTS.wear_rate_velocity),
    maint_frequency_trend:       safe(snapshot?.maintFrequencyTrend, IMPUTATION_DEFAULTS.maint_frequency_trend),
    cost_trend:                  safe(snapshot?.costTrend, IMPUTATION_DEFAULTS.cost_trend),
    hours_velocity:              safe(snapshot?.hoursVelocity, IMPUTATION_DEFAULTS.hours_velocity),
    neglect_acceleration:        safe(snapshot?.neglectAcceleration, IMPUTATION_DEFAULTS.neglect_acceleration),
    sensor_degradation_rate:     safe(snapshot?.sensorDegradationRate, IMPUTATION_DEFAULTS.sensor_degradation_rate),
  };
}
