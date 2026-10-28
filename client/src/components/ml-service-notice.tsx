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

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let poll = FIRST_POLL_MS;
    const startedAt = Date.now();

    const tick = async () => {
      const up = await checkMlHealth(controller.signal);
      if (stopped) return;

      if (up) {
        setWaking(false);
        return; // answered — stop polling entirely
      }

      setWaking(true);
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
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
