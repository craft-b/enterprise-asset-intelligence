// server/services/public-user.test.ts
//
// The regression: /api/auth/me, login and register each returned the raw user
// row, so every session check shipped the bcrypt hash to the browser and into
// the platform's logs. These tests pin the shape, and pin that routes.ts
// actually uses it -- a handler that forgets would reintroduce the leak while
// every unit test here still passed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { toPublicUser } from "./public-user";

const row = {
  id: 1,
  username: "admin",
  password: "$2b$10$Mt6ks.bxwJnbipmvIGUUo.9UgJxcpqn9c8FpGPsVQjmPmpnrhv.Qy",
  role: "ADMINISTRATOR",
  createdAt: new Date("2026-10-12T15:23:39.000Z"),
} as any;

describe("toPublicUser", () => {
  it("drops the password hash", () => {
    const publicUser = toPublicUser(row) as any;

    expect(publicUser.password).toBeUndefined();
    expect(JSON.stringify(publicUser)).not.toContain("$2b$");
    expect(JSON.stringify(publicUser)).not.toContain(row.password);
  });

  it("keeps what the client actually needs", () => {
    expect(toPublicUser(row)).toEqual({
      id: 1,
      username: "admin",
      role: "ADMINISTRATOR",
      createdAt: row.createdAt,
    });
  });

  it("is an allowlist, so a new column does not leak by default", () => {
    const withSecret = { ...row, resetToken: "tok_live_123", mfaSecret: "JBSWY3DP" };

    const publicUser = toPublicUser(withSecret) as any;

    expect(publicUser.resetToken).toBeUndefined();
    expect(publicUser.mfaSecret).toBeUndefined();
    expect(Object.keys(publicUser).sort()).toEqual(["createdAt", "id", "role", "username"]);
  });

  it("passes undefined through for a missing user", () => {
    expect(toPublicUser(undefined)).toBeUndefined();
  });

  it("normalises a missing createdAt to null rather than dropping it", () => {
    const publicUser = toPublicUser({ ...row, createdAt: undefined });
    expect(publicUser).toHaveProperty("createdAt", null);
  });
});

describe("auth routes use it", () => {
  const routes = readFileSync(join(__dirname, "..", "routes.ts"), "utf-8");

  it("never responds with a bare user row", () => {
    // These are the exact expressions that leaked.
    expect(routes).not.toMatch(/res\.json\(user\)/);
    expect(routes).not.toMatch(/res\.status\(201\)\.json\(user\)/);
    expect(routes).not.toMatch(/res\.json\(await storage\.getUser\(/);
  });

  it("wraps every auth response", () => {
    // login, register and /me.
    const wrapped = routes.match(/toPublicUser\(/g) ?? [];
    expect(wrapped.length).toBeGreaterThanOrEqual(3);
  });
});
