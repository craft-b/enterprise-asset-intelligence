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

/**
 * The same thing with runs of whitespace collapsed.
 *
 * Card copy is wrapped to the source's column width, so whether a phrase
 * survives as a contiguous substring depends on where a line happens to
 * break. The first rewrite of these cards failed three assertions for that
 * reason alone, with the copy saying exactly what was being asserted. What
 * this file is checking is the sentence, so it reads the sentence rather than
 * the layout; the one exception is the monospace figure below, which has to
 * match character for character because it is quoting the detector.
 */
const CODE = stripComments(PAGE).replace(/\s+/g, " ");

describe("no drift card promises an action that cannot work", () => {
  it("drops the advice to run a batch prediction", () => {
    // Allowed in a comment explaining the change; never again in the copy.
    expect(CODE).not.toContain("run a batch prediction to populate");
  });

  it("only suggests an action where the action can now pay off", () => {
    // The original defect was advice that could not work: ten assets could
    // never reach the batch floor, so "run a batch prediction" sent the viewer
    // through a cold start to reach the same empty card. Sixty assets clear
    // the floor, so suggesting a refresh is honest -- but the card has to keep
    // saying what happens on a database that still holds the old fleet, or it
    // has merely swapped one wrong state description for another.
    expect(CODE).toContain("refreshing the risk queue");
    expect(CODE).toContain("ten-asset yard");
  });
});

describe("each empty state names its own reason", () => {
  it("prediction drift gives the batch floor and both outcomes", () => {
    expect(CODE).toContain("at least 20 scored assets");
    expect(CODE).toContain("the seeded fleet is sixty");
    // The arithmetic for the fleet that genuinely could not reach the floor.
    expect(CODE).toContain("batch too small (10 &lt; 20)");
  });

  it("bias drift gives the per-category minimum and says the fleet clears it", () => {
    expect(CODE).toContain("at least three units in a category");
    expect(CODE).toContain("carries at least four");
  });

  it("bias drift still distinguishes not-yet from cannot", () => {
    // The distinction that matters, and the one both earlier versions of this
    // card lost in different directions: a sixty-asset fleet is waiting for a
    // scoring run, while the ten-asset yard was waiting for a different fleet.
    expect(CODE).toContain("at any amount of scoring");
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
  it("the README says the fleet exercises drift, as the cards now do", () => {
    expect(README).toContain("the sixty-asset fleet can exercise it");
    expect(README).toContain("batch too small (10 < 20)");
    expect(README).toContain("Bias drift needs three units per category");
  });

  it("neither still claims a ten-asset fleet is what ships", () => {
    // The copy and the document drifted apart once before, in this exact
    // place: the cards described a limit the README had already stopped
    // claiming. Both directions are checked now.
    expect(README).not.toContain("a ten-asset fleet cannot exercise it");
    expect(CODE).not.toContain("this dataset cannot produce one");
  });
});
