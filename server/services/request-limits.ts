// server/services/request-limits.ts
//
// Per-client limits on the public API.
//
// Three, each answering a different abuse:
//
//   Every /api request: 300 a minute per client. A person clicking through
//   the dashboard does not come close; a script looping on an endpoint hits
//   it in seconds. Each request it stops is a database read that never
//   happens, and the database is a free tier with a monthly request quota.
//
//   Failed sign-ins: 10 per client and 30 per username, per 15 minutes. The
//   admin account can wipe the database and start the ML service's most
//   expensive work, and the login had no limit at all, so its password could
//   be guessed as fast as bcrypt would answer. Per-username catches guessing
//   spread across many addresses. The cost is that someone can lock the admin
//   out for 15 minutes by failing on purpose; a successful sign-in clears
//   both counters, so the lockout never outlasts the window.
//
//   Registration: 5 an hour per client. Every viewer account is a row in the
//   users table and a bcrypt hash computed on the API's one small CPU.
//
// Each per-client limit counts twice: per visitor, which is fair but can be
// forged by someone calling Render directly, and per hop -- the address
// Cloudflare saw -- which cannot be forged, at ten times the allowance
// because Vercel's proxy puts many visitors behind each one. whoIsAsking()
// has the detail. The per-username login limit needs no address at all.
//
// None of this is the financial guarantee. That is ml-response-cache.ts,
// which bounds ML work however the requests arrive. These limits keep the
// database quota and the API's CPU from being spent by one client, and a
// client with many real addresses gets around them -- which is acceptable
// precisely because the bill does not depend on them.
//
// In memory, because there is one API instance. A second would need a shared
// store, or each would allow the full limit.

import type { NextFunction, Request, Response } from "express";
import { isIP } from "node:net";

export interface FixedWindowLimiter {
  /** Count one event; whether it is allowed, and if not, how long until it is. */
  hit(key: string, now?: number): { allowed: boolean; retryAfterMs: number };
  /** Whether the next event would be refused, without counting one. */
  blockedFor(key: string, now?: number): number;
  reset(key: string): void;
}

/**
 * Up to `limit` events per `windowMs` per key.
 *
 * Fixed windows rather than sliding: a client can land 2x the limit across a
 * window boundary, which for limits this coarse costs nothing and keeps one
 * small record per key.
 */
export function createFixedWindowLimiter(opts: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): FixedWindowLimiter {
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; startedAt: number }>();

  function current(key: string, now: number) {
    const w = windows.get(key);
    if (!w || now - w.startedAt >= opts.windowMs) return null;
    return w;
  }

  function prune(now: number) {
    windows.forEach((w, k) => { if (now - w.startedAt >= opts.windowMs) windows.delete(k); });
    // Still full means a flood of distinct keys. Forgetting the oldest lets
    // some of them start over, which is better than unbounded memory.
    while (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
  }

  return {
    hit(key, now = Date.now()) {
      let w = current(key, now);
      if (!w) {
        if (windows.size >= maxKeys) prune(now);
        w = { count: 0, startedAt: now };
        windows.set(key, w);
      }
      if (w.count >= opts.limit) {
        return { allowed: false, retryAfterMs: w.startedAt + opts.windowMs - now };
      }
      w.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    blockedFor(key, now = Date.now()) {
      const w = current(key, now);
      return w && w.count >= opts.limit ? w.startedAt + opts.windowMs - now : 0;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

/**
 * Who is asking, counted two ways.
 *
 *   hop      the address Cloudflare saw connect (CF-Connecting-IP), which
 *            Cloudflare overwrites, so no client can choose it. For a visitor
 *            on the live site that is not the visitor: the SPA reaches this
 *            API through Vercel's proxy, so the hop is a Vercel address that
 *            many visitors share.
 *
 *   visitor  the address one entry before the hop in X-Forwarded-For. Vercel
 *            overwrites X-Forwarded-For with the address it saw, so through
 *            Vercel this is the person in the browser. A request sent to
 *            Render directly can put anything there, so it is the fair key
 *            but not a trustworthy one. With nothing before the hop -- a
 *            direct request -- the visitor is the hop.
 *
 * Observed on the deployment (admin diagnostic): direct, X-Forwarded-For was
 * "you, Cloudflare edge, Render internal" with CF-Connecting-IP = you. Through
 * Vercel it gains Vercel's address after yours, and CF-Connecting-IP becomes
 * Vercel's. req.ip, under `trust proxy` 1, is Render's internal hop and the
 * same for everyone -- the first version of this keyed on it.
 */
export interface Asker {
  visitor: string;
  hop: string;
}

export function whoIsAsking(req: Request): Asker {
  const cf = req.headers["cf-connecting-ip"];
  const hop = typeof cf === "string" && isIP(cf.trim())
    ? cf.trim()
    : req.ip ?? req.socket?.remoteAddress ?? "unknown";

  const forwarded = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const at = chain.lastIndexOf(hop);
  const before = at > 0 ? chain[at - 1] : undefined;

  return { visitor: before && isIP(before) ? before : hop, hop };
}

/** The visitor key alone, for the admin diagnostic. */
export function clientKey(req: Request): string {
  return whoIsAsking(req).visitor;
}

/**
 * How much more a hop may do than one visitor. Vercel funnels every visitor
 * near one of its regions through a few addresses, so a hop limit equal to a
 * visitor's would make strangers share one allowance. Ten visitors' worth is
 * room for a busy moment, and still a ceiling on someone who bypasses Vercel
 * to forge the visitor key.
 */
export const HOP_FACTOR = 10;

export interface PairLimiter {
  hit(who: Asker, now?: number): { allowed: boolean; retryAfterMs: number };
  blockedFor(who: Asker, now?: number): number;
  /** Forgives the visitor only: one success says nothing about the others on its hop. */
  reset(who: Asker): void;
}

/** `limit` per visitor, and HOP_FACTOR times that per hop. Both count every event. */
export function createPairLimiter(opts: { limit: number; windowMs: number }): PairLimiter {
  const visitors = createFixedWindowLimiter(opts);
  const hops = createFixedWindowLimiter({ ...opts, limit: opts.limit * HOP_FACTOR });
  return {
    hit(who, now = Date.now()) {
      const v = visitors.hit(who.visitor, now);
      const h = hops.hit(who.hop, now);
      return { allowed: v.allowed && h.allowed, retryAfterMs: Math.max(v.retryAfterMs, h.retryAfterMs) };
    },
    blockedFor(who, now = Date.now()) {
      return Math.max(visitors.blockedFor(who.visitor, now), hops.blockedFor(who.hop, now));
    },
    reset(who) {
      visitors.reset(who.visitor);
    },
  };
}

function refuse(res: Response, retryAfterMs: number, message: string) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set("Retry-After", String(seconds));
  res.status(429).json({ message, retryAfterSeconds: seconds });
}

export const API_LIMIT = { limit: 300, windowMs: 60_000 } as const;

/**
 * Express middleware for every /api request, except two that must always
 * answer: the health check the host polls (and the startup screen waits on),
 * and CORS preflights, which are the browser's overhead rather than the
 * client's requests.
 */
export function apiRateLimit(limiter: PairLimiter = createPairLimiter(API_LIMIT)) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS" || req.path === "/health") return next();
    const { allowed, retryAfterMs } = limiter.hit(whoIsAsking(req));
    if (!allowed) return refuse(res, retryAfterMs, "Too many requests. Slow down and try again shortly.");
    next();
  };
}

export const LOGIN_LIMITS = {
  perClient: { limit: 10, windowMs: 15 * 60_000 },
  perUsername: { limit: 30, windowMs: 15 * 60_000 },
} as const;

/** Failed sign-in accounting. Only failures count; success clears the visitor's and the username's. */
export function createLoginThrottle(
  byClient: PairLimiter = createPairLimiter(LOGIN_LIMITS.perClient),
  byUsername: FixedWindowLimiter = createFixedWindowLimiter(LOGIN_LIMITS.perUsername),
) {
  // Case-folded: "Admin" and "admin" are one account to someone guessing.
  const user = (username: string) => username.trim().toLowerCase();
  return {
    /** Milliseconds until a sign-in may be attempted, or 0. Checked before bcrypt runs. */
    blockedFor(who: Asker, username: string, now = Date.now()): number {
      return Math.max(byClient.blockedFor(who, now), byUsername.blockedFor(user(username), now));
    },
    recordFailure(who: Asker, username: string, now = Date.now()): void {
      byClient.hit(who, now);
      byUsername.hit(user(username), now);
    },
    recordSuccess(who: Asker, username: string): void {
      byClient.reset(who);
      byUsername.reset(user(username));
    },
  };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;

/** Refuse a sign-in that the throttle says must wait. Returns true when it refused. */
export function refuseThrottledLogin(res: Response, retryAfterMs: number): boolean {
  if (retryAfterMs <= 0) return false;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  refuse(res, retryAfterMs, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  return true;
}

export const REGISTER_LIMIT = { limit: 5, windowMs: 60 * 60_000 } as const;

export function registerRateLimit(limiter: PairLimiter = createPairLimiter(REGISTER_LIMIT)) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { allowed, retryAfterMs } = limiter.hit(whoIsAsking(req));
    if (!allowed) return refuse(res, retryAfterMs, "Too many accounts created from this address. Try again later.");
    next();
  };
}
