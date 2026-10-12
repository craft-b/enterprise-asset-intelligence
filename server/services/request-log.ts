// server/services/request-log.ts
//
// How a response body is described in the request log.
//
// The log line used to end with JSON.stringify(body), which meant every
// /api/auth/me wrote the user's bcrypt hash into the platform's log retention,
// and every list endpoint wrote its entire payload:
//
//   GET /api/auth/me 304 :: {"id":1,"username":"admin",
//                            "password":"$2b$10$Mt6ks...","role":"ADMINISTRATOR"}
//
// SEC-2 flagged the logger; the deployment made it concrete. A log line should
// say what happened, not reproduce the payload — so bodies are summarised by
// shape, and the only text copied through is an error message, which is
// written by us rather than read out of the database.

/** Longest error message kept, so a stack-shaped string cannot fill the log. */
const MESSAGE_LIMIT = 120;

/** Most keys named for an object body. */
const KEY_LIMIT = 8;

/**
 * A short, non-sensitive description of a response body.
 *
 * Deliberately never includes a value from an object body: naming the keys is
 * enough to debug a response, and any value might be a credential, a token or
 * someone's data.
 */
export function summariseBody(body: unknown): string {
  if (body === undefined || body === null) return "";

  if (Array.isArray(body)) return ` :: ${body.length} item(s)`;

  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);

    // { message } and { message, errors } are our own error shapes; the text is
    // written in this codebase, not drawn from stored data.
    if (typeof record.message === "string" && keys.length <= 2) {
      return ` :: ${record.message.slice(0, MESSAGE_LIMIT)}`;
    }

    const shown = keys.slice(0, KEY_LIMIT).join(", ");
    const more = keys.length > KEY_LIMIT ? `, +${keys.length - KEY_LIMIT}` : "";
    return ` :: {${shown}${more}}`;
  }

  return "";
}
