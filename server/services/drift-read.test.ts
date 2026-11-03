// server/services/drift-read.test.ts
//
// After a baseline reset the feature card kept an ALERT for
// mean_time_between_failures, measured against the previous reference. The new
// reference does not track that feature, so no later run wrote a row to
// replace it, and "latest row per feature" served the stale one forever.
//
// Read as source: these are SQL strings, and the database-backed tests skip
// without DATABASE_URL.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "drift-read.ts"), "utf8");

function body(fn: string): string {
  const start = src.indexOf(`export async function ${fn}`);
  const next = src.indexOf("export async function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("drift cards read only readings since the reference in force", () => {
  it("anchors on the newest drift_reference row", () => {
    expect(src).toMatch(/SINCE_REFERENCE = sql`checked_at >= COALESCE\(\(SELECT MAX\(computed_at\) FROM drift_reference\)/);
  });

  for (const fn of ["featureDrift", "predictionDrift", "biasDrift"]) {
    it(`${fn} filters by it`, () => {
      expect(body(fn)).toContain("${SINCE_REFERENCE}");
    });
  }
});
