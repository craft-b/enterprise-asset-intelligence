// server/services/sensor-ingest.test.ts
//
// Ingestion is the front door for data that becomes training features, so the
// cases that matter are the ones where bad input would be accepted rather than
// rejected: a shifted column, a units error, a file uploaded twice.
//
// The pure parsing and validation steps are covered here. The database-facing
// path (unknown equipment, duplicates already stored, chunked insert) was
// exercised against the live cluster.

import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));

import { csvToRecords, validateRecords } from "./sensor-ingest";

const HEADER = "equipment_id,timestamp,engine_rpm,load_percentage";

function records(csv: string) {
  return csvToRecords(csv);
}

describe("csvToRecords", () => {
  it("maps snake_case headers to fields", () => {
    const { records: r, errors } = records(`${HEADER}\n1,2026-01-01T00:00:00Z,1800,65\n`);

    expect(errors).toEqual([]);
    expect(r[0].value).toEqual({
      equipmentId: "1",
      timestamp: "2026-01-01T00:00:00Z",
      engineRpm: "1800",
      loadPercentage: "65",
    });
  });

  it("accepts camelCase and common aliases", () => {
    const { records: r } = records("equipmentId,time,rpm,load\n1,2026-01-01,1800,65\n");

    expect(Object.keys(r[0].value).sort()).toEqual(
      ["engineRpm", "equipmentId", "loadPercentage", "timestamp"]
    );
  });

  it("ignores columns it does not store", () => {
    // A vendor export carries fields this schema has no column for; requiring
    // someone to strip them by hand first would be a pointless obstacle.
    const { records: r, errors } = records(
      `${HEADER},gps_lat,operator_badge\n1,2026-01-01,1800,65,51.5,AB12\n`
    );

    expect(errors).toEqual([]);
    expect(r[0].value).not.toHaveProperty("gps_lat");
    expect(r[0].value.engineRpm).toBe("1800");
  });

  it("reports a missing required column instead of failing row by row", () => {
    const { records: r, errors } = records("timestamp,engine_rpm\n2026-01-01,1800\n");

    expect(r).toHaveLength(0);
    expect(errors[0].message).toMatch(/Missing required column "equipment_id"/);
  });

  it("treats an empty cell as absent rather than zero", () => {
    // Zero is a reading. Blank is no reading, and the difference matters to a
    // feature computed as a mean.
    const { records: r } = records(`${HEADER}\n1,2026-01-01,,65\n`);

    expect(r[0].value).not.toHaveProperty("engineRpm");
    expect(r[0].value.loadPercentage).toBe("65");
  });

  it("numbers rows the way an editor does", () => {
    const { records: r } = records(`${HEADER}\n1,2026-01-01,1800,65\n1,2026-01-02,1800,65\n`);
    expect(r.map(x => x.row)).toEqual([2, 3]);
  });
});

describe("validateRecords", () => {
  const row = (over: Record<string, unknown> = {}, n = 2) => ({
    value: { equipmentId: "1", timestamp: "2026-01-01T00:00:00Z", ...over },
    row: n,
  });

  it("accepts a well-formed reading and coerces its types", () => {
    const { staged, errors } = validateRecords([row({ engineRpm: "1800" })]);

    expect(errors).toEqual([]);
    expect(staged[0].reading.equipmentId).toBe(1);
    expect(staged[0].reading.engineRpm).toBe(1800);
    expect(staged[0].reading.timestamp).toBeInstanceOf(Date);
  });

  it("rejects a value outside its plausible range", () => {
    // A units error — Fahrenheit, or a sensor reporting in different units —
    // is the kind of mistake that trains a confidently wrong model.
    const { errors } = validateRecords([row({ engineTemp: "9999" })]);
    expect(errors[0].message).toMatch(/engineTemp must be at most/);
  });

  it("rejects a non-numeric measurement", () => {
    const { errors } = validateRecords([row({ engineRpm: "n/a" })]);
    expect(errors[0].message).toMatch(/engineRpm must be a number/);
  });

  it("rejects a date that failed to parse", () => {
    const { errors } = validateRecords([row({ timestamp: "01/02/2026 oops" })]);
    expect(errors.some(e => /timestamp/.test(e.message))).toBe(true);
  });

  it("rejects a timestamp before 1990, which is usually a format error", () => {
    const { errors } = validateRecords([row({ timestamp: "1970-01-01T00:00:00Z" })]);
    expect(errors[0].message).toMatch(/before 1990/);
  });

  it("rejects a timestamp in the future", () => {
    const next = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const { errors } = validateRecords([row({ timestamp: next })]);
    expect(errors[0].message).toMatch(/future/);
  });

  it("reports every problem at once, not just the first", () => {
    // One round trip should be enough to fix the file.
    const { errors } = validateRecords([
      row({ engineRpm: "999999" }, 2),
      row({ timestamp: "nope" }, 3),
      row({ equipmentId: "abc" }, 4),
    ]);

    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(errors.map(e => e.row))).toEqual(new Set([2, 3, 4]));
  });

  it("rejects two readings for one machine at the same instant", () => {
    const { errors } = validateRecords([
      row({ engineRpm: "1800" }, 2),
      row({ engineRpm: "1900" }, 3),
    ]);

    expect(errors[0].row).toBe(3);
    expect(errors[0].message).toMatch(/duplicates the reading on line 2/);
  });

  it("allows the same instant for different machines", () => {
    const { errors, staged } = validateRecords([
      row({ equipmentId: "1" }, 2),
      row({ equipmentId: "2" }, 3),
    ]);

    expect(errors).toEqual([]);
    expect(staged).toHaveLength(2);
  });

  it("accepts a load percentage above 100, which the simulator emits", () => {
    // A rule the system's own data would fail is a rule nobody can trust.
    const { errors } = validateRecords([row({ loadPercentage: "110" })]);
    expect(errors).toEqual([]);
  });

  it("names the row and field so the file can be fixed without guessing", () => {
    const { errors } = validateRecords([row({ oilPressure: "-5" }, 47)]);

    expect(errors[0].row).toBe(47);
    expect(errors[0].field).toBe("oilPressure");
  });
});
