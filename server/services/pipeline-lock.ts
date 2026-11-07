// One pipeline write job at a time.
//
// Simulate, PM advance, snapshot backfill and labeling all read state, work
// for a while, then write. Two at once read the same state: a double-clicked
// backfill wrote every new snapshot twice, and two simulations both took the
// same day, one crashing halfway and leaving partial rows behind. The nightly
// PM job can collide with an admin click the same way.
//
// In-process, so it holds for the single API instance this runs as. The demo
// seed is checked too, since it writes the same tables for minutes.

import { getSeedStatus } from "./seed-orchestrator";

let held: string | null = null;

/** The job currently writing, or null. */
export function pipelineBusy(): string | null {
  if (held) return held;
  return getSeedStatus().status === "running" ? "demo seed" : null;
}

/**
 * Runs `fn` if nothing else is writing. Returns `{ busy }` naming the running
 * job instead of waiting, so callers can say so rather than queue silently.
 */
export async function runExclusive<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; busy: string }> {
  const busy = pipelineBusy();
  if (busy) return { ok: false, busy };
  held = name;
  try {
    return { ok: true, value: await fn() };
  } finally {
    held = null;
  }
}

/** The 409 body for a refused request. */
export function busyMessage(busy: string): { message: string } {
  return { message: `Another pipeline job is running (${busy}). Try again when it finishes.` };
}
