// shared/sensor-ingest.ts
//
// What a sensor reading must look like to be accepted.
//
// Shared so the browser can reject a bad CSV before uploading it and the
// server can reject it again on arrival — the client copy is a convenience,
// the server copy is the rule.
//
// Ranges are deliberately generous. The point is to catch the mistakes that
// poison a model — a column misaligned by one, Fahrenheit where Celsius was
// expected, a units error of 1000x — not to second-guess an unusual machine.
// Everything downstream (feature engineering, labels, training, drift) is
// computed from these rows, so a value that is wrong but plausible is far more
// damaging than one that is obviously wrong, and neither is caught by a type.

import { z } from "zod";

/** Columns a CSV must provide. Everything else is optional. */
export const REQUIRED_COLUMNS = ["equipment_id", "timestamp"] as const;

/**
 * Bounds per field.
 *
 * `loadPercentage` allows up to 150 rather than 100: the bundled simulator
 * emits values above 100 under its "stressed" branch, and a rule that rejects
 * the system's own data would be a rule nobody could trust.
 */
const RANGES = {
  engineRpm: [0, 10_000],
  engineTemp: [-60, 250],
  oilPressure: [0, 500],
  coolantTemp: [-60, 250],
  fuelConsumption: [0, 1_000],
  hydraulicPressure: [0, 10_000],
  hydraulicTemp: [-60, 250],
  hydraulicFlowRate: [0, 10_000],
  vibrationX: [0, 999.999],
  vibrationY: [0, 999.999],
  vibrationZ: [0, 999.999],
  operatingHours: [0, 24],
  loadPercentage: [0, 150],
  idleTime: [0, 24],
  ambientTemp: [-80, 70],
  warningCount: [0, 10_000],
} as const;

/** Earliest timestamp worth believing — before this is almost always a parse error. */
export const EARLIEST_READING = new Date("1990-01-01T00:00:00Z");

/** How far ahead of now a reading may be dated, for clock skew. */
export const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function bounded(field: keyof typeof RANGES) {
  const [min, max] = RANGES[field];
  return z.coerce
    .number({ invalid_type_error: "must be a number" })
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`)
    .optional()
    .nullable();
}

export const sensorReadingSchema = z.object({
  equipmentId: z.coerce
    .number({ invalid_type_error: "must be a number" })
    .int("must be a whole number")
    .positive("must be positive"),

  timestamp: z.coerce
    .date({ invalid_type_error: "is not a valid date" })
    .refine(d => d >= EARLIEST_READING, "is before 1990 — check the date format")
    .refine(
      d => d.getTime() <= Date.now() + FUTURE_TOLERANCE_MS,
      "is in the future"
    ),

  engineRpm: bounded("engineRpm"),
  engineTemp: bounded("engineTemp"),
  oilPressure: bounded("oilPressure"),
  coolantTemp: bounded("coolantTemp"),
  fuelConsumption: bounded("fuelConsumption"),
  hydraulicPressure: bounded("hydraulicPressure"),
  hydraulicTemp: bounded("hydraulicTemp"),
  hydraulicFlowRate: bounded("hydraulicFlowRate"),
  vibrationX: bounded("vibrationX"),
  vibrationY: bounded("vibrationY"),
  vibrationZ: bounded("vibrationZ"),
  operatingHours: bounded("operatingHours"),
  loadPercentage: bounded("loadPercentage"),
  idleTime: bounded("idleTime"),
  ambientTemp: bounded("ambientTemp"),
  warningCount: bounded("warningCount"),

  errorCodes: z.string().max(255, "is too long").optional().nullable(),
});

export type SensorReading = z.infer<typeof sensorReadingSchema>;

/** Accepted CSV header → field name. snake_case and camelCase both work. */
export const COLUMN_ALIASES: Record<string, keyof SensorReading> = {
  equipment_id: "equipmentId",
  equipmentid: "equipmentId",
  timestamp: "timestamp",
  time: "timestamp",
  recorded_at: "timestamp",
  engine_rpm: "engineRpm",
  enginerpm: "engineRpm",
  rpm: "engineRpm",
  engine_temp: "engineTemp",
  enginetemp: "engineTemp",
  oil_pressure: "oilPressure",
  oilpressure: "oilPressure",
  coolant_temp: "coolantTemp",
  coolanttemp: "coolantTemp",
  fuel_consumption: "fuelConsumption",
  fuelconsumption: "fuelConsumption",
  hydraulic_pressure: "hydraulicPressure",
  hydraulicpressure: "hydraulicPressure",
  hydraulic_temp: "hydraulicTemp",
  hydraulictemp: "hydraulicTemp",
  hydraulic_flow_rate: "hydraulicFlowRate",
  hydraulicflowrate: "hydraulicFlowRate",
  vibration_x: "vibrationX",
  vibrationx: "vibrationX",
  vibration_y: "vibrationY",
  vibrationy: "vibrationY",
  vibration_z: "vibrationZ",
  vibrationz: "vibrationZ",
  operating_hours: "operatingHours",
  operatinghours: "operatingHours",
  hours: "operatingHours",
  load_percentage: "loadPercentage",
  loadpercentage: "loadPercentage",
  load: "loadPercentage",
  idle_time: "idleTime",
  idletime: "idleTime",
  ambient_temp: "ambientTemp",
  ambienttemp: "ambientTemp",
  error_codes: "errorCodes",
  errorcodes: "errorCodes",
  warning_count: "warningCount",
  warningcount: "warningCount",
};

/** Map a CSV header to a field, or undefined if it is not one we store. */
export function fieldForColumn(header: string): keyof SensorReading | undefined {
  return COLUMN_ALIASES[header.trim().toLowerCase().replace(/\s+/g, "_")];
}

/** One rejected row, with enough detail to fix the file without guessing. */
export interface RowError {
  /** 1-based line in the uploaded file, header included, so it matches an editor. */
  row: number;
  field?: string;
  message: string;
}

export interface IngestResult {
  inserted: number;
  /** Rows already present for that equipment and timestamp. */
  duplicates: number;
  errors: RowError[];
}
