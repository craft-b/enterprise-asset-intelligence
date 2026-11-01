// server/route-cost-guards.test.ts
//
// The protections in services/ml-response-cache.ts and request-limits.ts only
// work if routes.ts uses them, and the failure mode of forgetting is silent: a
// new viewer route that calls mlFetch directly works perfectly, and also
// reopens the bill to anyone with the public viewer password. These read the
// source, as async-routes.test.ts does, so that omission fails here instead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "routes.ts"), "utf-8");
const lines = SRC.split("\n");

interface Handler { line: number; header: string; path: string; body: string }

/** Each route, from its app.<method>( line to the next one. */
function handlers(): Handler[] {
  const starts: number[] = [];
  lines.forEach((l, i) => { if (/app\.(get|post|put|patch|delete)\(/.test(l)) starts.push(i); });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const header = lines[start];
    return {
      line: start + 1,
      header,
      path: header.match(/app\.\w+\(\s*([^,]+),/)?.[1].trim() ?? header,
      body: lines.slice(start, end).join("\n"),
    };
  });
}

const all = handlers();
const route = (path: string) => {
  // A literal path is quoted in the source; api.auth.* paths are expressions.
  const h = all.find(r => [path, `"${path}"`, `'${path}'`].includes(r.path));
  if (!h) throw new Error(`route ${path} not found in routes.ts`);
  return h;
};
// Viewer-reachable: requireAuth and not requireAdmin. requireAgentKey routes
// are gated by a secret that is not published, so they are not in scope.
const viewerRoutes = all.filter(h => h.header.includes("requireAuth") && !h.header.includes("requireAdmin"));

describe("viewer routes cannot reach the ML service uncached", () => {
  it("found the viewer routes", () => {
    expect(viewerRoutes.length).toBeGreaterThan(20);
  });

  it("every viewer route that calls the ML service goes through the cache", () => {
    const direct = viewerRoutes
      .filter(h => h.body.includes("mlFetch(") && !h.body.includes("cachedMl("))
      .map(h => `routes.ts:${h.line} ${h.path}`);
    expect(direct, "call the ML service through cachedMl()/shared(), not mlFetch()").toEqual([]);
  });

  it.each([
    ["/api/ml/drift/summary", 'shared("/drift/summary"'],
    ["/api/ml/data-quality/report", 'shared("/data-quality/report"'],
    ["/api/ml/models/registry", 'shared("/models/registry"'],
    ["/api/ml/models/compare", 'shared("/models/champion-challenger/compare"'],
    ["/api/ml/model-metrics", "shared('/models/feature-importance'"],
    ["/api/ml/train/status", 'cachedMl("status:/train/status"'],
  ])("%s is cached", (path, call) => {
    expect(route(path).body).toContain(call);
  });

  it("the projection is cached, budgeted, and only for equipment that exists", () => {
    const body = route("/api/equipment/:id/projection").body;
    const exists = body.indexOf("storage.getEquipment(equipmentId)");
    const cached = body.indexOf("cachedMl(key, { ttlMs: ML_CACHE_TTL_MS.projection, budgeted: true }");
    expect(exists).toBeGreaterThan(-1);
    expect(cached).toBeGreaterThan(exists);
  });

  it("the expensive shared reads spend the budget", () => {
    expect(SRC).toMatch(/const shared = [^;]*budgeted: true/s);
  });

  it("an admin write empties the cache", () => {
    expect(SRC).toMatch(/req\.method !== "GET"[^]*?ADMINISTRATOR[^]*?invalidateMlCache\(\)/);
  });
});

describe("the request limits are wired in", () => {
  it("the API-wide limit runs after CORS and before the session", () => {
    const cors = SRC.indexOf("applyCors(app);");
    const limit = SRC.indexOf('app.use("/api", apiRateLimit());');
    const session = SRC.indexOf("session({");
    expect(cors).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(cors);
    expect(session).toBeGreaterThan(limit);
  });

  it("sign-in checks the throttle before bcrypt and records both outcomes", () => {
    const body = route("api.auth.login.path").body;
    const check = body.indexOf("loginThrottle.blockedFor(");
    const hash = body.indexOf("bcrypt.compareSync(");
    const fail = body.indexOf("loginThrottle.recordFailure(");
    const ok = body.indexOf("loginThrottle.recordSuccess(");
    expect(check).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(check);
    expect(fail).toBeGreaterThan(hash);
    expect(ok).toBeGreaterThan(fail);
  });

  it("registration is limited", () => {
    expect(route("api.auth.register.path").header).toContain("registerRateLimit()");
  });

  it("a malformed Google key fails at boot, not at the first ML request", () => {
    expect(SRC).toContain("validateMlServiceGoogleKey(process.env.ML_SERVICE_GOOGLE_KEY);");
  });
});
