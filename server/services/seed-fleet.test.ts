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
  serialPrefix: string;
  /** Unique within a shared prefix: several units run the same model. */
  serialSuffix: string;
  /** Years old at the cursor, which is how the seed now defines the fleet. */
  ageYears: number;
  hours: number;
  category: string;
  /** How hard the sensor seed works it: 1 is steady use, 0.3 mostly idle. */
  duty: number;
}

/** The fleet literal, parsed out of the seeder. */
function parseFleet(): Asset[] {
  const assets: Asset[] = [];
  const row =
    /equipmentId:\s*"(EQ-\d+)"[\s\S]*?category:\s*"([^"]+)"[\s\S]*?serialPrefix:\s*"([^"]+)"[\s\S]*?serialSuffix:\s*"([^"]+)"[\s\S]*?ageYears:\s*(\d+),\s*hours:\s*(\d+),\s*duty:\s*([\d.]+)/g;
  for (const m of SOURCE.matchAll(row)) {
    assets.push({
      code: m[1], category: m[2], serialPrefix: m[3], serialSuffix: m[4],
      ageYears: Number(m[5]), hours: Number(m[6]), duty: Number(m[7]),
    });
  }
  return assets;
}

/**
 * The cursor the seed treats as "today".
 *
 * Mirrors seedCursor() in the orchestrator: the pinned date when
 * SEED_CURSOR_DATE is set, otherwise the real one. It used to read a hardcoded
 * constant out of the source, which stopped existing when the seed was
 * anchored to the current date -- a demo seeded in October was producing a
 * world dated the previous April.
 */
function cursorDate(): Date {
  const pinned = process.env.SEED_CURSOR_DATE?.trim();
  if (pinned) return new Date(pinned);
  return new Date();
}

/** Integer age, matching how seedFailureEvents tiers assets. */
const tierAge = (a: Asset) => a.ageYears;

/**
 * Roughly what the 90-day sensor seed adds, by category.
 *
 * From dailyHoursByCategory in the seeder, times ~76 non-idle days. Only used
 * to check an asset clears the cold-start floor, so the low end is taken.
 */
const MIN_DAILY_HOURS: Record<string, number> = {
  Compressor: 10,
  Generator: 12,
  Hauler: 7,
  Loader: 7,
};

/**
 * Non-idle days in the 90-day window, and the length of one, both scale with
 * duty -- mirroring seedSensorData. Leaving this at a flat 76 days would have
 * the test describing the uniform accrual the duty factor exists to end, and
 * every projection below would be wrong for exactly the assets that matter.
 */
/** Read out of the seeder, so this cannot describe a window it no longer uses. */
const HISTORY_DAYS = Number(
  SOURCE.match(/const SEED_HISTORY_DAYS = (\d+)/)?.[1] ?? 0
);

const minAdded = (a: Asset) => {
  const perDay = (MIN_DAILY_HOURS[a.category] ?? 5) * (0.5 + 0.5 * a.duty);
  const activeDays = HISTORY_DAYS * (a.duty * 0.85);
  return perDay * activeDays;
};

/**
 * Duty cycle at the cursor: lifetime hours over age in hours.
 *
 * Mirrors wearRate in feature-engineering-enhanced.ts, which is the feature
 * that actually decides the risk band -- it is the top driver on every row.
 */
function projectedWearRate(a: Asset): number {
  // The seed sets purchase to June of (cursor year - ageYears), so the real
  // age straddles that by up to half a year either way. Close enough for a
  // duty-cycle bound, and it no longer drifts as the calendar moves.
  if (a.ageYears <= 0) return Infinity;
  return (a.hours + minAdded(a)) / (a.ageYears * 8760);
}

const fleet = parseFleet();
const cursor = cursorDate();

/**
 * The model year the seeder computes for an asset: cursor year minus age.
 *
 * This used to be read as `a.year`, a field Asset has never had. Every use of
 * it built `new Date("undefined-06-15")`, an Invalid Date, so the cold-start
 * check's `if (ageYears >= 1) continue` compared NaN and never continued --
 * it was applying the 500-hour floor to the whole fleet rather than to young
 * assets, and the future-dating check was asserting on NaN. Both tests passed
 * for the wrong reason; the 500-hour one passed by 57 hours on EQ-010.
 */
const assetYear = (a: Asset) => cursor.getFullYear() - a.ageYears;

describe("the demo fleet", () => {
  it("parsed", () => {
    // Guards everything below: a regex that matched nothing would pass it all.
    expect(fleet).toHaveLength(60);
    expect(fleet.map(a => a.code)).toContain("EQ-001");
    expect(fleet.every(a => a.ageYears > 0 && a.hours >= 0)).toBe(true);
  });

  it("has a cursor to measure ages against", () => {
    expect(cursor.getFullYear()).toBeGreaterThan(2020);
  });

  it("does not stack the fleet into the HIGH tier", () => {
    // Six years is where injected failures begin in earnest, so the count of
    // assets at or above it is the count of HIGH rows, near enough.
    //
    // This was pinned at exactly three, which was right for a ten-asset yard
    // and is wrong as a constant: the thing that matters is the share. Sixty
    // units with three old ones is a 5% HIGH rate, cleaner than any real
    // rental fleet and a waste of the extra assets. Held as a proportion, with
    // a floor so the fleet cannot go uniformly new either.
    const old = fleet.filter(a => tierAge(a) >= 6);
    expect(old.length, "a fleet with no old assets has no risk to show")
      .toBeGreaterThanOrEqual(3);
    expect(
      old.length / fleet.length,
      `${old.length}/${fleet.length} assets are 6+ years old; past a quarter ` +
      `the risk queue is mostly red before anything is scored, which reads as ` +
      `a model with one output rather than an ageing yard`
    ).toBeLessThanOrEqual(0.25);
  });

  it("keeps genuinely old assets, so HIGH means something", () => {
    // The opposite failure: a uniformly new fleet has no risk to show.
    const veryOld = fleet.filter(a => tierAge(a) >= 10);
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
    const worked = fleet.filter(a => tierAge(a) >= 10);
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
      const age = tierAge(a);
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
    // With the year computed correctly the loop below is vacuous unless the
    // fleet holds a sub-one-year asset, so state the reason the rule cannot
    // fire rather than leaving it to a skipped branch.
    const young = fleet.filter(a => a.ageYears < 1);
    expect(young, "the fleet is entirely a year old or more, so cold-start " +
      "cannot trigger; if that changes, the loop below is what guards it")
      .toHaveLength(0);

    for (const a of fleet) {
      const purchase = new Date(`${assetYear(a)}-06-15`);
      const ageYears = (cursor.getTime() - purchase.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears >= 1) continue;
      const hoursAtCursor = a.hours + minAdded(a);
      expect(
        hoursAtCursor,
        `${a.code} is ${ageYears.toFixed(2)}y old at the cursor, so it needs ` +
        `500+ lifetime hours to be scored by the model`
      ).toBeGreaterThan(500);
    }
  });

  it("owns nothing it has not bought yet", () => {
    for (const a of fleet) {
      expect(new Date(`${assetYear(a)}-06-15`).getTime(), `${a.code} is future-dated`)
        .toBeLessThan(cursor.getTime());
    }
  });

  it("gives older assets more hours than new ones", () => {
    // Not a strict ordering -- a compressor outworks a crane -- but the oldest
    // asset outrunning the newest is the minimum for the fleet to read as real.
    const byAge = [...fleet].sort((a, b) => tierAge(b) - tierAge(a));
    expect(byAge[0].hours).toBeGreaterThan(byAge[byAge.length - 1].hours);
  });

  it("builds the serial from the same year as the purchase date", () => {
    // Serials embed the model year, and they used to be written out by hand
    // beside it -- so changing one and not the other left a 2024 machine
    // stamped 2022, which is the first thing a reviewer from this industry
    // notices. Both are now derived from one computed year, so they cannot
    // disagree; this holds that derivation in place.
    const seedFn = SOURCE.match(/async function seedEquipment[\s\S]*?\n}/)![0];

    expect(seedFn).toMatch(/const year = cursorDate\.getFullYear\(\) - e\.ageYears/);
    expect(seedFn).toMatch(/const serial = `\$\{e\.serialPrefix\}-\$\{year\}-\$\{e\.serialSuffix\}`/);
    expect(seedFn).toMatch(/const purchaseDate = `\$\{year\}-06-15`/);
    // And nothing writes a literal four-digit year into a serial any more.
    expect(seedFn).not.toMatch(/serial:\s*"[^"]*-\d{4}-/);
  });

  it("has unique codes and serial stamps", () => {
    // The prefix is no longer unique by itself, and should not be: a yard runs
    // several units of one model, which is the whole reason a serial carries a
    // suffix. What has to be unique is the stamp -- prefix, computed year,
    // suffix -- because two assets sharing prefix and suffix are stamped
    // identically in every year they share.
    expect(new Set(fleet.map(a => a.code)).size).toBe(fleet.length);
    expect(
      new Set(fleet.map(a => `${a.serialPrefix}-${a.serialSuffix}`)).size,
      "two assets would carry the same serial stamp"
    ).toBe(fleet.length);
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
    // The loop itself now lives in services/ml-wake.ts, shared with the
    // request path, so this asserts where the bound actually is rather than
    // where it used to be. The seed still chooses its own probe length: it can
    // afford to wait out a full cold start and a button press cannot.
    const WAKE = readFileSync(join(__dirname, "ml-wake.ts"), "utf-8");
    expect(WAKE).toMatch(/AbortController/);
    expect(WAKE).toMatch(/signal:\s*controller\.signal/);
    // Belt and braces: the signal only binds a client that honours it.
    expect(WAKE).toMatch(/Promise\.race/);

    const fn = ORCH.match(/async function waitForMlService[\s\S]*?\n}/)![0];
    expect(fn).toMatch(/ML_WAKE_PROBE_MS/);
    expect(fn).toMatch(/waitForMl\(/);
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

describe("every fleet category has a maintenance interval", () => {
  // maintenance_config is keyed by category, not by asset, so a category with
  // no row silently falls back to a default. Six of the ten assets -- both
  // cranes, the grader, hauler, compressor and compactor -- had no row, so a
  // tower crane was scheduled on the same interval as a walk-behind roller,
  // and maint_overdue and neglect_acceleration were computed from a number
  // nobody chose. "Dozer" was configured for a category the fleet does not
  // contain.
  const CONFIG = readFileSync(join(__dirname, "..", "seeds", "maintenance-config.ts"), "utf-8");

  const configured = new Set(
    Array.from(CONFIG.matchAll(/equipmentCategory:\s*"([^"]+)"/g)).map(m => m[1])
  );

  it("parsed both lists", () => {
    expect(configured.size).toBeGreaterThan(5);
    expect(fleet.length).toBe(60);
  });

  it("covers every category the fleet actually contains", () => {
    const missing = fleet
      .map(a => a.category)
      .filter(c => !configured.has(c));
    expect(
      Array.from(new Set(missing)),
      "these categories have no maintenance_config row and will fall back to " +
      "the default interval, which is nobody's considered answer for them"
    ).toEqual([]);
  });

  it("shares one default between the services that need it", () => {
    // Feature engineering assumed 90 days and risk scoring 180, so one asset
    // could be overdue to one service and current to the other.
    expect(CONFIG).toMatch(/export const DEFAULT_MAINTENANCE_INTERVAL_DAYS/);
    for (const rel of [
      join("..", "services", "feature-engineering-enhanced.ts"),
      join("..", "services", "risk-scoring.ts"),
    ]) {
      const src = readFileSync(join(__dirname, rel), "utf-8");
      expect(src, `${rel} should use the shared default`)
        .toMatch(/DEFAULT_MAINTENANCE_INTERVAL_DAYS/);
    }
  });
});

describe("the fleet works its machines at different rates", () => {
  it("has at least two lightly-used units", () => {
    // The yard used to work every machine identically -- same idle rate, same
    // hours when running -- so a standby generator accumulated as fast as a
    // tower crane and every asset converged on one duty cycle. The result was
    // a queue with no LOW row in it.
    const light = fleet.filter(a => a.duty <= 0.5);
    expect(
      light.map(a => `${a.code} (duty ${a.duty})`),
      "every machine is worked at the same rate, which is what produced a " +
      "fleet with no low-risk assets"
    ).not.toHaveLength(0);
    expect(light.length).toBeGreaterThanOrEqual(2);
  });

  it("makes the lightly-used ones the newer ones", () => {
    // A 13-year-old machine that has barely run is a different story -- it
    // reads as neglected, not healthy -- and is not what a low-risk row
    // should look like.
    const light = fleet.filter(a => a.duty <= 0.5);
    const heavyAges = fleet.filter(a => a.duty > 0.5).map(a => a.ageYears);
    for (const a of light) {
      expect(a.ageYears, `${a.code} is lightly used but old`).toBeLessThanOrEqual(
        Math.min(...heavyAges) + 1
      );
    }
  });

  it("leaves most of the fleet in steady use", () => {
    // If everything were lightly used there would be no HIGH rows either.
    expect(fleet.filter(a => a.duty > 0.5).length).toBeGreaterThanOrEqual(6);
  });

  it("gives the lightly-used units a visibly lower duty cycle", () => {
    const light = fleet.filter(a => a.duty <= 0.5);
    const heavy = fleet.filter(a => a.duty > 0.5);
    const worstLight = Math.max(...light.map(projectedWearRate));
    const bestHeavy  = Math.min(...heavy.map(projectedWearRate));
    expect(worstLight).toBeLessThan(bestHeavy);
  });
});

/** Snapshot spacing and labelling lag, read from the seeder. */
const SNAPSHOT_INTERVAL = Number(
  SOURCE.match(/const SNAPSHOT_INTERVAL_DAYS = (\d+)/)?.[1] ?? 0
);
const LABEL_LAG = Number(
  SOURCE.match(/const LABELABLE_LAG_DAYS = (\d+)/)?.[1] ?? 0
);

describe("the labelled training set the history produces", () => {
  const interval = SNAPSHOT_INTERVAL;
  const lag = LABEL_LAG;

  it("reads the three constants it reasons about", () => {
    expect(HISTORY_DAYS).toBeGreaterThan(0);
    expect(interval).toBeGreaterThan(0);
    expect(lag).toBeGreaterThan(0);
  });

  it("leaves a labelling window at all", () => {
    // A snapshot cannot be labelled until its longest horizon has elapsed, so
    // history shorter than the lag produces a training set of zero rows and a
    // seed that completes successfully having taught the model nothing.
    expect(
      HISTORY_DAYS - lag,
      "history is shorter than the labelling lag: no snapshot can be labelled"
    ).toBeGreaterThan(0);
  });

  it("produces enough labelled dates to dilute the failures", () => {
    // Four dates and 40 rows gave a 27.5% base rate, which put the model's
    // calibrated floor above the LOW threshold and left the queue with no
    // low-risk row. The fix is span, not fewer failures -- there were only
    // eleven positives to begin with.
    const dates = Math.floor((HISTORY_DAYS - lag - interval) / interval) + 1;
    expect(
      dates * fleet.length,
      `${dates} labelled snapshot dates is too few to move the base rate`
    ).toBeGreaterThanOrEqual(120);
  });

  it("does not space snapshots so tightly they are near-duplicates", () => {
    // The data-quality gate counts duplicate snapshots against the training
    // set, and consecutive snapshots of one asset barely differ.
    expect(interval).toBeGreaterThanOrEqual(5);
  });
});

describe("the fleet clears the floors the ML service actually enforces", () => {
  // This is what growing the yard to sixty was for, so it is asserted against
  // the Python the service runs rather than against numbers copied into a
  // comment here. Copied numbers are how the fleet came to sit just under
  // three separate floors without anything failing: each gate returned a
  // polite "skipped", the dashboard rendered the skip, and the pipeline
  // reported success having measured nothing.
  const ENGINE = join(__dirname, "..", "..", "ml-service", "engine");
  const DRIFT = readFileSync(join(ENGINE, "drift_detector.py"), "utf-8");
  const QUALITY = readFileSync(join(ENGINE, "data_quality.py"), "utf-8");

  const minBatch = Number(DRIFT.match(/^MIN_BATCH_SIZE\s*=\s*(\d+)/m)?.[1] ?? 0);
  const minRows = Number(QUALITY.match(/^MIN_ROWS\s*=\s*(\d+)/m)?.[1] ?? 0);
  // The per-category floor is inline in check_bias_drift, not a named
  // constant: `if len(items) < 3:  # too few to be meaningful`.
  const minPerCategory = Number(
    DRIFT.match(/if len\(items\) < (\d+):/)?.[1] ?? 0
  );

  const labelledDates =
    Math.floor((HISTORY_DAYS - LABEL_LAG - SNAPSHOT_INTERVAL) / SNAPSHOT_INTERVAL) + 1;

  it("read all three floors out of the service", () => {
    // Without this the three assertions below would pass against zero.
    expect(minBatch, "MIN_BATCH_SIZE").toBeGreaterThan(0);
    expect(minRows, "MIN_ROWS").toBeGreaterThan(0);
    expect(minPerCategory, "the inline per-category floor").toBeGreaterThan(0);
  });

  it("scores enough assets in one batch for a PSI", () => {
    // One snapshot per asset per scoring run, so the batch is the fleet.
    expect(
      fleet.length,
      `a scoring run submits ${fleet.length} rows; under ${minBatch} every ` +
      `drift layer returns "batch too small" and the dashboard shows nothing`
    ).toBeGreaterThanOrEqual(minBatch);
  });

  it("puts enough units in every category for a bias reading", () => {
    const counts = new Map<string, number>();
    for (const a of fleet) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    const thin = [...counts.entries()].filter(([, n]) => n < minPerCategory);
    expect(
      thin.map(([c, n]) => `${c} (${n})`),
      `every category needs ${minPerCategory}+ units or check_bias_drift ` +
      `silently drops it, and a fleet of one-offs produces an empty reading`
    ).toEqual([]);
  });

  it("labels enough rows to get past the training gate", () => {
    // Clearing this one is not an unmixed win: the row count was what refused
    // training cheaply, and above it the run proceeds until it runs out of
    // memory on a 512MB instance instead. Asserted anyway, because the gate
    // being cleared is a fact about the fleet and the seeder's comments and
    // the README both now depend on it.
    expect(
      labelledDates * fleet.length,
      `${labelledDates} labelled dates x ${fleet.length} assets is under ` +
      `MIN_ROWS ${minRows}, so training is refused on row count`
    ).toBeGreaterThanOrEqual(minRows);
  });
});
