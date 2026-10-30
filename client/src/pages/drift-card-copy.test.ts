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
    // Guarding the branch so a future edit does not flatten the three cases
    // back into one message.
    expect(CODE).toContain("No reference distribution loaded");
    expect(CODE).toContain("Baseline established");
    expect(CODE).toContain("No PSI reading has been taken yet");
  });

  it("feature drift does not still describe the fleet as too small", () => {
    // This card was called "already correct" and left untouched while the
    // other two were rewritten, because it states its floor dynamically from
    // min_batch_size and reads as generic. The sentence after the floor was
    // not generic -- "a fleet smaller than that cannot reach it in one run"
    // is the same ten-asset claim, and it survived a grep for "ten assets"
    // and "nine categories" by not containing either. It was caught in a
    // screenshot rather than by a test.
    expect(CODE).not.toContain("cannot reach it in one run");
    expect(CODE).toContain("The seeded fleet is sixty, so a scoring run clears that floor");
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

describe("a populated card explains why it is alerting", () => {
  // A reviewer meeting three red cards reads "broken model" before they read
  // "working monitor", and on this fleet the second one is the true reading:
  // the seed is deliberately weighted toward aged, high-duty units, so the
  // distributions genuinely differ from the training sample. That context
  // lived only in the author's head, which made the project's strongest
  // ML-maturity signal look like its biggest defect.

  it("puts a note on all three cards", () => {
    expect(CODE.match(/<DriftContextNote>/g) ?? []).toHaveLength(3);
  });

  it("shows each note only when something is actually alerting", () => {
    // The point of the guard. Explaining an alert that is not on screen is an
    // excuse offered before anyone asked for one, and it reads worse than the
    // alert it was meant to explain -- so every note must sit behind a test
    // for a non-stable status.
    const uses = [...CODE.matchAll(/<DriftContextNote>/g)];
    expect(uses).toHaveLength(3);
    for (const use of uses) {
      const preceding = CODE.slice(Math.max(0, use.index! - 220), use.index!);
      expect(
        preceding,
        "a drift note is rendered unconditionally; it must be guarded by an alerting status"
      ).toMatch(/\.some\(/);
    }
  });

  it("names the cause rather than asserting the model is fine", () => {
    // The note has to earn its place by explaining a mechanism. "Older,
    // harder-worked machines than the training sample" is a claim a reader
    // can check against the seed; "the model is fine" is not.
    expect(CODE).toContain("older, harder-worked machines");
    expect(CODE).toContain("the detector reporting that correctly");
  });

  it("says what the same reading would mean in production", () => {
    // Without this the note is special pleading. With it, it is the thing
    // worth demonstrating: the monitor is wired to a decision.
    expect(CODE).toContain("the trigger to retrain against current data");
  });

  it("does not tell the viewer to disregard the alert", () => {
    // The failure mode of this kind of copy. Explaining a reading is the
    // opposite of dismissing it, and a monitor whose own interface waves its
    // findings away is worth less than no monitor.
    for (const phrase of [
      "false positive", "safe to ignore", "can be ignored",
      "nothing to worry about", "not a real", "disregard",
    ]) {
      expect(CODE.toLowerCase()).not.toContain(phrase);
    }
  });

  it("keeps the small-sample caveat on bias, where the categories are small", () => {
    // Bias drift divides sixty assets across nine categories, so a single
    // aged machine moves a percentage a long way. That is a different
    // argument from the fleet-level one and the card should make it, not
    // repeat the other two.
    expect(CODE).toContain("a single aged machine moves the percentage");
    expect(CODE).toContain("not yet a verdict on it");
  });
});

// ── Unreachable is not the same as nothing to report ─────────────────────────
//
// With the ML service unreachable, `error` is set and `drift` is undefined, so
// the optional chain fell through to the "no baseline" arm and the card said
// "No reference distribution loaded — click Reset Baseline". False twice: a
// reference does exist (the service logs loading it at startup) and the button
// routes through the same unreachable service.
//
// Naming a cause with no evidence for it, and offering a remedy that cannot
// run, is the defect this file was written to prevent — it just had two
// branches where it needed three.
describe("the drift card distinguishes unreachable from empty", () => {
  it("handles the error case before inspecting the payload", () => {
    // Order matters: `drift?.reference?.loaded` is falsy when drift is
    // undefined, so an error arm placed after it never runs.
    const branch = CODE.slice(CODE.indexOf("{error ? ("), CODE.indexOf("drift?.reference?.loaded ? ("));
    expect(branch, "the error arm must come first").toMatch(/ML service is not reachable/);
  });

  it("does not blame a missing baseline when it cannot see one", () => {
    const errorArm = CODE.slice(CODE.indexOf("{error ? ("), CODE.indexOf(") : drift?.reference?.loaded"));
    expect(errorArm).not.toMatch(/No reference distribution loaded/);
    expect(errorArm).not.toMatch(/Reset Baseline/);
  });

  it("says the drift state itself is unknown, not that it is fine", () => {
    const errorArm = CODE.slice(CODE.indexOf("{error ? ("), CODE.indexOf(") : drift?.reference?.loaded"));
    expect(errorArm).toMatch(/says nothing about the drift state/i);
  });

  it("disables the remedy it cannot perform", () => {
    expect(CODE).toMatch(/disabled=\{computeRef\.isPending \|\| Boolean\(error\)\}/);
  });
});
