// server/seeds/rentals.test.ts
//
// After the reseed, two rentals were ACTIVE and both machines were listed
// AVAILABLE. The new-rental form offers precisely the AVAILABLE units, so a
// dispatcher could hire out a crane that was already on a job.
//
// POST /api/rentals has always flipped the status; the seeder writes straight
// to the table with raw SQL and so skipped the part of the write that is not
// in the INSERT. Any seeder that bypasses the API has to carry the API's
// invariants itself, and nothing was checking that it did.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "rentals.ts"), "utf-8");

describe("the rental seeder leaves the fleet consistent", () => {
  it("marks equipment RENTED for an active rental", () => {
    expect(SRC).toMatch(/UPDATE equipment SET status = 'RENTED'/);
  });

  it("does it only for ACTIVE rentals", () => {
    // A completed rental has given the machine back; marking it RENTED would
    // take the whole fleet out of service.
    const guard = SRC.match(/if \(status === "ACTIVE"\) \{[\s\S]*?\n    \}/)?.[0];
    expect(guard, "the status update is not guarded by rental status").toBeDefined();
    expect(guard!).toMatch(/RENTED/);
  });

  it("writes a return date only for completed rentals", () => {
    // The other half of the same invariant: an active rental has not come
    // back, so its return date is null -- which is why the insert schema must
    // not require one.
    expect(SRC).toMatch(/status === "COMPLETED" \? daysAgo\([^)]*\) : null/);
  });

  it("still has at least one active rental to show", () => {
    // If every seeded rental were COMPLETED the rentals page would look dead,
    // and this test would pass vacuously.
    const actives = SRC.match(/"ACTIVE"\]/g) ?? [];
    expect(actives.length).toBeGreaterThan(0);
  });
});
