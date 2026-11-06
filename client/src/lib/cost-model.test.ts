import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { daysSinceRecentService, recentlyServicedIds, RECENT_SERVICE_DAYS } from "./cost-model";

// A crane serviced that morning was still told "Schedule PM by Day 0": the
// projection cannot see a service, only the risk left after it.

const event = (maintenanceDate: string, maintenanceType = "MAJOR_SERVICE", eventSource = "SCHEDULED_PM") =>
  ({ maintenanceDate, maintenanceType, eventSource });

describe("recentlyServicedIds", () => {
  it("names only the units with a recent service", () => {
    const events = [
      { ...event("2026-11-03"), equipmentId: 1 },
      { ...event("2026-06-01"), equipmentId: 1 },
      { ...event("2026-06-01"), equipmentId: 2 },
      { ...event("2026-11-04", "INSPECTION"), equipmentId: 3 },
    ];
    expect([...recentlyServicedIds(events, "2026-11-05")]).toEqual([1]);
  });
});

describe("daysSinceRecentService", () => {
  it("counts a service inside the window", () => {
    expect(daysSinceRecentService([event("2026-11-01")], "2026-11-05")).toBe(4);
  });

  it("uses the newest service", () => {
    expect(daysSinceRecentService([event("2026-08-01"), event("2026-11-03", "MINOR_SERVICE")], "2026-11-05")).toBe(2);
  });

  it("ignores a service older than the window", () => {
    expect(daysSinceRecentService([event("2026-09-01")], "2026-11-05")).toBeNull();
  });

  it("does not count inspections or breakdown repairs as service", () => {
    expect(daysSinceRecentService([
      event("2026-11-04", "INSPECTION"),
      event("2026-11-04", "MAJOR_SERVICE", "REACTIVE_REPAIR"),
    ], "2026-11-05")).toBeNull();
  });

  it("treats a service dated after the simulation clock as today", () => {
    expect(daysSinceRecentService([event("2026-11-06")], "2026-11-05")).toBe(0);
  });

  it("keeps the same window as the advisor", () => {
    const advisor = readFileSync(join(__dirname, "../../../ml-service/engine/genai_advisor.py"), "utf-8");
    expect(advisor).toContain(`RECENT_SERVICE_DAYS = ${RECENT_SERVICE_DAYS}`);
  });
});
