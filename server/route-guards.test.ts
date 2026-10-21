// server/route-guards.test.ts
//
// POST /api/admin/seed carried requireAuth, not requireAdmin.
//
// The seed pipeline does not truncate anything -- only resetSystem does, and
// that was already admin-gated -- it appends. So running it against a
// database that is already seeded produces a second fleet: twenty equipment
// units instead of ten, duplicate rentals, doubled revenue, two of every
// asset in the risk queue. On the public demo the advertised account is a
// VIEWER, and a VIEWER session was enough to ask for it.
//
// The UI never offered it, because the setup screen only appears on an
// unseeded database, so this needed a deliberate request rather than a
// misplaced click. It is still the button that rebuilds the dataset, and it
// belongs to the same role as the one that wipes it.
//
// These assertions read the route table as text, which is coarse but is the
// only way to check a guard without standing up a server and a database, and
// the failure being guarded against is a guard that is missing rather than
// one that is subtly wrong.
//
// Two things the first version of this file got wrong, both of which made it
// report defects that were not there:
//
//   - it read only the first guard, so `requireAuth, requireAdmin` on
//     /api/simulate/day looked unguarded;
//   - it matched only string-literal paths, so the routes registered through
//     the shared contract (api.equipment.create.path) were invisible, and a
//     route being absent read as a route being open.
//
// Hence: every guard in the argument list, and paths resolved through the
// contract object.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { api } from "@shared/routes";

const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf-8");

/** Resolve "api.equipment.create" to the path the contract declares. */
function contractPath(expr: string): string | undefined {
  const node = expr.split(".").slice(1).reduce<any>((acc, key) => acc?.[key], api);
  return typeof node?.path === "string" ? node.path : undefined;
}

interface Registration {
  method: string;
  path: string;
  guards: string[];
}

/**
 * Every route the table registers, with all of its middleware.
 *
 * Parsed by walking from each `app.<method>(` to the start of its handler and
 * reading the arguments in between, so a route with two guards reports two.
 */
function registrations(): Registration[] {
  const out: Registration[] = [];
  const re = /app\.(get|post|put|patch|delete)\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(ROUTES)) !== null) {
    const after = ROUTES.slice(m.index + m[0].length, m.index + m[0].length + 500);
    // Arguments stop where the handler begins.
    const handlerAt = after.search(/async\s*\(|asyncRoute\s*\(|\(\s*req\b/);
    const args = handlerAt === -1 ? after : after.slice(0, handlerAt);

    const literal = /^\s*["'`]([^"'`]+)["'`]/.exec(args);
    const contract = /^\s*(api\.[\w.]+)\.path/.exec(args);
    const path = literal ? literal[1] : contract ? contractPath(contract[1]) : undefined;
    if (!path) continue;

    out.push({
      method: m[1].toUpperCase(),
      path,
      guards: args.match(/\brequire[A-Z]\w*/g) ?? [],
    });
  }
  return out;
}

const find = (method: string, path: string) =>
  registrations().find(r => r.method === method && r.path === path);

describe("the parser sees what it claims to see", () => {
  // Without these, a regex that silently stops matching turns every
  // assertion below into a pass.
  it("finds a useful number of routes", () => {
    expect(registrations().length).toBeGreaterThan(50);
  });

  it("resolves paths registered through the shared contract", () => {
    expect(find("POST", "/api/equipment")).toBeDefined();
  });

  it("reads more than the first guard", () => {
    expect(find("POST", "/api/simulate/day")?.guards).toEqual(["requireAuth", "requireAdmin"]);
  });
});

describe("the routes that rebuild or destroy the dataset are admin-only", () => {
  it("gates the seed", () => {
    expect(find("POST", "/api/admin/seed")?.guards).toContain("requireAdmin");
  });

  it("gates the reset", () => {
    expect(find("POST", "/api/admin/reset")?.guards).toContain("requireAdmin");
  });

  it("leaves the read-only status endpoints open to any signed-in user", () => {
    // A VIEWER watching a seed it cannot start is the intended shape: the
    // progress screen and the system-status banner both poll these, and
    // closing them would make the demo look broken to the account the demo
    // advertises.
    expect(find("GET", "/api/admin/seed/status")?.guards).toEqual(["requireAuth"]);
    expect(find("GET", "/api/admin/system-status")?.guards).toEqual(["requireAuth"]);
  });
});

describe("no mutating /api/admin route settles for requireAuth", () => {
  it("holds for every one of them", () => {
    const weak = registrations().filter(
      r =>
        r.path.startsWith("/api/admin") &&
        r.method !== "GET" &&
        !r.guards.includes("requireAdmin")
    );
    expect(weak).toEqual([]);
  });
});

describe("the write surface is admin-only", () => {
  // Spot checks on the routes that change the fleet. The demo's safety story
  // is that the advertised account cannot reach any of them.
  const MUST_BE_ADMIN: [string, string][] = [
    ["POST", "/api/equipment"],
    ["DELETE", "/api/equipment/:id"],
    ["DELETE", "/api/rentals/:id"],
    ["POST", "/api/maintenance"],
    ["POST", "/api/ml/train"],
    ["POST", "/api/ml/models/promote"],
    ["POST", "/api/simulate/day"],
  ];

  for (const [method, path] of MUST_BE_ADMIN) {
    it(`${method} ${path}`, () => {
      const found = find(method, path);
      expect(found, `${method} ${path} is no longer registered`).toBeDefined();
      expect(found!.guards).toContain("requireAdmin");
    });
  }
});
