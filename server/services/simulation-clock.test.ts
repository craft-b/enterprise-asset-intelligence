// server/services/simulation-clock.test.ts
//
// Batch scoring snapshotted at new Date() while every other part of the
// pipeline worked from simulation_state.cursor_date. On the live deployment
// that meant scoring a fleet 195 days after its last sensor reading: rolling
// windows came back empty and imputed, days_since_last_maintenance read ~200,
// and all ten assets landed HIGH or MEDIUM with nothing LOW.
//
// It is a one-word bug with no visible failure -- predictions are produced,
// stored and rendered, just against the wrong day -- so this pins the call
// site rather than the behaviour.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PM = readFileSync(join(__dirname, "predictive-maintenance-fixed.ts"), "utf-8");

/** Source with comments stripped: the ones here quote the bug being banned. */
const CODE = PM
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * Each generateSnapshot call, from the name to the end of its statement.
 *
 * Not a parenthesised-argument match: `[^)]*` stops at the first `)`, which
 * for `generateSnapshot(id, new Date())` is the one inside `new Date()`. The
 * captured text was then "id, new Date(" and matched nothing, giving a check
 * that passed with the bug still present.
 */
function snapshotCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "generateSnapshot(";
  let at = source.indexOf(marker);
  while (at !== -1) {
    const end = source.indexOf(";", at);
    calls.push(source.slice(at, end === -1 ? source.length : end));
    at = source.indexOf(marker, at + marker.length);
  }
  return calls;
}

describe("predictions are scored on the simulation clock", () => {
  it("is reading the file it asserts about", () => {
    expect(CODE).toMatch(/generateSnapshot/);
    expect(CODE.length).toBeGreaterThan(1000);
  });

  it("does not snapshot at the wall clock", () => {
    const calls = snapshotCalls(CODE);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(
        call,
        "pass the simulation cursor (getSimulationDate()) — new Date() scores " +
        "the fleet at the wall clock, which on a seeded deployment is months " +
        "after the data ends"
      ).not.toMatch(/new Date\(\s*\)/);
    }
  });

  it("gets its date from the shared clock", () => {
    expect(CODE).toMatch(/getSimulationDate/);
    expect(CODE).toMatch(/from ["']\.\/simulation-clock["']/);
  });

  it("recognises the construct it is banning", () => {
    // Guards the check above. This assertion is why the extraction is written
    // the way it is: with an argument-matching regex it failed, which is how
    // the false negative was found rather than shipped.
    const original =
      "const snapshot = await featureEngineeringService.generateSnapshot(equipmentId, new Date());";
    const calls = snapshotCalls(original);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/new Date\(\s*\)/);
  });
});
