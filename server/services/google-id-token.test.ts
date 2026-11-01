// server/services/google-id-token.test.ts
//
// The exchange that makes the Cloud Run ML service private. Nothing here talks
// to Google: the key is generated per run, and the token endpoint is a stub
// that checks what a real one would check -- the grant type, and a signature
// that verifies against the key's public half.

import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  parseServiceAccountKey, signAssertion, expiryOf, createIdTokenSource,
  TOKEN_ENDPOINT, REFRESH_MARGIN_MS,
} from "./google-id-token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const keyFile = {
  type: "service_account",
  project_id: "eai-demo",
  private_key_id: "kid-123",
  private_key: PEM,
  client_email: "eai-api-invoker@eai-demo.iam.gserviceaccount.com",
};
const AUDIENCE = "https://eai-ml-abc-uw.a.run.app";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** A Google-shaped ID token: only `exp` matters to the code under test. */
const idToken = (expSeconds: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url"), "sig"].join(".");

describe("reading ML_SERVICE_GOOGLE_KEY", () => {
  it("is off when unset or blank", () => {
    expect(parseServiceAccountKey(undefined)).toBeNull();
    expect(parseServiceAccountKey("   ")).toBeNull();
  });

  it("accepts the key file and its base64", () => {
    const json = JSON.stringify(keyFile);
    for (const raw of [json, Buffer.from(json).toString("base64")]) {
      expect(parseServiceAccountKey(raw)).toEqual({
        client_email: keyFile.client_email,
        private_key: PEM,
        private_key_id: "kid-123",
      });
    }
  });

  it("refuses anything that is not a service account key, without echoing it", () => {
    const secretish = "not-json-but-could-be-a-secret";
    expect(() => parseServiceAccountKey(secretish)).toThrow(/neither JSON nor base64/);
    try { parseServiceAccountKey(secretish); } catch (e: any) { expect(e.message).not.toContain(secretish); }

    // A user OAuth client file is JSON, and is the wrong kind of credential.
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user", client_id: "x" })))
      .toThrow(/not a service account key/);
  });
});

describe("the signed assertion", () => {
  const key = parseServiceAccountKey(JSON.stringify(keyFile))!;
  const jwt = signAssertion(key, AUDIENCE, 1_700_000_000_000);
  const [h, c, s] = jwt.split(".");

  it("asks for an ID token for the ML service, as the service account", () => {
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    expect(decode(c)).toEqual({
      iss: keyFile.client_email,
      sub: keyFile.client_email,
      aud: TOKEN_ENDPOINT,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      target_audience: AUDIENCE,
    });
  });

  it("is signed by the key, and verifies against its public half", () => {
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("ID tokens", () => {
  const key = parseServiceAccountKey(JSON.stringify(keyFile))!;

  function stubEndpoint(expiries: number[]) {
    let call = 0;
    return vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(TOKEN_ENDPOINT);
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(form.get("assertion")!.split(".")).toHaveLength(3);
      return new Response(JSON.stringify({ id_token: idToken(expiries[call++]) }), { status: 200 });
    });
  }

  it("reads expiry from the token", () => {
    expect(expiryOf(idToken(1234))).toBe(1_234_000);
  });

  it("reuses a token until shortly before it expires, then fetches a new one", async () => {
    let now = 1_000_000_000_000;
    const exp = now / 1000 + 3600;
    const fetchStub = stubEndpoint([exp, exp + 3600]);
    const source = createIdTokenSource(key, AUDIENCE, { fetch: fetchStub as any, now: () => now });

    const first = await source.token();
    now += 3600_000 - REFRESH_MARGIN_MS - 1;          // just inside the margin
    expect(await source.token()).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    now += 2;                                          // just past it
    expect(await source.token()).not.toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers", async () => {
    const fetchStub = stubEndpoint([2_000_000_000]);
    const source = createIdTokenSource(key, AUDIENCE, { fetch: fetchStub as any, now: () => 0 });
    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reports Google's refusal, and tries again on the next call", async () => {
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id_token: idToken(2_000_000_000) }), { status: 200 }));
    const source = createIdTokenSource(key, AUDIENCE, { fetch: fetchStub as any, now: () => 0 });

    await expect(source.token()).rejects.toThrow(/token exchange failed \(400\).*invalid_grant/);
    await expect(source.token()).resolves.toMatch(/\./);
  });
});
