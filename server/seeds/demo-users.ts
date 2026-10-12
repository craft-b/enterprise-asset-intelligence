// server/seeds/demo-users.ts
//
// Creates the two accounts the login screen advertises, when SEED_DEMO_USERS
// is truthy.
//
// A public demo whose sign-in page names credentials that do not exist is
// worse than one with no credentials at all: the visitor types what they were
// told, is rejected, and leaves. Registering first is its own kind of friction
// -- someone spending ninety seconds on a portfolio link will not fill in a
// signup form, and asking them to is a strange thing for a demo to do.
//
// Off by default, and deliberately so. These are published passwords on an
// account that can create, modify and delete equipment, advance the
// simulation and reseed the database. That is the right trade on a demo full
// of synthetic data and completely wrong anywhere else, so a real deployment
// has to opt in rather than inherit it by forgetting to opt out. Same shape as
// ENABLE_API_DOCS.
//
// Idempotent: existing accounts are left exactly as they are, so a password
// changed in a running instance is never silently reset.

import { storage } from "../storage";
import bcrypt from "bcryptjs";

/** Matches the credentials printed on the login page. */
const DEMO_USERS = [
  { username: "admin", password: "admin123", role: "ADMINISTRATOR" as const },
  { username: "viewer", password: "viewer123", role: "VIEWER" as const },
];

/** bcrypt cost. Matches the registration route. */
const BCRYPT_ROUNDS = 10;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function enabled(value: string | undefined): boolean {
  // A Set, not `in {...}`: object key lookup also matches inherited members,
  // so SEED_DEMO_USERS=constructor would have switched this on.
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

export async function seedDemoUsers(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  if (!enabled(env.SEED_DEMO_USERS)) return { created, skipped };

  for (const demo of DEMO_USERS) {
    const existing = await storage.getUserByUsername(demo.username);
    if (existing) {
      skipped.push(demo.username);
      continue;
    }

    await storage.createUser({
      username: demo.username,
      password: bcrypt.hashSync(demo.password, BCRYPT_ROUNDS),
      role: demo.role,
    });
    created.push(demo.username);
  }

  if (created.length) {
    console.log(
      `[DEMO-USERS] created ${created.join(", ")} — published credentials, ` +
        `enabled by SEED_DEMO_USERS`
    );
  }
  if (skipped.length) {
    console.log(`[DEMO-USERS] already present: ${skipped.join(", ")}`);
  }

  return { created, skipped };
}

export const DEMO_USERNAMES = DEMO_USERS.map(u => u.username);
