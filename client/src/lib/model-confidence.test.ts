import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { confidenceLabel } from "./model-confidence";

const repo = (...p: string[]) => readFileSync(join(__dirname, "../../..", ...p), "utf-8");

describe("confidenceLabel", () => {
  it("matches the service's wording at each level", () => {
    expect(confidenceLabel(0.92)).toBe("high (holdout ROC-AUC 0.92)");
    expect(confidenceLabel(0.85)).toBe("moderate (holdout ROC-AUC 0.85)");
    expect(confidenceLabel(0.71)).toBe("low (holdout ROC-AUC 0.71)");
    expect(confidenceLabel(undefined)).toBe("unknown");
  });

  it("keeps the service's cutoffs", () => {
    const predictor = repo("ml-service/engine/predictor_multihorizon.py");
    expect(predictor).toContain("if roc_auc >= 0.90:");
    expect(predictor).toContain("if roc_auc >= 0.80:");
  });
});

describe("the predictive maintenance page", () => {
  const page = repo("client/src/pages/predictive-maintenance-dashboard.tsx");

  it("does not hardcode a confidence level", () => {
    expect(page).not.toMatch(/model_confidence: "/);
    expect(page).not.toContain("high confidence");
  });

  it("reads stored predictions ahead of the last run held in memory", () => {
    // A run's results used to win until the page reloaded, so a service logged
    // after a run showed the old numbers and looked like it had done nothing.
    expect(page).toContain("latestPredictions?.length ? latestPredictions : scores");
  });
});
