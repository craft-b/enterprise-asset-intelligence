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
// None of this is the financial guarantee. That is ml-response-cache.ts,
// which bounds ML work however the requests arrive. These limits keep the
// database quota and the API's CPU from being spent by one client, and a
// client that rotates addresses gets around them -- which is acceptable
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
 * Who is asking, for counting purposes.
 *
 * `trust proxy` is 1, so req.ip is the address the nearest proxy saw. Render
 * puts Cloudflare in front of its own proxy, so that address may be a
 * Cloudflare edge rather than the visitor -- which would make every visitor
 * behind one edge a single client. Cloudflare's CF-Connecting-IP carries the
 * visitor's address, and Cloudflare overwrites any value a client sends, so
 * it is preferred when present and well-formed.
 *
 * What the API actually sees is reported by the admin diagnostic, so this is
 * checked against the deployment rather than assumed.
 */
export function clientKey(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && isIP(cf.trim())) return cf.trim();
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
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
export function apiRateLimit(limiter: FixedWindowLimiter = createFixedWindowLimiter(API_LIMIT)) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS" || req.path === "/health") return next();
    const { allowed, retryAfterMs } = limiter.hit(clientKey(req));
    if (!allowed) return refuse(res, retryAfterMs, "Too many requests. Slow down and try again shortly.");
    next();
  };
}

export const LOGIN_LIMITS = {
  perClient: { limit: 10, windowMs: 15 * 60_000 },
  perUsername: { limit: 30, windowMs: 15 * 60_000 },
} as const;

/** Failed sign-in accounting. Only failures count; success clears both counters. */
export function createLoginThrottle(
  byClient = createFixedWindowLimiter(LOGIN_LIMITS.perClient),
  byUsername = createFixedWindowLimiter(LOGIN_LIMITS.perUsername),
) {
  // Case-folded: "Admin" and "admin" are one account to someone guessing.
  const user = (username: string) => username.trim().toLowerCase();
  return {
    /** Milliseconds until a sign-in may be attempted, or 0. Checked before bcrypt runs. */
    blockedFor(client: string, username: string, now = Date.now()): number {
      return Math.max(byClient.blockedFor(client, now), byUsername.blockedFor(user(username), now));
    },
    recordFailure(client: string, username: string, now = Date.now()): void {
      byClient.hit(client, now);
      byUsername.hit(user(username), now);
    },
    recordSuccess(client: string, username: string): void {
      byClient.reset(client);
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

export function registerRateLimit(limiter: FixedWindowLimiter = createFixedWindowLimiter(REGISTER_LIMIT)) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { allowed, retryAfterMs } = limiter.hit(clientKey(req));
    if (!allowed) return refuse(res, retryAfterMs, "Too many accounts created from this address. Try again later.");
    next();
  };
}
