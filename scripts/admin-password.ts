// scripts/admin-password.ts
//
// Set an administrator's password, or print the SQL that would.
//
// This exists because there was no way back. The demo seeder refuses to touch
// an account that already exists -- deliberately, so a password changed in a
// running instance is never silently reset -- and the first-account rule in
// the register route only fires on an empty users table. So once the live
// admin password was rotated away from the committed default, the only
// remaining route to administrator was direct database access, and the only
// copy of the new password was a text file.
//
// Two modes, because the useful one depends on where the database is:
//
//   --print-sql   compute the hash and print an UPDATE statement. Nothing is
//                 connected to. Paste the statement into whatever console the
//                 host gives you (TiDB Cloud, a MySQL shell). This is the
//                 mode to use against the deployed database, which is not
//                 reachable from a developer machine.
//
//   (default)     connect using DATABASE_URL and apply it. For local and
//                 self-hosted instances.
//
// The password is read from argv so it never has to be pasted into a chat, a
// ticket, or a commit. It is never logged, and --print-sql emits the bcrypt
// hash rather than the password.
//
//   npx tsx scripts/admin-password.ts --user admin --password 'new value' --print-sql
//   npx tsx scripts/admin-password.ts --user admin --password 'new value'

import bcrypt from "bcryptjs";

/** Matches the registration route and the demo seeder. */
const BCRYPT_ROUNDS = 10;

interface Args {
  user: string;
  password: string;
  printSql: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const user = get("--user") ?? "admin";
  const password = get("--password");
  const printSql = argv.includes("--print-sql");

  if (!password) {
    throw new Error(
      "--password is required.\n" +
        "  npx tsx scripts/admin-password.ts --user admin --password 'new value' --print-sql",
    );
  }
  // bcrypt silently truncates at 72 bytes, so a longer passphrase would have
  // a prefix that also authenticates. Refuse rather than quietly shorten.
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("password is longer than bcrypt's 72-byte limit; choose a shorter one");
  }
  return { user, password, printSql };
}

/** The statement that sets the hash, with the value already escaped by shape. */
export function updateSql(user: string, hash: string): string {
  // A bcrypt hash is [./A-Za-z0-9$] only, so it cannot carry a quote out of
  // this template; the username is the only field worth checking.
  if (!/^[A-Za-z0-9_.@-]+$/.test(user)) {
    throw new Error(`refusing to build SQL for an unusual username: ${JSON.stringify(user)}`);
  }
  return `UPDATE users SET password = '${hash}' WHERE username = '${user}';`;
}

async function main(): Promise<void> {
  const { user, password, printSql } = parseArgs(process.argv.slice(2));
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  if (printSql) {
    console.log();
    console.log(updateSql(user, hash));
    console.log();
    console.log("Run that in the database console, then sign in with the new password.");
    console.log("Check it affected one row; zero means no account by that name.");
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Use --print-sql and run the statement by hand.");
    process.exit(1);
  }

  const { db } = await import("../server/db.js");
  const { pool } = await import("../server/db.js");
  const { sql } = await import("drizzle-orm");

  const [result] = (await db.execute(
    sql`UPDATE users SET password = ${hash} WHERE username = ${user}`,
  )) as any;

  const changed = Number(result?.affectedRows ?? 0);
  await pool.end();

  if (changed === 0) {
    console.error(`No account named "${user}". Nothing changed.`);
    process.exit(1);
  }
  console.log(`Updated the password for "${user}".`);
}

// Importable by the tests without running anything.
if (process.argv[1] && process.argv[1].endsWith("admin-password.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
