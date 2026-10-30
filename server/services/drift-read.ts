// server/services/drift-read.ts
//
// Reading drift from the database the ML service writes it to.
//
// These three endpoints used to proxy to the ML service. They did not need to:
// the service's own handlers for them are SQL queries against drift_metrics,
// prediction_drift_metrics and bias_drift_metrics, with no model loaded and
// nothing computed. The ML service was acting as a database proxy for a
// database this process is already connected to.
//
// That was merely wasteful until the host put a Cloudflare challenge between
// the two services, at which point three dashboard cards went blank over data
// sitting in MySQL the whole time. Scoring runs persist their readings; the
// readings outlive the service that produced them.
//
// What still needs the ML service is genuinely computational: recomputing a
// reference distribution, and scoring a new batch. Those stay proxied, and
// they are the only two that should be.
//
// Shapes mirror the FastAPI responses field for field, including the
// snake_case the client already reads, so nothing downstream changes.

import { db } from "../db";
import { sql } from "drizzle-orm";

/** The features drift is tracked on. Mirrors MONITORED_FEATURES. */
export const MONITORED_FEATURES = [
  "mean_time_between_failures",
  "vendor_reliability_score",
  "mechanical_wear_score",
  "neglect_score",
  "hours_used_90d",
] as const;

/** Snapshots a batch needs before its PSI means anything. Mirrors the service. */
export const MIN_BATCH_SIZE = 20;

/** The horizon bias is reported on, matching the service's own filter. */
const BIAS_HORIZON = 30;

type Status = "STABLE" | "WARNING" | "ALERT";

/** ALERT beats WARNING beats STABLE; nothing at all is NO_DATA. */
function rollUp(statuses: string[]): Status | "NO_DATA" {
  if (statuses.includes("ALERT")) return "ALERT";
  if (statuses.includes("WARNING")) return "WARNING";
  return statuses.length > 0 ? "STABLE" : "NO_DATA";
}

/** MySQL hands DECIMAL back as a string; the client expects a number. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rows<T>(result: unknown): T[] {
  // mysql2 returns [rows, fields]; drizzle's execute passes that through.
  const first = Array.isArray(result) ? result[0] : result;
  return Array.isArray(first) ? (first as T[]) : [];
}

/**
 * The reference block that travels with the readings.
 *
 * It exists so a card can tell apart the reasons there might be nothing to
 * show — no baseline, a baseline with no qualifying batch, or real readings —
 * which is the distinction that stopped the monitor advising an admin to
 * compute a reference that already existed.
 */
async function latestReference() {
  const r = rows<any>(await db.execute(sql`
    SELECT model_version, feature_count, horizon_count, bias_category_count
    FROM drift_reference ORDER BY computed_at DESC LIMIT 1
  `));
  const ref = r[0];
  return {
    loaded: Boolean(ref),
    model_version: ref?.model_version ?? null,
    features: Number(ref?.feature_count ?? 0),
    horizons: Number(ref?.horizon_count ?? 0),
    bias_categories: Number(ref?.bias_category_count ?? 0),
  };
}

/** Most recent PSI row per monitored feature. */
export async function featureDrift() {
  const result = rows<any>(await db.execute(sql`
    SELECT d1.* FROM drift_metrics d1
    INNER JOIN (
      SELECT feature, MAX(id) AS latest_id FROM drift_metrics
      WHERE feature IN (${sql.join(MONITORED_FEATURES.map(f => sql`${f}`), sql`, `)})
      GROUP BY feature
    ) d2 ON d1.id = d2.latest_id
    ORDER BY d1.psi DESC
  `));

  const features = result.map(r => ({
    feature: r.feature,
    psi: num(r.psi) ?? 0,
    status: r.status as Status,
    checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : String(r.checked_at),
    model_version: r.model_version ?? "",
    batch_size: Number(r.batch_size) || 0,
    ref_mean: num(r.ref_mean),
    cur_mean: num(r.cur_mean),
    ref_std: num(r.ref_std),
    cur_std: num(r.cur_std),
  }));

  return {
    overall: rollUp(features.map(f => f.status)),
    features,
    min_batch_size: MIN_BATCH_SIZE,
    reference: await latestReference(),
  };
}

/** Most recent prediction-drift row per horizon. */
export async function predictionDrift() {
  const result = rows<any>(await db.execute(sql`
    SELECT p1.* FROM prediction_drift_metrics p1
    INNER JOIN (
      SELECT horizon, MAX(id) AS latest_id FROM prediction_drift_metrics GROUP BY horizon
    ) p2 ON p1.id = p2.latest_id
    ORDER BY p1.horizon
  `));

  const horizons = result.map(r => ({
    horizon: Number(r.horizon),
    score_psi: num(r.score_psi) ?? 0,
    score_status: r.score_status as Status,
    checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : String(r.checked_at),
    model_version: r.model_version ?? "",
    batch_size: Number(r.batch_size) || 0,
    high_pct: num(r.high_pct),
    medium_pct: num(r.medium_pct),
    low_pct: num(r.low_pct),
    ref_high_pct: num(r.ref_high_pct),
    ref_medium_pct: num(r.ref_medium_pct),
    ref_low_pct: num(r.ref_low_pct),
  }));

  return { overall: rollUp(horizons.map(h => h.score_status)), horizons };
}

/** Most recent bias row per category, at the reported horizon. */
export async function biasDrift() {
  const result = rows<any>(await db.execute(sql`
    SELECT b1.* FROM bias_drift_metrics b1
    INNER JOIN (
      SELECT category, horizon, MAX(id) AS latest_id FROM bias_drift_metrics
      WHERE horizon = ${BIAS_HORIZON} GROUP BY category, horizon
    ) b2 ON b1.id = b2.latest_id
    ORDER BY b1.deviation DESC
  `));

  const categories = result.map(r => ({
    category: r.category,
    horizon: Number(r.horizon),
    mean_score: num(r.mean_score),
    high_pct: num(r.high_pct),
    ref_high_pct: num(r.ref_high_pct),
    deviation: num(r.deviation) ?? 0,
    alert: Boolean(r.alert),
    checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : String(r.checked_at),
    model_version: r.model_version ?? "",
    batch_size: Number(r.batch_size) || 0,
  }));

  // Bias carries a boolean rather than a status enum, so the roll-up differs.
  return {
    overall: categories.length === 0 ? "NO_DATA" : categories.some(c => c.alert) ? "ALERT" : "STABLE",
    categories,
  };
}
