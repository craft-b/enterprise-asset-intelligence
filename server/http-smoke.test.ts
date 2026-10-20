// server/http-smoke.test.ts
//
// Does the API actually answer?
//
// Every other test in this project reads source or exercises the data layer.
// None of them made an HTTP request, which is the gap GET /api/rentals lived
// in: it returned 500 on every single call for as long as this deployment has
// been on TiDB, and nothing noticed, because nothing ever called it.
//
// This boots the real routes against a real database, takes a session through
// the test-login bypass, and asks every read endpoint whether it works. It is
// deliberately read-only -- it runs against whatever database DATABASE_URL
// points at, and a smoke test that mutates the data it is inspecting is a
// smoke test you stop trusting.
//
// Skipped when DATABASE_URL is absent, like the point-in-time test, so a
// checkout with no database still runs the rest of the suite.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const SECRET = "http-smoke-test-secret-value-long-enough";

let baseUrl = "";
let server: http.Server | undefined;
let cookie = "";

/** Endpoints that should answer for a signed-in administrator. */
const READ_ENDPOINTS = [
  "/api/auth/me",
  "/api/equipment",
  "/api/equipment/1",
  "/api/rentals",
  "/api/rentals/1",
  "/api/job-sites",
  "/api/vendors",
  "/api/admin/system-status",
  "/api/admin/seed/status",
  "/api/ml/model-metrics",
  "/api/risk-score/multi-horizon/latest",
  "/api/predictive-maintenance/fleet-risk",
  "/api/maintenance/due-soon",
];

async function get(path: string, withCookie = true) {
  return fetch(`${baseUrl}${path}`, {
    headers: withCookie && cookie ? { cookie } : {},
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;

  process.env.TEST_LOGIN_SECRET = SECRET;
  // Must not be "production", or the bypass refuses to register — which is
  // the behaviour its own tests cover.
  process.env.NODE_ENV = process.env.NODE_ENV === "production" ? "test" : (process.env.NODE_ENV ?? "test");

  const { registerRoutes } = await import("./routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  server = http.createServer(app);
  await registerRoutes(server, app);

  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  // Adopt user 1, whoever that is in this database.
  const res = await fetch(`${baseUrl}/api/test-login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-login": SECRET },
    body: JSON.stringify({ userId: 1 }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
});

describe.runIf(HAS_DB)("the API answers over HTTP", () => {
  it("issued a session through the test login", () => {
    expect(cookie, "no session cookie — the bypass did not authenticate").toBeTruthy();
  });

  it("refuses the test login without the secret", async () => {
    const res = await fetch(`${baseUrl}/api/test-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a user that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/test-login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-login": SECRET },
      body: JSON.stringify({ userId: 999_999 }),
    });
    expect(res.status).toBe(404);
  });

  it.each(READ_ENDPOINTS)("GET %s answers", async path => {
    const res = await get(path);
    const body = await res.text();

    expect(
      res.status,
      `${path} -> ${res.status}: ${body.slice(0, 200)}`
    ).toBeLessThan(400);

    // The rentals bug answered 500 with an HTML error page. Anything under
    // /api that is not JSON is a route that fell through or blew up.
    expect(res.headers.get("content-type") ?? "", `${path} content-type`)
      .toMatch(/json/);
  });

  it("still requires a session", async () => {
    // The bypass must not have loosened normal auth for everyone else.
    const res = await get("/api/rentals", false);
    expect(res.status).toBe(401);
  });

  it("answers 404 in JSON for a route that does not exist", async () => {
    const res = await get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toMatch(/json/);
  });

  it("rejects a non-numeric id rather than putting NaN into SQL", async () => {
    const res = await get("/api/equipment/not-a-number");
    expect(res.status).toBe(400);
  });

  it("survives a malformed login body instead of dying", async () => {
    // This exact request used to be an unhandled rejection, and Node exits on
    // those: one bad body from an unauthenticated caller took the server down.
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);

    // And the server is still up afterwards, which is the actual assertion.
    const after = await get("/api/auth/me");
    expect(after.status).toBeLessThan(500);
  });

  it("does not cache API responses", async () => {
    // A polled status endpoint answering 304 froze the seeding screen for
    // half an hour.
    const res = await get("/api/admin/seed/status");
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/);
  });
});
