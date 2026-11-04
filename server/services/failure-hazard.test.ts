import { describe, expect, it } from "vitest";
import {
  afterService,
  conditionFromHistory,
  dailyFailureProbability,
  degrade,
  CONDITION_CEILING,
  CONDITION_FLOOR,
  MAX_DAILY_FAILURE_PROB,
} from "./failure-hazard";

// The point of this model is that maintenance changes the breakdown rate.
// The hazard it replaced did not, measurably, and the champion trained on
// it ignored service entirely.

describe("failure hazard", () => {
  it("makes a serviced unit safer than a run-down one of the same age and hours", () => {
    const rundown = dailyFailureProbability(8, 6000, CONDITION_CEILING, false);
    const serviced = dailyFailureProbability(8, 6000, afterService(CONDITION_CEILING, "MAJOR_SERVICE"), false);
    expect(serviced).toBeLessThan(rundown / 4);
  });

  it("ranks the work: major restores more than minor; inspection restores nothing", () => {
    const c = 1.8;
    expect(afterService(c, "MAJOR_SERVICE")).toBeLessThan(afterService(c, "MINOR_SERVICE"));
    expect(afterService(c, "MINOR_SERVICE")).toBeLessThan(c);
    expect(afterService(c, "INSPECTION")).toBe(c);
  });

  it("fixes the failed part on a repair without resetting the unit's wear", () => {
    // If repairs restored condition, the units that break most would always
    // look freshly serviced, and the data would hide what service does.
    expect(afterService(1.8, "REPAIR")).toBe(1.8);
  });

  it("never lets work make a unit worse", () => {
    expect(afterService(CONDITION_FLOOR, "MINOR_SERVICE")).toBe(CONDITION_FLOOR);
  });

  it("keeps a neglected old unit below a coin flip per day", () => {
    expect(dailyFailureProbability(30, 40000, CONDITION_CEILING, true)).toBe(MAX_DAILY_FAILURE_PROB);
  });

  it("degrades with use, not with time on the shelf", () => {
    expect(degrade(1, 0)).toBe(1);
    expect(degrade(1, 1)).toBeGreaterThan(degrade(1, 0.3));
    expect(degrade(CONDITION_CEILING, 1)).toBe(CONDITION_CEILING);
  });

  it("replays history: a recent service beats an old one", () => {
    const asOf = new Date("2026-06-01");
    const recent = conditionFromHistory([{ date: new Date("2026-05-20"), kind: "MAJOR_SERVICE" }], asOf);
    const stale = conditionFromHistory([{ date: new Date("2025-10-01"), kind: "MAJOR_SERVICE" }], asOf);
    expect(recent).toBeLessThan(stale);
    expect(conditionFromHistory([{ date: new Date("2026-07-01"), kind: "MAJOR_SERVICE" }], asOf)).toBe(1);
  });
});
