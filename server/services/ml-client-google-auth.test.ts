// server/services/ml-client-google-auth.test.ts
//
// With ML_SERVICE_GOOGLE_KEY set, every request the API sends the ML service
// carries a Google ID token as well as the service token. Its own file because
// ml-client reads the key once, at module load.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ID_TOKEN = ["e30", Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url"), "sig"].join(".");

process.env.ML_SERVICE_URL = "https://eai-ml-abc-uw.a.run.app";
process.env.ML_SERVICE_TOKEN = "service-token-for-tests";
process.env.ML_SERVICE_GOOGLE_KEY = Buffer.from(JSON.stringify({
  type: "service_account",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: "eai-api-invoker@eai-demo.iam.gserviceaccount.com",
})).toString("base64");

const { mlFetch, probeHostDirectly, resetRateLimitGate, ML_AUTH_MODE } = await import("./ml-client");

const realFetch = globalThis.fetch;
const sent: Array<{ url: string; headers: Record<string, string> }> = [];
// Never reset: the token is cached for the life of the module, so one exchange
// across the whole file is the expected count -- and it must be this stub's.
let tokenRequests = 0;

beforeEach(() => {
  sent.length = 0;
  resetRateLimitGate();
  globalThis.fetch = vi.fn(async (url: any, init: any = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenRequests += 1;
      return new Response(JSON.stringify({ id_token: ID_TOKEN }), { status: 200 });
    }
    sent.push({ url: String(url), headers: init.headers });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("requests to a private Cloud Run ML service", () => {
  it("say so in the diagnostic", () => {
    expect(ML_AUTH_MODE).toBe("google-id-token + service token");
  });

  it("carry both credentials on an ordinary call", async () => {
    await mlFetch("/drift/summary");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://eai-ml-abc-uw.a.run.app/drift/summary");
    expect(sent[0].headers.Authorization).toBe(`Bearer ${ID_TOKEN}`);
    expect(sent[0].headers["X-Service-Token"]).toBe("service-token-for-tests");
  });

  it("carry both on the admin diagnostic's direct probe too", async () => {
    // The probe bypasses mlFetch on purpose; it must not bypass the credential,
    // or on a private service it would only ever report Google's 403.
    await probeHostDirectly(1_000);
    expect(sent[0].headers.Authorization).toBe(`Bearer ${ID_TOKEN}`);
  });

  it("mint no token for a request the rate-limit gate will not send", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: any, init: any) =>
      String(url).startsWith(process.env.ML_SERVICE_URL!) ? new Response("", { status: 429 }) : answer(url, init));
    await mlFetch("/health");                 // draws the 429, opens the gate
    fetchMock.mockClear();

    const res = await mlFetch("/drift/summary");
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();  // neither Google nor the service
  });

  it("got its token from the stub, never from Google itself", () => {
    // A source that captured fetch at module load once sent this file's
    // throwaway key to the real token endpoint.
    expect(tokenRequests).toBe(1);
  });
});
