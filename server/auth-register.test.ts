// server/auth-register.test.ts
//
// POST /api/auth/register is unauthenticated, and it was validating its body
// against insertUserSchema -- which is derived from the users table and
// therefore accepted `role`. The route spreads the parsed input straight into
// storage.createUser and then logs the new account in:
//
//   const user = await storage.createUser({ ...input, password: hash });
//   req.session.userId = user.id;
//   req.session.role = user.role;
//
// So one unauthenticated request with {"role":"ADMINISTRATOR"} created an
// administrator and returned a live admin session for it, which satisfies
// every requireAdmin gate: equipment and rental deletes, /api/admin/reset,
// /api/ml/models/promote, /api/simulate/day.
//
// The login page's form only ever sent username and password, so nothing in
// the UI reached this and nothing looked wrong from the browser.
//
// These tests pin the two halves apart: the public route must not accept a
// role, and the storage-layer schema must keep accepting one, because
// seedDemoUsers creates the ADMINISTRATOR account with it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { insertUserSchema, registerUserSchema } from "@shared/schema";
import { api } from "@shared/routes";

describe("public registration cannot ask for a role", () => {
  it("drops role from an otherwise valid body", () => {
    const parsed = registerUserSchema.parse({
      username: "anyone",
      password: "hunter2",
      role: "ADMINISTRATOR",
    });
    expect(parsed).not.toHaveProperty("role");
    expect(Object.keys(parsed).sort()).toEqual(["password", "username"]);
  });

  it("drops it for VIEWER too", () => {
    // Not because VIEWER is harmful, but because the field being honoured at
    // all is the defect. Accepting the harmless value is how the harmful one
    // stays reachable after a refactor.
    const parsed = registerUserSchema.parse({
      username: "anyone",
      password: "hunter2",
      role: "VIEWER",
    });
    expect(parsed).not.toHaveProperty("role");
  });

  it("is the schema the route contract actually uses", () => {
    // The route parses api.auth.register.input. A fix applied only to the
    // exported schema, without repointing the contract, would leave the hole
    // open and these tests green.
    const parsed = api.auth.register.input.parse({
      username: "anyone",
      password: "hunter2",
      role: "ADMINISTRATOR",
    });
    expect(parsed).not.toHaveProperty("role");
  });

  it("still enforces the password floor", () => {
    expect(() => registerUserSchema.parse({ username: "anyone", password: "short" })).toThrow();
  });

  it("still requires a username", () => {
    expect(() => registerUserSchema.parse({ password: "hunter2" })).toThrow();
  });
});

describe("the storage-layer schema keeps role", () => {
  it("accepts ADMINISTRATOR", () => {
    // seedDemoUsers passes role: "ADMINISTRATOR" through this type. Omitting
    // role here instead of in a registration-only schema would have broken
    // the seed, which is why there are two schemas rather than one.
    const parsed = insertUserSchema.parse({
      username: "admin",
      password: "a-long-enough-password",
      role: "ADMINISTRATOR",
    });
    expect(parsed.role).toBe("ADMINISTRATOR");
  });

  it("leaves role unset when it is not supplied", () => {
    // The column default (VIEWER) then applies, which is what a registration
    // now gets.
    const parsed = insertUserSchema.parse({ username: "x", password: "a-long-enough-password" });
    expect(parsed.role).toBeUndefined();
  });
});

describe("the route does not reach around the schema", () => {
  const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf-8");
  const REGISTER = ROUTES.slice(
    ROUTES.indexOf("api.auth.register.path"),
    ROUTES.indexOf("── EQUIPMENT"),
  );

  it("builds the new user from the parsed input, not the raw body", () => {
    expect(REGISTER).toMatch(/api\.auth\.register\.input\.parse\(req\.body\)/);
    expect(REGISTER).not.toMatch(/req\.body\.role/);
  });

  it("writes the role the database returned, not one from the request", () => {
    // req.session.role comes off the persisted user, so the column default is
    // what lands in the session.
    expect(REGISTER).toMatch(/req\.session\.role = user\.role/);
  });
});

describe("the first account on an empty instance is the administrator", () => {
  // Source-level, like the guard checks: exercising this needs a database,
  // and the thing worth pinning is that the decision is made from a count of
  // existing rows rather than from anything in the request.
  const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf-8");
  const REGISTER = ROUTES.slice(
    ROUTES.indexOf("api.auth.register.path"),
    ROUTES.indexOf("── EQUIPMENT"),
  );

  it("decides from a count of existing users", () => {
    expect(REGISTER).toMatch(/select\(\{ existing: count\(\) \}\)\.from\(users\)/);
    expect(REGISTER).toMatch(/isFirstAccount/);
  });

  it("grants ADMINISTRATOR only when that count is zero", () => {
    expect(REGISTER).toMatch(/Number\(counted\?\.existing \?\? 0\) === 0/);
    expect(REGISTER).toMatch(/isFirstAccount \? \{ role: "ADMINISTRATOR" as const \} : \{\}/);
  });

  it("adds no second route to the role, and still ignores the body", () => {
    // The only two ways an account can become an administrator are this count
    // and the seed. Neither reads req.body.
    //
    // Counted over code only: the comment above the check names the role
    // twice, and a word count that includes prose measures the prose.
    const code = REGISTER.split(/\r?\n/)
      .filter(line => !line.trim().startsWith("//"))
      .join(" ");
    expect(code).not.toMatch(/req\.body\.role/);
    expect(code.match(/ADMINISTRATOR/g) ?? []).toHaveLength(1);
  });

  it("cannot fire on a seeded deployment, because reset keeps the users", () => {
    // The safety argument for the whole mechanism: `users` is absent from
    // TABLES_TO_CLEAR, so once admin and viewer exist the count is never zero
    // again and no reseed can hand an administrator to a stranger.
    const ORCHESTRATOR = readFileSync(
      join(__dirname, "services", "seed-orchestrator.ts"), "utf-8"
    );
    const clearList = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf("const TABLES_TO_CLEAR"),
      ORCHESTRATOR.indexOf("export async function resetSystem"),
    );
    expect(clearList).not.toMatch(/"users"/);
    expect(clearList).toMatch(/"equipment"/);
  });
});
