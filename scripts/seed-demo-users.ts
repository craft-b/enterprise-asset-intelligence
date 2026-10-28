// scripts/seed-demo-users.ts
//
// Creates the two accounts the login screen advertises, against whatever
// DATABASE_URL points at. Thin on purpose: it calls the same seeder the
// server runs at boot rather than inserting rows of its own, so nothing can
// authenticate through a path production does not have.
//
// Exists because CI needs it. server/http-smoke.test.ts signs in through
// /api/test-login as userId 1, which assumes a database that has been seeded
// at least once -- true of every environment the suite had ever run in,
// because until the CI job gained a database it only ran where someone had
// already seeded by hand. On a freshly migrated database the bypass issues no
// session and nine endpoint checks fail as 401 with one cause.
//
// Inlining this as `tsx -e "..."` in the workflow was the first attempt and
// failed with a bare exit code: an eval string is an awkward place for an ESM
// import, and an awkward place to read an error from. A file is easier to run
// locally too, which is the other reason to have it.
//
//   SEED_DEMO_USERS=true npx tsx scripts/seed-demo-users.ts

import { seedDemoUsers } from "../server/seeds/demo-users.js";
import { pool } from "../server/db.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set; nothing to seed.");
    process.exit(1);
  }

  const { created, skipped } = await seedDemoUsers();
  console.log(`demo users — created: [${created.join(", ")}] skipped: [${skipped.join(", ")}]`);

  // The seeder returns two empty lists when SEED_DEMO_USERS is falsy, which
  // is a no-op rather than an error in the server's boot path. Here it means
  // the caller asked for a seed and did not get one, and a silent success
  // would hand the test suite the empty database it cannot sign in to.
  if (created.length === 0 && skipped.length === 0) {
    console.error(
      "No accounts created or found. SEED_DEMO_USERS is " +
        `"${process.env.SEED_DEMO_USERS ?? "(unset)"}" — it must be truthy.`,
    );
    process.exit(1);
  }

  // The pool holds the process open otherwise.
  await pool.end();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("demo user seed failed:", err);
  process.exit(1);
});
