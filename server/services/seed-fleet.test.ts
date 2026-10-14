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

/**
 * Duty cycle at the cursor: lifetime hours over age in hours.
 *
 * Mirrors wearRate in feature-engineering-enhanced.ts, which is the feature
 * that actually decides the risk band -- it is the top driver on every row.
 */
function projectedWearRate(a: Asset): number {
  const purchase = new Date(`${a.year}-06-15`);
  const ageYears = (cursor.getTime() - purchase.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (ageYears <= 0) return Infinity;
  return (a.hours + minAdded(a.category)) / (ageYears * 8760);
}

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

  it("has lightly-used assets, which is what produces a LOW row", () => {
    // This assertion previously demanded assets under two years old, on the
    // assumption that youth produces low risk. It does not, and the fleet
    // built on that assumption scored zero LOW rows.
    //
    // The dominant feature is wear rate -- lifetime hours over age in hours --
    // which is duty cycle. A nine-month-old unit with 878 hours scored 0.127,
    // higher than a 13-year-old crane at 0.092, because the hours are divided
    // by a very short life. Measured: wear 0.047 scored 0.295, which is LOW.
    const lightlyUsed = fleet.filter(a => projectedWearRate(a) <= 0.055);
    expect(
      lightlyUsed.map(a => `${a.code} (${projectedWearRate(a).toFixed(3)})`),
      "no asset has a low enough duty cycle to score LOW; being new is not " +
      "enough, since few hours over a short life is still a high duty cycle"
    ).not.toHaveLength(0);
    expect(lightlyUsed.length).toBeGreaterThanOrEqual(2);
  });

  it("works the old assets harder than the lightly-used ones", () => {
    // Without this the ordering can inverert: the first rebalance gave the
    // newest units the highest duty cycle in the fleet.
    const worked = fleet.filter(a => tierAge(a.year, cursor) >= 10);
    const light = fleet.filter(a => projectedWearRate(a) <= 0.055);
    const lowestWorked = Math.min(...worked.map(projectedWearRate));
    const highestLight = Math.max(...light.map(projectedWearRate));
    expect(highestLight).toBeLessThan(lowestWorked);
  });

  it("spreads across the failure tiers rather than clustering", () => {
    // These are seedFailureEvents' injection tiers. The under-two tier is not
    // required: assets in the 2-5 band mostly draw zero failures anyway, and
    // demanding one there is what pushed the fleet into the high-duty-cycle
    // shape that scored no LOW rows. What matters is that the fleet is not all
    // one age.
    const tiers = { old: 0, mid: 0, young: 0 };
    for (const a of fleet) {
      const age = tierAge(a.year, cursor);
      if (age >= 6) tiers.old++;
      else if (age >= 2) tiers.mid++;
      else tiers.young++;
    }
    expect(tiers.old).toBeGreaterThan(0);
    expect(tiers.mid).toBeGreaterThan(0);
    expect(Math.max(tiers.old, tiers.mid, tiers.young)).toBeLessThan(fleet.length);
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

describe("the ML wake budget", () => {
  // A seed that loads every table and leaves the risk queue empty is the
  // expensive failure here, and it happened: both wake attempts ran out of
  // budget, so training was skipped, the champion was not re-registered, and
  // nothing was scored -- while every data step reported success.
  const ORCH = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");

  it("does not borrow the per-request health timeout", () => {
    // ML_HEALTH_TIMEOUT_MS bounds a single request in
    // predictive-maintenance-fixed.ts. Reusing it as a total wake budget gave
    // one name two meanings, so tuning either silently moved the other.
    const line = ORCH.match(/const ML_WAKE_TIMEOUT_MS\s*=\s*[^;]+;/);
    expect(line, "ML_WAKE_TIMEOUT_MS not found").not.toBeNull();
    expect(line![0]).not.toMatch(/ML_HEALTH_TIMEOUT_MS/);
    expect(line![0]).toMatch(/ML_WAKE_TIMEOUT_MS/);
  });

  it("lets a single probe outlast a cold start", () => {
    // The original version of this test asked for the budget to be several
    // multiples of a probe, which sounds prudent and produced a 20s probe
    // against a cold start measured at 51s, 62s and then 72s. A suspended
    // instance holds the connection open while it boots -- that held request
    // is the wake -- so a probe shorter than the boot can never succeed, and
    // the budget buys nothing but more failures.
    const budget = Number(ORCH.match(/ML_WAKE_TIMEOUT_MS\s*\?\?\s*([\d_]+)/)![1].replace(/_/g, ""));
    const probe = Number(ORCH.match(/ML_WAKE_PROBE_MS\s*\?\?\s*([\d_]+)/)![1].replace(/_/g, ""));

    // Comfortably past the slowest wake observed, with room for it to worsen.
    expect(probe).toBeGreaterThanOrEqual(90_000);
    // And room for more than one attempt if the first finds a dead container.
    expect(budget).toBeGreaterThanOrEqual(probe * 2);
  });

  it("bounds each probe, so one hung request cannot eat the budget", () => {
    const fn = ORCH.match(/async function waitForMlService[\s\S]*?\n}/)![0];
    expect(fn).toMatch(/AbortController/);
    expect(fn).toMatch(/signal:\s*controller\.signal/);
    expect(fn).toMatch(/ML_WAKE_PROBE_MS/);
  });
});

describe("the sensor seed's query count", () => {
  // Step 4 wrote 90 days x 10 assets one row at a time, each preceded by a
  // category lookup and followed by a mileage update: ~2,700 sequential round
  // trips to a hosted database. The category lookup alone ran 900 times for
  // ten values that never change. The step has no sub-progress, so minutes of
  // that looked like a hang, and the obvious reading was that the seed had
  // stalled.
  const SRC = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");
  const fn = SRC.match(/async function seedSensorData[\s\S]*?\n}/)![0];

  it("found the function", () => {
    expect(fn).toMatch(/sensor_data_logs/);
  });

  it("does not look up the category inside the loop", () => {
    // One query for all of them, before the loop.
    expect(fn).not.toMatch(/SELECT category FROM equipment WHERE id/);
    expect(fn).toMatch(/categoryById/);
  });

  it("inserts in batches rather than row at a time", () => {
    expect(fn).toMatch(/VALUES \$\{sql\.join\(/);
  });

  it("updates mileage once per asset, not once per reading", () => {
    // The accumulator is the tell: hours are summed in memory first.
    expect(fn).toMatch(/hoursByEquipment/);
    const updates = fn.match(/UPDATE equipment SET current_mileage/g) ?? [];
    expect(updates).toHaveLength(1);
  });

  it("no longer swallows insert errors as duplicates", () => {
    // INSERT IGNORE already drops a duplicate key, so the catch could only
    // ever hide a real failure -- which is how a step reports success having
    // written nothing.
    expect(fn).not.toMatch(/catch\s*\{\s*\/\/ IGNORE duplicate/);
    expect(fn).toMatch(/INSERT IGNORE INTO sensor_data_logs/);
  });
});

describe("seeded maintenance is dated honestly", () => {
  // The risk queue discounts a unit's displayed probability when maintenance
  // was logged in the last 24 hours (x0.75 major, x0.87 minor, x0.95
  // inspection). That is a real feature: log a repair during a session and
  // watch the risk fall.
  //
  // Seeded history let created_at default to now, so a January inspection
  // looked like it had just been entered. Six units came out 25% below what
  // the model predicted, and the Command Center showed 1 HIGH asset where the
  // model said 3 -- a dashboard quietly flattering the fleet, which is the one
  // thing this project cannot afford to do.
  const SRC = readFileSync(join(__dirname, "seed-orchestrator.ts"), "utf-8");

  it("sets created_at on the pre-seed inspection", () => {
    const stmt = SRC.match(/INSERT INTO maintenance_events[\s\S]*?'SCHEDULED_PM'[\s\S]*?`\);/)![0];
    expect(stmt).toMatch(/created_at/);
    expect(stmt).toMatch(/lastMaint \+ " 09:00:00"/);
  });

  it("sets created_at on injected failures", () => {
    const stmt = SRC.match(/INSERT INTO maintenance_events[\s\S]*?'REACTIVE_REPAIR'[\s\S]*?`\);/)![0];
    expect(stmt).toMatch(/created_at/);
    expect(stmt).toMatch(/failStr \+ " 09:00:00"/);
  });

  it("writes no maintenance row without one", () => {
    // A third insert added later without created_at would reopen this.
    const inserts = SRC.match(/INSERT INTO maintenance_events[\s\S]*?`\);/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const stmt of inserts) {
      expect(stmt, "a seeded maintenance row without created_at defaults to " +
        "now and trips the post-maintenance discount").toMatch(/created_at/);
    }
  });
});
