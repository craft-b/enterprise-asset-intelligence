// scripts/admin-password.test.ts
//
// The recovery tool for the case that actually happened: the live
// administrator password was rotated away from the committed default, the
// demo seeder refuses to overwrite an account that exists, and the
// first-account rule only fires on an empty users table. At that point the
// only route back to administrator is the database, and this is what builds
// the statement.
//
// Only the pure parts are tested here. The connected path needs a database,
// which is what the CI service container is for.

import { describe, it, expect } from "vitest";
import { parseArgs, updateSql } from "./admin-password";

describe("parseArgs", () => {
  it("defaults the user to admin", () => {
    expect(parseArgs(["--password", "x"]).user).toBe("admin");
  });

  it("takes an explicit user and the print-sql flag", () => {
    const a = parseArgs(["--user", "ops", "--password", "x", "--print-sql"]);
    expect(a).toEqual({ user: "ops", password: "x", printSql: true });
  });

  it("defaults to applying rather than printing", () => {
    // Printing is the safe mode, so it has to be asked for explicitly --
    // otherwise a reader skimming the help would assume the connected run
    // was the dry one.
    expect(parseArgs(["--password", "x"]).printSql).toBe(false);
  });

  it("refuses to run with no password", () => {
    expect(() => parseArgs(["--user", "admin"])).toThrow(/--password is required/);
  });

  it("refuses a password bcrypt would silently truncate", () => {
    // bcrypt stops at 72 bytes. A longer passphrase would have a prefix that
    // authenticates just as well, which is the kind of surprise a password
    // tool must not hand someone.
    expect(() => parseArgs(["--password", "a".repeat(73)]))
      .toThrow(/72-byte limit/);
    expect(() => parseArgs(["--password", "a".repeat(72)])).not.toThrow();
    // Counted in bytes, not characters.
    expect(() => parseArgs(["--password", "é".repeat(37)])).toThrow(/72-byte limit/);
  });
});

describe("updateSql", () => {
  const HASH = "$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123";

  it("builds an update keyed on the username", () => {
    expect(updateSql("admin", HASH))
      .toBe(`UPDATE users SET password = '${HASH}' WHERE username = 'admin';`);
  });

  it("refuses a username that could carry a quote out of the template", () => {
    // The hash cannot: bcrypt output is [./A-Za-z0-9$] only. The username is
    // the field worth checking, and this statement gets pasted into a console
    // with administrator rights.
    // "admin--" is deliberately absent: a double dash inside a quoted literal
    // is not a comment, and the hyphen cannot close the quote. Rejecting it
    // would be guarding the shape of the string rather than the risk.
    for (const bad of ["ad'min", "admin; DROP TABLE users", "ad min", 'ad"min']) {
      expect(() => updateSql(bad, HASH)).toThrow(/unusual username/);
    }
  });

  it("allows the shapes a real account name takes", () => {
    for (const ok of ["admin", "ops_user", "bobby.craft", "a@b.com", "admin-2"]) {
      expect(() => updateSql(ok, HASH)).not.toThrow();
    }
  });
});
