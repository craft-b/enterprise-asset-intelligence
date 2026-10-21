// server/services/scoring-outcome.test.ts
//
// A seed finished, loaded every table, reported "Demo Data Loaded" with a
// single warning about training, and left the risk queue empty with nothing
// saying so.
//
// The ML service had failed its health check, which returns
// { predictions: [], attempted: 0, serviceAvailable: false }. The branch chain
// deciding the step's fate asked `attempted > 0 && predictions.length === 0`
// (false, attempted is 0), then `predictions.length < attempted` (false, 0 is
// not less than 0), then fell through to the success branch: "0 predictions
// generated", completed, green check, no warning.
//
// serviceAvailable had been added to the return type for exactly this case and
// was never read. The comment above the chain claimed the bug was fixed.
//
// Every row below is a combination that reached production code without anyone
// being able to see it was unhandled. That is the argument for the decision
// being a pure function: these are three independent inputs, and eyeballing an
// if-chain does not enumerate them.

import { describe, it, expect } from "vitest";
import { classifyScoringOutcome } from "./seed-orchestrator";

const outcome = (over: Partial<Parameters<typeof classifyScoringOutcome>[0]> = {}) => ({
  predictions: [],
  attempted: 0,
  serviceAvailable: true,
  ...over,
});

const n = (count: number) => Array.from({ length: count }, (_, i) => i);

describe("classifyScoringOutcome", () => {
  it("fails when the service is unavailable, even with nothing attempted", () => {
    // The case that shipped: attempted 0, scored 0, service down.
    const v = classifyScoringOutcome(outcome({ serviceAvailable: false }));

    expect(v.status).toBe("failed");
    expect(v.warning).toBeDefined();
    expect(v.warning).toMatch(/stopped responding/);
    expect(v.detail).not.toMatch(/^0 predictions generated/);
  });

  it("never calls zero scored a success", () => {
    // Tying the zero check to `attempted` is what let a zero through, so this
    // sweeps attempted across the values that made the old chain fall over.
    for (const attempted of [0, 1, 10]) {
      const v = classifyScoringOutcome(outcome({ attempted }));
      expect(v.status, `attempted=${attempted}`).toBe("failed");
      expect(v.warning, `attempted=${attempted}`).toBeDefined();
    }
  });

  it("always warns when the risk queue is left empty", () => {
    // The dialog is the only place this surfaces, so a failed step with no
    // warning is indistinguishable from success to whoever is looking.
    for (const serviceAvailable of [true, false]) {
      for (const attempted of [0, 10]) {
        const v = classifyScoringOutcome(outcome({ serviceAvailable, attempted }));
        expect(v.warning, `service=${serviceAvailable} attempted=${attempted}`)
          .toBeDefined();
        expect(v.warning).toMatch(/risk queue is empty/);
      }
    }
  });

  it("tells you how to recover, naming the button that exists", () => {
    // This string sends a reader to a specific control, so it has to match the
    // label on it. The button was called "Score Fleet" while the hook behind it
    // was useRunPredictions and a different page's button said "Run
    // Predictions" -- so advice naming one of them was as likely to misdirect
    // as to help. If the label moves again, this fails.
    const v = classifyScoringOutcome(outcome({ serviceAvailable: false }));
    expect(v.warning).toMatch(/Refresh Risk Queue/);
  });

  it("reports a partial pass as completed, with a warning", () => {
    const v = classifyScoringOutcome(outcome({ predictions: n(7), attempted: 10 }));

    expect(v.status).toBe("completed");
    expect(v.detail).toBe("7 of 10 predictions generated");
    expect(v.warning).toMatch(/3 of 10 assets could not be scored/);
  });

  it("names the reason on a partial pass when there is one", () => {
    const v = classifyScoringOutcome(
      outcome({ predictions: n(7), attempted: 10, firstError: "ECONNRESET" })
    );
    expect(v.warning).toMatch(/ECONNRESET/);
  });

  it("is quiet only when every asset was scored", () => {
    const v = classifyScoringOutcome(outcome({ predictions: n(10), attempted: 10 }));

    expect(v.status).toBe("completed");
    expect(v.detail).toBe("10 predictions generated");
    expect(v.warning).toBeUndefined();
  });

  it("carries the failure reason into the step detail", () => {
    const v = classifyScoringOutcome(
      outcome({ attempted: 10, firstError: "ML service returned 502" })
    );
    expect(v.detail).toMatch(/502/);
    expect(v.detail).toMatch(/0 of 10/);
  });

  it("says so plainly when no reason was reported", () => {
    const v = classifyScoringOutcome(outcome({ attempted: 10 }));
    expect(v.detail).toMatch(/no reason reported/);
  });

  it("keeps the detail short enough for the step row", () => {
    const v = classifyScoringOutcome(
      outcome({ attempted: 10, firstError: "x".repeat(2000) })
    );
    expect(v.detail.length).toBeLessThanOrEqual(300);
  });

  it("covers every combination of the three inputs", () => {
    // The hole was a combination nobody had considered, so this asserts the
    // function is total: it answers for all of them, and the answer agrees
    // with itself.
    for (const serviceAvailable of [true, false]) {
      for (const attempted of [0, 1, 10]) {
        for (const scored of [0, 1, 10]) {
          if (scored > attempted) continue;
          const v = classifyScoringOutcome(
            outcome({ serviceAvailable, attempted, predictions: n(scored) })
          );
          const label = `service=${serviceAvailable} attempted=${attempted} scored=${scored}`;

          expect(["completed", "failed"], label).toContain(v.status);
          expect(v.detail, label).toBeTruthy();

          // A green check means the queue has rows in it. No exceptions.
          if (v.status === "completed") {
            expect(scored, label).toBeGreaterThan(0);
            expect(serviceAvailable, label).toBe(true);
          }
          // Anything short of a full, healthy pass explains itself.
          if (scored < attempted || !serviceAvailable || scored === 0) {
            expect(v.warning, label).toBeDefined();
          }
        }
      }
    }
  });
});
