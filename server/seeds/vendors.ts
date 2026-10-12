import { db } from "../db";
import { sql } from "drizzle-orm";
import { isDuplicateKey } from "./seed-errors";

/**
 * Seeds the rental vendors equipment is sourced from.
 *
 * As with job sites, the previous version inserted columns `vendors` does not
 * have (`contact_name`, `contact_email`, `contact_phone`, `rating`) and omitted
 * `vendor_id`, which is NOT NULL and unique. Every insert errored into a bare
 * `catch {}`, so the step completed with nothing in it.
 */
export async function seedVendors(): Promise<number[]> {
  const vendors = [
    { vendorId: "V-001", name: "CatRent Equipment Solutions", salesPerson: "James Pruitt",   contact: "800-555-0101", address: "500 Equipment Way, Chicago, IL 60601" },
    { vendorId: "V-002", name: "United Rentals Corp",         salesPerson: "Maria Delgado",  contact: "800-555-0202", address: "1 United Dr, Stamford, CT 06902" },
    { vendorId: "V-003", name: "BlueLine Rental",             salesPerson: "Steve Holloway", contact: "877-555-0303", address: "200 BlueLine Blvd, Atlanta, GA 30301" },
    { vendorId: "V-004", name: "Sunbelt Rentals",             salesPerson: "Tanya Brooks",   contact: "800-555-0404", address: "10 Sunbelt Pkwy, Charlotte, NC 28201" },
  ];

  const ids: number[] = [];
  for (const v of vendors) {
    try {
      await db.execute(sql`
        INSERT INTO vendors (vendor_id, name, address, sales_person, contact)
        VALUES (${v.vendorId}, ${v.name}, ${v.address}, ${v.salesPerson}, ${v.contact})
      `);
      const [row] = await db.execute(sql`SELECT LAST_INSERT_ID() as id`) as any;
      ids.push(Number(row[0].id));
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const [existing] = await db.execute(
        sql`SELECT id FROM vendors WHERE vendor_id = ${v.vendorId}`
      ) as any;
      if (existing[0]) ids.push(Number(existing[0].id));
    }
  }

  if (ids.length === 0) {
    throw new Error("seedVendors produced no rows — rentals cannot be seeded without vendors");
  }
  return ids;
}
