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
import { mapWithConcurrency, snapshotConcurrency } from "./feature-engineering";
import { isColdStart, coldStartMultiHorizon } from "./imputation";
import { mlFetch, describeMlFailure, ML_SLOW_TIMEOUT_MS } from "./ml-client";
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
  /**
   * True when the host's CDN shed the request rather than the service
   * refusing it.
   *
   * Separate from serviceAvailable because the remedy is different and the
   * wait is longer: nothing is starting up, there is nothing to nudge, and
   * sending another request promptly is what keeps the limit in force.
   */
  rateLimited?: boolean;
  /** The first thing that went wrong, for reporting. */
  firstError?: string;
}

/** Gateway statuses mean the host answered, not the service. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** The CDN shedding load in front of the host. */
const RATE_LIMITED = 429;

/**
 * Largest group of assets sent to the ML service in one request.
 *
 * The service scores a batch in a sequential Python loop, and each asset
 * costs three SHAP TreeExplainer calls -- one per horizon. Sixty assets is
 * 180 of them, plus three drift checks, plus the same again if a challenger
 * is loaded for shadow scoring. All of it synchronous inside an `async def`,
 * so it blocks the event loop: while that batch runs, the service cannot
 * answer /health, and a request long enough also meets the host's proxy
 * timeout and comes back 502.
 *
 * Which is how "run the forecast" produced "the ML service is waking up".
 * The service was neither asleep nor broken. It was busy doing exactly what
 * had been asked of it, and every way we had of checking on it was a request
 * it was too busy to answer.
 */
const MAX_SCORE_BATCH = Number(process.env.ML_SCORE_BATCH_SIZE ?? 30);

/**
 * The ML service's own floor: it skips every drift check below this.
 *
 * Mirrors MIN_BATCH_SIZE in ml-service/engine/drift_detector.py. Splitting a
 * fleet without respecting it would quietly switch off the three drift cards
 * this dashboard exists to show -- the request would succeed, the forecasts
 * would store, and the only visible difference would be the cards going back
 * to explaining themselves.
 */
const DRIFT_MIN_BATCH = Number(process.env.ML_DRIFT_MIN_BATCH ?? 20);

/**
 * Split into groups no larger than `maxSize`, as evenly as possible, and
 * never into more groups than `minSize` allows.
 *
 * Evenly, rather than filling each group before starting the next: greedy
 * chunking of fifty assets at thirty leaves a tail of twenty, and of
 * forty-five a tail of fifteen, which the drift checks drop. Splitting
 * evenly gives 25/25 and 23/22.
 *
 * `minSize` is the second constraint, and it wins. A thirty-five asset fleet
 * split at thirty gives 18/17 -- two groups, both under the drift floor, so
 * every card goes blank while both requests report success. When the two
 * constraints cannot both hold, the fleet goes in one request: a batch that
 * is slower than we would like still produces an answer, and one that is
 * silently undrifted does not.
 */
export function chunkEvenly<T>(items: T[], maxSize: number, minSize = 0): T[][] {
  if (items.length === 0) return [];
  let groups = Math.ceil(items.length / Math.max(1, maxSize));
  if (minSize > 0) {
    groups = Math.min(groups, Math.max(1, Math.floor(items.length / minSize)));
  }
  const out: T[][] = [];
  let start = 0;
  for (let i = 0; i < groups; i++) {
    // Hand the remainder to the earliest groups, so sizes differ by at most
    // one and the last group is never the small one.
    const size = Math.ceil((items.length - start) / (groups - i));
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
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
    return { results: [], attempted: 0, serviceAvailable: true, rateLimited: false };
  }

  const snapshotDate = await getSimulationDate();
  let firstError: string | undefined;

  // Bounded, not Promise.all. Each snapshot is a handful of queries, so a
  // sixty-asset fleet opened sixty of those at once against a serverless
  // database and a pool that defaults to ten connections -- the same
  // unbounded fan-out that was already bounded in the backfill path, left
  // behind here because this one used to run over ten assets.
  const snapshots = await mapWithConcurrency(equipmentIds, snapshotConcurrency(), async id => {
    try {
      return { equipmentId: id, snapshot: await enhancedFeatureService.generateSnapshot(id, snapshotDate) };
    } catch (err: any) {
      console.error(`[MH-BATCH] Failed snapshot for EQ-${id}:`, err);
      firstError ??= `snapshot failed for equipment ${id}: ${err?.message ?? err}`;
      return null;
    }
  });

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

  /**
   * The one way out of here, because storing used to be skipped on the way.
   *
   * Both ML-failure returns sat above the storage loop, so a cold start threw
   * away the rule-scored assets it had already computed -- and those need no
   * ML service at all. On the sixty-unit fleet that is a dozen forecasts
   * discarded for a reason that did not apply to them, which is why a fleet
   * with a suspended service showed no predictions whatsoever rather than the
   * ones it could still account for.
   */
  async function finish(
    results: MultiHorizonResult[],
    serviceAvailable: boolean,
    rateLimited = false,
  ): Promise<MultiHorizonOutcome> {
    for (const result of results) {
      try {
        await store(result);
      } catch (err: any) {
        console.error(`[MH-BATCH] Failed to store EQ-${result.equipmentId}:`, err);
        firstError ??= `could not store equipment ${result.equipmentId}: ${err?.message ?? err}`;
      }
    }
    return { results, attempted, serviceAvailable, rateLimited, firstError };
  }

  const modelScored: MultiHorizonResult[] = [];

  // Only call the service if it has something to score. The inline version
  // posted an empty batch when every asset was rule-scored, which woke a
  // suspended container to ask it nothing.
  if (toScore.length > 0) {
    const groups = chunkEvenly(toScore, MAX_SCORE_BATCH, DRIFT_MIN_BATCH);
    let offset = 0;

    for (const group of groups) {
      const ids = toScoreIds.slice(offset, offset + group.length);
      offset += group.length;

      try {
        // Still the long budget: a group is shorter than the whole fleet but
        // it is not quick, and an abort here throws away work already done.
        const res = await mlFetch("/predict/multi-horizon/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshots: group }),
        }, { timeoutMs: ML_SLOW_TIMEOUT_MS });

        if (!res.ok) {
          const detail = await describeMlFailure(res, "/predict/multi-horizon/batch");
          firstError ??= detail;
          // Whatever earlier groups scored is kept. Before the fleet was
          // split this was all-or-nothing, so one bad response at any point
          // meant the entire run produced nothing.
          //
          // A 429 is not the service saying no -- it is the edge in front of
          // it refusing to ask. Reported as unavailable so the caller
          // retries rather than announcing "scored 0 of 60", which reads as
          // the model having rejected the whole fleet.
          if (res.status === RATE_LIMITED) {
            return finish([...modelScored, ...ruleScored], false, true);
          }
          return finish(
            [...modelScored, ...ruleScored],
            !GATEWAY_STATUSES.has(res.status),
          );
        }

        const body = await res.json();
        const preds = body.predictions ?? [];
        preds.forEach((pred: any, i: number) => {
          modelScored.push({
            equipmentId:    ids[i],
            modelVersion:   pred.model_version,
            riskTrend:      pred.risk_trend,
            predictions:    pred.predictions,
            recommendation: pred.recommendation,
          });
        });
      } catch (err: any) {
        // Connection refused, DNS, abort — the service is not reachable.
        firstError ??= err?.message ?? String(err);
        return finish([...modelScored, ...ruleScored], false);
      }
    }
  }

  return finish([...modelScored, ...ruleScored], true);
}
