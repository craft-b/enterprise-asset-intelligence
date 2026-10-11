// client/src/lib/api-wakeup.ts
//
// Free container hosting suspends an idle instance and takes ~40s to bring it
// back. The SPA is on static hosting and is therefore always instant, so
// without this the first visit after a quiet period renders the shell and then
// fails every request behind it — which reads as a broken app rather than a
// cold start.
//
// This probes the API until it answers and reports progress, so the wait can
// be shown as what it is. The probe is deliberately dumb: GET /api/health,
// which is unauthenticated, touches no database, and is the same endpoint the
// platform's own health check uses.

/** Milliseconds before the wait is worth telling the user about. */
export const ANNOUNCE_AFTER_MS = 1_200;

/** Give up after this long and offer a retry rather than spinning forever. */
export const GIVE_UP_AFTER_MS = 120_000;

/** Gap between probes. Short enough to feel responsive, long enough to be polite. */
const PROBE_INTERVAL_MS = 2_000;

/** Per-probe timeout. A cold instance accepts the socket but answers slowly. */
const PROBE_TIMEOUT_MS = 8_000;

export type WakeupPhase =
  /** Probing, but not long enough to say anything yet. */
  | "checking"
  /** Still probing, and worth showing the user. */
  | "waking"
  /** The API answered. */
  | "ready"
  /** Gave up; the user can retry. */
  | "unreachable";

export interface WakeupState {
  phase: WakeupPhase;
  /** Whole seconds spent waiting, for display. */
  elapsedSeconds: number;
  /** How many probes have been sent. */
  attempts: number;
}

/** One probe. Resolves true when the API answered, false otherwise. */
export async function probeHealth(
  fetchFn: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn("/api/health", {
      signal: controller.signal,
      // The point is to learn whether the server is up, so a cached 200 would
      // be a lie.
      cache: "no-store",
    });
    return res.ok;
  } catch {
    // Abort, DNS failure, connection refused — all "not awake yet".
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitOptions {
  fetchFn?: typeof fetch;
  onUpdate?: (state: WakeupState) => void;
  /** Injected in tests; defaults to real time and timers. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  giveUpAfterMs?: number;
  announceAfterMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Probe until the API answers, reporting progress, then resolve with the final
 * state ("ready" or "unreachable").
 */
export async function waitForApi(options: WaitOptions = {}): Promise<WakeupState> {
  const {
    fetchFn = fetch,
    onUpdate,
    now = () => Date.now(),
    sleep = realSleep,
    giveUpAfterMs = GIVE_UP_AFTER_MS,
    announceAfterMs = ANNOUNCE_AFTER_MS,
    intervalMs = PROBE_INTERVAL_MS,
    timeoutMs = PROBE_TIMEOUT_MS,
  } = options;

  const started = now();
  let attempts = 0;

  const emit = (phase: WakeupPhase): WakeupState => {
    const elapsed = now() - started;
    const state: WakeupState = {
      phase,
      elapsedSeconds: Math.floor(elapsed / 1000),
      attempts,
    };
    onUpdate?.(state);
    return state;
  };

  emit("checking");

  for (;;) {
    attempts++;
    if (await probeHealth(fetchFn, timeoutMs)) return emit("ready");

    const elapsed = now() - started;
    if (elapsed >= giveUpAfterMs) return emit("unreachable");

    // Only start saying "waking" once the wait is noticeable, so a warm API
    // never flashes the notice on screen.
    emit(elapsed >= announceAfterMs ? "waking" : "checking");
    await sleep(intervalMs);
  }
}
