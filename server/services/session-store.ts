// server/services/session-store.ts
//
// SEC-3: MySQL-backed session store.
//
// express-session's default MemoryStore never evicts expired entries (it leaks
// under sustained login traffic) and it lives in the process, so sessions are
// lost on every restart, redeploy or scale-to-zero wake. Both matter for a
// hosted deployment: the first is a slow leak, the second signs out every user
// whenever the instance cycles.
//
// Two deliberate choices:
//   1. The store reuses the mysql2 pool from ./db instead of opening its own.
//      One pool, one DSN, one place where credentials are read.
//   2. createDatabaseTable is false. The `sessions` table is declared in
//      shared/schema.ts and created by migrations/0002 so Drizzle stays the
//      single owner of DDL (ARCH-1) -- the store does no schema work at boot.
//
// The table/column names below are the contract between this store and that
// migration. session-store.test.ts asserts the SQL this store emits only ever
// references identifiers the migration actually creates.

import type session from "express-session";
import MySQLStoreFactory from "express-mysql-session";

/** Table backing the session store. Must match migrations/0002. */
export const SESSION_TABLE = "sessions";

/** Columns the store reads and writes. Must match migrations/0002. */
export const SESSION_COLUMNS = {
  session_id: "session_id",
  expires: "expires",
  data: "data",
} as const;

/** Cookie and row lifetime. Kept equal so the row never outlives the cookie. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How often expired rows are swept. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export function sessionStoreOptions() {
  return {
    createDatabaseTable: false,
    schema: {
      tableName: SESSION_TABLE,
      columnNames: { ...SESSION_COLUMNS },
    },
    // Without the sweep the table is append-on-login and grows without bound.
    clearExpired: true,
    checkExpirationInterval: SWEEP_INTERVAL_MS,
    expiration: SESSION_TTL_MS,
  };
}

/**
 * Build the session store on an existing mysql2 pool.
 *
 * `connection` is a mysql2/promise pool. express-mysql-session requires
 * mysql2/promise itself and its internal query() resolves either a returned
 * promise or a callback, so a promise pool is supported directly.
 */
export function createSessionStore(
  sessionModule: typeof session,
  connection: unknown
) {
  const MySQLStore = MySQLStoreFactory(sessionModule as any);
  const store = new MySQLStore(sessionStoreOptions() as any, connection as any);

  // A store outage degrades auth; it must not take the process down and put
  // the host into a restart loop.
  store.on("error", (err: Error) => {
    console.error("[SESSION] store error:", err.message);
  });

  return store;
}
