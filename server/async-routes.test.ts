// server/async-routes.test.ts
//
// Express 4 does not await route handlers. A handler that rejects is not an
// error Express ever sees: it is an unhandled promise rejection, and Node has
// terminated the process on those since v15.
//
// So POST /api/auth/login -- unauthenticated -- threw in Zod on a malformed
// body and took the whole server down with it. Anyone could restart the
// service with one bad request, and every in-memory job went with it,
// including a seed that was midway through. Two unexplained restarts during
// this project killed a running seed; this is the likeliest reason.
//
// Every async handler must therefore either guard itself with try/catch or be
// wrapped in asyncRoute, which forwards the rejection to next(). This checks
// that none have been added without one.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "routes.ts"), "utf-8");
const lines = SRC.split("\n");

interface Handler { line: number; method: string; path: string; body: string }

function handlers(): Handler[] {
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/app\.(get|post|put|patch|delete)\(/.test(l)) starts.push(i);
  });

  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const header = lines[start];
    const m = header.match(/app\.(get|post|put|patch|delete)\(\s*([^,]+),/);
    return {
      line: start + 1,
      method: (m?.[1] ?? "?").toUpperCase(),
      path: (m?.[2] ?? header).trim(),
      body: lines.slice(start, end).join("\n"),
    };
  });
}

/** Handlers that actually await something — the only ones that can reject. */
const asyncHandlers = handlers().filter(h => h.body.includes("await"));

describe("async route handlers cannot take the process down", () => {
  it("found handlers to check", () => {
    // Guards the sweep: zero would make it vacuous.
    expect(asyncHandlers.length).toBeGreaterThan(20);
  });

  it("every awaiting handler is guarded", () => {
    const unguarded = asyncHandlers
      .filter(h => !/\btry\s*\{/.test(h.body) && !h.body.includes("asyncRoute("))
      .map(h => `routes.ts:${h.line} ${h.method} ${h.path.slice(0, 50)}`);

    expect(
      unguarded,
      "an async handler that rejects is an unhandled rejection in Express 4, " +
      "and Node exits on those — wrap it in asyncRoute() or give it a try/catch"
    ).toEqual([]);
  });

  it("the wrapper forwards rejections rather than swallowing them", () => {
    // A wrapper that caught and ignored would turn a crash into a hung
    // request, which is not an improvement.
    const fn = SRC.match(/function asyncRoute[\s\S]*?\n\}/)![0];
    expect(fn).toMatch(/\.catch\(next\)/);
    expect(fn).toMatch(/Promise\.resolve\(/);
  });

  it("the unauthenticated endpoints are covered", () => {
    // These are reachable by anyone, so they are the ones that matter most.
    for (const path of ["api.auth.login.path", "api.auth.register.path"]) {
      const h = asyncHandlers.find(x => x.path.includes(path));
      expect(h, `${path} handler not found`).toBeDefined();
      expect(h!.body.includes("asyncRoute(") || /\btry\s*\{/.test(h!.body)).toBe(true);
    }
  });
});

describe("the process-level net", () => {
  const INDEX = readFileSync(join(__dirname, "index.ts"), "utf-8");

  it("logs an unhandled rejection instead of letting Node exit", () => {
    expect(INDEX).toMatch(/process\.on\("unhandledRejection"/);
  });
});
