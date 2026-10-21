// client/src/pages/drift-card-copy.test.ts
//
// The three drift cards were empty on the deployed demo, and two of them told
// the visitor to "run a batch prediction to populate".
//
// That advice could not pay off. All three drift checks run inside
// POST /predict/multi-horizon/batch and all three gate on MIN_BATCH_SIZE = 20,
// while scoreFleetMultiHorizon sends one snapshot per asset -- ten for the
// demo fleet. So every run returns "batch too small (10 < 20)" and nothing is
// written. Bias drift is further out of reach: it needs three units in a
// category, and ten units spread across nine categories put at most two in
// any of them.
//
// The README already said all of this, under "Drift monitoring is implemented;
// a ten-asset fleet cannot exercise it". The defect was that the interface
// contradicted the document: the prose was honest and the cards were not.
//
// These assertions read the page source as text. Rendering the components
// needs jsdom, which this project deliberately does not install, and what is
// worth pinning is the claim the copy makes rather than the DOM it makes it
// in.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PAGE = readFileSync(join(__dirname, "ml-dashboard.tsx"), "utf-8");
const README = readFileSync(
  join(__dirname, "..", "..", "..", "README.md"), "utf-8"
);

/**
 * The page with its comments stripped, so prose about the fix is not
 * evidence of the fix.
 *
 * JSX block comments matter here: the first version of this file only
 * filtered lines beginning with // or *, and the explanation sitting inside
 * {/* ... *}/ in the card still contained the exact phrase being asserted
 * against. The test failed on its own commentary.
 */
function stripComments(src: string): string {
  const parts = src.split("{/*");
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const closed = parts[i].indexOf("*/}");
    out += closed === -1 ? parts[i] : parts[i].slice(closed + 3);
  }
  return out
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

const CODE = stripComments(PAGE);

describe("no drift card promises an action that cannot work", () => {
  it("drops the advice to run a batch prediction", () => {
    // Allowed in a comment explaining the change; never again in the copy.
    expect(CODE).not.toContain("run a batch prediction to populate");
  });

  it("does not tell a viewer to press something either", () => {
    // The empty states explain; they do not hand out instructions that the
    // advertised read-only account could not follow even if they worked.
    expect(CODE).not.toContain("run a batch prediction");
  });
});

describe("each empty state names its own reason", () => {
  it("prediction drift gives the batch floor and the arithmetic", () => {
    expect(CODE).toContain("at least 20 scored assets");
    expect(CODE).toContain("batch too small (10 &lt; 20)");
    expect(CODE).toContain("gated on fleet");
  });

  it("bias drift gives the per-category minimum", () => {
    expect(CODE).toContain("at least three units in a category");
    expect(CODE).toContain("nine categories");
  });

  it("bias drift says no amount of scoring will help", () => {
    // The distinction that matters: not-yet versus cannot. Prediction drift is
    // waiting for a bigger fleet; bias drift is waiting for a different one.
    expect(CODE).toContain("cannot produce one");
  });

  it("feature drift still distinguishes its three states", () => {
    // This card was already correct. Guarding it so a future edit does not
    // flatten the three cases back into one message.
    expect(CODE).toContain("No reference distribution loaded");
    expect(CODE).toContain("Baseline established");
    expect(CODE).toContain("No PSI reading has been taken yet");
  });
});

describe("the interface and the document agree", () => {
  it("the README states the same limitation the cards now state", () => {
    expect(README).toContain("a ten-asset fleet cannot exercise it");
    expect(README).toContain("batch too small (10 < 20)");
    expect(README).toContain("Bias drift needs three units per category");
  });
});
