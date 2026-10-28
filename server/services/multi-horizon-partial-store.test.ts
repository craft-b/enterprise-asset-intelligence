// server/services/multi-horizon-partial-store.test.ts
//
// "Run Multi-Horizon Forecast" produced no predictions at all against a
// suspended ML service -- not even for the assets that do not need one.
//
// Brand-new units are out of distribution, so a rule scores them rather than
// letting the model extrapolate past its training data (ML-10). That rule runs
// in Node and touches nothing external. But both of the ML-failure returns in
// scoreFleetMultiHorizon sat ABOVE the loop that writes rows, so a cold start
// computed those rule-scored forecasts and then dropped them on the floor. On
// the sixty-unit fleet that is a dozen assets whose answer was already in hand
// and was discarded for a reason that did not apply to them -- and the Fleet
// Command Center reads that table, so the page said there was nothing at all.
//
// Every exit now goes through one storing path, which is what these tests pin.

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rows handed to db.insert(...).values(...). */
const inserted: any[] = [];

vi.mock("../db", () => ({
  db: {
    insert: () => ({
      values: async (row: any) => { inserted.push(row); },
    }),
  },
}));

vi.mock("../../shared/schema", () => ({ equipmentFailurePredictions: {} }));

const generateSnapshot = vi.fn();
vi.mock("./feature-engineering-enhanced", () => ({
  enhancedFeatureService: { generateSnapshot: (...a: unknown[]) => generateSnapshot(...a) },
}));

// The real bounded map, so the concurrency change is exercised rather than
// stubbed past: a test that replaced it with Promise.all would still pass if
// the fan-out regressed.
vi.mock("./feature-engineering", async () => {
  const actual = await vi.importActual<typeof import("./feature-engineering")>("./feature-engineering");
  return { mapWithConcurrency: actual.mapWithConcurrency, snapshotConcurrency: () => 4 };
});

const mlFetch = vi.fn();
vi.mock("./ml-client", () => ({
  mlFetch: (...a: unknown[]) => mlFetch(...a),
  describeMlFailure: async () => "503 Service Unavailable",
  ML_SLOW_TIMEOUT_MS: 300_000,
}));

vi.mock("./ml-snapshot-payload", () => ({
  toMlSnapshot: (equipmentId: number) => ({ equipment_id: equipmentId }),
}));

vi.mock("./simulation-clock", () => ({ getSimulationDate: async () => "2026-10-28" }));

const { scoreFleetMultiHorizon } = await import("./multi-horizon-scoring");

/** A unit old enough that the model, not the rule, scores it. */
const established = { assetAgeYears: 7, totalHoursLifetime: 9000, category: "Excavator" };
/** A unit inside the cold-start band, which the rule scores in Node. */
const brandNew = { assetAgeYears: 0.1, totalHoursLifetime: 5, category: "Excavator" };

beforeEach(() => {
  inserted.length = 0;
  generateSnapshot.mockReset();
  mlFetch.mockReset();
});

/** ids 1-2 are established, 3-4 brand new. */
function mixedFleet(): number[] {
  generateSnapshot.mockImplementation(async (id: number) =>
    id <= 2 ? { ...established } : { ...brandNew });
  return [1, 2, 3, 4];
}

describe("a suspended ML service", () => {
  it("still stores the assets a rule scored", async () => {
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 503 });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.serviceAvailable).toBe(false);
    // Two rule-scored assets, in hand before the service was ever called.
    expect(outcome.results).toHaveLength(2);
    expect(inserted).toHaveLength(2);
    expect(inserted.map(r => r.equipmentId).sort()).toEqual([3, 4]);
  });

  it("stores them when the service cannot be reached at all", async () => {
    // Connection refused, DNS, an aborted fetch: a different branch from a
    // gateway status, and it was dropping the same results.
    const ids = mixedFleet();
    mlFetch.mockRejectedValue(new Error("fetch failed"));

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.serviceAvailable).toBe(false);
    expect(inserted.map(r => r.equipmentId).sort()).toEqual([3, 4]);
    expect(outcome.firstError).toContain("fetch failed");
  });

  it("reports unavailable rather than pretending it scored the fleet", async () => {
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 503 });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.attempted).toBe(4);
    expect(outcome.results.length).toBeLessThan(outcome.attempted);
  });

  it("distinguishes a rejecting service from an absent one", async () => {
    // 400 is the service answering, so it is available and the caller must
    // not sit in a wake-retry loop against a request it should fix instead.
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 400 });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.serviceAvailable).toBe(true);
    expect(inserted.map(r => r.equipmentId).sort()).toEqual([3, 4]);
  });
});

describe("a healthy ML service", () => {
  it("stores both the model-scored and the rule-scored assets", async () => {
    const ids = mixedFleet();
    const horizon = {
      failure_probability: 0.42, risk_level: "MEDIUM",
      top_risk_drivers: { wear_rate: 0.3 }, shap_attribution: { wear_rate: 0.3 },
    };
    mlFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        predictions: [1, 2].map(() => ({
          model_version: "v1.17",
          risk_trend: "STABLE",
          predictions: { "10d": horizon, "30d": horizon, "60d": horizon },
          recommendation: "Monitor",
        })),
      }),
    });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.serviceAvailable).toBe(true);
    expect(outcome.results).toHaveLength(4);
    expect(inserted.map(r => r.equipmentId).sort()).toEqual([1, 2, 3, 4]);
  });

  it("is never called when every asset was rule-scored", async () => {
    // Waking a suspended container to ask it nothing costs a minute and
    // produces no answer.
    generateSnapshot.mockImplementation(async () => ({ ...brandNew }));

    const outcome = await scoreFleetMultiHorizon([7, 8]);

    expect(mlFetch).not.toHaveBeenCalled();
    expect(outcome.serviceAvailable).toBe(true);
    expect(inserted).toHaveLength(2);
  });

  it("stores nothing and calls nothing for an empty fleet", async () => {
    const outcome = await scoreFleetMultiHorizon([]);
    expect(outcome).toEqual({ results: [], attempted: 0, serviceAvailable: true });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("snapshot generation", () => {
  it("keeps a failed snapshot from losing the rest of the fleet", async () => {
    generateSnapshot.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error("deadlock");
      return { ...brandNew };
    });

    const outcome = await scoreFleetMultiHorizon([1, 2, 3]);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.firstError).toContain("snapshot failed for equipment 2");
    expect(inserted.map(r => r.equipmentId).sort()).toEqual([1, 3]);
  });

  it("does not open one query per asset at once", async () => {
    // Sixty assets, a handful of queries each, against a serverless database
    // and a pool that defaults to ten connections. The backfill path was
    // bounded for this reason; this one was left on Promise.all because it
    // used to run over ten assets.
    let inFlight = 0;
    let peak = 0;
    generateSnapshot.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { ...brandNew };
    });

    await scoreFleetMultiHorizon(Array.from({ length: 60 }, (_, i) => i + 1));

    expect(peak).toBeLessThanOrEqual(4);
    expect(inserted).toHaveLength(60);
  });
});
