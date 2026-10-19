// server/seeds/maintenance-config.test.ts
//
// The seed used to catch every error and log "already exists". A boot against
// an unreachable database therefore printed five lines of apparent success and
// carried on, so a bad DATABASE_URL looked like a healthy start. These tests
// pin both directions: a duplicate row stays benign, everything else escapes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

const insert = vi.fn();
vi.mock("../db", () => ({
  db: { insert: (...args: unknown[]) => insert(...args) },
  pool: {},
}));

import { readFileSync } from "fs";
import { join } from "path";
import { seedMaintenanceConfig } from "./maintenance-config";

/**
 * How many categories the seed tries to insert, read from the seed itself.
 *
 * This was the literal 5, which broke the moment the list grew to cover the
 * categories the fleet actually contains. The number was never the point --
 * these tests are about a duplicate being benign and everything else not
 * being, and both hold whatever the list's length is.
 */
const CATEGORY_COUNT = (
  readFileSync(join(__dirname, "maintenance-config.ts"), "utf-8")
    .match(/equipmentCategory:\s*"/g) ?? []
).length;

/** A db.insert(...) chain whose .values() settles as given. */
function chain(values: () => Promise<unknown>) {
  return { values };
}

function dupError() {
  return Object.assign(new Error("Duplicate entry 'Excavator'"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
  });
}

describe("seedMaintenanceConfig", () => {
  let logged: string[];

  beforeEach(() => {
    insert.mockReset();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("seeds every category on a clean database", async () => {
    insert.mockReturnValue(chain(() => Promise.resolve()));

    await expect(seedMaintenanceConfig()).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(CATEGORY_COUNT);
    expect(logged.filter(l => l.includes("Seeded config"))).toHaveLength(CATEGORY_COUNT);
  });

  it("treats a duplicate row as benign and keeps going", async () => {
    insert.mockReturnValue(chain(() => Promise.reject(dupError())));

    await expect(seedMaintenanceConfig()).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(CATEGORY_COUNT);
    expect(logged.filter(l => l.includes("already exists"))).toHaveLength(CATEGORY_COUNT);
  });

  it("rethrows a connection failure instead of reporting success", async () => {
    // The actual regression: ECONNREFUSED was logged as "already exists".
    const econn = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    insert.mockReturnValue(chain(() => Promise.reject(econn)));

    await expect(seedMaintenanceConfig()).rejects.toThrow(/ECONNREFUSED/);
    expect(logged.some(l => l.includes("already exists"))).toBe(false);
  });

  it.each([
    ["missing table", "ER_NO_SUCH_TABLE"],
    ["bad credentials", "ER_ACCESS_DENIED_ERROR"],
    ["unknown database", "ER_BAD_DB_ERROR"],
  ])("rethrows on %s", async (_label, code) => {
    insert.mockReturnValue(
      chain(() => Promise.reject(Object.assign(new Error(code), { code })))
    );

    await expect(seedMaintenanceConfig()).rejects.toThrow(code);
    expect(logged.some(l => l.includes("already exists"))).toBe(false);
  });

  it("stops at the first real error rather than retrying every category", async () => {
    insert.mockReturnValue(
      chain(() => Promise.reject(Object.assign(new Error("down"), { code: "ECONNREFUSED" })))
    );

    await expect(seedMaintenanceConfig()).rejects.toThrow();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  // drizzle's mysql-core session wraps EVERY query error in DrizzleQueryError
  // and puts the driver error under `cause`. So the real ER_DUP_ENTRY is never
  // on the thrown error itself -- without the cause walk, re-seeding an
  // already-seeded database would rethrow and fail the boot.
  it("recognises a duplicate inside a real DrizzleQueryError", async () => {
    insert.mockReturnValue(
      chain(() =>
        Promise.reject(new DrizzleQueryError("insert into `maintenance_config`", [], dupError()))
      )
    );

    await expect(seedMaintenanceConfig()).resolves.toBeUndefined();
    expect(logged.filter(l => l.includes("already exists"))).toHaveLength(CATEGORY_COUNT);
  });

  it("still rethrows a non-duplicate inside a real DrizzleQueryError", async () => {
    const driver = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    insert.mockReturnValue(
      chain(() =>
        Promise.reject(new DrizzleQueryError("insert into `maintenance_config`", [], driver))
      )
    );

    await expect(seedMaintenanceConfig()).rejects.toThrow(/Failed query/);
    expect(logged.some(l => l.includes("already exists"))).toBe(false);
  });
});
