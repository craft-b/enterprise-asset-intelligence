// server/services/ml-wake.ts
//
// Waiting for a service that suspends when idle.
//
// On free hosting the ML service goes to sleep after about fifteen minutes and
// takes 40-75 seconds to come back (measured: 42, 51, 61.5, 62, 72.5). The
// seed has always handled this — it waits, with retries, because a cold start
// in the middle of a ten-minute job is unremarkable. The buttons did not. They
// called the service once, got nothing, and told the user to try again later,
// which turns a condition the system knows how to handle into the user's
// problem and their job to time correctly.
//
// The difference that matters is that a seed is a background job and a button
// press is an HTTP request. A request cannot hold open for seventy seconds —
// proxies give up, and a browser showing a spinner that long has already lost
// the person. So the request path waits briefly, and if that is not enough it
// leaves the service booting and says so, in a form the client can retry
// against. By the second or third retry the service is up.

import { mlFetch } from "./ml-client";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long a single probe may take.
 *
 * A suspended container does not refuse the connection: the host holds it open
 * for the whole cold start. Without a bound, one probe consumes the entire
 * budget and the loop gets a single attempt rather than the several it looks
 * like it makes.
 */
export const WAKE_PROBE_MS = Number(process.env.ML_WAKE_PROBE_MS ?? 120_000);

/**
 * How long a request may spend waiting before it answers "still waking".
 *
 * Short on purpose. Long enough that an already-warm or nearly-warm service
 * simply works, short enough to stay well inside proxy timeouts — the client
 * covers the rest of a genuine cold start by retrying.
 */
export const REQUEST_WAKE_BUDGET_MS = Number(process.env.ML_REQUEST_WAKE_MS ?? 20_000);

/**
 * Per-probe bound on the request path.
 *
 * Smaller than the budget on purpose. Bounding a probe only by what is left
 * means the first one consumes the whole budget and the loop makes a single
 * attempt — which is the bug the seed's wake had, with a 20s budget and a 120s
 * probe. A service that comes up midway through should be noticed then, not
 * after the budget has already elapsed.
 */
export const REQUEST_WAKE_PROBE_MS = 8_000;

/** Seconds a client should wait before retrying a "still waking" response. */
export const RETRY_AFTER_SECONDS = 20;

/** First pause between probes on a short budget; it doubles from here. */
const FIRST_GAP_MS = 1_500;

/** Ceiling on the doubling, so a long budget still checks periodically. */
const MAX_GAP_MS = 8_000;

/** A rate limit is answered by backing off hard, not by trying again sooner. */
const RATE_LIMIT_BACKOFF = 4;
const RATE_LIMIT_MIN_GAP_MS = 10_000;

/**
 * One bounded health probe. True only if the service answered OK.
 *
 * Bounded twice over: an abort signal, and a race against a timer. The signal
 * alone trusts the HTTP client to honour it, and the whole point of this
 * function is that the bound holds — a probe that outlives its budget turns a
 * retry loop into a single attempt.
 */
export type ProbeResult = "up" | "not-yet" | "rate-limited";

/** The edge's answer when it is shedding load rather than the service's. */
const RATE_LIMITED_STATUSES = new Set([429]);

async function probe(timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ProbeResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve("not-yet"); }, timeoutMs);
  });
  const attempt = (async (): Promise<ProbeResult> => {
    try {
      const res = await mlFetch("/health", { signal: controller.signal });
      if (res.ok) return "up";
      // A 429 is the CDN in front of the host, not the container. Reading it
      // as "still booting" is what made this loop answer a rate limit by
      // polling harder, which is the one response guaranteed to extend it.
      return RATE_LIMITED_STATUSES.has(res.status) ? "rate-limited" : "not-yet";
    } catch {
      // Not up yet. The container keeps booting whether or not we wait on it,
      // which is the whole reason a later retry succeeds.
      return "not-yet";
    }
  })();
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll until the service answers or the budget runs out.
 *
 * `onAttempt` reports progress for callers that have somewhere to show it (the
 * seed's step detail); it is not called often enough to be chatty.
 */
export async function waitForMl(
  budgetMs: number,
  probeMs: number = WAKE_PROBE_MS,
  onAttempt?: (attempt: number, secondsLeft: number) => void,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  let gap = budgetMs <= 30_000 ? FIRST_GAP_MS : 5_000;

  while (Date.now() < deadline) {
    attempt++;
    // Never let a probe outlive the budget: the caller asked for a bound and
    // a 120s probe inside a 20s budget is not one.
    const remaining = Math.max(0, deadline - Date.now());
    const result = await probe(Math.min(probeMs, remaining || probeMs));
    if (result === "up") return true;
    if (Date.now() >= deadline) break;
    onAttempt?.(attempt, Math.max(0, Math.round((deadline - Date.now()) / 1000)));

    // Back off, rather than keeping a fixed gap.
    //
    // The gap was 1.5s flat, which assumed a probe costs something. It does
    // when the host holds a suspended request open -- but it also fast-fails:
    // a suspended service was measured answering 503 in 0.28s, and at that
    // cost a 20s budget is twelve probes, every client retry is twelve more,
    // and the banner polls /api/ml/health alongside them. That is tens of
    // requests a minute at one free-tier edge, from one open tab.
    //
    // A rate limit backs off much harder, because continuing to poll through
    // one is what keeps it in force.
    if (result === "rate-limited") {
      console.warn("[ML] health probe was rate-limited; backing off");
      gap = Math.max(gap * RATE_LIMIT_BACKOFF, RATE_LIMIT_MIN_GAP_MS);
    } else {
      gap = Math.min(gap * 2, MAX_GAP_MS);
    }

    await sleep(Math.min(gap, Math.max(0, deadline - Date.now())));
  }
  return false;
}

/**
 * Start the service waking and return immediately.
 *
 * Measured, against the deployed service: the request that performs the wake
 * is held open for the whole cold start and then FAILS -- 62.9 seconds, then
 * 502. Every request after it succeeds in under half a second. So the wake
 * costs one request, that request is the one that does not get an answer, and
 * nothing is wrong when it comes back empty-handed.
 *
 * Two things follow. The nudge is the right caller to spend that failure,
 * because nothing is waiting on its result. And a 502 from this service is
 * not evidence that anything is broken -- it is what a successful wake looks
 * like from the inside, which is why the client retries rather than reporting
 * it.
 *
 * Used when a request has decided to answer "still waking": the point is that
 * something is poking /health so the container is actually booting while the
 * client counts down to its retry. The rejection is swallowed here rather than
 * escaping as an unhandled one, which this process exits on.
 */
export function nudgeMlAwake(): void {
  // No abort, no timeout, nothing waiting on it.
  //
  // Every other call here is bounded because something is waiting. This one
  // is not, and the bound was actively harmful: aborting at 120 seconds tears
  // down the request that is holding the cold start open, so a container that
  // needs longer than the probe never finishes starting and the next probe
  // begins again from nothing. A seed observed 20 minutes of this — three full
  // wake budgets, every probe aborted, the service never up — while a plain
  // curl with no deadline woke the same service in 62 seconds.
  //
  // A cold start after hours idle is slower than one after thirty minutes:
  // the image may need pulling again. The nudge has nowhere to be, so it waits
  // as long as the host takes.
  // Infinity, not "no argument". Passing nothing does not mean unbounded --
  // mlFetch applies ML_FETCH_TIMEOUT_MS, 90 seconds, so this nudge was being
  // aborted at 90s for the whole time the comment above claimed it never was.
  // The measured cold starts reach 72.5s, and one after hours idle has to pull
  // the image first, so 90s lands inside the range this exists to cover.
  mlFetch("/health", {}, { timeoutMs: Infinity }).catch(() => {
    /* a nudge that fails has still asked the container to start */
  });
}

/**
 * Start the service waking, then wait a little for it.
 *
 * The order is the point, and it was the wrong way round on every request
 * path: probe for twenty seconds, and only once that failed, nudge. Each
 * probe aborts at eight seconds, and an aborted probe tears down the request
 * the host was using to hold the cold start open -- the exact failure
 * documented in nudgeMlAwake, there at 120 seconds and here at 8. So a
 * suspended service got two teardowns per request, and with the client
 * retrying five times, ten or more boots each abandoned a few seconds in. A
 * service in that state never comes up, however long anyone waits, which is
 * what "the ML service is not starting up" was.
 *
 * Nudging first means one unbounded request is holding the boot open from the
 * first moment. The probes that follow come and go on their own connections
 * without disturbing it, so the budget here is just how long this request is
 * willing to wait before answering "still waking" -- and the boot carries on
 * either way, so the client's retry lands on a service that is genuinely
 * further along than when it started.
 */
export async function wakeAndWait(
  budgetMs: number = REQUEST_WAKE_BUDGET_MS,
  probeMs: number = REQUEST_WAKE_PROBE_MS,
): Promise<boolean> {
  nudgeMlAwake();
  return waitForMl(budgetMs, probeMs);
}
