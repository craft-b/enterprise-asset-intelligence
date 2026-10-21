// server/services/champion-metrics.ts
//
// Registering the champion model that ships with the ML service image.
//
// The ML dashboard gates on /api/ml/model-metrics, which reads the
// model_metrics table, which is written by a training run. Training is refused
// below 500 labeled rows and a demo seed produces 40, so that table could
// never be populated on a demo deployment -- the dashboard showed a setup
// checklist reading "train the model" while a fully evaluated model sat loaded
// in the ML service, with ROC-AUC, calibration and operator metrics already
// measured on 10,589 rows.
//
// This copies those numbers into the table so the page renders what the system
// actually has.
//
// It is a copy, not a measurement. Everything that frames them travels with
// them: trained_at is the date of the run that produced the model, not today;
// dataset_size is that run's row count, not the caller's; data_source stays
// "simulated". A successful training run writes its own metrics and this does
// not interfere -- it only fills an empty table.

import { db } from "../db";
import { sql } from "drizzle-orm";
import { mlFetch, describeMlFailure } from "./ml-client";

/** Horizons the model is trained for. */
const HORIZONS = [10, 30, 60] as const;

interface MetricRow {
  horizon: number;
  split: "temporal" | "by_asset";
  metric: string;
  value: number;
}

export interface ChampionRegistration {
  version: string;
  trainedAt: Date;
  datasetSize: number | null;
  rows: number;
}

/**
 * Parse "0.9227 ± 0.0524" into mean and standard deviation.
 *
 * The training script stores these as two numbers; the metadata file stores
 * the formatted string it printed. Splitting on the separator rather than a
 * fixed index because the character varies with the encoding the file was
 * written under.
 */
export function parseCvRocAuc(raw: unknown): { mean?: number; std?: number } {
  if (typeof raw === "number") return { mean: raw };
  if (typeof raw !== "string") return {};

  const numbers = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return {};
  const mean = Number(numbers[0]);
  if (!Number.isFinite(mean)) return {};
  if (numbers.length === 1) return { mean };
  const std = Number(numbers[1]);
  return Number.isFinite(std) ? { mean, std } : { mean };
}

/** Keep only real numbers; a missing metric is omitted, never defaulted to 0. */
function push(rows: MetricRow[], horizon: number, split: MetricRow["split"], metric: string, value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return;
  rows.push({ horizon, split, metric, value: n });
}

/**
 * Flatten one horizon's metadata into the long format model_metrics uses.
 *
 * The metric names are the ones the training script writes and
 * /api/ml/model-metrics maps to camelCase. They are a contract between three
 * places, so they are spelled out here rather than derived from the metadata's
 * own key names, which differ (calibration.brier vs brier, per_class.failure
 * .precision vs precision_failure, confusion_matrix.TN vs confusion_tn).
 */
export function flattenHorizonMetadata(horizon: number, meta: Record<string, any>): MetricRow[] {
  const rows: MetricRow[] = [];
  if (!meta || typeof meta !== "object") return rows;

  // Headline holdout metrics.
  push(rows, horizon, "temporal", "roc_auc", meta.roc_auc);
  push(rows, horizon, "temporal", "pr_auc", meta.pr_auc);
  push(rows, horizon, "temporal", "accuracy", meta.accuracy);
  push(rows, horizon, "temporal", "train_accuracy", meta.train_accuracy);
  push(rows, horizon, "temporal", "positive_rate", meta.positive_rate);
  push(rows, horizon, "temporal", "samples_train", meta.samples_train);
  push(rows, horizon, "temporal", "samples_test", meta.samples_test);

  const cv = parseCvRocAuc(meta.cv_roc_auc);
  push(rows, horizon, "temporal", "cv_roc_auc_mean", cv.mean);
  push(rows, horizon, "temporal", "cv_roc_auc_std", cv.std);

  // Calibration (ML-5). Lives under its own key in the metadata, flat in the table.
  push(rows, horizon, "temporal", "brier", meta.calibration?.brier);
  push(rows, horizon, "temporal", "ece", meta.calibration?.ece);

  // Confusion matrix. Upper-case in the metadata, lower-case suffixes in the
  // table, where the route reassembles them into a confusion object.
  const cm = meta.confusion_matrix ?? {};
  push(rows, horizon, "temporal", "confusion_tn", cm.TN);
  push(rows, horizon, "temporal", "confusion_fp", cm.FP);
  push(rows, horizon, "temporal", "confusion_fn", cm.FN);
  push(rows, horizon, "temporal", "confusion_tp", cm.TP);

  // The positive rate OF THE TEST SPLIT, derived from the confusion matrix.
  //
  // Not meta.positive_rate: that is the rate across the whole dataset (0.5004
  // at v1.17), while the test split's is 0.29. The dashboard uses this as the
  // PR-AUC baseline and as the "never fails" accuracy comparison, so the
  // wrong one would overstate how hard the problem is and flatter the model.
  // Taking meta.positive_rate would have been close enough to look right and
  // wrong enough to matter.
  const testTotal = [cm.TN, cm.FP, cm.FN, cm.TP].reduce(
    (sum: number, v: unknown) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0), 0
  );
  if (testTotal > 0) {
    push(rows, horizon, "temporal", "positive_rate_test",
      (Number(cm.FN ?? 0) + Number(cm.TP ?? 0)) / testTotal);
  }

  // Per-class rates. "failure" is the positive class.
  push(rows, horizon, "temporal", "precision_failure", meta.per_class?.failure?.precision);
  push(rows, horizon, "temporal", "recall_failure", meta.per_class?.failure?.recall);
  push(rows, horizon, "temporal", "f1_failure", meta.per_class?.failure?.f1);
  push(rows, horizon, "temporal", "precision_no_failure", meta.per_class?.no_failure?.precision);
  push(rows, horizon, "temporal", "recall_no_failure", meta.per_class?.no_failure?.recall);

  // Operator metrics (ML-3) at the HIGH-band operating point.
  const OPERATOR = [
    "recall_failure_operating",
    "precision_at_budget",
    "lead_time_median_days",
    "lead_time_failures_flagged_pct",
  ] as const;
  for (const name of OPERATOR) {
    push(rows, horizon, "temporal", name, meta.operator_metrics_temporal?.[name]);
  }

  // By-asset grouped split -- the "new fleet, day one" question.
  const BY_ASSET = ["roc_auc", "pr_auc", "positive_rate", ...OPERATOR] as const;
  for (const name of BY_ASSET) {
    push(rows, horizon, "by_asset", name, meta.by_asset?.[name]);
  }

  return rows;
}

/** The run that produced the model, not the moment it was copied. */
function trainedAtFrom(metricsByHorizon: Record<string, any>): Date {
  for (const h of HORIZONS) {
    const raw = metricsByHorizon[String(h)]?.trained_at;
    if (typeof raw === "string") {
      const when = new Date(raw);
      if (!Number.isNaN(when.getTime())) return when;
    }
  }
  // Without a date the dashboard's "latest model" ordering has nothing to sort
  // by, so fall back rather than skip the import.
  return new Date();
}

/**
 * That run's dataset size, from the canonical horizon.
 *
 * Train + test + embargoed. The embargo drops rows either side of the
 * train/test boundary so no training row's features overlap a test row's label
 * window, and it widens with the horizon — 80 rows at 10 days, 239 at 30, 451
 * at 60. Those rows are part of the dataset; they are just unusable at that
 * horizon. Summing only train and test therefore gave a different answer per
 * horizon (10,748 / 10,589 / 10,377) for one dataset of 10,828, and the ML
 * dashboard showed the 30-day figure under the label "Training Dataset Size"
 * while the README said 10,828. Two numbers for the same thing.
 */
export function datasetSizeFrom(metricsByHorizon: Record<string, any>): number | null {
  const meta = metricsByHorizon["30"] ?? metricsByHorizon["10"] ?? metricsByHorizon["60"];
  const train = Number(meta?.samples_train);
  const test = Number(meta?.samples_test);
  const embargoed = Number(meta?.embargoed_rows);
  // Train and test are the required pair: without either there is no run to
  // report. An absent embargo count means an older metadata file, not zero
  // rows dropped, but zero is the only honest thing to add for it.
  if (!Number.isFinite(train) && !Number.isFinite(test)) return null;
  const orZero = (v: number) => (Number.isFinite(v) ? v : 0);
  return orZero(train) + orZero(test) + orZero(embargoed);
}

/** True when some model's metrics are already registered. */
export async function hasRegisteredMetrics(): Promise<boolean> {
  const [rows] = (await db.execute(sql`SELECT 1 FROM model_metrics LIMIT 1`)) as any;
  return (rows as any[]).length > 0;
}

/**
 * Copy the ML service's champion metrics into model_metrics.
 *
 * Idempotent: rows for the version being registered are replaced, so running
 * a seed twice does not double the table. The table has no unique key on
 * (version, horizon, split, metric), so this is done by delete-then-insert
 * rather than an upsert.
 */
export async function registerChampionMetrics(): Promise<ChampionRegistration> {
  const res = await mlFetch("/models/multi-horizon/metrics");
  if (!res.ok) {
    throw new Error(
      `Could not read champion metrics — ${await describeMlFailure(res, "/models/multi-horizon/metrics")}`
    );
  }

  const body = (await res.json()) as { versions?: Record<string, string>; metrics?: Record<string, any> };
  const metricsByHorizon = body.metrics ?? {};

  const version =
    metricsByHorizon["30"]?.version ??
    body.versions?.["30"] ??
    metricsByHorizon["10"]?.version ??
    metricsByHorizon["60"]?.version;
  if (!version) throw new Error("The ML service reported no model version");

  const rows = HORIZONS.flatMap(h => flattenHorizonMetadata(h, metricsByHorizon[String(h)]));
  if (rows.length === 0) {
    throw new Error(`The ML service reported no usable metrics for ${version}`);
  }

  const trainedAt = trainedAtFrom(metricsByHorizon);
  const datasetSize = datasetSizeFrom(metricsByHorizon);

  await db.execute(sql`DELETE FROM model_metrics WHERE model_version = ${version}`);

  const values = rows.map(
    r => sql`(${version}, ${r.horizon}, ${r.split}, ${r.metric}, ${r.value}, ${trainedAt}, ${datasetSize})`
  );
  await db.execute(
    sql`INSERT INTO model_metrics
          (model_version, horizon_days, split, metric, value, trained_at, dataset_size)
        VALUES ${sql.join(values, sql`, `)}`
  );

  return { version, trainedAt, datasetSize, rows: rows.length };
}

/**
 * Register the champion only if nothing is registered yet.
 *
 * Called in the background at boot so a deployment that was seeded before this
 * existed heals on its next restart, without a reseed. Never throws: an empty
 * dashboard is a worse outcome than it was, not a reason to fail startup.
 */
export async function registerChampionIfMissing(): Promise<void> {
  try {
    if (await hasRegisteredMetrics()) return;
    const result = await registerChampionMetrics();
    console.log(
      `[CHAMPION] Registered ${result.version} from the ML service image — ` +
      `${result.rows} metric rows, trained ${result.trainedAt.toISOString().slice(0, 10)}`
    );
  } catch (err: any) {
    console.warn("[CHAMPION] Could not register champion metrics:", err?.message ?? err);
  }
}
