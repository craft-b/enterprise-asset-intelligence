// server/services/simulation-clock.ts
//
// What "now" means to this system.
//
// The fleet lives on a simulation cursor, not the wall clock. Seeded sensor
// data, feature snapshots, labelling and the nightly crons all work from
// simulation_state.cursor_date, and the daily job advances it. Batch scoring
// did not: it snapshotted at new Date(), so on a deployment seeded to
// 2026-04-01 and opened in October, every asset was scored against a world
// that had ended 195 days earlier. Rolling sensor windows came back empty and
// imputed, days_since_last_maintenance read ~200, and the result was a
// ten-asset fleet with seven HIGH and no LOW -- a model that looks like it
// outputs one number regardless of input, on predictions whose own metadata
// says it does not.
//
// The cursor is the only clock the rest of the pipeline uses, so it is the one
// that keeps scoring consistent with the data being scored.

import { db } from "../db";
import { sql } from "drizzle-orm";

/**
 * The system's current date.
 *
 * Falls back to the wall clock when no cursor row exists, which is the state
 * of a fresh install before any seed or simulation run.
 */
export async function getSimulationDate(): Promise<Date> {
  try {
    const [rows] = (await db.execute(
      sql`SELECT cursor_date FROM simulation_state WHERE id = 1`
    )) as any;
    const raw = (rows as any[])[0]?.cursor_date;
    if (raw) {
      const when = new Date(raw);
      if (!Number.isNaN(when.getTime())) return when;
    }
  } catch {
    // No simulation_state table yet (pre-migration) — the wall clock is the
    // only answer available, and refusing to score would be worse.
  }
  return new Date();
}
