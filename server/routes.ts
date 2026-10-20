// server/routes.ts

import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import session from "express-session";
import { createSessionStore, resolveSessionSecret, SESSION_TTL_MS } from "./services/session-store";
import { applyCors } from "./services/cors";
import { toPublicUser } from "./services/public-user";
import { csvToRecords, ingestReadings, MAX_ROWS } from "./services/sensor-ingest";
import { validateMlServiceUrl } from "./services/ml-client";
import bcrypt from "bcryptjs";
import { maintenanceEvents, equipment, equipmentRiskScores, rentals, equipmentFailurePredictions, equipmentSwaps } from "@shared/schema";
import { eq, desc, asc, count, sql, and, like } from "drizzle-orm";
import { db, pool } from "./db";
import { predictiveMaintenanceService } from './services/predictive-maintenance-fixed';
import { featureEngineeringService } from './services/feature-engineering';
import { assetRiskPredictions } from "@shared/schema";
import { enhancedFeatureService } from "./services/feature-engineering-enhanced";
import { evaluatePMSchedule, generatePMDescription, samplePMCost, MaintenanceTypeKey } from "./services/pm-scheduler";
import { startSeedJob, getSeedStatus, getSystemStatus, resetSystem } from "./services/seed-orchestrator";
import { mlFetch, describeMlFailure } from "./services/ml-client";
import { timingSafeEqual } from "crypto";
import { getSimulationDate } from "./services/simulation-clock";
import { scoreFleetMultiHorizon, toMlSnapshot } from "./services/multi-horizon-scoring";
import { IMPUTATION_DEFAULTS, isColdStart, coldStartMultiHorizon } from "./services/imputation";

declare module "express-session" {
  interface SessionData {
    userId: number;
    role: string;
  }
}

/**
 * Wrap an async route handler so a rejection reaches Express.
 *
 * Express 4 does not await handlers, so a rejected promise is not an error it
 * ever sees -- it is an unhandled rejection, and Node has terminated the
 * process on those since v15. A malformed body on POST /api/auth/login threw
 * in Zod and took the server down with it, from an unauthenticated endpoint.
 *
 * Forwarding to next(err) puts it back on the error middleware, which answers
 * with a status and logs. Express 5 does this itself; until then, this.
 */
function asyncRoute(handler: (req: any, res: any, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Every :id in this file is a database key, and every handler reads it with
  // parseInt. A non-numeric segment produced NaN, which then reached SQL as
  // `WHERE id = NaN` and surfaced as a 500 rather than the 400 it is. One
  // guard here covers all 21 of them.
  app.param("id", (req, res, next, value) => {
    if (!/^\d+$/.test(String(value))) {
      return res.status(400).json({ message: `Invalid id: ${value}` });
    }
    next();
  });

  // Railway (and most cloud platforms) sit behind a reverse proxy.
  // Without this, Express won't see HTTPS and won't set secure cookies.
  app.set("trust proxy", 1);

  // Before the session and the routes: a preflight must be answered without
  // touching the session, and a blocked origin should never reach a handler.
  applyCors(app);

  // Fail here rather than at the first call to the ML service. A wrong value
  // is silent until something uses it, and then surfaces as whatever that
  // other URL happens to return -- a seed run once reported an entire GitHub
  // error page as its failure message.
  validateMlServiceUrl(process.env.ML_SERVICE_URL);

  // SEC-3: sessions are persisted in MySQL rather than express-session's
  // in-process MemoryStore, which leaks and loses every session on restart.
  // See services/session-store.ts for the table contract and rationale.
  const sessionStore = createSessionStore(session, pool);

  app.use(
    session({
      secret: resolveSessionSecret(),
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: SESSION_TTL_MS,
      },
    })
  );

  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) return res.status(401).json({ message: "Unauthorized" });
    next();
  };

  const requireAdmin = (req: any, res: any, next: any) => {
    if (!req.session.userId || req.session.role !== "ADMINISTRATOR") {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };

  // NOTE: the old getDefaultMetrics() hardcoded-fallback was deleted (ML-9).
  // Metrics endpoints now return an honest empty state when no model exists.

  // ── SIMULATION CURSOR HELPER ──────────────────────────────────────────────
  // One definition, in services/simulation-clock.ts. Batch scoring used
  // new Date() instead of this and scored a fleet six months after its data
  // ended, which is the kind of thing a second copy invites.

  // ── SIMULATION ────────────────────────────────────────────────────────────
  app.get("/api/simulate/state", requireAuth, async (req, res) => {
    try {
      const [state] = await db.execute(sql`SELECT * FROM simulation_state WHERE id = 1`) as any;
      res.json(state[0] || { cursorDate: null, totalDaysRun: 0 });
    } catch (e) {
      res.status(500).json({ message: "Failed to get simulation state" });
    }
  });

  app.post("/api/simulate/day", requireAuth, requireAdmin, async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.body.days) || 1, 1), 30);

      const equipmentList = await db.select({
        id: equipment.id,
        name: equipment.name,
        category: equipment.category,
        currentMileage: equipment.currentMileage,
        purchaseDate: equipment.purchaseDate,
      }).from(equipment);

      const [stateRows] = await db.execute(sql`SELECT cursor_date, total_days_run FROM simulation_state WHERE id = 1`) as any;
      let cursorDate = stateRows[0]?.cursor_date ? new Date(stateRows[0].cursor_date) : new Date();

      let totalInserted = 0;
      let maintenanceInserted = 0;

      for (let d = 0; d < days; d++) {
        cursorDate = new Date(cursorDate.getTime() + 24 * 3600 * 1000);
        const dateStr = cursorDate.toISOString().split("T")[0];

        for (const equip of equipmentList) {
          const category = equip.category || "Excavator";

          const baseTemp = { Crane: 78, Excavator: 82, Dozer: 85, Loader: 80, Compressor: 70, Generator: 75 }[category] || 80;
          const isStressed = Math.random() < 0.08;
          const isIdle     = Math.random() < 0.15;

          const engineRpm         = isIdle ? 0 : Math.round(1200 + Math.random() * 800 + (isStressed ? 600 : 0));
          const engineTemp        = isIdle ? 20 : Math.round(baseTemp + Math.random() * 15 + (isStressed ? 25 : 0));
          const oilPressure       = isIdle ? 0 : Math.round(35 + Math.random() * 15 - (isStressed ? 8 : 0));
          const coolantTemp       = isIdle ? 20 : Math.round(85 + Math.random() * 10 + (isStressed ? 15 : 0));
          const hydraulicPressure = isIdle ? 0 : Math.round(2000 + Math.random() * 500 + (isStressed ? 300 : 0));
          const hydraulicTemp     = isIdle ? 20 : Math.round(45 + Math.random() * 20 + (isStressed ? 15 : 0));
          const vibrationX        = parseFloat((0.1 + Math.random() * 0.8 + (isStressed ? 1.2 : 0)).toFixed(3));
          const vibrationY        = parseFloat((0.1 + Math.random() * 0.8 + (isStressed ? 1.0 : 0)).toFixed(3));
          const vibrationZ        = parseFloat((0.1 + Math.random() * 0.6 + (isStressed ? 0.8 : 0)).toFixed(3));
          const operatingHours    = isIdle ? 0 : parseFloat((4 + Math.random() * 6).toFixed(2));
          const loadPct           = isIdle ? 0 : Math.round(30 + Math.random() * 60 + (isStressed ? 20 : 0));
          const idleTime          = parseFloat((Math.random() * 2).toFixed(2));
          const fuelConsumption   = isIdle ? 0 : parseFloat((8 + Math.random() * 12 + (isStressed ? 5 : 0)).toFixed(2));
          const ambientTemp       = Math.round(10 + Math.random() * 25);
          const warningCount      = isStressed ? Math.floor(Math.random() * 3) : 0;
          const errorCodes        = isStressed && Math.random() < 0.3 ? `E${Math.floor(100 + Math.random() * 900)}` : null;

          await db.execute(sql`
            INSERT INTO sensor_data_logs
              (equipment_id, timestamp, engine_rpm, engine_temp, oil_pressure, coolant_temp,
              fuel_consumption, hydraulic_pressure, hydraulic_temp, hydraulic_flow_rate,
              vibration_x, vibration_y, vibration_z, operating_hours, load_percentage,
              idle_time, ambient_temp, error_codes, warning_count)
            VALUES (${equip.id}, ${dateStr}, ${engineRpm}, ${engineTemp}, ${oilPressure}, ${coolantTemp},
              ${fuelConsumption}, ${hydraulicPressure}, ${hydraulicTemp}, ${Math.round(hydraulicPressure * 0.8)},
              ${vibrationX}, ${vibrationY}, ${vibrationZ}, ${operatingHours}, ${loadPct},
              ${idleTime}, ${ambientTemp}, ${errorCodes}, ${warningCount})
          `);
          totalInserted++;

          // Advance equipment hours (currentMileage tracks cumulative operating hours)
          if (operatingHours > 0) {
            await db.execute(sql`
              UPDATE equipment SET current_mileage = current_mileage + ${operatingHours} WHERE id = ${equip.id}
            `);
          }

          const purchaseDate  = equip.purchaseDate ? new Date(equip.purchaseDate) : new Date('2020-01-01');
          const ageYears      = (cursorDate.getTime() - purchaseDate.getTime()) / (365.25 * 24 * 3600 * 1000);

          const [hoursRow] = await db.execute(sql`
            SELECT COALESCE(SUM(operating_hours), 0) as total_hours
            FROM sensor_data_logs
            WHERE equipment_id = ${equip.id} AND timestamp <= ${dateStr}
          `) as any;
          const totalHours = parseFloat(hoursRow[0]?.total_hours ?? 0);

          const [maintRow] = await db.execute(sql`
            SELECT MAX(maintenance_date) as last_maint
            FROM maintenance_events
            WHERE equipment_id = ${equip.id} AND maintenance_date <= ${dateStr}
          `) as any;
          const lastMaint      = maintRow[0]?.last_maint ? new Date(maintRow[0].last_maint) : purchaseDate;
          const daysSinceMaint = (cursorDate.getTime() - lastMaint.getTime()) / (24 * 3600 * 1000);

          // Weibull-inspired hazard function
          const ageHazard     = Math.min(0.01 * Math.exp(0.55 * Math.max(0, ageYears - 1.5)), 0.25);
          const hoursHazard   = Math.min(0.005 * Math.exp(0.0004 * Math.max(0, totalHours - 3000)), 0.20);
          const neglectHazard = daysSinceMaint > 120
            ? Math.min(0.002 * Math.pow(daysSinceMaint - 90, 1.4), 0.15)
            : 0;

          const dailyFailureProb = Math.min(ageHazard + hoursHazard + neglectHazard, 0.30);
          const finalFailureProb = Math.min(dailyFailureProb * (isStressed ? 1.8 : 1.0), 0.35);

          if (Math.random() < finalFailureProb) {
            const rand = Math.random();
            const type = rand < 0.15 ? "MAJOR_SERVICE" : rand < 0.70 ? "MINOR_SERVICE" : "INSPECTION";
            const cost = type === "MAJOR_SERVICE"
              ? parseFloat((800 + Math.random() * 1200).toFixed(2))
              : type === "MINOR_SERVICE"
              ? parseFloat((150 + Math.random() * 350).toFixed(2))
              : parseFloat((80 + Math.random() * 120).toFixed(2));
            const nextDueDays = type === "MAJOR_SERVICE" ? 180 : type === "MINOR_SERVICE" ? 90 : 60;
            const nextDue     = new Date(cursorDate.getTime() + nextDueDays * 24 * 3600 * 1000).toISOString().split("T")[0];

            await db.execute(sql`
              INSERT INTO maintenance_events
                (equipment_id, maintenance_date, maintenance_type, cost, description, next_due_date)
              VALUES (
                ${equip.id}, ${dateStr}, ${type}, ${cost},
                ${`Simulated ${type.toLowerCase().replace(/_/g, " ")} — age ${ageYears.toFixed(1)}y / ${Math.round(totalHours)}h`},
                ${nextDue}
              )
            `);
            maintenanceInserted++;
          }

          // Fleet renewal
          const shouldRetire =
            ageYears > 10 || (ageYears > 8 && totalHours > 8000);

          if (shouldRetire) {
            const newEquipId = `EQ-R${equip.id}-${cursorDate.getFullYear()}`;
            const existingResult = await db.execute(sql`SELECT id FROM equipment WHERE equipment_id = ${newEquipId}`) as any;
            const existing = existingResult[0];

            if (!existing || existing.length === 0) {
              const newPurchaseDateStr  = dateStr;
              const newYearManufactured = cursorDate.getFullYear();

              await db.execute(sql`
                INSERT INTO equipment
                  (equipment_id, name, category, make, model, serial_number,
                   status, daily_rate, weekly_rate, monthly_rate, location,
                   year_manufactured, purchase_date, current_mileage, initial_mileage)
                SELECT
                  ${newEquipId}, CONCAT('Replacement ', name),
                  category, make, model, CONCAT('SIM-', ${newEquipId}),
                  'AVAILABLE', daily_rate, weekly_rate, monthly_rate, location,
                  ${newYearManufactured}, ${newPurchaseDateStr}, 0, 0
                FROM equipment WHERE id = ${equip.id}
              `);

              await db.execute(sql`
                INSERT INTO maintenance_events
                  (equipment_id, maintenance_date, maintenance_type, cost, description, next_due_date)
                SELECT
                  (SELECT id FROM equipment WHERE equipment_id = ${newEquipId}),
                  ${dateStr}, 'MINOR_SERVICE', 250.00,
                  'Pre-delivery inspection — new unit',
                  DATE_ADD(${dateStr}, INTERVAL 90 DAY)
              `);

              console.log(`[FLEET RENEWAL] Retired equip id=${equip.id} (age=${ageYears.toFixed(1)}y / ${Math.round(totalHours)}h)`);
            }
          }
        }
      }

      const newCursorStr = cursorDate.toISOString().split("T")[0];
      const newTotal = (stateRows[0]?.total_days_run || 0) + days;
      await db.execute(sql`
        UPDATE simulation_state SET cursor_date = ${newCursorStr}, total_days_run = ${newTotal} WHERE id = 1
      `);

      res.json({
        message: `Simulated ${days} day${days > 1 ? "s" : ""} of operations`,
        daysSimulated: days,
        sensorReadings: totalInserted,
        maintenanceEvents: maintenanceInserted,
        cursorDate: newCursorStr,
        totalDaysRun: newTotal,
      });
    } catch (e: any) {
      console.error("[SIMULATE]", e);
      res.status(500).json({ message: "Simulation failed", error: e.message });
    }
  });

  // ── PREVENTIVE MAINTENANCE SIMULATION ────────────────────────────────────
  // Advances the simulation cursor by N days and auto-logs SCHEDULED_PM events
  // for any equipment whose feature-driven PM interval has elapsed.
  //
  // Each day:
  //   1. Cursor advances by 1 day
  //   2. Per-equipment feature snapshot generated
  //   3. Days-since-last-PM computed per maintenance type
  //   4. PM config evaluated — feature thresholds can shorten base intervals
  //   5. Triggered types get a maintenance_event logged (eventSource=SCHEDULED_PM)
  //
  app.post('/api/simulate/advance-pm', requireAuth, requireAdmin, async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.body.days) || 1, 1), 30);

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
      const summary: Array<{ equipmentId: number; name: string; types: string[]; date: string }> = [];

      for (let d = 0; d < days; d++) {
        cursorDate = new Date(cursorDate.getTime() + 24 * 3600 * 1000);
        const dateStr = cursorDate.toISOString().split("T")[0];

        for (const equip of allEquipment) {
          const category = equip.category || "Excavator";

          // Advance equipment hours — category-specific daily ranges
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

          // Get latest feature snapshot for this equipment
          let snapshot: any;
          try {
            snapshot = await enhancedFeatureService.generateSnapshot(equip.id, cursorDate);
          } catch {
            continue; // Skip if snapshot generation fails
          }

          // Days since last PM per maintenance type
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

          // Evaluate PM schedule
          const triggered = evaluatePMSchedule(category, snapshot, lastPMByType);
          if (triggered.length === 0) continue;

          const createdTypes: string[] = [];

          for (const item of triggered) {
            const description = generatePMDescription(item.maintenanceType, item, category);
            const cost = samplePMCost(category, item.maintenanceType);
            const nextDueDays = { MAJOR_SERVICE: 180, MINOR_SERVICE: 90, INSPECTION: 60 }[item.maintenanceType];
            const nextDue = new Date(cursorDate.getTime() + nextDueDays * 24 * 3600 * 1000)
              .toISOString().split("T")[0];

            await db.execute(sql`
              INSERT INTO maintenance_events
                (equipment_id, maintenance_date, maintenance_type, event_source,
                 description, cost, next_due_date)
              VALUES (
                ${equip.id}, ${dateStr}, ${item.maintenanceType}, 'SCHEDULED_PM',
                ${description}, ${cost}, ${nextDue}
              )
            `);

            createdTypes.push(item.maintenanceType);
            totalCreated++;
          }

          if (createdTypes.length > 0) {
            summary.push({ equipmentId: equip.id, name: equip.name ?? '', types: createdTypes, date: dateStr });
          }
        }
      }

      // Advance cursor
      const newCursorStr = cursorDate.toISOString().split("T")[0];
      const newTotal = (stateRows[0]?.total_days_run || 0) + days;
      await db.execute(sql`
        UPDATE simulation_state SET cursor_date = ${newCursorStr}, total_days_run = ${newTotal} WHERE id = 1
      `);

      res.json({
        message: `PM simulation: ${days} day(s) advanced, ${totalCreated} maintenance event(s) created`,
        daysAdvanced: days,
        cursorDate: newCursorStr,
        totalDaysRun: newTotal,
        eventsCreated: totalCreated,
        summary,
      });
    } catch (e: any) {
      console.error("[SIMULATE-PM]", e);
      res.status(500).json({ message: "PM simulation failed", error: e.message });
    }
  });

  // ── HEALTH ────────────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── AUTH ──────────────────────────────────────────────────────────────────
  app.post(api.auth.login.path, asyncRoute(async (req, res) => {
    const { username, password } = api.auth.login.input.parse(req.body);
    const user = await storage.getUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json(toPublicUser(user));
  }));

  app.post(api.auth.logout.path, (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
  });

  app.get(api.auth.me.path, asyncRoute(async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    res.json(toPublicUser(await storage.getUser(req.session.userId)));
  }));

  app.post(api.auth.register.path, asyncRoute(async (req, res) => {
    const input = api.auth.register.input.parse(req.body);
    if (await storage.getUserByUsername(input.username)) {
      return res.status(400).json({ message: "Username exists" });
    }
    const user = await storage.createUser({
      ...input,
      password: bcrypt.hashSync(input.password, 10),
    });
    req.session.userId = user.id;
    req.session.role = user.role;
    res.status(201).json(toPublicUser(user));
  }));

  // ── EQUIPMENT ─────────────────────────────────────────────────────────────
  app.get(api.equipment.list.path, requireAuth, asyncRoute(async (req, res) => {
    res.json(await storage.listEquipment(req.query.search as string, req.query.status as string));
  }));

  const EQUIPMENT_NULLABLE_FIELDS = [
    'weeklyRate', 'monthlyRate', 'currentMileage', 'initialMileage',
    'purchaseDate', 'make', 'model', 'serialNumber', 'location',
  ] as const;

  function sanitizeEquipmentBody(body: Record<string, any>) {
    const out = { ...body };
    for (const field of EQUIPMENT_NULLABLE_FIELDS) {
      if (out[field] === '') out[field] = null;
    }
    return out;
  }

  app.get('/api/equipment/:id', requireAuth, asyncRoute(async (req, res) => {
    const equip = await storage.getEquipment(parseInt(req.params.id));
    if (!equip) return res.status(404).json({ message: "Equipment not found" });
    res.json(equip);
  }));

  app.post(api.equipment.create.path, requireAdmin, async (req, res) => {
    try {
      const parsed = api.equipment.create.input.parse(sanitizeEquipmentBody(req.body));
      res.status(201).json(await storage.createEquipment(parsed));
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ message: 'Validation error', errors: error.errors });
      }
      console.error('Create equipment error:', error);
      res.status(500).json({ message: error?.message ?? 'Failed to create equipment' });
    }
  });

  app.put('/api/equipment/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const input = api.equipment.update.input.parse(sanitizeEquipmentBody(req.body));
      const equip = await storage.getEquipment(id);
      if (!equip) return res.status(404).json({ message: "Equipment not found" });
      res.json(await storage.updateEquipment(id, input));
    } catch (error) {
      console.error('Update equipment error:', error);
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to update equipment' });
    }
  });

  app.delete('/api/equipment/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const equip = await storage.getEquipment(id);
      if (!equip) return res.status(404).json({ message: "Equipment not found" });
      const [active] = await db.select({ count: count() }).from(rentals).where(and(eq(rentals.equipmentId, id), eq(rentals.status, 'ACTIVE')));
      if (active.count > 0) return res.status(409).json({ message: "Cannot delete equipment with active rentals" });
      await storage.deleteEquipment(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: 'Failed to delete equipment' });
    }
  });

  // ── RENTALS ───────────────────────────────────────────────────────────────

  // Generate next PO number for a given year: PO-YYYY-NNNN
  async function generatePoNumber(year: number): Promise<string> {
    const pattern = `PO-${year}-%`;
    const [rows] = await db.execute(sql`
      SELECT MAX(CAST(SUBSTRING_INDEX(po_number, '-', -1) AS UNSIGNED)) AS maxSeq
      FROM rentals
      WHERE po_number LIKE ${pattern}
    `);
    const maxSeq = (rows as unknown as any[])[0]?.maxSeq ?? 0;
    const next = (Number(maxSeq) || 0) + 1;
    return `PO-${year}-${String(next).padStart(4, "0")}`;
  }

  // Preview next PO number (for form auto-population)
  app.get('/api/rentals/next-po', requireAuth, async (req, res) => {
    try {
      const simDate = await getSimulationDate();
      const year = simDate.getFullYear();
      res.json({ poNumber: await generatePoNumber(year) });
    } catch (error) {
      res.status(500).json({ message: 'Failed to generate PO number' });
    }
  });

  // Backfill PO numbers for all rentals that have none (idempotent, admin only)
  app.post('/api/admin/backfill-po', requireAdmin, async (req, res) => {
    try {
      const [untagged] = await db.execute(sql`
        SELECT id, receive_date FROM rentals
        WHERE po_number IS NULL OR po_number = ''
        ORDER BY receive_date ASC, id ASC
      `);
      const rows = untagged as unknown as any[];
      if (rows.length === 0) return res.json({ updated: 0 });

      // Group by year
      const byYear = new Map<number, { id: number }[]>();
      for (const r of rows) {
        const year = r.receive_date
          ? new Date(r.receive_date).getFullYear()
          : new Date().getFullYear();
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year)!.push({ id: r.id });
      }

      let updated = 0;
      for (const [year, items] of Array.from(byYear.entries())) {
        // Find max existing sequence for this year
        const [existing] = await db.execute(sql`
          SELECT MAX(CAST(SUBSTRING_INDEX(po_number, '-', -1) AS UNSIGNED)) AS maxSeq
          FROM rentals WHERE po_number LIKE ${`PO-${year}-%`}
        `);
        let seq = (Number((existing as unknown as any[])[0]?.maxSeq) || 0);
        for (const item of items) {
          seq++;
          const po = `PO-${year}-${String(seq).padStart(4, "0")}`;
          await db.execute(sql`UPDATE rentals SET po_number = ${po} WHERE id = ${item.id}`);
          updated++;
        }
      }
      res.json({ updated });
    } catch (error) {
      res.status(500).json({ message: 'Backfill failed', error: String(error) });
    }
  });

  // Both of these ran unguarded while the route below them had a try/catch.
  // listRentals was throwing on every call (TiDB rejects the LATERAL joins
  // Drizzle's relational queries emit), and with nothing to catch it the
  // client saw a bare 500 rather than anything it could report.
  app.get(api.rentals.list.path, requireAuth, async (req, res) => {
    try {
      res.json(await storage.listRentals());
    } catch (error: any) {
      console.error("[RENTALS] list failed:", error);
      res.status(500).json({ message: error?.message ?? "Failed to list rentals" });
    }
  });

  app.post(api.rentals.create.path, requireAdmin, async (req, res) => {
    try {
      const input = api.rentals.create.input.parse(req.body);
      const equip = await storage.getEquipment(input.equipmentId);
      if (!equip || equip.status !== "AVAILABLE") {
        return res.status(400).json({ message: "Equipment unavailable" });
      }
      // Auto-generate PO number if not provided
      if (!input.poNumber) {
        const simDate = await getSimulationDate();
        (input as any).poNumber = await generatePoNumber(simDate.getFullYear());
      }
      const rental = await storage.createRental(input);
      await storage.updateEquipment(input.equipmentId, { status: "RENTED" });
      res.status(201).json(rental);
    } catch (error: any) {
      // A schema rejection is the caller's problem and belongs in the 400 the
      // client already knows how to display; anything else is ours.
      const isValidation = error?.name === "ZodError";
      console.error("[RENTALS] create failed:", error);
      res.status(isValidation ? 400 : 500).json({
        message: isValidation
          ? "Rental details are not valid: " +
            (error.errors ?? []).map((e: any) => `${e.path.join(".")} ${e.message}`).join("; ")
          : error?.message ?? "Failed to create rental",
      });
    }
  });

  app.put('/api/rentals/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const input = api.rentals.update.input.parse(req.body);
      const rental = await storage.getRental(id);
      if (!rental) return res.status(404).json({ message: "Rental not found" });
      res.json(await storage.updateRental(id, input));
    } catch (error) {
      console.error('Update rental error:', error);
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to update rental' });
    }
  });

  app.get('/api/rentals/:id', requireAuth, asyncRoute(async (req, res) => {
    const rental = await storage.getRental(parseInt(req.params.id));
    if (!rental) return res.status(404).json({ message: "Rental not found" });
    res.json(rental);
  }));

  app.post(api.rentals.complete.path, requireAdmin, asyncRoute(async (req, res) => {
    const rental = await storage.getRental(parseInt(req.params.id));
    if (!rental) return res.status(404).json({ message: "Rental not found" });
    const cursor = await getSimulationDate();
    const returnDate = cursor.toISOString().split('T')[0];
    await storage.updateRental(rental.id, { status: "COMPLETED", returnDate });

    // Hours accumulation model:
    //   transport   = round-trip to jobsite (delivery + pickup)
    //   daily ops   = on-site operating hours per day (category-dependent)
    //   idle standby= 15% of daily ops for engine warm-up, repositioning, idle time
    //   weather days= ~10% of rental days lost to weather/downtime (reduces ops hours)
    const DAILY_OPS_HOURS: Record<string, number> = {
      "Skid Steer": 7.5,  // highly mobile, used all day across site
      "Backhoe":    6.5,  // split between digging and repositioning
      "Excavator":  6.0,  // mostly stationary per cycle, moves between zones
      "Crane":      5.0,  // rigging/lift time; long setup reduces operating hours
    };
    const TRANSPORT_HOURS_PER_MILE = 0.05; // ~20mph average for equipment transport
    const distanceMiles  = parseFloat(rental.jobSite?.distanceMiles ?? "25");
    const receiveDate    = new Date(rental.receiveDate);
    const rentalDays     = Math.max(1, Math.round((cursor.getTime() - receiveDate.getTime()) / 86400000));
    const category       = rental.equipment?.category ?? "";
    const dailyOps       = DAILY_OPS_HOURS[category] ?? 6.0;
    const effectiveDays  = rentalDays * 0.90;                             // 10% weather/downtime
    const transportHours = distanceMiles * 2 * TRANSPORT_HOURS_PER_MILE; // round-trip
    const opsHours       = effectiveDays * dailyOps;
    const idleHours      = opsHours * 0.15;                              // 15% standby/idle
    const hoursAdded     = parseFloat((transportHours + opsHours + idleHours).toFixed(1));
    const receiveHours   = parseFloat(rental.receiveHours ?? rental.equipment?.currentMileage ?? "0");
    const returnHours    = parseFloat((receiveHours + hoursAdded).toFixed(1));

    await storage.updateEquipment(rental.equipmentId, {
      status: "AVAILABLE",
      currentMileage: returnHours.toFixed(1),
    });
    await storage.updateRental(rental.id, { returnHours: returnHours.toFixed(1) });

    res.json({ message: "Rental completed successfully" });
  }));

  // ── INVOICES ─────────────────────────────────────────────────────────────
  app.post('/api/invoices', requireAdmin, async (req, res) => {
    try {
      const { rentalId, periodFrom, periodTo, amount, invoiceNumber } = req.body;
      if (!rentalId || !periodFrom || !periodTo || amount == null || !invoiceNumber) {
        return res.status(400).json({ message: 'Missing required invoice fields' });
      }
      const rental = await storage.getRental(rentalId);
      if (!rental) return res.status(404).json({ message: 'Rental not found' });
      if (rental.invoices?.length) {
        return res.status(409).json({ message: 'Invoice already exists for this rental' });
      }
      const cursor = await getSimulationDate();
      const invoiceDate = cursor.toISOString().split('T')[0];
      const invoice = await storage.createInvoice({ rentalId, invoiceDate: new Date(invoiceDate), periodFrom, periodTo, amount: String(amount), invoiceNumber });
      res.status(201).json(invoice);
    } catch (e: any) {
      res.status(500).json({ message: 'Failed to create invoice', error: e.message });
    }
  });

  app.delete('/api/rentals/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rental = await storage.getRental(id);
      if (!rental) return res.status(404).json({ message: "Rental not found" });
      if (rental.status === 'ACTIVE') {
        return res.status(409).json({ message: "Cannot delete an active rental. Complete or cancel it first." });
      }
      await storage.deleteRental(id);
      res.json({ message: "Rental deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: 'Failed to delete rental' });
    }
  });

  // ── JOB SITES ─────────────────────────────────────────────────────────────
  app.get(api.jobSites.list.path, requireAuth, async (req, res) => {
    try {
      const sites = await storage.listJobSites();
      const sitesWithCounts = await Promise.all(sites.map(async (site) => {
        const [result] = await db.select({ count: count() }).from(rentals).where(eq(rentals.jobSiteId, site.id));
        return { ...site, _count: { rentals: result?.count || 0 } };
      }));
      res.json(sitesWithCounts);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch job sites' });
    }
  });

  app.get('/api/job-sites/:id', requireAuth, async (req, res) => {
    try {
      const site = await storage.getJobSite(parseInt(req.params.id));
      if (!site) return res.status(404).json({ message: "Job site not found" });
      res.json(site);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch job site' });
    }
  });

  app.post(api.jobSites.create.path, requireAdmin, async (req, res) => {
    try {
      res.status(201).json(await storage.createJobSite(api.jobSites.create.input.parse(req.body)));
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to create job site' });
    }
  });

  app.patch('/api/job-sites/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const site = await storage.getJobSite(id);
      if (!site) return res.status(404).json({ message: "Job site not found" });
      res.json(await storage.updateJobSite(id, api.jobSites.update.input.parse(req.body)));
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to update job site' });
    }
  });

  app.delete('/api/job-sites/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [result] = await db.select({ count: count() }).from(rentals).where(eq(rentals.jobSiteId, id));
      if (result.count > 0) return res.status(409).json({ message: "Cannot delete job site with associated rentals" });
      await storage.deleteJobSite(id);
      res.json({ message: "Job site deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: 'Failed to delete job site' });
    }
  });

  // ── VENDORS ───────────────────────────────────────────────────────────────
  app.get(api.vendors.list.path, requireAuth, async (req, res) => {
    try {
      const vendors = await storage.listVendors();
      const vendorsWithCounts = await Promise.all(vendors.map(async (vendor) => {
        const [result] = await db.select({ count: count() }).from(rentals).where(eq(rentals.vendorId, vendor.id));
        return { ...vendor, _count: { rentals: result?.count || 0 } };
      }));
      res.json(vendorsWithCounts);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch vendors' });
    }
  });

  app.get('/api/vendors/:id', requireAuth, async (req, res) => {
    try {
      const vendor = await storage.getVendor(parseInt(req.params.id));
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      res.json(vendor);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch vendor' });
    }
  });

  app.post(api.vendors.create.path, requireAdmin, async (req, res) => {
    try {
      res.status(201).json(await storage.createVendor(api.vendors.create.input.parse(req.body)));
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to create vendor' });
    }
  });

  app.patch('/api/vendors/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const vendor = await storage.getVendor(id);
      if (!vendor) return res.status(404).json({ message: "Vendor not found" });
      res.json(await storage.updateVendor(id, api.vendors.update.input.parse(req.body)));
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to update vendor' });
    }
  });

  app.delete('/api/vendors/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [result] = await db.select({ count: count() }).from(rentals).where(eq(rentals.vendorId, id));
      if (result.count > 0) return res.status(409).json({ message: "Cannot delete vendor with associated rentals" });
      await storage.deleteVendor(id);
      res.json({ message: "Vendor deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: 'Failed to delete vendor' });
    }
  });

  // ── MAINTENANCE ───────────────────────────────────────────────────────────
  app.get('/api/maintenance', requireAuth, async (req, res) => {
    try {
      const { equipmentId, limit: limitStr, offset: offsetStr, sortBy, sortDir } = req.query;
      const limit  = Math.min(Math.max(1, parseInt(limitStr  as string || '10', 10)), 500);
      const offset = Math.max(0, parseInt(offsetStr as string || '0', 10));
      const condition = equipmentId
        ? eq(maintenanceEvents.equipmentId, parseInt(equipmentId as string))
        : undefined;

      const colMap: Record<string, any> = {
        maintenanceDate: maintenanceEvents.maintenanceDate,
        maintenanceType: maintenanceEvents.maintenanceType,
        cost:            maintenanceEvents.cost,
        nextDueDate:     maintenanceEvents.nextDueDate,
        eventSource:     maintenanceEvents.eventSource,
        performedBy:     maintenanceEvents.performedBy,
      };
      const col = colMap[sortBy as string] ?? maintenanceEvents.maintenanceDate;
      const orderFn = (sortDir as string) === 'asc' ? asc : desc;

      const [countRows, events] = await Promise.all([
        db.select({ total: count() }).from(maintenanceEvents).where(condition),
        db.select().from(maintenanceEvents)
          .where(condition)
          .orderBy(orderFn(col))
          .limit(limit)
          .offset(offset),
      ]);

      res.json({ events, total: countRows[0].total, limit, offset });
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch maintenance events' });
    }
  });

  // ── SENSOR INGESTION ──────────────────────────────────────────────────────
  // The front door for real fleet data. Accepts a CSV body (text/csv) or
  // JSON { readings: [...] }. Validation is all-or-nothing and re-uploading
  // the same file is safe -- see services/sensor-ingest.ts for why both.
  app.post('/api/sensor-readings', requireAdmin, async (req, res) => {
    try {
      const isCsv = typeof req.body === 'string';

      let records: { value: Record<string, unknown>; row: number }[];
      let parseErrors: { row: number; message: string }[] = [];

      if (isCsv) {
        ({ records, errors: parseErrors } = csvToRecords(req.body as string));
      } else {
        const readings = (req.body as any)?.readings;
        if (!Array.isArray(readings)) {
          return res.status(400).json({
            message: 'Send a CSV body with Content-Type text/csv, or JSON { readings: [...] }',
          });
        }
        // Row numbers are 1-based and count a header, so a JSON array's
        // first element is "row 2" and matches what a CSV would report.
        records = readings.map((value: Record<string, unknown>, i: number) => ({
          value,
          row: i + 2,
        }));
      }

      if (parseErrors.length > 0) {
        return res.status(400).json({
          message: 'Could not read the file',
          inserted: 0,
          duplicates: 0,
          errors: parseErrors,
        });
      }

      const result = await ingestReadings(records);
      if (result.errors.length > 0) {
        return res.status(400).json({
          message: `Rejected: ${result.errors.length} problem(s) found. Nothing was imported.`,
          ...result,
        });
      }

      res.status(201).json({
        message:
          `Imported ${result.inserted} reading(s)` +
          (result.duplicates > 0 ? `, skipped ${result.duplicates} already stored` : ''),
        ...result,
      });
    } catch (error: any) {
      console.error('[sensor-ingest]', error);
      res.status(500).json({ message: error?.message ?? 'Failed to import readings' });
    }
  });

  // Columns the uploader accepts, so the UI can show a template rather than
  // making someone guess the header names.
  app.get('/api/sensor-readings/template', requireAuth, (_req, res) => {
    res.type('text/csv').send(
      'equipment_id,timestamp,engine_rpm,engine_temp,oil_pressure,coolant_temp,' +
      'fuel_consumption,hydraulic_pressure,hydraulic_temp,hydraulic_flow_rate,' +
      'vibration_x,vibration_y,vibration_z,operating_hours,load_percentage,' +
      'idle_time,ambient_temp,error_codes,warning_count\n'
    );
  });

  app.post('/api/maintenance', requireAdmin, async (req, res) => {
    try {
      const input = req.body;

      // Auto-calculate nextDueDate from simulation cursor when not provided
      if (!input.nextDueDate) {
        const simDate = await getSimulationDate();
        const intervals: Record<string, number> = {
          MAJOR_SERVICE: 180,
          MINOR_SERVICE: 90,
          INSPECTION: 60,
        };
        const days = intervals[input.maintenanceType] ?? 90;
        const base = new Date(input.maintenanceDate || simDate);
        base.setDate(base.getDate() + days);
        input.nextDueDate = base.toISOString().split('T')[0];
      }

      const event = await storage.createMaintenanceEvent(input);

      // Non-blocking multi-horizon rescore — fires after response is sent
      setImmediate(async () => {
        try {
          const snapshotDate = await getSimulationDate();
          const snapshot = await enhancedFeatureService.generateSnapshot(input.equipmentId, snapshotDate);
          // Same clamped payload the batch path builds; one definition in
          // services/multi-horizon-scoring.ts so the bounds cannot drift apart.
          const payload = toMlSnapshot(input.equipmentId, snapshot);

          const fastapiRes = await mlFetch('/predict/multi-horizon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (fastapiRes.ok) {
            const pred = await fastapiRes.json();
            const p = pred.predictions;
            await db.insert(equipmentFailurePredictions).values({
              equipmentId:    input.equipmentId,
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
            console.log(`[MAINTENANCE] Risk rescore complete for EQ-${input.equipmentId}`);
          }
        } catch (e) {
          console.warn(`[MAINTENANCE] Risk rescore failed for EQ-${input.equipmentId}:`, e);
        }
      });

      res.status(201).json(event);
    } catch (error) {
      console.error('Create maintenance error:', error);
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to create maintenance event' });
    }
  });

  app.put('/api/maintenance/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: 'Invalid maintenance event ID' });
      const updated = await storage.updateMaintenanceEvent(id, req.body);
      res.json(updated);
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to update maintenance event' });
    }
  });

  app.delete('/api/maintenance/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: 'Invalid maintenance event ID' });
      await storage.deleteMaintenanceEvent(id);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ message: (error instanceof Error ? error.message : String(error)) || 'Failed to delete maintenance event' });
    }
  });

  app.get('/api/maintenance/equipment/:id', requireAuth, async (req, res) => {
    try {
      res.json(await storage.getMaintenanceHistory(parseInt(req.params.id)));
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch maintenance history' });
    }
  });

  // ── RISK SCORING — multi-horizon ──────────────────────────────────────────
  app.post('/api/risk-score/multi-horizon/batch', requireAuth, async (req, res) => {
    try {
      const { equipmentIds } = api.riskScore.batch.input.parse(req.body);

      // The work lives in services/multi-horizon-scoring.ts so the seed can
      // run it too. While it was inline here, the only way to populate
      // equipment_failure_predictions was for someone to press a button --
      // and that table backs the Fleet Command Center, so a freshly seeded
      // system opened on "No predictions yet".
      const outcome = await scoreFleetMultiHorizon(equipmentIds);

      if (!outcome.serviceAvailable) {
        return res.status(503).json({
          message:
            'The ML service is not responding. On free hosting it suspends when idle — ' +
            'give it a minute and try again.',
          detail: outcome.firstError,
        });
      }
      if (outcome.results.length === 0 && outcome.attempted > 0) {
        return res.status(502).json({
          message: `Scored 0 of ${outcome.attempted} assets. ${outcome.firstError ?? 'No reason reported.'}`,
        });
      }

      // The shape callers already expect: the results array, nothing more.
      res.json(outcome.results);
    } catch (error: any) {
      console.error('Multi-horizon batch error:', error);
      res.status(500).json({ message: error?.message ?? 'Failed to calculate multi-horizon predictions' });
    }
  });

  app.get('/api/risk-score/multi-horizon/latest', requireAuth, async (req, res) => {
    try {
      const [stateRows] = await db.execute(sql`SELECT cursor_date FROM simulation_state WHERE id = 1`) as any;
      const cursorStr: string = stateRows[0]?.cursor_date
        ? String(stateRows[0].cursor_date).substring(0, 10)
        : new Date().toISOString().split('T')[0];

      const [predRows] = await db.execute(sql`
        SELECT efp.*, e.name, e.equipment_id as equipment_code, e.category, e.status
        FROM equipment_failure_predictions efp
        JOIN equipment e ON e.id = efp.equipment_id
        WHERE efp.id IN (
          SELECT MAX(id) FROM equipment_failure_predictions GROUP BY equipment_id
        )
        ORDER BY efp.prob_30d DESC
      `) as any;

      const rows: any[] = predRows || [];
      if (rows.length === 0) { res.json([]); return; }

      // Get the BEST maintenance type logged by a user in the last 24h per equipment,
      // within 30 sim-days of the cursor.  Using the best type (not just most recent)
      // prevents oscillation when someone logs MINOR after MAJOR — the stronger
      // MAJOR discount sticks for the rest of the session window.
      const [maintRows] = await db.execute(sql`
        SELECT
          equipment_id,
          CASE MAX(CASE maintenance_type
                WHEN 'MAJOR_SERVICE' THEN 3
                WHEN 'MINOR_SERVICE' THEN 2
                ELSE 1
               END)
            WHEN 3 THEN 'MAJOR_SERVICE'
            WHEN 2 THEN 'MINOR_SERVICE'
            ELSE 'INSPECTION'
          END AS best_type,
          MIN(DATEDIFF(${cursorStr}, maintenance_date)) AS days_since
        FROM maintenance_events
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
          AND DATEDIFF(${cursorStr}, maintenance_date) BETWEEN 0 AND 30
        GROUP BY equipment_id
      `) as any;

      const maintMap = new Map<number, { type: string; days: number }>();
      for (const m of (maintRows || [])) {
        maintMap.set(Number(m.equipment_id), { type: m.best_type, days: Number(m.days_since) });
      }

      // Post-maintenance discount: reduce displayed probability to reflect that
      // the maintenance event addresses neglect/scheduling risk.  Physical wear
      // factors (age, hours) are unchanged, so we apply a partial reduction only.
      const HIGH = 0.60, MED = 0.30;
      const FACTORS: Record<string, number> = {
        MAJOR_SERVICE: 0.75,
        MINOR_SERVICE: 0.87,
        INSPECTION:    0.95,
      };
      const band = (p: number) => p >= HIGH ? 'HIGH' : p >= MED ? 'MEDIUM' : 'LOW';

      const result = rows.map((row: any) => {
        const maint = maintMap.get(Number(row.equipment_id));

        // Always enforce cumulative-probability monotonicity: P(fail≤10d) ≤ P(fail≤30d) ≤ P(fail≤60d)
        // Stale DB rows may violate this if they were stored before monotonicity enforcement was added.
        if (!maint) {
          const p10 = parseFloat(row.prob_10d);
          const p30 = Math.max(parseFloat(row.prob_30d), p10);
          const p60 = Math.max(parseFloat(row.prob_60d), p30);
          return {
            ...row,
            prob_10d:       p10.toFixed(4),
            prob_30d:       p30.toFixed(4),
            prob_60d:       p60.toFixed(4),
            risk_level_10d: band(p10),
            risk_level_30d: band(p30),
            risk_level_60d: band(p60),
            days_since_last_maint: null,
          };
        }

        const f = FACTORS[maint.type] ?? 1.0;
        const p10 = Math.max(0, parseFloat(row.prob_10d) * f);
        const p30 = Math.max(Math.max(0, parseFloat(row.prob_30d) * f), p10);
        const p60 = Math.max(Math.max(0, parseFloat(row.prob_60d) * f), p30);
        return {
          ...row,
          prob_10d:       p10.toFixed(4),
          prob_30d:       p30.toFixed(4),
          prob_60d:       p60.toFixed(4),
          risk_level_10d: band(p10),
          risk_level_30d: band(p30),
          risk_level_60d: band(p60),
          days_since_last_maint: maint.days,
        };
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch latest predictions' });
    }
  });

  // ── PREDICTION FEEDBACK LOOP ──────────────────────────────────────────────
  // Measures model effectiveness: of assets flagged HIGH risk (30d horizon)
  // in the last 90 days, what % had a PREDICTIVE_INTERVENTION maintenance event
  // within 30 days of the prediction?
  app.get('/api/analytics/feedback-loop', requireAuth, async (req, res) => {
    try {
      // Distinct equipment flagged HIGH (30d) in last 90 days + their first prediction date
      const [flaggedRows] = await db.execute(sql`
        SELECT equipment_id, MIN(predicted_at) AS first_flagged_at
        FROM equipment_failure_predictions
        WHERE risk_level_30d = 'HIGH'
          AND predicted_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
        GROUP BY equipment_id
      `) as any;

      const flagged: Array<{ equipment_id: number; first_flagged_at: string }> = flaggedRows || [];
      const totalFlagged = flagged.length;

      if (totalFlagged === 0) {
        res.json({ totalFlagged: 0, actedOn: 0, rate: 0, windowDays: 30, lookbackDays: 90 });
        return;
      }

      // For each flagged equipment, check for a PREDICTIVE_INTERVENTION event
      // within 30 days of its first HIGH prediction
      const [actionRows] = await db.execute(sql`
        SELECT DISTINCT me.equipment_id
        FROM maintenance_events me
        JOIN (
          SELECT equipment_id, MIN(predicted_at) AS first_flagged_at
          FROM equipment_failure_predictions
          WHERE risk_level_30d = 'HIGH'
            AND predicted_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
          GROUP BY equipment_id
        ) fp ON me.equipment_id = fp.equipment_id
        WHERE me.event_source = 'PREDICTIVE_INTERVENTION'
          AND me.maintenance_date >= DATE(fp.first_flagged_at)
          AND DATEDIFF(me.maintenance_date, DATE(fp.first_flagged_at)) <= 30
      `) as any;

      const actedOn = (actionRows || []).length;
      const rate = Math.round((actedOn / totalFlagged) * 100);

      // Total PREDICTIVE_INTERVENTION events in the lookback window (any risk level)
      const [totalIntervRows] = await db.execute(sql`
        SELECT COUNT(*) AS cnt
        FROM maintenance_events
        WHERE event_source = 'PREDICTIVE_INTERVENTION'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
      `) as any;

      res.json({
        totalFlagged,
        actedOn,
        rate,
        totalPredictiveInterventions: Number((totalIntervRows as any[])[0]?.cnt ?? 0),
        windowDays: 30,
        lookbackDays: 90,
      });
    } catch (error) {
      res.status(500).json({ message: 'Failed to compute feedback loop metrics' });
    }
  });

  // ── PREDICTIVE MAINTENANCE ────────────────────────────────────────────────
  app.get('/api/equipment/:id/risk', requireAuth, async (req, res) => {
    try {
      const equipmentId = parseInt(req.params.id);
      let prediction = await predictiveMaintenanceService.getLatestPrediction(equipmentId);
      if (!prediction) prediction = await predictiveMaintenanceService.predictRisk(equipmentId);
      res.json(prediction);
    } catch (error) {
      res.status(500).json({ message: 'Failed to get risk prediction' });
    }
  });

  app.post('/api/predictive-maintenance/predict-all', requireAdmin, async (req, res) => {
    try {
      const outcome = await predictiveMaintenanceService.predictAllEquipmentWithOutcome();
      const { predictions, attempted, serviceAvailable, firstError } = outcome;

      // A batch of zero used to return 200 with "Generated 0 predictions",
      // which reads as success. The three reasons it can be zero need
      // different actions, so they get different answers.
      if (!serviceAvailable) {
        return res.status(503).json({
          message:
            'The ML service is not responding. On free hosting it suspends when idle — ' +
            'give it a minute and try again.',
          count: 0,
          predictions: [],
        });
      }
      if (attempted > 0 && predictions.length === 0) {
        return res.status(502).json({
          message: `Scored 0 of ${attempted} assets. ${firstError ?? 'No reason reported.'}`,
          count: 0,
          predictions: [],
        });
      }

      res.json({
        message:
          predictions.length === attempted
            ? `Generated ${predictions.length} predictions`
            : `Generated ${predictions.length} of ${attempted} predictions. ${firstError ?? ''}`.trim(),
        count: predictions.length,
        attempted,
        predictions,
      });
    } catch (error: any) {
      console.error('[PREDICT-ALL]', error);
      res.status(500).json({ message: error?.message ?? 'Failed to run batch predictions' });
    }
  });

  app.get('/api/predictive-maintenance/fleet-risk', requireAuth, async (req, res) => {
    try {
      res.json(await predictiveMaintenanceService.getFleetRiskDistribution());
    } catch (error) {
      res.status(500).json({ message: 'Failed to get fleet risk distribution' });
    }
  });

  app.post('/api/predictive-maintenance/generate-snapshots', requireAdmin, async (req, res) => {
    try {
      if (req.body.snapshotDate) {
        const snapshotDate = new Date(req.body.snapshotDate);
        const snapshots = await featureEngineeringService.generateSnapshotsForAllEquipment(snapshotDate);
        for (const snapshot of snapshots) await featureEngineeringService.saveSnapshot(snapshot);
        return res.json({ message: `Generated ${snapshots.length} feature snapshots`, count: snapshots.length });
      }

      const SNAPSHOT_INTERVAL_DAYS = 7;
      // Use earliest maintenance event as the data anchor — sensor_data_logs is not used
      const [maintRangeRow] = await db.execute(sql`SELECT MIN(DATE(maintenance_date)) as earliest FROM maintenance_events`) as any;
      const earliest = maintRangeRow[0]?.earliest ? new Date(maintRangeRow[0].earliest) : new Date('2028-01-01');
      const latest = await getSimulationDate();

      const [existingRows] = await db.execute(sql`SELECT DISTINCT DATE(snapshot_ts) as snap_date FROM asset_feature_snapshots`) as any;
      const existingDates = new Set((existingRows as any[]).map((r: any) => new Date(r.snap_date).toISOString().split('T')[0]));

      const datesToProcess: Date[] = [];
      const cursor = new Date(earliest);
      cursor.setDate(cursor.getDate() + 180);
      while (cursor <= latest) {
        const dateStr = cursor.toISOString().split('T')[0];
        if (!existingDates.has(dateStr)) datesToProcess.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + SNAPSHOT_INTERVAL_DAYS);
      }

      console.log(`[BACKFILL] ${datesToProcess.length} dates to process`);

      const BATCH_SIZE = 10;
      let totalGenerated = 0;
      let totalFailed = 0;

      for (let i = 0; i < datesToProcess.length; i += BATCH_SIZE) {
        await Promise.all(datesToProcess.slice(i, i + BATCH_SIZE).map(async (snapshotDate) => {
          try {
            const snapshots = await featureEngineeringService.generateSnapshotsForAllEquipment(snapshotDate);
            for (const snapshot of snapshots) await featureEngineeringService.saveSnapshot(snapshot);
            totalGenerated += snapshots.length;
          } catch (err) {
            totalFailed++;
          }
        }));
        if ((i / BATCH_SIZE) % 5 === 0) console.log(`[BACKFILL] Progress: ${Math.min(i + BATCH_SIZE, datesToProcess.length)}/${datesToProcess.length}`);
      }

      res.json({ message: 'Historical backfill complete', count: totalGenerated, datesProcessed: datesToProcess.length, failed: totalFailed });
    } catch (error) {
      res.status(500).json({ message: 'Failed to generate snapshots' });
    }
  });

  app.post('/api/predictive-maintenance/label-snapshots', requireAdmin, async (req, res) => {
    try {
      const labeled = await featureEngineeringService.labelSnapshots();
      res.json({ message: `Labeled ${labeled} historical snapshots`, count: labeled });
    } catch (error) {
      res.status(500).json({ message: 'Failed to label snapshots' });
    }
  });

  app.get('/api/predictive-maintenance/equipment-with-risk', requireAuth, async (req, res) => {
    try {
      const allEquipment = await db.select().from(equipment);
      const equipmentWithRisk = await Promise.all(allEquipment.map(async (equip) => {
        const prediction = await predictiveMaintenanceService.getLatestPrediction(equip.id);
        return { ...equip, risk: prediction ? { riskBand: prediction.riskBand, failureProbability: prediction.failureProbability, recommendation: prediction.recommendation, predictedAt: prediction.snapshotTs, topDrivers: prediction.topDrivers } : null };
      }));
      res.json(equipmentWithRisk);
    } catch (error) {
      res.status(500).json({ message: 'Failed to get equipment with risk' });
    }
  });

  // ── ML METRICS ────────────────────────────────────────────────────────────
  // Per-horizon binary metrics from the long-format model_metrics table.
  // Every number is stored under its real name (ROC-AUC as ROC-AUC, failure-class
  // precision as precision) — no re-labeling, no fabricated fallbacks (ML-9).
  app.get('/api/ml/model-metrics', requireAuth, async (req, res) => {
    try {
      const { modelMetrics } = await import('@shared/schema');
      const [latest] = await db
        .select({
          modelVersion: modelMetrics.modelVersion,
          trainedAt: modelMetrics.trainedAt,
          datasetSize: modelMetrics.datasetSize,
        })
        .from(modelMetrics)
        .orderBy(desc(modelMetrics.trainedAt))
        .limit(1);

      // Honest empty state: no trained model → say so, invent nothing.
      if (!latest) {
        return res.json({ available: false, dataSource: 'simulated' });
      }

      const rows = await db
        .select()
        .from(modelMetrics)
        .where(eq(modelMetrics.modelVersion, latest.modelVersion));

      // Pivot long-format rows → { '10': { rocAuc, ... }, '30': ..., '60': ... }
      const metricKeyMap: Record<string, string> = {
        roc_auc: 'rocAuc', pr_auc: 'prAuc', accuracy: 'accuracy',
        train_accuracy: 'trainAccuracy',
        cv_roc_auc_mean: 'cvRocAucMean', cv_roc_auc_std: 'cvRocAucStd',
        precision_failure: 'precisionFailure', recall_failure: 'recallFailure',
        f1_failure: 'f1Failure',
        precision_no_failure: 'precisionNoFailure', recall_no_failure: 'recallNoFailure',
        positive_rate_dev: 'positiveRateDev', positive_rate_test: 'positiveRateTest',
        samples_train: 'samplesTrain', samples_test: 'samplesTest',
        positive_rate: 'positiveRate',
        // Operator metrics (ML-3): evaluated at the HIGH-band operating point
        recall_failure_operating: 'recallFailureOperating',
        precision_at_budget: 'precisionAtBudget',
        lead_time_median_days: 'leadTimeMedianDays',
        lead_time_failures_flagged_pct: 'leadTimeFailuresFlaggedPct',
        // Calibration quality (ML-5)
        brier: 'brier',
        ece: 'ece',
      };
      // temporal split → horizons; by_asset split (GroupKFold over equipment,
      // the "new fleet, day one" question) → horizonsByAsset
      const horizons: Record<string, any> = {};
      const horizonsByAsset: Record<string, any> = {};
      for (const row of rows) {
        const target = row.split === 'temporal' ? horizons
          : row.split === 'by_asset' ? horizonsByAsset : null;
        if (!target) continue;
        const h = String(row.horizonDays);
        target[h] = target[h] ?? (row.split === 'temporal' ? { confusion: { tn: 0, fp: 0, fn: 0, tp: 0 } } : {});
        const value = Number(row.value);
        if (row.metric.startsWith('confusion_')) {
          target[h].confusion[row.metric.replace('confusion_', '')] = value;
        } else if (metricKeyMap[row.metric]) {
          target[h][metricKeyMap[row.metric]] = value;
        }
      }

      const predictionHistory = await db.execute(sql`
        SELECT DATE_FORMAT(predicted_at, '%Y-%m') as month, COUNT(*) as total,
          SUM(CASE WHEN risk_band = 'HIGH' THEN 1 ELSE 0 END) as high,
          SUM(CASE WHEN risk_band = 'MEDIUM' THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN risk_band = 'LOW' THEN 1 ELSE 0 END) as low
        FROM asset_risk_predictions
        GROUP BY DATE_FORMAT(predicted_at, '%Y-%m') ORDER BY month DESC LIMIT 12
      `);

      const featureLabels: Record<string, string> = {
        asset_age_years: 'Equipment Age', log_maintenance_cost_180d: 'Maintenance Cost 180d (log)',
        wear_rate_velocity: 'Wear Rate Velocity', log_total_hours_lifetime: 'Lifetime Hours (log)',
        log_mean_time_between_failures: 'MTBF (log)', mechanical_wear_score: 'Mechanical Wear Score',
        neglect_score: 'Maintenance Neglect Score', aging_factor: 'Aging Factor',
        log_cost_per_event: 'Cost Per Event (log)', days_since_last_maintenance: 'Days Since Last Service',
        wear_rate: 'Wear Rate', maintenance_events_90d: 'Maintenance Events 90d',
        category_encoded: 'Equipment Category', abuse_score: 'Operational Stress Score',
        vendor_reliability_score: 'Vendor Reliability Score', jobsite_risk_score: 'Job Site Risk Score',
        usage_trend: 'Usage Trend', usage_intensity: 'Usage Intensity',
        maint_frequency_trend: 'Maintenance Frequency Trend', cost_trend: 'Cost Trend',
        hours_velocity: 'Hours Velocity', neglect_acceleration: 'Neglect Acceleration',
        sensor_degradation_rate: 'Sensor Degradation Rate',
      };
      const featureDescriptions: Record<string, string> = {
        asset_age_years: 'Years since manufacture', log_maintenance_cost_180d: 'Log maintenance cost trajectory',
        log_total_hours_lifetime: 'Log cumulative operating hours',
        log_mean_time_between_failures: 'Log mean time between failures', mechanical_wear_score: 'Composite wear indicator (0-10)',
        neglect_score: 'Maintenance neglect composite (0-10)', days_since_last_maintenance: 'Days since last service',
        wear_rate: 'Rate of mechanical wear accumulation', vendor_reliability_score: 'Vendor failure frequency score (0-1)',
        jobsite_risk_score: 'Site utilization intensity risk (0-1)', usage_trend: 'Usage trajectory vs historical baseline',
        usage_intensity: 'Daily hours relative to equipment class', wear_rate_velocity: 'Rate of change in wear accumulation',
        maint_frequency_trend: 'Trending maintenance frequency', cost_trend: 'Trending maintenance cost',
        hours_velocity: 'Rate of change in operating hours', neglect_acceleration: 'Accelerating neglect signal',
        sensor_degradation_rate: 'Sensor signal quality degradation rate',
      };
      // Feature importance + hyperparameters come live from the ML service.
      // If it's unreachable they are empty/null — never hardcoded defaults.
      let featureImportance: { feature: string; importance: number; description: string }[] = [];
      let hyperparameters: {
        algorithm: string; nEstimators: number | null; maxDepth: number | null;
        minSamplesSplit: number | null; classWeight: string | null;
      } | null = null;
      try {
        const fiRes = await mlFetch('/models/feature-importance');
        if (fiRes.ok) {
          const fiData = await fiRes.json() as { feature_importance: Record<string, number>; hyperparameters: Record<string, any> };
          featureImportance = Object.entries(fiData.feature_importance)
            .filter(([, v]) => v > 0.005)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([key, importance]) => ({
              feature: featureLabels[key] || key,
              importance,
              description: featureDescriptions[key] || key,
            }));
          if (fiData.hyperparameters && Object.keys(fiData.hyperparameters).length > 0) {
            hyperparameters = {
              algorithm: fiData.hyperparameters.algorithm ?? 'Random Forest (calibrated)',
              nEstimators: fiData.hyperparameters.n_estimators ?? null,
              maxDepth: fiData.hyperparameters.max_depth ?? null,
              minSamplesSplit: fiData.hyperparameters.min_samples_split ?? null,
              classWeight: fiData.hyperparameters.class_weight ?? null,
            };
          }
        }
      } catch (e) {
        // ML service unavailable — featureImportance stays [], hyperparameters null
      }

      res.json({
        available: true,
        // All current training data comes from the fleet simulator; metrics
        // verify the pipeline, not field performance. Surfaced in the UI.
        dataSource: 'simulated',
        version: latest.modelVersion,
        trainedAt: latest.trainedAt.toISOString(),
        datasetSize: latest.datasetSize,
        horizons,
        horizonsByAsset,
        featureImportance,
        predictionHistory: ((predictionHistory as any)[0] as any[]).map((row: any) => ({
          date: row.month, total: Number(row.total), high: Number(row.high), medium: Number(row.medium), low: Number(row.low),
        })),
        hyperparameters,
      });
    } catch (error) {
      console.error('Model metrics error:', error);
      res.status(500).json({ message: 'Failed to fetch model metrics' });
    }
  });

  // NOTE: the old GET /api/ml/feature-importance route was deleted (ML-9): it
  // returned hardcoded importances regardless of the trained model and had no
  // callers. Live importances come from /api/ml/model-metrics.

  app.get('/api/ml/pipeline-status', requireAuth, async (req, res) => {
    try {
      const { assetFeatureSnapshots, assetRiskPredictions } = await import('@shared/schema');
      const [snapshotStats] = await db.select({
        total: count(),
        labeled: sql<number>`SUM(CASE WHEN ${assetFeatureSnapshots.willFail30d} IS NOT NULL THEN 1 ELSE 0 END)`,
        unlabeled: sql<number>`SUM(CASE WHEN ${assetFeatureSnapshots.willFail30d} IS NULL THEN 1 ELSE 0 END)`,
      }).from(assetFeatureSnapshots);

      const [predictionStats] = await db.select({ total: count() }).from(assetRiskPredictions);
      const [snapshotDates] = await db.select({
        oldest: sql`MIN(${assetFeatureSnapshots.snapshotTs})`,
        newest: sql`MAX(${assetFeatureSnapshots.snapshotTs})`,
      }).from(assetFeatureSnapshots);
      const [predictionDates] = await db.select({
        oldest: sql`MIN(${assetRiskPredictions.predictedAt})`,
        newest: sql`MAX(${assetRiskPredictions.predictedAt})`,
      }).from(assetRiskPredictions);

      res.json({
        snapshots: {
          total: Number(snapshotStats?.total) || 0,
          labeled: Number(snapshotStats?.labeled) || 0,
          unlabeled: Number(snapshotStats?.unlabeled) || 0,
          oldestDate: snapshotDates?.oldest,
          newestDate: snapshotDates?.newest,
        },
        predictions: {
          total: Number(predictionStats?.total) || 0,
          oldestDate: predictionDates?.oldest,
          newestDate: predictionDates?.newest,
        },
        readyForTraining: (Number(snapshotStats?.labeled) || 0) > 100,
        modelStatus: await (async () => {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const registryPath = path.join(process.cwd(), 'ml-service', 'registry');
            const files = fs.readdirSync(registryPath).filter((f: string) => f.startsWith('rf_30d_') && f.endsWith('.pkl'));
            if (files.length === 0) return 'rule-based';
            // Numeric sort to get true latest version
            const sorted = files.sort((a, b) => {
              const ma = a.match(/v(\d+)\.(\d+)/);
              const mb = b.match(/v(\d+)\.(\d+)/);
              if (!ma || !mb) return 0;
              return (parseInt(ma[1]) * 1000 + parseInt(ma[2])) - (parseInt(mb[1]) * 1000 + parseInt(mb[2]));
            });
            const match = sorted[sorted.length - 1].match(/rf_30d_(v[\d.]+)\.pkl/);
            return match ? `ml-${match[1]}` : 'ml';
          } catch { return 'rule-based'; }
        })(),
      });
    } catch (error) {
      res.status(500).json({ message: 'Failed to get pipeline status' });
    }
  });

  // ── PROJECTION ────────────────────────────────────────────────────────────
  app.get("/api/equipment/:id/projection", requireAuth, async (req, res) => {
    try {
      const equipmentId = parseInt(req.params.id);
      if (isNaN(equipmentId)) return res.status(400).json({ message: "Invalid equipment ID" });

      const snapshotTs = await getSimulationDate();
      const snapshot = await enhancedFeatureService.generateSnapshot(equipmentId, snapshotTs);

      const mlPayload = {
        equipment_id: snapshot.equipmentId, snapshot_ts: snapshot.snapshotTs,
        category: snapshot.category, asset_age_years: snapshot.assetAgeYears,
        total_hours_lifetime: snapshot.totalHoursLifetime, hours_used_30d: snapshot.hoursUsed30d,
        hours_used_90d: snapshot.hoursUsed90d, rental_days_30d: snapshot.rentalDays30d,
        rental_days_90d: snapshot.rentalDays90d, avg_rental_duration: snapshot.avgRentalDuration,
        maintenance_events_90d: snapshot.maintenanceEvents90d, maintenance_cost_180d: snapshot.maintenanceCost180d,
        avg_downtime_per_event: snapshot.avgDowntimePerEvent, days_since_last_maintenance: snapshot.daysSinceLastMaintenance,
        mean_time_between_failures: snapshot.meanTimeBetweenFailures, vendor_reliability_score: snapshot.vendorReliabilityScore,
        jobsite_risk_score: snapshot.jobSiteRiskScore, usage_intensity: snapshot.usageIntensity,
        usage_trend: snapshot.usageTrend, utilization_vs_expected: snapshot.utilizationVsExpected,
        wear_rate: snapshot.wearRate, aging_factor: snapshot.agingFactor, maint_overdue: snapshot.maintOverdue,
        cost_per_event: snapshot.costPerEvent, maint_burden: snapshot.maintBurden,
        mechanical_wear_score: snapshot.mechanicalWearScore, abuse_score: snapshot.abuseScore,
        neglect_score: snapshot.neglectScore, wear_rate_velocity: snapshot.wearRateVelocity,
        maint_frequency_trend: snapshot.maintFrequencyTrend, cost_trend: snapshot.costTrend,
        hours_velocity: snapshot.hoursVelocity, neglect_acceleration: snapshot.neglectAcceleration,
        sensor_degradation_rate: snapshot.sensorDegradationRate,
      };

      const mlResponse = await mlFetch("/predict/project", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mlPayload),
      });

      if (!mlResponse.ok) {
        return res.status(502).json({
          message: `ML service error - ${await describeMlFailure(mlResponse, "/predict/project")}`,
        });
      }
      res.json(await mlResponse.json());
    } catch (err: any) {
      console.error("[PROJECTION] Error:", err);
      res.status(500).json({ message: err.message || "Projection failed" });
    }
  });

  // ── SENSOR TRENDS — daily aggregates for the asset detail page ────────────
  // Anchored to the simulation cursor like every other time-aware read.
  app.get("/api/equipment/:id/sensor-trends", requireAuth, async (req, res) => {
    try {
      const equipmentId = parseInt(req.params.id);
      if (isNaN(equipmentId)) return res.status(400).json({ message: "Invalid equipment ID" });
      const days = Math.min(Math.max(parseInt(String(req.query.days ?? "90")), 7), 365);

      const cursor = await getSimulationDate();
      const cursorStr = cursor.toISOString().split("T")[0];

      const [rows] = await db.execute(sql`
        SELECT
          DATE(timestamp)                                   AS day,
          ROUND(AVG(engine_temp), 1)                        AS engine_temp,
          ROUND(AVG(oil_pressure), 1)                       AS oil_pressure,
          ROUND(AVG(hydraulic_pressure), 1)                 AS hydraulic_pressure,
          ROUND(AVG(SQRT(
            COALESCE(vibration_x, 0) * COALESCE(vibration_x, 0) +
            COALESCE(vibration_y, 0) * COALESCE(vibration_y, 0) +
            COALESCE(vibration_z, 0) * COALESCE(vibration_z, 0)
          )), 3)                                            AS vibration,
          SUM(COALESCE(warning_count, 0))                   AS warnings
        FROM sensor_data_logs
        WHERE equipment_id = ${equipmentId}
          AND timestamp >= DATE_SUB(${cursorStr}, INTERVAL ${days} DAY)
          AND timestamp <= ${cursorStr}
        GROUP BY DATE(timestamp)
        ORDER BY day ASC
      `) as any;

      // MySQL returns DECIMAL/ROUND as strings — coerce so the client plots numbers.
      const points = (rows ?? []).map((r: any) => ({
        day: String(r.day instanceof Date ? r.day.toISOString().split("T")[0] : r.day),
        engine_temp: r.engine_temp === null ? null : Number(r.engine_temp),
        oil_pressure: r.oil_pressure === null ? null : Number(r.oil_pressure),
        hydraulic_pressure: r.hydraulic_pressure === null ? null : Number(r.hydraulic_pressure),
        vibration: r.vibration === null ? null : Number(r.vibration),
        warnings: r.warnings === null ? 0 : Number(r.warnings),
      }));

      res.json({ equipmentId, days, asOf: cursorStr, points });
    } catch (err: any) {
      console.error("[SENSOR-TRENDS] Error:", err);
      res.status(500).json({ message: err.message || "Sensor trends failed" });
    }
  });

  // ── FEATURE BASELINE — raw feature values vs. fleet average ───────────────
  // Backs the expandable SHAP bars: "your unit's wear score 7.9 vs fleet 4.1".
  // Values come from the latest persisted snapshot per unit — labeled as such,
  // not claimed to be the exact prediction-time payload.
  const BASELINE_FEATURES = [
    "asset_age_years", "total_hours_lifetime", "hours_used_30d", "hours_used_90d",
    "rental_days_30d", "rental_days_90d", "avg_rental_duration",
    "maintenance_events_90d", "maintenance_cost_180d", "avg_downtime_per_event",
    "days_since_last_maintenance", "mean_time_between_failures",
    "vendor_reliability_score", "jobsite_risk_score",
    "usage_intensity", "usage_trend", "utilization_vs_expected",
    "wear_rate", "aging_factor", "maint_overdue", "cost_per_event", "maint_burden",
    "mechanical_wear_score", "abuse_score", "neglect_score",
    "wear_rate_velocity", "maint_frequency_trend", "cost_trend",
    "hours_velocity", "neglect_acceleration", "sensor_degradation_rate",
  ] as const;

  app.get("/api/equipment/:id/feature-baseline", requireAuth, async (req, res) => {
    try {
      const equipmentId = parseInt(req.params.id);
      if (isNaN(equipmentId)) return res.status(400).json({ message: "Invalid equipment ID" });

      // Column list is a hardcoded whitelist above — safe to interpolate raw.
      const cols = BASELINE_FEATURES.join(", ");
      const avgCols = BASELINE_FEATURES.map((c) => `AVG(${c}) AS ${c}`).join(", ");

      const [unitRows] = await db.execute(sql.raw(`
        SELECT snapshot_ts, ${cols}
        FROM asset_feature_snapshots
        WHERE equipment_id = ${equipmentId}
        ORDER BY id DESC
        LIMIT 1
      `)) as any;

      if (!unitRows?.length) {
        res.json({ equipmentId, asOf: null, unit: {}, fleet: {} });
        return;
      }

      const [fleetRows] = await db.execute(sql.raw(`
        SELECT ${avgCols}
        FROM asset_feature_snapshots s
        JOIN (
          SELECT equipment_id, MAX(id) AS mid
          FROM asset_feature_snapshots
          GROUP BY equipment_id
        ) latest ON s.id = latest.mid
      `)) as any;

      const toNums = (row: any) =>
        Object.fromEntries(
          BASELINE_FEATURES
            .filter((c) => row[c] !== null && row[c] !== undefined)
            .map((c) => [c, Number(row[c])]),
        );

      res.json({
        equipmentId,
        asOf: unitRows[0].snapshot_ts,
        unit: toNums(unitRows[0]),
        fleet: toNums(fleetRows?.[0] ?? {}),
      });
    } catch (err: any) {
      console.error("[FEATURE-BASELINE] Error:", err);
      res.status(500).json({ message: err.message || "Feature baseline failed" });
    }
  });

  // ── FINANCIAL ─────────────────────────────────────────────────────────────
  app.get('/api/dashboard/revenue-summary', requireAuth, async (req, res) => {
    try {
      const cursor = await getSimulationDate();
      const cursorStr = cursor.toISOString().split('T')[0];

      // Revenue recognition rules:
      //   - Invoiced rentals   → recognized on invoice_date, amount = invoice amount
      //   - Completed, no invoice → recognized on return_date, amount = days × daily_rate
      //   - Active (uninvoiced) → not counted
      const [rows] = await db.execute(sql`
        SELECT
          COALESCE(SUM(CASE
            WHEN rec_date BETWEEN DATE_SUB(${cursorStr}, INTERVAL 29 DAY) AND ${cursorStr}
            THEN rec_amount ELSE 0 END), 0) AS revenue_30d,
          COALESCE(SUM(CASE
            WHEN rec_date BETWEEN DATE_SUB(${cursorStr}, INTERVAL 6 DAY) AND ${cursorStr}
            THEN rec_amount ELSE 0 END), 0) AS revenue_wtd,
          COALESCE(SUM(CASE
            WHEN is_outstanding THEN rec_amount ELSE 0 END), 0) AS outstanding_ar,
          (SELECT COUNT(*) FROM equipment) AS total_equipment,
          (SELECT COUNT(*) FROM equipment WHERE status = 'RENTED') AS rented_equipment
        FROM (
          -- Invoiced rentals: use invoice date + invoice amount
          SELECT i.invoice_date AS rec_date, i.amount AS rec_amount, 0 AS is_outstanding
          FROM invoices i
          JOIN rentals r ON r.id = i.rental_id
          WHERE i.invoice_date <= ${cursorStr}

          UNION ALL

          -- Completed rentals with no invoice: use return_date + computed amount
          SELECT
            r.return_date AS rec_date,
            (DATEDIFF(r.return_date, r.receive_date) + 1) * CAST(e.daily_rate AS DECIMAL(10,2)) AS rec_amount,
            1 AS is_outstanding
          FROM rentals r
          JOIN equipment e ON e.id = r.equipment_id
          WHERE r.status = 'COMPLETED'
            AND r.return_date IS NOT NULL
            AND r.return_date <= ${cursorStr}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.rental_id = r.id)
        ) AS recognized
      `) as any;

      const [uninvoicedRows] = await db.execute(sql`
        SELECT COUNT(*) AS uninvoiced_count
        FROM rentals r
        WHERE r.status = 'COMPLETED'
          AND r.receive_date IS NOT NULL AND r.return_date IS NOT NULL
          AND r.return_date >= r.receive_date
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.rental_id = r.id)
      `) as any;

      const [utilRows] = await db.execute(sql`
        SELECT COALESCE(
          SUM(GREATEST(0, DATEDIFF(
            LEAST(COALESCE(r.return_date, ${cursorStr}), ${cursorStr}),
            GREATEST(r.receive_date, DATE_SUB(${cursorStr}, INTERVAL 29 DAY))
          ) + 1)),
          0
        ) / NULLIF((SELECT COUNT(*) FROM equipment) * 30, 0) * 100 AS avg_utilization_30d
        FROM rentals r
        WHERE r.receive_date <= ${cursorStr}
          AND (r.return_date IS NULL OR r.return_date >= DATE_SUB(${cursorStr}, INTERVAL 29 DAY))
          AND r.status IN ('ACTIVE', 'COMPLETED')
      `) as any;

      const data = (rows as any[])[0];
      const uninvoicedCount = Number((uninvoicedRows as any[])[0]?.uninvoiced_count || 0);
      const avgUtilization30d = Number((utilRows as any[])[0]?.avg_utilization_30d || 0);

      res.json({
        revenue30d: Number(data.revenue_30d || 0),
        revenueWtd: Number(data.revenue_wtd || 0),
        outstandingAr: Number(data.outstanding_ar || 0),
        uninvoicedCount,
        totalEquipment: Number(data.total_equipment || 0),
        rentedEquipment: Number(data.rented_equipment || 0),
        utilizationRate: data.total_equipment > 0 ? (data.rented_equipment / data.total_equipment) * 100 : 0,
        avgUtilization30d,
      });
    } catch (e: any) {
      res.status(500).json({ message: 'Failed to fetch revenue summary', error: e.message });
    }
  });

  app.get('/api/dashboard/daily-revenue', requireAuth, async (req, res) => {
    try {
      const cursor = await getSimulationDate();
      // Work entirely in UTC-parsed date strings to avoid local-timezone shifts
      const cursorStr = cursor.toISOString().split('T')[0];
      const MS_PER_DAY = 86400000;
      const cursorMs = new Date(cursorStr + 'T00:00:00Z').getTime();
      const windowStartMs = cursorMs - 29 * MS_PER_DAY;
      const windowStartStr = new Date(windowStartMs).toISOString().split('T')[0];

      // Build 30-day bucket array (index 0 = oldest day)
      const days: string[] = [];
      for (let i = 0; i < 30; i++) {
        days.push(new Date(windowStartMs + i * MS_PER_DAY).toISOString().split('T')[0]);
      }
      const buckets: Record<string, number> = {};
      for (const d of days) buckets[d] = 0;

      // Fetch recognized revenue events in the window:
      //   - Invoiced rentals → on invoice_date
      //   - Completed uninvoiced → on return_date
      const [rows] = await db.execute(sql`
        SELECT rec_date, rec_amount FROM (
          SELECT i.invoice_date AS rec_date, i.amount AS rec_amount
          FROM invoices i
          JOIN rentals r ON r.id = i.rental_id
          WHERE i.invoice_date BETWEEN ${windowStartStr} AND ${cursorStr}

          UNION ALL

          SELECT
            r.return_date AS rec_date,
            (DATEDIFF(r.return_date, r.receive_date) + 1) * CAST(e.daily_rate AS DECIMAL(10,2)) AS rec_amount
          FROM rentals r
          JOIN equipment e ON e.id = r.equipment_id
          WHERE r.status = 'COMPLETED'
            AND r.return_date BETWEEN ${windowStartStr} AND ${cursorStr}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.rental_id = r.id)
        ) AS recognized
      `) as any;

      for (const row of rows as any[]) {
        const recDate: string = row.rec_date instanceof Date
          ? row.rec_date.toISOString().split('T')[0]
          : String(row.rec_date).substring(0, 10);
        if (buckets[recDate] !== undefined) {
          buckets[recDate] += Number(row.rec_amount || 0);
        }
      }

      res.json(days.map(day => ({ day, revenue: Math.round(buckets[day] * 100) / 100 })));
    } catch (e: any) {
      console.error('[daily-revenue]', e);
      res.status(500).json({ message: 'Failed to fetch daily revenue', error: e.message });
    }
  });

  app.get('/api/dashboard/monthly-trend', requireAuth, async (req, res) => {
    try {
      const cursor = await getSimulationDate();
      const cursorStr = cursor.toISOString().split('T')[0];

      // Build 12 calendar-month buckets ending at cursor month (oldest → newest)
      const months: string[] = [];
      const buckets: Record<string, number> = {};
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(cursor.getFullYear(), cursor.getMonth() - i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        months.push(key);
        buckets[key] = 0;
      }
      const windowStart = months[0] + '-01';

      // Fetch recognized revenue events in the 12-month window:
      //   - Invoiced rentals → on invoice_date
      //   - Completed uninvoiced → on return_date
      const [rows] = await db.execute(sql`
        SELECT rec_date, rec_amount FROM (
          SELECT i.invoice_date AS rec_date, i.amount AS rec_amount
          FROM invoices i
          JOIN rentals r ON r.id = i.rental_id
          WHERE i.invoice_date BETWEEN ${windowStart} AND ${cursorStr}

          UNION ALL

          SELECT
            r.return_date AS rec_date,
            (DATEDIFF(r.return_date, r.receive_date) + 1) * CAST(e.daily_rate AS DECIMAL(10,2)) AS rec_amount
          FROM rentals r
          JOIN equipment e ON e.id = r.equipment_id
          WHERE r.status = 'COMPLETED'
            AND r.return_date BETWEEN ${windowStart} AND ${cursorStr}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.rental_id = r.id)
        ) AS recognized
      `) as any;

      for (const row of (rows as any[])) {
        const recDate: string = row.rec_date instanceof Date
          ? row.rec_date.toISOString().split('T')[0]
          : String(row.rec_date).substring(0, 10);
        const monthKey = recDate.substring(0, 7);
        if (buckets[monthKey] !== undefined) {
          buckets[monthKey] += Number(row.rec_amount || 0);
        }
      }

      res.json(months.map(m => ({ month: m, revenue: Math.round(buckets[m]) })));
    } catch (e: any) {
      res.status(500).json({ message: 'Failed to fetch monthly trend', error: e.message });
    }
  });

  // ── ML TRAINING PROXY ─────────────────────────────────────────────────────
  app.post("/api/ml/train", requireAdmin, async (req, res) => {
    try {
      const mlRes = await mlFetch("/train", { method: "POST" }, { actorId: req.session.userId });
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: await mlRes.text() });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.get("/api/ml/train/status", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/train/status");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Status unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  // ── ML SERVICE REACHABILITY ──────────────────────────────────────────────
  //
  // The ML service sleeps independently of this API, so getting past the
  // startup gate says nothing about whether predictions, drift or scoring will
  // answer. Without somewhere to ask, a visitor who lands on an ML page during
  // that second cold start sees "Failed to fetch drift status" and reasonably
  // concludes the thing is broken.
  //
  // Cheap on purpose: /health is exempt from the service token, touches no
  // database, and is the same endpoint the host polls. The short timeout is
  // the point -- the answer wanted here is "is it up right now", not "wait for
  // it", because waiting is the caller's decision to make.
  app.get("/api/ml/health", requireAuth, async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const mlRes = await mlFetch("/health", { signal: controller.signal });
      if (!mlRes.ok) {
        return res.json({ reachable: false, reason: `returned ${mlRes.status}` });
      }
      const body = await mlRes.json().catch(() => ({}));
      res.json({
        reachable: true,
        modelVersion: (body as any)?.model_version ?? null,
        modelLoaded: (body as any)?.model_loaded ?? null,
      });
    } catch (err: any) {
      // An abort or a refused connection both mean "not up yet", which is a
      // normal state on free hosting rather than an error to surface as 500.
      res.json({
        reachable: false,
        reason: err?.name === "AbortError" ? "no answer within 4s" : "unreachable",
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // ── DRIFT MONITORING ─────────────────────────────────────────────────────
  app.get("/api/ml/drift/latest", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/drift/latest");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Drift data unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.post("/api/ml/drift/compute-reference", requireAdmin, async (req, res) => {
    try {
      const mlRes = await mlFetch("/drift/compute-reference", { method: "POST" }, { actorId: req.session.userId });
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: await mlRes.text() });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.get("/api/ml/drift/prediction", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/drift/prediction");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Prediction drift data unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.get("/api/ml/drift/bias", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/drift/bias");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Bias drift data unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.get("/api/ml/drift/summary", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/drift/summary");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Drift summary unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  // ── DATA QUALITY ─────────────────────────────────────────────────────────
  app.get("/api/ml/data-quality/report", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/data-quality/report");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Data quality report unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  // ── CHAMPION-CHALLENGER ───────────────────────────────────────────────────
  app.get("/api/ml/models/registry", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/models/registry");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Registry unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.get("/api/ml/models/compare", requireAuth, async (req, res) => {
    try {
      const mlRes = await mlFetch("/models/champion-challenger/compare");
      if (!mlRes.ok) return res.status(mlRes.status).json({ message: "Compare unavailable" });
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  app.post("/api/ml/models/promote", requireAdmin, async (req, res) => {
    try {
      const mlRes = await mlFetch("/models/promote", { method: "POST" }, { actorId: req.session.userId });
      if (!mlRes.ok) {
        const err = await mlRes.json().catch(() => ({}));
        return res.status(mlRes.status).json(err);
      }
      res.json(await mlRes.json());
    } catch (e: any) {
      res.status(500).json({ message: "ML service unreachable", error: e.message });
    }
  });

  // ── MAINTENANCE DUE SOON ──────────────────────────────────────────────────
  app.get('/api/maintenance/due-soon', requireAuth, async (req, res) => {
    try {
      const cursorDate = await getSimulationDate();
      const [rows] = await db.execute(sql`
        SELECT
          e.id,
          e.name,
          e.equipment_id   AS equipmentId,
          e.category,
          e.status,
          me.next_due_date AS nextDueDate,
          DATEDIFF(me.next_due_date, ${cursorDate}) AS daysUntilDue
        FROM equipment e
        -- The latest dated event per unit, as a derived table rather than a
        -- subquery in the ON clause. TiDB rejects the latter outright:
        --   ER_UNKNOWN_ERROR: ON condition doesn't support subqueries yet
        -- MySQL accepts it, so this only failed once deployed.
        JOIN (
          SELECT m.equipment_id, m.next_due_date
          FROM maintenance_events m
          JOIN (
            SELECT equipment_id, MAX(id) AS id
            FROM maintenance_events
            WHERE next_due_date IS NOT NULL
            GROUP BY equipment_id
          ) latest ON latest.id = m.id
        ) me ON me.equipment_id = e.id
        WHERE me.next_due_date <= DATE_ADD(${cursorDate}, INTERVAL 30 DAY)
        ORDER BY me.next_due_date ASC
      `);
      res.json((rows as unknown as any[]) || []);
    } catch (error) {
      // Logged because this returned 500 for days with no indication why.
      console.error('[due-soon]', error);
      res.status(500).json({ message: 'Failed to fetch due-soon maintenance' });
    }
  });

  // ── EQUIPMENT SWAPS ────────────────────────────────────────────────────────
  app.post('/api/rentals/:id/swap', requireAdmin, async (req, res) => {
    try {
      const rentalId = parseInt(req.params.id);
      const { replacementEquipmentId, reason, swappedBy, notes } = req.body;

      const rental = await storage.getRental(rentalId);
      if (!rental) return res.status(404).json({ message: 'Rental not found' });
      if (rental.status !== 'ACTIVE') return res.status(400).json({ message: 'Can only swap equipment on active rentals' });

      const replacement = await storage.getEquipment(replacementEquipmentId);
      if (!replacement) return res.status(404).json({ message: 'Replacement equipment not found' });
      if (replacement.status !== 'AVAILABLE') return res.status(400).json({ message: 'Replacement equipment is not available' });
      if (replacementEquipmentId === rental.equipmentId) return res.status(400).json({ message: 'Replacement must be different from current equipment' });

      const originalEquipmentId = rental.equipmentId;
      const simCursor = await getSimulationDate();
      const today = simCursor.toISOString().split('T')[0];

      await Promise.all([
        storage.updateEquipment(originalEquipmentId, { status: 'AVAILABLE' }),
        storage.updateEquipment(replacementEquipmentId, { status: 'RENTED' }),
        storage.updateRental(rentalId, { equipmentId: replacementEquipmentId }),
      ]);

      await storage.createSwap({
        rentalId,
        originalEquipmentId,
        replacementEquipmentId,
        swapDate: today,
        reason: reason || null,
        swappedBy: swappedBy || null,
        notes: notes || null,
      });

      res.json({ message: 'Equipment swapped successfully' });
    } catch (error) {
      console.error('Swap error:', error);
      res.status(500).json({ message: 'Failed to swap equipment' });
    }
  });

  app.get('/api/rentals/:id/swaps', requireAuth, async (req, res) => {
    try {
      const rentalId = parseInt(req.params.id);
      const swaps = await storage.listSwapsByRental(rentalId);
      res.json(swaps);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch swap history' });
    }
  });

  // ── MAINTENANCE COST REPORT ────────────────────────────────────────────────
  app.get('/api/reports/maintenance-costs', requireAuth, async (req, res) => {
    try {
      const cursor = await getSimulationDate();
      const cursorStr = cursor.toISOString().split('T')[0];

      const [byEquipment] = await db.execute(sql`
        SELECT
          e.id,
          e.name,
          e.equipment_id  AS equipmentId,
          e.category,
          COUNT(me.id)    AS eventCount,
          COALESCE(SUM(CAST(me.cost AS DECIMAL(10,2))), 0) AS totalCost,
          COALESCE(AVG(CAST(me.cost AS DECIMAL(10,2))), 0) AS avgCostPerEvent
        FROM equipment e
        LEFT JOIN maintenance_events me ON me.equipment_id = e.id
        GROUP BY e.id, e.name, e.equipment_id, e.category
        HAVING eventCount > 0
        ORDER BY totalCost DESC
      `);

      const [byCategory] = await db.execute(sql`
        SELECT
          e.category,
          COUNT(me.id) AS eventCount,
          COALESCE(SUM(CAST(me.cost AS DECIMAL(10,2))), 0) AS totalCost
        FROM maintenance_events me
        JOIN equipment e ON e.id = me.equipment_id
        GROUP BY e.category
        ORDER BY totalCost DESC
      `);

      const [byMonth] = await db.execute(sql`
        SELECT
          DATE_FORMAT(me.maintenance_date, '%Y-%m') AS month,
          COUNT(*)  AS eventCount,
          COALESCE(SUM(CAST(me.cost AS DECIMAL(10,2))), 0) AS totalCost
        FROM maintenance_events me
        WHERE me.maintenance_date >= DATE_SUB(${cursorStr}, INTERVAL 12 MONTH)
          AND me.maintenance_date <= ${cursorStr}
        GROUP BY month
        ORDER BY month ASC
      `);

      const [summaryRows] = await db.execute(sql`
        SELECT
          COUNT(*)  AS totalEvents,
          COALESCE(SUM(CAST(cost AS DECIMAL(10,2))), 0) AS totalCost,
          COALESCE(AVG(CAST(cost AS DECIMAL(10,2))), 0) AS avgCostPerEvent
        FROM maintenance_events
      `);

      res.json({
        byEquipment: byEquipment as unknown as any[],
        byCategory: byCategory as unknown as any[],
        byMonth: byMonth as unknown as any[],
        summary: (summaryRows as unknown as any[])[0] || { totalEvents: 0, totalCost: 0, avgCostPerEvent: 0 },
      });
    } catch (error) {
      console.error('Maintenance cost report error:', error);
      res.status(500).json({ message: 'Failed to generate maintenance cost report' });
    }
  });

  // ── AGENT API ─────────────────────────────────────────────────────────────
  //
  // Bearer-token auth for programmatic / LLM agent access.
  // Set AGENT_API_KEY env var to a long random string to enable.
  // Agents pass: Authorization: Bearer <key>
  //
  function requireAgentKey(req: any, res: any, next: any) {
    const key = process.env.AGENT_API_KEY;
    if (!key) return res.status(503).json({ error: "Agent API not enabled — set AGENT_API_KEY env var" });

    // Constant-time, like the Python side's hmac.compare_digest. A plain !==
    // returns as soon as two bytes differ, which leaks the length and the
    // matching prefix to anyone willing to time the responses.
    const provided = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${key}`);
    const ok =
      provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) return res.status(401).json({ error: "Invalid or missing agent API key" });
    next();
  }

  // GET /api/agent/model-health
  // Returns a single consolidated snapshot of model + drift + pipeline health
  // plus a machine-readable recommended_action field agents can act on.
  app.get("/api/agent/model-health", requireAgentKey, async (req, res) => {
    try {
      const { modelMetrics, assetFeatureSnapshots, assetRiskPredictions } = await import("@shared/schema");

      // ── model metrics (long-format table; headline = 30d holdout ROC-AUC) ──
      const [latestModel] = await db
        .select({
          modelVersion: modelMetrics.modelVersion,
          trainedAt: modelMetrics.trainedAt,
          datasetSize: modelMetrics.datasetSize,
        })
        .from(modelMetrics)
        .orderBy(desc(modelMetrics.trainedAt))
        .limit(1);

      let rocAuc30d: number | null = null;
      if (latestModel) {
        const [rocRow] = await db
          .select({ value: modelMetrics.value })
          .from(modelMetrics)
          .where(and(
            eq(modelMetrics.modelVersion, latestModel.modelVersion),
            eq(modelMetrics.horizonDays, 30),
            eq(modelMetrics.metric, 'roc_auc'),
          ))
          .limit(1);
        rocAuc30d = rocRow ? Number(rocRow.value) : null;
      }

      // ── pipeline stats ─────────────────────────────────────────────────────
      const [snapStats] = await db.select({
        total: count(),
        labeled: sql<number>`SUM(CASE WHEN ${assetFeatureSnapshots.willFail30d} IS NOT NULL THEN 1 ELSE 0 END)`,
      }).from(assetFeatureSnapshots);

      const [predStats] = await db.select({ total: count() }).from(assetRiskPredictions);

      // ── drift ──────────────────────────────────────────────────────────────
      let drift: { overall: string; features: any[] } = { overall: "NO_DATA", features: [] };
      try {
        const mlRes = await mlFetch("/drift/latest");
        if (mlRes.ok) drift = await mlRes.json();
      } catch { /* ML service offline — surface NO_DATA */ }

      // ── training status ────────────────────────────────────────────────────
      let trainingRunning = false;
      try {
        const tr = await mlFetch("/train/status");
        if (tr.ok) { const d = await tr.json(); trainingRunning = d.running ?? false; }
      } catch { /* ignore */ }

      // ── recommended action ─────────────────────────────────────────────────
      let recommended_action: "none" | "retrain" | "compute_drift_reference" = "none";
      let reasoning = "Model is healthy and drift is within acceptable bounds.";

      if (drift.overall === "NO_DATA") {
        recommended_action = "compute_drift_reference";
        reasoning = "No drift reference baseline exists. Compute one before relying on drift monitoring.";
      } else if (drift.overall === "ALERT") {
        recommended_action = "retrain";
        reasoning = `Feature drift is in ALERT state (PSI ≥ 0.20 on ${drift.features.filter((f: any) => f.status === "ALERT").map((f: any) => f.feature).join(", ")}). Model predictions may be unreliable — retrain recommended.`;
      } else if (drift.overall === "WARNING") {
        recommended_action = "none";
        reasoning = "Feature drift is elevated (PSI 0.10–0.20). Monitor closely; retrain if drift continues to rise.";
      }

      if (trainingRunning) {
        recommended_action = "none";
        reasoning = "Training is currently in progress.";
      }

      res.json({
        model: latestModel ? {
          version: latestModel.modelVersion,
          trained_at: latestModel.trainedAt,
          roc_auc_30d: rocAuc30d,
          dataset_size: latestModel.datasetSize,
          data_source: "simulated",
        } : null,
        pipeline: {
          snapshots_total: Number(snapStats?.total) || 0,
          snapshots_labeled: Number(snapStats?.labeled) || 0,
          predictions_total: Number(predStats?.total) || 0,
          training_running: trainingRunning,
          ready_for_training: (Number(snapStats?.labeled) || 0) > 100,
        },
        drift: {
          overall: drift.overall,
          features: drift.features.map((f: any) => ({
            feature: f.feature,
            psi: f.psi,
            status: f.status,
            checked_at: f.checked_at,
          })),
        },
        recommended_action,
        reasoning,
        generated_at: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Agent model-health error:", error);
      res.status(500).json({ error: "Failed to assemble model health snapshot", detail: error.message });
    }
  });

  // POST /api/agent/actions
  // Body: { "action": "retrain" | "compute_drift_reference" }
  // Lets an agent trigger operations without a browser session.
  app.post("/api/agent/actions", requireAgentKey, async (req, res) => {
    const { action } = req.body ?? {};

    if (action === "retrain") {
      try {
        const mlRes = await mlFetch("/train", { method: "POST" }, { actorId: "agent" });
        if (!mlRes.ok) return res.status(mlRes.status).json({ error: await mlRes.text() });
        return res.json({ action, status: "accepted", detail: await mlRes.json() });
      } catch (e: any) {
        return res.status(500).json({ error: "ML service unreachable", detail: e.message });
      }
    }

    if (action === "compute_drift_reference") {
      try {
        const mlRes = await mlFetch("/drift/compute-reference", { method: "POST" }, { actorId: "agent" });
        if (!mlRes.ok) return res.status(mlRes.status).json({ error: await mlRes.text() });
        return res.json({ action, status: "accepted", detail: await mlRes.json() });
      } catch (e: any) {
        return res.status(500).json({ error: "ML service unreachable", detail: e.message });
      }
    }

    res.status(400).json({
      error: "Unknown action",
      allowed_actions: ["retrain", "compute_drift_reference"],
    });
  });

  // ── Admin / Onboarding Routes ───────────────────────────────────────────────

  // GET /api/admin/system-status — is the system seeded?
  app.get("/api/admin/system-status", requireAuth, async (req, res) => {
    try {
      const raw = await getSystemStatus();
      res.json({
        seeded: raw.isSeeded,
        fullyInitialized: raw.isFullyInitialized,
        equipmentCount: raw.equipmentCount,
        snapshotCount: raw.snapshotCount,
        modelTrained: raw.modelTrained,
        predictionCount: raw.predictionCount,
        cursorDate: raw.cursorDate,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/seed — kick off background seed job
  app.post("/api/admin/seed", requireAuth, async (req, res) => {
    try {
      const result = await startSeedJob();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/admin/seed/status — poll progress
  app.get("/api/admin/seed/status", requireAuth, async (req, res) => {
    try {
      const raw = getSeedStatus();
      // Progress counts settled steps, not successful ones. A skipped ML step
      // has advanced the pipeline, and counting only completions left the bar
      // stuck at 80% next to the words "All done".
      const settledCount = raw.steps.filter(
        s => s.status === "completed" || s.status === "failed"
      ).length;
      const runningStep = raw.steps.find(s => s.status === "running");
      res.json({
        state: raw.status,
        currentStep: settledCount,
        totalSteps: raw.steps.length,
        stepLabel: runningStep?.name ?? (raw.status === "completed" ? "All done" : "Waiting…"),
        log: raw.steps.filter(s => s.detail).map(s => `[${s.name}] ${s.detail}`),
        warnings: raw.warnings,
        error: raw.error,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/reset — wipe all data, reset cursor
  app.post("/api/admin/reset", requireAdmin, async (req, res) => {
    try {
      const result = await resetSystem();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return httpServer;
}