// client/src/pages/setup-claims.test.ts
//
// The Start Fresh card once described a capability the system did not have:
// "Connect real sensor data sources", at a time when nothing accepted a
// sensor reading from outside.
//
// That matters more here than it would in most projects. This one argues that
// its metrics are reported honestly, with the simulated data, the oracle
// ceiling and the SHAP circularity all disclosed. A UI overstating what the
// product does is the one place that argument cannot survive.
//
// Ingestion was subsequently built -- services/sensor-ingest.ts, behind a CSV
// upload -- so the claim is now true and this test holds the pairing from the
// other side: the copy is allowed precisely because the endpoint exists, and
// should go again if it ever does not.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SETUP_SOURCE = readFileSync(join(__dirname, "setup.tsx"), "utf-8");

/**
 * The page with comments stripped.
 *
 * What matters is the copy a visitor reads, not what the source says about it
 * — the comment explaining why the sensor claim was removed quotes the claim,
 * and matching against raw source flagged that explanation as the offence.
 */
const SETUP = SETUP_SOURCE
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")  // JSX comments
  .replace(/\/\*[\s\S]*?\*\//g, "")        // block comments
  .replace(/^\s*\/\/.*$/gm, "");             // line comments
const ROUTES = readFileSync(
  join(__dirname, "..", "..", "..", "server", "routes.ts"),
  "utf-8"
);

/** True when some route accepts a written sensor reading. */
function hasSensorIngestion(): boolean {
  return /app\.(post|put)\(\s*["'`][^"'`]*sensor/i.test(ROUTES);
}

describe("setup page claims", () => {
  it("has the files it is asserting about", () => {
    // Guards the test: a bad path would otherwise make everything below vacuous.
    expect(SETUP).toContain("Start Fresh");
    // And stripping comments must not have eaten the copy itself.
    expect(SETUP).toContain("Load Demo Data");
    expect(ROUTES).toContain("app.post");
  });

  it("matches the copy to whether ingestion exists", () => {
    // Asserted in both directions so the test cannot go quiet. Before the
    // endpoint existed the card advertised it anyway; now that it exists, the
    // card should say so, and if it is ever removed this fails again.
    const advertises = /import sensor readings|sensor data from csv/i.test(SETUP);

    expect(
      advertises,
      hasSensorIngestion()
        ? "POST /api/sensor-readings exists but Start Fresh does not mention importing readings"
        : "Start Fresh advertises sensor import but no endpoint accepts a reading"
    ).toBe(hasSensorIngestion());
  });

  it("never claims to connect to live sensor sources", () => {
    // Importing a CSV is not a telematics integration, and the distinction is
    // the sort a reviewer checks.
    expect(SETUP).not.toMatch(/connect real sensor/i);
    expect(SETUP).not.toMatch(/sensor data sources/i);
  });

  it("only promises training on production history once data can get in", () => {
    if (hasSensorIngestion()) return;
    expect(SETUP).not.toMatch(/production history/i);
  });
});
