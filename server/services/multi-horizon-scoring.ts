// server/services/multi-horizon-scoring.ts
//
// Scoring the fleet across all three horizons, and storing the result.
//
// This lived inline in the POST /api/risk-score/multi-horizon/batch handler,
// which meant the only way to run it was for someone to click a button. The
// seed could not, so a freshly seeded system had an empty
// equipment_failure_predictions table — and that table backs the Fleet
// Command Center, the asset detail view, the equipment detail panel and the
// feedback-loop analytics. A new demo opened on a command centre that said
// "No predictions yet", while the risk queue the seed did populate lives in a
// different table that page never reads.
//
// The two tables are not duplicates and this does not merge them. This one
// holds a forecast per horizon with its own SHAP attribution; the other holds
// a single-figure rollup. They answer different questions and are written by
// different callers — the point here is only that both callers can now reach
// this one.

import { db } from "../db";
import { equipmentFailurePredictions } from "../../shared/schema";
import { enhancedFeatureService } from "./feature-engineering-enhanced";
import { IMPUTATION_DEFAULTS, isColdStart, coldStartMultiHorizon } from "./imputation";
import { mlFetch, describeMlFailure } from "./ml-client";
import { getSimulationDate } from "./simulation-clock";

export interface MultiHorizonResult {
  equipmentId: number;
  modelVersion: string;
  riskTrend: string;
  predictions: Record<string, any>;
  recommendation: string | null;
}

export interface MultiHorizonOutcome {
  results: MultiHorizonResult[];
  /** How many assets were asked for. */
  attempted: number;
  /** False when the ML service could not be reached at all. */
  serviceAvailable: boolean;
  /** The first thing that went wrong, for reporting. */
  firstError?: string;
}

/** Gateway statuses mean the host answered, not the service. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Build the payload the ML service expects from a feature snapshot. */
export function toMlSnapshot(equipmentId: number, snapshot: any) {
  return {
    equipment_id:                equipmentId,
    asset_age_years:             snapshot.assetAgeYears,
    category:                    snapshot.category,
    total_hours_lifetime:        snapshot.totalHoursLifetime,
    hours_used_30d:              snapshot.hoursUsed30d,
    hours_used_90d:              snapshot.hoursUsed90d,
    rental_days_30d:             Math.round(snapshot.rentalDays30d),
    rental_days_90d:             Math.round(snapshot.rentalDays90d),
    avg_rental_duration:         snapshot.avgRentalDuration,
    maintenance_events_90d:      snapshot.maintenanceEvents90d,
    maintenance_cost_180d:       snapshot.maintenanceCost180d,
    avg_downtime_per_event:      snapshot.avgDowntimePerEvent,
    days_since_last_maintenance: Math.max(
      0,
      snapshot.daysSinceLastMaintenance ?? IMPUTATION_DEFAULTS.days_since_last_maintenance
    ),
    mean_time_between_failures:  snapshot.meanTimeBetweenFailures ?? IMPUTATION_DEFAULTS.mean_time_between_failures,
    vendor_reliability_score:    snapshot.vendorReliabilityScore,
    jobsite_risk_score:          snapshot.jobSiteRiskScore,
    usage_intensity:             Math.min(snapshot.usageIntensity, 12),
    usage_trend:                 Math.min(Math.max(snapshot.usageTrend, 0.5), 3.0),
    utilization_vs_expected:     snapshot.utilizationVsExpected,
    wear_rate:                   snapshot.wearRate,
    aging_factor:                Math.min(snapshot.agingFactor, 1.0),
    maint_overdue:               snapshot.maintOverdue,
    cost_per_event:              snapshot.costPerEvent,
    maint_burden:                snapshot.maintBurden,
    mechanical_wear_score:       Math.min(snapshot.mechanicalWearScore, 10),
    abuse_score:                 Math.min(snapshot.abuseScore, 10),
    neglect_score:               Math.min(Math.max(0, snapshot.neglectScore), 10),
    wear_rate_velocity:          snapshot.wearRateVelocity ?? 0,
    maint_frequency_trend:       snapshot.maintFrequencyTrend ?? 1.0,
    cost_trend:                  snapshot.costTrend ?? 1.0,
    hours_velocity:              snapshot.hoursVelocity ?? 1.0,
    neglect_acceleration:        snapshot.neglectAcceleration ?? 1.0,
    sensor_degradation_rate:     snapshot.sensorDegradationRate ?? 0,
  };
}

/** Write one scored asset to equipment_failure_predictions. */
async function store(result: MultiHorizonResult): Promise<void> {
  const p = result.predictions;
  await db.insert(equipmentFailurePredictions).values({
    equipmentId:    result.equipmentId,
    modelVersion:   result.modelVersion,
    riskTrend:      result.riskTrend as any,
    prob10d:        p["10d"].failure_probability.toString(),
    riskLevel10d:   p["10d"].risk_level,
    prob30d:        p["30d"].failure_probability.toString(),
    riskLevel30d:   p["30d"].risk_level,
    prob60d:        p["60d"].failure_probability.toString(),
    riskLevel60d:   p["60d"].risk_level,
    topDrivers10d:  JSON.stringify(Object.keys(p["10d"].top_risk_drivers || {})),
    topDrivers30d:  JSON.stringify(Object.keys(p["30d"].top_risk_drivers || {})),
    topDrivers60d:  JSON.stringify(Object.keys(p["60d"].top_risk_drivers || {})),
    shapAttribution10d: JSON.stringify(p["10d"].shap_attribution || {}),
    shapAttribution30d: JSON.stringify(p["30d"].shap_attribution || {}),
    shapAttribution60d: JSON.stringify(p["60d"].shap_attribution || {}),
    recommendation: result.recommendation,
  });
}

/**
 * Score the given assets across 10, 30 and 60 days and store the results.
 *
 * Reports an outcome rather than throwing, so the seed can record a failed
 * step and carry on while the route can still answer with an error. Scoring
 * is at the simulation cursor, which is what the rest of the pipeline treats
 * as today.
 */
export async function scoreFleetMultiHorizon(
  equipmentIds: number[]
): Promise<MultiHorizonOutcome> {
  const attempted = equipmentIds.length;
  if (attempted === 0) {
    return { results: [], attempted: 0, serviceAvailable: true };
  }

  const snapshotDate = await getSimulationDate();
  let firstError: string | undefined;

  const snapshots = await Promise.all(
    equipmentIds.map(async id => {
      try {
        return { equipmentId: id, snapshot: await enhancedFeatureService.generateSnapshot(id, snapshotDate) };
      } catch (err: any) {
        console.error(`[MH-BATCH] Failed snapshot for EQ-${id}:`, err);
        firstError ??= `snapshot failed for equipment ${id}: ${err?.message ?? err}`;
        return null;
      }
    })
  );

  const valid = snapshots.filter(Boolean) as { equipmentId: number; snapshot: any }[];

  // Brand-new units are out of distribution, so a rule scores them and tags
  // the row (ML-10) rather than letting a model extrapolate past its data.
  const ruleScored: MultiHorizonResult[] = [];
  const toScore: any[] = [];
  const toScoreIds: number[] = [];

  for (const { equipmentId, snapshot } of valid) {
    if (isColdStart(snapshot.assetAgeYears, snapshot.totalHoursLifetime)) {
      const cs = coldStartMultiHorizon(equipmentId);
      ruleScored.push({
        equipmentId,
        modelVersion: cs.model_version,
        riskTrend: cs.risk_trend,
        predictions: cs.predictions,
        recommendation: cs.recommendation,
      });
    } else {
      toScore.push(toMlSnapshot(equipmentId, snapshot));
      toScoreIds.push(equipmentId);
    }
  }

  let modelScored: MultiHorizonResult[] = [];

  // Only call the service if it has something to score. The inline version
  // posted an empty batch when every asset was rule-scored, which woke a
  // suspended container to ask it nothing.
  if (toScore.length > 0) {
    try {
      const res = await mlFetch("/predict/multi-horizon/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshots: toScore }),
      });

      if (!res.ok) {
        const detail = await describeMlFailure(res, "/predict/multi-horizon/batch");
        firstError ??= detail;
        // A gateway status is the host saying the service is not up, which is
        // a different situation from the service rejecting the request.
        return {
          results: ruleScored,
          attempted,
          serviceAvailable: !GATEWAY_STATUSES.has(res.status),
          firstError,
        };
      }

      const body = await res.json();
      modelScored = (body.predictions ?? []).map((pred: any, i: number) => ({
        equipmentId:    toScoreIds[i],
        modelVersion:   pred.model_version,
        riskTrend:      pred.risk_trend,
        predictions:    pred.predictions,
        recommendation: pred.recommendation,
      }));
    } catch (err: any) {
      // Connection refused, DNS, abort — the service is not reachable.
      firstError ??= err?.message ?? String(err);
      return { results: ruleScored, attempted, serviceAvailable: false, firstError };
    }
  }

  const results = [...modelScored, ...ruleScored];

  for (const result of results) {
    try {
      await store(result);
    } catch (err: any) {
      console.error(`[MH-BATCH] Failed to store EQ-${result.equipmentId}:`, err);
      firstError ??= `could not store equipment ${result.equipmentId}: ${err?.message ?? err}`;
    }
  }

  return { results, attempted, serviceAvailable: true, firstError };
}
