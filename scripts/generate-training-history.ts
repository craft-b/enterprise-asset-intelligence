/**
 * generate-training-history.ts -- build the champion's training set.
 *
 * Simulates a rental fleet for several years under the breakdown process in
 * server/services/failure-hazard.ts, with each unit kept to a maintenance
 * policy of its own (diligent, average, neglectful), and takes weekly feature
 * snapshots AS THE SIMULATION RUNS, through the same enhancedFeatureService
 * the API scores with. Then labels them with the same labelSnapshots().
 *
 * Snapshots are taken in step, not backfilled, because the feature service
 * reads lifetime hours off the equipment record (current_mileage). A
 * backfill after the fact would give every early snapshot the final meter
 * reading -- future information, and a wear rate no unit had at the time.
 *
 * Writes into a database of its own. It refuses to run against one that
 * already has equipment, so it cannot be pointed at the demo by mistake.
 *
 * Run:
 *   DATABASE_URL=mysql://user:pass@localhost:3306/eai_training \
 *     npx tsx scripts/generate-training-history.ts
 * then train with ml-service/training/train_model_multihorizon.py against
 * the same database.
 */
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { featureEngineeringService } from "../server/services/feature-engineering";
import { seedMaintenanceConfig } from "../server/seeds/maintenance-config";
import {
  afterService,
  degrade,
  dailyFailureProbability,
  type ServiceKind,
} from "../server/services/failure-hazard";

const FLEET_SIZE = Number(process.env.TRAINING_FLEET_SIZE ?? 160);
const SIM_DAYS = Number(process.env.TRAINING_SIM_DAYS ?? 1155);   // ~3 years + the 60-day label horizon
const WARMUP_DAYS = 90;          // the feature windows reach back 90 days
const SNAPSHOT_EVERY = 7;
const START = new Date("2022-01-03T00:00:00Z");
const SEED = Number(process.env.TRAINING_SEED ?? 20261104);

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString().split("T")[0];

// Seeded so two runs build the same dataset and a retrain is reproducible.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

// Category, PM interval (maintenance_config), and hours per working day --
// the same per-category hours the demo seed's sensor generator uses.
const CATEGORIES = [
  { category: "Crane", interval: 90, hours: [5, 9], make: "Liebherr", model: "LTM 1090", daily: 880 },
  { category: "Grader", interval: 180, hours: [5, 9], make: "Caterpillar", model: "140M3", daily: 640 },
  { category: "Lift", interval: 90, hours: [5, 9], make: "JLG", model: "860SJ", daily: 500 },
  { category: "Excavator", interval: 180, hours: [5, 9], make: "Komatsu", model: "PC210", daily: 570 },
  { category: "Hauler", interval: 150, hours: [7, 11], make: "Volvo", model: "A30G", daily: 440 },
  { category: "Compressor", interval: 120, hours: [10, 20], make: "Atlas Copco", model: "XAS 185", daily: 230 },
  { category: "Loader", interval: 150, hours: [7, 11], make: "Bobcat", model: "S650", daily: 290 },
  { category: "Compactor", interval: 150, hours: [5, 9], make: "Bomag", model: "BW 120", daily: 200 },
  { category: "Generator", interval: 120, hours: [12, 22], make: "Generac", model: "MDG25", daily: 165 },
  { category: "Dozer", interval: 180, hours: [5, 9], make: "Caterpillar", model: "D6", daily: 700 },
] as const;

/**
 * How a unit is looked after. `lateness` stretches the scheduled interval;
 * `skip` is the chance a scheduled visit simply does not happen. Shares are
 * a guess at a mixed yard, and the spread is what lets the model see service
 * matter: if every unit were serviced on time, days-since-service would carry
 * no information however strongly it drove breakdowns.
 */
const POLICIES = [
  { name: "diligent", share: 0.35, lateness: [0.85, 1.05], skip: 0.05 },
  { name: "average", share: 0.40, lateness: [1.0, 1.6], skip: 0.2 },
  { name: "neglectful", share: 0.25, lateness: [1.5, 3.0], skip: 0.45 },
] as const;

const INSPECTION_EVERY = 30;
const MAJOR_EVERY_NTH_SERVICE = 3;

interface Unit {
  id: number;
  code: string;
  cat: (typeof CATEGORIES)[number];
  policy: (typeof POLICIES)[number];
  duty: number;
  purchase: Date;
  hours: number;
  condition: number;
  nextService: number;     // sim day index
  nextInspection: number;
  servicesDone: number;
  downUntil: number;
}

type MaintRow = { eqId: number; date: string; type: string; source: string; cost: number; desc: string; nextDue: string };

function choosePolicy() {
  let r = rand();
  for (const p of POLICIES) { if ((r -= p.share) < 0) return p; }
  return POLICIES[POLICIES.length - 1];
}

function scheduleGap(u: Unit, base: number) {
  return Math.round(base * between(u.policy.lateness[0], u.policy.lateness[1]));
}

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0];
  const [existing] = await db.execute(sql`SELECT COUNT(*) AS n FROM equipment`) as any;
  if (Number(existing[0].n) > 0) {
    throw new Error(`${dbName} already has equipment; this script only fills an empty database`);
  }
  console.log(`[HISTORY] ${FLEET_SIZE} units, ${SIM_DAYS} days from ${iso(START)} into ${dbName}`);

  await seedMaintenanceConfig();
  await db.execute(sql`
    INSERT INTO simulation_state (id, cursor_date, total_days_run) VALUES (1, ${iso(START)}, 0)
    ON DUPLICATE KEY UPDATE cursor_date = VALUES(cursor_date), total_days_run = 0
  `);

  // ── Fleet ────────────────────────────────────────────────────────────────
  const units: Unit[] = [];
  const maint: MaintRow[] = [];
  for (let i = 0; i < FLEET_SIZE; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const ageYears = between(0.5, 12);
    const duty = rand() < 0.7 ? 1.0 : rand() < 0.5 ? 0.6 : 0.3;
    const purchase = new Date(START.getTime() - ageYears * 365.25 * DAY);
    // Duty cycle 0.03-0.11 of wall-clock time, scaled by how hard it is worked:
    // the span the demo fleet's wear rates cover.
    const hours = Math.round(ageYears * 8760 * between(0.03, 0.11) * (0.4 + 0.6 * duty));
    const code = `TR-${String(i + 1).padStart(4, "0")}`;
    const policy = choosePolicy();

    await db.execute(sql`
      INSERT INTO equipment
        (equipment_id, name, category, make, model, serial_number, status,
         daily_rate, weekly_rate, monthly_rate, year_manufactured, purchase_date, current_mileage, initial_mileage)
      VALUES
        (${code}, ${`${cat.make} ${cat.category}`}, ${cat.category}, ${cat.make}, ${cat.model},
         ${`SIM-${code}`}, 'AVAILABLE', ${cat.daily}, ${cat.daily * 6}, ${cat.daily * 21},
         ${purchase.getUTCFullYear()}, ${iso(purchase)}, ${hours}, 0)
    `);
    const [row] = await db.execute(sql`SELECT id FROM equipment WHERE equipment_id = ${code}`) as any;

    const u: Unit = {
      id: Number(row[0].id), code, cat, policy, duty, purchase, hours,
      condition: between(0.6, 1.8),
      nextService: Math.floor(between(0, cat.interval)),
      nextInspection: Math.floor(between(0, INSPECTION_EVERY)),
      servicesDone: Math.floor(between(0, MAJOR_EVERY_NTH_SERVICE)),
      downUntil: -1,
    };
    units.push(u);

    // One prior service, so days-since-service is defined from day one.
    const prior = new Date(START.getTime() - Math.floor(between(5, 150)) * DAY);
    maint.push({
      eqId: u.id, date: iso(prior), type: "MINOR_SERVICE", source: "SCHEDULED_PM",
      cost: Math.round(between(150, 500)), desc: "Service before the simulated history",
      nextDue: iso(new Date(prior.getTime() + cat.interval * DAY)),
    });
  }

  // ── Simulate ─────────────────────────────────────────────────────────────
  let sensors: any[] = [];
  let snapshots = 0, failures = 0, services = 0;

  for (let day = 0; day < SIM_DAYS; day++) {
    const date = new Date(START.getTime() + day * DAY);
    const dateStr = iso(date);

    for (const u of units) {
      const down = day <= u.downUntil;
      const idle = down || rand() < 1 - u.duty * 0.85;
      const stressed = !idle && rand() < 0.08 * u.duty;
      const dayLength = 0.5 + 0.5 * u.duty;
      const hrs = idle ? 0 : +((u.cat.hours[0] + rand() * (u.cat.hours[1] - u.cat.hours[0])) * dayLength).toFixed(2);
      u.hours += hrs;

      sensors.push([
        u.id, dateStr,
        idle ? 0 : Math.round(1200 + rand() * 800 + (stressed ? 600 : 0)),
        idle ? 20 : Math.round(80 + rand() * 15 + (stressed ? 25 : 0)),
        idle ? 0 : Math.round(35 + rand() * 15 - (stressed ? 8 : 0)),
        idle ? 20 : Math.round(85 + rand() * 10 + (stressed ? 15 : 0)),
        idle ? 0 : +(8 + rand() * 12).toFixed(2),
        idle ? 0 : Math.round(2000 + rand() * 500),
        idle ? 20 : Math.round(45 + rand() * 20),
        idle ? 0 : Math.round(1600 + rand() * 400),
        +(0.1 + rand() * 0.8 + (stressed ? 1.2 : 0)).toFixed(3),
        +(0.1 + rand() * 0.8 + (stressed ? 1.0 : 0)).toFixed(3),
        +(0.1 + rand() * 0.6 + (stressed ? 0.8 : 0)).toFixed(3),
        hrs,
        idle ? 0 : Math.round(30 + rand() * 60 + (stressed ? 20 : 0)),
        +(rand() * 2).toFixed(2),
        Math.round(10 + rand() * 25),
        stressed ? Math.floor(rand() * 3) : 0,
      ]);

      if (down) continue;
      u.condition = degrade(u.condition, idle ? u.duty * 0.3 : u.duty);

      // Breakdown?
      const ageYears = (date.getTime() - u.purchase.getTime()) / (365.25 * DAY);
      if (rand() < dailyFailureProbability(ageYears, u.hours, u.condition, stressed)) {
        u.condition = afterService(u.condition, "REPAIR");
        u.downUntil = day + 1 + Math.floor(rand() * 4);
        maint.push({
          eqId: u.id, date: dateStr, type: "MAJOR_SERVICE", source: "REACTIVE_REPAIR",
          cost: Math.round(between(800, 2500)), desc: "Breakdown repair (simulated)",
          nextDue: iso(new Date(date.getTime() + u.cat.interval * DAY)),
        });
        failures++;
        continue;
      }

      // Scheduled work, on this unit's own idea of the schedule.
      if (day >= u.nextService) {
        u.nextService = day + scheduleGap(u, u.cat.interval);
        if (rand() >= u.policy.skip) {
          u.servicesDone++;
          const kind: ServiceKind = u.servicesDone % MAJOR_EVERY_NTH_SERVICE === 0 ? "MAJOR_SERVICE" : "MINOR_SERVICE";
          u.condition = afterService(u.condition, kind);
          maint.push({
            eqId: u.id, date: dateStr, type: kind, source: "SCHEDULED_PM",
            cost: Math.round(kind === "MAJOR_SERVICE" ? between(900, 2000) : between(150, 500)),
            desc: `Scheduled ${kind === "MAJOR_SERVICE" ? "major" : "minor"} service (simulated)`,
            nextDue: iso(new Date(date.getTime() + u.cat.interval * DAY)),
          });
          services++;
          u.nextInspection = day + scheduleGap(u, INSPECTION_EVERY);
          continue;
        }
      }
      if (day >= u.nextInspection) {
        u.nextInspection = day + scheduleGap(u, INSPECTION_EVERY);
        if (rand() >= u.policy.skip) {
          u.condition = afterService(u.condition, "INSPECTION");
          maint.push({
            eqId: u.id, date: dateStr, type: "INSPECTION", source: "SCHEDULED_PM",
            cost: Math.round(between(80, 200)), desc: "Scheduled inspection (simulated)",
            nextDue: iso(new Date(date.getTime() + 60 * DAY)),
          });
        }
      }
    }

    // ── Snapshot in step with the simulation ───────────────────────────────
    const isSnapshotDay = day >= WARMUP_DAYS && (day - WARMUP_DAYS) % SNAPSHOT_EVERY === 0;
    if (isSnapshotDay || day === SIM_DAYS - 1) {
      await flushSensors(sensors); sensors = [];
      await flushMaintenance(maint); maint.length = 0;
      await writeMeters(units);
      await db.execute(sql`UPDATE simulation_state SET cursor_date = ${dateStr}, total_days_run = ${day + 1} WHERE id = 1`);
      if (isSnapshotDay) {
        const snaps = await featureEngineeringService.generateSnapshotsForAllEquipment(date);
        snapshots += await featureEngineeringService.saveSnapshots(snaps);
      }
      if (day % 70 === 0) {
        console.log(`[HISTORY] ${dateStr}: ${snapshots} snapshots, ${failures} breakdowns, ${services} services`);
      }
    }
  }

  console.log(`[HISTORY] labelling ${snapshots} snapshots...`);
  const labeled = await featureEngineeringService.labelSnapshots();
  const [summary] = await db.execute(sql`
    SELECT label_status, COUNT(*) n, SUM(will_fail_10d) p10, SUM(will_fail_30d) p30, SUM(will_fail_60d) p60
    FROM asset_feature_snapshots GROUP BY label_status
  `) as any;
  console.log(`[HISTORY] done: ${failures} breakdowns, ${services} services, ${labeled} labelled`);
  console.table(summary);
  process.exit(0);
}

async function flushSensors(rows: any[][]) {
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map(r => sql`(${sql.join(r.map(v => sql`${v}`), sql`, `)})`);
    await db.execute(sql`
      INSERT IGNORE INTO sensor_data_logs
        (equipment_id, timestamp, engine_rpm, engine_temp, oil_pressure, coolant_temp,
         fuel_consumption, hydraulic_pressure, hydraulic_temp, hydraulic_flow_rate,
         vibration_x, vibration_y, vibration_z, operating_hours, load_percentage,
         idle_time, ambient_temp, warning_count)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
}

async function flushMaintenance(rows: MaintRow[]) {
  for (let i = 0; i < rows.length; i += 300) {
    const values = rows.slice(i, i + 300).map(r => sql`(
      ${r.eqId}, ${r.date}, ${r.type}, ${r.source}, ${r.cost}, ${r.desc}, ${r.nextDue}, ${r.date + " 09:00:00"}
    )`);
    await db.execute(sql`
      INSERT INTO maintenance_events
        (equipment_id, maintenance_date, maintenance_type, event_source, cost, description, next_due_date, created_at)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
}

async function writeMeters(units: Unit[]) {
  const cases = sql.join(units.map(u => sql`WHEN ${u.id} THEN ${u.hours.toFixed(2)}`), sql` `);
  await db.execute(sql`UPDATE equipment SET current_mileage = CASE id ${cases} END
                       WHERE id IN (${sql.join(units.map(u => sql`${u.id}`), sql`, `)})`);
}

main().catch(err => { console.error(err); process.exit(1); });
