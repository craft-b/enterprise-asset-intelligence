// server/services/session-store.test.ts
//
// Cross-layer contract test (SEC-3 / QA-1): the session store's SQL is written
// by a third-party library against column names we configure, while the table
// itself is created by a Drizzle migration. Nothing in the type system ties
// those two together -- a rename on either side compiles fine and fails at
// runtime on the first login.
//
// These tests pin that contract by capturing the SQL the store actually emits
// against a stub pool and checking every identifier in it against the real
// migration file. No database required.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import session from "express-session";
import mysql from "mysql2";
import {
  createSessionStore,
  sessionStoreOptions,
  SESSION_TABLE,
  SESSION_COLUMNS,
  SESSION_TTL_MS,
} from "./session-store";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

/** The CREATE TABLE statement for `sessions`, from whichever migration adds it. */
function sessionMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql"));
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
    const match = sql.match(
      new RegExp("CREATE TABLE\\s+`" + SESSION_TABLE + "`[\\s\\S]*?;", "i")
    );
    if (match) return match[0];
  }
  throw new Error(`no migration creates the \`${SESSION_TABLE}\` table`);
}

/** Run a full session lifecycle against a stub pool, returning the SQL emitted. */
async function captureSql(): Promise<string[]> {
  const seen: string[] = [];
  const stubPool = {
    query(sql: unknown, params: unknown[]) {
      seen.push(mysql.format(String(sql), (params as any[]) ?? []).replace(/\s+/g, " ").trim());
      return Promise.resolve([[], []]);
    },
  };

  const store: any = createSessionStore(session, stubPool);
  const sid = "AbC-XyZ_123";
  const data = { cookie: { maxAge: SESSION_TTL_MS }, userId: 7, role: "ADMINISTRATOR" };

  await store.set(sid, data);
  await store.get(sid);
  await store.touch(sid, data);
  await store.length();
  await store.destroy(sid);
  await store.clearExpiredSessions();
  store.clearExpirationInterval();

  return seen;
}

describe("session store (SEC-3)", () => {
  let emitted: string[];
  let migration: string;

  beforeAll(async () => {
    emitted = await captureSql();
    migration = sessionMigrationSql();
  });

  it("is a real express-session store", () => {
    const store = createSessionStore(session, { query: () => Promise.resolve([[], []]) });
    expect(store).toBeInstanceOf(session.Store);
    (store as any).clearExpirationInterval();
  });

  it("emits no DDL — the migration owns the schema (ARCH-1)", () => {
    expect(sessionStoreOptions().createDatabaseTable).toBe(false);
    const all = emitted.join("\n");
    expect(all).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
  });

  it("only references identifiers the migration creates", () => {
    const declared = new Set<string>([SESSION_TABLE]);
    // Column names as written in the CREATE TABLE body.
    for (const m of migration.matchAll(/`([a-z_]+)`\s+(?:varchar|int|mediumtext)/gi)) {
      declared.add(m[1]);
    }

    const used = new Set(
      emitted.flatMap(q => [...q.matchAll(/`([a-z_]+)`/g)].map(m => m[1]))
    );

    expect(used.size).toBeGreaterThan(0);
    const undeclared = [...used].filter(id => !declared.has(id));
    expect(undeclared, `identifiers not in the migration: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("reads and writes every column the migration declares", () => {
    const all = emitted.join("\n");
    for (const col of Object.values(SESSION_COLUMNS)) {
      expect(all, `store never touches \`${col}\``).toContain(`\`${col}\``);
      expect(migration, `migration never declares \`${col}\``).toContain(`\`${col}\``);
    }
  });

  it("upserts on the primary key the migration defines", () => {
    // set() relies on ON DUPLICATE KEY UPDATE, which is a no-op unless
    // session_id is a unique/primary key. ARCH-2 is this same bug elsewhere.
    const upsert = emitted.find(q => /INSERT INTO/i.test(q));
    expect(upsert).toBeDefined();
    expect(upsert!).toMatch(/ON DUPLICATE KEY UPDATE/i);
    expect(migration).toMatch(
      new RegExp("PRIMARY KEY\\s*\\(`" + SESSION_COLUMNS.session_id + "`\\)", "i")
    );
  });

  it("stores expires as unix seconds that fit the column type", () => {
    const insert = emitted.find(q => /INSERT INTO/i.test(q))!;
    const ts = Number(insert.match(/VALUES\s*\('[^']*',\s*(\d+)/)![1]);

    // Seconds, not milliseconds — a ms value would overflow int unsigned.
    const nowSec = Math.floor(Date.now() / 1000);
    expect(ts).toBeGreaterThan(nowSec - 60);
    expect(ts).toBeLessThanOrEqual(nowSec + Math.ceil(SESSION_TTL_MS / 1000) + 60);

    expect(migration).toMatch(/`expires`\s+int unsigned/i);
    expect(ts).toBeLessThan(4294967295); // int unsigned ceiling (year 2106)
  });

  it("keeps session_id case-sensitive so id entropy is preserved", () => {
    // A default *_ci collation would make 'AbC' and 'abc' the same session.
    expect(migration).toMatch(/`session_id`[^,]*COLLATE utf8mb4_bin/i);
  });

  it("sweeps expired rows so the table cannot grow without bound", () => {
    const opts = sessionStoreOptions();
    expect(opts.clearExpired).toBe(true);
    expect(opts.checkExpirationInterval).toBeGreaterThan(0);
    expect(emitted.some(q => /DELETE FROM `sessions` WHERE `expires` </i.test(q))).toBe(true);
  });
});
