// server/services/ml-response-cache.ts
//
// The ceiling on what a stranger can make the ML service do.
//
// The viewer account's password is printed on the login page, so every route
// behind requireAuth is effectively public. Seven of them called the ML
// service on every request: drift summary, data quality, the model registry,
// champion-challenger, feature importance, training status, and the per-asset
// risk projection. Making the ML service private on Cloud Run stops anyone
// calling it directly, but not this -- the API holds the credential, so a
// script signed in as viewer could have the API call the service for it as
// fast as it liked. The service is billed per request-second.
//
// Two mechanisms, for two different jobs:
//
//   A cache per answer, with one shared request for concurrent callers.
//   These answers only change when the model or the data does, so a visitor
//   is not told anything less true by getting one a few minutes old, and an
//   admin write clears the lot (routes.ts) so their own change shows at once.
//
//   A global budget on cache misses for the expensive routes. The cache alone
//   bounds each key, but the key count and the failure path both multiply
//   that bound. The budget is a token bucket across all of them, so the
//   monthly ceiling is one number that does not depend on fleet size, on
//   which keys exist, or on whether the service is answering. When it is
//   spent, a stale answer is served if there is one; otherwise a 503 says why.
//
// worstCaseMonthlyMlRequests() is that ceiling, and the test beside this file
// holds it inside Cloud Run's free allowance.

import { HEALTH_TTL_MS } from "./ml-health-cache";

export interface MlOutcome {
  status: number;
  body: unknown;
}

export const ML_CACHE_TTL_MS = {
  /** Drift summary, data quality, registry, champion-challenger, feature importance. */
  shared: 10 * 60_000,
  /** Training status. Short: an admin watches it while a job runs. */
  status: 10_000,
  /** One asset's risk trajectory. Also keyed by the simulation date. */
  projection: 30 * 60_000,
  /** Any answer that is not a success, from the service or from failing to reach it. */
  failure: 15_000,
} as const;

/**
 * The budget for the expensive viewer routes: a burst for one visitor's first
 * look around, then one new computation every 20 seconds, shared by everyone.
 * Cached answers are shared too, so this is new work, not page views.
 */
export const ML_VIEWER_BUDGET = { capacity: 30, refillEveryMs: 20_000 } as const;

/** Entries kept. Keys are bounded by the routes and the fleet; this bounds memory regardless. */
const MAX_ENTRIES = 500;

export const BUDGET_SPENT_MESSAGE =
  "The ML service is rate-limited on this public demo to keep it within its free tier. " +
  "Try again shortly.";

type Entry = { value: MlOutcome; expiresAt: number };
type Flight = { promise: Promise<MlOutcome>; invalidated: boolean };

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Flight>();

let tokens: number = ML_VIEWER_BUDGET.capacity;
let refilledAt: number | null = null;

function refill(now: number): void {
  if (refilledAt === null) refilledAt = now;
  tokens = Math.min(
    ML_VIEWER_BUDGET.capacity,
    tokens + (now - refilledAt) / ML_VIEWER_BUDGET.refillEveryMs,
  );
  refilledAt = now;
}

function takeToken(now: number): boolean {
  refill(now);
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

function store(key: string, value: MlOutcome, ttlMs: number, now: number): void {
  entries.delete(key);  // re-insert at the end: Map order is the eviction order
  if (entries.size >= MAX_ENTRIES) {
    entries.forEach((e, k) => { if (e.expiresAt <= now) entries.delete(k); });
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  }
  entries.set(key, { value, expiresAt: now + ttlMs });
}

const isSuccess = (o: MlOutcome) => o.status >= 200 && o.status < 300;

/**
 * The answer for `key`: cached, joined to a request already on its way, or
 * fetched -- in that order, and only the last spends budget.
 *
 * Never throws. A fetcher that throws becomes a 500 outcome, cached for the
 * failure TTL like any other failure, so a dead service is asked at most once
 * per key per fifteen seconds rather than once per page load.
 */
export async function cachedMl(
  key: string,
  opts: { ttlMs: number; budgeted: boolean },
  fetcher: () => Promise<MlOutcome>,
  now: () => number = Date.now,
): Promise<MlOutcome> {
  const entry = entries.get(key);
  if (entry && entry.expiresAt > now()) return entry.value;

  const flight = inFlight.get(key);
  if (flight) return flight.promise;

  if (opts.budgeted && !takeToken(now())) {
    // A stale answer beats a refusal. It is the same answer a visitor could
    // have had a minute ago, and the cost of serving it is nothing.
    if (entry) return entry.value;
    return {
      status: 503,
      body: {
        message: BUDGET_SPENT_MESSAGE,
        retryAfterSeconds: Math.ceil(((1 - tokens) * ML_VIEWER_BUDGET.refillEveryMs) / 1000),
      },
    };
  }

  const record: Flight = { promise: null as unknown as Promise<MlOutcome>, invalidated: false };
  record.promise = (async () => {
    let value: MlOutcome;
    try {
      value = await fetcher();
    } catch (err: any) {
      value = { status: 500, body: { message: "ML service unreachable", error: err?.message } };
    }
    // An admin write while this was in flight means the answer may predate
    // it. Hand it to the callers already waiting, but do not keep it.
    if (!record.invalidated) {
      const ttl = isSuccess(value) ? opts.ttlMs : Math.min(opts.ttlMs, ML_CACHE_TTL_MS.failure);
      store(key, value, ttl, now());
    }
    return value;
  })().finally(() => {
    if (inFlight.get(key) === record) inFlight.delete(key);
  });
  inFlight.set(key, record);
  return record.promise;
}

/**
 * Forget cached answers whose key starts with `prefix` (all of them by default).
 *
 * Requests already in flight for those keys still answer their callers, but
 * the next caller starts a fresh one instead of joining an answer that may
 * predate the change.
 */
export function invalidateMlCache(prefix = ""): void {
  entries.forEach((_, k) => { if (k.startsWith(prefix)) entries.delete(k); });
  inFlight.forEach((f, k) => {
    if (k.startsWith(prefix)) {
      f.invalidated = true;
      inFlight.delete(k);
    }
  });
}

/** Test seam: empty the cache and refill the budget. */
export function resetMlCache(): void {
  entries.clear();
  inFlight.clear();
  tokens = ML_VIEWER_BUDGET.capacity;
  refilledAt = null;
}

/**
 * The most requests per 30-day month that viewer traffic can cause, however
 * it is driven.
 *
 *   budgeted   every expensive route, through the token bucket
 *   status     one key; its TTL is shorter than the failure TTL, so it binds
 *   health     one key, in ml-health-cache.ts, on its own TTL
 *
 * Admin-triggered work (training, fleet scoring, drift references) is not in
 * here: it sits behind requireAdmin, and the admin login is rate-limited.
 */
export function worstCaseMonthlyMlRequests() {
  const month = 30 * 24 * 3600_000;
  const budgeted = ML_VIEWER_BUDGET.capacity + Math.ceil(month / ML_VIEWER_BUDGET.refillEveryMs);
  const status = Math.ceil(month / Math.min(ML_CACHE_TTL_MS.status, ML_CACHE_TTL_MS.failure));
  const health = Math.ceil(month / HEALTH_TTL_MS);
  return { budgeted, status, health, total: budgeted + status + health };
}
