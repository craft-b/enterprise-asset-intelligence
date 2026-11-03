// server/projection-payload.test.ts
//
// The projection route built its ML payload from a hand-copied field list,
// which sent nulls straight through. SnapshotInput rejects a null, so any unit
// with no failure history -- no mean time between failures -- got a 502, while
// the same unit scored fine in a batch through toMlSnapshot's imputation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toMlSnapshot } from "./services/multi-horizon-scoring";

const routes = readFileSync(join(__dirname, "routes.ts"), "utf8");

describe("the projection payload", () => {
  it("is built by the batch path's mapper", () => {
    const start = routes.indexOf("async function requestProjection");
    const body = routes.slice(start, routes.indexOf("\n  }\n", start));
    expect(body).toContain("toMlSnapshot(equipmentId, snapshot)");
    expect(body).not.toContain("mean_time_between_failures: snapshot.");
  });

  it("imputes a unit with no failure history instead of sending null", () => {
    const payload = toMlSnapshot(7, { assetAgeYears: 3, category: "Crane", meanTimeBetweenFailures: null });
    expect(typeof payload.mean_time_between_failures).toBe("number");
    expect(Object.values(payload).some(v => v === null || v === undefined)).toBe(false);
  });
});
