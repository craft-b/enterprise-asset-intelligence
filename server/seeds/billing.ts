// server/seeds/billing.ts
//
// Invoices and equipment swaps.
//
// Both tables were in TABLES_TO_CLEAR and in the schema, both are read by the
// UI, and neither had a seeder -- so the revenue dashboard showed every
// completed rental as outstanding AR (the "no invoice" branch of
// /api/dashboard/revenue-summary), and the swap history on a rental was always
// empty. Two views whose empty state was the only state anyone ever saw.
//
// Deliberately partial: three of the most recently returned rentals are left
// uninvoiced. Invoicing all of them would zero out outstanding AR and the
// uninvoiced count, so the two metrics that exist to show unbilled work would
// read zero on a fully seeded system -- a demo of a billing feature with
// nothing to bill.

import { db } from "../db";
import { sql } from "drizzle-orm";
import { isDuplicateKey } from "./seed-errors";

/** Completed rentals are left unbilled, newest first — recently returned, not yet invoiced. */
const UNINVOICED_TAIL = 3;

/** Billing lag in days, cycled so invoice dates are not all identical. */
const INVOICE_LAG_DAYS = [4, 6, 9, 5, 7];

function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return toDateString(new Date(d.getTime() + days * 24 * 3600 * 1000));
}

interface CompletedRental {
  id: number;
  equipmentId: number;
  receiveDate: string;
  returnDate: string;
  category: string;
}

async function completedRentals(): Promise<CompletedRental[]> {
  const [rows] = (await db.execute(sql`
    SELECT r.id, r.equipment_id, r.receive_date, r.return_date, e.category
    FROM rentals r
    JOIN equipment e ON e.id = r.equipment_id
    WHERE r.status = 'COMPLETED'
      AND r.receive_date IS NOT NULL
      AND r.return_date IS NOT NULL
      AND r.return_date >= r.receive_date
    ORDER BY r.return_date ASC, r.id ASC
  `)) as any;
  return (rows as any[]).map(r => ({
    id:          Number(r.id),
    equipmentId: Number(r.equipment_id),
    // mysql2 hands back a Date for a DATE column; the day is all that matters
    // and formatting it here keeps the local-zone shift out of the value.
    receiveDate: typeof r.receive_date === "string" ? r.receive_date : toDateString(r.receive_date),
    returnDate:  typeof r.return_date  === "string" ? r.return_date  : toDateString(r.return_date),
    category:    String(r.category),
  }));
}

export async function seedInvoices(cursorDate: Date): Promise<number> {
  const rentals = await completedRentals();
  const billable = rentals.slice(0, Math.max(0, rentals.length - UNINVOICED_TAIL));
  const cursorStr = toDateString(cursorDate);
  let written = 0;

  for (let i = 0; i < billable.length; i++) {
    const rental = billable[i];
    const lag = INVOICE_LAG_DAYS[i % INVOICE_LAG_DAYS.length];
    // An invoice dated after the simulation cursor has not happened yet, and
    // revenue-summary filters on invoice_date <= cursor, so it would be
    // invisible revenue on a row that no longer counts as outstanding.
    const rawDate = addDays(rental.returnDate, lag);
    const invoiceDate = rawDate > cursorStr ? cursorStr : rawDate;
    const invoiceNumber = `INV-${rental.id}-${invoiceDate.replace(/-/g, "").slice(0, 6)}`;

    try {
      // The amount is computed in SQL with the same expression
      // /api/dashboard/revenue-summary uses for an uninvoiced rental:
      //   (DATEDIFF(return, receive) + 1) * daily_rate
      // Recomputing it in TypeScript would let invoiced and uninvoiced revenue
      // drift apart, so the chart would step up or down purely because a
      // rental got billed.
      await db.execute(sql`
        INSERT INTO invoices
          (rental_id, invoice_number, invoice_date, period_from, period_to, amount)
        SELECT
          r.id, ${invoiceNumber}, ${invoiceDate}, r.receive_date, r.return_date,
          (DATEDIFF(r.return_date, r.receive_date) + 1) * CAST(e.daily_rate AS DECIMAL(10,2))
        FROM rentals r
        JOIN equipment e ON e.id = r.equipment_id
        WHERE r.id = ${rental.id}
      `);
      written++;
    } catch (error) {
      // A duplicate invoice number on a re-run is fine. Anything else -- a
      // missing rental, a foreign-key violation -- means the rentals seed did
      // not do what it reported, and silence there is what let the empty
      // tables go unnoticed in the first place.
      if (!isDuplicateKey(error)) throw error;
    }
  }

  return written;
}

/**
 * Equipment swaps: a unit replaced partway through a rental.
 *
 * Seeded against the longest completed rentals, because a swap needs room
 * either side of it to make sense. The replacement is a different unit of the
 * same category where the fleet has one, so the substitution is plausible
 * rather than a grader standing in for a generator.
 */
export async function seedEquipmentSwaps(): Promise<number> {
  const rentals = await completedRentals();
  if (rentals.length === 0) return 0;

  const [equipRows] = (await db.execute(sql`
    SELECT id, equipment_id AS code, category FROM equipment ORDER BY id
  `)) as any;
  const fleet = (equipRows as any[]).map(e => ({
    id: Number(e.id), code: String(e.code), category: String(e.category),
  }));

  const durationDays = (r: CompletedRental) =>
    (new Date(`${r.returnDate}T00:00:00Z`).getTime() -
     new Date(`${r.receiveDate}T00:00:00Z`).getTime()) / (24 * 3600 * 1000);

  const candidates = [...rentals]
    .filter(r => durationDays(r) >= 20)
    .sort((a, b) => durationDays(b) - durationDays(a))
    .slice(0, 2);

  const REASONS = [
    {
      reason: "Hydraulic pump failure on site — unit returned to yard for repair",
      notes:  "Operator reported pressure loss and visible weep at the pump housing. "
            + "Replacement dispatched same day; no billable downtime passed to the customer.",
      by:     "Dale Whitfield",
    },
    {
      reason: "Engine overheating under sustained load — swapped to keep the site running",
      notes:  "Coolant temperature climbed past the alarm threshold twice in one shift. "
            + "Unit pulled for diagnosis rather than risk a failure mid-pour.",
      by:     "Priya Raman",
    },
  ];

  let written = 0;

  for (let i = 0; i < candidates.length; i++) {
    const rental = candidates[i];
    const sameCategory = fleet.filter(
      e => e.category === rental.category && e.id !== rental.equipmentId
    );
    const otherUnits = fleet.filter(e => e.id !== rental.equipmentId);
    const replacement = (sameCategory[0] ?? otherUnits[0]);
    if (!replacement) continue;

    // Partway through, not on either boundary: a swap on the receive date is a
    // different rental, and one on the return date is a return.
    const swapDate = addDays(rental.receiveDate, Math.floor(durationDays(rental) / 2));
    const { reason, notes, by } = REASONS[i % REASONS.length];

    try {
      await db.execute(sql`
        INSERT INTO equipment_swaps
          (rental_id, original_equipment_id, replacement_equipment_id,
           swap_date, reason, swapped_by, notes)
        VALUES
          (${rental.id}, ${rental.equipmentId}, ${replacement.id},
           ${swapDate}, ${reason}, ${by}, ${notes})
      `);
      written++;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  return written;
}
