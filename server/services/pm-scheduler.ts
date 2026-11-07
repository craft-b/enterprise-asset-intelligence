// server/services/pm-scheduler.ts
//
// Preventive Maintenance Scheduler
//
// Determines when each equipment unit is due for PM based on TWO factors:
//   1. Time elapsed since last PM of that type (calendar-driven baseline)
//   2. Feature-threshold overrides — key health signals that shorten the
//      interval when the equipment is under stress, aging, or degrading
//
// Maintenance hierarchy:
//   INSPECTION    — frequent safety/fluid checks; caught early = cheap
//   MINOR_SERVICE — filter/fluid changes, belt/hose inspection
//   MAJOR_SERVICE — overhaul-level work; driven by cumulative wear signals
//
// eventSource for all auto-generated events: SCHEDULED_PM

import { EnhancedFeatureSnapshot } from "./feature-engineering-enhanced";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type MaintenanceTypeKey = "INSPECTION" | "MINOR_SERVICE" | "MAJOR_SERVICE";

export interface PMTrigger {
  /** Feature name on EnhancedFeatureSnapshot */
  feature: keyof EnhancedFeatureSnapshot;
  operator: ">" | ">=" | "<";
  threshold: number;
  /** Effective interval in days when this trigger fires */
  reducedDays: number;
  /** Human-readable reason logged in the maintenance description */
  reason: string;
}

export interface PMTypeConfig {
  /** Baseline interval (days) under normal conditions */
  baseDays: number;
  /** Feature-driven overrides — any match reduces the interval */
  triggers: PMTrigger[];
}

export interface TriggeredPM {
  maintenanceType: MaintenanceTypeKey;
  effectiveDays: number;
  daysSinceLastPM: number;
  triggers: string[];   // reasons that fired
  urgency: "OVERDUE" | "DUE";  // OVERDUE = past due, DUE = within grace window
}

// ─────────────────────────────────────────────────────────────────────────────
// PM CONFIG — category → type → { baseDays, triggers }
//
// Driving features used as override signals:
//   assetAgeYears          — older equipment needs more frequent service
//   jobSiteRiskScore       — harsh terrain accelerates wear (0–1)
//   mechanicalWearScore    — composite wear indicator (0–10)
//   wearRateVelocity       — rate of change in wear (per month)
//   neglectAcceleration    — overdue ratio (days_since / MTBF)
//   sensorDegradationRate  — sensor signal quality degradation (0–1)
//   abuseScore             — operational stress composite (0–10)
//   hoursUsed90d           — recent utilization (hours in last 90 days)
//   maintenanceEvents90d   — frequency of recent events (high = cumulative wear)
//   meanTimeBetweenFailures — MTBF in days (low = declining reliability)
//   costTrend              — ratio of recent vs historical cost (rising = major due)
//   maintFrequencyTrend    — increasing maintenance events trend
// ─────────────────────────────────────────────────────────────────────────────

// Shared trigger sets (referenced by multiple categories)
const AGE_INSPECTION_TRIGGERS: PMTrigger[] = [
  {
    feature: "assetAgeYears", operator: ">", threshold: 10,
    reducedDays: 14,
    reason: "equipment age >10y — accelerated inspection cadence",
  },
  {
    feature: "assetAgeYears", operator: ">", threshold: 7,
    reducedDays: 21,
    reason: "equipment age >7y — increased inspection frequency",
  },
  {
    feature: "jobSiteRiskScore", operator: ">", threshold: 0.85,
    reducedDays: 14,
    reason: "extreme jobsite conditions (risk >0.85)",
  },
  {
    feature: "jobSiteRiskScore", operator: ">", threshold: 0.70,
    reducedDays: 21,
    reason: "harsh jobsite terrain (risk >0.70)",
  },
  {
    feature: "mechanicalWearScore", operator: ">", threshold: 7.5,
    reducedDays: 14,
    reason: "mechanical wear score >7.5 — high wear state",
  },
  {
    feature: "neglectAcceleration", operator: ">", threshold: 0.15,
    reducedDays: 14,
    reason: "neglect acceleration >0.15 — trending towards overdue",
  },
  {
    feature: "sensorDegradationRate", operator: ">", threshold: 0.30,
    reducedDays: 14,
    reason: "sensor degradation rate >0.30 — reliability check required",
  },
  {
    feature: "abuseScore", operator: ">", threshold: 7.0,
    reducedDays: 21,
    reason: "operational stress score >7 — stress-driven inspection",
  },
];

const AGE_MINOR_TRIGGERS: PMTrigger[] = [
  {
    feature: "wearRateVelocity", operator: ">", threshold: 0.4,
    reducedDays: 60,
    reason: "wear rate velocity >0.4/month — accelerated component degradation",
  },
  {
    feature: "hoursUsed90d", operator: ">", threshold: 400,
    reducedDays: 60,
    reason: "high utilization >400h/90d — shortened service interval",
  },
  {
    feature: "jobSiteRiskScore", operator: ">", threshold: 0.75,
    reducedDays: 60,
    reason: "harsh jobsite (risk >0.75) — accelerated fluid/filter wear",
  },
  {
    feature: "assetAgeYears", operator: ">", threshold: 7,
    reducedDays: 60,
    reason: "equipment age >7y — seals/hoses require more frequent service",
  },
  {
    feature: "mechanicalWearScore", operator: ">", threshold: 7.0,
    reducedDays: 45,
    reason: "mechanical wear score >7 — minor service critical",
  },
  {
    feature: "maintFrequencyTrend", operator: ">", threshold: 1.5,
    reducedDays: 60,
    reason: "maintenance frequency trending up — proactive minor service",
  },
];

const AGE_MAJOR_TRIGGERS: PMTrigger[] = [
  {
    feature: "assetAgeYears", operator: ">", threshold: 9,
    reducedDays: 180,
    reason: "equipment age >9y — major overhaul cycle shortened",
  },
  {
    feature: "assetAgeYears", operator: ">", threshold: 6,
    reducedDays: 270,
    reason: "equipment age >6y — proactive major service interval",
  },
  {
    feature: "costTrend", operator: ">", threshold: 1.3,
    reducedDays: 270,
    reason: "maintenance cost trend +30% — escalating costs signal major needed",
  },
  {
    feature: "maintenanceEvents90d", operator: ">=", threshold: 4,
    reducedDays: 270,
    reason: "≥4 maintenance events in 90d — cumulative wear requires overhaul",
  },
  {
    feature: "meanTimeBetweenFailures", operator: "<", threshold: 45,
    reducedDays: 180,
    reason: "MTBF <45d — declining reliability requires major intervention",
  },
  {
    feature: "mechanicalWearScore", operator: ">", threshold: 8.0,
    reducedDays: 180,
    reason: "mechanical wear score >8 — overhaul-level wear detected",
  },
  {
    feature: "wearRateVelocity", operator: ">", threshold: 0.7,
    reducedDays: 180,
    reason: "wear rate velocity >0.7/month — accelerated component failure risk",
  },
];

// ─── Category configs ─────────────────────────────────────────────────────────

type PMConfig = Record<string, Record<MaintenanceTypeKey, PMTypeConfig>>;

export const PM_CONFIG: PMConfig = {

  // Heavy excavation — high hours, hard terrain, hydraulic stress
  Excavator: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Heavy push/grade — drivetrain stress, undercarriage wear
  Dozer: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Road grading — similar to dozer profile
  Grader: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Compaction — lower stress than excavation
  Compactor: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Material transport — powertrain, brakes, tyre wear
  Hauler: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Loader/skid steer — moderate stress, hydraulics
  Loader: {
    INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
    MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
    MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
  },

  // Lifting — safety-critical; tighter inspection cadence, stricter overrides
  Crane: {
    INSPECTION: {
      baseDays: 21,
      triggers: [
        // All standard triggers but base is already tighter
        ...AGE_INSPECTION_TRIGGERS,
        // Extra: any load event anomaly
        {
          feature: "abuseScore", operator: ">", threshold: 6.0,
          reducedDays: 14,
          reason: "crane abuse score >6 — load anomaly inspection required",
        },
      ],
    },
    MINOR_SERVICE: {
      baseDays: 60,
      triggers: [
        ...AGE_MINOR_TRIGGERS,
        {
          feature: "hoursUsed90d", operator: ">", threshold: 300,
          reducedDays: 45,
          reason: "crane utilisation >300h/90d — shortened service",
        },
      ],
    },
    MAJOR_SERVICE: {
      baseDays: 270,
      triggers: AGE_MAJOR_TRIGGERS,
    },
  },

  // Aerial lift — personnel carrier, strict safety regs
  Lift: {
    INSPECTION: {
      baseDays: 21,
      triggers: [
        ...AGE_INSPECTION_TRIGGERS,
        {
          feature: "sensorDegradationRate", operator: ">", threshold: 0.20,
          reducedDays: 10,
          reason: "lift sensor degradation >0.20 — safety-critical inspection",
        },
      ],
    },
    MINOR_SERVICE: {
      baseDays: 60,
      triggers: AGE_MINOR_TRIGGERS,
    },
    MAJOR_SERVICE: {
      baseDays: 270,
      triggers: AGE_MAJOR_TRIGGERS,
    },
  },

  // Compressor — runtime hours key driver; lower mech stress
  Compressor: {
    INSPECTION: {
      baseDays: 45,
      triggers: [
        {
          feature: "hoursUsed90d", operator: ">", threshold: 500,
          reducedDays: 21,
          reason: "compressor hours >500/90d — intake filter check required",
        },
        {
          feature: "sensorDegradationRate", operator: ">", threshold: 0.25,
          reducedDays: 21,
          reason: "sensor degradation — pressure sensor check required",
        },
        {
          feature: "assetAgeYears", operator: ">", threshold: 7,
          reducedDays: 30,
          reason: "compressor age >7y — valve wear inspection",
        },
      ],
    },
    MINOR_SERVICE: {
      baseDays: 120,
      triggers: [
        {
          feature: "hoursUsed90d", operator: ">", threshold: 600,
          reducedDays: 60,
          reason: "high runtime — oil/filter change interval shortened",
        },
        {
          feature: "wearRateVelocity", operator: ">", threshold: 0.35,
          reducedDays: 75,
          reason: "elevated wear velocity — minor service advanced",
        },
        {
          feature: "assetAgeYears", operator: ">", threshold: 7,
          reducedDays: 75,
          reason: "compressor age >7y — bearing/seal service",
        },
      ],
    },
    MAJOR_SERVICE: {
      baseDays: 365,
      triggers: [
        {
          feature: "assetAgeYears", operator: ">", threshold: 6,
          reducedDays: 270,
          reason: "compressor age >6y — cylinder/valve overhaul",
        },
        {
          feature: "hoursUsed90d", operator: ">", threshold: 700,
          reducedDays: 270,
          reason: "compressor hours >700/90d — overhaul interval advanced",
        },
        ...AGE_MAJOR_TRIGGERS.filter(t => t.feature !== "assetAgeYears"),
      ],
    },
  },

  // Generator — runtime + load, electrical stress
  Generator: {
    INSPECTION: {
      baseDays: 45,
      triggers: [
        {
          feature: "hoursUsed90d", operator: ">", threshold: 450,
          reducedDays: 21,
          reason: "generator runtime >450h/90d — coolant/oil check required",
        },
        {
          feature: "sensorDegradationRate", operator: ">", threshold: 0.25,
          reducedDays: 21,
          reason: "electrical sensor degradation — load test inspection",
        },
        {
          feature: "abuseScore", operator: ">", threshold: 6.5,
          reducedDays: 21,
          reason: "generator load stress >6.5 — overload inspection",
        },
        {
          feature: "assetAgeYears", operator: ">", threshold: 7,
          reducedDays: 30,
          reason: "generator age >7y — brush/alternator inspection",
        },
      ],
    },
    MINOR_SERVICE: {
      baseDays: 120,
      triggers: [
        {
          feature: "hoursUsed90d", operator: ">", threshold: 550,
          reducedDays: 60,
          reason: "high runtime — oil/filter/coolant service advanced",
        },
        {
          feature: "wearRateVelocity", operator: ">", threshold: 0.35,
          reducedDays: 75,
          reason: "wear velocity elevated — minor service advanced",
        },
        {
          feature: "assetAgeYears", operator: ">", threshold: 7,
          reducedDays: 75,
          reason: "generator age >7y — belt/hose/battery service",
        },
      ],
    },
    MAJOR_SERVICE: {
      baseDays: 365,
      triggers: [
        {
          feature: "assetAgeYears", operator: ">", threshold: 6,
          reducedDays: 270,
          reason: "generator age >6y — alternator/engine overhaul cycle",
        },
        ...AGE_MAJOR_TRIGGERS.filter(t => t.feature !== "assetAgeYears"),
      ],
    },
  },
};

// Fallback config for unknown categories
export const DEFAULT_CONFIG: Record<MaintenanceTypeKey, PMTypeConfig> = {
  INSPECTION:    { baseDays: 30,  triggers: AGE_INSPECTION_TRIGGERS },
  MINOR_SERVICE: { baseDays: 90,  triggers: AGE_MINOR_TRIGGERS },
  MAJOR_SERVICE: { baseDays: 365, triggers: AGE_MAJOR_TRIGGERS },
};

// ─────────────────────────────────────────────────────────────────────────────
// COST RANGES by category + maintenance type [min, max]
// ─────────────────────────────────────────────────────────────────────────────

const COST_RANGES: Record<string, Record<MaintenanceTypeKey, [number, number]>> = {
  Crane:      { INSPECTION: [150, 300], MINOR_SERVICE: [600,  1200], MAJOR_SERVICE: [3000, 6000] },
  Excavator:  { INSPECTION: [100, 220], MINOR_SERVICE: [400,   900], MAJOR_SERVICE: [2000, 4500] },
  Dozer:      { INSPECTION: [120, 250], MINOR_SERVICE: [450,   950], MAJOR_SERVICE: [2200, 5000] },
  Grader:     { INSPECTION: [110, 230], MINOR_SERVICE: [420,   880], MAJOR_SERVICE: [2000, 4500] },
  Compactor:  { INSPECTION: [80,  180], MINOR_SERVICE: [280,   600], MAJOR_SERVICE: [1200, 2800] },
  Hauler:     { INSPECTION: [100, 220], MINOR_SERVICE: [400,   800], MAJOR_SERVICE: [1800, 4000] },
  Loader:     { INSPECTION: [80,  180], MINOR_SERVICE: [300,   700], MAJOR_SERVICE: [1500, 3500] },
  Lift:       { INSPECTION: [100, 200], MINOR_SERVICE: [350,   700], MAJOR_SERVICE: [1500, 3000] },
  Compressor: { INSPECTION: [60,  140], MINOR_SERVICE: [200,   450], MAJOR_SERVICE: [800,  2000] },
  Generator:  { INSPECTION: [70,  150], MINOR_SERVICE: [250,   500], MAJOR_SERVICE: [1000, 2500] },
};

const DEFAULT_COST: Record<MaintenanceTypeKey, [number, number]> = {
  INSPECTION:    [80,  200],
  MINOR_SERVICE: [300, 700],
  MAJOR_SERVICE: [1200, 3000],
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function evaluateTrigger(trigger: PMTrigger, snapshot: EnhancedFeatureSnapshot): boolean {
  const value = snapshot[trigger.feature] as number | null | undefined;
  if (value == null) return false;
  if (trigger.operator === ">")  return value > trigger.threshold;
  if (trigger.operator === ">=") return value >= trigger.threshold;
  if (trigger.operator === "<")  return value < trigger.threshold;
  return false;
}

/**
 * Compute the effective interval (days) for a given maintenance type,
 * factoring in all feature-driven overrides.
 * Returns the most aggressive (smallest) applicable interval.
 */
export function computeEffectiveDays(
  category: string,
  maintenanceType: MaintenanceTypeKey,
  snapshot: EnhancedFeatureSnapshot,
): { effectiveDays: number; firedTriggers: string[] } {
  const config = (PM_CONFIG[category] ?? DEFAULT_CONFIG)[maintenanceType];
  let effectiveDays = config.baseDays;
  const firedTriggers: string[] = [];

  for (const trigger of config.triggers) {
    if (evaluateTrigger(trigger, snapshot)) {
      firedTriggers.push(trigger.reason);
      if (trigger.reducedDays < effectiveDays) {
        effectiveDays = trigger.reducedDays;
      }
    }
  }

  return { effectiveDays, firedTriggers };
}

/**
 * Evaluate which maintenance types are due for a given equipment unit.
 *
 * @param category         Equipment category (Excavator, Crane, etc.)
 * @param snapshot         Latest feature snapshot
 * @param lastPMByType     Days since last PM for each maintenance type (null = never done)
 * @param stagger          The unit and day being scheduled. When given, a service
 *                         never done before falls on a unit-specific day within one
 *                         interval instead of on the first day for every unit at once.
 */
export function evaluatePMSchedule(
  category: string,
  snapshot: EnhancedFeatureSnapshot,
  lastPMByType: Record<MaintenanceTypeKey, number | null>,
  stagger?: { unitId: number; date: Date },
): TriggeredPM[] {
  const triggered: TriggeredPM[] = [];
  const types: MaintenanceTypeKey[] = ["INSPECTION", "MINOR_SERVICE", "MAJOR_SERVICE"];

  for (const maintenanceType of types) {
    const { effectiveDays, firedTriggers } = computeEffectiveDays(category, maintenanceType, snapshot);
    const daysSince = lastPMByType[maintenanceType];

    // Treating every never-done service as overdue fired it for the whole
    // fleet on the same day, so every unit then came due on the same day too,
    // indefinitely. With a unit and date, each unit gets its own day instead.
    if (daysSince == null && stagger) {
      const day = Math.floor(stagger.date.getTime() / 86_400_000);
      // 7919 is prime, so consecutive unit ids land on different days for any interval.
      if ((day + stagger.unitId * 7919) % effectiveDays !== 0) continue;
      triggered.push({
        maintenanceType,
        effectiveDays,
        daysSinceLastPM: effectiveDays,
        triggers: firedTriggers,
        urgency: "DUE",
      });
      continue;
    }

    // Never done = treat as overdue at 2× the effective interval
    const effectiveDaysSince = daysSince ?? effectiveDays * 2;

    if (effectiveDaysSince >= effectiveDays) {
      triggered.push({
        maintenanceType,
        effectiveDays,
        daysSinceLastPM: effectiveDaysSince,
        triggers: firedTriggers,
        urgency: effectiveDaysSince >= effectiveDays * 1.2 ? "OVERDUE" : "DUE",
      });
    }
  }

  return triggered;
}

/**
 * Generate a maintenance description that documents the triggering signals.
 */
export function generatePMDescription(
  maintenanceType: MaintenanceTypeKey,
  triggered: TriggeredPM,
  category: string,
): string {
  const baseLabel = {
    INSPECTION:    "Scheduled inspection",
    MINOR_SERVICE: "Scheduled minor service",
    MAJOR_SERVICE: "Scheduled major overhaul",
  }[maintenanceType];

  const urgencyTag = triggered.urgency === "OVERDUE" ? " [OVERDUE]" : "";
  const intervalNote = `${triggered.daysSinceLastPM}d since last ${maintenanceType.toLowerCase().replace(/_/g, " ")} (interval: ${triggered.effectiveDays}d)`;

  if (triggered.triggers.length === 0) {
    return `${baseLabel}${urgencyTag} — ${category} — ${intervalNote}`;
  }

  const triggerSummary = triggered.triggers.slice(0, 2).join("; ");
  return `${baseLabel}${urgencyTag} — ${category} — ${intervalNote} | Signals: ${triggerSummary}`;
}

/**
 * Sample a cost within the configured range for a category + type.
 */
export function samplePMCost(category: string, maintenanceType: MaintenanceTypeKey): number {
  const [min, max] = (COST_RANGES[category] ?? DEFAULT_COST)[maintenanceType];
  return parseFloat((min + Math.random() * (max - min)).toFixed(2));
}
