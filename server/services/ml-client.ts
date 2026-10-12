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
 * fetch() wrapper for the ML service. Prepends ML_SERVICE_URL and injects the
 * service token (+ optional actor id). Pass a relative path like "/train".
 */
export async function mlFetch(
  path: string,
  init: RequestInit = {},
  opts?: { actorId?: number | string | null },
): Promise<Response> {
  const hasBody = init.body !== undefined && init.body !== null;
  const headers = {
    ...mlHeaders({ json: hasBody, actorId: opts?.actorId }),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(`${ML_SERVICE_URL}${path}`, { ...init, headers });
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