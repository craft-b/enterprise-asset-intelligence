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

describe("an interrupted run is not reported as a running one", () => {
  // The API process restarted twenty minutes into a seed. The job died with
  // it, the stored row still said "running", and the setup screen sat at
  // "Waiting… 10 / 10" with a full progress bar for as long as anyone watched.
  //
  // The screen detects an interruption by seeing the status go running ->
  // idle, which is what the endpoint answered once the in-memory job was gone.
  // Falling back to the stored row broke that: the feature added to make a
  // failed run visible made this one invisible.
  const route = ROUTES.match(/app\.get\("\/api\/admin\/seed\/status"[\s\S]*?\n  \}\);/)?.[0] ?? "";

  it("treats a stored 'running' row as interrupted", () => {
    expect(route).toMatch(/const interrupted = fromHistory && raw\.status === "running"/);
  });

  it("reports it as idle, which is what the screen watches for", () => {
    expect(route).toMatch(/state: interrupted \? "idle" : raw\.status/);
  });

  it("says so explicitly too, so the next reader need not infer it", () => {
    expect(route).toMatch(/\n\s*interrupted,/);
  });

  it("does not call a live run interrupted", () => {
    // fromHistory is false while a job is in memory, so a genuinely running
    // seed keeps reporting "running".
    expect(route).toMatch(/fromHistory &&/);
  });
});

describe("the seed starts the ML service waking before it needs it", () => {
  const start = SRC.match(/export async function startSeedJob[\s\S]*?\n\}/)?.[0] ?? "";

  it("nudges at the start of the run", () => {
    // The data steps take long enough that a service awake at the button press
    // has suspended again by step 8. Three steps then spent a full wake budget
    // each on a container nothing had asked to start: 300 seconds apiece,
    // against a service that answers in 62 once poked.
    expect(start).toMatch(/nudgeMlAwake\(\)/);
  });

  it("does not wait on it, so seeding is not held up", () => {
    expect(start).not.toMatch(/await nudgeMlAwake/);
  });
});
