// client/src/components/ml-service-notice.tsx
//
// The second cold start.
//
// ApiGate covers the Node API, so by the time anything renders, that one is
// awake. The ML service suspends on its own schedule and is not consulted
// until a page asks it for something — which means a visitor can pass the
// startup screen, reach the ML dashboard, and meet a fresh 50-60 second wait
// with no explanation. The drift query's failure message in that window is
// "Failed to fetch drift status", which reads as a broken feature rather than
// a sleeping container.
//
// This does not gate anything. Most of these pages are useful while the ML
// service starts — model metrics come from the database, not from it — so
// blocking the whole page on a wake nobody asked for would trade a confusing
// wait for a worse one. It just says what is happening, and stops saying it
// as soon as the service answers.

import { useEffect, useState } from "react";
import { Moon, Loader2 } from "lucide-react";

/** Matches the gate's measured figure; both describe the same host behaviour. */
const TYPICAL_COLD_START_SECONDS = 60;

/**
 * First gap between checks; it widens from here.
 *
 * A flat five seconds assumed the check costs something. It does while the
 * host holds a suspended request open, but a suspended service also answers
 * 503 in under a third of a second -- so this banner put twelve requests a
 * minute at the ML edge for as long as it was shown, alongside the wake
 * probes the scoring request was already making. A cold start is about sixty
 * seconds and nobody is reading the counter that closely, so the first few
 * checks stay prompt and the rest spread out.
 */
const FIRST_POLL_MS = 5_000;

/** Ceiling on the widening, so a service that comes up is still noticed. */
const MAX_POLL_MS = 20_000;

/**
 * When to stop calling this a cold start.
 *
 * The banner had no terminal state. It said "starting up" and counted,
 * forever, at whatever the wait turned out to be -- 370 seconds, 650, 2300 --
 * because a wake that never completes is indistinguishable, from here, from
 * one that is taking a while. Every one of those readings was presented
 * beside a sentence promising about sixty seconds.
 *
 * Past this, something is wrong rather than slow, and saying so is both more
 * honest and more useful: the page keeps working, and a reader who knows
 * which parts are live can judge the rest. Comfortably past the slowest
 * measured cold start (72.5s) plus a host that has to pull an image first.
 */
const UNAVAILABLE_AFTER_MS = 150_000;

interface MlHealth {
  reachable: boolean;
  reason?: string;
}

export async function checkMlHealth(signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn("/api/ml/health", { credentials: "include", signal });
    if (!res.ok) return false;
    const body: MlHealth = await res.json();
    return body.reachable === true;
  } catch {
    return false;
  }
}

/**
 * A quiet notice while the ML service is starting.
 *
 * Renders nothing when it is up, which is every case except the first visit
 * after an idle period.
 */
export function MlServiceNotice() {
  const [waking, setWaking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let poll = FIRST_POLL_MS;
    // Set on the first failed check and cleared when the service answers, so
    // a tab that outlives several suspensions times each one separately.
    let wakeStartedAt: number | null = null;

    const tick = async () => {
      const up = await checkMlHealth(controller.signal);
      if (stopped) return;

      if (up) {
        setWaking(false);
        setUnavailable(false);
        wakeStartedAt = null;
        return; // answered — stop polling entirely
      }

      // Count from the first failed check, not from mount. These differ
      // whenever the component outlives a wake, which is most of the time: a
      // tab left open watches the service go down and come up repeatedly, and
      // a counter anchored to mount reports the age of the tab. One read
      // "2300s elapsed" for a service that was simply asleep and had never
      // been asked to start — a number with no bearing on any cold start,
      // presented beside a sentence about cold starts.
      if (wakeStartedAt === null) wakeStartedAt = Date.now();

      const waited = Date.now() - wakeStartedAt;
      setWaking(true);
      setSeconds(Math.floor(waited / 1000));
      setUnavailable(waited >= UNAVAILABLE_AFTER_MS);
      // Keep polling even once it is called unavailable, so a service that
      // does come back clears the banner without a reload.
      poll = Math.min(Math.round(poll * 1.5), MAX_POLL_MS);
      timer = setTimeout(tick, poll);
    };

    tick();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  if (!waking) return null;

  // Past the cold-start window this stops being a wait and starts being a
  // fault. The page is no less useful -- scores, attributions and model
  // metrics are all read from the database -- so the notice says which parts
  // are live rather than implying the whole page is pending.
  if (unavailable) {
    const minutes = Math.floor(seconds / 60);
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3"
        aria-live="polite"
      >
        <Moon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
        <div className="text-sm text-slate-800">
          <p className="font-medium">The ML service is not responding</p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
            It runs on separate free hosting and has not answered for{" "}
            {minutes > 0 ? `${minutes} min` : `${seconds}s`}, which is well past
            a cold start. <span className="font-medium">Everything on this page
            is still current:</span> risk scores, per-asset attributions and
            model metrics are read from the database, where each scoring run
            persists them. What needs the service itself is live drift
            evaluation and re-scoring on demand; those will be stale or
            unavailable until it answers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
      aria-live="polite"
    >
      <Moon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <div className="text-sm text-amber-900">
        <p className="font-medium">The ML service is starting up</p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
          It runs on free hosting and suspends separately from the rest of the
          app, so predictions, drift and scoring need about{" "}
          {TYPICAL_COLD_START_SECONDS} seconds to come back. Everything on this
          page that comes from the database is already current.
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-xs tabular-nums text-amber-700">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {seconds}s elapsed
        </p>
      </div>
    </div>
  );
}
