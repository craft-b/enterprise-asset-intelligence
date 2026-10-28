// client/src/hooks/multi-horizon-invalidation.test.ts
//
// Running the multi-horizon forecast appeared to do nothing.
//
// It did plenty: the batch endpoint writes stored predictions and all three
// drift layers. But every view of that work is a cached query -- the drift
// hooks hold results for two minutes, and queryClient sets
// refetchOnWindowFocus and refetchInterval to false globally -- and this
// mutation's onSuccess set local component state and nothing else. The rows
// landed, the dashboard kept rendering the state from before the click, and
// the only way to see the result was to reload the page.
//
// Which is the same defect as the drift cards describing a state the data was
// not in, and the sign-in button narrating a step it had not reached: the work
// completed, the interface did not say so.
//
// Asserted against the source. These hooks need a React renderer and a
// QueryClientProvider to exercise, and neither jsdom nor @testing-library is
// installed here (vitest.config.ts runs in the node environment on purpose).
// The structural claim -- that this call site invalidates what it writes -- is
// what regressed, and it is visible in the source.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const RISK = readFileSync(join(__dirname, "use-risk-score.ts"), "utf-8");
const PM = readFileSync(join(__dirname, "use-predictive-maintenance.ts"), "utf-8");

/** The body of useMultiHorizonRiskScores, comments stripped. */
function batchHook(): string {
  const start = RISK.indexOf("export function useMultiHorizonRiskScores");
  expect(start, "useMultiHorizonRiskScores not found").toBeGreaterThan(-1);
  const next = RISK.indexOf("export function", start + 10);
  const body = RISK.slice(start, next === -1 ? undefined : next);
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the multi-horizon batch refreshes what it writes", () => {
  const body = batchHook();

  it("invalidates the stored predictions it just replaced", () => {
    expect(body).toContain('"/api/risk-score/multi-horizon/latest"');
  });

  it("invalidates all three drift layers", () => {
    // The batch endpoint is where feature, prediction and bias drift are all
    // computed, so a run that leaves any of the three showing a stale reading
    // is reporting the previous fleet.
    expect(body).toContain('"/api/ml/drift/latest"');
    expect(body).toContain('"/api/ml/drift/prediction"');
    expect(body).toContain('"/api/ml/drift/bias"');
  });

  it("actually calls invalidateQueries, not just names the keys", () => {
    // A list of keys with nothing iterating it would satisfy every assertion
    // above while changing nothing.
    expect(body).toMatch(/queryClient\.invalidateQueries\(/);
  });

  it("reports completion instead of finishing silently", () => {
    // A long action that ends in silence is indistinguishable from one that
    // failed quietly.
    expect(body).toMatch(/toast\(\{/);
    expect(body).toContain("onError");
  });
});

describe("the sibling that already did this is unchanged", () => {
  it("useScoreRiskQueue still invalidates the risk queue views", () => {
    // This one was always correct. Pinned so a future edit does not level the
    // two hooks downward instead of upward.
    const start = PM.indexOf("export function useScoreRiskQueue");
    const body = PM.slice(start, PM.indexOf("export function", start + 10));
    expect(body).toContain("'/api/predictive-maintenance/fleet-risk'");
    expect(body).toContain("'/api/predictive-maintenance/equipment-with-risk'");
  });
});
