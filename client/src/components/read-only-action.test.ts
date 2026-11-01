// client/src/components/read-only-action.test.ts
//
// Viewers used to get no trace of any action an administrator could take:
// every page-level control sat inside `{isAdmin && (...)}`. On the public
// demo every visitor is a viewer, so the application's workflows -- creating
// a rental, logging maintenance, running the pipeline -- were invisible, and
// the pages read as a set of reports.
//
// These assertions read the source as text, for the reason the drift card
// tests give: rendering needs jsdom, which this project does not install, and
// what is worth pinning is which controls a viewer is shown.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ADMIN_ONLY } from "./read-only-action";

const PAGES = join(__dirname, "..", "pages");
const read = (file: string) => readFileSync(join(PAGES, file), "utf-8");

/** Source minus comments, whitespace collapsed -- the code, not the prose about it. */
function code(src: string): string {
  const parts = src.split("{/*");
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const closed = parts[i].indexOf("*/}");
    out += closed === -1 ? parts[i] : parts[i].slice(closed + 3);
  }
  return out
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");
}

/** Each page's primary actions, by the label the viewer's locked control carries. */
const LOCKED: Array<[string, string[]]> = [
  ["equipment-list.tsx", ["Import Sensor Data", "New Equipment"]],
  ["rentals-list.tsx", ["New Rental"]],
  ["maintenance-log.tsx", ["Log Maintenance"]],
  ["job-sites-list.tsx", ["New Job Site"]],
  ["vendors-list.tsx", ["New Vendor"]],
  ["asset-detail.tsx", ["Log Maintenance"]],
  ["predictive-maintenance-dashboard.tsx", ["Run Multi-Horizon Forecast", "Schedule Maintenance"]],
  ["ml-dashboard.tsx", ["Reset Baseline", "Promote Challenger"]],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("viewers see the actions they cannot take", () => {
  for (const [page, labels] of LOCKED) {
    for (const label of labels) {
      it(`${page}: "${label}" is shown locked`, () => {
        const locked = new RegExp(`<ReadOnlyAction[^>]*> ?${escape(label)} ?</ReadOnlyAction>`);
        expect(code(read(page))).toMatch(locked);
      });
    }
  }

  it("shows the ML pipeline card to viewers with every control disabled", () => {
    const src = code(read("predictive-maintenance-dashboard.tsx"));
    const start = src.indexOf("ML Pipeline Controls");
    expect(start).toBeGreaterThan(-1);

    // Not gated: the card opens straight after the previous block.
    const before = src.slice(Math.max(0, start - 80), start);
    expect(before).not.toMatch(/isAdmin &&/);

    // Every Button in the card, and the day slider, is off for a viewer.
    // Split on the tag rather than matching up to the next ">": each button's
    // onClick is an arrow function, and its "=>" would end the match early.
    const card = src.slice(start, src.indexOf("</Card>", start));
    const buttons = card.split("<Button ").slice(1).map(b => b.slice(0, b.indexOf("</Button>")));
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) expect(b).toContain("disabled={!isAdmin ||");
    const slider = card.slice(card.indexOf('type="range"'));
    expect(slider.slice(0, slider.indexOf("/>"))).toContain("disabled={!isAdmin}");

    // And says why, in words, for touch screens where no tooltip opens.
    expect(card).toContain("{!isAdmin && ( <span");
    expect(card).toContain("{ADMIN_ONLY} to run these steps.");
  });
});

describe("the locked control", () => {
  const src = code(readFileSync(join(__dirname, "read-only-action.tsx"), "utf-8"));

  it("cannot be clicked", () => {
    expect(src).toMatch(/<Button [^>]*disabled>/);
    // onClick is stripped from the props type, so a page cannot wire one up.
    expect(src).toMatch(/Omit<ButtonProps, "disabled" \| "onClick" \| "asChild">/);
  });

  it("states the reason without hover", () => {
    // The lock is visible; the reason is read aloud; the title is the extra.
    expect(src).toContain("<Lock />");
    expect(src).toMatch(/className="sr-only">\(\{ADMIN_ONLY\.toLowerCase\(\)\}\)/);
    // Title on the wrapper: a disabled button takes no pointer events.
    expect(src).toMatch(/<span title=\{ADMIN_ONLY\}/);
  });

  it("uses the words the Setup page already uses", () => {
    expect(read("setup.tsx")).toContain(ADMIN_ONLY);
  });
});
