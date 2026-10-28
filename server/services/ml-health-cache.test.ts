// server/services/ml-health-cache.test.ts
//
// The banner that reports a cold start was interrupting it.
//
// MlServiceNotice polls /api/ml/health while it is on screen, and the route
// turned every poll into a request at the ML service, aborted at four
// seconds. An abort tears down the request the host uses to hold a cold start
// open, so the container never finished booting and the banner's own counter
// climbed -- 370 seconds in one observed tab, reporting on a wake it was
// preventing.
//
// Two tabs would double the load. A demo in front of a room multiplies it by
// the room, against a free-tier edge that answers load with 429 pages.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mlFetch = vi.fn();
const nudgeMlAwake = vi.fn();
vi.mock("./ml-client", () => ({ mlFetch: (...a: unknown[]) => mlFetch(...a) }));
vi.mock("./ml-wake", () => ({ nudgeMlAwake: () => nudgeMlAwake() }));

const { getMlHealth, resetMlHealthCache, HEALTH_TTL_MS } = await import("./ml-health-cache");

const healthy = () => ({
  ok: true,
  status: 200,
  json: async () => ({ model_version: "v1.17", model_loaded: true }),
});

beforeEach(() => {
  mlFetch.mockReset();
  nudgeMlAwake.mockReset();
  resetMlHealthCache();
});

describe("one upstream probe, however many callers", () => {
  it("serves a repeat caller from cache", async () => {
    mlFetch.mockResolvedValue(healthy());

    const first = await getMlHealth();
    const second = await getMlHealth();

    expect(first.reachable).toBe(true);
    expect(second).toEqual(first);
    expect(mlFetch).toHaveBeenCalledTimes(1);
  });

  it("shares one probe between callers that arrive together", async () => {
    // Ten open tabs polling at the same moment used to be ten requests at a
    // service that is already struggling to answer one.
    let release!: (v: unknown) => void;
    mlFetch.mockImplementation(() => new Promise(res => { release = res; }));

    const calls = Array.from({ length: 10 }, () => getMlHealth());
    release(healthy());
    const results = await Promise.all(calls);

    expect(mlFetch).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.reachable).toBe(true);
  });

  it("probes again once the reading goes stale", async () => {
    mlFetch.mockResolvedValue(healthy());
    await getMlHealth(0);
    await getMlHealth(HEALTH_TTL_MS - 1);
    expect(mlFetch).toHaveBeenCalledTimes(1);

    await getMlHealth(Date.now() + HEALTH_TTL_MS + 1);
    expect(mlFetch).toHaveBeenCalledTimes(2);
  });

  it("outlasts the banner's fastest poll", () => {
    // MlServiceNotice starts at a five-second gap. A TTL at or below that
    // would let a single watcher outrun the cache entirely, which is the
    // state this module exists to leave behind.
    expect(HEALTH_TTL_MS).toBeGreaterThan(5_000);
  });
});

describe("what it reports", () => {
  it("passes through the model version and loaded flag", async () => {
    mlFetch.mockResolvedValue(healthy());
    await expect(getMlHealth()).resolves.toEqual({
      reachable: true, modelVersion: "v1.17", modelLoaded: true,
    });
  });

  it("calls an unreachable service not-up rather than erroring", async () => {
    mlFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(getMlHealth()).resolves.toEqual({
      reachable: false, reason: "unreachable",
    });
  });

  it("names a rate limit as a rate limit", async () => {
    // Distinct from "down", because the remedy is the opposite: ask less,
    // rather than poke it awake.
    mlFetch.mockResolvedValue({ ok: false, status: 429 });
    const health = await getMlHealth();
    expect(health.reachable).toBe(false);
    expect(health.reason).toContain("rate-limited");
  });

  it("reports an unexpected status with its code", async () => {
    mlFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(getMlHealth()).resolves.toEqual({
      reachable: false, reason: "returned 500",
    });
  });

  it("survives a health body that is not JSON", async () => {
    mlFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new Error("not json"); },
    });
    await expect(getMlHealth()).resolves.toEqual({
      reachable: true, modelVersion: null, modelLoaded: null,
    });
  });
});

describe("nudging", () => {
  it("leaves a sleeping service booting", async () => {
    mlFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await getMlHealth();
    expect(nudgeMlAwake).toHaveBeenCalledTimes(1);
  });

  it("does not nudge into a rate limit", async () => {
    // Another request now is exactly what keeps the limit in force.
    mlFetch.mockResolvedValue({ ok: false, status: 429 });
    await getMlHealth();
    expect(nudgeMlAwake).not.toHaveBeenCalled();
  });

  it("does not nudge a service that answered", async () => {
    mlFetch.mockResolvedValue(healthy());
    await getMlHealth();
    expect(nudgeMlAwake).not.toHaveBeenCalled();
  });

  it("nudges once per probe, not once per caller", async () => {
    mlFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await Promise.all(Array.from({ length: 8 }, () => getMlHealth()));
    expect(nudgeMlAwake).toHaveBeenCalledTimes(1);
  });
});
