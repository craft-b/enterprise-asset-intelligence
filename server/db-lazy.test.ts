// server/db-lazy.test.ts
//
// CI was red on main and every local run was green.
//
// db.ts threw at import time when DATABASE_URL was missing, so any module
// importing it transitively could not be loaded without one -- including four
// test files that only exercise pure functions and never open a connection.
// CI runs `npm test` with no database configured; every machine that had a
// .env ran a different suite. The configuration that matters was the one
// nobody ran.
//
// These are source-level assertions on purpose. Importing db.ts in-process to
// check the behaviour directly cannot work: it calls dotenv.config(), which
// would put DATABASE_URL straight back from the .env file the test is trying
// to do without.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const DB = readFileSync(join(__dirname, "db.ts"), "utf-8");
const INDEX = readFileSync(join(__dirname, "index.ts"), "utf-8");

/** Code lines at column 0 — not indented, not a comment. */
function topLevelLines(source: string): string[] {
  return source
    .split("\n")
    .filter(line => line.length > 0 && !/^[\s}]/.test(line))
    .filter(line => !/^(\/\/|\/\*|\*)/.test(line));
}

describe("importing db.ts does not require a database", () => {
  it("does not throw at the top level", () => {
    const offenders = topLevelLines(DB).filter(l => l.includes("throw "));
    expect(offenders, `top-level throw: ${offenders.join(" | ")}`).toHaveLength(0);
  });

  it("does not open the pool at the top level", () => {
    const offenders = topLevelLines(DB).filter(l => l.includes("createPool"));
    expect(offenders, `pool created on import: ${offenders.join(" | ")}`).toHaveLength(0);
  });

  it("still creates the pool exactly once", () => {
    // Lazy is not the same as per-call: a pool built on every property read
    // would exhaust the server's connection limit within a request or two.
    expect(DB).toMatch(/if \(!realPool\) connect\(\);/);
    expect(DB).toMatch(/if \(!realDb\) connect\(\);/);
  });

  it("binds forwarded methods to the real object", () => {
    // mysql2 and drizzle both use `this`. An unbound method called through the
    // proxy fails somewhere far away from here.
    expect(DB).toMatch(/typeof value === "function" \? value\.bind\(real\) : value/);
  });
});

describe("a missing DATABASE_URL is still fatal at boot", () => {
  it("db.ts exports the boot check", () => {
    expect(DB).toMatch(/export function assertDatabaseConfigured/);
  });

  it("index.ts calls it", () => {
    // Without this, laziness turns a clear boot failure into 500s from
    // whichever request queried first.
    expect(INDEX).toMatch(/^assertDatabaseConfigured\(\);/m);
  });

  it("and it says what to do about it", () => {
    expect(DB).toMatch(/DATABASE_URL must be set/);
  });
});
