import { describe, expect, it } from "vitest";
import { api } from "@shared/routes";

// POST /api/maintenance stored whatever it was sent: a made-up type, a negative
// cost. A missing date reached the database and came back as raw SQL.

const create = api.maintenance.create.input;
const update = api.maintenance.update.input;
const valid = { equipmentId: 1, maintenanceDate: "2026-11-06", maintenanceType: "MINOR_SERVICE" };

describe("maintenance input", () => {
  it("accepts what the forms send", () => {
    const parsed = create.parse({ ...valid, cost: "", description: "Oil change", performedBy: null, nextDueDate: null });
    expect(parsed.cost).toBeNull();
    expect(parsed.eventSource).toBe("SCHEDULED_PM");
  });

  it.each([
    ["a made-up type", { ...valid, maintenanceType: "NOPE" }],
    ["a negative cost", { ...valid, cost: "-50" }],
    ["a cost that is not a number", { ...valid, cost: "lots" }],
    ["a missing date", { equipmentId: 1, maintenanceType: "MINOR_SERVICE" }],
    ["an impossible date", { ...valid, maintenanceDate: "2026-13-45" }],
    ["a unit that is not an id", { ...valid, equipmentId: "1" }],
  ])("refuses %s", (_name, body) => {
    expect(create.safeParse(body).success).toBe(false);
  });

  it("keeps only the day of a date read back from the API", () => {
    expect(create.parse({ ...valid, maintenanceDate: "2026-11-06T00:00:00.000Z" }).maintenanceDate).toBe("2026-11-06");
  });

  it("an edit leaves fields it does not mention alone", () => {
    expect(update.parse({ description: "Corrected" })).toEqual({ description: "Corrected" });
  });
});
