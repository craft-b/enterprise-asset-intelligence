import dotenv from 'dotenv';
dotenv.config();

import { seedMaintenanceConfig } from './seeds/maintenance-config';
import { seedDemoUsers } from './seeds/demo-users';
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { equipment, equipmentFailurePredictions } from "@shared/schema";
import { desc, sql } from "drizzle-orm";
import { enhancedFeatureService } from "./services/feature-engineering-enhanced";
import { IMPUTATION_DEFAULTS } from "./services/imputation";
import { evaluatePMSchedule, generatePMDescription, samplePMCost, MaintenanceTypeKey } from "./services/pm-scheduler";
import { mlFetch } from "./services/ml-client";
import { registerChampionIfMissing } from "./services/champion-metrics";
import { getSeedStatus } from "./services/seed-orchestrator";
import {
  planCatchUp,
  PM_ADVANCE_DAYS,
  PM_CATCHUP_MAX_SIM_DAYS,
} from "./services/simulation-catchup";
import { toMlSnapshot } from "./services/multi-horizon-scoring";
import { summariseBody } from "./services/request-log";

// Last line of defence for an async handler nobody wrapped.
//
// Express 4 does not await route handlers, so a rejected promise is not an
// error it sees -- and Node has terminated the process on unhandled
// rejections since v15. A malformed body on an unauthenticated endpoint was
// enough to take the server down, which also loses every in-memory job,
// including a running seed.
//
// Handlers are wrapped at the source (asyncRoute in routes.ts); this exists so
// that the next one anybody forgets is a loud log rather than a restart.
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL-GUARD] Unhandled promise rejection — request dropped, process kept alive:", reason);
});

const app = express();
// No ETag on API responses: with no-store it is redundant, and it is the
// mechanism that produced the 304s above.
app.set("etag", false);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Sensor uploads arrive as raw CSV. 20mb covers ~50k readings, which is the
// row cap the ingest service enforces anyway.
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "20mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}


app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: unknown;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms${summariseBody(capturedJsonResponse)}`);
    }
  });

  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// NIGHTLY DRIFT CRON
// Keeps risk scores fresh without manual prediction runs.
//
// Strategy (risk-prioritized):
//   HIGH / MEDIUM units — rescore every night (scores drift fastest)
//   LOW units           — rescore every 3 days (stable, lower urgency)
//
// Runs at real midnight. Non-blocking — failures are logged, never crash server.
// Uses the simulation cursor date for feature engineering so scores reflect
// the current simulated state, not real-world time.
// ─────────────────────────────────────────────────────────────────────────────

async function runDriftRescore() {
  log("[CRON] Nightly drift rescore starting...", "cron");

  try {
    // Get simulation cursor date for feature engineering
    const [stateRows] = await db.execute(
      sql`SELECT cursor_date FROM simulation_state WHERE id = 1`
    ) as any;
    const snapshotDate = stateRows[0]?.cursor_date
      ? new Date(stateRows[0].cursor_date)
      : new Date();

    // Get all active equipment
    const allEquipment = await db.select({
      id: equipment.id,
      equipmentId: equipment.equipmentId,
    }).from(equipment);

    // Get latest prediction per unit to determine rescore priority
    const latestPreds = await db.execute(sql`
      SELECT equipment_id, risk_level_30d, predicted_at
      FROM equipment_failure_predictions
      WHERE id IN (
        SELECT MAX(id)
        FROM equipment_failure_predictions
        GROUP BY equipment_id
      )
    `) as any;

    const predMap = new Map<number, { riskLevel: string; predictedAt: Date }>();
    for (const row of (latestPreds as any)[0] ?? []) {
      predMap.set(Number(row.equipment_id), {
        riskLevel: row.risk_level_30d,
        predictedAt: new Date(row.predicted_at),
      });
    }

    const now = new Date();
    const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
    const THREE_DAY_MS = 3 * ONE_DAY_MS;

    // Determine which units need rescoring
    const toRescore: number[] = [];
    for (const equip of allEquipment) {
      const pred = predMap.get(equip.id);

      if (!pred) {
        // Never scored — always include
        toRescore.push(equip.id);
        continue;
      }

      const age = now.getTime() - pred.predictedAt.getTime();
      const isHighOrMedium = pred.riskLevel === "HIGH" || pred.riskLevel === "MEDIUM";

      if (isHighOrMedium && age >= ONE_DAY_MS) {
        toRescore.push(equip.id);
      } else if (!isHighOrMedium && age >= THREE_DAY_MS) {
        toRescore.push(equip.id);
      }
    }

    log(`[CRON] ${toRescore.length} / ${allEquipment.length} units queued for rescore`, "cron");

    if (toRescore.length === 0) {
      log("[CRON] All scores fresh — nothing to rescore", "cron");
      return;
    }

    // Build payloads and call FastAPI
    let rescored = 0;
    let failed = 0;

    for (const equipId of toRescore) {
      try {
        const snapshot = await enhancedFeatureService.generateSnapshot(equipId, snapshotDate);

        // One definition, in services/multi-horizon-scoring.ts.
        const payload = toMlSnapshot(equipId, snapshot);

        const fastapiRes = await mlFetch("/predict/multi-horizon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (fastapiRes.ok) {
          const pred = await fastapiRes.json();
          const p = pred.predictions;
          await db.insert(equipmentFailurePredictions).values({
            equipmentId:    equipId,
            modelVersion:   pred.model_version,
            riskTrend:      pred.risk_trend,
            prob10d:        p['10d'].failure_probability.toString(),
            riskLevel10d:   p['10d'].risk_level,
            prob30d:        p['30d'].failure_probability.toString(),
            riskLevel30d:   p['30d'].risk_level,
            prob60d:        p['60d'].failure_probability.toString(),
            riskLevel60d:   p['60d'].risk_level,
            topDrivers10d:  JSON.stringify(Object.keys(p['10d'].top_risk_drivers || {})),
            topDrivers30d:  JSON.stringify(Object.keys(p['30d'].top_risk_drivers || {})),
            topDrivers60d:  JSON.stringify(Object.keys(p['60d'].top_risk_drivers || {})),
            shapAttribution10d: JSON.stringify(p['10d'].shap_attribution || {}),
            shapAttribution30d: JSON.stringify(p['30d'].shap_attribution || {}),
            shapAttribution60d: JSON.stringify(p['60d'].shap_attribution || {}),
            recommendation: pred.recommendation,
          });
          rescored++;
        } else {
          failed++;
          log(`[CRON] FastAPI error for EQ-${equipId}: ${fastapiRes.status}`, "cron");
        }
      } catch (err: any) {
        failed++;
        log(`[CRON] Failed to rescore EQ-${equipId}: ${err.message}`, "cron");
      }
    }

    log(
      `[CRON] Drift rescore complete — ${rescored} rescored, ${failed} failed`,
      "cron"
    );

  } catch (err: any) {
    log(`[CRON] Drift rescore FATAL: ${err.message}`, "cron");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY PM SIMULATION CRON
// Advances the simulation clock by PM_ADVANCE_DAYS (default 7) each real day
// and auto-logs SCHEDULED_PM events for equipment whose feature-driven
// maintenance interval has elapsed.
//
// Runs at 06:00 real time (offset from midnight drift rescore to spread load).
// Non-blocking — failures are logged, never crash server.
// ─────────────────────────────────────────────────────────────────────────────



async function runPMSimulation(days: number = PM_ADVANCE_DAYS, realTimeMark?: Date) {
  log(`[PM-CRON] Starting PM simulation — advancing ${days} simulation day(s)`, "cron");

  try {
    const [stateRows] = await db.execute(
      sql`SELECT cursor_date, total_days_run FROM simulation_state WHERE id = 1`
    ) as any;
    let cursorDate: Date = stateRows[0]?.cursor_date
      ? new Date(stateRows[0].cursor_date)
      : new Date();

    const allEquipment = await db.select({
      id: equipment.id,
      name: equipment.name,
      category: equipment.category,
    }).from(equipment);

    let totalCreated = 0;
    // Snapshot failures are skipped per asset; counted so a run that skipped
    // everything cannot report success.
    let snapshotFailures = 0;

    for (let d = 0; d < days; d++) {
      cursorDate = new Date(cursorDate.getTime() + 24 * 3600 * 1000);
      const dateStr = cursorDate.toISOString().split("T")[0];

      for (const equip of allEquipment) {
        const category = equip.category || "Excavator";

        // Advance equipment hours — category-specific daily ranges, 15% idle chance
        const isIdle = Math.random() < 0.15;
        if (!isIdle) {
          const [dailyMin, dailyMax]: [number, number] = (
            { Compressor: [10, 20], Generator: [12, 22], Hauler: [7, 11], Loader: [7, 11] } as Record<string, [number, number]>
          )[category] ?? [5, 9];
          const dailyHours = parseFloat((dailyMin + Math.random() * (dailyMax - dailyMin)).toFixed(2));
          await db.execute(sql`
            UPDATE equipment SET current_mileage = current_mileage + ${dailyHours} WHERE id = ${equip.id}
          `);
        }

        let snapshot: any;
        try {
          snapshot = await enhancedFeatureService.generateSnapshot(equip.id, cursorDate);
        } catch (err) {
          // Counted, not just skipped: if every asset fails this job used to
          // finish reporting success having rescored nothing.
          snapshotFailures++;
          if (snapshotFailures === 1) log(`[CRON] snapshot failed for equipment ${equip.id}: ${(err as any)?.message ?? err}`, "cron");
          continue;
        }

        const [lastPMRows] = await db.execute(sql`
          SELECT maintenance_type, DATEDIFF(${dateStr}, MAX(maintenance_date)) AS days_since
          FROM maintenance_events
          WHERE equipment_id = ${equip.id}
            AND maintenance_date <= ${dateStr}
          GROUP BY maintenance_type
        `) as any;

        const lastPMByType: Record<MaintenanceTypeKey, number | null> = {
          INSPECTION:    null,
          MINOR_SERVICE: null,
          MAJOR_SERVICE: null,
        };
        for (const row of (lastPMRows as any[]) ?? []) {
          const t = row.maintenance_type as MaintenanceTypeKey;
          if (t in lastPMByType) {
            lastPMByType[t] = row.days_since != null ? Number(row.days_since) : null;
          }
        }

        const triggered = evaluatePMSchedule(category, snapshot, lastPMByType);

        for (const item of triggered) {
          const description = generatePMDescription(item.maintenanceType, item, category);
          const cost = samplePMCost(category, item.maintenanceType);
          const nextDueDays = { MAJOR_SERVICE: 180, MINOR_SERVICE: 90, INSPECTION: 60 }[item.maintenanceType];
          const nextDue = new Date(cursorDate.getTime() + nextDueDays * 24 * 3600 * 1000)
            .toISOString().split("T")[0];

          try {
            await db.execute(sql`
              INSERT INTO maintenance_events
                (equipment_id, maintenance_date, maintenance_type, event_source,
                 description, cost, next_due_date)
              VALUES (
                ${equip.id}, ${dateStr}, ${item.maintenanceType}, 'SCHEDULED_PM',
                ${description}, ${cost}, ${nextDue}
              )
            `);
            totalCreated++;
          } catch (insertErr: any) {
            log(`[PM-CRON] Insert failed for EQ-${equip.id} ${item.maintenanceType}: ${insertErr.message}`, "cron");
          }
        }
      }
    }

    const newCursorStr = cursorDate.toISOString().split("T")[0];
    const newTotal = (stateRows[0]?.total_days_run || 0) + days;
    await db.execute(sql`
      UPDATE simulation_state
         SET cursor_date = ${newCursorStr},
             total_days_run = ${newTotal},
             updated_at = ${realTimeMark ?? new Date()}
       WHERE id = 1
    `);

    const skipped = snapshotFailures > 0 ? `, ${snapshotFailures} snapshot(s) failed` : "";
    log(`[PM-CRON] Complete — cursor → ${newCursorStr}, ${totalCreated} PM event(s) created${skipped}`, "cron");
    if (snapshotFailures >= allEquipment.length && allEquipment.length > 0) {
      log(`[PM-CRON] WARNING: every asset failed snapshot generation — nothing was rescored`, "cron");
    }
  } catch (err: any) {
    log(`[PM-CRON] FATAL: ${err.message}`, "cron");
  }
}



/**
 * Advance the simulation by however much real time has passed since it last
 * moved.
 *
 * scheduleDailyPM arms a timer for 06:00, which on a free instance is a clock
 * that almost never rings: the container suspends after about fifteen minutes
 * without traffic, and every restart reschedules the timer from scratch. The
 * simulation had not moved since the day it was seeded.
 *
 * The amount owed is a function of elapsed real time, not of starting up --
 * which matters because this host boots on any visit after an idle period, so
 * a per-boot advance would run the clock far ahead of reality. Ten visits in
 * one day owe exactly as much as one.
 *
 * Partial progress is honest about itself: when the cap bites, the stored
 * timestamp moves forward only by the real time actually consumed, so the
 * remainder is still owed next time rather than being forgotten.
 */
async function catchUpSimulation(): Promise<void> {
  try {
    if (getSeedStatus().status === "running") {
      log("[PM-CATCHUP] Seed in progress — leaving the clock alone", "cron");
      return;
    }

    const [rows] = (await db.execute(
      sql`SELECT cursor_date, updated_at FROM simulation_state WHERE id = 1`
    )) as any;
    const state = (rows as any[])[0];
    if (!state?.updated_at) return;  // never seeded; nothing to catch up

    const plan = planCatchUp(new Date(state.updated_at), new Date());
    if (plan.applying === 0) return;

    log(
      `[PM-CATCHUP] ${plan.realDays} real day(s) since the clock last moved — ` +
      `applying ${plan.applying} of ${plan.owed} simulation day(s)`,
      "cron"
    );
    await runPMSimulation(plan.applying, plan.mark);
    if (plan.applying < plan.owed) {
      log(`[PM-CATCHUP] ${plan.owed - plan.applying} simulation day(s) still owed; will continue next start`, "cron");
    }
  } catch (err: any) {
    // A clock that cannot catch up is not a reason to refuse to serve.
    log(`[PM-CATCHUP] Failed: ${err?.message ?? err}`, "cron");
  }
}

function scheduleDailyPM() {
  // Fire at 06:00 real time (offset 6h from midnight drift rescore)
  const now = new Date();
  const next6am = new Date(now);
  next6am.setHours(6, 0, 0, 0);
  if (next6am <= now) next6am.setDate(next6am.getDate() + 1);
  const msUntil6am = next6am.getTime() - now.getTime();

  log(
    `[PM-CRON] Daily PM simulation scheduled — first run in ${Math.round(msUntil6am / 60000)} minutes`,
    "cron"
  );

  setTimeout(() => {
    runPMSimulation();
    setInterval(runPMSimulation, 24 * 60 * 60 * 1000);
  }, msUntil6am);
}

// Schedule nightly at midnight using setInterval
// Calculates ms until next midnight and fires then, then repeats every 24h
function scheduleNightlyRescore() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // next midnight
  const msUntilMidnight = midnight.getTime() - now.getTime();

  log(
    `[CRON] Nightly drift rescore scheduled — first run in ${Math.round(msUntilMidnight / 60000)} minutes`,
    "cron"
  );

  setTimeout(() => {
    runDriftRescore();
    // After first run, repeat every 24 hours
    setInterval(runDriftRescore, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER STARTUP
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await registerRoutes(httpServer, app);
  await seedMaintenanceConfig();
  // No-op unless SEED_DEMO_USERS is set; see the module for why it is
  // opt-in rather than on by default.
  await seedDemoUsers();


  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    // Logged, not rethrown. Rethrowing from an error handler after the
    // response has been sent escapes Express entirely and takes the process
    // with it -- one bad request restarting the server, losing every
    // in-memory job including a running seed.
    console.error(`[ERROR] ${req.method} ${req.originalUrl} -> ${status}:`, err);
    if (!res.headersSent) res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
    // Start nightly drift rescore after server is listening
    scheduleNightlyRescore();
    // Start daily PM simulation (runs at 06:00, advances simulation + logs PM events)
    scheduleDailyPM();
    // Make the shipped champion's metrics visible if nothing is registered.
    // Deliberately after listen() and never awaited: the ML service suspends
    // when idle and takes ~50s to wake, which is not something to hold a boot
    // on. It no-ops when a model is already registered, so a deployment
    // seeded before this existed heals on its next restart without a reseed.
    void registerChampionIfMissing();
    // Bring the simulation clock up to date. Not awaited: it is bounded work
    // but still work, and nothing serving depends on it having finished.
    void catchUpSimulation();
  });
})().catch((err: unknown) => {
  // Boot-time misconfiguration (a missing SESSION_SECRET, an unreachable
  // database) would otherwise surface as an unhandled rejection stack. Print
  // the message the check actually wrote and exit non-zero so the host's
  // restart/backoff sees a failed start.
  //
  // The chain is unwrapped because drizzle wraps every query error in a
  // DrizzleQueryError whose own message is just the SQL -- the reason the
  // query failed (ECONNREFUSED, ER_ACCESS_DENIED_ERROR, ER_NO_SUCH_TABLE)
  // only appears on `cause`, and that is the part an operator needs.
  const chain: string[] = [];
  for (let e: any = err; e != null && chain.length < 4; e = e.cause) {
    const code = e.code ? ` [${e.code}]` : "";
    const message = e instanceof Error ? e.message : String(e);
    // The outermost message is printed whole -- our own checks put remediation
    // (e.g. the openssl command) on a second line. Nested driver errors are
    // compressed to one line so the chain stays readable.
    chain.push(`${chain.length === 0 ? message : message.split("\n")[0]}${code}`);
  }
  console.error(`[BOOT] startup failed: ${chain.join("\n  caused by: ")}`);
  process.exit(1);
});