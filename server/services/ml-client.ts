// server/services/ml-client.ts
//
// SEC-1: the ML service is a private plane. It is not exposed to the host in
// compose, and every request from Node carries a shared service token
// (X-Service-Token). Admin-triggering calls also forward the acting user's id
// (X-Actor) so the Python side can audit-log who invoked train / promote /
// drift-reference. This is the ONLY place Node builds ML requests, so the token
// can never be forgotten on a call site.

/**
 * Check that ML_SERVICE_URL names the ML service and nothing else.
 *
 * It is one of several URLs the deployment asks for, and pasting the wrong
 * one is silent until something calls the service -- a seed run reported
 * `ML service train failed:` followed by an entire GitHub error page,
 * because the model bundle's release URL had been entered here and
 * `<release url>/train` is a real, 404-ing GitHub page.
 *
 * A path is the tell. The service is addressed by origin, so anything with
 * one is a different URL that happens to be valid.
 */
export function validateMlServiceUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "http://localhost:8000";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `ML_SERVICE_URL is not a valid URL: "${value}". ` +
      "Expected the ML service origin, e.g. https://eai-ml.onrender.com"
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ML_SERVICE_URL must be http or https, got "${parsed.protocol}"`);
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `ML_SERVICE_URL must be a bare origin with no path, got "${value}". ` +
      `Use "${parsed.origin}" — a path here usually means another URL ` +
      "(the model bundle, the API) was pasted into this variable."
    );
  }

  return parsed.origin;
}

/**
 * Normalise without throwing, for module load.
 *
 * The validating form is called from the boot path instead. A throw at
 * module scope escapes the server's own error handling, and Node then
 * prints the offending source line -- which, in a bundle, is the entire
 * file on one line. The operator gets a wall of minified code instead of
 * the sentence the check wrote.
 */
function normaliseMlServiceUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "http://localhost:8000";
  try {
    return new URL(value).origin;
  } catch {
    return value;  // boot validation reports this properly
  }
}

const ML_SERVICE_URL = normaliseMlServiceUrl(process.env.ML_SERVICE_URL);

export function mlHeaders(opts?: { json?: boolean; actorId?: number | string | null }): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts?.json) h["Content-Type"] = "application/json";
  const token = process.env.ML_SERVICE_TOKEN;
  if (token) h["X-Service-Token"] = token;
  if (opts?.actorId !== undefined && opts?.actorId !== null) h["X-Actor"] = String(opts.actorId);
  return h;
}

/**
 * Read a millisecond budget from the environment.
 *
 * The right value is a property of the deployment rather than the code, and an
 * unparseable one must not silently mean "no timeout" -- which is the state
 * this module was in.
 */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[ML] ignoring invalid ${name}=${raw}; using ${fallback}ms`);
    return fallback;
  }
  return parsed;
}

/**
 * How long any ML request may take before Node gives up on it.
 *
 * This existed nowhere, and the absence was not visible as an error. Every
 * call through here was a bare fetch(), so a suspended instance held the
 * request open for as long as the host felt like holding it: the ML dashboard
 * fired three drift queries, the browser waited, and because the client sets
 * `retry: false` and `staleTime: Infinity` the query never settled and never
 * retried. Observed at 1,350 seconds of spinner with the service in fact
 * healthy and answering a direct probe in 62.
 *
 * Nothing reported a fault, because nothing had decided what too long was.
 * The default is sized for the measured cold start (~62s) plus headroom, and
 * every route's existing catch turns an expiry into "ML service unreachable",
 * which the dashboard already renders as an error rather than as waiting.
 */
const ML_FETCH_TIMEOUT_MS = envMs("ML_FETCH_TIMEOUT_MS", 90_000);

/**
 * The budget for calls that are supposed to take a long time: fitting a model,
 * recomputing a drift reference, scoring a whole fleet. Applied only where a
 * call site asks for it, so the ordinary default stays tight enough to be a
 * real signal.
 */
export const ML_SLOW_TIMEOUT_MS = envMs("ML_SLOW_TIMEOUT_MS", 300_000);

/**
 * fetch() wrapper for the ML service. Prepends ML_SERVICE_URL and injects the
 * service token (+ optional actor id). Pass a relative path like "/train".
 *
 * Bounded by ML_FETCH_TIMEOUT_MS unless the caller passes `timeoutMs`, or
 * brings its own `signal` -- ml-wake and the prediction path already manage
 * their own deadlines, and taking those over would shorten budgets that were
 * chosen deliberately.
 *
 * `timeoutMs: Infinity` means no deadline at all, for the one caller that has
 * nothing waiting on it and must not tear down the request holding a cold
 * start open. It had been asking for that by passing nothing -- which is how
 * it got the 90s default instead, and 90s is inside the range a slow cold
 * start can take.
 */
/**
 * How long to stay off the host after it rate-limits us.
 *
 * A 429 from the free tier's CDN is not about one route. It is the edge
 * refusing this API's address, and every request sent during it both fails and
 * extends it. So the gate is shared: one 429 anywhere stops all of them.
 */
export const RATE_LIMIT_COOLDOWN_MS = Number(process.env.ML_RATE_LIMIT_COOLDOWN_MS ?? 60_000);

/**
 * Ceiling on the backoff.
 *
 * Long, because the alternative is worse. A cooldown that is too short costs
 * another refusal and resets the clock; one that is too long costs a slower
 * first page after the limit lifts. Fifteen minutes is also roughly the idle
 * window, so a service nobody has asked for in that time was asleep anyway.
 */
export const RATE_LIMIT_MAX_COOLDOWN_MS = Number(process.env.ML_RATE_LIMIT_MAX_MS ?? 900_000);

let rateLimitedUntil = 0;
let consecutive429 = 0;
let lastRetryAfter: string | null = null;

/** What the gate has seen, for the admin diagnostic. Read-only. */
export function rateLimitState(now: number = Date.now()) {
  return {
    remainingMs: Math.max(0, rateLimitedUntil - now),
    consecutive429,
    lastRetryAfter,
  };
}

/** Milliseconds left on the shared cooldown, or 0 when there is none. */
export function rateLimitRemaining(now: number = Date.now()): number {
  return Math.max(0, rateLimitedUntil - now);
}

/** Test seam: forget any cooldown. */
export function resetRateLimitGate(): void {
  rateLimitedUntil = 0;
  consecutive429 = 0;
  lastRetryAfter = null;
}

/**
 * How long to stay away, in milliseconds.
 *
 * `Retry-After` first, because the host is the only party that knows. It is
 * either a seconds count or an HTTP date; both are standard and both appear
 * in the wild. Everything here was previously a guess -- 60 seconds, chosen
 * because another module had already guessed 60 seconds -- and a guess that is
 * shorter than the real window re-probes into the limit and resets it, which
 * is a deadlock with a longer period rather than a fix.
 *
 * Without the header, double each time. A limit that outlasts one cooldown
 * will outlast the next identical one too.
 */
export function cooldownFor(header: string | null, strikes: number, now: number = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, RATE_LIMIT_MAX_COOLDOWN_MS);
    }
    const when = Date.parse(header);
    if (Number.isFinite(when) && when > now) {
      return Math.min(when - now, RATE_LIMIT_MAX_COOLDOWN_MS);
    }
  }
  const doubled = RATE_LIMIT_COOLDOWN_MS * Math.pow(2, Math.max(0, strikes - 1));
  return Math.min(doubled, RATE_LIMIT_MAX_COOLDOWN_MS);
}

/**
 * The 429 a caller gets without a request being sent.
 *
 * A real Response, so the fourteen call sites that already branch on
 * `res.status === 429` keep working unchanged. Nothing had to learn about the
 * gate for it to protect them.
 */
function syntheticRateLimit(): Response {
  return new Response(
    JSON.stringify({ detail: "rate-limited by the host; request not sent" }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

/**
 * Note what the host just told us.
 *
 * A 429 starts the cooldown. Any answer the service itself gave ends it --
 * the limit is on reaching the edge, so getting through means it has lifted.
 */
function recordOutcome(res: Response): void {
  if (res.status === 429) {
    consecutive429 += 1;
    lastRetryAfter = res.headers.get("retry-after");
    rateLimitedUntil = Date.now() + cooldownFor(lastRetryAfter, consecutive429);
    console.warn(
      `[ML] rate-limited by the host (strike ${consecutive429}, retry-after=${lastRetryAfter ?? "absent"}); ` +
      `holding all ML requests for ${Math.round(rateLimitRemaining() / 1000)}s`,
    );
  } else if (res.status < 500) {
    if (consecutive429 > 0) console.info(`[ML] rate limit lifted after ${consecutive429} strike(s)`);
    rateLimitedUntil = 0;
    consecutive429 = 0;
  }
}

/**
 * One request that ignores the gate and does not touch it.
 *
 * For the admin diagnostic only. The gate is shared and silent by design, so
 * every ordinary caller is short-circuited during a cooldown -- including the
 * diagnostic, which then reported our own synthetic 429 with ms:1 and told us
 * nothing about the host. An instrument that cannot see past the thing it is
 * measuring is the same fault as the banner that reported on a cold start it
 * was preventing.
 *
 * It is deliberately read-only: a 429 here does not count as a strike and a
 * success does not clear one. An observation that moves what it observes is
 * worse than none, and this is one manual request by one admin.
 */
export async function probeHostDirectly(timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${ML_SERVICE_URL}/health`, {
      headers: mlHeaders({ json: false }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function mlFetch(
  path: string,
  init: RequestInit = {},
  opts?: { actorId?: number | string | null; timeoutMs?: number },
): Promise<Response> {
  const hasBody = init.body !== undefined && init.body !== null;
  const headers = {
    ...mlHeaders({ json: hasBody, actorId: opts?.actorId }),
    ...(init.headers as Record<string, string> | undefined),
  };
  const url = `${ML_SERVICE_URL}${path}`;

  // Shared cooldown, checked before anything is sent.
  //
  // The health path learned to back off under a 429 and the other fourteen
  // call sites did not, so a single dashboard load kept firing eight requests
  // at an edge that was already refusing this address -- which is what kept
  // the limit in force and left the container asleep for 650 seconds while
  // the throttled health probe waited politely beside it.
  //
  // Backing off per-caller cannot work: the limit is on the address, so it is
  // the address that has to go quiet. One gate, every caller.
  if (rateLimitRemaining() > 0) return syntheticRateLimit();

  if (init.signal) {
    const res = await fetch(url, { ...init, headers });
    recordOutcome(res);
    return res;
  }
  if (opts?.timeoutMs === Infinity) {
    const res = await fetch(url, { ...init, headers });
    recordOutcome(res);
    return res;
  }

  const budget = opts?.timeoutMs ?? ML_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    recordOutcome(res);
    return res;
  } catch (err: any) {
    // An AbortError's own message is "This operation was aborted", which tells
    // a reader nothing about which call gave up or how long it waited. The
    // routes interpolate e.message into their response, so it has to say.
    if (err?.name === "AbortError") {
      throw new Error(
        `ML request to ${path} exceeded ${budget}ms and was aborted. The ` +
        `service may be suspended (a cold start measures ~60s) or the call ` +
        `may need a longer budget via ML_FETCH_TIMEOUT_MS.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export { ML_SERVICE_URL };

/**
 * A short, readable description of an unexpected ML response.
 *
 * The raw body used to be interpolated straight into an error shown in the
 * UI, so a misdirected request pasted a whole HTML page into a dialog. What
 * matters is the status, the content type and where the request actually
 * went.
 */
export async function describeMlFailure(res: Response, path: string): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const where = `${ML_SERVICE_URL}${path}`;

  let detail: string;
  try {
    const text = await res.text();
    if (contentType.includes("json")) {
      detail = text.slice(0, 300);
    } else {
      // HTML means something other than the ML service answered.
      detail = `${res.status} ${res.statusText} (${contentType})`;
      // A gateway status from the right host means the service did not answer,
      // not that the address is wrong -- saying "check your URL" there sends
      // someone to re-verify a setting that is already correct.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        detail +=
          " — the ML service did not respond. It may be waking from idle," +
          " or it ran out of memory and restarted. Training in particular" +
          " needs more memory than a small instance has.";
      } else if (res.status === 429) {
        // Checked before the generic HTML branch, which would otherwise send
        // someone to re-verify a correct ML_SERVICE_URL -- the same wrong
        // advice the gateway statuses above were already fixed for. A 429
        // arrives as a CDN challenge page, so it IS HTML and it IS from the
        // right host; the address has nothing to do with it.
        detail +=
          " — the host's CDN is rate-limiting us, not the ML service. This is" +
          " the free tier shedding load after too many requests in a short" +
          " window. It clears on its own; the call is retried automatically.";
      } else if (contentType.includes("html")) {
        detail +=
          " — that is a web page, not the ML service. Check ML_SERVICE_URL" +
          ` points at the service itself; it is currently "${ML_SERVICE_URL}".`;
      }
    }
  } catch {
    detail = `${res.status} ${res.statusText}`;
  }

  return `${where} returned ${detail}`;
}