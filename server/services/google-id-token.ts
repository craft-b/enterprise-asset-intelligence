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
// Two ways to get the token, chosen by the credential in ML_SERVICE_GOOGLE_KEY:
//
//   Workload Identity Federation -- what the deploy script sets up, and the
//   only one that works on a project created since Google began enforcing
//   iam.disableServiceAccountKeyCreation by default. The API signs its own
//   short JWT with a key Google has never held (the script uploaded only the
//   public half to a workload identity pool), Google's STS exchanges it for a
//   federated access token, and IAM Credentials mints an ID token for the
//   invoker service account with it. Three POSTs, no Google-issued key.
//
//   A service account key -- the classic RFC 7523 exchange, for a project
//   that still allows keys. One POST.
//
// google-auth-library performs both. Done here they are a page of node:crypto
// and fetch, where the library is a dozen packages.
//
// Optional by construction. With ML_SERVICE_GOOGLE_KEY unset -- local
// development, the compose stack, any host that is not Cloud Run -- nothing
// here runs and requests go out exactly as they did before.

import { createSign } from "node:crypto";

// Fixed rather than read from the credential: the credential is pasted into a
// dashboard, and a value there should not be able to send a signed assertion
// anywhere but Google.
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const STS_ENDPOINT = "https://sts.googleapis.com/v1/token";
export const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1";

/** Refresh this long before expiry, so a token never lapses mid-request. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** How long each exchange may take before the request it is for gives up. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/** What deploy-ml.sh prints for a federated credential. Not a Google type. */
export const FEDERATED_TYPE = "eai_workload_identity_federation";

export interface ServiceAccountCredential {
  kind: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export interface FederatedCredential {
  kind: "federated";
  /** Signs the API's own JWT. Only its public half was ever given to Google. */
  private_key: string;
  key_id: string;
  issuer: string;
  subject: string;
  /** The provider, as the JWT's `aud`: https://iam.googleapis.com/projects/... */
  audience: string;
  /** The invoker service account the federated identity mints ID tokens for. */
  service_account: string;
}

export type GoogleCredential = ServiceAccountCredential | FederatedCredential;

/**
 * Read ML_SERVICE_GOOGLE_KEY, or null when it is unset.
 *
 * Accepts the JSON or its base64. A dashboard keeps a one-line value more
 * reliably than a multi-line blob with a PEM inside it, so the deploy script
 * prints base64.
 *
 * Throws on anything else, with a message that never repeats the value.
 */
export function parseGoogleCredential(raw: string | undefined): GoogleCredential | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const json = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "ML_SERVICE_GOOGLE_KEY is neither JSON nor base64-encoded JSON. Paste " +
      "the base64 line the deploy script printed."
    );
  }

  const str = (k: string) => typeof parsed?.[k] === "string" && parsed[k].length > 0;

  if (parsed?.type === FEDERATED_TYPE) {
    const fields = ["private_key", "key_id", "issuer", "subject", "audience", "service_account"];
    const missing = fields.filter(k => !str(k));
    if (missing.length) {
      throw new Error(`ML_SERVICE_GOOGLE_KEY is missing ${missing.join(", ")}. Re-run the deploy script and paste its output again.`);
    }
    if (!/^https:\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(parsed.audience)) {
      throw new Error("ML_SERVICE_GOOGLE_KEY's audience is not a workload identity provider.");
    }
    return {
      kind: "federated",
      private_key: parsed.private_key,
      key_id: parsed.key_id,
      issuer: parsed.issuer,
      subject: parsed.subject,
      audience: parsed.audience,
      service_account: parsed.service_account,
    };
  }

  if (parsed?.type === "service_account" && str("client_email") && str("private_key")) {
    return {
      kind: "service_account",
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      private_key_id: str("private_key_id") ? parsed.private_key_id : undefined,
    };
  }

  throw new Error(
    "ML_SERVICE_GOOGLE_KEY is neither the deploy script's federation credential " +
    'nor a service account key (type "service_account" with client_email and private_key).'
  );
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

function signJwt(header: object, claims: object, privateKey: string): string {
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${b64url(signature)}`;
}

/** The JWT a service account signs to ask Google for an ID token directly. */
export function signAssertion(key: ServiceAccountCredential, audience: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  return signJwt(
    { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) },
    {
      iss: key.client_email,
      sub: key.client_email,
      aud: TOKEN_ENDPOINT,
      iat,
      exp: iat + 3600,
      // What makes this an ID-token request rather than an access-token one:
      // the token Google returns is minted for this audience, which is the
      // receiving service's URL.
      target_audience: audience,
    },
    key.private_key,
  );
}

/**
 * The JWT the API signs as its own identity provider, for Google's STS.
 *
 * Ten minutes: it is exchanged the moment it is made, and a short life is the
 * only thing standing between a leaked assertion and its reuse.
 */
export function signFederatedAssertion(cred: FederatedCredential, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  return signJwt(
    { alg: "RS256", typ: "JWT", kid: cred.key_id },
    { iss: cred.issuer, sub: cred.subject, aud: cred.audience, iat, exp: iat + 600 },
    cred.private_key,
  );
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

type Deps = { fetch: typeof fetch; now: () => number };

/** POST, and either the parsed JSON or an error naming the step that failed. */
async function post(deps: Deps, step: string, url: string, init: RequestInit): Promise<any> {
  const res = await deps.fetch(url, { method: "POST", ...init, signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS) });
  if (!res.ok) {
    // Google's error bodies name the problem ("invalid_grant", a missing
    // permission) and contain nothing secret, so they are worth passing on.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${step} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

const form = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function idTokenFromServiceAccount(key: ServiceAccountCredential, audience: string, deps: Deps) {
  const body = await post(deps, "Google token exchange", TOKEN_ENDPOINT, form({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signAssertion(key, audience, deps.now()),
  }));
  if (typeof body?.id_token !== "string") throw new Error("Google token exchange returned no id_token");
  return body.id_token as string;
}

async function idTokenFromFederation(cred: FederatedCredential, audience: string, deps: Deps) {
  // 1. The API's own JWT for a federated access token. STS names the
  //    provider without the scheme the JWT's `aud` carries.
  const sts = await post(deps, "Google STS exchange", STS_ENDPOINT, form({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: cred.audience.replace(/^https:/, ""),
    scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: signFederatedAssertion(cred, deps.now()),
  }));
  if (typeof sts?.access_token !== "string") throw new Error("Google STS exchange returned no access_token");

  // 2. That token for an ID token, as the invoker service account, for the
  //    ML service. The pool's principal holds Service Account OpenID Connect
  //    Identity Token Creator on that one account, and nothing else.
  const minted = await post(
    deps,
    "Google generateIdToken",
    `${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(cred.service_account)}:generateIdToken`,
    {
      headers: { authorization: `Bearer ${sts.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ audience, includeEmail: true }),
    },
  );
  if (typeof minted?.token !== "string") throw new Error("Google generateIdToken returned no token");
  return minted.token as string;
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
  credential: GoogleCredential,
  audience: string,
  // globalThis.fetch is looked up per call, not captured here: the source is
  // built at module load, and a captured reference would ignore any later
  // replacement -- which is how a test's stub was once bypassed and the
  // exchange went to Google for real.
  deps: Deps = {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
  },
): IdTokenSource {
  let cached: { token: string; refreshAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const token = credential.kind === "federated"
      ? await idTokenFromFederation(credential, audience, deps)
      : await idTokenFromServiceAccount(credential, audience, deps);
    cached = { token, refreshAt: expiryOf(token) - REFRESH_MARGIN_MS };
    return token;
  }

  return {
    async token() {
      if (cached && deps.now() < cached.refreshAt) return cached.token;
      if (!pending) pending = exchange().finally(() => { pending = null; });
      return pending;
    },
  };
}
