// server/test-login.test.ts
//
// This is an authentication bypass. It exists so HTTP-level tests can hold a
// session without anyone typing a password into a deployed app, and the whole
// reason it is acceptable is the set of conditions under which it refuses to
// exist. Those conditions are the thing worth testing -- a bypass verified
// only by "the server booted and the tests passed" is not verified at all.

import { describe, it, expect } from "vitest";
import { testLoginDecision } from "./test-login";

const LONG = "x".repeat(40);

describe("the test login refuses to exist unless it is safe", () => {
  it("is off in production, whatever else is configured", () => {
    // Checked before anything else, so shipping the secret by accident still
    // gets you nothing.
    const d = testLoginDecision({ NODE_ENV: "production", TEST_LOGIN_SECRET: LONG } as any);
    expect(d.enabled).toBe(false);
    expect(d.reason).toMatch(/production/);
  });

  it("is off when no secret is set", () => {
    // The default state of an environment that has not opted in.
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      expect(testLoginDecision(env as any).enabled, JSON.stringify(env)).toBe(false);
    }
  });

  it("is off for an empty or whitespace secret", () => {
    expect(testLoginDecision({ NODE_ENV: "test", TEST_LOGIN_SECRET: "" } as any).enabled).toBe(false);
    expect(testLoginDecision({ NODE_ENV: "test", TEST_LOGIN_SECRET: "   " } as any).enabled).toBe(false);
  });

  it("is off for a guessable secret", () => {
    for (const secret of ["test", "secret", "x".repeat(23)]) {
      const d = testLoginDecision({ NODE_ENV: "test", TEST_LOGIN_SECRET: secret } as any);
      expect(d.enabled, secret).toBe(false);
      expect(d.reason).toMatch(/shorter than/);
    }
  });

  it("is on only for a non-production run with a long secret", () => {
    const d = testLoginDecision({ NODE_ENV: "test", TEST_LOGIN_SECRET: LONG } as any);
    expect(d.enabled).toBe(true);
  });

  it("never enables on production even with every other condition met", () => {
    // The combination that would be most tempting to allow.
    for (const secret of [LONG, "y".repeat(100)]) {
      expect(
        testLoginDecision({ NODE_ENV: "production", TEST_LOGIN_SECRET: secret } as any).enabled
      ).toBe(false);
    }
  });
});

describe("the route cannot invent an identity", () => {
  const SRC = (() => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    return readFileSync(join(__dirname, "test-login.ts"), "utf-8");
  })();

  it("only ever selects an existing user", () => {
    // A bypass that could create a user, or take a role from the request,
    // would be an escalation path rather than a convenience.
    expect(SRC).toMatch(/db\.select\(\)\.from\(users\)/);
    expect(SRC).not.toMatch(/db\.insert\(users\)/);
  });

  it("takes the role from the row, not from the caller", () => {
    expect(SRC).toMatch(/role = user\.role/);
    expect(SRC).not.toMatch(/req\.body\?\.role|req\.body\.role/);
  });

  it("compares the secret in constant time", () => {
    expect(SRC).toMatch(/timingSafeEqual/);
  });

  it("says so in the server log when it is enabled", () => {
    expect(SRC).toMatch(/TEST-LOGIN/);
    expect(SRC).toMatch(/never run in production/);
  });
});
