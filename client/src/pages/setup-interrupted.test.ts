// client/src/pages/setup-interrupted.test.ts
//
// A seed ran, got through six steps, and then the API restarted -- a deploy
// pushed while it was running. The progress screen sat on "Historical sensor
// data & failure events, 4/10" for half an hour, because the server was
// reporting "idle" (its in-memory job state had gone with the process) and
// this screen only acted on "completed" and "failed".
//
// The database said otherwise the whole time: snapshots written, nothing
// after, total_days_run still 0. But nobody watching the screen could know
// that, and the obvious reading was that step 4 was slow.
//
// No DOM in this suite, so this asserts on the source: the three states the
// screen must distinguish, and that it no longer treats a vanished run as
// something to keep waiting on.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "setup.tsx"), "utf-8");

/** The effect that decides when the progress screen stops waiting. */
const effect = SRC.match(/\/\/ Detect completion\/failure[\s\S]*?\n  \}, \[[^\]]*\]\);/)![0];

describe("the setup screen reacts to a vanished run", () => {
  it("found the effect", () => {
    expect(effect).toMatch(/seedJob/);
    expect(effect).toMatch(/completed/);
  });

  it("still handles the two states the server can report itself", () => {
    expect(effect).toMatch(/=== "completed"/);
    expect(effect).toMatch(/=== "failed"/);
  });

  it("treats idle-after-running as an interrupted run", () => {
    // "idle" cannot mean "not started" once the job has been seen running:
    // the only way back to idle is the process losing its state.
    expect(effect).toMatch(/sawRunning/);
    expect(effect).toMatch(/=== "idle"/);
    expect(effect).toMatch(/setInterrupted\(true\)/);
  });

  it("leaves the waiting screen when that happens", () => {
    // The bug was not a missing message, it was waiting forever.
    const idleBranch = effect.match(/sawRunning && seedJob\.state === "idle"\)\s*\{[\s\S]*?\n    \}/)![0];
    expect(idleBranch).toMatch(/setMode\("done"\)/);
    expect(idleBranch).toMatch(/setSeedingStarted\(false\)/);
  });

  it("only arms after the job has actually been seen running", () => {
    // Without this the screen would call a run interrupted in the moment
    // between pressing the button and the first poll coming back.
    expect(effect).toMatch(/state === "running"\) setSawRunning\(true\)/);
  });

  it("does not report an interrupted run as success", () => {
    expect(SRC).toMatch(/const success = seedJob\?\.state === "completed" && !interrupted/);
  });

  it("says what happened and what to do", () => {
    expect(SRC).toMatch(/Setup was interrupted/);
    expect(SRC).toMatch(/restarted before setup finished/);
    expect(SRC).toMatch(/Reset and load again/);
  });

  it("does not claim the written data is gone", () => {
    // A reset is needed, but the rows that were written are still there --
    // saying otherwise would send someone looking for a problem they do not
    // have.
    expect(SRC).toMatch(/still there/);
  });
});
