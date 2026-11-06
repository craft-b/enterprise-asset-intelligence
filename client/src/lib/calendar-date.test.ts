import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import { calendarDate } from "./calendar-date";

// The day shown has to be the day stored, whatever the viewer's time zone.
describe("calendarDate", () => {
  it("keeps a plain date on its day", () => {
    expect(format(calendarDate("2026-11-06"), "yyyy-MM-dd")).toBe("2026-11-06");
  });

  it("keeps a date column serialized as midnight UTC on its day", () => {
    expect(format(calendarDate("2026-11-06T00:00:00.000Z"), "yyyy-MM-dd")).toBe("2026-11-06");
  });

  it("accepts a Date holding midnight UTC", () => {
    expect(format(calendarDate(new Date("2026-11-06T00:00:00.000Z")), "yyyy-MM-dd")).toBe("2026-11-06");
  });
});
