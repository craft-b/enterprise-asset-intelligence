import { parseISO } from "date-fns";

/**
 * A calendar day from the API, as local midnight.
 *
 * Date columns arrive as 'YYYY-MM-DD' or as midnight UTC. new Date() reads both
 * as UTC, so west of Greenwich every date displayed one day early.
 */
export function calendarDate(value: string | Date): Date {
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return parseISO(iso.slice(0, 10));
}
