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

/**
 * One bounded health probe. True only if the service answered OK.
 *
 * Bounded twice over: an abort signal, and a race against a timer. The signal
 * alone trusts the HTTP client to honour it, and the whole point of this
 * function is that the bound holds — a probe that outlives its budget turns a
 * retry loop into a single attempt.
 */
async function probe(timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const res = await mlFetch("/health", { signal: controller.signal });
      return res.ok;
    } catch {
      // Not up yet. The container keeps booting whether or not we wait on it,
      // which is the whole reason a later retry succeeds.
      return false;
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
  while (Date.now() < deadline) {
    attempt++;
    // Never let a probe outlive the budget: the caller asked for a bound and
    // a 120s probe inside a 20s budget is not one.
    const remaining = Math.max(0, deadline - Date.now());
    if (await probe(Math.min(probeMs, remaining || probeMs))) return true;
    if (Date.now() >= deadline) break;
    onAttempt?.(attempt, Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    // Back off less on a short budget, or the pause eats the attempts.
    const gap = Math.min(budgetMs <= 30_000 ? 1_500 : 5_000, Math.max(0, deadline - Date.now()));
    await sleep(gap);
  }
  return false;
}

/**
 * Start the service waking and return immediately.
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
