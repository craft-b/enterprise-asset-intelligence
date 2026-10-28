// server/services/ml-health-cache.ts
//
// One upstream health probe, however many browsers ask.
//
// MlServiceNotice polls /api/ml/health while it is on screen, and the route
// turned every one of those into a request at the ML service -- aborted at
// four seconds, which is the same teardown that stops a cold start finishing.
// So the banner reporting that the service was starting up was, every few
// seconds, interrupting it. One tab watched it climb to 370 seconds.
//
// Two tabs doubled it. A demo in front of a room would have multiplied it by
// the size of the room, against a free-tier edge that answers load with 429
// challenge pages.
//
// So the answer is cached. A health reading seconds old is as good as a fresh
// one for deciding whether to show a banner, and an in-flight probe is shared
// rather than duplicated: ten simultaneous callers get one upstream request
// between them.

import { mlFetch } from "./ml-client";
import { nudgeMlAwake } from "./ml-wake";

export interface MlHealth {
  reachable: boolean;
  reason?: string;
  modelVersion?: string | null;
  modelLoaded?: boolean | null;
}

/**
 * How long a reading stays good.
 *
 * Longer than the banner's fastest poll (5s), so a single watcher cannot
 * outrun the cache, and short enough that a service coming up is noticed
 * promptly -- a cold start is ~60s, so this costs at most a sixth of one.
 */
export const HEALTH_TTL_MS = Number(process.env.ML_HEALTH_TTL_MS ?? 10_000);

/** How long a single probe may take before we call it "not up". */
const PROBE_MS = Number(process.env.ML_HEALTH_PROBE_MS ?? 4_000);

let cached: { at: number; value: MlHealth } | null = null;
let inFlight: Promise<MlHealth> | null = null;

/** Test seam: drop the cache and any shared probe. */
export function resetMlHealthCache(): void {
  cached = null;
  inFlight = null;
}

async function probeOnce(): Promise<MlHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const res = await mlFetch("/health", { signal: controller.signal });
    if (!res.ok) {
      // A 429 is the edge shedding load, not the service being down. Saying
      // so matters: the remedy is to ask less often, and nudging here would
      // be asking again immediately.
      if (res.status === 429) {
        return { reachable: false, reason: "rate-limited by the host" };
      }
      return { reachable: false, reason: `returned ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as any;
    return {
      reachable: true,
      modelVersion: body?.model_version ?? null,
      modelLoaded: body?.model_loaded ?? null,
    };
  } catch (err: any) {
    return {
      reachable: false,
      reason: err?.name === "AbortError" ? `no answer within ${PROBE_MS}ms` : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current health of the ML service, from cache when it is fresh.
 *
 * Callers that arrive while a probe is running wait on that probe rather than
 * starting another.
 */
export async function getMlHealth(now: number = Date.now()): Promise<MlHealth> {
  if (cached && now - cached.at < HEALTH_TTL_MS) return cached.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const value = await probeOnce();
    cached = { at: Date.now(), value };
    // Leave it booting, so the next poll lands on a service further along.
    // nudgeMlAwake is deduped, so this cannot stack up the way the route's
    // own nudges did -- and it is skipped under a rate limit, where another
    // request is the one thing that keeps the limit in force.
    if (!value.reachable && value.reason !== "rate-limited by the host") {
      nudgeMlAwake();
    }
    return value;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
