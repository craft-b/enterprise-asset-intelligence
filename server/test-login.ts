// server/test-login.ts
//
// A login for automated tests, and nothing else.
//
// Every sweep of this codebase so far has read source or exercised the data
// layer. Nothing confirmed that a route actually answers correctly, which is
// the gap GET /api/rentals lived in for weeks: it returned 500 on every call
// and no test noticed, because no test ever made the call.
//
// Closing that needs a session, and a session needs a password nobody should
// be typing into a deployed app. So this exists -- and because an auth bypass
// is the worst possible thing to get wrong, it is written to be impossible in
// production rather than merely switched off there:
//
//   1. NODE_ENV === "production" refuses to register it. This is checked
//      first and cannot be overridden by configuration, so shipping the
//      secret by accident still gets you nothing.
//   2. Absent or short TEST_LOGIN_SECRET refuses to register it. The default
//      state of every environment is "no route", not "weak route".
//   3. The secret is compared in constant time, like the agent key.
//   4. It only ever adopts a user that already exists, by id. It cannot
//      create one, cannot escalate a role, and cannot invent an identity --
//      whatever the row says is what the session gets.
//   5. Registering it logs loudly, so a server that has it enabled says so in
//      its own startup output.
//
// Worth stating plainly: this is still an auth bypass. It belongs in local
// runs and CI against a throwaway database, and the guards above are what
// keep it from being anything more.

import type { Express } from "express";
import { timingSafeEqual } from "crypto";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

/** Short secrets are guessable; refuse to be the weak link. */
const MIN_SECRET_LENGTH = 24;

export interface TestLoginDecision {
  enabled: boolean;
  reason: string;
}

/**
 * Whether the route may exist at all, given the environment.
 *
 * Separated from the wiring so the decision can be tested directly -- a
 * bypass that is only verified by whether a server happens to boot with it is
 * not verified.
 */
export function testLoginDecision(env: NodeJS.ProcessEnv = process.env): TestLoginDecision {
  if (env.NODE_ENV === "production") {
    return { enabled: false, reason: "NODE_ENV is production" };
  }
  const secret = env.TEST_LOGIN_SECRET?.trim();
  if (!secret) {
    return { enabled: false, reason: "TEST_LOGIN_SECRET is not set" };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      enabled: false,
      reason: `TEST_LOGIN_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`,
    };
  }
  return { enabled: true, reason: "enabled for a non-production run" };
}

/** Constant-time compare, so the secret's length and prefix do not leak. */
function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Register POST /api/test-login when, and only when, it is allowed to exist.
 *
 * Returns the decision so the caller can log it.
 */
export function registerTestLogin(app: Express): TestLoginDecision {
  const decision = testLoginDecision();
  if (!decision.enabled) return decision;

  console.warn(
    `[TEST-LOGIN] ⚠  POST /api/test-login is ENABLED (${decision.reason}). ` +
    `This bypasses password authentication and must never run in production.`
  );

  app.post("/api/test-login", (req, res, next) => {
    void (async () => {
      try {
        const secret = process.env.TEST_LOGIN_SECRET ?? "";
        const provided = String(req.headers["x-test-login"] ?? "");
        if (!matches(provided, secret)) {
          return res.status(401).json({ message: "Invalid test login secret" });
        }

        const userId = Number(req.body?.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return res.status(400).json({ message: "userId must be a positive integer" });
        }

        // Adopt an existing identity; never mint one. A test that needs a
        // particular role needs a user with that role to already exist.
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return res.status(404).json({ message: `No user with id ${userId}` });

        (req.session as any).userId = user.id;
        (req.session as any).role = user.role;
        res.json({ id: user.id, username: user.username, role: user.role });
      } catch (err) {
        next(err);
      }
    })();
  });

  return decision;
}
