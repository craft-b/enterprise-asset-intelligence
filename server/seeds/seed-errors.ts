// server/seeds/seed-errors.ts
//
// Shared by the seeders so "this row already exists" stays benign while every
// other failure escapes.
//
// The seeders each had a bare `catch {}`, which made a schema mismatch
// indistinguishable from a re-run: job_sites and vendors inserted columns that
// do not exist, every insert errored, and the pipeline reported completed steps
// with zero rows. The data simply was not there and nothing said so.

/** MySQL error code for a unique-constraint violation. */
const ER_DUP_ENTRY = "ER_DUP_ENTRY";

/**
 * True only for a duplicate-key error.
 *
 * The cause chain is walked because drizzle's mysql-core session wraps every
 * query error in a DrizzleQueryError whose own message is just the SQL, with
 * the driver error underneath. Checking only the thrown object would never see
 * ER_DUP_ENTRY, so a re-run would look like a hard failure.
 */
export function isDuplicateKey(error: unknown): boolean {
  for (let e: any = error; e != null; e = e.cause) {
    if (e.code === ER_DUP_ENTRY || e.errno === 1062) return true;
  }
  return false;
}
