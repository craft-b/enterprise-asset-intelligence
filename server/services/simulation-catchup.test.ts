// server/catch-up.test.ts
//
// The simulation is meant to advance seven days per real day. It never did:
// scheduleDailyPM arms a setTimeout for 06:00, and a free instance suspends
// after about fifteen minutes without traffic, so the timer is almost never
// alive when it should fire and every restart rearms it from scratch. The
// clock sat on its seed date for five days while the real world moved on, and
// the demo showed rentals from the previous autumn.
//
// Catching up at boot fixes that, and introduces two ways to be wrong that
// are worth pinning down. This host starts the container on any visit after an
// idle period, so advancing per boot would race the clock far ahead of
// reality. And capping a long catch-up without accounting for it would drop
// the remainder on the floor.
//
// Both are arithmetic, which is why the arithmetic is a function.

import { describe, it, expect } from "vitest";
import { planCatchUp } from "./simulation-catchup";

const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
const NOW = () => new Date();

describe("planCatchUp", () => {
  it("does nothing inside the first real day", () => {
    // The clock moves in whole days; a few hours is not one.
    for (const hours of [0, 1, 11, 23]) {
      const plan = planCatchUp(new Date(Date.now() - hours * 3_600_000), NOW());
      expect(plan.applying, `${hours}h`).toBe(0);
      expect(plan.owed, `${hours}h`).toBe(0);
    }
  });

  it("owes seven simulation days for one real day", () => {
    const plan = planCatchUp(at(1), NOW(), 7, 28);
    expect(plan.realDays).toBe(1);
    expect(plan.owed).toBe(7);
    expect(plan.applying).toBe(7);
  });

  it("does not let repeated starts run the clock ahead", () => {
    // The failure this guards: on a host that boots whenever someone visits,
    // advancing per start would add a week of simulation every few minutes.
    // Ten starts inside one real day owe exactly what one start owes.
    const lastMoved = at(1);
    const first = planCatchUp(lastMoved, NOW(), 7, 28);
    expect(first.applying).toBe(7);

    // After that pass the mark has moved; a start moments later owes nothing.
    const second = planCatchUp(first.mark, NOW(), 7, 28);
    expect(second.applying).toBe(0);
  });

  it("caps a long absence instead of generating months at boot", () => {
    // Each simulation day costs a feature snapshot per asset.
    const plan = planCatchUp(at(90), NOW(), 7, 28);
    expect(plan.owed).toBe(630);
    expect(plan.applying).toBe(28);
  });

  it("carries the remainder rather than forgetting it", () => {
    // The mark advances only by the real time whose days were applied, so the
    // next start still owes the rest. Four real days' worth of 7 = 28 applied.
    const lastMoved = at(90);
    const plan = planCatchUp(lastMoved, NOW(), 7, 28);
    expect(plan.mark.getTime() - lastMoved.getTime()).toBeCloseTo(4 * DAY, -2);

    const next = planCatchUp(plan.mark, NOW(), 7, 28);
    expect(next.owed).toBe((90 - 4) * 7);
    expect(next.applying).toBe(28);
  });

  it("converges rather than falling further behind", () => {
    // Each pass applies 28 simulation days and consumes 4 real days, so a
    // backlog shrinks as long as starts are more frequent than every 4 days.
    let mark = at(30);
    let passes = 0;
    while (planCatchUp(mark, NOW(), 7, 28).applying > 0 && passes < 50) {
      mark = planCatchUp(mark, NOW(), 7, 28).mark;
      passes++;
    }
    expect(passes).toBeLessThan(50);
    expect(planCatchUp(mark, NOW(), 7, 28).applying).toBe(0);
  });

  it("never advances the mark past now", () => {
    // Writing a future timestamp would make the clock owe negative days and
    // stall until real time caught up with it.
    for (const days of [1, 5, 30, 400]) {
      const plan = planCatchUp(at(days), NOW(), 7, 28);
      expect(plan.mark.getTime(), `${days}d`).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("treats a future timestamp as nothing owed", () => {
    // A clock skew or a hand-edited row should not drive the simulation
    // backwards.
    const plan = planCatchUp(new Date(Date.now() + 5 * DAY), NOW());
    expect(plan.applying).toBe(0);
    expect(plan.realDays).toBe(0);
  });

  it("refuses nonsense configuration instead of looping", () => {
    expect(planCatchUp(at(10), NOW(), 0, 28).applying).toBe(0);
    expect(planCatchUp(at(10), NOW(), 7, 0).applying).toBe(0);
    expect(planCatchUp(at(10), NOW(), -7, 28).applying).toBe(0);
  });

  it("leaves the mark alone when nothing is applied", () => {
    const lastMoved = at(0.5);
    expect(planCatchUp(lastMoved, NOW()).mark.getTime()).toBe(lastMoved.getTime());
  });
});
