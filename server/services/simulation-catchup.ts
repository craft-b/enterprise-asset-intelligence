// server/services/simulation-catchup.ts
//
// How far to move the simulation clock when the process starts.
//
// The simulation is meant to advance seven days per real day, and it never
// did: the schedule arms a setTimeout for 06:00, and a free instance suspends
// after about fifteen minutes without traffic, so the timer is almost never
// alive when it should fire and every restart rearms it from scratch. The
// clock sat on its seed date while the real world moved on.
//
// Catching up at boot introduces two ways to be wrong, both arithmetic, which
// is why the arithmetic lives here on its own rather than inside a function
// that also talks to a database and a server.

/** Simulation days gained per real day elapsed. */
export const PM_ADVANCE_DAYS = parseInt(process.env.PM_ADVANCE_DAYS || "7", 10);

/**
 * Simulation days to apply in one catch-up pass.
 *
 * Each day costs a feature snapshot per asset, so an unbounded catch-up after
 * a long absence would mean thousands of them at boot. Anything still owed is
 * carried and applied on the next start.
 */
export const PM_CATCHUP_MAX_SIM_DAYS = parseInt(process.env.PM_CATCHUP_MAX_SIM_DAYS || "28", 10);

export interface CatchUpPlan {
  /** Whole real days since the clock last moved. */
  realDays: number;
  /** Simulation days those real days are worth. */
  owed: number;
  /** How many of them this pass will apply. */
  applying: number;
  /** What to store as the new "last moved" -- only the time actually consumed. */
  mark: Date;
}

/**
 * How far to move the simulation clock, and what to record as having happened.
 *
 * Pulled out because the arithmetic is the whole risk. Driving it from elapsed
 * real time rather than from starting up is what stops the clock running ahead
 * of reality on a host that boots on every visit, and advancing the stored
 * timestamp by only the consumed portion is what stops a capped pass silently
 * forgetting the rest.
 */
export function planCatchUp(
  lastMoved: Date,
  now: Date,
  advanceDaysPerRealDay: number = PM_ADVANCE_DAYS,
  cap: number = PM_CATCHUP_MAX_SIM_DAYS
): CatchUpPlan {
  const realDays = Math.floor((now.getTime() - lastMoved.getTime()) / 86_400_000);
  if (realDays < 1 || advanceDaysPerRealDay <= 0 || cap <= 0) {
    return { realDays: Math.max(0, realDays), owed: 0, applying: 0, mark: lastMoved };
  }

  const owed = realDays * advanceDaysPerRealDay;
  const applying = Math.min(owed, cap);
  const consumedRealDays = applying / advanceDaysPerRealDay;
  return {
    realDays,
    owed,
    applying,
    mark: new Date(lastMoved.getTime() + consumedRealDays * 86_400_000),
  };
}
