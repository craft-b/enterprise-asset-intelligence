// client/src/pages/setup-claims.test.ts
//
// The Start Fresh card described a capability the system does not have:
// "Connect real sensor data sources". Nothing accepts a sensor reading — the
// only writes to sensor_data_logs come from the simulator, and
// services/data-logger.ts is called by nothing.
//
// That matters more here than it would in most projects. This one argues that
// its metrics are reported honestly, with the simulated data, the oracle
// ceiling and the SHAP circularity all disclosed. A UI overstating what the
// product does is the one place that argument cannot survive.
//
// So this test ties the claim to the endpoint: if ingestion is ever built, it
// fails and asks for the copy back.

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

  it("does not claim sensor ingestion while no endpoint accepts one", () => {
    if (hasSensorIngestion()) {
      // Ingestion now exists — the card may advertise it again, and should.
      return;
    }

    expect(SETUP).not.toMatch(/connect real sensor/i);
    expect(SETUP).not.toMatch(/sensor data sources/i);
  });

  it("says where sensor data actually comes from", () => {
    if (hasSensorIngestion()) return;
    // Being plain about the simulator is the point, not an apology for it.
    expect(SETUP).toMatch(/simulator/i);
  });

  it("does not promise training on production history", () => {
    if (hasSensorIngestion()) return;
    // Features are computed from sensor readings, so without ingestion there is
    // no production history to train on.
    expect(SETUP).not.toMatch(/production history/i);
  });
});
