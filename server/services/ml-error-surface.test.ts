// server/services/ml-error-surface.test.ts
//
// One bug, five times.
//
// Every call to the ML service can get an answer from something other than the
// ML service: the hosting provider's gateway returns an HTML page when the
// container is suspended, out of memory, or simply not there. Interpolating
// `${await res.text()}` into an error forwards that page to whoever is
// looking, and these errors are shown in the UI. The seeding dialog rendered
// a ~180 KB Render 502 page, fonts and stylesheet included, inside an alert.
//
// It was fixed at the /train call site, then happened again at
// /drift/compute-reference, /predict/multi-horizon, the batch variant and
// /predict/project — because the fix was a local one and nothing stopped the
// next call site from doing it too.
//
// describeMlFailure() in ml-client.ts is the place a response body is allowed
// to be read: it keeps the status, content type and target URL, truncates
// JSON, and never quotes HTML. This test keeps everything else out of that
// business.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SERVER_DIR = join(__dirname, "..");

/** ml-client.ts reads the body on purpose; it is the thing being delegated to. */
const EXEMPT = new Set(["ml-client.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    if (EXEMPT.has(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * A response body being interpolated into a string.
 *
 * Deliberately shaped around the construct rather than the variable name: the
 * five occurrences used five different names (res, response, mlRes,
 * mlResponse, fastapiRes), which is why grepping for one never caught the
 * next.
 */
const FORWARDS_BODY = /\$\{\s*await\s+[A-Za-z_$][\w$]*(?:\.clone\(\))?\s*\.text\(\)\s*\}/;

function offendingLines(source: string): string[] {
  return source
    .split("\n")
    .filter(line => FORWARDS_BODY.test(line))
    // The comments recording why this is forbidden quote the pattern.
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line.trim()) && !line.trim().startsWith("//"));
}

describe("ML errors do not forward response bodies", () => {
  const files = sourceFiles(SERVER_DIR);

  it("is looking at the server source", () => {
    // Guards the test: a wrong path would make the sweep below vacuous.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some(f => f.endsWith("routes.ts"))).toBe(true);
    expect(files.some(f => f.endsWith("seed-orchestrator.ts"))).toBe(true);
  });

  it("recognises the construct it is banning", () => {
    // The five real offenders, verbatim.
    expect(FORWARDS_BODY.test(
      'if (!res.ok) throw new Error(`Drift reference failed: ${await res.text()}`);'
    )).toBe(true);
    expect(FORWARDS_BODY.test(
      'throw new Error(`FastAPI multi-horizon error: ${await fastapiRes.text()}`);'
    )).toBe(true);
    expect(FORWARDS_BODY.test(
      'res.status(502).json({ message: `ML service error: ${await mlResponse.text()}` });'
    )).toBe(true);
    expect(FORWARDS_BODY.test(
      'throw new Error(`ML service returned ${response.status}: ${await response.text()}`);'
    )).toBe(true);
    expect(FORWARDS_BODY.test(
      'throw new Error(`x ${await res.clone().text()}`);'
    )).toBe(true);

    // And does not object to the summariser, or to logging a body.
    expect(FORWARDS_BODY.test(
      'await describeMlFailure(res, "/train")'
    )).toBe(false);
    expect(FORWARDS_BODY.test(
      'console.error("[PM] body:", await response.text());'
    )).toBe(false);
  });

  it.each(sourceFiles(SERVER_DIR).map(f => [f.slice(SERVER_DIR.length + 1), f] as const))(
    "%s", (_name, path) => {
      const found = offendingLines(readFileSync(path, "utf-8"));
      expect(
        found,
        "Use describeMlFailure() from services/ml-client instead — a raw body " +
        "may be an HTML error page, and these messages are shown in the UI."
      ).toEqual([]);
    }
  );
});
