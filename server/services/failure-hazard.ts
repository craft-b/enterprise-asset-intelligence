/**
 * The fleet simulator's breakdown process: one definition, shared by the
 * training-history generator (scripts/generate-training-history.ts) and the
 * live day simulator (POST /api/simulate/day), so the data the model learns
 * from and the data it is later scored on come from the same physics.
 *
 * Why this replaced the old hazard. The previous one added three terms --
 * age, hours, and "neglect" -- and capped the sum. Neglect only switched on
 * past 120 days without service, the age term alone hit the cap for a
 * ten-year-old unit, and a breakdown repair counted as "maintenance". In the
 * data that produced, service almost never changed whether a machine failed,
 * and the champion learned exactly that: days_since_last_maintenance carried
 * 1% of the 30-day model's importance and maint_overdue 0.04%. Logging a
 * service in the app moved the score by nothing.
 *
 * Here wear and service are multiplicative. `base` is what age and hours
 * make inevitable; `condition` is what maintenance controls. Condition
 * degrades with use and is restored by work, by an amount that depends on
 * the work: a major service restores most of it, a minor service some. An
 * inspection restores none -- it finds problems, it does not fix them -- and
 * neither does a breakdown repair (see CONDITION_AFTER). The features agree:
 * days_since_last_maintenance counts scheduled services only. Giving inspections an effect the features cannot see would
 * only add noise the model has no way to explain. A well-kept old machine
 * is therefore safer than a neglected young one of the same duty, which is
 * the claim a maintenance model exists to make.
 */

/** Condition multiplier bounds: freshly rebuilt, and fully run down. */
export const CONDITION_FLOOR = 0.35;
export const CONDITION_CEILING = 2.2;

/**
 * Condition right after each kind of scheduled work.
 *
 * A breakdown repair is not here, deliberately. It fixes the part that
 * failed; it does not reset the wear on everything else. Letting it restore
 * condition also built a confound into the data: fragile units break often,
 * are repaired often, and so always read "recently serviced" -- which made
 * recent service look barely protective (30-day failure rate 27.6% within a
 * month of work vs 35% at 90-180 days, on 8+ year units) when the process
 * generating the data said it was strongly so.
 */
export const CONDITION_AFTER = {
  MAJOR_SERVICE: 0.35,
  MINOR_SERVICE: 0.6,
} as const;

/**
 * Daily degradation at full duty. From a major service to the ceiling takes
 * (2.2 - 0.35) / 0.009 ~ 205 working days -- roughly the gap a yard that
 * skips two scheduled services in a row would leave.
 */
export const CONDITION_WEAR_PER_DAY = 0.009;

/** Hard cap on the daily probability, so no unit is a coin flip per day. */
export const MAX_DAILY_FAILURE_PROB = 0.05;
export const STRESS_MULTIPLIER = 1.5;

/** What age and hours alone make inevitable, per day. */
export function baseDailyHazard(ageYears: number, totalHours: number): number {
  return 0.0012 * Math.exp(0.16 * Math.max(0, ageYears)) * (1 + Math.max(0, totalHours) / 10000);
}

export function dailyFailureProbability(
  ageYears: number,
  totalHours: number,
  condition: number,
  stressed: boolean,
): number {
  const p = baseDailyHazard(ageYears, totalHours) * condition * (stressed ? STRESS_MULTIPLIER : 1);
  return Math.min(p, MAX_DAILY_FAILURE_PROB);
}

/** Condition after one day at the given duty (0..1). */
export function degrade(condition: number, duty: number): number {
  return Math.min(condition + CONDITION_WEAR_PER_DAY * duty, CONDITION_CEILING);
}

export type ServiceKind = "INSPECTION" | "MINOR_SERVICE" | "MAJOR_SERVICE" | "REPAIR";

/** Condition after a piece of work. Work never makes a machine worse. */
export function afterService(condition: number, kind: ServiceKind): number {
  if (kind === "INSPECTION" || kind === "REPAIR") return condition;
  return Math.max(CONDITION_FLOOR, Math.min(condition, CONDITION_AFTER[kind]));
}

/**
 * Best estimate of a unit's condition from its maintenance history, for a
 * caller that has events rather than simulator state (the day simulator
 * reads the database each day). Replays the events oldest first from a
 * mid-range starting condition, at the unit's duty.
 */
export function conditionFromHistory(
  events: Array<{ date: Date; kind: ServiceKind }>,
  asOf: Date,
  duty = 1,
): number {
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());
  let condition = 1.0;
  let at: Date | null = null;
  for (const e of sorted) {
    if (e.date > asOf) break;
    if (at) condition = degradeDays(condition, duty, daysBetween(at, e.date));
    condition = afterService(condition, e.kind);
    at = e.date;
  }
  if (at) condition = degradeDays(condition, duty, daysBetween(at, asOf));
  return condition;
}

function degradeDays(condition: number, duty: number, days: number): number {
  return Math.min(condition + CONDITION_WEAR_PER_DAY * duty * Math.max(0, days), CONDITION_CEILING);
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (24 * 3600 * 1000);
}
