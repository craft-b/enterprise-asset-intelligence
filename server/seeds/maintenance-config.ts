import { db } from "../db";
import { maintenanceConfig } from "@shared/schema";

/**
 * MySQL error code for a unique-constraint violation.
 * maintenanceConfig.equipmentCategory is unique, so re-seeding an already
 * seeded database raises exactly this and nothing else.
 */
const ER_DUP_ENTRY = "ER_DUP_ENTRY";

/**
 * True only for a duplicate-key error.
 *
 * The cause chain is walked because drizzle-mysql2 currently lets the raw
 * mysql2 error through, but DrizzleQueryError (which nests the driver error
 * under `cause`) exists and other dialects already use it -- an upgrade that
 * starts wrapping should not silently turn every error back into "already
 * exists".
 */
function isDuplicateKey(error: unknown): boolean {
  for (let e: any = error; e != null; e = e.cause) {
    if (e.code === ER_DUP_ENTRY || e.errno === 1062) return true;
  }
  return false;
}

/**
 * Interval used for a category with no row of its own.
 *
 * Exported because two services needed it and had picked different numbers --
 * feature engineering assumed 90 days and risk scoring 180, so the same asset
 * was "overdue" to one and current to the other, with nothing reconciling them.
 */
export const DEFAULT_MAINTENANCE_INTERVAL_DAYS = 120;

export async function seedMaintenanceConfig() {
  // Every category in the demo fleet needs a row here. Six of the ten assets
  // -- both cranes, the grader, hauler, compressor and compactor -- had none
  // and silently fell back to a default, so a tower crane was scheduled on the
  // same interval as a walk-behind roller. Dozer was configured for a category
  // the fleet does not contain.
  const configs = [
    { equipmentCategory: "Crane", recommendedIntervalDays: 90 },
    { equipmentCategory: "Grader", recommendedIntervalDays: 180 },
    { equipmentCategory: "Lift", recommendedIntervalDays: 90 },
    { equipmentCategory: "Excavator", recommendedIntervalDays: 180 },
    { equipmentCategory: "Hauler", recommendedIntervalDays: 150 },
    { equipmentCategory: "Compressor", recommendedIntervalDays: 120 },
    { equipmentCategory: "Loader", recommendedIntervalDays: 150 },
    { equipmentCategory: "Compactor", recommendedIntervalDays: 150 },
    { equipmentCategory: "Generator", recommendedIntervalDays: 120 },
    { equipmentCategory: "Dozer", recommendedIntervalDays: 180 },
  ];

  for (const config of configs) {
    try {
      await db.insert(maintenanceConfig).values(config);
      console.log(`✓ Seeded config for ${config.equipmentCategory}`);
    } catch (error) {
      // Only an existing row is benign. Anything else -- an unreachable
      // database, a missing table, bad credentials -- used to be swallowed
      // and reported as "already exists", so a boot against a dead DB logged
      // five lines of apparent success and carried on. Let it escape: the
      // boot catch in index.ts turns it into one clear line and exit 1.
      if (!isDuplicateKey(error)) throw error;
      console.log(`Config for ${config.equipmentCategory} already exists`);
    }
  }
}
