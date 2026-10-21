import { mysqlTable, varchar, serial, bigint, int, smallint, tinyint, timestamp, decimal, date, text, mediumtext, mysqlEnum, index, uniqueIndex} from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

// One current risk score per asset. The writer upserts on equipment_id, which
// needs a unique index on it to work: without one the ON DUPLICATE KEY clause
// in predictAllEquipmentWithOutcome never matched anything, so every scoring
// run appended another row per asset instead of updating it. Two runs left two
// rows per asset, and the table grew without bound.
export const equipmentRiskScores = mysqlTable("equipment_risk_scores", {
  id: serial("id").primaryKey(),
  equipmentId: int("equipment_id").notNull(),
  riskScore: int("risk_score").notNull(), // 0-100
  riskLevel: varchar("risk_level", { length: 20, enum: ["LOW", "MEDIUM", "HIGH"] }).notNull(),
  drivers: text("drivers").notNull(), // JSON array of strings
  modelVersion: varchar("model_version", { length: 50 }).default("v1.0").notNull(),
  scoredAt: timestamp("scored_at").defaultNow().notNull(),
}, (t) => ({
  uqEquipment: uniqueIndex("uq_equipment_risk_scores_equipment").on(t.equipmentId),
}));

export const equipmentFailurePredictions = mysqlTable("equipment_failure_predictions", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  equipmentId: int("equipment_id").notNull(),
  predictedAt: timestamp("predicted_at").defaultNow().notNull(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  riskTrend: mysqlEnum("risk_trend", ["INCREASING", "DECREASING", "STABLE"]).notNull().default("STABLE"),
  prob10d: decimal("prob_10d", { precision: 5, scale: 4 }).notNull(),
  riskLevel10d: mysqlEnum("risk_level_10d", ["LOW", "MEDIUM", "HIGH"]).notNull(),
  prob30d: decimal("prob_30d", { precision: 5, scale: 4 }).notNull(),
  riskLevel30d: mysqlEnum("risk_level_30d", ["LOW", "MEDIUM", "HIGH"]).notNull(),
  prob60d: decimal("prob_60d", { precision: 5, scale: 4 }).notNull(),
  riskLevel60d: mysqlEnum("risk_level_60d", ["LOW", "MEDIUM", "HIGH"]).notNull(),
  topDrivers10d: text("top_drivers_10d"),
  topDrivers30d: text("top_drivers_30d"),
  topDrivers60d: text("top_drivers_60d"),
  // Per-prediction SHAP attribution (JSON: feature → signed log-odds contribution,
  // top 5 by |value|). Sign and rank are reliable; magnitudes are NOT probabilities.
  // Empty/NULL for cold-start rule-scored rows — the UI must show its no-attribution state.
  shapAttribution10d: text("shap_attribution_10d"),
  shapAttribution30d: text("shap_attribution_30d"),
  shapAttribution60d: text("shap_attribution_60d"),
  recommendation: text("recommendation"),
});

export type EquipmentFailurePrediction = typeof equipmentFailurePredictions.$inferSelect;


export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  role: varchar("role", { length: 50, enum: ["ADMINISTRATOR", "VIEWER"] }).default("VIEWER").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Session store backing table (SEC-3). Shape is dictated by
// express-mysql-session, not by us -- column names and types must match what
// the library's queries expect. It is declared here so Drizzle stays the only
// owner of DDL (ARCH-1); the store itself runs with createDatabaseTable:false.
// The migration pins session_id to utf8mb4_bin so lookups stay case-sensitive,
// which Drizzle cannot express at the column level.
export const sessions = mysqlTable("sessions", {
  sessionId: varchar("session_id", { length: 128 }).primaryKey(),
  expires: int("expires", { unsigned: true }).notNull(),
  data: mediumtext("data"),
});

export const jobSites = mysqlTable("job_sites", {
  id: serial("id").primaryKey(),
  jobId: varchar("job_id", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  contactPerson: varchar("contact_person", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  distanceMiles: decimal("distance_miles", { precision: 6, scale: 1 }).default("25.0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const vendors = mysqlTable("vendors", {
  id: serial("id").primaryKey(),
  vendorId: varchar("vendor_id", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  salesPerson: varchar("sales_person", { length: 255 }),
  contact: varchar("contact", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const equipment = mysqlTable("equipment", {
  id: serial("id").primaryKey(),
  equipmentId: varchar("equipment_id", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  serialNumber: varchar("serial_number", { length: 100 }).unique(),
  status: varchar("status", { length: 50, enum: ["AVAILABLE", "RENTED", "MAINTENANCE"] }).default("AVAILABLE").notNull(),
  dailyRate: decimal("daily_rate", { precision: 10, scale: 2 }).notNull(),
  weeklyRate: decimal("weekly_rate", { precision: 10, scale: 2 }),
  monthlyRate: decimal("monthly_rate", { precision: 10, scale: 2 }),
  location: varchar("location", { length: 255 }),
  yearManufactured: int("year_manufactured"),
  purchaseDate: date("purchase_date"),
  currentMileage: decimal("current_mileage", { precision: 10, scale: 2 }),
  initialMileage: decimal("initial_mileage", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const rentals = mysqlTable("rentals", {
  id: serial("id").primaryKey(),
  equipmentId: int("equipment_id").notNull(),
  jobSiteId: int("job_site_id").notNull(),
  vendorId: int("vendor_id"),
  poNumber: varchar("po_number", { length: 100 }),
  receiveDate: date("receive_date").notNull(),
  receiveHours: decimal("receive_hours", { precision: 10, scale: 2 }),
  receiveDocument: varchar("receive_document", { length: 255 }),
  returnDate: date("return_date"),
  returnHours: decimal("return_hours", { precision: 10, scale: 2 }),
  returnDocument: varchar("return_document", { length: 255 }),
  buyRent: varchar("buy_rent", { length: 10, enum: ["BUY", "RENT"] }).default("RENT").notNull(),
  status: varchar("status", { length: 50, enum: ["ACTIVE", "COMPLETED", "CANCELLED"] }).default("ACTIVE").notNull(),
  notes: text("notes"),
  operatorName: varchar("operator_name", { length: 255 }),
  deliveryMethod: varchar("delivery_method", { length: 30, enum: ["CUSTOMER_PICKUP", "COMPANY_DELIVERY"] }).default("CUSTOMER_PICKUP").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const equipmentSwaps = mysqlTable("equipment_swaps", {
  id: serial("id").primaryKey(),
  rentalId: int("rental_id").notNull(),
  originalEquipmentId: int("original_equipment_id").notNull(),
  replacementEquipmentId: int("replacement_equipment_id").notNull(),
  swapDate: date("swap_date").notNull(),
  reason: text("reason"),
  swappedBy: varchar("swapped_by", { length: 255 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type EquipmentSwap = typeof equipmentSwaps.$inferSelect;
export type InsertEquipmentSwap = typeof equipmentSwaps.$inferInsert;

export const invoices = mysqlTable("invoices", {
  id: serial("id").primaryKey(),
  rentalId: int("rental_id").notNull(),
  invoiceNumber: varchar("invoice_number", { length: 100 }).notNull().unique(),
  invoiceDate: date("invoice_date").notNull(),
  periodFrom: date("period_from").notNull(),
  periodTo: date("period_to").notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Event source enum ─────────────────────────────────────────────────────────
// Captures WHY maintenance was performed — separate from maintenanceType (WHAT was done).
// This distinction is the feedback loop between predictive model outputs and actual actions:
//   SCHEDULED_PM            → vendor interval, calendar driven (default for all historical records)
//   PREDICTIVE_INTERVENTION → tech/dispatcher acted on a model HIGH/MEDIUM flag
//   REACTIVE_REPAIR         → breakdown response, unit failed in the field
//   PRE_DISPATCH_INSPECTION → triggered by rental dispatch risk guard
//
// A MAJOR_SERVICE from REACTIVE_REPAIR is a different signal than one from PREDICTIVE_INTERVENTION —
// same maintenanceType, fundamentally different operational context.
export const EVENT_SOURCE_VALUES = [
  "SCHEDULED_PM",
  "PREDICTIVE_INTERVENTION",
  "REACTIVE_REPAIR",
  "PRE_DISPATCH_INSPECTION",
] as const;

export type EventSource = typeof EVENT_SOURCE_VALUES[number];

export const maintenanceEvents = mysqlTable("maintenance_events", {
  id: serial("id").primaryKey(),
  equipmentId: int("equipment_id").notNull(),
  maintenanceDate: date("maintenance_date").notNull(),
  maintenanceType: varchar("maintenance_type", {
    length: 50,
    enum: ["INSPECTION", "MINOR_SERVICE", "MAJOR_SERVICE"],
  }).notNull(),
  // WHY it was triggered — enriches the ML feedback loop going forward
  // All historical records default to SCHEDULED_PM (safe assumption)
  eventSource: mysqlEnum("event_source", EVENT_SOURCE_VALUES)
    .notNull()
    .default("SCHEDULED_PM"),
  description: text("description"),
  performedBy: varchar("performed_by", { length: 255 }),
  cost: decimal("cost", { precision: 10, scale: 2 }),
  nextDueDate: date("next_due_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const maintenanceConfig = mysqlTable("maintenance_config", {
  id: serial("id").primaryKey(),
  equipmentCategory: varchar("equipment_category", { length: 100 }).notNull().unique(),
  recommendedIntervalDays: int("recommended_interval_days").notNull().default(180),
  inspectionResetFactor: decimal("inspection_reset_factor", { precision: 3, scale: 2 }).default("0.90"),
  minorServiceResetFactor: decimal("minor_service_reset_factor", { precision: 3, scale: 2 }).default("0.60"),
  majorServiceResetFactor: decimal("major_service_reset_factor", { precision: 3, scale: 2 }).default("0.20"),
  createdAt: timestamp("created_at").defaultNow(),
});


// === RELATIONS ===

export const equipmentRiskScoresRelations = relations(equipmentRiskScores, ({ one }) => ({
  equipment: one(equipment, { fields: [equipmentRiskScores.equipmentId], references: [equipment.id] }),
}));

export const rentalsRelations = relations(rentals, ({ one, many }) => ({
  equipment: one(equipment, { fields: [rentals.equipmentId], references: [equipment.id] }),
  jobSite: one(jobSites, { fields: [rentals.jobSiteId], references: [jobSites.id] }),
  vendor: one(vendors, { fields: [rentals.vendorId], references: [vendors.id] }),
  invoices: many(invoices),
  swaps: many(equipmentSwaps),
}));

export const equipmentRelations = relations(equipment, ({ many }) => ({
  rentals: many(rentals),
  maintenanceEvents: many(maintenanceEvents),
}));

export const jobSitesRelations = relations(jobSites, ({ many }) => ({
  rentals: many(rentals),
}));

export const vendorsRelations = relations(vendors, ({ many }) => ({
  rentals: many(rentals),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  rental: one(rentals, { fields: [invoices.rentalId], references: [rentals.id] }),
}));

export const equipmentSwapsRelations = relations(equipmentSwaps, ({ one }) => ({
  rental: one(rentals, { fields: [equipmentSwaps.rentalId], references: [rentals.id] }),
  originalEquipment: one(equipment, { fields: [equipmentSwaps.originalEquipmentId], references: [equipment.id] }),
  replacementEquipment: one(equipment, { fields: [equipmentSwaps.replacementEquipmentId], references: [equipment.id] }),
}));

export const maintenanceEventsRelations = relations(maintenanceEvents, ({ one }) => ({
  equipment: one(equipment, {
    fields: [maintenanceEvents.equipmentId],
    references: [equipment.id],
  }),
}));

// === PREDICTIVE MAINTENANCE TABLES ===

export const assetFeatureSnapshots = mysqlTable("asset_feature_snapshots", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  equipmentId: bigint("equipment_id", { mode: 'number', unsigned: true }).notNull(),
  snapshotTs: timestamp("snapshot_ts").notNull(),
  assetAgeYears: decimal("asset_age_years", { precision: 10, scale: 2 }),
  category: varchar("category", { length: 100 }),
  totalHoursLifetime: decimal("total_hours_lifetime", { precision: 10, scale: 2 }),
  hoursUsed30d: decimal("hours_used_30d", { precision: 10, scale: 2 }),
  hoursUsed90d: decimal("hours_used_90d", { precision: 10, scale: 2 }),
  rentalDays30d: int("rental_days_30d"),
  rentalDays90d: int("rental_days_90d"),
  avgRentalDuration: decimal("avg_rental_duration", { precision: 10, scale: 2 }),
  maintenanceEvents90d: int("maintenance_events_90d"),
  maintenanceCost180d: decimal("maintenance_cost_180d", { precision: 10, scale: 2 }),
  avgDowntimePerEvent: decimal("avg_downtime_per_event", { precision: 10, scale: 2 }),
  daysSinceLastMaintenance: int("days_since_last_maintenance"),
  meanTimeBetweenFailures: int("mean_time_between_failures"),
  vendorReliabilityScore: decimal("vendor_reliability_score", { precision: 3, scale: 2 }),
  jobSiteRiskScore: decimal("jobsite_risk_score", { precision: 3, scale: 2 }),
  // Derived / composite features
  usageIntensity:        decimal("usage_intensity", { precision: 8, scale: 4 }),
  usageTrend:            decimal("usage_trend", { precision: 8, scale: 4 }),
  utilizationVsExpected: decimal("utilization_vs_expected", { precision: 8, scale: 4 }),
  wearRate:              decimal("wear_rate", { precision: 8, scale: 4 }),
  agingFactor:           decimal("aging_factor", { precision: 8, scale: 4 }),
  maintOverdue:          decimal("maint_overdue", { precision: 8, scale: 4 }),
  costPerEvent:          decimal("cost_per_event", { precision: 10, scale: 2 }),
  maintBurden:           decimal("maint_burden", { precision: 8, scale: 4 }),
  mechanicalWearScore:   decimal("mechanical_wear_score", { precision: 5, scale: 2 }),
  abuseScore:            decimal("abuse_score", { precision: 5, scale: 2 }),
  neglectScore:          decimal("neglect_score", { precision: 5, scale: 2 }),
  // Trend velocity features
  wearRateVelocity:      decimal("wear_rate_velocity", { precision: 8, scale: 4 }),
  maintFrequencyTrend:   decimal("maint_frequency_trend", { precision: 8, scale: 4 }),
  costTrend:             decimal("cost_trend", { precision: 8, scale: 4 }),
  hoursVelocity:         decimal("hours_velocity", { precision: 8, scale: 4 }),
  neglectAcceleration:   decimal("neglect_acceleration", { precision: 8, scale: 4 }),
  sensorDegradationRate: decimal("sensor_degradation_rate", { precision: 8, scale: 4 }),
  willFail10d: int("will_fail_10d"),
  willFail30d: int("will_fail_30d"),
  willFail60d: int("will_fail_60d"),
  // ML-11: label integrity. NULL = not yet evaluated by the labeler.
  //   observed              → outcome window fully elapsed, labels are ground truth
  //   censored_intervention → a PREDICTIVE_INTERVENTION landed in the window before
  //                           any failure; the counterfactual is unknowable, so the
  //                           row is excluded from training and prevalence accounting
  //   censored_horizon      → 60d outcome window hasn't elapsed yet (re-evaluated
  //                           as the simulation cursor advances)
  labelStatus: mysqlEnum("label_status", [
    "observed",
    "censored_intervention",
    "censored_horizon",
  ]),
  createdAt: timestamp("created_at").defaultNow(),
});

export const assetRiskPredictions = mysqlTable("asset_risk_predictions", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  equipmentId: bigint("equipment_id", { mode: 'number', unsigned: true }).notNull(),
  snapshotTs: timestamp("snapshot_ts").notNull(),
  failureProbability: decimal("failure_probability", { precision: 5, scale: 4 }).notNull(),
  riskBand: mysqlEnum("risk_band", ["LOW", "MEDIUM", "HIGH"]).notNull(),
  topDriver1: varchar("top_driver_1", { length: 100 }),
  topDriver1Impact: decimal("top_driver_1_impact", { precision: 5, scale: 4 }),
  topDriver2: varchar("top_driver_2", { length: 100 }),
  topDriver2Impact: decimal("top_driver_2_impact", { precision: 5, scale: 4 }),
  topDriver3: varchar("top_driver_3", { length: 100 }),
  topDriver3Impact: decimal("top_driver_3_impact", { precision: 5, scale: 4 }),
  recommendation: text("recommendation"),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  predictedAt: timestamp("predicted_at").defaultNow().notNull(),
});

export const mlModels = mysqlTable("ml_models", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  modelVersion: varchar("model_version", { length: 50 }).notNull().unique(),
  modelType: varchar("model_type", { length: 50 }).notNull(),
  trainedAt: timestamp("trained_at").notNull(),
  trainingDataStart: date("training_data_start").notNull(),
  trainingDataEnd: date("training_data_end").notNull(),
  trainingRecords: int("training_records").notNull(),
  rocAuc: decimal("roc_auc", { precision: 5, scale: 4 }),
  precision: decimal("precision", { precision: 5, scale: 4 }),
  recall: decimal("recall", { precision: 5, scale: 4 }),
  featureSchema: text("feature_schema"),
  status: mysqlEnum("status", ["ACTIVE", "ARCHIVED", "TESTING"]).default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const modelTrainingMetrics = mysqlTable("model_training_metrics", {
  id: int("id").primaryKey().autoincrement(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  trainedAt: timestamp("trained_at").notNull(),
  datasetSize: int("dataset_size").notNull(),
  accuracy: decimal("accuracy", { precision: 5, scale: 4 }).notNull(),
  precisionHigh: decimal("precision_high", { precision: 5, scale: 4 }).notNull(),
  recallHigh: decimal("recall_high", { precision: 5, scale: 4 }).notNull(),
  f1High: decimal("f1_high", { precision: 5, scale: 4 }).notNull(),
  precisionMedium: decimal("precision_medium", { precision: 5, scale: 4 }).notNull(),
  recallMedium: decimal("recall_medium", { precision: 5, scale: 4 }).notNull(),
  f1Medium: decimal("f1_medium", { precision: 5, scale: 4 }).notNull(),
  precisionLow: decimal("precision_low", { precision: 5, scale: 4 }).notNull(),
  recallLow: decimal("recall_low", { precision: 5, scale: 4 }).notNull(),
  f1Low: decimal("f1_low", { precision: 5, scale: 4 }).notNull(),
  highPredictedHigh: int("high_predicted_high").notNull(),
  highPredictedMedium: int("high_predicted_medium").notNull(),
  highPredictedLow: int("high_predicted_low").notNull(),
  mediumPredictedHigh: int("medium_predicted_high").notNull(),
  mediumPredictedMedium: int("medium_predicted_medium").notNull(),
  mediumPredictedLow: int("medium_predicted_low").notNull(),
  lowPredictedHigh: int("low_predicted_high").notNull(),
  lowPredictedMedium: int("low_predicted_medium").notNull(),
  lowPredictedLow: int("low_predicted_low").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Long-format model metrics — one row per (version, horizon, split, metric).
// Replaces the mis-shaped model_training_metrics table, whose 3-class
// precision/recall columns were being (ab)used to store per-horizon ROC-AUCs.
// `split`: 'temporal' (time-based holdout) | 'by_asset' (grouped by equipment).
export const modelMetrics = mysqlTable("model_metrics", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  horizonDays: int("horizon_days").notNull(),
  split: varchar("split", { length: 20 }).notNull().default("temporal"),
  metric: varchar("metric", { length: 60 }).notNull(),
  value: decimal("value", { precision: 14, scale: 6 }).notNull(),
  trainedAt: timestamp("trained_at").notNull(),
  datasetSize: int("dataset_size"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ModelMetricRow = typeof modelMetrics.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// ARCH-1: tables previously created by runtime DDL (Node db-initializer and the
// Python drift detector / training script) now live here — Drizzle is the single
// DDL owner. Column definitions mirror the live schema exactly. The Python and
// Node services only read/write these; they no longer CREATE them.
// ─────────────────────────────────────────────────────────────────────────────

// High-volume sensor telemetry (simulator today; ingestion adapters in Phase B).
export const sensorDataLogs = mysqlTable("sensor_data_logs", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  equipmentId: int("equipment_id").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  engineRpm: int("engine_rpm"),
  engineTemp: int("engine_temp"),
  oilPressure: int("oil_pressure"),
  coolantTemp: int("coolant_temp"),
  fuelConsumption: decimal("fuel_consumption", { precision: 10, scale: 2 }),
  hydraulicPressure: int("hydraulic_pressure"),
  hydraulicTemp: int("hydraulic_temp"),
  hydraulicFlowRate: int("hydraulic_flow_rate"),
  vibrationX: decimal("vibration_x", { precision: 6, scale: 3 }),
  vibrationY: decimal("vibration_y", { precision: 6, scale: 3 }),
  vibrationZ: decimal("vibration_z", { precision: 6, scale: 3 }),
  operatingHours: decimal("operating_hours", { precision: 10, scale: 2 }),
  loadPercentage: int("load_percentage"),
  idleTime: decimal("idle_time", { precision: 10, scale: 2 }),
  ambientTemp: int("ambient_temp"),
  errorCodes: text("error_codes"),
  warningCount: int("warning_count"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  idxEquipmentTs: index("idx_equipment_ts").on(t.equipmentId, t.timestamp),
  idxTimestamp: index("idx_timestamp").on(t.timestamp),
}));

// Feature drift — PSI per monitored feature vs. training distribution.
export const driftMetrics = mysqlTable("drift_metrics", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  modelVersion: varchar("model_version", { length: 50 }),
  batchSize: int("batch_size").notNull(),
  feature: varchar("feature", { length: 100 }).notNull(),
  psi: decimal("psi", { precision: 10, scale: 6 }).notNull(),
  status: mysqlEnum("status", ["STABLE", "WARNING", "ALERT"]).notNull(),
  refMean: decimal("ref_mean", { precision: 14, scale: 4 }),
  curMean: decimal("cur_mean", { precision: 14, scale: 4 }),
  refStd: decimal("ref_std", { precision: 14, scale: 4 }),
  curStd: decimal("cur_std", { precision: 14, scale: 4 }),
}, (t) => ({
  idxCheckedAt: index("idx_checked_at").on(t.checkedAt),
  idxFeature: index("idx_feature").on(t.feature),
}));

// Prediction drift — PSI on output score distribution, per horizon.
export const predictionDriftMetrics = mysqlTable("prediction_drift_metrics", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  modelVersion: varchar("model_version", { length: 50 }),
  batchSize: int("batch_size").notNull(),
  horizon: smallint("horizon").notNull(),
  scorePsi: decimal("score_psi", { precision: 10, scale: 6 }).notNull(),
  scoreStatus: mysqlEnum("score_status", ["STABLE", "WARNING", "ALERT"]).notNull(),
  highPct: decimal("high_pct", { precision: 5, scale: 4 }),
  mediumPct: decimal("medium_pct", { precision: 5, scale: 4 }),
  lowPct: decimal("low_pct", { precision: 5, scale: 4 }),
  refHighPct: decimal("ref_high_pct", { precision: 5, scale: 4 }),
  refMediumPct: decimal("ref_medium_pct", { precision: 5, scale: 4 }),
  refLowPct: decimal("ref_low_pct", { precision: 5, scale: 4 }),
}, (t) => ({
  idxCheckedAt: index("idx_checked_at").on(t.checkedAt),
  idxHorizon: index("idx_horizon").on(t.horizon),
}));

// The drift reference itself — the "normal" every PSI check is measured
// against.
//
// It used to live only in ml-service/registry/drift_reference.json, written at
// runtime by POST /drift/compute-reference. Two things went wrong with that.
// The ML service runs on free hosting with no persistent disk, so a file
// written at runtime is gone at the next cold start. And the loader globs
// `drift_reference_*.json` — note the underscore — which matches the committed
// per-version files but never the plain `drift_reference.json` the compute step
// writes, so on any restart the freshly computed reference was not merely lost,
// it had never been the one in use.
//
// Here instead: survives restarts, is visible to anything that can read the
// database, and keeps its history like the three metrics tables above.
export const driftReference = mysqlTable("drift_reference", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  computedAt: timestamp("computed_at").notNull().defaultNow(),
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  // Counts are columns rather than JSON fields so "does a prediction reference
  // exist?" is answerable without parsing the payload -- that question went
  // unanswered for three model versions.
  featureCount: int("feature_count").notNull().default(0),
  horizonCount: int("horizon_count").notNull().default(0),
  biasCategoryCount: int("bias_category_count").notNull().default(0),
  /** Snapshots behind the feature references. */
  nSamples: int("n_samples").notNull().default(0),
  /** Distinct assets behind the prediction and bias references. */
  nAssets: int("n_assets").notNull().default(0),
  /** JSON: { features, predictions, bias } — the distributions themselves. */
  payload: mediumtext("payload").notNull(),
}, (t) => ({
  idxComputedAt: index("idx_computed_at").on(t.computedAt),
}));

// Bias drift — per-category HIGH-rate deviation vs. baseline.
export const biasDriftMetrics = mysqlTable("bias_drift_metrics", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  modelVersion: varchar("model_version", { length: 50 }),
  batchSize: int("batch_size").notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  horizon: smallint("horizon").notNull(),
  meanScore: decimal("mean_score", { precision: 8, scale: 6 }),
  highPct: decimal("high_pct", { precision: 5, scale: 4 }),
  refHighPct: decimal("ref_high_pct", { precision: 5, scale: 4 }),
  deviation: decimal("deviation", { precision: 5, scale: 4 }),
  alert: tinyint("alert").default(0),
}, (t) => ({
  idxCheckedAt: index("idx_checked_at").on(t.checkedAt),
  idxCategory: index("idx_category").on(t.category),
}));

export const maintenanceOverrides = mysqlTable("maintenance_overrides", {
  id: bigint("id", { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  equipmentId: bigint("equipment_id", { mode: 'number', unsigned: true }).notNull(),
  predictionId: bigint("prediction_id", { mode: 'number', unsigned: true }),
  overriddenBy: bigint("overridden_by", { mode: 'number', unsigned: true }).notNull(),
  originalRiskBand: varchar("original_risk_band", { length: 20 }),
  overrideRiskBand: varchar("override_risk_band", { length: 20 }).notNull(),
  reason: text("reason"),
  actionTaken: text("action_taken"),
  createdAt: timestamp("created_at").defaultNow(),
});

// === RELATIONS ===

export const assetFeatureSnapshotsRelations = relations(assetFeatureSnapshots, ({ one }) => ({
  equipment: one(equipment, {
    fields: [assetFeatureSnapshots.equipmentId],
    references: [equipment.id],
  }),
}));

export const assetRiskPredictionsRelations = relations(assetRiskPredictions, ({ one }) => ({
  equipment: one(equipment, {
    fields: [assetRiskPredictions.equipmentId],
    references: [equipment.id],
  }),
}));

export const maintenanceOverridesRelations = relations(maintenanceOverrides, ({ one }) => ({
  equipment: one(equipment, {
    fields: [maintenanceOverrides.equipmentId],
    references: [equipment.id],
  }),
  prediction: one(assetRiskPredictions, {
    fields: [maintenanceOverrides.predictionId],
    references: [assetRiskPredictions.id],
  }),
  user: one(users, {
    fields: [maintenanceOverrides.overriddenBy],
    references: [users.id],
  }),
}));

// === SCHEMAS ===

export const insertRiskScoreSchema = createInsertSchema(equipmentRiskScores).omit({ id: true, scoredAt: true });

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true }).extend({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const insertJobSiteSchema = createInsertSchema(jobSites)
  .omit({ id: true, createdAt: true, jobId: true })
  .extend({
    name: z.string().min(1, "Name is required"),
    address: z.string().optional().nullable(),
    contactPerson: z.string().optional().nullable(),
    contactPhone: z.string().optional().nullable(),
  });

export const insertVendorSchema = createInsertSchema(vendors)
  .omit({ id: true, createdAt: true, vendorId: true })
  .extend({
    name: z.string().min(1, "Name is required"),
    address: z.string().optional().nullable(),
    salesPerson: z.string().optional().nullable(),
    contact: z.string().optional().nullable(),
  });

export const insertEquipmentSchema = createInsertSchema(equipment, {
  purchaseDate: z.string().nullable().optional(),
})
  .omit({ id: true, createdAt: true })
  .extend({
    equipmentId: z.string().optional(),
    yearManufactured: z.number().nullable().optional(),
    purchaseDate: z.string().nullable().optional(),
    currentMileage: z.string().nullable().optional(),
    initialMileage: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
  });

export const insertRentalSchema = createInsertSchema(rentals)
  .omit({ id: true, createdAt: true })
  .extend({
    receiveDate: z.string(),
    // Nullable in the table, and necessarily so: an ACTIVE rental has not come
    // back yet, and POST /api/rentals/:id/complete is what fills this in. The
    // extend() here only exists to accept a "YYYY-MM-DD" string instead of a
    // Date, so requiring it was accidental -- and it made the new-rental form
    // unusable without a return date, with the rejection surfacing as a bare
    // "returnDate Required" that no field on the form was pointing at.
    returnDate: z.string().nullable().optional(),
    operatorName: z.string().nullable().optional(),
    deliveryMethod: z.enum(["CUSTOMER_PICKUP", "COMPANY_DELIVERY"]).default("CUSTOMER_PICKUP"),
  });

export const insertInvoiceSchema = createInsertSchema(invoices).omit({ id: true, createdAt: true });

export const insertMaintenanceEventSchema = createInsertSchema(maintenanceEvents)
  .omit({ id: true, createdAt: true })
  .extend({
    maintenanceDate: z.string(),
    nextDueDate: z.string().nullable().optional(),
    eventSource: z.enum(EVENT_SOURCE_VALUES).optional().default("SCHEDULED_PM"),
  });

export const insertMaintenanceConfigSchema = createInsertSchema(maintenanceConfig)
  .omit({ id: true, createdAt: true });

export const insertAssetFeatureSnapshotSchema = createInsertSchema(assetFeatureSnapshots)
  .omit({ id: true, createdAt: true });

export const insertAssetRiskPredictionSchema = createInsertSchema(assetRiskPredictions)
  .omit({ id: true, predictedAt: true });

export const insertMlModelSchema = createInsertSchema(mlModels)
  .omit({ id: true, createdAt: true });

export const insertMaintenanceOverrideSchema = createInsertSchema(maintenanceOverrides)
  .omit({ id: true, createdAt: true });

/**
 * The outcome of each demo seed, kept so it survives the API process.
 *
 * The run's steps and warnings lived only in memory. On free hosting the API
 * restarts often -- a deploy, or the instance suspending -- and when it did,
 * the record of why a run's ML steps had been skipped went with it. Three
 * consecutive seeds wrote no predictions and the only evidence left was the
 * shape of the tables: counts of zero, and a drift row older than the seed
 * that was supposed to have replaced it.
 *
 * Written on every step transition rather than at the end, because a run that
 * dies is exactly the run whose reasons matter.
 */
export const seedRuns = mysqlTable("seed_runs", {
  id:         serial("id").primaryKey(),
  status:     varchar("status", { length: 20, enum: ["running", "completed", "failed"] }).notNull(),
  steps:      mediumtext("steps"),     // JSON: SeedStep[]
  warnings:   mediumtext("warnings"),  // JSON: string[]
  error:      text("error"),
  startedAt:  timestamp("started_at").defaultNow(),
  updatedAt:  timestamp("updated_at").defaultNow().onUpdateNow(),
  finishedAt: timestamp("finished_at"),
});

export const insertSeedRunSchema = createInsertSchema(seedRuns).omit({ id: true });
export type SeedRun = typeof seedRuns.$inferSelect;

export const simulationState = mysqlTable("simulation_state", {
  id:           int("id").primaryKey().autoincrement(),
  cursorDate:   varchar("cursor_date", { length: 10 }).notNull(),
  totalDaysRun: int("total_days_run").notNull().default(0),
  updatedAt:    timestamp("updated_at").defaultNow(),
});

export const insertModelTrainingMetricsSchema = createInsertSchema(modelTrainingMetrics)
  .omit({ id: true, createdAt: true });


// === EXPLICIT TYPES ===

export type EquipmentRiskScore = typeof equipmentRiskScores.$inferSelect;
export type InsertRiskScore = z.infer<typeof insertRiskScoreSchema>;

export type User = typeof users.$inferSelect;
export type JobSite = typeof jobSites.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type Equipment = typeof equipment.$inferSelect;
export type Rental = typeof rentals.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type MaintenanceEvent = typeof maintenanceEvents.$inferSelect;
export type MaintenanceConfig = typeof maintenanceConfig.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertJobSite = z.infer<typeof insertJobSiteSchema>;
export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type InsertEquipment = z.infer<typeof insertEquipmentSchema>;
export type InsertRental = z.infer<typeof insertRentalSchema>;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type InsertMaintenanceEvent = z.infer<typeof insertMaintenanceEventSchema>;
export type InsertMaintenanceConfig = z.infer<typeof insertMaintenanceConfigSchema>;

export type AssetFeatureSnapshot = typeof assetFeatureSnapshots.$inferSelect;
export type AssetRiskPrediction = typeof assetRiskPredictions.$inferSelect;
export type MlModel = typeof mlModels.$inferSelect;
export type MaintenanceOverride = typeof maintenanceOverrides.$inferSelect;

export type InsertAssetFeatureSnapshot = z.infer<typeof insertAssetFeatureSnapshotSchema>;
export type InsertAssetRiskPrediction = z.infer<typeof insertAssetRiskPredictionSchema>;
export type InsertMlModel = z.infer<typeof insertMlModelSchema>;
export type InsertMaintenanceOverride = z.infer<typeof insertMaintenanceOverrideSchema>;

export type ModelTrainingMetrics = typeof modelTrainingMetrics.$inferSelect;
export type InsertModelTrainingMetrics = z.infer<typeof insertModelTrainingMetricsSchema>;