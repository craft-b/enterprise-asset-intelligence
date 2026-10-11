// client/src/lib/api-wakeup.test.ts
//
// Time and timers are injected, so these run instantly rather than actually
// waiting out a 40-second cold start.

import { describe, it, expect, vi } from "vitest";
import { probeHealth, waitForApi, type WakeupState } from "./api-wakeup";

/** A fake clock whose sleep() advances it, so elapsed time is deterministic. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function okFetch() {
  return vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
}

function failFetch(error: Error = new Error("ECONNREFUSED")) {
  return vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** Fails `n` times, then succeeds — a cold start that eventually wakes. */
function coldThenWarm(n: number) {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls <= n) throw new Error("ECONNREFUSED");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("probeHealth", () => {
  it("is true when the API answers ok", async () => {
    expect(await probeHealth(okFetch())).toBe(true);
  });

  it("is false when the connection fails", async () => {
    expect(await probeHealth(failFetch())).toBe(false);
  });

  it("is false on a non-ok status", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await probeHealth(f)).toBe(false);
  });

  it("asks for /api/health and bypasses the cache", async () => {
    const f = okFetch();
    await probeHealth(f);

    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe("/api/health");
    // A cached 200 would report a sleeping server as awake.
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeDefined();
  });

  it("gives up on a probe that never settles, rather than hanging", async () => {
    const hang = vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

    expect(await probeHealth(hang, 10)).toBe(false);
  });
});

describe("waitForApi", () => {
  it("reports ready on the first probe when the API is warm", async () => {
    const clock = fakeClock();
    const states: WakeupState[] = [];

    const final = await waitForApi({
      fetchFn: okFetch(),
      onUpdate: s => states.push(s),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(final.phase).toBe("ready");
    expect(final.attempts).toBe(1);
    // A warm API must never show the waking notice.
    expect(states.map(s => s.phase)).not.toContain("waking");
  });

  it("keeps probing through a cold start and then succeeds", async () => {
    const clock = fakeClock();

    const final = await waitForApi({
      fetchFn: coldThenWarm(5),
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 2_000,
    });

    expect(final.phase).toBe("ready");
    expect(final.attempts).toBe(6);
  });

  it("announces 'waking' only once the wait is noticeable", async () => {
    const clock = fakeClock();
    const phases: string[] = [];

    await waitForApi({
      fetchFn: coldThenWarm(3),
      onUpdate: s => phases.push(s.phase),
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 2_000,
      announceAfterMs: 1_200,
    });

    expect(phases[0]).toBe("checking");
    expect(phases).toContain("waking");
    expect(phases[phases.length - 1]).toBe("ready");
  });

  it("gives up instead of spinning forever", async () => {
    const clock = fakeClock();

    const final = await waitForApi({
      fetchFn: failFetch(),
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 2_000,
      giveUpAfterMs: 20_000,
    });

    expect(final.phase).toBe("unreachable");
    expect(final.elapsedSeconds).toBeGreaterThanOrEqual(20);
  });

  it("reports elapsed seconds so the wait does not look hung", async () => {
    const clock = fakeClock();
    const seconds: number[] = [];

    await waitForApi({
      fetchFn: coldThenWarm(4),
      onUpdate: s => seconds.push(s.elapsedSeconds),
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 5_000,
    });

    // Monotonic and actually advancing.
    expect(seconds[seconds.length - 1]).toBeGreaterThan(0);
    expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
  });
});
