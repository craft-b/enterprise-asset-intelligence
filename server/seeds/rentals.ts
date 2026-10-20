import { db } from "../db";
import { sql } from "drizzle-orm";
import { isDuplicateKey } from "./seed-errors";

// Generates a date string N days before the reference date
function daysAgo(ref: Date, days: number): string {
  const d = new Date(ref.getTime() - days * 24 * 3600 * 1000);
  return d.toISOString().split("T")[0];
}

export async function seedRentals(
  equipmentIds: number[],
  jobSiteIds: number[],
  vendorIds: number[],
  cursorDate: Date,
): Promise<void> {
  // [equipIdx, jobSiteIdx, vendorIdx, startDaysAgo, durationDays, operator, status]
  type RentalSpec = [number, number, number, number, number, string, "COMPLETED" | "ACTIVE"];

  const specs: RentalSpec[] = [
    [0, 0, 0, 180, 45,  "Ray Fuentes",    "COMPLETED"],  // Crane → Riverside
    [1, 2, 1, 165, 60,  "Maria Castillo", "COMPLETED"],  // Grader → Highway 9
    [2, 1, 0, 150, 30,  "Steve Park",     "COMPLETED"],  // Lift → Downtown Tower
    [3, 0, 2, 140, 55,  "Derek Walsh",    "COMPLETED"],  // Excavator → Riverside
    [4, 4, 1, 120, 40,  "Jen Alvarez",    "COMPLETED"],  // Crane2 → Metro Rail
    [5, 2, 3, 110, 50,  "Tom Reid",       "COMPLETED"],  // Hauler → Highway 9
    [6, 3, 0, 100, 35,  "Chris Monroe",   "COMPLETED"],  // Compressor → Northside
    [7, 5, 2, 90,  25,  "Lisa Tran",      "COMPLETED"],  // Loader → Lakeside
    [8, 4, 1, 80,  30,  "Mike Okafor",    "COMPLETED"],  // Compactor → Metro Rail
    [9, 1, 3, 75,  20,  "Dana Patel",     "COMPLETED"],  // Generator → Downtown Tower
    [0, 3, 0, 60,  45,  "Ray Fuentes",    "COMPLETED"],  // Crane → Northside
    [3, 2, 1, 55,  40,  "Derek Walsh",    "COMPLETED"],  // Excavator → Highway 9
    [1, 5, 2, 45,  30,  "Maria Castillo", "COMPLETED"],  // Grader → Lakeside
    [5, 0, 3, 30,  25,  "Tom Reid",       "ACTIVE"],     // Hauler → Riverside (active)
    [2, 4, 0, 20,  60,  "Steve Park",     "ACTIVE"],     // Lift → Metro Rail (active)
  ];

  let poCounter = 1001;

  for (const [eqIdx, siteIdx, vendIdx, startAgo, duration, operator, status] of specs) {
    const equipId  = equipmentIds[eqIdx % equipmentIds.length];
    const siteId   = jobSiteIds[siteIdx % jobSiteIds.length];
    const vendId   = vendorIds[vendIdx % vendorIds.length];

    const receiveDate = daysAgo(cursorDate, startAgo);
    const returnDate  = status === "COMPLETED" ? daysAgo(cursorDate, startAgo - duration) : null;
    const poNumber    = `PO-${poCounter++}`;
    const receiveHours = (Math.random() * 500 + 100).toFixed(1);
    const returnHours  = returnDate ? (parseFloat(receiveHours) + duration * (Math.random() * 8 + 4)).toFixed(1) : null;

    try {
      await db.execute(sql`
        INSERT INTO rentals
          (equipment_id, job_site_id, vendor_id, po_number,
           receive_date, receive_hours, return_date, return_hours,
           buy_rent, status, operator_name, delivery_method)
        VALUES
          (${equipId}, ${siteId}, ${vendId}, ${poNumber},
           ${receiveDate}, ${receiveHours}, ${returnDate}, ${returnHours},
           'RENT', ${status}, ${operator}, 'COMPANY_DELIVERY')
      `);
    } catch (error) {
      // A duplicate PO on a re-run is fine. A foreign-key violation is not:
      // it means sites or vendors are missing, which is how this seeder
      // silently produced zero rentals while reporting success.
      if (!isDuplicateKey(error)) throw error;
    }

    // An ACTIVE rental means the unit is out. Writing the rental row without
    // this left two machines on hire while the fleet still listed them
    // AVAILABLE -- and the new-rental form offers exactly the AVAILABLE ones,
    // so both could be hired out a second time from the UI. POST /api/rentals
    // has always done this; the seeder writes straight to the table and so
    // skipped it.
    if (status === "ACTIVE") {
      await db.execute(sql`
        UPDATE equipment SET status = 'RENTED' WHERE id = ${equipId}
      `);
    }
  }
}
