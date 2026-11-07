import { describe, it, expect } from "vitest";
import { evaluatePMSchedule, PM_CONFIG } from "./pm-scheduler";

const never = { INSPECTION: null, MINOR_SERVICE: null, MAJOR_SERVICE: null };
const snapshot = {} as any;
const interval = PM_CONFIG.Crane.INSPECTION.baseDays;

function firstInspectionDay(unitId: number): number {
  for (let d = 0; d < interval; d++) {
    const date = new Date(Date.UTC(2026, 0, 1 + d));
    if (evaluatePMSchedule("Crane", snapshot, never, { unitId, date }).some((t) => t.maintenanceType === "INSPECTION")) return d;
  }
  return -1;
}

describe("evaluatePMSchedule", () => {
  it("fires a never-done service for every unit on the first day without a unit and date", () => {
    const fired = evaluatePMSchedule("Crane", snapshot, never).map((t) => t.maintenanceType);
    expect(fired).toEqual(["INSPECTION", "MINOR_SERVICE", "MAJOR_SERVICE"]);
  });

  it("spreads never-done services across one interval when given a unit and date", () => {
    const days = Array.from({ length: 10 }, (_, i) => firstInspectionDay(i + 1));
    expect(days.every((d) => d >= 0)).toBe(true);
    expect(new Set(days).size).toBeGreaterThan(5);
  });

  it("schedules a service already done by its interval, as before", () => {
    const done = { INSPECTION: interval, MINOR_SERVICE: 1, MAJOR_SERVICE: 1 };
    const fired = evaluatePMSchedule("Crane", snapshot, done, { unitId: 3, date: new Date() }).map((t) => t.maintenanceType);
    expect(fired).toEqual(["INSPECTION"]);
  });
});
