// server/services/seed-orchestrator.ts
//
// Orchestrates the full system seed pipeline:
//   1.  Job sites
//   2.  Vendors
//   3.  Equipment + maintenance config
//   4.  Rentals
//   5.  Historical sensor data (90 days)
//   6.  Feature snapshots (backfill)
//   7.  Label snapshots
//   8.  Train model (polls ML service until complete)
//   9.  Batch predictions
//   10. Drift reference
//
// Progress is tracked in-memory and polled by the client.
// Reset wipes all tables (except users) and resets the simulation cursor.

import { db } from "../db";
import { sql, eq } from "drizzle-orm";
import { equipment } from "../../shared/schema";
import { seedJobSites } from "../seeds/job-sites";
import { seedVendors } from "../seeds/vendors";
import { seedRentals } from "../seeds/rentals";
import { seedMaintenanceConfig } from "../seeds/maintenance-config";
import { featureEngineeringService } from "./feature-engineering";
import { predictiveMaintenanceService } from "./predictive-maintenance-fixed";
import { mlFetch, describeMlFailure } from "./ml-client";
import { registerChampionMetrics } from "./champion-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// SEED CURSOR DATE — the "today" date used for all seeded data
// ─────────────────────────────────────────────────────────────────────────────
const SEED_CURSOR = "2026-04-01";

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESS TRACKING
// ─────────────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface SeedStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface SeedJobState {
  status: "idle" | "running" | "completed" | "failed";
  steps: SeedStep[];
  error?: string;
  /**
   * Steps that were skipped without failing the run.
   *
   * The three ML steps depend on a service that suspends when idle, so on free
   * hosting they fail as a matter of course. A binary completed/failed status
   * had to either throw away a full data load over a cold start, or report
   * "Demo Data Loaded" and a trained model when neither prediction nor training
   * had happened. These say which it was.
   */
  warnings: string[];
  startedAt?: string;
  completedAt?: string;
}

const STEP_NAMES = [
  "Job sites",
  "Vendors",
  "Equipment & maintenance config",
  "Rentals",
  "Historical sensor data & failure events",
  "Feature snapshots (backfill)",
  "Label snapshots",
  "Train model",
  "Batch predictions",
  "Drift reference baseline",
];

let jobState: SeedJobState = {
  status: "idle",
  steps: STEP_NAMES.map(name => ({ name, status: "pending" })),
  warnings: [],
};

export function getSeedStatus(): SeedJobState {
  return jobState;
}

function resetJobState() {
  jobState = {
    status: "idle",
    steps: STEP_NAMES.map(name => ({ name, status: "pending" })),
    warnings: [],
  };
}

function setStep(index: number, status: StepStatus, detail?: string) {
  jobState.steps[index] = { ...jobState.steps[index], status, detail };
}

/** Record a step that was skipped but did not sink the run. */
function addWarning(message: string) {
  jobState.warnings.push(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM STATUS — used to detect whether system needs seeding
// ─────────────────────────────────────────────────────────────────────────────

export async function getSystemStatus() {
  const [eqRows]   = await db.execute(sql`SELECT COUNT(*) as cnt FROM equipment`) as any;
  const [snapRows] = await db.execute(sql`SELECT COUNT(*) as cnt FROM asset_feature_snapshots`) as any;
  const [modelRows]= await db.execute(sql`SELECT COUNT(*) as cnt FROM model_training_metrics`) as any;
  const [predRows] = await db.execute(sql`SELECT COUNT(*) as cnt FROM asset_risk_predictions`) as any;
  const [stateRows]= await db.execute(sql`SELECT cursor_date FROM simulation_state WHERE id = 1`) as any;

  const equipmentCount  = Number(eqRows[0]?.cnt   ?? 0);
  const snapshotCount   = Number(snapRows[0]?.cnt  ?? 0);
  const modelTrained    = Number(modelRows[0]?.cnt ?? 0) > 0;
  const predictionCount = Number(predRows[0]?.cnt  ?? 0);
  const cursorDate      = stateRows[0]?.cursor_date ?? null;

  return {
    isSeeded: equipmentCount > 0,
    isFullyInitialized: equipmentCount > 0 && snapshotCount > 0 && modelTrained,
    equipmentCount,
    snapshotCount,
    modelTrained,
    predictionCount,
    cursorDate,
    seedJob: jobState,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

export async function startSeedJob(): Promise<{ started: boolean; message: string }> {
  if (jobState.status === "running") {
    return { started: false, message: "Seed already running" };
  }

  resetJobState();
  jobState.status = "running";
  jobState.startedAt = new Date().toISOString();

  // Run async — don't await
  runSeedPipeline().catch(err => {
    jobState.status = "failed";
    jobState.error = err?.message ?? "Unknown error";
  });

  return { started: true, message: "Seed pipeline started" };
}

/**
 * What a scoring pass means, as a value rather than a chain of ifs.
 *
 * The chain this replaces had a hole: a service that failed its health check
 * comes back as { predictions: [], attempted: 0 }, and `attempted > 0 &&
 * predictions.length === 0` is false when attempted is 0, as is
 * `predictions.length < attempted`. So it fell through to the success branch
 * and reported "0 predictions generated" as completed, with a green check and
 * no warning -- the exact failure the branch above it was written to stop, and
 * the reason a seed finished with an empty risk queue and said nothing.
 *
 * serviceAvailable existed to distinguish that case and was simply never read.
 * Pulling the decision out of the pipeline makes every combination something a
 * test can enumerate, which is the only reason this one was ever going to be
 * found.
 */
export function classifyScoringOutcome(outcome: {
  predictions: unknown[];
  attempted: number;
  serviceAvailable: boolean;
  firstError?: string;
}): { status: StepStatus; detail: string; warning?: string } {
  const scored = outcome.predictions.length;
  const retry = ' Use "Score Fleet" on the ML dashboard to retry.';

  if (!outcome.serviceAvailable) {
    return {
      status: "failed",
      detail: "Skipped — the ML service stopped responding",
      warning:
        "No assets were scored: the ML service stopped responding, so the " +
        "risk queue is empty." + retry,
    };
  }

  // Zero is never a success, whatever attempted says. Tying this to attempted
  // is what let a zero through.
  if (scored === 0) {
    const why = outcome.firstError ?? "no reason reported";
    return {
      status: "failed",
      detail: `Scored 0 of ${outcome.attempted} — ${why}`.slice(0, 300),
      warning: `No assets were scored (${why}), so the risk queue is empty.` + retry,
    };
  }

  if (scored < outcome.attempted) {
    return {
      status: "completed",
      detail: `${scored} of ${outcome.attempted} predictions generated`,
      warning:
        `${outcome.attempted - scored} of ${outcome.attempted} assets could not be scored` +
        (outcome.firstError ? ` (${outcome.firstError})` : "") + ".",
    };
  }

  return { status: "completed", detail: `${scored} predictions generated` };
}

async function runSeedPipeline() {
  const cursorDate = new Date(SEED_CURSOR);

  try {
    // ── Step 0: Job sites ──────────────────────────────────────────────────
    setStep(0, "running");
    const jobSiteIds = await seedJobSites();
    setStep(0, "completed", `${jobSiteIds.length} job sites`);

    // ── Step 1: Vendors ────────────────────────────────────────────────────
    setStep(1, "running");
    const vendorIds = await seedVendors();
    setStep(1, "completed", `${vendorIds.length} vendors`);

    // ── Step 2: Equipment + maintenance config ─────────────────────────────
    setStep(2, "running");
    await seedEquipment(cursorDate);
    await seedMaintenanceConfig();
    const allEquipment = await db.select({ id: equipment.id }).from(equipment);
    const equipmentIds = allEquipment.map(e => e.id);
    setStep(2, "completed", `${equipmentIds.length} equipment units`);

    // ── Step 3: Rentals ────────────────────────────────────────────────────
    setStep(3, "running");
    await seedRentals(equipmentIds, jobSiteIds, vendorIds, cursorDate);
    setStep(3, "completed", "15 historical rentals");

    // ── Step 4: Historical sensor data + failure events ────────────────────
    setStep(4, "running");
    const seedStart = new Date(cursorDate.getTime() - 90 * 24 * 3600 * 1000);
    const sensorCount = await seedSensorData(equipmentIds, cursorDate, 90);
    const failureCount = await seedFailureEvents(equipmentIds, seedStart, cursorDate);
    setStep(4, "completed", `${sensorCount} sensor readings, ${failureCount} failure events`);

    // ── Step 5: Feature snapshots (backfill weekly + current) ──────────────
    setStep(5, "running");
    // Backfill snapshots at weekly intervals from day 7 to day 29 after seedStart.
    // Only snapshots older than (cursor - 60d) can be fully labeled (all three horizons).
    // cursor - 60d = 2026-02-01; seedStart = 2026-01-01 → backfill 2026-01-08 to 2026-01-29.
    const labelableCutoff = new Date(cursorDate.getTime() - 61 * 24 * 3600 * 1000);
    let totalSnapshots = 0;
    let backfillDate = new Date(seedStart.getTime() + 7 * 24 * 3600 * 1000);
    while (backfillDate <= labelableCutoff) {
      const snaps = await featureEngineeringService.generateSnapshotsForAllEquipment(backfillDate);
      for (const snap of snaps) await featureEngineeringService.saveSnapshot(snap);
      totalSnapshots += snaps.length;
      backfillDate = new Date(backfillDate.getTime() + 7 * 24 * 3600 * 1000);
    }
    // Current-date snapshot (for live predictions — won't be labeled yet)
    const currentSnaps = await featureEngineeringService.generateSnapshotsForAllEquipment(cursorDate);
    for (const snap of currentSnaps) await featureEngineeringService.saveSnapshot(snap);
    totalSnapshots += currentSnaps.length;
    setStep(5, "completed", `${totalSnapshots} snapshots (${totalSnapshots - currentSnaps.length} backfill + ${currentSnaps.length} current)`);

    // ── Step 6: Label snapshots ────────────────────────────────────────────
    setStep(6, "running");
    const labeled = await featureEngineeringService.labelSnapshots();
    setStep(6, "completed", `${labeled} snapshots labeled`);

    // ── Step 7: Train model ────────────────────────────────────────────────
    // Not fatal. Training three 200-tree forests with SHAP loaded needs more
    // memory than a small instance has, so on free hosting this step fails by
    // design — and aborting here used to take predictions and the drift
    // baseline down with it, leaving a seeded fleet with an empty risk queue
    // and nothing to look at. The service ships a trained champion in its
    // image, so the steps below work regardless of whether this one does.
    setStep(7, "running", "Contacting ML service...");
    try {
      await trainAndPoll();
      setStep(7, "completed", "Model trained successfully");
    } catch (err: any) {
      const why = err?.message ?? String(err);
      console.warn("[SEED] training step failed; continuing with the model the ML service already has:", why);

      // Register the shipped champion's own evaluation instead. Without this
      // the ML dashboard shows a "train the model" checklist forever: it reads
      // model_metrics, only a training run writes that table, and training is
      // refused below 500 labeled rows while this seed produces 40. The model
      // itself is loaded and fully evaluated; only the paperwork was missing.
      let registered = "";
      try {
        const champion = await registerChampionMetrics();
        registered =
          ` Registered ${champion.version} (trained ` +
          `${champion.trainedAt.toISOString().slice(0, 10)}, ` +
          `${champion.datasetSize?.toLocaleString() ?? "?"} rows) so its metrics are visible.`;
        setStep(7, "failed", `Skipped — ${why} · registered ${champion.version}`.slice(0, 300));
      } catch (regErr: any) {
        console.warn("[SEED] could not register champion metrics:", regErr?.message ?? regErr);
        setStep(7, "failed", `Skipped — ${why}`.slice(0, 300));
      }

      addWarning(
        `The model was not retrained (${why}) — the fleet is scored with the ` +
        `champion model shipped in the ML service image.${registered}`
      );
    }

    // ── Step 8: Batch predictions ──────────────────────────────────────────
    // Also not fatal, but it is the step that fills the risk queue, so a
    // failure here is the difference between a demo and an empty table. It
    // used to report "0 predictions generated" as completed, with a green
    // check, whenever the ML service was asleep.
    setStep(8, "running", "Waking the ML service…");
    if (!(await waitForMlService(8, ML_WAKE_TIMEOUT_MS))) {
      setStep(8, "failed", `Skipped — ${ML_ASLEEP}`);
      addWarning(`No assets were scored: ${ML_ASLEEP} Use "Score Fleet" on the ML dashboard to retry.`);
    } else {
      setStep(8, "running", "Scoring fleet…");
      let outcome = await predictiveMaintenanceService.predictAllEquipmentWithOutcome();

      // Training runs a subprocess in the same 512MB instance and can take the
      // container down with it -- a run that reports "exit code 1" may leave
      // the service restarting, so the health check a moment later fails even
      // though the service was up when training began. One re-wake and retry,
      // rather than declaring the risk queue empty over a restart we caused.
      if (!outcome.serviceAvailable) {
        setStep(8, "running", "ML service restarted after training; waiting…");
        if (await waitForMlService(8, ML_WAKE_TIMEOUT_MS)) {
          setStep(8, "running", "Scoring fleet…");
          outcome = await predictiveMaintenanceService.predictAllEquipmentWithOutcome();
        }
      }

      const verdict = classifyScoringOutcome(outcome);
      setStep(8, verdict.status, verdict.detail);
      if (verdict.warning) addWarning(verdict.warning);
    }

    // ── Step 9: Drift reference ────────────────────────────────────────────
    // A monitoring baseline. Nothing in the fleet views depends on it, and it
    // is recomputable from the dashboard, so it does not get to fail a run
    // that has already loaded the data.
    setStep(9, "running");
    try {
      await bootstrapDriftReference();
      setStep(9, "completed", "Drift baseline established");
    } catch (err: any) {
      const why = err?.message ?? String(err);
      console.warn("[SEED] drift reference failed; the rest of the seed stands:", why);
      setStep(9, "failed", `Skipped — ${why}`.slice(0, 300));
      addWarning(
        `No drift baseline was computed (${why}) — the Feature Drift Monitor ` +
        `will be empty until you use "Reset Baseline" on the ML dashboard.`
      );
    }

    // ── Finalize cursor ────────────────────────────────────────────────────
    await db.execute(sql`
      INSERT INTO simulation_state (id, cursor_date, total_days_run)
      VALUES (1, ${SEED_CURSOR}, 90)
      ON DUPLICATE KEY UPDATE cursor_date = ${SEED_CURSOR}, total_days_run = 90
    `);

    jobState.status = "completed";
    jobState.completedAt = new Date().toISOString();

  } catch (err: any) {
    // Mark the currently-running step as failed
    const runningIdx = jobState.steps.findIndex(s => s.status === "running");
    if (runningIdx >= 0) setStep(runningIdx, "failed", err?.message ?? "Error");
    jobState.status = "failed";
    jobState.error = err?.message ?? "Seed pipeline failed";
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT SEED — inserts base fleet with realistic purchase dates + hours
// ─────────────────────────────────────────────────────────────────────────────

async function seedEquipment(cursorDate: Date) {
  // Fleet composition is a demo-design choice, and it decides the risk mix.
  //
  // seedFailureEvents injects reactive repairs by age: 3-5 for 10+ years, 1-3
  // for 6-9, 0-1 for 2-5, none below that. Every asset at or above six years
  // therefore scores HIGH (measured: 0.657-0.692), and the previous fleet had
  // seven of them -- a ten-asset yard where everything was red, which reads as
  // a model with one output rather than an old fleet.
  //
  // The shape below is how rental yards actually age: cranes and graders are
  // long-lived capital that stays in service past a decade, while skid steers,
  // rollers, haulers and gensets turn over every few years. That gives three
  // genuinely old assets, a middle group, and new units -- without touching
  // the hazard model to flatter the numbers.
  //
  // Hours are starting values; the 90-day sensor seed adds roughly 535 (most
  // categories), 690 (hauler/loader), 1,150 (compressor) or 1,300 (generator)
  // on top. Nothing is left under a year old with fewer than 500 lifetime
  // hours, which would trip the cold-start rule in services/imputation.ts and
  // be scored by rule instead of by the model.
  //
  // Age alone does not produce a low-risk asset, and assuming it did cost a
  // round trip. The dominant feature is wear rate --
  // totalHoursLifetime / (assetAgeYears * 8760) -- which is duty cycle, the
  // share of wall-clock time a machine has been running, and it is the top
  // driver on every row. A nearly-new unit with few hours still has a high
  // duty cycle, because those hours are divided by a very short life: at nine
  // months and 878 hours an asset scored 0.127, above the 13-year crane's
  // 0.092, and landed MEDIUM.
  //
  // Measured anchor: wear 0.047 scored 0.295, which is LOW. EQ-006 and EQ-009
  // are sized to land near that -- around three years old and ~1,100 hours --
  // so the fleet has genuinely lightly-used assets rather than merely young
  // ones.
  const fleet = [
    { equipmentId: "EQ-001", name: "Liebherr Tower Crane",         category: "Crane",      make: "Liebherr",    model: "81K.1",    serial: "LH-81K-2013-0042",     status: "AVAILABLE", daily: "850.00",  weekly: "5200.00",  monthly: "18000.00", year: 2013, hours: 9800 },
    { equipmentId: "EQ-002", name: "Caterpillar Motor Grader",      category: "Grader",     make: "Caterpillar", model: "140M3",    serial: "CAT-140M3-2014-0091",   status: "AVAILABLE", daily: "620.00",  weekly: "3800.00",  monthly: "13500.00", year: 2014, hours: 8200 },
    { equipmentId: "EQ-003", name: "JLG Telescopic Boom Lift",      category: "Lift",       make: "JLG",         model: "1350SJ",   serial: "JLG-1350SJ-2022-0067",  status: "AVAILABLE", daily: "480.00",  weekly: "2900.00",  monthly: "10200.00", year: 2022, hours: 2400 },
    { equipmentId: "EQ-004", name: "Komatsu Hydraulic Excavator",   category: "Excavator",  make: "Komatsu",     model: "PC210",    serial: "KOM-PC210-2021-0234",   status: "AVAILABLE", daily: "550.00",  weekly: "3300.00",  monthly: "11800.00", year: 2021, hours: 3100 },
    { equipmentId: "EQ-005", name: "Manitowoc Crawler Crane",       category: "Crane",      make: "Manitowoc",   model: "222",      serial: "MAN-222-2016-0088",     status: "AVAILABLE", daily: "920.00",  weekly: "5600.00",  monthly: "19500.00", year: 2016, hours: 6800 },
    { equipmentId: "EQ-006", name: "Volvo Articulated Hauler",      category: "Hauler",     make: "Volvo",       model: "A40G",     serial: "VOL-A40G-2023-0156",    status: "AVAILABLE", daily: "430.00",  weekly: "2600.00",  monthly: "9200.00",  year: 2023, hours: 410  },
    { equipmentId: "EQ-007", name: "Atlas Copco Air Compressor",    category: "Compressor", make: "Atlas Copco", model: "XATS 400", serial: "AC-XATS400-2022-0321",  status: "AVAILABLE", daily: "220.00",  weekly: "1350.00",  monthly: "4800.00",  year: 2022, hours: 1700 },
    { equipmentId: "EQ-008", name: "Bobcat Skid Steer Loader",      category: "Loader",     make: "Bobcat",      model: "S650",     serial: "BOB-S650-2024-0512",    status: "AVAILABLE", daily: "280.00",  weekly: "1700.00",  monthly: "6000.00",  year: 2024, hours: 400  },
    { equipmentId: "EQ-009", name: "Wacker Neuson Vibratory Roller",category: "Compactor",  make: "Wacker Neuson",model: "RD27",    serial: "WN-RD27-2023-0789",     status: "AVAILABLE", daily: "190.00",  weekly: "1150.00",  monthly: "4100.00",  year: 2023, hours: 560  },
    { equipmentId: "EQ-010", name: "Generac Industrial Generator",  category: "Generator",  make: "Generac",     model: "XG10000E", serial: "GEN-XG10K-2024-0633",  status: "AVAILABLE", daily: "160.00",  weekly: "980.00",   monthly: "3500.00",  year: 2024, hours: 200  },
  ];

  for (const e of fleet) {
    const purchaseDate = `${e.year}-06-15`;
    try {
      await db.execute(sql`
        INSERT INTO equipment
          (equipment_id, name, category, make, model, serial_number, status,
           daily_rate, weekly_rate, monthly_rate, year_manufactured, purchase_date, current_mileage, initial_mileage)
        VALUES
          (${e.equipmentId}, ${e.name}, ${e.category}, ${e.make}, ${e.model}, ${e.serial}, ${e.status},
           ${e.daily}, ${e.weekly}, ${e.monthly}, ${e.year}, ${purchaseDate}, ${e.hours}, 0)
      `);

      // Seed maintenance history
      const [eqRow] = await db.execute(sql`SELECT id FROM equipment WHERE equipment_id = ${e.equipmentId}`) as any;
      const eqId = eqRow[0]?.id;
      if (!eqId) continue;

      const cursorStr = cursorDate.toISOString().split("T")[0];
      const lastMaint = new Date(cursorDate.getTime() - (e.hours > 5000 ? 120 : 60) * 24 * 3600 * 1000)
        .toISOString().split("T")[0];
      const nextDue   = new Date(cursorDate.getTime() + 60 * 24 * 3600 * 1000)
        .toISOString().split("T")[0];

      await db.execute(sql`
        INSERT INTO maintenance_events
          (equipment_id, maintenance_date, maintenance_type, event_source, cost, description, next_due_date)
        VALUES
          (${eqId}, ${lastMaint}, 'INSPECTION', 'SCHEDULED_PM', 150.00,
           ${'Pre-seed inspection — ' + e.category}, ${nextDue})
      `);
    } catch {
      // Already exists — skip
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSOR DATA — inserts daily readings for the past N days
// ─────────────────────────────────────────────────────────────────────────────

async function seedSensorData(
  equipmentIds: number[],
  cursorDate: Date,
  days: number,
): Promise<number> {
  const dailyHoursByCategory: Record<string, [number, number]> = {
    Compressor: [10, 20], Generator: [12, 22], Hauler: [7, 11], Loader: [7, 11],
  };

  let count = 0;
  for (let d = days; d >= 1; d--) {
    const date = new Date(cursorDate.getTime() - d * 24 * 3600 * 1000);
    const dateStr = date.toISOString().split("T")[0];

    for (const eqId of equipmentIds) {
      const isIdle     = Math.random() < 0.15;
      const isStressed = Math.random() < 0.08;

      // Get category for this equipment
      const [catRow] = await db.execute(sql`SELECT category FROM equipment WHERE id = ${eqId}`) as any;
      const category = catRow[0]?.category ?? "Excavator";
      const [min, max] = dailyHoursByCategory[category] ?? [5, 9];
      const operatingHours = isIdle ? 0 : parseFloat((min + Math.random() * (max - min)).toFixed(2));

      try {
        await db.execute(sql`
          INSERT IGNORE INTO sensor_data_logs
            (equipment_id, timestamp, engine_rpm, engine_temp, oil_pressure, coolant_temp,
             fuel_consumption, hydraulic_pressure, hydraulic_temp, hydraulic_flow_rate,
             vibration_x, vibration_y, vibration_z, operating_hours, load_percentage,
             idle_time, ambient_temp, warning_count)
          VALUES (
            ${eqId}, ${dateStr},
            ${isIdle ? 0 : Math.round(1200 + Math.random() * 800 + (isStressed ? 600 : 0))},
            ${isIdle ? 20 : Math.round(80 + Math.random() * 15 + (isStressed ? 25 : 0))},
            ${isIdle ? 0 : Math.round(35 + Math.random() * 15 - (isStressed ? 8 : 0))},
            ${isIdle ? 20 : Math.round(85 + Math.random() * 10 + (isStressed ? 15 : 0))},
            ${isIdle ? 0 : parseFloat((8 + Math.random() * 12).toFixed(2))},
            ${isIdle ? 0 : Math.round(2000 + Math.random() * 500)},
            ${isIdle ? 20 : Math.round(45 + Math.random() * 20)},
            ${isIdle ? 0 : Math.round(1600 + Math.random() * 400)},
            ${parseFloat((0.1 + Math.random() * 0.8 + (isStressed ? 1.2 : 0)).toFixed(3))},
            ${parseFloat((0.1 + Math.random() * 0.8 + (isStressed ? 1.0 : 0)).toFixed(3))},
            ${parseFloat((0.1 + Math.random() * 0.6 + (isStressed ? 0.8 : 0)).toFixed(3))},
            ${operatingHours},
            ${isIdle ? 0 : Math.round(30 + Math.random() * 60 + (isStressed ? 20 : 0))},
            ${parseFloat((Math.random() * 2).toFixed(2))},
            ${Math.round(10 + Math.random() * 25)},
            ${isStressed ? Math.floor(Math.random() * 3) : 0}
          )
        `);
        count++;

        if (operatingHours > 0) {
          await db.execute(sql`
            UPDATE equipment SET current_mileage = current_mileage + ${operatingHours} WHERE id = ${eqId}
          `);
        }
      } catch {
        // IGNORE duplicate timestamp
      }
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE EVENT SEED — injects REACTIVE_REPAIR / MAJOR_SERVICE events so the
// labeling step finds positives and training data has a realistic failure rate.
//
// Approach: age-weighted failure count per equipment over the seeding window.
// Failures are deliberately spread across the window (not clustered) so that
// backfilled snapshots at different dates get diverse label distributions.
//
// Target positive rates (30d horizon):
//   Age 10+ years  → 3-5 failures in 90d  → ~20-35% of snapshots labeled positive
//   Age 5-10 years → 1-3 failures in 90d  → ~10-20%
//   Age 2-5 years  → 0-1 failures in 90d  → ~0-10%
//   Age < 2 years  → 0 failures            → 0%
// ─────────────────────────────────────────────────────────────────────────────

async function seedFailureEvents(
  equipmentIds: number[],
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const windowDays = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000));
  const cursorYear = endDate.getFullYear();

  const [rows] = await db.execute(sql`
    SELECT id, year_manufactured FROM equipment
    WHERE id IN (${sql.join(equipmentIds.map(id => sql`${id}`), sql`, `)})
  `) as any;

  let inserted = 0;

  for (const row of rows) {
    const ageYears = cursorYear - (Number(row.year_manufactured) || 2020);

    // Determine failure count for this equipment
    let targetFailures: number;
    if      (ageYears >= 10) targetFailures = 3 + Math.floor(Math.random() * 3); // 3-5
    else if (ageYears >=  6) targetFailures = 1 + Math.floor(Math.random() * 3); // 1-3
    else if (ageYears >=  2) targetFailures = Math.floor(Math.random() * 2);     // 0-1
    else                     targetFailures = 0;

    // Spread failures evenly across the window to avoid temporal clustering.
    // Slice the window into equal segments and place one failure per segment.
    const segmentSize = windowDays / Math.max(targetFailures, 1);

    for (let f = 0; f < targetFailures; f++) {
      const segStart   = Math.floor(f * segmentSize);
      const segEnd     = Math.floor((f + 1) * segmentSize);
      const dayOffset  = segStart + Math.floor(Math.random() * (segEnd - segStart));
      const failDate   = new Date(startDate.getTime() + Math.max(1, dayOffset) * 24 * 3600 * 1000);
      const failStr    = failDate.toISOString().split("T")[0];
      const nextDueStr = new Date(failDate.getTime() + 180 * 24 * 3600 * 1000).toISOString().split("T")[0];
      const cost       = (800 + Math.random() * 1200).toFixed(2);

      try {
        await db.execute(sql`
          INSERT INTO maintenance_events
            (equipment_id, maintenance_date, maintenance_type, cost, description, next_due_date, event_source)
          VALUES (
            ${row.id}, ${failStr}, 'MAJOR_SERVICE', ${cost},
            ${"Seeded failure event — age-based hazard (training data)"},
            ${nextDueStr}, 'REACTIVE_REPAIR'
          )
        `);
        inserted++;
      } catch {
        // Duplicate date — skip
      }
    }
  }

  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAIN + POLL — triggers training, polls status until complete or timeout
// ─────────────────────────────────────────────────────────────────────────────

// Training on the seeded dataset typically takes ~2-4 minutes; allow headroom.
/**
 * Wait for the ML service to answer /health.
 *
 * A host that suspends an idle container answers the first request with a
 * gateway error while it starts, so POSTing straight to /train returns 502
 * and reads like a failure rather than a cold start. /health is exempt from
 * the service token and touches nothing, so it is the cheapest way to find
 * out whether anyone is home.
 */
async function waitForMlService(stepIndex: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    // Each probe is bounded. Without this the call inherits fetch's lack of a
    // timeout, and a suspended container does not refuse the connection -- the
    // host holds it open for the whole cold start, measured at 51-62s. One
    // such attempt consumed almost the entire budget, so the loop got one try
    // rather than the dozen it looks like it takes.
    const controller = new AbortController();
    const probe = setTimeout(() => controller.abort(), ML_WAKE_PROBE_MS);
    try {
      const res = await mlFetch("/health", { signal: controller.signal });
      if (res.ok) return true;
    } catch {
      // not up yet; the container keeps booting whether or not we wait on it
    } finally {
      clearTimeout(probe);
    }
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    setStep(stepIndex, "running", `Waking the ML service… (attempt ${attempt}, ${left}s left)`);
    await sleep(5000);
  }
  return false;
}

// How long to keep trying to wake the ML service, and how long any single
// health probe may take.
//
// Deliberately NOT ML_HEALTH_TIMEOUT_MS: that one is a per-request timeout in
// services/predictive-maintenance-fixed.ts, and reusing it here gave one name
// two meanings. Raising it to cover a cold start silently lengthened every
// health check; lowering it to tighten those silently shortened the wake
// budget to the point of uselessness.
//
// The default is generous because the failure it prevents is expensive: a seed
// that loads every table and then has nothing to show in the risk queue.
const ML_WAKE_TIMEOUT_MS = Number(process.env.ML_WAKE_TIMEOUT_MS ?? 300_000);
const ML_WAKE_PROBE_MS = Number(process.env.ML_WAKE_PROBE_MS ?? 20_000);

/** The message for a service that never answered, written once. */
const ML_ASLEEP =
  "ML service did not come up in time. On free hosting it suspends when " +
  "idle; open its /health URL once and retry.";

async function trainAndPoll(timeoutMs = 420_000): Promise<void> {
  // Give a suspended instance a chance to start before judging it.
  if (!(await waitForMlService(7, ML_WAKE_TIMEOUT_MS))) throw new Error(ML_ASLEEP);

  const trainRes = await mlFetch("/train", { method: "POST" }, { actorId: "seed" });
  if (!trainRes.ok) {
    // Not the raw body: a misdirected request returns an HTML page, and
    // interpolating it put an entire web page into the seeding dialog.
    throw new Error(`ML service train failed — ${await describeMlFailure(trainRes, "/train")}`);
  }

  // /train/status returns { running: boolean, log: string[], last_result: { success, ... } | null }
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(4000);
    polls++;
    try {
      const statusRes = await mlFetch("/train/status");
      if (statusRes.ok) {
        const status = await statusRes.json() as any;
        const lastLog: string = status.log?.[status.log.length - 1] ?? "";
        setStep(7, "running", `Training… ${lastLog}`.slice(0, 200));
        if (status.running) {
          sawRunning = true;
          continue;
        }
        // Not running: either finished (last_result set) or hasn't started yet.
        // Require sawRunning or ≥2 polls so a stale last_result from a previous
        // run isn't mistaken for this run's outcome before the job starts.
        if (status.last_result && (sawRunning || polls >= 2)) {
          if (status.last_result.success) return;
          throw new Error(
            "ML training failed: " + (status.last_result.error ?? `exit code ${status.last_result.return_code}`)
          );
        }
        if (sawRunning) {
          // Ran and stopped without a result — treat as failure
          throw new Error("ML training stopped without reporting a result");
        }
        // Job not picked up yet — keep polling
      }
    } catch (e: any) {
      if (e.message.includes("ML training")) throw e;
      // Network hiccup — keep polling
    }
  }
  throw new Error(`ML training timed out after ${Math.round(timeoutMs / 60000)} minutes`);
}

async function bootstrapDriftReference(): Promise<void> {
  // Wake first, for the same reason training does: the request that follows a
  // suspension gets a gateway error from the host, not from the service.
  if (!(await waitForMlService(9, ML_WAKE_TIMEOUT_MS))) throw new Error(ML_ASLEEP);

  const res = await mlFetch("/drift/compute-reference", { method: "POST" }, { actorId: "seed" });
  if (!res.ok) {
    // Not the raw body. This threw `${await res.text()}` until a sleeping
    // container answered with a full HTML 502 page, which was then rendered
    // into the seeding dialog -- fonts, stylesheet and all.
    throw new Error(
      `Drift reference failed — ${await describeMlFailure(res, "/drift/compute-reference")}`
    );
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// RESET — wipes all data except users, resets simulation cursor
// ─────────────────────────────────────────────────────────────────────────────

const TABLES_TO_CLEAR = [
  "asset_risk_predictions",
  "equipment_failure_predictions",
  "equipment_risk_scores",
  "model_training_metrics",
  "ml_models",
  "asset_feature_snapshots",
  "sensor_data_logs",
  "maintenance_overrides",
  "maintenance_events",
  "maintenance_config",
  "equipment_swaps",
  "invoices",
  "rentals",
  "equipment",
  "vendors",
  "job_sites",
];

export async function resetSystem(): Promise<{ cleared: string[] }> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES_TO_CLEAR) {
    await db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

  // Reset simulation cursor to seed start date
  await db.execute(sql`
    INSERT INTO simulation_state (id, cursor_date, total_days_run)
    VALUES (1, ${SEED_CURSOR}, 0)
    ON DUPLICATE KEY UPDATE cursor_date = ${SEED_CURSOR}, total_days_run = 0
  `);

  // Reset seed job state so a new seed can run
  resetJobState();

  return { cleared: TABLES_TO_CLEAR };
}
