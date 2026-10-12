// server/services/request-log.test.ts
//
// The regression this pins, taken verbatim from the deployed logs:
//
//   GET /api/auth/me 304 in 251ms :: {"id":1,"username":"admin",
//     "password":"$2b$10$Mt6ks.bxwJnbipmvIGUUo...","role":"ADMINISTRATOR"}
//
// A bcrypt hash in the platform's log retention, written on every session
// check. The fix is that no value from an object body is ever copied into a
// log line, so the next field someone adds cannot leak the same way.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { summariseBody } from "./request-log";

const HASH = "$2b$10$Mt6ks.bxwJnbipmvIGUUo.9UgJxcpqn9c8FpGPsVQjmPmpnrhv.Qy";

describe("summariseBody", () => {
  it("never emits the password hash from a user body", () => {
    const line = summariseBody({
      id: 1,
      username: "admin",
      password: HASH,
      role: "ADMINISTRATOR",
    });

    expect(line).not.toContain(HASH);
    expect(line).not.toContain("$2b$");
    // Keys are useful for debugging; values are not worth the risk.
    expect(line).toBe(" :: {id, username, password, role}");
  });

  it("emits no value from any object body", () => {
    const line = summariseBody({
      token: "tok_live_abc123",
      apiKey: "sk-secret",
      email: "someone@example.com",
    });

    expect(line).not.toContain("tok_live_abc123");
    expect(line).not.toContain("sk-secret");
    expect(line).not.toContain("someone@example.com");
  });

  it("counts an array instead of printing it", () => {
    // The equipment list used to be logged in full, ten objects deep.
    const equipment = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      serialNumber: `SN-${i}`,
    }));

    expect(summariseBody(equipment)).toBe(" :: 10 item(s)");
    expect(summariseBody(equipment)).not.toContain("SN-");
  });

  it("keeps our own error messages, which are worth reading", () => {
    expect(summariseBody({ message: "Failed to fetch due-soon maintenance" }))
      .toBe(" :: Failed to fetch due-soon maintenance");
  });

  it("truncates a long message so one line cannot flood the log", () => {
    const line = summariseBody({ message: "x".repeat(500) });
    expect(line.length).toBeLessThan(140);
  });

  it("does not treat a data object as an error just because it has a message", () => {
    // Three or more keys means it is a payload, not one of our error shapes.
    const line = summariseBody({ message: "hi", password: HASH, id: 1 });
    expect(line).not.toContain(HASH);
    expect(line).toBe(" :: {message, password, id}");
  });

  it("caps how many keys it names", () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const line = summariseBody(wide);
    expect(line).toContain("+12");
    expect(line.length).toBeLessThan(120);
  });

  it.each([undefined, null, "a string", 42, true])("emits nothing for %s", value => {
    expect(summariseBody(value)).toBe("");
  });
});

describe("the logger uses it", () => {
  const index = readFileSync(join(__dirname, "..", "index.ts"), "utf-8");

  it("no longer stringifies response bodies", () => {
    expect(index).not.toMatch(/JSON\.stringify\(capturedJsonResponse\)/);
    expect(index).toContain("summariseBody(capturedJsonResponse)");
  });
});
