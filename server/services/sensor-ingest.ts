// server/services/sensor-ingest.ts
//
// Accepting sensor readings from outside the system.
//
// Until this existed, the only way a row reached sensor_data_logs was the
// bundled simulator inventing one, which meant the platform could not be
// pointed at a real fleet even if someone offered the data. Everything
// downstream — feature engineering, labelling, training, SHAP, drift — already
// reads this table and does not care who wrote it, so this is the whole
// missing piece.
//
// Three decisions worth stating, because they are what make the data
// trustworthy afterwards:
//
//   Validation is all-or-nothing. A file is accepted whole or rejected whole,
//   with every problem listed at once. Loading 9,999 of 10,000 rows leaves
//   someone believing they loaded 10,000, and the gap surfaces later as a
//   feature that is quietly wrong.
//
//   Re-uploading the same file is safe. Readings already present for that
//   equipment and timestamp are skipped and counted, not inserted again.
//   operating_hours accumulates into a model feature, so a double upload would
//   not error — it would just make every machine look twice as worked.
//
//   Equipment must already exist. A reading for an unknown asset is a
//   mistyped id far more often than it is a new machine, and inventing the
//   asset would hide that.

import { db } from "../db";
import { sql } from "drizzle-orm";
import {
  sensorReadingSchema,
  fieldForColumn,
  REQUIRED_COLUMNS,
  type SensorReading,
  type RowError,
  type IngestResult,
} from "@shared/sensor-ingest";
import { parseCsv } from "./csv";

/** Rows per INSERT. Large enough to be quick, small enough for a placeholder cap. */
const CHUNK_SIZE = 500;

/** Refuse absurd uploads outright rather than melting on them. */
export const MAX_ROWS = 50_000;

/** A validated reading plus where it came from, for error messages. */
interface StagedReading {
  reading: SensorReading;
  row: number;
}

/** Turn CSV text into the loosely-typed objects the schema validates. */
export function csvToRecords(text: string): {
  records: { value: Record<string, unknown>; row: number }[];
  errors: RowError[];
} {
  const parsed = parseCsv(text);
  const errors: RowError[] = parsed.errors.map(e => ({ row: e.row, message: e.message }));

  if (parsed.header.length === 0) return { records: [], errors };

  const fields = parsed.header.map(fieldForColumn);
  for (const required of REQUIRED_COLUMNS) {
    const want = fieldForColumn(required);
    if (!fields.includes(want)) {
      errors.push({ row: 1, message: `Missing required column "${required}"` });
    }
  }
  if (errors.some(e => e.row === 1)) return { records: [], errors };

  const records = parsed.rows.map((cells, i) => {
    const value: Record<string, unknown> = {};
    cells.forEach((cell, col) => {
      const field = fields[col];
      // Unrecognised columns are ignored, so a vendor export with extra
      // telematics fields does not have to be trimmed by hand first.
      if (!field) return;
      const trimmed = cell.trim();
      if (trimmed !== "") value[field] = trimmed;
    });
    return { value, row: parsed.lineNumbers[i] };
  });

  return { records, errors };
}

/** Validate records against the schema, collecting every failure. */
export function validateRecords(
  records: { value: Record<string, unknown>; row: number }[]
): { staged: StagedReading[]; errors: RowError[] } {
  const staged: StagedReading[] = [];
  const errors: RowError[] = [];

  for (const { value, row } of records) {
    const result = sensorReadingSchema.safeParse(value);
    if (result.success) {
      staged.push({ reading: result.data, row });
      continue;
    }
    for (const issue of result.error.errors) {
      errors.push({
        row,
        field: issue.path.join("."),
        message: `${issue.path.join(".") || "row"} ${issue.message}`,
      });
    }
  }

  // Two readings for the same machine at the same instant cannot both be
  // right, and silently keeping one would be a guess.
  const seen = new Map<string, number>();
  for (const { reading, row } of staged) {
    const key = `${reading.equipmentId}|${reading.timestamp.toISOString()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        row,
        message: `duplicates the reading on line ${first} (same equipment and timestamp)`,
      });
    } else {
      seen.set(key, row);
    }
  }

  return { staged, errors };
}

/** Equipment ids that exist, of those referenced. */
async function existingEquipmentIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const unique = Array.from(new Set(ids));
  const [rows] = (await db.execute(
    sql`SELECT id FROM equipment WHERE id IN (${sql.join(unique.map(i => sql`${i}`), sql`, `)})`
  )) as any;
  return new Set((rows as any[]).map(r => Number(r.id)));
}

/** Which of these (equipment, timestamp) pairs are already stored. */
async function existingReadings(staged: StagedReading[]): Promise<Set<string>> {
  if (staged.length === 0) return new Set();

  const found = new Set<string>();
  for (let i = 0; i < staged.length; i += CHUNK_SIZE) {
    const chunk = staged.slice(i, i + CHUNK_SIZE);
    const pairs = chunk.map(
      s => sql`(${s.reading.equipmentId}, ${s.reading.timestamp})`
    );
    const [rows] = (await db.execute(
      sql`SELECT equipment_id, timestamp FROM sensor_data_logs
          WHERE (equipment_id, timestamp) IN (${sql.join(pairs, sql`, `)})`
    )) as any;
    for (const r of rows as any[]) {
      found.add(`${Number(r.equipment_id)}|${new Date(r.timestamp).toISOString()}`);
    }
  }
  return found;
}

const COLUMNS: [keyof SensorReading, string][] = [
  ["equipmentId", "equipment_id"],
  ["timestamp", "timestamp"],
  ["engineRpm", "engine_rpm"],
  ["engineTemp", "engine_temp"],
  ["oilPressure", "oil_pressure"],
  ["coolantTemp", "coolant_temp"],
  ["fuelConsumption", "fuel_consumption"],
  ["hydraulicPressure", "hydraulic_pressure"],
  ["hydraulicTemp", "hydraulic_temp"],
  ["hydraulicFlowRate", "hydraulic_flow_rate"],
  ["vibrationX", "vibration_x"],
  ["vibrationY", "vibration_y"],
  ["vibrationZ", "vibration_z"],
  ["operatingHours", "operating_hours"],
  ["loadPercentage", "load_percentage"],
  ["idleTime", "idle_time"],
  ["ambientTemp", "ambient_temp"],
  ["errorCodes", "error_codes"],
  ["warningCount", "warning_count"],
];

/**
 * Validate and store a batch of readings.
 *
 * Nothing is written unless every row is acceptable.
 */
export async function ingestReadings(
  input: { value: Record<string, unknown>; row: number }[]
): Promise<IngestResult> {
  if (input.length > MAX_ROWS) {
    return {
      inserted: 0,
      duplicates: 0,
      errors: [{ row: 1, message: `File has ${input.length} rows; the limit is ${MAX_ROWS}` }],
    };
  }

  const { staged, errors } = validateRecords(input);
  if (errors.length > 0) return { inserted: 0, duplicates: 0, errors };
  if (staged.length === 0) {
    return { inserted: 0, duplicates: 0, errors: [{ row: 1, message: "No readings found" }] };
  }

  const known = await existingEquipmentIds(staged.map(s => s.reading.equipmentId));
  const unknown = staged.filter(s => !known.has(s.reading.equipmentId));
  if (unknown.length > 0) {
    return {
      inserted: 0,
      duplicates: 0,
      errors: unknown.map(s => ({
        row: s.row,
        field: "equipmentId",
        message: `equipment ${s.reading.equipmentId} does not exist`,
      })),
    };
  }

  const already = await existingReadings(staged);
  const toInsert = staged.filter(
    s => !already.has(`${s.reading.equipmentId}|${s.reading.timestamp.toISOString()}`)
  );

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const values = chunk.map(({ reading }) =>
      sql`(${sql.join(
        COLUMNS.map(([field]) => sql`${(reading as any)[field] ?? null}`),
        sql`, `
      )})`
    );
    await db.execute(
      sql`INSERT INTO sensor_data_logs (${sql.raw(COLUMNS.map(([, c]) => c).join(", "))})
          VALUES ${sql.join(values, sql`, `)}`
    );
    inserted += chunk.length;
  }

  return { inserted, duplicates: staged.length - toInsert.length, errors: [] };
}
