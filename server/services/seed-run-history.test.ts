// server/services/seed-run-history.test.ts
//
// A seed's steps and warnings lived only in the API process. On free hosting
// that process restarts constantly -- a deploy, or the instance suspending --
// and when it did, the record of why a run's ML steps had been skipped went
// with it.
//
// Three consecutive seeds wrote no predictions. The only evidence left was the
// shape of the tables: prediction counts of zero, and a drift row older than
// the seed that should have replaced it. The actual reason, a 401 from the ML
// service, was sitting in a warning string that no longer existed anywhere by
// the time anyone asked. It took a manual redeploy on a hunch to confirm.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");
const ROUTES = readFileSync(join(__dirname, "..", "routes.ts"), "utf-8");

describe("a seed run leaves a record behind", () => {
  it("writes on every step transition, not only at the end", () => {
    // A run that dies is exactly the run whose reasons matter, and it never
    // reaches an end-of-run write.
    const setStep = SRC.match(/function setStep\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(setStep).toMatch(/persistRunRecord\(\)/);
  });

  it("writes when a step is skipped", () => {
    const addWarning = SRC.match(/function addWarning\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(addWarning).toMatch(/persistRunRecord\(\)/);
  });

  it("writes when the pipeline throws", () => {
    const fail = SRC.match(/jobState\.status = "failed";[\s\S]{0,200}?persistRunRecord\(\)/);
    expect(fail, "a failed run does not record why").not.toBeNull();
  });

  it("never lets bookkeeping sink the seed", () => {
    // Fire-and-forget, so a slow or missing history table cannot slow down or
    // fail a seed -- and caught, because this process exits on an unhandled
    // rejection.
    const persist = SRC.match(/function persistRunRecord\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(persist).toMatch(/\.catch\(/);
    expect(persist).not.toMatch(/await /);
  });

  it("carries on when the table is not there at all", () => {
    // An older database should still seed, just without the audit trail.
    const begin = SRC.match(/async function beginRunRecord\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(begin).toMatch(/try \{/);
    expect(begin).toMatch(/catch/);
  });
});

describe("the record survives what it needs to survive", () => {
  it("is not wiped by the reset that precedes a reseed", () => {
    // Reset runs immediately before a fresh seed. Truncating the history there
    // would erase the previous run's reasons at exactly the moment someone is
    // reseeding because of them.
    const list = SRC.match(/const TABLES_TO_CLEAR = \[[\s\S]*?\];/)?.[0] ?? "";
    expect(list, "TABLES_TO_CLEAR not found").not.toBe("");
    expect(list).not.toMatch(/seed_runs/);
  });

  it("is what the status endpoint falls back to", () => {
    // The point of persisting it: asking "why were there no predictions?"
    // after the process that ran the seed is gone.
    const route = ROUTES.match(/app\.get\("\/api\/admin\/seed\/status"[\s\S]*?\n  \}\);/)?.[0] ?? "";
    expect(route).toMatch(/getLastSeedRun/);
  });

  it("prefers the live run over the stored one", () => {
    // A finished run must never be presented as the one in progress.
    const route = ROUTES.match(/app\.get\("\/api\/admin\/seed\/status"[\s\S]*?\n  \}\);/)?.[0] ?? "";
    expect(route).toMatch(/memory\.status === "idle"/);
    expect(route).toMatch(/fromHistory/);
  });
});
