// server/tidb-compat.test.ts
//
// The whole rentals feature was broken in production and nothing said so.
//
// storage.listRentals, getRental and listSwapsByRental used Drizzle's
// relational query API -- db.query.<table>.findMany({ with: { ... } }) -- which
// compiles `with` into LEFT JOIN LATERAL. TiDB does not implement LATERAL, so
// every call raised ER_PARSE_ERROR. GET /api/rentals had no try/catch, so it
// answered 500, and the rentals list, rental detail, update, delete and swap
// history were all dead on the deployed database.
//
// It works perfectly against MySQL, which is what makes it worth a test: the
// code is correct, the dialect is not, and nothing in a local run or a type
// check will tell you. This is the second TiDB divergence found in this
// project -- subqueries in a JOIN ... ON clause were the first.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SERVER_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Source with comments stripped: the ones here name the banned construct. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const files = sourceFiles(SERVER_DIR);

describe("queries stay within what TiDB implements", () => {
  it("is reading the server source", () => {
    // Guards the sweep: no files would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some(f => f.endsWith("storage.ts"))).toBe(true);
  });

  it.each(files.map(f => [f.slice(SERVER_DIR.length + 1), f] as const))(
    "%s", (_name, path) => {
      const source = code(readFileSync(path, "utf-8"));

      // db.query.<table>.findMany/findFirst is only a problem when it carries
      // `with`, which is what produces the lateral join. Without it the API
      // emits an ordinary SELECT and is fine.
      const relational = Array.from(
        source.matchAll(/db\.query\.\w+\.(findMany|findFirst)\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g)
      ).filter(m => /\bwith\s*:/.test(m[2]));

      expect(
        relational.map(m => m[0].slice(0, 60)),
        "db.query with `with:` compiles to LEFT JOIN LATERAL, which TiDB " +
        "rejects with ER_PARSE_ERROR. Use explicit .leftJoin() instead — see " +
        "storage.listRentals."
      ).toEqual([]);
    }
  );

  it("recognises the construct it is banning", () => {
    // Guards the regex: it has to match the code that actually broke.
    const original = `
      const results = await db.query.rentals.findMany({
        with: {
          equipment: true,
          jobSite: true,
        },
        orderBy: (rentals, { desc }) => [desc(rentals.receiveDate)],
      });
    `;
    const found = Array.from(
      original.matchAll(/db\.query\.\w+\.(findMany|findFirst)\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g)
    ).filter(m => /\bwith\s*:/.test(m[2]));
    expect(found).toHaveLength(1);
  });

  it("does not flag a relational query without `with`", () => {
    // These are fine; a test that banned them outright would push people into
    // writing worse code for no reason.
    const plain = `await db.query.rentals.findMany({\n  where: eq(rentals.id, 1),\n})`;
    const found = Array.from(
      plain.matchAll(/db\.query\.\w+\.(findMany|findFirst)\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g)
    ).filter(m => /\bwith\s*:/.test(m[2]));
    expect(found).toEqual([]);
  });
});

describe("the rentals queries were actually rewritten", () => {
  const STORAGE = code(readFileSync(join(SERVER_DIR, "storage.ts"), "utf-8"));

  it("joins explicitly", () => {
    expect(STORAGE).toMatch(/\.leftJoin\(/);
  });

  it("does not multiply rentals by their invoices", () => {
    // Joining invoices in would return one row per invoice per rental, so they
    // are fetched separately and grouped.
    const fn = STORAGE.match(/async listRentals[\s\S]*?\n  \}/)![0];
    expect(fn).toMatch(/inArray\(invoices\.rentalId/);
    expect(fn).not.toMatch(/leftJoin\(invoices/);
  });

  it("aliases equipment twice for a swap", () => {
    // A swap references the unit that left and the one that replaced it; the
    // same table joined twice needs distinct aliases or the SQL is ambiguous.
    const fn = STORAGE.match(/async listSwapsByRental[\s\S]*?\n  \}/)![0];
    expect(fn).toMatch(/alias\(equipment, "original_equipment"\)/);
    expect(fn).toMatch(/alias\(equipment, "replacement_equipment"\)/);
  });
});
