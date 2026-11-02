// server/services/ml-response-cache.test.ts
//
// The cache and the budget that bound what viewer traffic can make the ML
// service do -- and the arithmetic that says the bound fits in Cloud Run's
// free allowance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cachedMl, invalidateMlCache, resetMlCache, worstCaseMonthlyMlRequests,
  ML_CACHE_TTL_MS, ML_VIEWER_BUDGET, BUDGET_SPENT_MESSAGE, type MlOutcome,
} from "./ml-response-cache";

const ok = (body: unknown = { n: 1 }): MlOutcome => ({ status: 200, body });
let now = 1_000_000;
const clock = () => now;
const free = { ttlMs: 60_000, budgeted: false };
const metered = { ttlMs: 60_000, budgeted: true };

beforeEach(() => {
  resetMlCache();
  now = 1_000_000;
});

describe("caching", () => {
  it("answers from the cache until the TTL, then asks again", async () => {
    const fetcher = vi.fn(async () => ok());
    await cachedMl("k", free, fetcher, clock);
    now += 59_999;
    await cachedMl("k", free, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 1;
    await cachedMl("k", free, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends one request for any number of simultaneous callers", async () => {
    let release!: (o: MlOutcome) => void;
    const fetcher = vi.fn(() => new Promise<MlOutcome>(r => { release = r; }));
    const callers = Array.from({ length: 25 }, () => cachedMl("k", free, fetcher, clock));
    release(ok());
    const answers = await Promise.all(callers);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(answers.every(a => a.status === 200)).toBe(true);
  });

  it("keeps a failure only briefly, so a recovered service is asked again soon", async () => {
    const fetcher = vi.fn(async () => ({ status: 502, body: {} }));
    await cachedMl("k", { ttlMs: 10 * 60_000, budgeted: false }, fetcher, clock);
    now += ML_CACHE_TTL_MS.failure;
    await cachedMl("k", { ttlMs: 10 * 60_000, budgeted: false }, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("turns a throw into a 500 instead of rejecting", async () => {
    const out = await cachedMl("k", free, async () => { throw new Error("socket hang up"); }, clock);
    expect(out).toEqual({ status: 500, body: { message: "ML service unreachable", error: "socket hang up" } });
  });
});

describe("invalidation", () => {
  it("forgets matching keys and leaves the rest", async () => {
    const fetcher = vi.fn(async () => ok());
    await cachedMl("shared:/a", free, fetcher, clock);
    await cachedMl("status:/b", free, fetcher, clock);
    invalidateMlCache("shared:");
    await cachedMl("shared:/a", free, fetcher, clock);
    await cachedMl("status:/b", free, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not keep an answer that was in flight when the data changed", async () => {
    let release!: (o: MlOutcome) => void;
    const slow = vi.fn(() => new Promise<MlOutcome>(r => { release = r; }));
    const before = cachedMl("k", free, slow, clock);
    invalidateMlCache();                     // an admin write lands mid-request
    release(ok({ stale: true }));
    expect((await before).body).toEqual({ stale: true });  // its caller still gets it

    const fresh = vi.fn(async () => ok({ stale: false }));
    expect((await cachedMl("k", free, fresh, clock)).body).toEqual({ stale: false });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe("the viewer budget", () => {
  it("allows a burst, then refuses with a reason and a retry time", async () => {
    for (let i = 0; i < ML_VIEWER_BUDGET.capacity; i++) {
      expect((await cachedMl(`k${i}`, metered, async () => ok(), clock)).status).toBe(200);
    }
    const refused = await cachedMl("one-more", metered, async () => ok(), clock);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({
      message: BUDGET_SPENT_MESSAGE,
      retryAfterSeconds: ML_VIEWER_BUDGET.refillEveryMs / 1000,
    });
  });

  it("serves a stale answer rather than refusing, when it has one", async () => {
    // A 1ms TTL, so it expires before the bucket has refilled a whole token.
    const brief = { ttlMs: 1, budgeted: true };
    await cachedMl("drift", brief, async () => ok({ v: "old" }), clock);
    for (let i = 1; i < ML_VIEWER_BUDGET.capacity; i++) await cachedMl(`k${i}`, metered, async () => ok(), clock);
    now += 1;                                // expired, and the budget is spent
    const fetcher = vi.fn(async () => ok({ v: "new" }));
    expect((await cachedMl("drift", brief, fetcher, clock)).body).toEqual({ v: "old" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refills one request per interval", async () => {
    for (let i = 0; i < ML_VIEWER_BUDGET.capacity; i++) await cachedMl(`k${i}`, metered, async () => ok(), clock);
    now += ML_VIEWER_BUDGET.refillEveryMs;
    expect((await cachedMl("a", metered, async () => ok(), clock)).status).toBe(200);
    expect((await cachedMl("b", metered, async () => ok(), clock)).status).toBe(503);
  });

  it("is not spent by cache hits or by joining a request in flight", async () => {
    const fetcher = vi.fn(async () => ok());
    for (let i = 0; i < 1000; i++) await cachedMl("same", metered, fetcher, clock);
    for (let i = 1; i < ML_VIEWER_BUDGET.capacity; i++) {
      expect((await cachedMl(`k${i}`, metered, async () => ok(), clock)).status).toBe(200);
    }
  });

  it("does not apply to unbudgeted keys", async () => {
    for (let i = 0; i < ML_VIEWER_BUDGET.capacity; i++) await cachedMl(`k${i}`, metered, async () => ok(), clock);
    expect((await cachedMl("status", free, async () => ok(), clock)).status).toBe(200);
  });
});

describe("the ceiling", () => {
  // Cloud Run's always-free allowance, request-based billing, Tier 1 regions
  // (us-west1 is one), per billing account per month.
  const FREE = { requests: 2_000_000, vcpuSeconds: 180_000, gibSeconds: 360_000 };

  // Assumptions, stated so they can be checked against the deployed service:
  // an expensive call (projection, data quality, drift summary) holds the
  // instance for 4.25s, the slowest measured in Cloud Run's request log (the
  // data-quality report: 3.7s and 4.3s); health and status answer in
  // milliseconds but bill a 100ms minimum. 1 vCPU, 1 GiB, as deploy-ml.sh
  // configures.
  const SECONDS = { expensive: 4.25, cheap: 0.1 };
  const MEMORY_GIB = 1;

  it("is inside the free request allowance", () => {
    const c = worstCaseMonthlyMlRequests();
    expect(c.total).toBeLessThan(FREE.requests);
  });

  it("is inside the free compute allowance, under the stated assumptions", () => {
    const c = worstCaseMonthlyMlRequests();
    const vcpu = c.budgeted * SECONDS.expensive + (c.status + c.health) * SECONDS.cheap;
    expect(vcpu).toBeLessThan(FREE.vcpuSeconds);
    expect(vcpu * MEMORY_GIB).toBeLessThan(FREE.gibSeconds);
  });

  it("does not depend on fleet size or the number of keys", () => {
    // The budget is global: a thousand assets is the same ceiling as sixty.
    expect(worstCaseMonthlyMlRequests().budgeted).toBe(
      ML_VIEWER_BUDGET.capacity + (30 * 24 * 3600_000) / ML_VIEWER_BUDGET.refillEveryMs,
    );
  });
});
