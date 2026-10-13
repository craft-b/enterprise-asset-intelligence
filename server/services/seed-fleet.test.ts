// server/services/seed-fleet.test.ts
//
// The demo fleet's age profile decides the risk distribution, and nothing in
// the code says so, so it is easy to edit one into uselessness.
//
// seedFailureEvents injects reactive repairs by integer age at the cursor:
// 3-5 for 10+ years, 1-3 for 6-9, 0-1 for 2-5, none below two. Measured on the
// live deployment, every asset at or above six years scored HIGH (0.657-0.692)
// and everything below it scored 0.29-0.49. So the count of assets aged six or
// more IS the count of HIGH rows, near enough.
//
// The first fleet had seven of them. A ten-asset yard with seven red rows
// reads as a model that emits one number regardless of input, which is the
// opposite of what this project is demonstrating -- and it is not fixed by
// touching the model or the thresholds, only by the fleet being a plausible
// mix of old and new.
//
// These assertions are read off the source rather than a running seed because
// the module reaches for the database at import.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");

interface Asset {
  code: string;
  serial: string;
  year: number;
  hours: number;
  category: string;
}

/** The fleet literal, parsed out of the seeder. */
function parseFleet(): Asset[] {
  const assets: Asset[] = [];
  const row =
    /equipmentId:\s*"(EQ-\d+)"[\s\S]*?category:\s*"([^"]+)"[\s\S]*?serial:\s*"([^"]+)"[\s\S]*?year:\s*(\d{4}),\s*hours:\s*(\d+)/g;
  for (const m of SOURCE.matchAll(row)) {
    assets.push({ code: m[1], category: m[2], serial: m[3], year: Number(m[4]), hours: Number(m[5]) });
  }
  return assets;
}

/** The cursor the seed treats as "today". */
function cursorDate(): Date {
  const m = SOURCE.match(/const SEED_CURSOR\s*=\s*"(\d{4}-\d{2}-\d{2})"/);
  if (!m) throw new Error("SEED_CURSOR not found");
  return new Date(m[1]);
}

/** Integer age, matching how seedFailureEvents tiers assets. */
const tierAge = (year: number, cursor: Date) => cursor.getFullYear() - year;

/**
 * Roughly what the 90-day sensor seed adds, by category.
 *
 * From dailyHoursByCategory in the seeder, times ~76 non-idle days. Only used
 * to check an asset clears the cold-start floor, so the low end is taken.
 */
const MIN_HOURS_ADDED: Record<string, number> = {
  Compressor: 10 * 76,
  Generator: 12 * 76,
  Hauler: 7 * 76,
  Loader: 7 * 76,
};
const minAdded = (category: string) => MIN_HOURS_ADDED[category] ?? 5 * 76;

const fleet = parseFleet();
const cursor = cursorDate();

describe("the demo fleet", () => {
  it("parsed", () => {
    // Guards everything below: a regex that matched nothing would pass it all.
    expect(fleet).toHaveLength(10);
    expect(fleet.map(a => a.code)).toContain("EQ-001");
    expect(fleet.every(a => a.year > 2000 && a.hours >= 0)).toBe(true);
  });

  it("has a cursor to measure ages against", () => {
    expect(cursor.getFullYear()).toBeGreaterThan(2020);
  });

  it("does not stack the fleet into the HIGH tier", () => {
    // Six years is where injected failures begin in earnest. More than four
    // such assets and the risk queue is mostly red before anything is scored.
    const old = fleet.filter(a => tierAge(a.year, cursor) >= 6);
    expect(
      old.map(a => `${a.code} (${tierAge(a.year, cursor)}y)`),
      "assets aged 6+ score HIGH; keep this to four or fewer or the demo " +
      "shows a fleet where everything is failing"
    ).toHaveLength(3);
  });

  it("keeps genuinely old assets, so HIGH means something", () => {
    // The opposite failure: a uniformly new fleet has no risk to show.
    const veryOld = fleet.filter(a => tierAge(a.year, cursor) >= 10);
    expect(veryOld.length).toBeGreaterThanOrEqual(2);
  });

  it("has assets too new to be assigned any failure", () => {
    // Below two years seedFailureEvents injects nothing, which is what makes
    // a LOW row possible at all.
    const young = fleet.filter(a => tierAge(a.year, cursor) < 2);
    expect(young.length).toBeGreaterThanOrEqual(2);
  });

  it("spreads across the tiers rather than clustering", () => {
    const tiers = { high: 0, mid: 0, low: 0 };
    for (const a of fleet) {
      const age = tierAge(a.year, cursor);
      if (age >= 6) tiers.high++;
      else if (age >= 2) tiers.mid++;
      else tiers.low++;
    }
    // Every tier populated: the point of the demo is a mixed fleet.
    expect(tiers.high).toBeGreaterThan(0);
    expect(tiers.mid).toBeGreaterThan(0);
    expect(tiers.low).toBeGreaterThan(0);
  });

  it("never trips the cold-start rule at the cursor", () => {
    // isColdStart in services/imputation.ts: under one year old AND under 500
    // lifetime hours is scored by rule, not by the model. An asset that lands
    // there shows "rule:cold-start-v1" in the risk queue instead of a
    // prediction, which is honest but is not what the demo is for.
    for (const a of fleet) {
      const purchase = new Date(`${a.year}-06-15`);
      const ageYears = (cursor.getTime() - purchase.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears >= 1) continue;
      const hoursAtCursor = a.hours + minAdded(a.category);
      expect(
        hoursAtCursor,
        `${a.code} is ${ageYears.toFixed(2)}y old at the cursor, so it needs ` +
        `500+ lifetime hours to be scored by the model`
      ).toBeGreaterThan(500);
    }
  });

  it("owns nothing it has not bought yet", () => {
    for (const a of fleet) {
      expect(new Date(`${a.year}-06-15`).getTime(), `${a.code} is future-dated`)
        .toBeLessThan(cursor.getTime());
    }
  });

  it("gives older assets more hours than new ones", () => {
    // Not a strict ordering -- a compressor outworks a crane -- but the oldest
    // asset outrunning the newest is the minimum for the fleet to read as real.
    const byAge = [...fleet].sort((a, b) => tierAge(b.year, cursor) - tierAge(a.year, cursor));
    expect(byAge[0].hours).toBeGreaterThan(byAge[byAge.length - 1].hours);
  });

  it("carries serial numbers that agree with the model year", () => {
    // The serials embed the year. Changing one without the other leaves a 2024
    // machine stamped 2022, which is exactly the detail a reviewer from this
    // industry notices.
    for (const a of fleet) {
      const stamped = a.serial.match(/-(\d{4})-/);
      expect(stamped, `${a.code} serial has no year: ${a.serial}`).not.toBeNull();
      expect(Number(stamped![1]), `${a.code} serial ${a.serial} vs year ${a.year}`)
        .toBe(a.year);
    }
  });

  it("has unique codes and serials", () => {
    expect(new Set(fleet.map(a => a.code)).size).toBe(fleet.length);
    expect(new Set(fleet.map(a => a.serial)).size).toBe(fleet.length);
  });
});
