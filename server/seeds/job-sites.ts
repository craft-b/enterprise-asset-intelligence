import { db } from "../db";
import { sql } from "drizzle-orm";
import { isDuplicateKey } from "./seed-errors";

/**
 * Seeds the job sites rentals are delivered to.
 *
 * The columns here are the ones `job_sites` actually has. An earlier version
 * inserted `project_type` and `status`, which do not exist, and omitted
 * `job_id`, which is NOT NULL and unique with no default -- so every insert
 * errored. A bare `catch {}` swallowed that, the function returned an empty
 * array, and the seed pipeline reported "0 job sites" as a completed step.
 * Rentals then had no site to reference and failed in turn, silently.
 */
export async function seedJobSites(): Promise<number[]> {
  const sites = [
    { jobId: "JS-001", name: "Riverside Industrial Park",  address: "1200 Riverside Dr, Newark, NJ 07102",     contactPerson: "Mike Torres",   contactPhone: "201-555-0142", distanceMiles: "12.4" },
    { jobId: "JS-002", name: "Downtown Tower Project",     address: "450 5th Ave, New York, NY 10018",         contactPerson: "Sandra Lee",    contactPhone: "212-555-0198", distanceMiles: "28.7" },
    { jobId: "JS-003", name: "Highway 9 Expansion",        address: "Rte 9 & County Rd 12, Freehold, NJ 07728",contactPerson: "Dave Kowalski", contactPhone: "732-555-0167", distanceMiles: "41.2" },
    { jobId: "JS-004", name: "Northside Warehouse Complex",address: "88 Commerce Blvd, Linden, NJ 07036",      contactPerson: "Rachel Nguyen", contactPhone: "908-555-0211", distanceMiles: "18.9" },
    { jobId: "JS-005", name: "Metro Rail Extension",       address: "Junction Rd & Main St, Secaucus, NJ 07094",contactPerson: "Tom Brannigan",contactPhone: "201-555-0309", distanceMiles: "9.6" },
    { jobId: "JS-006", name: "Lakeside Resort Development",address: "22 Lake Shore Rd, Hopatcong, NJ 07843",   contactPerson: "Amy Castello",  contactPhone: "973-555-0088", distanceMiles: "53.1" },
  ];

  const ids: number[] = [];
  for (const site of sites) {
    try {
      await db.execute(sql`
        INSERT INTO job_sites (job_id, name, address, contact_person, contact_phone, distance_miles)
        VALUES (${site.jobId}, ${site.name}, ${site.address}, ${site.contactPerson},
                ${site.contactPhone}, ${site.distanceMiles})
      `);
      const [row] = await db.execute(sql`SELECT LAST_INSERT_ID() as id`) as any;
      ids.push(Number(row[0].id));
    } catch (error) {
      // Only an existing row is benign -- re-seeding should be idempotent.
      // Anything else (a column that does not exist, an unreachable database)
      // must escape rather than silently produce an empty fleet.
      if (!isDuplicateKey(error)) throw error;
      const [existing] = await db.execute(
        sql`SELECT id FROM job_sites WHERE job_id = ${site.jobId}`
      ) as any;
      if (existing[0]) ids.push(Number(existing[0].id));
    }
  }

  if (ids.length === 0) {
    throw new Error("seedJobSites produced no rows — rentals cannot be seeded without sites");
  }
  return ids;
}
