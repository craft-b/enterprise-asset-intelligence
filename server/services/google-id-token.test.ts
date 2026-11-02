// server/services/google-id-token.test.ts
//
// The exchanges that make the Cloud Run ML service private. Nothing here talks
// to Google: keys are generated per run, and each endpoint is a stub that
// checks what the real one would -- grant types, audiences, the bearer token
// between steps, and signatures that verify against the key's public half.

import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  parseGoogleCredential, signAssertion, signFederatedAssertion, expiryOf, createIdTokenSource,
  TOKEN_ENDPOINT, STS_ENDPOINT, IAM_CREDENTIALS, REFRESH_MARGIN_MS, FEDERATED_TYPE,
  type FederatedCredential, type ServiceAccountCredential,
} from "./google-id-token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ML_URL = "https://eai-ml-q2n75oonzq-uw.a.run.app";
const PROVIDER = "https://iam.googleapis.com/projects/139712268172/locations/global/workloadIdentityPools/eai-pool/providers/eai-api";
const INVOKER = "eai-api-invoker@eai-demo.iam.gserviceaccount.com";

const serviceAccountFile = {
  type: "service_account",
  private_key_id: "kid-123",
  private_key: PEM,
  client_email: INVOKER,
};
const federatedFile = {
  type: FEDERATED_TYPE,
  private_key: PEM,
  key_id: "eai-api-1",
  issuer: "https://eai-api-q3u3.onrender.com",
  subject: "eai-api",
  audience: PROVIDER,
  service_account: INVOKER,
};

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const verifies = (jwt: string) => {
  const [h, c, s] = jwt.split(".");
  return createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
};

/** A Google-shaped ID token: only `exp` matters to the code under test. */
const idToken = (expSeconds: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url"), "sig"].join(".");

describe("reading ML_SERVICE_GOOGLE_KEY", () => {
  it("is off when unset or blank", () => {
    expect(parseGoogleCredential(undefined)).toBeNull();
    expect(parseGoogleCredential("   ")).toBeNull();
  });

  it("accepts the deploy script's federation credential, as JSON or base64", () => {
    const json = JSON.stringify(federatedFile);
    for (const raw of [json, Buffer.from(json).toString("base64")]) {
      const { type, ...rest } = federatedFile;
      expect(parseGoogleCredential(raw)).toEqual({ kind: "federated", ...rest });
    }
  });

  it("accepts a service account key file", () => {
    expect(parseGoogleCredential(JSON.stringify(serviceAccountFile))).toEqual({
      kind: "service_account", client_email: INVOKER, private_key: PEM, private_key_id: "kid-123",
    });
  });

  it("names what a federation credential is missing", () => {
    const { subject, service_account, ...partial } = federatedFile;
    expect(() => parseGoogleCredential(JSON.stringify(partial))).toThrow(/missing subject, service_account/);
  });

  it("refuses an audience that is not a workload identity provider", () => {
    const wrong = { ...federatedFile, audience: "https://attacker.example/token" };
    expect(() => parseGoogleCredential(JSON.stringify(wrong))).toThrow(/not a workload identity provider/);
  });

  it("refuses anything else, without echoing it", () => {
    const secretish = "not-json-but-could-be-a-secret";
    expect(() => parseGoogleCredential(secretish)).toThrow(/neither JSON nor base64/);
    try { parseGoogleCredential(secretish); } catch (e: any) { expect(e.message).not.toContain(secretish); }
    expect(() => parseGoogleCredential(JSON.stringify({ type: "authorized_user", client_id: "x" })))
      .toThrow(/neither the deploy script's federation credential nor a service account key/);
  });
});

describe("the signed assertions", () => {
  it("a service account asks Google for an ID token for the ML service", () => {
    const key = parseGoogleCredential(JSON.stringify(serviceAccountFile)) as ServiceAccountCredential;
    const jwt = signAssertion(key, ML_URL, 1_700_000_000_000);
    expect(decode(jwt.split(".")[0])).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    expect(decode(jwt.split(".")[1])).toEqual({
      iss: INVOKER, sub: INVOKER, aud: TOKEN_ENDPOINT,
      iat: 1_700_000_000, exp: 1_700_003_600, target_audience: ML_URL,
    });
    expect(verifies(jwt)).toBe(true);
  });

  it("the federated JWT is addressed to the provider and lives ten minutes", () => {
    const cred = parseGoogleCredential(JSON.stringify(federatedFile)) as FederatedCredential;
    const jwt = signFederatedAssertion(cred, 1_700_000_000_000);
    expect(decode(jwt.split(".")[0])).toEqual({ alg: "RS256", typ: "JWT", kid: "eai-api-1" });
    expect(decode(jwt.split(".")[1])).toEqual({
      iss: "https://eai-api-q3u3.onrender.com", sub: "eai-api", aud: PROVIDER,
      iat: 1_700_000_000, exp: 1_700_000_600,
    });
    expect(verifies(jwt)).toBe(true);
  });
});

describe("ID tokens through federation", () => {
  const cred = parseGoogleCredential(JSON.stringify(federatedFile))!;

  /** STS and IAM Credentials, checking each request the way Google would. */
  function stubGoogle(expiries: number[]) {
    let minted = 0;
    return vi.fn(async (url: string, init: RequestInit) => {
      if (url === STS_ENDPOINT) {
        const f = new URLSearchParams(String(init.body));
        expect(f.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
        expect(f.get("audience")).toBe(PROVIDER.replace(/^https:/, ""));
        expect(f.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
        expect(f.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
        expect(verifies(f.get("subject_token")!)).toBe(true);
        return new Response(JSON.stringify({ access_token: "federated-access-token", expires_in: 3600 }), { status: 200 });
      }
      expect(url).toBe(`${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(INVOKER)}:generateIdToken`);
      expect((init.headers as any).authorization).toBe("Bearer federated-access-token");
      expect(JSON.parse(String(init.body))).toEqual({ audience: ML_URL, includeEmail: true });
      return new Response(JSON.stringify({ token: idToken(expiries[minted++]) }), { status: 200 });
    });
  }

  it("exchanges the API's JWT at STS, then mints the ID token as the invoker", async () => {
    const fetchStub = stubGoogle([2_000_000_000]);
    const source = createIdTokenSource(cred, ML_URL, { fetch: fetchStub as any, now: () => 0 });
    expect(expiryOf(await source.token())).toBe(2_000_000_000_000);
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([STS_ENDPOINT, expect.stringContaining(":generateIdToken")]);
  });

  it("reuses the token until shortly before it expires", async () => {
    let now = 1_000_000_000_000;
    const exp = now / 1000 + 3600;
    const fetchStub = stubGoogle([exp, exp + 3600]);
    const source = createIdTokenSource(cred, ML_URL, { fetch: fetchStub as any, now: () => now });

    const first = await source.token();
    now += 3600_000 - REFRESH_MARGIN_MS - 1;
    expect(await source.token()).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(2);       // one STS, one mint

    now += 2;
    expect(await source.token()).not.toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it("shares one exchange between concurrent callers", async () => {
    const fetchStub = stubGoogle([2_000_000_000]);
    const source = createIdTokenSource(cred, ML_URL, { fetch: fetchStub as any, now: () => 0 });
    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("says which step Google refused, and tries again next time", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: idToken(2_000_000_000) }), { status: 200 }));
    const source = createIdTokenSource(cred, ML_URL, { fetch: fetchStub as any, now: () => 0 });

    await expect(source.token()).rejects.toThrow(/generateIdToken failed \(403\).*PERMISSION_DENIED/);
    await expect(source.token()).resolves.toMatch(/\./);
  });
});

describe("ID tokens from a service account key", () => {
  it("exchanges one signed assertion for an ID token", async () => {
    const key = parseGoogleCredential(JSON.stringify(serviceAccountFile))!;
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(TOKEN_ENDPOINT);
      const f = new URLSearchParams(String(init.body));
      expect(f.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(verifies(f.get("assertion")!)).toBe(true);
      return new Response(JSON.stringify({ id_token: idToken(2_000_000_000) }), { status: 200 });
    });
    const source = createIdTokenSource(key, ML_URL, { fetch: fetchStub as any, now: () => 0 });
    expect(expiryOf(await source.token())).toBe(2_000_000_000_000);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reports Google's refusal", async () => {
    const key = parseGoogleCredential(JSON.stringify(serviceAccountFile))!;
    const fetchStub = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const source = createIdTokenSource(key, ML_URL, { fetch: fetchStub as any, now: () => 0 });
    await expect(source.token()).rejects.toThrow(/token exchange failed \(400\).*invalid_grant/);
  });
});
