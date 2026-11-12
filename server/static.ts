import express, { type Express, type RequestHandler } from "express";
import fs from "fs";
import path from "path";

/**
 * Send browser page requests to the canonical public origin.
 *
 * The container ships the built client so it runs on its own (local, Docker),
 * but in the hosted deployment the SPA lives on a static host and only /api is
 * proxied here. A visitor who lands on the container's own URL gets the worse
 * demo: a blank page for the whole cold start instead of the waking screen,
 * and a session cookie on an origin the real site never uses.
 *
 * With PUBLIC_APP_URL set, a GET or HEAD for a page -- a request that accepts
 * HTML, outside /api -- is answered with a 308 to the same path on that
 * origin. Asset requests, API calls and anything already on the canonical
 * host pass through. Unset, which is every non-hosted run, nothing changes.
 *
 * Returns null when unset so the caller registers nothing, rather than a
 * handler that checks the variable on every request.
 */
export function canonicalRedirect(publicAppUrl: string | undefined): RequestHandler | null {
  if (!publicAppUrl) return null;
  let canonical: URL;
  try {
    canonical = new URL(publicAppUrl);
  } catch {
    throw new Error(`PUBLIC_APP_URL is not a valid URL: ${JSON.stringify(publicAppUrl)}`);
  }
  const { origin, host } = canonical;
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (req.headers.host === host) return next(); // already there; never loop
    if (!(req.headers.accept ?? "").includes("text/html")) return next(); // an asset, not a page
    res.redirect(308, origin + req.originalUrl);
  };
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "..", "dist", "public");

  const redirect = canonicalRedirect(process.env.PUBLIC_APP_URL);
  if (redirect) app.use(redirect);

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Production build not found at ${distPath}. Run "npm run build" first.`
    );
  }

  // Serve static assets with long cache
  app.use(
    "/assets",
    (req, res, next) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      next();
    },
    express.static(path.join(distPath, "assets"))
  );

  // Serve remaining static files
  app.use(express.static(distPath));

  // SPA fallback — all unmatched routes serve index.html
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}