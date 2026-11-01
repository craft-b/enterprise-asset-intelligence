// server/services/request-limits.test.ts
//
// The per-client limits on the public API: every request, failed sign-ins,
// and registration.

import { describe, it, expect, vi } from "vitest";
import {
  createFixedWindowLimiter, clientKey, apiRateLimit, createLoginThrottle,
  refuseThrottledLogin, registerRateLimit, API_LIMIT, LOGIN_LIMITS, REGISTER_LIMIT,
} from "./request-limits";

/** Just enough of Express's req/res for middleware. */
function fakeReq(over: Record<string, any> = {}) {
  return { method: "GET", path: "/equipment", ip: "203.0.113.7", headers: {}, socket: {}, ...over } as any;
}
function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe("the fixed-window limiter", () => {
  it("allows `limit` events per window per key, then says how long to wait", () => {
    const l = createFixedWindowLimiter({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) expect(l.hit("a", 0).allowed).toBe(true);
    expect(l.hit("a", 400)).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(l.hit("b", 400).allowed).toBe(true);   // keys are independent
    expect(l.hit("a", 1000).allowed).toBe(true);  // a new window
  });

  it("can be asked without counting", () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(l.blockedFor("a", 0)).toBe(0);
    l.hit("a", 0);
    expect(l.blockedFor("a", 250)).toBe(750);
    expect(l.blockedFor("a", 250)).toBe(750);     // still 750: asking is free
  });

  it("holds a bounded number of keys under a flood of distinct ones", () => {
    const l = createFixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) l.hit(`client-${i}`, 0);
    // The newest keys are still tracked; the oldest were forgotten.
    expect(l.blockedFor("client-9999", 0)).toBeGreaterThan(0);
    expect(l.blockedFor("client-0", 0)).toBe(0);
  });
});

describe("who a request counts as", () => {
  it("prefers Cloudflare's visitor address when it is a real address", () => {
    expect(clientKey(fakeReq({ headers: { "cf-connecting-ip": "198.51.100.4" } }))).toBe("198.51.100.4");
    expect(clientKey(fakeReq({ headers: { "cf-connecting-ip": "2001:db8::1" } }))).toBe("2001:db8::1");
  });

  it("falls back to req.ip when the header is absent or junk", () => {
    expect(clientKey(fakeReq())).toBe("203.0.113.7");
    expect(clientKey(fakeReq({ headers: { "cf-connecting-ip": "evil, 1.2.3.4" } }))).toBe("203.0.113.7");
  });
});

describe("the API-wide limit", () => {
  it("refuses past the limit with 429, Retry-After and a message", () => {
    const mw = apiRateLimit(createFixedWindowLimiter(API_LIMIT));
    const next = vi.fn();
    for (let i = 0; i < API_LIMIT.limit; i++) mw(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(API_LIMIT.limit);

    const res = fakeRes();
    mw(fakeReq(), res, next);
    expect(next).toHaveBeenCalledTimes(API_LIMIT.limit);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
    expect(res.body.message).toMatch(/Too many requests/);
  });

  it("never counts the health check or a CORS preflight", () => {
    const mw = apiRateLimit(createFixedWindowLimiter({ limit: 1, windowMs: 60_000 }));
    const next = vi.fn();
    for (let i = 0; i < 50; i++) {
      mw(fakeReq({ path: "/health" }), fakeRes(), next);
      mw(fakeReq({ method: "OPTIONS" }), fakeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(100);
    mw(fakeReq(), fakeRes(), next);              // the one real request still allowed
    expect(next).toHaveBeenCalledTimes(101);
  });

  it("is generous enough for a person", () => {
    // Five requests a second, sustained for a minute. A dashboard page makes a
    // handful; this only stops something looping.
    expect(API_LIMIT.limit / (API_LIMIT.windowMs / 1000)).toBeGreaterThanOrEqual(5);
  });
});

describe("failed sign-ins", () => {
  it("lock out a client after its limit, whatever usernames it tries", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit; i++) t.recordFailure("ip-1", `user${i}`, 0);
    expect(t.blockedFor("ip-1", "anyone", 0)).toBeGreaterThan(0);
    expect(t.blockedFor("ip-2", "anyone", 0)).toBe(0);
  });

  it("lock out a username guessed from many addresses, ignoring case", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perUsername.limit; i++) {
      t.recordFailure(`ip-${i}`, i % 2 ? "Admin" : " admin ", 0);
    }
    expect(t.blockedFor("fresh-ip", "ADMIN", 0)).toBeGreaterThan(0);
    expect(t.blockedFor("fresh-ip", "viewer", 0)).toBe(0);
  });

  it("are forgiven by a successful sign-in", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit - 1; i++) t.recordFailure("ip-1", "admin", 0);
    t.recordSuccess("ip-1", "admin");
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit - 1; i++) t.recordFailure("ip-1", "admin", 0);
    expect(t.blockedFor("ip-1", "admin", 0)).toBe(0);
  });

  it("expire with the window", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit; i++) t.recordFailure("ip-1", "admin", 0);
    expect(t.blockedFor("ip-1", "admin", LOGIN_LIMITS.perClient.windowMs)).toBe(0);
  });

  it("are refused in minutes a person can read", () => {
    const res = fakeRes();
    expect(refuseThrottledLogin(res, 0)).toBe(false);
    expect(refuseThrottledLogin(res, 14 * 60_000 + 1)).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.body.message).toBe("Too many failed sign-in attempts. Try again in 15 minutes.");
  });
});

describe("registration", () => {
  it("is limited per client", () => {
    const mw = registerRateLimit(createFixedWindowLimiter(REGISTER_LIMIT));
    const next = vi.fn();
    for (let i = 0; i < REGISTER_LIMIT.limit; i++) mw(fakeReq({ method: "POST" }), fakeRes(), next);
    const res = fakeRes();
    mw(fakeReq({ method: "POST" }), res, next);
    expect(next).toHaveBeenCalledTimes(REGISTER_LIMIT.limit);
    expect(res.statusCode).toBe(429);
  });
});

describe("inside a real Express app, configured as production is", () => {
  it("counts each visitor separately behind the proxy, and exempts /api/health", async () => {
    const express = (await import("express")).default;
    const app = express();
    app.set("trust proxy", 1);                    // as routes.ts sets it
    app.use("/api", apiRateLimit(createFixedWindowLimiter({ limit: 2, windowMs: 60_000 })));
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.get("/api/thing", (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(base + path, { headers }).then(r => r.status);

    try {
      // Two visitors behind the same proxy: the proxy appends each one's
      // address, and trust proxy 1 reads it back.
      const alice = { "x-forwarded-for": "198.51.100.1" };
      const bob = { "x-forwarded-for": "198.51.100.2" };
      expect([await get("/api/thing", alice), await get("/api/thing", alice)]).toEqual([200, 200]);
      expect(await get("/api/thing", alice)).toBe(429);
      expect(await get("/api/thing", bob)).toBe(200);

      // Cloudflare's header wins over the proxy chain.
      const carol = { "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "198.51.100.3" };
      expect(await get("/api/thing", carol)).toBe(200);

      // The health check is mounted under /api and still never counted.
      for (let i = 0; i < 5; i++) expect(await get("/api/health", alice)).toBe(200);
    } finally {
      server.close();
    }
  });
});
