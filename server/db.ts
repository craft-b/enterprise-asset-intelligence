import dotenv from 'dotenv';
dotenv.config();

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "@shared/schema";

// The connection is built on first use, not on import.
//
// This module used to throw at import time when DATABASE_URL was missing,
// which meant any module that touched the database could not be imported
// without one -- including, transitively, four test files that exercise pure
// functions and never open a connection. CI runs `npm test` with no database
// configured, so those four failed on import and the suite was red on main
// while passing on every machine that happened to have a .env.
//
// Import-time side effects that need the environment are the problem. A
// missing DATABASE_URL is still fatal, but it is fatal where it can be
// reported properly: assertDatabaseConfigured() at boot in index.ts, and
// otherwise at the first query rather than the first import.

function createDb(connection: mysql.Pool) {
  return drizzle(connection, { schema, mode: 'default' });
}

type Database = ReturnType<typeof createDb>;

let realPool: mysql.Pool | undefined;
let realDb: Database | undefined;

/** The message both the boot check and the first query share. */
const MISSING = "DATABASE_URL must be set. Did you forget to provision a database?";

function connect(): void {
  if (!process.env.DATABASE_URL) throw new Error(MISSING);
  realPool = mysql.createPool(process.env.DATABASE_URL);
  realDb = createDb(realPool);
}

/**
 * Fails fast at boot, so a misconfigured deployment says so immediately
 * instead of serving 500s from the first request that happens to query.
 */
export function assertDatabaseConfigured(): void {
  if (!process.env.DATABASE_URL) throw new Error(MISSING);
}

/**
 * Forwards to the real object, creating it on the first property read.
 * Methods are bound to the real target: mysql2 and drizzle both rely on
 * `this`, and handing them the proxy breaks them in ways that surface much
 * later than here.
 */
function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve() as any;
      const value = real[prop];
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_target, prop) {
      return prop in (resolve() as any);
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as any);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolve() as any, prop);
    },
  });
}

export const pool = lazy<mysql.Pool>(() => {
  if (!realPool) connect();
  return realPool!;
});

export const db = lazy<Database>(() => {
  if (!realDb) connect();
  return realDb!;
});
