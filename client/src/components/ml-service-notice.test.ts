// client/src/components/ml-service-notice.test.ts
//
// The notice exists because the ML service sleeps on its own schedule, after
// ApiGate has already waited out the Node API. A visitor can clear the startup
// screen, open an ML page, and meet a second 50-60 second wait whose only
// visible symptom was "Failed to fetch drift status".
//
// There is no DOM in this test setup -- the suite runs in node by deliberate
// choice -- so what is tested is the decision the component acts on: whether
// the ML service counts as reachable. Getting that backwards would either show
// a "starting up" banner permanently over a working page, or show nothing
// during the wait it was written for.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkMlHealth } from "./ml-service-notice";

/** A fetch that answers once with the given status and body. */
const fetchWith = (status: number, body: unknown) =>
  vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;

describe("checkMlHealth", () => {
  it("is reachable when the service answers", async () => {
    const f = fetchWith(200, { reachable: true, modelVersion: "v1.17" });
    await expect(checkMlHealth(undefined, f)).resolves.toBe(true);
  });

  it("is not reachable when the API says so", async () => {
    // The passthrough answers 200 with reachable:false, because a sleeping ML
    // service is a normal state rather than a server error. Reading only the
    // HTTP status would call that healthy and hide the wait.
    const f = fetchWith(200, { reachable: false, reason: "no answer within 4s" });
    await expect(checkMlHealth(undefined, f)).resolves.toBe(false);
  });

  it("treats a missing flag as not reachable", async () => {
    // Fail closed: a banner that should not be there is a smaller harm than
    // silence during the wait this exists to explain.
    await expect(checkMlHealth(undefined, fetchWith(200, {}))).resolves.toBe(false);
    await expect(checkMlHealth(undefined, fetchWith(200, { reachable: "yes" })))
      .resolves.toBe(false);
  });

  it("is not reachable on an HTTP error", async () => {
    await expect(checkMlHealth(undefined, fetchWith(500, {}))).resolves.toBe(false);
    await expect(checkMlHealth(undefined, fetchWith(401, {}))).resolves.toBe(false);
  });

  it("survives a body that is not JSON", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    })) as unknown as typeof fetch;
    await expect(checkMlHealth(undefined, f)).resolves.toBe(false);
  });

  it("survives the request throwing", async () => {
    const f = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(checkMlHealth(undefined, f)).resolves.toBe(false);
  });

  it("sends credentials, since the route requires a session", async () => {
    const f = fetchWith(200, { reachable: true });
    await checkMlHealth(undefined, f);
    expect(f).toHaveBeenCalledWith("/api/ml/health", expect.objectContaining({
      credentials: "include",
    }));
  });
});

describe("the advertised cold start", () => {
  // Two components tell the visitor how long to expect, and they describe the
  // same host behaviour. The gate said 45 seconds while the measured cold
  // starts were 51s and 62s, so its progress bar filled and then kept waiting.
  const read = (path: string) =>
    Number(
      readFileSync(join(__dirname, path), "utf-8")
        .match(/TYPICAL_COLD_START_SECONDS\s*=\s*(\d+)/)![1]
    );

  it("matches between the gate and the notice", () => {
    expect(read("./ml-service-notice.tsx")).toBe(read("./api-gate.tsx"));
  });

  it("is not shorter than the cold starts actually measured", () => {
    // 51s and 62s observed; the host's own dashboard warns of "50 seconds or
    // more". An estimate under that is a progress bar that lies.
    expect(read("./api-gate.tsx")).toBeGreaterThanOrEqual(55);
  });
});

// ── What the counter counts ──────────────────────────────────────────────────
//
// The banner reads "{seconds}s elapsed" directly beneath a sentence promising
// the wait is about sixty seconds, so the number is read as the age of a cold
// start. It was the age of the component. A tab left open on an ML page while
// its reader did something else reported "2300s elapsed" for a service that
// was merely asleep — thirty-eight minutes being how long the tab had been
// open, and no cold start having been attempted at all.
//
// Anchoring to the first FAILED check is what makes the figure mean what the
// sentence beside it claims. No DOM here, so this is asserted against source.
describe("the elapsed counter is anchored to the wake, not to the mount", () => {
  const SRC = readFileSync(join(__dirname, "ml-service-notice.tsx"), "utf8");

  it("does not anchor the counter to mount time", () => {
    // `const startedAt = Date.now()` in the effect body is the defect: with []
    // deps it is fixed at mount and never reset.
    expect(
      /const\s+startedAt\s*=\s*Date\.now\(\)/.test(SRC),
      "counter re-anchored to mount; it will report the age of the tab",
    ).toBe(false);
  });

  it("starts the clock on the first failed check", () => {
    expect(SRC).toMatch(/if\s*\(\s*wakeStartedAt\s*===\s*null\s*\)\s*wakeStartedAt\s*=\s*Date\.now\(\)/);
    expect(SRC).toMatch(/setSeconds\(Math\.floor\(\(Date\.now\(\)\s*-\s*wakeStartedAt\)\s*\/\s*1000\)\)/);
  });

  it("clears the anchor when the service answers, so a second wake is timed fresh", () => {
    // Without this, a tab that watches the service suspend and recover reports
    // the second wait as though it had been running since the first.
    const upBranch = SRC.slice(SRC.indexOf("if (up) {"), SRC.indexOf("// Count from the first failed check"));
    expect(upBranch, "the success branch must reset the anchor").toMatch(/wakeStartedAt\s*=\s*null/);
  });

  it("still promises a figure the counter can plausibly reach", () => {
    // The prose says ~60s. If that constant drifts far from the measured cold
    // start the banner misleads again, in the other direction.
    const m = SRC.match(/TYPICAL_COLD_START_SECONDS\s*=\s*(\d+)/);
    expect(m, "the stated figure went missing").not.toBeNull();
    const stated = Number(m![1]);
    // Measured range across ten observations: 42s - 72.5s.
    expect(stated).toBeGreaterThanOrEqual(42);
    expect(stated).toBeLessThanOrEqual(90);
  });
});
