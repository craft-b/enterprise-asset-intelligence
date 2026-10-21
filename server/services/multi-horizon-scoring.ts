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
import { isColdStart, coldStartMultiHorizon } from "./imputation";
import { mlFetch, describeMlFailure } from "./ml-client";
// One assembly site, shared with the predict-all path. Re-exported because
// routes.ts and index.ts have always imported it from here.
import { toMlSnapshot } from "./ml-snapshot-payload";
export { toMlSnapshot };
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
