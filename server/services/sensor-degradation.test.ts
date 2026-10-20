// server/services/sensor-degradation.test.ts
//
// sensor_degradation_rate read 0.0000 in all 50 snapshots on the deployed
// instance, and had done in every snapshot the system ever took.
//
// Two causes, found a week apart. The query named columns from a schema that
// no longer existed, so it threw and a bare catch returned {}. That was fixed,
// and the value stayed at zero, because the baseline window asked for readings
// from 365 to 180 days ago and the sensor log holds 90 days. AVG() over no
// rows is NULL, the code substituted the recent value for the missing
// baseline, and the arithmetic became (x - x) / x.
//
// Both failures produced the same output: a confident, identical, plausible
// number. The point of these tests is that an absent measurement now looks
// absent.

import { describe, it, expect } from "vitest";
import { computeSensorDegradation } from "./feature-engineering-enhanced";

describe("computeSensorDegradation", () => {
  it("is null when there is no baseline at all", () => {
    // The case that produced 50 zeroes.
    expect(computeSensorDegradation(12, null, 95, null)).toBeNull();
  });

  it("is null when there are no recent readings", () => {
    expect(computeSensorDegradation(null, 10, null, 90)).toBeNull();
  });

  it("is null when the baseline is zero rather than missing", () => {
    // Dividing by it would be Infinity, which is worse than not answering.
    expect(computeSensorDegradation(12, 0, 95, 0)).toBeNull();
  });

  it("does not report zero degradation when it simply does not know", () => {
    // The distinction the whole fix rests on.
    expect(computeSensorDegradation(12, null, 95, null)).not.toBe(0);
  });

  it("averages both signals when both are measured", () => {
    // vibration +20%, temperature +10% → 0.15
    expect(computeSensorDegradation(12, 10, 110, 100)).toBeCloseTo(0.15, 6);
  });

  it("gives a lone signal full weight rather than halving it", () => {
    // Halving against a signal that was never taken would under-report a
    // machine whose only working sensor is screaming.
    expect(computeSensorDegradation(12, 10, null, null)).toBeCloseTo(0.2, 6);
    expect(computeSensorDegradation(null, null, 110, 100)).toBeCloseTo(0.1, 6);
  });

  it("floors at zero: cooler and quieter is not negative degradation", () => {
    expect(computeSensorDegradation(8, 10, 90, 100)).toBe(0);
  });

  it("caps each signal at 1 so one runaway sensor cannot dominate", () => {
    // A tenfold vibration reading is a fault, but it is still one signal of
    // two; without the per-signal cap it would drag the mean past anything
    // the other signal could say.
    expect(computeSensorDegradation(100, 10, 100, 100)).toBeCloseTo(0.5, 6);
  });

  it("stays within 0..1", () => {
    for (const [rv, bv, rt, bt] of [
      [1e6, 1, 1e6, 1], [0, 1, 0, 1], [1, 1, 1, 1],
    ] as const) {
      const v = computeSensorDegradation(rv, bv, rt, bt)!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
