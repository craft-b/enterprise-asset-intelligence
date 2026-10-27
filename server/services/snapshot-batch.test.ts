// server/services/snapshot-batch.test.ts
//
// The seed wrote feature snapshots one row at a time. At ten assets that was
// 240 inserts against a hosted database and nobody noticed; at sixty it is
// 1,440, in a step whose cost is linear in the fleet.
//
// What is actually being protected here is not the speed. It is that the
// batched writer and the single-row writer keep producing the same row: there
// are thirty-seven columns, and the way this breaks is a feature added to one
// mapping and not the other, which does not fail anything -- it writes a null
// into a model input and the next training run quietly learns around it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const values = vi.fn().mockResolvedValue(undefined);
const insert = vi.fn(() => ({ values }));

// db.ts throws at import unless DATABASE_URL is set.
vi.mock("../db", () => ({ db: { insert: (...a: any[]) => insert(...a) }, pool: {} }));
vi.mock("./feature-engineering-enhanced", () => ({ enhancedFeatureService: {} }));

import { featureEngineeringService } from "./feature-engineering";
import type { FeatureSnapshot } from "./feature-engineering";

/** A snapshot with every numeric field present, so toRow has something to map. */
function snapshot(equipmentId: number): FeatureSnapshot {
  const n = 1;
  return {
    equipmentId,
    snapshotTs: new Date("2026-06-15T00:00:00Z"),
    assetAgeYears: n, category: "Excavator", totalHoursLifetime: n,
    hoursUsed30d: n, hoursUsed90d: n, rentalDays30d: 1, rentalDays90d: 1,
    avgRentalDuration: n, maintenanceEvents90d: 1, maintenanceCost180d: n,
    avgDowntimePerEvent: n, daysSinceLastMaintenance: 1,
    meanTimeBetweenFailures: null, vendorReliabilityScore: n,
    jobSiteRiskScore: n, usageIntensity: n, usageTrend: n,
    utilizationVsExpected: n, wearRate: n, agingFactor: n, maintOverdue: n,
    costPerEvent: n, maintBurden: n, mechanicalWearScore: n, abuseScore: n,
    neglectScore: n, wearRateVelocity: n, maintFrequencyTrend: n,
    costTrend: n, hoursVelocity: n, neglectAcceleration: n,
    sensorDegradationRate: n,
  } as unknown as FeatureSnapshot;
}

const rowsFromCalls = () => values.mock.calls.map(c => c[0] as any[]);

beforeEach(() => {
  insert.mockClear();
  values.mockClear();
});

describe("saveSnapshots", () => {
  it("writes a whole date's fleet in one statement", () => {
    // Sixty assets per backfill date is the case this exists for.
    return featureEngineeringService.saveSnapshots(
      Array.from({ length: 60 }, (_, i) => snapshot(i + 1))
    ).then(written => {
      expect(written).toBe(60);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(rowsFromCalls()[0]).toHaveLength(60);
    });
  });

  it("chunks rather than building one unbounded statement", async () => {
    // A multi-row INSERT spends a placeholder per column per row, and at
    // thirty-seven columns an unbounded batch would eventually hit the
    // protocol limit -- as a runtime error, mid-seed.
    const written = await featureEngineeringService.saveSnapshots(
      Array.from({ length: 250 }, (_, i) => snapshot(i + 1)), 100
    );
    expect(written).toBe(250);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(rowsFromCalls().map(r => r.length)).toEqual([100, 100, 50]);
  });

  it("does not touch the database for an empty list", async () => {
    // The backfill loop can legitimately produce nothing, and an INSERT with
    // no VALUES is a syntax error rather than a no-op.
    expect(await featureEngineeringService.saveSnapshots([])).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses a chunk size that would never terminate", async () => {
    await expect(featureEngineeringService.saveSnapshots([snapshot(1)], 0))
      .rejects.toThrow(/at least 1/);
  });

  it("writes the same row the single-row path writes", async () => {
    // The regression this file is really for. Both paths go through toRow, and
    // this holds that arrangement in place: a column added to one mapping and
    // not the other writes a null into a model input, which fails nothing and
    // shows up as a feature that stopped carrying signal.
    await featureEngineeringService.saveSnapshot(snapshot(7));
    const single = rowsFromCalls()[0][0];

    values.mockClear();
    insert.mockClear();

    await featureEngineeringService.saveSnapshots([snapshot(7)]);
    const batched = rowsFromCalls()[0][0];

    expect(batched).toEqual(single);
    // And the row is not accidentally empty, which would make the above vacuous.
    expect(Object.keys(single).length).toBeGreaterThan(30);
  });

  it("stops at the failing chunk instead of carrying on", async () => {
    // A row-at-a-time loop that threw on row 50 left 49 committed, so a failed
    // seed left a partial snapshot set that looked complete. Chunks land whole.
    values
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ER_LOCK_WAIT_TIMEOUT"));

    await expect(featureEngineeringService.saveSnapshots(
      Array.from({ length: 30 }, (_, i) => snapshot(i + 1)), 10
    )).rejects.toThrow(/LOCK_WAIT/);

    // Two attempted, third never issued.
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
