// server/services/sensor-columns.test.ts
//
// Feature engineering queried sensor_data_logs for engine_temperature,
// vibration_level, error_code and warning_flag. None of those columns have
// existed since the schema moved to Drizzle under ARCH-1 -- the table has
// engine_temp, vibration_x/y/z, error_codes and warning_count. Every call
// raised ER_BAD_FIELD_ERROR, and a bare catch turned that into `return 0` and
// `return {}`.
//
// So sensor_degradation_rate was 0 for every asset in every snapshot ever
// taken (50 of 50 on the deployed instance), every sensor statistic was
// undefined, and 900 seeded readings per demo were written to a table nothing
// could read. Nothing logged, nothing failed, and the feature is in the
// model's trained feature list.
//
// The names drifted because the old schema survived in two unreferenced files
// carrying their own CREATE TABLE. Both are gone now, but the real protection
// is checking the queries against the schema rather than against memory, which
// is what this does -- no database required, so it runs everywhere.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SERVER_DIR = join(__dirname, "..");
const SCHEMA = readFileSync(join(SERVER_DIR, "..", "shared", "schema.ts"), "utf-8");

/** Every table name Drizzle declares, so a join partner is not read as a column. */
function schemaTables(): Set<string> {
  return new Set(
    Array.from(SCHEMA.matchAll(/mysqlTable\(\s*"([a-z0-9_]+)"/g)).map(m => m[1])
  );
}

/** Column names Drizzle declares for sensor_data_logs. */
function schemaColumns(): Set<string> {
  const table = SCHEMA.match(
    /export const sensorDataLogs = mysqlTable\("sensor_data_logs",\s*\{([\s\S]*?)\n\}\)/
  );
  if (!table) throw new Error("sensorDataLogs table not found in shared/schema.ts");
  // Each column is declared as someType("column_name", ...).
  return new Set(
    Array.from(table[1].matchAll(/\w+\(\s*"([a-z0-9_]+)"/g)).map(m => m[1])
  );
}

/** SQL words that are not column references. */
const NOT_COLUMNS = new Set([
  "select", "from", "where", "and", "or", "as", "between", "is", "not", "null",
  "case", "when", "then", "else", "end", "count", "sum", "avg", "min", "max",
  "sqrt", "pow", "insert", "into", "values", "ignore", "on", "duplicate", "key",
  "update", "set", "group", "by", "order", "desc", "asc", "limit", "distinct",
  "in", "join", "left", "inner", "truncate", "table", "date", "datediff",
  "coalesce", "if", "cast", "signed", "interval", "day", "now", "sensor_data_logs",
  "date_sub", "date_add", "date_format", "timestampdiff", "unix_timestamp",
  "ifnull", "nullif", "greatest", "least", "round", "abs", "floor", "ceil",
  "reading_count", "avg_vibration", "max_vibration", "avg_engine_temp",
  "avg_oil_pressure", "avg_hydraulic_pressure", "error_code_count",
  "hours", "readings", "total", "cnt", "n", "lo", "hi",
]);

/** Every .ts file under server/, excluding tests. */
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

/**
 * Identifiers a sensor_data_logs query appears to reference.
 *
 * Deliberately crude: it over-collects and leans on NOT_COLUMNS, because the
 * failure being prevented is a name that looks exactly like a column and is
 * not one.
 */
function referencedIdentifiers(sqlText: string): string[] {
  const cleaned = sqlText
    .toLowerCase()
    // `SUM(operating_hours) as total_hours` names a result, not a column.
    .replace(/\bas\s+[a-z0-9_]+/g, " ")
    // ${...} is a bound parameter; its contents are JavaScript, not SQL.
    .replace(/\$\{[^}]*\}/g, " ");

  return Array.from(new Set(
    (cleaned.match(/\b[a-z][a-z0-9_]{2,}\b/g) ?? [])
      .filter(w => !NOT_COLUMNS.has(w))
      // Template interpolations and JS identifiers are not SQL.
      .filter(w => w.includes("_") || /^(timestamp|id)$/.test(w))
  ));
}

/** Raw SQL blocks mentioning the sensor table. */
function sensorQueries(source: string): string[] {
  const blocks: string[] = [];
  for (const m of source.matchAll(/sql`([\s\S]*?)`/g)) {
    if (/sensor_data_logs/i.test(m[1])) blocks.push(m[1]);
  }
  return blocks;
}

const columns = schemaColumns();
const tables = schemaTables();

describe("sensor_data_logs queries match the schema", () => {
  it("read the table list", () => {
    expect(tables.size).toBeGreaterThan(5);
    expect(tables.has("sensor_data_logs")).toBe(true);
  });

  it("read the schema", () => {
    // Guards everything below: an empty set would pass every check.
    expect(columns.size).toBeGreaterThan(15);
    expect(columns.has("engine_temp")).toBe(true);
    expect(columns.has("vibration_x")).toBe(true);
  });

  it("knows the names that were wrong", () => {
    // The four that broke it, confirmed absent rather than assumed.
    for (const gone of ["engine_temperature", "vibration_level", "error_code", "warning_flag"]) {
      expect(columns.has(gone), `${gone} should not be in the schema`).toBe(false);
    }
  });

  const files = sourceFiles(SERVER_DIR).filter(f => sensorQueries(readFileSync(f, "utf-8")).length > 0);

  it("found files to check", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.endsWith("feature-engineering-enhanced.ts"))).toBe(true);
  });

  it.each(files.map(f => [f.slice(SERVER_DIR.length + 1), f] as const))(
    "%s", (_name, path) => {
      const source = readFileSync(path, "utf-8");
      const unknown: string[] = [];

      for (const query of sensorQueries(source)) {
        for (const ident of referencedIdentifiers(query)) {
          if (tables.has(ident)) continue;           // a joined table, not a column
          if (!columns.has(ident)) unknown.push(ident);
        }
      }

      expect(
        Array.from(new Set(unknown)),
        "these look like sensor_data_logs columns and are not in shared/schema.ts — " +
        "a query naming a column that does not exist throws at runtime, and the " +
        "last time that happened a catch turned it into an empty result"
      ).toEqual([]);
    }
  );
});
