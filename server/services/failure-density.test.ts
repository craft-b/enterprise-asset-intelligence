// server/services/failure-density.test.ts
//
// The risk queue had no LOW row, and three attempts to fix it by reshaping
// the fleet moved individual assets without moving the floor.
//
// The floor was the label base rate. seedFailureEvents was injecting 18
// reactive repairs across ten machines in six months -- a breakdown every
// five weeks for the oldest crane -- which put the 30-day positive rate at
// 33.5%. A calibrated model centres its output on the rate it was trained on,
// so the scores clustered around a third and the 0.30 threshold sat
// underneath nearly all of them.
//
// These assertions are on the injection tiers rather than on a seeded
// database, because the thing worth protecting is the intent: a demo fleet
// that breaks down at a rate a rental yard would recognise.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");
const AGES = [13, 12, 4, 5, 10, 3, 4, 2, 3, 2]; // the seeded fleet's ages
const HISTORY_DAYS = Number(SOURCE.match(/const SEED_HISTORY_DAYS = (\d+)/)?.[1] ?? 0);

/** The tier block, read out of the seeder. */
const tiers = SOURCE.match(
  /if\s+\(ageYears >= 10\) targetFailures = ([^;]+);[\s\S]*?ageYears >=\s+6\) targetFailures = ([^;]+);[\s\S]*?ageYears >=\s+2\) targetFailures = ([^;]+);/
);

/** Highest count a tier expression can return. */
function upperBound(expr: string): number {
  const range = expr.match(/(\d+) \+ Math\.floor\(Math\.random\(\) \* (\d+)\)/);
  if (range) return Number(range[1]) + Number(range[2]) - 1;
  const floor = expr.match(/^Math\.floor\(Math\.random\(\) \* (\d+)\)$/);
  if (floor) return Number(floor[1]) - 1;
  const coin = expr.match(/Math\.random\(\) < [\d.]+ \? (\d+) : (\d+)/);
  if (coin) return Math.max(Number(coin[1]), Number(coin[2]));
  return Number(expr.trim());
}

/** Mean count a tier expression returns — this is what sets the base rate. */
function expected(expr: string): number {
  const range = expr.match(/(\d+) \+ Math\.floor\(Math\.random\(\) \* (\d+)\)/);
  if (range) {
    const lo = Number(range[1]), n = Number(range[2]);
    return lo + (n - 1) / 2;
  }
  const floor = expr.match(/^Math\.floor\(Math\.random\(\) \* (\d+)\)$/);
  if (floor) return (Number(floor[1]) - 1) / 2;
  const coin = expr.match(/Math\.random\(\) < ([\d.]+) \? (\d+) : (\d+)/);
  if (coin) {
    const p = Number(coin[1]);
    return p * Number(coin[2]) + (1 - p) * Number(coin[3]);
  }
  return Number(expr.trim());
}

const forAge = (age: number) =>
  age >= 10 ? tiers![1] : age >= 6 ? tiers![2] : age >= 2 ? tiers![3] : "0";

describe("how often the demo fleet breaks down", () => {
  it("has tiers that can be read", () => {
    expect(tiers, "the failure-injection tiers are not where this test looks").not.toBeNull();
  });

  it("does not break the oldest machines every few weeks", () => {
    const worst = upperBound(tiers![1]);
    const weeksBetween = (HISTORY_DAYS / worst) / 7;
    expect(
      weeksBetween,
      `the oldest assets can draw ${worst} failures in ${HISTORY_DAYS} days, ` +
      `one every ${weeksBetween.toFixed(1)} weeks`
    ).toBeGreaterThan(8);
  });

  it("expects few enough failures to leave room under the LOW threshold", () => {
    // The fleet-wide mean is what sets the base rate, and the base rate is
    // what the calibrated scores centre on. Measured: 18 failures gave 33.5%
    // at 30 days, which left nothing below 0.30. Scaling from that point,
    // eight is about 15% and six about 11%.
    const mean = AGES.reduce((sum, age) => sum + expected(forAge(age)), 0);
    expect(
      Number(mean.toFixed(2)),
      `${mean.toFixed(1)} expected failures across ${AGES.length} assets; 18 ` +
      `produced a 33.5% base rate and a queue with no LOW row`
    ).toBeLessThanOrEqual(8);
  });

  it("cannot draw its way back to the old density on a bad roll", () => {
    // The mean is the target, but the tiers are random: a fleet that can draw
    // 18 again has not really been changed.
    const worst = AGES.reduce((sum, age) => sum + upperBound(forAge(age)), 0);
    expect(worst).toBeLessThan(15);
  });

  it("still breaks something, or there is nothing to predict", () => {
    // The opposite failure: a fleet that never fails trains a model on one
    // class and the whole demo is vacuous.
    const oldestFloor = tiers![1].includes("Math.random") ? 1 : Number(tiers![1].trim());
    expect(oldestFloor).toBeGreaterThanOrEqual(1);
  });

  it("breaks old machines more often than new ones", () => {
    expect(upperBound(tiers![1])).toBeGreaterThan(upperBound(tiers![3]));
  });
});
