// server/http-write.test.ts
//
// The write paths, exercised over HTTP for the first time.
//
// GET /api/rentals answered 500 on every call for as long as this deployment
// has been on TiDB and nothing noticed, because nothing ever made the call.
// The read side is covered now. These are the endpoints with the same
// exposure and none of the coverage: creating a rental, completing it,
// deleting it, and the status changes those are supposed to cause on the
// equipment they reference.
//
// They need a database they are allowed to damage, so they run against
// TEST_DATABASE_URL and nothing else. The guard below refuses to start if that
// DSN does not name a database with "test" in it -- a smoke test that writes
// is one misconfigured variable away from editing the fleet somebody is being
// shown, and skipping quietly on a typo would hide exactly that.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

const TEST_DSN = process.env.TEST_DATABASE_URL?.trim();
const SECRET = "http-write-test-secret-value-long-enough";

/** The DSN must name a database that is obviously a test one. */
function namesATestDatabase(dsn: string): boolean {
  const database = dsn.split("/").pop()?.split("?")[0] ?? "";
  return /test/i.test(database);
}

if (TEST_DSN && !namesATestDatabase(TEST_DSN)) {
  throw new Error(
    `TEST_DATABASE_URL does not name a test database (got "${TEST_DSN.split("/").pop()?.split("?")[0]}"). ` +
    `These tests insert, update and delete; refusing to run.`
  );
}

const ENABLED = Boolean(TEST_DSN);

let baseUrl = "";
let server: http.Server | undefined;
let cookie = "";
let savedDsn: string | undefined;
const made = { jobSite: 0, vendor: 0, equipment: 0, replacement: 0, rental: 0 };

/** A fixed calendar day, to be read back unchanged. */
const RECEIVE_DATE = "2026-01-05";
/** The simulation cursor this file pins, so completion lands on a known day. */
const CURSOR_DATE = "2026-03-10";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is the finding */ }
  return { status: res.status, body: json, raw: text, headers: res.headers };
}

beforeAll(async () => {
  if (!ENABLED) return;

  // server/db.ts reads DATABASE_URL once, at import, so pointing it at the test
  // database means setting this before the first import of anything that
  // touches it -- and putting it back afterwards, because vitest may run
  // another file in this same process and the read-only smoke test expects the
  // real database.
  savedDsn = process.env.DATABASE_URL;
  process.env.DATABASE_URL = TEST_DSN;
  process.env.TEST_LOGIN_SECRET = SECRET;
  if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

  const { registerRoutes } = await import("./routes");
  const { db } = await import("./db");
  const { users } = await import("@shared/schema");
  const { sql } = await import("drizzle-orm");
  const bcrypt = (await import("bcryptjs")).default;

  // An administrator to act as. Created here rather than assumed, because the
  // test database starts empty.
  const [existing] = await db.select().from(users).limit(1);
  let adminId = existing?.id;
  if (!adminId) {
    const inserted: any = await db.insert(users).values({
      username: "write-test-admin",
      password: bcrypt.hashSync("not-a-real-password", 4),
      role: "ADMINISTRATOR",
    } as any);
    adminId = Number(inserted[0]?.insertId ?? inserted.insertId);
  }

  // The completion handler dates the return from the simulation cursor, and an
  // empty test database has no cursor at all -- it would fall back to the wall
  // clock and the assertion would be against whatever today is.
  await db.execute(sql`
    INSERT INTO simulation_state (id, cursor_date, total_days_run)
    VALUES (1, ${CURSOR_DATE}, 0)
    ON DUPLICATE KEY UPDATE cursor_date = ${CURSOR_DATE}
  `);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  const res = await fetch(`${baseUrl}/api/test-login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-login": SECRET },
    body: JSON.stringify({ userId: adminId }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (ENABLED) {
    if (savedDsn === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDsn;
  }
});

describe.runIf(ENABLED)("write paths over HTTP", () => {
  it("is signed in as an administrator", () => {
    expect(cookie, "no session — the rest of this file proves nothing").toBeTruthy();
  });

  it("creates a job site", async () => {
    const r = await api("POST", "/api/job-sites", {
      name: "Write Test Yard",
      address: "1 Test Road",
    });
    expect(r.status, r.raw.slice(0, 200)).toBe(201);
    expect(r.body?.id).toBeGreaterThan(0);
    made.jobSite = r.body.id;
  });

  it("creates a vendor", async () => {
    const r = await api("POST", "/api/vendors", { name: "Write Test Rentals" });
    expect(r.status, r.raw.slice(0, 200)).toBe(201);
    made.vendor = r.body.id;
  });

  it("creates equipment, available by default", async () => {
    const r = await api("POST", "/api/equipment", {
      equipmentId: "WT-001",
      name: "Write Test Excavator",
      category: "Excavator",
      status: "AVAILABLE",
      dailyRate: "500.00",
    });
    expect(r.status, r.raw.slice(0, 200)).toBe(201);
    made.equipment = r.body.id;
    expect(r.body.status).toBe("AVAILABLE");
  });

  it("creates a rental and marks the equipment rented", async () => {
    // The side effect is the point: a rental that does not take the unit out
    // of the available pool lets it be rented twice.
    // No returnDate: an active rental has not come back yet, which is the
    // case the create schema used to reject.
    const r = await api("POST", "/api/rentals", {
      equipmentId: made.equipment,
      jobSiteId: made.jobSite,
      vendorId: made.vendor,
      receiveDate: RECEIVE_DATE,
      buyRent: "RENT",
      status: "ACTIVE",
    });
    expect(r.status, r.raw.slice(0, 300)).toBe(201);
    made.rental = r.body.id;

    const equip = await api("GET", `/api/equipment/${made.equipment}`);
    expect(equip.body.status).toBe("RENTED");
  });

  it("stores the receive date as the day that was sent", async () => {
    // Not one day earlier. A DATE column handed a Date object is formatted in
    // the writing machine's local zone, so this assertion is about which
    // server wrote the row -- it passed in UTC and failed in New York.
    const r = await api("GET", `/api/rentals/${made.rental}`);
    expect(String(r.body.receiveDate).slice(0, 10)).toBe(RECEIVE_DATE);
  });

  it("auto-generates a PO number when none is given", async () => {
    const r = await api("GET", `/api/rentals/${made.rental}`);
    expect(r.status).toBe(200);
    expect(r.body.poNumber, "no PO number was generated").toBeTruthy();
  });

  it("returns the new rental in the list, with its relations resolved", async () => {
    // The exact query that was failing: relations through a join TiDB accepts.
    const r = await api("GET", "/api/rentals");
    expect(r.status).toBe(200);
    const mine = (r.body as any[]).find(x => x.id === made.rental);
    expect(mine, "the created rental is not in the list").toBeDefined();
    expect(mine.equipment?.equipmentId).toBe("WT-001");
    expect(mine.jobSite?.name).toBe("Write Test Yard");
    expect(mine.vendor?.name).toBe("Write Test Rentals");
    expect(Array.isArray(mine.invoices)).toBe(true);
  });

  it("refuses to rent equipment that is already out", async () => {
    const r = await api("POST", "/api/rentals", {
      equipmentId: made.equipment,
      jobSiteId: made.jobSite,
      receiveDate: RECEIVE_DATE,
      buyRent: "RENT",
      status: "ACTIVE",
    });
    expect(r.status).toBe(400);
    expect(String(r.body?.message)).toMatch(/unavailable/i);
  });

  it("rejects a malformed rental with 400 and a usable message", async () => {
    // Not a 500, and not a hang: this is the shape that used to be an
    // unhandled rejection.
    const r = await api("POST", "/api/rentals", { equipmentId: "not a number" });
    expect(r.status).toBe(400);
    expect(typeof r.body?.message).toBe("string");
    expect(r.body.message.length).toBeGreaterThan(0);
  });

  it("updates a rental", async () => {
    const r = await api("PUT", `/api/rentals/${made.rental}`, { notes: "updated by test" });
    expect(r.status, r.raw.slice(0, 200)).toBe(200);
    const after = await api("GET", `/api/rentals/${made.rental}`);
    expect(after.body.notes).toBe("updated by test");
  });

  it("swaps the equipment on an active rental, moving both statuses", async () => {
    // The replacement goes out, the original comes back, the rental points at
    // the new unit, and the swap is recorded -- four rows that have to agree.
    const second = await api("POST", "/api/equipment", {
      equipmentId: "WT-002",
      name: "Write Test Replacement",
      category: "Excavator",
      status: "AVAILABLE",
      dailyRate: "500.00",
    });
    expect(second.status, second.raw.slice(0, 200)).toBe(201);
    made.replacement = second.body.id;

    const r = await api("POST", `/api/rentals/${made.rental}/swap`, {
      replacementEquipmentId: made.replacement,
      reason: "hydraulic leak",
    });
    expect(r.status, r.raw.slice(0, 300)).toBeLessThan(400);

    const original = await api("GET", `/api/equipment/${made.equipment}`);
    const replacement = await api("GET", `/api/equipment/${made.replacement}`);
    expect(original.body.status).toBe("AVAILABLE");
    expect(replacement.body.status).toBe("RENTED");

    const rental = await api("GET", `/api/rentals/${made.rental}`);
    expect(rental.body.equipmentId).toBe(made.replacement);

    const swaps = await api("GET", `/api/rentals/${made.rental}/swaps`);
    expect(swaps.body).toHaveLength(1);
    expect(swaps.body[0].originalEquipment?.equipmentId).toBe("WT-001");
    expect(swaps.body[0].replacementEquipment?.equipmentId).toBe("WT-002");
    expect(String(swaps.body[0].swapDate).slice(0, 10)).toBe(CURSOR_DATE);
  });

  it("rejects a swap whose replacement id is not a number", async () => {
    // "5" used to get past the "must be different" check, because 5 !== "5".
    const r = await api("POST", `/api/rentals/${made.rental}/swap`, {
      replacementEquipmentId: String(made.replacement),
    });
    expect(r.status).toBe(400);
  });

  it("refuses to swap in the unit already on the rental", async () => {
    const r = await api("POST", `/api/rentals/${made.rental}/swap`, {
      replacementEquipmentId: made.replacement,
    });
    expect(r.status).toBe(400);
    expect(String(r.body?.message)).toMatch(/different/i);
  });

  it("swaps back, so the rest of this file reads the original unit", async () => {
    const r = await api("POST", `/api/rentals/${made.rental}/swap`, {
      replacementEquipmentId: made.equipment,
    });
    expect(r.status, r.raw.slice(0, 300)).toBeLessThan(400);
    const rental = await api("GET", `/api/rentals/${made.rental}`);
    expect(rental.body.equipmentId).toBe(made.equipment);
  });

  it("will not delete an active rental", async () => {
    const r = await api("DELETE", `/api/rentals/${made.rental}`);
    expect(r.status).toBe(409);
  });

  it("completes a rental on the simulation's current day", async () => {
    const state = await api("GET", "/api/simulate/state");
    expect(String(state.body?.cursor_date ?? "").slice(0, 10)).toBe(CURSOR_DATE);

    const r = await api("POST", `/api/rentals/${made.rental}/complete`);
    expect(r.status, r.raw.slice(0, 300)).toBeLessThan(400);

    const after = await api("GET", `/api/rentals/${made.rental}`);
    expect(after.body.status).toBe("COMPLETED");
    // The exact day, not just "a date": the completion handler derives this
    // from the cursor, and a conversion through Date would shift it.
    expect(String(after.body.returnDate).slice(0, 10)).toBe(CURSOR_DATE);
    // And the unit goes back in the pool, or it can never be rented again.
    const equip = await api("GET", `/api/equipment/${made.equipment}`);
    expect(equip.body.status).toBe("AVAILABLE");
  });

  it("accumulated hours onto the equipment at return", async () => {
    const equip = await api("GET", `/api/equipment/${made.equipment}`);
    expect(parseFloat(equip.body.currentMileage ?? "0")).toBeGreaterThan(0);
  });

  it("deletes a completed rental", async () => {
    const r = await api("DELETE", `/api/rentals/${made.rental}`);
    expect(r.status, r.raw.slice(0, 200)).toBe(200);
    const after = await api("GET", `/api/rentals/${made.rental}`);
    expect(after.status).toBe(404);
  });

  it("refuses writes without a session", async () => {
    const saved = cookie;
    cookie = "";
    const r = await api("POST", "/api/vendors", { name: "Should Not Exist" });
    cookie = saved;
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.status).toBeLessThan(404);
  });

  it("cleans up after itself", async () => {
    // Not strictly required on a throwaway database, but a test that leaves
    // its fixtures behind makes the next run's assertions ambiguous.
    for (const [path, id] of [
      ["/api/equipment", made.equipment],
      ["/api/equipment", made.replacement],
      ["/api/vendors", made.vendor],
      ["/api/job-sites", made.jobSite],
    ] as const) {
      if (id) await api("DELETE", `${path}/${id}`);
    }
    const equip = await api("GET", "/api/equipment");
    const left = (equip.body as any[]).filter(e => String(e.equipmentId).startsWith("WT-"));
    expect(left, `left behind: ${left.map(e => e.equipmentId).join(", ")}`).toHaveLength(0);
  });
});

describe.runIf(ENABLED)("the seed run record", () => {
  it("reads back a finished run after the process that ran it is gone", async () => {
    // getLastSeedRun is the fallback the status endpoint uses once the
    // in-memory job is gone. Writing the row directly here is the point:
    // it stands in for a run whose process no longer exists.
    const { db } = await import("./db");
    const { seedRuns } = await import("@shared/schema");
    const { getLastSeedRun } = await import("./services/seed-orchestrator");

    await db.insert(seedRuns).values({
      status: "completed",
      steps: JSON.stringify([{ name: "Batch predictions", status: "failed", detail: "401" }]),
      warnings: JSON.stringify(["No assets were scored: the ML service rejected the call."]),
      finishedAt: new Date(),
    } as any);

    const run = await getLastSeedRun();
    expect(run, "nothing came back from the history").toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.warnings[0]).toMatch(/rejected the call/);
    expect(run!.steps[0].status).toBe("failed");
  });

  it("degrades to an empty run rather than throwing on unreadable JSON", async () => {
    // A truncated or hand-edited column must not take down the status
    // endpoint, which is the one thing you reach for when a seed misbehaved.
    const { db } = await import("./db");
    const { seedRuns } = await import("@shared/schema");
    const { getLastSeedRun } = await import("./services/seed-orchestrator");

    await db.insert(seedRuns).values({
      status: "failed",
      steps: "{not json",
      warnings: "",
      error: "something went wrong",
    } as any);

    const run = await getLastSeedRun();
    expect(run!.status).toBe("failed");
    expect(run!.steps).toEqual([]);
    expect(run!.warnings).toEqual([]);
    expect(run!.error).toBe("something went wrong");
  });

  it("reports the most recent run, not the first", async () => {
    const { getLastSeedRun } = await import("./services/seed-orchestrator");
    const run = await getLastSeedRun();
    expect(run!.status).toBe("failed"); // the row written just above
  });

  it("answers the status endpoint from history when nothing is running", async () => {
    const r = await api("GET", "/api/admin/seed/status");
    expect(r.status).toBe(200);
    expect(r.body.fromHistory, "the endpoint ignored the stored run").toBe(true);
    expect(r.body.state).toBe("failed");
  });
});
