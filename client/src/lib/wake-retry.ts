// client/src/lib/wake-retry.ts
//
// Retrying through a cold start.
//
// The ML service suspends after about fifteen minutes idle and takes 40-75
// seconds to come back. Pressing "Run Predictions" on a suspended service used
// to fail with "give it a minute and try again" — so the button's behaviour
// depended on whether the person had used the app recently, and the remedy was
// for them to wait and guess when.
//
// The server now answers `waking: true` instead, having started the container
// booting, and these options make the mutation retry against that flag until
// it is up. Only that flag: a 400 is not retried, a 502 that scored zero
// assets is not retried, and nothing here loops forever.

import type { ApiError } from "./api-error";

/** Enough attempts to cover the slowest cold start measured (72.5s). */
const MAX_WAKE_RETRIES = 5;

const DEFAULT_RETRY_SECONDS = 20;

/**
 * Retry only while the server says it is waking.
 *
 * React Query calls this with the number of failures so far, so the comparison
 * is against attempts already made.
 */
export function retryWhileWaking(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_WAKE_RETRIES && (error as ApiError)?.waking === true;
}

/** How long to wait before the next attempt, honouring what the server asked. */
export function wakeRetryDelay(_failureCount: number, error: unknown): number {
  const asked = (error as ApiError)?.retryAfterSeconds;
  const seconds = typeof asked === "number" && asked > 0 ? asked : DEFAULT_RETRY_SECONDS;
  return seconds * 1000;
}

/** True while a mutation is sitting between wake retries, for button copy. */
export function isWaking(error: unknown, isPending: boolean): boolean {
  return isPending && (error as ApiError)?.waking === true;
}
