// server/services/google-id-token.ts
//
// Signs this API's requests to the ML service when it runs on Cloud Run as a
// private service.
//
// Private means Google's front end turns away any request without a
// Google-signed identity token before it reaches the container, and Cloud Run
// does not bill requests it turns away that way. Without it, the ML service's
// address is the one URL in the stack that can cost money: anyone who finds it
// can make the container run, and the shared service token only refuses the
// work after the instance has been woken and billed for it.
//
// The token comes from the standard service-account exchange (RFC 7523): sign
// a short-lived JWT with the account's private key and trade it at Google's
// token endpoint for an ID token whose audience is the service URL.
// google-auth-library performs exactly this exchange. Done here it is a page
// of node:crypto, where the library is a dozen packages for one POST.
//
// Optional by construction. With ML_SERVICE_GOOGLE_KEY unset -- local
// development, the compose stack, any host that is not Cloud Run -- nothing
// here runs and requests go out exactly as they did before.

import { createSign } from "node:crypto";

/**
 * Where the assertion is exchanged. Fixed rather than read from the key's
 * `token_uri`: the key is pasted into a dashboard, and a value there should
 * not be able to send a signed assertion anywhere but Google.
 */
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Refresh this long before expiry, so a token never lapses mid-request. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** How long the exchange may take before the request it is for gives up. */
const EXCHANGE_TIMEOUT_MS = 10_000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/**
 * Read ML_SERVICE_GOOGLE_KEY, or null when it is unset.
 *
 * Accepts the key file as downloaded or its base64. A dashboard keeps a
 * one-line value more reliably than a multi-line JSON blob with a PEM inside
 * it, so the deploy script prints the base64 form.
 *
 * Throws on anything else, with a message that never repeats the value.
 */
export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const json = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "ML_SERVICE_GOOGLE_KEY is neither JSON nor base64-encoded JSON. Paste the " +
      "service account key file, or the base64 line the deploy script printed."
    );
  }

  if (
    parsed?.type !== "service_account" ||
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string"
  ) {
    throw new Error(
      'ML_SERVICE_GOOGLE_KEY is not a service account key: expected type ' +
      '"service_account" with client_email and private_key.'
    );
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    private_key_id: typeof parsed.private_key_id === "string" ? parsed.private_key_id : undefined,
  };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** The JWT this API signs to ask Google for an ID token. */
export function signAssertion(key: ServiceAccountKey, audience: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = {
    iss: key.client_email,
    sub: key.client_email,
    aud: TOKEN_ENDPOINT,
    iat,
    exp: iat + 3600,
    // What makes this an ID-token request rather than an access-token one:
    // the token Google returns is minted for this audience, which is the
    // receiving service's URL.
    target_audience: audience,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

/**
 * The `exp` claim of a JWT, in milliseconds.
 *
 * Read, not verified: the token is Google's and is verified by Google when
 * the ML service receives it. This only decides when to ask for a new one.
 */
export function expiryOf(jwt: string): number {
  const payload = jwt.split(".")[1];
  const exp = payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp : undefined;
  if (typeof exp !== "number") throw new Error("ID token has no exp claim");
  return exp * 1000;
}

export interface IdTokenSource {
  token(): Promise<string>;
}

/**
 * ID tokens for one audience, cached until shortly before they expire.
 *
 * Concurrent callers during a refresh share one exchange: a dashboard load
 * sends several ML requests at once, and each asking Google separately would
 * be several round trips to learn one thing.
 */
export function createIdTokenSource(
  key: ServiceAccountKey,
  audience: string,
  // globalThis.fetch is looked up per call, not captured here: the source is
  // built at module load, and a captured reference would ignore any later
  // replacement -- which is how a test's stub was once bypassed and the
  // exchange went to Google for real.
  deps: { fetch: typeof fetch; now: () => number } = {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
  },
): IdTokenSource {
  let cached: { token: string; refreshAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const assertion = signAssertion(key, audience, deps.now());
    const res = await deps.fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Google's error body names the problem ("invalid_grant", a disabled
      // account) and contains nothing secret, so it is worth passing on.
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
    }
    const body: any = await res.json();
    if (typeof body?.id_token !== "string") {
      throw new Error("Google token exchange returned no id_token");
    }
    cached = { token: body.id_token, refreshAt: expiryOf(body.id_token) - REFRESH_MARGIN_MS };
    return body.id_token;
  }

  return {
    async token() {
      if (cached && deps.now() < cached.refreshAt) return cached.token;
      if (!pending) pending = exchange().finally(() => { pending = null; });
      return pending;
    },
  };
}
