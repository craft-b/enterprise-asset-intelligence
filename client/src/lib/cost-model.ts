import { RISK_BANDS } from "@shared/risk-bands";

// ProjectionPoint inlined here to avoid a circular import with the dashboard page.
interface ProjectionPoint { day: number; "10d": number; "30d": number; "60d": number; }

// PM cost estimates by equipment category (USD)
// Derived from industry averages for construction rental fleets
export const PM_COST_BY_CATEGORY: Record<string, number> = {
  "Excavator":          850,
  "Bulldozer":          900,
  "Crane":             1200,
  "Forklift":           600,
  "Compactor":          500,
  "Generator":          400,
  "Skid Steer":         650,
  "Loader":             750,
  "Grader":             850,
  "Trencher":           550,
};
export const DEFAULT_PM_COST = 700;

// Assumed downtime days if failure occurs (unplanned breakdown)
export const FAILURE_DOWNTIME_DAYS = 7;

// Below HIGH, a service this recent means the work is done. Matches
// _RECENT_SERVICE_DAYS in ml-service/engine/genai_advisor.py, so the advice and
// the callout beside it agree.
export const RECENT_SERVICE_DAYS = 30;

/**
 * Days since the unit's last scheduled service, or null if none is that recent.
 *
 * Counts what days_since_last_maintenance counts: major and minor services, not
 * inspections or breakdown repairs. The projection cannot see this: risk stays
 * above break-even on an old unit however fresh the service, so the callout
 * said "Schedule PM by Day 0" on a crane serviced that morning.
 */
export function daysSinceRecentService(
  events: Array<{ maintenanceDate: string | Date; maintenanceType: string; eventSource?: string | null }>,
  asOf: string | Date,
): number | null {
  const now = new Date(asOf).getTime();
  const days = events
    .filter(e => ["MAJOR_SERVICE", "MINOR_SERVICE"].includes(e.maintenanceType))
    .filter(e => e.eventSource !== "REACTIVE_REPAIR")
    .map(e => Math.max(0, Math.floor((now - new Date(e.maintenanceDate).getTime()) / 86_400_000)));
  if (days.length === 0) return null;
  const latest = Math.min(...days);
  return latest <= RECENT_SERVICE_DAYS ? latest : null;
}

export interface CostModelResult {
  optimalDay: number | null;       // day to intervene; null = already past or never crosses
  expectedSavings: number;         // failure_cost - pm_cost at optimal day
  pmCost: number;                  // scheduled PM cost used
  failureCostAtOptimal: number;    // P(failure|optimalDay) × failure_cost
  breakEvenProbability: number;    // pm_cost / failure_cost
  alreadyHighRisk: boolean;        // day 0 probability already above HIGH threshold
}

export function computeOptimalIntervention(
  curve: ProjectionPoint[],
  dailyRate: number,                // from equipment.dailyRate
  category: string,
): CostModelResult {
  const pmCost = PM_COST_BY_CATEGORY[category] ?? DEFAULT_PM_COST;
  const failureCost = dailyRate * FAILURE_DOWNTIME_DAYS;
  const breakEvenProbability = pmCost / failureCost;

  const alreadyHighRisk = curve.length > 0 && curve[0]["60d"] >= RISK_BANDS[60].HIGH;

  // Walk the curve — find first day where P(60d) × failure_cost > pm_cost
  let optimalDay: number | null = null;
  let failureCostAtOptimal = 0;

  for (const point of curve) {
    const expectedFailureCost = point["60d"] * failureCost;
    if (expectedFailureCost > pmCost) {
      optimalDay = point.day;
      failureCostAtOptimal = expectedFailureCost;
      break;
    }
  }

  const expectedSavings = optimalDay !== null
    ? Math.round(failureCostAtOptimal - pmCost)
    : 0;

  return {
    optimalDay,
    expectedSavings,
    pmCost,
    failureCostAtOptimal: Math.round(failureCostAtOptimal),
    breakEvenProbability,
    alreadyHighRisk,
  };
}