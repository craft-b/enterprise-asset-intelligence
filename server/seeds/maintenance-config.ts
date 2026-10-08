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

export async function seedMaintenanceConfig() {
  const configs = [
    { equipmentCategory: "Excavator", recommendedIntervalDays: 180 },
    { equipmentCategory: "Lift", recommendedIntervalDays: 90 },
    { equipmentCategory: "Dozer", recommendedIntervalDays: 180 },
    { equipmentCategory: "Loader", recommendedIntervalDays: 150 },
    { equipmentCategory: "Generator", recommendedIntervalDays: 120 },
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
