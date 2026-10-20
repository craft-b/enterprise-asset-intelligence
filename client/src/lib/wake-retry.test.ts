// client/src/lib/wake-retry.test.ts
//
// Pressing "Run Predictions" on a suspended ML service used to fail with
// "give it a minute and try again". The service takes 40-75 seconds to come
// back and suspends after about fifteen minutes idle, so whether the button
// worked depended on how recently the app had been used, and the remedy was
// for the person to wait and guess when.
//
// It happened for real: the button was pressed, the table stayed empty, and
// the cause was a health check that took 62 seconds — a service asleep, not a
// bug. The seed had always handled this; only the buttons did not.

import { describe, it, expect } from "vitest";
import { retryWhileWaking, wakeRetryDelay, isWaking } from "./wake-retry";

const waking = (retryAfterSeconds?: number) =>
  Object.assign(new Error("The ML service is waking up"), { waking: true, retryAfterSeconds });

describe("retrying while the ML service wakes", () => {
  it("retries a waking response", () => {
    expect(retryWhileWaking(0, waking())).toBe(true);
  });

  it("keeps retrying long enough to cover the slowest cold start", () => {
    // Measured cold starts: 42, 51, 61.5, 62, 72.5 seconds. At 20s a go, four
    // waits is 80s — the fifth attempt has to still be allowed.
    expect(retryWhileWaking(4, waking())).toBe(true);
  });

  it("gives up rather than looping forever", () => {
    // A service that is genuinely down must eventually surface as an error.
    expect(retryWhileWaking(5, waking())).toBe(false);
    expect(retryWhileWaking(50, waking())).toBe(false);
  });

  it("does not retry anything else", () => {
    // A 400 will fail identically next time, and a batch that scored 0 of 10
    // has a real reason that retrying hides.
    expect(retryWhileWaking(0, new Error("Validation error"))).toBe(false);
    expect(retryWhileWaking(0, { message: "Scored 0 of 10 assets" })).toBe(false);
    expect(retryWhileWaking(0, undefined)).toBe(false);
    expect(retryWhileWaking(0, null)).toBe(false);
  });

  it("honours the delay the server asked for", () => {
    expect(wakeRetryDelay(0, waking(30))).toBe(30_000);
  });

  it("falls back to a sane delay when the server did not say", () => {
    expect(wakeRetryDelay(0, waking())).toBe(20_000);
    expect(wakeRetryDelay(0, waking(0))).toBe(20_000);
    expect(wakeRetryDelay(0, waking(-5))).toBe(20_000);
    expect(wakeRetryDelay(0, new Error("x"))).toBe(20_000);
  });

  it("never returns a delay that would hammer the service", () => {
    for (const e of [waking(), waking(1), new Error("x"), null]) {
      expect(wakeRetryDelay(0, e)).toBeGreaterThanOrEqual(1000);
    }
  });

  it("can tell a button it is waiting on a wake, not just pending", () => {
    expect(isWaking(waking(), true)).toBe(true);
    expect(isWaking(waking(), false)).toBe(false);
    expect(isWaking(new Error("boom"), true)).toBe(false);
  });
});
