// server/services/ml-fetch-timeout.test.ts
//
// Observed on the deployed demo, signed in as the read-only account: the ML
// dashboard span for 1,350 seconds with no error, while a direct probe of the
// ML service returned healthy in 62. Nothing was broken in the sense of
// throwing. mlFetch was a bare fetch() with no timeout and no signal, so a
// suspended instance held the request for as long as the host held it; the
// client sets `retry: false` and `staleTime: Infinity`, so the query never
// settled, never retried, and rendered its loading state indefinitely.
//
// A spinner is the worst possible rendering of this, because it is
// indistinguishable from the system working. The fix is not a faster service:
// it is deciding what "too long" is, so a route's existing catch can say "ML
// service unreachable" and the dashboard can render an error.
//
// These tests use a server that accepts the connection and never answers,
// which is the condition that produced the 1,350 seconds.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "http";
import type { Socket } from "net";
import { readFileSync } from "fs";
import { join } from "path";

let server: Server;
let origin: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  // Accepts, holds, never responds.
  server = createServer(() => {});
  server.on("connection", s => sockets.push(s));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/** Fresh ml-client with the environment this test needs. */
async function loadClient(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  process.env.ML_SERVICE_URL = origin;
  return import("./ml-client");
}

describe("mlFetch gives up instead of waiting forever", () => {
  it("aborts a request that never answers", async () => {
    const { mlFetch } = await loadClient({ ML_FETCH_TIMEOUT_MS: "300" });
    const started = Date.now();
    await expect(mlFetch("/drift/latest")).rejects.toThrow(/exceeded 300ms/);
    // Bounded by its own budget, with slack for scheduling. Before the fix
    // this promise did not settle at all.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("says which call gave up and how long it waited", async () => {
    // An AbortError's own message is "This operation was aborted", and the
    // routes interpolate e.message into the response the dashboard shows. So
    // the message has to name the path and the budget, or the error is as
    // uninformative as the spinner was.
    const { mlFetch } = await loadClient({ ML_FETCH_TIMEOUT_MS: "250" });
    await expect(mlFetch("/drift/bias")).rejects.toThrow(/\/drift\/bias/);
    await expect(mlFetch("/drift/bias")).rejects.toThrow(/suspended/);
  });

  it("leaves a caller's own signal alone", async () => {
    // ml-wake and the prediction path manage their own deadlines, and those
    // were chosen deliberately -- a wake probe is supposed to outlast a cold
    // start. Taking them over would quietly shorten them.
    const { mlFetch } = await loadClient({ ML_FETCH_TIMEOUT_MS: "100000" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const err = await mlFetch("/health", { signal: controller.signal })
      .then(() => null, (e: any) => e);
    expect(err).toBeTruthy();
    // The caller's abort, not ours: ours rewrites the message, theirs does not.
    expect(String(err?.message ?? "")).not.toMatch(/exceeded/);
  });

  it("honours a per-call budget for work that is meant to be slow", async () => {
    const { mlFetch } = await loadClient({ ML_FETCH_TIMEOUT_MS: "100" });
    // The default would have aborted at 100ms; this call asked for more.
    const started = Date.now();
    await expect(mlFetch("/train", { method: "POST" }, { timeoutMs: 600 }))
      .rejects.toThrow(/exceeded 600ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("refuses an unusable budget rather than treating it as no limit", async () => {
    // "0", "" and nonsense all used to be the same thing as unset, and unset
    // used to mean unbounded. A misconfigured value must not reopen that.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mlFetch } = await loadClient({ ML_FETCH_TIMEOUT_MS: "nonsense" });
    await expect(mlFetch("/drift/summary", {}, { timeoutMs: 200 }))
      .rejects.toThrow(/exceeded 200ms/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("every ML request still goes through the one chokepoint", () => {
  // ml-client's header says it is "the ONLY place Node builds ML requests", so
  // the token can never be forgotten. That invariant is now carrying the
  // timeout too: a direct fetch() to the service would be unbounded again.
  const SERVER = join(__dirname, "..");

  const files = [
    join(SERVER, "routes.ts"),
    join(SERVER, "index.ts"),
    join(SERVER, "services", "multi-horizon-scoring.ts"),
    join(SERVER, "services", "predictive-maintenance-fixed.ts"),
    join(SERVER, "services", "seed-orchestrator.ts"),
    join(SERVER, "services", "champion-metrics.ts"),
    join(SERVER, "services", "ml-wake.ts"),
  ];

  it("no module reaches the ML service with a bare fetch", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      for (const m of src.matchAll(/fetch\(\s*`?\$?\{?ML_SERVICE_URL/g)) {
        offenders.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders, "these bypass mlFetch and so bypass the timeout")
      .toEqual([]);
  });

  it("the long budget is applied where the work is long", () => {
    // Fitting a model, recomputing a reference and scoring the fleet all
    // legitimately outrun the default. If one of these loses its budget the
    // symptom is an abort mid-run, which on the batch call empties the risk
    // queue.
    const routes = readFileSync(join(SERVER, "routes.ts"), "utf-8");
    const orch = readFileSync(join(SERVER, "services", "seed-orchestrator.ts"), "utf-8");
    const batch = readFileSync(
      join(SERVER, "services", "multi-horizon-scoring.ts"), "utf-8"
    );

    for (const [label, src, n] of [
      ["routes.ts", routes, 4],
      ["seed-orchestrator.ts", orch, 2],
      ["multi-horizon-scoring.ts", batch, 1],
    ] as const) {
      expect(
        src.match(/timeoutMs: ML_SLOW_TIMEOUT_MS/g)?.length ?? 0,
        `${label} should pass the long budget on ${n} call(s)`
      ).toBe(n);
    }
  });
});
