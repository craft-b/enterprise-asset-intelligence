// server/services/snapshot-concurrency.test.ts
//
// Snapshot generation ran assets strictly one after another, and each asset
// costs about eleven sequential queries. Sixty assets across twenty-four
// backfill dates is roughly 15,000 round trips taken in series against a
// hosted database -- the bulk of a sixty-asset seed.
//
// The risk in fixing it by scheduling is not that it breaks loudly. It is that
// an unbounded Promise.all looks like it works: on a ten-connection pool,
// sixty concurrent callers queue inside the driver instead of running, and the
// connection the progress endpoint needs is one of the ones taken. So the
// bound is tested, not assumed, along with the ordering guarantee that keeps
// two seeds of the same cursor comparable.

import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("./feature-engineering-enhanced", () => ({ enhancedFeatureService: {} }));

import {
  mapWithConcurrency,
  snapshotConcurrency,
  DEFAULT_SNAPSHOT_CONCURRENCY,
} from "./feature-engineering";

/** Resolves after a tick, recording how many calls overlapped. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    fn: async (x: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return x * 2;
    },
  };
}

describe("mapWithConcurrency", () => {
  it("keeps at most `limit` calls in flight", async () => {
    const t = tracker();
    await mapWithConcurrency(Array.from({ length: 60 }, (_, i) => i), 6, t.fn);
    expect(t.peak()).toBe(6);
  });

  it("actually overlaps, rather than being a slower for loop", async () => {
    // The assertion above passes trivially if nothing runs concurrently.
    const t = tracker();
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, t.fn);
    expect(t.peak()).toBeGreaterThan(1);
  });

  it("returns results in input order, not completion order", async () => {
    // Two seeds of the same cursor should be comparable, and the snapshot
    // list is written to the database in the order it comes back.
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 3, async n => {
      await new Promise(r => setTimeout(r, n * 4));
      return n;
    });
    expect(out).toEqual([5, 1, 4, 2, 3]);
  });

  it("does not leave workers idle behind one slow item", async () => {
    // Fixed slices per worker would stall a whole slice behind its slowest
    // member. Workers pull from a shared cursor instead.
    const t = tracker();
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async (x, i) => {
      if (i === 0) await new Promise(r => setTimeout(r, 60));
      return t.fn(x);
    });
    // The other nineteen were not waiting on item 0.
    expect(t.peak()).toBeGreaterThan(1);
  });

  it("handles an empty list and a limit above the item count", async () => {
    expect(await mapWithConcurrency([], 6, async x => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 50, async x => x)).toEqual([1, 2]);
  });

  it("refuses a limit that would never make progress", async () => {
    await expect(mapWithConcurrency([1], 0, async x => x))
      .rejects.toThrow(/at least 1/);
  });

  it("propagates a rejection rather than resolving short", async () => {
    // generateSnapshotsForAllEquipment catches per asset, so this path is not
    // reached there -- but a future caller that forgets to catch must not get
    // a silently short list back.
    await expect(mapWithConcurrency([1, 2, 3], 2, async n => {
      if (n === 2) throw new Error("boom");
      return n;
    })).rejects.toThrow("boom");
  });
});

describe("snapshotConcurrency", () => {
  it("defaults below the mysql2 pool size", () => {
    // The pool defaults to ten and the progress endpoint needs one of them
    // while the seed runs.
    expect(snapshotConcurrency({})).toBe(DEFAULT_SNAPSHOT_CONCURRENCY);
    expect(DEFAULT_SNAPSHOT_CONCURRENCY).toBeLessThan(10);
  });

  it("takes an override", () => {
    expect(snapshotConcurrency({ SNAPSHOT_CONCURRENCY: "3" })).toBe(3);
  });

  it("ignores a value that is not a usable count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["0", "-2", "2.5", "lots", ""]) {
      expect(snapshotConcurrency({ SNAPSHOT_CONCURRENCY: raw }))
        .toBe(DEFAULT_SNAPSHOT_CONCURRENCY);
    }
    warn.mockRestore();
  });
});
