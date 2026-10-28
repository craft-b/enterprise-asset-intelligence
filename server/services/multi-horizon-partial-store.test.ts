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

const { scoreFleetMultiHorizon, chunkEvenly } = await import("./multi-horizon-scoring");

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
    expect(outcome).toEqual({ results: [], attempted: 0, serviceAvailable: true, rateLimited: false });
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

describe("the host's CDN shedding load", () => {
  it("is reported as retryable, not as the model rejecting the fleet", async () => {
    // What a sixty-asset run actually produced: "Scored 0 of 60 assets.
    // https://eai-ml.onrender.com/predict/multi-horizon/batch returned 429
    // Too Many Requests (text/html)". A 429 is not the service answering --
    // it is the edge in front of it declining to ask. Reported as a refusal
    // it reads as the model having rejected all sixty, and the run stops
    // instead of waiting out a limit that clears on its own.
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 429 });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.rateLimited).toBe(true);
    expect(outcome.serviceAvailable).toBe(false);
  });

  it("is not confused with a suspended service", async () => {
    // The remedies are opposite. A waking service is helped along by another
    // request; a rate-limited one is not, so nothing nudges it and the wait
    // is longer.
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 503 });

    const outcome = await scoreFleetMultiHorizon(ids);

    expect(outcome.serviceAvailable).toBe(false);
    expect(outcome.rateLimited).toBe(false);
  });

  it("still keeps the forecasts it had already computed", async () => {
    const ids = mixedFleet();
    mlFetch.mockResolvedValue({ ok: false, status: 429 });

    await scoreFleetMultiHorizon(ids);

    expect(inserted.map(r => r.equipmentId).sort()).toEqual([3, 4]);
  });
});

describe("chunkEvenly", () => {
  it("splits evenly rather than leaving a small tail", () => {
    // Greedy chunking of fifty at thirty gives 30/20; of forty-five, 30/15.
    // The drift checks skip any batch under MIN_BATCH_SIZE (20), so a greedy
    // tail is silently dropped from feature, prediction and bias drift.
    expect(chunkEvenly(Array.from({ length: 50 }, (_, i) => i), 30).map(g => g.length))
      .toEqual([25, 25]);
    expect(chunkEvenly(Array.from({ length: 45 }, (_, i) => i), 30).map(g => g.length))
      .toEqual([23, 22]);
    expect(chunkEvenly(Array.from({ length: 60 }, (_, i) => i), 30).map(g => g.length))
      .toEqual([30, 30]);
  });

  it("never makes a group larger than the maximum", () => {
    for (let n = 1; n <= 200; n++) {
      for (const max of [20, 30, 50]) {
        for (const g of chunkEvenly(Array.from({ length: n }, (_, i) => i), max)) {
          expect(g.length).toBeLessThanOrEqual(max);
          expect(g.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps every item, once, in order", () => {
    const items = Array.from({ length: 97 }, (_, i) => i);
    expect(chunkEvenly(items, 30).flat()).toEqual(items);
  });

  it("leaves a fleet that already fits as one group", () => {
    expect(chunkEvenly([1, 2, 3], 30)).toEqual([[1, 2, 3]]);
    expect(chunkEvenly([], 30)).toEqual([]);
  });

  it("will not split below the drift floor", () => {
    // Thirty-five at thirty is 18/17 -- two groups, both under the ML
    // service's MIN_BATCH_SIZE of 20, so every drift check is skipped while
    // both requests report success and the forecasts store normally. The
    // only visible difference would be the three cards going back to
    // explaining themselves, which is not a symptom anyone would trace here.
    const n = (count: number) => Array.from({ length: count }, (_, i) => i);
    expect(chunkEvenly(n(35), 30, 20).map(g => g.length)).toEqual([35]);
    expect(chunkEvenly(n(39), 30, 20).map(g => g.length)).toEqual([39]);
    expect(chunkEvenly(n(40), 30, 20).map(g => g.length)).toEqual([20, 20]);
    expect(chunkEvenly(n(60), 30, 20).map(g => g.length)).toEqual([30, 30]);
  });

  it("keeps every group at or above the floor whenever it splits at all", () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => i);
    for (let count = 20; count <= 300; count++) {
      const groups = chunkEvenly(n(count), 30, 20);
      if (groups.length > 1) {
        for (const g of groups) expect(g.length).toBeGreaterThanOrEqual(20);
      }
      expect(groups.flat()).toHaveLength(count);
    }
  });
});

describe("scoring the fleet in groups", () => {
  it("sends more than one request for a sixty-asset fleet", async () => {
    generateSnapshot.mockImplementation(async () => ({ ...established }));
    const horizon = {
      failure_probability: 0.4, risk_level: "MEDIUM",
      top_risk_drivers: {}, shap_attribution: {},
    };
    mlFetch.mockImplementation(async (_p: string, init: any) => {
      const sent = JSON.parse(init.body).snapshots.length;
      return {
        ok: true,
        json: async () => ({
          predictions: Array.from({ length: sent }, () => ({
            model_version: "v1.17", risk_trend: "STABLE",
            predictions: { "10d": horizon, "30d": horizon, "60d": horizon },
            recommendation: "Monitor",
          })),
        }),
      };
    });

    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const outcome = await scoreFleetMultiHorizon(ids);

    expect(mlFetch.mock.calls.length).toBe(2);
    expect(outcome.results).toHaveLength(60);
    // Every asset stored, each exactly once, with its own id.
    expect(inserted.map(r => r.equipmentId).sort((a, b) => a - b)).toEqual(ids);
  });

  it("keeps what earlier groups scored when a later one fails", async () => {
    // This was all-or-nothing: one bad response at any point and the entire
    // run produced nothing, however much had already been scored.
    generateSnapshot.mockImplementation(async () => ({ ...established }));
    const horizon = {
      failure_probability: 0.4, risk_level: "MEDIUM",
      top_risk_drivers: {}, shap_attribution: {},
    };
    let call = 0;
    mlFetch.mockImplementation(async (_p: string, init: any) => {
      const sent = JSON.parse(init.body).snapshots.length;
      if (++call > 1) return { ok: false, status: 502 };
      return {
        ok: true,
        json: async () => ({
          predictions: Array.from({ length: sent }, () => ({
            model_version: "v1.17", risk_trend: "STABLE",
            predictions: { "10d": horizon, "30d": horizon, "60d": horizon },
            recommendation: "Monitor",
          })),
        }),
      };
    });

    const outcome = await scoreFleetMultiHorizon(Array.from({ length: 60 }, (_, i) => i + 1));

    expect(outcome.serviceAvailable).toBe(false);
    expect(outcome.results).toHaveLength(30);
    expect(inserted).toHaveLength(30);
  });

  it("maps predictions to the right asset in the second group", async () => {
    // The ids were sliced per group; an off-by-one here would file group
    // two's forecasts under group one's assets, which no assertion on counts
    // would notice.
    generateSnapshot.mockImplementation(async () => ({ ...established }));
    mlFetch.mockImplementation(async (_p: string, init: any) => {
      const sent = JSON.parse(init.body).snapshots;
      return {
        ok: true,
        json: async () => ({
          predictions: sent.map((snap: any) => ({
            model_version: `eq-${snap.equipment_id}`,
            risk_trend: "STABLE",
            predictions: {
              "10d": { failure_probability: 0.1, risk_level: "LOW", top_risk_drivers: {}, shap_attribution: {} },
              "30d": { failure_probability: 0.1, risk_level: "LOW", top_risk_drivers: {}, shap_attribution: {} },
              "60d": { failure_probability: 0.1, risk_level: "LOW", top_risk_drivers: {}, shap_attribution: {} },
            },
            recommendation: null,
          })),
        }),
      };
    });

    await scoreFleetMultiHorizon(Array.from({ length: 60 }, (_, i) => i + 1));

    // toMlSnapshot is stubbed to echo the equipment id, so the model_version
    // each row carries names the asset the service was actually asked about.
    for (const row of inserted) {
      expect(row.modelVersion).toBe(`eq-${row.equipmentId}`);
    }
  });
});
