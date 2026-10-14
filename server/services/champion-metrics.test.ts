// server/services/champion-metrics.test.ts
//
// The champion's metrics reach the dashboard through a long-format table and a
// name lookup: the ML service's metadata is flattened into
// (horizon, split, metric, value) rows, and /api/ml/model-metrics pivots them
// back using metricKeyMap. A metric whose name is not in that map is dropped
// silently -- the row is written, the query finds it, the pivot ignores it,
// and the dashboard renders a blank cell with no error anywhere.
//
// So the names are a contract between three files, and the metadata does not
// use them: it has calibration.brier for brier, confusion_matrix.TN for
// confusion_tn, per_class.failure.precision for precision_failure, and
// cv_roc_auc as the formatted string "0.9227 ± 0.0524" where the table wants
// two numbers. Most of this file is about that translation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { flattenHorizonMetadata, parseCvRocAuc } from "./champion-metrics";

/**
 * The real metadata_30d_v1.17.json from the shipped bundle, trimmed to the
 * fields that matter here. Values are verbatim, so a change in the trainer's
 * output shape fails this rather than quietly halving what the page shows.
 */
const META_30D = {
  version: "v1.17",
  horizon_days: 30,
  algorithm: "Random Forest (calibrated, isotonic)",
  trained_at: "2026-07-08T21:29:02.226237",
  data_source: "simulated",
  metrics_framing: "pipeline verification on synthetic data — pending real fleet labels",
  operator_metrics_temporal: {
    recall_failure_operating: 0.7722929936305732,
    precision_at_budget: 0.8957528957528959,
    lead_time_median_days: 26.0,
    lead_time_failures_flagged_pct: 0.960308710033076,
    lead_time_failures_evaluable: 907,
    operating_threshold: 0.6,
    budget_fraction: 0.1,
  },
  by_asset: {
    roc_auc: 0.9334940900087272,
    pr_auc: 0.946576371681146,
    positive_rate: 0.5003694126339121,
    n_evaluated: 10828,
    n_folds: 5,
    recall_failure_operating: 0.7951273532668881,
    precision_at_budget: 0.9792986159981233,
    lead_time_median_days: 26.0,
    lead_time_failures_flagged_pct: 0.9661627790569627,
  },
  accuracy: 0.9141,
  train_accuracy: 0.9425,
  roc_auc: 0.8823,
  pr_auc: 0.8079,
  cv_roc_auc: "0.9227 ± 0.0524",
  positive_rate: 0.5004,
  samples_train: 8423,
  samples_test: 2166,
  calibration: { brier: 0.08, ece: 0.0317, ece_gate_passed: true },
  confusion_matrix: { TN: 1495, FP: 43, FN: 143, TP: 485 },
  per_class: {
    no_failure: { precision: 0.9127, recall: 0.972, f1: 0.9414, support: 1538 },
    failure: { precision: 0.9186, recall: 0.7723, f1: 0.8391, support: 628 },
  },
};

const rowsFor = (meta: any) => flattenHorizonMetadata(30, meta);
const value = (rows: ReturnType<typeof rowsFor>, metric: string, split = "temporal") =>
  rows.find(r => r.metric === metric && r.split === split)?.value;

describe("parseCvRocAuc", () => {
  it("splits the formatted string the trainer writes", () => {
    expect(parseCvRocAuc("0.9227 ± 0.0524")).toEqual({ mean: 0.9227, std: 0.0524 });
  });

  it("handles the mangled separator", () => {
    // The file is written under whatever encoding the trainer ran with, and
    // the separator has arrived as "+/-" and as a replacement character.
    expect(parseCvRocAuc("0.9227 +/- 0.0524")).toEqual({ mean: 0.9227, std: 0.0524 });
    expect(parseCvRocAuc("0.9227 � 0.0524")).toEqual({ mean: 0.9227, std: 0.0524 });
  });

  it("accepts a bare number", () => {
    expect(parseCvRocAuc(0.9227)).toEqual({ mean: 0.9227 });
    expect(parseCvRocAuc("0.9227")).toEqual({ mean: 0.9227 });
  });

  it("returns nothing it cannot read, rather than zero", () => {
    // A zero would render as a real CV score of 0.000 on the dashboard.
    expect(parseCvRocAuc(undefined)).toEqual({});
    expect(parseCvRocAuc(null)).toEqual({});
    expect(parseCvRocAuc("not a number")).toEqual({});
  });
});

describe("flattenHorizonMetadata", () => {
  const rows = rowsFor(META_30D);

  it("carries the headline holdout metrics", () => {
    expect(value(rows, "roc_auc")).toBe(0.8823);
    expect(value(rows, "pr_auc")).toBe(0.8079);
    expect(value(rows, "accuracy")).toBe(0.9141);
    expect(value(rows, "train_accuracy")).toBe(0.9425);
    expect(value(rows, "samples_train")).toBe(8423);
    expect(value(rows, "samples_test")).toBe(2166);
  });

  it("lifts calibration out of its own object", () => {
    expect(value(rows, "brier")).toBe(0.08);
    expect(value(rows, "ece")).toBe(0.0317);
  });

  it("lower-cases the confusion matrix keys", () => {
    // Metadata has TN/FP/FN/TP; the route reassembles confusion_* rows.
    expect(value(rows, "confusion_tn")).toBe(1495);
    expect(value(rows, "confusion_fp")).toBe(43);
    expect(value(rows, "confusion_fn")).toBe(143);
    expect(value(rows, "confusion_tp")).toBe(485);
  });

  it("maps the positive class to the _failure names", () => {
    expect(value(rows, "precision_failure")).toBe(0.9186);
    expect(value(rows, "recall_failure")).toBe(0.7723);
    expect(value(rows, "f1_failure")).toBe(0.8391);
    expect(value(rows, "precision_no_failure")).toBe(0.9127);
    expect(value(rows, "recall_no_failure")).toBe(0.972);
  });

  it("does not confuse the two classes", () => {
    // precision is 0.9186 for failure and 0.9127 for no_failure -- close
    // enough that a swap would look plausible on the page.
    expect(value(rows, "precision_failure")).not.toBe(0.9127);
    expect(value(rows, "recall_failure")).not.toBe(0.972);
  });

  it("splits the CV string into two rows", () => {
    expect(value(rows, "cv_roc_auc_mean")).toBe(0.9227);
    expect(value(rows, "cv_roc_auc_std")).toBe(0.0524);
  });

  it("keeps operator metrics on the temporal split", () => {
    expect(value(rows, "recall_failure_operating")).toBeCloseTo(0.7722929936, 9);
    expect(value(rows, "precision_at_budget")).toBeCloseTo(0.8957528957, 9);
    expect(value(rows, "lead_time_median_days")).toBe(26);
    expect(value(rows, "lead_time_failures_flagged_pct")).toBeCloseTo(0.96030871, 8);
  });

  it("keeps the by-asset split separate, with its own values", () => {
    // Same metric names, different numbers, different split. Collapsing the
    // two would overwrite the headline ROC-AUC with the grouped-CV one and
    // make the model look better than its temporal holdout says.
    expect(value(rows, "roc_auc", "by_asset")).toBeCloseTo(0.93349409, 8);
    expect(value(rows, "roc_auc", "temporal")).toBe(0.8823);
    expect(value(rows, "precision_at_budget", "by_asset")).toBeCloseTo(0.979298616, 9);
    expect(value(rows, "precision_at_budget", "temporal")).toBeCloseTo(0.8957528957, 9);
  });

  it("tags every row with the horizon it was asked for", () => {
    expect(rows.every(r => r.horizon === 30)).toBe(true);
    expect(flattenHorizonMetadata(10, META_30D).every(r => r.horizon === 10)).toBe(true);
  });

  it("omits a missing metric instead of writing zero", () => {
    const partial = { roc_auc: 0.8, version: "v1.17" };
    const out = rowsFor(partial);

    expect(value(out, "roc_auc")).toBe(0.8);
    expect(value(out, "brier")).toBeUndefined();
    expect(out.some(r => r.metric === "pr_auc")).toBe(false);
    // A zero pr_auc would render as a real measurement of a useless model.
    expect(out.every(r => Number.isFinite(r.value))).toBe(true);
  });

  it("survives metadata that is absent or the wrong shape", () => {
    expect(flattenHorizonMetadata(30, undefined as any)).toEqual([]);
    expect(flattenHorizonMetadata(30, null as any)).toEqual([]);
    expect(flattenHorizonMetadata(30, {} as any)).toEqual([]);
  });

  it("produces enough rows to fill the page", () => {
    // Guards against a refactor that silently drops most of the translation.
    expect(rows.length).toBeGreaterThan(25);
  });
});

describe("the metric names the dashboard actually reads", () => {
  // /api/ml/model-metrics pivots rows through metricKeyMap. A name missing
  // from that map is written to the table and then ignored by the pivot, with
  // no error on either side.
  const ROUTES = readFileSync(join(__dirname, "..", "routes.ts"), "utf-8");

  /** The keys of metricKeyMap in routes.ts. */
  function mappedNames(): Set<string> {
    const block = ROUTES.match(/const metricKeyMap[^=]*=\s*\{([\s\S]*?)\n      \};/);
    if (!block) return new Set();
    // Several keys share a line ("roc_auc: 'rocAuc', pr_auc: 'prAuc',"), so
    // this matches every name: 'camelCase' pair rather than one per line.
    return new Set(
      Array.from(block[1].matchAll(/([a-z0-9_]+)\s*:\s*'/g)).map(m => m[1])
    );
  }

  it("found the map it is checking against", () => {
    // Guards the test: an unparsed map would make the sweep below vacuous.
    const names = mappedNames();
    expect(names.size).toBeGreaterThan(15);
    expect(names.has("roc_auc")).toBe(true);
    expect(names.has("precision_at_budget")).toBe(true);
  });

  it("emits nothing the pivot would throw away", () => {
    const mapped = mappedNames();
    const emitted = rowsFor(META_30D).map(r => r.metric);

    const unknown = emitted.filter(
      m => !mapped.has(m) && !m.startsWith("confusion_")
    );
    expect(
      Array.from(new Set(unknown)),
      "these are written to model_metrics and then ignored by the pivot in " +
      "/api/ml/model-metrics — add them to metricKeyMap or stop emitting them"
    ).toEqual([]);
  });
});

describe("the positive rate the dashboard actually reads", () => {
  const rows = rowsFor(META_30D);

  it("derives the test split's rate from the confusion matrix", () => {
    // (FN + TP) / all = (143 + 485) / 2166
    expect(value(rows, "positive_rate_test")).toBeCloseTo(628 / 2166, 6);
  });

  it("does not pass off the whole-dataset rate as the test split's", () => {
    // meta.positive_rate is 0.5004 across the full dataset; the test split is
    // 0.29. The dashboard uses this as the PR-AUC baseline and the "never
    // fails" accuracy comparison, so the wrong one flatters the model.
    expect(value(rows, "positive_rate_test")).not.toBeCloseTo(0.5004, 3);
    expect(value(rows, "positive_rate_test")!).toBeLessThan(0.35);
  });

  it("agrees with the reported class support", () => {
    // per_class.failure.support is the same quantity by another route.
    const fromSupport = META_30D.per_class.failure.support / META_30D.samples_test;
    expect(value(rows, "positive_rate_test")).toBeCloseTo(fromSupport, 6);
  });

  it("omits it rather than dividing by zero", () => {
    const out = rowsFor({ roc_auc: 0.8, confusion_matrix: { TN: 0, FP: 0, FN: 0, TP: 0 } });
    expect(out.some(r => r.metric === "positive_rate_test")).toBe(false);
  });
});
