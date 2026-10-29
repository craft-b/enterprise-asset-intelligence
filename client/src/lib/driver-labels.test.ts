// Guards the one property that makes a SHAP bar readable: a driver label names
// the quantity measured, never a direction.
//
// The panel renders a signed share — red "+" toward failure, green "−"
// protective — against the feature's name. If the name itself asserts a
// direction, a correct protective attribution renders as a contradiction:
// "Short time between failures — 22% protective" says frequent failures keep an
// asset healthy. That shipped, on the centerpiece panel, with the model behind
// it working correctly the whole time.
//
// Derived, not listed: the ban is a vocabulary applied to every entry, so a
// label added later is covered without touching this file.
import { describe, it, expect } from "vitest";
import { DRIVER_LABELS, humanizeDriver } from "./risk-format";

// Comparatives and superlatives that presume which way the feature points.
const DIRECTIONAL = [
  "high", "low", "short", "long", "rising", "climbing", "falling",
  "heavy", "light", "frequent", "rare", "intense", "costly", "cheap",
  "worsening", "improving", "poor", "good", "excessive", "sustained",
  "over-utilized", "under-utilized", "aging", "lower", "higher",
  "trending up", "trending down", "detected", "signs of", "fast", "slow",
];

describe("DRIVER_LABELS name quantities, not directions", () => {
  for (const [key, label] of Object.entries(DRIVER_LABELS)) {
    it(`${key} is directionally neutral`, () => {
      const lower = label.toLowerCase();
      for (const word of DIRECTIONAL) {
        const hit = new RegExp(`\b${word}\b`).test(lower);
        expect(
          hit,
          `"${label}" contains "${word}". The sign and colour carry direction; ` +
            `naming one here contradicts the bar whenever SHAP disagrees.`,
        ).toBe(false);
      }
    });
  }

  it("covers the features the panel actually renders", () => {
    // A spot set spanning each family, so a wholesale deletion fails loudly.
    for (const key of [
      "mean_time_between_failures", "vendor_reliability_score",
      "maintenance_cost_180d", "wear_rate", "asset_age_years",
      "total_hours_lifetime", "mechanical_wear_score",
    ]) {
      expect(DRIVER_LABELS, `${key} lost its label`).toHaveProperty(key);
    }
  });

  it("distinguishes a rate from its acceleration", () => {
    // These were one derivative apart and labelled as near-synonyms, so the
    // panel showed "Wear rate accelerating" beside "Wear accelerating faster".
    expect(DRIVER_LABELS.wear_rate).toBe("Wear rate");
    expect(DRIVER_LABELS.wear_rate_velocity).toBe("Wear rate acceleration");
    expect(DRIVER_LABELS.wear_rate).not.toBe(DRIVER_LABELS.wear_rate_velocity);
  });

  it("no two features share a label", () => {
    const seen = new Map<string, string>();
    for (const [key, label] of Object.entries(DRIVER_LABELS)) {
      const prior = seen.get(label);
      expect(prior, `${key} and ${prior} both render as "${label}"`).toBeUndefined();
      seen.set(label, key);
    }
  });
});

describe("humanizeDriver reaches the dictionary", () => {
  it("strips the pipeline's log_ transform prefix", () => {
    // SHAP keys arrive transformed; the transform is irrelevant to a mechanic.
    expect(humanizeDriver("log_maintenance_cost_180d")).toBe("Maintenance cost (180d)");
  });

  it("maps a raw feature key, not just a prefixed one", () => {
    expect(humanizeDriver("mean_time_between_failures")).toBe("Time between failures");
  });

  it("passes finished prose through untouched", () => {
    // top_risk_drivers emits phrases; only shap_attribution hits the dictionary.
    const prose = "Asset age: 13.4 years";
    expect(humanizeDriver(prose)).toBe(prose);
  });
});
