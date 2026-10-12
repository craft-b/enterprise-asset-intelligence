// server/seeds/demo-users.test.ts
//
// Two things matter here and they pull in opposite directions: the advertised
// credentials must exist on the demo, and they must never appear anywhere they
// were not explicitly asked for. Both directions are pinned.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserByUsername = vi.fn();
const createUser = vi.fn();

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({
  storage: {
    getUserByUsername: (...a: unknown[]) => getUserByUsername(...a),
    createUser: (...a: unknown[]) => createUser(...a),
  },
}));

import bcrypt from "bcryptjs";
import { seedDemoUsers, DEMO_USERNAMES } from "./demo-users";

describe("seedDemoUsers", () => {
  beforeEach(() => {
    getUserByUsername.mockReset().mockResolvedValue(undefined);
    createUser.mockReset().mockResolvedValue({});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  describe("disabled by default", () => {
    it.each([undefined, "", "false", "0", "no", "off"])(
      "creates nothing when SEED_DEMO_USERS=%s",
      async value => {
        const result = await seedDemoUsers({ SEED_DEMO_USERS: value } as any);

        expect(createUser).not.toHaveBeenCalled();
        expect(result.created).toEqual([]);
      }
    );

    it("is not switched on by an inherited object key", async () => {
      // `"constructor" in {...}` is true via the prototype chain, which an
      // object-literal lookup would have treated as truthy.
      for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        await seedDemoUsers({ SEED_DEMO_USERS: value } as any);
      }
      expect(createUser).not.toHaveBeenCalled();
    });
  });

  describe("when enabled", () => {
    it.each(["1", "true", "TRUE", " yes ", "on"])(
      "creates both accounts for SEED_DEMO_USERS=%s",
      async value => {
        const result = await seedDemoUsers({ SEED_DEMO_USERS: value } as any);
        expect(result.created).toEqual(DEMO_USERNAMES);
      }
    );

    it("creates exactly the usernames the login page advertises", async () => {
      await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      const names = createUser.mock.calls.map(c => c[0].username);
      expect(names).toEqual(["admin", "viewer"]);
    });

    it("gives admin ADMINISTRATOR and viewer VIEWER", async () => {
      await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      const byName = Object.fromEntries(
        createUser.mock.calls.map(c => [c[0].username, c[0].role])
      );
      expect(byName).toEqual({ admin: "ADMINISTRATOR", viewer: "VIEWER" });
    });

    it("stores a bcrypt hash, never the plaintext", async () => {
      await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      for (const [{ username, password }] of createUser.mock.calls as any) {
        expect(password).not.toBe(username === "admin" ? "admin123" : "viewer123");
        expect(password).toMatch(/^\$2[aby]\$/);
      }
    });

    it("stores hashes the login route will actually accept", async () => {
      // The seeded hash has to verify against the advertised password, or the
      // credentials on the page still do not work.
      await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      const expected: Record<string, string> = { admin: "admin123", viewer: "viewer123" };
      for (const [{ username, password }] of createUser.mock.calls as any) {
        expect(bcrypt.compareSync(expected[username], password)).toBe(true);
      }
    });
  });

  describe("idempotence", () => {
    it("leaves an existing account untouched", async () => {
      // Never silently reset a password someone changed in a live instance.
      getUserByUsername.mockResolvedValue({ id: 1, username: "admin" });

      const result = await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      expect(createUser).not.toHaveBeenCalled();
      expect(result.created).toEqual([]);
      expect(result.skipped).toEqual(DEMO_USERNAMES);
    });

    it("creates only the account that is missing", async () => {
      getUserByUsername.mockImplementation(async (name: string) =>
        name === "admin" ? { id: 1, username: "admin" } : undefined
      );

      const result = await seedDemoUsers({ SEED_DEMO_USERS: "true" } as any);

      expect(result.created).toEqual(["viewer"]);
      expect(result.skipped).toEqual(["admin"]);
    });
  });
});
