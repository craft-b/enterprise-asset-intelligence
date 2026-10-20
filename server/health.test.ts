// server/health.test.ts
//
// /api/health answered { status: "healthy" } and nothing else, which cannot
// answer the question it gets asked: after a push, Render keeps the old
// instance serving until the new one passes its own health check, so a 200
// proves something is up, not that your change is live. Three deploys this
// week were "confirmed" by waiting a while and trying again.
//
// These are source-level assertions, like the cache-header tests: the value
// comes from the hosting environment, so there is nothing to call locally
// that would prove the deployed answer.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf-8");
const handler = ROUTES.match(/app\.get\('\/api\/health'[\s\S]*?\n  \}\);/)?.[0] ?? "";

describe("the health endpoint says which build answered", () => {
  it("exists", () => {
    expect(handler, "no /api/health handler found").not.toBe("");
  });

  it("reports the commit", () => {
    expect(handler).toMatch(/commit:/);
  });

  it("reads the commit from the host's build variable", () => {
    // Hardcoding it in source would make it a lie on the very next commit.
    expect(ROUTES).toMatch(/RENDER_GIT_COMMIT/);
  });

  it("resolves the commit once, outside the handler", () => {
    // Not per request: the value cannot change while the process lives, and a
    // health check is the one endpoint that must stay cheap.
    const constAt = ROUTES.indexOf("const BUILD_COMMIT");
    const handlerAt = ROUTES.indexOf("app.get('/api/health'");
    expect(constAt).toBeGreaterThan(-1);
    expect(constAt).toBeLessThan(handlerAt);
  });

  it("says 'unknown' rather than empty when the variable is absent", () => {
    // Locally and under docker-compose there is no build commit, and an empty
    // string reads as a bug in the endpoint rather than an absent variable.
    expect(ROUTES).toMatch(/\|\| "unknown"/);
  });

  it("reports how long this instance has been up", () => {
    // A free-tier instance that cold started two seconds ago behaves
    // differently from one that has been warm for an hour.
    expect(handler).toMatch(/uptimeSeconds/);
    expect(handler).toMatch(/process\.uptime\(\)/);
  });

  it("needs no authentication", () => {
    // A health check behind a session is not a health check.
    expect(handler).not.toMatch(/requireAuth|requireAdmin/);
  });
});
