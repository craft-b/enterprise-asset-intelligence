// server/services/mtbf.test.ts
//
// mean_time_between_failures is a model feature, and it was selecting the wrong
// rows. It filtered on maintenance_type IN ('MAJOR_SERVICE', 'MINOR_SERVICE')
// -- what was done -- when the metric is about failures, which is
// event_source. The schema spells out why those differ: "A MAJOR_SERVICE from
// REACTIVE_REPAIR is a different signal than one from PREDICTIVE_INTERVENTION
// — same maintenanceType, fundamentally different operational context."
//
// Counting a scheduled major service as a failure inflates the failure count
// and shortens the mean, so an asset kept in good order looks like one that
// keeps breaking. On the demo seed the two filters happen to select the same
// eight rows, which is why nothing looked wrong.
//
// Separately: the feature is non-null in 1 of 240 snapshots, and that is
// arithmetic rather than a defect. A mean needs two failures before the
// snapshot date, and a 180-day seed gives most assets one or none. Only EQ-005
// has two (124 days apart), and only its last snapshot carries the value. The
// other 239 take the trainer's COALESCE default of 500 -- which means this
// feature carries almost no signal in the demo, and that is documented in the
// README rather than papered over.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "feature-engineering-enhanced.ts"), "utf-8");

/** The MTBF query and the arithmetic that follows it. */
const MTBF_BLOCK = SRC.slice(
  SRC.indexOf("Mean time between FAILURES"),
  SRC.indexOf("// ── Sensor data"),
);

describe("MTBF counts failures, not services", () => {
  it("selects on event_source", () => {
    expect(MTBF_BLOCK).toMatch(/eventSource\} = 'REACTIVE_REPAIR'/);
  });

  it("no longer selects on maintenance_type", () => {
    // The old filter. If it returns, a scheduled service counts as a breakdown.
    expect(MTBF_BLOCK).not.toMatch(/maintenanceType\} IN \('MAJOR_SERVICE'/);
  });

  it("still bounds the history at the snapshot date", () => {
    // The point-in-time rule: a snapshot built for time T must not see events
    // after T, or training reads the label off its own features (ML-1).
    expect(MTBF_BLOCK).toMatch(/maintenanceDate\} <= \$\{nowStr\}/);
  });
});

describe("MTBF needs two failures to mean anything", () => {
  it("stays null below two events", () => {
    // One failure gives no interval. Returning 0, or the asset's age, would
    // both be fabrications -- null is the honest answer and the trainer's
    // COALESCE decides what to impute.
    expect(MTBF_BLOCK).toMatch(/allMaint\.length >= 2/);
    expect(MTBF_BLOCK).toMatch(/meanTimeBetweenFailures: number \| null = null/);
  });

  it("averages the gaps between consecutive failures", () => {
    expect(MTBF_BLOCK).toMatch(/gaps\.reduce\(\(a, b\) => a \+ b, 0\) \/ gaps\.length/);
  });

  it("floors the mean at 14 days", () => {
    // Two repairs in the same week would otherwise produce an MTBF near zero
    // and a feature value far outside anything in the training distribution.
    expect(MTBF_BLOCK).toMatch(/\n\s*14\s*\n|,\s*14\s*\)/);
  });
});
