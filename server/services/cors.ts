// server/services/cors.ts
//
// Cross-origin access for the case where the SPA is hosted apart from the API
// (static host for the frontend, container for the API). Same-origin
// deployments -- local dev, the Docker stack behind nginx -- send no Origin
// header that needs answering and are unaffected.
//
// Written by hand rather than pulling in `cors` because the policy is four
// rules and one of them has to be a hard failure:
//
//   1. Only origins named in ALLOWED_ORIGINS are answered.
//   2. Credentials are allowed, because the session cookie authenticates
//      every request.
//   3. Therefore a wildcard is refused at boot. `Access-Control-Allow-Origin:
//      *` is invalid alongside Allow-Credentials, and browsers reject the
//      response with a CORS error that names neither cause -- a wildcard looks
//      like the permissive choice and is actually the broken one.
//   4. A disallowed preflight is answered 403 rather than silently, so the
//      cause shows up in logs instead of only in someone's browser console.

import type { Express, Request, Response, NextFunction } from "express";

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With";
const PREFLIGHT_MAX_AGE = "86400"; // 24h — preflights are per-origin per-path

/**
 * Parse the ALLOWED_ORIGINS allowlist.
 *
 * Comma-separated absolute origins, e.g.
 *   https://enterprise-asset-intelligence.vercel.app,http://localhost:5173
 *
 * Throws on a wildcard (see rule 3) and on anything that is not a bare origin;
 * a trailing path never matches the Origin header, so it would be a silent
 * misconfiguration.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origins: string[] = [];
  for (const entry of entries) {
    if (entry === "*") {
      throw new Error(
        "ALLOWED_ORIGINS cannot be '*': the API sends credentials, and a " +
          "wildcard Access-Control-Allow-Origin is rejected by browsers when " +
          "Allow-Credentials is set. List the exact frontend origins."
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(
        `ALLOWED_ORIGINS entry is not a valid origin: "${entry}". ` +
          "Expected e.g. https://your-app.vercel.app"
      );
    }

    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(
        `ALLOWED_ORIGINS entry must be a bare origin with no path: "${entry}". ` +
          `Use "${parsed.origin}".`
      );
    }

    origins.push(parsed.origin);
  }

  return Array.from(new Set(origins));
}

/** Install the CORS policy. Must run before the session and the routes. */
export function applyCors(app: Express, raw = process.env.ALLOWED_ORIGINS): string[] {
  const allowed = parseAllowedOrigins(raw);

  if (allowed.length === 0) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[CORS] ALLOWED_ORIGINS is not set. Only same-origin requests will " +
          "work — if the SPA is hosted elsewhere, set it to that origin."
      );
    }
    return allowed;
  }

  console.log(`[CORS] allowing credentialed requests from: ${allowed.join(", ")}`);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // No Origin: same-origin navigation, curl, a health check. Nothing to do.
    if (!origin) return next();

    if (!allowed.includes(origin)) {
      if (req.method === "OPTIONS") {
        console.warn(`[CORS] blocked preflight from ${origin}`);
        return res.status(403).json({ message: "Origin not allowed" });
      }
      // Omitting the headers is what makes the browser block the response.
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    // The response varies by Origin, so a cache must not reuse one origin's
    // headers for another.
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
      return res.sendStatus(204);
    }

    next();
  });

  return allowed;
}
