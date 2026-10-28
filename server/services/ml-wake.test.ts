// server/services/ml-wake.test.ts
//
// The seed waited for the ML service to wake; the buttons did not. Pressing
// "Run Predictions" against a suspended service failed with "give it a minute
// and try again", which turns a condition the system knows how to handle into
// the user's problem and their job to time correctly.
//
// The budget is the whole design here. A request cannot hold open for the
// 40-75 seconds a cold start takes — proxies give up — so the request path
// waits briefly and hands the rest to the client's retry. A probe that outran
// its budget would defeat that, which is the bug these tests exist to stop:
// the seed's own wake loop once had a 20s budget and a 120s probe, so it got
// one attempt where it looked like it took a dozen.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mlFetch = vi.fn();
vi.mock("./ml-client", () => ({ mlFetch: (...args: unknown[]) => mlFetch(...args) }));

const { waitForMl, wakeAndWait, nudgeMlAwake, REQUEST_WAKE_BUDGET_MS, REQUEST_WAKE_PROBE_MS, RETRY_AFTER_SECONDS } =
  await import("./ml-wake");

beforeEach(() => { mlFetch.mockReset(); });

describe("waiting for the ML service", () => {
  it("returns as soon as it answers", async () => {
    mlFetch.mockResolvedValue({ ok: true });
    const started = Date.now();
    await expect(waitForMl(5_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(mlFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up when the budget runs out", async () => {
    mlFetch.mockResolvedValue({ ok: false });
    await expect(waitForMl(200, 50)).resolves.toBe(false);
  });

  it("keeps trying rather than failing on the first miss", async () => {
    // A suspended container refuses nothing — it just does not answer yet.
    mlFetch
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ ok: true });
    await expect(waitForMl(20_000, 1_000)).resolves.toBe(true);
    expect(mlFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("does not let one probe outlive the whole budget", async () => {
    // The failure this guards: a 120s probe inside a 20s budget is not a
    // bound, and the caller asked for one. The mock ignores the abort signal
    // on purpose — if the bound depended on the HTTP client honouring it,
    // this is where that assumption would go unnoticed.
    mlFetch.mockImplementation(() => new Promise(() => {})); // never settles
    const started = Date.now();
    await expect(waitForMl(300, 120_000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("probes more than once inside the request budget", async () => {
    // One probe per budget is what the seed's wake did by accident, so a
    // service coming up midway was missed entirely.
    mlFetch.mockResolvedValue({ ok: false });
    await waitForMl(REQUEST_WAKE_BUDGET_MS, REQUEST_WAKE_PROBE_MS);
    expect(mlFetch.mock.calls.length).toBeGreaterThan(1);
  }, 30_000);

  it("survives a probe that throws synchronously", async () => {
    mlFetch.mockImplementation(() => { throw new Error("DNS"); });
    await expect(waitForMl(200, 50)).resolves.toBe(false);
  });
});

describe("the request-path budget", () => {
  it("is short enough to stay inside a proxy timeout", () => {
    // Held-open requests are what this design exists to avoid.
    expect(REQUEST_WAKE_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });

  it("is long enough that a warm service simply works", () => {
    expect(REQUEST_WAKE_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("asks the client back after a wait that makes progress", () => {
    // Five retries at this interval has to cover the slowest cold start
    // measured, 72.5 seconds.
    expect(RETRY_AFTER_SECONDS * 5).toBeGreaterThan(72.5);
  });
});

describe("nudging it awake", () => {
  it("returns immediately and swallows the rejection", async () => {
    // Fire-and-forget: an unhandled rejection takes this process down, which
    // is a bug already fixed once in this codebase.
    mlFetch.mockRejectedValue(new Error("still booting"));
    expect(() => nudgeMlAwake()).not.toThrow();
    await new Promise(r => setTimeout(r, 10));
    expect(mlFetch).toHaveBeenCalled();
  });

  it("does not abort the cold start it is trying to cause", async () => {
    // The bug this replaced: the nudge aborted at 120 seconds, tearing down
    // the request holding the cold start open, so a container needing longer
    // never finished starting. Three full wake budgets failed this way over
    // twenty minutes while a curl with no deadline woke the same service in
    // 62 seconds. Nothing waits on a nudge, so nothing should bound it.
    mlFetch.mockResolvedValue({ ok: true });
    nudgeMlAwake();
    await new Promise(r => setTimeout(r, 10));
    const init = mlFetch.mock.calls[0]?.[1] as { signal?: unknown } | undefined;
    expect(init?.signal, "the nudge passed an abort signal").toBeUndefined();
  });
});

describe("the nudge that holds a cold start open", () => {
  it("asks for no deadline at all", async () => {
    // It had asked by passing nothing, and nothing means
    // ML_FETCH_TIMEOUT_MS -- 90 seconds. Its own comment said "No abort, no
    // timeout", and the reason given was that aborting tears down the request
    // the host uses to hold a boot open, so a container needing longer than
    // the bound never finishes starting. Measured cold starts reach 72.5s and
    // one after hours idle has an image to pull first, so 90s sits inside the
    // range this is here to cover.
    mlFetch.mockResolvedValue({ ok: true });
    nudgeMlAwake();
    expect(mlFetch).toHaveBeenCalledTimes(1);
    const [path, , opts] = mlFetch.mock.calls[0] as [string, unknown, { timeoutMs?: number }];
    expect(path).toBe("/health");
    expect(opts?.timeoutMs).toBe(Infinity);
  });

  it("does not reject when the nudge fails", async () => {
    // An escaping rejection exits the process.
    mlFetch.mockRejectedValue(new Error("socket hang up"));
    expect(() => nudgeMlAwake()).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
  });
});

describe("wakeAndWait", () => {
  it("nudges before it probes", async () => {
    // The ordering is the whole fix. Every request path probed for twenty
    // seconds and only nudged once that failed -- and each probe aborts at
    // eight seconds, tearing down the request holding the boot open. Two
    // teardowns per request, five client retries, and a service that never
    // comes up however long anyone waits.
    mlFetch.mockResolvedValue({ ok: false });
    await wakeAndWait(150, 50);

    expect(mlFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const first = mlFetch.mock.calls[0] as [string, unknown, { timeoutMs?: number } | undefined];
    // The first call is the unbounded nudge; the probes that follow carry a
    // signal instead and must not be unbounded.
    expect(first[2]?.timeoutMs).toBe(Infinity);
    for (const call of mlFetch.mock.calls.slice(1)) {
      expect((call[2] as { timeoutMs?: number } | undefined)?.timeoutMs).not.toBe(Infinity);
    }
  });

  it("still reports true when the service answers", async () => {
    mlFetch.mockResolvedValue({ ok: true });
    await expect(wakeAndWait(5_000, 1_000)).resolves.toBe(true);
  });

  it("reports false without throwing when the budget runs out", async () => {
    mlFetch.mockResolvedValue({ ok: false });
    await expect(wakeAndWait(150, 50)).resolves.toBe(false);
  });
});

describe("a rate limit from the edge", () => {
  it("is not read as 'still booting'", async () => {
    // The CDN in front of the host answers 429 with a challenge page when it
    // sees too many requests. probe() only checked res.ok, so that was
    // indistinguishable from a container still starting -- and the response
    // to "still starting" is to poll again, which is the one thing that keeps
    // a rate limit in force. Observed: twelve requests in seven seconds was
    // enough to earn one.
    mlFetch.mockResolvedValue({ ok: false, status: 429 });
    const started = Date.now();
    await expect(waitForMl(3_000, 200)).resolves.toBe(false);

    // Backing off hard means few attempts in the window, not many.
    expect(mlFetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  }, 15_000);

  it("still returns true if the service answers after one", async () => {
    mlFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true });
    await expect(waitForMl(30_000, 1_000)).resolves.toBe(true);
    expect(mlFetch).toHaveBeenCalledTimes(2);
  }, 25_000);
});

describe("the gap between probes", () => {
  it("sends fewer probes than a flat gap would", async () => {
    // The flat 1.5s gap sent twelve probes into this budget against a fast
    // 503. The backoff roughly halves that on its own; the larger reductions
    // come from the rate-limit case above and from the banner, which polled
    // alongside it. Pinned as a ceiling so the gap cannot quietly go flat.
    mlFetch.mockResolvedValue({ ok: false, status: 503 });
    await waitForMl(20_000, 500);
    expect(mlFetch.mock.calls.length).toBeLessThanOrEqual(8);
  }, 30_000);
});
