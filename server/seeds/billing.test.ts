// server/seeds/billing.test.ts
//
// What matters about this seeder is not that it writes rows -- it is that the
// rows it writes agree with the arithmetic the dashboard does.
//
// /api/dashboard/revenue-summary recognises revenue two ways: an invoiced
// rental contributes its invoice amount, and a completed rental with no
// invoice contributes (DATEDIFF(return, receive) + 1) * daily_rate as
// outstanding AR. If the seeder computed amounts its own way, invoicing a
// rental would move revenue up or down for no reason an operator could
// explain. So the amount is computed by the same SQL expression, and that is
// asserted here by reading the source rather than by trusting the comment.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(__dirname, "billing.ts"), "utf-8");
const ROUTES = readFileSync(join(__dirname, "..", "routes.ts"), "utf-8");
const ORCH = readFileSync(join(__dirname, "..", "services", "seed-orchestrator.ts"), "utf-8");

/** The revenue expression, whitespace-insensitive. */
const AMOUNT_EXPR = /DATEDIFF\(\s*r\.return_date\s*,\s*r\.receive_date\s*\)\s*\+\s*1\s*\)\s*\*\s*CAST\(\s*e\.daily_rate/;

describe("invoice amounts match what the dashboard computes", () => {
  it("uses the same expression the revenue endpoint uses", () => {
    expect(SRC).toMatch(AMOUNT_EXPR);
    expect(ROUTES, "revenue-summary no longer computes it this way — the seeder has drifted")
      .toMatch(AMOUNT_EXPR);
  });

  it("computes the amount in SQL, not in TypeScript", () => {
    // A JS reimplementation would have to redo DATEDIFF and decimal rounding,
    // and would be free to disagree.
    const insert = SRC.match(/INSERT INTO invoices[\s\S]*?`\s*\)/)?.[0] ?? "";
    expect(insert).toMatch(/SELECT/);
    expect(insert).toMatch(AMOUNT_EXPR);
  });
});

describe("the billing views have something to show in every state", () => {
  it("leaves some completed rentals unbilled", () => {
    // Outstanding AR and the uninvoiced count both read zero if everything is
    // invoiced, which is a billing dashboard with nothing to bill.
    expect(SRC).toMatch(/UNINVOICED_TAIL\s*=\s*[1-9]/);
    expect(SRC).toMatch(/rentals\.length\s*-\s*UNINVOICED_TAIL/);
  });

  it("never dates an invoice past the simulation cursor", () => {
    // revenue-summary filters invoice_date <= cursor. An invoice beyond it
    // counts as neither recognised revenue nor outstanding -- the rental
    // simply vanishes from both figures.
    expect(SRC).toMatch(/rawDate > cursorStr \? cursorStr : rawDate/);
  });
});

describe("a swap describes something that could have happened", () => {
  it("places the swap inside the rental, not on its edges", () => {
    expect(SRC).toMatch(/durationDays\(rental\) \/ 2/);
  });

  it("requires a replacement from the same category, with no fallback", () => {
    // This assertion used to read "prefers the same category" and matched the
    // preference in the source. It passed while the rows written on the real
    // fleet were a Grader replaced by a Tower Crane and an Excavator replaced
    // by that same crane -- because ten units span nine categories, only Crane
    // has a second unit, and so the "any other unit" fallback fired every
    // single time. The code path existed; the outcome was nonsense.
    expect(SRC).toMatch(/e\.category === rental\.category/);
    // No fallback to an arbitrary unit. If this reappears, a one-per-category
    // fleet silently produces implausible swaps again.
    expect(SRC).not.toMatch(/otherUnits/);
    expect(SRC).not.toMatch(/sameCategory\[0\]\s*\?\?/);
  });

  it("drops a rental that has no like-for-like replacement", () => {
    // Fewer swaps is the right answer on a fleet that cannot supply one.
    expect(SRC).toMatch(/\.filter\(r => replacementFor\(r\) !== undefined\)/);
  });

  it("never swaps a unit for itself", () => {
    expect(SRC).toMatch(/e\.id !== rental\.equipmentId/);
  });
});

describe("re-running the seed does not fail", () => {
  it("tolerates a duplicate but not a foreign-key violation", () => {
    // The distinction the rentals seeder learned the hard way: swallowing
    // every error let it report success having written nothing.
    const catches = SRC.match(/if \(!isDuplicateKey\(error\)\) throw error;/g) ?? [];
    expect(catches.length).toBe(2);
  });
});

describe("the orchestrator runs them after the rentals exist", () => {
  it("seeds invoices and swaps inside the rentals step", () => {
    const step = ORCH.match(/setStep\(3, "running"\)[\s\S]*?setStep\(3, "completed"[\s\S]*?\);/)?.[0] ?? "";
    expect(step).toMatch(/seedRentals/);
    expect(step).toMatch(/seedInvoices/);
    expect(step).toMatch(/seedEquipmentSwaps/);
    // Order matters: both read the rentals back.
    expect(step.indexOf("seedRentals")).toBeLessThan(step.indexOf("seedInvoices"));
  });

  it("keeps the step list at ten, which is what the client renders", () => {
    const names = ORCH.match(/const STEP_NAMES = \[[\s\S]*?\];/)?.[0] ?? "";
    expect(names).not.toBe("");
    expect((names.match(/^\s+"/gm) ?? []).length).toBe(10);
  });

  it("reports the counts, so a zero is visible in the run record", () => {
    expect(ORCH).toMatch(/\$\{invoiceCount\} invoices/);
    expect(ORCH).toMatch(/\$\{swapCount\} equipment swaps/);
  });
});
