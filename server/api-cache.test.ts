// server/api-cache.test.ts
//
// The seed progress screen polled /api/admin/seed/status every 1.5 seconds and
// showed the same step for half an hour. The network panel told the story: a
// run of 304 Not Modified, 225 bytes each. Express sends an ETag with every
// JSON response, the browser revalidated with If-None-Match, and the server
// answered "unchanged" -- so the page went on rendering a cached payload while
// the run behind it moved on and then died.
//
// Two call sites had already been patched with `cache: "no-store"` on the
// fetch, which is the same bug fixed twice and left open everywhere else. A
// polled endpoint that may be cached is a UI that may be lying, and nothing in
// a code review makes that visible -- the request is made, a 200-looking
// response arrives, the data is just old.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const INDEX = readFileSync(join(__dirname, "index.ts"), "utf-8");
// The cache policy belongs with the API surface, not the server bootstrap:
// mounting the routes anywhere else (the HTTP smoke test does) used to lose
// it silently, along with the JSON 404.
const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf-8");

describe("API responses are not cacheable", () => {
  it("sets no-store for everything under /api", () => {
    const mw = ROUTES.match(/app\.use\("\/api", \(_req, res, next\)[\s\S]*?\n  \}\);/)?.[0];
    expect(mw, "no /api cache middleware found").toBeDefined();
    expect(mw!).toMatch(/Cache-Control/);
    expect(mw!).toMatch(/no-store/);
  });

  it("applies before any route can answer", () => {
    // Registered after a handler and the headers are already sent.
    const mwAt = ROUTES.indexOf('app.use("/api", (_req, res, next)');
    const firstRouteAt = ROUTES.search(/app\.(get|post|put|patch|delete)\(/);
    expect(mwAt).toBeGreaterThan(-1);
    expect(mwAt).toBeLessThan(firstRouteAt);
  });

  it("answers an unmatched /api path with JSON, after every route", () => {
    // Falling through to the static handler answered a missing endpoint with
    // the SPA shell and a 200.
    const notFound = ROUTES.indexOf("No such endpoint");
    expect(notFound).toBeGreaterThan(-1);
    const lastRoute = ROUTES.lastIndexOf("app.get(");
    expect(notFound).toBeGreaterThan(lastRoute);
  });

  it("turns off the ETag that produced the 304s", () => {
    expect(INDEX).toMatch(/app\.set\("etag",\s*false\)/);
  });
});

describe("the proxy in front of it does not cache either", () => {
  const vercel = JSON.parse(
    readFileSync(join(__dirname, "..", "vercel.json"), "utf-8")
  );

  it("has a no-store rule for /api", () => {
    const rule = vercel.headers.find((h: any) => h.source.startsWith("/api"));
    expect(rule, "no /api header rule in vercel.json").toBeDefined();
    const cc = rule.headers.find((h: any) => h.key === "Cache-Control");
    expect(cc.value).toMatch(/no-store/);
  });

  it("puts it before the catch-all, which would otherwise win", () => {
    const sources = vercel.headers.map((h: any) => h.source);
    expect(sources.indexOf("/api/(.*)")).toBeLessThan(sources.indexOf("/(.*)"));
  });

  it("still caches hashed assets forever", () => {
    // The point is to stop caching the API, not to make the app slow.
    const assets = vercel.headers.find((h: any) => h.source === "/assets/(.*)");
    expect(assets.headers[0].value).toMatch(/immutable/);
  });
});

describe("the polled status call", () => {
  const HOOK = readFileSync(
    join(__dirname, "..", "client", "src", "hooks", "use-system-status.ts"),
    "utf-8"
  );

  it("asks for a fresh body as well", () => {
    // Redundant with the server header by design: this is the call whose
    // staleness is invisible, and two layers is cheap.
    const fn = HOOK.match(/export function useSeedStatus[\s\S]*?\n\}/)![0];
    expect(fn).toMatch(/cache:\s*"no-store"/);
  });
});
