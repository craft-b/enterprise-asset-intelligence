// server/canonical-redirect.test.ts
//
// The API container also serves the built SPA, so its own URL is a second
// front door to the demo -- the one without the waking screen. With
// PUBLIC_APP_URL set, page requests are sent to the static host instead.
// These exercise the handler directly with a fake request and response.

import { describe, it, expect, vi } from "vitest";
import { canonicalRedirect } from "./static";

const CANONICAL = "https://enterprise-asset-intelligence.vercel.app";

function call(
  handler: NonNullable<ReturnType<typeof canonicalRedirect>>,
  overrides: Partial<{ method: string; path: string; host: string; accept: string }> = {},
) {
  const req = {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/login",
    originalUrl: overrides.path ?? "/login",
    headers: {
      host: overrides.host ?? "eai-api.onrender.com",
      accept: overrides.accept ?? "text/html,application/xhtml+xml",
    },
  };
  const res = { redirect: vi.fn() };
  const next = vi.fn();
  handler(req as never, res as never, next);
  return { res, next };
}

describe("canonicalRedirect", () => {
  it("registers nothing when PUBLIC_APP_URL is unset", () => {
    expect(canonicalRedirect(undefined)).toBeNull();
    expect(canonicalRedirect("")).toBeNull();
  });

  it("refuses a value that is not a URL, at boot rather than per request", () => {
    expect(() => canonicalRedirect("not a url")).toThrow(/PUBLIC_APP_URL/);
  });

  it("sends a page request to the same path on the canonical origin", () => {
    const { res, next } = call(canonicalRedirect(CANONICAL)!, { path: "/equipment/12" });
    expect(res.redirect).toHaveBeenCalledWith(308, `${CANONICAL}/equipment/12`);
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves the API alone", () => {
    const { res, next } = call(canonicalRedirect(CANONICAL)!, { path: "/api/health" });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("leaves asset requests alone", () => {
    // A page already loaded from this host fetches its bundle with Accept: */*.
    const { res, next } = call(canonicalRedirect(CANONICAL)!, {
      path: "/assets/index-abc123.js", accept: "*/*",
    });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("leaves writes alone", () => {
    const { res, next } = call(canonicalRedirect(CANONICAL)!, { method: "POST", path: "/login" });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("never redirects a request that is already on the canonical host", () => {
    // A misconfigured proxy that forwarded pages here must not loop.
    const { res, next } = call(canonicalRedirect(CANONICAL)!, {
      host: "enterprise-asset-intelligence.vercel.app",
    });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
