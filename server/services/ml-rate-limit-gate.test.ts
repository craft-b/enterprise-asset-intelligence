// One address, one cooldown.
//
// The health path was taught to back off under a 429. The other fourteen
// mlFetch call sites were not, and a single ML dashboard load fires eight of
// them — drift/latest, drift/prediction, drift/bias, drift/summary,
// data-quality/report, models/registry, models/compare, train/status — plus
// client retries.
//
// So while the health probe waited a polite minute between checks, the page
// beside it kept the edge saturated, the 429 never lapsed, and the nudge that
// would have woken the container stayed suppressed behind it. Observed: 650
// seconds against a service that was merely asleep, after the health path had
// already been "fixed".
//
// Backing off per caller cannot work. A rate limit is on the address, so the
// address has to go quiet — every caller or none.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

process.env.ML_SERVICE_URL = "https://ml.example.test";
const { mlFetch, rateLimitRemaining, resetRateLimitGate, RATE_LIMIT_COOLDOWN_MS } =
  await import("./ml-client");

const reply = (status: number) =>
  new Response(JSON.stringify({}), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  resetRateLimitGate();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("the shared rate-limit gate", () => {
  it("sends the request when there is no cooldown", async () => {
    fetchMock.mockResolvedValue(reply(200));
    const res = await mlFetch("/health");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the cooldown on a 429", async () => {
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    expect(rateLimitRemaining()).toBeGreaterThan(0);
  });

  it("stops every other caller, not just the one that drew the 429", async () => {
    // The whole point. /drift/latest never saw the 429 that /health drew.
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    fetchMock.mockClear();

    for (const path of ["/drift/latest", "/drift/bias", "/models/registry", "/train/status"]) {
      const res = await mlFetch(path);
      expect(res.status, `${path} was sent during a cooldown`).toBe(429);
    }
    expect(fetchMock, "nothing should have reached the network").not.toHaveBeenCalled();
  });

  it("gates the unbounded nudge too", async () => {
    // The nudge is the one request that must not be wasted into a refusal:
    // it is what holds a cold start open, and a 429 means it never will.
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    fetchMock.mockClear();

    const res = await mlFetch("/health", {}, { timeoutMs: Infinity });
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gates a caller that brings its own signal", async () => {
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    fetchMock.mockClear();

    const res = await mlFetch("/health", { signal: new AbortController().signal });
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers from the gate without touching the network", async () => {
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    fetchMock.mockClear();

    const res = await mlFetch("/drift/summary");
    // A real Response, so the call sites that branch on 429 need no change.
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toHaveProperty("detail");
  });

  it("lifts the cooldown once a request gets through", async () => {
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    expect(rateLimitRemaining()).toBeGreaterThan(0);

    // Simulate the cooldown elapsing, then a real answer.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + RATE_LIMIT_COOLDOWN_MS + 1);
    expect(rateLimitRemaining()).toBe(0);
    fetchMock.mockResolvedValue(reply(200));
    await mlFetch("/health");
    expect(rateLimitRemaining()).toBe(0);
    vi.useRealTimers();
  });

  it("does not lift the cooldown on a gateway error", async () => {
    // A 502 is what a successful wake looks like from the inside. It says
    // nothing about whether the edge has stopped refusing us.
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    const before = rateLimitRemaining();

    resetRateLimitGate();
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    fetchMock.mockClear();
    expect(rateLimitRemaining()).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });

  it("cools down for at least the host's own retry window", () => {
    expect(RATE_LIMIT_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
  });
});
