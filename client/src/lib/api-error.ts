// client/src/lib/api-error.ts
//
// Keeping the reason a request failed.
//
// Every hook threw a fixed string -- `throw new Error("Failed to fetch
// rentals")` -- and discarded the response. The server had something specific
// to say in almost every case: a validation message naming the bad field, a
// 503 explaining that the ML service suspends when idle, a 500 carrying the
// database error. All of it was dropped, and the toast said "Failed to fetch
// rentals".
//
// That is not only worse for whoever is looking at it. GET /api/rentals
// returned 500 for weeks because TiDB rejects the query Drizzle generated for
// it, and the UI could not say anything beyond "failed" -- so the only way to
// find out was to reproduce it against the database by hand.
//
// The fixed string stays as a fallback, because a server that returns an
// empty body or a proxy error page still needs something to show.

/** Longest server message worth putting in a toast. */
const MAX_MESSAGE = 400;

/**
 * An Error that also carries the machine-readable part of the response.
 *
 * Only two fields, and only the ones a caller acts on. The ML service suspends
 * when idle and takes 40-75s to come back, which is longer than a request may
 * reasonably be held open — so the server answers "waking" and the caller
 * retries. That decision needs a flag, not a string match on a message that
 * someone will reword.
 */
export interface ApiError extends Error {
  status?: number;
  waking?: boolean;
  retryAfterSeconds?: number;
  /**
   * How many rows a partially-successful call did store.
   *
   * A fleet scoring run can account for some assets by rule and need the ML
   * service only for the rest, so "the service is waking" and "nothing was
   * written" are not the same answer. The caller refreshes its views when
   * this is non-zero instead of leaving the work unread.
   */
  stored?: number;
}

/**
 * Build an Error from a failed response, preferring what the server said.
 *
 * Never throws: it is called on the failure path, and a parse error here would
 * replace a useful message with a confusing one.
 */
export async function apiError(res: Response, fallback: string): Promise<ApiError> {
  const body = await readBody(res);
  // The status is worth keeping alongside the text -- "503" plus "the ML
  // service is not responding" is a different situation from a 400 with the
  // same words.
  const err: ApiError = new Error(body?.message ?? fallback);
  err.status = res.status;
  if (body?.waking) {
    err.waking = true;
    err.retryAfterSeconds = body.retryAfterSeconds;
  }
  if (typeof body?.stored === "number") err.stored = body.stored;
  return err;
}

type ParsedBody = {
  message: string | null;
  waking: boolean;
  retryAfterSeconds?: number;
  stored?: number;
};

async function readBody(res: Response): Promise<ParsedBody | null> {
  try {
    const text = await res.text();
    if (!text) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      // HTML means something other than the API answered -- a proxy error
      // page, or a route that fell through to the SPA. Quoting it into a
      // toast would paste a web page into the corner of the screen.
      return null;
    }

    const body = JSON.parse(text);
    const raw =
      typeof body?.message === "string" ? body.message
      : typeof body?.error === "string" ? body.error
      : null;

    return {
      message: raw === null ? null
        : raw.length > MAX_MESSAGE ? `${raw.slice(0, MAX_MESSAGE)}…` : raw,
      waking: body?.waking === true,
      retryAfterSeconds:
        typeof body?.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined,
      stored: typeof body?.stored === "number" ? body.stored : undefined,
    };
  } catch {
    // Unreadable body, already-consumed stream, malformed JSON: the caller's
    // fallback is the right answer.
    return null;
  }
}
