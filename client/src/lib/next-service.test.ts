import { describe, it, expect } from "vitest";
import { nextService } from "./next-service";

const levels = (l10: string, l30: string, l60: string) => ({ risk_level_10d: l10, risk_level_30d: l30, risk_level_60d: l60 });

describe("nextService", () => {
  it("shows the scheduled date when the model rates nothing High", () => {
    expect(nextService({ daysUntilDue: 29 }, levels("LOW", "MEDIUM", "MEDIUM"))).toEqual({ days: 29, moveUp: false });
  });

  it("moves the service up when the model rates High before the scheduled date", () => {
    expect(nextService({ daysUntilDue: 29 }, levels("HIGH", "HIGH", "HIGH"))).toEqual({ days: 10, moveUp: true });
  });

  it("keeps the scheduled date when it already comes first", () => {
    expect(nextService({ daysUntilDue: 8 }, levels("LOW", "HIGH", "HIGH"))).toEqual({ days: 8, moveUp: false });
  });

  it("moves up a unit High within 30 days with no service due in that time", () => {
    expect(nextService(undefined, levels("LOW", "HIGH", "HIGH"))).toEqual({ days: 30, moveUp: true });
  });

  it("does not move up a unit High only at 60 days when its service date is unknown", () => {
    expect(nextService(undefined, levels("LOW", "LOW", "HIGH"))).toBeNull();
  });

  it("shows nothing with neither a due date nor a High rating", () => {
    expect(nextService(undefined, levels("LOW", "LOW", "LOW"))).toBeNull();
    expect(nextService(undefined, undefined)).toBeNull();
  });

  it("reads a due date returned as a string", () => {
    expect(nextService({ daysUntilDue: "-3" }, undefined)).toEqual({ days: -3, moveUp: false });
  });
});
