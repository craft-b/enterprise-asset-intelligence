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
import { cn } from "@/lib/utils";


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

  // One line, not a boxed alert.
  //
  // This used to render a full-width amber panel at the top of the page,
  // above a red risk alert and a blue model-provenance alert — three stacked
  // warnings before any content, for a condition the reader cannot act on and
  // which leaves nearly everything on the page working. The visual weight
  // claimed the page was broken when a single card was.
  //
  // So: a muted line in the page's own voice, stating which capability is
  // affected and nothing more. Everything read from the database — scores,
  // attributions, model metrics — renders as usual and needs no caveat,
  // because none applies to it.
  const dotClass = unavailable ? "bg-slate-400" : "bg-amber-500 animate-pulse";
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} aria-hidden />
      {unavailable ? (
        <span>
          Live scoring and drift evaluation are unavailable. Figures on this page
          come from the last completed run.
        </span>
      ) : (
        <span>
          ML service waking — live scoring available in about{" "}
          {TYPICAL_COLD_START_SECONDS}s <span className="tabular-nums">({seconds}s)</span>
        </span>
      )}
    </p>
  );
}
