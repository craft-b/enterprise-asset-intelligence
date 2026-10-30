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
const {
  mlFetch, rateLimitRemaining, resetRateLimitGate, rateLimitState,
  cooldownFor, RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS,
} = await import("./ml-client");

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

// ── How long to stay away ────────────────────────────────────────────────────
//
// The first cooldown was 60 seconds, picked because ml-wake had already picked
// 60 seconds. Neither was measured. A cooldown shorter than the host's real
// window re-probes into the limit and resets it, which is the same deadlock
// with a longer period — observed as 370 seconds still counting, after the
// gate that was supposed to fix it had deployed.
//
// Retry-After is the only non-guess available: the host knows and says so.
describe("cooldownFor", () => {
  it("honours Retry-After given in seconds", () => {
    expect(cooldownFor("120", 1)).toBe(120_000);
  });

  it("honours Retry-After given as an HTTP date", () => {
    const now = Date.now();
    const when = new Date(now + 90_000).toUTCString();
    const ms = cooldownFor(when, 1, now);
    // Second-resolution date, so allow the rounding.
    expect(ms).toBeGreaterThan(88_000);
    expect(ms).toBeLessThanOrEqual(90_000);
  });

  it("ignores a Retry-After that is absent, unparseable or in the past", () => {
    const now = Date.now();
    for (const header of [null, "soon", new Date(now - 60_000).toUTCString()]) {
      expect(cooldownFor(header, 1, now)).toBe(RATE_LIMIT_COOLDOWN_MS);
    }
  });

  it("doubles with each consecutive refusal", () => {
    // A limit that outlasted one cooldown will outlast the next identical one.
    expect(cooldownFor(null, 1)).toBe(RATE_LIMIT_COOLDOWN_MS);
    expect(cooldownFor(null, 2)).toBe(RATE_LIMIT_COOLDOWN_MS * 2);
    expect(cooldownFor(null, 3)).toBe(RATE_LIMIT_COOLDOWN_MS * 4);
  });

  it("caps the doubling", () => {
    expect(cooldownFor(null, 50)).toBe(RATE_LIMIT_MAX_COOLDOWN_MS);
    expect(cooldownFor("99999999", 1)).toBe(RATE_LIMIT_MAX_COOLDOWN_MS);
  });

  it("counts strikes and clears them when a request gets through", async () => {
    fetchMock.mockResolvedValue(reply(429));
    await mlFetch("/health");
    expect(rateLimitState().consecutive429).toBe(1);

    resetRateLimitGate();
    fetchMock.mockResolvedValue(reply(200));
    await mlFetch("/health");
    expect(rateLimitState().consecutive429).toBe(0);
    expect(rateLimitState().remainingMs).toBe(0);
  });

  it("records the Retry-After it was given, for the diagnostic to report", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "300" } }),
    );
    await mlFetch("/health");
    expect(rateLimitState().lastRetryAfter).toBe("300");
    expect(rateLimitState().remainingMs).toBeGreaterThan(290_000);
  });
});
