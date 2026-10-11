// client/src/lib/api-base.test.ts
//
// The fetch wrapper stands in for ~80 relative-path call sites, so a mistake
// here breaks every request in the deployed SPA at once — and only when the
// frontend and API are on different origins, which is exactly the case local
// development never exercises.

import { describe, it, expect, vi } from "vitest";
import { createApiFetch, installApiFetch, isApiPath, resolveApiUrl } from "./api-base";

const BASE = "https://eai-api.onrender.com";

/** A fetch stub that records what it was called with. */
function spyFetch() {
  const calls: Array<{ input: any; init?: RequestInit }> = [];
  const fn = vi.fn((input: any, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  return { fn, calls };
}

describe("isApiPath", () => {
  it.each(["/api", "/api/health", "/api/equipment/7?days=30"])("owns %s", path => {
    expect(isApiPath(path)).toBe(true);
  });

  it.each([
    "/assets/index.js",     // served by the static host, must not be rewritten
    "/favicon.png",
    "/",
    "/apiary",              // prefix lookalike
    "/setup",               // SPA route
    "https://other/api/x",  // already absolute
  ])("does not own %s", path => {
    expect(isApiPath(path)).toBe(false);
  });
});

describe("resolveApiUrl", () => {
  it("prefixes an API path", () => {
    expect(resolveApiUrl("/api/health", BASE)).toBe(`${BASE}/api/health`);
  });

  it("preserves query strings", () => {
    expect(resolveApiUrl("/api/equipment?status=AVAILABLE", BASE))
      .toBe(`${BASE}/api/equipment?status=AVAILABLE`);
  });

  it("is a no-op with no base — the same-origin case", () => {
    expect(resolveApiUrl("/api/health", "")).toBe("/api/health");
  });

  it("leaves non-API paths alone", () => {
    expect(resolveApiUrl("/assets/app.js", BASE)).toBe("/assets/app.js");
  });
});

describe("createApiFetch", () => {
  it("returns the original fetch when no base is configured", () => {
    const { fn } = spyFetch();
    expect(createApiFetch(fn, "")).toBe(fn);
  });

  it("rewrites a string API URL and attaches credentials", async () => {
    const { fn, calls } = spyFetch();
    await createApiFetch(fn, BASE)("/api/equipment");

    expect(calls[0].input).toBe(`${BASE}/api/equipment`);
    // Cross-site cookies are sent only when every request asks.
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("does not touch asset requests", async () => {
    const { fn, calls } = spyFetch();
    await createApiFetch(fn, BASE)("/assets/index.css");

    expect(calls[0].input).toBe("/assets/index.css");
    expect(calls[0].init?.credentials).toBeUndefined();
  });

  it("does not double-prefix an already absolute URL", async () => {
    const { fn, calls } = spyFetch();
    await createApiFetch(fn, BASE)(`${BASE}/api/health`);

    expect(calls[0].input).toBe(`${BASE}/api/health`);
    expect(String(calls[0].input).match(/onrender/g)).toHaveLength(1);
  });

  it("preserves method and body on a mutation", async () => {
    const { fn, calls } = spyFetch();
    await createApiFetch(fn, BASE)("/api/maintenance", {
      method: "POST",
      body: JSON.stringify({ equipmentId: 1 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(calls[0].input).toBe(`${BASE}/api/maintenance`);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe('{"equipmentId":1}');
    expect((calls[0].init?.headers as any)["Content-Type"]).toBe("application/json");
  });

  it("lets an explicit credentials setting win", async () => {
    const { fn, calls } = spyFetch();
    await createApiFetch(fn, BASE)("/api/health", { credentials: "omit" });
    expect(calls[0].init?.credentials).toBe("omit");
  });

  it("rewrites a Request object, keeping its method", async () => {
    const { fn, calls } = spyFetch();
    const request = new Request("http://localhost:5173/api/equipment", { method: "DELETE" });

    await createApiFetch(fn, BASE)(request);

    const sent = calls[0].input as Request;
    expect(sent.url).toBe(`${BASE}/api/equipment`);
    expect(sent.method).toBe("DELETE");
  });

  it("leaves a Request for a non-API path alone", async () => {
    const { fn, calls } = spyFetch();
    const request = new Request("http://localhost:5173/assets/app.js");

    await createApiFetch(fn, BASE)(request);

    expect((calls[0].input as Request).url).toBe("http://localhost:5173/assets/app.js");
  });
});

describe("installApiFetch", () => {
  it("replaces fetch on the scope", async () => {
    const { fn, calls } = spyFetch();
    const scope: any = { fetch: fn };

    installApiFetch(scope, BASE);
    await scope.fetch("/api/health");

    expect(calls[0].input).toBe(`${BASE}/api/health`);
  });

  it("does nothing when same-origin", () => {
    const { fn } = spyFetch();
    const scope: any = { fetch: fn };

    installApiFetch(scope, "");

    expect(scope.fetch).toBe(fn);
  });

  it("is idempotent, so hot reload cannot wrap a wrapper", async () => {
    const { fn, calls } = spyFetch();
    const scope: any = { fetch: fn };

    installApiFetch(scope, BASE);
    const afterFirst = scope.fetch;
    installApiFetch(scope, BASE);

    expect(scope.fetch).toBe(afterFirst);

    await scope.fetch("/api/health");
    // Double-wrapping would prefix twice.
    expect(calls[0].input).toBe(`${BASE}/api/health`);
  });
});
