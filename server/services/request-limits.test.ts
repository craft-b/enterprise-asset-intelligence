// server/services/request-limits.test.ts
//
// The per-client limits on the public API: every request, failed sign-ins,
// and registration -- and who a request counts as, from the header chains the
// deployment actually produces.

import { describe, it, expect, vi } from "vitest";
import {
  createFixedWindowLimiter, createPairLimiter, whoIsAsking, apiRateLimit, createLoginThrottle,
  refuseThrottledLogin, registerRateLimit, API_LIMIT, LOGIN_LIMITS, REGISTER_LIMIT, HOP_FACTOR,
  type Asker,
} from "./request-limits";

// Shapes from the admin diagnostic on the live API (2026-11-02). Direct:
// X-Forwarded-For "you, Cloudflare edge, Render internal", CF-Connecting-IP you.
const RENDER = "10.31.107.140";
const CF_EDGE = "172.71.151.158";
const VERCEL = "76.76.21.98";

/** Just enough of Express's req/res for middleware. */
function fakeReq(over: Record<string, any> = {}) {
  return { method: "GET", path: "/equipment", ip: RENDER, headers: {}, socket: {}, ...over } as any;
}
/** A request as the live site's SPA sends it: through Vercel, then Cloudflare, then Render. */
const viaVercel = (visitor: string, over: Record<string, any> = {}) => fakeReq({
  headers: { "cf-connecting-ip": VERCEL, "x-forwarded-for": `${visitor}, ${VERCEL}, ${CF_EDGE}, ${RENDER}` },
  ...over,
});
/** A request straight to the Render URL, optionally forging the chain. */
const direct = (ip: string, forged?: string, over: Record<string, any> = {}) => fakeReq({
  headers: {
    "cf-connecting-ip": ip,
    "x-forwarded-for": `${forged ? forged + ", " : ""}${ip}, ${CF_EDGE}, ${RENDER}`,
  },
  ...over,
});
function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
const who = (visitor: string, hop = visitor): Asker => ({ visitor, hop });

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
    expect(l.blockedFor("client-9999", 0)).toBeGreaterThan(0);
    expect(l.blockedFor("client-0", 0)).toBe(0);
  });
});

describe("who a request counts as", () => {
  it("direct: the address Cloudflare saw, as observed on the deployment", () => {
    expect(whoIsAsking(direct("172.56.45.141"))).toEqual(who("172.56.45.141"));
  });

  it("through Vercel: the visitor Vercel recorded, with Vercel as the hop", () => {
    expect(whoIsAsking(viaVercel("198.51.100.1"))).toEqual(who("198.51.100.1", VERCEL));
  });

  it("never Render's internal hop, which is the same for everyone", () => {
    // req.ip under trust proxy 1. The first version of the limits keyed on it.
    const a = whoIsAsking(viaVercel("198.51.100.1"));
    const b = whoIsAsking(direct("172.56.45.141"));
    expect([a.visitor, a.hop, b.visitor, b.hop]).not.toContain(RENDER);
  });

  it("a forged chain can choose the visitor, but not the hop", () => {
    expect(whoIsAsking(direct("203.0.113.66", "1.2.3.4"))).toEqual(who("1.2.3.4", "203.0.113.66"));
  });

  it("ignores a malformed visitor entry, and works without Cloudflare at all", () => {
    expect(whoIsAsking(direct("203.0.113.66", "not-an-ip"))).toEqual(who("203.0.113.66"));
    expect(whoIsAsking(fakeReq({ ip: "127.0.0.1" }))).toEqual(who("127.0.0.1"));   // local dev
  });
});

describe("the pair limiter", () => {
  it("gives each visitor behind one hop its own allowance", () => {
    const l = createPairLimiter({ limit: 2, windowMs: 60_000 });
    expect([l.hit(who("a", VERCEL), 0).allowed, l.hit(who("a", VERCEL), 0).allowed]).toEqual([true, true]);
    expect(l.hit(who("a", VERCEL), 0).allowed).toBe(false);
    expect(l.hit(who("b", VERCEL), 0).allowed).toBe(true);
  });

  it("caps a hop at HOP_FACTOR visitors' worth, however the visitor key is forged", () => {
    const l = createPairLimiter({ limit: 2, windowMs: 60_000 });
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (l.hit(who(`forged-${i}`, "203.0.113.66"), 0).allowed) allowed++;
    expect(allowed).toBe(2 * HOP_FACTOR);
  });

  it("forgives a visitor without forgiving their hop", () => {
    const l = createPairLimiter({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < HOP_FACTOR; i++) l.hit(who(`v${i}`, "hop"), 0);
    l.reset(who("v0", "hop"));
    expect(l.blockedFor(who("v0", "hop"), 0)).toBeGreaterThan(0);   // the hop is still spent
  });
});

describe("the API-wide limit", () => {
  it("refuses past the limit with 429, Retry-After and a message", () => {
    const mw = apiRateLimit(createPairLimiter(API_LIMIT));
    const next = vi.fn();
    for (let i = 0; i < API_LIMIT.limit; i++) mw(viaVercel("198.51.100.1"), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(API_LIMIT.limit);

    const res = fakeRes();
    mw(viaVercel("198.51.100.1"), res, next);
    expect(next).toHaveBeenCalledTimes(API_LIMIT.limit);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
    expect(res.body.message).toMatch(/Too many requests/);

    mw(viaVercel("198.51.100.2"), fakeRes(), next);   // the next visitor is unaffected
    expect(next).toHaveBeenCalledTimes(API_LIMIT.limit + 1);
  });

  it("never counts the health check or a CORS preflight", () => {
    const mw = apiRateLimit(createPairLimiter({ limit: 1, windowMs: 60_000 }));
    const next = vi.fn();
    for (let i = 0; i < 50; i++) {
      mw(viaVercel("198.51.100.1", { path: "/health" }), fakeRes(), next);
      mw(viaVercel("198.51.100.1", { method: "OPTIONS" }), fakeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(100);
    mw(viaVercel("198.51.100.1"), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(101);
  });

  it("is generous enough for a person", () => {
    expect(API_LIMIT.limit / (API_LIMIT.windowMs / 1000)).toBeGreaterThanOrEqual(5);
  });
});

describe("failed sign-ins", () => {
  it("lock out one visitor, not the others behind the same Vercel address", () => {
    const t = createLoginThrottle();
    const griefer = whoIsAsking(viaVercel("198.51.100.66"));
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit; i++) t.recordFailure(griefer, `user${i}`, 0);
    expect(t.blockedFor(griefer, "viewer", 0)).toBeGreaterThan(0);
    expect(t.blockedFor(whoIsAsking(viaVercel("198.51.100.7")), "viewer", 0)).toBe(0);
  });

  it("lock out a username guessed from many addresses, ignoring case", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perUsername.limit; i++) {
      t.recordFailure(who(`ip-${i}`), i % 2 ? "Admin" : " admin ", 0);
    }
    expect(t.blockedFor(who("fresh-ip"), "ADMIN", 0)).toBeGreaterThan(0);
    expect(t.blockedFor(who("fresh-ip"), "viewer", 0)).toBe(0);
  });

  it("still stop a guesser who forges a new visitor for every attempt", () => {
    const t = createLoginThrottle();
    const hopCap = LOGIN_LIMITS.perClient.limit * HOP_FACTOR;
    for (let i = 0; i < hopCap; i++) t.recordFailure(who(`forged-${i}`, "203.0.113.66"), `user${i}`, 0);
    expect(t.blockedFor(who("forged-new", "203.0.113.66"), "anyone", 0)).toBeGreaterThan(0);
  });

  it("are forgiven by a successful sign-in", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit - 1; i++) t.recordFailure(who("ip-1"), "admin", 0);
    t.recordSuccess(who("ip-1"), "admin");
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit - 1; i++) t.recordFailure(who("ip-1"), "admin", 0);
    expect(t.blockedFor(who("ip-1"), "admin", 0)).toBe(0);
  });

  it("expire with the window", () => {
    const t = createLoginThrottle();
    for (let i = 0; i < LOGIN_LIMITS.perClient.limit; i++) t.recordFailure(who("ip-1"), "admin", 0);
    expect(t.blockedFor(who("ip-1"), "admin", LOGIN_LIMITS.perClient.windowMs)).toBe(0);
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
  it("is limited per visitor", () => {
    const mw = registerRateLimit(createPairLimiter(REGISTER_LIMIT));
    const next = vi.fn();
    for (let i = 0; i < REGISTER_LIMIT.limit; i++) mw(viaVercel("198.51.100.1", { method: "POST" }), fakeRes(), next);
    const res = fakeRes();
    mw(viaVercel("198.51.100.1", { method: "POST" }), res, next);
    expect(next).toHaveBeenCalledTimes(REGISTER_LIMIT.limit);
    expect(res.statusCode).toBe(429);
  });
});

describe("inside a real Express app, configured as production is", () => {
  it("counts visitors behind one Vercel address separately, and exempts /api/health", async () => {
    const express = (await import("express")).default;
    const app = express();
    app.set("trust proxy", 1);                    // as routes.ts sets it
    app.use("/api", apiRateLimit(createPairLimiter({ limit: 2, windowMs: 60_000 })));
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.get("/api/thing", (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(base + path, { headers }).then(r => r.status);
    const through = (visitor: string) => ({
      "cf-connecting-ip": VERCEL,
      "x-forwarded-for": `${visitor}, ${VERCEL}, ${CF_EDGE}`,
    });

    try {
      const alice = through("198.51.100.1");
      expect([await get("/api/thing", alice), await get("/api/thing", alice)]).toEqual([200, 200]);
      expect(await get("/api/thing", alice)).toBe(429);
      expect(await get("/api/thing", through("198.51.100.2"))).toBe(200);

      // The health check is mounted under /api and still never counted.
      for (let i = 0; i < 5; i++) expect(await get("/api/health", alice)).toBe(200);
    } finally {
      server.close();
    }
    // Real sockets: under a full parallel suite on a busy machine this once
    // took 6s against vitest's 5s default, with nothing wrong.
  }, 20_000);
});
